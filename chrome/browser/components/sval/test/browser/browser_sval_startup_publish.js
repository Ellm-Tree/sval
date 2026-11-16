/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_panel_startup_helpers.js */

/**
 * What a launch publishes, read by another device through the shared folder
 * (spec §6). Each task opens a window on a fresh profile
 * (`sval_panel_startup_helpers.js`), which starts as a launch's window does.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_panel_startup_helpers.js",
  this
);

const SvalPanelModel = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);

/**
 * What a launch publishes into the shared folder, another device reads.
 *
 * The panel takes both keys from `SvalIdentity` and seals the shared copy under
 * the sync key, never this device's local key. The peer holds the sync key
 * and a local key of its own, as a real second device does, so a copy sealed
 * under the wrong key is one it cannot read.
 */
add_task(async function a_peer_reads_the_workspace_a_launch_published() {
  await SvalSharedFolder._whenIdle();
  const shared = await makeTempDir("sval-published");
  await IOUtils.makeDirectory(PathUtils.join(shared, "sval"));
  const profile = await freshProfile({ shared });
  const { keys } = profile;
  const { SvalPanel: panel } = await profile.open();
  const ours = panel.workspaceId;
  Assert.ok(ours, "the launch made a workspace");
  // One helper at a time: while the launch's sweep is winding down, the
  // folder answers "busy", so the pass is asked again until it answers.
  await TestUtils.waitForCondition(async () => {
    await SvalSharedFolder._whenIdle();
    return (await panel.syncWithFolder()) === "reached";
  }, "the launch's workspace reached the folder");

  const peer = new SvalEngine({
    root: await makeTempDir("sval-published-peer"),
    sharedRoot: shared,
    localKey: crypto.getRandomValues(new Uint8Array(32)),
    syncKey: keys.syncKey,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  try {
    // The panel's own background steps share the one helper too.
    await TestUtils.waitForCondition(async () => {
      await SvalSharedFolder._whenIdle();
      const report = await peer.sync(SvalPanelModel.SYNC_DOCUMENT, Date.now());
      return report.shared === "reached" && !report.sharedBusy;
    }, "the peer reached the folder");
    Assert.ok(
      ours in (await peer.tree()).nodes,
      "and holds the workspace this device published"
    );
  } finally {
    await stopEngine(peer);
  }
});
