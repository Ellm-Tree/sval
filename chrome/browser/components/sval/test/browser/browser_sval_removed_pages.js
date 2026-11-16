/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * The Firefox pages Sval replaces or has no use for are not built
 * (`no-closed-about-pages.patch`, `no-mozilla-credits-rights-pages.patch`):
 * no about: name of theirs is registered, none of their documents is in the
 * package, and nothing Sval shows leads to them.
 */

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);

const ABOUT_NAMES = [
  "about:logins",
  "about:loginsimportreport",
  "about:protections",
  "about:keyboard",
  "about:welcomeback",
  "about:studies",
  "about:asrouter",
  "about:messagepreview",
  "about:aichatcontent",
  "about:inference",
  "about:mozilla",
  "about:logo",
  "about:unloads",
  "about:telemetry",
  "about:glean",
  "about:profiling",
  "about:firefoxview",
  "about:robots",
  "about:sync-log",
  "about:profiles",
  "about:profilemanager",
  "about:newprofile",
  "about:editprofile",
  "about:deleteprofile",
  "about:pdf",
  "about:sessionrestore",
  "about:fingerprintingprotection",
  "about:checkerboard",
  "about:credits",
  "about:rights",
];

const DOCUMENTS = [
  "chrome://browser/content/aboutlogins/aboutLogins.html",
  "chrome://browser/content/aboutlogins/aboutLoginsImportReport.html",
  "chrome://browser/content/protections.html",
  "chrome://browser/content/customkeys/customkeys.html",
  "chrome://browser/content/aboutwelcome/aboutwelcome.html",
  "chrome://browser/content/aboutWelcomeBack.xhtml",
  "resource://normandy-content/about-studies/about-studies.html",
  "chrome://browser/content/asrouter/asrouter-admin.html",
  "chrome://browser/content/messagepreview/messagepreview.html",
  "chrome://browser/content/aiwindow/aiChatContent.html",
  "chrome://global/content/aboutInference.html",
  "chrome://global/content/mozilla.html",
  "chrome://browser/content/tabunloader/aboutUnloads.html",
  "chrome://global/content/aboutTelemetry.xhtml",
  "chrome://global/content/aboutGlean.html",
  "chrome://browser/content/firefoxview/firefoxview.html",
  "chrome://browser/content/aboutRobots.xhtml",
  "chrome://global/content/aboutProfiles.xhtml",
  "chrome://browser/content/profiles/profiles.html",
  "chrome://browser/content/profiles/new-profile.html",
  "chrome://browser/content/profiles/edit-profile.html",
  "chrome://browser/content/profiles/delete-profile.html",
  "chrome://global/content/aboutPDF.html",
  "chrome://browser/content/aboutSessionRestore.xhtml",
  "chrome://global/content/usercharacteristics/usercharacteristics.html",
  "chrome://global/content/aboutCheckerboard.html",
];

/**
 * @param {string} url An about: address.
 * @returns {boolean} whether Gecko registers a page under its name.
 */
function registered(url) {
  const what = new URL(url).pathname;
  return `@mozilla.org/network/protocol/about;1?what=${what}` in Cc;
}

/** Each name opens the page an about: address with no page behind it gets. */
add_task(async function no_name_has_a_page() {
  for (const url of ABOUT_NAMES) {
    Assert.ok(!registered(url), `Gecko registers no ${url}`);
    await BrowserTestUtils.withNewTab(
      { gBrowser, url: "about:blank" },
      async browser => {
        const loaded = BrowserTestUtils.browserLoaded(
          browser,
          false,
          null,
          true
        );
        BrowserTestUtils.startLoadingURIString(browser, url);
        await within(loaded, 15_000, `${url} loading in the tab`);
        const shown = await SpecialPowers.spawn(
          browser,
          [],
          () => content.document.documentURI
        );
        Assert.ok(
          shown.startsWith("about:neterror?e=malformedURI"),
          `${url} has no page (${shown})`
        );
      }
    );
  }
});

/**
 * @param {string} spec A chrome: or resource: address.
 * @returns {boolean} whether the package holds a file at it. Opening a
 *   missing one is no way to ask: under automation Gecko crashes on it
 *   (`CheckForBrokenChromeURL`).
 */
function packaged(spec) {
  let uri = Services.io.newURI(spec);
  // An override maps a chrome: address to another one.
  while (uri.schemeIs("chrome")) {
    uri = Cc["@mozilla.org/chrome/chrome-registry;1"]
      .getService(Ci.nsIChromeRegistry)
      .convertChromeURL(uri);
  }
  if (uri.schemeIs("resource")) {
    uri = Services.io.newURI(
      Services.io
        .getProtocolHandler("resource")
        .QueryInterface(Ci.nsIResProtocolHandler)
        .resolveURI(uri)
    );
  }
  if (uri instanceof Ci.nsIJARURI) {
    const reader = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(
      Ci.nsIZipReader
    );
    reader.open(uri.JARFile.QueryInterface(Ci.nsIFileURL).file);
    try {
      return reader.hasEntry(uri.JAREntry);
    } finally {
      reader.close();
    }
  }
  return uri.QueryInterface(Ci.nsIFileURL).file.exists();
}

add_task(function no_document_is_in_the_package() {
  Assert.ok(
    packaged("chrome://global/content/license.html"),
    "a document the package keeps is found"
  );
  for (const spec of DOCUMENTS) {
    Assert.ok(!packaged(spec), `${spec} is not in the package`);
  }
});

/**
 * about:welcome is Sval's home page while Firefox's onboarding is off, which
 * is why the onboarding's document goes and its name stays.
 */
add_task(async function welcome_is_home() {
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:blank" },
    async browser => {
      const loaded = BrowserTestUtils.browserLoaded(browser);
      BrowserTestUtils.startLoadingURIString(browser, "about:welcome");
      await within(loaded, 15_000, "about:welcome loading in the tab");
      const shown = await SpecialPowers.spawn(
        browser,
        [],
        () => content.document.documentURI
      );
      Assert.equal(shown, "about:home", "about:welcome shows about:home");
    }
  );
});

/** about:about lists none of them. */
add_task(async function about_about_lists_none_of_them() {
  const tab = await openPage("about:about");
  const listed = await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    [...content.document.querySelectorAll("#abouts a")].map(a => a.href)
  );
  Assert.ok(listed.includes("about:license"), "about:about lists its pages");
  for (const url of ABOUT_NAMES) {
    Assert.ok(!listed.includes(url), `about:about leaves out ${url}`);
  }
  BrowserTestUtils.removeTab(tab);
});

/** The address bar neither suggests nor completes one of them. */
add_task(async function the_address_bar_offers_none_of_them() {
  await BrowserTestUtils.withNewTab("about:blank", async () => {
    for (const url of ["about:telemetry", "about:glean", "about:unloads"]) {
      const typed = url.slice(0, -2);
      await UrlbarTestUtils.promiseAutocompleteResultPopup({
        window,
        value: typed,
      });
      const offered = [];
      for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
        const { url: result } = await UrlbarTestUtils.getDetailsOfResultAt(
          window,
          i
        );
        offered.push(result);
      }
      Assert.ok(
        !offered.includes(url),
        `typing ${typed} offers no ${url} (${offered.join(", ")})`
      );
      Assert.equal(gURLBar.value, typed, `${typed} is not completed to ${url}`);
      await UrlbarTestUtils.promisePopupClose(window);
    }
  });
});

/**
 * Firefox's selectable profiles are off, so the File menu's Profiles menu
 * and Settings' profile controls, the ways to about:profilemanager and the
 * pages it opens, are hidden (`SelectableProfileService.isEnabled`).
 */
add_task(async function no_menu_or_setting_leads_to_the_profile_pages() {
  const { SelectableProfileService } = ChromeUtils.importESModule(
    "resource:///modules/profiles/SelectableProfileService.sys.mjs"
  );
  Assert.ok(
    !SelectableProfileService.isEnabled,
    "Firefox's selectable profiles are off"
  );
  Assert.ok(
    document.getElementById("profiles-menu").hidden,
    "the File menu has no Profiles menu"
  );
  await BrowserTestUtils.withNewTab(
    "about:preferences#privacy",
    async browser => {
      const { Preferences } = browser.contentWindow;
      await TestUtils.waitForCondition(
        () => Preferences.getSetting("preferencesPrivacyProfiles"),
        "Settings registers its profile controls"
      );
      for (const id of ["profilesSettings", "preferencesPrivacyProfiles"]) {
        Assert.ok(!Preferences.getSetting(id).visible, `Settings hides ${id}`);
      }
    }
  );
});

/**
 * about:support keeps its profile folder row, and shows no link to a page
 * Sval does not build and no Remote Experiments section.
 */
add_task(async function about_support_links_to_no_profile_page() {
  const tab = await openPage("about:support");
  const shown = await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const { document } = content;
    const visible = el =>
      el.checkVisibility({
        checkVisibilityCSS: true,
        visibilityProperty: true,
      });
    return {
      links: [...document.querySelectorAll("a[href^='about:']")]
        .filter(visible)
        .map(a => a.getAttribute("href")),
      experiments: !!document.getElementById("remote-experiments"),
      folder: visible(document.getElementById("profile-dir-box")),
    };
  });
  Assert.ok(shown.links.length, "about:support links to other pages");
  for (const href of shown.links) {
    Assert.ok(registered(href), `${href} has a page`);
  }
  Assert.ok(
    !shown.experiments,
    "about:support has no Remote Experiments section"
  );
  Assert.ok(shown.folder, "the profile folder still shows");
  BrowserTestUtils.removeTab(tab);
});

/** A PDF opens in PDF.js at its own address, with no about:pdf. */
add_task(async function a_pdf_opens_in_the_viewer() {
  const pdf =
    getRootDirectory(gTestPath).replace(
      "chrome://mochitests/content",
      "https://example.com"
    ) + "sval_agent_doc.pdf";
  const tab = await openPage(pdf);
  Assert.equal(
    tab.linkedBrowser.browsingContext.currentWindowGlobal.documentPrincipal
      .originNoSuffix,
    "resource://pdf.js",
    "PDF.js shows the PDF"
  );
  await within(
    SpecialPowers.spawn(tab.linkedBrowser, [], () =>
      ContentTaskUtils.waitForCondition(
        () =>
          Boolean(content.wrappedJSObject.PDFViewerApplication?.pdfDocument),
        "the PDF's document"
      )
    ),
    10_000,
    "the PDF loading in PDF.js"
  );
  BrowserTestUtils.removeTab(tab);
});
