/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * Split view in a real window (split-view spec §6, §9, §10): what the user
 * sees in the content area and the panel after acting through Firefox's own
 * split UI, and that the tree, which the next launch and every other device
 * read, holds the same splits. The writes themselves are
 * `test/xpcshell/test_sval_splits.js`'s.
 */

const { SvalWorkspaceJar } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalWorkspaceJar.sys.mjs"
);
const SvalPanelModel = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);
const SvalTree = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTree.sys.mjs"
);

/** A page with one link, to PAGE. */
const LINK_PAGE =
  "data:text/html,<title>Links</title>" +
  encodeURIComponent(`<a id="link" href="${PAGE}">A page</a>`);

/** The workspace the window shows between tasks. */
let home = null;

/**
 * The window's own panel, engine and tab observer, showing a workspace of
 * this file's own, so the tabs a task counts are this file's and what is
 * asserted is the real panel and observer.
 */
add_setup(async function () {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  home = await SvalPanel.engine.mutate({
    kind: "addWorkspace",
    name: "Home",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  expectWorkspaceTabs();
  Assert.ok(
    await within(
      SvalWindowWorkspace.of(window).switchTo(home),
      10_000,
      "the switch to Home"
    ),
    "the window shows this file's workspace"
  );
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "the observer filing the switch's tabs"
  );

  registerCleanupFunction(() => {
    // Firefox records the first split it shows, as its own tests clear.
    Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed");
    gBrowser.defaultUserContextId = 0;
  });
});

/**
 * Deletes the nodes of `ids` when the task ends. The harness takes a task's
 * tabs out of the window without closing them as a person does, so their
 * nodes stay, and the next switch home would bring them back.
 *
 * @param {Function} ids Answers the node ids, once the task has them.
 */
function forgetAtTaskEnd(ids) {
  atTaskEnd(async () => {
    const nodes = await settledNodes();
    const ops = ids()
      .filter(id => id && nodes[id])
      .map(id => ({ kind: "remove", id }));
    if (ops.length) {
      await SvalPanel.engine.mutate({ kind: "batch", ops, now: Date.now() });
    }
  });
}

/** @returns {Promise<object>} the tree's nodes once the window is quiet. */
async function settledNodes() {
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  return (await SvalPanel.engine.tree()).nodes ?? {};
}

/**
 * The split nodes of the tree, each as the node ids of its tabs in pane order.
 *
 * @param {object} nodes
 * @returns {string[][]}
 */
function treeSplits(nodes) {
  const byParent = SvalTree.childrenByParent(nodes);
  return Object.keys(nodes)
    .filter(id => nodes[id].kind === SvalTree.SPLIT)
    .map(id => byParent.get(id) ?? []);
}

/** @returns {string[][]} the window's splits, by node id. */
function windowSplits() {
  return gBrowser.splitViews
    .map(split => split.tabs.map(tab => SvalPanel.observer.nodeIdFor(tab)))
    .filter(ids => ids.length);
}

/**
 * Waits until the tree and the window hold the same splits, `expected`, of
 * the tabs this window holds. An earlier task's tabs leave the window with
 * the harness's cleanup and their nodes may stay.
 *
 * @param {string[][]} expected
 * @param {string} what
 */
async function untilSplits(expected, what) {
  const key = list => JSON.stringify(list.map(ids => ids.join(" ")).sort());
  const held = id =>
    gBrowser.tabs.some(tab => SvalPanel.observer.nodeIdFor(tab) === id);
  await TestUtils.waitForCondition(async () => {
    const nodes = await settledNodes();
    return (
      key(treeSplits(nodes).filter(panes => panes.some(held))) ===
        key(expected) && key(windowSplits()) === key(expected)
    );
  }, what);
}

/**
 * @returns {string[]} the node ids the panel draws, each pane of a split's
 *   row in its place.
 */
function drawnTabIds() {
  return Array.from(
    SvalPanel._els.tree.querySelectorAll(
      ".sval-row:not(.sval-row-leaving), .sval-split-pane"
    ),
    element => element.dataset.nodeId
  );
}

/** @returns {Element[]} the content area's panels on screen, left to right. */
function panesOnScreen() {
  return Array.from(
    gBrowser.tabpanels.querySelectorAll(".split-view-panel-active")
  ).sort(
    (a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left
  );
}

/** @returns {number} the splitters on screen. */
function splittersOnScreen() {
  return Array.from(
    gBrowser.tabpanels.querySelectorAll(".split-view-splitter")
  ).filter(splitter => BrowserTestUtils.isVisible(splitter)).length;
}

/**
 * Opens `count` tabs on test pages in the workspace the window shows.
 *
 * @param {number} count
 * @returns {Promise<{tabs: object[], ids: string[]}>}
 */
async function openTabs(count) {
  const tabs = [];
  for (let i = 0; i < count; i++) {
    tabs.push(
      await within(
        BrowserTestUtils.openNewForegroundTab(
          gBrowser,
          // A page of its own origin, as a restore reopens no top-level data:.
          `${PAGE}?pane=${i}`
        ),
        10_000,
        "a tab opening"
      )
    );
  }
  await settledNodes();
  const ids = tabs.map(tab => SvalPanel.observer.nodeIdFor(tab));
  forgetAtTaskEnd(() => ids);
  return { tabs, ids };
}

/**
 * Writes a split of `ids` into the tree, as another device's pass or an
 * import brings one in, and redraws as a pass does.
 *
 * @param {string[]} ids Tab ids in the workspace the window shows.
 * @returns {Promise<string>} the split's id.
 */
async function splitInTree(ids) {
  const nodes = await settledNodes();
  const split = crypto.randomUUID();
  const parent = nodes[ids[0]].placement.parent;
  const ops = [
    { kind: "addSplit", parent, id: split, before: null, after: ids[0] },
  ];
  let last = null;
  for (const id of ids) {
    ops.push({
      kind: "moveNode",
      id,
      newParent: split,
      before: last,
      after: null,
    });
    last = id;
  }
  await SvalPanel.engine.mutate({ kind: "batch", ops, now: Date.now() });
  await SvalPanel.refresh();
  return split;
}

/**
 * A second workspace, removed when the task ends with the window back home.
 *
 * @param {object} [options]
 * @param {boolean} [options.isolated]
 * @returns {Promise<string>}
 */
async function otherWorkspace({ isolated = false } = {}) {
  // Switching back materialises the workspace's tabs again.
  expectWorkspaceTabs();
  const id = await SvalPanel.engine.mutate({
    kind: "addWorkspace",
    name: "Elsewhere",
    isolated,
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  atTaskEnd(async () => {
    await SvalWindowWorkspace.of(window).switchTo(home);
    await within(
      SvalPanel.observer.settled(),
      10_000,
      "SvalPanel.observer settling"
    );
    if ((await SvalPanel.engine.tree()).nodes?.[id]) {
      await removeWorkspace(id);
    }
    await SvalPanel.refresh();
  });
  await SvalPanel.refresh();
  return id;
}

/**
 * Opens the content area's context menu on PAGE's link and splits it.
 *
 * @param {object} browser The page's browser.
 * @returns {Promise<object>} the link's tab.
 */
async function openLinkInSplitView(browser) {
  const menu = document.getElementById("contentAreaContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#link",
    { type: "contextmenu", button: 2 },
    browser
  );
  await within(shown, 10_000, "the link's context menu");
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, PAGE, true);
  const item = document.getElementById("context-openlinkinsplitview");
  Assert.ok(!item.hidden, "the link menu offers Open Link in Split View");
  menu.activateItem(item);
  return within(opened, 10_000, "the link's tab opening");
}

add_task(async function a_link_opened_in_split_view_shows_beside_its_page() {
  const page = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, LINK_PAGE),
    10_000,
    "the page opening"
  );
  const link = await openLinkInSplitView(page.linkedBrowser);
  const [pageId, linkId] = [page, link].map(tab =>
    SvalPanel.observer.nodeIdFor(tab)
  );
  forgetAtTaskEnd(() => [pageId, linkId]);

  await untilSplits([[pageId, linkId]], "the page and the link are a split");
  Assert.equal(
    panesOnScreen().length,
    2,
    "two pages are on screen, side by side"
  );
  Assert.equal(splittersOnScreen(), 1, "with a divider between them");
  Assert.deepEqual(
    drawnTabIds().filter(id => id === pageId || id === linkId),
    [pageId, linkId],
    "the panel shows both pages, in pane order"
  );
});

add_task(async function two_splits_made_as_their_tabs_open_both_stay() {
  // As Firefox's own callers do, splitting tabs whose filing is still
  // queued, with one split's write still to come when the next is made.
  const tabs = [1, 2, 3, 4].map(i =>
    BrowserTestUtils.addTab(
      gBrowser,
      `data:text/html,<title>Quick ${i}</title>`
    )
  );
  gBrowser.addTabSplitView([tabs[0], tabs[2]]);
  gBrowser.addTabSplitView([tabs[1], tabs[3]]);
  await settledNodes();
  const id = tab => SvalPanel.observer.nodeIdFor(tab);
  const ids = tabs.map(id);
  forgetAtTaskEnd(() => ids);
  await untilSplits(
    [
      [id(tabs[0]), id(tabs[2])],
      [id(tabs[1]), id(tabs[3])],
    ],
    "both splits are on screen and in the tree"
  );
});

add_task(async function a_split_the_session_store_restores_stays() {
  // The session store opens a restored split's tabs already in their split,
  // with no `TabMove` (`MozTabSplitViewWrapper.addTabs`).
  const before = new Set(gBrowser.tabs);
  const splitViewId = SessionStore.getNextSplitViewId();
  const entry = pane => ({
    entries: [
      {
        url: `${PAGE}?restored=${pane}`,
        triggeringPrincipal_base64: E10SUtils.SERIALIZED_SYSTEMPRINCIPAL,
      },
    ],
    splitViewId,
  });
  SessionStore.setWindowState(
    window,
    {
      windows: [
        {
          tabs: [entry(0), entry(1)],
          splitViews: [{ id: splitViewId, numberOfTabs: 2 }],
        },
      ],
    },
    false
  );
  await TestUtils.waitForCondition(
    () => gBrowser.tabs.filter(tab => !before.has(tab)).length == 2,
    "the restored tabs are in the window"
  );
  const tabs = gBrowser.tabs.filter(tab => !before.has(tab));
  expectOpened(...tabs);
  await settledNodes();
  const ids = tabs.map(tab => SvalPanel.observer.nodeIdFor(tab));
  forgetAtTaskEnd(() => ids);
  await untilSplits([ids], "the restored split is on screen and in the tree");
});

add_task(async function reverse_and_separate_from_the_split_menu() {
  const { tabs, ids } = await openTabs(2);
  await splitInTree(ids);
  await untilSplits([ids], "the split is shown");
  await within(
    BrowserTestUtils.switchTab(gBrowser, tabs[0]),
    10_000,
    "the tab switch"
  );

  document.getElementById("splitViewCmd_reverseTabs").doCommand();
  await untilSplits([ids.toReversed()], "Reverse swaps the panes");
  Assert.deepEqual(
    panesOnScreen().map(panel =>
      gBrowser.getTabForBrowser(panel.querySelector("browser"))
    ),
    tabs.toReversed(),
    "on screen too"
  );

  document.getElementById("splitViewCmd_separateTabs").doCommand();
  await untilSplits([], "Separate leaves no split");
  const nodes = await settledNodes();
  for (const id of ids) {
    Assert.equal(
      nodes[id]?.placement.parent,
      home,
      "each page is an ordinary tab of the workspace"
    );
  }
  Assert.ok(
    !gBrowser.tabpanels.hasAttribute("splitview"),
    "and one page fills the content area"
  );
});

add_task(async function closing_one_pane_of_two_leaves_one_page() {
  const { tabs, ids } = await openTabs(2);
  await splitInTree(ids);
  await untilSplits([ids], "the split is shown");

  BrowserTestUtils.removeTab(tabs[0]);
  await untilSplits([], "the split is gone");
  const nodes = await settledNodes();
  Assert.ok(!nodes[ids[0]], "the closed pane's tab is closed");
  Assert.equal(
    nodes[ids[1]].placement.parent,
    home,
    "the other is an ordinary tab"
  );
  Assert.ok(drawnIds().includes(ids[1]), "with a row of its own");
});

/**
 * A pane Firefox's recently-closed list hands back is one tab again, under
 * its own node: the tree and the window agree on the split it is in, and no
 * second node holds its page.
 */
add_task(async function a_reopened_pane_comes_back_once_in_one_split() {
  const { tabs, ids } = await openTabs(3);
  await splitInTree(ids);
  await untilSplits([ids], "the split of three is shown");

  const closedBefore = SessionStore.getClosedTabCountForWindow(window);
  BrowserTestUtils.removeTab(tabs[1]);
  await untilSplits([[ids[0], ids[2]]], "the split of two is left");
  await TestUtils.waitForCondition(
    () => SessionStore.getClosedTabCountForWindow(window) > closedBefore,
    "Firefox keeps the closed pane"
  );

  const reopened = SessionStore.undoCloseTab(window, 0);
  await within(
    BrowserTestUtils.waitForEvent(reopened, "SSTabRestored"),
    10_000,
    "the reopened pane's restore"
  );
  expectOpened(reopened);
  const nodes = await settledNodes();
  Assert.equal(
    SvalPanel.observer.nodeIdFor(reopened),
    ids[1],
    "it comes back as its own node"
  );
  const url = nodes[ids[1]]?.content?.url;
  Assert.equal(
    Object.values(nodes).filter(node => node.content?.url === url).length,
    1,
    "one node holds its page"
  );
  const key = list => JSON.stringify(list.map(p => p.join(" ")).sort());
  const held = id =>
    gBrowser.tabs.some(tab => SvalPanel.observer.nodeIdFor(tab) === id);
  await TestUtils.waitForCondition(
    async () =>
      key(treeSplits(await settledNodes()).filter(p => p.some(held))) ===
      key(windowSplits()),
    "the tree and the window hold the same splits"
  );
});

add_task(async function three_and_four_panes_show_side_by_side() {
  for (const count of [3, 4]) {
    const { tabs, ids } = await openTabs(count);
    await splitInTree(ids);
    await untilSplits([ids], `the split of ${count} is shown`);
    await within(
      BrowserTestUtils.switchTab(gBrowser, tabs[1]),
      10_000,
      "the tab switch"
    );
    await TestUtils.waitForCondition(
      () => panesOnScreen().length === count,
      `${count} pages on screen`
    );
    Assert.deepEqual(
      panesOnScreen().map(panel =>
        gBrowser.getTabForBrowser(panel.querySelector("browser"))
      ),
      tabs,
      "in pane order, left to right"
    );
    Assert.equal(
      splittersOnScreen(),
      count - 1,
      "with a divider between each two"
    );
    Assert.deepEqual(
      drawnTabIds().filter(id => ids.includes(id)),
      ids,
      "and the panel shows every pane in order"
    );
    for (const tab of tabs) {
      BrowserTestUtils.removeTab(tab);
    }
    await untilSplits([], "the split's tabs are closed");
  }
});

add_task(async function a_split_comes_back_whole_after_switching_away() {
  const { tabs, ids } = await openTabs(2);
  await splitInTree(ids);
  await untilSplits([ids], "the split is shown");
  Assert.equal(gBrowser.selectedTab, tabs[1], "a pane is on screen");
  const before = JSON.stringify(await settledNodes());

  const elsewhere = await otherWorkspace();
  Assert.ok(
    await SvalWindowWorkspace.of(window).switchTo(elsewhere),
    "the window switched away"
  );
  await settledNodes();
  Assert.ok(
    tabs.every(tab => !gBrowser.visibleTabs.includes(tab)),
    "the split went out of sight with its workspace"
  );

  Assert.ok(await SvalWindowWorkspace.of(window).switchTo(home), "and back");
  await untilSplits([ids], "the split is back, both panes in order");
  await TestUtils.waitForCondition(
    () => gBrowser.selectedTab.splitview,
    "the split is on screen"
  );
  Assert.equal(panesOnScreen().length, 2, "both pages on screen");
  const after = await settledNodes();
  Assert.deepEqual(
    treeSplits(after),
    treeSplits(JSON.parse(before)),
    "and the switch wrote no change to it"
  );
});

add_task(async function a_divider_let_go_keeps_its_place_after_a_switch() {
  const { tabs, ids } = await openTabs(2);
  const split = await splitInTree(ids);
  await untilSplits([ids], "the split is shown");
  await within(
    BrowserTestUtils.switchTab(gBrowser, tabs[0]),
    10_000,
    "the tab switch"
  );
  await TestUtils.waitForCondition(
    () => splittersOnScreen() === 1,
    "the divider is on screen"
  );

  // Dragged as Firefox's own splitter tests drag it
  // (`browser_tab_splitview_resize.js`).
  const splitter = gBrowser.tabpanels.splitViewSplitter;
  AccessibilityUtils.setEnv({ mustHaveAccessibleRule: false });
  EventUtils.synthesizeMouseAtCenter(splitter, { type: "mousedown" });
  EventUtils.synthesizeMouse(splitter, 150, 0, { type: "mousemove" });
  EventUtils.synthesizeMouse(splitter, 0, 0, { type: "mouseup" });
  AccessibilityUtils.resetEnv();
  await TestUtils.waitForCondition(
    async () => (await settledNodes())[split]?.content?.shares,
    "the widths are written"
  );
  const [left, right] = (await settledNodes())[split].content.shares;
  Assert.greater(left, right + 5, "the left page is the wider");
  Assert.less(Math.abs(left + right - 100), 0.1, "and the two make 100");

  const elsewhere = await otherWorkspace();
  await SvalWindowWorkspace.of(window).switchTo(elsewhere);
  await settledNodes();
  await SvalWindowWorkspace.of(window).switchTo(home);
  await untilSplits([ids], "the split is back");
  const shown = gBrowser.tabs.find(
    tab => SvalPanel.observer.nodeIdFor(tab) === ids[0]
  );
  if (gBrowser.selectedTab !== shown) {
    await within(
      BrowserTestUtils.switchTab(gBrowser, shown),
      10_000,
      "the tab switch"
    );
  }
  await TestUtils.waitForCondition(() => {
    const [a, b] = panesOnScreen().map(p => p.getBoundingClientRect().width);
    return a && b && Math.abs((a / (a + b)) * 100 - left) < 1;
  }, "the left page has the share it was given");
});

add_task(async function a_picked_pane_in_an_isolated_workspace_stays_split() {
  const isolated = await otherWorkspace({ isolated: true });
  await SvalWindowWorkspace.of(window).switchTo(isolated);
  const { tabs, ids } = await openTabs(1);
  Assert.equal(gBrowser.selectedTab, tabs[0], "the tab is on screen");

  // The command the add-split shortcut runs, which opens the picker as the
  // second pane in the default jar (split-view spec §4.2, §9.3).
  document.getElementById("Browser:AddTabSplitView").doCommand();
  const jar = SvalWorkspaceJar.userContextIdFor(await settledNodes(), isolated);
  Assert.greater(jar, 0, "the workspace has a jar of its own");
  await TestUtils.waitForCondition(() => {
    const panes = gBrowser.selectedTab.splitview?.tabs ?? [];
    return panes.length === 2 && panes.every(tab => tab.userContextId === jar);
  }, "both panes are in the workspace's jar, still split");
  expectOpened(...gBrowser.selectedTab.splitview.tabs);
  const panes = gBrowser.selectedTab.splitview.tabs.map(tab =>
    SvalPanel.observer.nodeIdFor(tab)
  );
  Assert.equal(panes[0], ids[0], "the tab is the left pane");
  await untilSplits([panes], "and the tree holds the split");
});

add_task(async function a_private_window_splits_and_writes_nothing() {
  // The profile's own window goes on writing its tabs' titles meanwhile, so
  // what is compared is which nodes the profile's tree holds, and what the
  // private window's nodes are.
  const before = Object.keys(await settledNodes()).sort();
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20_000,
    "a private window's opening"
  );
  await within(win.SvalPanel.started, 10_000, "the private panel's startup");
  const page = await within(
    BrowserTestUtils.openNewForegroundTab(win.gBrowser, LINK_PAGE),
    10_000,
    "the page opening"
  );
  const menu = win.document.getElementById("contentAreaContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#link",
    { type: "contextmenu", button: 2 },
    page.linkedBrowser
  );
  await within(shown, 10_000, "the link's context menu");
  const opened = BrowserTestUtils.waitForNewTab(win.gBrowser, PAGE, true);
  menu.activateItem(win.document.getElementById("context-openlinkinsplitview"));
  await within(opened, 10_000, "the link's tab opening");

  await TestUtils.waitForCondition(async () => {
    await within(
      win.SvalPanel.observer.settled(),
      10_000,
      "win.SvalPanel.observer settling"
    );
    const nodes = (await win.SvalPanel.engine.tree()).nodes ?? {};
    return treeSplits(nodes).some(panes => panes.length === 2);
  }, "the private window's tree holds the split");
  Assert.equal(
    win.gBrowser.selectedTab.splitview?.tabs.length,
    2,
    "and shows it"
  );
  const priv = (await win.SvalPanel.engine.tree()).nodes ?? {};
  const profile = await settledNodes();
  Assert.deepEqual(
    Object.keys(profile).sort(),
    before,
    "the profile's tree gained no node"
  );
  Assert.deepEqual(
    Object.keys(priv).filter(id => id in profile),
    [],
    "and holds none of the private window's"
  );
  Assert.ok(
    !Object.values(profile).some(node =>
      [LINK_PAGE, PAGE].includes(node.content?.url)
    ),
    "nor a page the private window opened"
  );
  await within(BrowserTestUtils.closeWindow(win), 10_000, "the window closing");
});
