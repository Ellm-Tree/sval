/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * The page menu shows one line between groups of items, whichever items
 * Sval hides or adds once Firefox has shown its own.
 */

const LINKS_PAGE = ROOT + "sval_quick_peek_links.html";

/**
 * The menu's children the person sees, in order.
 *
 * @param {Element} menu
 * @returns {Element[]}
 */
function shownChildren(menu) {
  return [...menu.children].filter(
    child => !child.hidden && getComputedStyle(child).display !== "none"
  );
}

/**
 * Opens the page menu on `selector`, checks its lines, and closes it.
 *
 * @param {Element} browser
 * @param {string} selector
 */
async function checkLines(browser, selector) {
  const menu = document.getElementById("contentAreaContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  await BrowserTestUtils.synthesizeMouseAtCenter(
    selector,
    { type: "contextmenu", button: 2 },
    browser
  );
  await within(shown, 10_000, `the menu on ${selector} showing`);

  const items = shownChildren(menu);
  const isLine = item => item.localName === "menuseparator";
  Assert.ok(!isLine(items[0]), `the menu on ${selector} starts with an item`);
  Assert.ok(!isLine(items.at(-1)), `the menu on ${selector} ends with an item`);
  const doubled = items
    .slice(1)
    .filter((item, i) => isLine(item) && isLine(items[i]))
    .map(item => item.id);
  Assert.deepEqual(doubled, [], `no two lines together on ${selector}`);

  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(hidden, 10_000, `the menu on ${selector} hiding`);
}

add_task(async function one_line_between_groups() {
  const tab = await openPage(LINKS_PAGE);
  const browser = tab.linkedBrowser;
  for (const selector of ["h1", "#link", "#mail"]) {
    await checkLines(browser, selector);
  }
});
