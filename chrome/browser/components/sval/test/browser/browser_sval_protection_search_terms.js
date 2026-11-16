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
