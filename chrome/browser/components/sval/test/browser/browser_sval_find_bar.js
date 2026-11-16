/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The find bar opens across the top of the page in the chrome's colour, and
 * the page's rounded corners under it show that colour too.
 */
add_task(async function the_pages_corners_under_the_find_bar_are_the_bars() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(
      gBrowser,
      "https://example.com/browser/?find-bar"
    ),
    10_000,
    "a tab opening"
  );
  const findbar = await gBrowser.getFindBar(tab);
  const shown = BrowserTestUtils.waitForEvent(findbar, "findbaropen");
  findbar.open();
  await within(shown, 10_000, "the find bar opening");
  atTaskEnd(() => findbar.close(true));

  const container = tab.linkedBrowser.closest(".browserContainer");
  const stack = tab.linkedBrowser.closest(".browserStack");
  Assert.notEqual(
    getComputedStyle(stack).borderStartStartRadius,
    "0px",
    "the page's top corners are rounded"
  );
  Assert.equal(
    getComputedStyle(container).backgroundColor,
    getComputedStyle(findbar).backgroundColor,
    "and what shows behind them is the bar's colour"
  );
});
