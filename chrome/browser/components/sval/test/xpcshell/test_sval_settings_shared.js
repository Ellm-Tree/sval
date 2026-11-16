/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */

const SETTINGS = "settings";

add_task(async function settings_cross_the_shared_folder_in_one_step() {
  const a = await device("ss-a");
  const alice = a.make();
  await alice.addDocument(SETTINGS);
  await alice.mutate({
    kind: "setSetting",
    document: SETTINGS,
    key: "k",
    valueJson: "true",
    now: 1000,
  });
  const published = await alice.sync(WORKSPACE, 2000, { shared: "wait" });
  Assert.equal(published.shared, "reached", "alice's step reached the folder");

  const bobLocal = await makeTempDir("sval-ss-b-local");
  const bob = new SvalEngine({
    root: bobLocal,
    sharedRoot: a.shared,
    keyBytes: a.keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  registerCleanupFunction(() => bob.terminate());
  await bob.addDocument(SETTINGS);
  const read = await bob.sync(WORKSPACE, 3000, { shared: "wait" });
  Assert.equal(read.shared, "reached", "bob's step reached the folder");

  Assert.deepEqual(await bob.settings(SETTINGS), { k: true });
});

add_task(async function background_steps_carry_settings_too() {
  // A busy tree must not starve the settings document: one step, every
  // document, one helper (settings-sync spec §4.1).
  const a = await device("ss-bg");
  const alice = a.make({ sharedIntervalMs: 0 });
  await alice.addDocument(SETTINGS);
  await alice.mutate({
    kind: "setSetting",
    document: SETTINGS,
    key: "k",
    valueJson: "1",
    now: 1000,
  });
  await alice.sync(WORKSPACE, 2000, { shared: "background" });
  await SvalSharedFolder._whenIdle();
  await alice.sync(WORKSPACE, 3000, { shared: "wait" });

  const reader = new SvalEngine({
    root: a.shared,
    keyBytes: a.keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  registerCleanupFunction(() => reader.terminate());
  await reader.addDocument(SETTINGS);
  await reader.sync(SETTINGS, 4000);
  Assert.deepEqual(await reader.settings(SETTINGS), { k: 1 });
});

add_task(async function a_shared_settings_problem_reaches_the_trees_report() {
  // Settings-sync spec §6 row 3, for a file only the shared folder holds: the
  // shared step's per-document problems reach the report the panel reads.
  const a = await device("ss-problem");
  const peer = new SvalEngine({
    root: a.shared,
    keyBytes: a.keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  registerCleanupFunction(() => peer.terminate());
  await peer.addDocument(SETTINGS);
  await peer.mutate({
    kind: "setSetting",
    document: SETTINGS,
    key: "k",
    valueJson: "1",
    now: 1000,
  });
  const { wrote } = await peer.sync(SETTINGS, 1500);

  // Another account's settings file, under a peer's name.
  const stranger = new SvalEngine({
    root: await makeTempDir("sval-ss-stranger"),
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  registerCleanupFunction(() => stranger.terminate());
  await stranger.addDocument(SETTINGS);
  await stranger.mutate({
    kind: "setSetting",
    document: SETTINGS,
    key: "k",
    valueJson: "2",
    now: 1000,
  });
  const theirs = await stranger.sync(SETTINGS, 1500);
  const planted = `00000000000000000000000000000099${wrote.slice(
    wrote.lastIndexOf(".")
  )}`;
  await IOUtils.write(
    PathUtils.join(PathUtils.parent(resolve(a.shared, wrote)), planted),
    await IOUtils.read(resolve(stranger.root, theirs.wrote))
  );

  const alice = a.make();
  await alice.addDocument(SETTINGS);
  const report = await alice.sync(WORKSPACE, 2000, { shared: "wait" });
  Assert.equal(report.shared, "reached");
  const problems = [
    ...report.errors,
    ...report.schemaTooNew,
    ...report.unreadable,
  ];
  Assert.equal(problems.length, 1, "the tree's report carries one problem");
  Assert.ok(
    problems[0].path.endsWith(`/${planted}`),
    "and it is the shared settings file that would not open"
  );
  Assert.deepEqual(
    await alice.settings(SETTINGS),
    { k: 1 },
    "the readable peer still merged"
  );
});

add_task(
  async function an_unreachable_folder_is_unreachable_for_every_document() {
    const a = await device("ss-gone");
    const alice = a.make();
    await alice.addDocument(SETTINGS);
    await IOUtils.remove(a.shared, { recursive: true });
    const report = await alice.sync(WORKSPACE, 1000, { shared: "wait" });
    Assert.equal(report.shared, "unreachable");
    Assert.equal(report.sharedWrote, null, "nothing was published anywhere");
  }
);

/**
 * Preferences holding one int pref that its user set, for a `SvalSettingsSync`.
 *
 * @param {string} name
 * @param {number} value
 * @returns {object} An nsIPrefBranch-shaped store; `value` reads it back.
 */
function oneUserIntPref(name, value) {
  return {
    value,
    getPrefType: () => Ci.nsIPrefBranch.PREF_INT,
    getIntPref() {
      return this.value;
    },
    setIntPref(_name, next) {
      this.value = next;
    },
    prefHasUserValue: () => true,
    prefIsLocked: () => false,
    addObserver() {},
    removeObserver() {},
  };
}

add_task(async function a_device_that_joins_takes_the_choice_made_there() {
  // A device whose user set a pref before it shared any folder joins one
  // where another device chose that pref. The choice made there stands.
  const { SvalSettingsSync } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSettingsSync.sys.mjs"
  );
  const a = await device("ss-join");
  const peer = new SvalEngine({
    root: a.shared,
    keyBytes: a.keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  registerCleanupFunction(() => peer.terminate());
  await peer.addDocument(SETTINGS);
  await peer.mutate({
    kind: "setSetting",
    document: SETTINGS,
    key: "test.int",
    valueJson: "7",
    now: 1000,
  });
  await peer.sync(SETTINGS, 1500);

  const joiner = a.make({ sharedRoot: null });
  const prefs = oneUserIntPref("test.int", 3);
  const seeded = new Set();
  const sync = new SvalSettingsSync({
    engine: joiner,
    prefs,
    search: {
      currentId: async () => "ddg",
      setById: async () => true,
      observe: () => () => {},
    },
    isSeeded: key => seeded.has(key),
    markSeeded: async keys => keys.forEach(key => seeded.add(key)),
    requestPass: () => {},
    keys: ["test.int"],
  });
  await sync.start();
  registerCleanupFunction(() => sync.stop());
  await joiner.sync(WORKSPACE, 2000);

  joiner.setSharedRoot(a.shared);
  await joiner.sync(WORKSPACE, 3000, { shared: "wait" });
  await waitForCondition(
    () => prefs.value === 7,
    "the device that joined takes the choice made there"
  );
  await joiner.sync(WORKSPACE, 4000, { shared: "wait" });
  await peer.sync(SETTINGS, 5000);
  Assert.strictEqual(
    (await peer.settings(SETTINGS))["test.int"],
    7,
    "and the other device keeps it"
  );
});
