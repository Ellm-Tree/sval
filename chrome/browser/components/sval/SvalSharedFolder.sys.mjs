/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The browser's only way to the shared folder (local-copy spec §3, §4.2).
 *
 * Firefox runs every `IOUtils` call in a process through one serial queue
 * (`xpcom/ioutils/IOUtils.cpp`, `IOUtils::EventQueue`), so one read stuck on
 * a hung network mount would stall every file operation in the browser. The
 * shared folder is therefore read and written by `sval-folder`, a program
 * beside the browser binary (decision 1437). This module starts it through
 * `Subprocess`, whose worker reads its pipes without blocking, talks to it in
 * frames over its stdin and stdout, and stops waiting at each request's
 * deadline. Nothing here calls `IOUtils` on a path in the shared folder.
 *
 * One helper serves the browser run, from the first shared request until its
 * stdin closes: when the user clears the shared folder (`release`), or when
 * the browser exits for any reason. A request made while another runs waits
 * its turn, in order, and the wait counts against its own deadline: a request
 * whose deadline passes before its turn answers "busy" (the request ahead of
 * it is stuck), and one that runs past it has the helper killed, its pipes
 * closed and the helper abandoned, and answers "timeout". The next request
 * starts a fresh helper once that one has gone, so there is never more than
 * one (decision 0033).
 *
 * File contents travel through one directory in the profile (`requestDir`):
 * a write's bytes as payload files, and every file a listing reads as the
 * helper's raw copy under `files-<id>/`. There is one helper at a time and
 * the profile's lock gives one browser to a profile, so the directory is
 * emptied whenever a helper starts, and each request's files are removed when
 * it ends, before it answers.
 */

import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import {
  SvalLog,
  describeError,
} from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { SvalSerialQueue } from "moz-src:///browser/components/sval/SvalSerialQueue.sys.mjs";
import {
  MAX_FRAME_BYTES,
  encodeFrame,
} from "moz-src:///browser/components/sval/SvalAgentWire.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  SvalRemoteFolder:
    "moz-src:///browser/components/sval/SvalRemoteFolder.sys.mjs",
});

/** How long one shared step may take before Sval stops waiting for it. */
export const SHARED_STEP_TIMEOUT_MS = 20000;

/**
 * The helper's limits (`tools/sval-folder/src/ops.rs`), which the browser
 * batches its requests by and its tests measure against. The helper enforces
 * them; these must match its constants.
 */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_ENTRIES = 1000;
export const MAX_STEP_BYTES = 256 * 1024 * 1024;
export const MAX_BATCH = 64;

/**
 * The protocol this browser speaks with its helper, the handshake's `hello`.
 * A helper that speaks it or the one before is accepted, whatever its build:
 * a Linux package upgrade replaces the helper under a running browser. Bump
 * it only for a change an older helper cannot speak, on both sides at once
 * (`HELLO` in `tools/sval-folder/src/serve.rs`).
 */
export const HELPER_HELLO = 2;

/**
 * Whether a helper whose handshake says `hello` speaks this browser's
 * protocol: the same version or the one before.
 *
 * @param {*} hello
 * @returns {boolean}
 */
export function isCompatibleHello(hello) {
  return (
    Number.isSafeInteger(hello) &&
    hello <= HELPER_HELLO &&
    hello >= HELPER_HELLO - 1
  );
}

/**
 * The environment variables a helper inherits. It needs none of them to do
 * its work; they are the ones the operating system's file clients may read.
 */
const PASSED_ENV = [
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "USER",
  "LOGNAME",
  "LANG",
  "PATH",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
];

/** What a helper may say when the folder is not reachable. */
const REASONS = new Set([
  "missing",
  "not-a-directory",
  "no-sval-dir",
  "own-file-unreadable",
  "too-large",
  "io-error",
  "helper-failed",
]);

/**
 * What a user can do about a shared folder that is not reachable, from the
 * helper's reason and the error name it reported. Among I/O errors only a
 * denied access, and a remote folder's refused sign-in
 * (`RemoteError::name` in `tools/sval-folder/src/remote/mod.rs`), are told
 * apart: every other one is "offline".
 *
 * @param {string} reason A helper's reason.
 * @param {string} [error] The error name the helper reported, if any.
 * @returns {"offline"|"gone"|"denied"|"sign-in"|"own-file"|"too-large"}
 */
export function folderProblem(reason, error) {
  switch (reason) {
    case "missing":
    case "not-a-directory":
    case "no-sval-dir":
      return "gone";
    case "io-error":
      if (error === "NotAllowedError") {
        return "denied";
      }
      return error === "SignInError" ? "sign-in" : "offline";
    case "own-file-unreadable":
      return "own-file";
    case "too-large":
      return "too-large";
    default:
      return "offline";
  }
}

/** What a request answers when its turn did not come before its deadline. */
const BUSY = Object.freeze({ reachable: false, reason: "busy" });

/**
 * What a request answers when the helper failed it.
 *
 * @param {string} [error] The error name the answer carries.
 * @returns {object}
 */
function helperFailed(error) {
  return error
    ? { reachable: false, reason: "helper-failed", error }
    : { reachable: false, reason: "helper-failed" };
}

/**
 * The live helper: `{ proc, exited, alive, killed, released, ready }`,
 * `exited` resolving with its exit code once it has gone; or null when none
 * was started since the last one went.
 */
let helper = null;

/**
 * Set once a helper answered the handshake with a protocol this browser
 * does not speak: every later request fails until Sval restarts, since the
 * helper beside the binary will not change while it runs.
 */
let outdated = false;

/** Set once a missing helper has been logged, so it is logged once a run. */
let missingLogged = false;

/** The requests' turns at the helper, one at a time, in order. */
const turns = new SvalSerialQueue("shared-folder helper");

/** How many requests are queued or running. */
let pending = 0;

/** Ends each request still waiting for its turn, answering "busy". */
const waiting = new Set();

/** Set when the browser is quitting: no helper starts after that. */
let quitting = false;

/** Resolves when the browser starts quitting. */
const quit = Promise.withResolvers();

let watchingQuit = false;

/**
 * The directory every request of a profile travels through. It is in the
 * profile, which only one browser holds at a time, so no other browser's
 * request reaches it; the helper, a process of the same user, reads and
 * writes it there.
 *
 * @param {string} [profile] The profile directory; this browser's by default.
 * @returns {string}
 */
export function requestDir(profile = PathUtils.profileDir) {
  return PathUtils.join(profile, "sval-shared-request");
}

/**
 * Where the helper is: beside the running executable, where the package
 * manifest puts it (`patches/package-sval-folder.patch`).
 *
 * @returns {string}
 */
export function helperPath() {
  const file = Services.dirsvc.get("XREExeF", Ci.nsIFile).parent;
  file.append(
    AppConstants.platform == "win" ? "sval-folder.exe" : "sval-folder"
  );
  return file.path;
}

function environment() {
  const env = {};
  for (const name of PASSED_ENV) {
    if (Services.env.exists(name)) {
      env[name] = Services.env.get(name);
    }
  }
  return env;
}

/**
 * Reads a pipe to its end, so a chatty helper never blocks on a full one.
 *
 * @param {object} pipe A `Subprocess` output pipe.
 */
async function drain(pipe) {
  try {
    while ((await pipe.readString()).length) {
      // Discarded: the helper writes nothing Sval reads on stderr.
    }
  } catch {
    // The pipe closed with the process.
  }
}

/**
 * The next frame on `pipe`: a 4-byte big-endian length, then UTF-8 JSON
 * (`tools/sval-folder/src/frame.rs`), refused over `MAX_FRAME_BYTES`.
 *
 * @param {object} pipe A `Subprocess` output pipe.
 * @returns {Promise<object>} It rejects when the pipe ends first, or on a
 *   frame that is too large or not JSON.
 */
async function readFrame(pipe) {
  const length = new DataView(await pipe.read(4)).getUint32(0);
  if (!length || length > MAX_FRAME_BYTES) {
    throw new Error(`a helper frame of ${length} bytes`);
  }
  return JSON.parse(new TextDecoder().decode(await pipe.read(length)));
}

function watchQuit() {
  if (watchingQuit) {
    return;
  }
  watchingQuit = true;
  Services.obs.addObserver(() => {
    quitting = true;
    quit.resolve();
    SvalSharedFolder.killLive();
    for (const end of waiting) {
      end();
    }
  }, "quit-application");
}

/**
 * Removes a request's files as it ends. What a failure leaves, the next
 * helper's start removes, so it is logged rather than raised.
 *
 * @param {string[]} files The request's files and directories.
 */
async function removeRequestFiles(files) {
  for (const path of files) {
    try {
      await IOUtils.remove(path, { recursive: true, ignoreAbsent: true });
    } catch (err) {
      SvalLog.debug(
        `a shared-folder request file was not removed: ${SvalLog.errorName(err)}`
      );
    }
  }
}

/** A copy's name in the request directory: a decimal number. */
const COPY_NAME = /^(0|[1-9][0-9]*)$/;

/**
 * Whether each of `entries` names a file and its copy. An entry without a
 * usable name or copy fails the answer: left out, this device's own file
 * would read as absent.
 *
 * @param {*} entries
 * @returns {boolean}
 */
function usableEntries(entries) {
  return (
    Array.isArray(entries) &&
    entries.every(
      entry =>
        typeof entry?.name === "string" &&
        typeof entry.copy === "string" &&
        COPY_NAME.test(entry.copy)
    )
  );
}

export const SvalSharedFolder = {
  /**
   * How long the helper may spend on one request before it ends itself, or
   * null for its own limit (`HARD_EXIT_MS` in the helper). A test shortens
   * it; the helper never takes a longer one.
   */
  _helperExitAfterMs: null,

  /**
   * What starts a helper: `(dir) => ({ command, arguments })`, or null for
   * the helper beside the binary. A test replaces it with a stand-in.
   */
  _helperCommand: null,

  /** The live helper's process, or null: for a test to end a stand-in. */
  get _helperProcess() {
    return helper?.alive ? helper.proc : null;
  },

  /**
   * Whether a request is queued or running, or a helper Sval has killed or
   * released is still alive. A live helper waiting for its next request is
   * not.
   */
  get busy() {
    return (
      pending > 0 || !!((helper?.killed || helper?.released) && helper.alive)
    );
  },

  /**
   * Stops `proc` at once, without waiting for it to go. `kill(0)` is SIGKILL
   * on Unix and an immediate terminate on Windows; the promise it returns
   * settles only when the process is reaped, which a process stuck in the
   * kernel never is, so it is never awaited. A test replaces this.
   *
   * @param {object} proc A `Subprocess` process.
   */
  _kill(proc) {
    proc.kill(0).catch(() => {});
  },

  /**
   * Kills the live helper, if there is one, without waiting, and closes the
   * browser's ends of its pipes, so nothing here waits on it again.
   */
  killLive() {
    if (helper?.alive && !helper.killed) {
      SvalLog.debug("killing a live shared-folder helper");
      helper.killed = true;
      this._kill(helper.proc);
      helper.proc.stdin.close(true).catch(() => {});
      helper.proc.stdout.close(true).catch(() => {});
    }
  },

  /**
   * Lets the live helper go once the requests already queued have run: its
   * stdin closes, and it exits. The next request starts another. Called when
   * the user clears the shared folder, so no helper lives on for a folder
   * that is not used.
   *
   * @returns {Promise} Resolves once the helper has been told.
   */
  release() {
    return turns.run(async () => {
      if (helper?.alive && !helper.killed && !helper.released) {
        helper.released = true;
        await helper.proc.stdin.close().catch(() => {});
      }
    });
  },

  /**
   * Resolves once nothing is `busy`. A live helper waiting for its next
   * request may still be alive.
   */
  async _whenIdle() {
    await turns.idle();
    if (helper?.killed || helper?.released) {
      await helper.exited;
    }
  },

  /**
   * Reads every file in one directory, each as base64 in the answer: for
   * directories of small files. The browser reads the helper's copies of them
   * on the main thread, so `maxBytes` bounds each file to the size its format
   * has, and a folder writer cannot make that read large; `readDirs` hands a
   * document's files to the worker instead.
   *
   * @param {object} request
   * @param {string} request.root The folder.
   * @param {string} request.path The directory, relative to `root`.
   * @param {string|null} request.suffix Only names ending in this are read.
   * @param {string|null} request.mine This device's own file name.
   * @param {number} [request.maxBytes] The most one file may hold;
   *   `MAX_FILE_BYTES` when absent.
   * @param {string|null} request.requireTop A directory below `root` that
   *   must exist for the folder to count as mounted, or null.
   * @param {number} request.deadline When the helper must have answered.
   * @returns {Promise<object>}
   */
  readDir({ root, path, suffix, mine, maxBytes, requireTop, deadline }) {
    return this._run(
      { op: "readDir", root, path, suffix, mine, maxBytes, requireTop },
      deadline
    );
  },

  writeFile({ root, path, bytes, requireTop, deadline }) {
    return this._run({ op: "write", root, path, requireTop }, deadline, {
      payload: bytes,
    });
  },

  /**
   * Reads every directory in `dirs` in one request, as `readDir` reads one,
   * and hands the answer to `consume` while the files it read are still on
   * this machine: each entry names its copy in `file`, raw, so a worker can
   * read it. They are removed once `consume` settles.
   *
   * @param {object} request
   * @param {string} request.root The folder.
   * @param {object[]} request.dirs `{ path, suffix, mine }` each, as
   *   `readDir` takes them.
   * @param {string|null} request.requireTop As `readDir` takes it.
   * @param {number} request.deadline When the helper must have answered.
   * @param {Function} request.consume `(answer) => Promise`, given `{
   *   reachable: true, dirs: [{ entries: [{ name, file }], unreadable }],
   *   first }`: `dirs` holds `request.dirs` from the `first`th on, in order.
   *   A request takes at most `MAX_BATCH` directories, so more are read in
   *   one request per batch, and `consume` hears each batch.
   * @returns {Promise<*>} what the last `consume` resolved to, or the first
   *   unreachable answer, whose `dir`, when the helper gave one, is the index
   *   in `dirs` of the directory that failed.
   */
  async readDirs({ root, dirs, requireTop, deadline, consume }) {
    let answer = { reachable: true };
    for (
      let first = 0;
      first === 0 || first < dirs.length;
      first += MAX_BATCH
    ) {
      answer = await this._run(
        {
          op: "readDirs",
          root,
          dirs: dirs.slice(first, first + MAX_BATCH),
          requireTop,
        },
        deadline,
        { consume: read => consume({ ...read, first }) }
      );
      if (!answer.reachable) {
        return answer.dir === undefined
          ? answer
          : { ...answer, dir: answer.dir + first };
      }
    }
    return answer;
  },

  /**
   * Writes every file in `files` in one request per `MAX_BATCH` of them, as
   * `writeFile` writes one, in order, stopping at the first that fails.
   *
   * @param {object} request
   * @param {string} request.root The folder.
   * @param {object[]} request.files `{ path, bytes }` each.
   * @param {string|null} request.requireTop As `writeFile` takes it.
   * @param {number} request.deadline When the helper must have answered.
   * @returns {Promise<object>} `{ reachable: true }`, or the helper's
   *   unreachable answer.
   */
  async writeFiles({ root, files, requireTop, deadline }) {
    for (let first = 0; first < files.length; first += MAX_BATCH) {
      const batch = files.slice(first, first + MAX_BATCH);
      const answer = await this._run(
        {
          op: "writeFiles",
          root,
          files: batch.map(({ path }) => ({ path })),
          requireTop,
        },
        deadline,
        { payloads: batch.map(({ bytes }) => bytes) }
      );
      if (!answer.reachable) {
        return answer;
      }
    }
    return { reachable: true };
  },

  /**
   * Renames the file at `from` to `to`, in the folder. Nothing at `to` is
   * replaced: an entry there refuses the move, as does a link or a directory
   * at either end.
   *
   * @param {object} request
   * @param {string} request.root The folder.
   * @param {string} request.from Relative to `root`.
   * @param {string} request.to Relative to `root`.
   * @param {string|null} request.requireTop As `writeFile` takes it.
   * @param {number} request.deadline When the helper must have answered.
   * @returns {Promise<object>} `{ reachable: true }`, or the helper's
   *   unreachable answer.
   */
  moveFile({ root, from, to, requireTop, deadline }) {
    return this._run({ op: "move", root, from, to, requireTop }, deadline);
  },

  /**
   * Removes the file `path` under `root`.
   *
   * @param {object} request
   * @param {string} request.root The folder.
   * @param {string} request.path Relative to `root`.
   * @param {string|null} [request.requireTop] As `writeFile` takes it.
   *   Without it, a folder whose mount is gone answers as an empty one.
   * @param {number} request.deadline When the helper must have answered.
   * @returns {Promise<object>} `{ reachable: true }`, or the helper's
   *   unreachable answer.
   */
  remove({ root, path, requireTop = null, deadline }) {
    return this._run({ op: "remove", root, path, requireTop }, deadline);
  },

  /**
   * Whether `path` exists under `root`.
   *
   * @param {object} request
   * @param {string} request.root The folder.
   * @param {string} request.path Relative to `root`.
   * @param {string|null} [request.requireTop] As `writeFile` takes it.
   *   Without it, a folder whose mount is gone answers that nothing exists.
   * @param {number} request.deadline When the helper must have answered.
   * @returns {Promise<object>} `{ reachable: true, exists }`, or the
   *   helper's unreachable answer.
   */
  exists({ root, path, requireTop = null, deadline }) {
    return this._run({ op: "exists", root, path, requireTop }, deadline);
  },

  /**
   * Removes `path`, a directory under `root`, and everything in it.
   *
   * @param {object} request
   * @param {string} request.root The folder.
   * @param {string} request.path Relative to `root`.
   * @param {number} request.deadline When the helper must have answered.
   * @returns {Promise<object>} `{ reachable: true }`, or the helper's
   *   unreachable answer.
   */
  removeDir({ root, path, deadline }) {
    return this._run(
      { op: "removeDir", root, path, requireTop: null },
      deadline
    );
  },

  /**
   * The names in `path`, a directory under `root`, without reading any of
   * them. An absent directory has none.
   *
   * @param {object} request
   * @param {string} request.root The folder.
   * @param {string} request.path Relative to `root`.
   * @param {string|null} [request.holding] A file name: the answer also says
   *   which of the directories listed hold an entry by that name.
   * @param {number} request.deadline When the helper must have answered.
   * @returns {Promise<object>} `{ reachable: true, names, holding }`, `holding`
   *   only when asked, or the helper's unreachable answer.
   */
  listNames({ root, path, holding = null, deadline }) {
    return this._run(
      { op: "listNames", root, path, holding, requireTop: null },
      deadline
    );
  },

  /**
   * The folders in `root` itself, for choosing one inside a remote folder
   * before it is the one in use.
   *
   * @param {object} request
   * @param {string} request.root The folder to list.
   * @param {object} request.auth The sign-in for it (`SvalRemoteFolder`).
   * @param {number} request.deadline When the helper must have answered.
   * @returns {Promise<object>} `{ reachable: true, folders }`, or the
   *   helper's unreachable answer.
   */
  listFolders({ root, auth, deadline }) {
    return this._run(
      { op: "listFolders", root, auth, requireTop: null },
      deadline
    );
  },

  /**
   * Makes `path`, a directory under `root`. `root` itself is never made: a
   * folder that is not there answers "missing".
   *
   * @param {object} request
   * @param {string} request.root The folder.
   * @param {string} request.path Relative to `root`.
   * @param {number} request.deadline When the helper must have answered.
   * @returns {Promise<object>} `{ reachable: true }`, or the helper's
   *   unreachable answer.
   */
  makeDir({ root, path, deadline }) {
    return this._run({ op: "makeDir", root, path, requireTop: null }, deadline);
  },

  /**
   * Queues a request for its turn at the helper.
   *
   * @param {object} request What the helper is asked to do.
   * @param {number} deadline When Sval stops waiting, in `Date.now()` ms.
   * @param {object} [extra]
   * @param {Uint8Array} [extra.payload] The bytes for a write.
   * @param {Uint8Array[]} [extra.payloads] The bytes for each file of a
   *   `writeFiles`.
   * @param {Function} [extra.consume] Takes a reachable answer, and what it
   *   resolves to is the request's; run within the turn, before the request
   *   directory goes.
   * @returns {Promise<object>}
   */
  _run(request, deadline, extra = {}) {
    if (quitting) {
      return Promise.resolve(BUSY);
    }
    watchQuit();
    const answer = Promise.withResolvers();
    const giveUp = () => {
      waiting.delete(giveUp);
      clearTimeout(timer);
      answer.resolve(BUSY);
    };
    const timer = setTimeout(giveUp, Math.max(0, deadline - Date.now()));
    waiting.add(giveUp);
    pending++;
    turns.post(async () => {
      try {
        if (!waiting.has(giveUp)) {
          return;
        }
        waiting.delete(giveUp);
        clearTimeout(timer);
        await this._turn(request, deadline, extra, answer);
      } finally {
        pending--;
      }
    });
    return answer.promise;
  },

  /**
   * One request's turn: asks the helper, and answers through `answer` once
   * the request's files are removed.
   *
   * @param {object} request What the helper is asked to do.
   * @param {number} deadline When Sval stops waiting, in `Date.now()` ms.
   * @param {object} extra As `_run` takes it.
   * @param {object} answer `{ resolve, reject }` for the request's answer.
   */
  async _turn(request, deadline, extra, answer) {
    const asked = { files: [] };
    let result;
    try {
      // A remote folder's sign-in travels with each request, so a helper
      // started afresh needs nothing kept by the one before
      // (`SvalRemoteFolder`).
      // A request that names its own, for a folder not yet chosen, keeps it.
      if (lazy.SvalRemoteFolder.isRemoteRoot(request.root) && !request.auth) {
        const auth = await lazy.SvalRemoteFolder.authFor(request.root);
        request = { ...request, auth: auth ?? {} };
      }
      result = await this._ask(asked, request, deadline, extra);
    } catch (err) {
      SvalLog.warn(
        `a shared-folder helper could not run: ${describeError(err)}`
      );
      result = { reachable: false, reason: "helper-failed" };
    }
    let failed = null;
    if (extra.consume && result.reachable) {
      try {
        result = await extra.consume(result);
      } catch (err) {
        failed = err;
      }
    }
    await removeRequestFiles(asked.files);
    if (failed) {
      answer.reject(failed);
    } else {
      answer.resolve(result);
    }
  },

  /**
   * A live helper that has said hello, starting one on an emptied request
   * directory if none is. One that was killed, released or exited is waited
   * for first, so there is never more than one.
   *
   * @param {number} deadline When the request stops waiting, in `Date.now()`
   *   ms.
   * @returns {Promise<object>} `{ live }`, or `{ answer }` for the request
   *   when no helper could be had.
   */
  async _liveHelper(deadline) {
    if (helper?.alive && helper.ready && !helper.killed && !helper.released) {
      return { live: helper };
    }
    if (helper) {
      let timer;
      const gone = await Promise.race([
        helper.exited.then(() => true),
        new Promise(resolve => {
          timer = setTimeout(
            () => resolve(false),
            Math.max(0, deadline - Date.now())
          );
        }),
        quit.promise.then(() => false),
      ]);
      clearTimeout(timer);
      if (!gone) {
        // The helper ahead of it is stuck.
        return { answer: BUSY };
      }
      helper = null;
    }
    const dir = requestDir();
    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
    await IOUtils.makeDirectory(dir, { permissions: 0o700 });
    const { command, arguments: args } = this._helperCommand?.(dir) ?? {
      command: helperPath(),
      arguments: [dir],
    };
    if (!(await IOUtils.exists(command))) {
      if (!missingLogged) {
        missingLogged = true;
        SvalLog.warn(
          "the shared-folder helper is not beside the browser binary, so the shared folder is unreachable"
        );
      }
      return { answer: helperFailed("HelperMissing") };
    }
    const started = await this._start(command, args);
    const said = await this._exchange(
      started,
      {
        hello: HELPER_HELLO,
        build: Services.appinfo.appBuildID,
        exitAfterMs: this._helperExitAfterMs,
      },
      deadline
    );
    if (said.answer) {
      return said;
    }
    const { hello, build } = said.frame;
    if (!isCompatibleHello(hello)) {
      outdated = true;
      SvalLog.warn(
        `the shared-folder helper speaks protocol ${Number.isSafeInteger(hello) ? hello : "none"} (build ${typeof build == "string" ? build : "unknown"}), and this browser ${HELPER_HELLO}: shared-folder requests fail until Sval restarts`
      );
      started.released = true;
      started.proc.stdin.close().catch(() => {});
      return { answer: helperFailed("HelperOutdated") };
    }
    started.ready = true;
    return { live: started };
  },

  /**
   * Starts a helper.
   *
   * @param {string} command The program.
   * @param {string[]} args Its arguments.
   * @returns {Promise<object>} `helper`.
   */
  async _start(command, args) {
    const proc = await lazy.Subprocess.call({
      command,
      arguments: args,
      environment: environment(),
      stderr: "pipe",
    });
    const started = {
      proc,
      exited: null,
      alive: true,
      killed: false,
      released: false,
      ready: false,
    };
    started.exited = proc.wait().then(
      ({ exitCode }) => {
        started.alive = false;
        return exitCode;
      },
      () => {
        started.alive = false;
        return -1;
      }
    );
    drain(proc.stderr);
    helper = started;
    return started;
  },

  /**
   * Sends `message` to `live` and waits for its next frame, its exit, the
   * deadline or the browser quitting. A deadline that passes kills the
   * helper and abandons it.
   *
   * @param {object} live The helper.
   * @param {object} message What to send.
   * @param {number} deadline When Sval stops waiting, in `Date.now()` ms.
   * @returns {Promise<object>} `{ frame }`, or `{ answer }` for the request.
   */
  async _exchange(live, message, deadline) {
    let timer;
    const outcome = await Promise.race([
      live.proc.stdin
        .write(encodeFrame(message))
        .then(() => readFrame(live.proc.stdout))
        .then(
          frame => ({ frame }),
          err => ({ broken: err })
        ),
      live.exited.then(code => ({ exited: code })),
      new Promise(resolve => {
        timer = setTimeout(
          () => resolve({ timeout: true }),
          Math.max(0, deadline - Date.now())
        );
      }),
      quit.promise.then(() => ({ quit: true })),
    ]);
    clearTimeout(timer);
    if (outcome.frame) {
      return outcome;
    }
    if (outcome.quit) {
      return { answer: BUSY };
    }
    if (outcome.timeout) {
      SvalLog.debug("a shared-folder request overran its deadline");
      this.killLive();
      return { answer: { reachable: false, reason: "timeout" } };
    }
    if (outcome.broken) {
      SvalLog.debug(
        `a shared-folder helper's pipe failed: ${describeError(outcome.broken)}`
      );
    } else {
      SvalLog.debug(`a shared-folder helper exited with ${outcome.exited}`);
    }
    this.killLive();
    return { answer: helperFailed() };
  },

  /**
   * Hands the request to the helper and waits for its answer, its deadline
   * or the browser quitting.
   *
   * @param {object} asked `{ files }`: the request's files, as they are made,
   *   for `_turn` to remove.
   * @param {object} request What the helper is asked to do.
   * @param {number} deadline When Sval stops waiting, in `Date.now()` ms.
   * @param {object} extra As `_run` takes it.
   * @param {Uint8Array} [extra.payload] As `_run` takes it.
   * @param {Uint8Array[]} [extra.payloads] As `_run` takes it.
   * @returns {Promise<object>}
   */
  async _ask(asked, request, deadline, { payload, payloads }) {
    if (deadline - Date.now() <= 0) {
      return { reachable: false, reason: "timeout" };
    }
    if (quitting) {
      return BUSY;
    }
    if (outdated) {
      return helperFailed("HelperOutdated");
    }
    const got = await this._liveHelper(deadline);
    if (got.answer) {
      return got.answer;
    }
    const dir = requestDir();
    const id = crypto.randomUUID();
    // A directory on this machine: the payloads and the copies travel
    // through it, so the browser's own `IOUtils` calls never touch the
    // shared folder.
    const bytes = payload ? [payload] : (payloads ?? []);
    const names = bytes.map((_, index) => `payload-${id}-${index}.bin`);
    for (const [index, name] of names.entries()) {
      const path = PathUtils.join(dir, name);
      asked.files.push(path);
      await this._writePayload(path, bytes[index]);
    }
    const files = PathUtils.join(dir, `files-${id}`);
    asked.files.push(files);
    const said = await this._exchange(
      got.live,
      { ...request, id, payloads: names },
      deadline
    );
    if (said.answer) {
      return said.answer;
    }
    return this._answerOf(said.frame, id, request, files);
  },

  /**
   * Writes one payload file for the helper. A test replaces it, to hand the
   * helper a payload that never ends.
   *
   * @param {string} path In the request directory.
   * @param {Uint8Array} bytes
   */
  async _writePayload(path, bytes) {
    await IOUtils.write(path, bytes);
  },

  /**
   * Checks a helper's answer before trusting it: only the helper wrote it,
   * and the shared folder's contents shape it.
   *
   * @param {object} frame What the helper answered.
   * @param {string} id The request's id, which its helper answers with.
   * @param {object} request What the helper was asked.
   * @param {string} files Where the helper put its copies.
   * @returns {Promise<object>}
   */
  async _answerOf(frame, id, request, files) {
    const { id: answered, ...response } = frame ?? {};
    if (answered !== id) {
      SvalLog.debug("a shared-folder answer answered another request");
      return helperFailed();
    }
    if (response.reachable === true) {
      if (request.op === "readDirs") {
        return this._withFiles(response, files, request.dirs.length);
      }
      if (request.op === "readDir") {
        return this._withData(response, files);
      }
      return response;
    }
    if (response.reachable !== false || !REASONS.has(response.reason)) {
      return helperFailed();
    }
    // Error names only: the helper never reports a path.
    SvalLog.debug(
      `a shared-folder helper reported ${response.reason}: ${response.error ?? "no error"}`
    );
    const failed = { reachable: false, reason: response.reason };
    if (typeof response.error === "string") {
      failed.error = response.error;
    }
    if (Number.isInteger(response.dir) && response.dir >= 0) {
      failed.dir = response.dir;
    }
    return failed;
  },

  /**
   * A `readDir` answer with each entry's bytes as base64url. The helper names
   * its copies by number, so a name a file in the folder carries is data here
   * and never part of a path.
   *
   * @param {object} response What the helper answered.
   * @param {string} files Where the helper put its copies.
   * @returns {Promise<object>}
   */
  async _withData(response, files) {
    if (!usableEntries(response.entries)) {
      return helperFailed();
    }
    const entries = [];
    for (const { name, copy } of response.entries) {
      const bytes = await IOUtils.read(PathUtils.join(files, copy));
      entries.push({
        name,
        data: ChromeUtils.base64URLEncode(bytes, { pad: true }),
      });
    }
    const unreadable = Array.isArray(response.unreadable)
      ? response.unreadable
      : [];
    return { reachable: true, entries, unreadable };
  },

  /**
   * A `readDirs` answer with each entry's copy named in `file`, for a worker
   * to read.
   *
   * @param {object} response What the helper answered.
   * @param {string} files Where the helper put its copies.
   * @param {number} count How many directories were asked for.
   * @returns {object}
   */
  _withFiles(response, files, count) {
    if (
      !Array.isArray(response.dirs) ||
      response.dirs.length !== count ||
      !response.dirs.every(listed => usableEntries(listed?.entries))
    ) {
      return helperFailed();
    }
    const dirs = response.dirs.map((listed, index) => ({
      entries: listed.entries.map(entry => ({
        name: entry.name,
        file: PathUtils.join(files, String(index), entry.copy),
      })),
      unreadable: Array.isArray(listed.unreadable) ? listed.unreadable : [],
    }));
    return { reachable: true, dirs };
  },
};
