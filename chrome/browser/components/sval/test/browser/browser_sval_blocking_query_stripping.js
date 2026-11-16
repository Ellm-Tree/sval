/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_blocking_helpers.js */

// Every level but Off turns on Firefox's query stripping in normal and private
// windows, with the parameters the level's lists strip on every site; Off puts
// it back, and a value the user set wins at every level, Firefox's Strict
// category among them (decision 0104).

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_blocking_helpers.js",
  this
);

const { SvalBlocking } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
);
const { SvalBlockingLists } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlockingLists.sys.mjs"
);

const NORMAL = "privacy.query_stripping.enabled";
const PRIVATE = "privacy.query_stripping.enabled.pbmode";
const CATEGORY = "browser.contentblocking.category";
const QUERY = "paramToStrip1=123&paramToKeep=456";
const STRIPPED = "paramToKeep=456";

const { ContentBlockingPrefs } = ChromeUtils.importESModule(
  "moz-src:///browser/components/protections/ContentBlockingPrefs.sys.mjs"
);

/**
 * Puts Firefox's category back to Standard, its default. Writing "standard"
 * only clears the category's user value, which `updateCBCategory` ignores,
 * so the category's prefs are reset here.
 */
function backToStandard() {
  Services.prefs.clearUserPref(CATEGORY);
  ContentBlockingPrefs.setPrefsToCategory("standard");
}

const listService = Cc[
  "@mozilla.org/query-stripping-list-service;1"
].getService(Ci.nsIURLQueryStrippingListService);

let normalWindow;
let privateWindow;

add_setup(async function () {
  // The level, and the prefs Sval and Firefox derive from it, as this file
  // found them.
  keepPrefs(
    "browser.sval.adblock.",
    "privacy.trackingprotection.",
    "privacy.query_stripping.",
    "browser.contentblocking.category"
  );
  await SpecialPowers.pushPrefEnv({
    set: [
      ["privacy.query_stripping.strip_list", "paramToStrip1"],
      ["privacy.query_stripping.strip_on_share.enabled", false],
    ],
  });
  SvalBlocking.setLevel("off");
  await within(listService.testWaitForInit(), 10_000, "the list service");
  [normalWindow, privateWindow] = await within(
    Promise.all([
      BrowserTestUtils.openNewBrowserWindow(),
      BrowserTestUtils.openNewBrowserWindow({ private: true }),
    ]),
    20_000,
    "the windows opening"
  );
  registerCleanupFunction(async () => {
    SvalBlocking.setLevel("off");
    Services.prefs.clearUserPref(NORMAL);
    Services.prefs.clearUserPref(PRIVATE);
    // A user value of either moves Firefox's category to Custom, as it does
    // in Firefox; the files after this one start from Standard.
    backToStandard();
    await within(
      Promise.all([
        BrowserTestUtils.closeWindow(normalWindow),
        BrowserTestUtils.closeWindow(privateWindow),
      ]),
      10_000,
      "the windows closing"
    );
  });
});

/**
 * @param {Window} win
 * @param {string} [page] The page to load.
 * @param {string} [query] The query to load it with.
 * @returns {Promise<string>} The query the page kept.
 */
async function queryAfterLoad(win, page = PAGE2, query = QUERY) {
  return within(
    BrowserTestUtils.withNewTab(
      { gBrowser: win.gBrowser, url: `${page}?${query}` },
      async browser => browser.currentURI.query
    ),
    10_000,
    "a page loading"
  );
}

async function checkStripping(normal, inPrivate, what) {
  Assert.equal(Services.prefs.getBoolPref(NORMAL), normal, `${what}: pref`);
  Assert.equal(
    Services.prefs.getBoolPref(PRIVATE),
    inPrivate,
    `${what}: private pref`
  );
  Assert.equal(
    await within(
      listService.testWaitForInit(),
      10_000,
      "the list service following the prefs"
    ),
    normal || inPrivate,
    `${what}: the list service runs while stripping is on`
  );
  Assert.equal(
    await queryAfterLoad(normalWindow),
    normal ? STRIPPED : QUERY,
    `${what}: a normal window's load`
  );
  Assert.equal(
    await queryAfterLoad(privateWindow),
    inPrivate ? STRIPPED : QUERY,
    `${what}: a private window's load`
  );
}

add_task(async function every_level_but_off_strips() {
  await checkStripping(false, false, "Off");

  SvalBlocking.setLevel("balanced");
  await checkStripping(true, true, "Balanced");
  ok(
    !Services.prefs.prefHasUserValue(NORMAL) &&
      !Services.prefs.prefHasUserValue(PRIVATE),
    "the level sets no value of the user's"
  );
  Assert.equal(
    Services.prefs.getStringPref(CATEGORY),
    "standard",
    "Firefox's tracking-protection category stays as it was"
  );

  SvalBlocking.setLevel("strict");
  await checkStripping(true, true, "Strict");

  SvalBlocking.setLevel("off");
  await checkStripping(false, false, "Off after Strict");
});

add_task(async function custom_strips_from_any_level() {
  SvalBlocking.setLevel("balanced");
  SvalBlocking.setListEnabled("sval-easylist", false);
  SvalBlocking.flush();
  Assert.equal(SvalBlocking.level, "custom", "editing a list makes Custom");
  await checkStripping(true, true, "Custom from Balanced");

  Services.prefs.setBoolPref(NORMAL, false);
  await checkStripping(false, true, "the user's choice in Custom");
  Services.prefs.clearUserPref(NORMAL);

  SvalBlocking.setLevel("off");
  SvalBlocking.setListEnabled("sval-easylist", true);
  SvalBlocking.flush();
  await checkStripping(true, true, "Custom from Off");
  SvalBlocking.setLevel("off");
  backToStandard();
});

add_task(async function the_levels_lists_add_their_parameters() {
  await serveLists({
    "sval-ublock-privacy": [
      "! Title: Test privacy",
      "$removeparam=listparam",
      "||example.com^$removeparam=sitescoped",
      "@@||example.org^$removeparam",
    ].join("\n"),
  });
  // Mozilla's list and the file's own parameter stay; the lists' parameters
  // are the strip list's default, which a value of the user's would hide.
  await SpecialPowers.pushPrefEnv({
    clear: [["privacy.query_stripping.strip_list"]],
  });
  const STRIP_LIST = "privacy.query_stripping.strip_list";
  const ALLOW_LIST = "privacy.query_stripping.allow_list";
  const QUERY_WITH_LIST = "listparam=1&sitescoped=2&paramToKeep=456";
  const defaults = Services.prefs.getDefaultBranch("");

  SvalBlocking.setLevel("balanced");
  const followed = TestUtils.waitForPrefChange(
    STRIP_LIST,
    value => value == "listparam"
  );
  ok(
    await SvalBlockingLists.update("sval-ublock-privacy"),
    "the list downloads"
  );
  await within(followed, 10_000, "the strip list following the download");
  Assert.equal(defaults.getStringPref(ALLOW_LIST), "example.org");
  Assert.equal(
    await queryAfterLoad(normalWindow, PAGE2, QUERY_WITH_LIST),
    "sitescoped=2&paramToKeep=456",
    "a load strips the list's parameter and keeps the one scoped to a site"
  );
  Assert.equal(
    await queryAfterLoad(privateWindow, PAGE2, QUERY_WITH_LIST),
    "sitescoped=2&paramToKeep=456",
    "and so does a private window's"
  );
  Assert.equal(
    await queryAfterLoad(normalWindow, ORG_PAGE, QUERY_WITH_LIST),
    QUERY_WITH_LIST,
    "the site the list excepts keeps every parameter"
  );

  const emptied = TestUtils.waitForPrefChange(STRIP_LIST, value => !value);
  SvalBlocking.setLevel("off");
  await within(emptied, 10_000, "Off emptying the strip list");
  Assert.equal(defaults.getStringPref(ALLOW_LIST), "");

  // The profile keeps the copy, and the level the file found would read its
  // rules back into the strip list, so a copy with none replaces it.
  await serveLists();
  ok(
    await SvalBlockingLists.update("sval-ublock-privacy"),
    "a copy with no rules replaces the test's"
  );
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
  backToStandard();
});

add_task(async function the_users_own_choice_wins_at_every_level() {
  Services.prefs.setBoolPref(PRIVATE, true);
  await checkStripping(false, true, "the user's private choice at Off");

  SvalBlocking.setLevel("strict");
  Services.prefs.setBoolPref(NORMAL, false);
  await checkStripping(false, true, "the user's choice at Strict");

  SvalBlocking.setLevel("off");
  await checkStripping(false, true, "the user's choice after Strict");

  Services.prefs.clearUserPref(NORMAL);
  Services.prefs.clearUserPref(PRIVATE);
  backToStandard();
});

add_task(async function firefoxs_strict_category_outlasts_svals_strict() {
  SvalBlocking.setLevel("strict");
  Services.prefs.setStringPref(CATEGORY, "strict");
  await checkStripping(true, true, "both Stricts");

  SvalBlocking.setLevel("off");
  Assert.equal(
    Services.prefs.getStringPref(CATEGORY),
    "strict",
    "Firefox's category stays Strict"
  );
  await checkStripping(true, true, "Firefox's Strict after Sval's");

  SvalBlocking.setLevel("off");
  backToStandard();
  await checkStripping(false, false, "Standard again");
});
