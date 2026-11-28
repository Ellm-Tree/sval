/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * The History sidebar lists the history of the workspace its window shows,
 * with the pages visited in no workspace, and every page under "All
 * workspaces", where a column names each page's workspace.
 */

ChromeUtils.defineESModuleGetters(this, {
  PlacesTestUtils: "resource://testing-common/PlacesTestUtils.sys.mjs",
});

const { WINDOW_WORKSPACE_TOPIC } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);
const { SvalVisitWorkspaces } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalVisitWorkspaces.sys.mjs"
);
const { DATE_COLUMN_ID, SCOPE_SWITCH_ID, WORKSPACE_COLUMN_ID } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalHistorySidebar.sys.mjs"
  );

const HERE = "https://example.com/scope-here";
const THERE = "https://example.com/scope-there";
const BEFORE = "https://example.com/scope-before";
const GONE = "https://example.com/scope-gone";

/**
 * A workspace no window shows, removed when the task ends.
 *
 * @param {string} name
 * @returns {Promise<string>} Its id.
 */
async function otherWorkspace(name) {
  const id = crypto.randomUUID();
  await SvalPanel.engine.mutate({
    kind: "addWorkspace",
    id,
    name,
    icon: null,
    now: Date.now(),
  });
  atTaskEnd(async () => {
    if (SvalPanel.nodes[id]) {
      await removeWorkspace(id);
    }
  });
  await SvalPanel.refresh();
  return id;
}

/**
 * Visits each page a minute apart, oldest first, each in the workspace it
 * names, or in none for null.
 *
 * @param {Array<[string, string|null]>} pages
 */
async function visitIn(pages) {
  const start = Date.now() - 60 * 60_000;
  const visits = pages.map(([url], i) => ({
    uri: url,
    title: url.split("/").at(-1),
    visitDate: (start + i * 60_000) * 1000,
  }));
  await PlacesTestUtils.addVisits(visits);
  await SvalVisitWorkspaces.record(
    pages
      .map(([url, workspace], i) => ({
        url,
        visitedAt: start + i * 60_000,
        workspace,
      }))
      .filter(visit => visit.workspace)
  );
}

/**
 * Shows the History sidebar of `win`, by last visited, once Sval dressed it.
 *
 * @param {Window} [win]
 * @returns {Promise<{doc: Document, tree: Element}>}
 */
async function showHistory(win = window) {
  await win.SidebarController.show("viewHistorySidebar");
  const doc = win.SidebarController.browser.contentDocument;
  const tree = doc.getElementById("historyTree");
  // A hide asked for while the sidebar slides in reverses the slide and
  // leaves it open (`SvalHistorySidebar._slider`), so the task starts once
  // it is in.
  await TestUtils.waitForCondition(
    () =>
      tree._svalDecorated &&
      !win.document.getElementById("sidebar-box").hasAttribute("sval-overlay"),
    "sval dressed the sidebar, and it slid in"
  );
  doc.getElementById("bylastvisited").doCommand();
  atTaskEnd(async () => {
    doc.getElementById("byday")?.doCommand();
    win.SidebarController.hide();
    await TestUtils.waitForCondition(
      () => !win.SidebarController.isOpen,
      "the sidebar closes"
    );
  });
  return { doc, tree };
}

/**
 * @param {Element} tree
 * @returns {string[]} The pages the tree lists, top first.
 */
function listed(tree) {
  const urls = [];
  for (let row = 0; row < tree.view.rowCount; row++) {
    const node = tree.view.nodeForTreeIndex(row);
    if (PlacesUtils.nodeIsURI(node)) {
      urls.push(node.uri);
    }
  }
  return urls;
}

/**
 * @param {Element} tree
 * @param {string} url
 * @param {string} id
 * @returns {string|null} The text of `url`'s cell in column `id`.
 */
function cellOf(tree, url, id) {
  for (let row = 0; row < tree.view.rowCount; row++) {
    if (tree.view.nodeForTreeIndex(row).uri === url) {
      return tree.view.getCellText(row, tree.columns.getNamedColumn(id));
    }
  }
  return null;
}

const segment = (doc, all) =>
  doc.querySelector(`#${SCOPE_SWITCH_ID} [data-all="${all}"]`);

/**
 * Clicks the "All Workspaces" segment. The switch keeps a roving tabindex,
 * so the segment not chosen is reached with the arrow keys, which the
 * accessibility checks' tabindex rule does not know.
 *
 * @param {Document} doc
 */
function showAll(doc) {
  AccessibilityUtils.setEnv({ nonNegativeTabIndexRule: false });
  segment(doc, true).click();
  AccessibilityUtils.resetEnv();
}

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  await PlacesUtils.history.clear();
  registerCleanupFunction(() => PlacesUtils.history.clear());
});

add_task(
  async function a_window_lists_its_workspaces_history_and_all_on_request() {
    const here = SvalWindowWorkspace.of(window).id;
    const there = await otherWorkspace("Research");
    await visitIn([
      [BEFORE, null],
      [THERE, there],
      [HERE, here],
    ]);
    atTaskEnd(() => PlacesUtils.history.clear());
    const { doc, tree } = await showHistory();

    Assert.equal(segment(doc, false).getAttribute("aria-checked"), "true");
    await TestUtils.waitForCondition(
      () => listed(tree).length === 2,
      "this workspace's pages and those of none"
    );
    Assert.deepEqual(listed(tree), [HERE, BEFORE]);
    const column = tree.columns.getNamedColumn(WORKSPACE_COLUMN_ID);
    Assert.ok(column.element.hidden, "no workspace column in its own view");
    Assert.ok(
      !tree.columns.getNamedColumn(DATE_COLUMN_ID).element.hidden,
      "the Visited column stays"
    );

    showAll(doc);
    await TestUtils.waitForCondition(
      () => listed(tree).length === 3,
      "All Workspaces lists every page"
    );
    Assert.deepEqual(listed(tree), [HERE, THERE, BEFORE], "newest first");
    Assert.equal(segment(doc, true).getAttribute("aria-checked"), "true");
    Assert.ok(!column.element.hidden, "with the workspace column");
    await TestUtils.waitForCondition(
      () => cellOf(tree, THERE, WORKSPACE_COLUMN_ID) === "Research",
      "a page names its workspace"
    );
    Assert.equal(
      cellOf(tree, BEFORE, WORKSPACE_COLUMN_ID),
      "",
      "and a page visited in none names nothing"
    );
    Assert.ok(
      cellOf(tree, HERE, DATE_COLUMN_ID),
      "each page keeps its visit time"
    );

    // The switch is a radio group: an arrow key moves and chooses.
    segment(doc, true).focus();
    EventUtils.synthesizeKey("KEY_ArrowLeft", {}, doc.defaultView);
    await TestUtils.waitForCondition(
      () => listed(tree).length === 2,
      "back to this workspace"
    );
    Assert.equal(doc.activeElement, segment(doc, false));
  }
);

add_task(async function a_search_keeps_to_the_workspace() {
  const there = await otherWorkspace("Research");
  await visitIn([
    [THERE, there],
    [HERE, SvalWindowWorkspace.of(window).id],
  ]);
  atTaskEnd(() => PlacesUtils.history.clear());
  const { doc, tree } = await showHistory();
  const search = doc.getElementById("search-box");
  search.value = "scope";
  doc.defaultView.searchHistory(search.value);
  await TestUtils.waitForCondition(
    () => listed(tree).length === 1,
    "the search finds this workspace's page"
  );
  Assert.deepEqual(listed(tree), [HERE]);
  showAll(doc);
  await TestUtils.waitForCondition(
    () => listed(tree).length === 2,
    "and every workspace's under All Workspaces"
  );
  search.value = "";
  doc.defaultView.searchHistory("");
});

add_task(async function a_deleted_workspaces_pages_show_only_under_all() {
  await visitIn([
    [GONE, crypto.randomUUID()],
    [HERE, SvalWindowWorkspace.of(window).id],
  ]);
  atTaskEnd(() => PlacesUtils.history.clear());
  const { doc, tree } = await showHistory();
  await TestUtils.waitForCondition(
    () => listed(tree).includes(HERE),
    "this workspace's history is listed"
  );
  Assert.deepEqual(listed(tree), [HERE], "no workspace shows the other");
  showAll(doc);
  await TestUtils.waitForCondition(
    () => cellOf(tree, GONE, WORKSPACE_COLUMN_ID) === "Deleted Workspace",
    "All Workspaces lists it as a deleted workspace's"
  );
});

add_task(async function showing_another_workspace_lists_its_history() {
  const there = await otherWorkspace("Research");
  await visitIn([
    [THERE, there],
    [HERE, SvalWindowWorkspace.of(window).id],
  ]);
  const here = SvalWindowWorkspace.of(window).id;
  const tabsBefore = new Set(gBrowser.tabs);
  atTaskEnd(async () => {
    await SvalWindowWorkspace.of(window).switchTo(here);
    // An empty workspace is shown with a new tab of its own.
    for (const tab of gBrowser.tabs) {
      if (!tabsBefore.has(tab)) {
        expectOpened(tab);
      }
    }
    await PlacesUtils.history.clear();
  });
  const { doc, tree } = await showHistory();
  showAll(doc);
  await TestUtils.waitForCondition(
    () => listed(tree).length === 2,
    "All Workspaces"
  );
  await SvalWindowWorkspace.of(window).switchTo(there);
  await TestUtils.waitForCondition(
    () => listed(tree).length === 1 && listed(tree)[0] === THERE,
    "the window's other workspace lists its own"
  );
  Assert.equal(
    segment(doc, false).getAttribute("aria-checked"),
    "true",
    "back on This Workspace"
  );
});

add_task(async function a_private_window_lists_every_page_with_no_switch() {
  await visitIn([
    [HERE, SvalWindowWorkspace.of(window).id],
    [BEFORE, null],
  ]);
  atTaskEnd(() => PlacesUtils.history.clear());
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20_000,
    "a private window's opening"
  );
  atTaskEnd(() =>
    within(BrowserTestUtils.closeWindow(win), 20_000, "the window closing")
  );
  const { doc, tree } = await showHistory(win);
  Assert.ok(!doc.getElementById(SCOPE_SWITCH_ID), "no switch");
  await TestUtils.waitForCondition(
    () => listed(tree).length === 2,
    "every page"
  );
  Assert.ok(
    tree.columns.getNamedColumn(WORKSPACE_COLUMN_ID).element.hidden,
    "and no workspace column"
  );

  // The panel tells the sidebar the window shows another workspace, and the
  // sidebar reloads its list there and then, keeping every page.
  Object.defineProperty(win.SvalPanel, "workspaceId", {
    get: () => "another workspace",
    configurable: true,
  });
  Services.obs.notifyObservers(win, WINDOW_WORKSPACE_TOPIC);
  Assert.equal(listed(tree).length, 2, "and it still lists every page");
});
