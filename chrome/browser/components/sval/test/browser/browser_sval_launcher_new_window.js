/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * Shift on a Launcher row of another workspace opens that workspace in a
 * window of its own, as Shift does in the workspace switcher: an open tab's
 * row, which the new window shows, and a Go to command's. A window that
 * already shows the workspace comes forward instead. The line under the
 * list names the key on those rows, and only on those.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);

add_setup(failOnConsoleErrors);

add_setup(async function () {
  registerCleanupFunction(async () => {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      await UrlbarTestUtils.promisePopupClose(win);
      win.gURLBar.handleRevert();
    }
  });
});

/**
 * Types `value` into `win`'s address bar and waits for its rows.
 *
 * @param {Window} win
 * @param {string} value
 * @returns {Promise<object[]>} `{ result, element, i }` per row.
 */
async function rowsFor(win, value) {
  await within(
    UrlbarTestUtils.promiseAutocompleteResultPopup({ window: win, value }),
    10_000,
    "the address bar's results"
  );
  const rows = [];
  for (let i = 0; i < UrlbarTestUtils.getResultCount(win); i++) {
    rows.push({ ...(await UrlbarTestUtils.getDetailsOfResultAt(win, i)), i });
  }
  return rows;
}

/**
 * Selects `row` with the arrow keys, as a person does.
 *
 * @param {object} row
 * @param {Window} [win]
 */
function select(row, win = window) {
  for (
    let left = UrlbarTestUtils.getResultCount(win);
    left && UrlbarTestUtils.getSelectedRowIndex(win) !== row.i;
    left--
  ) {
    EventUtils.synthesizeKey("KEY_ArrowDown", {}, win);
  }
  Assert.equal(
    UrlbarTestUtils.getSelectedRowIndex(win),
    row.i,
    "the row is selected"
  );
}

/**
 * The l10n ids of the line under the list, once its words are in.
 *
 * @param {Window} win
 * @returns {Promise<string[]>}
 */
async function footItems(win) {
  const line = win.gURLBar.querySelector(".sval-launcher-foot");
  await TestUtils.waitForCondition(
    () =>
      line.children.length &&
      [...line.querySelectorAll("[data-l10n-id]")].every(el => el.textContent),
    "the line's words"
  );
  return [...line.querySelectorAll("[data-l10n-id]")].map(el =>
    el.getAttribute("data-l10n-id")
  );
}

/**
 * Waits for the window a pick opens, and for its panel to start. The window
 * closes when the running task ends.
 *
 * @param {Promise<DOMWindow>} opening The window's opening, bounded.
 * @returns {Promise<DOMWindow>}
 */
async function openedWindow(opening) {
  const win = await opening;
  atTaskEnd(async () => {
    if (!win.closed) {
      await within(
        BrowserTestUtils.closeWindow(win),
        10_000,
        "the new window closing"
      );
    }
  });
  expectWorkspaceTabs(win);
  await within(win.SvalPanel.started, 20_000, "the new window's panel");
  return win;
}

/**
 * Two workspaces, Work and Home, with this window on Work, and a second tab
 * "Notes" in Home, so a window opened on Home shows the tab picked rather
 * than its only one.
 *
 * @returns {Promise<object>} `withSwitcherTabs`' result, plus `work`,
 *   `home` and `notes`, the second tab's node.
 */
async function withTwoWorkspaces() {
  const fixture = await withSwitcherTabs({ names: ["Work", "Home"] });
  const [work, home] = fixture.ids.workspaces;
  const notes = await fixture.engine.mutate({
    kind: "addTab",
    parent: home,
    name: "Notes",
    url: `${ROOT}sval_switcher_page.sjs?%3Ctitle%3ENotes%3C/title%3E`,
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  await SvalPanel.refresh();
  return { ...fixture, work, home, notes };
}

/**
 * Shift+Enter on a tab of another workspace opens that workspace in a new
 * window showing the tab, and this window stays. Accel+Shift+Enter on it
 * then brings that window forward, and opens no other.
 */
add_task(async function shift_enter_on_another_workspaces_tab() {
  const { work, home, notes } = await withTwoWorkspaces();
  const shown = taggedId(gBrowser.selectedTab);

  const [row] = (await rowsFor(window, "notes")).filter(
    r => r.result.payload.svalNodeId === notes
  );
  Assert.ok(row, "the tab has a row");
  select(row);
  Assert.ok(
    (await footItems(window)).includes("launcher-foot-new-window"),
    "the line names Shift+Enter"
  );
  const opening = within(
    BrowserTestUtils.domWindowOpenedAndLoaded(),
    20_000,
    "the new window's opening"
  );
  EventUtils.synthesizeKey("KEY_Enter", { shiftKey: true }, window);
  const win = await openedWindow(opening);

  Assert.equal(win.SvalPanel.workspaceId, home, "the new window shows Home");
  await TestUtils.waitForCondition(
    () => taggedId(win.gBrowser.selectedTab) === notes,
    "the new window shows the tab"
  );
  Assert.equal(SvalPanel.workspaceId, work, "this window stays on Work");
  Assert.equal(taggedId(gBrowser.selectedTab), shown, "on its tab");

  window.focus();
  await untilFocused(window, "this window has the focus");
  const windows = [...Services.wm.getEnumerator("navigator:browser")].length;
  const [again] = (await rowsFor(window, "notes")).filter(
    r => r.result.payload.svalNodeId === notes
  );
  select(again);
  EventUtils.synthesizeKey(
    "KEY_Enter",
    { accelKey: true, shiftKey: true },
    window
  );
  await untilFocused(win, "Home's window comes forward");
  Assert.equal(
    [...Services.wm.getEnumerator("navigator:browser")].length,
    windows,
    "no other window opens"
  );
  Assert.equal(SvalPanel.workspaceId, work, "this window stays on Work");
});

/**
 * A tab of this window's workspace offers no new window, and Shift+Enter
 * on it goes to it here.
 */
add_task(async function shift_enter_on_a_tab_here_goes_to_it() {
  const { work, ids } = await withTwoWorkspaces();
  const here = ids.tabs[0];
  const blank = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser),
    10_000,
    "an empty tab opening"
  );
  const [row] = (await rowsFor(window, "tab in 1")).filter(
    r => r.result.payload.svalNodeId === here
  );
  Assert.ok(row, "the tab has a row");
  select(row);
  Assert.ok(
    !(await footItems(window)).includes("launcher-foot-new-window"),
    "the line offers no new window"
  );
  const windows = [...Services.wm.getEnumerator("navigator:browser")].length;
  EventUtils.synthesizeKey("KEY_Enter", { shiftKey: true }, window);
  await TestUtils.waitForCondition(
    () => taggedId(gBrowser.selectedTab) === here,
    "the window goes to the tab"
  );
  Assert.equal(SvalPanel.workspaceId, work, "on its workspace");
  Assert.equal(
    [...Services.wm.getEnumerator("navigator:browser")].length,
    windows,
    "no window opens"
  );
  Assert.ok(!blank.isConnected || blank.closing, "the empty tab is closed");
});

/**
 * Shift+Enter on Go to Home opens Home in a new window, and this window
 * stays.
 */
add_task(async function shift_enter_on_go_to_opens_a_window() {
  const { work, home } = await withTwoWorkspaces();
  const [row] = (await rowsFor(window, "go to home")).filter(
    r =>
      r.result.payload.commandId === "go-to-workspace" &&
      r.result.payload.choiceId === home
  );
  Assert.ok(row, "Home has a Go to row");
  select(row);
  Assert.ok(
    (await footItems(window)).includes("launcher-foot-new-window"),
    "the line names Shift+Enter"
  );
  const opening = within(
    BrowserTestUtils.domWindowOpenedAndLoaded(),
    20_000,
    "the new window's opening"
  );
  EventUtils.synthesizeKey("KEY_Enter", { shiftKey: true }, window);
  const win = await openedWindow(opening);
  Assert.equal(win.SvalPanel.workspaceId, home, "the new window shows Home");
  Assert.equal(SvalPanel.workspaceId, work, "this window stays on Work");
});
