/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The time Sval stamps synced data with: the wall clock corrected by the
 * difference Remote Settings measures against its server (decision 1714,
 * spec §5.3). Every timestamp the host hands the engine for synced data
 * comes from {@link SvalClock}.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  RemoteSettings: "resource://services-settings/remote-settings.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
});

/**
 * Local time minus server time, in whole seconds, as `remote-settings.sys.mjs`
 * writes it on every poll (`PREF_SETTINGS_CLOCK_SKEW_SECONDS`). It has no
 * default value, so it is unset until the first poll succeeds.
 */
export const SKEW_PREF = "services.settings.clock_skew_seconds";

/**
 * When Remote Settings' server asked clients to wait until, as milliseconds
 * since the epoch in a string pref (`PREF_SETTINGS_SERVER_BACKOFF`).
 * `RemoteSettings.pollChanges` refuses to poll before then.
 */
export const SERVER_BACKOFF_PREF = "services.settings.server.backoff";

/** `NS_WIDGET_WAKE_OBSERVER_TOPIC` (widget/nsIWidget.h). */
export const WAKE_TOPIC = "wake_notification";

/**
 * The topics that say the network came back, with the data each carries
 * then: `NS_NETWORK_LINK_TOPIC` with `NS_NETWORK_LINK_DATA_UP`
 * (nsINetworkLinkService.idl), and `NS_IOSERVICE_OFFLINE_STATUS_TOPIC` with
 * `NS_IOSERVICE_ONLINE` (nsIIOService.idl).
 */
export const NETWORK_UP = new Map([
  ["network:link-status-changed", "up"],
  ["network:offline-status-changed", "online"],
]);

/**
 * How far past corrected time a device's own watermark may be and still
 * raise its next stamps: decision 0135's margin, `WATERMARK_MARGIN` in
 * `engine/src/sync.rs`, which says why one minute.
 */
export const OWN_WATERMARK_MARGIN_MS = 60 * 1000;

/**
 * How far the wall clock may drift from the monotonic clock and still be
 * followed: two seconds. The two tick at slightly different rates, and a
 * synchronised wall clock is slewed to its server's time, at most 500 parts
 * per million under NTP (RFC 5905), which is 1.8 s over the hour between
 * Remote Settings polls. Followed, corrected time stays on the wall clock
 * other Sval code and other devices read. A larger move is a change to the
 * wall clock, which waits for the next reading (decision 1714).
 */
export const FOLLOWED_DRIFT_MS = 2000;

/** The first retry's delay after a poll that left no reading. */
export const FIRST_RETRY_MS = 30 * 1000;

/** The longest delay between two retries. */
export const LONGEST_RETRY_MS = 30 * 60 * 1000;

/**
 * The skew Remote Settings last measured, in seconds, or null before it has
 * measured one.
 *
 * @returns {number|null}
 */
function readSkew() {
  return Services.prefs.getPrefType(SKEW_PREF) === Services.prefs.PREF_INT
    ? Services.prefs.getIntPref(SKEW_PREF)
    : null;
}

/**
 * A clock that answers corrected time, built on injectable sources so a test
 * can move each one.
 *
 * Between readings it follows the monotonic clock from the last anchor, so a
 * change to the wall clock does not move it. A drift of the wall clock from
 * the monotonic clock within {@link FOLLOWED_DRIFT_MS} is followed. `ChromeUtils.now` is Gecko's
 * `TimeStamp`, which may not advance while the system sleeps (`TimeStamp.h`),
 * so {@link CorrectedClock#wake} adds the time the wall clock says passed
 * beyond what the monotonic clock counted.
 *
 * Every answer of {@link CorrectedClock#now} is later than the one before,
 * as Syncthing's version counters are (`lib/protocol/vector.go`): a new
 * reading a second lower moves no stamp back.
 */
export class CorrectedClock {
  #wall;
  #monotonic;
  #skew;
  /**
   * The skew as {@link CorrectedClock#readingChanged} last read it, which
   * the module calls on every change to {@link SKEW_PREF}: a stamp reads no
   * pref.
   */
  #reading;
  /** `{ at, mono }`: corrected time at the monotonic reading `mono`. */
  #anchor = null;
  /** `{ wall, mono }` at the last time either clock was read. */
  #seen = null;
  #last = 0;
  #hadReading;
  #firstReadingListeners = new Set();

  /**
   * @param {object} [sources]
   * @param {Function} [sources.wall] Milliseconds since the epoch.
   * @param {Function} [sources.monotonic] Milliseconds from any origin.
   * @param {Function} [sources.skewSeconds] Local minus server time in
   *   seconds, or null when there is no reading.
   */
  constructor({
    wall = () => Date.now(),
    monotonic = () => ChromeUtils.now(),
    skewSeconds = readSkew,
  } = {}) {
    this.#wall = wall;
    this.#monotonic = monotonic;
    this.#skew = skewSeconds;
    this.#reading = skewSeconds();
    this.#hadReading = this.hasReading;
  }

  /** Whether a time reading exists. */
  get hasReading() {
    return this.#reading !== null;
  }

  /**
   * Corrected time with no forward-only rule, unrounded; the wall clock
   * while there is no reading.
   *
   * @returns {number}
   */
  #corrected() {
    const wall = this.#wall();
    if (!this.hasReading) {
      this.#anchor = null;
      return wall;
    }
    const mono = this.#monotonic();
    if (!this.#anchor) {
      this.#anchorAt(wall, mono);
    }
    this.#seen = { wall, mono };
    const fromMono = this.#anchor.at + (mono - this.#anchor.mono);
    const fromWall = wall - this.#anchor.skew * 1000;
    if (Math.abs(fromWall - fromMono) <= FOLLOWED_DRIFT_MS) {
      this.#anchor = { at: fromWall, mono, skew: this.#anchor.skew };
      return fromWall;
    }
    return fromMono;
  }

  #anchorAt(wall, mono) {
    const skew = this.#reading ?? 0;
    this.#anchor = { at: wall - skew * 1000, mono, skew };
    this.#seen = { wall, mono };
  }

  /**
   * The next stamp: corrected time, or one millisecond past the last stamp
   * when that is later.
   *
   * @returns {number} Whole milliseconds since the epoch.
   */
  now() {
    const stamp = Math.max(this.#last + 1, Math.floor(this.#corrected()));
    this.#last = stamp;
    return stamp;
  }

  /**
   * Takes a new reading as the anchor. The first reading also lets stamps
   * fall back to corrected time, and tells each {@link onFirstReading}
   * listener the corrected time it starts from, before any later stamp is
   * taken: the stamps taken before it came from the wall clock, and a
   * listener pulls those later than corrected time back to it.
   */
  readingChanged() {
    this.#reading = this.#skew();
    if (!this.hasReading) {
      // A pref reset by hand leaves the device as one that never had a
      // reading, so the next reading is a first one.
      this.#anchor = null;
      this.#hadReading = false;
      return;
    }
    const first = !this.#hadReading;
    this.#hadReading = true;
    this.#anchorAt(this.#wall(), this.#monotonic());
    if (!first) {
      return;
    }
    const at = Math.floor(this.#corrected());
    this.#last = at;
    for (const fn of this.#firstReadingListeners) {
      try {
        fn(at);
      } catch (err) {
        lazy.SvalLog.warn(
          `a first reading listener failed: ${lazy.SvalLog.errorName(err)}`
        );
      }
    }
  }

  /**
   * Keeps every later stamp above `at`, this device's own watermark: what it
   * last wrote or published under (decision 1714). A peer holding that
   * watermark reads a node stamped below it as one it has already seen, so
   * a restart, or a reading lower than the last, must not stamp below it.
   * A watermark more than {@link OWN_WATERMARK_MARGIN_MS} past corrected
   * time is a fast clock's, from before the first reading, and is passed
   * over.
   *
   * @param {number} at Milliseconds since the epoch.
   */
  atLeast(at) {
    if (at - this.#corrected() <= OWN_WATERMARK_MARGIN_MS) {
      this.#last = Math.max(this.#last, at);
    }
  }

  /**
   * Adds the time the system slept to the anchor: what the wall clock says
   * passed since the last reading beyond what the monotonic clock counted.
   * A wall clock set back in that time adds nothing.
   */
  wake() {
    if (!this.#anchor || !this.#seen) {
      return;
    }
    const wall = this.#wall();
    const mono = this.#monotonic();
    const slept = wall - this.#seen.wall - (mono - this.#seen.mono);
    if (slept > 0) {
      this.#anchor.at += slept;
    }
    this.#seen = { wall, mono };
  }

  /**
   * Calls `fn(at)` when the first reading arrives, with the corrected time
   * stamps start from.
   *
   * @param {Function} fn
   * @returns {Function} Removes the listener.
   */
  onFirstReading(fn) {
    this.#firstReadingListeners.add(fn);
    return () => this.#firstReadingListeners.delete(fn);
  }
}

/**
 * Polls Remote Settings until the first reading exists, on a backoff, so one
 * failed poll does not leave the device waiting for the update timer
 * (`services.settings.poll_interval`). The first attempt runs at once. A
 * poll that leaves no reading schedules the next after a delay that doubles
 * from {@link FIRST_RETRY_MS} to {@link LONGEST_RETRY_MS}, and never before
 * the server's backoff ends. {@link ReadingRetry#nudge} tries at once and
 * starts the delays over, for the network coming back or the system waking.
 */
export class ReadingRetry {
  #poll;
  #hasReading;
  #setTimeout;
  #clearTimeout;
  #backoffUntil;
  #wall;
  #delay = FIRST_RETRY_MS;
  #timer = null;
  #running = false;
  #stopped = true;

  /**
   * @param {object} hooks
   * @param {Function} hooks.poll Runs one poll; may reject.
   * @param {Function} hooks.hasReading
   * @param {Function} [hooks.setTimeout]
   * @param {Function} [hooks.clearTimeout]
   * @param {Function} [hooks.backoffUntil] When the server's backoff ends,
   *   in wall-clock milliseconds; 0 when there is none.
   * @param {Function} [hooks.wall] Milliseconds since the epoch, the clock
   *   the server's backoff is in.
   */
  constructor({
    poll,
    hasReading,
    setTimeout = (fn, ms) => lazy.setTimeout(fn, ms),
    clearTimeout = timer => lazy.clearTimeout(timer),
    backoffUntil = () => 0,
    wall = () => Date.now(),
  }) {
    this.#poll = poll;
    this.#hasReading = hasReading;
    this.#setTimeout = setTimeout;
    this.#clearTimeout = clearTimeout;
    this.#backoffUntil = backoffUntil;
    this.#wall = wall;
  }

  /** Whether a retry is scheduled. */
  get scheduled() {
    return this.#timer !== null;
  }

  /** Starts polling, unless a reading exists. */
  start() {
    this.#stopped = false;
    this.#attempt();
  }

  /** Tries at once, and starts the delays over. */
  nudge() {
    if (this.#stopped) {
      return;
    }
    this.#delay = FIRST_RETRY_MS;
    this.#attempt();
  }

  stop() {
    this.#stopped = true;
    this.#cancel();
  }

  #cancel() {
    if (this.#timer !== null) {
      this.#clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  async #attempt() {
    if (this.#stopped || this.#running) {
      return;
    }
    if (this.#hasReading()) {
      this.stop();
      return;
    }
    this.#cancel();
    const backoff = this.#backoffUntil() - this.#wall();
    if (backoff > 0) {
      this.#schedule(backoff);
      return;
    }
    this.#running = true;
    try {
      await this.#poll();
    } catch (err) {
      lazy.SvalLog.info(
        `a time reading poll failed: ${lazy.SvalLog.errorName(err)}`
      );
    } finally {
      this.#running = false;
    }
    if (this.#stopped) {
      return;
    }
    if (this.#hasReading()) {
      this.stop();
      return;
    }
    const delay = this.#delay;
    this.#delay = Math.min(delay * 2, LONGEST_RETRY_MS);
    this.#schedule(Math.max(delay, this.#backoffUntil() - this.#wall()));
  }

  #schedule(ms) {
    this.#cancel();
    this.#timer = this.#setTimeout(() => {
      this.#timer = null;
      this.#attempt();
    }, ms);
  }
}

const clock = new CorrectedClock();
let retry = null;

const observer = {
  observe(subject, topic, data) {
    if (topic === "nsPref:changed") {
      clock.readingChanged();
      if (clock.hasReading) {
        retry?.stop();
      }
      return;
    }
    if (topic === WAKE_TOPIC) {
      clock.wake();
      retry?.nudge();
      return;
    }
    if (NETWORK_UP.get(topic) === data) {
      retry?.nudge();
    }
  },
};

// From the module's load, so no reading or wake goes unseen.
Services.prefs.addObserver(SKEW_PREF, observer);
Services.obs.addObserver(observer, WAKE_TOPIC);

/** The process's clock for synced data. */
export const SvalClock = {
  /**
   * The next stamp for synced data, in milliseconds since the epoch.
   *
   * @returns {number}
   */
  now() {
    return clock.now();
  },

  /** Whether Remote Settings has measured this device's clock. */
  get hasReading() {
    return clock.hasReading;
  },

  /**
   * As {@link CorrectedClock#atLeast}.
   *
   * @param {number} at
   */
  atLeast(at) {
    clock.atLeast(at);
  },

  /**
   * As {@link CorrectedClock#onFirstReading}.
   *
   * @param {Function} fn
   * @returns {Function}
   */
  onFirstReading(fn) {
    return clock.onFirstReading(fn);
  },

  /**
   * Watches for readings and wakes, and polls Remote Settings until the
   * first reading exists. Called once, at startup.
   */
  start() {
    if (retry || clock.hasReading) {
      return;
    }
    retry = new ReadingRetry({
      poll: () => lazy.RemoteSettings.pollChanges({ trigger: "manual" }),
      hasReading: () => clock.hasReading,
      backoffUntil: () =>
        parseInt(Services.prefs.getStringPref(SERVER_BACKOFF_PREF, "0"), 10) ||
        0,
    });
    for (const topic of NETWORK_UP.keys()) {
      Services.obs.addObserver(observer, topic);
    }
    retry.start();
  },
};
