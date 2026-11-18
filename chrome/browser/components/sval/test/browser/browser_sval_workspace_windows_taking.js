/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */
/* import-globals-from sval_workspace_windows_helpers.js */

/**
 * Which workspace a window shows: tearing one off, new and restored windows,
 * and agents' workspaces, which no ordinary window takes.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_workspace_windows_helpers.js",
  this
);

add_setup(failOnConsoleErrors);

/**
 * The test profile opens a new window on `about:blank`
 * (`browser.startup.page` 0). Sval's default opens it on the home page, whose
 * startup tab is still loading when the window's restore asks whether it is
 * blank, so every window here opens as a user's does.
 */
add_setup(async function new_windows_open_on_the_home_page() {
  await SpecialPowers.pushPrefEnv({ clear: [["browser.startup.page"]] });
});

/**
 * Spec §10.7: a workspace can be torn off into its own window.
 *
 * These tasks open a real second browser window and let its own `SvalPanel`
 * start, because that panel is what is under test: the tear-off works
 * because the workspace reaches the per-window record a restart reads before
 * that panel runs at all.
 *
 * Every window of the profile takes its engine from `SvalEngine.forProfile`
 * and its settings from the profile's one store, so the new window reads the
 * document these tasks write into.
 */

/** @param {DOMWindow} win A torn-off window. @returns {string[]} its rows. */
function drawnIdsIn(win) {
  return Array.from(
    win.SvalPanel._els.tree.querySelectorAll(".sval-row:not(.sval-row-leaving)")
  ).map(row => row.dataset.nodeId);
}

/**
 * The whole of the tear-off: a window whose current workspace is the one asked
 * for, this window left exactly where it was, and not one node moved.
 *
 * The document is asserted byte for byte because tearing off changes the
 * view only: the new window materialises the workspace's tabs for itself,
 * matching by the node id each tab carries, and nothing is released,
 * reparented or deleted.
 */
add_task(async function tearing_off_a_workspace_opens_a_window_showing_it() {
  const { ids, engine } = await withSwitcherPanel({
    tabUrl: TITLED_TAB_URL,
  });
  const [first, second] = ids.workspaces;
  // Tabs outlive a task, and an earlier task's materialised tab carries a node
  // id from a document this one does not hold.
  const before = await treeJson(engine);

  const win = await tearOff(second);
  try {
    Assert.equal(
      SvalWindowWorkspace.of(win).id,
      second,
      "the new window shows the workspace that was torn off"
    );
    Assert.deepEqual(
      drawnIdsIn(win),
      [ids.tabs[1]],
      "and draws that workspace's children, which is its one tab"
    );
    Assert.equal(
      SessionStore.getCustomWindowValue(win, CURRENT_WORKSPACE_KEY),
      second,
      "recorded per window, which is what makes it survive a restart: the " +
        "new window's own startup wrote it, through the same key one reads"
    );
    Assert.ok(
      win.SvalPanel.observer?.tabFor(ids.tabs[1]),
      "the new window materialised that workspace's tab for itself"
    );

    Assert.equal(
      SvalWindowWorkspace.of(window).id,
      first,
      "this window did not move"
    );
    Assert.deepEqual(
      drawnIds(),
      [ids.tabs[0]],
      "and still draws its own workspace's children"
    );

    Assert.equal(
      await settleBoth(engine, win),
      before,
      "and the document is what it was: tearing off changes which window " +
        "shows a workspace, never the tree"
    );
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the test window closing"
    );
  }

  Assert.equal(
    await treeJson(engine),
    before,
    "closing the torn-off window leaves the tree intact — a window closing " +
      "is not its tabs closing, so no node goes with it"
  );
});

/**
 * A window opened on a workspace that has tabs lands on them, with no home
 * page tab of its own.
 */
add_task(async function a_window_opened_on_a_workspace_adds_no_home_tab() {
  const { ids, engine } = await withSwitcherPanel({
    tabUrl: TITLED_TAB_URL,
  });
  const [, second] = ids.workspaces;
  const before = await treeJson(engine);

  const win = await tearOff(second);
  Assert.equal(
    await settleBoth(engine, win),
    before,
    "the window's startup tab was filed nowhere"
  );
  Assert.deepEqual(
    win.gBrowser.tabs.map(tab => taggedId(tab) ?? "untagged"),
    [ids.tabs[1]],
    "and the window holds the workspace's one tab alone"
  );
});

/**
 * A window handed a workspace with tabs of its own, but opened on a page of
 * its own, as a link from another app opens one, keeps that page's tab. It
 * still reads as a blank tab with no history while the page loads, and only
 * a window opened on Firefox's default page has a startup tab restore may
 * close (`SvalRestore`'s `isDebris`).
 */
add_task(async function a_window_opened_on_a_page_keeps_it() {
  const { ids } = await withSwitcherPanel({
    tabUrl: TITLED_TAB_URL,
  });
  const second = ids.workspaces[1];

  // Held, so the page is still loading when the window's panel restores.
  const slow = ROOT + "sval_agent_slow.sjs";
  const key = crypto.randomUUID();
  const args = Cc["@mozilla.org/supports-string;1"].createInstance(
    Ci.nsISupportsString
  );
  args.data = `${slow}?hold=${key}`;
  const win = BrowserWindowTracker.openWindow({ args });
  SvalPanelModel.handWorkspaceTo(win, second);
  let released = false;
  try {
    await within(
      BrowserTestUtils.waitForEvent(win, "load"),
      20_000,
      "the window loading"
    );
    const page = win.gBrowser.tabs[0];
    await within(win.SvalPanel.started, 20_000, "the window's panel starting");
    Assert.equal(SvalWindowWorkspace.of(win).id, second, "on the workspace");
    Assert.ok(
      win.SvalPanel.observer?.tabFor(ids.tabs[1]),
      "which brought its own tab"
    );
    Assert.ok(page.isConnected, "and the page's tab stays");
    Assert.equal(win.gBrowser.selectedTab, page, "on screen");
    const loaded = BrowserTestUtils.browserLoaded(page.linkedBrowser);
    await fetch(`${slow}?release=${key}`);
    released = true;
    await within(loaded, 10_000, "the page loading");
  } finally {
    if (!released) {
      await fetch(`${slow}?release=${key}`);
    }
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the test window closing"
    );
  }
});

/**
 * Shift+click on a workspace's entry opens it in a new window, as its "Open in
 * new window" does, and a plain click on another entry switches this window.
 */
add_task(async function shift_click_opens_a_workspace_in_a_new_window() {
  const { ids } = await withSwitcherPanel({
    workspaces: 3,
    tabUrl: TITLED_TAB_URL,
  });
  const [first, second, third] = ids.workspaces;

  const win = await tearOff(second, { shiftClick: true });
  Assert.equal(
    SvalWindowWorkspace.of(win).id,
    second,
    "the new window shows the Shift+clicked workspace"
  );
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    first,
    "this window did not move"
  );

  const menu = await openSwitcher();
  const entry = menu.querySelector(`menu[data-workspace-id="${third}"]`);
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  entry.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
  await within(hidden, 10_000, "a click closing the switcher");
  await within(
    SvalPanel._switching?.idle() ?? Promise.resolve(),
    10_000,
    "the switch"
  );
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    third,
    "a click switched to it"
  );
});

/**
 * The workspaces whose switcher entries offer "Open in New Window".
 *
 * @param {Element} menu The open switcher.
 * @returns {string[]} the workspace ids it offers a window for.
 */
function openableIds(menu) {
  return Array.from(
    menu.querySelectorAll("[data-open-workspace-id]"),
    item => item.dataset.openWorkspaceId
  );
}

/**
 * A workspace has one window (spec §10.7). The switcher offers "Open in new
 * window" only for a workspace no window shows, and choosing a workspace
 * another window shows brings that window forward rather than moving this one
 * onto it. Asking for a window for an open workspace opens nothing.
 */
add_task(async function an_open_workspace_is_not_offered_a_second_window() {
  const { ids } = await withSwitcherPanel({
    tabUrl: TITLED_TAB_URL,
  });
  const [first, second] = ids.workspaces;

  const ours = menu =>
    openableIds(menu).filter(id => ids.workspaces.includes(id));
  let menu = await openSwitcher();
  Assert.deepEqual(
    ours(menu),
    [second],
    "the workspace this window shows is not offered a window of its own"
  );
  Assert.ok(
    menu.querySelector("[data-sval-new-workspace]"),
    "and the switcher is where a new workspace is made"
  );
  await closeSwitcher(menu);

  const win = await tearOff(second);
  // On Linux a test can neither raise a window (a raise carries the last real
  // input's time, `nsWindow::SetFocus`, and the window manager may refuse an
  // old one) nor send it a real input (a native click goes into GTK's own
  // queue, `nsWindow::SynthesizeNativeMouseEvent`), so which window the
  // product brings forward is asserted where a test can raise one.
  const raisable = AppConstants.platform != "linux";
  const opened = [];
  const watcher = { observe: subject => opened.push(subject) };
  let watching = false;
  try {
    menu = await openSwitcher();
    Assert.deepEqual(
      ours(menu),
      [],
      "with the other one open in a window, neither is offered one"
    );
    const listed = switcherEntries(menu).find(
      item => item.dataset.workspaceId === second
    );
    Assert.ok(listed, "while the open workspace is still listed, to go to");
    Assert.ok(
      listed.querySelector('[data-command="edit"]') &&
        !listed.querySelector("[data-open-workspace-id]"),
      "its submenu keeps its own commands, with no new window"
    );

    await activateWorkspace(menu, second);
    if (raisable) {
      await untilFocused(win, "choosing it brings its window forward");
    }
    Assert.equal(
      SvalWindowWorkspace.of(window).id,
      first,
      "and this window stays where it was"
    );
    Assert.equal(SvalWindowWorkspace.of(win).id, second, "as does that one");

    if (raisable) {
      window.focus();
      await untilFocused(window, "this window has focus again");
    }
    Services.obs.addObserver(watcher, "domwindowopened");
    watching = true;
    Assert.equal(
      SvalPanel._openWorkspaceInNewWindow(first),
      null,
      "the workspace this window shows gets no second window"
    );
    Assert.equal(
      SvalPanel._openWorkspaceInNewWindow(second),
      null,
      "nor does one another window shows"
    );
    if (raisable) {
      await untilFocused(win, "which comes forward instead");
    }
    Assert.deepEqual(opened, [], "and no window opened");
  } finally {
    // A failure before the watch began leaves nothing to remove, and
    // `removeObserver` throws for an observer it does not hold.
    if (watching) {
      Services.obs.removeObserver(watcher, "domwindowopened");
    }
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the test window closing"
    );
  }
});

/**
 * Whatever route a window takes onto a workspace, it never takes one another
 * window shows. A window handed this window's workspace, as an agent's or a
 * stale tear-off would be, shows a free one instead.
 */
add_task(async function a_window_handed_a_shown_workspace_takes_another() {
  const { ids, engine } = await withSwitcherPanel({
    tabUrl: TITLED_TAB_URL,
  });
  const [first, second] = ids.workspaces;
  // The profile's own workspace in a window of its own, so the second is
  // the one workspace no window shows.
  const torn = await tearOff(SvalTree.workspaceIds(SvalPanel.nodes)[0]);
  await settleBoth(engine, torn);
  const before = await treeJson(engine);

  const opening = BrowserTestUtils.domWindowOpenedAndLoaded();
  const handed = window.OpenBrowserWindow();
  SvalPanelModel.handWorkspaceTo(handed, first);
  const win = await within(opening, 20_000, "the handed window's opening");
  try {
    await within(
      win.SvalPanel.started,
      20_000,
      "the handed window's panel starting"
    );
    Assert.equal(
      SvalWindowWorkspace.of(win).id,
      second,
      "the new window shows the workspace no window shows"
    );
    Assert.equal(
      SvalWindowWorkspace.of(window).id,
      first,
      "and this one stays"
    );
    Assert.equal(
      await settleBoth(engine, win),
      before,
      "and nothing in the document moved"
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
 * Closes `win`, a torn-off window, once both windows have settled, and waits
 * for the session to keep it as the one window `undoCloseWindow` reopens.
 *
 * @param {object} engine
 * @param {DOMWindow} win
 */
async function closeForTheSession(engine, win) {
  await settleBoth(engine, win);
  await within(
    BrowserTestUtils.closeWindow(win),
    10_000,
    "the torn-off window closing"
  );
  await TestUtils.waitForCondition(
    () => SessionStore.getClosedWindowCount() == 1,
    "the session keeps the closed window"
  );
}

/**
 * Reopens the window the session kept, as History's "Reopen closed window"
 * does, and waits for its panel to have started.
 *
 * @returns {Promise<DOMWindow>}
 */
async function reopenClosedWindow() {
  const opening = BrowserTestUtils.domWindowOpenedAndLoaded();
  SessionStore.undoCloseWindow(0);
  const win = await within(opening, 20_000, "the reopened window's opening");
  atTaskEnd(async () => {
    if (!win.closed) {
      await within(
        BrowserTestUtils.closeWindow(win),
        10_000,
        "the reopened window closing"
      );
    }
  });
  await within(
    win.SvalPanel.started,
    20_000,
    "the reopened window's panel starting"
  );
  return win;
}

/** Forgets every closed window, before the task and after it. */
function forgetClosedWindows() {
  const forget = () => {
    for (const { closedId } of SessionStore.getClosedWindowData()) {
      SessionStore.forgetClosedWindowById(closedId);
    }
  };
  forget();
  atTaskEnd(forget);
}

/**
 * A window the session brings back remembering a workspace another window
 * shows, as the second of two windows a session saved on one workspace, holds
 * that workspace's tabs as the session restored them. It takes a free
 * workspace, materialises that one, and lets the restored tabs go, with every
 * node kept.
 */
add_task(async function a_window_moved_off_its_remembered_workspace_lets_go() {
  const { ids, engine } = await withSwitcherPanel({
    tabUrl: TITLED_TAB_URL,
  });
  const [first, second] = ids.workspaces;
  forgetClosedWindows();
  // The profile's own workspace in a window of its own, so the second is
  // the one workspace no window shows.
  const torn = await tearOff(SvalTree.workspaceIds(SvalPanel.nodes)[0]);
  await settleBoth(engine, torn);

  // A window on the first workspace, closed, while this one shows the
  // second; then this window goes back to the first.
  await within(SvalPanel.switchTo(second), 10_000, "the switch away");
  await closeForTheSession(engine, await tearOff(first));
  await within(SvalPanel.switchTo(first), 10_000, "the switch back");
  await settleBoth(engine, torn);
  const before = await treeJson(engine);

  const win = await reopenClosedWindow();
  Assert.equal(
    SvalWindowWorkspace.of(win).id,
    second,
    "the window shows the workspace no window shows"
  );
  Assert.deepEqual(
    win.gBrowser.tabs.map(taggedId).filter(Boolean),
    [ids.tabs[1]],
    "and holds that workspace's tab and none of the one it remembered"
  );
  Assert.equal(
    await settleBoth(engine, win),
    before,
    "and nothing in the document moved"
  );
});

/**
 * A window the session brings back on the workspace it remembers can hold a
 * tab whose node the tree has since moved to another workspace. The window
 * keeps its workspace and its workspace's tab, and lets the other tab go,
 * with every node kept.
 */
add_task(async function a_restored_window_lets_go_of_another_workspaces_tab() {
  const { ids, engine } = await withSwitcherPanel({
    tabUrl: TITLED_TAB_URL,
  });
  const [first, second] = ids.workspaces;
  forgetClosedWindows();
  // The profile's own workspace in a window of its own, so the second is
  // the one workspace no window shows.
  const torn = await tearOff(SvalTree.workspaceIds(SvalPanel.nodes)[0]);
  await settleBoth(engine, torn);

  // A window on the second workspace with a second tab of its own, closed;
  // then that tab's node moves to the first workspace.
  const away = await tearOff(second);
  const extra = await within(
    BrowserTestUtils.openNewForegroundTab(
      away.gBrowser,
      TITLED_TAB_URL.replace("%s", "3")
    ),
    10_000,
    "a second tab in the torn-off window"
  );
  await TestUtils.waitForCondition(
    () => taggedId(extra),
    "the second tab is filed"
  );
  const moved = taggedId(extra);
  await closeForTheSession(engine, away);
  await engine.mutate({
    kind: "moveNode",
    id: moved,
    newParent: first,
    before: null,
    after: null,
    now: Date.now(),
  });
  await SvalPanel.refresh();
  await settleBoth(engine, torn);
  const before = await treeJson(engine);

  const win = await reopenClosedWindow();
  Assert.equal(
    SvalWindowWorkspace.of(win).id,
    second,
    "the window shows the workspace it remembers"
  );
  Assert.deepEqual(
    win.gBrowser.visibleTabs.map(taggedId).filter(Boolean),
    [ids.tabs[1]],
    "and shows that workspace's tab and none of another's"
  );
  Assert.equal(
    await settleBoth(engine, win),
    before,
    "and nothing in the document moved"
  );
});

/**
 * A window the session reopens remembering a workspace another window shows
 * holds that workspace's tab as the session restores it, carrying the node
 * id the other window's tab carries. It takes the free workspace and lets the
 * restored tab go, and the document gains no copy of that tab.
 */
add_task(async function a_reopened_window_files_no_copy_of_a_shown_tab() {
  const { ids, engine } = await withSwitcherPanel({
    tabUrl: TITLED_TAB_URL,
    workspaces: 3,
  });
  const [first, second, third] = ids.workspaces;
  // The profile's own workspace in a window of its own, so it is not free.
  const torn = await tearOff(SvalTree.workspaceIds(SvalPanel.nodes)[0]);
  await settleBoth(engine, torn);
  const forget = () => {
    for (const { closedId } of SessionStore.getClosedWindowData()) {
      SessionStore.forgetClosedWindowById(closedId);
    }
  };
  forget();
  atTaskEnd(forget);

  // A window on the first workspace, closed while this one shows the third;
  // then another window on the first holds its tab, so the second is the one
  // workspace no window shows.
  await within(SvalPanel.switchTo(third), 10_000, "the switch away");
  const closing = await tearOff(first);
  await settleBoth(engine, closing);
  await within(
    BrowserTestUtils.closeWindow(closing),
    10_000,
    "the torn-off window closing"
  );
  await TestUtils.waitForCondition(
    () => SessionStore.getClosedWindowCount() == 1,
    "the session keeps the closed window"
  );
  const holder = await tearOff(first);
  const before = await settleBoth(engine, holder);

  const opening = BrowserTestUtils.domWindowOpenedAndLoaded();
  SessionStore.undoCloseWindow(0);
  const win = await within(opening, 20_000, "the reopened window's opening");
  atTaskEnd(async () => {
    if (!win.closed) {
      await within(
        BrowserTestUtils.closeWindow(win),
        10_000,
        "the reopened window closing"
      );
    }
  });
  await within(
    win.SvalPanel.started,
    20_000,
    "the reopened window's panel starting"
  );
  Assert.equal(
    SvalWindowWorkspace.of(win).id,
    second,
    "the reopened window shows the workspace no window shows"
  );
  await settleBoth(engine, holder);
  Assert.equal(
    await settleBoth(engine, win),
    before,
    "and nothing in the document moved"
  );
  Assert.deepEqual(
    win.gBrowser.tabs.map(taggedId).filter(Boolean),
    [ids.tabs[1]],
    "and it holds that workspace's tab and none of the one it remembered"
  );
});

/**
 * A new window when every workspace already has one gets a new, nameless
 * workspace of its own, which is what a new window is for.
 */
add_task(async function a_new_window_with_every_workspace_open_gets_its_own() {
  const { ids, engine } = await withSwitcherPanel({
    tabUrl: TITLED_TAB_URL,
  });
  const [, second] = ids.workspaces;
  const [home] = SvalTree.workspaceIds(SvalPanel.nodes);

  // Every one of the user's workspaces in a window, the profile's own too.
  const torn = await tearOff(second);
  const tornHome = await tearOff(home);
  let win;
  try {
    win = await within(
      BrowserTestUtils.openNewBrowserWindow(),
      20_000,
      "a new window's opening"
    );
    await within(
      win.SvalPanel.started,
      20_000,
      "the new window's panel starting"
    );
    const shown = SvalWindowWorkspace.of(win).id;
    leftWhenTheTaskEnds([shown]);
    Assert.ok(
      shown && !ids.workspaces.includes(shown) && shown !== home,
      "the new window shows a workspace of its own"
    );
    const nodes = JSON.parse(await treeJson(engine));
    Assert.equal(nodes[shown]?.kind, "workspace", "a real one");
    Assert.equal(nodes[shown].content.name, "", "with no name sval chose");
  } finally {
    if (win) {
      await within(
        BrowserTestUtils.closeWindow(win),
        10_000,
        "the test window closing"
      );
    }
    for (const each of [tornHome, torn]) {
      await within(
        BrowserTestUtils.closeWindow(each),
        10_000,
        "the torn-off window closing"
      );
    }
  }
});

/**
 * A new window with every one of the user's workspaces open never takes an
 * agent's workspace that has no window: it gets a new, nameless workspace of
 * the user's own, as when every workspace is open.
 */
add_task(async function a_new_window_never_takes_an_agents_workspace() {
  const { ids, engine } = await withSwitcherPanel({
    tabUrl: TITLED_TAB_URL,
  });
  const [, second] = ids.workspaces;
  const [home] = SvalTree.workspaceIds(SvalPanel.nodes);
  const agent = await addAgentWorkspace(engine);
  await SvalPanel.refresh();

  // Every one of the user's workspaces in a window, the profile's own too.
  const torn = await tearOff(second);
  const tornHome = await tearOff(home);
  let win;
  try {
    win = await within(
      BrowserTestUtils.openNewBrowserWindow(),
      20_000,
      "a new window's opening"
    );
    await within(
      win.SvalPanel.started,
      20_000,
      "the new window's panel starting"
    );
    const shown = SvalWindowWorkspace.of(win).id;
    leftWhenTheTaskEnds([shown]);
    Assert.notEqual(shown, agent, "the agent's workspace is not taken");
    Assert.ok(
      shown && !ids.workspaces.includes(shown) && shown !== home,
      "the new window shows a workspace of its own"
    );
    const nodes = JSON.parse(await treeJson(engine));
    Assert.equal(nodes[shown]?.kind, "workspace", "a real one");
    Assert.ok(!nodes[shown].agent, "the user's, not an agent's");
    Assert.equal(nodes[shown].content.name, "", "with no name sval chose");
    Assert.ok(
      !win.document.documentElement.hasAttribute("data-sval-agent"),
      "and the window is not marked as an agent's"
    );
  } finally {
    if (win) {
      await within(
        BrowserTestUtils.closeWindow(win),
        10_000,
        "the test window closing"
      );
    }
    for (const each of [tornHome, torn]) {
      await within(
        BrowserTestUtils.closeWindow(each),
        10_000,
        "the torn-off window closing"
      );
    }
  }
});

/**
 * The switcher lists agents' workspaces apart from the user's, after them,
 * under an "Agent Workspaces" caption: one menu for each app, wearing the
 * robot face, with a row for each of its workspaces (decision 1998).
 */
add_task(async function agents_workspaces_have_their_own_section() {
  const { ids, engine } = await withSwitcherPanel();
  const [home] = SvalTree.workspaceIds(SvalPanel.nodes);
  const agent = await addAgentWorkspace(engine);
  const again = await addAgentWorkspace(engine);
  // After the agent's in sibling order, so the section is a regrouping of the
  // document's order.
  const third = await engine.mutate({
    kind: "addWorkspace",
    name: "Workspace 3",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  leftWhenTheTaskEnds([third]);
  await SvalPanel.refresh();

  const menu = await openSwitcher();
  try {
    Assert.deepEqual(
      switcherEntries(menu).map(item => item.dataset.workspaceId),
      [home, ids.workspaces[0], ids.workspaces[1], third, agent, again],
      "the user's workspaces first, the shown one in its place, then the " +
        "agent's"
    );
    const captions = menu.querySelectorAll(":scope > menucaption");
    Assert.equal(captions.length, 1, "one caption in the list");
    const [caption] = captions;
    Assert.ok(caption.getAttribute("label"), "named");
    Assert.equal(
      caption.previousElementSibling.localName,
      "menuseparator",
      "set apart from the user's workspaces"
    );
    const apps = menu.querySelectorAll(":scope > menu[data-agent-app]");
    Assert.equal(apps.length, 1, "one menu for the app");
    const [app] = apps;
    Assert.equal(app, caption.nextElementSibling, "heading the agents'");
    Assert.equal(app.dataset.agentApp, "Test Agent", "named for the app");
    Assert.equal(
      app.getAttribute("image"),
      "chrome://browser/content/sval/agent-robot.svg",
      "which wears the robot face"
    );
    const rows = app.querySelectorAll(
      ":scope > menupopup > menu[data-workspace-id]"
    );
    Assert.deepEqual(
      Array.from(rows, row => row.dataset.workspaceId).sort(),
      [agent, again].sort(),
      "a row for each of its workspaces"
    );
    for (const id of [ids.workspaces[1], third]) {
      Assert.ok(
        !menu
          .querySelector(`[data-workspace-id="${CSS.escape(id)}"]`)
          .hasAttribute("image"),
        "the user's own wear no robot"
      );
    }
    Assert.deepEqual(
      openableIds(menu),
      [home, ids.workspaces[1], third, agent, again],
      "Open in New Window is offered for the agents' workspaces too"
    );
  } finally {
    await closeSwitcher(menu);
  }
});

/**
 * An agent workspace's row says the folder its session ran in and the model
 * it gave, and the rows put the one a session used last first.
 */
add_task(async function an_agent_workspaces_row_says_where_it_ran() {
  const { SvalAgents } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
  );
  const { engine } = await withSwitcherPanel();
  await agentAccessForTask();
  const older = await addAgentWorkspace(engine);
  const newer = await addAgentWorkspace(engine);
  const store = SvalAgents.store;
  const { agentId } = await store.pair({
    label: "Test Agent",
    workspaceId: older,
    task: "Test Agent",
    dir: "/work/sval",
    model: "Opus 5.5",
    lastUsed: Date.now() - 2 * 24 * 60 * 60 * 1000,
  });
  atTaskEnd(() => SvalAgents.unpair(agentId));
  await store.addWorkspace(agentId, newer, {
    task: "Test Agent",
    // Either separator, on every platform: the session spells it.
    dir: "C:\\Users\\someone\\notes\\",
    lastUsed: Date.now() - 60_000,
  });
  await SvalPanel.refresh();
  const menu = await openSwitcher();
  try {
    const rows = [
      ...menu.querySelectorAll(
        ":scope > menu[data-agent-app] > menupopup > menu[data-workspace-id]"
      ),
    ];
    Assert.deepEqual(
      rows.map(row => row.dataset.workspaceId),
      [newer, older],
      "the one used last first"
    );
    const [first, second] = rows.map(row => row.getAttribute("label"));
    Assert.ok(first.startsWith("Test Agent · notes · "), first);
    Assert.ok(second.startsWith("Test Agent · sval · Opus 5.5 · "), second);
  } finally {
    await closeSwitcher(menu);
  }
});

/**
 * An agent workspace's submenu stops the agent working there, as the card's
 * Stop agent does, and then resumes it.
 */
add_task(async function an_agent_workspaces_menu_stops_and_resumes_it() {
  const { SvalAgents } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
  );
  const { engine } = await withSwitcherPanel();
  await agentAccessForTask();
  const agent = await addAgentWorkspace(engine);
  const { agentId } = await SvalAgents.store.pair({
    label: "Test Agent",
    workspaceId: agent,
    task: "Test Agent",
  });
  atTaskEnd(() => SvalAgents.unpair(agentId));
  atTaskEnd(() => SvalPanel.settings.setAgentStopped(agent, false));
  await SvalPanel.refresh();
  const choose = async (label, what) => {
    const menu = await openSwitcher();
    const row = menu.querySelector(
      `menu[data-workspace-id="${CSS.escape(agent)}"]`
    );
    const item = row.querySelector('menuitem[data-command="stopAgent"]');
    Assert.equal(item.getAttribute("label"), label, `${what} is labelled`);
    await chooseMenuItem(item, menu, what);
  };
  await choose("Stop Agent", "Stop Agent");
  Assert.ok(SvalPanel.settings.isAgentStopped(agent), "the agent is stopped");
  await choose("Resume Agent", "Resume Agent");
  Assert.ok(!SvalPanel.settings.isAgentStopped(agent), "the agent goes on");
});

/**
 * An agent workspace's submenu opens the permissions of the agent that works
 * there, the one of several with the same name that owns this workspace.
 */
add_task(
  async function an_agent_workspaces_menu_opens_its_agents_permissions() {
    const { SvalAgents } = ChromeUtils.importESModule(
      "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
    );
    const { engine } = await withSwitcherPanel();
    await agentAccessForTask();
    const agent = await addAgentWorkspace(engine);
    const other = await SvalAgents.store.pair({ label: "Test Agent" });
    atTaskEnd(() => SvalAgents.unpair(other.agentId));
    const { agentId } = await SvalAgents.store.pair({
      label: "Test Agent",
      workspaceId: agent,
      task: "Test Agent",
    });
    atTaskEnd(() => SvalAgents.unpair(agentId));
    await SvalPanel.refresh();
    const menu = await openSwitcher();
    const item = menu
      .querySelector(`menu[data-workspace-id="${CSS.escape(agent)}"]`)
      .querySelector('menuitem[data-command="agentPermissions"]');
    Assert.ok(!item.hidden, "an agent's workspace offers its permissions");
    const opened = BrowserTestUtils.waitForNewTab(
      gBrowser,
      url => url.startsWith("about:preferences"),
      true
    );
    await chooseMenuItem(item, menu, "the agent's permissions");
    const tab = expectOpened(await within(opened, 20_000, "Settings opening"));
    const page = tab.linkedBrowser.contentWindow;
    await TestUtils.waitForCondition(
      () => page.document.getElementById("sval-agent-page")?.checkVisibility(),
      "the agent's page shows"
    );
    Assert.equal(
      page.location.hash,
      `#svalAgents-agent?id=${encodeURIComponent(agentId)}`,
      "the page is the agent that owns the workspace"
    );
  }
);

/**
 * An ordinary new window holds the workspace it took, as a switch to it
 * does, and lands on its tab rather than the new tab it opened with. No other
 * window shows that workspace (spec §10.7), so nothing is opened twice.
 */
add_task(async function an_ordinary_new_window_holds_its_workspace() {
  const { ids, engine } = await withSwitcherPanel({
    tabUrl: TITLED_TAB_URL,
  });
  const [, second] = ids.workspaces;
  const [home] = SvalTree.workspaceIds(SvalPanel.nodes);
  // The profile's own workspace in a window of its own, so the first no
  // window shows is one made here.
  const tornHome = await tearOff(home);
  const before = await treeJson(engine);

  // ⌘N, with nothing handed to it.
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    20_000,
    "a new window's opening"
  );
  try {
    await within(
      win.SvalPanel.started,
      20_000,
      "the new window's panel starting"
    );
    Assert.equal(
      SvalWindowWorkspace.of(win).id,
      second,
      "it shows the first workspace no window shows, having remembered none"
    );
    Assert.deepEqual(
      win.gBrowser.tabs.map(tab => taggedId(tab) ?? "untagged"),
      [ids.tabs[1]],
      "and holds a tab for each of that workspace's nodes, and nothing else"
    );
    Assert.equal(
      taggedId(win.gBrowser.selectedTab),
      ids.tabs[1],
      "with that workspace's tab on screen"
    );
    Assert.ok(
      !gBrowser.tabs.some(tab => taggedId(tab) === ids.tabs[1]),
      "and this window holds none of them"
    );
    Assert.equal(
      await treeJson(engine),
      before,
      "and its own blank tab was filed nowhere"
    );
  } finally {
    for (const each of [win, tornHome]) {
      await within(
        BrowserTestUtils.closeWindow(each),
        10_000,
        "the test window closing"
      );
    }
  }
});

/**
 * A workspace another device closed between the menu being built and the entry
 * being pressed opens no window, and says nothing.
 *
 * The same no-op and redraw {@link SvalPanel._switchToOnce} answers with
 * (spec §10.7). A window opened on something else would be a window nobody
 * asked for, and an explanation would describe a state that has gone.
 */
add_task(async function tearing_off_a_vanished_workspace_opens_nothing() {
  const { ids, engine } = await withSwitcherPanel();
  const [first, second] = ids.workspaces;

  await engine.mutate({ kind: "remove", id: ids.tabs[1] });
  await engine.mutate({ kind: "remove", id: second });
  await SvalPanel.refresh();

  const opened = [];
  const watcher = { observe: subject => opened.push(subject) };
  Services.obs.addObserver(watcher, "domwindowopened");
  try {
    // Emptied so the redraw is observable.
    SvalPanel._els.tree.textContent = "";
    Assert.equal(
      SvalPanel._openWorkspaceInNewWindow(second),
      null,
      "nothing is opened for a workspace the document no longer holds"
    );
  } finally {
    Services.obs.removeObserver(watcher, "domwindowopened");
  }
  Assert.deepEqual(opened, [], "and no window was opened at all");
  Assert.deepEqual(
    drawnIds(),
    [ids.tabs[0]],
    "the panel redrew instead, which is what takes the entry away"
  );
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    first,
    "and this window did not move"
  );
});
