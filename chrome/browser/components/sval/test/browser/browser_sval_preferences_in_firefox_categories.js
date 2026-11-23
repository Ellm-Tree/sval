/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */

/**
 * The settings Sval adds to about:preferences' own categories (spec §10.8): the
 * search engine's one control in Search and Launcher, with the Launcher's
 * sections, ad blocking first in Privacy and protection with the
 * bookmarklets switch in its Advanced, the address bar's host in Appearance, the release
 * candidates switch, the log level, about:config and the privacy link in About,
 * the home page's
 * Favorites… button, and
 * what Firefox's own categories keep or lose.
 * `browser_sval_preferences_layout.js` and
 * `browser_sval_preferences_sync_and_agents.js` cover the rest of the page;
 * their shared helpers are in `sval_preferences_helpers.js`.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

const { SearchService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/search/SearchService.sys.mjs"
);

/**
 * One topic, one place: the search engine is chosen only in Firefox's Search
 * category, and Kagi's card sits there beside it while Kagi is the engine.
 */
add_task(async function the_search_engine_has_one_control() {
  await SearchService.init();
  const original = await SearchService.getDefault();
  registerCleanupFunction(() =>
    SearchService.setDefault(original, SearchService.CHANGE_REASON.UNKNOWN)
  );
  const kagiEngine = SearchService.getEngineById("kagi");
  await SearchService.setDefault(kagiEngine, SearchService.CHANGE_REASON.USER);
  await panelWithFolder(null);
  const ui = await openSettings();
  await showPane(ui.page, "search");
  const engineControl = () =>
    ui.page.document.querySelector(
      'setting-pane[data-category="paneSearch"] #defaultEngineNormal'
    );
  await TestUtils.waitForCondition(
    () => engineControl()?.panelList && !engineControl().closest("[hidden]"),
    "the Search category shows Firefox's engine control"
  );

  const doc = ui.page.document;
  Assert.equal(
    doc.querySelectorAll("#defaultEngineNormal").length,
    1,
    "the page has one default-engine control"
  );
  Assert.equal(
    doc.querySelectorAll('input[type="radio"][name*="search"]').length,
    0,
    "and sval adds no second one"
  );
  const navViews = [...doc.querySelectorAll("#categories moz-page-nav-button")]
    .filter(button => !button.hidden)
    .map(button => button.getAttribute("view") ?? "");
  Assert.equal(
    navViews.filter(view => /search/i.test(view)).length,
    1,
    "one category is about search"
  );

  const kagi = doc.getElementById("sval-kagi-card");
  Assert.ok(
    kagi.closest('setting-pane[data-category="paneSearch"]'),
    "Kagi's card is in the Search category"
  );
  await TestUtils.waitForCondition(
    () => kagi.checkVisibility(),
    "and showing there"
  );

  const control = engineControl();
  const other = (await SearchService.getVisibleEngines()).find(
    engine => engine.id !== kagiEngine.id
  );
  const shown = BrowserTestUtils.waitForEvent(control.panelList, "shown");
  EventUtils.synthesizeMouseAtCenter(control.inputEl, {}, ui.page);
  await within(shown, 5_000, "the search engine list's shown");
  const item = [...control.panelList.children].find(
    option => option.textContent.trim() === other.name
  );
  const changed = TestUtils.topicObserved(
    "browser-search-engine-modified",
    (_subject, data) => data === "engine-default"
  );
  EventUtils.synthesizeMouseAtCenter(item, {}, ui.page);
  await within(changed, 10_000, "the default search engine changing");
  Assert.equal(
    (await SearchService.getDefault()).id,
    other.id,
    "the control changes the default engine"
  );
  await TestUtils.waitForCondition(
    () => !kagi.checkVisibility(),
    "and Kagi's card goes with Kagi"
  );
});

/**
 * Ad and tracker blocking is the first card in Privacy and protection, and
 * its level is the pref.
 */
add_task(async function ad_blocking_is_first_in_privacy_and_protection() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.sval.adblock.level", "strict"]],
  });
  await panelWithFolder(null);
  const ui = await openSettings();
  await showPane(ui.page, "privacy");
  await TestUtils.waitForCondition(
    () => ui.byId("sval-blocking")?.checkVisibility(),
    "Privacy and protection is showing"
  );
  const first = paneOf(ui.page, "privacy").querySelector(".sval-card");
  Assert.equal(first?.id, "sval-blocking", "blocking is the first card");
  const checked = first.querySelector(
    'input[name="sval-blocking-level"]:checked'
  );
  Assert.equal(checked?.value, "strict", "it shows the level in force");
  Assert.ok(checked.checkVisibility(), "where it can be seen");
});

/**
 * The bookmarklets switch is a card of its own in Privacy and protection's
 * Advanced, and it is the pref.
 */
add_task(async function bookmarklets_are_an_advanced_setting() {
  await panelWithFolder(null);
  const ui = await openSettings();
  await showPane(ui.page, "privacy");
  const advanced = () => ui.byId("sval-privacy-advanced");
  await TestUtils.waitForCondition(
    () => advanced()?.querySelector("summary").checkVisibility(),
    "Privacy and protection shows its Advanced"
  );
  const bookmarklets = ui.byId("sval-bookmarklets");
  Assert.equal(bookmarklets.closest(".sval-card").id, "sval-bookmarklets-card");
  Assert.ok(!bookmarklets.checkVisibility(), "the switch is advanced");
  advanced().querySelector("summary").click();
  Assert.ok(bookmarklets.checkVisibility(), "and shows once Advanced opens");
  Assert.ok(bookmarklets.checked, "on by default");
  bookmarklets.click();
  Assert.ok(
    !Services.prefs.getBoolPref("browser.sval.favorites.bookmarklets"),
    "off writes the pref"
  );
  Services.prefs.clearUserPref("browser.sval.favorites.bookmarklets");
  await TestUtils.waitForCondition(
    () => bookmarklets.checked,
    "a change from elsewhere moves the switch"
  );
});

/**
 * Privacy and protection has a Private windows card under History, whose
 * switch is Gecko's pref for notifications in private windows, off as Sval
 * ships it.
 */
add_task(async function private_window_notifications_are_a_setting() {
  const PREF = "dom.webnotifications.privateBrowsing.enabled";
  await panelWithFolder(null);
  const ui = await openSettings();
  await showPane(ui.page, "privacy");
  const toggle = () => ui.byId("sval-private-notifications");
  await TestUtils.waitForCondition(
    () => toggle()?.checkVisibility(),
    "Privacy and protection shows the private windows switch"
  );
  const pane = paneOf(ui.page, "privacy");
  const card = toggle().closest(".sval-card");
  const history = pane.querySelector('setting-group[groupid="history2"]');
  Assert.ok(
    history.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
    "the card comes after History"
  );
  Assert.ok(
    card.compareDocumentPosition(ui.byId("sval-privacy-advanced")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
    "and before Advanced"
  );
  Assert.ok(!toggle().checked, "off by default");
  toggle().click();
  Assert.ok(Services.prefs.getBoolPref(PREF), "on writes the pref");
  Services.prefs.clearUserPref(PREF);
  await TestUtils.waitForCondition(
    () => !toggle().checked,
    "a change from elsewhere moves the switch"
  );
});

/**
 * Appearance holds the address bar's display choice, after Theme, and each
 * segment is the pref.
 */
add_task(async function the_address_bar_display_is_a_setting() {
  await panelWithFolder(null);
  const ui = await openSettings();
  await showPane(ui.page, "paneAppearance");
  const radio = value =>
    ui.page.document.querySelector(
      `input[name="sval-urlbar-display"][value="${value}"]`
    );
  await TestUtils.waitForCondition(
    () => radio("domain")?.checkVisibility(),
    "Appearance shows the choice"
  );
  let section = radio("domain").closest(".sval-pane-section");
  Assert.equal(
    section.previousElementSibling?.getAttribute("groupid"),
    "appearance",
    "after Theme"
  );
  const exampleTail = () =>
    ui.byId("sval-urlbar-example").querySelector(".sval-urlbar-tail")
      .textContent;
  Assert.ok(radio("domain").checked, "the site name by default");
  Assert.equal(exampleTail(), "", "the example shows the site alone");
  radio("path").click();
  Assert.equal(
    Services.prefs.getStringPref("browser.sval.urlbar.display"),
    "path",
    "a segment writes the pref"
  );
  Assert.ok(exampleTail(), "the example shows its path");
  Assert.ok(!/[?#]/.test(exampleTail()), "and nothing after it");
  radio("full").click();
  Assert.ok(exampleTail().includes("?"), "the full address has its query");
  Services.prefs.clearUserPref("browser.sval.urlbar.display");
  await TestUtils.waitForCondition(
    () => radio("domain").checked && exampleTail() === "",
    "a change from elsewhere moves the choice"
  );
});

/**
 * Search and Launcher lists the Launcher's sections in their order, each with its
 * limit (launcher spec §5): moving one writes the order, a limit writes the
 * section's pref, and a change from elsewhere redraws the list.
 */
add_task(async function the_launchers_sections_are_settings() {
  await panelWithFolder(null);
  registerCleanupFunction(() => {
    for (const name of [
      "browser.sval.launcher.order",
      "browser.sval.launcher.limit.history",
    ]) {
      Services.prefs.clearUserPref(name);
    }
  });
  const ui = await openSettings();
  await showPane(ui.page, "paneSearch");
  const list = () => ui.byId("sval-launcher-sections");
  const rows = () =>
    [...list().querySelectorAll(".sval-launcher-section")].map(row => [
      row.dataset.section,
      row.querySelector("select").value,
    ]);
  await TestUtils.waitForCondition(
    () => list()?.checkVisibility() && rows().length === 5,
    "Search and Launcher lists the sections"
  );
  Assert.deepEqual(
    rows(),
    [
      ["tabs", "4"],
      ["favorites", "3"],
      ["commands", "3"],
      ["history", "5"],
      ["suggestions", "3"],
    ],
    "in the default order, with the default limits"
  );

  const history = () => list().querySelectorAll(".sval-launcher-section")[3];
  const up = history().querySelector("[data-role=up]");
  up.focus();
  up.click();
  Assert.equal(
    Services.prefs.getCharPref("browser.sval.launcher.order"),
    "tabs,favorites,history,commands,suggestions",
    "moving History up writes the order"
  );
  await TestUtils.waitForCondition(
    () => rows()[2][0] === "history",
    "the list follows"
  );
  Assert.equal(
    ui.page.document.activeElement?.dataset.key,
    "history",
    "focus stays on History's control"
  );

  const limit = list().querySelectorAll("select")[2];
  limit.value = "1";
  limit.dispatchEvent(new ui.page.Event("change"));
  Assert.equal(
    Services.prefs.getIntPref("browser.sval.launcher.limit.history"),
    1,
    "a limit writes its section's pref"
  );

  Services.prefs.clearUserPref("browser.sval.launcher.order");
  Services.prefs.clearUserPref("browser.sval.launcher.limit.history");
  await TestUtils.waitForCondition(
    () => rows()[3][0] === "history" && rows()[3][1] === "5",
    "a change from elsewhere redraws the list"
  );

  // A section left out of the order is not shown, and says so.
  const row = key =>
    list().querySelector(`.sval-launcher-section[data-section="${key}"]`);
  row("commands").querySelector("[data-role=hide]").click();
  Assert.equal(
    Services.prefs.getCharPref("browser.sval.launcher.order"),
    "tabs,favorites,history,suggestions",
    "Hide leaves it out of the order"
  );
  await TestUtils.waitForCondition(
    () => row("commands")?.hasAttribute("data-not-shown"),
    "it is listed last, as not shown"
  );
  Assert.equal(
    ui.page.document.l10n.getAttributes(
      row("commands").querySelector(".sval-status-line")
    ).id,
    "launcher-settings-not-shown",
    "in words"
  );
  Assert.ok(
    !row("commands").querySelector("[data-role=up], [data-role=down]"),
    "and moves with none of the rest"
  );
  const last = row("suggestions").querySelector("[data-role=down]");
  Assert.ok(last.disabled, "the last section shown moves down no further");
  row("commands").querySelector("[data-role=show]").click();
  Assert.equal(
    Services.prefs.getCharPref("browser.sval.launcher.order"),
    "tabs,favorites,history,suggestions,commands",
    "Show lists it after the others"
  );
});

/**
 * About holds the release candidates switch after Firefox's update settings,
 * on a build that updates itself on the release channel, and it is the pref.
 */
add_task(async function release_candidates_is_a_setting_in_about() {
  useUpdateChannel("release");
  registerCleanupFunction(() =>
    Services.prefs.clearUserPref("browser.sval.update.releaseCandidates")
  );
  await panelWithFolder(null);
  const ui = await openSettings();
  await showPane(ui.page, "paneAbout");
  const toggle = () => ui.byId("sval-release-candidates");
  await TestUtils.waitForCondition(
    () => toggle()?.checkVisibility(),
    "About shows the switch"
  );
  const section = toggle().closest(".sval-pane-section");
  Assert.equal(
    section.previousElementSibling?.getAttribute("groupid"),
    "updates",
    "after Firefox's update settings"
  );
  Assert.ok(!toggle().checked, "off by default");
  toggle().click();
  Assert.ok(
    Services.prefs.getBoolPref("browser.sval.update.releaseCandidates"),
    "on writes the pref"
  );
  Services.prefs.clearUserPref("browser.sval.update.releaseCandidates");
  await TestUtils.waitForCondition(
    () => !toggle().checked,
    "a change from elsewhere moves the switch"
  );
});

add_task(async function about_has_the_log_level_in_its_advanced() {
  await panelWithFolder(null);
  const ui = await openSettings();
  await showPane(ui.page, "paneAbout");
  const summary = () =>
    ui.byId("sval-about-advanced")?.querySelector("summary");
  await TestUtils.waitForCondition(
    () => summary()?.checkVisibility(),
    "About shows its Advanced"
  );
  const select = ui.byId("sval-loglevel");
  Assert.ok(!select.checkVisibility(), "the log level is advanced");
  summary().click();
  Assert.ok(select.checkVisibility(), "and shows once Advanced opens");
  Assert.equal(select.value, "Warn", "at Sval's default");
  select.value = "Debug";
  select.dispatchEvent(new ui.page.Event("change"));
  Assert.equal(Services.prefs.getStringPref("browser.sval.loglevel"), "Debug");
  Services.prefs.clearUserPref("browser.sval.loglevel");
  await TestUtils.waitForCondition(
    () => select.value === "Warn",
    "a change from elsewhere moves the select"
  );
});

/**
 * The home page's Favorites… button opens Favorites as a menu at the button:
 * a favorite sets the home page, and a folder each favorite in it.
 */
add_task(async function the_home_page_takes_favorites() {
  await panelWithFolder(null);
  const { SvalFavoritesStore } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs"
  );
  const store = await within(
    SvalFavoritesStore.startFor(SvalPanel.engine),
    10_000,
    "the profile's Favorites"
  );
  const ONE = "https://example.com/one";
  const TWO = "https://example.com/two";
  const THREE = "https://example.com/three";
  const PINNED = "https://example.com/pinned";
  const made = await store.insertTree(
    [
      { title: "One", url: ONE },
      {
        title: "Pages",
        children: [
          { title: "Two", url: TWO },
          { title: "Three", url: THREE },
        ],
      },
    ],
    { pins: [{ title: "Pinned", url: PINNED }] }
  );
  atTaskEnd(async () => {
    for (const guid of made) {
      await store.delete(guid);
    }
  });
  const [, folder] = made;
  await SpecialPowers.pushPrefEnv({
    set: [["browser.startup.homepage", "about:home"]],
  });
  const ui = await openSettings();
  await showPane(ui.page, "customHomepage");
  const button = () => ui.byId("customHomepageReplaceWithBookmarksButton");
  await TestUtils.waitForCondition(() => button(), "the home page's page");

  const menu = async () => {
    const opened = TestUtils.waitForCondition(
      () => ui.byId("sval-use-favorite-menu")?.state === "open",
      "the button opens Favorites as a menu"
    );
    button().click();
    await opened;
    return ui.byId("sval-use-favorite-menu");
  };
  const homePage = () =>
    Services.prefs.getStringPref("browser.startup.homepage");

  let popup = await menu();
  Assert.ok(
    !ui.page.gSubDialog._topDialog,
    "and no dialog of Firefox's bookmarks"
  );
  const one = await TestUtils.waitForCondition(() =>
    popup.querySelector("menuitem[label='One']")
  );
  popup.activateItem(one);
  await TestUtils.waitForCondition(
    () => homePage() === ONE,
    "a favorite becomes the home page"
  );

  // The pins follow Favorites, under a heading (pins-root spec §6).
  popup = await menu();
  const pinned = await TestUtils.waitForCondition(() =>
    popup.querySelector("menuitem[label='Pinned']")
  );
  const items = [...popup.children].filter(el => !el.hidden);
  const caption = items.findIndex(el => el.localName === "menucaption");
  Assert.greater(caption, 0, "a heading after Favorites");
  Assert.equal(items.indexOf(pinned), caption + 1, "with the pins under it");
  popup.activateItem(pinned);
  await TestUtils.waitForCondition(
    () => homePage() === PINNED,
    "a pin becomes the home page"
  );

  popup = await menu();
  const pages = popup.querySelector(`menu[data-guid="${folder}"]`);
  const shown = BrowserTestUtils.waitForPopupEvent(pages.menupopup, "shown");
  pages.openMenu(true);
  await within(shown, 10_000, "the folder's submenu showing");
  const all = await TestUtils.waitForCondition(() =>
    pages.menupopup.querySelector(`[data-pick-folder="${folder}"]`)
  );
  pages.menupopup.activateItem(all);
  await TestUtils.waitForCondition(
    () => homePage() === `${TWO}|${THREE}`,
    "a folder makes each favorite in it a home page"
  );
  await SpecialPowers.popPrefEnv();
});

/**
 * About's Advanced holds the way to advanced preferences, which opens
 * about:config.
 */
add_task(async function about_config_is_in_abouts_advanced() {
  await panelWithFolder(null);
  const ui = await openSettings();
  await showPane(ui.page, "paneAbout");
  const summary = () =>
    ui.byId("sval-about-advanced")?.querySelector("summary");
  await TestUtils.waitForCondition(
    () => summary()?.checkVisibility(),
    "About shows its Advanced"
  );
  const button = ui.byId("sval-advanced-open");
  Assert.equal(
    button.closest("setting-pane")?.dataset.category,
    "paneAbout",
    "the way to about:config is in About"
  );
  Assert.ok(!button.checkVisibility(), "in its Advanced");
  summary().click();
  Assert.ok(button.checkVisibility(), "and shows once Advanced opens");
  const config = BrowserTestUtils.waitForNewTab(gBrowser, "about:config");
  button.click();
  BrowserTestUtils.removeTab(
    await within(config, 10_000, "about:config opening")
  );
});

/**
 * About links to Sval's privacy policy, beside Get help. The test opens no
 * tab: the harness allows no connection to a host off its own server.
 */
add_task(async function about_links_to_the_privacy_policy() {
  await panelWithFolder(null);
  const ui = await openSettings();
  await showPane(ui.page, "paneAbout");
  const link = () => ui.byId("supportPrivacy");
  await TestUtils.waitForCondition(
    () => link()?.checkVisibility(),
    "About shows the privacy link"
  );
  Assert.equal(
    link().closest("setting-group")?.getAttribute("groupid"),
    "support",
    "in the support links"
  );
  await link().updateComplete;
  const anchor = link().shadowRoot.querySelector("a");
  Assert.equal(
    anchor.href,
    "https://sval.app/privacy/",
    "it leads to the privacy policy"
  );
  Assert.equal(anchor.target, "_blank", "in a new tab");
});

/**
 * Appearance links to no Firefox Home, and the default browser is offered in
 * General alone, not again under Workspaces.
 */
add_task(async function no_firefox_home_link_and_one_default_browser() {
  await BrowserTestUtils.withNewTab("about:preferences", async browser => {
    const win = browser.contentWindow;
    const doc = browser.contentDocument;
    await showPane(win, "paneAppearance");
    await TestUtils.waitForTick();
    const home = doc.getElementById("related-settings-home-link");
    Assert.ok(!home?.checkVisibility(), "no link to Firefox Home");

    await showPane(win, "paneHome");
    await TestUtils.waitForTick();
    Assert.ok(
      !doc.querySelector('setting-group[groupid="defaultBrowserHome"]'),
      "General alone offers the default browser"
    );
  });
});

/**
 * Text you select in Settings is what Copy copies, though Settings opens
 * with its search box focused.
 */
add_task(async function copy_copies_the_text_you_select() {
  await panelWithFolder(null);
  const ui = await openSettings();
  await showPane(ui.page, "paneAppearance");
  const doc = ui.page.document;
  const text = doc.querySelector('[data-sval-pane="svalAddressBar"] h2');
  await TestUtils.waitForCondition(
    () => text?.checkVisibility(),
    "Appearance shows its cards"
  );
  // A person scrolls to text below the window's bottom before clicking it.
  text.scrollIntoView({ block: "center", behavior: "instant" });
  doc.getElementById("searchInput").focus();
  // A click on text selects it; the text is no control, which the a11y
  // checks require of whatever a click lands on.
  AccessibilityUtils.setEnv({ mustHaveAccessibleRule: false });
  for (let clickCount = 1; clickCount <= 3; clickCount++) {
    EventUtils.synthesizeMouse(text, 4, 4, { clickCount }, ui.page);
  }
  AccessibilityUtils.resetEnv();
  const selected = ui.page.getSelection().toString();
  Assert.ok(selected.trim(), "a triple-click selects the text");
  await SimpleTest.promiseClipboardChange(selected, () =>
    document.getElementById("menu_copy").doCommand()
  );
});
