/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_panel_startup_helpers.js */

/**
 * A launch whose sync fails (spec §6): a failed pass is tried again on a
 * backing-off clock, a missing shared folder still draws everything, and a
 * folder that goes away is quiet.
 *
 * Each task opens windows on a fresh profile over temporary folders, which
 * start as a launch's windows do, and makes the failure for real: this
 * device's own file refuses its reads, or the shared folder is not there.
 * `browser_sval_startup_workspace.js` covers which workspace a launch shows;
 * the fixture they share is in `sval_panel_startup_helpers.js`.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_panel_startup_helpers.js",
  this
);

const { SvalIdentity } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalIdentity.sys.mjs"
);
const SvalPanelModel = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);
const { SvalTestDeny } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestDeny.sys.mjs"
);

/**
 * Publishes a workspace with one tab as this device, into `root`, its own
 * location, so the profile holds this device's own copy.
 *
 * @param {object} fixture `freshProfile`'s `publish` argument.
 * @param {string} fixture.root
 * @param {object} fixture.keys
 * @returns {Promise<object>} `{ ws, tab, file }`: the ids, and the path of
 *   the file the pass wrote.
 */
async function publishOwnCopy({ root, keys }) {
  const mine = new SvalEngine({
    root,
    ...keys,
    deviceId: await SvalIdentity.deviceId(),
  });
  try {
    const ws = await mine.mutate({
      kind: "addWorkspace",
      name: "Kept on this device",
      id: crypto.randomUUID(),
      now: Date.now(),
    });
    const tab = await mine.mutate({
      kind: "addTab",
      parent: ws,
      name: "A page",
      url: "https://example.com/offline",
      id: crypto.randomUUID(),
      now: Date.now(),
    });
    const report = await mine.sync(SvalPanelModel.SYNC_DOCUMENT, Date.now());
    Assert.notEqual(report.wrote, null, "this device's copy was written");
    return {
      ws,
      tab,
      file: PathUtils.join(root, ...report.wrote.split("/")),
    };
  } finally {
    await stopEngine(mine);
  }
}

/**
 * A fresh profile whose own copy refuses its reads, as a cloud folder's file
 * still downloading or held open by another process does (spec §6.4), and a
 * window opened on it.
 *
 * @returns {Promise<object>} `{ win, planted, allow }`: `allow` gives the
 *   file its reads back.
 */
async function aLaunchWhoseOwnCopyRefusesReads() {
  let planted = null;
  const profile = await freshProfile({
    async publish(fixture) {
      planted = await publishOwnCopy(fixture);
      await SvalTestDeny.read(planted.file);
    },
  });
  const allow = () => SvalTestDeny.allow(planted.file);
  atTaskEnd(allow);
  const win = await profile.open();
  return { win, planted, allow };
}

/**
 * The clock that runs sync passes belongs to the tab observer, and the
 * observer only attaches once a pass has succeeded, so a first pass that
 * failed and was never retried would be the last pass of the session. Every
 * failure this is about clears by itself (spec §6.4), and a folder that is
 * merely slow wants the early tries close together, so the wait doubles.
 * The wait's ceiling, a minute, lies past this file's time limit.
 */
add_task(async function a_failed_startup_pass_is_tried_again_backing_off() {
  const { win, planted, allow } = await aLaunchWhoseOwnCopyRefusesReads();
  const panel = win.SvalPanel;

  Assert.strictEqual(
    panel.workspaceId,
    null,
    "nothing was created: a device that cannot read its copy must not " +
      "decide it holds nothing"
  );
  Assert.ok(!panel.observer, "and no tab observer runs a clock");
  Assert.notStrictEqual(
    panel._startRetryTimer,
    null,
    "so startup has a try of its own waiting"
  );
  Assert.equal(
    panel._startRetryWaitMs,
    panel._startRetryMs * 2,
    "and the try after it waits twice as long"
  );

  await TestUtils.waitForCondition(
    () => panel._startRetryWaitMs === panel._startRetryMs * 4,
    "the device tried again by itself, failed, and doubled its wait",
    100,
    150
  );
  Assert.strictEqual(panel.workspaceId, null, "still creating nothing");

  await allow();
  await TestUtils.waitForCondition(
    () => panel.workspaceId,
    "the next try reads the copy and shows its workspace",
    100,
    250
  );
  Assert.equal(panel.workspaceId, planted.ws, "the one this device kept");
  Assert.strictEqual(
    panel._startRetryWaitMs,
    null,
    "with the wait back where it started, so a launch that reads its " +
      "folder once does not carry a minute's patience into the next failure"
  );
});

/** Spec §6 test 1. */
add_task(
  async function a_launch_with_the_shared_folder_missing_draws_everything() {
    const missing = tempPath("sval-missing");
    let planted = null;
    const profile = await freshProfile({
      shared: missing,
      publish: async fixture => {
        planted = await publishOwnCopy(fixture);
      },
    });
    const { SvalPanel: panel } = await profile.open();
    Assert.equal(
      panel.workspaceId,
      planted.ws,
      "the window shows the workspace from the profile copy"
    );
    Assert.ok(
      planted.tab in panel.nodes,
      "with its tab, which is what restore opens tabs from"
    );
    // The launch's background step can wait its turn behind a helper an
    // earlier task's folder still holds, then a step's allowance.
    await TestUtils.waitForCondition(
      () => panel.folderState === "unreachable",
      "the launch's background step finds the folder missing",
      100,
      450
    );
    Assert.strictEqual(
      panel._startRetryTimer,
      null,
      "and startup is not waiting for the folder"
    );
  }
);

/**
 * Spec §6 test 8, as messages spec §3 draws it: a folder that is gone is
 * quiet at first, and clears the moment it answers. Its three minutes of
 * quiet, after which the indicator says so, lie past this file's time limit.
 */
add_task(async function a_missing_folder_is_quiet_and_clears_when_back() {
  const profile = await freshProfile();
  const { SvalPanel: panel } = await profile.open();
  const missing = tempPath("sval-missing");
  await within(
    panel.chooseSharedFolder(missing),
    45_000,
    "choosing a folder that is not there"
  );

  const { indicator, syncLabel } = panel._els;
  Assert.equal(panel.folderState, "unreachable", "the folder is away");
  Assert.equal(panel._folderProblem, "gone", "because it is not there");
  Assert.equal(
    indicator.dataset.severity,
    "synced",
    "a short outage shows nothing"
  );
  Assert.equal(syncLabel.textContent, "", "and no label");

  // The folder comes back as the chosen one, holding `sval/`.
  await IOUtils.makeDirectory(PathUtils.join(missing, "sval"));
  await TestUtils.waitForCondition(async () => {
    await within(SvalSharedFolder._whenIdle(), 45_000, "the helper's exit");
    return (await panel.syncWithFolder()) === "reached";
  }, "the folder answers again");
  Assert.equal(panel.folderState, "reached", "the panel knows");
  Assert.equal(indicator.dataset.severity, "synced", "and the moon is back");
  Assert.equal(syncLabel.textContent, "", "with no label");
});
