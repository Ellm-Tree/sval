/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// A JavaScript rule for one host under its site: stored only
// where it differs from what the host gets without it, and decided in Gecko's
// domain policy by the most specific name, whatever the default.

const { SITE_BRANCH, SvalJavascript } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalJavascript.sys.mjs"
);

do_get_profile();

/**
 * @param {string} origin
 * @returns {boolean} Whether a page of `origin` runs script, as Gecko decides
 *   it when it makes the page's global (`xpc::Scriptability`).
 */
function runsScript(origin) {
  return Services.scriptSecurityManager.createContentPrincipal(
    Services.io.newURI(origin),
    {}
  ).isScriptAllowedByPolicy;
}

function clearRules() {
  for (const name of Services.prefs.getChildList(SITE_BRANCH)) {
    Services.prefs.clearUserPref(name);
  }
}

add_setup(function () {
  SvalJavascript.start();
  registerCleanupFunction(() => {
    clearRules();
    Services.prefs.clearUserPref("javascript.enabled");
  });
});

add_task(function a_host_choice_matching_its_site_stores_nothing() {
  SvalJavascript.setEnabled("app.example.com", true);
  Assert.equal(SvalJavascript.rules().size, 0, "on, as the default is");
  SvalJavascript.setEnabled("example.com", false);
  SvalJavascript.setEnabled("app.example.com", false);
  Assert.deepEqual(
    [...SvalJavascript.rules()],
    [["example.com", "block"]],
    "off, as its site is"
  );
  clearRules();
});

add_task(function a_hosts_allow_beats_its_sites_block_with_script_on() {
  SvalJavascript.setEnabled("example.com", false);
  SvalJavascript.setEnabled("app.example.com", true);
  Assert.equal(SvalJavascript.ruleFor("app.example.com"), "allow");
  Assert.equal(SvalJavascript.ruleFor("other.example.com"), undefined);
  Assert.ok(runsScript("https://app.example.com"), "the host runs script");
  Assert.ok(
    runsScript("http://deep.app.example.com:8080"),
    "and so does a name under it"
  );
  Assert.ok(!runsScript("https://other.example.com"), "its sibling does not");
  Assert.ok(!runsScript("https://example.com"), "nor does the site");
  Assert.ok(SvalJavascript.enabledFor("deep.app.example.com"));
  Assert.ok(!SvalJavascript.enabledFor("other.example.com"));

  SvalJavascript.setEnabled("example.com", true);
  Assert.equal(
    SvalJavascript.ruleFor("app.example.com"),
    "allow",
    "a choice at the site never replaces the host's own"
  );
  clearRules();
});

add_task(function a_hosts_choices_beat_its_sites_with_script_off() {
  Services.prefs.setBoolPref("javascript.enabled", false);
  SvalJavascript.setEnabled("example.com", true);
  SvalJavascript.setEnabled("app.example.com", false);
  Assert.ok(!runsScript("https://app.example.com"), "the host's block wins");
  Assert.ok(runsScript("https://other.example.com"), "its sibling runs");

  SvalJavascript.removeRule("app.example.com");
  SvalJavascript.setEnabled("example.com", false);
  SvalJavascript.setEnabled("app.example.com", true);
  Assert.deepEqual(
    [...SvalJavascript.rules()],
    [["app.example.com", "allow"]],
    "a site matching the off default stores nothing, the host's allow is kept"
  );
  Assert.ok(runsScript("https://app.example.com"), "the host runs script");
  Assert.ok(!runsScript("https://other.example.com"), "its sibling does not");
  clearRules();
  Services.prefs.clearUserPref("javascript.enabled");
});
