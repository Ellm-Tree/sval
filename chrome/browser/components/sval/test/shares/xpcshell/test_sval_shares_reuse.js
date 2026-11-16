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
 * A deleted sval/ directory waits for the user and then spreads (real-share
 * tests spec §3.3, test 6, the engine half).
 */

const { SvalSharesTestUtils: Shares } = ChromeUtils.importESModule(
  "resource://testing-common/SvalSharesTestUtils.sys.mjs"
);
const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
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
    async function a_deleted_sval_dir_waits_for_the_user_and_then_spreads() {
      const shared = await Shares.runDir(share, "reuse");
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
        await a.sync(WORKSPACE, 2000);
        Assert.equal((await b.sync(WORKSPACE, 2500)).shared, "reached");

        await IOUtils.remove(PathUtils.join(shared, "sval"), {
          recursive: true,
        });
        Assert.equal(
          (await a.sync(WORKSPACE, 3000)).shared,
          "unreachable",
          "a deleted sval/ is unreachable"
        );
        Assert.ok(
          !(await IOUtils.exists(PathUtils.join(shared, "sval"))),
          "and sval does not recreate it"
        );

        // Made while the folder was gone, so only the folder brings it to b.
        const later = await a.mutate({
          kind: "addWorkspace",
          name: "Made while it was gone",
          now: 3500,
        });
        Assert.ok((await a.markSharedRoot()).reachable);
        Assert.equal(
          (await a.sync(WORKSPACE, 4000)).shared,
          "reached",
          "using the folder again publishes"
        );
        Assert.ok(await IOUtils.exists(PathUtils.join(shared, "sval")));
        Assert.equal(
          (await b.sync(WORKSPACE, 5000)).shared,
          "reached",
          "the other device finds it with nothing pressed"
        );
        Assert.ok(
          later in (await b.tree()).nodes,
          "and takes what was made while it was gone"
        );
      } finally {
        a.terminate();
        b.terminate();
      }
    }
  );
}
