/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { makeTempDir } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

// This directory is not one of Mozilla's xpcshell lint paths, so the harness
// globals are declared here.
/* global add_task, Assert, registerCleanupFunction, do_get_profile */

// A shared-folder request travels through a directory in the profile
// (`SvalSharedFolder`'s `requestDir`), so these tests run with one.
do_get_profile();

/**
 * A second device converges once a dropped share returns (real-share tests
 * spec §3.3, test 5).
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
const { within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);

const WORKSPACE = "workspace-under-test";

const { bytes } = Shares;

async function localFolder(name) {
  return makeTempDir(`sval-shares-${name}`);
}

registerCleanupFunction(() => Shares.restoreAndClean());

for (const share of ["nfs", "smb"]) {
  add_task(
    { skip_if: () => !Shares.has(share) },
    async function a_second_device_converges_once_the_share_returns() {
      const shared = await Shares.runDir(share, "restore");
      const keyBytes = bytes(32);
      const a = new SvalEngine({
        root: await localFolder("a"),
        sharedRoot: shared,
        keyBytes,
        deviceId: bytes(16),
      });
      const b = new SvalEngine({
        root: await localFolder("b"),
        sharedRoot: shared,
        keyBytes,
        deviceId: bytes(16),
      });
      try {
        Assert.ok((await a.markSharedRoot()).reachable, "the folder is chosen");
        await a.mutate({ kind: "addWorkspace", name: "A", now: 1000 });
        Assert.equal((await a.sync(WORKSPACE, 2000)).shared, "reached");

        await Shares.control("drop", share, 120);
        const id = await b.mutate({
          kind: "addWorkspace",
          name: "Made offline",
          now: 3000,
        });
        const offline = await b.sync(WORKSPACE, 4000);
        Assert.equal(
          offline.shared,
          "unreachable",
          `${share}: b cannot reach it`
        );
        Assert.notEqual(offline.wrote, null, "b still saves to its profile");

        // Restored before waiting for the helper, because a helper stuck in a
        // dropped hard NFS mount exits only when the share answers.
        await Shares.control("restore", share);
        await within(
          SvalSharedFolder._whenIdle(),
          Shares.reconnectMs,
          "the helper's exit after the restore"
        );
        await Shares.settle();
        Assert.equal(
          (await b.sync(WORKSPACE, 5000)).shared,
          "reached",
          "b publishes once it returns"
        );
        await a.sync(WORKSPACE, 6000);
        Assert.ok(
          id in (await a.tree()).nodes,
          `${share}: a has b's offline edit with nothing pressed`
        );
      } finally {
        a.terminate();
        b.terminate();
      }
    }
  );
}
