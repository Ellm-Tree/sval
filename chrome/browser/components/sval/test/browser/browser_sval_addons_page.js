/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The add-ons page in Sval's design (`SvalPageStyle`), Firefox's ways into
 * it opening Settings instead, and the way from the page back to Settings
 * in its tab (`SvalAddonsNav`).
 */

ChromeUtils.defineESModuleGetters(this, {
  PAGE_SHEET: "moz-src:///browser/components/sval/SvalPageStyle.sys.mjs",
  sheetsFor: "moz-src:///browser/components/sval/SvalPageStyle.sys.mjs",
  settingsPaneFor: "moz-src:///browser/components/sval/SvalAddonsNav.sys.mjs",
});

/**
 * Resolves with the add-ons page in `browser` once it has shown a view.
 *
 * @param {Element} browser
 */
async function addonsReady(browser) {
  await TestUtils.waitForCondition(
    () =>
      browser.currentURI?.spec.startsWith("about:addons") &&
      browser.contentWindow?.gViewController?.currentViewId,
    "the add-ons page shows a view"
  );
  await within(
    browser.contentWindow.promiseInitialized,
    10_000,
    "the add-ons page's start"
  );
  return browser.contentWindow;
}

/**
 * Resolves once `browser` shows Settings with Sval's panes.
 *
 * @param {Element} browser
 */
async function settingsReady(browser) {
  await TestUtils.waitForCondition(
    () =>
      browser.currentURI?.spec.startsWith("about:preferences") &&
      browser.contentWindow?.SvalSettings?._els,
    "Settings shows Sval's panes"
  );
  return browser.contentWindow;
}

add_task(function only_the_restyled_pages_take_sheets() {
  Assert.deepEqual(
    sheetsFor("about:addons"),
    [PAGE_SHEET, "chrome://browser/content/sval/pages/addons.css"],
    "the add-ons page takes the page sheet, then its own"
  );
  Assert.equal(
    sheetsFor("about:addons?view=x#y").length,
    2,
    "whatever its query and fragment"
  );
  Assert.deepEqual(sheetsFor("https://example.com/"), [], "a site takes none");
});

add_task(function add_ons_views_have_places_in_settings() {
  Assert.equal(settingsPaneFor(undefined), "paneSvalExtensions");
  Assert.equal(
    settingsPaneFor("addons://list/extension"),
    "paneSvalExtensions"
  );
  Assert.equal(settingsPaneFor("addons://discover/"), "paneSvalExtensions");
  Assert.equal(
    settingsPaneFor("addons://detail/a%40b"),
    "paneSvalExtensions-extension?id=a%40b"
  );
  Assert.equal(
    settingsPaneFor("addons://detail/a%40b/preferences"),
    "paneSvalExtensions-extension?id=a%40b&card=settings"
  );
  Assert.equal(
    settingsPaneFor("addons://shortcuts/a%40b"),
    "paneSvalExtensions-extension?id=a%40b&card=shortcuts"
  );
  Assert.equal(
    settingsPaneFor("addons://shortcuts/shortcuts"),
    "paneSvalKeyboard"
  );
  Assert.equal(
    settingsPaneFor("addons://list/dictionary"),
    null,
    "dictionaries keep the add-ons page"
  );
});

add_task(async function the_add_ons_manager_opens_settings() {
  await BrowserTestUtils.withNewTab("about:blank", async blank => {
    const page = await within(
      BrowserAddonUI.openAddonsMgr("addons://list/extension"),
      20_000,
      "the add-ons manager's opening"
    );
    const browser = page.docShell.chromeEventHandler;
    const tab = gBrowser.getTabForBrowser(browser);
    if (browser !== blank) {
      expectOpened(tab);
    }
    await settingsReady(browser);
    Assert.equal(page, browser.contentWindow, "its callers get Settings' page");
    await TestUtils.waitForCondition(
      () =>
        page.document
          .querySelector('[data-sval-pane="svalExtensions"]')
          ?.checkVisibility(),
      "on the Extensions category"
    );
    if (browser !== blank) {
      BrowserTestUtils.removeTab(tab);
    }
  });
});

add_task(async function the_add_ons_page_leads_back_to_settings_in_its_tab() {
  await BrowserTestUtils.withNewTab("about:preferences", async browser => {
    const tabs = gBrowser.tabs.length;
    await settingsReady(browser);
    BrowserTestUtils.startLoadingURIString(browser, "about:addons");
    const addons = await addonsReady(browser);
    Assert.ok(browser.canGoBack, "Back leads to Settings");

    const crumb = addons.document.getElementById("sval-addons-crumb");
    Assert.equal(
      crumb.getAttribute("href"),
      "about:preferences",
      "a crumb leads to Settings"
    );
    addons.document.getElementById("sval-addons-back").click();
    await settingsReady(browser);
    Assert.equal(gBrowser.tabs.length, tabs, "Settings came back in the tab");
    Assert.ok(browser.canGoForward, "and the history went back to it");
  });
});
