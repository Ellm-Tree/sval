/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The only code in Sval that performs file I/O.
 *
 * `sval-core` cannot: WASM has no filesystem, and Firefox's only privileged
 * storage API (`IOUtils`, `dom/chrome-webidl/IOUtils.webidl`) is
 * Promise-based throughout, which JS cannot block on. So the boundary is
 * inverted as `docs/host-contract.md` §1 requires: this worker lists and
 * reads, hands the engine a snapshot of plain bytes, and writes back the
 * single file the engine names.
 *
 * It also supplies every value the engine refuses to invent, such as node ids
 * and timestamps, because `wasm32-unknown-unknown` has neither a clock nor an
 * entropy source of its own (host contract §3).
 */

import initWasm, {
  SvalDocument,
  init as installPanicHook,
  syncPrefix,
  devicePath,
  isDeviceFile,
  generatePairingCode,
  sealPairing,
  openPairing,
  pairingExpiresAt,
  favoriteId,
  settingId,
  visitId,
} from "chrome://browser/content/sval/sval_core.mjs";
// Read through the namespace, because a named import the module lacks fails
// the whole worker at link time. An engine that predates `engineVersion`, as a
// bisect builds, then loads and reports "unknown".
import * as engineModule from "chrome://browser/content/sval/sval_core.mjs";
import { applyOp } from "chrome://browser/content/sval/SvalDocumentOps.mjs";
import {
  SvalError,
  causeNamed,
  describe,
  loadEngine,
  serve,
} from "chrome://browser/content/sval/SvalWorkerHost.mjs";

// What a workspace nobody has touched is, as the panel and the tab observer
// judge it. Loaded into this worker's own global, the only one it has.
const { childrenByParent, isUntouchedWorkspace, workspaceIds } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalTree.sys.mjs",
    { global: "current" }
  );

/**
 * This worker's own console, with Sval's prefix and a level handed in rather
 * than read.
 *
 * `maxLogLevelPref` does not work in a worker: given one off the main thread,
 * `ConsoleInstance` sets the level from `maxLogLevel` alone and logs
 * "Console.maxLogLevelPref is not supported within workers!" as an error
 * (`dom/console/ConsoleInstance.cpp`). `SvalEngine` reads
 * `browser.sval.loglevel` on the main thread and sends it in through
 * {@link SvalSyncWorker#setLogLevel} before the first call it makes.
 *
 * Reassigned, because a `ConsoleInstance`'s level is fixed at construction.
 */
let SvalLog = console.createInstance({ prefix: "sval", maxLogLevel: "Warn" });

/**
 * `syncPrefix` and every path in a `SyncOutcome` are engine-relative and
 * always `/`-separated: they name positions in `sval-core`'s own
 * `sval/ws/<hashed>/<device>.json` layout. The
 * engine matches its own device's file against these strings byte for byte,
 * so they must be passed back to it unchanged; only this function knows about
 * the storage root.
 *
 * @param {string} root Absolute path of the user's storage folder.
 * @param {string} relative An engine-relative, `/`-separated path.
 * @returns {string} The absolute path `relative` names under `root`.
 */
function toAbsolute(root, relative) {
  return PathUtils.join(root, ...relative.split("/"));
}

/**
 * This device's own file in a document's directory, by the engine's answer:
 * `devicePath` is engine-relative and `/`-separated like `syncPrefix`
 * ({@link toAbsolute}), so its last segment is the file's name, and the
 * extension every file shares is that name's.
 *
 * @param {Uint8Array} keyBytes
 * @param {string} workspace
 * @param {Uint8Array} deviceId
 * @returns {{mine: string, suffix: string}}
 */
function ownFile(keyBytes, workspace, deviceId) {
  const relative = devicePath(keyBytes, workspace, deviceId);
  const mine = relative.slice(relative.lastIndexOf("/") + 1);
  return { mine, suffix: mine.slice(mine.lastIndexOf(".")) };
}

/**
 * The engine code the loaded engine was built from (host contract §11).
 *
 * @returns {string} The git tree id of `engine/`, that id with `-dirty` for a
 *   build with uncommitted changes, or "unknown".
 */
function engineVersion() {
  return typeof engineModule.engineVersion === "function"
    ? engineModule.engineVersion()
    : "unknown";
}

/**
 * The bytes of the copies the shared-folder helper left on this machine.
 * They are local files written a moment ago, so one that does not read is a
 * failure, never a file to leave out: an own file left out reads to the
 * engine as a first run.
 *
 * @param {string[]} files Absolute paths.
 * @returns {Promise<Uint8Array[]>}
 */
async function readCopies(files) {
  const bytes = [];
  for (const file of files) {
    try {
      bytes.push(await IOUtils.read(file));
    } catch (err) {
      throw new SvalError(
        `sval: a copy of the shared folder did not read: ${describe(err)}`,
        causeNamed(err)
      );
    }
  }
  return bytes;
}

/**
 * A snapshot merged into a fresh document, as JSON. Writes nothing.
 *
 * A fresh document has no watermarks, so every node in every file survives
 * the merge, and the answer is the union of what is there, whatever this
 * device would have kept.
 *
 * @param {object} options
 * @param {string[]} options.paths Engine-relative paths.
 * @param {Uint8Array[]} options.files The bytes behind each path.
 * @param {string} options.workspace The document name.
 * @param {Uint8Array} options.keyBytes The 32-byte document key.
 * @param {Uint8Array} options.deviceId This device's 16 bytes.
 * @param {number} options.now Milliseconds since the epoch.
 * @param {boolean} [options.shared] Whether the files are the shared
 *   folder's, as the engine's `sync` takes it.
 * @returns {string}
 */
function mergeScratch({
  paths,
  files,
  workspace,
  keyBytes,
  deviceId,
  now,
  shared = false,
}) {
  const scratch = new SvalDocument();
  try {
    const outcome = scratch.sync(
      keyBytes,
      deviceId,
      workspace,
      paths,
      files,
      now,
      undefined,
      shared
    );
    // Freed unread: `sync` is the only way to fold a snapshot into a
    // document, and writing what it decided is what this must not do.
    outcome.free();
    return scratch.toJson();
  } catch (err) {
    throw new SvalError(
      `sval: cannot read what is published: ${describe(err)}`,
      err
    );
  } finally {
    scratch.free();
  }
}

/**
 * Holds the wasm module, the one document it owns, and the only filesystem
 * access in Sval.
 */
class SvalSyncWorker {
  /** The one document this worker holds. Rebuilt from disk by the first sync. */
  #doc = null;

  /**
   * The workspaces of the tree that were untouched (`isUntouchedWorkspace`)
   * when last looked at. See `#touchTouchedWorkspaces`.
   */
  #untouched = new Set();

  /**
   * Documents other than the tree, by name (settings-sync spec §4.1). Each is
   * synced under its own name, so it lands in its own directory, and none is
   * touched by the tree-only calls: `loadTree` and `tree`.
   */
  #extra = new Map();

  /**
   * Extra documents registered and then removed. A pass for one is refused:
   * left to `#docFor`, its name would be taken for the tree's.
   */
  #retired = new Set();

  /**
   * The extra document `documentName` names, which must be registered.
   * `mutate` and `settings` use this, so a setting sent before `addDocument`,
   * or to a misspelt name, is refused instead of landing in the tree.
   *
   * @param {string} documentName A document name.
   * @returns {SvalDocument}
   */
  #registered(documentName) {
    const doc = this.#extra.get(documentName);
    if (!doc) {
      throw new SvalError(
        `sval: document "${documentName}" is not registered`,
        {
          code: "not_registered",
        }
      );
    }
    return doc;
  }

  /**
   * The document `documentName` names: a registered extra document, or the
   * tree. `sync` and `mergeSnapshot` use this because they cannot tell an
   * unregistered extra document from a tree name.
   *
   * @param {string|undefined} documentName A document name, or undefined for
   *   the tree.
   * @returns {SvalDocument}
   */
  #docFor(documentName) {
    if (this.#retired.has(documentName)) {
      throw new SvalError(`sval: a removed document cannot be synced`);
    }
    return (
      (documentName !== undefined && this.#extra.get(documentName)) || this.#doc
    );
  }

  /** Resolves once the wasm module is instantiated; awaited by every call. */
  #ready = null;

  /**
   * The tail of the sync queue: every pass waits for the one before it.
   *
   * A pass is a read-modify-write spread across many `await` points: list,
   * read every file, merge into `#doc`, write one file back. Two interleaved
   * passes would merge into the same document from two snapshots and both
   * write it, so the later write could publish a state no single snapshot
   * held. They would also share the one temp path `IOUtils.write` renames
   * from.
   */
  #queue = Promise.resolve();

  constructor() {
    this.#connectToPromiseWorker();
  }

  async #ensureReady() {
    if (!this.#ready) {
      this.#ready = (async () => {
        await loadEngine(initWasm);
        // Makes a panic in sval-core print its file, line and message instead
        // of surfacing only as `RuntimeError: unreachable executed`. It does
        // not make one recoverable: a trap leaves this module instance and
        // the document it holds unusable (host contract §8).
        installPanicHook();
        this.#doc = new SvalDocument();
        // Once per load: which engine code every later line came from. A
        // tree id names code and nothing browsed (CONTRIBUTING.md rule 10).
        SvalLog.info(`engine ${engineVersion()}`);
      })().catch(err => {
        // Cleared so a later call retries instead of replaying one stored
        // rejection for the lifetime of the worker.
        this.#ready = null;
        throw new SvalError(
          `sval: the engine failed to load: ${describe(err)}`,
          err
        );
      });
    }
    await this.#ready;
    return this.#doc;
  }

  /**
   * Registers an extra document. Idempotent: a second call keeps the document
   * already held, because `SvalPanel._start` runs again after a key adoption.
   *
   * @param {string} documentName The document name.
   */
  async addDocument(documentName) {
    return this.#enqueue(() => {
      this.#retired.delete(documentName);
      if (!this.#extra.has(documentName)) {
        this.#extra.set(documentName, new SvalDocument());
      }
    });
  }

  /**
   * Forgets an extra document: what this worker holds of it is let go, and
   * its files stay where they are. A week of history nobody is writing to is
   * held only while a pass merges it (history-sync spec §4.1).
   *
   * @param {string} documentName The document name.
   */
  async removeDocument(documentName) {
    return this.#enqueue(() => {
      if (this.#extra.delete(documentName)) {
        this.#retired.add(documentName);
      }
    });
  }

  /**
   * Every setting in document `documentName`, as `{ key: value | null }`.
   *
   * @param {string} documentName The document name.
   * @returns {Promise<object>}
   */
  async settings(documentName) {
    return this.#enqueue(() => {
      const doc = this.#registered(documentName);
      try {
        return JSON.parse(doc.settings());
      } catch (err) {
        throw new SvalError(`sval: ${describe(err)}`, err);
      }
    });
  }

  /**
   * One sync pass, queued behind any pass already in flight.
   *
   * @param {object} options
   * @param {string} options.root Absolute path of the user's storage folder.
   * @param {string} options.workspace The workspace id to sync.
   * @param {Uint8Array} options.keyBytes The 32-byte document key.
   * @param {Uint8Array} options.deviceId This device's 16 bytes.
   * @param {number} [options.now] Milliseconds since the epoch.
   * @param {boolean} [options.ownOnly] Merge only this device's own file,
   *   as a document being loaded does.
   * @param {number} [options.archiveRetention] For the Archive alone: drop
   *   the entries closed at least this many milliseconds before `now`
   *   (host contract §10, "The Archive").
   * @param {number} [options.clampFrom] When this device's first time
   *   reading arrived, on this document's first pass since: the engine pulls
   *   back the stamps taken before it (decision 1714).
   * @returns {Promise<object>} the engine's report, plus `wrote` and
   *   `unreadable`.
   */
  async sync(options) {
    return this.#enqueue(() => this.#syncOnce(options));
  }

  /**
   * Where a document's files live, so the browser can hand the helper a
   * directory without handing it the key (local-copy spec §3).
   *
   * @param {object} options
   * @param {string} options.workspace The document name.
   * @param {Uint8Array} options.keyBytes The 32-byte document key.
   * @param {Uint8Array} options.deviceId This device's 16 bytes.
   * @returns {Promise<object>} `{ prefix, mine, suffix, top }`: the
   *   engine-relative directory, this device's file name, the extension every
   *   file shares, and the top-level directory a published folder holds.
   */
  async layout({ workspace, keyBytes, deviceId }) {
    await this.#ensureReady();
    try {
      const prefix = syncPrefix(keyBytes, workspace);
      return {
        prefix,
        ...ownFile(keyBytes, workspace, deviceId),
        top: prefix.split("/")[0],
      };
    } catch (err) {
      throw new SvalError(`sval: ${describe(err)}`, err);
    }
  }

  /**
   * Merges a snapshot of the shared folder that the browser read through the
   * helper, and says what this device's file there should become, without
   * writing it.
   *
   * @param {object} options
   * @param {string[]} options.paths Engine-relative paths.
   * @param {string[]} options.files Where the helper left a copy of each
   *   path's bytes, on this machine.
   * @param {object[]} options.unreadable Files the helper could not read, as
   *   `{ path, own, reason }`.
   * @param {string} options.workspace The document name.
   * @param {Uint8Array} options.keyBytes The 32-byte document key.
   * @param {Uint8Array} options.deviceId This device's 16 bytes.
   * @param {number} [options.now] Milliseconds since the epoch.
   * @param {number} [options.archiveRetention] As {@link sync} takes it.
   * @returns {Promise<object>} the engine's report, plus `unreadable` and
   *   `write`: `{ path, bytes }` for the browser to publish, or null.
   */
  async mergeSnapshot({
    paths,
    files,
    unreadable,
    workspace,
    keyBytes,
    deviceId,
    now,
    archiveRetention,
  }) {
    return this.#enqueue(async () => {
      let write = null;
      const report = await this.#merge({
        snapshot: { paths, files: await readCopies(files), unreadable },
        workspace,
        keyBytes,
        deviceId,
        now,
        archiveRetention,
        shared: true,
        write: async (path, bytes) => {
          write = { path, bytes };
        },
      });
      delete report.wrote;
      return { ...report, write };
    });
  }

  /**
   * `publishedTree` for a snapshot the browser read through the helper.
   * Writes nothing, and touches only a scratch document.
   *
   * @param {object} options
   * @param {string[]} options.paths Engine-relative paths.
   * @param {string[]} options.files Where the helper left a copy of each
   *   path's bytes, on this machine.
   * @param {string} options.workspace The document name.
   * @param {Uint8Array} options.keyBytes The 32-byte document key.
   * @param {Uint8Array} options.deviceId This device's 16 bytes.
   * @param {number} [options.now] Milliseconds since the epoch.
   * @returns {Promise<string>} the merged document, as JSON.
   */
  async treeOfSnapshot({
    paths,
    files,
    workspace,
    keyBytes,
    deviceId,
    now = Date.now(),
  }) {
    await this.#ensureReady();
    return mergeScratch({
      paths,
      files: await readCopies(files),
      workspace,
      keyBytes,
      deviceId,
      now,
      shared: true,
    });
  }

  /**
   * Runs `work` after everything already queued, whatever that settled as.
   *
   * Everything that touches `#doc` goes through here: a
   * document replaced between a pass's merge and its write would be published
   * from a state no snapshot ever held, which is the same hazard two
   * interleaved passes present. Reads and mutations are queued too, so the
   * document each call sees is the one every call posted before it left: a
   * mutation that overtook a queued `loadTree` would land in the document it
   * replaces.
   *
   * So a call joins the queue the moment its message arrives, and waits for
   * the engine inside it: `PromiseWorker` dispatches each message as it
   * comes, and a call that awaited the load first would join behind calls
   * posted after it.
   *
   * @param {Function} work The call to serialise.
   * @returns {Promise<*>} whatever `work` resolves to.
   */
  #enqueue(work) {
    const run = async () => {
      await this.#ensureReady();
      return work();
    };
    // The same continuation on both settlements: a failed item must neither
    // reject the next one nor break the queue.
    const item = this.#queue.then(run, run);
    this.#queue = item.catch(() => {});
    return item;
  }

  /** Loads the engine ahead of the first call that needs it. */
  async warm() {
    await this.#ensureReady();
  }

  /**
   * Rebuilds {@link SvalLog} at `level`, which the parent read from the pref.
   *
   * Invalid values are ignored: `maxLogLevel` is a WebIDL enum, so a pref
   * holding something that is not a level name would reject whichever call
   * carried it, and a bad log level must not fail a sync pass.
   *
   * @param {string} level A `ConsoleLogLevel` name.
   */
  setLogLevel(level) {
    try {
      SvalLog = console.createInstance({ prefix: "sval", maxLogLevel: level });
    } catch (err) {
      SvalLog.warn(`ignoring an unusable log level: ${SvalLog.errorName(err)}`);
    }
  }

  /**
   * Removes each workspace among `ids` that is still untouched, and what is
   * in it, in one queued step, so nothing posted after it can land in
   * between. See `SvalEngine.leaveUntouched`.
   *
   * @param {string[]} ids What a join's candidate left out.
   */
  async leaveUntouched(ids) {
    return this.#enqueue(() => {
      const nodes = JSON.parse(this.#doc.toJson()).nodes ?? {};
      const byParent = childrenByParent(nodes);
      for (const id of ids) {
        if (isUntouchedWorkspace(nodes, id, byParent)) {
          for (const child of byParent.get(id) ?? []) {
            this.#doc.remove(child);
          }
          this.#doc.remove(id);
        }
      }
    });
  }

  /**
   * Replaces this worker's document with the one `json` describes.
   *
   * `json` is what `tree` produced: the engine's own serialisation, parsed by
   * the engine's own deserialiser, so the round trip carries `written_at`,
   * `written_by`, `seen` and every unrecognised-field bucket with it.
   *
   * @param {string} json A full document, as `tree` returns it.
   */
  async loadTree(json) {
    return this.#enqueue(() => {
      try {
        this.#doc = SvalDocument.loadJson(json);
      } catch (err) {
        throw new SvalError(
          `sval: could not load the document: ${describe(err)}`,
          err
        );
      }
    });
  }

  /**
   * Everything under `keyBytes`'s prefix that the engine can be handed: the
   * engine-relative paths and the bytes behind them.
   *
   * @param {object} options
   * @param {string} options.root Absolute path of the user's storage folder.
   * @param {string} options.workspace The workspace id.
   * @param {Uint8Array} options.keyBytes The 32-byte document key.
   * @param {Uint8Array} options.deviceId This device's 16 bytes.
   * @param {boolean} [options.ownOnly] Collect only this device's own file.
   * @returns {Promise<object>} `{ paths, files, unreadable, hasMine }`.
   */
  async #collect({ root, workspace, keyBytes, deviceId, ownOnly = false }) {
    let prefix;
    try {
      prefix = syncPrefix(keyBytes, workspace);
    } catch (err) {
      throw new SvalError(`sval: ${describe(err)}`, err);
    }
    const dir = toAbsolute(root, prefix);
    let mine;
    let suffix;
    try {
      ({ mine, suffix } = ownFile(keyBytes, workspace, deviceId));
    } catch (err) {
      throw new SvalError(`sval: ${describe(err)}`, err);
    }

    // `ignoreAbsent`: the directory not existing yet is the ordinary
    // first-run case, and a separate `exists` check leaves a window in which
    // it can appear or vanish between the two calls.
    let children;
    try {
      children = await IOUtils.getChildren(dir, { ignoreAbsent: true });
    } catch (err) {
      throw new SvalError(
        `sval: cannot list ${dir}: ${describe(err)}`,
        causeNamed(err)
      );
    }

    // Only files sharing the engine's own extension are candidates. A leftover
    // `.tmp` from a write interrupted by a crash is not a peer's state, and
    // handed to the engine it would be a decryption error on every later sync.
    const paths = [];
    const files = [];
    const unreadable = [];
    let hasMine = false;
    for (const child of children) {
      const filename = PathUtils.filename(child);
      if (!filename.endsWith(suffix)) {
        continue;
      }
      if (filename === mine) {
        hasMine = true;
      } else if (ownOnly) {
        continue;
      }
      let bytes;
      try {
        bytes = await IOUtils.read(child);
      } catch (err) {
        if (filename === mine) {
          // A file absent from the snapshot reads as `NotFound` to the engine
          // (`PreloadedStore::read` is a map lookup), and `NotFound` on this
          // device's own file is the one case `sync` treats as "first run,
          // nothing of mine to merge": it then merges the peers and overwrites
          // this path. So an own file that exists but cannot be read must
          // never be turned into an absence. The pass stops here, before the
          // engine is called, and the file on disk is left untouched.
          //
          // That is ordinary in the cloud folders this is designed for: an
          // iCloud placeholder not yet materialised, a Dropbox lock, a volume
          // not yet mounted. Everything this device wrote that no peer has
          // merged exists only in that file.
          throw new SvalError(
            `sval: cannot read this device's own file ${filename}, so nothing ` +
              `was published or overwritten: ${describe(err)}`,
            { ...causeNamed(err), reason: "own_file_unreadable" }
          );
        }
        // One unreadable peer must not stop the others converging, so it is
        // dropped from the snapshot and reported. Both its path and its bytes
        // are dropped: a path paired with empty bytes would reach the engine
        // as a corrupt peer.
        unreadable.push({
          path: `${prefix}/${filename}`,
          own: false,
          reason: describe(err),
        });
        continue;
      }
      files.push(bytes);
      paths.push(`${prefix}/${filename}`);
    }

    return { paths, files, unreadable, hasMine };
  }

  /**
   * What is on disk under `keyBytes`'s prefix, decrypted and merged into a
   * scratch document, as JSON. Writes nothing.
   *
   * The question adoption has to answer after it publishes is "is this
   * device's tree under the new key", and the sync report cannot answer it: a
   * pass that writes nothing is the correct outcome both when the publish
   * failed and when an earlier attempt already published the same document.
   * Reading the directory back separates them.
   *
   * @param {object} options
   * @param {string} options.root Absolute path of the user's storage folder.
   * @param {string} options.workspace The workspace id.
   * @param {Uint8Array} options.keyBytes The 32-byte document key.
   * @param {Uint8Array} options.deviceId This device's 16 bytes.
   * @param {number} [options.now] Milliseconds since the epoch.
   * @returns {Promise<string>} the merged document, as JSON.
   */
  async publishedTree({
    root,
    workspace,
    keyBytes,
    deviceId,
    now = Date.now(),
  }) {
    return this.#enqueue(async () => {
      const { paths, files } = await this.#collect({
        root,
        workspace,
        keyBytes,
        deviceId,
      });
      return mergeScratch({ paths, files, workspace, keyBytes, deviceId, now });
    });
  }

  /**
   * Every week the history index `workspace` lists on disk, as
   * {@link shards} answers for a registered one, read as
   * {@link publishedTree} reads. Writes nothing.
   *
   * @param {object} options
   * @param {string} options.root Absolute path of the folder to read.
   * @param {string} options.workspace The history index's name.
   * @param {Uint8Array} options.keyBytes The 32-byte document key.
   * @param {Uint8Array} options.deviceId This device's 16 bytes.
   * @param {number} [options.now] Milliseconds since the epoch.
   * @returns {Promise<object[]>}
   */
  async publishedShards({
    root,
    workspace,
    keyBytes,
    deviceId,
    now = Date.now(),
  }) {
    return this.#enqueue(async () => {
      const { paths, files } = await this.#collect({
        root,
        workspace,
        keyBytes,
        deviceId,
      });
      const json = mergeScratch({
        paths,
        files,
        workspace,
        keyBytes,
        deviceId,
        now,
      });
      let doc = null;
      try {
        doc = SvalDocument.loadJson(json);
        return JSON.parse(doc.shards());
      } catch (err) {
        throw new SvalError(`sval: ${describe(err)}`, err);
      } finally {
        doc?.free();
      }
    });
  }

  async #syncOnce({
    root,
    workspace,
    keyBytes,
    deviceId,
    now = Date.now(),
    ownOnly = false,
    archiveRetention,
    clampFrom,
    doc,
  }) {
    const snapshot = await this.#collect({
      root,
      workspace,
      keyBytes,
      deviceId,
      ownOnly,
    });
    const report = await this.#merge({
      snapshot,
      workspace,
      keyBytes,
      deviceId,
      now,
      archiveRetention,
      clampFrom,
      doc,
      write: async (relative, bytes) => {
        const target = toAbsolute(root, relative);
        await IOUtils.makeDirectory(PathUtils.parent(target));
        // `tmpPath` makes this a write-then-rename, so a reader never sees a
        // half-written file (spec §6.3).
        await IOUtils.write(target, bytes, { tmpPath: `${target}.tmp` });
      },
    });
    return { ...report, hadLocalCopy: snapshot.hasMine };
  }

  /**
   * Merges `snapshot` into the document and hands `write` the one file the
   * engine names, if it names one.
   *
   * @param {object} options
   * @param {object} options.snapshot `{ paths, files, unreadable }`.
   * @param {string} options.workspace The document name.
   * @param {Uint8Array} options.keyBytes The 32-byte document key.
   * @param {Uint8Array} options.deviceId This device's 16 bytes.
   * @param {number} [options.now] Milliseconds since the epoch.
   * @param {number} [options.archiveRetention] As {@link sync} takes it.
   * @param {number} [options.clampFrom] As {@link sync} takes it.
   * @param {SvalDocument} [options.doc] The document to merge into, when it
   *   is not the one `workspace` names: a copy not yet put in its place.
   * @param {boolean} [options.shared] Whether `snapshot` is the shared
   *   folder's, which holds none of this device's local nodes (decision
   *   1372); this device's profile copy otherwise.
   * @param {Function} options.write `(relativePath, bytes) => Promise`.
   * @returns {Promise<object>} the engine's report, plus `wrote` and
   *   `unreadable`.
   */
  async #merge({
    snapshot,
    workspace,
    keyBytes,
    deviceId,
    now = Date.now(),
    archiveRetention,
    clampFrom,
    doc = this.#docFor(workspace),
    shared = false,
    write,
  }) {
    const { paths, files } = snapshot;
    const tree = doc === this.#doc;
    if (tree) {
      this.#touchTouchedWorkspaces(deviceId, now);
    }

    let outcome;
    try {
      outcome = doc.sync(
        keyBytes,
        deviceId,
        workspace,
        paths,
        files,
        now,
        archiveRetention,
        shared,
        clampFrom
      );
    } catch (err) {
      throw new SvalError(`sval: sync failed: ${describe(err)}`, err);
    }
    if (tree) {
      this.#noteUntouchedWorkspaces();
    }
    // A file the engine would not open is no peer, so one that would not
    // read is no problem either: a cloud client's conflict copy, say.
    const unreadable = snapshot.unreadable.filter(file =>
      isDeviceFile(keyBytes, workspace, file.path)
    );

    let wrote = null;
    try {
      const writePath = outcome.writePath;
      if (writePath !== undefined) {
        await write(writePath, outcome.writeBytes);
        wrote = writePath;
      }
      // The filesystem's half of a pass, which `SvalEngine`'s report cannot
      // see: how many peer files were there to merge and how many would not
      // read. `shouldLog` first, so a pass nobody follows builds no string.
      if (SvalLog.shouldLog("Debug")) {
        SvalLog.debug(
          `pass: ${files.length} files read, ${unreadable.length} ` +
            `unreadable, ${wrote ? "one published" : "none published"}`
        );
      }
      return { ...JSON.parse(outcome.reportJson), wrote, unreadable };
    } catch (err) {
      throw new SvalError(`sval: ${describe(err)}`, causeNamed(err));
    } finally {
      outcome.free();
    }
  }

  /**
   * Touches each workspace of the tree that was untouched when last looked at
   * and is touched at this merge, so that the work which touched it is an
   * edit to the workspace (decision 0106). Run inside every merge, before it,
   * so no merge takes in a peer's file, and no file is published, without it.
   *
   * Another device can show the same workspace while it is untouched, and
   * close its window on it before this device's work there reaches it. That
   * close deletes the workspace (decision 0101). Tabs and groups filed under
   * it are not edits to the workspace, so without the touch the delete would
   * win, and repair would move them to another workspace (spec §5.2). A touch
   * the deleting device never saw wins over its delete (decision 0017). A
   * device that has seen the touch has seen the work with it, and judges the
   * workspace touched.
   *
   * The touch holds no value, so it costs no edit made elsewhere. A
   * workspace a peer's change touched is touched here too, which is
   * harmless.
   *
   * @param {Uint8Array} deviceId This device's 16 bytes.
   * @param {number} now Milliseconds since the epoch.
   */
  #touchTouchedWorkspaces(deviceId, now) {
    const nodes = JSON.parse(this.#doc.toJson()).nodes ?? {};
    const byParent = childrenByParent(nodes);
    const was = this.#untouched;
    this.#untouched = new Set();
    for (const id of workspaceIds(nodes)) {
      if (isUntouchedWorkspace(nodes, id, byParent)) {
        this.#untouched.add(id);
      } else if (was.has(id)) {
        applyOp(this.#doc, { kind: "touch", id, deviceId }, { id, now });
      }
    }
  }

  /**
   * Adds the tree's untouched workspaces to `#untouched`, such as one a merge
   * just brought in. None is taken out here, so a touch this device makes
   * before the next merge is still found.
   */
  #noteUntouchedWorkspaces() {
    const nodes = JSON.parse(this.#doc.toJson()).nodes ?? {};
    const byParent = childrenByParent(nodes);
    for (const id of workspaceIds(nodes)) {
      if (isUntouchedWorkspace(nodes, id, byParent)) {
        this.#untouched.add(id);
      }
    }
  }

  /**
   * The current document as JSON: `schema`, `written_at`, `written_by`,
   * `seen` and `nodes`. The engine keeps its type graph to itself and hands a
   * host JSON to parse (host contract §10).
   */
  async tree() {
    return this.#enqueue(() => {
      try {
        return this.#doc.toJson();
      } catch (err) {
        throw new SvalError(`sval: ${describe(err)}`, err);
      }
    });
  }

  /**
   * Plaintext export, independent of the encrypted sync path (spec §6.8).
   *
   * @param {string} [documentName] A registered extra document; the tree
   *   when absent.
   */
  async exportJson(documentName) {
    return this.#enqueue(() => {
      const doc =
        documentName === undefined ? this.#doc : this.#registered(documentName);
      try {
        return doc.exportJson();
      } catch (err) {
        throw new SvalError(`sval: ${describe(err)}`, err);
      }
    });
  }

  /**
   * Every favorite, folder and separator in document `documentName`, as the
   * engine's `favorites()` lists them (host contract §10).
   *
   * @param {string} documentName The document name.
   * @returns {Promise<object[]>}
   */
  async favorites(documentName) {
    return this.#enqueue(() => {
      const doc = this.#registered(documentName);
      try {
        return JSON.parse(doc.favorites());
      } catch (err) {
        throw new SvalError(`sval: ${describe(err)}`, err);
      }
    });
  }

  /**
   * Every visit in document `documentName`, oldest first, as the engine's
   * `visits()` lists them (host contract §10).
   *
   * @param {string} documentName The document name.
   * @returns {Promise<object[]>}
   */
  async visits(documentName) {
    return this.#enqueue(() => {
      const doc = this.#registered(documentName);
      try {
        return JSON.parse(doc.visits());
      } catch (err) {
        throw new SvalError(`sval: ${describe(err)}`, err);
      }
    });
  }

  /**
   * Every week the history index in `documentName` lists, newest first, as
   * `{ name, changedAt }` (host contract §10).
   *
   * @param {string} documentName The document name.
   * @returns {Promise<object[]>}
   */
  async shards(documentName) {
    return this.#enqueue(() => {
      const doc = this.#registered(documentName);
      try {
        return JSON.parse(doc.shards());
      } catch (err) {
        throw new SvalError(`sval: ${describe(err)}`, err);
      }
    });
  }

  /**
   * Every entry in the Archive document `documentName`, newest first, as the
   * engine's `archived` lists them (host contract §10, "The Archive").
   *
   * @param {string} documentName The Archive's document name.
   * @param {number} now Milliseconds since the epoch.
   * @returns {Promise<object[]>}
   */
  async archived(documentName, now) {
    return this.#enqueue(() => {
      const doc = this.#registered(documentName);
      try {
        return JSON.parse(doc.archived(now));
      } catch (err) {
        throw new SvalError(`sval: ${describe(err)}`, err);
      }
    });
  }

  /**
   * Records that tab `id` was selected (idle-tab archive spec §4.1).
   *
   * @param {string} id A tab's node id.
   * @param {Uint8Array} deviceId This device's 16 bytes.
   * @param {number} now Milliseconds since the epoch.
   * @returns {Promise<boolean>} whether the tree changed: the tab's touch
   *   was an hour old or more.
   */
  async markUsed(id, deviceId, now) {
    return this.#enqueue(() => {
      try {
        return this.#doc.markUsed(id, deviceId, now);
      } catch (err) {
        throw new SvalError(`sval: markUsed failed: ${describe(err)}`, err);
      }
    });
  }

  /**
   * The sweep (idle-tab archive spec §4.2), as one queued step that swaps
   * the tree and the Archive only once the Archive is written (spec §6.3).
   * It runs on copies of both; the Archive's copy is written to this
   * device's own file in the profile; and only then are the copies put in
   * place of the documents this worker holds. A refused sweep or a failed
   * write leaves both as they were. The tree's removals are written by its
   * next pass, so the profile never lacks a tab whose entry it lacks too.
   *
   * @param {object} options
   * @param {string} options.archive The Archive's document name.
   * @param {object} options.sweep `{ default, lastActive, exempt }`.
   * @param {string} options.root Absolute path of the profile's storage.
   * @param {Uint8Array} options.keyBytes The profile's 32-byte key.
   * @param {Uint8Array} options.deviceId This device's 16 bytes.
   * @param {number} options.now Milliseconds since the epoch.
   * @param {number} [options.archiveRetention] As {@link sync} takes it.
   * @returns {Promise<object>} `{ tabs, entries }`, as the engine answers.
   */
  async archiveIdle({ archive, sweep, ...written }) {
    return this.#archiveWith(archive, written, (tree, entries) =>
      tree.archiveIdle(
        entries,
        JSON.stringify(sweep),
        written.deviceId,
        written.now
      )
    );
  }

  /**
   * Archives tab `id` now, with its split when it is a pane (launcher spec
   * §4), as {@link archiveIdle} archives: on copies, swapped in once the
   * Archive is written.
   *
   * @param {object} options
   * @param {string} options.archive The Archive's document name.
   * @param {string} options.id A tab's node id.
   * @param {string} options.root Absolute path of the profile's storage.
   * @param {Uint8Array} options.keyBytes The profile's 32-byte key.
   * @param {Uint8Array} options.deviceId This device's 16 bytes.
   * @param {number} options.now Milliseconds since the epoch.
   * @param {number} [options.archiveRetention] As {@link sync} takes it.
   * @returns {Promise<object>} `{ tabs, entries }`, as the engine answers.
   */
  async archiveNow({ archive, id, ...written }) {
    return this.#archiveWith(archive, written, (tree, entries) =>
      tree.archiveNow(entries, id, written.deviceId, written.now)
    );
  }

  /**
   * Adds an entry to the Archive `archive` for each tab another browser
   * archived (idle-tab archive spec §7.6). It runs on a copy, which is
   * written to this device's file before it takes the Archive's place, as
   * {@link archiveIdle} writes the Archive before anything changes.
   *
   * @param {object} options
   * @param {string} options.archive The Archive's document name.
   * @param {object[]} options.entries `{ tab, title, url, workspace,
   *   workspaceName, closedAt }`, as the engine's `importArchived` takes them.
   * @param {string} options.root Absolute path of the profile's storage.
   * @param {Uint8Array} options.keyBytes The profile's 32-byte key.
   * @param {Uint8Array} options.deviceId This device's 16 bytes.
   * @param {number} options.now Milliseconds since the epoch.
   * @param {number} [options.archiveRetention] As {@link sync} takes it.
   * @returns {Promise<string[]>} the entries' ids.
   */
  async importArchived({ archive, entries, ...written }) {
    const { root, keyBytes, deviceId, now, archiveRetention } = written;
    return this.#enqueue(async () => {
      const held = this.#registered(archive);
      let copy = null;
      try {
        copy = SvalDocument.loadJson(held.toJson());
        const ids = JSON.parse(
          copy.importArchived(JSON.stringify(entries), deviceId, now)
        );
        if (ids.length) {
          await this.#syncOnce({
            root,
            workspace: archive,
            keyBytes,
            deviceId,
            now,
            archiveRetention,
            doc: copy,
          });
          this.#extra.set(archive, copy);
          held.free();
          copy = null;
        }
        return ids;
      } catch (err) {
        throw new SvalError(
          `sval: importing archived tabs failed: ${describe(err)}`,
          err
        );
      } finally {
        copy?.free();
      }
    });
  }

  /**
   * Runs `step` on copies of the tree and the Archive `archive`, writes the
   * Archive's copy to this device's file when the step archived anything,
   * and only then puts both copies in place.
   *
   * @param {string} archive The Archive's document name.
   * @param {object} written `{ root, keyBytes, deviceId, now,
   *   archiveRetention }`, as {@link archiveIdle} takes them.
   * @param {(tree: object, entries: object) => string} step Answers the
   *   engine's `{ tabs, entries }` as JSON.
   * @returns {Promise<object>} `{ tabs, entries }`.
   */
  async #archiveWith(archive, written, step) {
    const { root, keyBytes, deviceId, now, archiveRetention } = written;
    return this.#enqueue(async () => {
      const held = this.#registered(archive);
      let tree = null;
      let entries = null;
      try {
        tree = SvalDocument.loadJson(this.#doc.toJson());
        entries = SvalDocument.loadJson(held.toJson());
        const swept = JSON.parse(step(tree, entries));
        if (swept.tabs.length) {
          await this.#syncOnce({
            root,
            workspace: archive,
            keyBytes,
            deviceId,
            now,
            archiveRetention,
            doc: entries,
          });
          this.#doc.free();
          this.#doc = tree;
          this.#extra.set(archive, entries);
          held.free();
          tree = entries = null;
        }
        return swept;
      } catch (err) {
        throw new SvalError(`sval: archiving failed: ${describe(err)}`, err);
      } finally {
        tree?.free();
        entries?.free();
      }
    });
  }

  /**
   * Restores Archive entry `entry` into the tree (idle-tab archive spec
   * §2): both documents change, or neither. Their passes write them, in
   * either order (spec §6.3).
   *
   * @param {object} options
   * @param {string} options.archive The Archive's document name.
   * @param {string} options.entry The entry's id.
   * @param {string} options.current The workspace it goes to when its own
   *   is gone.
   * @param {string[]} options.ids The new nodes' ids, as many as the entry's
   *   `restoreIds`.
   * @param {Uint8Array} options.deviceId This device's 16 bytes.
   * @param {number} options.now Milliseconds since the epoch.
   * @returns {Promise<object>} `{ tabs, split, workspace }`.
   */
  async restore({ archive, entry, current, ids, deviceId, now }) {
    return this.#enqueue(() => {
      const held = this.#registered(archive);
      try {
        return JSON.parse(
          this.#doc.restore(held, entry, current, ids, deviceId, now)
        );
      } catch (err) {
        throw new SvalError(`sval: the restore failed: ${describe(err)}`, err);
      }
    });
  }

  /**
   * The node id of the visit device `deviceId` made to `url` at `visitedAt`
   * (host contract §10).
   *
   * @param {Uint8Array} deviceId The device's 16 bytes.
   * @param {string} url
   * @param {number} visitedAt Milliseconds since the epoch.
   * @returns {Promise<string>}
   */
  async visitId(deviceId, url, visitedAt) {
    await this.#ensureReady();
    try {
      return visitId(deviceId, url, visitedAt);
    } catch (err) {
      throw new SvalError(`sval: ${describe(err)}`, err);
    }
  }

  /**
   * The node id of the favorite whose Places guid is `guid` (host contract
   * §10). The engine derives it, so every platform agrees.
   *
   * @param {string} guid A Places guid.
   * @returns {Promise<string>}
   */
  async favoriteId(guid) {
    await this.#ensureReady();
    try {
      return favoriteId(guid);
    } catch (err) {
      throw new SvalError(`sval: ${describe(err)}`, err);
    }
  }

  /**
   * The node id of setting `key` (host contract §10), so a host can match a
   * node a pass reports to the setting it holds.
   *
   * @param {string} key A setting's key.
   * @returns {Promise<string>}
   */
  async settingId(key) {
    await this.#ensureReady();
    return settingId(key);
  }

  /**
   * Applies one local change. Ids and timestamps are minted here because the
   * engine mints neither (host contract §3); the new node's id is returned so
   * the caller can address it without reading the tree back.
   *
   * @param {object} op
   * @param {string} op.kind The operation, as `applyOp` names it.
   * @param {string} [op.document] An extra document's name; the tree when
   *   absent.
   * @param {Uint8Array} op.deviceId This device's 16 bytes, stamped into
   *   whichever fact group the change touches.
   * @returns {Promise<string|null>} the affected node's id.
   */
  async mutate(op) {
    return this.#enqueue(() => this.#mutateOnce(op));
  }

  #mutateOnce(op) {
    const doc =
      op.document === undefined ? this.#doc : this.#registered(op.document);
    try {
      return applyOp(doc, op, {
        id: op.id ?? crypto.randomUUID(),
        now: op.now ?? Date.now(),
      });
    } catch (err) {
      if (err?.unknownOperation) {
        throw new SvalError(err.message);
      }
      throw new SvalError(`sval: ${op.kind} failed: ${describe(err)}`, err);
    }
  }

  /**
   * The engine code the module was built from, once it is loaded.
   *
   * @returns {Promise<string>} As {@link engineVersion} answers.
   */
  async engineVersion() {
    await this.#ensureReady();
    return engineVersion();
  }

  /**
   * A fresh pairing code (spec §6.7).
   *
   * @returns {Promise<string>} A 14-character grouped code.
   */
  async generatePairingCode() {
    await this.#ensureReady();
    try {
      return generatePairingCode();
    } catch (err) {
      throw new SvalError(`sval: ${describe(err)}`, err);
    }
  }

  /**
   * Seals a document key under a pairing code, for `SvalPairing.offer` to
   * write into the shared folder.
   *
   * @param {object} options
   * @param {Uint8Array} options.keyBytes The 32-byte document key.
   * @param {string} options.code The code the seal opens under.
   * @param {number} options.now Milliseconds since the epoch.
   * @param {number} options.ttlMs How long the seal stays open.
   * @returns {Promise<Uint8Array>} The sealed file's bytes.
   */
  async sealPairing({ keyBytes, code, now, ttlMs }) {
    await this.#ensureReady();
    try {
      return sealPairing(keyBytes, code, now, ttlMs);
    } catch (err) {
      throw new SvalError(`sval: ${describe(err)}`, err);
    }
  }

  /**
   * Recovers the key a pairing file sealed, or rejects with code
   * `bad_pairing_code` for a wrong code and `malformed_pairing_file` for bytes
   * that are not a pairing file (`sval_core.mjs`'s `openPairing`).
   * `SvalPairing.claim` relies on both to tell "try the next candidate file"
   * from nothing left to try.
   *
   * @param {object} options
   * @param {Uint8Array} options.bytes The sealed file's bytes.
   * @param {string} options.code The code to try.
   * @returns {Promise<Uint8Array>} The 32-byte document key.
   */
  async openPairing({ bytes, code }) {
    await this.#ensureReady();
    try {
      return openPairing(bytes, code);
    } catch (err) {
      throw new SvalError(`sval: ${describe(err)}`, err);
    }
  }

  /**
   * A pairing file's expiry, without needing the code.
   *
   * @param {object} options
   * @param {Uint8Array} options.bytes The sealed file's bytes.
   * @returns {Promise<number>} Milliseconds since the epoch.
   */
  async pairingExpiresAt({ bytes }) {
    await this.#ensureReady();
    try {
      return pairingExpiresAt(bytes);
    } catch (err) {
      throw new SvalError(`sval: ${describe(err)}`, err);
    }
  }

  #connectToPromiseWorker() {
    serve(method =>
      typeof this[method] === "function"
        ? (...args) => this[method](...args)
        : undefined
    );
  }
}

new SvalSyncWorker();
