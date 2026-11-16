/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { SvalICloudKeychain, STATUS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalICloudKeychain.sys.mjs"
);
const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);

const GROUP_PREF = "browser.sval.keychainAccessGroup";

/**
 * A build with no access group set, which is every build until signing sets
 * one, never calls iCloud Keychain: storing answers "missing entitlement" and
 * reading finds nothing, so Sval goes on with its other stores.
 */
add_task(function an_unsigned_build_never_reaches_icloud_keychain() {
  Services.prefs.clearUserPref(GROUP_PREF);
  Assert.ok(!SvalICloudKeychain.configured(), "no group, nothing to reach");
  Assert.equal(
    SvalICloudKeychain.store(new Uint8Array(32).fill(1)),
    STATUS.missingEntitlement,
    "storing is refused before any call"
  );
  Assert.equal(SvalICloudKeychain.read(), null, "and reading finds nothing");
});

/**
 * On a Mac the calls into Security.framework load and answer: a dev build may
 * look for an item of its own and is told there is none, or that it lacks
 * the entitlement. Either is an answer, never a throw, which is what proves
 * the declarations match the framework.
 */
add_task(function security_framework_answers_on_a_mac() {
  if (AppConstants.platform !== "macosx") {
    Assert.equal(SvalICloudKeychain._probe(), null, "off a Mac, no framework");
    return;
  }
  const status = SvalICloudKeychain._probe();
  Assert.ok(
    [STATUS.notFound, STATUS.missingEntitlement].includes(status),
    `Security.framework answered: ${status}`
  );
});

/**
 * A build that names a group it holds no entitlement for, which is a signed
 * build's setting on an unsigned one, is refused by the framework and stores
 * nothing, and still never throws.
 */
add_task(
  { skip_if: () => AppConstants.platform !== "macosx" },
  function a_group_without_its_entitlement_is_refused_quietly() {
    Services.prefs.setStringPref(GROUP_PREF, "ABCDE12345.app.sval.test");
    try {
      const status = SvalICloudKeychain.store(new Uint8Array(32).fill(2));
      Assert.notEqual(status, STATUS.success, `the store refused: ${status}`);
      Assert.equal(SvalICloudKeychain.read(), null, "and nothing is read");
    } finally {
      Services.prefs.clearUserPref(GROUP_PREF);
    }
  }
);
