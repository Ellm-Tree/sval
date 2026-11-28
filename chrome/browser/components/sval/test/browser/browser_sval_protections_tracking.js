/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */

/**
 * Firefox's tracking protection in Privacy and protection (fingerprinting
 * spec §3): Sval's cards replace Enhanced Tracking Protection, every pref its
 * pages reached is a control of Sval's, in the Fingerprinting card, Cookies
 * and site data or the category's Advanced, their addresses land there, and
 * none of its UI shows anywhere else.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

const CATEGORY = "browser.contentblocking.category";

/** The prefs the tracking controls write, cleared before each task. */
const SWITCH_PREFS = [
  "privacy.fingerprintingProtection",
  "privacy.fingerprintingProtection.pbmode",
  "network.cookie.cookieBehavior",
  "privacy.query_stripping.enabled",
  "privacy.query_stripping.enabled.pbmode",
  "privacy.bounceTrackingProtection.mode",
  "network.http.referer.disallowCrossSiteRelaxingDefault.top_navigation",
];

function clearSwitchPrefs() {
  for (const name of SWITCH_PREFS) {
    Services.prefs.clearUserPref(name);
  }
  Services.prefs.clearUserPref(CATEGORY);
}

// As this file found them, with the record Firefox keeps of a change to its
// category (`UrlClassifierExceptionListService`).
keepPrefs(
  ...SWITCH_PREFS,
  CATEGORY,
  "privacy.trackingprotection.allow_list.hasUserInteractedWithETPSettings"
);

/**
 * Opens settings on Privacy and protection, with its Advanced closed.
 *
 * @returns {Promise<object>} `openSettings`' result, with `pane` and `doc`.
 */
async function openProtections() {
  await panelWithFolder(null);
  const ui = await openSettings();
  await showPane(ui.page, "privacy");
  await TestUtils.waitForCondition(
    () => ui.byId("sval-fp")?.checkVisibility(),
    "Privacy and protection is showing"
  );
  ui.page.document.getElementById("sval-privacy-advanced").open = false;
  return {
    ...ui,
    doc: ui.page.document,
    pane: paneOf(ui.page, "privacy"),
  };
}

/**
 * @param {object} ui From `openProtections`.
 * @param {string} query
 */
async function search(ui, query) {
  const input = ui.doc.getElementById("searchInput");
  const done = BrowserTestUtils.waitForEvent(
    ui.page,
    "PreferencesSearchCompleted",
    false,
    event => event.detail == query
  );
  input.value = query;
  input.dispatchEvent(new ui.page.Event("input"));
  await within(done, 10_000, `the search for "${query}"`);
}

/** Every setting group of Enhanced Tracking Protection's, by id. */
const ETP_GROUPS = [
  "etpStatus",
  "etpBanner",
  "etpAdvanced",
  "etpReset",
  "etpCustomize",
  "securityPrivacyStatus",
];

/**
 * @param {Document} doc
 * @returns {Element[]} Enhanced Tracking Protection's groups, pages and
 *   status card in `doc`.
 */
function etpSurfaces(doc) {
  return [
    ...doc.querySelectorAll(
      [
        ...ETP_GROUPS.map(id => `setting-group[groupid="${id}"]`),
        'setting-pane[data-category="paneEtp"]',
        'setting-pane[data-category="paneEtpCustomize"]',
        "security-privacy-card",
      ].join(",")
    ),
  ];
}

/**
 * Enhanced Tracking Protection's groups, pages and status card are nowhere:
 * not in Privacy and protection, and not in settings search.
 */
add_task(async function tracking_protection_is_gone() {
  const ui = await openProtections();
  await TestUtils.waitForCondition(
    () => ui.doc.querySelector('setting-group[groupid="history2"]'),
    "Firefox's groups are drawn"
  );
  Assert.deepEqual(etpSurfaces(ui.doc), [], "none in Privacy and protection");

  await search(ui, "enhanced tracking protection");
  Assert.deepEqual(etpSurfaces(ui.doc), [], "search finds none");
  Assert.ok(
    !ui.byId("sval-tracking-more").checkVisibility(),
    "and does not take its name for Sval's tracking settings"
  );

  await search(ui, "tracking parameters");
  const card = ui.byId("sval-tracking-more");
  Assert.ok(card.checkVisibility(), "sval's tracking settings are found");
  Assert.equal(
    card.closest("[data-category]").dataset.category,
    "panePrivacy",
    "under Privacy and protection"
  );
  Assert.deepEqual(etpSurfaces(ui.doc), [], "and nothing of its");
  await showPane(ui.page, "privacy");
});

/**
 * What Enhanced Tracking Protection's pages reached is Sval's, each a control
 * of Sval's: fingerprinting protection in the Fingerprinting card, the cookie
 * choice in Cookies and site data, and a switch for each other pref in the
 * category's Advanced. What ran on Disconnect's
 * lists is not offered, since Sval runs none of them. Firefox's level reads
 * custom once a pref moves, and never moves one back.
 */
add_task(async function the_rest_is_in_privacy_and_protection() {
  clearSwitchPrefs();
  const ui = await openProtections();
  const more = ui.byId("sval-tracking-more");
  Assert.ok(!more.checkVisibility(), "the tracking settings are advanced");
  const advanced = ui.byId("sval-privacy-advanced");
  advanced.querySelector("summary").click();
  Assert.ok(more.checkVisibility(), "opening it shows them");

  for (const id of [
    "sval-mozilla-trackers",
    "sval-cryptominers",
    "sval-known-fingerprinters",
    "sval-mozilla-exceptions",
    "sval-mozilla-convenience",
    "sval-strict-list",
    "sval-consent-private",
  ]) {
    Assert.ok(
      !ui.byId(id),
      `${id} is not offered: it ran on Disconnect's lists (decision 1051)`
    );
  }

  const choose = (select, value) => {
    select.value = value;
    select.dispatchEvent(new ui.page.Event("change", { bubbles: true }));
  };
  const fp = ui.byId("sval-fp-windows");
  Assert.equal(
    fp.closest(".sval-card"),
    ui.byId("sval-fp"),
    "fingerprinting protection's windows are in the Fingerprinting card"
  );
  Assert.equal(fp.value, "all", "fingerprinting protection in every window");
  choose(fp, "private");
  Assert.ok(
    !Services.prefs.getBoolPref("privacy.fingerprintingProtection") &&
      Services.prefs.getBoolPref("privacy.fingerprintingProtection.pbmode"),
    "private windows only"
  );

  const group = ui.pane.querySelector('setting-group[groupid="svalCookies"]');
  const cookies = await TestUtils.waitForCondition(
    () => group.querySelector("moz-select#svalCookieBehavior"),
    "the cookie choice is drawn"
  );
  Assert.ok(
    group.querySelector("#clearSiteDataButton") &&
      group.querySelector("#deleteOnClose"),
    "with Firefox's site data settings in one card"
  );
  Assert.ok(
    !group.querySelector("#cookieExceptions") &&
      !group.querySelector("#siteDataSettings"),
    "and no cookie exceptions or site data list: Sites holds both"
  );
  Assert.ok(
    !ui.pane.querySelector('setting-group[groupid="cookiesAndSiteData2"]'),
    "and none of Firefox's own group beside it"
  );
  Assert.equal(
    Number(cookies.value),
    Services.prefs.getIntPref("network.cookie.cookieBehavior"),
    "cookies read their behaviour"
  );
  choose(cookies, String(Ci.nsICookieService.BEHAVIOR_REJECT_FOREIGN));
  Assert.equal(
    Services.prefs.getIntPref("network.cookie.cookieBehavior"),
    Ci.nsICookieService.BEHAVIOR_REJECT_FOREIGN,
    "and write it"
  );
  clearSwitchPrefs();

  Assert.equal(Services.prefs.getStringPref(CATEGORY), "standard");
  const stripping = ui.byId("sval-query-stripping");
  Assert.ok(stripping.checked, "the blocking level strips by default");
  stripping.click();
  Assert.ok(!Services.prefs.getBoolPref("privacy.query_stripping.enabled"));
  Assert.ok(
    !Services.prefs.getBoolPref("privacy.query_stripping.enabled.pbmode"),
    "in every window"
  );
  Assert.equal(
    Services.prefs.getStringPref(CATEGORY),
    "custom",
    "Firefox's level reads custom"
  );
  stripping.click();
  Assert.ok(
    !Services.prefs.prefHasUserValue("privacy.query_stripping.enabled") &&
      !Services.prefs.prefHasUserValue(
        "privacy.query_stripping.enabled.pbmode"
      ),
    "on is the level's default again"
  );
  Assert.equal(
    Services.prefs.getStringPref(CATEGORY),
    "custom",
    "and Firefox's level stays custom without moving a pref"
  );

  const bounce = ui.byId("sval-bounce-tracking");
  const defaultMode = Services.prefs.getIntPref(
    "privacy.bounceTrackingProtection.mode"
  );
  Assert.equal(
    bounce.checked,
    defaultMode === Ci.nsIBounceTrackingProtection.MODE_ENABLED,
    "bounce tracking protection reads its mode"
  );
  Services.prefs.clearUserPref(CATEGORY);
  bounce.click();
  Assert.equal(
    Services.prefs.getStringPref(CATEGORY),
    "custom",
    "a pref Firefox's level does not observe still moves it to custom"
  );
  Assert.equal(
    Services.prefs.getIntPref("privacy.bounceTrackingProtection.mode"),
    bounce.checked
      ? Ci.nsIBounceTrackingProtection.MODE_ENABLED
      : Ci.nsIBounceTrackingProtection.MODE_ENABLED_DRY_RUN,
    "and writes it"
  );
  bounce.click();
  Assert.ok(
    !Services.prefs.prefHasUserValue("privacy.bounceTrackingProtection.mode"),
    "back is the default again"
  );

  clearSwitchPrefs();
});

/**
 * Enhanced Tracking Protection's addresses, from a bookmark or Firefox's own
 * code, land on Privacy and protection with Sval's tracking settings
 * showing.
 */
add_task(async function its_addresses_land_on_the_tracking_settings() {
  const ui = await openProtections();
  for (const address of [
    "privacy-trackingprotection",
    "etp",
    "etpCustomize",
    "etp-etp-strict-control",
    "svalProtections-tracking",
  ]) {
    ui.byId("sval-privacy-advanced").open = false;
    await showPane(ui.page, "paneSearch");
    await TestUtils.waitForCondition(
      () => ui.page.history.state?.category === "search",
      "away first"
    );
    ui.page.location.hash = address;
    await TestUtils.waitForCondition(
      () => ui.byId("sval-tracking-more").checkVisibility(),
      `#${address} shows the tracking settings`
    );
    Assert.ok(
      !paneOf(ui.page, "privacy").hidden,
      `#${address} is Privacy and protection`
    );
  }
});

/**
 * The address bar has no padlock: Sval's Privacy and Security button stands
 * in for it (decision 0131).
 */
add_task(async function the_address_bar_shows_none_of_it() {
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    Assert.ok(
      !document.getElementById("trust-icon-container"),
      "the address bar has no padlock"
    );
    Assert.ok(
      document.getElementById("sval-protection-button").checkVisibility(),
      "sval's button shows in their place"
    );
  });
});

/**
 * Sval has no Report broken site, whose report offers to send what tracking
 * protection blocked to webcompat.com, a Mozilla service (Sval spec §10.9).
 */
add_task(async function report_broken_site_is_absent() {
  for (const id of ["cmd_reportBrokenSite", "help_reportBrokenSite"]) {
    Assert.ok(!document.getElementById(id), `the window has no ${id}`);
  }
});
