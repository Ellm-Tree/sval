/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * The page context menu's "Open Link in Quick Peek": it opens the Quick Peek an
 * Alt-click on the link opens, and shows only for a link an Alt-click would
 * Quick Peek at.
 */

const { QUICK_PEEK_LINK_ITEM_ID, QUICK_PEEK_PREF, SvalQuickPeek } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalQuickPeek.sys.mjs"
  );

/** A page of links, among them `#link` to QUICK_PEEKED and `#mail`, a mailto. */
const LINKS_PAGE = ROOT + "sval_quick_peek_links.html";
const QUICK_PEEKED = PAGE2;

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
});

/**
 * Opens the page's context menu on `selector` in `browser`.
 *
 * @param {object} browser
 * @param {string} selector
 * @returns {Promise<Element>} the menu, shown.
 */
async function linkMenu(browser, selector) {
  const menu = document.getElementById("contentAreaContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  await BrowserTestUtils.synthesizeMouseAtCenter(
    selector,
    { type: "contextmenu", button: 2 },
    browser
  );
  await within(shown, 10_000, "the page's context menu showing");
  return menu;
}

/**
 * Closes `menu` without choosing anything.
 *
 * @param {Element} menu
 */
async function closeMenu(menu) {
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(hidden, 10_000, "the page's context menu hiding");
}

add_task(async function the_link_menu_opens_the_link_in_a_quick_peek() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, LINKS_PAGE),
    10_000,
    "the page of links opening"
  );
  const menu = await linkMenu(tab.linkedBrowser, "#link");
  const item = document.getElementById(QUICK_PEEK_LINK_ITEM_ID);
  Assert.ok(!item.hidden, "a link's menu offers Open Link in Quick Peek");

  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(item);
  await within(hidden, 10_000, "the page's context menu hiding");
  await TestUtils.waitForCondition(
    () => SvalQuickPeek.tabOf(window),
    "a Quick Peek opens"
  );
  const quickPeek = SvalQuickPeek.tabOf(window);
  await pageReady(quickPeek.linkedBrowser, QUICK_PEEKED);
  Assert.equal(gBrowser.selectedTab, tab, "the tab under it stays selected");
  Assert.equal(
    quickPeek.userContextId,
    tab.userContextId,
    "it uses the tab's sign-ins"
  );

  SvalQuickPeek.close(window);
  await TestUtils.waitForCondition(
    () => !SvalQuickPeek.tabOf(window) && !quickPeek.linkedBrowser,
    "the Quick Peek closes"
  );
  await PlacesUtils.history.clear();
});

add_task(async function the_item_shows_only_where_alt_click_quick_peeks() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, LINKS_PAGE),
    10_000,
    "the page of links opening"
  );
  const item = document.getElementById(QUICK_PEEK_LINK_ITEM_ID);

  let menu = await linkMenu(tab.linkedBrowser, "#mail");
  Assert.ok(item.hidden, "an email link's menu offers no Quick Peek");
  await closeMenu(menu);

  await SpecialPowers.pushPrefEnv({ set: [[QUICK_PEEK_PREF, false]] });
  menu = await linkMenu(tab.linkedBrowser, "#link");
  Assert.ok(item.hidden, "nor a link's, with Quick Peek turned off");
  await closeMenu(menu);
  await SpecialPowers.popPrefEnv();
});
