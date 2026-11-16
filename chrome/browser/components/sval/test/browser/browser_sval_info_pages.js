/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The sheets Firefox's information and tool pages take (`SvalPageStyle`),
 * and the ways Settings leads to two of them: security keys, and an
 * organization's policies.
 */

ChromeUtils.defineESModuleGetters(this, {
  EnterprisePolicyTesting:
    "resource://testing-common/EnterprisePolicyTesting.sys.mjs",
  PAGE_SHEET: "moz-src:///browser/components/sval/SvalPageStyle.sys.mjs",
  PAGES: "moz-src:///browser/components/sval/SvalPageStyle.sys.mjs",
  SHADOW_SHEETS: "moz-src:///browser/components/sval/SvalPageStyle.sys.mjs",
  shadowSheetsFor: "moz-src:///browser/components/sval/SvalPageStyle.sys.mjs",
  sheetsFor: "moz-src:///browser/components/sval/SvalPageStyle.sys.mjs",
});

const INFO_SHEET = "chrome://browser/content/sval/pages/info.css";

/** @param {string} page An about: address. */
const exists = page =>
  `@mozilla.org/network/protocol/about;1?what=${page.slice("about:".length)}` in
  Cc;

/**
 * Resolves once `browser` shows Settings with Sval's panes.
 *
 * @param {Element} browser
 */
async function settingsReady(browser) {
  await pageReady(browser, browser.currentURI.spec);
  await TestUtils.waitForCondition(
    () => browser.contentWindow?.SvalSettings?._els,
    "Settings shows Sval's panes"
  );
  return browser.contentWindow;
}

add_task(function each_page_takes_the_page_sheet_then_its_own() {
  Assert.deepEqual(
    sheetsFor("about:memory"),
    [PAGE_SHEET, INFO_SHEET],
    "an information page takes the page sheet, then the info sheet"
  );
  Assert.deepEqual(
    sheetsFor("about:license#top"),
    [PAGE_SHEET, "chrome://browser/content/sval/pages/license.css"],
    "a page with parts of its own takes its own sheet, whatever its fragment"
  );
  Assert.deepEqual(
    shadowSheetsFor("about:certificate?cert=x"),
    ["chrome://browser/content/sval/pages/certificate-shadow.css"],
    "a page with components to reach takes a user sheet for them"
  );
  Assert.deepEqual(shadowSheetsFor("about:support"), [], "others take none");
  for (const page of SHADOW_SHEETS.keys()) {
    Assert.ok(PAGES.has(page), `${page} is one the actor loads into`);
  }
});

add_task(
  async function security_keys_open_from_settings_where_gecko_has_them() {
    await BrowserTestUtils.withNewTab(
      "about:preferences#privacy",
      async browser => {
        const win = await settingsReady(browser);
        const card = win.document.getElementById("sval-security-keys");
        Assert.equal(
          card.hidden,
          !exists("about:webauthn"),
          "the card shows where Gecko has about:webauthn"
        );
        if (card.hidden) {
          return;
        }
        const opened = BrowserTestUtils.waitForNewTab(
          gBrowser,
          "about:webauthn"
        );
        win.document.getElementById("sval-security-keys-open").click();
        const tab = await within(opened, 10_000, "about:webauthn opening");
        await pageReady(tab.linkedBrowser, "about:webauthn");
        BrowserTestUtils.removeTab(tab);
      }
    );
  }
);

add_task(async function settings_says_when_an_organization_manages_sval() {
  const path = tempPath("sval-policies-", ".json");
  await IOUtils.writeJSON(path, { policies: { DummyPolicy: true } });
  // The policy engine turns Web Serial off by default as it starts
  // (`EnterprisePoliciesParent._initialize`), and stopping it leaves that.
  const defaults = Services.prefs.getDefaultBranch("");
  const webSerial = defaults.getBoolPref("dom.webserial.enabled");
  registerCleanupFunction(async () => {
    await within(
      EnterprisePolicyTesting.setupPolicyEngineWithJson(""),
      10_000,
      "the policy engine stopping"
    );
    Services.prefs.clearUserPref("browser.policies.alternatePath");
    defaults.setBoolPref("dom.webserial.enabled", webSerial);
  });
  await EnterprisePolicyTesting.setupPolicyEngineWithJson(path);
  Assert.equal(
    Services.policies.status,
    Services.policies.ACTIVE,
    "a policy is in force"
  );
  await BrowserTestUtils.withNewTab("about:preferences", async browser => {
    const win = await settingsReady(browser);
    const notice = win.document.getElementById("policies-container-content");
    await TestUtils.waitForCondition(
      () => !notice.hidden,
      "Settings shows the policies notice"
    );
    Assert.greater(
      notice.getBoundingClientRect().height,
      0,
      "the notice is on screen"
    );
    Assert.equal(
      notice.getAttribute("href"),
      "about:policies",
      "it leads to the policies in force"
    );
  });
});

/**
 * about:license says what licenses the source is under and nothing about
 * where it is, and about:buildconfig names a key file option without the
 * path the builder keeps the key at.
 */
add_task(async function the_license_and_build_pages_name_no_local_paths() {
  const license = await openPage("about:license");
  const links = await SpecialPowers.spawn(license.linkedBrowser, [], () =>
    [...content.document.querySelectorAll("a")].map(a => a.href)
  );
  Assert.ok(
    !links.includes("about:buildconfig"),
    "about:license points to no source URL on about:buildconfig"
  );
  Assert.ok(
    !links.some(href => href.includes("firefox-source-docs.mozilla.org")),
    "about:license links no instructions for building Firefox"
  );
  BrowserTestUtils.removeTab(license);

  const build = await openPage("about:buildconfig");
  const text = await SpecialPowers.spawn(
    build.linkedBrowser,
    [],
    () => content.document.body.textContent
  );
  Assert.ok(
    !/-keyfile=/.test(text),
    "about:buildconfig shows no key file's path"
  );
  BrowserTestUtils.removeTab(build);
});
