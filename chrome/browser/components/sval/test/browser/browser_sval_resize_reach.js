/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * Each edge that resizes something takes a press anywhere across the line a
 * person sees: from just inside the page, across the gap the page's frame
 * leaves, to just inside the box it resizes. The workspace panel, Firefox's
 * sidebar and a split's divider each stand at a page's edge. The panel's
 * edge and the sidebar's splitter stop at their box, whose scrollbar runs
 * along that edge, and the panel's scrollbar takes a drag there.
 */

/** How far either side of the gap a press still lands on the edge. */
const REACH = 2;

/**
 * Asserts that a press at each x, halfway down `handle`, lands on it.
 *
 * @param {Element} handle
 * @param {number[]} xs window coordinates.
 * @param {string} what
 */
function assertTakesPresses(handle, xs, what) {
  const rect = handle.getBoundingClientRect();
  const y = rect.top + rect.height / 2;
  for (const x of xs) {
    const hit = document.elementFromPoint(x, y);
    Assert.ok(
      hit === handle || handle.contains(hit),
      `${what} takes a press at x=${x} (got ${hit?.id || hit?.className || hit?.localName})`
    );
  }
}

/** @returns {DOMRect} the page's frame on screen, the selected tab's. */
function pageRect() {
  return gBrowser.selectedBrowser
    .closest(".browserSidebarContainer")
    .getBoundingClientRect();
}

/**
 * The xs from `REACH` inside `box`, across the gap, to `REACH` inside
 * `page`, on whichever side of the page the box stands.
 *
 * @param {DOMRect} box
 * @param {DOMRect} page
 * @returns {number[]}
 */
function across(box, page) {
  if (box.right <= page.left) {
    return [box.right - REACH, (box.right + page.left) / 2, page.left + REACH];
  }
  Assert.lessOrEqual(page.right, box.left, "the box stands beside the page");
  return [page.right - REACH, (page.right + box.left) / 2, box.left + REACH];
}

/**
 * Asserts that `handle` takes a press across the gap between `box` and the
 * page and just inside the page, and leaves a press just inside `box` to the
 * box, whose scrollbar runs along that edge.
 *
 * @param {Element} handle
 * @param {Element} box
 * @param {string} what
 */
function assertStopsAtBox(handle, box, what) {
  const rect = box.getBoundingClientRect();
  const page = pageRect();
  const inside =
    rect.right <= page.left ? rect.right - REACH : rect.left + REACH;
  assertTakesPresses(
    handle,
    across(rect, page).filter(x => x !== inside),
    what
  );
  const hit = document.elementFromPoint(inside, rect.top + rect.height / 2);
  Assert.ok(
    box.contains(hit) && hit !== handle,
    `${what} leaves a press just inside its box (got ${hit?.id || hit?.className || hit?.localName})`
  );
}

add_task(async function the_panels_edge_reaches_the_page() {
  const container = document.getElementById("sval-panel-container");
  const handle = container.querySelector(":scope > .sval-panel-resizer");
  withEdgeChecks(() => assertStopsAtBox(handle, container, "the panel's edge"));
});

/**
 * Asserts that every point across the tree's scrollbar is the tree's, up to
 * the panel's edge, where the edge's handle starts.
 */
async function assertScrollbarIsTheTrees() {
  await moveWindowOnScreen();
  const container = document.getElementById("sval-panel-container");
  const handle = container.querySelector(":scope > .sval-panel-resizer");
  const tree = await scrollingTree();
  const bar = nativePart(
    tree,
    el => el.localName === "scrollbar" && el.hasAttribute("vertical")
  );
  const thumb = nativePart(bar, el => el.localName === "thumb");
  const strip = bar.getBoundingClientRect();
  const edge = container.getBoundingClientRect();
  const grip = thumb.getBoundingClientRect();
  Assert.greater(strip.width, 0, "the tree has a scrollbar");
  Assert.lessOrEqual(strip.right, edge.right, "inside the panel");
  Assert.lessOrEqual(
    edge.right,
    handle.getBoundingClientRect().left,
    "and the edge's handle starts past it"
  );
  const y = grip.top + grip.height / 2;
  const xs = [strip.left + 1, strip.left + strip.width / 2, strip.right - 1];
  for (const x of xs) {
    const hit = document.elementFromPoint(x, y);
    Assert.ok(
      tree.contains(hit),
      `a press at x=${x} is the tree's (got ${hit?.id || hit?.className || hit?.localName})`
    );
  }
}

add_task(async function the_panels_scrollbar_is_the_trees() {
  await assertScrollbarIsTheTrees();
});

/** Windows 11's overlay scrollbars, which Gecko draws on any platform. */
add_task(async function the_panels_overlay_scrollbar_is_the_trees() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["widget.non-native-theme.scrollbar.style", 5],
      ["ui.useOverlayScrollbars", 1],
      ["ui.scrollbarDisplayOnMouseMove", 1],
    ],
  });
  await assertScrollbarIsTheTrees();
  await SpecialPowers.popPrefEnv();
});

add_task(async function the_sidebars_splitter_reaches_the_page() {
  await SidebarController.show("viewHistorySidebar");
  registerCleanupFunction(() => SidebarController.hide());
  const box = document.getElementById("sidebar-box");
  await TestUtils.waitForCondition(
    () => !box.hasAttribute("sval-overlay"),
    "the sidebar has slid in"
  );
  const splitter = document.getElementById("sidebar-splitter");
  assertStopsAtBox(splitter, box, "the sidebar's splitter");
  SidebarController.hide();
  await TestUtils.waitForCondition(
    () => !SidebarController.isOpen,
    "the sidebar closes"
  );
});

add_task(async function a_splits_divider_reaches_both_pages() {
  const tabs = [];
  for (let i = 0; i < 2; i++) {
    tabs.push(
      await within(
        BrowserTestUtils.openNewForegroundTab(
          gBrowser,
          `https://example.com/split-${i}`
        ),
        10_000,
        "a tab opening"
      )
    );
  }
  // Firefox records the first split it shows, as its own tests clear.
  registerCleanupFunction(() =>
    Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed")
  );
  gBrowser.addTabSplitView(tabs);
  const splitter = gBrowser.tabpanels.splitViewSplitter;
  await TestUtils.waitForCondition(
    () => BrowserTestUtils.isVisible(splitter),
    "the divider is on screen"
  );
  const [left, right] = Array.from(
    gBrowser.tabpanels.querySelectorAll(".split-view-panel-active"),
    pane => pane.getBoundingClientRect()
  ).sort((a, b) => a.left - b.left);
  assertTakesPresses(splitter, across(left, right), "the divider");
});

/**
 * Runs `pointer` without the accessible-rule check: the panel's edge is a
 * focusable separator, which the checker does not count among interactive
 * roles (`browser_sval_panel_resize.js`).
 *
 * @param {Function} pointer
 */
function withEdgeChecks(pointer) {
  AccessibilityUtils.setEnv({ mustHaveAccessibleRule: false });
  try {
    pointer();
  } finally {
    AccessibilityUtils.resetEnv();
  }
}
