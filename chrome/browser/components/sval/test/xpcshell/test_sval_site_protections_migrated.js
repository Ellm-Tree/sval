/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A profile that has migrated its permissions once starts without
 * migrating again: a permission made since stays out of the store. Its
 * manifest entry starts the profile migrated.
 */

const { MIGRATED_PREF, SvalSiteProtections } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
);

do_get_profile();

add_task(function a_migrated_profile_migrates_nothing_more() {
  Assert.ok(
    Services.prefs.getBoolPref(MIGRATED_PREF),
    "the profile has migrated"
  );
  const principal = Services.scriptSecurityManager.createContentPrincipal(
    Services.io.newURI("https://example.edu"),
    {}
  );
  Services.perms.addFromPrincipal(
    principal,
    "autoplay-media",
    Services.perms.ALLOW_ACTION
  );

  SvalSiteProtections.start();

  Assert.ok(
    !SvalSiteProtections.rules().has("example.edu"),
    "the later permission stays out of the store"
  );
  Assert.equal(
    Services.perms.testExactPermissionFromPrincipal(
      principal,
      "autoplay-media"
    ),
    Services.perms.ALLOW_ACTION,
    "and the permission is untouched"
  );
});
