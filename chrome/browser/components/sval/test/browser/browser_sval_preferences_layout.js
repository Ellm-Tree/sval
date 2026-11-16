/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */

/**
 * The layout of about:preferences (spec §10.8): Sval's categories in the nav, in
 * order, each opening its pane, with a plain open landing on Sync and old
 * addresses landing where their topic is. Advanced settings are Advanced
 * disclosures at each category's or card's foot, and settings search finds
 * moved and advanced settings.
 * `browser_sval_preferences_placement.js`,
 * `browser_sval_preferences_sync_and_agents.js` and
 * `browser_sval_preferences_in_firefox_categories.js` cover the rest of the
 * page; their shared helpers are in `sval_preferences_helpers.js`.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

const CATEGORIES = [
  "svalSync",
  "svalLinks",
  "svalSites",
  "svalExtensions",
  "svalAgents",
];

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel starting");
});

add_task(async function sval_categories_are_in_the_preferences_nav() {
  await panelWithFolder(null);
  const ui = await openSettings();
  Assert.ok(
    ui.tab.linkedBrowser.currentURI.spec.startsWith("about:preferences"),
    "settings is about:preferences"
  );
  const nav = ui.byId("categories");
  const buttons = CATEGORIES.map(id => ui.byId(`category-${id}`));
  for (const [i, button] of buttons.entries()) {
    Assert.ok(button, `${CATEGORIES[i]} is in the nav`);
    Assert.equal(button.parentNode, nav, "as one of its categories");
  }

  for (const id of CATEGORIES) {
    await showPane(ui.page, id);
    await TestUtils.waitForCondition(
      () => !paneOf(ui.page, id).hidden,
      `${id} shows its pane`
    );
    Assert.ok(
      paneOf(ui.page, id).querySelector(".sval-pane-title"),
      "with its title"
    );
    for (const other of CATEGORIES.filter(o => o !== id)) {
      Assert.ok(paneOf(ui.page, other).hidden, `and hides ${other}`);
    }
    Assert.ok(
      ui.byId("category-general") &&
        ui.page.document.querySelector('[data-category="paneGeneral"]')
          ?.hidden !== false,
      "and Firefox's General pane"
    );
  }
});

add_task(async function a_plain_open_lands_on_svals_sync_category() {
  closeSettings();
  await panelWithFolder(null);
  const tab = expectOpened(SvalPanel.openSettingsPage());
  registerCleanupFunction(() => {
    if (tab.parentNode) {
      BrowserTestUtils.removeTab(tab);
    }
  });
  await TestUtils.waitForCondition(
    () => tab.linkedBrowser.contentWindow?.SvalSettings?._els,
    "settings opened"
  );
  const page = tab.linkedBrowser.contentWindow;
  Assert.equal(tab.linkedBrowser.currentURI.spec, "about:preferences#svalSync");
  await TestUtils.waitForCondition(
    () => !paneOf(page, "svalSync").hidden,
    "at Sval's Sync category"
  );
  await TestUtils.waitForCondition(
    () =>
      page.document.activeElement ===
      page.document.getElementById("sval-settings-heading"),
    "with the caret on the pane's title"
  );
});

/**
 * The nav, top to bottom, by button id: the categories a person sees, then
 * About after a separator.
 */
const NAV = [
  "category-sync",
  "category-home",
  "category-svalLinks",
  "category-svalSync",
  "category-appearance",
  "category-search",
  "category-privacy",
  "category-svalSites",
  "category-svalExtensions",
  "category-svalAgents",
  "category-svalKeyboard",
];

/**
 * The nav holds Sval's categories in order, with About last after a
 * separator, and none of the categories Sval folds into others.
 */
add_task(async function the_nav_is_in_order() {
  await panelWithFolder(null);
  const ui = await openSettings();
  const shown = [
    ...ui.byId("categories").querySelectorAll(":scope > *"),
  ].filter(
    el =>
      !el.hidden &&
      !el.classList.contains("hidden-category") &&
      el.getAttribute("slot") !== "secondary-nav"
  );
  const ids = shown.map(el => el.id);
  Assert.deepEqual(
    ids.slice(0, NAV.length),
    NAV,
    "the categories come first, in order"
  );
  Assert.deepEqual(
    ids.slice(-2),
    ["nav-separator", "category-about-firefox"],
    "About is last, after the separator"
  );
  Assert.ok(
    ui.byId("category-svalSync").textContent.trim(),
    "Sync and devices is named"
  );
  for (const gone of [
    "category-svalDevices",
    "category-svalAds",
    "category-svalWorkspaces",
    "category-passwords-autofill",
    "category-downloads",
    "category-tabs-browsing",
    "category-accessibility",
    "category-languages",
  ]) {
    Assert.ok(!ui.byId(gone), `${gone} is not in the nav`);
  }
  Assert.equal(
    ui.page.document.querySelectorAll("#categories hr").length,
    1,
    "one separator"
  );
});

add_task(async function every_nav_category_opens() {
  await panelWithFolder(null);
  const ui = await openSettings();
  const views = [
    ...ui.page.document.querySelectorAll("#categories moz-page-nav-button"),
  ]
    .filter(button => !button.hidden && button.getAttribute("view"))
    .map(button => button.getAttribute("view"));
  for (const view of views) {
    await showPane(ui.page, view);
    await TestUtils.waitForCondition(
      () =>
        [
          ...ui.page.document.querySelectorAll(`[data-category="${view}"]`),
        ].some(element => !element.hidden),
      `${view} shows its pane`
    );
  }
});

/**
 * An address naming a category Sval folded into another lands on that
 * category, with the section it named.
 */
add_task(async function old_addresses_land_where_their_topic_is() {
  await panelWithFolder(await makeTempDir("sval-shared"));
  const ui = await openSettings();
  const landings = [
    ["svalDevices", "paneSvalSync"],
    ["svalDevices-offer", "paneSvalSync"],
    ["svalDevices-claim", "paneSvalSync"],
    ["svalAds", "panePrivacy"],
    ["svalProtections", "panePrivacy"],
    ["svalProtections-secureDns", "panePrivacy"],
    ["svalProtections-sites", "paneSvalSites"],
    ["permissionsData", "paneSvalSites"],
    ["privacy-permissions", "paneSvalSites"],
    ["svalWorkspaces", "paneHome"],
    ["tabsBrowsing", "paneHome"],
    ["languages", "paneSync"],
    ["downloads", "paneSync"],
    ["accessibility", "paneAppearance"],
    ["privacy-trackingprotection", "panePrivacy"],
    ["passwordsAutofill", "panePrivacy"],
    ["privacy-logins", "panePrivacy"],
  ];
  for (const [address, pane] of landings) {
    await showPane(ui.page, "paneSearch");
    await TestUtils.waitForCondition(
      () => ui.page.history.state?.category === "search",
      "away first"
    );
    // The page goes to the address on its hashchange, which comes on a later
    // task (`onHashChange` in preferences.js).
    const shown = BrowserTestUtils.waitForEvent(
      ui.page.document,
      "paneshown",
      false,
      event => event.detail.category === pane
    );
    ui.page.location.hash = address;
    await within(shown, 10_000, `#${address} going to ${pane}`);
    await TestUtils.waitForCondition(
      () =>
        [
          ...ui.page.document.querySelectorAll(`[data-category="${pane}"]`),
        ].some(el => !el.hidden),
      `#${address} shows ${pane}`
    );
    if (address === "svalDevices-claim") {
      await TestUtils.waitForCondition(
        () => !ui.byId("sval-path-claim-steps").hidden,
        "with the section it named"
      );
    }
  }
});

/**
 * A site page's address under Protections, from a bookmark or a restored
 * tab, opens the site's page in Sites.
 */
add_task(async function a_site_pages_old_address_opens_it_in_sites() {
  await panelWithFolder(null);
  const ui = await openSettings();
  await showPane(ui.page, "paneSearch");
  ui.page.location.hash = "svalProtections-site?host=example.com";
  await TestUtils.waitForCondition(
    () => ui.byId("sval-site-page").checkVisibility(),
    "the site's page shows"
  );
  Assert.equal(ui.byId("sval-site-title").textContent, "example.com");
  Assert.equal(
    ui.page.location.hash,
    "#svalSites-site?host=example.com",
    "at its address in Sites"
  );
});

/**
 * Advanced settings are one pattern: a collapsed Advanced disclosure at the
 * foot of each category that has them, or of the card whose controls they
 * change, which the keyboard opens. No page-wide switch remains.
 */
add_task(async function advanced_is_a_disclosure_at_each_foot() {
  await panelWithFolder(null);
  const ui = await openSettings();
  const doc = ui.page.document;
  Assert.ok(
    !doc.querySelector(".sval-advanced-switch, [data-sval-advanced]"),
    "no page-wide Show advanced"
  );

  await showPane(ui.page, "privacy");
  await TestUtils.waitForCondition(
    () => ui.byId("sval-blocking").checkVisibility(),
    "Privacy and protection is showing"
  );
  const advancedName = doc
    .querySelector("details.sval-advanced .sval-advanced-label")
    .textContent.trim();
  Assert.ok(advancedName, "an Advanced is named");
  for (const details of doc.querySelectorAll("details.sval-advanced")) {
    Assert.ok(!details.open, `#${details.id} is closed at first`);
    const summary = details.firstElementChild;
    Assert.equal(summary.localName, "summary", `#${details.id} has a summary`);
    Assert.equal(
      summary.querySelector(".sval-advanced-label")?.textContent.trim(),
      advancedName,
      `#${details.id} is named Advanced, as every other is`
    );
    const holder = details.parentElement.closest(".sval-card, .sval-settings");
    Assert.equal(
      [...holder.children].filter(el => el.localName !== "dialog").at(-1),
      details,
      `#${details.id} is at the foot of what holds it`
    );
  }

  const blocking = ui.byId("sval-blocking-advanced");
  const summary = blocking.querySelector("summary");
  const filters = ui.byId("sval-my-filters");
  Assert.ok(!filters.checkVisibility(), "what it holds is out of sight");
  await within(SimpleTest.promiseFocus(ui.page), 10_000, "the page's focus");
  summary.focus();
  EventUtils.synthesizeKey("KEY_Enter", {}, ui.page);
  Assert.ok(blocking.open, "Enter opens it");
  Assert.ok(filters.checkVisibility(), "and shows what it holds");
  EventUtils.synthesizeKey(" ", {}, ui.page);
  await TestUtils.waitForCondition(() => !blocking.open, "Space closes it");
});

/**
 * Types `query` into settings search and waits for its results.
 *
 * @param {object} ui From `openSettings`.
 * @param {string} query The search text.
 */
async function searchSettings(ui, query) {
  const input = ui.page.document.getElementById("searchInput");
  const done = BrowserTestUtils.waitForEvent(
    ui.page,
    "PreferencesSearchCompleted",
    false,
    event => event.detail == query
  );
  input.value = query;
  input.dispatchEvent(new ui.page.Event("input"));
  await within(done, 10_000, "the settings search completing");
}

/**
 * Settings search finds a moved group under its new category, and finds an
 * advanced one, opening the Advanced that holds it.
 */
add_task(async function search_finds_moved_and_advanced_settings() {
  await panelWithFolder(null);
  const ui = await openSettings();
  const doc = ui.page.document;
  const search = query => searchSettings(ui, query);

  await search("zoom text only");
  const zoom = doc.querySelector('setting-group[groupid="zoom"]');
  Assert.ok(zoom.checkVisibility(), "a moved group is found");
  Assert.equal(
    zoom.closest("setting-pane").dataset.category,
    "paneAppearance",
    "under its new category"
  );

  await search("certificates");
  const certificates = doc.querySelector(
    'setting-group[groupid="certificates"]'
  );
  Assert.ok(certificates.checkVisibility(), "an advanced group is found");
  Assert.ok(
    ui.byId("sval-privacy-advanced").open,
    "with the Advanced that holds it open"
  );

  await search("webdriver");
  Assert.ok(
    ui.byId("sval-webdriver-cookies").checkVisibility(),
    "and an advanced card of Sval's"
  );

  await showPane(ui.page, "panePrivacy");
  await TestUtils.waitForCondition(
    () => ui.byId("sval-privacy-advanced")?.closest("setting-pane"),
    "Privacy and security's Advanced in place"
  );
  Assert.equal(
    certificates.closest("details"),
    ui.byId("sval-privacy-advanced"),
    "Firefox's certificates group is in Privacy and security's Advanced"
  );
  const groups = [
    ...doc.querySelectorAll(
      '[data-category="panePrivacy"] setting-group:not(details setting-group)'
    ),
  ];
  Assert.ok(
    groups.every(
      group =>
        group.compareDocumentPosition(ui.byId("sval-privacy-advanced")) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ),
    "after every other group in the category"
  );
  ui.byId("sval-privacy-advanced").open = false;
  Assert.ok(!certificates.checkVisibility(), "and closing it hides it");
});

/**
 * Settings search finds no setting that no category shows. Firefox's browser
 * layout is the workspace panel's in Sval, and Sval shows no recommendations
 * as the user browses, so neither has a category.
 */
add_task(async function search_finds_nothing_no_category_shows() {
  await panelWithFolder(null);
  const ui = await openSettings();
  const doc = ui.page.document;
  for (const query of [
    "vertical tabs",
    "browser layout",
    "recommend extensions",
    "recommend features",
  ]) {
    await searchSettings(ui, query);
    Assert.ok(
      doc.getElementById("no-results-message").checkVisibility(),
      `"${query}" finds nothing`
    );
  }
  for (const id of ["browserLayout", "recommendations"]) {
    Assert.ok(
      !doc.querySelector(`setting-group[groupid="${id}"]`),
      `no category has ${id}`
    );
  }
});
