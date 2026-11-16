/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * A window's recently closed tabs are its own: History's list and the undo
 * close tab key in one window do not reach a tab closed in another, whose
 * workspace may have a jar of its own. The key reopens the last tab closed
 * in the workspace the window shows, straight into that workspace's jar, and
 * a tab closed in another workspace waits for the window to show it again.
 * In a private window the key reopens nothing from any other window, a
 * closed window included.
 */

const { SvalWorkspaceJar } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalWorkspaceJar.sys.mjs"
);

const CLOSED_URL =
  "https://example.com/browser/browser/components/sval/test/browser/sval_agent_page2.html";
const OWN_URL =
  "https://example.com/browser/browser/components/sval/test/browser/sval_quick_peek_links.html";
const KEPT_URL = OWN_URL + "?kept";

/**
 * Opens `url` in `win` and closes it, and waits for Firefox to keep it.
 *
 * @param {Window} win
 * @param {string} url
 */
async function openAndClose(win, url) {
  const before = SessionStore.getClosedTabCountForWindow(win);
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(win.gBrowser, url),
    10_000,
    "a tab opening"
  );
  BrowserTestUtils.removeTab(tab);
  await TestUtils.waitForCondition(
    () => SessionStore.getClosedTabCountForWindow(win) === before + 1,
    "Firefox keeps the closed tab"
  );
}

/**
 * Forgets the tabs `win` keeps as closed, so the key can reach only what
 * the task closes.
 *
 * @param {Window} [win]
 */
function forgetClosedTabs(win = window) {
  while (SessionStore.getClosedTabCountForWindow(win)) {
    SessionStore.forgetClosedTab(win, 0);
  }
}

/**
 * @param {Window} win
 * @returns {number} the closed tabs History's menu offers in `win`.
 */
function offered(win) {
  return RecentlyClosedTabsAndWindowsMenuUtils.getTabsFragment(
    win,
    "menuitem"
  ).querySelectorAll("menuitem[targetURI]").length;
}

/**
 * Presses undo close tab's key (Ctrl+Shift+T, Cmd+Shift+T on macOS) in
 * `win`, after making it the focused window, which takes the key.
 *
 * @param {Window} [win]
 */
async function pressUndoKey(win = window) {
  await within(SimpleTest.promiseFocus(win), 10_000, "the window's focus");
  EventUtils.synthesizeKey("t", { accelKey: true, shiftKey: true }, win);
}

add_task(async function history_offers_only_this_windows_closed_tabs() {
  const other = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    15_000,
    "another window opening"
  );
  try {
    const here = offered(window);
    const there = offered(other);
    const tab = await within(
      BrowserTestUtils.openNewForegroundTab(other.gBrowser, CLOSED_URL),
      10_000,
      "a tab opening in the other window"
    );
    BrowserTestUtils.removeTab(tab);
    await TestUtils.waitForCondition(
      () => offered(other) === there + 1,
      "the other window offers its closed tab"
    );
    Assert.equal(offered(window), here, "and this window does not");
  } finally {
    await within(
      BrowserTestUtils.closeWindow(other),
      10_000,
      "the other window closing"
    );
  }
});

add_task(async function the_undo_key_reopens_only_this_windows_closed_tabs() {
  forgetClosedTabs();
  await openAndClose(window, OWN_URL);
  const other = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    15_000,
    "another window opening"
  );
  try {
    await openAndClose(other, CLOSED_URL);
    const kept = SessionStore.getClosedTabCountForWindow(other);
    const opened = BrowserTestUtils.waitForNewTab(gBrowser, OWN_URL);
    await pressUndoKey();
    const reopened = await within(opened, 10_000, "this window's tab back");
    BrowserTestUtils.removeTab(reopened);
    Assert.equal(
      SessionStore.getClosedTabCountForWindow(other),
      kept,
      "and the other window keeps the tab it closed last"
    );
  } finally {
    await within(
      BrowserTestUtils.closeWindow(other),
      10_000,
      "the other window closing"
    );
  }
});

/**
 * @param {Window} win
 * @param {string} url
 * @returns {boolean} whether `win` keeps a closed tab last at `url`.
 */
function keepsClosed(win, url) {
  return SessionStore.getClosedTabDataForWindow(win).some(
    ({ state }) => state.entries.at(-1)?.url === url
  );
}

add_task(async function the_undo_key_reopens_the_shown_workspaces_tab() {
  // A window of the task's own, so switching it leaves this one as it is.
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    15_000,
    "a window opening"
  );
  const panel = win.SvalPanel;
  await within(panel._started.promise, 10_000, "its panel's startup");
  const home = panel._currentWorkspaceId;
  const isolated = await panel._engine.mutate({
    kind: "addWorkspace",
    name: "Isolated undo",
    isolated: true,
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  // A tab of its own, so the switch to it opens no blank tab.
  await panel._engine.mutate({
    kind: "addTab",
    parent: isolated,
    name: "Kept",
    url: KEPT_URL,
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  const show = async id => {
    await panel.switchTo(id);
    await within(panel._observer.settled(), 10_000, "panel._observer settling");
  };
  try {
    forgetClosedTabs(win);
    await openAndClose(win, OWN_URL);
    await show(isolated);
    await openAndClose(win, CLOSED_URL);
    await show(home);

    let opened = BrowserTestUtils.waitForNewTab(win.gBrowser, OWN_URL);
    await pressUndoKey(win);
    BrowserTestUtils.removeTab(await within(opened, 10_000, "home's tab back"));
    await within(panel._observer.settled(), 10_000, "panel._observer settling");
    Assert.ok(
      keepsClosed(win, CLOSED_URL),
      "the isolated workspace's closed tab waits for its workspace"
    );

    await show(isolated);
    // A press sent while the focused tab was starting its first load never
    // reached the key's command here, so the workspace's own tab loads first.
    await pageReady(win.gBrowser.selectedBrowser, KEPT_URL);
    opened = BrowserTestUtils.waitForNewTab(win.gBrowser, CLOSED_URL);
    await pressUndoKey(win);
    const reopened = await within(opened, 10_000, "the isolated tab back");
    const jar = SvalWorkspaceJar.userContextIdFor(panel._nodes, isolated);
    Assert.notEqual(jar, 0, "the isolated workspace has a jar of its own");
    Assert.equal(
      reopened.userContextId,
      jar,
      "and the tab opened straight into it"
    );
    await show(home);
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the window closing"
    );
    await removeWorkspace(isolated);
  }
});

add_task(
  async function a_tab_reopened_into_a_new_jar_closes_back_to_its_opener() {
    const win = await within(
      BrowserTestUtils.openNewBrowserWindow(),
      15_000,
      "a window opening"
    );
    const panel = win.SvalPanel;
    await within(panel._started.promise, 10_000, "its panel's startup");
    const home = panel._currentWorkspaceId;
    const id = await panel._engine.mutate({
      kind: "addWorkspace",
      name: "Reopen",
      isolated: false,
      id: crypto.randomUUID(),
      now: Date.now(),
    });
    const kept = crypto.randomUUID();
    const other = crypto.randomUUID();
    for (const [tabId, url] of [
      [kept, KEPT_URL],
      [other, OWN_URL],
    ]) {
      await panel._engine.mutate({
        kind: "addTab",
        parent: id,
        name: url,
        url,
        id: tabId,
        now: Date.now(),
      });
    }
    const settled = () =>
      within(panel._observer.settled(), 10_000, "panel._observer settling");
    try {
      forgetClosedTabs(win);
      await panel.switchTo(id);
      await settled();
      await openAndClose(win, CLOSED_URL);
      // The workspace has a jar of its own since the tab closed, so the key
      // reopens it afresh in that one (`SvalTabs`' `reopenClosedTab`).
      await panel._engine.mutate({
        kind: "setIsolation",
        id,
        isolated: true,
        now: Date.now(),
      });
      await panel.refresh();
      await settled();

      const opener = panel._observer.tabFor(kept);
      await selectTab(opener);
      await pageReady(opener.linkedBrowser, KEPT_URL);
      const opened = BrowserTestUtils.waitForNewTab(win.gBrowser, CLOSED_URL);
      await pressUndoKey(win);
      const reopened = await within(opened, 10_000, "the closed tab back");
      await switchDone(win);
      Assert.notEqual(reopened.userContextId, 0, "in the workspace's own jar");
      Assert.equal(win.gBrowser.selectedTab, reopened, "it is selected");
      Assert.equal(
        win.gBrowser.visibleTabs.at(-1),
        reopened,
        "after the workspace's other tab, which a close with no opener selects"
      );

      const closed = BrowserTestUtils.waitForTabClosing(reopened);
      EventUtils.synthesizeKey("w", { accelKey: true }, win);
      await within(closed, 10_000, "the reopened tab closing");
      await switchDone(win);
      Assert.equal(
        win.gBrowser.selectedTab,
        opener,
        "closing it returns to the tab it was reopened over"
      );
      await panel.switchTo(home);
      await settled();
    } finally {
      await within(
        BrowserTestUtils.closeWindow(win),
        10_000,
        "the window closing"
      );
      await removeWorkspace(id);
    }
  }
);

add_task(async function a_private_windows_key_reaches_no_other_window() {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20_000,
    "a private window opening"
  );
  await within(win.SvalPanel.started, 10_000, "its panel's startup");
  const other = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    15_000,
    "a normal window opening"
  );
  try {
    await openAndClose(win, OWN_URL);
    // The normal window closes last, so Firefox's last closed action is a
    // window the private window must not reach.
    await within(
      BrowserTestUtils.openNewForegroundTab(other.gBrowser, CLOSED_URL),
      10_000,
      "a tab opening in the normal window"
    );
    const closedWindows = SessionStore.getClosedWindowCount();
    await within(
      BrowserTestUtils.closeWindow(other),
      10_000,
      "the normal window closing"
    );
    await TestUtils.waitForCondition(
      () => SessionStore.getClosedWindowCount() === closedWindows + 1,
      "Firefox keeps the closed window"
    );

    const opened = BrowserTestUtils.waitForNewTab(win.gBrowser, OWN_URL);
    await pressUndoKey(win);
    await within(opened, 10_000, "the private window's own tab back");
    Assert.equal(
      SessionStore.getClosedWindowCount(),
      closedWindows + 1,
      "and the normal window stays closed"
    );
  } finally {
    if (!other.closed) {
      await within(
        BrowserTestUtils.closeWindow(other),
        10_000,
        "the normal window closing"
      );
    }
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the private window closing"
    );
  }
});
