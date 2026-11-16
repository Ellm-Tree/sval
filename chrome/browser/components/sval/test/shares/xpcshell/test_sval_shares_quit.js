/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// This directory is not one of Mozilla's xpcshell lint paths, so the harness
// globals are declared here.
/* global add_task, Assert, registerCleanupFunction, do_get_profile */

// A shared-folder request travels through a directory in the profile
// (`SvalSharedFolder`'s `requestDir`), so these tests run with one.
do_get_profile();

/**
 * Quitting during a hang is prompt, keeps the last edit and kills the stuck
 * helper (real-share tests spec §3.3, test 4).
 *
 * The shutdown blocker finishes within its limit while a helper is stuck on
 * the hung share, with the edit in the profile. Then the application's
 * `quit-application` notification, the one Sval's helper watches, is sent, and
 * the helper must be gone within seconds: Sval kills it without waiting for the
 * share. The hang is left in force, for 45 s, so the second task can check that
 * the edit is in the profile and that the hang had not lifted by then. The
 * share is restored only once both have run, because test code never touches
 * a hung share with IOUtils.
 */

const { SvalSharesTestUtils: Shares } = ChromeUtils.importESModule(
  "resource://testing-common/SvalSharesTestUtils.sys.mjs"
);
const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { SvalSharedFolder } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
);
const { waitForCondition } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);
const { AsyncShutdown } = ChromeUtils.importESModule(
  "resource://gre/modules/AsyncShutdown.sys.mjs"
);

const WORKSPACE = "workspace-under-test";

const noNfs = () => !Shares.has("nfs");

const { bytes } = Shares;

/** The task's profile copy and its last edit, for the file's cleanup. */
let saved = null;

registerCleanupFunction(async () => {
  await Shares.restoreAndClean();
  if (saved) {
    await IOUtils.remove(saved.local, { recursive: true, ignoreAbsent: true });
  }
});

add_task(
  { skip_if: noNfs },
  async function quitting_during_a_hang_is_prompt_and_keeps_the_edit() {
    const shared = await Shares.runDir("nfs", "quit");
    const local = PathUtils.join(
      PathUtils.tempDir,
      `sval-shares-quit-${Shares.config.run}`
    );
    await IOUtils.makeDirectory(local);
    saved = { local };
    const keyBytes = bytes(32);
    const deviceId = bytes(16);
    const barrier = new AsyncShutdown.Barrier(
      "sval test: quit on a hung share"
    );
    SvalEngine.setShutdownClient(barrier.client, { timeoutMs: 1000 });
    const engine = SvalEngine.forProfile({
      root: local,
      sharedRoot: shared,
      keyBytes,
      deviceId,
    });
    try {
      Assert.ok((await engine.markSharedRoot()).reachable, "chosen");
      await engine.sync(WORKSPACE, 1000);
      await Shares.control("hang", "nfs", 45);
      engine.setSharedRoot(shared);
      // The share hangs before this step starts, so its helper cannot finish:
      // only its step's limit, 20 s off, or the kill at quit ends it.
      await engine.sync(WORKSPACE, 1500, { shared: "background" });
      await waitForCondition(() => SvalSharedFolder.busy, "started");
      const id = await engine.mutate({
        kind: "addWorkspace",
        name: "Last edit",
        now: 2000,
      });
      Assert.ok(SvalSharedFolder.busy, "the helper is stuck on the hung share");
      const started = Date.now();
      await barrier.wait();
      // A quit that waited for the stuck helper would wait out the 45 s hang.
      Assert.less(Date.now() - started, 5000, "quitting was not held up");
      Assert.ok(SvalSharedFolder.busy, "by the helper, still stuck");
      Object.assign(saved, { id, keyBytes });

      Services.obs.notifyObservers(null, "quit-application");
      await waitForCondition(
        () => !SvalSharedFolder.busy,
        "quitting killed the stuck helper",
        100,
        50
      );
    } finally {
      engine.terminate();
      SvalEngine.setSharedInstance(null);
      SvalEngine.setShutdownClient(null);
    }

    // Quitting has finished by now, so a hang still in force means it quit
    // with the share hung. The profile copy is local, so it reads at once.
    Assert.equal(
      (await Shares.state()).nfs,
      "hang",
      "the hang was still in force when quitting had finished"
    );
    const reader = new SvalEngine({
      root: local,
      keyBytes,
      deviceId: bytes(16),
    });
    try {
      Assert.ok(
        saved.id in JSON.parse(await reader.publishedTree(WORKSPACE)).nodes,
        "the edit made just before quitting is in the profile copy"
      );
    } finally {
      reader.terminate();
    }
  }
);
