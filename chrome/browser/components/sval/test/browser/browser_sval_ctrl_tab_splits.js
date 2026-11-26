/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_ctrl_tab_helpers.js */

/**
 * A Split in the Ctrl+Tab switcher (`SvalTabSwitcher`): one card holding a
 * preview of each pane, in the window's order, which picking shows at the
 * pane used last, and which Ctrl+W closes whole. A pane closed elsewhere
 * leaves the card with the others.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_ctrl_tab_helpers.js",
  this
);

/**
 * Opens tabs A, B, C and D, makes A and B a Split, and uses B, then D.
 * In order of use that is D, the Split at B, then C.
 *
 * @returns {Promise<Element[]>} A, B, C and D.
 */
async function withSplit() {
  // Firefox records the first split it shows, as its own tests clear.
  atTaskEnd(() =>
    Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed")
  );
  const tabs = [];
  for (const title of ["A", "B", "C", "D"]) {
    tabs.push(await openPage(titledPage(title)));
  }
  const [a, b, , d] = tabs;
  gBrowser.addTabSplitView([a, b]);
  await TestUtils.waitForCondition(
    () => a.splitview && a.splitview === b.splitview,
    "A and B making a Split"
  );
  await selectTab(b);
  await selectTab(d);
  return tabs;
}

/** @returns {Element|null} The Split's card. */
function splitCard() {
  return switcherOptions().find(option => option.hasAttribute("data-split"));
}

add_task(async function a_split_is_one_card_that_shows_its_last_pane() {
  await withSplit();
  await holdCtrlTab();
  const options = switcherOptions();
  Assert.equal(
    options.filter(option => option.hasAttribute("data-split")).length,
    1,
    "the Split is one card"
  );
  const card = splitCard();
  Assert.equal(options.indexOf(card), 1, "second in order of use");
  Assert.equal(card.getAttribute("aria-selected"), "true", "it is selected");
  Assert.equal(
    card.querySelectorAll(".sval-switcher-preview").length,
    2,
    "with a preview of each pane"
  );
  Assert.equal(
    optionTitle(card),
    "Split View: A, B",
    "named by its panes, in the window's order"
  );

  await releaseCtrl();
  Assert.equal(
    gBrowser.selectedTab.label,
    "B",
    "picking shows the pane used last"
  );
});

add_task(async function ctrl_w_closes_the_whole_split() {
  const [a, b, c] = await withSplit();
  await holdCtrlTab();
  Assert.ok(splitCard(), "the Split's card is selected");
  const closed = Promise.all(
    [a, b].map(tab => BrowserTestUtils.waitForEvent(tab, "TabClose"))
  );
  EventUtils.synthesizeKey("w", { ctrlKey: true });
  await within(closed, 10_000, "Ctrl+W closing the Split's panes");
  Assert.ok(!a.isConnected && !b.isConnected, "both panes closed");
  Assert.ok(c.isConnected, "and the tab after them stays");
  Assert.ok(!splitCard(), "the Split's card is gone");

  await releaseCtrl();
  Assert.equal(gBrowser.selectedTab, c, "letting go picks the next card");
});

add_task(async function a_pane_closed_elsewhere_leaves_its_card() {
  const [a] = await withSplit();
  await holdCtrlTab();
  const closed = BrowserTestUtils.waitForEvent(a, "TabClose");
  gBrowser.removeTab(a);
  await within(closed, 10_000, "A closing");
  Assert.ok(!splitCard(), "no card shows a Split");
  Assert.ok(
    switcherOptions().map(optionTitle).includes("B"),
    "B has a card of its own"
  );

  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    () => !switcherShown(),
    "the switcher closing"
  );
  await releaseCtrl();
});
