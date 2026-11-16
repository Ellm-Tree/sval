/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_pins_helpers.js */

/**
 * Links in a pin's page (pins spec §5, §12.6): one to another site opens in
 * Quick Peek with the pin named in its bar, ⌘-click opens a tab, and with the
 * setting off the link navigates the pin. A sandboxed frame's link does only
 * what its sandbox allows.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_pins_helpers.js",
  this
);

const { SvalQuickPeek } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalQuickPeek.sys.mjs"
);
const { PINS_QUICK_PEEK_PREF } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPinsModel.sys.mjs"
);

/** `#elsewhere` on the page of links. */
const ELSEWHERE = ORG_PAGE;

/** `#samesite` on the page of links: another host of the page's site. */
const SAME_SITE = PAGE2.replace("://example.com/", "://test1.example.com/");

add_setup(pinsSetup);

/**
 * Clicks `#elsewhere` in the pin's page, after a first click on the page,
 * as a person reads before they click.
 *
 * @param {object} page The pin's tab.
 * @param {object} [modifiers]
 */
async function clickElsewhere(page, modifiers = {}) {
  await BrowserTestUtils.synthesizeMouseAtCenter("h1", {}, page.linkedBrowser);
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#elsewhere",
    modifiers,
    page.linkedBrowser
  );
}

add_task(async function a_link_to_another_host_opens_in_quick_peek() {
  const guid = await pinFavorite(LINKS_PAGE, "Links");
  const page = await clickTile(guid, LINKS_PAGE);
  await clickElsewhere(page);
  await TestUtils.waitForCondition(
    () => SvalQuickPeek.tabOf(window),
    "a Quick Peek opens"
  );
  const quickPeek = SvalQuickPeek.tabOf(window);
  await committed(() => quickPeek.linkedBrowser, ELSEWHERE);
  Assert.equal(gBrowser.selectedTab, page, "the pin stays selected under it");
  Assert.equal(
    page.linkedBrowser.currentURI.spec,
    LINKS_PAGE,
    "and stays on its page"
  );
  const chip = document
    .getElementById(quickPeek.linkedPanel)
    .querySelector(".sval-quick-peek-from");
  Assert.ok(chip?.textContent.includes("Links"), "the bar names the pin");
  const split = document
    .getElementById(quickPeek.linkedPanel)
    .querySelector(".sval-quick-peek-split");
  Assert.equal(
    split.getAttribute("aria-disabled"),
    "true",
    "a pin's page takes no Split"
  );
  Assert.equal(split.dataset.split, "pin", "and the button says why");

  // Open as tab: where Sval puts a new tab.
  document
    .getElementById(quickPeek.linkedPanel)
    .querySelector(".sval-quick-peek-tab")
    .click();
  await TestUtils.waitForCondition(
    async () =>
      (await tabNodes()).some(node => node.content?.url === ELSEWHERE),
    "kept, the page is a tab"
  );
  atTaskEnd(() => BrowserTestUtils.removeTab(quickPeek));
  expectOpened(quickPeek);
});

add_task(async function a_link_to_another_host_on_the_site_stays_in_the_pin() {
  const guid = await pinFavorite(LINKS_PAGE, "Links");
  const page = await clickTile(guid, LINKS_PAGE);
  await BrowserTestUtils.synthesizeMouseAtCenter("h1", {}, page.linkedBrowser);
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#samesite",
    {},
    page.linkedBrowser
  );
  await committed(page.linkedBrowser, SAME_SITE);
  Assert.ok(!SvalQuickPeek.tabOf(window), "no Quick Peek");
  Assert.equal(gBrowser.selectedTab, page, "the pin stays selected");
});

/**
 * A link clicked the moment the pin's page has loaded, with no press on the
 * page before it, leaves the pin as any later one does (pins spec §14).
 */
add_task(async function a_first_click_on_a_fresh_page_opens_in_quick_peek() {
  const guid = await pinFavorite(LINKS_PAGE, "Links");
  const page = await clickTile(guid, LINKS_PAGE);
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#elsewhere",
    {},
    page.linkedBrowser
  );
  await committed(() => SvalQuickPeek.tabOf(window)?.linkedBrowser, ELSEWHERE);
  Assert.equal(
    page.linkedBrowser.currentURI.spec,
    LINKS_PAGE,
    "and the pin stays on its page"
  );
  SvalQuickPeek.close(window);
});

add_task(async function a_cmd_click_opens_a_tab() {
  const guid = await pinFavorite(LINKS_PAGE, "Links");
  const page = await clickTile(guid, LINKS_PAGE);
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, ELSEWHERE);
  await clickElsewhere(page, { accelKey: true });
  const tab = await within(opened, 10_000, "a tab opens");
  Assert.ok(!SvalQuickPeek.tabOf(window), "no Quick Peek");
  Assert.equal(
    page.linkedBrowser.currentURI.spec,
    LINKS_PAGE,
    "the pin stays on its page"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function with_quick_peek_off_a_link_navigates_the_pin() {
  await SpecialPowers.pushPrefEnv({ set: [[PINS_QUICK_PEEK_PREF, false]] });
  const guid = await pinFavorite(LINKS_PAGE, "Links");
  const page = await clickTile(guid, LINKS_PAGE);
  await clickElsewhere(page);
  await committed(page.linkedBrowser, ELSEWHERE);
  Assert.ok(!SvalQuickPeek.tabOf(window), "no Quick Peek");
  const slot = tileOf(guid).closest(".sval-pin-slot");
  await TestUtils.waitForCondition(
    () =>
      slot.isConnected &&
      tileOf(guid).closest(".sval-pin-slot").querySelector(".sval-pin-refresh"),
    "and the refresh button can bring it back"
  );
  await SpecialPowers.popPrefEnv();
});

/**
 * A frame from another site in a pin's page, such as an advertiser's, learns
 * nothing of the pin's saved address, and cannot settle where the pin is.
 */
add_task(async function a_frame_in_a_pin_gets_no_saved_address() {
  const framed = ROOT + "sval_pin_frame.html";
  const guid = await pinFavorite(framed, "Framed");
  const page = await clickTile(guid, framed);
  const frame = page.linkedBrowser.browsingContext.children[0];
  await pageReady(frame, ORG_PAGE);
  const answer = await SpecialPowers.spawn(frame, [], async () =>
    content.windowGlobalChild.getActor("SvalPin").sendQuery("SvalPin:Which")
  );
  Assert.deepEqual(
    answer,
    { site: "example.com", quickPeek: true },
    "the frame is told the pin's site and no more"
  );
  Assert.ok(
    !JSON.stringify(answer).includes("sval_pin_frame"),
    "and never its saved address"
  );
  await SpecialPowers.spawn(frame, [], () =>
    content.windowGlobalChild
      .getActor("SvalPin")
      .sendAsyncMessage("SvalPin:Touched")
  );
  // The parent answers in order, so the frame's message has arrived once
  // this answer has.
  await SpecialPowers.spawn(frame, [], async () =>
    content.windowGlobalChild.getActor("SvalPin").sendQuery("SvalPin:Which")
  );
  Assert.ok(
    !SvalPinPages.pageOfTab(page).touched,
    "a frame's press does not settle the pin"
  );
});

/**
 * A sandboxed frame that may not navigate the page cannot reach it through
 * a Quick Peek either: its `_top` link to another site does nothing.
 */
add_task(async function a_sandboxed_frames_link_leaves_the_pin_alone() {
  const framed = ROOT + "sval_pin_sandboxed_frame.html";
  const guid = await pinFavorite(framed, "Sandboxed");
  const page = await clickTile(guid, framed);
  const frame = page.linkedBrowser.browsingContext.children[0];
  await SpecialPowers.spawn(frame, [], () =>
    ContentTaskUtils.waitForCondition(
      () => !!content.document.getElementById("out"),
      "the frame's link is there"
    )
  );
  await BrowserTestUtils.synthesizeMouseAtCenter("#out", {}, frame);
  // The parent answers in order, so a Quick Peek the click asked for has arrived
  // once this answer has.
  await SpecialPowers.spawn(frame, [], async () =>
    content.windowGlobalChild.getActor("SvalPin").sendQuery("SvalPin:Which")
  );
  Assert.ok(!SvalQuickPeek.tabOf(window), "no Quick Peek opens");
  Assert.equal(
    page.linkedBrowser.currentURI.spec,
    framed,
    "and the pin stays on its page"
  );
});
