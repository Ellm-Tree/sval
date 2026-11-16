/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */

/**
 * §10.4's materialisation is for a node with no live browser. A node that has
 * one is *shown*: the panel is the only tab surface, so opening a second tab
 * for a row the user already has open would make one row stand for two pages.
 */
add_task(async function activating_a_row_shows_the_tab_it_already_has() {
  const first = await within(
    BrowserTestUtils.openNewForegroundTab(
      gBrowser,
      "https://example.com/first"
    ),
    15_000,
    "the first tab opening and loading"
  );
  const second = await within(
    BrowserTestUtils.openNewForegroundTab(
      gBrowser,
      "https://example.com/second"
    ),
    15_000,
    "the second tab opening and loading"
  );
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  const id = SvalPanel.observer.nodeIdFor(first);
  ok(id, "the first tab has a row");
  is(gBrowser.selectedTab, second, "the second tab is the one on screen");
  const tabsBefore = gBrowser.tabs.length;

  await SvalPanel.activate({ id, kind: "tab", expanded: false });

  is(gBrowser.selectedTab, first, "activating the row went to its browser");
  is(
    gBrowser.tabs.length,
    tabsBefore,
    "and opened no second tab for a row that already had one"
  );
});
