/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_icon_audit_collect.js */

/**
 * Sval's surfaces draw no image of Firefox's. Each task opens a
 * surface the way a user reaches it and records every image it shows from
 * outside Sval's art (`sval_icon_audit_collect.js`). The last task fails on
 * any of them that does not load Sval's art through `jar.mn`'s overrides,
 * and logs them as one `ICON-AUDIT` line, by URL, with the surfaces and
 * elements that draw each.
 */

const COLLECT = getRootDirectory(gTestPath) + "sval_icon_audit_collect.js";
Services.scriptloader.loadSubScript(COLLECT, this);

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);

const SITE = "https://example.com/browser/";

/** url -> { surfaces: string[], elements: string[] } */
const report = {};

/**
 * @param {string} surface
 * @param {{[key: string]: string[]}} found
 */
function record(surface, found) {
  for (const [url, elements] of Object.entries(found)) {
    const entry = (report[url] ??= { surfaces: [], elements: [] });
    if (!entry.surfaces.includes(surface)) {
      entry.surfaces.push(surface);
    }
    for (const el of elements) {
      if (!entry.elements.includes(el) && entry.elements.length < 8) {
        entry.elements.push(el);
      }
    }
  }
}

/**
 * What a page in `browser` draws, read in its own process.
 *
 * @param {MozBrowser} browser
 * @returns {Promise<{[key: string]: string[]}>}
 */
function pageImages(browser) {
  return within(
    SpecialPowers.spawn(browser, [COLLECT], collect => {
      const scope = {};
      Services.scriptloader.loadSubScript(collect, scope);
      return scope.drawnImages(content.document);
    }),
    10_000,
    "the page's images"
  );
}

/**
 * Opens the popup `open` shows, records what it draws, and closes it.
 *
 * @param {string} surface
 * @param {string} popupId
 * @param {Function} open
 */
async function auditPopup(surface, popupId, open) {
  // A popup built the first time it opens is not there to wait on, so the
  // wait for one is on the window.
  const existing = document.getElementById(popupId);
  const shown = existing
    ? BrowserTestUtils.waitForPopupEvent(existing, "shown")
    : BrowserTestUtils.waitForEvent(
        window,
        "popupshown",
        true,
        event => event.target.id === popupId
      );
  await open();
  await within(shown, 10_000, `${surface} opening`);
  const popup = document.getElementById(popupId);
  record(surface, drawnImages(popup));
  const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
  popup.hidePopup();
  await within(hidden, 5_000, `${surface} closing`);
}

/**
 * @param {string} id
 * @returns {Promise}
 */
function clickButton(id) {
  return EventUtils.synthesizeMouseAtCenter(
    document.getElementById(id),
    {},
    window
  );
}

add_task(async function the_window_on_a_site() {
  await openPage(SITE);
  record("window", drawnImages(document));
});

add_task(async function the_launcher_with_rows() {
  await openPage(SITE);
  await within(
    UrlbarTestUtils.promiseAutocompleteResultPopup({ window, value: "exam" }),
    10_000,
    "the Launcher's rows"
  );
  record("launcher", drawnImages(gURLBar.view.panel));
  await UrlbarTestUtils.promisePopupClose(window);
});

add_task(async function the_header_s_panels() {
  await openPage(SITE);
  for (const [surface, button, popup] of [
    [
      "extensions panel",
      "unified-extensions-button",
      "unified-extensions-panel",
    ],
    ["site menu", "sval-site-menu-button", "sval-site-menu"],
    ["notices", "sval-notices-button", "sval-notices-panel"],
  ]) {
    if (!document.getElementById(button)?.checkVisibility()) {
      info(`${surface}: its button is not shown`);
      continue;
    }
    await auditPopup(surface, popup, () => clickButton(button));
  }
});

add_task(async function the_context_menus() {
  const tab = await openPage(`${ROOT}sval_quick_peek_links.html`);
  await auditPopup("page context menu", "contentAreaContextMenu", () =>
    BrowserTestUtils.synthesizeMouseAtCenter(
      "#link",
      { type: "contextmenu", button: 2 },
      tab.linkedBrowser
    )
  );
});

add_task(async function a_site_s_location_prompt() {
  await SpecialPowers.pushPrefEnv({
    set: [["geo.prompt.testing", false]],
  });
  const tab = await openPage(SITE);
  await auditPopup("location prompt", "notification-popup", () =>
    SpecialPowers.spawn(tab.linkedBrowser, [], () => {
      content.navigator.geolocation.getCurrentPosition(() => {});
    })
  );
  record("location prompt, address bar", drawnImages(gURLBar));
});

add_task(async function a_site_s_camera_and_notification_prompts() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["media.navigator.streams.fake", true],
      ["dom.webnotifications.requireuserinteraction", false],
    ],
  });
  const tab = await openPage(`${ROOT}sval_capture_page.html`);
  await auditPopup("camera prompt", "notification-popup", () =>
    SpecialPowers.spawn(tab.linkedBrowser, [], () => {
      content.wrappedJSObject.start();
    })
  );
  record("camera prompt, address bar", drawnImages(gURLBar));
  BrowserTestUtils.removeTab(tab);
  const other = await openPage(`${ROOT}sval_quick_peek_links.html`);
  await auditPopup("notification prompt", "notification-popup", () =>
    SpecialPowers.spawn(other.linkedBrowser, [], () => {
      content.Notification.requestPermission();
    })
  );
});

add_task(async function the_downloads_panel_and_page_with_a_download() {
  const list = await Downloads.getList(Downloads.PUBLIC);
  const download = await Downloads.createDownload({
    source: `${ROOT}sval_quick_peek_links.html`,
    target: PathUtils.join(PathUtils.tempDir, "sval-icon-audit.html"),
  });
  await list.add(download);
  registerCleanupFunction(async () => {
    await list.remove(download);
    await download.finalize(true);
  });
  await within(download.start(), 10_000, "the download finishing");
  await openPage(SITE);
  await auditPopup("downloads panel", "downloadsPanel", () =>
    DownloadsPanel.showPanel()
  );
  const tab = await openPage("about:downloads");
  await TestUtils.waitForCondition(
    () => tab.linkedBrowser.contentDocument?.querySelector("richlistitem"),
    "about:downloads lists the download"
  );
  record(
    "about:downloads, a download",
    drawnImages(tab.linkedBrowser.contentDocument)
  );
});

add_task(async function a_private_window() {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20_000,
    "the private window"
  );
  await pageReady(win.gBrowser.selectedBrowser, "about:privatebrowsing");
  record("private window", drawnImages(win.document));
  record(
    "private window's page",
    await pageImages(win.gBrowser.selectedBrowser)
  );
  await within(BrowserTestUtils.closeWindow(win), 10_000, "its closing");
});

add_task(async function a_peek() {
  const { SvalPeek } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalPeek.sys.mjs"
  );
  const opened = BrowserTestUtils.waitForNewWindow({
    url: BROWSER_NEW_TAB_URL,
  });
  SvalPeek.openEmpty(window);
  const win = await within(opened, 20_000, "the Peek");
  record("peek", drawnImages(win.document));
  await within(BrowserTestUtils.closeWindow(win), 10_000, "the Peek closing");
});

add_task(async function a_quick_peek() {
  const { SvalQuickPeek } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalQuickPeek.sys.mjs"
  );
  const tab = await openPage(`${ROOT}sval_quick_peek_links.html`);
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#link",
    { altKey: true },
    tab.linkedBrowser
  );
  await TestUtils.waitForCondition(
    () => SvalQuickPeek.tabOf(window),
    "a Quick Peek opens"
  );
  await committed(
    SvalQuickPeek.tabOf(window).linkedBrowser,
    `${ROOT}sval_agent_page2.html`,
    "the Quick Peek has the link"
  );
  record("quick peek", drawnImages(document));
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    () => !SvalQuickPeek.tabOf(window),
    "the Quick Peek closes"
  );
});

add_task(async function page_info() {
  await openPage(SITE);
  const opened = BrowserTestUtils.domWindowOpenedAndLoaded();
  BrowserCommands.pageInfo();
  const win = await within(opened, 10_000, "Page Info");
  for (const panel of ["general", "media", "perm", "security"]) {
    win.showTab(panel);
    record(`page info ${panel}`, drawnImages(win.document));
  }
  await within(BrowserTestUtils.closeWindow(win), 10_000, "Page Info closing");
});

/** Firefox's pages Sval keeps, each opened as a user opens it. */
const PAGES = [
  "about:home",
  "about:newtab",
  "about:addons",
  "about:downloads",
  "about:support",
  "about:config",
  "about:processes",
  "about:policies",
  "about:license",
  "about:about",
  "about:certificate",
  "about:neterror?e=dnsNotFound&u=https%3A//example.invalid/&c=UTF-8&d=x",
  "about:certerror?e=nssBadCert&u=https%3A//expired.example.com/&c=UTF-8&d=x",
  "about:blocked?e=deceptiveBlocked&u=https%3A//example.invalid/&c=UTF-8&d=x",
];

add_task(async function firefox_s_pages() {
  for (const url of PAGES) {
    const tab = await openPage(url);
    record(url.split("?")[0], await pageImages(tab.linkedBrowser));
    BrowserTestUtils.removeTab(tab);
  }
});

/**
 * Settings panes Sval takes out of reach: Firefox Labs
 * (`no-firefox-labs.patch`), the AI window's (`browser.ai.control.*`) and
 * Containers (`browser_sval_upstream_ui.js`).
 */
const REMOVED_PANES = [
  "paneExperimental",
  "panePersonalizeSmartWindow",
  "paneContainers",
];

add_task(async function every_settings_pane() {
  const tab = await openPage("about:preferences");
  const win = tab.linkedBrowser.contentWindow;
  const views = [
    ...win.document.querySelectorAll("moz-page-nav-button[view]"),
  ].map(button => button.getAttribute("view"));
  for (const view of views.filter(v => !REMOVED_PANES.includes(v))) {
    if (win.gLastCategory.category !== view) {
      const shown = BrowserTestUtils.waitForEvent(win.document, "paneshown");
      win.gotoPref(view);
      await within(shown, 5_000, `${view} showing`);
    }
    record(`settings ${view}`, drawnImages(win.document));
  }
});

/**
 * The file a chrome URL loads, through every override on the way.
 *
 * @param {string} url
 * @returns {string}
 */
function resolve(url) {
  const registry = Cc["@mozilla.org/chrome/chrome-registry;1"].getService(
    Ci.nsIChromeRegistry
  );
  let uri = Services.io.newURI(url);
  while (uri.schemeIs("chrome")) {
    uri = registry.convertChromeURL(uri);
  }
  return uri.spec;
}

/** Where Sval's own art loads from. */
const SVAL_ART = [
  "chrome://browser/content/sval/sval-icons.css",
  "chrome://branding/content/about-logo.svg",
].map(url => resolve(url).replace(/[^/]+$/, ""));

add_task(async function no_surface_draws_firefox_s_art() {
  const urls = Object.keys(report)
    .filter(url => !SVAL_ART.some(dir => resolve(url).startsWith(dir)))
    .sort();
  info(
    `ICON-AUDIT ${JSON.stringify(Object.fromEntries(urls.map(u => [u, report[u]])))}`
  );
  Assert.greater(Object.keys(report).length, 0, "the audit read images");
  Assert.deepEqual(urls, [], "every image Sval's surfaces draw is Sval's");
});
