/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);
const { Subprocess } = ChromeUtils.importESModule(
  "resource://gre/modules/Subprocess.sys.mjs"
);

/**
 * Subprocess's worker forgets a process once it has exited and been reaped,
 * and tells the main thread a moment later. A kill() sent in that moment finds
 * no process in the worker, and must not leave its "Invalid process ID"
 * rejection unhandled (patches/subprocess-kill-after-exit.patch). Clearing
 * exitCode after the worker has reaped the process holds the main thread in
 * that moment.
 */
add_task(async function a_kill_racing_the_exit_is_harmless() {
  const win = AppConstants.platform == "win";
  const proc = await Subprocess.call({
    command: win ? await Subprocess.pathSearch("cmd.exe") : "/bin/sh",
    arguments: win ? ["/c", "exit 0"] : ["-c", "exit 0"],
  });
  await proc.wait();
  await proc.worker.call("waitForNoProcesses", []);
  proc.exitCode = null;

  Assert.equal((await proc.kill(0)).exitCode, 0, "kill() reports the exit");
  // The worker answers in order, so this reply follows the kill's.
  await proc.worker.call("getProcesses", []);
});
