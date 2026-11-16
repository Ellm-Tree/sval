/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * While rows lie past the Workspace panel tree's top or bottom edge, the
 * header or the footer across that edge casts a shadow over them.
 */

/**
 * @param {Element} part The panel's header or footer.
 * @returns {boolean} whether it casts its shadow.
 */
function shades(part) {
  return (
    part.hasAttribute("sval-over-rows") &&
    getComputedStyle(part, "::after").opacity === "1"
  );
}

add_task(async function the_edges_shade_the_rows_past_them() {
  for (let i = 0; i < 40; i++) {
    BrowserTestUtils.addTab(gBrowser, `https://example.com/edge/${i}`, {
      createLazyBrowser: true,
    });
  }
  const tree = document.querySelector(".sval-tree");
  const header = document.querySelector(".sval-panel-header");
  const footer = document.querySelector(".sval-panel-footer");
  // Every row is in before the tree scrolls: one drawn after the scroll to
  // the bottom would leave the tree short of it.
  await TestUtils.waitForCondition(
    () =>
      tree.querySelectorAll('[role="treeitem"][data-kind="tab"]').length ===
      gBrowser.tabs.length,
    "a row for every tab"
  );
  Assert.greater(
    tree.scrollHeight,
    tree.clientHeight,
    "the tree holds more rows than it shows"
  );

  tree.scrollTop = 0;
  await TestUtils.waitForCondition(
    () => !shades(header) && shades(footer),
    "at the top, only the footer shading the rows below it"
  );
  Assert.ok(shades(footer), "at the top, the footer shades the rows below");
  Assert.ok(!shades(header), "and the header nothing");
  tree.scrollTop = tree.scrollHeight;
  await TestUtils.waitForCondition(
    () => shades(header) && !shades(footer),
    "at the bottom, only the header shading the rows above it"
  );
  Assert.ok(shades(header), "at the bottom, the header shades the rows above");
  Assert.ok(!shades(footer), "and the footer nothing");
  tree.scrollTop = Math.floor((tree.scrollHeight - tree.clientHeight) / 2);
  await TestUtils.waitForCondition(
    () => shades(header) && shades(footer),
    "in the middle, both"
  );
  Assert.ok(shades(header) && shades(footer), "in the middle, both shade");
});
