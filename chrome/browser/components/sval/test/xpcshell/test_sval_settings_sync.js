/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { makeTempDir, tempPath } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { SvalLocalSettings } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLocalSettings.sys.mjs"
);
const { SvalSettingsSync } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSettingsSync.sys.mjs"
);
const { SvalSettingsRegistry } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSettingsRegistry.sys.mjs"
);
const { SITE_BRANCH } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
);
const {
  SITE_BRANCH: EXTENSION_SITE_BRANCH,
  DEFAULT_BRANCH: EXTENSION_DEFAULT_BRANCH,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalExtensionSites.sys.mjs"
);
const {
  AVAILABLE_BRANCH: EXTENSION_WORKSPACES_BRANCH,
  PIN_BRANCH: EXTENSION_PIN_BRANCH,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalExtensionWorkspaces.sys.mjs"
);
const { SITE_BRANCH: JAVASCRIPT_BRANCH } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalJavascript.sys.mjs"
);
const { SITE_BRANCH: KEEP_LINKS_BRANCH } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalKeepLinks.sys.mjs"
);
const {
  ALLOWED_DOMAIN_BRANCH,
  CUSTOM_LIST_BRANCH,
  MY_FILTER_BRANCH,
  USER_LIST_BRANCH,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
);

const { waitForCondition, within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);

const TREE = "workspace-under-test";
const SETTINGS = "settings";
const KEYS = [
  "test.bool",
  "test.int",
  "test.string",
  "test.locked",
  "test.nodefault",
];

/**
 * Waits for what a pass or a change set in motion. A pass hands its report
 * to the mirror's queue without waiting for it, and a change to a pref or the
 * search engine is queued there as it is heard, so the queue going idle is
 * all of it done. The search service notifies a tick after it changes, and
 * an apply can hear a change it then queues, so the queue is waited on twice.
 *
 * @param {object} device The device: its `sync`, any other instance a task
 *   made over its engine (`also`), and the process's instance.
 */
async function settle(device) {
  for (let i = 0; i < 2; i++) {
    await new Promise(resolve => executeSoon(resolve));
    for (const sync of [
      device.sync,
      ...device.also,
      SvalSettingsSync.shared?.sync,
    ]) {
      await within(sync?.whenIdle(), 10_000, "sync going idle");
    }
  }
}

/** The defaults every device's prefs start with. */
const DEFAULTS = {
  "test.bool": false,
  "test.int": 1,
  "test.string": "a",
  "test.locked": false,
};

/**
 * Sets `name` to `value` on `branch`, by the value's type.
 *
 * @param {nsIPrefBranch} branch
 * @param {string} name
 * @param {boolean|number|string} value
 */
function setPref(branch, name, value) {
  if (typeof value === "boolean") {
    branch.setBoolPref(name, value);
  } else if (typeof value === "number") {
    branch.setIntPref(name, value);
  } else {
    branch.setStringPref(name, value);
  }
}

let devices = 0;

/**
 * One device's preferences: a branch of Gecko's own pref service, under a
 * root of its own, with `defaults` set as its default values. Each device in
 * one process needs prefs of its own, and a branch answers every name below
 * its root as the pref service answers the full name, observers and locks
 * included (`nsPrefBranch`).
 *
 * @param {object} [defaults] Default values beside {@link DEFAULTS}.
 * @returns {nsIPrefBranch}
 */
function devicePrefs(defaults = {}) {
  const root = `sval.test.device${++devices}.`;
  const defaultBranch = Services.prefs.getDefaultBranch(root);
  for (const [name, value] of Object.entries({ ...DEFAULTS, ...defaults })) {
    setPref(defaultBranch, name, value);
  }
  registerCleanupFunction(() => {
    for (const name of Services.prefs.getChildList(root)) {
      if (Services.prefs.prefIsLocked(name)) {
        Services.prefs.unlockPref(name);
      }
    }
    Services.prefs.deleteBranch(root);
  });
  return Services.prefs.getBranch(root);
}

/** One device's search service: a default engine and a change listener. */
class FakeSearch {
  constructor() {
    this.id = "ddg";
    this.known = new Set(["ddg", "kagi", "bing"]);
    this.listener = null;
    // When set, `setById` waits on it before it takes effect.
    this.hold = null;
    this.setting = false;
  }
  async currentId() {
    return this.id;
  }
  async setById(id) {
    if (!this.known.has(id)) {
      return false;
    }
    if (this.hold) {
      this.setting = true;
      await this.hold;
      this.setting = false;
    }
    this.id = id;
    this.listener?.(id);
    return true;
  }
  observe(fn) {
    this.listener = fn;
    return () => (this.listener = null);
  }
  userChooses(id) {
    this.id = id;
    this.listener?.(id);
  }
}

/** Two devices on one folder, each with its own prefs and search. */
async function twoDevices() {
  const root = await makeTempDir("sval-settings-sync");
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  let tick = 10_000;
  const now = () => (tick += 1000);
  const made = [];
  registerCleanupFunction(() =>
    made.forEach(d => {
      d.sync.stop();
      d.engine.terminate();
    })
  );
  // Every device's profile is the folder they share, so a profile pass is
  // the pass that merges what they share.
  const make = async ({ defaults, keys = KEYS } = {}) => {
    const engine = new SvalEngine({
      root,
      sharedRoot: root,
      keyBytes,
      deviceId: crypto.getRandomValues(new Uint8Array(16)),
    });
    const prefs = devicePrefs(defaults);
    const search = new FakeSearch();
    const seeded = new Set();
    const settingsSync = synced =>
      new SvalSettingsSync({
        engine,
        prefs,
        search,
        isSeeded: key => seeded.has(key),
        markSeeded: async names => names.forEach(key => seeded.add(key)),
        requestPass: () => {},
        keys: synced,
        now,
      });
    const device = {
      engine,
      prefs,
      search,
      seeded,
      sync: settingsSync(keys),
      also: [],
      /**
       * This device's next launch, on a build that syncs `newKeys`.
       *
       * @param {string[]} newKeys
       */
      async upgrade(newKeys) {
        device.sync.stop();
        device.sync = settingsSync(newKeys);
        await device.sync.start();
      },
      settle: () => settle(device),
      /** The local changes this device's engine has been handed. */
      get changes() {
        return engine.changeCount;
      },
      pass: async () => {
        const report = await engine.sync(TREE, now());
        await settle(device);
        return report;
      },
    };
    made.push(device);
    return device;
  };
  return { make };
}

add_task(async function a_fresh_device_writes_nothing() {
  const { make } = await twoDevices();
  const a = await make();
  await a.sync.start();
  await a.pass();
  Assert.deepEqual(await a.engine.settings(SETTINGS), {});
});

add_task(async function a_user_change_reaches_the_other_device() {
  const { make } = await twoDevices();
  const a = await make();
  const b = await make();
  await a.sync.start();
  await b.sync.start();

  a.prefs.setBoolPref("test.bool", true);
  a.prefs.setStringPref("test.string", "b");
  a.search.userChooses("kagi");
  await a.settle();
  await a.pass();
  await b.pass();

  Assert.strictEqual(b.prefs.getBoolPref("test.bool"), true);
  Assert.strictEqual(b.prefs.getStringPref("test.string"), "b");
  Assert.equal(b.search.id, "kagi");
});

add_task(async function an_applied_value_is_not_written_back() {
  const { make } = await twoDevices();
  const a = await make();
  const b = await make();
  await a.sync.start();
  await b.sync.start();
  a.prefs.setIntPref("test.int", 5);
  a.search.userChooses("kagi");
  await a.settle();
  await a.pass();

  // Every write b makes is a change handed to its engine; an echo would be one.
  const changes = b.changes;
  await b.pass();
  await b.pass();

  Assert.strictEqual(b.prefs.getIntPref("test.int"), 5, "b applied the value");
  Assert.equal(b.search.id, "kagi", "b applied the engine");
  Assert.equal(b.changes, changes, "and wrote neither back");
});

add_task(async function a_reset_syncs_as_a_change() {
  const { make } = await twoDevices();
  const a = await make();
  const b = await make();
  await a.sync.start();
  await b.sync.start();
  a.prefs.setIntPref("test.int", 5);
  await a.pass();
  await b.pass();
  a.prefs.clearUserPref("test.int");
  await a.pass();
  await b.pass();
  Assert.ok(!b.prefs.prefHasUserValue("test.int"), "b reset it too");
});

/**
 * A locked pref reads its default (`Pref::GetValue` in Gecko's
 * `Preferences.cpp`), and a value set on it lands on its user value without
 * a notification, so the user value, read once the lock is gone, tells
 * whether a sync touched it.
 */
add_task(async function locked_prefs_are_skipped_both_ways() {
  const { make } = await twoDevices();
  const a = await make();
  const b = await make();
  // The user set both before Sval synced them, and an administrator then
  // locked one.
  const locked = `${a.prefs.root}test.int`;
  a.prefs.setIntPref("test.int", 4);
  a.prefs.setStringPref("test.string", "kept");
  Services.prefs.lockPref(locked);
  await a.sync.start();
  await b.sync.start();
  await a.pass();
  await within(
    waitForCondition(
      () => a.seeded.has("test.string"),
      "a has seeded what it held"
    ),
    10_000,
    "a has seeded what it held"
  );
  await a.pass();
  let synced = await a.engine.settings(SETTINGS);
  Assert.equal(synced["test.string"], "kept", "the unlocked pref was seeded");
  Assert.ok(!("test.int" in synced), "a locked pref is never written");

  b.prefs.setIntPref("test.int", 9);
  await b.settle();
  await b.pass();
  await a.pass();
  synced = await a.engine.settings(SETTINGS);
  Assert.equal(synced["test.int"], 9, "b's value reached a");
  Services.prefs.unlockPref(locked);
  Assert.equal(
    a.prefs.getIntPref("test.int"),
    4,
    "and was never applied under a's lock"
  );
});

add_task(
  async function a_value_of_the_wrong_type_is_skipped_and_the_rest_apply() {
    const { make } = await twoDevices();
    const a = await make();
    const b = await make();
    await a.sync.start();
    await b.sync.start();
    await a.engine.mutate({
      kind: "setSetting",
      document: SETTINGS,
      key: "test.bool",
      valueJson: JSON.stringify("not a bool"),
      now: 50_000,
    });
    a.prefs.setStringPref("test.string", "c");
    await a.pass();
    await b.pass();
    Assert.strictEqual(b.prefs.getBoolPref("test.bool"), false, "skipped");
    Assert.strictEqual(
      b.prefs.getStringPref("test.string"),
      "c",
      "the rest applied"
    );
  }
);

add_task(async function a_change_made_while_applying_is_still_written() {
  // Only the value being applied is ignored.
  const { make } = await twoDevices();
  const a = await make();
  const b = await make();
  await a.sync.start();
  await b.sync.start();
  a.prefs.setIntPref("test.int", 5);
  await a.pass();
  // b's user changes test.int to 7 as the apply sets it, in an observer
  // Gecko calls during the apply's own set.
  const observer = {
    observe(_subject, _topic, name) {
      if (b.prefs.getIntPref(name) === 5) {
        b.prefs.setIntPref(name, 7);
      }
    },
  };
  b.prefs.addObserver("test.int", observer);
  try {
    await b.pass();
    await b.pass();
  } finally {
    b.prefs.removeObserver("test.int", observer);
  }
  await a.pass();
  Assert.strictEqual(a.prefs.getIntPref("test.int"), 7);
});

add_task(async function a_child_of_a_synced_pref_writes_nothing() {
  // Gecko's pref observers match by prefix (`nsPrefBranch::AddObserverImpl`
  // registers `Preferences::PrefixMatch`), so the observer for a synced key
  // also hears every pref whose name begins with it. The real pref service,
  // so the test is about Gecko's matching and not a fake's.
  const { make } = await twoDevices();
  const a = await make();
  const key = "sval.test.synced";
  const child = `${key}.child`;
  const sync = new SvalSettingsSync({
    engine: a.engine,
    prefs: Services.prefs,
    search: a.search,
    isSeeded: () => true,
    markSeeded: async () => {},
    requestPass: () => {},
    keys: [key],
    now: () => 50_000,
  });
  a.also.push(sync);
  await sync.start();
  const changes = a.changes;
  try {
    Services.prefs.setIntPref(child, 3);
    Services.prefs.setBoolPref(key, true);
    await a.settle();
    Assert.equal(a.changes, changes + 1, "only the synced pref was written");
    Assert.deepEqual(
      await a.engine.settings(SETTINGS),
      { [key]: true },
      "and the document holds nothing else"
    );
  } finally {
    sync.stop();
    Services.prefs.clearUserPref(child);
    Services.prefs.clearUserPref(key);
  }
});

add_task(
  async function a_value_set_before_its_pref_synced_reaches_the_other_device() {
    // A later build adds test.int and test.string to the synced list. Before
    // it, a's user set both, where only a saw them.
    const { make } = await twoDevices();
    const older = ["test.bool"];
    const newer = ["test.bool", "test.int", "test.string"];
    const a = await make({ keys: older });
    const b = await make({ keys: older });
    await a.sync.start();
    await b.sync.start();
    a.prefs.setStringPref("test.string", "from-a");
    a.prefs.setIntPref("test.int", 3);
    a.prefs.setBoolPref("test.bool", true);
    await a.settle();
    await a.pass();
    await b.pass();
    Assert.strictEqual(b.prefs.getBoolPref("test.bool"), true, "b has read a");

    // b takes the update first, and its user chooses test.int there.
    await b.upgrade(newer);
    await b.pass();
    b.prefs.setIntPref("test.int", 7);
    await b.settle();
    await b.pass();

    await a.upgrade(newer);
    await a.pass();
    await within(
      waitForCondition(
        () => newer.every(key => a.seeded.has(key)),
        "a has seeded what the update added"
      ),
      10_000,
      "a has seeded what the update added"
    );
    await a.pass();
    await b.pass();
    Assert.strictEqual(
      b.prefs.getStringPref("test.string"),
      "from-a",
      "the value a's user set earlier reaches b"
    );
    Assert.strictEqual(
      a.prefs.getIntPref("test.int"),
      7,
      "and the choice made on b replaces a's earlier value"
    );
    Assert.strictEqual(b.prefs.getIntPref("test.int"), 7, "which b keeps");
  }
);

add_task(async function a_pref_with_no_default_takes_its_type_from_the_value() {
  const { make } = await twoDevices();
  const a = await make();
  const b = await make();
  await a.sync.start();
  await b.sync.start();
  Assert.equal(
    b.prefs.getPrefType("test.nodefault"),
    Ci.nsIPrefBranch.PREF_INVALID,
    "b has neither a default nor a user value"
  );
  a.prefs.setStringPref("test.nodefault", "x");
  await a.pass();
  await b.pass();
  Assert.strictEqual(b.prefs.getStringPref("test.nodefault"), "x");
});

add_task(async function an_applied_value_equal_to_the_default_is_not_a_reset() {
  const { make } = await twoDevices();
  const a = await make();
  // b's default is what a's user chose, so applying it clears b's user value
  // and Gecko notifies.
  const b = await make({ defaults: { "test.bool": true } });
  await a.sync.start();
  await b.sync.start();
  b.prefs.setBoolPref("test.bool", false);
  await b.settle();
  await b.pass();
  await a.pass();

  a.prefs.setBoolPref("test.bool", true);
  await a.pass();

  const changes = b.changes;
  await b.pass();
  await b.pass();
  await a.pass();
  await b.pass();

  Assert.ok(!b.prefs.prefHasUserValue("test.bool"), "b took its default");
  Assert.equal(b.changes, changes, "b wrote nothing back");
  Assert.strictEqual(
    a.prefs.getBoolPref("test.bool"),
    true,
    "a kept its choice"
  );
  Assert.ok(a.prefs.prefHasUserValue("test.bool"));
});

add_task(async function a_synced_value_equal_to_the_default_changes_nothing() {
  const { make } = await twoDevices();
  const a = await make();
  const b = await make({ defaults: { "test.bool": true } });
  await a.sync.start();
  await b.sync.start();
  a.prefs.setBoolPref("test.bool", true);
  await a.pass();

  const changes = b.changes;
  await b.pass();
  await a.pass();
  Assert.equal(b.changes, changes, "b wrote nothing");
  Assert.strictEqual(a.prefs.getBoolPref("test.bool"), true);
});

add_task(async function a_stale_search_apply_does_not_overwrite_a_choice() {
  const { make } = await twoDevices();
  const a = await make();
  const b = await make();
  await a.sync.start();
  await b.sync.start();

  b.search.userChooses("kagi");
  await b.settle();
  await b.pass();

  // a begins applying kagi, and its user picks bing before that lands.
  let release;
  a.search.hold = new Promise(resolve => (release = resolve));
  // The pass settles only once its apply does, which waits on the hold.
  const passing = a.pass();
  await within(
    waitForCondition(() => a.search.setting, "a is applying"),
    10_000,
    "a is applying"
  );
  a.search.userChooses("bing");
  release();
  a.search.hold = null;
  await passing;
  await a.settle();

  await a.pass();
  await b.pass();
  await a.pass();
  Assert.equal(b.search.id, "bing", "b follows the choice");
  Assert.equal(a.search.id, "bing", "a kept the choice");
  Assert.equal(
    (await a.engine.settings(SETTINGS))["sval.search.engine"],
    "bing"
  );
});

/**
 * A device-local settings store of its own, as `startFor` reads the seeded
 * keys from.
 *
 * @returns {Promise<object>}
 */
function localSettings() {
  return SvalLocalSettings.open(tempPath("sval-settings-sync", ".json"));
}

registerCleanupFunction(async () => {
  await SvalSettingsSync.stopShared();
  await SvalLocalSettings.forgetCachedValues();
});

add_task(async function one_instance_serves_every_window() {
  const { make } = await twoDevices();
  const a = await make();
  const asked = [];
  const options = {
    settings: await localSettings(),
    prefs: a.prefs,
    search: a.search,
    keys: KEYS,
    requestPass: () => asked.push(1),
  };

  const [first, second] = await Promise.all([
    SvalSettingsSync.startFor(a.engine, options),
    SvalSettingsSync.startFor(a.engine, options),
  ]);
  Assert.strictEqual(first, second, "concurrent callers share one instance");
  Assert.strictEqual(
    await SvalSettingsSync.startFor(a.engine, options),
    first,
    "and a later caller does too"
  );

  const changes = a.changes;
  a.prefs.setBoolPref("test.bool", true);
  await a.settle();
  Assert.equal(a.changes, changes + 1, "one write for one change");
  Assert.equal(asked.length, 1, "and one pass is asked for");

  const b = await make();
  await b.sync.start();
  b.prefs.setIntPref("test.int", 9);
  await b.settle();
  await b.pass();
  await a.pass();
  Assert.strictEqual(
    a.prefs.getIntPref("test.int"),
    9,
    "incoming values are applied"
  );
  await SvalSettingsSync.stopShared();
});

add_task(async function a_new_engine_replaces_the_instance() {
  const { make } = await twoDevices();
  const a = await make();
  const b = await make();

  const first = await SvalSettingsSync.startFor(a.engine, {
    settings: await localSettings(),
    prefs: a.prefs,
    search: a.search,
    keys: KEYS,
    requestPass: () => {},
  });
  const second = await SvalSettingsSync.startFor(b.engine, {
    settings: await localSettings(),
    prefs: b.prefs,
    search: b.search,
    keys: KEYS,
    requestPass: () => {},
  });
  Assert.notStrictEqual(first, second, "another engine gets its own instance");

  const aChanges = a.changes;
  const bChanges = b.changes;
  a.prefs.setBoolPref("test.bool", true);
  b.prefs.setBoolPref("test.bool", true);
  await a.settle();
  await b.settle();
  Assert.equal(a.changes, aChanges, "the old instance is stopped");
  Assert.equal(b.changes, bChanges + 1, "the new one is running");
  await SvalSettingsSync.stopShared();
});

add_task(async function a_search_service_that_fails_does_not_fail_start() {
  const { make } = await twoDevices();
  const a = await make();
  a.prefs.setBoolPref("test.bool", true);
  const attempts = [];
  const broken = {
    currentId: () => Promise.reject(new Error("search init failed")),
    setById: id => {
      attempts.push(id);
      return Promise.reject(new Error("search init failed"));
    },
    observe: () => () => {},
  };
  const sync = new SvalSettingsSync({
    engine: a.engine,
    prefs: a.prefs,
    search: broken,
    isSeeded: () => false,
    markSeeded: async () => {},
    requestPass: () => {},
    keys: KEYS,
  });
  a.also.push(sync);
  await sync.start();
  await a.pass();
  await within(
    waitForCondition(
      async () => (await a.engine.settings(SETTINGS))["test.bool"] === true,
      "the prefs were still seeded"
    ),
    10_000,
    "the prefs were still seeded"
  );

  await a.engine.mutate({
    kind: "setSetting",
    document: SETTINGS,
    key: "sval.search.engine",
    valueJson: JSON.stringify("kagi"),
    now: 90_000,
  });
  await a.pass();
  Assert.deepEqual(attempts, [], "and no engine is applied");
  sync.stop();
});

/** Secure DNS's prefs, with Gecko's defaults, under their real rules. */
const DNS_KEYS = [
  "network.trr.mode",
  "network.trr.uri",
  "network.trr.excluded-domains",
];
const DNS_DEFAULTS = {
  "network.trr.mode": 0,
  "network.trr.uri": "",
  "network.trr.excluded-domains": "",
};

async function twoDnsDevices() {
  const { make } = await twoDevices();
  const options = { defaults: DNS_DEFAULTS, keys: DNS_KEYS };
  const a = await make(options);
  const b = await make(options);
  await a.sync.start();
  await b.sync.start();
  return { a, b };
}

add_task(async function a_malformed_synced_dns_value_is_refused() {
  const { a, b } = await twoDnsDevices();
  b.prefs.setIntPref("network.trr.mode", 2);
  b.prefs.setStringPref(
    "network.trr.uri",
    "https://cloudflare-dns.com/dns-query"
  );
  b.prefs.setStringPref("network.trr.excluded-domains", "nas.example");
  await b.settle();
  await b.pass();
  for (const [key, value] of [
    ["network.trr.mode", 7],
    ["network.trr.uri", "http://resolver.example/dns-query"],
    ["network.trr.excluded-domains", "ok.example, not/a/host"],
  ]) {
    await a.engine.mutate({
      kind: "setSetting",
      document: SETTINGS,
      key,
      valueJson: JSON.stringify(value),
      now: 90_000,
    });
  }
  await a.pass();
  await b.pass();
  Assert.strictEqual(b.prefs.getIntPref("network.trr.mode"), 2, "mode kept");
  Assert.strictEqual(
    b.prefs.getStringPref("network.trr.uri"),
    "https://cloudflare-dns.com/dns-query",
    "resolver kept"
  );
  Assert.strictEqual(
    b.prefs.getStringPref("network.trr.excluded-domains"),
    "nas.example",
    "names kept"
  );
});

add_task(async function valid_dns_values_sync() {
  const { a, b } = await twoDnsDevices();
  a.prefs.setIntPref("network.trr.mode", 3);
  a.prefs.setStringPref(
    "network.trr.uri",
    "https://resolver.example/dns-query"
  );
  a.prefs.setStringPref(
    "network.trr.excluded-domains",
    "nas.example,printer.lan"
  );
  await a.settle();
  await a.pass();
  await b.pass();
  Assert.strictEqual(b.prefs.getIntPref("network.trr.mode"), 3);
  Assert.strictEqual(
    b.prefs.getStringPref("network.trr.uri"),
    "https://resolver.example/dns-query",
    "a public custom resolver syncs"
  );
  Assert.strictEqual(
    b.prefs.getStringPref("network.trr.excluded-domains"),
    "nas.example,printer.lan"
  );
});

add_task(async function a_resolver_on_the_local_network_stays_on_its_device() {
  const { a, b } = await twoDnsDevices();
  a.prefs.setStringPref(
    "network.trr.uri",
    "https://cloudflare-dns.com/dns-query"
  );
  await a.settle();
  await a.pass();
  await b.pass();
  Assert.strictEqual(
    b.prefs.getStringPref("network.trr.uri"),
    "https://cloudflare-dns.com/dns-query"
  );

  a.prefs.setIntPref("network.trr.mode", 2);
  a.prefs.setStringPref("network.trr.uri", "https://192.168.1.2/dns-query");
  await a.settle();
  await a.pass();
  await b.pass();
  Assert.strictEqual(b.prefs.getIntPref("network.trr.mode"), 2, "mode syncs");
  Assert.ok(
    !b.prefs.prefHasUserValue("network.trr.uri"),
    "the other device falls back to its default resolver"
  );
  Assert.strictEqual(
    a.prefs.getStringPref("network.trr.uri"),
    "https://192.168.1.2/dns-query",
    "the device keeps its own resolver"
  );
  await a.pass();
  Assert.strictEqual(
    a.prefs.getStringPref("network.trr.uri"),
    "https://192.168.1.2/dns-query",
    "and a later pass leaves it"
  );

  b.prefs.setStringPref("network.trr.uri", "https://nas.home.arpa/dns-query");
  await b.settle();
  await b.pass();
  await a.pass();
  Assert.strictEqual(
    a.prefs.getStringPref("network.trr.uri"),
    "https://192.168.1.2/dns-query",
    "another device's local resolver never arrives"
  );
});

add_task(async function a_synced_custom_from_holds_a_curated_level_only() {
  const { make } = await twoDevices();
  const key = "browser.sval.adblock.customFrom";
  const options = { defaults: { [key]: "" }, keys: [key] };
  const a = await make(options);
  const b = await make(options);
  await a.sync.start();
  await b.sync.start();
  a.prefs.setStringPref(key, "strict");
  await a.settle();
  await a.pass();
  await b.pass();
  Assert.strictEqual(b.prefs.getStringPref(key), "strict", "a level syncs");

  for (const [i, value] of ["custom", "Strict", "everything"].entries()) {
    await a.engine.mutate({
      kind: "setSetting",
      document: SETTINGS,
      key,
      valueJson: JSON.stringify(value),
      now: 90_000 + i * 1000,
    });
    await a.pass();
    await b.pass();
    Assert.strictEqual(
      b.prefs.getStringPref(key),
      "strict",
      `${value} is refused`
    );
  }
});

add_task(async function protections_tracking_settings_sync_valid_values() {
  const { make } = await twoDevices();
  const cookies = "network.cookie.cookieBehavior";
  const fpp = "privacy.fingerprintingProtection";
  const options = {
    defaults: { [cookies]: 5, [fpp]: true },
    keys: [cookies, fpp],
  };
  const a = await make(options);
  const b = await make(options);
  await a.sync.start();
  await b.sync.start();
  a.prefs.setIntPref(cookies, Ci.nsICookieService.BEHAVIOR_REJECT_FOREIGN);
  a.prefs.setBoolPref(fpp, false);
  await a.settle();
  await a.pass();
  await b.pass();
  Assert.strictEqual(
    b.prefs.getIntPref(cookies),
    Ci.nsICookieService.BEHAVIOR_REJECT_FOREIGN,
    "a cookie behaviour syncs"
  );
  Assert.strictEqual(
    b.prefs.getBoolPref(fpp),
    false,
    "and so does where fingerprinting protection applies"
  );

  const bounce = "privacy.bounceTrackingProtection.mode";
  const c = await make({
    defaults: { [bounce]: Ci.nsIBounceTrackingProtection.MODE_ENABLED },
    keys: [bounce],
  });
  await c.sync.start();
  for (const [now, mode] of [
    [79_000, Ci.nsIBounceTrackingProtection.MODE_ENABLED_DRY_RUN],
    [80_000, Ci.nsIBounceTrackingProtection.MODE_DISABLED],
  ]) {
    await a.engine.mutate({
      kind: "setSetting",
      document: SETTINGS,
      key: bounce,
      valueJson: JSON.stringify(mode),
      now,
    });
    await a.pass();
    await c.pass();
  }
  Assert.strictEqual(
    c.prefs.getIntPref(bounce),
    Ci.nsIBounceTrackingProtection.MODE_ENABLED_DRY_RUN,
    "a bounce tracking mode the switch writes syncs, and one it never writes is refused"
  );

  for (const [i, value] of [6, -1].entries()) {
    await a.engine.mutate({
      kind: "setSetting",
      document: SETTINGS,
      key: cookies,
      valueJson: JSON.stringify(value),
      now: 90_000 + i * 1000,
    });
    await a.pass();
    await b.pass();
    Assert.strictEqual(
      b.prefs.getIntPref(cookies),
      Ci.nsICookieService.BEHAVIOR_REJECT_FOREIGN,
      `${JSON.stringify(value)} is refused`
    );
  }
});

add_task(
  async function fingerprinting_switches_changed_on_two_devices_both_hold() {
    const FP = ChromeUtils.importESModule(
      "moz-src:///browser/components/sval/SvalFingerprinting.sys.mjs"
    );
    const byId = id => FP.ITEMS.find(item => item.id === id);
    const canvas = byId("canvas-noise");
    const touch = byId("touch");
    const { make } = await twoDevices();
    const options = { keys: FP.SYNCED_PREFS };
    const a = await make(options);
    const b = await make(options);
    await a.sync.start();
    await b.sync.start();
    // b runs a newer build, whose default string turns one more target on.
    const older = FP.defaultOverrides();
    const newer = `${older},+AudioSampleRate`;
    /**
     * @param {object} device One of the two.
     * @param {string} baseline Its build's default overrides string.
     * @returns {string[]} The overrides `device` composes, as tokens.
     */
    const overridesOf = (device, baseline) =>
      FP.composeOverrides({
        choice: setting =>
          device.prefs.prefHasUserValue(FP.choicePref(setting))
            ? device.prefs.getBoolPref(FP.choicePref(setting))
            : undefined,
        current: baseline,
        baseline,
      }).split(",");

    // Between two passes, Canvas noise goes off on a and Touch points on b.
    a.prefs.setBoolPref(FP.choicePref(canvas), false);
    b.prefs.setBoolPref(FP.choicePref(touch), false);
    await a.settle();
    await b.settle();
    await a.pass();
    await b.pass();
    await a.pass();

    for (const [device, baseline, name] of [
      [a, older, "a"],
      [b, newer, "b"],
    ]) {
      const tokens = overridesOf(device, baseline);
      Assert.ok(
        tokens.includes("-CanvasRandomization") &&
          !tokens.includes("+CanvasRandomization"),
        `Canvas noise is off on ${name}`
      );
      Assert.ok(
        tokens.includes("-MaxTouchPointsCollapse"),
        `Touch points are off on ${name}`
      );
    }
    Assert.ok(
      overridesOf(b, newer).includes("+AudioSampleRate"),
      "b keeps its own build's default target"
    );

    a.prefs.clearUserPref(FP.choicePref(canvas));
    await a.settle();
    await a.pass();
    await b.pass();
    Assert.ok(
      overridesOf(b, newer).includes("+CanvasRandomization"),
      "turning Canvas noise back on returns b to its default"
    );
    Assert.ok(
      overridesOf(b, newer).includes("-MaxTouchPointsCollapse"),
      "and leaves Touch points as b's user set them"
    );
  }
);

/**
 * Two choices of each kind that is kept a pref per entry, as each module
 * stores them: `[pref, value]` for one device and the other.
 */
const ENTRY_CHOICES = [
  [
    [SITE_BRANCH + "example.net", JSON.stringify({ media: "allow" })],
    [SITE_BRANCH + "example.org", JSON.stringify({ protections: "off" })],
  ],
  [
    [EXTENSION_SITE_BRANCH + "example.net", JSON.stringify(["a@example"])],
    [EXTENSION_SITE_BRANCH + "example.org", JSON.stringify(["b@example"])],
  ],
  [
    [EXTENSION_DEFAULT_BRANCH + "a@example", "off"],
    [EXTENSION_DEFAULT_BRANCH + "b@example", "off"],
  ],
  [
    [EXTENSION_WORKSPACES_BRANCH + "a@example", JSON.stringify(["w1"])],
    [EXTENSION_WORKSPACES_BRANCH + "b@example", JSON.stringify(["w2"])],
  ],
  [
    [EXTENSION_PIN_BRANCH + "a@example", JSON.stringify(["w1"])],
    [EXTENSION_PIN_BRANCH + "b@example", JSON.stringify(["w2"])],
  ],
  [
    [JAVASCRIPT_BRANCH + "example.net", "block"],
    [JAVASCRIPT_BRANCH + "example.org", "allow"],
  ],
  [
    [KEEP_LINKS_BRANCH + "example.net", "on"],
    [KEEP_LINKS_BRANCH + "shop.example.org", "off"],
  ],
  [
    [ALLOWED_DOMAIN_BRANCH + "shop.example.net", true],
    [ALLOWED_DOMAIN_BRANCH + "news.example.org", true],
  ],
  [
    [CUSTOM_LIST_BRANCH + "sval-easylist", true],
    [CUSTOM_LIST_BRANCH + "sval-easyprivacy", true],
  ],
  [
    [
      USER_LIST_BRANCH + "sval-user-0001",
      JSON.stringify({ url: "https://lists.example.net/a.txt" }),
    ],
    [
      USER_LIST_BRANCH + "sval-user-0002",
      JSON.stringify({ url: "https://lists.example.org/b.txt" }),
    ],
  ],
  [
    [
      MY_FILTER_BRANCH + "0a",
      JSON.stringify({ line: "a.com##.x", order: "i" }),
    ],
    [
      MY_FILTER_BRANCH + "0b",
      JSON.stringify({ line: "b.com##.y", order: "r" }),
    ],
  ],
];

/** @returns {string[]} Every branch `ENTRY_CHOICES` covers. */
function entryBranches() {
  return ENTRY_CHOICES.map(([[pref]]) =>
    SvalSettingsRegistry.SYNCED_BRANCHES.find(b => pref.startsWith(b))
  );
}

/**
 * @param {nsIPrefBranch} prefs
 * @param {string} name
 * @returns {*} The pref's user value, or undefined for none.
 */
function held(prefs, name) {
  if (!prefs.prefHasUserValue(name)) {
    return undefined;
  }
  switch (prefs.getPrefType(name)) {
    case Ci.nsIPrefBranch.PREF_BOOL:
      return prefs.getBoolPref(name);
    case Ci.nsIPrefBranch.PREF_INT:
      return prefs.getIntPref(name);
    default:
      return prefs.getStringPref(name);
  }
}

add_task(
  async function two_devices_changing_different_entries_both_keep_them() {
    Assert.deepEqual(
      entryBranches().toSorted(),
      SvalSettingsRegistry.SYNCED_BRANCHES.toSorted(),
      "the choices cover every synced branch"
    );
    const { make } = await twoDevices();
    const a = await make();
    const b = await make();
    await a.sync.start();
    await b.sync.start();

    // Each device chooses before it has seen the other's choice.
    for (const [[name, value]] of ENTRY_CHOICES) {
      setPref(a.prefs, name, value);
    }
    await a.settle();
    for (const [, [name, value]] of ENTRY_CHOICES) {
      setPref(b.prefs, name, value);
    }
    await b.settle();
    await a.pass();
    await b.pass();
    await a.pass();

    for (const device of [a, b]) {
      for (const [name, value] of ENTRY_CHOICES.flat()) {
        Assert.strictEqual(
          held(device.prefs, name),
          value,
          `${device === a ? "a" : "b"} holds ${name}`
        );
      }
    }
  }
);

add_task(async function a_removal_on_one_device_stands_on_the_other() {
  const { make } = await twoDevices();
  const a = await make();
  const b = await make();
  await a.sync.start();
  await b.sync.start();
  for (const [name, value] of ENTRY_CHOICES.flat()) {
    setPref(a.prefs, name, value);
  }
  await a.settle();
  await a.pass();
  await b.pass();

  // b takes away the first entry of each kind, and keeps the second.
  for (const [[name]] of ENTRY_CHOICES) {
    Assert.notStrictEqual(held(b.prefs, name), undefined, `b had ${name}`);
    b.prefs.clearUserPref(name);
  }
  await b.settle();
  await b.pass();
  await a.pass();
  await a.pass();
  await b.pass();

  for (const device of [a, b]) {
    for (const [[removed], [kept]] of ENTRY_CHOICES) {
      Assert.strictEqual(
        held(device.prefs, removed),
        undefined,
        `${removed} is gone`
      );
      Assert.notStrictEqual(
        held(device.prefs, kept),
        undefined,
        `${kept} stays`
      );
    }
  }
});

/**
 * Entries a device holds before settings sync starts reach the other
 * devices, and one another device chose already is taken from there rather
 * than overwritten.
 */
add_task(async function entries_held_before_sync_starts_reach_the_others() {
  const { make } = await twoDevices();
  const b = await make();
  await b.sync.start();
  const [[chosenThere, there], [onlyHere, here]] = ENTRY_CHOICES[1];
  setPref(b.prefs, chosenThere, there);
  await b.settle();
  await b.pass();

  const a = await make();
  // A value of its own for b's entry, and one b lacks.
  setPref(a.prefs, chosenThere, there === "block" ? "allow" : "block");
  setPref(a.prefs, onlyHere, here);
  await a.sync.start();
  await a.pass();
  await a.pass();
  await b.pass();

  for (const device of [a, b]) {
    Assert.strictEqual(held(device.prefs, chosenThere), there, "b's choice");
    Assert.strictEqual(held(device.prefs, onlyHere), here, "a's entry");
  }
});

/**
 * A home page opens with the system principal, so only web pages and Sval's
 * home page sync as one, every address of several, and anything else neither
 * reaches another device nor leaves its own.
 */
add_task(async function a_local_or_data_address_stays_on_its_device() {
  const homepage = "browser.startup.homepage";
  const { make } = await twoDevices();
  const options = {
    defaults: { [homepage]: "about:home" },
    keys: [homepage],
  };
  const a = await make(options);
  const b = await make(options);
  await a.sync.start();
  await b.sync.start();

  a.prefs.setStringPref(homepage, "https://start.example/");
  await a.settle();
  await a.pass();
  await b.pass();
  Assert.strictEqual(
    b.prefs.getStringPref(homepage),
    "https://start.example/",
    "a web address syncs"
  );

  let at = 900_000;
  for (const value of [
    "data:text/html,<h1>Sign in</h1>",
    "https://start.example/|data:text/html,<h1>Sign in</h1>",
    "javascript:alert(1)",
    "chrome://browser/content/browser.xhtml",
  ]) {
    await a.engine.mutate({
      kind: "setSetting",
      document: SETTINGS,
      key: homepage,
      valueJson: JSON.stringify(value),
      now: (at += 1000),
    });
    await a.pass();
    await b.pass();
    Assert.strictEqual(
      b.prefs.getStringPref(homepage),
      "https://start.example/",
      `a synced home page that is not every bit a web page is refused: ${value}`
    );
  }
  await a.engine.mutate({
    kind: "setSetting",
    document: SETTINGS,
    key: homepage,
    valueJson: JSON.stringify("https://one.example/|about:home"),
    now: (at += 1000),
  });
  await a.pass();
  await b.pass();
  Assert.strictEqual(
    b.prefs.getStringPref(homepage),
    "https://one.example/|about:home",
    "web pages and Sval's home page sync"
  );

  b.prefs.setStringPref(homepage, "file:///Users/me/start.html");
  await b.settle();
  await b.pass();
  await a.pass();
  Assert.ok(
    !Object.values(await a.engine.settings(SETTINGS)).some(
      value => typeof value === "string" && value.startsWith("file:")
    ),
    "a file: address this device chose is not published"
  );
  Assert.strictEqual(
    b.prefs.getStringPref(homepage),
    "file:///Users/me/start.html",
    "and stays here"
  );
});

/**
 * Safe Browsing and extension updates sync one way (spec §10.8): another
 * device can turn them on here, never off.
 */
add_task(async function protections_sync_on_and_never_off() {
  const phishing = "browser.safebrowsing.phishing.enabled";
  const { make } = await twoDevices();
  const options = { defaults: { [phishing]: true }, keys: [phishing] };
  const a = await make(options);
  const b = await make(options);
  await a.sync.start();
  await b.sync.start();

  a.prefs.setBoolPref(phishing, false);
  await a.settle();
  await a.pass();
  await b.pass();
  Assert.strictEqual(
    b.prefs.getBoolPref(phishing),
    true,
    "another device turning it off leaves it on here"
  );
  Assert.strictEqual(a.prefs.getBoolPref(phishing), false, "and off there");

  b.prefs.setBoolPref(phishing, false);
  await b.settle();
  await b.pass();
  a.prefs.setBoolPref(phishing, true);
  await a.settle();
  await a.pass();
  await b.pass();
  Assert.strictEqual(
    b.prefs.getBoolPref(phishing),
    true,
    "another device turning it on turns it on here"
  );
});
