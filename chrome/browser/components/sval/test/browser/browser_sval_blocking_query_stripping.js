/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// Strict turns on Firefox's query stripping in normal and private windows, and
// so does Custom made from Strict; leaving them puts it back, and a value the
// user set wins at every level, Firefox's Strict category among them
// (decision 0104).

const { SvalBlocking } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
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
 * @returns {Promise<string>} The query a page loaded with {@link QUERY} kept.
 */
async function queryAfterLoad(win) {
  return within(
    BrowserTestUtils.withNewTab(
      { gBrowser: win.gBrowser, url: `${PAGE2}?${QUERY}` },
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

add_task(async function strict_strips_and_leaving_it_puts_it_back() {
  await checkStripping(false, false, "Off");

  SvalBlocking.setLevel("strict");
  await checkStripping(true, true, "Strict");
  ok(
    !Services.prefs.prefHasUserValue(NORMAL) &&
      !Services.prefs.prefHasUserValue(PRIVATE),
    "Strict sets no value of the user's"
  );
  Assert.equal(
    Services.prefs.getStringPref(CATEGORY),
    "standard",
    "Firefox's tracking-protection category stays as it was"
  );

  SvalBlocking.setLevel("balanced");
  await checkStripping(false, false, "Balanced after Strict");

  SvalBlocking.customize();
  SvalBlocking.flush();
  await checkStripping(false, false, "Custom from Balanced");
  SvalBlocking.setLevel("off");
});

add_task(async function custom_from_strict_keeps_stripping() {
  SvalBlocking.setLevel("strict");
  SvalBlocking.setListEnabled("sval-fanboy-social", false);
  SvalBlocking.flush();
  Assert.equal(SvalBlocking.level, "custom", "editing a list makes Custom");
  await checkStripping(true, true, "Custom from Strict");

  Services.prefs.setBoolPref(NORMAL, false);
  await checkStripping(false, true, "the user's choice in Custom from Strict");
  Services.prefs.clearUserPref(NORMAL);

  SvalBlocking.setLevel("balanced");
  await checkStripping(false, false, "Balanced after Custom from Strict");

  SvalBlocking.setLevel("off");
  SvalBlocking.setListEnabled("sval-easylist", true);
  SvalBlocking.flush();
  await checkStripping(false, false, "Custom from Off");
  SvalBlocking.setLevel("off");
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

  SvalBlocking.setLevel("balanced");
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
