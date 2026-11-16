/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */

/**
 * Reopen Closed Tab pressed in a Peek opens the Peek the user
 * closed last, with its page's history, and leaves the workspace's own closed
 * tabs where they are.
 */

const { SvalPeek } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPeek.sys.mjs"
);

const FIRST = "https://example.com/browser/?undo-close-first";
const SECOND = "https://example.org/browser/?undo-close-second";
const NEXT = "https://example.org/browser/?undo-close-next";
const WORKSPACE_TAB = "https://example.net/browser/?undo-close-workspace";

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
});

/**
 * A link from another app, and the Peek it opened, loaded.
 *
 * @param {string} url
 * @returns {Promise<Window>}
 */
async function linkFromAnotherApp(url) {
  const opened = BrowserTestUtils.waitForNewWindow({ url });
  runCommandLine(["-url", url]);
  return within(opened, 20_000, "the Peek");
}

add_task(async function the_key_in_a_peek_reopens_the_one_closed() {
  // A workspace tab closed first, which Firefox's own undo would reopen.
  const workspaceTab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, WORKSPACE_TAB),
    10_000,
    "the workspace tab"
  );
  BrowserTestUtils.removeTab(workspaceTab);
  const tabs = gBrowser.tabs.length;
  const closedTabs = SessionStore.getClosedTabCount();

  const first = await linkFromAnotherApp(FIRST);
  const second = await linkFromAnotherApp(SECOND);
  const browser = second.gBrowser.selectedBrowser;
  BrowserTestUtils.startLoadingURIString(browser, NEXT);
  await pageReady(browser, NEXT);

  const closed = BrowserTestUtils.domWindowClosed(second);
  await within(
    SimpleTest.promiseFocus(second),
    10_000,
    "the second Peek's focus"
  );
  EventUtils.synthesizeKey("w", { accelKey: true }, second);
  await within(closed, 10_000, "the second Peek closing");

  const reopened = BrowserTestUtils.waitForNewWindow();
  await within(
    SimpleTest.promiseFocus(first),
    10_000,
    "the first Peek's focus"
  );
  EventUtils.synthesizeKey("t", { accelKey: true, shiftKey: true }, first);
  const win = await within(reopened, 20_000, "the reopened Peek");
  await pageReady(win.gBrowser.selectedBrowser, NEXT);

  Assert.ok(SvalPeek.isPeek(win), "it opens as a Peek");
  Assert.equal(win.gBrowser.tabs.length, 1, "with one page");
  Assert.equal(win.gBrowser.selectedTab.userContextId, 0, "in its jar");
  Assert.ok(
    win.gBrowser.selectedBrowser.canGoBack,
    "its page keeps its back history"
  );
  Assert.equal(gBrowser.tabs.length, tabs, "the main window gains no tab");
  Assert.equal(
    SessionStore.getClosedTabCount(),
    closedTabs,
    "the workspace's closed tab stays closed"
  );

  await within(
    BrowserTestUtils.closeWindow(win),
    10_000,
    "the reopened Peek closing"
  );
  await within(
    BrowserTestUtils.closeWindow(first),
    10_000,
    "the first Peek closing"
  );
});
