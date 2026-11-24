/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * Firefox's New Tab add-on and the components that served it are not built:
 * the add-on, its startup cache, its sponsored-link attribution and context
 * id, and its enterprise policy. about:home and about:newtab stay Sval's own
 * page (`browser_sval_home_page.js`).
 */

const { Policies } = ChromeUtils.importESModule(
  "resource:///modules/policies/Policies.sys.mjs"
);

/** A file of each removed component. */
const REMOVED_FILES = [
  "resource://builtin-addons/newtab/manifest.json",
  "resource:///modules/AboutHomeStartupCache.sys.mjs",
  "resource:///modules/AboutNewTabResourceMapping.sys.mjs",
  "resource:///actors/AboutNewTabParent.sys.mjs",
  "resource:///actors/AboutNewTabChild.sys.mjs",
  "moz-src:///browser/components/newtab/AboutNewTabComponents.sys.mjs",
  "moz-src:///browser/components/newtab/SponsorProtection.sys.mjs",
  "moz-src:///browser/components/newtab/MozNewTabRemoteRendererProtocolHandler.sys.mjs",
  "moz-src:///browser/components/mozcachedohttp/MozCachedOHTTPProtocolHandler.sys.mjs",
  "moz-src:///browser/modules/ContextId.sys.mjs",
  "resource:///modules/PartnerLinkAttribution.sys.mjs",
  "chrome://browser/content/contentSearchHandoffUI.mjs",
];

add_task(function removed_newtab_files_do_not_ship() {
  Assert.ok(
    packaged("resource:///modules/AboutNewTabRedirector.sys.mjs"),
    "the about: module that serves Sval's home page is found"
  );
  for (const spec of REMOVED_FILES) {
    Assert.ok(!packaged(spec), `${spec} is not in the package`);
  }
});

add_task(async function no_newtab_addon_is_installed() {
  Assert.equal(
    await AddonManager.getAddonByID("newtab@mozilla.org"),
    null,
    "the New Tab add-on is not installed"
  );
});

add_task(function the_firefox_home_policy_is_gone() {
  Assert.ok(!("FirefoxHome" in Policies), "no FirefoxHome policy");
});
