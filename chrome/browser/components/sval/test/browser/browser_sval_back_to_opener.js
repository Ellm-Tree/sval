/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * Back on a tab a link opened, with no page of its own to go back to,
 * closes the tab and shows the tab the link was in (`SvalBackToOpener`).
 */

/** A page whose `#out` link opens {@link LINKS} in a new tab. */
const OPENER_PAGE = ROOT + "sval_agent_popup.html";

const backCommand = () => document.getElementById("Browser:Back");
const tooltipId = () =>
  document.l10n.getAttributes(
    document.getElementById("back-button-tooltip-description")
  ).id;

/**
 * Opens {@link OPENER_PAGE} and clicks its link.
 *
 * @returns {Promise<{opener: object, tab: object}>}
 */
async function openFromLink() {
  const opener = await openPage(OPENER_PAGE);
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, LINKS, true);
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#out",
    {},
    opener.linkedBrowser
  );
  const tab = await within(opened, 10_000, "the link's tab opening");
  await switchDone(window);
  Assert.equal(gBrowser.selectedTab, tab, "the link's tab is in front");
  Assert.equal(tab.openerTab, opener, "the link's tab knows its opener");
  return { opener, tab };
}

/**
 * Presses Back and waits for `tab` to close.
 *
 * @param {object} tab
 */
async function backCloses(tab) {
  const closed = BrowserTestUtils.waitForTabClosing(tab);
  BrowserCommands.back();
  await within(closed, 10_000, "the tab closing");
  await switchDone(window);
}

add_task(async function back_closes_a_tab_to_its_opener() {
  const { opener, tab } = await openFromLink();
  Assert.ok(!backCommand().hasAttribute("disabled"), "Back is enabled");
  Assert.equal(
    tooltipId(),
    "sval-navbar-tooltip-back-to-opener",
    "Back's tooltip says it closes the tab"
  );

  await backCloses(tab);
  Assert.equal(gBrowser.selectedTab, opener, "the opener is in front");
  Assert.equal(
    tooltipId(),
    "navbar-tooltip-back-2",
    "Back's tooltip is the history one again"
  );
});

add_task(async function back_steps_through_the_tabs_history_first() {
  const { opener, tab } = await openFromLink();
  const browser = tab.linkedBrowser;
  BrowserTestUtils.startLoadingURIString(browser, PAGE2);
  await pageReady(browser, PAGE2);
  Assert.equal(
    tooltipId(),
    "navbar-tooltip-back-2",
    "with a page to go back to, Back's tooltip is the history one"
  );

  const back = BrowserTestUtils.waitForLocationChange(gBrowser, LINKS);
  BrowserCommands.back();
  await within(back, 10_000, "the tab going back a page");
  Assert.ok(!tab.closing, "the first Back stays in the tab");

  await backCloses(tab);
  Assert.equal(gBrowser.selectedTab, opener, "the second Back closes it");
});

add_task(async function a_tab_nothing_opened_has_no_back() {
  const tab = await openPage(PAGE);
  Assert.equal(tab.openerTab, null, "the tab has no opener");
  Assert.ok(backCommand().hasAttribute("disabled"), "Back is disabled");
  Assert.equal(tooltipId(), "navbar-tooltip-back-2", "Back's tooltip");
});

add_task(async function back_turns_off_when_the_opener_closes() {
  const { opener, tab } = await openFromLink();
  expectOpened(tab);
  Assert.ok(!backCommand().hasAttribute("disabled"), "Back is enabled");

  BrowserTestUtils.removeTab(opener);
  Assert.ok(backCommand().hasAttribute("disabled"), "Back is disabled");
  BrowserCommands.back();
  Assert.ok(!tab.closing, "Back leaves the tab open");
});
