/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { makeTempDir } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);

const { failEngineCalls } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestFault.sys.mjs"
);

const TREE = "workspace-under-test";
const SETTINGS = "settings";

function resolve(root, relative) {
  return PathUtils.join(root, ...relative.split("/"));
}

/**
 * Puts a settings document sealed under another account's key into `dir`,
 * under a peer's name: a file this account finds and cannot open.
 *
 * @param {string} dir The settings document's directory.
 * @param {string} extension The extension its files carry.
 * @returns {Promise<string>} the planted file's name.
 */
async function plantForeignSettings(dir, extension) {
  const elsewhere = await makeTempDir("sval-settings-foreign");
  const stranger = new SvalEngine({
    root: elsewhere,
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  try {
    await stranger.addDocument(SETTINGS);
    await stranger.mutate({
      kind: "setSetting",
      document: SETTINGS,
      key: "k",
      valueJson: "1",
      now: 1000,
    });
    const { wrote } = await stranger.sync(SETTINGS, 1500);
    const name = `00000000000000000000000000000099${extension}`;
    await IOUtils.write(
      PathUtils.join(dir, name),
      await IOUtils.read(resolve(elsewhere, wrote))
    );
    return name;
  } finally {
    stranger.terminate();
  }
}

function engines(root, keyBytes) {
  const made = [];
  registerCleanupFunction(() => made.forEach(e => e.terminate()));
  return () => {
    const engine = new SvalEngine({
      root,
      keyBytes,
      deviceId: crypto.getRandomValues(new Uint8Array(16)),
    });
    made.push(engine);
    return engine;
  };
}

add_task(async function a_setting_reaches_a_second_device() {
  const make = engines(
    await makeTempDir("sval-settings-two"),
    crypto.getRandomValues(new Uint8Array(32))
  );
  const alice = make();
  const bob = make();
  await alice.addDocument(SETTINGS);
  await bob.addDocument(SETTINGS);

  await alice.mutate({
    kind: "setSetting",
    document: SETTINGS,
    key: "sval.search.engine",
    valueJson: JSON.stringify("kagi"),
    now: 1000,
  });
  await alice.sync(SETTINGS, 2000);
  await bob.sync(SETTINGS, 3000);

  Assert.deepEqual(await bob.settings(SETTINGS), {
    "sval.search.engine": "kagi",
  });
});

add_task(async function a_setting_never_enters_the_tree_document() {
  const make = engines(
    await makeTempDir("sval-settings-tree"),
    crypto.getRandomValues(new Uint8Array(32))
  );
  const alice = make();
  await alice.addDocument(SETTINGS);
  await alice.mutate({ kind: "addWorkspace", name: "W", now: 1000 });
  await alice.mutate({
    kind: "setSetting",
    document: SETTINGS,
    key: "k",
    valueJson: "true",
    now: 1000,
  });
  await alice.sync(TREE, 2000);

  const kinds = Object.values((await alice.tree()).nodes).map(n => n.kind);
  Assert.ok(!kinds.includes("setting"), "the tree holds no setting node");
  Assert.deepEqual(kinds, ["workspace"], "the tree holds only its own nodes");
});

add_task(async function a_key_swap_keeps_the_settings_document() {
  // A join moves the profile's engine onto the new key with every document
  // it holds, and each publishes under that key on its next pass.
  const make = engines(
    await makeTempDir("sval-settings-rekey"),
    crypto.getRandomValues(new Uint8Array(32))
  );
  const alice = make();
  await alice.addDocument(SETTINGS);
  await alice.mutate({
    kind: "setSetting",
    document: SETTINGS,
    key: "k",
    valueJson: "1",
    now: 1000,
  });
  alice.useSyncKey(crypto.getRandomValues(new Uint8Array(32)));

  Assert.deepEqual(await alice.settings(SETTINGS), { k: 1 });
});

add_task(async function a_null_value_is_a_reset() {
  const make = engines(
    await makeTempDir("sval-settings-reset"),
    crypto.getRandomValues(new Uint8Array(32))
  );
  const alice = make();
  await alice.addDocument(SETTINGS);
  await alice.mutate({
    kind: "setSetting",
    document: SETTINGS,
    key: "k",
    valueJson: null,
    now: 1000,
  });
  Assert.deepEqual(await alice.settings(SETTINGS), { k: null });
});

add_task(async function a_setting_for_an_unregistered_document_is_refused() {
  const make = engines(
    await makeTempDir("sval-settings-unregistered"),
    crypto.getRandomValues(new Uint8Array(32))
  );
  const alice = make();
  await Assert.rejects(
    alice.mutate({
      kind: "setSetting",
      document: SETTINGS,
      key: "k",
      valueJson: "1",
      now: 1000,
    }),
    err => err.code === "not_registered",
    "a setting sent before addDocument is refused"
  );
  await Assert.rejects(
    alice.settings("typo"),
    err => err.code === "not_registered",
    "reading an unregistered document is refused"
  );

  const kinds = Object.values((await alice.tree()).nodes).map(n => n.kind);
  Assert.deepEqual(kinds, [], "the refused setting did not reach the tree");
});

add_task(async function syncing_the_tree_also_syncs_settings() {
  const make = engines(
    await makeTempDir("sval-settings-ride"),
    crypto.getRandomValues(new Uint8Array(32))
  );
  const alice = make();
  const bob = make();
  const seen = [];
  await alice.addDocument(SETTINGS);
  await bob.addDocument(SETTINGS, report => seen.push(report));

  await alice.mutate({
    kind: "setSetting",
    document: SETTINGS,
    key: "k",
    valueJson: '"v"',
    now: 1000,
  });
  await alice.sync(TREE, 2000);
  await bob.sync(TREE, 3000);

  Assert.deepEqual(await bob.settings(SETTINGS), { k: "v" });
  Assert.equal(seen.length, 1, "bob's settings listener heard its one pass");
});

add_task(async function a_settings_problem_reaches_the_trees_report() {
  // Settings-sync spec §6 row 3: the panel reads the report of the tree's
  // sync, so a peer's settings file that will not open has to be in it.
  const root = await makeTempDir("sval-settings-problem");
  const make = engines(root, crypto.getRandomValues(new Uint8Array(32)));
  const alice = make();
  await alice.addDocument(SETTINGS);
  await alice.mutate({
    kind: "setSetting",
    document: SETTINGS,
    key: "k",
    valueJson: "1",
    now: 1000,
  });
  const { wrote } = await alice.sync(SETTINGS, 2000);
  const planted = await plantForeignSettings(
    PathUtils.parent(resolve(root, wrote)),
    wrote.slice(wrote.lastIndexOf("."))
  );

  const bob = make();
  await bob.addDocument(SETTINGS);
  const report = await bob.sync(TREE, 3000);
  const problems = [
    ...report.errors,
    ...report.schemaTooNew,
    ...report.unreadable,
  ];
  Assert.equal(problems.length, 1, "the tree's report carries one problem");
  Assert.ok(
    problems[0].path.endsWith(`/${planted}`),
    "and it is the settings file that would not open"
  );
  Assert.ok(!problems[0].own, "a peer's file, not this device's");
  Assert.deepEqual(
    await bob.settings(SETTINGS),
    { k: 1 },
    "the readable peer still merged"
  );
});

add_task(async function a_pending_setting_is_published_before_shutdown() {
  const root = await makeTempDir("sval-settings-quit");
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const make = engines(root, keyBytes);
  const alice = make();
  await alice.addDocument(SETTINGS);
  await alice.sync(TREE, 1000);
  // After the last tree pass, so only a final pass that carries the settings
  // document publishes it.
  await alice.mutate({
    kind: "setSetting",
    document: SETTINGS,
    key: "k",
    valueJson: "2",
    now: 2000,
  });

  await alice.publishBeforeShutdown();

  const reader = make();
  await reader.addDocument(SETTINGS);
  await reader.sync(SETTINGS, 3000);
  Assert.deepEqual(await reader.settings(SETTINGS), { k: 2 });
});

add_task(async function a_tree_change_made_during_a_pass_stays_pending() {
  // The worker answers in order, so this change lands after the tree's
  // profile pass and before the settings document's. The pass that follows it
  // must not count it as published.
  const root = await makeTempDir("sval-settings-midpass");
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const make = engines(root, keyBytes);
  const alice = make();
  await alice.addDocument(SETTINGS);
  const pass = alice.sync(TREE, 1000);
  await alice.mutate({ kind: "addWorkspace", name: "W", now: 1500 });
  await pass;

  Assert.notEqual(
    await alice.publishPending(),
    null,
    "the change the tree's pass missed is still pending"
  );

  const reader = make();
  await reader.sync(TREE, 3000);
  const kinds = Object.values((await reader.tree()).nodes).map(n => n.kind);
  Assert.deepEqual(kinds, ["workspace"], "and the final pass published it");
});

add_task(async function a_broken_settings_pass_leaves_the_tree_syncing() {
  // Settings-sync spec §6: the two documents are independent.
  const root = await makeTempDir("sval-settings-broken");
  const make = engines(root, crypto.getRandomValues(new Uint8Array(32)));
  const alice = make();
  await alice.addDocument(SETTINGS);
  await alice.mutate({ kind: "addWorkspace", name: "W", now: 1000 });
  await alice.mutate({
    kind: "setSetting",
    document: SETTINGS,
    key: "k",
    valueJson: "3",
    now: 1000,
  });
  const fault = failEngineCalls(alice, "sync", {
    when: args => args?.[0]?.workspace === SETTINGS,
  });

  const report = await alice.sync(TREE, 2000);
  Assert.notEqual(report.wrote, null, "the tree's pass still wrote");

  fault.mend();
  Assert.notEqual(
    await alice.publishPending(),
    null,
    "the setting the broken pass missed is still pending"
  );
  const reader = make();
  await reader.addDocument(SETTINGS);
  await reader.sync(TREE, 3000);
  Assert.deepEqual(await reader.settings(SETTINGS), { k: 3 });
  const kinds = Object.values((await reader.tree()).nodes).map(n => n.kind);
  Assert.deepEqual(kinds, ["workspace"]);
});

add_task(async function a_settings_only_pass_leaves_tree_changes_pending() {
  const root = await makeTempDir("sval-settings-only");
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const make = engines(root, keyBytes);
  const alice = make();
  await alice.addDocument(SETTINGS);
  await alice.sync(TREE, 1000);
  await alice.mutate({ kind: "addWorkspace", name: "W", now: 1500 });
  await alice.sync(SETTINGS, 2000);

  Assert.notEqual(
    await alice.publishPending(),
    null,
    "a pass that never ran the tree did not publish its change"
  );
  const reader = make();
  await reader.sync(TREE, 3000);
  const kinds = Object.values((await reader.tree()).nodes).map(n => n.kind);
  Assert.deepEqual(kinds, ["workspace"], "the final pass published it");
});

add_task(async function a_removal_asked_during_an_open_ends_removed() {
  const make = engines(
    await makeTempDir("sval-settings-open-remove"),
    crypto.getRandomValues(new Uint8Array(32))
  );
  const alice = make();
  const opened = alice.openDocument(SETTINGS, null);
  const removed = alice.removeDocument(SETTINGS);
  await Promise.all([opened, removed]);
  Assert.ok(!alice.hasDocument(SETTINGS), "the later removal holds");
  await Assert.rejects(
    alice.settings(SETTINGS),
    err => err.code === "not_registered",
    "and the worker let the document go"
  );
});

add_task(async function an_open_asked_during_a_removal_ends_open() {
  const make = engines(
    await makeTempDir("sval-settings-remove-open"),
    crypto.getRandomValues(new Uint8Array(32))
  );
  const alice = make();
  await alice.openDocument(SETTINGS, null);
  const removed = alice.removeDocument(SETTINGS);
  const opened = alice.openDocument(SETTINGS, null);
  await Promise.all([removed, opened]);
  Assert.ok(alice.hasDocument(SETTINGS), "the later open holds");
  await alice.mutate({
    kind: "setSetting",
    document: SETTINGS,
    key: "k",
    valueJson: "1",
    now: 1000,
  });
  Assert.deepEqual(
    await alice.settings(SETTINGS),
    { k: 1 },
    "and the worker holds the document it lists"
  );
});
