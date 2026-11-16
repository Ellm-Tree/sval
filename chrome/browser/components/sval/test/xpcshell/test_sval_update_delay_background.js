/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// A background update check holds an extension update for the set days
// (patches/extension-update-wait.patch); an update the user asks for is not
// held.

const { AddonTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/AddonTestUtils.sys.mjs"
);
const { AddonManager, AddonManagerPrivate } = ChromeUtils.importESModule(
  "resource://gre/modules/AddonManager.sys.mjs"
);
const { SvalUpdateDelay, WAIT_PREF } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalUpdateDelay.sys.mjs"
);
const { within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);

AddonTestUtils.init(this);
AddonTestUtils.createAppInfo(
  "xpcshell@tests.mozilla.org",
  "XPCShell",
  "42",
  "42"
);
AddonTestUtils.overrideCertDB();

// The test server is plain http; Firefox refuses an insecure update manifest
// unless told otherwise.
Services.prefs.setBoolPref("extensions.checkUpdateSecurity", false);

const ID = "held@tests.sval.app";
const DAY = 86400000;
const server = AddonTestUtils.createHttpServer({ hosts: ["example.com"] });

function manifest(version) {
  return {
    manifest: {
      version,
      browser_specific_settings: {
        gecko: { id: ID, update_url: "http://example.com/update.json" },
      },
    },
  };
}

server.registerFile(
  "/v2.xpi",
  AddonTestUtils.createTempWebExtensionFile(manifest("2.0"))
);
AddonTestUtils.registerJSON(server, "/update.json", {
  addons: {
    [ID]: {
      updates: [{ version: "2.0", update_link: "http://example.com/v2.xpi" }],
    },
  },
});

/** Installs version 1.0 and clears any record of an earlier task. */
async function installOld() {
  SvalUpdateDelay.forget(ID);
  await AddonTestUtils.promiseInstallFile(
    AddonTestUtils.createTempWebExtensionFile(manifest("1.0"))
  );
  SvalUpdateDelay.forget(ID);
}

/** @returns {Promise<string>} The installed version once an install ends. */
function nextInstallEnds() {
  return new Promise(resolve => {
    const listener = {
      onInstallEnded(install, addon) {
        AddonManager.removeInstallListener(listener);
        resolve(addon.version);
      },
    };
    AddonManager.addInstallListener(listener);
  });
}

async function installedVersion() {
  return (await AddonManager.getAddonByID(ID)).version;
}

add_setup(async function () {
  await AddonTestUtils.promiseStartupManager();
  SvalUpdateDelay.start();
});

add_task(async function test_held_by_default() {
  await installOld();
  let started = false;
  const listener = { onInstallStarted: () => (started = true) };
  AddonManager.addInstallListener(listener);
  await AddonManagerPrivate.backgroundUpdateCheck();
  AddonManager.removeInstallListener(listener);
  Assert.ok(!started, "no install started");
  Assert.equal(await installedVersion(), "1.0");
  Assert.equal(SvalUpdateDelay.waiting(ID)?.version, "2.0");
  await (await AddonManager.getAddonByID(ID)).uninstall();
});

add_task(async function test_installs_after_wait() {
  await installOld();
  Services.prefs.setStringPref(
    `browser.sval.extensions.updateSeen.${ID}`,
    JSON.stringify({ version: "2.0", seen: Date.now() - 8 * DAY })
  );
  const ended = nextInstallEnds();
  await AddonManagerPrivate.backgroundUpdateCheck();
  Assert.equal(await within(ended, 10000, "update install"), "2.0");
  Assert.equal(SvalUpdateDelay.waiting(ID), null);
  await (await AddonManager.getAddonByID(ID)).uninstall();
});

add_task(async function test_lowered_wait_installs_held() {
  await installOld();
  await AddonManagerPrivate.backgroundUpdateCheck();
  Assert.equal(await installedVersion(), "1.0");
  Services.prefs.setIntPref(WAIT_PREF, 0);
  const ended = nextInstallEnds();
  await AddonManagerPrivate.backgroundUpdateCheck();
  Assert.equal(await within(ended, 10000, "update install"), "2.0");
  Services.prefs.clearUserPref(WAIT_PREF);
  await (await AddonManager.getAddonByID(ID)).uninstall();
});

add_task(async function test_user_check_not_held() {
  await installOld();
  const addon = await AddonManager.getAddonByID(ID);
  const update = await AddonTestUtils.promiseFindAddonUpdates(
    addon,
    AddonManager.UPDATE_WHEN_USER_REQUESTED
  );
  const ended = nextInstallEnds();
  update.updateAvailable.install();
  Assert.equal(await within(ended, 10000, "update install"), "2.0");
  await (await AddonManager.getAddonByID(ID)).uninstall();
});

/**
 * Installs version 1.0 of an extension with a record that holds version 2.0.
 *
 * @param {string} id
 * @param {string} path Its update manifest's path on the test server.
 * @returns {Promise<object>} The add-on manager's wrapper.
 */
async function installHeld(id, path) {
  const addon = (
    await AddonTestUtils.promiseInstallFile(
      AddonTestUtils.createTempWebExtensionFile({
        manifest: {
          version: "1.0",
          browser_specific_settings: {
            gecko: { id, update_url: `http://example.com${path}` },
          },
        },
      })
    )
  ).addon;
  Services.prefs.setStringPref(
    `browser.sval.extensions.updateSeen.${id}`,
    JSON.stringify({ version: "2.0", seen: Date.now() })
  );
  return AddonManager.getAddonByID(addon.id);
}

add_task(async function test_update_now_prompts_for_new_permissions() {
  const id = "perms@tests.sval.app";
  server.registerFile(
    "/perms-v2.xpi",
    AddonTestUtils.createTempWebExtensionFile({
      manifest: {
        version: "2.0",
        permissions: ["tabs"],
        browser_specific_settings: {
          gecko: { id, update_url: "http://example.com/perms.json" },
        },
      },
    })
  );
  AddonTestUtils.registerJSON(server, "/perms.json", {
    addons: {
      [id]: {
        updates: [
          { version: "2.0", update_link: "http://example.com/perms-v2.xpi" },
        ],
      },
    },
  });
  const addon = await installHeld(id, "/perms.json");
  let prompted = false;
  const observe = subject => {
    prompted = true;
    subject.wrappedJSObject.resolve();
  };
  Services.obs.addObserver(observe, "webextension-update-permission-prompt");
  const outcome = await within(
    SvalUpdateDelay.updateNow(addon),
    10000,
    "Update now"
  );
  Services.obs.removeObserver(observe, "webextension-update-permission-prompt");
  Assert.equal(outcome, "installed");
  Assert.ok(prompted, "the new permission was asked for");
  Assert.equal((await AddonManager.getAddonByID(id)).version, "2.0");
  Assert.equal(SvalUpdateDelay.waiting(id), null, "nothing waits");
  await (await AddonManager.getAddonByID(id)).uninstall();
});

add_task(async function test_update_now_none_offered_forgets() {
  const id = "none@tests.sval.app";
  AddonTestUtils.registerJSON(server, "/none.json", {
    addons: { [id]: { updates: [] } },
  });
  const addon = await installHeld(id, "/none.json");
  Assert.equal(await SvalUpdateDelay.updateNow(addon), "none");
  Assert.equal(SvalUpdateDelay.waiting(id), null, "the stale wait goes");
  await addon.uninstall();
});

add_task(async function test_update_now_failed_check_keeps_wait() {
  const id = "failed@tests.sval.app";
  const addon = await installHeld(id, "/missing.json");
  Assert.equal(await SvalUpdateDelay.updateNow(addon), "failed");
  Assert.equal(
    SvalUpdateDelay.waiting(id)?.version,
    "2.0",
    "a failed check keeps the wait"
  );
  await addon.uninstall();
  SvalUpdateDelay.forget(id);
});
