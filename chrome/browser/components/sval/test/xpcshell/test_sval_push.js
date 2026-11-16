/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { SvalPush } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPush.sys.mjs"
);

do_get_profile();

const PREF = "dom.push.connection.enabled";
const site = origin =>
  Services.scriptSecurityManager.createContentPrincipalFromOrigin(origin);

/**
 * Spec §10.9: the push connection is open exactly while some site may notify
 * the user: off on a profile that has allowed nobody, on from the moment one
 * site is allowed, and off again when the last allowed site is not.
 */
add_task(function the_connection_follows_the_notification_permission() {
  // The test harness turns the connection off as a user value
  // (testing/profiles/unittest-required/user.js); a real profile has none.
  Services.prefs.clearUserPref(PREF);
  Services.perms.removeAll();
  SvalPush.start();
  Assert.ok(!Services.prefs.getBoolPref(PREF), "nobody allowed: closed");

  Services.perms.addFromPrincipal(
    site("https://a.example"),
    "desktop-notification",
    Services.perms.DENY_ACTION
  );
  Assert.ok(!Services.prefs.getBoolPref(PREF), "a refusal opens nothing");

  Services.perms.addFromPrincipal(
    site("https://b.example"),
    "desktop-notification",
    Services.perms.ALLOW_ACTION
  );
  Assert.ok(Services.prefs.getBoolPref(PREF), "one site allowed: open");

  Services.perms.addFromPrincipal(
    site("https://c.example"),
    "geo",
    Services.perms.ALLOW_ACTION
  );
  Assert.ok(
    Services.prefs.getBoolPref(PREF),
    "other permissions change nothing"
  );

  Services.perms.removeFromPrincipal(
    site("https://b.example"),
    "desktop-notification"
  );
  Assert.ok(!Services.prefs.getBoolPref(PREF), "last one gone: closed");

  Services.perms.addFromPrincipal(
    site("https://b.example"),
    "desktop-notification",
    Services.perms.ALLOW_ACTION
  );
  Services.perms.removeAll();
  Assert.ok(!Services.prefs.getBoolPref(PREF), "clearing everything: closed");
});

/**
 * The gate writes the default branch, so a value the user set themselves is
 * never overridden, "false" included, a way to say never.
 */
add_task(function a_users_own_setting_wins() {
  Services.prefs.setBoolPref(PREF, false);
  Services.perms.addFromPrincipal(
    site("https://b.example"),
    "desktop-notification",
    Services.perms.ALLOW_ACTION
  );
  Assert.ok(!Services.prefs.getBoolPref(PREF));
  Assert.ok(Services.prefs.getDefaultBranch("").getBoolPref(PREF));
  Services.prefs.clearUserPref(PREF);
  Services.perms.removeAll();
});
