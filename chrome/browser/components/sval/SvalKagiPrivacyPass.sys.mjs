/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Kagi's Privacy Pass tokens, which sign private windows in to Kagi (Kagi
 * Privacy Pass spec, decision 0091). Kagi can check that a token comes from a
 * subscriber, and cannot tell which subscriber.
 *
 * This module keeps the stock and refills it. `SvalKagi` spends it, one token
 * per request, in private windows.
 *
 * **Refilling uses the normal window's session, and nothing else does.** The
 * `kagi_session` value goes only into the `Authorization` header of the
 * issuance POST to `kagi.com`, made from chrome with no cookies and no
 * referrer. Kagi learns that the account fetched a batch; it cannot tell which
 * search spent which token.
 *
 * **The stock is a credential.** It lives in `SvalSecretStore`, per device and
 * never synced, and no diagnostic here names a token, a challenge, a client
 * state or a session value. Tokens are spent newest first. Those issued before
 * the start of the previous calendar month are dropped on read, because Kagi
 * has retired the key they were issued under. Signing out of a normal window
 * keeps the stock, because a token carries nothing that names the account.
 */

import { SvalWorkerClient } from "moz-src:///browser/components/sval/SvalWorkerClient.sys.mjs";
import { SvalSerialQueue } from "moz-src:///browser/components/sval/SvalSerialQueue.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  SvalKagi: "moz-src:///browser/components/sval/SvalKagi.sys.mjs",
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  SvalSecretStore: "moz-src:///browser/components/sval/SvalSecretStore.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const WORKER_URL = "chrome://browser/content/sval/SvalKagi.worker.mjs";

const CHALLENGE_URL = "https://kagi.com/pp/wwwa";
const ISSUE_URL = "https://kagi.com/pp/gettokens";
/** The header that tells Kagi a request is a Privacy Pass client's. */
export const CLIENT_HEADER = "X-Kagi-PrivacyPass-Client";

/** Kagi issues this many per request, and allows ten requests a month. */
const BATCH = 300;
/** A refill starts when the stock falls to this. */
const LOW = 50;

/** The stock's name in `SvalSecretStore`. */
const SECRET_NAME = "kagi privacy pass";

/** A failed refill is tried again after this, doubling up to the cap. */
const RETRY_FIRST_MS = 60 * 1000;
const RETRY_MAX_MS = 60 * 60 * 1000;

/** What Kagi's 403 says when the plan has no Privacy Pass. */
const UNSUPPORTED_ERRORS = new Set([
  "no_subscription",
  "unsupported_subscription",
]);

/** A token as the redemption header carries it: base64url, padded. */
const TOKEN = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * @param {number} now Milliseconds since the epoch.
 * @returns {number} 00:00 UTC on the 1st of the month after `now`'s.
 */
function nextMonth(now) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

/**
 * @param {number} now Milliseconds since the epoch.
 * @returns {number} 00:00 UTC on the 1st of the month before `now`'s.
 */
function previousMonth(now) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1);
}

/** The engine worker for one refill. */
class KagiWorker extends SvalWorkerClient {
  constructor() {
    super(WORKER_URL);
  }
}

/**
 * Raised when a refill should not be retried soon: Kagi answered, and the
 * answer is the state.
 */
class Settled extends Error {}

export const SvalKagiPrivacyPass = {
  BATCH,
  LOW,

  /** Tokens as `[token, issuedMs]`, oldest first. Null until loaded. */
  _tokens: null,
  _unsupported: false,
  _outUntil: 0,
  /** Set when the engine is the public stub; not stored. */
  _unavailable: false,
  _engineChecked: false,
  _loaded: null,
  _tail: new SvalSerialQueue("privacy pass store"),
  _refilling: null,
  _retryTimer: null,
  _retryMs: RETRY_FIRST_MS,
  _run: 0,
  _listeners: new Set(),
  /** Replaced by tests. */
  _now: () => Date.now(),
  _fetch: (...args) => fetch(...args),
  _makeWorker: () => new KagiWorker(),

  /**
   * Reads the stock, and refills at once when it is empty and a normal window
   * is signed in. Idempotent.
   *
   * @returns {Promise<void>} once the stock is read; never rejects.
   */
  async start() {
    try {
      await this._load();
    } catch (err) {
      this._warn(err);
      return;
    }
    if (!this._tokens.length) {
      await this._checkEngine();
      this.refill();
    }
  },

  /**
   * Learns whether this build has an engine to make tokens with, once per
   * process, so that a build without one says so before any refill is tried.
   */
  async _checkEngine() {
    if (this._engineChecked) {
      return;
    }
    this._engineChecked = true;
    const worker = this._makeWorker();
    try {
      await worker.post("ready");
    } catch (err) {
      if (err?.code === "engine_not_built") {
        this._unavailable = true;
        this._changed();
      } else {
        this._engineChecked = false;
        this._warn(err);
      }
    } finally {
      worker.terminate();
    }
  },

  /** Forgets everything in memory, so a test can start again. */
  _reset() {
    this._run++;
    lazy.clearTimeout(this._retryTimer);
    this._retryTimer = null;
    this._retryMs = RETRY_FIRST_MS;
    this._tokens = null;
    this._unsupported = false;
    this._outUntil = 0;
    this._unavailable = false;
    this._engineChecked = false;
    this._loaded = null;
    this._refilling = null;
    this._tail = new SvalSerialQueue("privacy pass store");
  },

  /**
   * What private windows get from Kagi, synchronously, for the request
   * observer and Settings. Before the stock is read it is `signedOut`.
   *
   * @returns {"unavailable"|"ready"|"out"|"unsupported"|"signedOut"}
   */
  state() {
    if (this._unavailable) {
      return "unavailable";
    }
    if (this._tokens?.length) {
      return "ready";
    }
    if (this._unsupported) {
      return "unsupported";
    }
    if (this._outUntil > this._now()) {
      return "out";
    }
    if (this._outUntil) {
      // The allowance has reset since it ran out. Nothing else would ask Kagi
      // again before a restart, so the first look at the state does.
      this._outUntil = 0;
      this._persist();
      this.refill();
    }
    return "signedOut";
  },

  /** @returns {number} how many tokens are left. */
  count() {
    return this._tokens?.length ?? 0;
  },

  /** @returns {number} when an `out` stock is allowed more, in ms. */
  outUntil() {
    return this._outUntil;
  },

  /**
   * Calls `listener` whenever the state or the count changes.
   *
   * @param {Function} listener
   * @returns {Function} what stops it.
   */
  addListener(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  },

  _changed() {
    for (const listener of this._listeners) {
      try {
        listener();
      } catch (err) {
        this._warn(err);
      }
    }
  },

  /**
   * Removes and returns the newest token, and refills when the stock is low.
   * Synchronous, because the request observer cannot wait.
   *
   * @returns {string|null} a token, or null when there is none.
   */
  take() {
    const entry = this._tokens?.pop();
    if (!entry) {
      return null;
    }
    this._persist();
    if (this._tokens.length <= LOW) {
      this.refill();
    }
    this._changed();
    return entry[0];
  },

  /**
   * A normal window signed in to Kagi: the plan may have changed, so Kagi is
   * asked again, and the stock refilled when it is low.
   *
   * `SvalKagi` calls this once per session value, not for each time Kagi sets
   * its session cookie again on its own responses. The stored state changes
   * only on Kagi's answer, and only when the answer differs from it:
   * `SvalSecretStore` asks the system store once per run, at the first read
   * or write that needs it, and macOS may show that as a prompt.
   */
  async signedIn() {
    try {
      await this._load();
    } catch (err) {
      this._warn(err);
      return;
    }
    if (this._unsupported || this._tokens.length <= LOW) {
      this.refill({ askAgain: true });
    }
  },

  /**
   * Settings' "Check again": asks Kagi again whether the plan includes
   * Privacy Pass.
   *
   * @returns {Promise<void>} once that refill has finished.
   */
  async checkAgain() {
    await this._load();
    this._unsupported = false;
    this._outUntil = 0;
    this._persist();
    this._changed();
    await this.refill();
  },

  /**
   * Refills the stock from Kagi, once at a time. Does nothing without a
   * normal-window session, on a plan without Privacy Pass unless asked again,
   * or while this month's allowance is used.
   *
   * @param {object} [options]
   * @param {boolean} [options.askAgain] Asks Kagi even when the plan was last
   *   found to have no Privacy Pass.
   * @returns {Promise<void>} once this refill, or the one already running,
   *   has finished; never rejects.
   */
  refill({ askAgain = false } = {}) {
    this._refilling ??= this._refillOnce(askAgain).finally(() => {
      this._refilling = null;
    });
    return this._refilling;
  },

  async _refillOnce(askAgain) {
    const run = this._run;
    try {
      await this._load();
      if (
        this._unavailable ||
        (this._unsupported && !askAgain) ||
        this._outUntil > this._now()
      ) {
        return;
      }
      const session = lazy.SvalKagi.sessionValue();
      if (!session) {
        return;
      }
      const tokens = await this._issue(session);
      if (run !== this._run) {
        return;
      }
      const now = this._now();
      this._tokens.unshift(...tokens.map(token => [token, now]));
      this._unsupported = false;
      this._outUntil = 0;
      this._retryMs = RETRY_FIRST_MS;
      this._persist();
      this._changed();
    } catch (err) {
      if (run !== this._run) {
        return;
      }
      if (err instanceof Settled) {
        this._retryMs = RETRY_FIRST_MS;
        return;
      }
      lazy.SvalLog.warn(
        `Kagi Privacy Pass tokens not fetched: ${lazy.SvalLog.errorName(err)}`
      );
      this._retryLater();
    }
  },

  _retryLater() {
    lazy.clearTimeout(this._retryTimer);
    this._retryTimer = lazy.setTimeout(() => {
      this._retryTimer = null;
      this.refill();
    }, this._retryMs);
    this._retryMs = Math.min(this._retryMs * 2, RETRY_MAX_MS);
  },

  /**
   * One issuance: the challenge, the request, Kagi's answer and the tokens.
   *
   * @param {string} session The normal window's `kagi_session` value.
   * @returns {Promise<string[]>} the tokens.
   */
  async _issue(session) {
    const request = {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "error",
    };
    const challengeResponse = await this._fetch(CHALLENGE_URL, {
      ...request,
      headers: { [CLIENT_HEADER]: "true" },
    });
    const challenge = challengeResponse.headers.get("WWW-Authenticate");
    if (!challenge) {
      throw new Error("Kagi sent no Privacy Pass challenge");
    }

    const worker = this._makeWorker();
    try {
      let issuance;
      try {
        issuance = await worker.post("tokenRequest", [
          { challenge, count: BATCH },
        ]);
      } catch (err) {
        if (err?.code === "engine_not_built") {
          this._unavailable = true;
          this._changed();
          throw new Settled();
        }
        throw err;
      }

      const response = await this._fetch(ISSUE_URL, {
        ...request,
        method: "POST",
        headers: {
          "Content-Type": "application/private-token-request",
          [CLIENT_HEADER]: "true",
          Authorization: session,
        },
        body: issuance.body,
      });
      const text = await response.text();
      await this._answered(response.status, text);

      const tokens = await worker.post("finalize", [
        { state: issuance.state, response: text },
      ]);
      if (!tokens.length) {
        this._out();
        throw new Settled();
      }
      return tokens.filter(token => TOKEN.test(token));
    } finally {
      worker.terminate();
    }
  },

  /**
   * Settles the state from an issuance answer that carries no tokens, and
   * throws for any answer that is not a batch.
   *
   * @param {number} status
   * @param {string} text The body.
   */
  async _answered(status, text) {
    if (status === 200 && text.trim()) {
      return;
    }
    if (status === 200 || status === 429) {
      this._out();
      throw new Settled();
    }
    if (status === 401) {
      throw new Settled();
    }
    if (status === 403) {
      let code = null;
      try {
        code = JSON.parse(text)?.error_code ?? null;
      } catch {}
      if (UNSUPPORTED_ERRORS.has(code)) {
        if (!this._unsupported) {
          this._unsupported = true;
          this._persist();
          this._changed();
        }
        throw new Settled();
      }
    }
    throw new Error(`Kagi answered ${status}`);
  },

  /** This month's allowance is used. */
  _out() {
    this._outUntil = nextMonth(this._now());
    this._persist();
    this._changed();
  },

  /**
   * Runs `task` after every task already queued, so reads and writes of the
   * store never interleave.
   *
   * @param {Function} task
   * @returns {Promise} the task's own outcome.
   */
  _queue(task) {
    return this._tail.run(task);
  },

  /**
   * Reads the store once. A read that failed is tried again on the next
   * load; `SvalSecretStore` keeps a refusal itself, so trying again asks the
   * system store nothing until the user takes a step that retries it.
   */
  async _load() {
    this._loaded ??= this._queue(() => this._read()).catch(err => {
      this._loaded = null;
      throw err;
    });
    await this._loaded;
  },

  async _read() {
    const run = this._run;
    let stored = null;
    const bytes = await lazy.SvalSecretStore.read(SECRET_NAME);
    if (bytes) {
      try {
        stored = JSON.parse(new TextDecoder().decode(bytes));
      } catch {}
    }
    if (run !== this._run) {
      return;
    }
    const oldest = previousMonth(this._now());
    const tokens = Array.isArray(stored?.tokens) ? stored.tokens : [];
    this._tokens = tokens.filter(
      entry =>
        Array.isArray(entry) &&
        typeof entry[0] === "string" &&
        TOKEN.test(entry[0]) &&
        Number.isFinite(entry[1]) &&
        entry[1] >= oldest
    );
    this._unsupported = stored?.unsupported === true;
    this._outUntil = Number.isFinite(stored?.outUntil) ? stored.outUntil : 0;
    if (this._tokens.length !== tokens.length) {
      this._persist();
    }
    this._changed();
  },

  /** Writes what is in memory, after every write already queued. */
  _persist() {
    const tokens = this._tokens ?? [];
    const snapshot = {
      tokens: tokens.slice(),
      unsupported: this._unsupported,
      outUntil: this._outUntil,
    };
    const empty =
      !snapshot.tokens.length && !snapshot.unsupported && !snapshot.outUntil;
    this._queue(() =>
      empty
        ? lazy.SvalSecretStore.remove(SECRET_NAME)
        : lazy.SvalSecretStore.write(
            SECRET_NAME,
            new TextEncoder().encode(JSON.stringify(snapshot))
          )
    ).catch(err => this._warn(err));
  },

  _warn(err) {
    lazy.SvalLog.warn(
      `Kagi Privacy Pass state not updated: ${lazy.SvalLog.errorName(err)}`
    );
  },
};
