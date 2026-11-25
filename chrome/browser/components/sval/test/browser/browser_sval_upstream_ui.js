/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Firefox's own UI that Sval removes or points at Sval: outbound links, the
 * profiler, Firefox's tab settings and tab chrome, and the address bar's
 * offer of an engine Sval already has. docs/outbound-links.md is the audit.
 */

ChromeUtils.defineESModuleGetters(this, {
  OpenSearchManager:
    "moz-src:///browser/components/search/OpenSearchManager.sys.mjs",
  SearchTestUtils: "resource://testing-common/SearchTestUtils.sys.mjs",
});

SearchTestUtils.init(this);

const OFFER_PAGE = "https://example.com/browser/";

/** Hosts no link a user can reach in Sval may lead to. */
const UPSTREAM_HOST = /(^|\.)(mozilla\.org|mozilla\.com|firefox\.com)$/;

/**
 * @param {string} url
 * @returns {boolean} whether `url` is on one of Mozilla's hosts.
 */
function isUpstream(url) {
  try {
    return UPSTREAM_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * The URL a pref ships with. The harness's own profile points some of these
 * at its test server, so the user branch says nothing about Sval.
 *
 * @param {string} name
 * @returns {string}
 */
function shippedUrl(name) {
  return Services.urlFormatter.formatURL(
    Services.prefs.getDefaultBranch("").getStringPref(name)
  );
}

add_task(async function support_links_lead_to_sval() {
  Assert.ok(
    shippedUrl("app.support.baseURL").startsWith("https://sval.app/"),
    "every Learn more link is built on Sval's support pages"
  );
  for (const name of [
    "app.feedback.baseURL",
    "app.update.url.manual",
    "browser.geolocation.warning.infoURL",
    "browser.xr.warning.infoURL",
    "browser.lna.warning.infoURL",
    "extensions.recommendations.themeRecommendationUrl",
    "pdfjs.commentLearnMoreUrl",
    "app.normandy.shieldLearnMoreUrl",
    "toolkit.datacollection.infoURL",
  ]) {
    const url = shippedUrl(name);
    Assert.ok(!isUpstream(url), `${name} leads to none of Mozilla's sites`);
  }
  Assert.ok(
    !Services.prefs.getBoolPref("extensions.getAddons.showPane"),
    "about:addons has no Mozilla recommendations pane"
  );
  const feedback = document.getElementById("feedbackPage");
  Assert.ok(!feedback || feedback.hidden, "no Share Ideas and Feedback item");
});

add_task(async function the_profiler_has_no_button_and_no_panel() {
  for (const name of [
    "devtools.performance.popup.feature-flag",
    "devtools.performance.enabled",
  ]) {
    Assert.ok(!Services.prefs.getBoolPref(name), `${name} is off`);
    Assert.ok(Services.prefs.prefIsLocked(name), `${name} is locked`);
  }

  // A placement left in a profile's toolbar, the state profiler.firefox.com
  // and about:logging leave behind, draws nothing.
  CustomizableUI.addWidgetToArea("profiler-button", CustomizableUI.AREA_NAVBAR);
  try {
    Assert.equal(
      document.getElementById("profiler-button"),
      null,
      "no profiler button in the toolbar"
    );
  } finally {
    CustomizableUI.removeWidgetFromArea("profiler-button");
  }
});

const FIREFOX_TAB_MENU_ITEMS = [
  "menu_openFirefoxView",
  "historyRestoreLastSession",
];

add_task(async function firefox_tab_chrome_is_hidden() {
  for (const id of FIREFOX_TAB_MENU_ITEMS) {
    Assert.ok(document.getElementById(id).hidden, `${id} is hidden`);
  }
});

// The hidden window's menu bar is the one macOS shows once every window is
// closed (`hiddenWindowMac.xhtml`).
add_task(
  { skip_if: () => AppConstants.platform != "macosx" },
  async function hidden_window_menu_bar_has_no_firefox_tab_items() {
    const doc = Services.appShell.hiddenDOMWindow.document;
    Assert.equal(
      doc.documentURI,
      "chrome://browser/content/hiddenWindowMac.xhtml",
      "the hidden window is the one with a menu bar"
    );
    for (const id of FIREFOX_TAB_MENU_ITEMS) {
      const item = doc.getElementById(id);
      Assert.ok(item, `the hidden window has ${id}`);
      Assert.ok(item.hidden, `${id} is hidden in the hidden window`);
    }
  }
);

add_task(async function settings_offer_no_firefox_tab_settings() {
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:preferences#home" },
    async browser => {
      const win = browser.contentWindow;
      for (const id of [
        "browserRestoreSession",
        "tabsInteraction",
        "browserLayoutRadioGroup",
        "warnCloseMultiple",
        "linkTargeting",
        "openAppLinksNextToActiveTab",
      ]) {
        const setting = win.Preferences.getSetting(id);
        Assert.ok(setting, `${id} is a setting`);
        Assert.ok(!setting.visible, `${id} is not shown`);
      }
    }
  );
});

/**
 * A link that asks for a new window opens a tab, from a page or from another
 * app, and no setting or synced value changes that: a new window takes
 * another workspace (Sval spec §10.7).
 */
add_task(async function links_never_ask_for_a_new_window() {
  for (const [name, value] of [
    ["browser.link.open_newwindow", Ci.nsIBrowserDOMWindow.OPEN_NEWTAB],
    ["browser.link.open_newwindow.override.external", -1],
  ]) {
    Assert.ok(Services.prefs.prefIsLocked(name), `${name} is locked`);
    Assert.equal(Services.prefs.getIntPref(name), value, `at ${value}`);
  }
  const { SvalSettingsRegistry } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSettingsRegistry.sys.mjs"
  );
  Assert.ok(
    !SvalSettingsRegistry.SYNCED_PREFS.includes("browser.link.open_newwindow"),
    "and it does not sync"
  );
});

add_task(async function firefox_containers_are_unreachable() {
  const prefs = [
    "privacy.userContext.enabled",
    "privacy.userContext.ui.enabled",
    "privacy.userContext.newTabContainerOnLeftClick.enabled",
  ];
  for (const name of prefs) {
    Assert.ok(!Services.prefs.getBoolPref(name), `${name} is off`);
    Assert.ok(Services.prefs.prefIsLocked(name), `${name} is locked`);
  }
  Assert.ok(Services.prefs.prefIsLocked("privacy.userContext.extension"));

  // What an add-on with the contextualIdentities permission does at startup
  // (ext-contextualIdentities.js, onStartup): the lock must win.
  Services.prefs.setBoolPref("privacy.userContext.enabled", true);
  Services.prefs.setBoolPref("privacy.userContext.ui.enabled", true);
  try {
    Assert.ok(
      !Services.prefs.getBoolPref("privacy.userContext.enabled"),
      "an add-on cannot turn containers back on"
    );
    Assert.ok(!Services.prefs.getBoolPref("privacy.userContext.ui.enabled"));
  } finally {
    Services.prefs.clearUserPref("privacy.userContext.enabled");
    Services.prefs.clearUserPref("privacy.userContext.ui.enabled");
  }

  gFileMenu.updateUserContextUIVisibility();
  Assert.ok(
    document.getElementById("menu_newUserContext").hidden,
    "the File menu has no New Container Tab"
  );

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:preferences#general" },
    async browser => {
      const setting = browser.contentWindow.Preferences.getSetting(
        "browserContainersbox"
      );
      Assert.ok(setting, "the containers setting exists");
      Assert.ok(!setting.visible, "settings offer no containers");
    }
  );

  await BrowserTestUtils.withNewTab(
    {
      gBrowser,
      url: "data:text/html,<a id='l' href='https://example.com/'>link</a>",
    },
    async browser => {
      const menu = document.getElementById("contentAreaContextMenu");
      const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
      await BrowserTestUtils.synthesizeMouseAtCenter(
        "#l",
        { type: "contextmenu", button: 2 },
        browser
      );
      await within(shown, 5_000, "the content context menu's shown");
      Assert.ok(
        document.getElementById("context-openlinkincontainertab").hidden,
        "a link's menu has no Open Link in New Container Tab"
      );
      const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
      menu.hidePopup();
      await within(hidden, 5_000, "the content context menu's hidden");
    }
  );
});

add_task(async function an_installed_engine_is_not_offered_again() {
  // The page's title for its engine differs from the installed name, as
  // kagi.com's "Kagi Search" differs from Sval's "Kagi".
  await SearchTestUtils.installSearchExtension({
    name: "sval Installed Engine",
    search_url: "https://example.com/search",
  });

  await BrowserTestUtils.withNewTab(OFFER_PAGE, async browser => {
    await SpecialPowers.spawn(browser, [], () => {
      const add = (title, href) => {
        const link = content.document.createElement("link");
        link.rel = "search";
        link.type = "application/opensearchdescription+xml";
        link.title = title;
        link.href = href;
        content.document.head.appendChild(link);
      };
      add("Installed Engine Search", "https://example.com/opensearch.xml");
      // The same site, under www.
      add("Installed Engine at www", "https://www.example.com/opensearch.xml");
      add("Another Engine", "https://example.org/opensearch.xml");
    });

    await TestUtils.waitForCondition(() => {
      const titles = OpenSearchManager.getEngines(browser).map(e => e.title);
      return titles.length == 1 && titles[0] == "Another Engine";
    }, "only the engine sval does not have is offered");
  });
});

/**
 * The bookmarks toolbar never shows, not even on a new tab with bookmarks on
 * it, and no menu offers it (import spec §6).
 */
add_task(async function the_bookmarks_toolbar_never_shows() {
  Assert.equal(
    Services.prefs.getCharPref("browser.toolbars.bookmarks.visibility"),
    "never"
  );
  Assert.ok(
    Services.prefs.prefIsLocked("browser.toolbars.bookmarks.visibility"),
    "and nothing can change that"
  );

  await PlacesUtils.bookmarks.insert({
    parentGuid: PlacesUtils.bookmarks.toolbarGuid,
    url: "https://example.com/on-the-toolbar",
    title: "On the toolbar",
  });
  registerCleanupFunction(() => PlacesUtils.bookmarks.eraseEverything());
  // Not waiting for a load: about:newtab may come from the preloaded browser,
  // which fired its load before the tab existed.
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "about:newtab", false),
    15_000,
    "the new tab opening and loading"
  );
  await committed(tab.linkedBrowser, "about:newtab");
  const bar = document.getElementById("PersonalToolbar");
  Assert.ok(bar.collapsed, "a new tab with toolbar bookmarks shows no bar");

  // The toolbar context menu and View › Toolbars list exactly the toolbars
  // carrying a name (`ToolbarContextMenu.onViewToolbarsPopupShowing`).
  Assert.ok(!bar.hasAttribute("toolbarname"), "no menu lists the toolbar");
  Assert.ok(
    !bar.hasAttribute("data-l10n-id"),
    "nor names it again when the language changes"
  );
  Assert.equal(
    document.getElementById("viewBookmarksToolbarKb").getAttribute("disabled"),
    "true",
    "and its shortcut does nothing"
  );
  BrowserTestUtils.removeTab(tab);
});
