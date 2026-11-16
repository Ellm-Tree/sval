/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */

/**
 * Settings scrolls inside its pane, and the page around it cannot scroll.
 * `#preferences-body` is `overflow: hidden`, which `scrollIntoView` still
 * scrolls when anything overflows it, as Firefox's `scrollAndHighlight` does
 * when Settings opens at a subcategory. Sval's panes must keep their content,
 * absolutely positioned parts included, inside `.main-content`.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

for (const category of ["privacy", "svalSites", "svalAgents", "svalKeyboard"]) {
  add_task(async function the_page_around_the_pane_cannot_scroll() {
    const { page } = await openPane(
      category,
      ({ page: p }) => paneOf(p, category)?.checkVisibility(),
      `the ${category} pane`
    );
    const body = page.document.getElementById("preferences-body");
    Assert.equal(
      body.scrollTopMax,
      0,
      `${category}: the page has nothing to scroll`
    );
  });
}
