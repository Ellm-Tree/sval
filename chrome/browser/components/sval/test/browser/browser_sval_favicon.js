/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */

/**
 * A real tab's row state end to end, through the window's own panel and tab
 * observer on the profile's engine, in the workspace the window shows.
 *
 * @returns {Promise<void>}
 */
async function panelStarted() {
  await within(SvalPanel.started, 10_000, "the panel's startup");
}

/** A real tab's favicon reaches the row drawn for that tab's node. */
add_task(async function a_real_tab_favicon_reaches_its_row() {
  await panelStarted();
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/"),
    10_000,
    "example.com's load"
  );
  try {
    await within(
      SvalPanel.observer.settled(),
      10_000,
      "SvalPanel.observer settling"
    );
    const id = SvalPanel.observer.nodeIdFor(tab);
    ok(id, "the tab has a node");
    await SvalPanel.refresh();
    const row = SvalPanel._rowElementFor(id);
    ok(row, "and a row");
    ok(row.querySelector(".sval-row-icon"), "with an icon slot");

    const icon = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>";
    gBrowser.setIcon(tab, icon);
    is(
      SvalPanel._rowElementFor(id)
        .querySelector(".sval-row-icon")
        .getAttribute("src"),
      icon,
      "the favicon reaches the row"
    );

    is(
      SvalPanel._rowElementFor(id).getAttribute("data-loaded"),
      "true",
      "a tab that loaded here is not muted"
    );
    ok(SvalPanel.observer.isLoaded(id), "and the observer agrees");
  } finally {
    BrowserTestUtils.removeTab(tab);
    await within(
      SvalPanel.observer.settled(),
      10_000,
      "SvalPanel.observer settling"
    );
  }
});

/**
 * A tab loading a page marks its row busy and shows the header's stop
 * button, and its reload button once it has loaded.
 */
add_task(async function a_loading_tab_shows_it_in_its_row_and_the_header() {
  await panelStarted();
  const key = crypto.randomUUID();
  atTaskEnd(() => fetch(`${ROOT}sval_agent_slow.sjs?release=${key}`));
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab({
      gBrowser,
      url: `${ROOT}sval_agent_slow.sjs?hold=${key}`,
      waitForLoad: false,
    }),
    10_000,
    "the held page's tab"
  );
  try {
    await within(
      SvalPanel.observer.settled(),
      10_000,
      "SvalPanel.observer settling"
    );
    const id = SvalPanel.observer.nodeIdFor(tab);
    ok(id, "the tab has a node");
    await SvalPanel.refresh();
    await TestUtils.waitForCondition(
      () => SvalPanel._rowElementFor(id)?.hasAttribute("data-busy"),
      "the row marked as loading"
    );

    const stop = document.getElementById("stop-button");
    ok(
      BrowserTestUtils.isVisible(stop),
      "the header shows the stop button while the page loads"
    );

    await fetch(`${ROOT}sval_agent_slow.sjs?release=${key}`);
    await within(
      BrowserTestUtils.browserLoaded(tab.linkedBrowser),
      10_000,
      "the held page's load"
    );
    await TestUtils.waitForCondition(
      () => !SvalPanel._rowElementFor(id)?.hasAttribute("data-busy"),
      "the row no longer marked as loading"
    );
    const reload = document.getElementById("reload-button");
    ok(
      BrowserTestUtils.isVisible(reload),
      "the header shows the reload button once the page has loaded"
    );
    // `CombinedStopReload.switchToReload` animates a load this long.
    ok(
      !BrowserTestUtils.isVisible(
        reload.querySelector(".toolbarbutton-animatable-box")
      ),
      "without Firefox's stop-to-reload sprite, which starts on the stop mark"
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
    await within(
      SvalPanel.observer.settled(),
      10_000,
      "SvalPanel.observer settling"
    );
  }
});
