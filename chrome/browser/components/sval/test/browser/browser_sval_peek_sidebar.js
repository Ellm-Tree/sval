/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A Peek opens no sidebar, History's included, by any route: it
 * holds one page, as Firefox's taskbar tab window does
 * (`SidebarController.inSingleTabWindow`).
 */

const { SvalPeek } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPeek.sys.mjs"
);

const QUICK_PAGE = "https://example.com/browser/?quick-sidebar";

/**
 * A link from another app, and the Peek it opened, with its sidebar
 * started.
 *
 * @returns {Promise<Window>}
 */
async function peek() {
  const opened = BrowserTestUtils.waitForNewWindow({ url: QUICK_PAGE });
  runCommandLine(["-url", QUICK_PAGE]);
  const win = await within(opened, 20_000, "the Peek");
  Assert.ok(SvalPeek.isPeek(win), "it is a Peek");
  await within(
    win.SidebarController.promiseInitialized,
    10_000,
    "its sidebar starting"
  );
  return win;
}

add_task(async function the_last_closed_windows_history_stays_shut() {
  // A window with no opener starts its sidebar from the state the last
  // browser window to close left (`SidebarController.startDelayedLoad`), and
  // a link from another app opens its Peek with no opener.
  await SpecialPowers.pushPrefEnv({
    set: [
      [
        "sidebar.backupState",
        JSON.stringify({
          command: "viewHistorySidebar",
          panelOpen: true,
          launcherVisible: false,
        }),
      ],
    ],
  });
  const win = await peek();
  Assert.ok(!win.SidebarController.isOpen, "no sidebar is open");
  Assert.ok(
    win.document.getElementById("sidebar-box").hidden,
    "and none is shown"
  );
  await within(BrowserTestUtils.closeWindow(win), 10_000, "the Peek closing");
});

add_task(async function no_route_opens_history_in_a_peek() {
  const win = await peek();
  const { SidebarController } = win;

  Assert.ok(
    !(await SidebarController.show("viewHistorySidebar")),
    "showing History is refused"
  );
  await SidebarController.toggle("viewHistorySidebar");
  win.document.getElementById("key_gotoHistory").doCommand();
  const button = win.document.getElementById("sval-history-button");
  Assert.ok(!button?.checkVisibility(), "the header shows no history button");
  button?.doCommand();
  Assert.ok(!SidebarController.isOpen, "nothing opened it");
  Assert.ok(
    win.document.getElementById("sidebar-box").hidden,
    "and no sidebar is shown"
  );
  await within(BrowserTestUtils.closeWindow(win), 10_000, "the Peek closing");
});
