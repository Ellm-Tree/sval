/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The host side of getting a key onto a second device (spec §6.7): writing a
 * sealed offer into the shared folder, finding one there, and cleaning up
 * after.
 *
 * Generating a code, sealing, opening and reading an expiry are wasm calls
 * that exist only inside the worker `SvalEngine` owns, so this module reaches
 * them through one. Pairing has no document of its own: `sealPairing` and
 * `openPairing` work on whatever key bytes they are handed, so the engine
 * behind that call carries no identity, only a running wasm module.
 *
 * `sval/pair/` sits outside the hashed `syncPrefix` directory a device's own
 * key would put it under, because a device that does not yet hold the key
 * could never compute that hash and so could never find an offer filed
 * beneath it.
 */

import {
  SvalSharedFolder,
  SHARED_STEP_TIMEOUT_MS,
} from "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs";
import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  SvalEngine: "moz-src:///browser/components/sval/SvalEngine.sys.mjs",
});

/**
 * How long an offer stays claimable. A SharePoint-backed folder polls roughly
 * every 30 minutes (spec §6.4), so an hour is the first figure that survives
 * one full missed poll. The figure is a product choice; it is not derived
 * from latency figures here.
 */
const PAIRING_TTL_MS = 60 * 60 * 1000;

/**
 * The furthest ahead of now an offer's expiry may be and still count as one
 * Sval wrote: 24 hours, far past {@link PAIRING_TTL_MS} plus any clock skew
 * between two devices. The expiry is read without the code, so anyone who can
 * write to the folder can claim any expiry; a file past this is stale, is
 * never tried against a code, and `sweep` removes it (spec §6.7).
 */
const PAIRING_MAX_AHEAD_MS = 24 * 60 * 60 * 1000;

/**
 * Whether an offer with expiry `expiresAt` is stale at `now` (spec §6.7):
 * expired, or expiring further ahead than an offer Sval writes ever does.
 *
 * @param {number} expiresAt What `pairingExpiresAt` read from the file.
 * @param {number} now Milliseconds since the epoch.
 * @returns {boolean}
 */
function isStale(expiresAt, now) {
  return expiresAt <= now || expiresAt > now + PAIRING_MAX_AHEAD_MS;
}

/**
 * How often a look that is still waiting claims again.
 *
 * A code typed before the file has synced is the common case, since spec
 * §6.4 measures a SharePoint-backed folder's poll in tens of minutes, so a
 * look keeps claiming on the user's behalf rather than asking them to press
 * a button they cannot know the right moment for. The same interval as
 * `SvalTabs`' `DEFAULT_POLL_MS`, for the same reasons: a claim is one listing
 * of the pairing folder and one small read, and pairing waits on the same
 * provider to deliver the same folder as sync does.
 */
export const CLAIM_POLL_MS = 5000;

/**
 * The engine's codes for a pairing file `code` does not open: a wrong code,
 * or bytes that are not a pairing file (host contract §8).
 */
const OPEN_REFUSALS = new Set(["bad_pairing_code", "malformed_pairing_file"]);

/**
 * Where offers live, relative to the storage root: never under a workspace
 * prefix (see the top of this file).
 */
const PAIR_DIR_SEGMENTS = ["sval", "pair"];

/**
 * The engine every pairing call shares, whichever device's key it seals or
 * opens. `sync` and `mutate` are never called on it, so its identity fields
 * are never used.
 *
 * Its own worker, so Argon2id never holds up the profile's sync queue, and
 * one that lives only while a call uses it: Argon2id grows the worker's wasm
 * memory past 64 MiB (sval-core's `pairing.rs`), and wasm memory never
 * shrinks.
 */
let pairingEngine = null;

/** The calls using {@link pairingEngine} now. */
let pairingUsers = 0;

/**
 * Runs `work` with the pairing engine, and stops the engine once no call is
 * using it.
 *
 * @param {Function} work `(engine) => Promise`.
 * @returns {Promise<*>} what `work` resolves to.
 */
async function withEngine(work) {
  pairingEngine ??= new lazy.SvalEngine({
    root: "",
    keyBytes: new Uint8Array(32),
    deviceId: new Uint8Array(16),
  });
  const engine = pairingEngine;
  pairingUsers++;
  try {
    return await work(engine);
  } finally {
    if (--pairingUsers === 0) {
      pairingEngine = null;
      engine.terminate();
    }
  }
}

function pairDir(root) {
  return PathUtils.join(root, ...PAIR_DIR_SEGMENTS);
}

/**
 * The most an offer is read to. An offer is sval-core's pairing envelope: a
 * salt and a sealed key of fixed lengths, which `openPairing` checks, and two
 * times, a few hundred bytes of JSON. A file far larger is not one, and is
 * listed as unreadable without being read.
 */
const OFFER_MAX_BYTES = 4096;

/** The pairing folder relative to the storage folder, as the helper takes it. */
const PAIR_PATH = PAIR_DIR_SEGMENTS.join("/");

/** One shared-folder request's deadline (local-copy spec §4.2). */
function deadline() {
  return Date.now() + SHARED_STEP_TIMEOUT_MS;
}

/**
 * The storage folder an offer lives in. An offer's path is always
 * `<root>/sval/pair/<file>`, because `offer` builds it that way.
 *
 * @param {string} path An offer's absolute path.
 * @returns {string}
 */
function rootOf(path) {
  return PathUtils.parent(PathUtils.parent(PathUtils.parent(path)));
}

/**
 * The error a request that got no answer rejects with. `reason` is the
 * helper's.
 *
 * @param {object} result A `{ reachable: false, reason }` answer.
 * @returns {Error}
 */
function unavailable(result) {
  const error = new Error(
    `sval: the shared folder is unavailable (${result.reason})`
  );
  error.reason = result.reason;
  return error;
}

/**
 * Lists the pairing folder through the helper, once.
 *
 * @param {string} root Absolute path of the user's storage folder.
 * @param {object} [options]
 * @param {string|null} [options.requireTop] A directory below `root` that must
 *   exist for the folder to count as mounted, or null.
 * @param {number} [options.until] The request's deadline.
 * @returns {Promise<object>} The helper's answer: `{ reachable: true,
 *   entries, unreadable }`, or `{ reachable: false, reason }`.
 */
function listOffers(root, { requireTop = null, until = deadline() } = {}) {
  return SvalSharedFolder.readDir({
    root,
    path: PAIR_PATH,
    suffix: null,
    mine: null,
    maxBytes: OFFER_MAX_BYTES,
    requireTop,
    deadline: until,
  });
}

/**
 * @param {object} entry One of a listing's entries.
 * @returns {Uint8Array} The file's bytes.
 */
function bytesOf(entry) {
  return new Uint8Array(
    ChromeUtils.base64URLDecode(entry.data, { padding: "require" })
  );
}

/**
 * 16 random bytes, hex-encoded, independent of the pairing code: a
 * filename anyone could compute from a guess would turn a 60-bit code into a
 * cheap dictionary attack against a directory listing (spec §6.7).
 *
 * @returns {string} A 32-character hex filename, with `.json`.
 */
function randomFilename() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${bytes.toHex()}.json`;
}

/**
 * `SvalPairing.claim`'s candidates, tried in turn.
 *
 * @param {object} eng The pairing engine.
 * @param {string} root Absolute path of the user's storage folder.
 * @param {object[]} entries The offers the helper read.
 * @param {string} code The code the user typed.
 * @param {number} now Milliseconds since the epoch.
 * @returns {Promise<object>} what `claim` answers.
 */
async function tryOffers(eng, root, entries, code, now) {
  let sawCandidate = false;

  // A file the helper could not read is not a candidate (`read.unreadable`).
  for (const entry of entries) {
    const path = PathUtils.join(pairDir(root), entry.name);
    const bytes = bytesOf(entry);

    let expiresAt;
    try {
      expiresAt = await eng.pairingExpiresAt(bytes);
    } catch {
      // Not a pairing file: a `.DS_Store`, a half-synced leftover, a
      // conflicted copy a cloud client wrote. It is not a candidate this code
      // could have opened.
      continue;
    }
    if (isStale(expiresAt, now)) {
      // Expired, or not an offer Sval wrote: neither says the user's code is
      // wrong.
      continue;
    }

    sawCandidate = true;

    let keyBytes;
    try {
      keyBytes = await eng.openPairing(bytes, code);
    } catch (err) {
      // Wrong code for this file; there may be another offer, or another
      // stale file, still to try. Any other failure says nothing about the
      // code, and answering "no-match" for it would tell the user a right
      // code is wrong.
      if (!OPEN_REFUSALS.has(err?.code)) {
        throw err;
      }
      continue;
    }

    return { status: "claimed", keyBytes, path };
  }

  return { status: sawCandidate ? "no-match" : "waiting" };
}

export const SvalPairing = {
  /**
   * Writes a sealed offer of `keyBytes` into `root`'s pairing folder.
   *
   * @param {string} root Absolute path of the user's storage folder.
   * @param {Uint8Array} keyBytes The 32-byte document key to hand off.
   * @param {number} [now] Milliseconds since the epoch.
   * @returns {Promise<object>} `{ code, path, expiresAt }`. Rejects, with
   *   `reason` the helper's, when the folder does not answer, and with
   *   "no-sval-dir" when it does not hold `sval/` (`SvalEngine`'s `TOP_DIR`).
   */
  async offer(root, keyBytes, now = Date.now()) {
    const { code, sealed } = await withEngine(async eng => {
      const fresh = await eng.generatePairingCode();
      return {
        code: fresh,
        sealed: await eng.sealPairing(keyBytes, fresh, now, PAIRING_TTL_MS),
      };
    });

    const name = randomFilename();
    // The helper writes then renames, as every other Sval write does (spec
    // §6.3): a device listing this folder never sees a half-written offer.
    const result = await SvalSharedFolder.writeFile({
      root,
      path: `${PAIR_PATH}/${name}`,
      bytes: sealed,
      requireTop: PAIR_DIR_SEGMENTS[0],
      deadline: deadline(),
    });
    if (!result.reachable) {
      throw unavailable(result);
    }
    const target = PathUtils.join(pairDir(root), name);

    return { code, path: target, expiresAt: now + PAIRING_TTL_MS };
  },

  /**
   * Tries `code` against every file in `root`'s pairing folder that is not
   * stale (`isStale`). There is normally one. The filename carries nothing
   * of the code (`randomFilename`), so this lists the directory.
   *
   * The result tells "no offer has arrived yet" from "an offer is here and
   * this code does not open it". One answer for both would tell someone
   * whose code is right, but whose slow provider has not delivered the file
   * yet, that their code is wrong (`CLAIM_POLL_MS`).
   *
   * A file that cannot be read, cannot be parsed as a pairing file, or is
   * stale is not a candidate: it counts as no file, `"waiting"`, never
   * `"no-match"`. Only a file this call could put a code to is grounds to
   * say the code was wrong.
   *
   * The offer is left in place. Deleting it is the caller's, once the
   * adopted key has been persisted: an adoption abandoned before that, by a
   * publish that failed or a browser that closed, has changed nothing, and
   * the user must be able to retry with the code they already have.
   * `SvalPanel.adoptKey` calls `withdraw` at the end, and `sweep` collects
   * an offer whose claimer never got that far. A spent offer not yet
   * withdrawn stays openable for the length of one adoption: a second or two
   * against a 60-bit code behind Argon2id.
   *
   * @param {string} root Absolute path of the user's storage folder.
   * @param {string} code The code, as the user typed it.
   * @param {number} [now] Milliseconds since the epoch.
   * @returns {Promise<object>} One of:
   *   - `{ status: "claimed", keyBytes, path }`: `code` opened the candidate
   *     at `path`, which is still in the folder.
   *   - `{ status: "waiting" }`: the folder holds no parseable candidate
   *     that is not stale.
   *   - `{ status: "no-match" }`: at least one candidate was tried and none
   *     opened under `code`.
   */
  async claim(root, code, now = Date.now()) {
    const read = await listOffers(root);
    if (!read.reachable) {
      // The next poll asks again.
      return { status: "waiting" };
    }
    if (!read.entries.length) {
      return { status: "waiting" };
    }
    return withEngine(eng => tryOffers(eng, root, read.entries, code, now));
  },

  /**
   * Deletes one offer (spec §6.7). Called by the device that adopted the key
   * it held, once that key is persisted, and by the device that made it when
   * the user cancels.
   *
   * @param {string} path Absolute path of the offer file.
   */
  async withdraw(path) {
    const result = await SvalSharedFolder.remove({
      root: rootOf(path),
      path: `${PAIR_PATH}/${PathUtils.filename(path)}`,
      requireTop: PAIR_DIR_SEGMENTS[0],
      deadline: deadline(),
    });
    if (!result.reachable) {
      throw unavailable(result);
    }
  },

  /**
   * Withdraws the offer at `path` once `earlier`, a withdrawal of it already
   * running, has failed; does nothing if it succeeded. It lives here, not
   * in the page that asks, because the page may be gone by the time
   * `earlier` settles.
   *
   * @param {Promise} earlier A `withdraw` of the same offer.
   * @param {string} path Absolute path of the offer file.
   */
  async withdrawUnlessDone(earlier, path) {
    try {
      await earlier;
      return;
    } catch {
      // It failed, so the offer may still be in the folder.
    }
    await this.withdraw(path);
  },

  /**
   * Whether the offer at `path` is still in the folder, or null when the
   * folder did not answer. The offering page reads a disappearance as "the
   * other device took it", so not answering must not read as gone.
   *
   * `sval/pair/` must exist for an absence to count. A mount point that is not
   * mounted is an empty directory, and an offer is "gone" from it too. Only an
   * offer creates `sval/pair/`, and Sval removes offers but never that
   * directory, so a folder holding it is the one the offer went into.
   *
   * @param {string} path An offer's absolute path.
   * @returns {Promise<boolean|null>}
   */
  async stillOffered(path) {
    const name = PathUtils.filename(path);
    const read = await listOffers(rootOf(path), { requireTop: PAIR_PATH });
    if (!read.reachable) {
      return null;
    }
    return (
      read.entries.some(entry => entry.name === name) ||
      read.unreadable.some(note => note.name === name)
    );
  },

  /**
   * Deletes every stale offer (`isStale`) in `root`'s pairing folder: any
   * device that sees a stale one can remove it, for the offering device that
   * closed before it could withdraw its own, and for a file Sval did not
   * write (spec §6.7).
   *
   * A file that cannot be read or cannot be parsed as a pairing file is left
   * alone: this call cannot tell a stray file from one it cannot make sense
   * of, and only `pairingExpiresAt` deciding a file is stale is grounds to
   * remove it.
   *
   * @param {string} root Absolute path of the user's storage folder.
   * @param {number} [now] Milliseconds since the epoch.
   */
  async sweep(root, now = Date.now()) {
    const read = await listOffers(root);
    if (!read.reachable || !read.entries.length) {
      return;
    }
    const expiries = await withEngine(async eng => {
      const found = [];
      for (const entry of read.entries) {
        found.push(
          await eng.pairingExpiresAt(bytesOf(entry)).catch(() => null)
        );
      }
      return found;
    });

    for (const [i, entry] of read.entries.entries()) {
      const expiresAt = expiries[i];
      if (expiresAt === null) {
        continue;
      }

      if (isStale(expiresAt, now)) {
        // Best-effort: a file that resists deletion, or a folder that does
        // not answer, leaves an offer that is still stale next time `sweep`
        // runs.
        await SvalSharedFolder.remove({
          root,
          path: `${PAIR_PATH}/${entry.name}`,
          requireTop: PAIR_DIR_SEGMENTS[0],
          deadline: deadline(),
        });
      }
    }
  },
};

/**
 * One code's look for its offer: it claims, waits on `waiting` and claims
 * again, until the code is claimed or refused, a claim fails, or the look is
 * stopped. Every page that takes a code looks through one, so each keeps the
 * same rules.
 *
 * - Only the current look's answers reach its page. Starting or stopping a
 *   look moves the run on, so a claim that answers after its look ended is
 *   about a code the user has already taken back, and is dropped.
 * - One claim at a time. A look started while an earlier claim still runs
 *   waits for that claim to settle: a claim can hold what an adoption will
 *   take, and two at once would both open the offer.
 * - `waiting` is not a failure (`SvalPairing.claim`). It reaches the page so
 *   the page can say nothing has arrived, and the look goes on.
 */
export class SvalPairingLook {
  #run = 0;
  #looking = false;
  #claiming = null;
  #timer = null;
  #timers;

  /** Milliseconds between claims while the answer is `waiting`. */
  pollMs;

  /**
   * @param {object} [options]
   * @param {object} [options.timers] `{ setTimeout, clearTimeout }`; the
   *   process's by default, so a look outlives the window that started it
   *   until it is stopped.
   * @param {number} [options.pollMs] See {@link CLAIM_POLL_MS}.
   */
  constructor({
    timers = { setTimeout, clearTimeout },
    pollMs = CLAIM_POLL_MS,
  } = {}) {
    this.#timers = timers;
    this.pollMs = pollMs;
  }

  /** Whether a look is running: started, and not yet ended or stopped. */
  get looking() {
    return this.#looking;
  }

  /**
   * Starts a look, ending any look already running.
   *
   * @param {Function} claim `() => Promise<object>`: one claim of the code,
   *   answering as `SvalPairing.claim` does.
   * @param {Function} onAnswer `(answer) => void`, given each answer of this
   *   look while it is current: `{ status: "waiting" }` for every answer that
   *   leaves the look going, then the one that ends it: `claimed`, with
   *   what the claim found, `no-match`, or `{ status: "failed", error }`
   *   when the claim threw. The look has ended before an ending answer is
   *   given, so the page may start another from it.
   */
  start(claim, onAnswer) {
    this.stop();
    this.#looking = true;
    this.#claimFor(this.#run, claim, onAnswer);
  }

  /** Ends the running look, if there is one; its answers are dropped. */
  stop() {
    this.#run++;
    this.#looking = false;
    if (this.#timer !== null) {
      this.#timers.clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  async #claimFor(run, claim, onAnswer) {
    while (this.#claiming && run === this.#run) {
      await this.#claiming.catch(() => {});
    }
    if (run !== this.#run) {
      return;
    }
    const claiming = (async () => claim())();
    this.#claiming = claiming;
    let answer;
    try {
      answer = await claiming;
    } catch (error) {
      answer = { status: "failed", error };
    } finally {
      if (this.#claiming === claiming) {
        this.#claiming = null;
      }
    }
    if (run !== this.#run) {
      return;
    }
    if (!["claimed", "no-match", "failed"].includes(answer?.status)) {
      this.#timer = this.#timers.setTimeout(() => {
        this.#timer = null;
        if (run === this.#run) {
          this.#claimFor(run, claim, onAnswer);
        }
      }, this.pollMs);
      onAnswer({ status: "waiting" });
      return;
    }
    this.stop();
    onAnswer(answer);
  }
}
