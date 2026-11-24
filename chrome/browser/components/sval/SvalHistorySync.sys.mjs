/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { SvalChromePages } from "moz-src:///browser/components/sval/SvalChromePages.sys.mjs";
import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { SvalClock } from "moz-src:///browser/components/sval/SvalClock.sys.mjs";
import {
  SvalSaver,
  readJSONOrDiscard,
} from "moz-src:///browser/components/sval/SvalJSONFile.sys.mjs";
import { SvalSerialQueue } from "moz-src:///browser/components/sval/SvalSerialQueue.sys.mjs";
import { SvalTitleHold } from "moz-src:///browser/components/sval/SvalTitleHold.sys.mjs";
import {
  SvalEngine,
  SvalProcessInstance,
} from "moz-src:///browser/components/sval/SvalEngine.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  syncableAddress:
    "moz-src:///browser/components/sval/SvalSyncableAddress.sys.mjs",
  PlacesSyncUtils: "resource://gre/modules/PlacesSyncUtils.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SvalVisitWorkspaces:
    "moz-src:///browser/components/sval/SvalVisitWorkspaces.sys.mjs",
});

/** The document that lists every week of history (history-sync spec §2). */
export const HISTORY_INDEX = "history-index";

/** Where this device keeps what history sync has done, in the profile. */
const STATE_FILE = "sval-history-sync.json";

/**
 * The least time between two writes of the current week to the shared
 * folder (history-sync spec §4.1). The week is the largest file a device
 * writes while browsing, and a provider uploads all of it on each write.
 */
export const CURRENT_WEEK_PUBLISH_MS = 10 * 60 * 1000;

/** How many weeks other than the current one a pass takes, newest first. */
const COLD_SHARDS_PER_PASS = 4;

/** How many visits the seed reads from Places at a time. */
const SEED_BATCH = 5000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How many of a page's visits sync: the newest, as Firefox's history engine
 * sends a page with the visits `PlacesSyncUtils.history.fetchVisitsForURL`
 * reads. Here it bounds each device's visits to a page in each week
 * (history-sync spec §2).
 */
export const VISITS_PER_PAGE = 20;

/**
 * What the seed publishes, as Firefox's history engine first uploads: the
 * pages visited this recently, by frecency, at most `MAX_HISTORY_UPLOAD` of
 * them (`HistoryStore.getAllIDs` in
 * `services/sync/modules/engines/history.sys.mjs`).
 */
const SEED_SINCE_MS = 30 * DAY_MS;
const SEED_PAGES = 5000;

/**
 * Whether a visit Places recorded here syncs. Firefox's history engine leaves
 * out hidden pages and the transitions `IGNORED_TRANSITIONS_AS_SQL_LIST`
 * names in `PlacesSyncUtils.sys.mjs`. An address that stays on its device
 * (`syncableAddress`, decision 1372) stays in Places alone, as Firefox's
 * engine keeps `file:` visits to itself.
 *
 * Places also notifies `page-visited` for a visit it does not store, such as
 * one flooding prevention restricts (`NotifyOriginRestrictedVisit` in
 * History.cpp). That notification carries `VisitData`'s defaults: hidden,
 * at time 0, with transition `UINT32_MAX`. The hidden check keeps it out of
 * every week.
 *
 * @param {object} visit `{ url, transition, hidden }`.
 * @returns {boolean}
 */
function syncable(visit) {
  const { history } = lazy.PlacesUtils;
  return (
    !visit.hidden &&
    ![0, history.TRANSITION_FRAMED_LINK, history.TRANSITION_DOWNLOAD].includes(
      visit.transition
    ) &&
    lazy.syncableAddress(visit.url)
  );
}

/**
 * The document holding visits made at `ms`: its ISO week, in UTC, as
 * `history-YYYY-Www` (history-sync spec §2).
 *
 * @param {number} ms Milliseconds since the epoch.
 * @returns {string}
 */
export function weekOf(ms) {
  const date = new Date(ms);
  const day = date.getUTCDay() || 7;
  // The ISO week belongs to the year its Thursday is in.
  const thursday = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 4 - day
  );
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.ceil(((thursday - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return `history-${year}-W${String(week).padStart(2, "0")}`;
}

/**
 * The weeks of `weeks` a visit between `from` and `to` could fall in, oldest
 * first. Week names sort as their weeks do: every year since 1970 has four
 * digits, and {@link weekOf} pads the week to two.
 *
 * @param {Iterable<string>} weeks Week names, as {@link weekOf} gives them.
 * @param {number} from Milliseconds since the epoch.
 * @param {number} to Milliseconds since the epoch.
 * @returns {string[]}
 */
export function weeksWithin(weeks, from, to) {
  const first = weekOf(from);
  const last = weekOf(to);
  return [...weeks].filter(week => week >= first && week <= last).sort();
}

/**
 * A loaded week's visits by id, `{ url, at, device }` as last read, with each
 * page's visit ids beside them, so a title change finds its page's visits
 * without reading the whole week.
 */
class WeekVisits extends Map {
  /** url -> the ids of the visits to it. */
  #byUrl = new Map();

  set(id, visit) {
    this.delete(id);
    let ids = this.#byUrl.get(visit.url);
    if (!ids) {
      ids = new Set();
      this.#byUrl.set(visit.url, ids);
    }
    ids.add(id);
    return super.set(id, visit);
  }

  delete(id) {
    const visit = this.get(id);
    if (visit) {
      const ids = this.#byUrl.get(visit.url);
      ids.delete(id);
      if (!ids.size) {
        this.#byUrl.delete(visit.url);
      }
    }
    return super.delete(id);
  }

  /**
   * @param {string} url
   * @returns {string[]} the ids of the visits to `url`.
   */
  idsOf(url) {
    return [...(this.#byUrl.get(url) ?? [])];
  }
}

/** The scope the next history clear takes, set by the clear dialog. */
let nextClearScope = "device";

/**
 * Whether the clear dialog set the scope. Only a clear the user ran from it
 * puts other devices' visits back: a clear on shutdown leaves this computer
 * with none.
 */
let fromDialog = false;

/** Whether Firefox's history clear has been routed through this module. */
let watchingClears = false;

/** Firefox's Clear Recent History dialog. */
const CLEAR_DIALOG_URL = "chrome://browser/content/sanitize_v2.xhtml";

export const CLEAR_SCOPE_ID = "sval-history-scope";

/**
 * Adds the choice of whose history to clear to a Clear Recent History dialog
 * as it loads (history-sync spec §4.2): this device's, which is the default
 * every time, or every device's. The choice applies to the clear the dialog
 * runs, and only when it clears history.
 *
 * @param {Document} doc The dialog's document, its root just inserted.
 */
function addClearScope(doc) {
  doc.addEventListener(
    "DOMContentLoaded",
    () => {
      const history = doc.getElementById("browsingHistoryAndDownloads");
      const description = doc.getElementById(
        "browsing-history-downloads-description"
      );
      if (!history || !description) {
        return;
      }
      const group = doc.createXULElement("radiogroup");
      group.id = CLEAR_SCOPE_ID;
      group.setAttribute("aria-label", "Whose history");
      for (const [value, label] of [
        ["device", "This device's history"],
        ["all", "All devices' history"],
      ]) {
        const radio = doc.createXULElement("radio");
        radio.setAttribute("value", value);
        radio.setAttribute("label", label);
        group.append(radio);
      }
      description.after(group);
      group.value = "device";
      // The dialog's preferences set the checkbox after this, so it is
      // followed as it changes, whoever changes it.
      const follow = () => (group.disabled = !history.checked);
      new doc.defaultView.MutationObserver(follow).observe(history, {
        attributeFilter: ["checked"],
      });
      follow();
      doc.addEventListener("dialogaccept", () => {
        SvalHistorySync.nextClearScope =
          history.checked && group.value === "all" ? "all" : "device";
      });
    },
    { once: true }
  );
}

/** The process's one instance (history-sync spec §4.1). */
const shared = new SvalProcessInstance(
  (engine, options) =>
    new SvalHistorySync({
      engine,
      canBegin: () => SvalEngine.pastFirstRun,
      ...options,
    })
);

/**
 * How long the shutdown blocker waits for history sync to stop before
 * letting Places shut down without it. Within AsyncShutdown's limits for the
 * same reasons as `FINAL_PASS_TIMEOUT_MS` in `SvalEngine.sys.mjs`. A seed in
 * progress stops once the page of visits it is reading is written.
 */
const STOP_TIMEOUT_MS = 5000;

/**
 * Where the shutdown blocker is registered, while it is.
 *
 * `PlacesUtils.history.shutdownClient` is the phase Places gives its outside
 * clients: Places waits for every blocker on it before it closes any
 * connection (`Shutdown.h`). The later `connectionShutdownClient` runs its
 * blockers beside the one that closes the connection `visitsBefore` reads
 * through (`setupDbForShutdown` in `PlacesUtils.sys.mjs`).
 */
let shutdownClient = null;

/** The client a test moved the blocker onto, or null for Places' own. */
let shutdownClientOverride = null;

/** The blocker's deadline, which a test can set. */
let shutdownTimeoutMs = STOP_TIMEOUT_MS;

/**
 * The shutdown blocker: stops the process's instance and waits for its start
 * and queued work to finish, so nothing it does reaches Places once Places
 * closes its connections. Bounded by {@link shutdownTimeoutMs}, and it never
 * rejects, because AsyncShutdown reports a rejected blocker as an error.
 *
 * @returns {Promise<void>}
 */
async function stopBeforePlacesCloses() {
  // A barrier drops a blocker once it has run, so there is nothing to remove.
  shutdownClient = null;
  const sync = shared.instance;
  let timer = null;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => resolve(false), shutdownTimeoutMs);
  });
  try {
    const stopped = (async () => {
      await shared.stop();
      await sync?.whenIdle();
      return true;
    })();
    if (!(await Promise.race([stopped, deadline]))) {
      SvalLog.warn(
        `history sync did not stop within ${shutdownTimeoutMs}ms, ` +
          "so Places shut down without waiting for it"
      );
    }
  } catch (err) {
    SvalLog.warn(
      `history sync did not stop at shutdown: ${SvalLog.errorName(err)}`
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Registers the shutdown blocker, once. */
function holdShutdown() {
  if (shutdownClient) {
    return;
  }
  try {
    const client =
      shutdownClientOverride ??
      lazy.PlacesUtils.history.shutdownClient.jsclient;
    client.addBlocker(
      "sval: stopping history sync before Places closes",
      stopBeforePlacesCloses
    );
    shutdownClient = client;
  } catch (err) {
    // Places' clients phase has already finished, which only happens when a
    // window opens during shutdown. There is nothing left to hold.
    SvalLog.warn(
      `history sync could not hold shutdown: ${SvalLog.errorName(err)}`
    );
  }
}

/** Removes the shutdown blocker, if it is registered. */
function releaseShutdown() {
  if (!shutdownClient) {
    return;
  }
  shutdownClient.removeBlocker(stopBeforePlacesCloses);
  shutdownClient = null;
}

/**
 * Syncs the history Places keeps, one document per week (history-sync spec
 * §4).
 *
 * Places stays the store everything reads. A visit Places records here is
 * written to its week's document; a visit a pass brings in from another
 * device is inserted into Places, with its own time and transition, and the
 * outgoing listener skips it. A visit deleted anywhere is removed here.
 * Places' own expiry removes nothing from the documents, so a small disk on
 * one device never shortens history on the others.
 *
 * **Addresses and titles are never logged** (Sval `CONTRIBUTING.md` rule 10).
 */
export class SvalHistorySync {
  #engine;
  #places;
  #storage;
  #canBegin;
  #requestPass;
  #now;

  #started = false;
  #begun = false;
  /** The start in progress or done. */
  #beginning = null;
  #stopObserving = null;
  #stopPassListener = null;
  #stopSharedListener = null;

  /** Every apply, outgoing write and deletion, in order. */
  #queue = new SvalSerialQueue("history sync");

  /** Which pages' titles wait before they are written. */
  #titleHold;

  /** url -> the latest title `#titleHold` is holding back. */
  #heldTitles = new Map();

  /**
   * What this device has done, saved in the profile: `merged`, week -> the
   * index's `changedAt` this device last merged it at; `unpublished`, weeks
   * this device wrote to that no shared step has published yet, with an index
   * that announces them; `seed`, how far the seed of Places' history has
   * got, `next` being where Places' next page of visits starts; `deletions`,
   * deletes not yet carried into every week they touch; `unwritten`, week -> the time of the earliest visit Places recorded here
   * that did not reach the week's document, which the week takes from Places
   * once it loads ({@link #catchUp}); `unremoved`, `{ url, at }` of visits
   * deleted elsewhere that Places still holds, removed at the next pass
   * ({@link #removeFromPlaces}).
   */
  #state = {
    merged: {},
    unpublished: [],
    seed: { done: false, next: null },
    deletions: [],
    unwritten: {},
    unremoved: [],
  };

  /** Saves `#state` soon after it changes. */
  #save = null;

  /**
   * The weeks loaded, by name: `{ visits, waiting, announced,
   * changedAt, openedAt }`. `visits` maps each visit's id to `{ url, at,
   * device }` as last read, so a removal a pass reports can be found in
   * Places. `waiting` is the engine's change count when the week was loaded
   * to merge or last written to: a shared step that exchanged the week
   * holding that change has merged and published it. It is null when nothing
   * waits on a step. `announced` is the engine's change count once the index
   * was told of the week, and null when no announcement waits: the week
   * stays in `unpublished` until a step has exchanged the index holding it,
   * so a quit before then announces it again at the next start. `changedAt`
   * is the index's, for a week loaded because another device changed it;
   * `openedAt` is when it was loaded.
   */
  #open = new Map();

  /** The week the current one is, as last decided. */
  #current = null;

  /** `url\nvisitedAt` of visits being inserted into Places, which echo. */
  #inserting = new Set();

  /** URLs whose visits are being removed from Places by an apply. */
  #removing = new Set();

  /** Set while a history clear runs, whose removals it handles itself. */
  #clearing = false;

  /**
   * Weeks in `unwritten` this session has tried to load, by a visit to them
   * or a pass over the index. Passes try each such week once a session, and
   * after that it waits for a change to it ({@link #afterIndexPass}).
   */
  #triedBehind = new Set();

  /**
   * @param {object} options
   * @param {object} options.engine The profile's engine.
   * @param {object} [options.places] Places, as {@link historyStore} wraps it.
   * @param {object} [options.storage] `{ read, write }` for the state file.
   * @param {() => boolean} [options.canBegin] Whether this device's sync key
   *   is settled.
   * @param {Function} [options.requestPass] Asks for a pass soon; the
   *   engine's `requestPass` by default.
   * @param {() => number} [options.now] Milliseconds since the epoch, on
   *   the clock Places' visit times are on: it places the current week, the
   *   seed's window and the ranges of deletions.
   * @param {number} [options.titleHoldMs] How long a page's title holds
   *   back the ones after it (`SvalTitleHold`); a test shortens it.
   */
  constructor({
    engine,
    places = SvalHistorySync.historyStore(),
    storage = SvalHistorySync.profileStorage(),
    canBegin = () => true,
    requestPass = () => engine.requestPass(),
    now = () => Date.now(),
    titleHoldMs,
  }) {
    this.#titleHold = new SvalTitleHold(url => {
      const title = this.#heldTitles.get(url);
      this.#heldTitles.delete(url);
      this.#queue.post(() => this.#writeTitle(url, title));
    }, titleHoldMs);
    this.#engine = engine;
    this.#places = places;
    this.#storage = storage;
    this.#canBegin = canBegin;
    this.#requestPass = requestPass;
    this.#now = now;
  }

  /**
   * Starts once this device's sync key is settled: at once if it is,
   * otherwise after the first pass that finds it so. Idempotent.
   */
  async start() {
    if (this.#started) {
      return;
    }
    this.#started = true;
    if (this.#canBegin()) {
      this.#beginning = this.#begin();
      await this.#beginning;
      return;
    }
    this.#stopPassListener = this.#engine.addPassListener(() => {
      if (this.#started && !this.#begun && this.#canBegin()) {
        this.#beginning = this.#begin();
        this.#beginning.catch(err =>
          SvalLog.warn(`history sync did not start: ${SvalLog.errorName(err)}`)
        );
      }
    });
  }

  async #begin() {
    if (this.#begun) {
      return;
    }
    this.#begun = true;
    this.#stopPassListener?.();
    this.#stopPassListener = null;
    const saved = await this.#storage.read();
    // The keys `#state` defines, alone: the file names pages, and a key no
    // code reads would outlive every clear of history.
    if (saved && typeof saved === "object") {
      for (const key of Object.keys(this.#state)) {
        if (key in saved) {
          this.#state[key] = saved[key];
        }
      }
    }
    this.#save = this.#storage.saver(() => this.#state);
    if (!this.#started) {
      return;
    }
    // Before anything is merged: from then on Places holds other devices'
    // visits too, and the seed would claim them as this device's.
    if (!this.#state.seed.done && this.#enabled) {
      await this.#seed();
    }
    await this.#engine.openDocument(HISTORY_INDEX, report =>
      this.#queue.post(() => this.#afterIndexPass(report))
    );
    await this.#queue.run(() => this.#ensureCurrent());
    // A `stop()` during the steps above found no listener to remove, and a
    // later one returns at once, so a listener added now would never go: it
    // would write Places' changes into an engine nobody syncs.
    if (!this.#started) {
      return;
    }
    this.#stopSharedListener = this.#engine.addSharedListener(report => {
      // A step that did not reach the folder published nothing and merged
      // nothing from it.
      if (report.shared === "reached") {
        this.#queue.post(() => this.#afterSharedStep(report));
      }
    });
    this.#stopObserving = this.#places.observe({
      visited: visits => this.#queue.post(() => this.#writeVisits(visits)),
      titled: (url, title) => {
        if (this.#titleHold.admit(url)) {
          this.#queue.post(() => this.#writeTitle(url, title));
        } else {
          this.#heldTitles.set(url, title);
        }
      },
      removed: urls => this.#onRemoved(urls),
      cleared: () => this.#onCleared(),
    });
    this.#requestPass();
  }

  stop() {
    if (!this.#started) {
      return;
    }
    this.#started = false;
    this.#stopObserving?.();
    this.#stopObserving = null;
    this.#titleHold.stop();
    this.#heldTitles.clear();
    this.#stopPassListener?.();
    this.#stopPassListener = null;
    this.#stopSharedListener?.();
    this.#stopSharedListener = null;
    this.#save?.finalize();
  }

  /**
   * Settles once the start in progress, and every apply and outgoing write
   * queued so far, has finished.
   *
   * @returns {Promise<void>}
   */
  async whenIdle() {
    // A start that failed has been reported to whoever started it.
    await this.#beginning?.catch(() => {});
    await this.#queue.idle();
  }

  /**
   * Writes every title a hold keeps back, ending its hold. A hold ends up
   * to `TITLE_HOLD_MS` after the page set its title, so a test that compares
   * the documents across a stretch of time calls this first, then
   * {@link whenIdle}.
   */
  _writeHeldTitlesForTests() {
    for (const [url, title] of this.#heldTitles) {
      this.#titleHold.forget(url);
      this.#queue.post(() => this.#writeTitle(url, title));
    }
    this.#heldTitles.clear();
  }

  /** Whether Places is recording history here: "Never remember" turns it off. */
  get #enabled() {
    return this.#places.enabled();
  }

  #mutate(document, op) {
    // Stamped by the engine's clock, which its passes over these documents
    // read too: what tells a deletion from a visit never seen compares a
    // visit's stamp with watermarks those passes wrote (spec §5.4).
    return this.#engine.mutate({ ...op, document });
  }

  /**
   * Loads week `name`, if it is not loaded: this device's copy first, then
   * passes run it. The visits it holds are read so a removal can be found.
   *
   * @param {string} name
   */
  async #openWeek(name) {
    if (this.#open.has(name)) {
      return;
    }
    const entry = {
      visits: new WeekVisits(),
      waiting: null,
      announced: null,
      changedAt: null,
      // On the clock the engine stamps the index's announcements with
      // (decision 1714), so an announcement made after this load is always
      // later.
      openedAt: SvalClock.now(),
    };
    // Loaded only once the engine holds it: a week whose load failed is not
    // open, so the next write to it tries the load again.
    await this.#engine.openDocument(
      name,
      report => this.#queue.post(() => this.#afterWeekPass(name, report)),
      name === this.#current ? { publishEveryMs: CURRENT_WEEK_PUBLISH_MS } : {}
    );
    this.#open.set(name, entry);
    for (const row of await this.#engine.visits(name)) {
      entry.visits.set(row.id, {
        url: row.url,
        at: row.visitedAt,
        device: row.device,
      });
    }
    // A week whose file holds more of this device's visits to a page than
    // sync keeps the newest. A trim that fails is made at the next write.
    try {
      await this.#writeNewest(name, []);
    } catch (err) {
      SvalLog.warn(
        `history: a week was not trimmed: ${SvalLog.errorName(err)}`
      );
    }
    await this.#catchUp(name);
  }

  /**
   * Writes into week `name`, loaded, the visits Places recorded here that did
   * not reach it. Places is read from the earliest of them on: a visit from
   * another device Places took in since then came from this week's document
   * while it was loaded, so it is there already and is skipped. A catch-up
   * that fails is tried again the next time the week loads, or, for the
   * current week, at the next visit or pass. A device that keeps no history
   * writes none of it, as with the seed. A visit deleted elsewhere that
   * Places still holds is not this device's to write back.
   *
   * @param {string} name
   */
  async #catchUp(name) {
    const since = this.#state.unwritten[name];
    const entry = this.#open.get(name);
    if (since === undefined || !entry || !this.#enabled) {
      return;
    }
    const held = new Set(
      [...entry.visits.values()].map(visit => `${visit.url}\n${visit.at}`)
    );
    const missed = [];
    try {
      let next = null;
      do {
        const page = await this.#places.visitsBefore(next, SEED_BATCH);
        const recent = page.visits.filter(visit => visit.visitedAt >= since);
        missed.push(
          ...this.#notDeletedElsewhere(recent).filter(
            visit =>
              weekOf(visit.visitedAt) === name &&
              !held.has(`${visit.url}\n${visit.visitedAt}`)
          )
        );
        next = recent.length === page.visits.length ? page.next : null;
      } while (next);
      if (missed.length) {
        await this.#addVisits(name, missed);
      }
    } catch (err) {
      SvalLog.warn(
        `history: visits did not reach the document: ${SvalLog.errorName(err)}`
      );
      return;
    }
    delete this.#state.unwritten[name];
    this.#save.saveSoon();
  }

  async #closeWeek(name) {
    if (name === this.#current || !this.#open.has(name)) {
      return;
    }
    this.#open.delete(name);
    await this.#engine.removeDocument(name);
  }

  /**
   * Keeps the current week loaded, and lets the last one go once it can. A
   * week that does not load is tried again at the next call: every visit and
   * every pass over the index makes one.
   */
  async #ensureCurrent() {
    const week = weekOf(this.#now());
    const previous = this.#current;
    this.#current = week;
    if (
      previous &&
      previous !== week &&
      this.#settled(this.#open.get(previous))
    ) {
      await this.#closeWeek(previous);
    }
    if (this.#open.has(week)) {
      // A week that loads takes its visits as it does ({@link #openWeek}).
      await this.#catchUp(week);
      return;
    }
    try {
      await this.#openWeek(week);
    } catch (err) {
      SvalLog.warn(
        `history: this week did not load: ${SvalLog.errorName(err)}`
      );
    }
  }

  /**
   * Notes that this device wrote to `week`. It stays loaded until shared
   * steps have published it, and the index hears of it only then
   * ({@link #afterSharedStep}).
   *
   * @param {string} week
   */
  #wroteTo(week) {
    if (!this.#state.unpublished.includes(week)) {
      this.#state.unpublished.push(week);
    }
    const entry = this.#open.get(week);
    if (entry) {
      entry.waiting = this.#engine.changeCount;
      // The index hears of this write once a step has published it.
      entry.announced = null;
    }
    this.#save.saveSoon();
  }

  /**
   * Whether a loaded week waits on no step: nothing to merge or publish, and
   * no announcement of it waiting to be exchanged.
   *
   * @param {object|undefined} entry The week's entry in `#open`.
   * @returns {boolean}
   */
  #settled(entry) {
    return entry?.waiting === null && entry.announced === null;
  }

  /**
   * Visits Places recorded here, each written to its week with the workspace
   * it was made in (decision 1287).
   *
   * @param {object[]} visits `{ url, title, visitedAt, transition, hidden,
   *   visitId }`.
   */
  async #writeVisits(visits) {
    if (!this.#started) {
      return;
    }
    let mine = visits.filter(
      visit => !this.#inserting.delete(`${visit.url}\n${visit.visitedAt}`)
    );
    if (!mine.length || !this.#enabled) {
      return;
    }
    try {
      const workspaces = await this.#places.workspacesOf(
        mine.map(visit => visit.visitId)
      );
      mine = mine.map(visit => ({
        ...visit,
        workspace: workspaces.get(visit.visitId) ?? null,
      }));
    } catch (err) {
      SvalLog.warn(
        `history: visits' workspaces were not read: ${SvalLog.errorName(err)}`
      );
    }
    await this.#ensureCurrent();
    const byWeek = Map.groupBy(mine, visit => weekOf(visit.visitedAt));
    for (const [week, weekVisits] of byWeek) {
      try {
        await this.#addVisits(week, weekVisits);
      } catch (err) {
        SvalLog.warn(
          `history: visits did not reach the document: ${SvalLog.errorName(err)}`
        );
        this.#triedBehind.add(week);
        const earliest = Math.min(...weekVisits.map(visit => visit.visitedAt));
        this.#state.unwritten[week] = Math.min(
          this.#state.unwritten[week] ?? earliest,
          earliest
        );
        this.#save.saveSoon();
      }
    }
    this.#requestPass();
  }

  /**
   * Writes this device's `visits` that sync ({@link syncable}) into `week`,
   * loading it if need be.
   *
   * @param {string} week
   * @param {object[]} all
   */
  async #addVisits(week, all) {
    const visits = all.filter(syncable);
    if (!visits.length) {
      return;
    }
    await this.#openWeek(week);
    await this.#writeNewest(week, visits);
  }

  /**
   * Writes `visits` into loaded week `name` and removes this device's visits
   * there that fall outside each page's newest {@link VISITS_PER_PAGE}, so
   * the week holds only those. Another device's visits are its own to trim.
   * A removal reaches the other devices as a deletion, and they keep the
   * newest of this device's visits to the page.
   *
   * @param {string} name
   * @param {object[]} visits `{ url, title, visitedAt, transition, workspace }`.
   */
  async #writeNewest(name, visits) {
    const entry = this.#open.get(name);
    const device = this.#engine.deviceIdHex;
    const byPage = new Map();
    const list = url => byPage.get(url) ?? byPage.set(url, []).get(url);
    for (const [id, visit] of entry.visits) {
      if (visit.device === device) {
        list(visit.url).push({ at: visit.at, id });
      }
    }
    for (const visit of visits) {
      list(visit.url).push({ at: visit.visitedAt, visit });
    }
    const added = [];
    const removed = [];
    for (const page of byPage.values()) {
      page.sort((a, b) => b.at - a.at);
      for (const [i, item] of page.entries()) {
        if (i < VISITS_PER_PAGE) {
          if (item.visit) {
            added.push(item.visit);
          }
        } else if (item.id) {
          removed.push(item.id);
        }
      }
    }
    if (!added.length && !removed.length) {
      return;
    }
    await this.#mutate(name, {
      kind: "batch",
      ops: [
        ...added.map(visit => ({
          kind: "addVisit",
          url: visit.url,
          title: visit.title ?? "",
          transition: visit.transition,
          visitedAt: visit.visitedAt,
          workspace: visit.workspace ?? null,
        })),
        ...removed.map(id => ({ kind: "remove", id })),
      ],
    });
    for (const visit of added) {
      const id = await this.#engine.visitId(visit.url, visit.visitedAt);
      entry.visits.set(id, { url: visit.url, at: visit.visitedAt, device });
    }
    for (const id of removed) {
      entry.visits.delete(id);
    }
    this.#wroteTo(name);
  }

  /**
   * A page's title changed: this device's visits to it in the current week
   * take the new title. Older weeks stay as they are, so they go cold.
   *
   * @param {string} url
   * @param {string} title
   */
  async #writeTitle(url, title) {
    if (!this.#started || !this.#enabled || !this.#current) {
      return;
    }
    const entry = this.#open.get(this.#current);
    const device = this.#engine.deviceIdHex;
    const ids = (entry?.visits.idsOf(url) ?? []).filter(
      id => entry.visits.get(id).device === device
    );
    if (!ids.length) {
      return;
    }
    await this.#mutate(this.#current, {
      kind: "batch",
      ops: ids.map(id => ({ kind: "setVisitTitle", id, title })),
    });
    this.#wroteTo(this.#current);
    this.#requestPass();
  }

  /**
   * After a pass over a week: what it brought in goes into Places, and what
   * another device deleted comes out.
   *
   * @param {string} week
   * @param {object} report The pass's report.
   */
  async #afterWeekPass(week, report) {
    const entry = this.#open.get(week);
    if (!entry) {
      return;
    }
    // A visit never changes but for its title, so of the nodes the pass
    // changed, those this week did not hold are the visits it brought.
    const added = (report?.changedIds ?? []).filter(
      id => !entry.visits.has(id)
    );
    const removed = report?.removedIds ?? [];
    if (added.length) {
      const wanted = new Set(added);
      const rows = (await this.#engine.visits(week)).filter(row =>
        wanted.has(row.id)
      );
      for (const row of rows) {
        entry.visits.set(row.id, {
          url: row.url,
          at: row.visitedAt,
          device: row.device,
        });
      }
      await this.#insert(rows);
    }
    if (removed.length) {
      const gone = removed.map(id => entry.visits.get(id)).filter(Boolean);
      for (const id of removed) {
        entry.visits.delete(id);
      }
      await this.#removeFromPlaces(gone);
    }
    // With no shared folder, the profile is everything there is to publish
    // to, so a pass that ran the week is a step that exchanged it.
    if (
      !this.#engine.sharesSomewhere &&
      (await this.#advance(week, { saw: report?.saw, at: null }))
    ) {
      this.#requestPass();
    }
  }

  /**
   * Inserts visits from other devices into Places, unless this device keeps
   * no history. A visit to an address that may not leave a device
   * (`syncableAddress`) is left out: no device writes one.
   *
   * @param {object[]} rows As the engine's `visits()` lists them.
   */
  async #insert(rows) {
    const device = this.#engine.deviceIdHex;
    const arrived = rows.filter(
      row => row.device !== device && row.url && lazy.syncableAddress(row.url)
    );
    if (!arrived.length || !this.#enabled) {
      return;
    }
    // Firefox's history engine inserts a page's incoming visits only where
    // Places has no visit at that time with that transition, and, once it
    // holds the page's newest VISITS_PER_PAGE, none older than those
    // (`HistoryStore` in `services/sync/modules/engines/history.sys.mjs`).
    const theirs = [];
    for (const [url, visits] of Map.groupBy(arrived, row => row.url)) {
      let local = [];
      try {
        local = await this.#places.recentVisits(url);
      } catch (err) {
        SvalLog.warn(
          `history: a page's visits were not read: ${SvalLog.errorName(err)}`
        );
      }
      const held = new Set(local.map(v => `${v.visitedAt},${v.transition}`));
      const oldest =
        local.length >= VISITS_PER_PAGE ? local.at(-1).visitedAt : -Infinity;
      theirs.push(
        ...visits.filter(
          row =>
            row.visitedAt >= oldest &&
            !held.has(`${row.visitedAt},${row.transition}`)
        )
      );
    }
    if (!theirs.length) {
      return;
    }
    for (const row of theirs) {
      this.#inserting.add(`${row.url}\n${row.visitedAt}`);
    }
    try {
      await this.#places.insert(theirs);
    } catch (err) {
      for (const row of theirs) {
        this.#inserting.delete(`${row.url}\n${row.visitedAt}`);
      }
      SvalLog.warn(
        `history: visits from another device were not inserted: ${SvalLog.errorName(err)}`
      );
      return;
    }
    // Each takes the workspace its node names, or none (decision 1287).
    try {
      await this.#places.recordWorkspaces(theirs);
    } catch (err) {
      SvalLog.warn(
        `history: visits' workspaces were not recorded: ${SvalLog.errorName(err)}`
      );
    }
  }

  /**
   * Whether the visit to `url` at `visitedAt` is one this module is inserting
   * for another device.
   *
   * @param {string} url
   * @param {number} visitedAt Milliseconds since the epoch.
   * @returns {boolean}
   */
  isInserting(url, visitedAt) {
    return this.#inserting.has(`${url}\n${visitedAt}`);
  }

  /**
   * Removes visits deleted elsewhere from Places, with those an earlier call
   * could not. A visit Places would not let go stays in `unremoved` and is
   * tried again at the next pass over the index; until then nothing writes
   * it back to a week. Removing is always allowed, so this runs whether or
   * not Places is recording history. The removals this makes are not taken
   * for the user's.
   *
   * @param {object[]} visits `{ url, at }`.
   */
  async #removeFromPlaces(visits) {
    const todo = [...this.#state.unremoved];
    for (const { url, at } of visits) {
      if (!todo.some(visit => visit.url === url && visit.at === at)) {
        todo.push({ url, at });
      }
    }
    if (!todo.length) {
      return;
    }
    for (const visit of todo) {
      this.#removing.add(visit.url);
    }
    // One at a time, so a visit Places refuses holds back no other.
    const left = [];
    let error = null;
    try {
      for (const visit of todo) {
        try {
          await this.#places.removeVisits([visit]);
        } catch (err) {
          error = err;
          left.push(visit);
        }
      }
    } finally {
      // Places notifies before `removeVisits` settles.
      for (const visit of todo) {
        this.#removing.delete(visit.url);
      }
    }
    if (error) {
      SvalLog.warn(
        `history: visits deleted elsewhere were not removed: ${SvalLog.errorName(error)}`
      );
    }
    if (left.length || this.#state.unremoved.length) {
      this.#state.unremoved = left;
      this.#save.saveSoon();
    }
  }

  /**
   * `visits` read from Places, without those deleted elsewhere that Places
   * still holds.
   *
   * @param {object[]} visits `{ url, visitedAt }`.
   * @returns {object[]}
   */
  #notDeletedElsewhere(visits) {
    const unremoved = this.#state.unremoved;
    if (!unremoved.length) {
      return visits;
    }
    const gone = new Set(unremoved.map(({ url, at }) => `${url}\n${at}`));
    return visits.filter(
      visit => !gone.has(`${visit.url}\n${visit.visitedAt}`)
    );
  }

  /**
   * After a pass over the index: visits deleted elsewhere that Places kept
   * are removed again. Weeks this device has not published yet, then weeks
   * another device changed since this one merged them, are loaded, newest
   * first, a few a pass. A week that holds fewer of this device's visits than
   * Places does takes them as it loads ({@link #catchUp}). Passes load such a
   * week once a session; after that it loads for another device's change to
   * it or a visit here to it, so a week that will not load is not loaded
   * again at every pass. A deletion in progress takes its next step.
   *
   * @param {object} [report] The pass's report.
   */
  async #afterIndexPass(report) {
    if (!this.#started) {
      return;
    }
    await this.#removeFromPlaces([]);
    // With no shared folder, the profile is everything there is to publish
    // to, so a pass that wrote the index published what it announces.
    if (!this.#engine.sharesSomewhere) {
      await this.#indexPublished(report?.saw);
    }
    await this.#ensureCurrent();
    const shards = await this.#engine.shards(HISTORY_INDEX);
    const behind = Object.keys(this.#state.unwritten).filter(
      name => name !== this.#current && !this.#triedBehind.has(name)
    );
    const wanted = [
      ...[...new Set([...this.#state.unpublished, ...behind])]
        .sort()
        .reverse()
        .map(name => ({ name })),
      ...shards.filter(
        ({ name, changedAt }) => (this.#state.merged[name] ?? 0) < changedAt
      ),
    ];
    let cold = [...this.#open.keys()].filter(w => w !== this.#current).length;
    for (const { name, changedAt } of wanted) {
      if (cold >= COLD_SHARDS_PER_PASS) {
        break;
      }
      if (this.#open.has(name)) {
        continue;
      }
      if (name in this.#state.unwritten) {
        this.#triedBehind.add(name);
      }
      try {
        await this.#openWeek(name);
        const entry = this.#open.get(name);
        // Kept until a shared step has merged it, and published it if it
        // holds this device's writes.
        entry.waiting = this.#engine.changeCount;
        entry.changedAt = changedAt ?? null;
        cold++;
      } catch (err) {
        SvalLog.warn(`history: a week did not load: ${SvalLog.errorName(err)}`);
      }
    }
    await this.#deletionStep(shards);
  }

  /**
   * After a shared step that reached the folder. A week the step exchanged,
   * holding this device's last write to it, is merged, and published if this
   * device wrote to it. Only then does the index hear that this device wrote
   * to it, so a device that reads the index and then the week finds the
   * write there (history-sync spec §3). A week other than the current one is
   * let go once nothing of it waits on a step.
   *
   * @param {object} report The step's report.
   */
  async #afterSharedStep(report) {
    await this.#indexPublished(report.exchanged?.[HISTORY_INDEX]);
    let touched = false;
    for (const name of [...this.#open.keys()]) {
      touched =
        (await this.#advance(name, {
          saw: report.exchanged?.[name],
          at: report.sharedAt ?? null,
        })) || touched;
    }
    if (touched) {
      this.#requestPass();
    }
  }

  /**
   * The index was exchanged by a step, or written by a profile pass with no
   * shared folder, holding every change up to `saw`. A week whose
   * announcement that covers is published, and is let go, which frees its
   * place for the next unpublished week to load.
   *
   * @param {number|undefined} saw The index's change count, or undefined
   *   when the step did not exchange it.
   */
  async #indexPublished(saw) {
    if (saw === undefined) {
      return;
    }
    let closed = false;
    for (const [name, entry] of [...this.#open]) {
      if (entry.announced === null || saw < entry.announced) {
        continue;
      }
      entry.announced = null;
      this.#state.unpublished = this.#state.unpublished.filter(
        week => week !== name
      );
      this.#save.saveSoon();
      if (entry.waiting === null) {
        await this.#closeWeek(name);
        closed = true;
      }
    }
    if (closed) {
      this.#requestPass();
    }
  }

  /**
   * Week `name` was exchanged by a step, or a profile pass with no shared
   * folder, whose merge held every change up to `saw`. Once that covers
   * what the week waits on, the week is merged and published.
   *
   * @param {string} name
   * @param {object} exchange
   * @param {number|undefined} exchange.saw The merge's change count, or
   *   undefined when the step did not exchange the week.
   * @param {number|null} exchange.at When the step began, or null.
   * @returns {Promise<boolean>} whether the index was written.
   */
  async #advance(name, { saw, at }) {
    const entry = this.#open.get(name);
    if (
      !entry ||
      entry.waiting === null ||
      saw === undefined ||
      saw < entry.waiting
    ) {
      return false;
    }
    const waited = entry.waiting;
    entry.waiting = null;
    // Merged as of when the step began, or the week was loaded: a write
    // another device announces later than that may have landed after this
    // device read the week, and is merged the next time. This device's own
    // announcement below is one of those, and loads the week once more: the
    // index keeps only the newest announcement, so one another device made
    // between the read and this device's would otherwise go unread.
    const merged = Math.max(
      this.#state.merged[name] ?? 0,
      entry.changedAt ?? 0,
      at ?? entry.openedAt
    );
    let touched = false;
    if (this.#state.unpublished.includes(name)) {
      try {
        await this.#mutate(HISTORY_INDEX, { kind: "touchShard", name });
      } catch (err) {
        SvalLog.warn(
          `history: the index did not record a week: ${SvalLog.errorName(err)}`
        );
        entry.waiting = waited;
        return false;
      }
      // Still unpublished, and loaded, until a step exchanges the index
      // holding this ({@link #indexPublished}).
      entry.announced = this.#engine.changeCount;
      touched = true;
    }
    this.#state.merged[name] = merged;
    this.#save.saveSoon();
    if (!touched) {
      await this.#closeWeek(name);
    }
    return touched;
  }

  /**
   * Writes what Firefox's history engine first uploads into this profile's
   * copy of each week, newest first: the newest {@link VISITS_PER_PAGE}
   * visits to each page of {@link SEED_PAGES} (history-sync spec §4.1). Shared steps publish the weeks afterwards, a few a pass. An
   * interrupted seed resumes where it stopped.
   */
  async #seed() {
    const seed = this.#state.seed;
    const since = this.#now() - SEED_SINCE_MS;
    const pages = new Set(await this.#places.seedPages(since, SEED_PAGES));
    // Counted from where this run starts. A seed resumed after a stop can
    // write a page past the limit, and the trim as its week loads
    // ({@link #writeNewest}) takes it back down.
    const written = new Map();
    let count = 0;
    while (this.#started) {
      const page = await this.#places.visitsBefore(
        seed.next ?? null,
        SEED_BATCH
      );
      const recent = page.visits.filter(visit => visit.visitedAt >= since);
      const visits = this.#notDeletedElsewhere(recent).filter(visit => {
        const n = written.get(visit.url) ?? 0;
        if (!pages.has(visit.url) || n >= VISITS_PER_PAGE || !syncable(visit)) {
          return false;
        }
        written.set(visit.url, n + 1);
        return true;
      });
      for (const [week, weekVisits] of Map.groupBy(visits, v =>
        weekOf(v.visitedAt)
      )) {
        await this.#engine.writeLocally(
          week,
          weekVisits.map(visit => ({
            kind: "addVisit",
            url: visit.url,
            title: visit.title ?? "",
            transition: visit.transition,
            visitedAt: visit.visitedAt,
            workspace: visit.workspace ?? null,
          }))
        );
        if (!this.#state.unpublished.includes(week)) {
          this.#state.unpublished.push(week);
        }
      }
      count += visits.length;
      seed.next = page.next;
      this.#save.saveSoon();
      if (!page.next || recent.length < page.visits.length) {
        break;
      }
    }
    if (this.#started) {
      seed.done = true;
      this.#save.saveSoon();
      SvalLog.debug(`history: seeded ${count} visit(s)`);
    }
  }

  /**
   * Page URLs the user deleted: Delete Page and Forget About This Site. Every
   * visit to them goes, from every device (history-sync spec §4.2).
   *
   * @param {string[]} urls
   */
  #onRemoved(urls) {
    const theirs = urls.filter(url => !this.#removing.has(url));
    if (this.#clearing || !theirs.length) {
      return;
    }
    this.#queue.post(() => this.#queueDeletion({ urls: theirs }));
  }

  /** All of Places' history went, outside a clear this module ran. */
  #onCleared() {
    if (this.#clearing) {
      return;
    }
    this.#queue.post(() =>
      this.#queueDeletion({ from: 0, to: this.#now(), scope: "device" })
    );
  }

  /**
   * Records a deletion to carry into every week it touches, and starts on it.
   *
   * @param {object} deletion `{ urls }`, or `{ from, to, scope }`.
   */
  async #queueDeletion(deletion) {
    this.#state.deletions.push({ ...deletion, done: [] });
    // At once: a clear on shutdown is the last thing this session does.
    await this.#storage.write(this.#state);
    await this.#deletionStep(await this.#engine.shards(HISTORY_INDEX));
  }

  /**
   * Carries the oldest deletion into the weeks it has not reached yet, a few
   * a pass. A deletion by URL could be in any week; one by time only in the
   * weeks that time spans.
   *
   * @param {object[]} shards The index's weeks.
   */
  async #deletionStep(shards) {
    const deletion = this.#state.deletions[0];
    if (!deletion || !this.#started) {
      return;
    }
    // Every week any device has published, and the ones this device has
    // written to and not published yet.
    const known = new Set([
      ...shards.map(shard => shard.name),
      ...this.#state.unpublished,
      ...(this.#current ? [this.#current] : []),
    ]);
    const weeks = deletion.urls
      ? [...known]
      : weeksWithin(known, deletion.from, deletion.to);
    const todo = weeks.filter(week => !deletion.done.includes(week));
    for (const week of todo.slice(0, COLD_SHARDS_PER_PASS)) {
      try {
        await this.#deleteIn(week, deletion);
        deletion.done.push(week);
      } catch (err) {
        SvalLog.warn(
          `history: a deletion did not reach a week: ${SvalLog.errorName(err)}`
        );
        break;
      }
    }
    if (weeks.every(week => deletion.done.includes(week))) {
      this.#state.deletions.shift();
    }
    this.#save.saveSoon();
    this.#requestPass();
  }

  /**
   * Deletes `deletion`'s visits from `week`. A clear of this device's history
   * then puts back into Places the other devices' visits it removed.
   *
   * @param {string} week
   * @param {object} deletion
   */
  async #deleteIn(week, deletion) {
    await this.#openWeek(week);
    const entry = this.#open.get(week);
    const device = this.#engine.deviceIdHex;
    const rows = await this.#engine.visits(week);
    const inRange = row =>
      row.visitedAt >= deletion.from && row.visitedAt <= deletion.to;
    const doomed = deletion.urls
      ? rows.filter(row => deletion.urls.includes(row.url))
      : rows.filter(
          row =>
            inRange(row) && (deletion.scope === "all" || row.device === device)
        );
    if (doomed.length) {
      await this.#mutate(week, {
        kind: "batch",
        ops: doomed.map(row => ({ kind: "remove", id: row.id })),
      });
      for (const row of doomed) {
        entry.visits.delete(row.id);
      }
      this.#wroteTo(week);
      // The user deleted these in front of them, and expects them gone from
      // every device, so the current week's interval does not hold this.
      this.#engine.publishSoon(week);
    } else if (this.#settled(entry) && week !== this.#current) {
      await this.#closeWeek(week);
    }
    if (!deletion.urls && deletion.scope !== "all" && deletion.restore) {
      await this.#insert(
        rows.filter(row => inRange(row) && row.device !== device)
      );
    }
  }

  /**
   * Runs a history clear of `range` (`[from, to]` in microseconds, or null
   * for everything) through `clear`, Firefox's own, and carries it into the
   * documents with the scope the clear dialog chose (history-sync spec §4.2).
   *
   * @param {Array<number>|null} range
   * @param {Function} clear Clears Places.
   * @returns {Promise<void>}
   */
  async clearHistory(range, clear) {
    const scope = nextClearScope;
    const restore = fromDialog;
    nextClearScope = "device";
    fromDialog = false;
    this.#clearing = true;
    try {
      await clear();
    } finally {
      this.#clearing = false;
    }
    const from = range ? Math.floor(range[0] / 1000) : 0;
    const to = range ? Math.ceil(range[1] / 1000) : this.#now();
    await this.#queue.run(() =>
      this.#queueDeletion({ from, to, scope, restore })
    );
  }

  /**
   * Sets the scope the next history clear takes: `"device"` for this
   * device's visits, `"all"` for every device's. It applies once.
   *
   * @param {"device"|"all"} scope
   */
  static set nextClearScope(scope) {
    nextClearScope = scope === "all" ? "all" : "device";
    fromDialog = true;
  }

  static get nextClearScope() {
    return nextClearScope;
  }

  /**
   * Firefox's history clear (`Sanitizer.items.history`), which calls this
   * with its own clear, so Clear Recent History and clearing on shutdown
   * reach the documents with their scope through the process's instance.
   *
   * @param {Array<number>|null} range As {@link clearHistory} takes it.
   * @param {Function} clear Clears Places.
   * @returns {Promise<void>}
   */
  static clearsHistory(range, clear) {
    const sync = shared.instance;
    return sync ? sync.clearHistory(range, clear) : clear();
  }

  /**
   * Adds the scope to Clear Recent History, and forgets a scope the dialog
   * chose once its clear is done. Once for the process.
   */
  static watchClears() {
    if (watchingClears) {
      return;
    }
    watchingClears = true;
    SvalChromePages.on(url => url === CLEAR_DIALOG_URL, addClearScope);
    // A dialog that chose every device's history and then cleared none
    // leaves nothing behind for the next clear, such as one on shutdown.
    Services.obs.addObserver(() => {
      nextClearScope = "device";
      fromDialog = false;
    }, "sanitizer-sanitization-complete");
  }

  /**
   * The state file in the profile, read and saved soon after each change. A
   * change still waiting as the profile closes is written then, so a visit
   * made just before quitting is still published at the next start.
   *
   * @param {object} [options] For tests.
   * @param {string} [options.path] The file; {@link STATE_FILE} in the
   *   profile by default.
   * @param {object} [options.finalizeAt] As `SvalSaver` takes it.
   * @param {number} [options.saveDelayMs]
   * @returns {object} `{ read, write, saver }`.
   */
  static profileStorage({
    path = PathUtils.join(PathUtils.profileDir, STATE_FILE),
    finalizeAt,
    saveDelayMs = 1000,
  } = {}) {
    return {
      read() {
        return readJSONOrDiscard(path, "history sync's state file");
      },
      write(state) {
        return IOUtils.writeJSON(path, state, { tmpPath: `${path}.tmp` });
      },
      saver(get) {
        return new SvalSaver({
          what: "history sync's state",
          write: () => this.write(get()),
          delayMs: saveDelayMs,
          finalizeAt,
        });
      },
    };
  }

  /**
   * Places' history, as this module uses it.
   *
   * @returns {object} `{ enabled, observe, insert, seedPages, recentVisits,
   *   removeVisits, visitsBefore, workspacesOf, recordWorkspaces }`.
   */
  static historyStore() {
    const PlacesUtils = lazy.PlacesUtils;
    return {
      enabled() {
        return (
          Services.prefs.getBoolPref("places.history.enabled", true) &&
          !lazy.PrivateBrowsingUtils.permanentPrivateBrowsing
        );
      },
      /**
       * @param {object} on
       * @param {Function} on.visited `(visits)`, each `{ url, title,
       *   visitedAt, transition, hidden, visitId }`.
       * @param {Function} on.titled `(url, title)`.
       * @param {Function} on.removed `(urls)`: pages the user deleted.
       * @param {Function} on.cleared `()`: every page went.
       * @returns {Function} stops listening.
       */
      observe(on) {
        const listener = events => {
          const visits = [];
          const removed = [];
          for (const e of events) {
            switch (e.type) {
              case "page-visited":
                visits.push({
                  url: e.url,
                  title: e.lastKnownTitle ?? "",
                  visitedAt: e.visitTime,
                  transition: e.transitionType,
                  hidden: e.hidden,
                  visitId: e.visitId,
                });
                break;
              case "page-title-changed":
                on.titled(e.url, e.title);
                break;
              case "page-removed":
                if (
                  e.isRemovedFromStore &&
                  e.reason === PlacesVisitRemoved.REASON_DELETED
                ) {
                  removed.push(e.url);
                }
                break;
              case "history-cleared":
                on.cleared();
                break;
            }
          }
          if (visits.length) {
            on.visited(visits);
          }
          if (removed.length) {
            on.removed(removed);
          }
        };
        const types = [
          "page-visited",
          "page-title-changed",
          "page-removed",
          "history-cleared",
        ];
        PlacesUtils.observers.addListener(types, listener);
        return () => PlacesUtils.observers.removeListener(types, listener);
      },
      /**
       * Inserts every visit Places accepts. `insertMany` validates the whole
       * batch first and refuses all of it for one visit it would not take,
       * such as one dated in this device's future by another device's clock,
       * so each visit is put to Places' own check (`validatePageInfo`) and
       * only those it refuses are left out. A visit with no time is left out
       * as Firefox's history engine leaves one out (`HistoryStore` in
       * `services/sync/modules/engines/history.sys.mjs`): `validatePageInfo`
       * passes it, and `History::UpdatePlaces` then refuses the whole batch.
       *
       * @param {object[]} rows As the engine's `visits()` lists them.
       */
      async insert(rows) {
        const byUrl = Map.groupBy(rows, row => row.url);
        const pages = [];
        let refused = 0;
        for (const [url, all] of byUrl) {
          const visits = [];
          for (const row of all) {
            if (!row.visitedAt) {
              refused++;
              continue;
            }
            const visit = {
              date: new Date(row.visitedAt),
              transition: PlacesUtils.history.isValidTransition(row.transition)
                ? row.transition
                : PlacesUtils.history.TRANSITIONS.LINK,
            };
            try {
              PlacesUtils.validatePageInfo({ url, visits: [visit] });
              visits.push(visit);
            } catch {
              refused++;
            }
          }
          if (visits.length) {
            pages.push({ url, title: all.at(-1).title || undefined, visits });
          }
        }
        if (refused) {
          SvalLog.info(
            `history: Places refused ${refused} visit(s) from another device`
          );
        }
        if (pages.length) {
          await PlacesUtils.history.insertMany(pages);
        }
      },
      /**
       * @param {number[]} visitIds Places' ids of visits.
       * @returns {Promise<Map<number, string>>} The workspace of each made in
       *   one.
       */
      workspacesOf(visitIds) {
        return lazy.SvalVisitWorkspaces.workspacesOf(visitIds);
      },
      /** @param {object[]} rows As the engine's `visits()` lists them. */
      recordWorkspaces(rows) {
        return lazy.SvalVisitWorkspaces.record(rows);
      },
      /**
       * The pages Firefox's history engine first uploads.
       *
       * @param {number} since Milliseconds since the epoch.
       * @param {number} limit
       * @returns {Promise<string[]>} URLs of pages visited after `since`, by
       *   frecency.
       */
      seedPages(since, limit) {
        return lazy.PlacesSyncUtils.history.getAllURLs({
          since: new Date(since),
          limit,
        });
      },
      /**
       * @param {string} url
       * @returns {Promise<object[]>} The page's newest visits, newest first,
       *   as many as Firefox's history engine sends: `{ visitedAt,
       *   transition }`.
       */
      async recentVisits(url) {
        const visits =
          await lazy.PlacesSyncUtils.history.fetchVisitsForURL(url);
        return visits.map(({ date, type }) => ({
          visitedAt: Math.floor(date / 1000),
          transition: type,
        }));
      },
      /** @param {object[]} visits `{ url, at }`. */
      async removeVisits(visits) {
        for (const { url, at } of visits) {
          await PlacesUtils.history.removeVisitsByFilter({
            url,
            beginDate: new Date(at),
            endDate: new Date(at + 1),
          });
        }
      },
      /**
       * Up to `limit` visits, newest first, from where the last page ended.
       * Visits are ordered by time, then by their row in
       * `moz_historyvisits`, so visits made at one instant, as an import
       * makes them, are each read once.
       *
       * @param {?object} after The last page's `next`, or null for the
       *   newest visits.
       * @param {number} limit
       * @returns {Promise<object>} `{ visits, next }`: each visit `{ url,
       *   title, visitedAt, transition, hidden, workspace }`, and where the next
       *   page starts, or null when this is the last.
       */
      async visitsBefore(after, limit) {
        const db = await PlacesUtils.promiseDBConnection();
        const rows = await db.executeCached(
          `SELECT h.url, h.title, h.hidden, v.id, v.visit_date, v.visit_type,
                  w.workspace
           FROM moz_historyvisits v JOIN moz_places h ON h.id = v.place_id
           LEFT JOIN sval_visit_workspaces w ON w.visit_id = v.id
           WHERE (v.visit_date, v.id) < (:date, :id)
           ORDER BY v.visit_date DESC, v.id DESC LIMIT :limit`,
          // The first page starts past every visit, so each page is one
          // range over moz_historyvisits_dateindex.
          { ...(after ?? { date: Number.MAX_SAFE_INTEGER, id: 0 }), limit }
        );
        const last = rows.at(-1);
        return {
          visits: rows.map(row => ({
            url: row.getResultByName("url"),
            title: row.getResultByName("title") ?? "",
            visitedAt: Math.floor(row.getResultByName("visit_date") / 1000),
            transition: row.getResultByName("visit_type"),
            hidden: !!row.getResultByName("hidden"),
            workspace: row.getResultByName("workspace"),
          })),
          next:
            rows.length < limit
              ? null
              : {
                  date: last.getResultByName("visit_date"),
                  id: last.getResultByName("id"),
                },
        };
      },
    };
  }

  /** @returns {?object} `{ engine, sync }` for the process's instance. */
  static get shared() {
    return shared.shared;
  }

  /** Stops the process's instance and forgets it, for tests and shutdown. */
  static stopShared() {
    releaseShutdown();
    return shared.stop();
  }

  /**
   * Moves the shutdown blocker onto `client`.
   *
   * For a test, which passes an `AsyncShutdown.Barrier`'s client and triggers
   * the blocker with `wait()`, as `SvalEngine.setShutdownClient` does.
   *
   * @param {object|null} client An `nsIAsyncShutdownClient`, or null for
   *   `PlacesUtils.history.shutdownClient`.
   * @param {object} [options]
   * @param {number} [options.timeoutMs] The blocker's deadline.
   */
  static setShutdownClient(client, { timeoutMs = STOP_TIMEOUT_MS } = {}) {
    releaseShutdown();
    shutdownClientOverride = client;
    shutdownTimeoutMs = timeoutMs;
    if (shared.shared) {
      holdShutdown();
    }
  }

  /** @returns {SvalHistorySync|null} The process's instance once made. */
  static get instance() {
    return shared.instance;
  }

  /**
   * Starts history sync for `engine`, once for the process
   * (`SvalProcessInstance`), as `SvalFavoritesStore.startFor` does.
   *
   * @param {object} engine The profile's engine.
   * @param {object} [options] As the constructor takes, beside `engine`.
   * @returns {Promise<SvalHistorySync>}
   */
  static startFor(engine, options = {}) {
    holdShutdown();
    return shared.startFor(engine, options);
  }
}
