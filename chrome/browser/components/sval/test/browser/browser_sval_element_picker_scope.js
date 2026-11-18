/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_blocking_helpers.js */
/* import-globals-from sval_element_picker_helpers.js */

// The element picker's card on a host under its site (host-scoped rules
// spec §4): its title picks where the rule is saved, starting at the host.

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_blocking_helpers.js",
  this
);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_element_picker_helpers.js",
  this
);

const { SvalBlocking, MY_FILTER_BRANCH } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
);
const { SvalBlockingLists } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlockingLists.sys.mjs"
);
const { SvalElementPicker } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalElementPicker.sys.mjs"
);

const PATH =
  "/browser/browser/components/sval/test/browser/sval_element_picker.html";
const HOST_PAGE = `https://test1.example.com${PATH}`;
const SITE_PAGE = `https://example.net${PATH}`;

add_setup(async function () {
  keepPrefs(
    "browser.sval.adblock.",
    "privacy.trackingprotection.",
    "privacy.query_stripping.",
    "browser.contentblocking.category"
  );
  await SpecialPowers.pushPrefEnv({
    set: [...CONTENT_BLOCKING_TEST_PREFS],
    clear: [
      ["browser.sval.adblock.customFrom"],
      ["browser.sval.adblock.myFiltersTrustedHere"],
    ],
  });
  registerCleanupFunction(() => clearPrefBranches(MY_FILTER_BRANCH));
  await serveLists();
  registerCleanupFunction(async () => {
    SvalBlocking.setLevel("off");
    await IOUtils.remove(SvalBlockingLists.dir, {
      recursive: true,
      ignoreAbsent: true,
    });
  });
  SvalBlocking.setLevel("off");
  SvalBlocking.setListEnabled("sval-easylist", true);
  SvalBlocking.flush();
  ok(await SvalBlockingLists.update("sval-easylist"), "a list downloads");
  await listsInForce();
});

/**
 * Starts the picker and chooses the page's box.
 *
 * @param {Element} browser
 * @returns {Promise<object>} the overlay's state with its card.
 */
async function chooseTheBox(browser) {
  await within(
    SvalElementPicker.start(browser, "remove"),
    10_000,
    "the picker starting"
  );
  await overlayUntil(browser, s => s?.bar, "the pointing bar");
  await BrowserTestUtils.synthesizeMouseAtCenter("#ad", {}, browser);
  return overlayUntil(browser, s => s?.card, "the card");
}

add_task(async function the_card_saves_at_the_scope_picked() {
  atTaskEnd(() => SvalBlocking.setMyFilters(""));
  await BrowserTestUtils.withNewTab(HOST_PAGE, async browser => {
    let state = await chooseTheBox(browser);
    is(state.scope, "test1.example.com", "the card starts at the host");
    Assert.deepEqual(state.rules, ["test1.example.com##.sval-test-ad"]);

    await clickOverlay(browser, "card-scope-button");
    await clickOverlay(browser, "card-scope-option-1");
    state = await overlayUntil(
      browser,
      s => s?.scope == "example.com",
      "the site picked"
    );
    Assert.deepEqual(state.rules, ["example.com##.sval-test-ad"]);

    await clickOverlay(browser, "hide");
    await overlayUntil(browser, s => s?.toast, "the toast");
    is(
      SvalBlocking.myFilters,
      "example.com##.sval-test-ad",
      "saved for the site"
    );
  });
});

add_task(async function the_next_card_starts_at_the_host_again() {
  atTaskEnd(() => SvalBlocking.setMyFilters(""));
  await BrowserTestUtils.withNewTab(HOST_PAGE, async browser => {
    await chooseTheBox(browser);
    await clickOverlay(browser, "card-scope-button");
    await clickOverlay(browser, "card-scope-option-1");
    await overlayUntil(browser, s => s?.scope == "example.com", "the site");
    SvalElementPicker.stop(browser);
    await overlayUntil(browser, s => !s, "the overlay going");

    const state = await chooseTheBox(browser);
    is(state.scope, "test1.example.com", "back at the host");
    await clickOverlay(browser, "hide");
    await overlayUntil(browser, s => s?.toast, "the toast");
    is(
      SvalBlocking.myFilters,
      "test1.example.com##.sval-test-ad",
      "saved for the host"
    );
  });
});

add_task(async function a_plain_site_has_no_scope_to_choose() {
  await BrowserTestUtils.withNewTab(SITE_PAGE, async browser => {
    const state = await chooseTheBox(browser);
    is(state.scope, null, "the title names the site alone");
    SvalElementPicker.stop(browser);
    await overlayUntil(browser, s => !s, "the overlay going");
  });
});
