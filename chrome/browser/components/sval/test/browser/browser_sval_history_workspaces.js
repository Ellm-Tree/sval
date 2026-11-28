/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * Each visit records the workspace it was made in: a tab's
 * is its workspace's, a Quick Peek's is its tab's, a page from another app in
 * a Peek has none until it is moved into a workspace, and a private
 * window records no visit.
 */

const { SvalVisitWorkspaces } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalVisitWorkspaces.sys.mjs"
);
const { SvalQuickPeek } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalQuickPeek.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  await PlacesUtils.history.clear();
  registerCleanupFunction(() => PlacesUtils.history.clear());
});

/**
 * Waits for Places to hold a visit to `url`, and answers the workspace of
 * its latest one.
 *
 * @param {string} url
 * @returns {Promise<string|null>}
 */
async function recordedWorkspace(url) {
  await TestUtils.waitForCondition(
    () => PlacesUtils.history.fetch(url),
    "Places records the visit"
  );
  return SvalVisitWorkspaces.latestOf(url);
}

add_task(async function a_tabs_visit_takes_its_workspace() {
  const url = PAGE + "?in-a-tab";
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, url),
    10_000,
    "the page loading"
  );
  Assert.equal(
    await recordedWorkspace(url),
    SvalWindowWorkspace.of(window).id,
    "the workspace the window shows"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function another_windows_visit_takes_that_windows_workspace() {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    20_000,
    "a new window's opening"
  );
  await within(win.SvalPanel.started, 20_000, "its panel starting");
  const workspace = SvalWindowWorkspace.of(win).id;
  Assert.notEqual(workspace, SvalWindowWorkspace.of(window).id);
  atTaskEnd(async () => {
    await within(BrowserTestUtils.closeWindow(win), 20_000, "its closing");
    if (SvalPanel.nodes[workspace]) {
      await removeWorkspace(workspace);
    }
  });
  const url = PAGE + "?in-another-window";
  await within(
    BrowserTestUtils.openNewForegroundTab(win.gBrowser, url),
    10_000,
    "the page loading"
  );
  Assert.equal(await recordedWorkspace(url), workspace);
});

add_task(async function a_quick_peeks_visit_takes_its_tabs_workspace() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.sval.quickPeek.enabled", true]],
  });
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE),
    10_000,
    "the page loading"
  );
  atTaskEnd(() => BrowserTestUtils.removeTab(tab));
  const url = PAGE2 + "?quick-peeked";
  await SpecialPowers.spawn(tab.linkedBrowser, [url], href => {
    const link = content.document.createElement("a");
    link.id = "quick-peek-link";
    link.href = href;
    link.textContent = "Quick Peek here";
    content.document.body.prepend(link);
  });
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#quick-peek-link",
    { altKey: true },
    tab.linkedBrowser
  );
  const quickPeek = await TestUtils.waitForCondition(
    () => SvalQuickPeek.tabOf(window),
    "a Quick Peek"
  );
  Assert.equal(
    await recordedWorkspace(url),
    SvalWindowWorkspace.of(window).id,
    "the Quick Peek's page is in the tab's workspace"
  );
  document
    .getElementById(quickPeek.linkedPanel)
    .querySelector(".sval-quick-peek-close")
    .click();
  await TestUtils.waitForCondition(
    () => !SvalQuickPeek.tabOf(window) && !quickPeek.linkedBrowser,
    "its close button closes the Quick Peek"
  );
});

add_task(async function a_peeks_page_takes_a_workspace_once_moved() {
  const url = "https://example.com/browser/?from-another-app";
  const opened = BrowserTestUtils.waitForNewWindow({ url });
  runCommandLine(["-url", url]);
  const win = await within(opened, 20_000, "the Peek");
  await TestUtils.waitForCondition(
    () => !win.document.getElementById("sval-peek-open").hidden,
    "its open button names a workspace"
  );
  Assert.equal(
    await recordedWorkspace(url),
    null,
    "a page in no workspace records none"
  );

  const closed = BrowserTestUtils.domWindowClosed(win);
  win.document.getElementById("sval-peek-open-main").click();
  await within(closed, 10_000, "the Peek closing");
  const tab = expectOpened(gBrowser.selectedTab);
  atTaskEnd(async () => {
    BrowserTestUtils.removeTab(tab);
    await within(
      SvalPanel.observer.settled(),
      10_000,
      "SvalPanel.observer settling"
    );
  });
  const next = PAGE + "?after-the-move";
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, next);
  await pageReady(tab.linkedBrowser, next);
  Assert.equal(
    await recordedWorkspace(next),
    SvalWindowWorkspace.of(window).id,
    "a visit after the move takes the workspace"
  );
  Assert.equal(
    await SvalVisitWorkspaces.latestOf(url),
    null,
    "the visit before it keeps none"
  );
});

add_task(async function a_private_window_records_no_visit() {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20_000,
    "a private window's opening"
  );
  atTaskEnd(() =>
    within(BrowserTestUtils.closeWindow(win), 20_000, "its closing")
  );
  const url = PAGE + "?in-private";
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(win.gBrowser, url),
    10_000,
    "the page loading"
  );
  await pageReady(tab.linkedBrowser, url);
  // A later visit in a normal tab is recorded, so Places has had the time
  // to record the private one, had it any.
  const after = PAGE + "?after-private";
  const normal = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, after),
    10_000,
    "a normal page loading"
  );
  atTaskEnd(() => BrowserTestUtils.removeTab(normal));
  await recordedWorkspace(after);
  Assert.equal(await PlacesUtils.history.fetch(url), null, "no visit");
});
