/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The chrome-side face of Sval's sync engine: it owns one worker's lifetime and
 * exposes promises. The engine and all filesystem access live in that worker.
 *
 * One instance is one device: the key and device id supplied at construction
 * are stamped into everything it writes, and the worker behind it holds exactly
 * one document.
 */

import { SvalWorkerClient } from "moz-src:///browser/components/sval/SvalWorkerClient.sys.mjs";
import { noteTree } from "moz-src:///browser/components/sval/SvalTreeSnapshot.sys.mjs";
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";
import {
  SvalLog,
  svalLogLevel,
  describeError,
} from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import {
  SvalSharedFolder,
  SHARED_STEP_TIMEOUT_MS,
  folderProblem,
} from "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs";
import { syncableAddress } from "moz-src:///browser/components/sval/SvalSyncableAddress.sys.mjs";
import { toHex } from "moz-src:///browser/components/sval/SvalBytes.sys.mjs";
import { SvalClock } from "moz-src:///browser/components/sval/SvalClock.sys.mjs";

const WORKER_URL = "chrome://browser/content/sval/SvalSync.worker.mjs";

/** The operations that write an address into a node's content group. */
const ADDRESS_WRITES = new Set(["addTab", "setContent", "addFavorite"]);

/**
 * `op` with every address it writes marked `local` where `syncableAddress`
 * refuses it, a batch's operations included (decision 1372). The engine
 * stores the mark and never reads an address, so this is the one place a
 * write learns whether it may leave the device.
 *
 * A write that copies an address out of a node already in a document names
 * that node's mark as its own `local`, which is kept: an address another
 * device wrote carries none, and marking it here would let it open with this
 * device's trust. The engine keeps a node's mark itself on a write that
 * sends back the address the node holds.
 *
 * @param {object} op As {@link SvalEngine#mutate} takes it.
 * @returns {object}
 */
function markLocal(op) {
  if (op.kind === "batch") {
    return { ...op, ops: op.ops.map(markLocal) };
  }
  if (
    ADDRESS_WRITES.has(op.kind) &&
    typeof op.url === "string" &&
    typeof op.local !== "boolean"
  ) {
    return { ...op, local: !syncableAddress(op.url) };
  }
  return op;
}

/** Host contract §4: `Key` is 32 raw bytes. */
const KEY_BYTES = 32;

/**
 * Sval's top directory in a shared folder, and its mark: choosing a folder
 * makes it, and nothing is written into a folder that does not hold it. A
 * mount point that is not mounted is an empty local directory, and a write
 * into it would hide a file under the mount when it returns.
 */
export const TOP_DIR = "sval";

/**
 * The file in an engine's {@link TOP_DIR} that keeps the time this device's first time
 * reading arrived and the documents whose stamps from before it are pulled
 * back (decision 1714). It stays, so a restart between the reading and a
 * document's next pass, in this run or a later one, still pulls that
 * document's stamps back before it publishes.
 */
export const CLOCK_READING_FILE = "clock-reading.json";

/** Where every sync key's documents live in a folder (spec §6.2). */
const WORKSPACES_DIR = `${TOP_DIR}/ws`;

/** Where each device keeps its sealed copy of the sync key. */
const KEYS_DIR = `${TOP_DIR}/keys`;

/**
 * The most a sealed key copy is read to. One is `SvalSecretStore.wrap`'s
 * base64 of an IV, 32 key bytes and a tag, about 80 bytes; anything far
 * larger in `KEYS_DIR` is not one, and is left unread.
 */
const KEY_COPY_MAX_BYTES = 4096;

/**
 * How often a background pass exchanges files with the shared folder. Local
 * saves are not held to it: every pass writes the profile at once (local-copy
 * spec §4.2).
 */
export const SHARED_INTERVAL_MS = 30000;

/**
 * How long this device's own file in the shared folder stays unreadable
 * before it is set aside and written afresh (decision 1144): long enough for
 * a cloud client to finish downloading it.
 */
export const OWN_FILE_SET_ASIDE_MS = 10 * 60 * 1000;

/** The helper's reasons for an own entry that it will not move. */
const NOT_SET_ASIDE = new Set(["Symlink", "IsDirectory"]);

/**
 * The one engine this profile's windows share. See {@link SvalEngine.forProfile}.
 *
 * Nothing tears it down. A window closing must not take the profile's document
 * with it, and on macOS the application outlives its windows, so the engine
 * lives for the life of the process.
 */
let sharedEngine = null;

/**
 * An engine whose worker started before this profile's identity was read,
 * which the first {@link SvalEngine.forProfile} takes as the shared engine.
 * See {@link SvalEngine.prestart}.
 */
let prestarted = null;

/** What the constructor takes for an engine with no identity yet. */
const UNIDENTIFIED = Symbol("unidentified");

/**
 * How long the shutdown blocker waits for the last pass before letting the
 * application quit without it.
 *
 * A pass is a directory listing, one read per device and one atomic write, so
 * it normally takes milliseconds. AsyncShutdown crashes the process when a
 * phase is still blocked after `toolkit.asyncshutdown.crash_timeout` (60 s in
 * `modules/libpref/init/all.js`) and warns after 10 s (`DELAY_WARNING_MS` in
 * `AsyncShutdown.sys.mjs`); five seconds stays inside both, and other
 * blockers share the same phase. A pass cut off here loses only that pass: the
 * worker writes through `tmpPath`, so the file on disk is never half-written.
 */
const FINAL_PASS_TIMEOUT_MS = 5000;

/**
 * The share of an idle poll's interval within which another pass makes it
 * unnecessary. See `sync`'s `idleWithinMs`.
 */
const IDLE_POLL_SLACK = 0.9;

/**
 * How long a requested pass waits for other requests to join it
 * ({@link SvalEngine#requestPass}), so a page load, a bookmark edit and the
 * history index they touch publish one file.
 */
const PASS_REQUEST_DELAY_MS = 750;

/**
 * Off, no pass Sval runs on its own is run, a requested one included: the
 * document moves only when someone acts (`app-sval-prefs.js`).
 */
const BACKGROUND_PASSES_PREF = "browser.sval.sync.background.enabled";

/**
 * Whether a window's startup has got past first run, so the sync key is the
 * one this profile keeps. One answer for the process, because the document
 * modules that wait on it are one for the process and outlive the window
 * that started them.
 */
let pastFirstRun = false;

/**
 * Where the profile's shutdown blocker is registered, while it is.
 *
 * `IOUtils.profileBeforeChange` is the barrier `SessionFile` and `JSONFile`
 * use for their last writes: IOUtils' own profile-before-change blocker waits
 * for every client on it, and IOUtils keeps accepting I/O, the worker's
 * included, until profile-before-change-telemetry has finished
 * (`xpcom/ioutils/IOUtils.cpp`, `IOUtilsShutdownBlocker`). Workers are not
 * cancelled until xpcom-shutdown (`dom/workers/RuntimeService.cpp`), so the
 * worker is still there to run the pass.
 */
let shutdownClient = null;

/** The client a test moved the blocker onto, or null for the real one. */
let shutdownClientOverride = null;

/** The blocker's deadline, which a test can shorten. */
let shutdownTimeoutMs = FINAL_PASS_TIMEOUT_MS;

/**
 * The profile's shutdown blocker: one last pass for whatever the shared engine
 * holds that no pass has published.
 *
 * Bounded by {@link shutdownTimeoutMs}, and it never rejects, because
 * AsyncShutdown reports a rejected blocker as an error.
 *
 * @returns {Promise<void>}
 */
async function publishBeforeShutdown() {
  // A barrier drops a blocker once it has run, so there is nothing to remove.
  shutdownClient = null;
  const engine = sharedEngine;
  if (!engine) {
    return;
  }
  let timer = null;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => resolve(false), shutdownTimeoutMs);
  });
  try {
    const finished = await Promise.race([
      engine.publishBeforeShutdown().then(() => true),
      deadline,
    ]);
    if (!finished) {
      SvalLog.warn(
        `the last sync pass did not finish within ${shutdownTimeoutMs}ms, ` +
          "so the application quit without it"
      );
    }
  } catch (err) {
    SvalLog.warn(`the last sync pass failed: ${describeError(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** What the blocker reports if AsyncShutdown ever has to describe it. */
function shutdownState() {
  return {
    hasEngine: !!sharedEngine,
  };
}

/** Registers the profile's shutdown blocker, once. */
function holdShutdown() {
  if (shutdownClient) {
    return;
  }
  try {
    const client = shutdownClientOverride ?? IOUtils.profileBeforeChange;
    client.addBlocker(
      "sval: publishing changes no sync pass has written yet",
      publishBeforeShutdown,
      { fetchState: shutdownState }
    );
    shutdownClient = client;
  } catch (err) {
    // The phase has already finished, which only happens when a window opens
    // during shutdown. There is nothing left to hold.
    SvalLog.warn(`could not hold shutdown: ${describeError(err)}`);
  }
}

/** Removes the profile's shutdown blocker, if it is registered. */
function releaseShutdown() {
  if (!shutdownClient) {
    return;
  }
  shutdownClient.removeBlocker(publishBeforeShutdown);
  shutdownClient = null;
}

/**
 * `value` as a 32-byte key, copied, or a throw saying what was not done.
 *
 * Copied, so nothing outside can change a key a pass in flight is encrypting
 * under.
 *
 * @param {Uint8Array} value
 * @param {string} consequence What did not happen, for the message.
 * @returns {Uint8Array}
 */
function checkedKey(value, consequence) {
  if (
    !ArrayBuffer.isView(value) ||
    value.length !== KEY_BYTES ||
    value.byteLength !== KEY_BYTES
  ) {
    throw new Error(
      `sval: a key is ${KEY_BYTES} bytes, so ${consequence}: ` +
        `${ArrayBuffer.isView(value) ? `${value.byteLength} bytes` : typeof value}`
    );
  }
  return Uint8Array.from(value);
}

/**
 * One instance drives one worker, which holds one document for one device.
 */
export class SvalEngine extends SvalWorkerClient {
  #root;

  /** Encrypts this device's own copy in the profile. */
  #localKey;

  /** Encrypts the shared folder and names its directory, or null for none. */
  #syncKey = null;

  /**
   * Whether this is a candidate ({@link SvalEngine#candidate}), which publishes
   * into the shared folder and never reads or writes the profile.
   */
  #isCandidate = false;

  #deviceId;

  /** The folder devices exchange files through, or null. */
  #sharedRoot = null;

  #sharedStepTimeoutMs = SHARED_STEP_TIMEOUT_MS;
  #sharedIntervalMs = SHARED_INTERVAL_MS;

  /** The `now` of the last shared step's start, or null when one is due. */
  #sharedLastRun = null;

  /**
   * The shared step in flight, or null: `{ promise, generation, workspace,
   * names, saw }`. `generation` names the folder choice the step was started
   * for. `names` is every document the step exchanges, `workspace` first.
   * `saw` is the change count when the step first asked the worker to merge,
   * and so the newest change it can publish, or null before then.
   */
  #sharedStep = null;

  /**
   * Counts the folder choices, marks and re-keyings made. A step that finds
   * this moved was started for another folder, an unmarked folder or another
   * key, and touches none of the state a choice resets.
   */
  #sharedGeneration = 0;

  /** What the last finished shared step found, or "unknown". */
  #sharedState = "unknown";

  /**
   * Why the last shared step did not reach the folder, as
   * {@link folderProblem} names it; null when it did, or none ran.
   */
  #sharedReason = null;

  /**
   * The last shared step's per-file problems, by document name, folded into
   * every report for that document until the next step replaces them, so a
   * local pass does not clear a peer's problem from the panel.
   */
  #sharedProblems = new Map();

  /**
   * The corrected time this device's first time reading arrived at, when it
   * arrived in this run, and the documents whose profile pass has pulled
   * back the stamps taken before it (decision 1714). A document publishes
   * nothing before that pass.
   */
  #clampFrom = null;
  #clamped = new Set();
  #stopFirstReading = null;
  /** {@link CLOCK_READING_FILE} read into the two above, once. */
  #clampLoaded = null;
  /** The last write of {@link CLOCK_READING_FILE}, which the next follows. */
  #clampWritten = Promise.resolve();

  /**
   * The `now` of the first shared step that found each document's own file
   * in the folder unreadable, by document name, until a step reads it or it
   * is set aside. In memory only: a restart gives the file its full
   * `OWN_FILE_SET_ASIDE_MS` again.
   */
  #ownUnreadSince = new Map();

  /**
   * Visits the last shared step merged into each extra document, by name,
   * handed to that document's listener with the profile pass that follows
   * (history-sync spec §4.1). The step merges peers' files; the profile pass
   * after it finds the visits already there and reports none.
   */
  #sharedArrivals = new Map();

  #sharedListeners = new Set();

  /**
   * Extra documents (settings-sync spec §4.1), by name, each with the
   * listener that hears its profile passes. Every `sync` runs them all, after
   * the document it was asked for.
   */
  #extraDocuments = new Map();

  /**
   * The last open, local write or removal asked for each extra document, by
   * name, settled whatever its outcome. Each changes what the worker holds and
   * then what `#extraDocuments` lists, across awaits, so the next for the same
   * name starts once it has settled: two that overlapped would leave a
   * document listed that the worker has let go, or one the worker holds that
   * nothing lists.
   */
  #documentTurns = new Map();

  /**
   * How long each extra document that expires its entries keeps them, by
   * name: a function answering milliseconds, or undefined while nothing
   * should expire. Only the Archive has one (host contract §10).
   */
  #retention = new Map();

  /**
   * The least time between two of this device's writes of an extra document
   * to the shared folder, by name (history-sync spec §4.1). Providers upload
   * a whole file on every write, and every peer downloads it, so a large
   * document written for each small change costs that much every step.
   * Steps still merge it every time.
   */
  #publishEvery = new Map();

  /** When a shared step last wrote each document of `#publishEvery`. */
  #publishedAt = new Map();

  /**
   * Documents of `#publishEvery` that a step writes regardless, each with
   * the change count when that was asked: a step whose merge held that
   * change satisfies it.
   */
  #publishNow = new Map();

  /** What `addPassListener` was given. */
  #passListeners = new Set();

  /** What `addPeerRemovalListener` was given. */
  #peerRemovalListeners = new Set();

  /** What `addDocumentListener` was given, by document name. */
  #documentListeners = new Map();

  /** What `addFailureListener` was given. */
  #failureListeners = new Set();

  /** The errors a pass rejected with because its shared step threw. */
  #sharedStepFailures = new WeakSet();

  /**
   * When the last pass for each document began, by the `now` it was given, so
   * an idle poll can tell that another window has just run one.
   */
  #lastPassAt = new Map();

  /** The documents a pass has read off disk into the worker. */
  #read = new Set();

  /** The level last sent to the worker, so it is sent only when it moves. */
  #logLevel = null;

  /**
   * Counts local changes made to any document, and the count the last
   * completed pass had seen. They differ while something is in memory only.
   * A pass runs every document, so one pair covers them all.
   */
  #changes = 0;
  #publishedChanges = 0;

  /**
   * The document other than an extra one that the last pass synced: the tree,
   * which is what a final pass syncs.
   */
  #lastDocument = null;

  /** Set by `terminate`; a terminated engine runs no further final pass. */
  #terminated = false;

  /** Work a closing window handed over for the shutdown blocker to await. */
  #pendingFlushes = new Set();

  /** The timer of a requested pass, or null. See {@link requestPass}. */
  #passRequest = null;

  /** Whether the requested pass runs with nothing unpublished. */
  #passAlways = false;

  /** How long a requested pass waits; a test shortens it. */
  #passRequestDelayMs = PASS_REQUEST_DELAY_MS;

  /**
   * `settings()` answers by document name, while no change or pass has been
   * posted since: every listener of one pass reads the document once.
   */
  #settingsRead = new Map();

  /**
   * The engine every window of this profile uses.
   *
   * One profile is one device, and one device is one document. A second
   * instance for the same device loses data. Two instances write the same
   * file, and `merge` does not let an own file delete anything (`own_file` in
   * `engine/src/merge.rs` skips the absence rule, because a file this
   * device wrote can only be stale relative to this device). A tab closed in
   * one window stays in the other window's document, which republishes it, and
   * the close is undone on every device. Tearing a workspace off into its own
   * window (spec §10.7) makes two windows ordinary.
   *
   * The shared folder is a per-profile setting (local-copy spec §4.1), so a
   * window asking for a different one means the profile's choice changed,
   * which is `setSharedRoot`. The local root is the profile and does not
   * change.
   *
   * The keys and `deviceId` on a second call are ignored. Every window reads
   * them from `SvalIdentity`, and joining another device's sync key goes
   * through `useSyncKey` on this instance (`SvalKeyJoin`). Re-keying here
   * would be a second, silent path to the operation §6.6 makes deliberate.
   *
   * @param {object} identity
   * @param {string} identity.root As the constructor takes.
   * @param {string|null} [identity.sharedRoot] As the constructor takes.
   * @param {Uint8Array} identity.localKey As the constructor takes.
   * @param {Uint8Array|null} [identity.syncKey] As the constructor takes.
   * @param {Uint8Array} [identity.keyBytes] As the constructor takes.
   * @param {Uint8Array} identity.deviceId As the constructor takes.
   * @returns {SvalEngine} the shared engine.
   */
  static forProfile({
    root,
    sharedRoot = null,
    keyBytes = null,
    localKey = keyBytes,
    syncKey = keyBytes,
    deviceId,
  }) {
    if (!sharedEngine) {
      const identity = { root, sharedRoot, localKey, syncKey, deviceId };
      if (prestarted) {
        prestarted.#identify(identity);
        sharedEngine = prestarted;
        prestarted = null;
      } else {
        sharedEngine = new SvalEngine(identity);
      }
    } else if (sharedEngine.sharedRoot !== sharedRoot) {
      sharedEngine.setSharedRoot(sharedRoot);
    }
    // Here, beside the one engine per profile, so a profile holds shutdown
    // once however many windows it opens.
    holdShutdown();
    return sharedEngine;
  }

  /**
   * Starts the worker and loads the engine into it, for the first
   * {@link SvalEngine.forProfile} to take.
   *
   * A window reads the profile's keys before it can make the engine, and the
   * worker takes no identity of its own: every call carries the keys and
   * device id it needs. Started as the first window's panel starts, the
   * worker's start and the engine's load run alongside the key reads instead
   * of after them.
   */
  static prestart() {
    if (sharedEngine || prestarted) {
      return;
    }
    prestarted = new SvalEngine(UNIDENTIFIED);
    // A failed load is retried by the first call that needs the engine, and
    // reported there.
    prestarted.post("warm").catch(err => {
      SvalLog.debug(`the engine did not load early: ${SvalLog.errorName(err)}`);
    });
  }

  /**
   * The engine {@link SvalEngine.forProfile} answers with, or null before the
   * first window starts one.
   *
   * @returns {SvalEngine|null}
   */
  static get sharedInstance() {
    return sharedEngine;
  }

  /**
   * Whether a window's startup has got past first run, so a document module
   * may begin (see {@link pastFirstRun}).
   *
   * @returns {boolean}
   */
  static get pastFirstRun() {
    return pastFirstRun;
  }

  static set pastFirstRun(value) {
    const was = pastFirstRun;
    pastFirstRun = value === true;
    // The document modules waiting on it begin at the next pass, which an
    // idle device would otherwise never run.
    if (pastFirstRun && !was) {
      sharedEngine?.#schedulePass({ always: true });
    }
  }

  /**
   * Makes `engine` the one {@link SvalEngine.forProfile} answers with.
   *
   * For a test that drives more than one window over a document of its own.
   * Without it the second window would be handed the engine the harness's
   * startup built, pointed at the profile folder, and the two windows would
   * show different trees.
   *
   * @param {SvalEngine|null} engine The engine to share, or null to forget.
   */
  static setSharedInstance(engine) {
    sharedEngine = engine;
    if (engine) {
      holdShutdown();
    } else {
      releaseShutdown();
    }
  }

  /**
   * Moves the profile's shutdown blocker onto `client`.
   *
   * For a test, which passes an `AsyncShutdown.Barrier`'s client and triggers
   * the blocker with `wait()`, the way `JSONFile`'s tests use `finalizeAt`.
   *
   * @param {object|null} client An `nsIAsyncShutdownClient`, or null for
   *   `IOUtils.profileBeforeChange`.
   * @param {object} [options]
   * @param {number} [options.timeoutMs] The blocker's deadline.
   */
  static setShutdownClient(client, { timeoutMs = FINAL_PASS_TIMEOUT_MS } = {}) {
    releaseShutdown();
    shutdownClientOverride = client;
    shutdownTimeoutMs = timeoutMs;
    if (sharedEngine) {
      holdShutdown();
    }
  }

  /**
   * @param {object|symbol} identity This device and its folders, as
   *   `#identify` takes, or `UNIDENTIFIED` for `prestart`.
   */
  constructor(identity) {
    super(WORKER_URL);
    this.#stopFirstReading = SvalClock.onFirstReading(at => {
      // A candidate publishes the profile engine's document, which that
      // engine pulls back.
      if (this.#isCandidate) {
        return;
      }
      this.#clampFrom = at;
      this.#clamped.clear();
      this.#saveClampState().catch(err =>
        SvalLog.warn(
          `the time reading's file did not write: ${describeError(err)}`
        )
      );
    });

    if (identity !== UNIDENTIFIED) {
      this.#identify(identity);
    }
  }

  /**
   * Sets which device and folders this engine works for.
   *
   * @param {object} identity
   * @param {string} identity.root This device's own location: the profile in
   *   production (local-copy spec §4.1), a folder of a test's own otherwise.
   * @param {string|null} [identity.sharedRoot] The folder devices exchange
   *   files through, or null for none.
   * @param {number} [identity.sharedStepTimeoutMs] How long a shared step may
   *   take. A test shortens it.
   * @param {number} [identity.sharedIntervalMs] How often a background pass
   *   runs a shared step.
   * @param {number} [identity.passRequestDelayMs] How long a requested pass
   *   waits for others to join it.
   * @param {Uint8Array} identity.localKey The 32 bytes this device's own copy
   *   is encrypted under.
   * @param {Uint8Array|null} [identity.syncKey] The 32 bytes the shared folder
   *   is encrypted under, or null on a device with none, which shares nowhere.
   * @param {Uint8Array} [identity.keyBytes] One key for both, in place of
   *   `localKey` and `syncKey`: a test of the engine alone has no reason to
   *   tell them apart.
   * @param {Uint8Array} identity.deviceId This device's 16 bytes.
   */
  #identify({
    root,
    sharedRoot = null,
    sharedStepTimeoutMs = SHARED_STEP_TIMEOUT_MS,
    sharedIntervalMs = SHARED_INTERVAL_MS,
    passRequestDelayMs = PASS_REQUEST_DELAY_MS,
    keyBytes = null,
    localKey = keyBytes,
    syncKey = keyBytes,
    deviceId,
  }) {
    this.#root = root;
    this.#passRequestDelayMs = passRequestDelayMs;
    this.#sharedRoot = sharedRoot;
    this.#sharedStepTimeoutMs = sharedStepTimeoutMs;
    this.#sharedIntervalMs = sharedIntervalMs;
    this.#localKey = checkedKey(localKey, "this engine was not made");
    this.#syncKey =
      syncKey === null ? null : checkedKey(syncKey, "this engine was not made");
    this.#deviceId = deviceId;
  }

  /**
   * Reads {@link CLOCK_READING_FILE} once. A first reading heard in this run
   * stands over the file's.
   *
   * @returns {Promise<void>}
   */
  #clampState() {
    this.#clampLoaded ??= this.#isCandidate
      ? Promise.resolve()
      : IOUtils.readJSON(
          PathUtils.join(this.#root, TOP_DIR, CLOCK_READING_FILE)
        ).then(
          ({ from, clamped }) => {
            if (this.#clampFrom === null && Number.isFinite(from)) {
              this.#clampFrom = from;
              this.#clamped = new Set(Array.isArray(clamped) ? clamped : []);
            }
          },
          err => {
            if (err?.name !== "NotFoundError") {
              SvalLog.warn(
                `the time reading's file did not read: ${describeError(err)}`
              );
            }
          }
        );
    return this.#clampLoaded;
  }

  /**
   * Writes {@link CLOCK_READING_FILE} after any write before it.
   *
   * @returns {Promise<void>}
   */
  #saveClampState() {
    const state = { from: this.#clampFrom, clamped: [...this.#clamped] };
    const path = PathUtils.join(this.#root, TOP_DIR, CLOCK_READING_FILE);
    this.#clampWritten = this.#clampWritten
      .catch(() => {})
      .then(async () => {
        await IOUtils.makeDirectory(PathUtils.parent(path));
        await IOUtils.writeJSON(path, state, { tmpPath: `${path}.tmp` });
      });
    return this.#clampWritten;
  }

  /**
   * Waits until `document` may be published as far as the clock goes: once
   * a reading exists, the profile pass that pulls back the stamps taken
   * before it has run (decision 1714). A pairing publishes this engine's
   * document through a candidate, so it calls this first.
   *
   * @param {string} document The document name.
   * @returns {Promise<void>}
   */
  async settleClock(document) {
    await this.#clampState();
    if (this.#clampFrom !== null && !this.#clamped.has(document)) {
      await this.sync(document, SvalClock.now(), { shared: "skip" });
    }
  }

  /**
   * Every call into the worker, with Sval's log level carried in front of it
   * whenever the pref has moved.
   *
   * `maxLogLevelPref` is inert off the main thread (see `SvalLog.sys.mjs` and
   * the worker's own `SvalLog`), so the level is pushed. Pushing it here keeps
   * the worker lazy, since `BasePromiseWorker` starts one only when something
   * posts.
   *
   * @param {...*} args As `BasePromiseWorker.post`.
   * @returns {Promise<*>} what the worker answered.
   */
  post(...args) {
    const level = svalLogLevel();
    if (level !== this.#logLevel) {
      this.#logLevel = level;
      // Unawaited, and its failure is its own: the queue is ordered, so the
      // level is in place before `args` runs either way.
      super.post("setLogLevel", [level]).catch(err => {
        SvalLog.debug(
          `the worker would not take a log level: ${describeError(err)}`
        );
      });
    }
    return super.post(...args);
  }

  /** This device's own location, which every pass writes first. */
  get root() {
    return this.#root;
  }

  /** Whether {@link SvalEngine#terminate} has stopped this engine. */
  get terminated() {
    return this.#terminated;
  }

  /** The folder devices exchange files through, or null. */
  get sharedRoot() {
    return this.#sharedRoot;
  }

  /**
   * How long a shared step may take, from the next request on. A test waits
   * out a short limit on a hang and gives the steps it needs to succeed the
   * full one, because a real helper on a loaded machine can take longer than
   * the short limit just to start.
   *
   * @param {number} ms The limit.
   */
  set sharedStepTimeoutMs(ms) {
    this.#sharedStepTimeoutMs = ms;
  }

  /**
   * Makes `path` the folder this device exchanges files through, or stops
   * sharing when it is null. The next shared step is due at once.
   *
   * Nothing moves and nothing is removed. The document stays in memory and in
   * the profile, and the next step that reaches `path` publishes there
   * (local-copy spec §4.5), once it holds {@link TOP_DIR}
   * ({@link SvalEngine#markSharedRoot}).
   *
   * @param {string|null} path An absolute path, or null.
   */
  setSharedRoot(path) {
    if (path !== null && (typeof path !== "string" || !path)) {
      throw new Error(
        `sval: a shared folder is an absolute path or null, got ${JSON.stringify(path)}`
      );
    }
    this.#sharedGeneration++;
    this.#sharedRoot = path;
    this.#sharedLastRun = null;
    this.#sharedState = "unknown";
    this.#sharedReason = null;
    this.#sharedProblems.clear();
    this.#ownUnreadSince.clear();
    if (path === null) {
      // No helper lives on for a folder the user no longer shares.
      SvalSharedFolder.release();
    }
  }

  /**
   * Makes {@link TOP_DIR} in the shared folder: the user has said this is the
   * folder, so what is there is the folder and not an empty mount point. Once
   * it is made, a step that began before is about the folder without it, and
   * the next shared step is due at once.
   *
   * @returns {Promise<object>} `{ reachable: true }`, or the helper's
   *   unreachable answer. Without a shared folder, `{ reachable: false,
   *   reason: "missing" }`.
   */
  async markSharedRoot() {
    if (!this.#sharedRoot) {
      return { reachable: false, reason: "missing" };
    }
    const answer = await SvalSharedFolder.makeDir({
      root: this.#sharedRoot,
      path: TOP_DIR,
      deadline: Date.now() + this.#sharedStepTimeoutMs,
    });
    if (answer.reachable) {
      this.#sharedGeneration++;
      this.#sharedLastRun = null;
    }
    return answer;
  }

  /**
   * Calls `fn(report)` with the report of every shared step that finishes.
   *
   * @param {Function} fn
   * @returns {Function} removes `fn`.
   */
  addSharedListener(fn) {
    this.#sharedListeners.add(fn);
    return () => this.#sharedListeners.delete(fn);
  }

  /**
   * Calls `fn(report, origin)` when any pass finishes, with the `origin` the
   * caller of `sync` passed. Every window of a profile shares this engine and
   * its one document, so a pass one window runs brings in what every window
   * would have, and each window draws it from here instead of running its own.
   *
   * @param {Function} fn
   * @returns {Function} removes `fn`.
   */
  addPassListener(fn) {
    this.#passListeners.add(fn);
    return () => this.#passListeners.delete(fn);
  }

  /**
   * Calls `fn(ids)` with the nodes a merge has just taken out of any
   * document because another device deleted them, the moment the worker
   * answers. The worker answers in order, so no read that shows the nodes
   * gone reaches this thread first, and a listener acts before anything can
   * draw their absence. A pass's own report comes later, after the
   * profile write and the other documents.
   *
   * @param {Function} fn
   * @returns {Function} removes `fn`.
   */
  addPeerRemovalListener(fn) {
    this.#peerRemovalListeners.add(fn);
    return () => this.#peerRemovalListeners.delete(fn);
  }

  /**
   * Hands `ids` to each `addPeerRemovalListener` listener, none of which
   * may fail the merge.
   *
   * @param {string[]|undefined} ids
   */
  #heardPeerRemovals(ids) {
    if (!ids?.length) {
      return;
    }
    for (const fn of this.#peerRemovalListeners) {
      try {
        fn(ids);
      } catch (err) {
        SvalLog.warn(`a peer removal listener failed: ${describeError(err)}`);
      }
    }
  }

  /**
   * Calls `fn(report)` after every profile pass that runs extra document
   * `name`, with that document's report, as the listener `addDocument`
   * registered hears it. For a module that reads the document and needs to
   * know when a pass brought in something new (`changedIds`, `removedIds`).
   *
   * @param {string} name The document name.
   * @param {Function} fn
   * @returns {Function} removes `fn`.
   */
  addDocumentListener(name, fn) {
    let listeners = this.#documentListeners.get(name);
    if (!listeners) {
      listeners = new Set();
      this.#documentListeners.set(name, listeners);
    }
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /**
   * Calls `fn(err, origin, now)` when a pass that ran fails to read or write
   * this device's copy in the profile, with the error the pass rejects with,
   * and the `origin` and `now` the caller of `sync` passed. A pass that
   * starts marks the document as just passed, so the other windows' idle
   * polls skip; this is how they hear that the pass failed. A pass whose
   * shared step throws rejects too, unheard: it fails after this call's own
   * profile pass saved the copy, and only a failing profile copy loses work
   * (messages spec §4). A lasting disk fault fails that first profile pass
   * on the next call, which is heard.
   *
   * @param {Function} fn
   * @returns {Function} removes `fn`.
   */
  addFailureListener(fn) {
    this.#failureListeners.add(fn);
    return () => this.#failureListeners.delete(fn);
  }

  /**
   * Whether `sync` rejected with `err` because its shared step threw, after
   * the profile pass had saved this device's copy.
   *
   * @param {*} err
   * @returns {boolean}
   */
  failedInSharedStep(err) {
    return Object(err) === err && this.#sharedStepFailures.has(err);
  }

  /**
   * An engine for this device that publishes under `keyBytes` and never
   * touches the profile: the candidate a join merges the other document into
   * and publishes through (`SvalKeyJoin`). It starts empty, with a worker of
   * its own, so nothing it merges can reach this engine's document; it is
   * dropped with `terminate` once the join is decided.
   *
   * It writes this device's own file under `keyBytes`'s directory, which this
   * engine does not write until it is moved onto that key, so the two never
   * write one file. The device id is this device's (spec §6.7): every
   * watermark the other document's devices keep for it is keyed on it.
   *
   * @param {Uint8Array} keyBytes The key to publish under.
   * @returns {SvalEngine}
   */
  candidate(keyBytes) {
    const engine = new SvalEngine({
      root: this.#root,
      sharedRoot: this.#sharedRoot,
      sharedStepTimeoutMs: this.#sharedStepTimeoutMs,
      sharedIntervalMs: this.#sharedIntervalMs,
      localKey: this.#localKey,
      syncKey: keyBytes,
      deviceId: this.#deviceId,
    });
    engine.#isCandidate = true;
    return engine;
  }

  /**
   * The sync key the shared folder is read and written under, or null. A
   * copy: what a failed pairing puts the engine back on is the key it was
   * using, which the store may not be able to answer with.
   *
   * @returns {Uint8Array|null}
   */
  get syncKey() {
    return this.#syncKey === null ? null : Uint8Array.from(this.#syncKey);
  }

  /**
   * The directories in `root`'s `sval/ws/` that are not this device's: another
   * sync key's workspaces (key-storage spec, "Becoming a syncing device").
   * Only names are listed; nothing in them is read. A device with no sync key
   * owns none, so every directory there is another's.
   *
   * A device with a key owns the directories of the documents it has loaded
   * under that key, of the documents `names` lists, and every directory that
   * holds its own file. The third covers the documents it published and has
   * not loaded since: a history week it let go of, or the Favorites and
   * history documents of a launch that has not started syncing them yet. A
   * document a peer published and this device never wrote is found only by
   * its name, which only the caller knows.
   *
   * @param {string} [root] The folder to look in; the shared folder if
   *   omitted.
   * @param {Iterable<string>} [names] More documents of this key, as
   *   {@link workspaceDirsOf} takes them.
   * @returns {Promise<string[]|null>} the names, or null when the folder did
   *   not answer.
   */
  async otherWorkspaces(root = this.#sharedRoot, names = []) {
    if (!root) {
      return [];
    }
    let ours = new Set();
    let mine = null;
    if (this.#syncKey) {
      ours = new Set(await this.workspaceDirsOf(this.#syncKey, names));
      // This device's file is named for the device alone, whatever the
      // document, so any name answers what it is called.
      ({ mine } = await this.post("layout", [
        {
          workspace: WORKSPACES_DIR,
          keyBytes: this.#syncKey,
          deviceId: this.#deviceId,
        },
      ]));
    }
    const listed = await SvalSharedFolder.listNames({
      root,
      path: WORKSPACES_DIR,
      holding: mine,
      deadline: Date.now() + this.#sharedStepTimeoutMs,
    });
    if (!listed?.reachable) {
      return null;
    }
    for (const name of listed.holding ?? []) {
      ours.add(name);
    }
    return listed.names.filter(name => !ours.has(name));
  }

  /**
   * Writes this device's sealed copy of the sync key into `root`'s
   * `sval/keys/`, where Sval installed again for the same user finds it
   * (key-storage spec, "Installing again"). Only this user's system secret
   * opens it. The folder is the caller's: sealing the key takes long enough
   * for the user to choose another folder meanwhile.
   *
   * @param {string} sealed What `SvalSecretStore.wrap` gave.
   * @param {string} root The shared folder the copy is for.
   * @returns {Promise<boolean>} whether it was written.
   */
  async publishKeyCopy(sealed, root) {
    const answer = await SvalSharedFolder.writeFile({
      root,
      path: `${KEYS_DIR}/${toHex(this.#deviceId)}.key`,
      bytes: new TextEncoder().encode(sealed),
      requireTop: TOP_DIR,
      deadline: Date.now() + this.#sharedStepTimeoutMs,
    });
    return answer?.reachable === true;
  }

  /**
   * Every sealed copy of a sync key in `root`'s `sval/keys/`: this user's own
   * among them, if Sval ran here before, and other devices' that this machine
   * cannot open.
   *
   * @param {string} root The folder.
   * @returns {Promise<string[]|null>} the sealed copies, or null when the
   *   folder did not answer.
   */
  async keyCopies(root) {
    const read = await SvalSharedFolder.readDir({
      root,
      path: KEYS_DIR,
      suffix: ".key",
      mine: `${toHex(this.#deviceId)}.key`,
      maxBytes: KEY_COPY_MAX_BYTES,
      requireTop: null,
      deadline: Date.now() + this.#sharedStepTimeoutMs,
    });
    if (!read?.reachable) {
      return null;
    }
    return read.entries.map(entry =>
      new TextDecoder().decode(
        ChromeUtils.base64URLDecode(entry.data, { padding: "require" })
      )
    );
  }

  /**
   * Whether `keyBytes` names a directory in the shared folder: whether a key
   * typed from a backup belongs to the workspaces there.
   *
   * @param {Uint8Array} keyBytes
   * @param {string} workspace The tree document's name.
   * @param {string} [root] The folder; the shared folder if omitted.
   * @returns {Promise<boolean|null>} the answer, or null when the folder did
   *   not answer.
   */
  async opensWorkspacesHere(keyBytes, workspace, root = this.#sharedRoot) {
    if (!root) {
      return false;
    }
    const { prefix } = await this.post("layout", [
      { workspace, keyBytes, deviceId: this.#deviceId },
    ]);
    const answer = await SvalSharedFolder.exists({
      root,
      path: prefix,
      requireTop: TOP_DIR,
      deadline: Date.now() + this.#sharedStepTimeoutMs,
    });
    return answer?.reachable ? answer.exists : null;
  }

  /**
   * The directories `keyBytes` names in the shared folder's `sval/ws/`, one
   * per document: what an old sync key could still read once this device has
   * started over with a new one (key-storage spec, "Starting over with a new
   * sync key"). Names only, which are not secret.
   *
   * A directory is named by the key and the document's name together, so
   * only a document named here is found: every one this engine has loaded,
   * and `names`, the documents the caller knows of that may not be loaded.
   * A name the key never published answers a directory that is not there,
   * which {@link removeWorkspaceDirs} counts as removed.
   *
   * @param {Uint8Array} keyBytes The key replaced.
   * @param {Iterable<string>} [names] More document names.
   * @returns {Promise<string[]>}
   */
  async workspaceDirsOf(keyBytes, names = []) {
    const all = new Set([
      ...this.#lastPassAt.keys(),
      ...this.#extraDocuments.keys(),
      ...names,
    ]);
    const dirs = new Set();
    for (const workspace of all) {
      const { prefix } = await this.post("layout", [
        { workspace, keyBytes, deviceId: this.#deviceId },
      ]);
      dirs.add(prefix.split("/").pop());
    }
    return [...dirs];
  }

  /**
   * Removes `dirs`, directories in the shared folder's `sval/ws/`.
   *
   * @param {string[]} dirs
   * @returns {Promise<string[]>} the ones still there.
   */
  async removeWorkspaceDirs(dirs) {
    if (!this.#sharedRoot) {
      return dirs;
    }
    const left = [];
    for (const dir of dirs) {
      const answer = await SvalSharedFolder.removeDir({
        root: this.#sharedRoot,
        path: `${WORKSPACES_DIR}/${dir}`,
        deadline: Date.now() + this.#sharedStepTimeoutMs,
      }).catch(() => null);
      if (answer?.reachable !== true || answer.removed !== true) {
        left.push(dir);
      }
    }
    return left;
  }

  /**
   * Starts sharing under `keyBytes` with the document as it is: a key this
   * device was already using, read again after the store would not answer,
   * one just made for a folder this device is setting up, or one a join has
   * published under and stored (`SvalKeyJoin`). The next pass merges what the
   * key's directory holds into this document. A shared step in flight under
   * the old key stops at its next await and writes nothing.
   *
   * @param {Uint8Array} keyBytes
   */
  useSyncKey(keyBytes) {
    this.#syncKey = checkedKey(keyBytes, "this engine did not take it");
    this.#sharedGeneration++;
    this.#sharedLastRun = null;
    this.#ownUnreadSince.clear();
  }

  /**
   * Removes each workspace among `ids` that is still untouched
   * (`isUntouchedWorkspace`), with what is in it, in one step: a join leaves a
   * device's untouched first workspace behind, and one the user has
   * touched since is theirs to keep.
   *
   * @param {string[]} ids What a join's candidate left out
   *   (`withoutUntouchedWorkspaces`).
   */
  async leaveUntouched(ids) {
    this.#changed();
    return this.post("leaveUntouched", [ids]);
  }

  /**
   * Replaces the document this worker holds with the one `json` describes.
   *
   * `json` must be a `treeJson` result: the engine's own serialisation, which
   * its deserialiser reads back whole.
   *
   * @param {string} json A full document, as `treeJson` returns it.
   */
  async loadTree(json) {
    this.#changed();
    return this.post("loadTree", [json]);
  }

  /**
   * Runs one sync pass for `workspace`, and for every extra document after
   * it, in the profile pass and in the shared step alike. Each extra
   * document's report goes to the listener `addDocument` registered.
   *
   * `errors` and `schemaTooNew` are kept apart all the way from the engine to
   * here because they need different words in front of a user. A file in
   * `schemaTooNew` was written by a device on a newer build and is intact, so
   * the user is told to update this device. A file in `errors` failed to
   * decrypt or parse, which is a corrupt file. Collapsing them would tell a
   * user their data was damaged when it was not.
   *
   * @param {string} workspace The workspace id.
   * @param {number} [now] Milliseconds since the epoch; the engine reads no
   *   clock of its own (host contract §3).
   * @param {object} [options]
   * @param {string} [options.shared] `"wait"` includes a shared step that
   *   publishes this call's changes, whatever the interval: the one running,
   *   when it can, or a new one; `"background"` starts one if the interval
   *   has passed and none is running, without waiting for it; `"skip"` writes
   *   the profile only.
   * @param {number} [options.idleWithinMs] For a pass with nothing of its own
   *   to publish, a window's idle poll: run nothing, and resolve null, when a
   *   pass for this document began less than this long before `now`, or when
   *   the engine holds nothing unpublished and the pass would start no shared
   *   step. Each window polls on its own clock, and one pass per interval
   *   serves them all.
   * @param {*} [options.origin] Handed to every pass listener with the report,
   *   so the caller can tell its own pass from another window's.
   * @returns {Promise<object>} `{ merged, errors, schemaTooNew, refusedWrite,
   *   repairedIds, unreadable, wrote, hadLocalCopy, shared, sharedRan,
   *   sharedWrote }`. `errors`, `schemaTooNew` and `unreadable` hold
   *   `{ path, own, reason }` entries (`docs/host-contract.md`
   *   §7). `wrote` is the engine-relative path this pass wrote to the
   *   profile, or null when nothing changed. `hadLocalCopy` is
   *   whether the profile held this device's own file when the pass began.
   *   `shared` is `"none"` (no shared folder, or it is the profile),
   *   `"reached"`, `"unreachable"`, `"too-large"` (the folder holds more
   *   than one step reads, decision 0032), or `"unknown"` (no shared step has
   *   finished since the folder was set). `sharedRan` is whether this report
   *   carries a shared step's outcome. `sharedWrote` is the engine-relative
   *   path written to the shared folder, or null. `unreadable` names files
   *   that could not be read at all, which never abort a pass; it,
   *   `errors` and `schemaTooNew` include the last shared step's per-file
   *   problems until the next shared step replaces them, as `harmedByClock`
   *   does: the hex ids of the devices whose clocks set ahead replaced this
   *   device's values or brought back what it closed (decision 1714). Null
   *   when an idle poll was skipped.
   */
  async sync(
    workspace,
    now = SvalClock.now(),
    { shared = "wait", idleWithinMs = 0, origin = null } = {}
  ) {
    // Checked here because at the wasm boundary an absent document becomes a
    // `TypeError` from the generated glue that names neither the argument nor
    // the caller.
    if (typeof workspace !== "string" || !workspace) {
      throw new Error("sval: sync needs the name of the document to sync");
    }
    // A little short of the interval, so two windows whose timers fire a few
    // milliseconds apart do not skip each other's turn. A `now` before the last
    // pass is a clock set back, and polls on.
    const last = this.#lastPassAt.get(workspace);
    if (
      idleWithinMs > 0 &&
      last !== undefined &&
      now >= last &&
      now - last < idleWithinMs * IDLE_POLL_SLACK
    ) {
      return null;
    }
    // An idle poll with nothing unpublished and no shared step to start reads
    // only the profile, which nothing but this engine writes: it would bring
    // in nothing. A profile that is itself the shared folder is read.
    if (
      idleWithinMs > 0 &&
      last !== undefined &&
      this.#changes === this.#publishedChanges &&
      this.#sharedRoot !== this.#root &&
      (this.#sharesNowhere() ||
        shared === "skip" ||
        (shared === "background" &&
          (this.#sharedStep || !this.#sharedStepDue(now))))
    ) {
      return null;
    }
    this.#lastPassAt.set(workspace, now);
    return this.#pass(workspace, now, shared, origin);
  }

  /**
   * The body of {@link sync} once the pass is to run.
   *
   * @param {string} workspace
   * @param {number} now
   * @param {string} shared
   * @param {*} origin
   * @returns {Promise<object>} the report.
   */
  async #pass(workspace, now, shared, origin) {
    const changes = this.#changes;
    let local;
    try {
      local = await this.#localPasses(workspace, now);
    } catch (err) {
      for (const fn of this.#failureListeners) {
        try {
          fn(err, origin, now);
        } catch (listenerErr) {
          SvalLog.warn(
            `a pass failure listener failed: ${describeError(listenerErr)}`
          );
        }
      }
      throw err;
    }
    this.#read.add(workspace);
    let report = local;
    if (!this.#sharesNowhere()) {
      if (shared === "wait") {
        let step;
        try {
          step = await this.#stepPublishing(changes, workspace, now);
        } catch (err) {
          if (Object(err) === err) {
            this.#sharedStepFailures.add(err);
          }
          throw err;
        }
        // The step ends with a second profile pass that usually finds nothing
        // new to write, so what this call's own profile pass wrote and found
        // is carried over it.
        report = {
          ...step,
          wrote: local.wrote ?? step.wrote,
          hadLocalCopy: local.hadLocalCopy,
          merged: (local.merged ?? 0) + (step.merged ?? 0),
          repairedIds: [
            ...new Set([
              ...(local.repairedIds ?? []),
              ...(step.repairedIds ?? []),
            ]),
          ],
        };
      } else if (
        shared === "background" &&
        !this.#sharedStep &&
        this.#sharedStepDue(now)
      ) {
        this.#startSharedStep(workspace, now);
      }
    }
    this.#debugPass(report);
    for (const fn of this.#passListeners) {
      try {
        fn(report, origin);
      } catch (err) {
        SvalLog.warn(`a pass listener failed: ${describeError(err)}`);
      }
    }
    return report;
  }

  /**
   * The report of a shared step for `workspace` and the folder chosen that
   * publishes every change up to the `changes`th. A step already running is
   * joined when it qualifies: it exchanges every document registered so far,
   * and it has not yet asked the worker to merge, or asked once those changes
   * had been made. One that does not qualify is waited out and a fresh one
   * follows.
   *
   * @param {number} changes The change count when the caller began.
   * @param {string} workspace The document name.
   * @param {number} now Milliseconds since the epoch.
   * @returns {Promise<object>} the step's report.
   */
  async #stepPublishing(changes, workspace, now) {
    for (;;) {
      const running = this.#sharedStep;
      if (!running) {
        return this.#startSharedStep(workspace, now);
      }
      if (
        running.generation === this.#sharedGeneration &&
        running.workspace === workspace &&
        [...this.#extraDocuments.keys()].every(name =>
          running.names.includes(name)
        ) &&
        (running.saw === null || running.saw >= changes)
      ) {
        return running.promise;
      }
      await running.promise.catch(() => {});
    }
  }

  /**
   * Whether a background shared step is due at `now`. A `now` earlier than the
   * last step's is a clock set back, and counts as due: otherwise shared steps
   * would stop until the clock caught up again.
   *
   * @param {number} now Milliseconds since the epoch.
   * @returns {boolean}
   */
  #sharedStepDue(now) {
    if (this.#sharedLastRun === null) {
      return true;
    }
    const elapsed = now - this.#sharedLastRun;
    return elapsed < 0 || elapsed >= this.#sharedIntervalMs;
  }

  /**
   * True when there is no shared folder, it is the profile itself, or this
   * device holds no sync key to read it with.
   */
  #sharesNowhere() {
    return (
      !this.#sharedRoot || this.#sharedRoot === this.#root || !this.#syncKey
    );
  }

  /**
   * One pass over the profile for `workspace`, with the shared folder's last
   * known state and that document's last shared problems.
   *
   * @param {string} workspace The document name.
   * @param {number} now Milliseconds since the epoch.
   * @param {object} [options]
   * @param {boolean} [options.ownOnly] Read only this device's own file.
   * @returns {Promise<object>}
   */
  async #localPass(workspace, now, { ownOnly = false } = {}) {
    if (this.#isCandidate) {
      // A candidate's document is not this device's (`candidate`), so the
      // profile is neither read nor written and the report is empty.
      return this.#withShared(
        {
          merged: 0,
          peersMerged: 0,
          wrote: null,
          hadLocalCopy: true,
          repairedIds: [],
        },
        workspace
      );
    }
    this.#settingsRead.delete(workspace);
    await this.#clampState();
    const clampFrom =
      this.#clampFrom !== null && !this.#clamped.has(workspace)
        ? this.#clampFrom
        : undefined;
    const local = await this.post("sync", [
      {
        root: this.#root,
        workspace,
        keyBytes: this.#localKey,
        deviceId: this.#deviceId,
        now,
        ownOnly,
        archiveRetention: this.#retention.get(workspace)?.(),
        clampFrom,
      },
    ]);
    this.#heardPeerRemovals(local.removedIds);
    if (clampFrom !== undefined) {
      this.#clamped.add(workspace);
      await this.#saveClampState();
    }
    SvalClock.atLeast(local.ownWatermark ?? 0);
    return this.#withShared(
      {
        ...local,
        peersMerged: Math.max(
          0,
          (local.merged ?? 0) - (local.hadLocalCopy ? 1 : 0)
        ),
      },
      workspace
    );
  }

  /**
   * A profile pass over `workspace` and then every extra document. Resolves
   * to `workspace`'s report; each extra document's report goes to its
   * listener.
   *
   * An extra document's failure is logged and passed over: the documents are
   * independent (settings-sync spec §6), so a broken settings pass must not
   * stop the tree syncing.
   *
   * The change counter is captured before the first pass and marked
   * published only when this call ran the tree and every extra document, so
   * a change any of them missed stays pending. Each listener's report carries
   * it as `saw`: every change up to it is in what that pass wrote.
   *
   * The extra documents' `errors`, `schemaTooNew` and `unreadable` are added
   * to the report this resolves to, shared-step problems included, because
   * that report is the one the panel reads (settings-sync spec §6): a peer's
   * settings file that will not open is a problem the user has to hear about.
   *
   * @param {string} workspace The document the caller asked for.
   * @param {number} now Milliseconds since the epoch.
   * @returns {Promise<object>}
   */
  async #localPasses(workspace, now) {
    const changes = this.#changes;
    const report = await this.#localPass(workspace, now);
    const problems = {
      errors: [...(report.errors ?? [])],
      schemaTooNew: [...(report.schemaTooNew ?? [])],
      unreadable: [...(report.unreadable ?? [])],
      harmedByClock: [...(report.harmedByClock ?? [])],
    };
    let complete = !this.#extraDocuments.has(workspace);
    for (const name of this.#extraDocuments.keys()) {
      if (name === workspace) {
        continue;
      }
      let extra;
      try {
        extra = await this.#localPass(name, now);
      } catch (err) {
        complete = false;
        SvalLog.warn(
          `an extra document's profile pass failed, and the rest went on: ${describeError(err)}`
        );
        continue;
      }
      this.#hear(name, { ...this.#withArrivals(name, extra), saw: changes });
      for (const kind of Object.keys(problems)) {
        problems[kind].push(...(extra[kind] ?? []));
      }
    }
    if (this.#extraDocuments.has(workspace)) {
      this.#hear(workspace, {
        ...this.#withArrivals(workspace, report),
        saw: changes,
      });
    } else {
      this.#lastDocument = workspace;
    }
    if (complete) {
      this.#publishedChanges = Math.max(this.#publishedChanges, changes);
    }
    problems.harmedByClock = [...new Set(problems.harmedByClock)];
    return { ...report, ...problems };
  }

  /**
   * `report` with what the last shared step merged into `name` added, once:
   * the peers' files and the nodes changed and removed are handed on with
   * the first profile pass after the step. The profile pass came later, so
   * where the two disagree about a node, its answer stands.
   *
   * @param {string} name The document name.
   * @param {object} report The document's profile-pass report.
   * @returns {object}
   */
  #withArrivals(name, report) {
    const arrived = this.#sharedArrivals.get(name);
    if (!arrived) {
      return report;
    }
    this.#sharedArrivals.delete(name);
    const changed = new Set(report.changedIds ?? []);
    const removed = new Set(report.removedIds ?? []);
    return {
      ...report,
      peersMerged: (report.peersMerged ?? 0) + arrived.peersMerged,
      changedIds: [
        ...new Set([
          ...arrived.changedIds.filter(id => !removed.has(id)),
          ...changed,
        ]),
      ],
      removedIds: [
        ...new Set([
          ...arrived.removedIds.filter(id => !changed.has(id)),
          ...removed,
        ]),
      ],
    };
  }

  /**
   * Hands extra document `name`'s `report` to the listener `addDocument`
   * registered and to each `addDocumentListener` gave, none of which may
   * fail the pass. The warning names no document: `SvalLog`'s rule keeps
   * document names out of diagnostics.
   *
   * @param {string} name The document name.
   * @param {object} report The document's profile-pass report.
   */
  #hear(name, report) {
    const onPass = this.#extraDocuments.get(name);
    for (const fn of [
      ...(onPass ? [onPass] : []),
      ...(this.#documentListeners.get(name) ?? []),
    ]) {
      try {
        fn(report);
      } catch (err) {
        SvalLog.warn(
          `a document's pass listener failed: ${describeError(err)}`
        );
      }
    }
  }

  /**
   * The last shared step's problems for `name`, or none.
   *
   * @param {string} name The document name.
   * @returns {object} `{ errors, schemaTooNew, unreadable, harmedByClock }`.
   */
  #problemsFor(name) {
    return (
      this.#sharedProblems.get(name) ?? {
        errors: [],
        schemaTooNew: [],
        unreadable: [],
        harmedByClock: [],
      }
    );
  }

  /**
   * `report` with the shared folder's state and `name`'s last problems added,
   * and no shared step's outcome: a profile pass ran none.
   *
   * @param {object} report A profile pass's report.
   * @param {string} name The document `report` is about.
   * @returns {object}
   */
  #withShared(report, name) {
    const none = this.#sharesNowhere();
    const problems = this.#problemsFor(name);
    return {
      ...report,
      errors: [...(report.errors ?? []), ...problems.errors],
      schemaTooNew: [...(report.schemaTooNew ?? []), ...problems.schemaTooNew],
      unreadable: [...(report.unreadable ?? []), ...problems.unreadable],
      harmedByClock: [
        ...(report.harmedByClock ?? []),
        ...problems.harmedByClock,
      ],
      shared: none ? "none" : this.#sharedState,
      sharedReason: none ? null : this.#sharedReason,
      sharedRan: false,
      sharedWrote: null,
    };
  }

  /**
   * Starts a shared step and tells the listeners when it finishes.
   *
   * @param {string} workspace The document name.
   * @param {number} now Milliseconds since the epoch.
   * @returns {Promise<object>} the step's report.
   */
  #startSharedStep(workspace, now) {
    const generation = this.#sharedGeneration;
    const names = [
      workspace,
      ...[...this.#extraDocuments.keys()].filter(name => name !== workspace),
    ];
    const step = { promise: null, generation, workspace, names, saw: null };
    step.promise = this.#runSharedStep(step, now).finally(() => {
      if (this.#sharedStep === step) {
        this.#sharedStep = null;
      }
    });
    this.#sharedStep = step;
    step.promise.then(
      report => {
        // A step whose folder choice has moved reports nothing: its outcome
        // is not about the folder the listeners are watching.
        if (generation !== this.#sharedGeneration) {
          return;
        }
        for (const fn of this.#sharedListeners) {
          try {
            fn(report);
          } catch (err) {
            SvalLog.warn(
              `a shared-step listener failed: ${describeError(err)}`
            );
          }
        }
      },
      err => {
        SvalLog.warn(`a shared step failed: ${describeError(err)}`);
      }
    );
    return step.promise;
  }

  /**
   * One exchange with the shared folder through the helper (local-copy spec
   * §4.2), for `workspace` and every extra document: one helper reads every
   * document's directory, the worker merges each, one helper publishes this
   * device's files that changed, and the profile is written again so what
   * arrived is on disk here too. The whole step shares one deadline, and the
   * folder is one folder: finding it unreachable makes the step unreachable.
   *
   * @param {object} step The step, as `#sharedStep` holds it. When the
   *   folder choice has moved from `step.generation` by the time an await
   *   returns, the step answers with a plain profile pass and leaves the
   *   shared state alone.
   * @param {number} now Milliseconds since the epoch.
   * @returns {Promise<object>} the report for `step.workspace`, with
   *   `sharedRan` true, `sharedAt` the `now` it ran at, and `exchanged`: for
   *   each document whose files this step merged from the folder and
   *   published there, the change count its merge held every change up to.
   *   `sharedRead` names every document whose files it merged from the
   *   folder, published or not.
   */
  async #runSharedStep(step, now) {
    const { workspace, names, generation } = step;
    this.#sharedLastRun = now;
    const root = this.#sharedRoot;
    const deadline = Date.now() + this.#sharedStepTimeoutMs;
    const moved = () => generation !== this.#sharedGeneration;
    const layouts = [];
    for (const name of names) {
      layouts.push(
        await this.post("layout", [
          {
            workspace: name,
            keyBytes: this.#syncKey,
            deviceId: this.#deviceId,
          },
        ])
      );
    }
    if (moved()) {
      return this.#localPasses(workspace, now);
    }
    const requireTop = layouts[0].top;

    const outcomes = new Map();
    const read = await SvalSharedFolder.readDirs({
      root,
      requireTop,
      deadline,
      dirs: layouts.map(({ prefix, suffix, mine }) => ({
        path: prefix,
        suffix,
        mine,
      })),
      consume: async ({ dirs, first }) => {
        for (const [offset, listed] of dirs.entries()) {
          if (moved()) {
            return { reachable: true };
          }
          const index = first + offset;
          const name = names[index];
          const outcome = await this.#mergeOne(
            name,
            layouts[index],
            listed,
            step,
            now
          ).catch(err => {
            if (name === workspace) {
              throw err;
            }
            // The documents are independent (settings-sync spec §6): this
            // one keeps its last problems, and the step goes on without it.
            SvalLog.warn(
              `an extra document's shared step failed, and the rest went on: ${describeError(err)}`
            );
            return null;
          });
          if (outcome) {
            outcomes.set(name, outcome);
          }
        }
        return { reachable: true };
      },
    });
    if (moved()) {
      // The user chose another folder while this one was being read, so what
      // was read is about the old one.
      return this.#localPasses(workspace, now);
    }
    if (!read.reachable) {
      // Only time a step saw a file unreadable counts toward setting it
      // aside. A step that stops short saw no other document's own file: a
      // folder out of reach shows none, and a stop at one document's own
      // file leaves every other document unread, including those its batch
      // listed before it.
      const stoppedAt =
        read.reason === "own-file-unreadable" ? names[read.dir] : undefined;
      for (const name of this.#ownUnreadSince.keys()) {
        if (name !== stoppedAt) {
          this.#ownUnreadSince.delete(name);
        }
      }
      if (stoppedAt) {
        await this.#ownFileUnread(stoppedAt, layouts[read.dir], now, {
          root,
          requireTop,
          deadline,
        });
        if (moved()) {
          return this.#localPasses(workspace, now);
        }
      }
      return this.#unreachable(workspace, now, read);
    }

    for (const [index, name] of names.entries()) {
      const outcome = outcomes.get(name);
      if (!outcome) {
        continue;
      }
      if (!outcome.ownUnread) {
        this.#ownUnreadSince.delete(name);
        continue;
      }
      await this.#ownFileUnread(name, layouts[index], now, {
        root,
        requireTop,
        deadline,
      });
      if (moved()) {
        return this.#localPasses(workspace, now);
      }
    }

    const writes = [...outcomes.values()].filter(({ merged }) => merged.write);
    if (writes.length) {
      const wrote = await SvalSharedFolder.writeFiles({
        root,
        requireTop,
        deadline,
        files: writes.map(({ merged }) => merged.write),
      });
      if (moved()) {
        return this.#localPasses(workspace, now);
      }
      if (!wrote.reachable) {
        return this.#unreachable(workspace, now, wrote);
      }
      for (const [name, { merged, saw }] of outcomes) {
        if (!merged.write || !this.#publishEvery.has(name)) {
          continue;
        }
        this.#publishedAt.set(name, now);
        if (saw >= (this.#publishNow.get(name) ?? Infinity)) {
          this.#publishNow.delete(name);
        }
      }
    }

    this.#sharedState = "reached";
    this.#sharedReason = null;
    for (const [name, { merged }] of outcomes) {
      this.#sharedProblems.set(name, {
        errors: merged.errors ?? [],
        schemaTooNew: merged.schemaTooNew ?? [],
        unreadable: merged.unreadable ?? [],
        harmedByClock: merged.harmedByClock ?? [],
      });
    }
    for (const [name, { merged, peersMerged }] of outcomes) {
      if (
        this.#extraDocuments.has(name) &&
        (peersMerged || merged.changedIds?.length || merged.removedIds?.length)
      ) {
        this.#sharedArrivals.set(name, {
          peersMerged,
          changedIds: merged.changedIds ?? [],
          removedIds: merged.removedIds ?? [],
        });
      }
    }
    const own = outcomes.get(workspace);
    const again = await this.#localPasses(workspace, now);
    return {
      ...again,
      merged: (again.merged ?? 0) + (own.merged.merged ?? 0),
      repairedIds: [
        ...(own.merged.repairedIds ?? []),
        ...(again.repairedIds ?? []),
      ],
      sharedRan: true,
      sharedWrote: own.merged.write?.path ?? null,
      sharedAt: now,
      exchanged: Object.fromEntries(
        [...outcomes]
          .filter(([, { saw }]) => saw !== null)
          .map(([name, { saw }]) => [name, saw])
      ),
      sharedRead: [...outcomes.keys()],
    };
  }

  /**
   * One document's merge in a shared step: what the helper read of its
   * directory, merged by the worker, which says what this device's file
   * there should become.
   *
   * @param {string} name The document name.
   * @param {object} layout The document's `layout`.
   * @param {object} listed `{ entries, unreadable }`, as `readDirs` hands
   *   each directory to `consume`.
   * @param {object} step The step this is part of; `step.saw` is set as the
   *   first merge is asked for.
   * @param {number} now Milliseconds since the epoch.
   * @returns {Promise<object>} `{ merged, peersMerged, saw, ownUnread }`:
   *   the worker's merge report, how many other devices' files it was
   *   handed, the change count it holds every change up to, or null when
   *   this device's own file there did not read and nothing is published,
   *   and whether that file is one to set aside once it has stayed so
   *   (`#ownFileUnread`).
   */
  async #mergeOne(name, layout, listed, step, now) {
    // The worker answers in order, so this merge, and the file it names,
    // holds every change posted before it.
    const saw = this.#changes;
    step.saw ??= saw;
    this.#settingsRead.delete(name);
    const merged = await this.post("mergeSnapshot", [
      {
        workspace: name,
        keyBytes: this.#syncKey,
        deviceId: this.#deviceId,
        now,
        archiveRetention: this.#retention.get(name)?.(),
        paths: listed.entries.map(entry => `${layout.prefix}/${entry.name}`),
        files: listed.entries.map(entry => entry.file),
        unreadable: listed.unreadable.map(file => ({
          path: `${layout.prefix}/${file.name}`,
          own: file.name === layout.mine,
          reason: file.reason,
        })),
      },
    ]);
    this.#heardPeerRemovals(merged.removedIds);
    SvalClock.atLeast(merged.ownWatermark ?? 0);
    const peersMerged = listed.entries.filter(
      entry => entry.name !== layout.mine
    ).length;
    const ownEntry = listed.unreadable.find(file => file.name === layout.mine);
    const ownUnread = ownEntry
      ? !NOT_SET_ASIDE.has(ownEntry.reason)
      : // A file a newer build wrote is intact, and that build's to replace
        // (decision 1144).
        !!merged.refusedWrite && !merged.schemaTooNew?.some(file => file.own);
    if (ownEntry) {
      // This device's own file is there and does not read, so the merge took
      // it for absent and names a first write. Nothing is written over it,
      // as the engine writes nothing over an own file it could not read
      // (`refusedWrite`), and the document is not exchanged: the folder does
      // not hold its changes. A link or a directory there is left for the
      // user to remove: the helper refuses to move either.
      return {
        merged: { ...merged, write: null, refusedWrite: true },
        peersMerged,
        saw: null,
        ownUnread,
      };
    }
    await this.#clampState();
    if (
      !SvalClock.hasReading ||
      (this.#clampFrom !== null && !this.#clamped.has(name))
    ) {
      // Nothing is published before this device's first time reading, nor
      // before the pass that pulls back the stamps taken before it (decision
      // 1714). What the folder holds is still merged.
      return {
        merged: { ...merged, write: null },
        peersMerged,
        saw: null,
        ownUnread,
      };
    }
    if (merged.write && this.#publishHeld(name, now)) {
      // Merged, and left for a later step to publish: the document counts
      // as not exchanged, so what waits on its publishing goes on waiting.
      return {
        merged: { ...merged, write: null },
        peersMerged,
        saw: null,
        ownUnread,
      };
    }
    return { merged, peersMerged, saw, ownUnread };
  }

  /**
   * Notes that `name`'s own file in the folder did not read at `now`, and
   * once it has not read for `OWN_FILE_SET_ASIDE_MS`, renames it with
   * `.damaged-<now>` appended so that the next step writes a fresh one from
   * this device's document (decision 1144). Each copy keeps its own name, and
   * the helper never moves over an existing one. The name ends past the
   * suffix every device file shares, so no step reads the copy as a peer's.
   * A move that fails is tried again at the next step.
   *
   * @param {string} name The document name.
   * @param {object} layout The document's `layout`.
   * @param {number} now Milliseconds since the epoch.
   * @param {object} folder The step's folder.
   * @param {string} folder.root The shared folder.
   * @param {string} folder.requireTop As `readDirs` took it.
   * @param {number} folder.deadline The step's deadline.
   */
  async #ownFileUnread(name, layout, now, { root, requireTop, deadline }) {
    const since = this.#ownUnreadSince.get(name);
    if (since === undefined) {
      this.#ownUnreadSince.set(name, now);
      return;
    }
    if (now - since < OWN_FILE_SET_ASIDE_MS) {
      return;
    }
    const own = `${layout.prefix}/${layout.mine}`;
    const answer = await SvalSharedFolder.moveFile({
      root,
      from: own,
      to: `${own}.damaged-${now}`,
      requireTop,
      deadline,
    });
    if (!answer.reachable) {
      SvalLog.debug(
        `could not set aside this device's file in the sync folder: ${answer.reason}`
      );
      return;
    }
    SvalLog.warn("this device's file in the sync folder was set aside");
    this.#ownUnreadSince.delete(name);
  }

  /**
   * The report of a shared step that did not reach the folder.
   *
   * The reason only, never the folder: a diagnostic says what happened, not
   * where the user keeps things.
   *
   * @param {string} workspace The document name.
   * @param {number} now Milliseconds since the epoch.
   * @param {{reason: string, error?: string}} failed The helper's answer.
   * @returns {Promise<object>}
   */
  async #unreachable(workspace, now, { reason, error }) {
    SvalLog.debug(`shared folder unreachable: ${reason}`);
    this.#sharedState = reason === "too-large" ? "too-large" : "unreachable";
    this.#sharedReason = folderProblem(reason, error);
    return {
      ...(await this.#localPasses(workspace, now)),
      sharedRan: true,
    };
  }

  /**
   * The debug line every pass gets.
   *
   * @param {object} report What {@link SvalEngine#sync} is about to resolve to.
   */
  #debugPass(report) {
    // Every pass comes through here, whatever started it, so this is where a
    // pass's decision is said. From outside a pass, "nothing happened" and
    // "nothing needed to happen" look alike: the write is skipped when the
    // merged document's shared state matches what this device already
    // published (`engine/src/sync.rs`), and refused when this device's own
    // file did not read.
    if (SvalLog.shouldLog("Debug")) {
      SvalLog.debug(
        `sync pass: ${this.#passDecision(report)}, ` +
          `${report.merged ?? 0} files merged, ` +
          `${report.errors?.length ?? 0} would not decrypt, ` +
          `${report.unreadable?.length ?? 0} would not read, ` +
          `${report.schemaTooNew?.length ?? 0} from a newer build, ` +
          `${report.repairedIds?.length ?? 0} nodes repaired, ` +
          `shared folder ${report.shared}${report.sharedRan ? "" : " (not run)"}`
      );
    }
  }

  /**
   * What a pass decided, in a few words.
   *
   * @param {object} report What {@link SvalEngine#sync} resolved to.
   * @returns {string} `published`, `refused` or `nothing to write`.
   */
  #passDecision(report) {
    if (report.wrote) {
      return "published";
    }
    // A refused write publishes nothing until the own file reads, which is
    // worth telling apart from an idle pass (see `#debugPass`).
    return report.refusedWrite ? "refused" : "nothing to write";
  }

  /**
   * What is on disk under this engine's key, decrypted and merged, as JSON.
   * Writes nothing.
   *
   * The presence check adoption needs. After publishing under a newly received
   * key, whether a pass wrote bytes does not say whether the tree is there: a
   * retry after an attempt that published and then failed writes nothing and
   * is a success. Only a read can say whether this device's tree is in that
   * directory.
   *
   * With a shared folder, what is published is what the folder holds, read
   * through the helper under the shared step's deadline; an unreachable folder
   * is a rejection the caller can tell from an empty folder, carrying the
   * helper's `reason` ("busy" when a stuck helper held the folder past the
   * deadline).
   *
   * @param {string} workspace The workspace id.
   * @param {number} [now] Milliseconds since the epoch.
   * @returns {Promise<string>} the merged document, as JSON.
   */
  async publishedTree(workspace, now = SvalClock.now()) {
    if (this.#sharesNowhere()) {
      return this.post("publishedTree", [
        {
          root: this.#root,
          now,
          workspace,
          keyBytes: this.#localKey,
          deviceId: this.#deviceId,
        },
      ]);
    }
    const identity = {
      workspace,
      keyBytes: this.#syncKey,
      deviceId: this.#deviceId,
    };
    const layout = await this.post("layout", [identity]);
    const read = await SvalSharedFolder.readDirs({
      root: this.#sharedRoot,
      dirs: [{ path: layout.prefix, suffix: layout.suffix, mine: layout.mine }],
      requireTop: layout.top,
      deadline: Date.now() + this.#sharedStepTimeoutMs,
      consume: async ({ dirs: [listed] }) => ({
        reachable: true,
        json: await this.post("treeOfSnapshot", [
          {
            ...identity,
            now,
            paths: listed.entries.map(
              entry => `${layout.prefix}/${entry.name}`
            ),
            files: listed.entries.map(entry => entry.file),
          },
        ]),
      }),
    });
    if (!read.reachable) {
      const error = new Error(
        `sval: cannot read what is published: the shared folder is unreachable (${read.reason})`
      );
      error.code = "shared_folder_unreachable";
      error.reason = read.reason;
      throw error;
    }
    return read.json;
  }

  /**
   * Whether a pass has read `workspace` off disk, so {@link tree} holds
   * the profile's copy of it. The worker starts with an empty document, and
   * only a pass reads one.
   *
   * @param {string} workspace The document name.
   * @returns {boolean}
   */
  hasRead(workspace) {
    return this.#read.has(workspace);
  }

  /**
   * The current document as the engine serialised it.
   *
   * A string, because this is also what `loadTree` takes: a document that
   * leaves and re-enters the engine without a JavaScript round trip cannot
   * lose a number's precision or a key this build does not know about on the
   * way.
   */
  async treeJson() {
    return this.post("tree");
  }

  /**
   * The current document as parsed JSON: `schema`, `written_at`, `written_by`,
   * `seen` and `nodes`.
   */
  async tree() {
    const json = await this.treeJson();
    const tree = JSON.parse(json);
    noteTree(this, json, tree.nodes ?? {});
    return tree;
  }

  /**
   * Plaintext export of a document (spec §6.7): the tree when `name` is
   * absent. A document no pass holds, such as a past week of history, is
   * read from this device's files in the profile, and nothing is written.
   *
   * @param {string} [name] A document name.
   * @returns {Promise<string>}
   */
  async exportJson(name) {
    if (name === undefined || this.#extraDocuments.has(name)) {
      return this.post("exportJson", name === undefined ? [] : [name]);
    }
    return this.post("publishedTree", [
      {
        root: this.#root,
        now: SvalClock.now(),
        workspace: name,
        keyBytes: this.#localKey,
        deviceId: this.#deviceId,
      },
    ]);
  }

  /**
   * Applies one local change and resolves to the affected node's id.
   *
   * @param {object} op `{ kind, ... }`, as `SvalSync.worker.mjs`'s `mutate`
   *   takes it. `document` names an extra document; the tree when absent.
   */
  async mutate(op) {
    this.#changed();
    return this.post("mutate", [
      {
        ...markLocal(op),
        now: op.now ?? SvalClock.now(),
        deviceId: this.#deviceId,
      },
    ]);
  }

  /**
   * Registers an extra document with this engine's worker (settings-sync
   * spec §4.1). From then on every `sync` runs it too. Idempotent; a second
   * call replaces the listener.
   *
   * @param {string} name The document name.
   * @param {Function|null} [onPass] Receives the document's report after
   *   every profile pass that ran it.
   */
  addDocument(name, onPass = null) {
    return this.#documentTurn(name, () => this.#addDocument(name, onPass));
  }

  async #addDocument(name, onPass) {
    await this.post("addDocument", [name]);
    // Unpublished until a pass has run it: what the profile holds of it is
    // read by that pass.
    this.#changed();
    this.#extraDocuments.set(name, onPass);
  }

  /**
   * Registers extra document `name` holding this device's own file before
   * any pass runs it, so the first pass merges peers' files into what this
   * device already had. A listener told what a pass brought in is then never
   * told about what was already here.
   *
   * @param {string} name The document name.
   * @param {Function} onPass As {@link addDocument} takes it.
   * @param {object} [options]
   * @param {Function} [options.retention] For a document that expires its
   *   entries, the Archive: answers how many milliseconds a pass keeps them,
   *   or undefined for a pass that expires none.
   * @param {number} [options.publishEveryMs] The least time between two
   *   writes of this device's file to the shared folder. The first step
   *   after the document opens writes it, and so does the next after
   *   {@link publishSoon}.
   * @returns {Promise<object>} the loading pass's report.
   */
  openDocument(name, onPass, { retention, publishEveryMs } = {}) {
    return this.#documentTurn(name, () =>
      this.#openDocument(name, onPass, retention, publishEveryMs)
    );
  }

  async #openDocument(name, onPass, retention, publishEveryMs) {
    await this.post("addDocument", [name]);
    if (retention) {
      this.#retention.set(name, retention);
    }
    if (publishEveryMs) {
      this.#publishEvery.set(name, publishEveryMs);
    }
    let loaded;
    try {
      loaded = await this.#localPass(name, SvalClock.now(), { ownOnly: true });
    } catch (err) {
      // A document this engine does not run is one the worker does not hold,
      // or a change to it would be accepted and never written.
      if (!this.#extraDocuments.has(name)) {
        await this.post("removeDocument", [name]);
      }
      throw err;
    }
    this.#extraDocuments.set(name, onPass);
    return loaded;
  }

  /**
   * Applies `ops` to this device's profile copy of document `name` and writes
   * it back, without the document joining any pass: it is loaded, changed,
   * written and let go. A document already registered is changed in place,
   * and its passes write it.
   *
   * @param {string} name The document name.
   * @param {object[]} ops Operations for one batch.
   */
  writeLocally(name, ops) {
    return this.#documentTurn(name, () => this.#writeLocally(name, ops));
  }

  async #writeLocally(name, ops) {
    if (this.#extraDocuments.has(name)) {
      await this.mutate({ kind: "batch", document: name, ops });
      return;
    }
    await this.post("addDocument", [name]);
    try {
      const own = { ownOnly: true };
      await this.#localPass(name, SvalClock.now(), own);
      await this.mutate({ kind: "batch", document: name, ops });
      await this.#localPass(name, SvalClock.now(), own);
    } finally {
      if (!this.#extraDocuments.has(name)) {
        await this.post("removeDocument", [name]);
      }
    }
  }

  /**
   * How many local changes this engine has been handed. A pass or merge that
   * reports a count this high or higher holds every one of them.
   *
   * @returns {number}
   */
  get changeCount() {
    return this.#changes;
  }

  /** Whether passes reach a shared folder: one is chosen, and a key opens it. */
  get sharesSomewhere() {
    return !this.#sharesNowhere();
  }

  /**
   * Forgets extra document `name`: passes stop running it and the worker lets
   * go of what it held. Its files stay. It leaves the engine's list first, so
   * no step starts naming it, and the worker lets it go once a step already
   * running it has finished, so no step names a document the worker has let
   * go.
   *
   * @param {string} name A document registered with {@link addDocument}.
   */
  removeDocument(name) {
    return this.#documentTurn(name, () => this.#removeDocument(name));
  }

  async #removeDocument(name) {
    if (!this.#extraDocuments.delete(name)) {
      return;
    }
    this.#retention.delete(name);
    this.#publishEvery.delete(name);
    this.#publishedAt.delete(name);
    this.#publishNow.delete(name);
    this.#settingsRead.delete(name);
    await this.#sharedStep?.promise.catch(() => {});
    // Registered again while the step ran, and so still wanted.
    if (!this.#extraDocuments.has(name)) {
      await this.post("removeDocument", [name]);
    }
  }

  /**
   * Has the next shared step write document `name` to the folder even when
   * its `publishEveryMs` has not passed: for a change other devices should
   * not wait for, such as a delete.
   *
   * @param {string} name The document name.
   */
  publishSoon(name) {
    if (this.#publishEvery.has(name)) {
      this.#publishNow.set(name, this.#changes);
    }
  }

  /**
   * Whether a step at `now` holds back its write of document `name`. A
   * clock set back since the last write lets it through.
   *
   * @param {string} name The document name.
   * @param {number} now Milliseconds since the epoch.
   * @returns {boolean}
   */
  #publishHeld(name, now) {
    const every = this.#publishEvery.get(name);
    const last = this.#publishedAt.get(name);
    return (
      every !== undefined &&
      last !== undefined &&
      !this.#publishNow.has(name) &&
      now >= last &&
      now - last < every
    );
  }

  /**
   * Runs `task` once every open, local write and removal asked before it for
   * document `name` has settled.
   *
   * @param {string} name The document name.
   * @param {Function} task Returns a promise.
   * @returns {Promise} what `task` resolves to.
   */
  #documentTurn(name, task) {
    const run = (this.#documentTurns.get(name) ?? Promise.resolve()).then(task);
    const settled = run.catch(() => {});
    this.#documentTurns.set(name, settled);
    settled.then(() => {
      if (this.#documentTurns.get(name) === settled) {
        this.#documentTurns.delete(name);
      }
    });
    return run;
  }

  /**
   * Whether extra document `name` is registered.
   *
   * @param {string} name
   * @returns {boolean}
   */
  hasDocument(name) {
    return this.#extraDocuments.has(name);
  }

  /** @returns {string[]} Every extra document registered, by name. */
  extraDocumentNames() {
    return [...this.#extraDocuments.keys()];
  }

  /**
   * Reads extra document `name` from this device's file in the profile and
   * writes it back if it changed, touching no other document and not the
   * shared folder. A module that mirrors a store into a document calls this
   * once before comparing the two, so it compares against what the profile
   * holds rather than an empty document.
   *
   * @param {string} name A document registered with {@link addDocument}.
   * @returns {Promise<object>} The pass's report, as `sync` describes it.
   */
  async profilePass(name) {
    return this.#localPass(name, SvalClock.now());
  }

  /**
   * Whether the profile holds this device's own file for document `name`.
   * Reads the profile and writes nothing.
   *
   * @param {string} name A document name.
   * @returns {Promise<boolean>}
   */
  async hasLocalCopy(name) {
    const { prefix, mine } = await this.post("layout", [
      { workspace: name, keyBytes: this.#localKey, deviceId: this.#deviceId },
    ]);
    return IOUtils.exists(
      PathUtils.join(this.#root, ...prefix.split("/"), mine)
    );
  }

  /**
   * Every setting in document `name`, as `{ key: value | null }`. Callers
   * between one change or pass and the next share one answer, so it is read,
   * never changed.
   *
   * @param {string} name The document name.
   * @returns {Promise<object>}
   */
  settings(name) {
    let read = this.#settingsRead.get(name);
    if (!read) {
      read = this.post("settings", [name]);
      this.#settingsRead.set(name, read);
      read.catch(() => {
        if (this.#settingsRead.get(name) === read) {
          this.#settingsRead.delete(name);
        }
      });
    }
    return read;
  }

  /**
   * Every favorite, folder and separator in document `name`, as
   * `{ id, kind, guid, parent, order, name, url, pinned, pinScope,
   * contentAt, placementAt, added, local }`, ordered by parent and then by
   * order. `pinned` marks a pin the pass that moves pins into the pins root
   * has yet to move.
   *
   * @param {string} name The document name.
   * @returns {Promise<object[]>}
   */
  async favorites(name) {
    return this.post("favorites", [name]);
  }

  /**
   * Every visit in document `name`, oldest first, as `{ id, url, title,
   * visitedAt, transition, device }`, `device` being the hex id of the device
   * that made it.
   *
   * @param {string} name The document name.
   * @returns {Promise<object[]>}
   */
  async visits(name) {
    return this.post("visits", [name]);
  }

  /**
   * Every week the history index `name` lists, newest first, as
   * `{ name, changedAt }`. An index no pass holds is read from this device's
   * file in the profile, and nothing is written.
   *
   * @param {string} name The document name.
   * @returns {Promise<object[]>}
   */
  async shards(name) {
    if (this.#extraDocuments.has(name)) {
      return this.post("shards", [name]);
    }
    return this.post("publishedShards", [
      {
        root: this.#root,
        now: SvalClock.now(),
        workspace: name,
        keyBytes: this.#localKey,
        deviceId: this.#deviceId,
      },
    ]);
  }

  /**
   * Every entry in the Archive document `name`, newest first (host contract
   * §10, "The Archive").
   *
   * @param {string} name The Archive's document name.
   * @param {number} [now] Milliseconds since the epoch.
   * @returns {Promise<object[]>}
   */
  async archived(name, now = SvalClock.now()) {
    return this.post("archived", [name, now]);
  }

  /**
   * Records that tab `id` was selected, which stamps its touch at most once
   * an hour (idle-tab archive spec §4.1). A change only when it stamped.
   *
   * @param {string} id A tab's node id.
   * @param {number} [now] Milliseconds since the epoch.
   * @returns {Promise<boolean>} whether it stamped.
   */
  async markUsed(id, now = SvalClock.now()) {
    const stamped = await this.post("markUsed", [id, this.#deviceId, now]);
    if (stamped) {
      this.#changed();
    }
    return stamped;
  }

  /**
   * The sweep over the tree and the Archive document `name` (idle-tab
   * archive spec §4.2), which writes the Archive to the profile before
   * either document changes (spec §6.3).
   *
   * @param {string} name The Archive's document name.
   * @param {object} sweep `{ default, lastActive, exempt }`.
   * @param {number} [now] Milliseconds since the epoch.
   * @returns {Promise<object>} `{ tabs, entries }`: the tabs it removed, and
   *   the entries it added.
   */
  async archiveIdle(name, sweep, now = SvalClock.now()) {
    const swept = await this.post("archiveIdle", [
      {
        archive: name,
        sweep,
        root: this.#root,
        keyBytes: this.#localKey,
        deviceId: this.#deviceId,
        now,
        archiveRetention: this.#retention.get(name)?.(),
      },
    ]);
    if (swept.tabs.length) {
      this.#changed();
    }
    return swept;
  }

  /**
   * Archives tab `id` into the Archive document `name` now, with its split
   * when it is a pane (launcher spec §4), writing the Archive first as the
   * sweep does.
   *
   * @param {string} name The Archive's document name.
   * @param {string} id A tab's node id.
   * @param {number} [now] Milliseconds since the epoch.
   * @returns {Promise<object>} `{ tabs, entries }`, as {@link archiveIdle}.
   */
  async archiveNow(name, id, now = SvalClock.now()) {
    const swept = await this.post("archiveNow", [
      {
        archive: name,
        id,
        root: this.#root,
        keyBytes: this.#localKey,
        deviceId: this.#deviceId,
        now,
        archiveRetention: this.#retention.get(name)?.(),
      },
    ]);
    if (swept.tabs.length) {
      this.#changed();
    }
    return swept;
  }

  /**
   * Adds an entry to the Archive document `name` for each tab another
   * browser archived (idle-tab archive spec §7.6), writing the Archive
   * before it changes, as {@link archiveIdle} does.
   *
   * @param {string} name The Archive's document name.
   * @param {object[]} entries `{ tab, title, url, workspace, workspaceName,
   *   closedAt }`: `tab` a fresh id for each, `closedAt` milliseconds since
   *   the epoch.
   * @param {number} [now] Milliseconds since the epoch.
   * @returns {Promise<string[]>} the entries' ids.
   */
  async importArchived(name, entries, now = SvalClock.now()) {
    return this.post("importArchived", [
      {
        archive: name,
        entries,
        root: this.#root,
        keyBytes: this.#localKey,
        deviceId: this.#deviceId,
        now,
        archiveRetention: this.#retention.get(name)?.(),
      },
    ]);
  }

  /**
   * Removes entries from the Archive document `name`, for a site the user
   * forgot (decision 2376), writing the Archive before it changes, as
   * {@link archiveIdle} does.
   *
   * @param {string} name The Archive's document name.
   * @param {string[]} ids The entries' ids.
   * @param {number} [now] Milliseconds since the epoch.
   * @returns {Promise<string[]>} the ids of the entries removed.
   */
  async forgetArchived(name, ids, now = SvalClock.now()) {
    return this.post("forgetArchived", [
      {
        archive: name,
        ids,
        root: this.#root,
        keyBytes: this.#localKey,
        deviceId: this.#deviceId,
        now,
        archiveRetention: this.#retention.get(name)?.(),
      },
    ]);
  }

  /**
   * Restores Archive entry `entry` from document `name` into the tree, as a
   * new tab, or with the rest of its split as a new split (idle-tab archive
   * spec §2).
   *
   * @param {string} name The Archive's document name.
   * @param {object} restore
   * @param {string} restore.entry The entry's id.
   * @param {string} restore.current The workspace it goes to when its own
   *   is gone.
   * @param {string[]} restore.ids The new nodes' ids, as many as the
   *   entry's `restoreIds`.
   * @param {number} [now] Milliseconds since the epoch.
   * @returns {Promise<object>} `{ tabs, split, workspace }`.
   */
  async restore(name, { entry, current, ids }, now = SvalClock.now()) {
    this.#changed();
    return this.post("restore", [
      { archive: name, entry, current, ids, deviceId: this.#deviceId, now },
    ]);
  }

  /**
   * The node id of the visit this device made to `url` at `visitedAt`.
   *
   * @param {string} url
   * @param {number} visitedAt Milliseconds since the epoch.
   * @returns {Promise<string>}
   */
  async visitId(url, visitedAt) {
    return this.post("visitId", [this.#deviceId, url, visitedAt]);
  }

  /** This device's id as the engine spells it: 32 lowercase hex digits. */
  get deviceIdHex() {
    return toHex(this.#deviceId);
  }

  /**
   * The node id of the favorite whose Places guid is `guid`.
   *
   * @param {string} guid A Places guid.
   * @returns {Promise<string>}
   */
  async favoriteId(guid) {
    return this.post("favoriteId", [guid]);
  }

  /**
   * The node id of setting `key`.
   *
   * @param {string} key A setting's key.
   * @returns {Promise<string>}
   */
  async settingId(key) {
    return this.post("settingId", [key]);
  }

  /** Notes a local change: one more unpublished, and settings read anew. */
  #changed() {
    this.#changes++;
    this.#settingsRead.clear();
  }

  /**
   * Asks for a pass soon, to publish a change just made. Requests made while
   * one waits join it, so a burst of changes is one pass and one file. The
   * pass runs like a window's background pass: every pass listener draws it,
   * and a due shared step starts. Nothing runs when nothing is unpublished by
   * then. A pass a person is waiting on goes through {@link sync}.
   */
  requestPass() {
    this.#schedulePass();
  }

  /**
   * {@link requestPass}'s timer.
   *
   * @param {object} [options]
   * @param {boolean} [options.always] Run the pass with nothing unpublished
   *   too, for listeners waiting on one.
   */
  #schedulePass({ always = false } = {}) {
    this.#passAlways ||= always;
    if (this.#passRequest !== null || this.#terminated) {
      return;
    }
    this.#passRequest = setTimeout(() => {
      this.#passRequest = null;
      const run = this.#passAlways;
      this.#passAlways = false;
      const document =
        this.#lastDocument ?? this.#extraDocuments.keys().next().value;
      if (
        this.#terminated ||
        !document ||
        (!run && this.#changes === this.#publishedChanges) ||
        !Services.prefs.getBoolPref(BACKGROUND_PASSES_PREF, true)
      ) {
        return;
      }
      this.sync(document, SvalClock.now(), { shared: "background" }).catch(
        err => SvalLog.warn(`a requested pass failed: ${describeError(err)}`)
      );
    }, this.#passRequestDelayMs);
  }

  /**
   * Runs one pass for `document` if this device holds a change no completed
   * pass has seen, and does nothing otherwise.
   *
   * Every pass runs every extra document as well, so a change to any of them
   * is published by a pass over the tree.
   *
   * @param {string} [document] The document to sync. Defaults to the tree the
   *   last pass synced, or the first extra document when no tree pass has
   *   run.
   * @returns {Promise<object|null>} the pass's report, or null when none ran.
   */
  async publishPending(
    document = this.#lastDocument ?? this.#extraDocuments.keys().next().value
  ) {
    if (
      this.#terminated ||
      !document ||
      this.#changes === this.#publishedChanges
    ) {
      return null;
    }
    // The profile only. Quitting must never start a helper, and the shared
    // folder catches up at the next launch.
    return this.sync(document, SvalClock.now(), { shared: "skip" });
  }

  /**
   * Runs `steps` one after another and hands them to the shutdown blocker,
   * which awaits them before the final pass. A closing window hands its last
   * writes over here, because nothing else is left to await them.
   *
   * The steps are chained here, in this module, because those writes end
   * after the window has gone, and Gecko runs no promise callback of a window
   * whose document has gone (`CallSetup::GetActiveGlobalObjectForCall`): a
   * chain the window built would never settle. A step that fails is logged,
   * and the next one runs.
   *
   * @param {...(Promise|Function)} steps Each a promise, or a function called
   *   once the step before has settled, answering a value or a promise.
   */
  finishBeforeShutdown(...steps) {
    const run = async () => {
      for (const step of steps) {
        try {
          await (typeof step === "function" ? step() : step);
        } catch (err) {
          SvalLog.error(
            `a closing window's last write failed: ${describeError(err)}`
          );
        }
      }
    };
    const tracked = run().finally(() => this.#pendingFlushes.delete(tracked));
    this.#pendingFlushes.add(tracked);
  }

  /**
   * The shutdown blocker's work: wait for what closing windows handed over,
   * then publish whatever is still unpublished. A join in flight is not
   * waited for: this engine's document is this profile's throughout one
   * (`SvalKeyJoin`).
   *
   * @returns {Promise<void>}
   */
  async publishBeforeShutdown() {
    await this.closedWindowsFlushed();
    await this.publishPending();
  }

  /**
   * Settles once every flush a closing window handed over
   * ({@link finishBeforeShutdown}) has.
   *
   * @returns {Promise<void>}
   */
  async closedWindowsFlushed() {
    await Promise.allSettled(this.#pendingFlushes);
  }

  /**
   * Stops the worker, and with it any final pass. A post after this would
   * start a fresh worker holding an empty document, which is not this device's
   * state, so the shutdown blocker must not reach it.
   */
  terminate() {
    this.#terminated = true;
    this.#stopFirstReading?.();
    clearTimeout(this.#passRequest);
    this.#passRequest = null;
    if (this === sharedEngine) {
      releaseShutdown();
    }
    super.terminate();
  }

  /**
   * The git tree id of `engine/` this engine was built from, which the worker
   * also logs at Info when it loads the engine (`docs/host-contract.md` §11).
   *
   * @returns {Promise<string>} A tree id, that id with `-dirty` for a build of
   *   a working tree with uncommitted changes in `engine/`, or "unknown".
   */
  async engineVersion() {
    return this.post("engineVersion");
  }

  /**
   * A fresh pairing code (spec §6.7). Pairing seals whatever key the caller
   * hands it, so this and the other pairing calls work the same on any
   * `SvalEngine`, whatever its own key and device id.
   *
   * @returns {Promise<string>} A 14-character grouped code.
   */
  async generatePairingCode() {
    return this.post("generatePairingCode");
  }

  /**
   * Seals `keyBytes` under `code` until `now + ttlMs`.
   *
   * @param {Uint8Array} keyBytes The 32-byte document key to hand off.
   * @param {string} code The code the seal opens under.
   * @param {number} now Milliseconds since the epoch.
   * @param {number} ttlMs How long the seal stays open.
   * @returns {Promise<Uint8Array>} The sealed file's bytes.
   */
  async sealPairing(keyBytes, code, now, ttlMs) {
    return this.post("sealPairing", [{ keyBytes, code, now, ttlMs }]);
  }

  /**
   * Recovers the key `bytes` sealed, given `code`. Rejects with code
   * `bad_pairing_code` for a wrong code and `malformed_pairing_file` for bytes
   * that are not a pairing file at all.
   *
   * @param {Uint8Array} bytes The sealed file's bytes.
   * @param {string} code The code to try.
   * @returns {Promise<Uint8Array>} The 32-byte document key.
   */
  async openPairing(bytes, code) {
    return this.post("openPairing", [{ bytes, code }]);
  }

  /**
   * A pairing file's expiry, without needing the code.
   *
   * @param {Uint8Array} bytes The sealed file's bytes.
   * @returns {Promise<number>} Milliseconds since the epoch.
   */
  async pairingExpiresAt(bytes) {
    return this.post("pairingExpiresAt", [{ bytes }]);
  }
}

/**
 * A document module's one instance for the process, over the profile's
 * engine (settings-sync spec §4.2). Every window starts it: the first call
 * for an engine makes and starts the instance, and every other caller,
 * concurrent or later, gets the same one, because the promise is recorded
 * before anything is awaited. A call for another engine stops the last
 * instance first: at once when it is made, so a start still waiting until it
 * can begin holds nothing up, and again once its start has settled.
 */
export class SvalProcessInstance {
  /** Makes the instance: `(engine, options) => instance or a promise of one`. */
  #make;

  /** `{ engine, sync, ready }`, or null. `sync` is null until made. */
  #entry = null;

  /**
   * @param {Function} make `(engine, options)`, answering an instance with
   *   `start()` and `stop()`, or a promise of one.
   */
  constructor(make) {
    this.#make = make;
  }

  /**
   * The instance for `engine`, started.
   *
   * @param {SvalEngine} engine The profile's engine.
   * @param {object} [options] Handed to `make`.
   * @returns {Promise<object>}
   */
  startFor(engine, options = {}) {
    if (this.#entry?.engine === engine) {
      return this.#entry.ready;
    }
    const previous = this.#entry;
    previous?.sync?.stop();
    const entry = { engine, sync: null, ready: null };
    entry.ready = (async () => {
      if (previous) {
        await previous.ready.catch(() => {});
        previous.sync?.stop();
      }
      const sync = await this.#make(engine, options);
      entry.sync = sync;
      try {
        await sync.start();
      } catch (err) {
        sync.stop();
        throw err;
      }
      return sync;
    })();
    this.#entry = entry;
    entry.ready.catch(() => {
      if (this.#entry === entry) {
        this.#entry = null;
      }
    });
    return entry.ready;
  }

  /**
   * @returns {{engine: object, sync: object|null}|null} the instance and the
   *   engine it runs over, or null. `sync` is null until it is made.
   */
  get shared() {
    return this.#entry
      ? { engine: this.#entry.engine, sync: this.#entry.sync }
      : null;
  }

  /** @returns {object|null} the instance, once made. */
  get instance() {
    return this.#entry?.sync ?? null;
  }

  /** Stops the instance and forgets it, for tests and shutdown. */
  async stop() {
    const entry = this.#entry;
    this.#entry = null;
    if (entry) {
      entry.sync?.stop();
      await entry.ready.catch(() => {});
      entry.sync?.stop();
    }
  }
}
