/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_agent_on_helpers.js */

/**
 * Workspaces as a user works with them, with agent access on: made, gone to
 * and renamed through the switcher, a tab moved between them or closed and
 * brought back, and a window opened on one. A tab that could be an agent's
 * waits for its filing before its first load (`holdForFiling`), so each
 * task asserts that every page the user goes to loads and paints.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_agent_on_helpers.js",
  this
);

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);

add_setup(failOnConsoleErrors);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  await agentAccessOn(registerCleanupFunction);
  expectWorkspaceTabs();
});

/**
 * @param {string} id A node id.
 * @param {Window} [win]
 * @returns {object|null} the tab `win` holds for it.
 */
function tabOf(id, win = window) {
  return win.SvalPanel.observer.tabFor(id);
}

add_task(async function each_workspace_shows_its_own_tabs() {
  const start = SvalPanel.workspaceId;
  const here = titledRed("Here");
  const hereId = await nodeOfTab(await openPage(here));

  const errands = await newWorkspace("Errands");
  Assert.ok(!rowIn(window, hereId), "the new workspace draws none of its tabs");
  const there = titledRed("There");
  const thereTab = await openPage(there);
  const thereId = await nodeOfTab(thereTab);
  await selectedShows(window, there, "the new workspace's page");
  Assert.equal(
    SvalPanel.nodes[thereId].placement.parent,
    errands,
    "filed in the new workspace"
  );
  await TestUtils.waitForCondition(
    () => rowNameIn(window, thereId) === "There",
    "its row is named for its page"
  );

  await switchVia(window, start);
  Assert.ok(!rowIn(window, thereId), "the first draws none of the other's");
  Assert.ok(rowIn(window, hereId), "and its own");
  Assert.equal(
    gBrowser.selectedTab,
    tabOf(hereId),
    "on the tab it was left on"
  );
  await selectedShows(window, here, "the first workspace's page");
  Assert.ok(
    !tabOf(thereId) || tabOf(thereId).hidden,
    "the other workspace's tab is out of sight"
  );

  await switchVia(window, errands);
  Assert.equal(
    gBrowser.selectedTab,
    tabOf(thereId),
    "on the tab it was left on"
  );
  await selectedShows(window, there, "the other's page, back again");
});

add_task(async function a_renamed_workspace_keeps_its_name_in_a_new_window() {
  const start = SvalPanel.workspaceId;
  const draft = await newWorkspace("Draft");
  const page = titledRed("Kept");
  const id = await nodeOfTab(await openPage(page));

  const menu = await rightClickOpens(
    SvalPanel._els.switcher,
    SvalPanel._els.workspaceMenu
  );
  await menuCommand(menu, '[data-command="edit"]');
  const doc = await dialogIn(window, ".sval-nw-name");
  Assert.equal(doc.querySelector(".sval-nw-name").value, "Draft");
  typeIn(doc.querySelector(".sval-nw-name"), "Final");
  doc.querySelector(".sval-nw-create").click();
  await TestUtils.waitForCondition(
    () => switcherNameIn(window) === "Final",
    "the switcher shows the new name"
  );
  await TestUtils.waitForCondition(() => !gDialogBox.isOpen, "it closes");

  await switchVia(window, start);
  const win = await tearOffVia(window, draft);
  Assert.equal(switcherNameIn(win), "Final", "a new window shows the name");
  await clickRowShows(win, id, page, "its page in the new window");
});

add_task(async function a_tab_moved_to_another_workspace_loads_there() {
  const start = SvalPanel.workspaceId;
  const elsewhere = await newWorkspace("Elsewhere");
  await switchVia(window, start);
  const page = titledRed("Moving");
  const id = await nodeOfTab(await openPage(page));

  const menu = await contextMenuIn(window, id);
  await menuCommand(menu, `[data-move-workspace="${CSS.escape(elsewhere)}"]`);
  await TestUtils.waitForCondition(
    () =>
      SvalPanel.nodes[id]?.placement.parent === elsewhere && !rowIn(window, id),
    "the tab is filed in the other workspace, and leaves this one's rows"
  );

  await switchVia(window, elsewhere);
  await TestUtils.waitForCondition(
    () => rowNameIn(window, id) === "Moving",
    "the other workspace draws it"
  );
  await clickRowShows(window, id, page, "the moved tab");
});

add_task(async function a_closed_tab_comes_back_in_its_workspace() {
  const reading = await newWorkspace("Reading");
  const page = titledRed("Closed");
  const tab = await openPage(page);
  const id = await nodeOfTab(tab);

  const restored = await closeAndRestore(window, tab);
  await selectTab(restored);
  await selectedShows(window, page, "the restored tab");
  Assert.equal(
    SvalPanel.nodes[id].placement.parent,
    reading,
    "back in the workspace it was closed in"
  );
  await TestUtils.waitForCondition(
    () => rowNameIn(window, id) === "Closed",
    "with its row"
  );
});

add_task(async function a_workspace_opened_in_a_new_window_loads_its_tabs() {
  const start = SvalPanel.workspaceId;
  const travel = await newWorkspace("Travel");
  const first = titledRed("First");
  const second = titledRed("Second");
  const firstId = await nodeOfTab(await openPage(first));
  const secondId = await nodeOfTab(await openPage(second));
  await switchVia(window, start);

  const win = await tearOffVia(window, travel);
  Assert.ok(
    tabOf(firstId, win) && tabOf(secondId, win),
    "the window holds a tab for each of the workspace's"
  );
  await selectedShows(win, second, "the tab last looked at");
  await clickRowShows(win, firstId, first, "the other tab");
  Assert.ok(!tabOf(firstId) && !tabOf(secondId), "and this window holds none");
});

add_task(async function a_new_window_loads_what_is_typed_in_it() {
  const win = await secondWindow();
  const workspace = win.SvalPanel.workspaceId;
  Assert.ok(workspace, "the new window shows a workspace");
  const page = titledRed("Typed");
  await within(
    UrlbarTestUtils.promiseAutocompleteResultPopup({
      window: win,
      value: page,
    }),
    10_000,
    "the address bar's results"
  );
  EventUtils.synthesizeKey("KEY_Enter", {}, win);
  await selectedShows(win, page, "the typed page");
  const id = await nodeOfTab(win.gBrowser.selectedTab);
  Assert.equal(
    win.SvalPanel.nodes[id].placement.parent,
    workspace,
    "filed in the new window's workspace"
  );
  await explained(
    TestUtils.waitForCondition(
      () => rowNameIn(win, id) === "Typed",
      "and drawn in its panel"
    ),
    () => ({
      row: rowNameIn(win, id),
      content: win.SvalPanel.nodes[id]?.content,
      label: win.gBrowser.selectedTab.label,
    })
  );
});
