/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_private_helpers.js */

/**
 * What a private window shows and who can reach it (private-windows spec):
 * Sval's panel and its sync-off indicator, rows drawn as normal rows, no
 * workspace actions, Kagi with a stored token, and no agent or settings page
 * bound to it. `browser_sval_private_writes_nothing.js` proves the session
 * writes nothing; `sval_private_helpers.js` holds what both use.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_private_helpers.js",
  this
);

add_setup(privateSetup);

/**
 * A private window shows Sval's panel with sync shown as off, and no tab
 * strip.
 */
add_task(async function a_private_window_shows_the_panel_and_sync_off() {
  const win = await openPrivate();
  try {
    const panel = win.SvalPanel;
    const doc = win.document;
    Assert.ok(
      BrowserTestUtils.isHidden(doc.getElementById("TabsToolbar")),
      "the tab strip is hidden"
    );
    Assert.ok(
      !doc.getElementById("sval-panel-container").hidden,
      "the panel is shown"
    );
    Assert.equal(panel.engine.isPrivate, true, "on the private tree");
    Assert.notEqual(panel.engine, SvalPanel.engine, "not the profile's");
    const { syncRow, indicator, syncLabel } = panel._els;
    Assert.ok(
      BrowserTestUtils.isVisible(syncRow),
      "the sync indicator is shown"
    );
    Assert.equal(
      indicator.dataset.icon,
      "moon-off",
      "as the outlined moon: nothing here syncs"
    );
    Assert.equal(
      indicator.dataset.state,
      "private-window",
      "as a private window's"
    );
    Assert.ok(indicator.title, "and its tooltip says so");
    Assert.equal(syncLabel.textContent, "", "with no label");
    Assert.ok(
      BrowserTestUtils.isHidden(panel._els.switcher.parentElement),
      "and the header has no empty switcher bar"
    );
    Assert.ok(
      panel._els.switcher.hidden,
      "there is no switcher, which is where a workspace is made"
    );

    const { id } = await openMarked(win, marker());
    // The panel draws after its own read of the tree, a round trip past the
    // write that filed the tab, so the row is waited for itself.
    await TestUtils.waitForCondition(
      () => panel._rows.some(row => row.id === id),
      "the tab is a row in the panel"
    );
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the test window closing"
    );
  }
});

/**
 * One experience: the private window's rows are drawn by the same code, with
 * the same markup, as a normal window's.
 */
add_task(async function private_rows_are_drawn_as_normal_rows() {
  const win = await openPrivate();
  let normalWin;
  try {
    await openMarked(win, marker());
    // A row that has just opened may still be fading in, which is the moment
    // and no part of the row's shape: its `style` and `sval-row-opening` are
    // left out of both comparisons.
    const shape = el =>
      [
        el.localName,
        [...el.attributes]
          .map(a => a.name)
          .filter(name => name !== "style")
          .sort()
          .join(","),
      ].join(" ");
    // A normal window of its own, whose panel starts on the profile's engine
    // as any new window's does, so nothing an earlier file did to this
    // window's panel is in the comparison.
    normalWin = await within(
      BrowserTestUtils.openNewBrowserWindow(),
      20_000,
      "a normal window's opening"
    );
    await within(
      normalWin.SvalPanel.started,
      10_000,
      "the normal panel's startup"
    );
    const normalTab = await within(
      BrowserTestUtils.openNewForegroundTab(normalWin.gBrowser, "about:blank"),
      10_000,
      "a blank tab's opening"
    );
    let normalRow = null;
    await TestUtils.waitForCondition(() => {
      const id = normalWin.SvalPanel.observer?.nodeIdFor(normalTab);
      normalRow =
        id &&
        normalWin.SvalPanel._els.tree.querySelector(`[data-node-id="${id}"]`);
      return normalRow;
    }, "the normal window draws its new tab");
    const privateRow = win.SvalPanel._els.tree.querySelector(
      '[role="treeitem"][data-kind="tab"]'
    );
    Assert.ok(privateRow && normalRow, "both windows draw tab rows");
    Assert.equal(
      shape(privateRow),
      shape(normalRow),
      "with the same element and attributes"
    );
    const base = el =>
      [...el.classList]
        .filter(name => !name.startsWith("is-") && name !== "sval-row-opening")
        .sort();
    Assert.deepEqual(base(privateRow), base(normalRow), "and the same classes");
  } finally {
    if (normalWin) {
      await within(
        BrowserTestUtils.closeWindow(normalWin),
        10_000,
        "the normal window closing"
      );
    }
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the test window closing"
    );
  }
});

/**
 * Whether a row's context menu offers `command`, read from the menu itself.
 *
 * @param {Window} win The window the row is in.
 * @param {Element} row The row to open the menu on.
 * @param {string} command A `data-command` of the panel's context menu.
 * @returns {Promise<boolean>}
 */
async function rowMenuOffers(win, row, command) {
  const menu = win.SvalPanel._els.contextMenu;
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(row, { type: "contextmenu" }, win);
  await within(shown, 10_000, "the context menu opening");
  assertTidySeparators(menu, "the row's menu");
  const item = menuItem(win.SvalPanel.rowMenu.menu, command);
  const offered = !!item && !item.hidden;
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(hidden, 10_000, "the context menu closing");
  return offered;
}

/**
 * A private window offers nothing that belongs to saved workspaces, and no
 * name for a tab, and the handlers refuse when called directly. A normal window's tab row offers
 * Move to workspace; a private one's has no other workspace to move to.
 */
add_task(async function a_private_window_offers_no_workspace_actions() {
  const win = await openPrivate();
  let normalWin;
  try {
    normalWin = await within(
      BrowserTestUtils.openNewBrowserWindow(),
      20_000,
      "a normal window's opening"
    );
    await within(
      normalWin.SvalPanel.started,
      10_000,
      "the normal panel's startup"
    );
    const normalTab = await within(
      BrowserTestUtils.openNewForegroundTab(normalWin.gBrowser, "about:blank"),
      10_000,
      "a blank tab's opening"
    );
    const normalRow = await TestUtils.waitForCondition(() => {
      const id = normalWin.SvalPanel.observer?.nodeIdFor(normalTab);
      return (
        id &&
        normalWin.SvalPanel._els.tree.querySelector(`[data-node-id="${id}"]`)
      );
    }, "the normal tab's row is drawn");
    Assert.ok(
      await rowMenuOffers(normalWin, normalRow, "moveToWorkspace"),
      "a normal tab row offers Move to workspace"
    );
    await within(
      BrowserTestUtils.closeWindow(normalWin),
      10_000,
      "the normal window closing"
    );
    normalWin = null;

    const panel = win.SvalPanel;
    const { id } = await openMarked(win, marker());
    // Drawn after the panel's own read of the tree, so waited for itself.
    const row = await TestUtils.waitForCondition(
      () => panel._els.tree.querySelector(`[data-node-id="${id}"]`),
      "the tab's row is drawn"
    );
    Assert.ok(
      !(await rowMenuOffers(win, row, "moveToWorkspace")),
      "a private tab row does not"
    );
    Assert.ok(
      !(await rowMenuOffers(win, row, "rename")),
      "nor does it offer Rename"
    );
    await within(panel.run("rename", { id }), 10_000, "Rename's refusal");
    Assert.ok(!win.gDialogBox.isOpen, "and F2's Rename asks nothing");

    const before = Object.keys(await privateTree(win)).length;
    const windows = BrowserWindowTracker.windowCount;
    await within(
      panel.run("addWorkspace", null),
      10_000,
      "New Workspace's refusal"
    );
    Assert.ok(!win.gDialogBox.isOpen, "New Workspace asks nothing");
    Assert.equal(
      panel.switcher.openInNewWindow(SvalWindowWorkspace.of(win).id),
      null,
      "no workspace opens in a new window"
    );
    Assert.equal(
      Object.keys(await privateTree(win)).length,
      before,
      "no workspace was added"
    );
    Assert.equal(BrowserWindowTracker.windowCount, windows, "no window opened");
    await Assert.rejects(
      panel.adoptKey(new Uint8Array(32)),
      err => err.code === "memory_tree",
      "and pairing is refused"
    );
  } finally {
    if (normalWin) {
      await within(
        BrowserTestUtils.closeWindow(normalWin),
        10_000,
        "the normal window closing"
      );
    }
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the test window closing"
    );
  }
});

/**
 * A private window starts Kagi's sign-in when a token is stored, whatever the
 * engine, since a profile whose windows are all private never runs `_start`.
 */
add_task(async function a_private_window_starts_kagi_with_a_stored_token() {
  const search = SvalSettingsSync.searchService();
  const engine = await search.currentId();
  const wasStarted = SvalKagi._started;
  const wasWatching = !!SvalKagi._searchWatch;
  await search.setById("ddg");
  SvalKagi.stop();
  SvalKagi._stopWatchingSearch();
  await SvalKagi.setToken("tok_en-3456.mnop~XYZ");
  let win;
  try {
    win = await openPrivate();
    await TestUtils.waitForCondition(
      () => SvalKagi._started,
      "the private window started Kagi"
    );
  } finally {
    if (win) {
      await within(
        BrowserTestUtils.closeWindow(win),
        10_000,
        "the test window closing"
      );
    }
    SvalKagi._stopWatchingSearch();
    SvalKagi.stop();
    await SvalKagi.clearToken();
    await search.setById(engine);
    if (wasStarted) {
      SvalKagi.start();
    }
    if (wasWatching) {
      await SvalKagi.watchSearch(search);
    }
  }
});

/**
 * An agent never sees a private window or its tabs, and cannot act on one by
 * its id.
 */
add_task(async function an_agent_never_sees_a_private_tab() {
  const { call, reply } = await agentSetup();
  const win = await openPrivate();
  try {
    const mark = marker();
    const { id } = await openMarked(win, mark);
    const listed = JSON.stringify(await call("list_tabs", {}));
    Assert.ok(!listed.includes(mark), "list_tabs does not list it");
    Assert.ok(!listed.includes(id), "or its id");
    const refusal = await reply("get_snapshot", { tab: id });
    Assert.equal(
      refusal.error,
      "not_controlled",
      "a tool given its id refuses"
    );
    Assert.ok(
      !JSON.stringify(refusal).includes(mark),
      "and says nothing of what is in it"
    );
    const { fullWindowShowing } = ChromeUtils.importESModule(
      "moz-src:///browser/components/sval/SvalAgentTabs.sys.mjs"
    );
    Assert.equal(
      fullWindowShowing(SvalWindowWorkspace.of(win).id),
      null,
      "and no agent lookup finds the private window"
    );
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the test window closing"
    );
  }
});

/**
 * Settings opened from a private window binds to the profile's panel, never
 * the private one.
 */
add_task(async function settings_never_binds_to_a_private_window() {
  const win = await openPrivate();
  try {
    const tab = win.SvalPanel.openSettingsPage();
    // about:preferences finishes `gotoPref` after its own scripts run, and a
    // window closed before then leaves that navigation to throw.
    const initialized = BrowserTestUtils.waitForEvent(
      tab.linkedBrowser,
      "Initialized",
      true
    );
    await within(initialized, 15_000, "the settings page initializing");
    await TestUtils.waitForCondition(
      () => tab.linkedBrowser.contentWindow?.SvalSettings?._els,
      "the settings page started"
    );
    const page = tab.linkedBrowser.contentWindow;
    Assert.equal(
      page.SvalSettings.panel,
      SvalPanel,
      "the page's panel is the profile's"
    );
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the test window closing"
    );
  }
});

/**
 * A private tab's node id is the private session's, kept by its browser, so
 * a duplicate carries none: it is filed as a node of its own, and outlives
 * its original.
 */
add_task(async function a_private_duplicate_outlives_its_original() {
  const win = await openPrivate();
  try {
    const { tab, id } = await openMarked(win, marker());
    const copy = win.gBrowser.duplicateTab(tab, true);
    await within(
      BrowserTestUtils.waitForEvent(copy, "SSTabRestored"),
      10_000,
      "the copy's restore"
    );
    await within(win.SvalPanel.observer.settled(), 10_000, "the observer");
    const copyId = win.SvalPanel.observer.nodeIdFor(copy);
    Assert.ok(copyId && copyId !== id, "the copy is a node of its own");

    BrowserTestUtils.removeTab(tab);
    await within(win.SvalPanel.observer.settled(), 10_000, "the observer");
    const nodes = await privateTree(win);
    Assert.deepEqual(
      win.SvalPanel.observer.closeOrphanTabs(nodes),
      [],
      "the orphan sweep closes nothing"
    );
    Assert.ok(win.gBrowser.tabs.includes(copy), "the copy is open");
    Assert.ok(copyId in nodes, "as its own node");
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the test window closing"
    );
  }
});
