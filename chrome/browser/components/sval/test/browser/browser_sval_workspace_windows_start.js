/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_agent_on_helpers.js */
/* import-globals-from sval_panel_startup_helpers.js */

/**
 * A window opened for a workspace still shows that workspace when its first
 * sync pass fails (spec §10.7, §6.4). A failed pass leaves the window with
 * nothing to draw, and the retry that succeeds starts it again: the window
 * was opened for one workspace, and another that happens to be free is a
 * different window from the one the person asked for.
 *
 * The task opens its window on a fresh profile over temporary folders and
 * makes the failure for real, as `browser_sval_startup_when_sync_fails.js`
 * does: this device's own file refuses its reads.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_agent_on_helpers.js",
  this
);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_panel_startup_helpers.js",
  this
);

const { SvalIdentity } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalIdentity.sys.mjs"
);
const { SvalTestDeny } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestDeny.sys.mjs"
);

/**
 * Publishes two workspaces with a tab each as this device, into `root`, its
 * own location, so the profile holds this device's own copy.
 *
 * @param {object} fixture `freshProfile`'s `publish` argument.
 * @param {string} fixture.root
 * @param {object} fixture.keys
 * @returns {Promise<object>} `{ first, second, file }`: each workspace as
 *   `{ id, tab }`, in the switcher's order, and the path of the file the
 *   pass wrote.
 */
async function publishTwoWorkspaces({ root, keys }) {
  const mine = new SvalEngine({
    root,
    ...keys,
    deviceId: await SvalIdentity.deviceId(),
  });
  try {
    const made = [];
    for (const name of ["First", "Second"]) {
      const id = await mine.mutate({
        kind: "addWorkspace",
        name,
        id: crypto.randomUUID(),
        now: Date.now(),
      });
      const tab = await mine.mutate({
        kind: "addTab",
        parent: id,
        name: `In ${name}`,
        url: titledRed(`In ${name}`),
        id: crypto.randomUUID(),
        now: Date.now(),
      });
      made.push({ id, tab });
    }
    const report = await mine.sync(SvalTree.SYNC_DOCUMENT, Date.now());
    Assert.notEqual(report.wrote, null, "this device's copy was written");
    const [first, second] = made;
    return {
      first,
      second,
      file: PathUtils.join(root, ...report.wrote.split("/")),
    };
  } finally {
    await stopEngine(mine);
  }
}

/**
 * The window is handed the second workspace, as the switcher's Open in New
 * Window hands one to the window it opens (`SvalPanelModel.handWorkspaceTo`).
 * No window of this profile has read the document, so there is no switcher
 * to choose it from. The first workspace is free throughout: it is what a
 * window that forgot what it was opened for would take.
 */
add_task(async function a_window_keeps_its_workspace_past_a_failed_pass() {
  let planted = null;
  const profile = await freshProfile({
    async publish(fixture) {
      planted = await publishTwoWorkspaces(fixture);
      await SvalTestDeny.read(planted.file);
    },
  });
  const allow = () => SvalTestDeny.allow(planted.file);
  atTaskEnd(allow);

  const handing = {
    observe(subject) {
      Services.obs.removeObserver(handing, "domwindowopened");
      SvalPanelModel.handWorkspaceTo(subject, planted.second.id);
    },
  };
  Services.obs.addObserver(handing, "domwindowopened");
  const win = await profile.open();
  // A window behind another reads as hidden to its pages.
  const context = win.browsingContext;
  context.forceAppWindowActive = true;
  atTaskEnd(() => {
    if (!context.isDiscarded) {
      context.forceAppWindowActive = false;
    }
  });

  Assert.deepEqual(
    rowIdsIn(win),
    [],
    "the window whose pass failed draws no workspace's rows"
  );
  Assert.deepEqual(shownTabIdsIn(win), [], "and has none of their tabs");

  await allow();
  // The first retry comes five seconds after the failed pass.
  await TestUtils.waitForCondition(
    () => rowIdsIn(win).length,
    "the retry reads the copy and the window draws a workspace",
    100,
    250
  );
  // The rows are drawn by the retry's pass, and the window's tabs are
  // restored and its observer attached after it.
  await TestUtils.waitForCondition(
    () => win.SvalPanel.observer,
    "the window's startup attaching its tabs"
  );
  await switchDone(win);
  await within(
    win.SvalPanel.observer.settled(),
    10_000,
    "the window's observer settling"
  );

  Assert.equal(
    switcherNameIn(win),
    "Second",
    "the switcher names the workspace the window was opened for"
  );
  Assert.deepEqual(rowIdsIn(win), [planted.second.tab], "its rows are drawn");
  Assert.deepEqual(
    shownTabIdsIn(win),
    [planted.second.tab],
    "and its tab is the one on show"
  );
  await selectedShows(win, titledRed("In Second"), "the workspace's page");
  const { listed, free } = await switcherIdsIn(win);
  Assert.deepEqual(
    listed,
    [planted.first.id, planted.second.id],
    "the switcher lists the two workspaces, with none made meanwhile"
  );
  Assert.deepEqual(
    free,
    [planted.first.id],
    "and the first is still free for a window of its own"
  );
});
