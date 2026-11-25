/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The Privacy and Security button on a search engine's results page, where
 * the address bar keeps the search words (`UrlbarSearchTermsPersistence`):
 * it stays for the page shown, and goes once the person types other words.
 */

const { stateOf } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalProtectionButton.sys.mjs"
);
const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);
const { SearchTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/SearchTestUtils.sys.mjs"
);
SearchTestUtils.init(this);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);
const { AppProvidedConfigEngine } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/search/ConfigSearchEngine.sys.mjs"
);

const { SvalSearchConfig } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSearchConfig.sys.mjs"
);
const { SearchService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/search/SearchService.sys.mjs"
);

const RESULTS_BASE = "https://www.example.com/";

function button() {
  return document.getElementById("sval-protection-button");
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.urlbar.showSearchTerms.featureGate", true]],
  });
  // Search words persist only for an engine from the search configuration
  // (`UrlbarSearchTermsPersistence.getSearchTerm`), and Sval's selector reads
  // its configuration from `SvalSearchConfig` alone.
  const sandbox = sinon.createSandbox();
  // An engine with no icon in the configuration logs a missing icon URL.
  sandbox
    .stub(AppProvidedConfigEngine.prototype, "getIconURL")
    .resolves("data:image/x-icon;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=");
  const shipped = SvalSearchConfig.SEARCH_CONFIG;
  await reloadEngines(
    SearchTestUtils.expandPartialConfig([
      {
        recordType: "engine",
        identifier: "Example",
        base: {
          name: "Example",
          urls: { search: { base: RESULTS_BASE, searchTermParamName: "q" } },
        },
      },
      { recordType: "defaultEngines", globalDefault: "Example" },
    ])
  );
  registerCleanupFunction(async () => {
    await reloadEngines(shipped);
    sandbox.restore();
  });
});

/**
 * Gives the search service another configuration. A locale change is the
 * reload `SearchService.observe` runs without waiting for the user to idle.
 *
 * @param {object[]} config
 */
async function reloadEngines(config) {
  SvalSearchConfig.SEARCH_CONFIG = config;
  SearchService.resetEngineSelector();
  const reloaded =
    SearchTestUtils.promiseSearchNotification("engines-reloaded");
  SearchService.observe(null, "intl:app-locales-changed");
  await within(reloaded, 10_000, "the search engines' reload");
}

add_task(async function shield_stays_on_a_results_page() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser),
    10_000,
    "the new tab"
  );
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url =>
    url.startsWith(RESULTS_BASE)
  );
  gURLBar.focus();
  await UrlbarTestUtils.promiseAutocompleteResultPopup({
    window,
    waitForFocus,
    value: "hello",
    fireInputEvent: true,
  });
  EventUtils.synthesizeKey("KEY_Enter");
  await within(loaded, 10_000, "the results page's load");
  await pageReady(tab.linkedBrowser, tab.linkedBrowser.currentURI.spec);
  gURLBar.blur();
  await within(
    TestUtils.waitForCondition(
      () =>
        gURLBar.hasAttribute("persistsearchterms") &&
        !gURLBar.hasAttribute("breakout-extend")
    ),
    5_000,
    "the bar keeping the search words"
  );
  is(gURLBar.value, "hello", "the bar shows the search words");
  is(
    gURLBar.getAttribute("pageproxystate"),
    "invalid",
    "search words leave the proxy state invalid"
  );
  ok(BrowserTestUtils.isVisible(button()), "the shield shows on the page");

  const panel = document.getElementById("sval-protection-panel");
  const shown = BrowserTestUtils.waitForEvent(panel, "popupshown");
  button().click();
  await within(shown, 5_000, "the protection panel's popupshown");
  is(stateOf(window).site, "example.com", "the panel is the results page's");
  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  panel.hidePopup();
  await within(hidden, 5_000, "the protection panel's popuphidden");

  gURLBar.focus();
  gURLBar.select();
  EventUtils.sendString("goodbye");
  ok(
    !gURLBar.hasAttribute("persistsearchterms"),
    "other words end the persisted search"
  );
  ok(!BrowserTestUtils.isVisible(button()), "the shield goes while typing");
  await UrlbarTestUtils.promisePopupClose(window, () => gURLBar.blur());
  ok(
    !gURLBar.hasAttribute("breakout-extend"),
    "the bar is back in the toolbar"
  );
  ok(
    !BrowserTestUtils.isVisible(button()),
    "the shield stays hidden for typed words"
  );
  gURLBar.handleRevert();
  BrowserTestUtils.removeTab(tab);
});

const { FLIP_ID } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSearchFlip.sys.mjs"
);
const { FLOATING } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLauncher.sys.mjs"
);

/**
 * Searches from the address bar in a new tab, and waits for the results
 * page to show the search with its switch.
 *
 * @returns {Promise<Tab>}
 */
async function searchInNewTab() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser),
    10_000,
    "the new tab"
  );
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url =>
    url.startsWith(RESULTS_BASE)
  );
  gURLBar.focus();
  await UrlbarTestUtils.promiseAutocompleteResultPopup({
    window,
    waitForFocus,
    value: "foof",
    fireInputEvent: true,
  });
  EventUtils.synthesizeKey("KEY_Enter");
  await within(loaded, 10_000, "the results page's load");
  await pageReady(tab.linkedBrowser, tab.linkedBrowser.currentURI.spec);
  gURLBar.blur();
  const flip = document.getElementById(FLIP_ID);
  await within(
    TestUtils.waitForCondition(
      () => gURLBar.hasAttribute("persistsearchterms") && !flip.hidden
    ),
    5_000,
    "the bar showing the search, with its switch"
  );
  return tab;
}

/**
 * Opens the Launcher, with Open Location's key or command.
 */
async function openLauncher() {
  const shown = UrlbarTestUtils.promisePopupOpen(window, () =>
    document.getElementById("Browser:OpenLocation").doCommand()
  );
  await within(shown, 10_000, "the Launcher's list");
  await within(
    TestUtils.waitForCondition(() => gURLBar.hasAttribute(FLOATING)),
    5_000,
    "the Launcher floating"
  );
}

/** Closes the Launcher with Escape. */
async function escapeLauncher() {
  EventUtils.synthesizeKey("KEY_Escape");
  await within(
    TestUtils.waitForCondition(() => !gURLBar.hasAttribute(FLOATING)),
    5_000,
    "the Launcher closing"
  );
}

add_task(async function the_search_switches_to_the_address_and_back() {
  const tab = await searchInNewTab();
  const flip = document.getElementById(FLIP_ID);
  is(flip.dataset.side, "search", "the switch offers the address");
  ok(
    document.getElementById("sval-launcher-key").checkVisibility(),
    "the Launcher's key shows beside the search"
  );

  flip.click();
  await within(
    TestUtils.waitForCondition(
      () => !gURLBar.hasAttribute("persistsearchterms")
    ),
    5_000,
    "the bar showing the address"
  );
  is(
    gURLBar.getAttribute("pageproxystate"),
    "valid",
    "the bar shows the page's address"
  );
  is(flip.dataset.side, "address", "the switch offers the search");
  ok(!flip.hidden, "and stays to switch back");

  flip.click();
  await within(
    TestUtils.waitForCondition(() =>
      gURLBar.hasAttribute("persistsearchterms")
    ),
    5_000,
    "the bar showing the search again"
  );
  is(gURLBar.value, "foof", "the search is back");
  is(flip.dataset.side, "search", "and the switch offers the address again");

  gURLBar.handleRevert();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function the_launcher_switches_and_escape_keeps_the_side() {
  const tab = await searchInNewTab();
  const flip = document.getElementById(FLIP_ID);

  await openLauncher();
  ok(!flip.hidden, "the Launcher offers the switch");
  is(flip.dataset.side, "search", "from the search to the address");
  await escapeLauncher();
  ok(
    gURLBar.hasAttribute("persistsearchterms"),
    "Escape leaves the bar showing the search"
  );
  is(gURLBar.value, "foof", "the search itself");
  ok(!flip.hidden, "with its switch");

  await openLauncher();
  flip.click();
  await within(
    TestUtils.waitForCondition(() => flip.dataset.side === "address"),
    5_000,
    "the Launcher switching to the address"
  );
  ok(gURLBar.hasAttribute(FLOATING), "the Launcher stays open");
  is(
    gURLBar.getAttribute("pageproxystate"),
    "valid",
    "the Launcher shows the page's address"
  );
  await escapeLauncher();
  is(
    gURLBar.getAttribute("pageproxystate"),
    "valid",
    "Escape leaves the bar showing the address asked for"
  );
  ok(!flip.hidden, "with the switch back to the search");

  await openLauncher();
  flip.click();
  await within(
    TestUtils.waitForCondition(() =>
      gURLBar.hasAttribute("persistsearchterms")
    ),
    5_000,
    "the Launcher switching back to the search"
  );
  is(gURLBar.value, "foof", "the search is back in the Launcher");
  await escapeLauncher();
  ok(
    gURLBar.hasAttribute("persistsearchterms"),
    "and stays once the Launcher closes"
  );

  gURLBar.handleRevert();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function the_results_page_shows_its_engines_icon() {
  const tab = await searchInNewTab();
  atTaskEnd(() => {
    gURLBar.handleRevert();
    BrowserTestUtils.removeTab(tab);
  });
  const engine = gURLBar.querySelector(".searchmode-switcher");
  await within(
    TestUtils.waitForCondition(() =>
      engine.getAttribute("iconsrc")?.startsWith("data:")
    ),
    5_000,
    "the engine's icon"
  );
  const icon = engine.shadowRoot.querySelector("img");
  Assert.equal(
    getComputedStyle(icon).content,
    "normal",
    "the field at rest draws the engine's icon, as the Launcher does"
  );
  const glyph = button()
    .querySelector(".sval-prot-glyph")
    .getBoundingClientRect();
  const drawn = icon.getBoundingClientRect();
  Assert.equal(drawn.width, glyph.width, "at the shield's size");
  Assert.equal(
    engine.getBoundingClientRect().left,
    button().getBoundingClientRect().right,
    "in a button beside the shield's, as a pill's buttons stand"
  );
});

add_task(async function the_panels_engine_button_opens_the_picker() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.sval.toolbar.inPanel", true],
      // Firefox marks Home as taken out of `#nav-bar` once it moves
      // (`BrowserUsageTelemetry`).
      ["browser.engagement.home-button.has-removed", false],
    ],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const tab = await searchInNewTab();
  atTaskEnd(() => {
    gURLBar.handleRevert();
    BrowserTestUtils.removeTab(tab);
  });
  const engine = gURLBar.querySelector(".searchmode-switcher");
  const picker = gURLBar.querySelector(".searchmode-switcher-panel");
  const shown = BrowserTestUtils.waitForPopupEvent(picker, "shown");
  EventUtils.synthesizeMouseAtCenter(engine, {});
  await within(shown, 5_000, "the engine picker");
  ok(!gURLBar.hasAttribute(FLOATING), "and the Launcher stays closed");
  const hidden = BrowserTestUtils.waitForPopupEvent(picker, "hidden");
  picker.hidePopup();
  await within(hidden, 5_000, "the engine picker closing");
});
