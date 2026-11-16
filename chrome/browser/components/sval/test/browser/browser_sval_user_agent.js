/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Sval sends Firefox's user agent, token for token, as other Firefox forks
 * do: a site that recognises Firefox serves Sval what it serves Firefox. Gecko
 * writes `Firefox/<version>` only when the application's user-agent name is
 * "Firefox", and that name is compiled into libxul from MOZ_APP_UA_NAME
 * (patches/sval-app-vendor.patch). Without it the name falls back to the
 * application's own, and the string ends `sval/<version>`.
 */

const URL =
  "https://example.com/browser/browser/components/sval/test/browser/sval_user_agent.sjs";

// Firefox's desktop form: the rv: and Firefox/ versions are the same major
// release, and Gecko's token is frozen at 20100101.
const FIREFOX_FORM =
  /^Mozilla\/5\.0 \([^()]+; rv:(\d+)\.0\) Gecko\/20100101 Firefox\/\1\.0$/;

function major() {
  return Services.appinfo.platformVersion.split(".")[0];
}

add_task(async function the_user_agent_is_firefoxs() {
  Assert.ok(
    !Services.prefs.prefHasUserValue("general.useragent.override"),
    "no override stands in for the built-in string"
  );
  const ua = Cc["@mozilla.org/network/protocol;1?name=http"].getService(
    Ci.nsIHttpProtocolHandler
  ).userAgent;
  const match = FIREFOX_FORM.exec(ua);
  Assert.ok(match, `the user agent has Firefox's form: ${ua}`);
  Assert.equal(match?.[1], major(), "for this Gecko's version");
  Assert.ok(!/\bsval\b/i.test(ua), "and does not name Sval");
});

add_task(async function sites_see_the_same_user_agent() {
  const expected = Cc["@mozilla.org/network/protocol;1?name=http"].getService(
    Ci.nsIHttpProtocolHandler
  ).userAgent;
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, URL),
    15_000,
    "the new tab opening and loading"
  );
  try {
    const seen = await SpecialPowers.spawn(tab.linkedBrowser, [], () => ({
      header: content.document.body.textContent,
      navigator: content.navigator.userAgent,
    }));
    Assert.equal(seen.header, expected, "the request header carries it");
    Assert.equal(seen.navigator, expected, "and so does navigator.userAgent");
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});
