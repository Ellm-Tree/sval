/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The add-ons page in Sval's design (`SvalPageStyle`), and the way between
 * it and Settings in one tab (`SvalAddonsNav`).
 */

ChromeUtils.defineESModuleGetters(this, {
  PAGE_SHEET: "moz-src:///browser/components/sval/SvalPageStyle.sys.mjs",
  sheetsFor: "moz-src:///browser/components/sval/SvalPageStyle.sys.mjs",
  SvalAddonsNav: "moz-src:///browser/components/sval/SvalAddonsNav.sys.mjs",
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

add_task(async function settings_opens_add_ons_in_its_tab_and_back() {
  await BrowserTestUtils.withNewTab("about:preferences", async browser => {
    const tabs = gBrowser.tabs.length;
    const settings = await settingsReady(browser);
    await showPane(settings, "svalExtensions");
    settings.document.getElementById("sval-extensions-full").click();

    const addons = await addonsReady(browser);
    Assert.equal(gBrowser.tabs.length, tabs, "no tab opened for add-ons");
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

add_task(async function settings_can_ask_add_ons_for_a_view() {
  await BrowserTestUtils.withNewTab("about:preferences", async browser => {
    const settings = await settingsReady(browser);
    SvalAddonsNav.openInTab(settings, "addons://list/plugin");
    const addons = await addonsReady(browser);
    await TestUtils.waitForCondition(
      () => addons.gViewController.currentViewId === "addons://list/plugin",
      "the asked-for view shows"
    );
  });
});

add_task(async function add_ons_from_elsewhere_lead_to_settings_in_the_tab() {
  await BrowserTestUtils.withNewTab("about:blank", async blank => {
    const addons = await within(
      BrowserAddonUI.openAddonsMgr("addons://list/extension"),
      20_000,
      "the add-ons manager's opening"
    );
    const tab = gBrowser.getTabForBrowser(addons.docShell.chromeEventHandler);
    if (tab.linkedBrowser !== blank) {
      expectOpened(tab);
    }
    const tabs = gBrowser.tabs.length;
    addons.document.getElementById("sval-addons-crumb").click();
    await settingsReady(tab.linkedBrowser);
    Assert.equal(gBrowser.selectedTab, tab, "Settings loaded in the tab");
    Assert.equal(gBrowser.tabs.length, tabs, "and opened no other");
    if (tab.linkedBrowser !== blank) {
      BrowserTestUtils.removeTab(tab);
    }
  });
});
