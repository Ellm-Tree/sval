/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * Ctrl+Tab goes to the tab used before this one (`ctrlTab`, on by default in
 * Sval), and Ctrl+Shift+Tab, which in that order would open a list of all
 * tabs that Sval has no strip to open from, goes to the previous tab
 * (ctrl-tab-recent-order.patch).
 */

// Firefox records that Ctrl+Tab was used (`ctrlTab.onKeyDown`, the tabbox's
// CYCLE_TABS handling).
registerCleanupFunction(() =>
  Services.prefs.clearUserPref("browser.engagement.ctrlTab.has-used")
);

/**
 * @returns {Promise<object[]>} three tabs after the first, opened in order, so
 *   the last is selected.
 */
async function threeTabs() {
  const tabs = [];
  for (let i = 0; i < 3; i++) {
    tabs.push(
      await within(
        BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank"),
        10_000,
        "a tab opening"
      )
    );
  }
  return tabs;
}

add_task(async function ctrl_tab_goes_to_the_tab_used_last() {
  Assert.ok(
    Services.prefs.getBoolPref("browser.ctrlTab.sortByRecentlyUsed"),
    "Sval orders Ctrl+Tab by use"
  );
  const [a, b, c] = await threeTabs();
  await selectTab(a);
  await selectTab(c);

  EventUtils.synthesizeKey("KEY_Tab", { ctrlKey: true });
  EventUtils.synthesizeKey("KEY_Control", { type: "keyup" });
  await switchDone(window);
  Assert.equal(gBrowser.selectedTab, a, "Ctrl+Tab goes back to the last used");
  Assert.notEqual(gBrowser.selectedTab, b, "past the tab beside it");
  Assert.ok(!window.ctrlTab.isOpen, "and its list is closed");
});

add_task(async function ctrl_shift_tab_goes_to_the_previous_tab() {
  const [a, b, c] = await threeTabs();
  await selectTab(a);
  await selectTab(c);

  EventUtils.synthesizeKey("KEY_Tab", { ctrlKey: true, shiftKey: true });
  await switchDone(window);
  Assert.equal(gBrowser.selectedTab, b, "Ctrl+Shift+Tab goes one tab back");
  Assert.ok(!window.ctrlTab.isOpen, "and opens no list");
});
