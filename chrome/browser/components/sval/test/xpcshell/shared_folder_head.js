/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { makeTempDir, tempPath } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

const { SvalTestDeny } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestDeny.sys.mjs"
);

const { waitForCondition, within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);

// A shared-folder request travels through a directory in the profile
// (`SvalSharedFolder`'s `requestDir`), so these tests run with one.
do_get_profile();

/**
 * What the shared-folder test files share (local-copy spec). Their tasks run
 * real engines and the real helper, `sval-folder`, against real folders. A
 * hang is a real named pipe the helper reads as a write's payload
 * (`hangNextWrite`), or a stand-in helper that says hello and then answers
 * nothing (`useStuckHelper`): the helper never opens a pipe in the shared
 * folder itself.
 *
 * The harness gives each test file 30 s (`HARNESS_TIMEOUT` in
 * `testing/xpcshell/runxpcshelltests.py`), and a hang waits out a deadline, so
 * these tasks are spread over several files, each well inside that budget.
 *
 * The test files that use this name it in an `import-globals-from` comment.
 * eslint gives every test in the directory the globals of any `head*.js`, and
 * these are only theirs.
 */

const { SvalEngine, TOP_DIR } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { SvalSharedFolder, SHARED_STEP_TIMEOUT_MS, requestDir } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
  );
const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);
const { syncIndicator } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);
const { Subprocess } = ChromeUtils.importESModule(
  "resource://gre/modules/Subprocess.sys.mjs"
);

const WORKSPACE = "workspace-under-test";

/** Windows has no `mkfifo`, so there is no real hang to build there. */
const noFifo = () => AppConstants.platform == "win";

/**
 * A file ends with no helper alive. Every task that hangs a helper waits for
 * it, so one still busy here is a task's leak, and the file fails for it.
 * Whether one is busy is taken first; the kill, retried until a spawn in
 * progress has finished, runs before the assertion that would stop this
 * function, so a leaked helper does not outlive the test process either way.
 * The live helper that served the file's requests is let go.
 */
registerCleanupFunction(async () => {
  const leaked = SvalSharedFolder.busy;
  await SvalSharedFolder.release();
  try {
    await waitForCondition(
      () => {
        SvalSharedFolder.killLive();
        return !SvalSharedFolder.busy;
      },
      "the leaked shared-folder helper was killed",
      200,
      50
    );
  } finally {
    Assert.ok(
      !leaked,
      "no task left a shared-folder helper alive at the end of the file"
    );
  }
});

/**
 * Waits for `condition` as long as a shared step may take. A step is real
 * helper processes, which a loaded machine makes slow to start.
 *
 * @param {Function} condition What to wait for.
 * @param {string} msg What is being waited for.
 */
function waitForStep(condition, msg) {
  return waitForCondition(condition, msg, 100, SHARED_STEP_TIMEOUT_MS / 100);
}

/**
 * The deadline for a request whose helper a task means to leave stuck. A
 * helper is stuck only once it has read its request, and one that starts
 * after Sval has stopped waiting finds its directory gone and exits, so this
 * leaves a loaded machine time to start one.
 */
const STUCK_DEADLINE_MS = 5000;

function deadline(ms = SHARED_STEP_TIMEOUT_MS) {
  return Date.now() + ms;
}

/**
 * An answer's verdict and reason, without the error name a helper may add
 * to say what went wrong, for a test that asserts the reason alone.
 *
 * @param {object} answer What a `SvalSharedFolder` call resolved to.
 * @returns {{reachable: boolean, reason: string|undefined}}
 */
function reasonOf(answer) {
  return { reachable: answer.reachable, reason: answer.reason };
}

/**
 * A folder the user chose: choosing one makes `sval/` in it
 * (`SvalEngine.markSharedRoot`).
 *
 * @param {string} name Distinguishes the folder.
 * @returns {Promise<string>}
 */
async function chosenFolder(name) {
  const folder = await makeTempDir(`sval-${name}`);
  await IOUtils.makeDirectory(PathUtils.join(folder, TOP_DIR));
  return folder;
}

function missingFolder(name) {
  return tempPath(`sval-test-missing-${name}`);
}

function resolve(root, relative) {
  return PathUtils.join(root, ...relative.split("/"));
}

/**
 * Makes a named pipe at `path`. A helper that reads it blocks until something
 * opens it for writing: a real hang in the real helper.
 *
 * @param {string} path Where the pipe goes.
 */
async function makeFifo(path) {
  const proc = await Subprocess.call({
    command: await Subprocess.pathSearch("mkfifo"),
    arguments: [path],
    stderr: "pipe",
  });
  Assert.equal((await proc.wait()).exitCode, 0, "mkfifo made the pipe");
}

/**
 * Makes the next write's payload a named pipe nobody writes, so the real
 * helper blocks reading it, before it touches the shared folder.
 *
 * @returns {object} `{ fifo }`, a promise for the pipe's path once it is made.
 */
function hangNextWrite() {
  const made = Promise.withResolvers();
  const realWrite = SvalSharedFolder._writePayload;
  SvalSharedFolder._writePayload = async path => {
    SvalSharedFolder._writePayload = realWrite;
    await makeFifo(path);
    made.resolve(path);
  };
  registerCleanupFunction(() => {
    if (SvalSharedFolder._writePayload !== realWrite) {
      SvalSharedFolder._writePayload = realWrite;
    }
  });
  return { fifo: made.promise };
}

/**
 * `message` as a helper frame, for `printf` in `/bin/sh`: the 4-byte
 * big-endian length as octal escapes, then the JSON, which must hold no `'`,
 * `%` or `\\`.
 *
 * @param {object} message
 * @returns {string}
 */
function printfFrame(message) {
  const body = JSON.stringify(message);
  const octal = byte => `\\${byte.toString(8).padStart(3, "0")}`;
  const length = body.length;
  return (
    [length >>> 24, length >>> 16, length >>> 8, length]
      .map(byte => octal(byte & 0xff))
      .join("") + body
  );
}

/**
 * Starts helpers that stand in for one stuck in the kernel: each says hello
 * as `sval-folder` does with the given frame, then answers nothing, and the
 * end of its stdin does not end it. A kill does, unless the task replaced
 * `SvalSharedFolder._kill` to stand in for a helper the operating system will
 * not let die. `endStuckHelper` puts the real helper back.
 *
 * @param {object} [hello] The frame it answers the handshake with.
 */
function useStuckHelper(hello = { hello: 1, build: "stuck" }) {
  SvalSharedFolder._helperCommand = () => ({
    command: "/bin/sh",
    arguments: ["-c", `printf '${printfFrame(hello)}'; exec sleep 3600`],
  });
  registerCleanupFunction(endStuckHelper);
}

/**
 * Puts the real helper back and kills a stand-in still alive, whatever
 * `SvalSharedFolder._kill` stands for, then waits until it has gone.
 */
async function endStuckHelper() {
  if (!SvalSharedFolder._helperCommand) {
    return;
  }
  SvalSharedFolder._helperCommand = null;
  const proc = SvalSharedFolder._helperProcess;
  SvalSharedFolder.killLive();
  await proc?.kill(0).catch(() => {});
  await SvalSharedFolder._whenIdle();
}

/**
 * Ends the read the live helper is blocked in on `path`, and waits until that
 * helper has exited.
 *
 * Opening the pipe for writing and closing it gives end-of-file to whatever
 * has it open for reading at that moment, which need not be the helper: one
 * still starting has not opened it yet, and another process can open any file
 * in the temporary directory. So the pipe is opened again until the helper
 * itself has gone. An open that finds no reader blocks, and is killed once the
 * helper has gone without it.
 *
 * @param {string} path A pipe from `makeFifo`.
 */
async function releaseFifo(path) {
  const giveUp = Date.now() + SHARED_STEP_TIMEOUT_MS;
  while (SvalSharedFolder.busy) {
    Assert.less(Date.now(), giveUp, "the helper reading the pipe exits");
    const proc = await Subprocess.call({
      command: "/bin/sh",
      arguments: ["-c", ': > "$1"', "sh", path],
      stderr: "pipe",
    });
    const opened = proc.wait().then(() => true);
    const idle = SvalSharedFolder._whenIdle().then(() => false);
    if (await Promise.race([opened, idle])) {
      // Something read the end-of-file. If it was the helper, it exits soon.
      await within(idle, 500, "the helper exiting").catch(() => {});
    } else {
      await proc.kill(0).catch(() => {});
    }
  }
}

/**
 * A profile folder and a shared folder, one key, and a device id that a
 * "relaunch" can reuse.
 *
 * @param {string} name Distinguishes this task's folders.
 * @param {object} [options]
 * @param {boolean} [options.chosen] Whether the shared folder holds `sval/`,
 *   as a folder the user chose does; without it, it is an empty directory,
 *   as a mount point that is not mounted is.
 * @returns {Promise<object>} `{ local, shared, keyBytes, deviceId, make }`,
 *   where `make(options)` builds an engine for this device with `options`
 *   merged over `{ root: local, sharedRoot: shared }`.
 */
async function device(name, { chosen = true } = {}) {
  const local = await makeTempDir(`sval-${name}-local`);
  const shared = chosen
    ? await chosenFolder(`${name}-shared`)
    : await makeTempDir(`sval-${name}-shared`);
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const deviceId = crypto.getRandomValues(new Uint8Array(16));
  const engines = [];
  registerCleanupFunction(() => engines.forEach(e => e.terminate()));
  const make = (options = {}) => {
    const engine = new SvalEngine({
      root: local,
      sharedRoot: shared,
      keyBytes,
      deviceId,
      ...options,
    });
    engines.push(engine);
    return engine;
  };
  return { local, shared, keyBytes, deviceId, make };
}

/**
 * The nodes a fresh device holding `keyBytes` reads from `root`, read as its
 * profile (no helper involved).
 *
 * @param {string} root The folder to read.
 * @param {Uint8Array} keyBytes The document key.
 * @returns {Promise<object>} The nodes by id.
 */
async function readBack(root, keyBytes) {
  const reader = new SvalEngine({
    root,
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  try {
    return JSON.parse(await reader.publishedTree(WORKSPACE)).nodes;
  } finally {
    reader.terminate();
  }
}

/**
 * A peer's file in `shared`, and the directory and extension it landed with.
 * The peer uses `shared` as its own profile, so no helper is involved.
 *
 * @param {string} shared The shared folder.
 * @param {Uint8Array} keyBytes The document key.
 * @returns {Promise<object>} `{ dir, extension, id }`.
 */
async function peerPublishes(shared, keyBytes) {
  const peer = new SvalEngine({
    root: shared,
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  try {
    const id = await peer.mutate({
      kind: "addWorkspace",
      name: "Peer",
      now: 1000,
    });
    const report = await peer.sync(WORKSPACE, 2000);
    const absolute = resolve(shared, report.wrote);
    return {
      dir: PathUtils.parent(absolute),
      extension: report.wrote.slice(report.wrote.lastIndexOf(".")),
      id,
    };
  } finally {
    peer.terminate();
  }
}

/**
 * The footer indicator a pass's report gives a healthy, paired device.
 *
 * @param {object} report A `SvalEngine.sync()` result.
 * @param {number} now When the pass ran.
 * @returns {object|null} what `syncIndicator` answers.
 */
function indicatorFor(report, now) {
  return syncIndicator({
    window: "normal",
    sharing: true,
    firstPassDone: true,
    folder: { problem: report.sharedReason, since: null },
    lastSynced: now,
    keyState: "present",
    platform: AppConstants.platform,
    unpairedDevice: false,
    newerSchema: !!report.schemaTooNew?.length,
    critical: null,
    now,
    formatTime: String,
  });
}
