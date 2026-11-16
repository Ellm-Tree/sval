/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_pairing_helpers.js */

/**
 * A device that has never shared joining another (spec §6.7): it takes the
 * other device's folder before it holds a sync key, as first run's joining
 * path does, and joins without its untouched first workspace. The file runs
 * on a fresh profile of its own (browser-pairing-join-first.toml), which
 * holds no sync key until a join brings one.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_pairing_helpers.js",
  this
);

const { SvalPairing } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPairing.sys.mjs"
);

/**
 * The other device's shared folder, holding a workspace of its own under
 * `keyBytes`.
 *
 * @param {Uint8Array} keyBytes
 * @returns {Promise<object>} `{ root, them }`.
 */
async function theirFolder(keyBytes) {
  const root = await makeTempDir("sval-their-folder");
  await IOUtils.makeDirectory(PathUtils.join(root, "sval"));
  const them = await peerPublishing(root, keyBytes, "Theirs");
  return { root, them };
}

/**
 * Chooses `path` as this device's shared folder without making a key, as
 * first run's joining path does, and puts the choice back when the task
 * ends.
 *
 * @param {string} path
 * @returns {Promise<object>} `chooseSharedFolder`'s answer.
 */
async function chooseWithoutAKey(path) {
  atTaskEnd(async () => {
    await SvalSharedFolder._whenIdle();
    await within(
      SvalPanel.chooseSharedFolder(null),
      20_000,
      "putting back the shared folder"
    );
  });
  await SvalSharedFolder._whenIdle();
  return within(
    SvalPanel.chooseSharedFolder(path, { mint: false }),
    20_000,
    "the folder chosen"
  );
}

/**
 * A folder this device can read is reached with no key to run a shared step
 * with, and one that does not answer is not.
 */
add_task(async function a_joining_device_with_no_key_reaches_the_folder() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  Assert.equal(
    SvalPanel.syncKeyState,
    SvalIdentity.SYNC_KEY_STATES.none,
    "a profile that never shared holds no sync key"
  );
  const { root } = await theirFolder(randomBytes(32));

  const gone = PathUtils.join(await makeTempDir("sval-joining-gone"), "gone");
  const unreached = await chooseWithoutAKey(gone);
  Assert.ok(!unreached.reached, "a folder that does not answer is not reached");
  Assert.ok(unreached.unreachable, "and says so");

  const chosen = await within(
    SvalPanel.chooseSharedFolder(root, { mint: false }),
    20_000,
    "the readable folder chosen"
  );
  Assert.ok(chosen.reached, "a readable folder is reached");
  Assert.equal(SvalPanel.engine.syncKey, null, "with no key made for it");
});

/**
 * A device that never shared joins without its untouched first workspace:
 * an unnamed workspace holding only a fresh tab stays behind and never
 * reaches the other device, while what the user made goes with them.
 */
add_task(async function joining_leaves_an_untouched_first_workspace_behind() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const { engine } = SvalPanel;
  const made = await engine.mutate({
    kind: "addWorkspace",
    name: "Made on this device",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  const untouched = await engine.mutate({
    kind: "addWorkspace",
    name: "",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  const freshTab = await engine.mutate({
    kind: "addTab",
    parent: untouched,
    name: "New Tab",
    url: "about:newtab",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  await SvalPanel.refresh();

  const theirKey = randomBytes(32);
  const { root, them } = await theirFolder(theirKey);
  Assert.ok((await chooseWithoutAKey(root)).reached, "the folder is reached");
  await SvalSharedFolder._whenIdle();
  const { code } = await SvalPairing.offer(root, theirKey);
  const { ui, outcome } = await joinWithCode(code);
  Assert.equal(outcome, "adopted", "joining worked");
  BrowserTestUtils.removeTab(ui.tab);

  Assert.ok(them.id in SvalPanel.nodes, "this device shows their workspace");
  Assert.ok(made in SvalPanel.nodes, "and keeps the one it made");
  Assert.ok(
    !(untouched in SvalPanel.nodes) && !(freshTab in SvalPanel.nodes),
    "the untouched one stayed behind"
  );

  await SvalSharedFolder._whenIdle();
  await them.engine.sync(SYNC_DOCUMENT, Date.now());
  const theirs = await nodes(them.engine);
  Assert.ok(made in theirs, "the other device has what was made");
  Assert.ok(!(untouched in theirs), "and never saw the untouched one");
});
