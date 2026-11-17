/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * HTTPS-Only Mode, on by default: a site with no secure version opens only
 * from its warning page, which lets it open until Sval quits, and the
 * Privacy and Security button's certificate view lets it open without the
 * warning on every device, a site choice that syncs (`SvalSiteProtections`).
 */

const { SvalSiteProtections, SITE_BRANCH } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
);

const PREF = "dom.security.https_only_mode";
const HOST = "expired.example.com";
// The harness serves this host over http, and its https only with an expired
// certificate, so HTTPS-Only Mode finds no secure version of it.
// eslint-disable-next-line sdl/no-insecure-url
const PLAIN_PAGE = `http://${HOST}/`;

const httpPrincipal = Services.scriptSecurityManager.createContentPrincipal(
  Services.io.newURI(PLAIN_PAGE),
  {}
);

function exception() {
  return Services.perms.testExactPermissionFromPrincipal(
    httpPrincipal,
    "https-only-load-insecure"
  );
}

function panel() {
  return document.getElementById("sval-protection-panel");
}

async function openCertificateView() {
  const shown = BrowserTestUtils.waitForEvent(panel(), "popupshown");
  document.getElementById("sval-protection-button").click();
  await within(shown, 5_000, "the panel's popupshown");
  document.getElementById("sval-prot-conn").click();
}

async function closePanel() {
  if (panel().state === "closed") {
    return;
  }
  const hidden = BrowserTestUtils.waitForEvent(panel(), "popuphidden");
  panel().hidePopup();
  await within(hidden, 5_000, "the panel's popuphidden");
}

/**
 * @param {Browser} browser
 * @returns {Promise<string>} The address of the document the browser shows.
 */
function documentURI(browser) {
  return SpecialPowers.spawn(browser, [], () => content.document.documentURI);
}

add_setup(async function () {
  // The harness profiles turn HTTPS-Only Mode off, since the harness serves
  // its own pages over plain http; this file is about the mode.
  await SpecialPowers.pushPrefEnv({ set: [[PREF, true]] });
  registerCleanupFunction(() => {
    SvalSiteProtections.setRule(HOST, null);
    Services.perms.removeFromPrincipal(
      httpPrincipal,
      "https-only-load-insecure"
    );
  });
});

add_task(function sval_turns_it_on_by_default() {
  Assert.ok(
    Services.prefs.getDefaultBranch("").getBoolPref(PREF),
    "Sval ships HTTPS-Only Mode on in every window"
  );
});

add_task(async function a_site_opens_from_the_warning_then_always() {
  const tab = BrowserTestUtils.addTab(gBrowser, PLAIN_PAGE);
  const browser = tab.linkedBrowser;
  const warned = BrowserTestUtils.waitForErrorPage(browser);
  await selectTab(tab);
  await within(warned, 15_000, "the warning page");
  Assert.ok(
    (await documentURI(browser)).startsWith("about:httpsonlyerror"),
    "a site with no secure version shows the warning first"
  );

  const opened = BrowserTestUtils.browserLoaded(browser, false, PLAIN_PAGE);
  await SpecialPowers.spawn(browser, [], () =>
    content.document.getElementById("openInsecure").click()
  );
  await within(opened, 15_000, "the site opening from the warning");
  Assert.equal(
    exception(),
    Ci.nsIHttpsOnlyModePermission.LOAD_INSECURE_ALLOW_SESSION,
    "the warning page lets it open until Sval quits"
  );

  await openCertificateView();
  try {
    const always = document.getElementById("sval-prot-https-only-always");
    Assert.ok(always, "the certificate view offers to always open it");
    const hidden = BrowserTestUtils.waitForEvent(panel(), "popuphidden");
    always.click();
    await within(hidden, 5_000, "the panel closing on the choice");
  } finally {
    await closePanel();
  }
  Assert.ok(
    SvalSiteProtections.insecureFor(HOST),
    "the choice is the host's, saved with its other site choices"
  );
  Assert.ok(
    Services.prefs.prefHasUserValue(SITE_BRANCH + HOST),
    "in the pref settings sync carries"
  );
  Assert.equal(
    exception(),
    Ci.nsIHttpsOnlyModePermission.LOAD_INSECURE_ALLOW,
    "and Gecko lets the site open with no end"
  );

  await openCertificateView();
  try {
    Assert.ok(
      !document.getElementById("sval-prot-https-only-always"),
      "a saved choice is not offered again"
    );
    const warnedAgain = BrowserTestUtils.waitForErrorPage(browser);
    document.getElementById("sval-prot-https-only").click();
    await within(warnedAgain, 15_000, "the warning after turning it back on");
  } finally {
    await closePanel();
  }
  Assert.ok(
    !SvalSiteProtections.insecureFor(HOST),
    "turning the mode back on takes the saved choice away"
  );
  Assert.equal(
    exception(),
    Services.perms.UNKNOWN_ACTION,
    "and the exception with it"
  );
  BrowserTestUtils.removeTab(tab);
});
