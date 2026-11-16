/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// The wait an extension update serves before a background check may install
// it, counted from when this device first saw that version.

const { AddonTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/AddonTestUtils.sys.mjs"
);
const { ExtensionTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/ExtensionXPCShellUtils.sys.mjs"
);
const { SYNC_RULES, SvalUpdateDelay, WAIT_PREF } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalUpdateDelay.sys.mjs"
);

AddonTestUtils.init(this);
AddonTestUtils.createAppInfo(
  "xpcshell@tests.mozilla.org",
  "XPCShell",
  "1",
  "42"
);
AddonTestUtils.overrideCertDB();
ExtensionTestUtils.init(this);

const DAY = 86400000;
const ext = { id: "a@test", type: "extension" };

add_task(function test_holds_then_installs() {
  Services.prefs.setIntPref(WAIT_PREF, 7);
  Assert.ok(!SvalUpdateDelay.mayInstall(ext, "2.0", 1000));
  Assert.ok(!SvalUpdateDelay.mayInstall(ext, "2.0", 1000 + 7 * DAY - 1));
  Assert.ok(SvalUpdateDelay.mayInstall(ext, "2.0", 1000 + 7 * DAY));
  SvalUpdateDelay.forget(ext.id);
  Services.prefs.clearUserPref(WAIT_PREF);
});

add_task(function test_default_is_seven_days() {
  Assert.equal(SvalUpdateDelay.waitDays(), 7);
});

add_task(function test_new_version_restarts_wait() {
  SvalUpdateDelay.mayInstall(ext, "2.0", 0);
  Assert.ok(!SvalUpdateDelay.mayInstall(ext, "2.1", 6 * DAY));
  Assert.ok(!SvalUpdateDelay.mayInstall(ext, "2.1", 7 * DAY));
  Assert.ok(SvalUpdateDelay.mayInstall(ext, "2.1", 13 * DAY));
  SvalUpdateDelay.forget(ext.id);
});

add_task(function test_zero_installs_at_once() {
  Services.prefs.setIntPref(WAIT_PREF, 0);
  Assert.ok(SvalUpdateDelay.mayInstall(ext, "3.0", 0));
  Assert.equal(SvalUpdateDelay.waiting(ext.id, 0), null);
  Services.prefs.clearUserPref(WAIT_PREF);
});

add_task(function test_other_types_not_held() {
  Assert.ok(
    SvalUpdateDelay.mayInstall({ id: "l@test", type: "locale" }, "2.0", 0)
  );
  Assert.ok(
    SvalUpdateDelay.mayInstall({ id: "d@test", type: "dictionary" }, "2.0", 0)
  );
});

add_task(function test_bad_wait_uses_default() {
  Services.prefs.setIntPref(WAIT_PREF, -3);
  Assert.equal(SvalUpdateDelay.waitDays(), 7);
  Services.prefs.clearUserPref(WAIT_PREF);
});

add_task(function test_waiting_reports_version_and_date() {
  SvalUpdateDelay.mayInstall(ext, "4.0", 0);
  Assert.deepEqual(SvalUpdateDelay.waiting(ext.id, DAY), {
    version: "4.0",
    installsOn: 7 * DAY,
  });
  Assert.equal(SvalUpdateDelay.waiting(ext.id, 7 * DAY), null);
  SvalUpdateDelay.forget(ext.id);
  Assert.equal(SvalUpdateDelay.waiting(ext.id, DAY), null);
});

add_task(function test_clock_backwards() {
  SvalUpdateDelay.mayInstall(ext, "5.0", 10 * DAY);
  Assert.ok(!SvalUpdateDelay.mayInstall(ext, "5.0", 2 * DAY));
  Assert.ok(SvalUpdateDelay.mayInstall(ext, "5.0", 9 * DAY));
  SvalUpdateDelay.forget(ext.id);
});

add_task(function test_sync_rule() {
  Assert.ok(SYNC_RULES[WAIT_PREF].accepts(0));
  Assert.ok(SYNC_RULES[WAIT_PREF].accepts(30));
  Assert.ok(!SYNC_RULES[WAIT_PREF].accepts(-1));
  Assert.ok(!SYNC_RULES[WAIT_PREF].accepts(1.5));
  Assert.ok(SYNC_RULES[WAIT_PREF].accepts(365));
  Assert.ok(!SYNC_RULES[WAIT_PREF].accepts(366), "a year at most");
});

add_task(function test_wait_past_a_year_uses_default() {
  Services.prefs.setIntPref(WAIT_PREF, 100000000);
  Assert.equal(SvalUpdateDelay.waitDays(), 7);
  Services.prefs.clearUserPref(WAIT_PREF);
});

add_task(async function test_forget_on_uninstall() {
  await AddonTestUtils.promiseStartupManager();
  SvalUpdateDelay.start();
  const extension = ExtensionTestUtils.loadExtension({
    manifest: { browser_specific_settings: { gecko: { id: "u@test" } } },
    useAddonManager: "permanent",
  });
  await extension.startup();
  SvalUpdateDelay.mayInstall({ id: "u@test", type: "extension" }, "2.0");
  Assert.ok(SvalUpdateDelay.waiting("u@test"));
  await extension.unload();
  Assert.equal(SvalUpdateDelay.waiting("u@test"), null);
  Assert.ok(
    !Services.prefs.prefHasUserValue(
      "browser.sval.extensions.updateSeen.u@test"
    )
  );
});
