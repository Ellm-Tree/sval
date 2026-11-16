/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The Launcher in a Peek: what its line offers, which commands it
 * lists, and where the ones that open Sval's own pages open. Commands run
 * from the floating Launcher, as Accel+L opens it.
 */

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);
const { SvalPeek } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPeek.sys.mjs"
);
const { COMMANDS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLauncherCommands.sys.mjs"
);

const QUICK_PAGE = "https://example.com/browser/?quick-launcher";

// Opening a toolbox records that one was opened and the inspector's sizes.
keepPrefs(
  "devtools.everOpened",
  "devtools.toolsidebar-width.inspector",
  "devtools.toolsidebar-width.inspector.splitsidebar",
  "devtools.toolsidebar-height.inspector"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
});

/** @returns {Promise<Window>} a Peek opened on {@link QUICK_PAGE}. */
async function aPeek() {
  const opened = BrowserTestUtils.waitForNewWindow({ url: QUICK_PAGE });
  runCommandLine(["-url", QUICK_PAGE]);
  const win = await within(opened, 20_000, "the Peek");
  atTaskEnd(() =>
    within(BrowserTestUtils.closeWindow(win), 10_000, "the Peek closing")
  );
  await within(SimpleTest.promiseFocus(win), 10_000, "the Peek in front");
  return win;
}

/**
 * Opens the floating Launcher in `win` with Accel+L and types `value`.
 *
 * @param {Window} win
 * @param {string} value
 * @returns {Promise<object[]>} `{ result, i }` per row.
 */
async function launcherRows(win, value) {
  EventUtils.synthesizeKey("l", { accelKey: true }, win);
  await TestUtils.waitForCondition(
    () => win.gURLBar.hasAttribute("sval-launcher-floating"),
    "the Launcher floating"
  );
  EventUtils.sendString(value, win);
  await within(
    UrlbarTestUtils.promiseSearchComplete(win),
    10_000,
    "the Launcher's rows"
  );
  return within(
    (async () => {
      const rows = [];
      for (let i = 0; i < UrlbarTestUtils.getResultCount(win); i++) {
        rows.push({
          ...(await UrlbarTestUtils.getDetailsOfResultAt(win, i)),
          i,
        });
      }
      return rows;
    })(),
    10_000,
    "the Launcher's rows read"
  );
}

/**
 * Runs the command `id` from the floating Launcher in `win`: Accel+L, its
 * name, the arrow keys to its row and Enter.
 *
 * @param {Window} win
 * @param {string} id
 */
async function runFromLauncher(win, id) {
  const command = COMMANDS.find(c => c.id === id);
  const name = await win.document.l10n.formatValue(command.l10nId);
  const rows = await launcherRows(win, name);
  const row = rows.find(r => r.result.payload.commandId === id);
  Assert.ok(row, `${id} is listed`);
  for (
    let left = rows.length;
    left && UrlbarTestUtils.getSelectedRowIndex(win) !== row.i;
    left--
  ) {
    EventUtils.synthesizeKey("KEY_ArrowDown", {}, win);
  }
  EventUtils.synthesizeKey("KEY_Enter", {}, win);
}

/**
 * Waits until the ordinary window shows `url` and is in front.
 *
 * @param {string} url
 * @param {string} what
 */
async function shownInOrdinaryWindow(url, what) {
  // Firefox's `switchToTabHavingURI` may take the window's empty tab.
  await within(
    TestUtils.waitForCondition(
      () =>
        gBrowser.selectedBrowser.currentURI.spec === url &&
        Services.focus.activeWindow === window,
      what
    ),
    10_000,
    what
  );
  if (gBrowser.tabs.length > 1) {
    expectOpened(gBrowser.selectedTab);
  }
}

/**
 * @param {Window} win
 * @returns {Promise<string[]>} the l10n ids of the line under the rows.
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

add_task(async function a_peeks_line_offers_a_new_peek_and_no_split() {
  const win = await aPeek();
  await launcherRows(win, "example");
  const items = await footItems(win);
  Assert.ok(items.includes("launcher-foot-new-peek"), "New Peek is offered");
  Assert.ok(!items.includes("launcher-foot-new-tab"), "New tab is not");
  Assert.ok(
    !items.some(id => id.startsWith("launcher-foot-split")),
    "nor a split, which a Peek's page cannot join"
  );
  EventUtils.synthesizeKey("KEY_Escape", {}, win);
});

add_task(async function a_peek_lists_no_unloading_commands() {
  const win = await aPeek();
  for (const text of ["unload", "keep loaded"]) {
    const listed = (await launcherRows(win, text))
      .map(r => r.result.payload.commandId)
      .filter(id =>
        ["unload-tab", "keep-tab-loaded", "let-tab-unload"].includes(id)
      );
    Assert.deepEqual(listed, [], `none for "${text}"`);
    EventUtils.synthesizeKey("KEY_Escape", {}, win);
  }
});

add_task(async function a_peeks_site_panel_opens_from_the_launcher() {
  const win = await aPeek();
  const panel = win.document.getElementById("sval-protection-panel");
  const shown = BrowserTestUtils.waitForPopupEvent(panel, "shown");
  await runFromLauncher(win, "site-privacy");
  await within(shown, 10_000, "Privacy and Security opening");
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  panel.hidePopup();
  await within(hidden, 10_000, "Privacy and Security closing");
});

add_task(async function settings_from_a_peek_open_in_the_ordinary_window() {
  const win = await aPeek();
  await runFromLauncher(win, "settings-sites");
  await shownInOrdinaryWindow(
    "about:preferences#svalSites",
    "Sites settings in the ordinary window, in front"
  );
  Assert.equal(win.gBrowser.tabs.length, 1, "the Peek keeps its one page");
  Assert.equal(SvalPeek.windows().length, 1, "and no other Peek opens");
});

add_task(async function downloads_from_a_peek_open_in_the_ordinary_window() {
  const win = await aPeek();
  await runFromLauncher(win, "downloads");
  await shownInOrdinaryWindow(
    "about:downloads",
    "Downloads in the ordinary window, in front"
  );
  Assert.equal(SvalPeek.windows().length, 1, "and no other Peek opens");
});

add_task(async function history_from_a_peek_opens_in_the_ordinary_window() {
  const win = await aPeek();
  await runFromLauncher(win, "history");
  await within(
    TestUtils.waitForCondition(
      () =>
        SidebarController.currentID === "viewHistorySidebar" &&
        SidebarController.isOpen &&
        Services.focus.activeWindow === window,
      "History open in the ordinary window, in front"
    ),
    10_000,
    "History opening"
  );
  SidebarController.hide();
  Assert.equal(SvalPeek.windows().length, 1, "and no other Peek opens");
});

/** The floating Launcher runs a command in an ordinary window too. */
add_task(async function a_command_runs_from_the_floating_launcher() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(
      gBrowser,
      "https://example.com/browser/?launcher-mute"
    ),
    10_000,
    "the tab opening"
  );
  // The tasks before leave the window just raised over a closing Peek, and
  // the Launcher's view closes when its field or window loses focus
  // (`UrlbarInput._on_blur`, `UrlbarView.on_blur`).
  await switchDone(window);
  await within(SimpleTest.promiseFocus(window), 10_000, "the window's focus");
  await runFromLauncher(window, "mute");
  await within(
    TestUtils.waitForCondition(() => tab.muted, "the tab muted"),
    10_000,
    "Mute tab running"
  );
  BrowserTestUtils.removeTab(tab);
});

/**
 * With nothing typed, a Peek lists the ordinary window's recent tabs, and
 * picking one shows it there.
 */
add_task(async function a_peeks_empty_launcher_lists_recent_tabs() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(
      gBrowser,
      "https://example.com/browser/?quick-launcher-recent"
    ),
    10_000,
    "the tab opening"
  );
  const id = await TestUtils.waitForCondition(
    () => SvalPanel.observer.nodeIdFor(tab),
    "the tab in the tree"
  );
  const home = gBrowser.tabs[0];
  await within(
    BrowserTestUtils.switchTab(gBrowser, home),
    10_000,
    "back to the first tab"
  );
  const win = await aPeek();

  const rows = await launcherRows(win, "");
  const row = rows.find(r => r.result.payload.svalNodeId === id);
  Assert.ok(row, "the ordinary window's recent tab is listed");
  while (UrlbarTestUtils.getSelectedRowIndex(win) !== row.i) {
    EventUtils.synthesizeKey("KEY_ArrowDown", {}, win);
  }
  EventUtils.synthesizeKey("KEY_Enter", {}, win);
  await within(
    TestUtils.waitForCondition(
      () =>
        gBrowser.selectedTab === tab && Services.focus.activeWindow === window,
      "the tab shown in the ordinary window, in front"
    ),
    10_000,
    "going to the tab"
  );
  Assert.equal(SvalPeek.windows().length, 1, "and no other Peek opens");
  BrowserTestUtils.removeTab(tab);
});

/** A command a Peek ran is listed there again. */
add_task(async function a_peek_lists_a_command_again_after_running_it() {
  const win = await aPeek();
  const panel = win.document.getElementById("sval-protection-panel");
  const shown = BrowserTestUtils.waitForPopupEvent(panel, "shown");
  await runFromLauncher(win, "site-privacy");
  await within(shown, 10_000, "Privacy and Security opening");
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  panel.hidePopup();
  await within(hidden, 10_000, "Privacy and Security closing");
  await TestUtils.waitForCondition(
    () => !win.gURLBar.hasAttribute("sval-launcher-floating"),
    "the Launcher closed"
  );
  const ids = (await launcherRows(win, "privacy")).map(
    r => r.result.payload.commandId
  );
  Assert.ok(ids.includes("site-privacy"), "Privacy and Security is listed");
  EventUtils.synthesizeKey("KEY_Escape", {}, win);
});

/**
 * A Firefox action a Peek lists is decided by the Peek's own page: Inspect
 * shows while the ordinary window's page has DevTools open and the Peek's
 * does not.
 */
add_task(async function a_peeks_firefox_actions_follow_its_own_page() {
  // Someone who has used DevTools, whom alone Firefox offers Inspect
  // (`DevToolsStartup.isDevToolsUser`).
  await SpecialPowers.pushPrefEnv({ set: [["devtools.selfxss.count", 1]] });
  const { require } = ChromeUtils.importESModule(
    "resource://devtools/shared/loader/Loader.sys.mjs"
  );
  const { gDevTools } = require("devtools/client/framework/devtools");
  const toolbox = await gDevTools.showToolboxForTab(gBrowser.selectedTab, {
    toolId: "inspector",
  });
  atTaskEnd(() => toolbox.destroy());

  const win = await aPeek();
  const ids = (await launcherRows(win, "inspect")).map(
    r => r.result.payload.commandId
  );
  Assert.ok(ids.includes("inspect"), "Inspect is listed in the Peek");
  EventUtils.synthesizeKey("KEY_Escape", {}, win);
});

add_task(async function a_peeks_site_settings_open_from_the_launcher() {
  const win = await aPeek();
  const menu = win.document.getElementById("sval-site-menu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  await runFromLauncher(win, "site-settings");
  await within(shown, 10_000, "Site settings opening");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(hidden, 10_000, "Site settings closing");
});

/**
 * Settings asked for in a Peek, as its menu and key ask, open in the
 * ordinary window too.
 */
add_task(
  async function settings_asked_for_in_a_peek_open_in_the_ordinary_window() {
    const win = await aPeek();
    win.openPreferences("paneSvalSites");
    await within(
      committed(() => gBrowser.selectedBrowser, "about:preferences#svalSites"),
      10_000,
      "Sites settings in the ordinary window"
    );
    if (gBrowser.tabs.length > 1) {
      expectOpened(gBrowser.selectedTab);
    }
    Assert.equal(win.gBrowser.tabs.length, 1, "the Peek keeps its one page");
    Assert.equal(SvalPeek.windows().length, 1, "and no other Peek opens");
  }
);
