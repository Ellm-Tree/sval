/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_agent_on_helpers.js */

/**
 * What a person is left looking at when two things change the workspace a
 * window shows at once (spec §10.7): their own switch and another device
 * deleting the workspace on screen. Another device is an engine of its own
 * on the profile's folder, and its change arrives on a pass, as it does in
 * use.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_agent_on_helpers.js",
  this
);

const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);

add_setup(failOnConsoleErrors);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  expectWorkspaceTabs();
});

/**
 * @param {string} title
 * @returns {{url: string, title: string}} a page for `workspaceWith`.
 */
function page(title) {
  return { url: titledRed(title), title };
}

/**
 * Another device that has read what this one holds, stopped when the task
 * ends.
 *
 * @returns {Promise<object>} its engine.
 */
async function anotherDevice() {
  const { engine } = SvalPanel;
  // Published, so the other device reads the task's workspaces.
  await engine.sync(SvalTree.SYNC_DOCUMENT, Date.now());
  const peer = new SvalEngine({
    root: engine.root,
    ...(await svalKeys()),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  atTaskEnd(() => stopFixture({ engine: peer }));
  // Read before it writes, so this device's watermark is in the peer's file
  // and the absence it publishes is a deletion (spec §5.4).
  await peer.sync(SvalTree.SYNC_DOCUMENT, Date.now());
  return peer;
}

/**
 * Deletes `workspaces` on `peer`, each with its tabs, and publishes the
 * deletions as one change.
 *
 * @param {object} peer
 * @param {Array<{id: string, tabs: string[]}>} workspaces
 */
async function deleteElsewhere(peer, workspaces) {
  for (const { id, tabs } of workspaces) {
    for (const tab of tabs) {
      await peer.mutate({ kind: "remove", id: tab });
    }
    await peer.mutate({ kind: "remove", id });
  }
  await peer.sync(SvalTree.SYNC_DOCUMENT, Date.now());
}

/**
 * Asserts that `win` is on `workspace` in everything a person reads: the
 * switcher, the rows, the tabs on show and the one on screen.
 *
 * The rows are asserted by what they hold of the workspace's own tabs and of
 * the deleted ones. A window whose every tab on show is deleted is given a
 * home page tab so that it stays open (`SvalTabObserver.keepOneTab`), and
 * that tab is filed in the workspace the window shows by the time its page
 * loads, so the workspace arrived at can hold a row for it.
 *
 * @param {Window} win
 * @param {{id: string, tabs: string[]}} workspace
 * @param {string} name
 * @param {Array<{id: string, tabs: string[]}>} deleted
 */
async function assertWindowIsOn(win, workspace, name, deleted) {
  await switchDone(win);
  await within(
    win.SvalPanel.observer.settled(),
    10_000,
    "the window's observer settling"
  );
  Assert.equal(switcherNameIn(win), name, "the switcher names it");
  const rows = rowIdsIn(win);
  Assert.deepEqual(
    rows.filter(id => workspace.tabs.includes(id)),
    workspace.tabs,
    "its tabs are drawn"
  );
  Assert.deepEqual(
    rows.filter(id => deleted.some(gone => gone.tabs.includes(id))),
    [],
    "and none of a deleted workspace's"
  );
  Assert.deepEqual(
    shownTabIdsIn(win),
    workspace.tabs,
    "its tabs are the only ones on show"
  );
  Assert.ok(
    workspace.tabs.includes(taggedId(win.gBrowser.selectedTab)),
    "and one of them is on screen"
  );
}

/**
 * The switch is under way when the deletion arrives. The pass that brings
 * the deletion in finds the window's workspace gone and would move the
 * window to the first free one, over the switch the person asked for.
 */
add_task(async function a_switch_holds_when_the_workspace_left_is_deleted() {
  const shown = await workspaceWith("Shown", { pages: [page("Going")] });
  const wanted = await workspaceWith("Wanted", { pages: [page("Staying")] });
  await switchVia(window, shown.id);
  const peer = await anotherDevice();
  await deleteElsewhere(peer, [shown]);

  const menu = await openSwitcherIn(window);
  // The entry's command starts the switch before the menu closes
  // (`nsXULMenuCommandEvent::Run`), so the pass starts with it in flight.
  await chooseMenuItem(
    menu.querySelector(`[data-workspace-id="${CSS.escape(wanted.id)}"]`),
    menu,
    "the wanted workspace"
  );
  Assert.ok(
    await within(SvalPanel.syncNow(), 20_000, "the pass"),
    "the pass read the other device's deletion"
  );

  await assertWindowIsOn(window, wanted, "Wanted", [shown]);
  await selectedShows(window, titledRed("Staying"), "the wanted page");
  Assert.ok(
    !(await switcherIdsIn(window)).listed.includes(shown.id),
    "and the deleted workspace is gone from the switcher"
  );
});

/**
 * The deletion's pass is under way when the switch starts. The pass moves
 * the window off the deleted workspace by itself, and the switch asked for
 * while it ran is still where the window ends.
 */
add_task(async function a_switch_started_during_the_deleting_pass_wins() {
  const shown = await workspaceWith("Shown", { pages: [page("Going")] });
  const wanted = await workspaceWith("Wanted", { pages: [page("Staying")] });
  await switchVia(window, shown.id);
  const peer = await anotherDevice();
  await deleteElsewhere(peer, [shown]);

  const pass = SvalPanel.syncNow();
  // The switcher's own action, started in the turn the pass started in. The
  // pass rebuilds an open switcher as it takes the shown workspace away, so
  // an entry cannot be chosen from the menu while it runs.
  const switched = SvalWindowWorkspace.of(window).switchTo(wanted.id);
  Assert.ok(
    await within(pass, 20_000, "the pass"),
    "the pass read the other device's deletion"
  );
  await within(switched, 10_000, "the switch");

  await assertWindowIsOn(window, wanted, "Wanted", [shown]);
  await selectedShows(window, titledRed("Staying"), "the wanted page");
  Assert.ok(
    !(await switcherIdsIn(window)).listed.includes(shown.id),
    "and the deleted workspace is gone from the switcher"
  );
});
