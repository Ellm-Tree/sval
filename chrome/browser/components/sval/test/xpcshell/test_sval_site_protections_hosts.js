/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Protections, video and audio, and fingerprinting exceptions for one host
 * under its site: each field resolves on its own from the
 * most specific name holding it, and Gecko's stores give each origin that
 * name's choice.
 */

const { OVERRIDE_PREFS, SITE_BRANCH, SvalSiteProtections } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
  );

do_get_profile();

const { ALLOW_ACTION, DENY_ACTION, UNKNOWN_ACTION } = Ci.nsIPermissionManager;

/**
 * @param {string} origin
 * @returns {nsIPrincipal}
 */
function principalOf(origin) {
  return Services.scriptSecurityManager.createContentPrincipal(
    Services.io.newURI(origin),
    {}
  );
}

/**
 * @param {string} origin
 * @returns {number} The content-blocking allow list's answer for a page of
 *   `origin`: ALLOW lifts its protections (`ContentBlockingAllowList::Check`).
 */
function allowList(origin) {
  return Services.perms.testPermissionFromPrincipal(
    principalOf(origin),
    "trackingprotection"
  );
}

/**
 * @param {string} origin
 * @returns {number} The media permission Gecko's gate reads for `origin`.
 */
function media(origin) {
  return Services.perms.testExactPermissionFromPrincipal(
    principalOf(origin),
    "autoplay-media"
  );
}

function clearRules() {
  for (const name of Services.prefs.getChildList(SITE_BRANCH)) {
    Services.prefs.clearUserPref(name);
  }
}

add_setup(function () {
  SvalSiteProtections.start();
  registerCleanupFunction(clearRules);
});

add_task(function a_hosts_protections_on_under_its_sites_off() {
  SvalSiteProtections.setProtections("app.example.com", "on");
  Assert.deepEqual(
    SvalSiteProtections.ruleFor("app.example.com"),
    {},
    "on, as its site is, stores nothing"
  );

  SvalSiteProtections.setProtections("example.com", "off");
  SvalSiteProtections.setProtections("app.example.com", "on");
  Assert.deepEqual(SvalSiteProtections.ruleFor("app.example.com"), {
    protections: "on",
  });
  Assert.equal(allowList("https://app.example.com"), DENY_ACTION, "the host");
  Assert.equal(
    allowList("https://deep.app.example.com"),
    DENY_ACTION,
    "a name under the host"
  );
  Assert.equal(
    allowList("https://other.example.com"),
    ALLOW_ACTION,
    "its sibling keeps the site's protections off"
  );
  Assert.equal(
    SvalSiteProtections.protectionsFor("deep.app.example.com"),
    "on"
  );
  Assert.equal(SvalSiteProtections.protectionsFor("other.example.com"), "off");

  SvalSiteProtections.setProtections("example.com", "on");
  Assert.equal(
    allowList("https://other.example.com"),
    UNKNOWN_ACTION,
    "the site's choice goes from its hosts"
  );
  Assert.deepEqual(
    SvalSiteProtections.ruleFor("app.example.com"),
    { protections: "on" },
    "and leaves the host's own"
  );

  SvalSiteProtections.setRule("app.example.com", null);
  Assert.notEqual(
    allowList("https://app.example.com"),
    ALLOW_ACTION,
    "the host's reset leaves its protections on"
  );
  clearRules();
});

add_task(function a_hosts_protections_off_survives_its_sites_reset() {
  SvalSiteProtections.setProtections("example.com", "off");
  SvalSiteProtections.setProtections("app.example.com", "off");
  Assert.deepEqual(
    SvalSiteProtections.ruleFor("app.example.com"),
    {},
    "off, as its site is, stores nothing"
  );
  SvalSiteProtections.setProtections("example.com", "on");
  SvalSiteProtections.setProtections("app.example.com", "off");
  SvalSiteProtections.setRule("example.com", null);
  Assert.equal(allowList("https://app.example.com"), ALLOW_ACTION);
  Assert.equal(allowList("https://example.com"), UNKNOWN_ACTION);
  clearRules();
});

add_task(function a_hosts_media_rule() {
  SvalSiteProtections.setMedia("example.com", "block");
  SvalSiteProtections.setMedia("app.example.com", "allow");
  Assert.equal(
    SvalSiteProtections.ruleFor("app.example.com").protections,
    undefined,
    "a media rule holds no protections"
  );
  Assert.equal(media("https://app.example.com"), ALLOW_ACTION, "the host");
  Assert.equal(media("https://example.com"), DENY_ACTION, "the site");

  SvalSiteProtections.coverOrigin(principalOf("https://deep.app.example.com"));
  SvalSiteProtections.coverOrigin(principalOf("https://other.example.com"));
  Assert.equal(
    media("https://deep.app.example.com"),
    ALLOW_ACTION,
    "a page under the host takes the host's choice as it loads"
  );
  Assert.equal(
    media("https://other.example.com"),
    DENY_ACTION,
    "its sibling takes the site's"
  );
  Assert.equal(SvalSiteProtections.mediaFor("deep.app.example.com"), "allow");

  SvalSiteProtections.setMedia("example.com", "ask");
  Assert.equal(
    media("https://deep.app.example.com"),
    ALLOW_ACTION,
    "a choice at the site leaves the host's origins alone"
  );
  Assert.equal(
    media("https://other.example.com"),
    Ci.nsIAutoplay.BLOCKED_ALL,
    "and reaches the rest"
  );

  SvalSiteProtections.setMedia("app.example.com", "");
  Assert.equal(
    media("https://deep.app.example.com"),
    Ci.nsIAutoplay.BLOCKED_ALL,
    "the host's reset gives its origins the site's choice"
  );
  clearRules();
});

add_task(function a_hosts_fingerprinting_exception() {
  SvalSiteProtections.setExceptions("app.example.com", ["fonts"]);
  SvalSiteProtections.setMedia("media.example.com", "allow");
  const entries = JSON.parse(
    Services.prefs.getDefaultBranch("").getStringPref(OVERRIDE_PREFS[0], "")
  );
  Assert.deepEqual(
    entries.map(entry => entry.firstPartyDomain),
    ["app.example.com"],
    "the host's entry is named by the host, and a host with only media has none"
  );
  Assert.deepEqual(SvalSiteProtections.exceptionsFor("deep.app.example.com"), [
    "fonts",
  ]);
  Assert.deepEqual(SvalSiteProtections.exceptionsFor("example.com"), []);
  clearRules();
});

add_task(function rules_list_sites_and_hosts() {
  SvalSiteProtections.setMedia("example.com", "allow");
  SvalSiteProtections.setMedia("app.example.com", "block");
  Services.prefs.setStringPref(
    SITE_BRANCH + "www.example.com",
    JSON.stringify({ media: "block" })
  );
  Assert.deepEqual(
    [...SvalSiteProtections.rules().keys()],
    ["app.example.com", "example.com"],
    "a name that is no scope of its own, as www. of a site, is dropped"
  );
  clearRules();
});
