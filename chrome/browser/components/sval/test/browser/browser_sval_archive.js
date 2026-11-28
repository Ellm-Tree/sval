/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */
/* import-globals-from sval_preferences_helpers.js */

/**
 * Archiving idle tabs (idle-tab archive spec): off until Settings turns it
 * on; the tab on screen and a tab playing sound stay while an idle tab of a
 * workspace no window shows goes; what another device archived is listed in
 * the History sidebar's Archived tabs view, which a search filters and a
 * click restores from; and a private window offers none of it.
 *
 * Time is the one thing a task cannot wait out, so the archive these tasks
 * sweep with reads a clock eight days ahead: every tab is then a week idle,
 * unless something keeps it.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

const { AUTO_ARCHIVE_PREF, SvalArchive, RETENTION_PREF } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalArchive.sys.mjs"
  );
const { ARCHIVED_TREE_ID, ARCHIVED_VIEW_ID, ARCHIVE_MENU_ID } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalHistorySidebar.sys.mjs"
  );

const WEEK_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;

add_setup(function the_choice_is_put_back() {
  registerCleanupFunction(async () => {
    await SvalArchive.stopShared();
    Services.prefs.clearUserPref(AUTO_ARCHIVE_PREF);
    Services.prefs.clearUserPref(RETENTION_PREF);
    // Firefox notes the first Ctrl+Tab.
    Services.prefs.clearUserPref("browser.engagement.ctrlTab.has-used");
  });
});

/**
 * This window's archive over `fixture`'s engine, as the panel starts it.
 *
 * @param {object} fixture `withSwitcherTabs`'s.
 * @param {object} [options] As `SvalArchive` takes them.
 * @returns {Promise<SvalArchive>}
 */
async function archiveFor(fixture, options = {}) {
  await SvalArchive.stopShared();
  return SvalArchive.startFor(fixture.engine, {
    canBegin: () => true,
    settings: fixture.settings,
    requestPass: () => {},
    ...options,
  });
}

/**
 * A pass, and the sweep it starts.
 *
 * @param {SvalEngine} engine
 * @param {SvalArchive} archive
 */
async function passAndSweep(engine, archive) {
  await engine.sync(SYNC_DOCUMENT, Date.now());
  await within(archive.whenIdle(), 10_000, "archive going idle");
}

/**
 * Turns on Archive idle tabs in Settings › Workspaces, as a person does.
 *
 * @returns {Promise<object>} what the group shows: `{ after, keep }`.
 */
async function turnOnInSettings() {
  // From the default, whatever an earlier task chose.
  Services.prefs.clearUserPref(AUTO_ARCHIVE_PREF);
  let group;
  const control = id =>
    group?.querySelector(`#setting-control-${id}`)?.controlEl;
  await openPane(
    "paneHome",
    ({ page }) => {
      group = page.document.querySelector(
        'setting-group[groupid="svalTabArchive"]'
      );
      return control("svalAutoArchive")?.checkVisibility();
    },
    "Idle tabs is showing in Workspaces"
  );
  Assert.ok(
    control("svalAutoArchiveAfter").disabled,
    "the time waits for the box"
  );
  control("svalAutoArchive").click();
  await TestUtils.waitForCondition(
    () => Services.prefs.getStringPref(AUTO_ARCHIVE_PREF) === "7d",
    "checking the box chooses 7 days"
  );
  await TestUtils.waitForCondition(
    () => !control("svalAutoArchiveAfter").disabled,
    "and the time can be changed"
  );
  const shown = {
    after: control("svalAutoArchiveAfter").value,
    keep: control("svalArchiveRetention").value,
  };
  closeSettings();
  return shown;
}

add_task(async function off_by_default_nothing_is_archived() {
  const fixture = await withSwitcherTabs();
  const archive = await archiveFor(fixture, {
    now: () => Date.now() + WEEK_AHEAD_MS,
  });
  Assert.equal(
    Services.prefs.getStringPref(AUTO_ARCHIVE_PREF),
    "never",
    "archiving starts off"
  );
  await passAndSweep(fixture.engine, archive);
  const nodes = (await fixture.engine.tree()).nodes;
  Assert.ok(
    fixture.ids.tabs.every(id => id in nodes),
    "every tab is still in its workspace"
  );
  Assert.deepEqual(await archive.entries(), [], "and none was archived");
});

add_task(
  async function the_shown_and_the_playing_tab_stay_and_an_idle_one_goes() {
    const fixture = await withSwitcherTabs();
    const { engine, observer, ids } = fixture;
    const [shownTab, idleTab] = ids.tabs;
    await SpecialPowers.pushPrefEnv({
      // Settings › Sites: "Allow sites to play video and audio" Always allow.
      set: [["media.autoplay.site-permission-only.default", 1]],
    });

    const shown = gBrowser.selectedTab;
    const noisy = BrowserTestUtils.addTab(
      gBrowser,
      "data:text/html,%3Ctitle%3ENoisy%3C/title%3E"
    );
    await within(
      BrowserTestUtils.switchTab(gBrowser, noisy),
      10_000,
      "the playing tab showing"
    );
    await within(
      BrowserTestUtils.browserLoaded(noisy.linkedBrowser),
      10_000,
      "its page"
    );
    await SpecialPowers.spawn(noisy.linkedBrowser, [], async () => {
      const context = new content.AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      gain.gain.value = 0.2;
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      await context.resume();
    });
    await TestUtils.waitForCondition(
      () => noisy.hasAttribute("soundplaying"),
      "the tab is playing audio"
    );
    await within(
      BrowserTestUtils.switchTab(gBrowser, shown),
      10_000,
      "the first tab showing again"
    );
    await quiet(engine, observer);
    const noisyId = taggedId(noisy);
    Assert.ok(noisyId, "the playing tab is filed");

    const choice = await turnOnInSettings();
    Assert.deepEqual(
      choice,
      { after: "7d", keep: "30" },
      "Settings shows 7 days, and keeps archived tabs for 30"
    );
    await quiet(engine, observer);

    const archive = await archiveFor(fixture, {
      now: () => Date.now() + WEEK_AHEAD_MS,
    });
    await passAndSweep(engine, archive);
    const nodes = (await engine.tree()).nodes;
    Assert.ok(shownTab in nodes, "the tab on screen stays");
    Assert.ok(noisyId in nodes, "and so does the tab playing audio");
    Assert.ok(
      !(idleTab in nodes),
      "the idle tab of the workspace no window shows was archived"
    );
    // The profile's own workspace is one no window shows too, so its idle
    // tabs are archived beside this task's.
    Assert.deepEqual(
      (await archive.entries())
        .filter(entry => ids.workspaces.includes(entry.workspace))
        .map(entry => [entry.title, entry.workspaceName]),
      [["Tab in 2", "Workspace 2"]],
      "and is in the Archive under its workspace's name"
    );

    BrowserTestUtils.removeTab(noisy);
    await quiet(engine, observer);
  }
);

/**
 * Opens the History sidebar from the History menu's Archive, and waits for
 * the archived view to list `count` rows.
 *
 * @param {number} count
 * @returns {Promise<object>} `{ doc, tree }`.
 */
async function showArchivedTabs(count) {
  document.getElementById(ARCHIVE_MENU_ID).doCommand();
  let tree;
  await TestUtils.waitForCondition(() => {
    tree =
      SidebarController.browser.contentDocument?.getElementById(
        ARCHIVED_TREE_ID
      );
    return (
      tree &&
      !tree.hidden &&
      tree.view?.rowCount === count &&
      !document.getElementById("sidebar-box").hasAttribute("sval-overlay")
    );
  }, `the archived view lists ${count}, slid in`);
  return { doc: SidebarController.browser.contentDocument, tree };
}

add_task(async function another_devices_archived_tab_is_listed_and_restores() {
  // The Archive keeps what earlier tasks archived, under the same tab
  // titles, so this task's workspace has a name of its own.
  const place = `Archived ${crypto.randomUUID().slice(0, 8)}`;
  const fixture = await withSwitcherTabs({ names: ["Workspace 1", place] });
  const { engine, observer, ids } = fixture;
  const archive = await archiveFor(fixture);
  await turnOnInSettings();
  await quiet(engine, observer);
  await engine.sync(SYNC_DOCUMENT, Date.now());

  // The other device: the same folder and key, its own archive and clock.
  const peer = new SvalEngine({
    root: fixture.root,
    ...fixture.keys,
    deviceId: randomBytes(16),
  });
  const peerArchive = new SvalArchive({
    engine: peer,
    settings: await SvalLocalSettings.open(
      tempPath("sval-archive-peer-settings", ".json")
    ),
    // That device shows every tab but this task's idle one.
    exempt: async () =>
      Object.keys((await peer.tree()).nodes).filter(id => id !== ids.tabs[1]),
    now: () => Date.now() + WEEK_AHEAD_MS,
    requestPass: () => {},
  });
  registerCleanupFunction(async () => {
    peerArchive.stop();
    await stopEngine(peer);
  });
  await peerArchive.start();
  await passAndSweep(peer, peerArchive);
  Assert.deepEqual(
    (await peerArchive.entries())
      .filter(entry => ids.workspaces.includes(entry.workspace))
      .map(entry => entry.title),
    ["Tab in 2"],
    "the other device archived the idle tab"
  );
  // Its next pass writes the tree's removal, as the sweep asks for one.
  await peer.sync(SYNC_DOCUMENT, Date.now());

  // This device's next pass merges it.
  await engine.sync(SYNC_DOCUMENT, Date.now());
  await within(archive.whenIdle(), 10_000, "archive going idle");
  const { doc, tree } = await showArchivedTabs(
    (await archive.entries()).length
  );
  const cellAt = (row, id) =>
    tree.view.getCellText(row, tree.columns.getNamedColumn(id));
  const ours = () =>
    Array.from({ length: tree.view.rowCount }, (_, i) => i).find(
      i => cellAt(i, "sval-archived-workspace") === place
    );
  Assert.ok(
    doc.getElementById(ARCHIVED_VIEW_ID).hasAttribute("checked"),
    "Archived tabs is the view chosen"
  );
  Assert.ok(doc.getElementById("historyTree").hidden, "in Places' stead");
  const cell = id => cellAt(ours(), id);
  Assert.equal(cell("sval-archived-title"), "Tab in 2");
  // A site's icon can be far larger than a favicon; this entry's is 64px.
  const view = tree.view.wrappedJSObject ?? tree.view;
  view.rows[ours()].icon =
    "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64'/></svg>";
  tree.invalidate();
  const icon = tree.getCoordsForCellItem(
    ours(),
    tree.columns.getNamedColumn("sval-archived-title"),
    "image"
  );
  Assert.equal(icon.height, 16, "its icon is drawn at favicon size");
  Assert.ok(!cell("sval-archived-closed").endsWith("restored"));

  const search = doc.getElementById("search-box");
  const searchFor = text => {
    search.value = text;
    search.dispatchEvent(new CustomEvent("MozInputSearch:search"));
  };
  searchFor("nothing like it");
  Assert.equal(ours(), undefined, "a search that matches no title hides it");
  searchFor("TAB IN 2");
  Assert.equal(
    cell("sval-archived-title"),
    "Tab in 2",
    "one that matches, in any case, shows it"
  );
  searchFor("");

  // A click on the row brings it back, in its workspace, on screen.
  const row = ours();
  tree.scrollToRow(row);
  const rect = tree.getCoordsForCellItem(
    row,
    tree.columns.getNamedColumn("sval-archived-title"),
    "text"
  );
  // The a11y checks find no interactive accessible above a tree's body;
  // Enter on the selected row is the keyboard's way to the same restore.
  AccessibilityUtils.setEnv({ mustHaveAccessibleRule: false });
  EventUtils.synthesizeMouse(
    tree.body,
    rect.x + rect.width / 2,
    rect.y + rect.height / 2,
    {},
    doc.defaultView
  );
  AccessibilityUtils.resetEnv();
  await TestUtils.waitForCondition(
    () => SvalWindowWorkspace.of(window).id === ids.workspaces[1],
    "the window goes to the tab's workspace"
  );
  await TestUtils.waitForCondition(
    () => cell("sval-archived-closed").endsWith(", restored"),
    "and the row says it was restored"
  );
  await quiet(engine, observer);
  const nodes = (await engine.tree()).nodes;
  const restored = Object.keys(nodes).filter(
    id =>
      nodes[id].kind === "tab" &&
      nodes[id].placement?.parent === ids.workspaces[1]
  );
  Assert.equal(restored.length, 1, "one tab is back in Workspace 2");
  Assert.notEqual(restored[0], ids.tabs[1], "as a new tab");
  Assert.equal(
    taggedId(gBrowser.selectedTab),
    restored[0],
    "and it is the tab on screen"
  );
  expectOpened(gBrowser.selectedTab);

  // Another view puts Places' tree back.
  doc.getElementById("byday").doCommand();
  await TestUtils.waitForCondition(
    () => tree.hidden && !doc.getElementById("historyTree").hidden,
    "By Date shows Places' tree again"
  );
  SidebarController.hide();
  await TestUtils.waitForCondition(
    () => !SidebarController.isOpen,
    "the sidebar closes"
  );
});

add_task(async function another_devices_entry_at_a_file_offers_no_restore() {
  const fixture = await withSwitcherTabs();
  const { engine, observer, ids } = fixture;
  const archive = await archiveFor(fixture);
  await turnOnInSettings();
  await quiet(engine, observer);
  await engine.sync(SYNC_DOCUMENT, Date.now());

  // The other device: the same folder and key, its own archive and clock,
  // and a tab of its own at a file, which it archives with the idle one.
  const peer = new SvalEngine({
    root: fixture.root,
    ...fixture.keys,
    deviceId: randomBytes(16),
  });
  const peerArchive = new SvalArchive({
    engine: peer,
    settings: await SvalLocalSettings.open(
      tempPath("sval-archive-peer-settings", ".json")
    ),
    // That device shows every tab but this task's idle one.
    exempt: async () =>
      Object.keys((await peer.tree()).nodes).filter(id => id !== ids.tabs[1]),
    now: () => Date.now() + WEEK_AHEAD_MS,
    requestPass: () => {},
  });
  registerCleanupFunction(async () => {
    peerArchive.stop();
    await stopEngine(peer);
  });
  await peerArchive.start();
  await peer.sync(SYNC_DOCUMENT, Date.now());
  await peer.mutate({
    kind: "addTab",
    parent: ids.workspaces[1],
    name: "Notes",
    url: "file:///Users/me/notes.html",
  });
  await passAndSweep(peer, peerArchive);
  await peer.sync(SYNC_DOCUMENT, Date.now());

  await engine.sync(SYNC_DOCUMENT, Date.now());
  await within(archive.whenIdle(), 10_000, "archive going idle");
  const entries = await archive.entries();
  const notes = entries.find(entry => entry.title === "Notes");
  Assert.ok(notes?.refused, "the file's entry is listed, refused");
  Assert.ok(!entries.find(entry => entry.title === "Tab in 2").refused);
  await Assert.rejects(
    archive.restore(notes.id, ids.workspaces[0]),
    err => err.code === "refused_entry",
    "and is not restored"
  );

  const { tree } = await showArchivedTabs((await archive.entries()).length);
  const row = Array.from({ length: tree.view.rowCount }, (_, i) => i).find(
    i =>
      tree.view.getCellText(
        i,
        tree.columns.getNamedColumn("sval-archived-title")
      ) === "Notes"
  );
  tree.view.selection.select(row);
  tree.focus();
  EventUtils.synthesizeKey("KEY_Enter", {}, tree.documentGlobal);
  await within(archive.whenIdle(), 10_000, "archive going idle");
  Assert.ok(
    !(await archive.entries()).find(entry => entry.id === notes.id).restored,
    "Enter on its row restores nothing"
  );
  const nodes = (await engine.tree()).nodes;
  Assert.ok(
    !Object.values(nodes).some(
      node => node.kind === "tab" && node.content.url?.startsWith("file:")
    ),
    "and no tab is made at its address"
  );
  SidebarController.hide();
  await TestUtils.waitForCondition(
    () => !SidebarController.isOpen,
    "the sidebar closes"
  );
});

add_task(async function a_private_window_offers_no_archive_and_adds_none() {
  const fixture = await withSwitcherTabs();
  const archive = await archiveFor(fixture, {
    now: () => Date.now() + WEEK_AHEAD_MS,
  });
  await turnOnInSettings();
  await quiet(fixture.engine, fixture.observer);
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20_000,
    "a private window"
  );
  const privateTab = await within(
    BrowserTestUtils.openNewForegroundTab(
      win.gBrowser,
      "data:text/html,%3Ctitle%3EPrivate%3C/title%3E"
    ),
    10_000,
    "a private tab"
  );
  Assert.ok(privateTab, "the private window has a tab of its own");
  Assert.ok(
    win.document.getElementById(ARCHIVE_MENU_ID).hidden,
    "its History menu has no Archive"
  );

  await win.SidebarController.show("viewHistorySidebar");
  await TestUtils.waitForCondition(
    () =>
      win.SidebarController.browser.contentDocument?.getElementById(
        "historyTree"
      )?._svalDecorated,
    "sval dressed the private window's sidebar"
  );
  const doc = win.SidebarController.browser.contentDocument;
  Assert.ok(
    !doc.getElementById(ARCHIVED_VIEW_ID),
    "and its sidebar no Archived tabs view"
  );
  Assert.ok(!doc.getElementById(ARCHIVED_TREE_ID));

  await passAndSweep(fixture.engine, archive);
  Assert.ok(
    (await archive.entries()).every(entry => entry.title !== "Private"),
    "a sweep archives nothing of a private window's"
  );
  await within(
    BrowserTestUtils.closeWindow(win),
    10_000,
    "the private window closing"
  );
});

/**
 * The Edit dialog's document, once its page's script has drawn it.
 *
 * The page's markup parses before its script fills in the archive choice on
 * `DOMContentLoaded`, so a control in the markup says nothing about whether
 * the dialog is drawn. `SubDialog`'s `_dialogReady` resolves after the
 * frame's load, by when that script has run.
 *
 * @returns {Promise<Document>}
 */
async function editDialog() {
  let dialog;
  await TestUtils.waitForCondition(
    () => (dialog = gDialogBox.dialog),
    "the Edit dialog opens"
  );
  await dialogShown(dialog, "the Edit dialog's load");
  return dialog._frame.contentDocument;
}

add_task(async function a_workspace_takes_its_own_choice_in_its_edit_dialog() {
  const fixture = await withSwitcherTabs();
  const [shown] = fixture.ids.workspaces;
  await turnOnInSettings();

  const edited = SvalPanel.run("edit", { id: shown });
  const doc = await editDialog();
  const field = doc.querySelector(".sval-nw-archive");
  Assert.ok(!field.hidden, "a workspace's dialog offers Archive idle tabs");
  const select = doc.querySelector(".sval-nw-archive-choice");
  await fieldDrawn(select);
  const options = [...fieldInner(select).options];
  Assert.deepEqual(
    options.map(option => option.value),
    ["", "12h", "24h", "7d", "30d", "never"],
    "the global choice first, then each time and Never"
  );
  const sevenDays = options.find(option => option.value === "7d");
  Assert.ok(
    options[0].textContent.includes(sevenDays.textContent),
    "the default option names the global choice"
  );
  Assert.equal(select.value, "", "following the default");
  await pickOption(select, "30d");
  doc.querySelector(".sval-nw-create").click();
  await within(edited, 10_000, "the edit being saved");
  Assert.equal(
    (await fixture.engine.tree()).nodes[shown].lifecycle?.auto_archive,
    "30d",
    "the workspace archives after 30 days of its own"
  );
});

/**
 * When `id`'s node was last touched, as the engine holds it.
 *
 * @param {SvalEngine} engine
 * @param {string} id
 * @returns {Promise<number>}
 */
async function touchedAt(engine, id) {
  return (await engine.tree()).nodes[id]?.touched_at ?? 0;
}

add_task(async function a_tab_the_user_goes_to_is_marked_used() {
  const fixture = await withSwitcherTabs();
  const { engine, observer } = fixture;
  const second = BrowserTestUtils.addTab(
    gBrowser,
    "data:text/html,%3Ctitle%3ESecond%3C/title%3E"
  );
  await quiet(engine, observer);
  const [shownId, secondId] = [
    taggedId(gBrowser.selectedTab),
    taggedId(second),
  ];
  Assert.equal(await touchedAt(engine, secondId), 0, "never used yet");

  // Ctrl+Tab, Firefox's own key for the tab used last, which a tab opened
  // beside this one is (`ctrlTab`'s TabOpen). It selects as Ctrl comes up.
  const handled = [];
  const listen = () =>
    handled.push(
      window.windowUtils.isHandlingUserInput || window.ctrlTab.selecting
    );
  gBrowser.tabContainer.addEventListener("TabSelect", listen);
  const selected = BrowserTestUtils.waitForEvent(
    gBrowser.tabContainer,
    "TabSelect"
  );
  EventUtils.synthesizeKey("VK_TAB", { ctrlKey: true });
  EventUtils.synthesizeKey("VK_CONTROL", { type: "keyup" });
  await within(selected, 10_000, "Ctrl+Tab's selection");
  Assert.equal(gBrowser.selectedTab, second, "Ctrl+Tab went to the new tab");
  Assert.deepEqual(handled, [true], "as the user's own input");
  await TestUtils.waitForCondition(
    async () => (await touchedAt(engine, secondId)) > 0,
    "the tab Ctrl+Tab went to is marked used"
  );

  // A click on the panel's row for the first tab.
  handled.length = 0;
  const row = SvalPanel._els.tree.querySelector(`[data-node-id="${shownId}"]`);
  const back = BrowserTestUtils.waitForEvent(
    gBrowser.tabContainer,
    "TabSelect"
  );
  EventUtils.synthesizeMouseAtCenter(row, {});
  await within(back, 10_000, "the row click's selection");
  gBrowser.tabContainer.removeEventListener("TabSelect", listen);
  Assert.deepEqual(
    handled,
    [false],
    "a row selects its tab after an await, so the panel marks the use itself"
  );
  await TestUtils.waitForCondition(
    async () => (await touchedAt(engine, shownId)) > 0,
    "the tab whose row was clicked is marked used"
  );

  BrowserTestUtils.removeTab(second);
  await quiet(engine, observer);
});

add_task(async function a_click_in_the_shown_page_marks_its_tab_used() {
  const { engine, observer } = await withSwitcherTabs();
  // Opened by the test, the tab is selected with no input of the user's, so
  // nothing has marked it used.
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(
      gBrowser,
      "data:text/html,%3Ctitle%3EReading%3C/title%3E%3Cp%3Etext"
    ),
    10_000,
    "the tab opening"
  );
  await quiet(engine, observer);
  const id = taggedId(tab);
  Assert.equal(await touchedAt(engine, id), 0, "never used yet");

  // A press the platform delivers, as a person's click arrives, reaches the
  // parent before the page's process. It lands on the page's `<browser>`,
  // which is no control and has no accessible of its own to operate.
  AccessibilityUtils.setEnv({ mustHaveAccessibleRule: false });
  atTaskEnd(() => AccessibilityUtils.resetEnv());
  await moveWindowOnScreen();
  const rect = tab.linkedBrowser.getBoundingClientRect();
  const point = {
    screenX: window.mozInnerScreenX + rect.left + rect.width / 2,
    screenY: window.mozInnerScreenY + rect.top + rect.height / 2,
  };
  await nativeMouse({
    type: "mousemove",
    target: tab.linkedBrowser,
    ...point,
    eventTargetToListen: window,
  });
  for (const type of ["mousedown", "mouseup"]) {
    await nativeMouse({ type, target: tab.linkedBrowser, ...point });
  }
  await TestUtils.waitForCondition(
    async () => (await touchedAt(engine, id)) > 0,
    "the tab clicked in is marked used"
  );

  BrowserTestUtils.removeTab(tab);
  await quiet(engine, observer);
});

add_task(async function a_tab_passed_on_the_way_to_another_is_not_used() {
  const { engine, observer } = await withSwitcherTabs();
  const second = BrowserTestUtils.addTab(
    gBrowser,
    "data:text/html,%3Ctitle%3ESecond%3C/title%3E"
  );
  await quiet(engine, observer);
  const [shownId, secondId] = [
    taggedId(gBrowser.selectedTab),
    taggedId(second),
  ];
  Assert.equal(await touchedAt(engine, shownId), 0, "never used yet");

  // Ctrl+Tab to the new tab and straight back, as a person who overshoots.
  for (const to of [second, gBrowser.selectedTab]) {
    const selected = BrowserTestUtils.waitForEvent(
      gBrowser.tabContainer,
      "TabSelect"
    );
    EventUtils.synthesizeKey("VK_TAB", { ctrlKey: true });
    EventUtils.synthesizeKey("VK_CONTROL", { type: "keyup" });
    await within(selected, 10_000, "Ctrl+Tab's selection");
    Assert.equal(gBrowser.selectedTab, to, "Ctrl+Tab went where expected");
  }

  // The tab returned to is marked once it has been shown long enough, which
  // is later than the tab passed would have been.
  await TestUtils.waitForCondition(
    async () => (await touchedAt(engine, shownId)) > 0,
    "the tab returned to is marked used"
  );
  Assert.equal(
    await touchedAt(engine, secondId),
    0,
    "the tab passed on the way is not"
  );

  BrowserTestUtils.removeTab(second);
  await quiet(engine, observer);
});
