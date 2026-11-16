/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { SvalPasswordManager: P, installFailureText } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalPasswordManager.sys.mjs"
  );

const { within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);

const CHOICE = "browser.sval.passwordManager";
const FAILED = "browser.sval.passwordManager.installFailed";

/** An in-memory stand-in for the preference service, with the calls Sval makes. */
class FakePrefs {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
  }
  getStringPref(name, fallback = "") {
    return this.values.has(name) ? this.values.get(name) : fallback;
  }
  setStringPref(name, value) {
    this.values.set(name, value);
  }
  getBoolPref(name, fallback = false) {
    return this.values.has(name) ? this.values.get(name) : fallback;
  }
  setBoolPref(name, value) {
    this.values.set(name, value);
  }
  clearUserPref(name) {
    this.values.delete(name);
  }
}

/**
 * A stand-in add-on manager that records the URLs it was asked to install.
 *
 * @param {object} [options]
 * @param {string[]} [options.installed] Ids already installed.
 * @param {boolean} [options.installFails] Whether every install rejects.
 */
function fakeAddons({ installed = [], installFails = false } = {}) {
  const have = new Set(installed);
  return {
    urls: [],
    async get(id) {
      return have.has(id) ? { enabled: true } : null;
    },
    async install(url, id) {
      this.urls.push(url);
      if (installFails) {
        throw new Error("the download failed");
      }
      const slug = url.split("/latest/")[1].split("/")[0];
      Assert.equal(
        id,
        P.MANAGERS.find(m => m.slug === slug).id,
        "the install is told the id its listing must deliver"
      );
      have.add(id);
    },
  };
}

const bitwarden = P.managerFor("bitwarden");

add_task(function every_manager_is_offered_alphabetically_and_none_is_last() {
  const keys = P.choices("linux");
  Assert.equal(keys.at(-1), P.NONE, "none is last");
  const names = keys.slice(0, -1).map(key => P.managerFor(key).name);
  Assert.deepEqual(
    names,
    [...names].sort((a, b) => a.localeCompare(b, "en")),
    "managers are alphabetical"
  );
});

add_task(function icloud_passwords_is_offered_where_apple_supports_it() {
  Assert.ok(P.choices("macosx").includes("icloud"), "macOS");
  Assert.ok(P.choices("win").includes("icloud"), "Windows");
  Assert.ok(!P.choices("linux").includes("icloud"), "not Linux");
});

add_task(function nothing_is_chosen_until_the_user_chooses() {
  Assert.equal(P.current(new FakePrefs()), P.NONE);
  Assert.equal(P.current(new FakePrefs({ [CHOICE]: "nonsense" })), P.NONE);
});

add_task(async function choosing_a_manager_installs_its_extension_from_amo() {
  const prefs = new FakePrefs();
  const addons = fakeAddons();
  Assert.deepEqual(await P.choose("bitwarden", { prefs, addons }), {
    installed: true,
    failed: false,
  });
  Assert.equal(P.current(prefs), "bitwarden");
  Assert.deepEqual(addons.urls, [
    "https://addons.mozilla.org/firefox/downloads/latest/bitwarden-password-manager/latest.xpi",
  ]);
});

add_task(async function a_manager_already_installed_is_left_alone() {
  const prefs = new FakePrefs();
  const addons = fakeAddons({ installed: [bitwarden.id] });
  Assert.deepEqual(await P.choose("bitwarden", { prefs, addons }), {
    installed: false,
    failed: false,
  });
  Assert.deepEqual(addons.urls, [], "nothing downloaded");
});

add_task(async function none_installs_nothing() {
  const prefs = new FakePrefs({ [CHOICE]: "bitwarden", [FAILED]: true });
  const addons = fakeAddons();
  Assert.deepEqual(await P.choose(P.NONE, { prefs, addons }), {
    installed: false,
    failed: false,
  });
  Assert.equal(P.current(prefs), P.NONE);
  Assert.ok(!prefs.values.has(FAILED), "no retry is left pending");
  Assert.deepEqual(addons.urls, []);
});

add_task(async function an_unknown_choice_changes_nothing() {
  const prefs = new FakePrefs({ [CHOICE]: "bitwarden" });
  const addons = fakeAddons();
  await P.choose("nonsense", { prefs, addons });
  Assert.equal(P.current(prefs), "bitwarden");
  Assert.deepEqual(addons.urls, []);
});

add_task(async function a_failed_install_keeps_the_choice_and_is_retried() {
  const prefs = new FakePrefs();
  Assert.deepEqual(
    await P.choose("bitwarden", {
      prefs,
      addons: fakeAddons({ installFails: true }),
    }),
    { installed: false, failed: true }
  );
  Assert.equal(P.current(prefs), "bitwarden", "the choice is kept");
  Assert.ok(prefs.getBoolPref(FAILED), "the failure is recorded");

  Assert.deepEqual(
    await P.reconcile({ prefs, addons: fakeAddons({ installFails: true }) }),
    { failed: true },
    "a retry that fails again says so"
  );
  const addons = fakeAddons();
  Assert.deepEqual(await P.reconcile({ prefs, addons }), { failed: false });
  Assert.equal(addons.urls.length, 1, "the retry installed it");
  Assert.ok(!prefs.values.has(FAILED), "nothing is left to retry");
});

add_task(async function a_launch_without_a_failure_installs_nothing() {
  const addons = fakeAddons();
  Assert.deepEqual(
    await P.reconcile({
      prefs: new FakePrefs({ [CHOICE]: "bitwarden" }),
      addons,
    }),
    { failed: false }
  );
  Assert.deepEqual(addons.urls, [], "a removed extension stays removed");
});

add_task(function failure_text_names_offline() {
  const offline = installFailureText("1Password", true);
  const online = installFailureText("1Password", false);
  Assert.stringContains(offline, "1Password", "the manager is named");
  Assert.stringContains(online, "1Password");
  Assert.notEqual(offline, online, "being offline is told as its own cause");
});

add_task(async function a_failed_install_retries_when_back_online() {
  const prefs = new FakePrefs();
  const calls = [];
  let succeeded;
  const secondCall = new Promise(resolve => (succeeded = resolve));
  const have = new Set();
  const addons = {
    async get(id) {
      return have.has(id) ? { enabled: true } : null;
    },
    async install(url, id) {
      calls.push(url);
      if (calls.length === 1) {
        throw new Error("offline");
      }
      have.add(id);
      succeeded();
    },
  };
  Assert.deepEqual(await P.choose("bitwarden", { prefs, addons }), {
    installed: false,
    failed: true,
  });
  Assert.ok(prefs.getBoolPref(FAILED), "the failure is recorded");

  Services.obs.notifyObservers(
    null,
    "network:offline-status-changed",
    "online"
  );
  await within(secondCall, 5000, "the install is tried again");
  await P.reconcile({ prefs, addons });
  Assert.equal(calls.length, 2, "one retry");
  Assert.ok(!prefs.values.has(FAILED), "the failure is cleared");

  Services.obs.notifyObservers(
    null,
    "network:offline-status-changed",
    "online"
  );
  await P.reconcile({ prefs, addons });
  Assert.equal(calls.length, 2, "a recovered install no longer listens");
});

add_task(async function going_offline_does_not_retry() {
  const prefs = new FakePrefs();
  const addons = fakeAddons({ installFails: true });
  await P.choose("bitwarden", { prefs, addons });
  Assert.equal(addons.urls.length, 1);
  Services.obs.notifyObservers(
    null,
    "network:offline-status-changed",
    "offline"
  );
  Services.obs.notifyObservers(null, "network:link-status-changed", "down");
  await P.reconcile({ prefs, addons });
  Assert.equal(
    addons.urls.length,
    2,
    "only the explicit retry installed: the notifications retried nothing"
  );
  await P.choose("none", { prefs, addons });
});

add_task(async function a_link_coming_up_retries_a_failed_install() {
  const prefs = new FakePrefs();
  let succeeded;
  const secondCall = new Promise(resolve => (succeeded = resolve));
  const have = new Set();
  let calls = 0;
  const addons = {
    async get(id) {
      return have.has(id) ? { enabled: true } : null;
    },
    async install(url, id) {
      if (++calls === 1) {
        throw new Error("offline");
      }
      have.add(id);
      succeeded();
    },
  };
  await P.choose("bitwarden", { prefs, addons });
  Services.obs.notifyObservers(null, "network:link-status-changed", "up");
  await within(secondCall, 5000, "the install is tried again");
  await P.reconcile({ prefs, addons });
  Assert.ok(!prefs.values.has(FAILED), "the failure is cleared");
});

add_task(async function a_recovered_choice_stops_listening() {
  const prefs = new FakePrefs();
  const addons = fakeAddons({ installFails: true });
  await P.choose("bitwarden", { prefs, addons });
  prefs.clearUserPref(FAILED);
  await P.reconcile({ prefs, addons });
  prefs.setBoolPref(FAILED, true);
  Services.obs.notifyObservers(null, "network:link-status-changed", "up");
  await P.reconcile({ prefs: new FakePrefs(), addons });
  Assert.equal(addons.urls.length, 1, "nothing listens once no failure stands");
  await P.choose("none", { prefs, addons });
});
