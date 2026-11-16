/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * What `SvalSiteProtections.start` finds in a profile at startup: the
 * permissions made before the store existed move into it, and entries of its
 * own that an older build saved in Gecko's granular prefs are dropped, so
 * none outlives its choice. A profile that has migrated once is
 * `test_sval_site_protections_migrated.js`'s.
 */

const {
  GRANULAR_PREFS,
  MIGRATED_PREF,
  OVERRIDE_PREFS,
  SITE_BRANCH,
  SvalSiteProtections,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
);

do_get_profile();

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

add_task(function startup_migrates_and_drops_saved_entries() {
  const foreign = { firstPartyDomain: "other.test", overrides: "+Gamepad" };
  const own = site => ({ firstPartyDomain: site, overrides: "-AllTargets" });
  // Someone's own entry, in the shape an exception has, but unmarked.
  const users = { firstPartyDomain: "mine.test", overrides: "-WebVTT" };
  Services.prefs.setStringPref(
    SITE_BRANCH + "kept.test",
    JSON.stringify({ protections: "fingerprinting" })
  );
  for (const name of GRANULAR_PREFS) {
    Services.prefs.setStringPref(
      name,
      JSON.stringify([
        foreign,
        own("stale.test"),
        own("kept.test"),
        {
          firstPartyDomain: "lifted.test",
          overrides: "-SpeechVoicesDefault",
          sval: true,
        },
        users,
      ])
    );
  }
  Services.perms.addFromPrincipal(
    principalOf("https://www.example.net"),
    "trackingprotection",
    Services.perms.ALLOW_ACTION
  );
  Services.perms.addFromPrincipal(
    principalOf("https://sub.example.org"),
    "autoplay-media",
    Services.perms.DENY_ACTION
  );
  Assert.ok(
    !Services.prefs.getBoolPref(MIGRATED_PREF, false),
    "a profile that has never migrated"
  );

  SvalSiteProtections.start();

  Assert.deepEqual(
    Object.fromEntries(SvalSiteProtections.rules()),
    {
      "kept.test": { protections: "fingerprinting" },
      "example.net": { protections: "off" },
      "example.org": { media: "block" },
    },
    "each permission lands in the store under its site"
  );
  Assert.equal(
    Services.perms.testExactPermissionFromPrincipal(
      principalOf("https://www.example.net"),
      "trackingprotection"
    ),
    Services.perms.ALLOW_ACTION,
    "the user's permission is kept"
  );
  Assert.ok(Services.prefs.getBoolPref(MIGRATED_PREF), "migrating is done");
  for (const name of GRANULAR_PREFS) {
    Assert.deepEqual(
      JSON.parse(Services.prefs.getStringPref(name)),
      [foreign, users],
      `${name}: Sval's entries are gone, a person's own kept`
    );
  }
  for (const name of OVERRIDE_PREFS) {
    Assert.deepEqual(
      JSON.parse(Services.prefs.getStringPref(name)),
      [own("kept.test")],
      `${name}: the choice the pref holds is applied`
    );
  }
});
