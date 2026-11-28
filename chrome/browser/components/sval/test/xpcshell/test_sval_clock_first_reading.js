/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */

/**
 * A device publishes nothing before its first time reading, and the first
 * file it publishes after one holds no stamp of its own later than corrected
 * time.
 */

const { SKEW_PREF } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalClock.sys.mjs"
);
const { CLOCK_READING_FILE } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { SvalKeyJoin } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalKeyJoin.sys.mjs"
);
const { SvalIdentity } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalIdentity.sys.mjs"
);
const { SvalSecretStore, MemoryKeyStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSecretStore.sys.mjs"
);
const { SYNC_DOCUMENT } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTree.sys.mjs"
);

registerCleanupFunction(() => Services.prefs.setIntPref(SKEW_PREF, 0));

/**
 * Every stamp this device's file in `shared` holds is no later than `at`.
 *
 * @param {object} me As `device` answers.
 * @param {number} at
 */
async function assertNothingAhead(me, at) {
  const stamps = stampsOf(await readBack(me.shared, me.keyBytes));
  Assert.ok(stamps.length, "stamps were read");
  for (const [field, value] of stamps) {
    Assert.lessOrEqual(value, at, `${field} is no later than now`);
  }
}

/**
 * Every stamp a document's nodes carry.
 *
 * @param {object} nodes A document's nodes by id.
 * @returns {Array<Array>} `[field, value]` pairs.
 */
function stampsOf(nodes) {
  return Object.values(nodes).flatMap(node =>
    Object.entries(node).filter(
      ([field, value]) => field.endsWith("_at") && typeof value === "number"
    )
  );
}

add_task(async function a_clock_ahead_publishes_nothing_until_a_reading() {
  Services.prefs.clearUserPref(SKEW_PREF);
  const me = await device("first-reading");
  const engine = me.make();
  // A wall clock an hour ahead, which the device stamps with until it has a
  // reading.
  const ahead = Date.now() + 3_600_000;
  const ws = await engine.mutate({
    kind: "addWorkspace",
    name: "W",
    now: ahead,
  });
  const tab = await engine.mutate({
    kind: "addTab",
    parent: ws,
    name: "T",
    url: "https://example.com/",
    now: ahead + 1,
  });

  const held = await engine.sync(WORKSPACE, ahead + 2);
  Assert.ok(held.sharedRan, "the shared step ran");
  Assert.equal(held.shared, "reached", "and reached the folder");
  Assert.equal(held.sharedWrote, null, "and published nothing");
  Assert.deepEqual(
    await readBack(me.shared, me.keyBytes),
    {},
    "the folder holds nothing from this device"
  );

  // Remote Settings measures no difference: corrected time is the real time.
  Services.prefs.setIntPref(SKEW_PREF, 0);
  const report = await engine.sync(WORKSPACE);
  const after = Date.now();
  Assert.ok(report.sharedWrote, "the next step publishes");
  const published = await readBack(me.shared, me.keyBytes);
  Assert.ok(published[tab], "the tab with it");
  const stamps = stampsOf(published);
  Assert.ok(stamps.length, "stamps were read");
  for (const [field, value] of stamps) {
    Assert.lessOrEqual(value, after, `${field} is no later than now`);
  }
});

add_task(async function a_restart_before_the_next_pass_still_pulls_back() {
  Services.prefs.clearUserPref(SKEW_PREF);
  const me = await device("restart-reading");
  const first = me.make();
  const ahead = Date.now() + 3_600_000;
  const ws = await first.mutate({
    kind: "addWorkspace",
    name: "W",
    now: ahead,
  });
  await first.sync(WORKSPACE, ahead + 1);

  Services.prefs.setIntPref(SKEW_PREF, 0);
  const file = PathUtils.join(me.local, TOP_DIR, CLOCK_READING_FILE);
  await within(
    (async () => {
      while (!(await IOUtils.exists(file))) {
        await new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
      }
    })(),
    5000,
    "the reading's file"
  );
  first.terminate();

  const second = me.make();
  const report = await second.sync(WORKSPACE);
  const after = Date.now();
  Assert.ok(report.sharedWrote, "the new engine publishes");
  Assert.ok((await readBack(me.shared, me.keyBytes))[ws], "the workspace");
  await assertNothingAhead(me, after);
});

add_task(async function a_join_without_a_reading_joins_and_publishes_later() {
  Services.prefs.clearUserPref(SKEW_PREF);
  const previous = {
    path: SvalIdentity.path,
    localKeyPath: SvalIdentity.localKeyPath,
    secrets: SvalSecretStore.path,
    keyStore: SvalSecretStore.keyStore,
  };
  const dir = await makeTempDir("sval-join-reading-identity");
  SvalIdentity.path = PathUtils.join(dir, "sval-identity.json");
  SvalIdentity.localKeyPath = PathUtils.join(dir, "sval-local-key");
  SvalSecretStore.path = PathUtils.join(dir, "sval-secrets.json");
  SvalSecretStore.keyStore = new MemoryKeyStore();
  SvalIdentity.forgetCachedValues();
  registerCleanupFunction(() => {
    Object.assign(SvalIdentity, {
      path: previous.path,
      localKeyPath: previous.localKeyPath,
    });
    SvalSecretStore.path = previous.secrets;
    SvalSecretStore.keyStore = previous.keyStore;
    SvalIdentity.forgetCachedValues();
  });
  await SvalIdentity.localKey();

  const me = await device("join-reading");
  const engine = me.make();
  const ws = await engine.mutate({ kind: "addWorkspace", name: "W" });
  const key = crypto.getRandomValues(new Uint8Array(32));
  const published = async () => {
    const reader = new SvalEngine({
      root: me.shared,
      keyBytes: key,
      deviceId: crypto.getRandomValues(new Uint8Array(16)),
    });
    try {
      return JSON.parse(await reader.publishedTree(SYNC_DOCUMENT)).nodes;
    } finally {
      reader.terminate();
    }
  };

  const joined = await SvalKeyJoin.join(engine, key);
  Assert.equal(joined.outcome, "adopted", `joined: ${joined.reason}`);
  Assert.ok(sameKey(engine.syncKey, key), "the engine is on the new key");
  Assert.ok(!(await published())[ws], "nothing is published yet");

  Services.prefs.setIntPref(SKEW_PREF, 0);
  const report = await engine.sync(SYNC_DOCUMENT);
  Assert.ok(report.sharedWrote, "the reading lets it publish");
  Assert.ok((await published())[ws], "this device's workspace with it");
});

/**
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
function sameKey(a, b) {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
