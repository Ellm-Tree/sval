/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * Closing the selected tab shows the tab of the Workspace the user saw last,
 * wherever it sits in Firefox's hidden tab strip.
 */

/** @returns {Promise<object>} a tab opened in front and filed. */
async function foregroundTab() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE),
    10_000,
    "a tab opening"
  );
  await within(SvalPanel.observer.settled(), 10_000, "the tab being filed");
  return tab;
}

/** Closes the selected tab as Cmd/Ctrl+W does, once the switch is done. */
async function closeSelected() {
  const closed = BrowserTestUtils.waitForTabClosing(gBrowser.selectedTab);
  BrowserCommands.closeTabOrWindow();
  await within(closed, 10_000, "the tab closing");
  await switchDone(window);
}

add_task(async function closing_returns_to_the_tab_seen_last() {
  const a = await foregroundTab();
  const b = await foregroundTab();
  const c = await foregroundTab();
  await selectTab(a);
  await selectTab(c);
  await selectTab(a);
  Assert.equal(
    gBrowser.tabContainer.findNextTab(a, { direction: 1 }),
    b,
    "the strip's next tab is one the user saw longer ago"
  );

  await closeSelected();
  Assert.equal(gBrowser.selectedTab, c, "closing it shows the tab seen last");
  await closeSelected();
  Assert.equal(gBrowser.selectedTab, b, "and closing that the one before");
});

add_task(async function a_tab_never_seen_is_not_returned_to() {
  const a = await foregroundTab();
  const b = await foregroundTab();
  const unseen = await within(
    BrowserTestUtils.addTab(gBrowser, PAGE),
    10_000,
    "a background tab opening"
  );
  await within(SvalPanel.observer.settled(), 10_000, "the tab being filed");
  Assert.equal(gBrowser.selectedTab, b, "the background tab stays unseen");
  Assert.equal(
    gBrowser.tabContainer.findNextTab(b, { direction: 1 }),
    unseen,
    "the strip's next tab is the unseen one"
  );

  await closeSelected();
  Assert.equal(gBrowser.selectedTab, a, "closing it shows the tab seen last");
});
