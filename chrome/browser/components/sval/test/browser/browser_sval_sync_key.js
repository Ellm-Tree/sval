/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_pairing_helpers.js */

/**
 * This device's sync key outside pairing: a key missing or unreadable at
 * start, a start that fails, Set Up Sync Again, a backup, installing again,
 * iCloud Keychain (spec §6.6), and asking whether a profile that last ran
 * elsewhere moved here. Like the pairing tasks, these change the
 * stored key for real, so the file runs on a fresh profile of its own
 * (browser-sync-key.toml).
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_pairing_helpers.js",
  this
);

/**
 * `sval_panel_startup_helpers.js`, in a scope of its own: it declares
 * `SvalEngine` too, as `sval_pairing_helpers.js` does. Names reach it
 * through this file's scope object, which holds head.js's functions; its
 * `const`s are lexical, so those it uses are handed over.
 */
const startup = Object.assign(Object.create(this), { within, tempPath });
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_panel_startup_helpers.js",
  startup
);

const { SvalTestDeny } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestDeny.sys.mjs"
);

/**
 * The secrets file the profile's sync key is kept in (`SvalSecretStore`'s
 * default path).
 *
 * @returns {string}
 */
function secretsFile() {
  return (
    SvalSecretStore.path ??
    PathUtils.join(PathUtils.profileDir, "sval-secrets.json")
  );
}

/**
 * The sync row a window's panel draws: the indicator, its label and the
 * buttons its state offers.
 *
 * @param {Window} win
 * @returns {{indicator: Element, syncLabel: Element, syncActions: Element}}
 */
function syncRowOf(win) {
  const doc = win.document;
  return {
    indicator: doc.querySelector(".sval-sync-indicator"),
    syncLabel: doc.querySelector(".sval-sync-label"),
    syncActions: doc.querySelector(".sval-sync-actions"),
  };
}

/**
 * Presses `selector` in the dialog `win` shows that holds it, as the user
 * does, once it can be pressed, and waits for that dialog to close.
 *
 * @param {Window} win
 * @param {string} selector
 */
async function pressInDialog(win, selector) {
  let dialog;
  let button;
  await TestUtils.waitForCondition(() => {
    dialog = win.gDialogBox.dialog;
    button = dialog?._frame?.contentDocument?.querySelector(selector);
    return button && !dialog._isClosing;
  }, `a dialog shows ${selector}`);
  await dialogShown(dialog, "the dialog's load");
  await TestUtils.waitForCondition(
    () => !button.disabled,
    `${selector} can be pressed`
  );
  button.click();
  await TestUtils.waitForCondition(
    () => win.gDialogBox.dialog !== dialog,
    "the dialog closes"
  );
}

/**
 * Starts a window on a fresh profile set up to share a folder that another
 * device has published a workspace into, with the stored sync key taken
 * away first: removed from the store, or with the store refusing to answer.
 *
 * @param {object} [options]
 * @param {boolean} [options.refusing] The store refuses instead.
 * @returns {Promise<object>} `{ win, panel, ourKey, peer, storedKey }`.
 */
async function startingWithoutTheKey({ refusing = false } = {}) {
  const shared = await makeTempDir("sval-missing");
  let ourKey;
  let peer;
  const profile = await startup.freshProfile({
    shared,
    async publish({ keys }) {
      ourKey = keys.syncKey;
      peer = await peerPublishing(shared, ourKey, "On the other device");
    },
  });
  atTaskEnd(() => SvalIdentity.adoptSyncKey(ourKey));
  if (refusing) {
    const store = SvalSecretStore._store();
    store.failing.asyncGetRecoveryPhrase = new Error("the keychain is locked");
    // The system secret is read once a run, so the store is asked afresh.
    SvalSecretStore.retry();
    atTaskEnd(() => {
      delete store.failing.asyncGetRecoveryPhrase;
      SvalSecretStore.retry();
    });
  } else {
    await SvalSecretStore.remove("sync key");
  }
  SvalIdentity.forgetCachedValues();
  const win = await profile.open();
  return {
    win,
    panel: win.SvalPanel,
    ourKey,
    peer,
    storedKey: () => SvalSecretStore.read("sync key"),
  };
}

/**
 * A device whose sync key is gone starts with its own workspaces, its
 * indicator says sync is off and offers to reconnect, mints nothing, and
 * syncs again once pairing has brought the key back.
 */
add_task(async function a_missing_key_is_named_and_pairing_restores_it() {
  const { win, panel, ourKey, peer, storedKey } = await startingWithoutTheKey();
  Assert.ok(panel.engine, "sval started");
  Assert.ok(panel.workspaceId, "on a workspace of its own");
  const { indicator, syncActions } = syncRowOf(win);
  Assert.equal(indicator.dataset.severity, "error", "the indicator errs");
  Assert.equal(indicator.dataset.state, "key-gone", "and says syncing is off");
  Assert.ok(
    syncActions.querySelector('[data-command="pairAgain"]'),
    "and offers the way back"
  );
  Assert.ok(
    !(peer.id in panel.nodes),
    "nothing was read from the folder without the key"
  );
  Assert.equal(await storedKey(), null, "no key was made");

  const result = await panel.adoptKey(ourKey);
  Assert.equal(result.outcome, "adopted", "pairing restored the key");
  Assert.equal(shownReason(result), "joined", "and says so");
  Assert.ok(peer.id in panel.nodes, "showing what the other device has");
  Assert.ok(
    !syncActions.querySelector('[data-command="pairAgain"]'),
    "and the indicator's button is gone"
  );
  SvalIdentity.forgetCachedValues();
  Assert.deepEqual(
    asArray((await SvalIdentity.syncKey()).bytes),
    asArray(ourKey),
    "and the next launch finds the key"
  );
});

/**
 * A store that will not answer stops only syncing. Its button reads it again,
 * and a key that reads starts the shared passes without a restart.
 */
add_task(async function an_unreadable_key_is_tried_again_without_a_restart() {
  const { win, panel, peer } = await startingWithoutTheKey({
    refusing: true,
  });
  const { indicator, syncActions } = syncRowOf(win);
  Assert.equal(
    indicator.dataset.state,
    "key-unreadable",
    "the indicator says sync needs access while the store refuses"
  );
  const retry = syncActions.querySelector('[data-command="retrySyncKey"]');
  Assert.ok(retry, "and the panel offers to try again");
  Assert.ok(!(peer.id in panel.nodes), "nothing is read meanwhile");

  delete SvalSecretStore._store().failing.asyncGetRecoveryPhrase;
  // One helper at a time: a request still running from before would answer
  // Try again's shared step "busy", and the step waits for the next poll.
  await within(SvalSharedFolder._whenIdle(), 45_000, "the helper's exit");
  retry.click();
  await TestUtils.waitForCondition(
    () => peer.id in panel.nodes,
    "Try again brought the folder in"
  );
});

/**
 * Restoring a missing key while Sval's own folder work holds the helper waits
 * its turn and restores the key.
 */
add_task(async function restoring_a_missing_key_behind_other_folder_work() {
  const { panel, ourKey, peer } = await startingWithoutTheKey();
  const other = SvalSharedFolder.exists({
    root: panel.sharedRootSetting(),
    path: "sval",
    deadline: Date.now() + 20_000,
  });
  const result = await panel.adoptKey(ourKey);
  await within(other, 20_000, "the other request");
  Assert.equal(result.outcome, "adopted", "pairing restored the key");
  Assert.equal(shownReason(result), "joined", "and says so");
  Assert.ok(
    peer.id in panel.nodes,
    "and the window has the other device's workspace"
  );
});

/**
 * Set Up Sync Again publishes this device's workspaces under a new sync key,
 * stores it, removes what the old key could read, and offers the backup. A
 * device still on the old key reads nothing of it.
 */
/**
 * The directories in `root`'s `sval/ws/`.
 *
 * @param {string} root The shared folder.
 * @returns {Promise<string[]>}
 */
async function workspaceDirs(root) {
  const listed = await SvalSharedFolder.listNames({
    root,
    path: "sval/ws",
    deadline: Date.now() + 30000,
  });
  Assert.ok(listed.reachable, "the folder lists its directories");
  return listed.names;
}

/**
 * Publishes a past week of history through `engine` and lets it go, as a
 * launch whose history sync has not opened that week holds none of it. The
 * profile's own Favorites and history index are published beside it by
 * their stores.
 *
 * @param {SvalEngine} engine
 */
async function publishAPastWeek(engine) {
  const { HISTORY_INDEX } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalHistorySync.sys.mjs"
  );
  const WEEK = "history-2026-W40";
  const now = Date.now();
  await engine.openDocument(WEEK, () => {});
  await engine.mutate({
    kind: "touchShard",
    document: HISTORY_INDEX,
    name: WEEK,
    now,
  });
  await engine.mutate({
    kind: "addVisit",
    document: WEEK,
    url: "https://visited.example/",
    title: "",
    transition: 1,
    visitedAt: now,
    now,
  });
  await engine.sync(SYNC_DOCUMENT, now);
  await engine.removeDocument(WEEK);
}

add_task(async function setting_up_sync_again_shuts_the_old_key_out() {
  const us = await thisDevice("set-up-again");
  await publishAPastWeek(us.engine);
  const oldDirs = await workspaceDirs(us.root);
  Assert.greaterOrEqual(
    oldDirs.length,
    4,
    "the tree, Favorites, the index and a week are under the old key"
  );
  const onOldKey = new SvalEngine({
    root: await makeTempDir("sval-old"),
    sharedRoot: us.root,
    localKey: randomBytes(32),
    syncKey: us.ourKey,
    deviceId: randomBytes(16),
  });
  registerCleanupFunction(() => stopEngine(onOldKey));
  await within(SvalSharedFolder._whenIdle(), 45_000, "the helper's exit");
  await onOldKey.sync(SYNC_DOCUMENT, Date.now());
  Assert.ok(
    us.workspace in (await nodes(onOldKey)),
    "a device on the old key reads this one's workspace to begin with"
  );

  const pending = SvalPanel.setUpSyncAgain();
  await pressInDialog(window, '.sval-dialog-actions button[data-button="ok"]');
  const result = await within(pending, 30_000, "setting up sync again");

  Assert.ok(result.done, `it set up sync again: ${result.failure}`);
  const stored = (await SvalIdentity.syncKey()).bytes;
  Assert.notDeepEqual(asArray(stored), asArray(us.ourKey), "with a new key");
  // The backup is offered once the step has returned, and the user closes it.
  await pressInDialog(window, ".sval-backup-done");
  Assert.ok(!(await IOUtils.exists(us.ourDirectory)), "the old files are gone");
  Assert.deepEqual(
    (await workspaceDirs(us.root)).filter(dir => oldDirs.includes(dir)),
    [],
    "with the documents no pass held"
  );
  Assert.ok(us.workspace in SvalPanel.nodes, "this device keeps its own");

  const onNewKey = new SvalEngine({
    root: await makeTempDir("sval-new"),
    sharedRoot: us.root,
    localKey: randomBytes(32),
    syncKey: stored,
    deviceId: randomBytes(16),
  });
  registerCleanupFunction(() => stopEngine(onNewKey));
  await within(SvalSharedFolder._whenIdle(), 45_000, "the helper's exit");
  await onNewKey.sync(SYNC_DOCUMENT, Date.now());
  Assert.ok(
    us.workspace in (await nodes(onNewKey)),
    "and a device paired with the new key reads it"
  );
  await SvalIdentity.adoptSyncKey(us.ourKey);
});

/**
 * A Set Up Sync Again whose new key did not save removes nothing: the device is
 * still on its old key, and the old key's files are its own workspaces.
 */
add_task(async function a_setup_whose_key_did_not_save_removes_nothing() {
  const us = await thisDevice("set-up-again-unsaved");
  const onOldKey = new SvalEngine({
    root: await makeTempDir("sval-old-unsaved"),
    sharedRoot: us.root,
    keyBytes: us.ourKey,
    deviceId: randomBytes(16),
  });
  registerCleanupFunction(() => stopEngine(onOldKey));

  // The store's file refuses to be read, so the new key cannot be written
  // into it, as a disk that refuses the file does.
  const secrets = secretsFile();
  let result;
  await SvalTestDeny.read(secrets);
  try {
    const pending = SvalPanel.setUpSyncAgain();
    await pressInDialog(
      window,
      '.sval-dialog-actions button[data-button="ok"]'
    );
    result = await within(pending, 30_000, "setting up sync again");
  } finally {
    await SvalTestDeny.allow(secrets);
  }
  Assert.ok(!result.done, "it did not set up sync again");
  Assert.equal(result.failure, "key-store", "because the key did not save");

  Assert.deepEqual(
    us.settings.oldKeyDirs,
    [],
    "so no directory is left for a later pass to remove"
  );
  Assert.ok(
    await IOUtils.exists(us.ourDirectory),
    "the files of the key this device is still on are there"
  );
  await within(SvalSharedFolder._whenIdle(), 45_000, "the helper's exit");
  await onOldKey.sync(SYNC_DOCUMENT, Date.now());
  Assert.ok(
    us.workspace in (await nodes(onOldKey)),
    "and a device on that key still reads this one's workspace"
  );
});

/**
 * A typed backup restores the sync key only when it opens the workspaces in
 * this device's folder.
 */
add_task(async function a_backup_restores_only_a_key_that_fits_the_folder() {
  const us = await thisDevice("restore");
  const theirKey = randomBytes(32);
  const them = await peerPublishing(us.root, theirKey, "Theirs");

  const wrong = await SvalPanel.restoreFromBackup(
    SvalPanelModel.backupCode(randomBytes(32))
  );
  Assert.ok(!wrong.restored, "a key for some other folder is refused");
  Assert.equal(wrong.refused, "mismatch", "as not matching the folder");
  Assert.ok(
    !(await SvalPanel.restoreFromBackup("not a key")).restored,
    "and so is something that is not a key"
  );

  const right = await SvalPanel.restoreFromBackup(
    SvalPanelModel.backupCode(theirKey)
  );
  Assert.ok(right.restored, `the right key is taken: ${right.message}`);
  Assert.ok(right.message, "and says so");
  Assert.ok(them.id in SvalPanel.nodes, "and opens their workspaces");
  Assert.deepEqual(
    asArray((await SvalIdentity.syncKey()).bytes),
    asArray(theirKey),
    "and is stored"
  );
  await SvalIdentity.adoptSyncKey(us.ourKey);
});

/**
 * A window on a fresh profile set up to share `root`, whose first step that
 * reaches the folder leaves its sealed copy of the sync key there.
 *
 * @param {string} root The shared folder.
 * @returns {Promise<Window>}
 */
async function sharingInstallation(root) {
  await IOUtils.makeDirectory(PathUtils.join(root, "sval"));
  const profile = await startup.freshProfile({ shared: root });
  const win = await profile.open();
  atTaskEnd(() => SvalIdentity.adoptSyncKey(profile.keys.syncKey));
  await keyCopyIn(root, "this installation left a sealed copy in the folder");
  return win;
}

/**
 * Sval as this user ran it before on this machine: a device that shares
 * `root` under a sync key of its own, has published a workspace there, and
 * has left its sealed copy of the key there, as a window does once a step
 * reaches the folder (`_afterReachingFolder` in sval-panel-folder.js). It is
 * an engine of its own, because a window of it would still show its
 * workspace when the installation after it joins, and no window shows a
 * workspace another window shows (spec §10.7).
 *
 * @param {string} root The shared folder.
 * @returns {Promise<object>} `{ ourKey, workspace }`.
 */
async function earlierInstallation(root) {
  await IOUtils.makeDirectory(PathUtils.join(root, "sval"));
  const ourKey = randomBytes(32);
  const engine = new SvalEngine({
    root: await makeTempDir("sval-installed-before"),
    sharedRoot: root,
    localKey: randomBytes(32),
    syncKey: ourKey,
    deviceId: randomBytes(16),
  });
  atTaskEnd(() => stopEngine(engine));
  const workspace = await engine.mutate({
    kind: "addWorkspace",
    name: "Made on this device",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  const report = await engine.sync(SYNC_DOCUMENT, Date.now(), {
    shared: "wait",
  });
  Assert.equal(report.shared, "reached", "the earlier installation shared");
  Assert.ok(
    await engine.publishKeyCopy(await SvalSecretStore.wrap(ourKey), root),
    "and left its sealed copy in the folder"
  );
  return { ourKey, workspace };
}

/**
 * A window on Sval installed again on this machine: a fresh profile whose
 * identity, local key and secrets file are new, so it holds no sync key,
 * while the system store is this user's, as it is for a reinstall. Those
 * paths are the ones `SvalIdentity` and `SvalSecretStore` let a test point
 * elsewhere, and they are put back when the task ends, with `ourKey` stored
 * again for the profile's identity.
 *
 * @param {string} label Distinguishes this task's temporary paths.
 * @param {Uint8Array} ourKey The key the harness's profile goes back to.
 * @returns {Promise<object>} `{ win, dir }`: the window, and the directory
 *   its identity, local key and secrets file are in.
 */
async function installedAgain(label, ourKey) {
  const profile = await startup.freshProfile();
  const dir = await makeTempDir(`sval-installed-again-${label}`);
  atTaskEnd(() => SvalIdentity.adoptSyncKey(ourKey));
  const real = {
    identity: SvalIdentity.path,
    localKey: SvalIdentity.localKeyPath,
    secrets: SvalSecretStore.path,
  };
  SvalIdentity.path = PathUtils.join(dir, "sval-identity.json");
  SvalIdentity.localKeyPath = PathUtils.join(dir, "sval-local-key");
  SvalSecretStore.path = PathUtils.join(dir, "sval-secrets.json");
  SvalIdentity.forgetCachedValues();
  atTaskEnd(() => {
    SvalIdentity.path = real.identity;
    SvalIdentity.localKeyPath = real.localKey;
    SvalSecretStore.path = real.secrets;
    SvalIdentity.forgetCachedValues();
  });
  const win = await profile.open();
  Assert.equal(
    win.SvalPanel.syncState.keyState,
    SvalIdentity.SYNC_KEY_STATES.none,
    "the installation holds no sync key"
  );
  return { win, dir };
}

/**
 * Sval installed again for the same user, pointed at the same folder by a
 * user who says they are new, finds its own sealed key there and joins the
 * workspaces with no code and no other device. A copy another user sealed
 * opens nothing, and the folder is not set up beside them.
 */
add_task(async function installing_again_finds_the_key_in_the_folder() {
  const root = await makeTempDir("sval-installed-again");
  const us = await earlierInstallation(root);
  const { win } = await installedAgain("finds", us.ourKey);
  const panel = win.SvalPanel;

  // Another user is another system store, whose secret opens nothing this
  // user sealed. The store is the operating system's, which the test stands
  // in for with a store of its own (`SvalSecretStore.keyStore`).
  const realStore = SvalSecretStore.keyStore;
  const { MemoryKeyStore } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSecretStore.sys.mjs"
  );
  SvalSecretStore.keyStore = new MemoryKeyStore();
  let refused;
  try {
    refused = await panel.chooseSharedFolder(root, { mint: true });
  } finally {
    SvalSecretStore.keyStore = realStore;
  }
  Assert.ok(
    refused.otherWorkspaces,
    "another user's copy opens nothing, so the folder is not set up"
  );

  const joined = await panel.chooseSharedFolder(root, { mint: true });
  Assert.ok(joined.joined, `the same user's copy joins: ${joined.message}`);
  Assert.ok(
    us.workspace in panel.nodes,
    "and the workspaces made before are back"
  );
  Assert.deepEqual(
    asArray(panel.engine.syncKey),
    asArray(us.ourKey),
    "under the key they were made with"
  );
});

/**
 * Sval installed again whose found key does not save says so as a setup that
 * failed, with the line's button, and choosing the same folder again tries
 * the join again.
 */
add_task(async function installing_again_whose_key_did_not_save_can_retry() {
  const root = await makeTempDir("sval-installed-again-unsaved");
  const us = await earlierInstallation(root);
  const { win, dir } = await installedAgain("unsaved", us.ourKey);
  const panel = win.SvalPanel;

  // The directory the installation keeps its keys in refuses a new file, so
  // the key it found cannot be saved there.
  let failed;
  await SvalTestDeny.write(dir);
  try {
    failed = await panel.chooseSharedFolder(root, { mint: true });
  } finally {
    await SvalTestDeny.allow(dir);
  }
  Assert.ok(!failed.reached, "the join did not finish");
  Assert.deepEqual(
    failed.line,
    SvalPanelModel.pairingLine(
      { failure: "key-store" },
      AppConstants.platform,
      "Setup"
    ),
    "it is told as a setup that failed, with its button"
  );
  Assert.notEqual(
    failed.line.text,
    SvalPanelModel.pairingLine({ failure: "key-store" }, AppConstants.platform)
      .text,
    "and never as a pairing"
  );
  Assert.equal(failed.message, failed.line.text, "first run shows the same");

  const joined = await panel.chooseSharedFolder(root, { mint: true });
  Assert.ok(joined.joined, `the same folder joins again: ${joined.message}`);
  Assert.deepEqual(
    asArray(panel.engine.syncKey),
    asArray(us.ourKey),
    "under the key found there"
  );
});

/**
 * A device that moves to another folder, on the same sync key, leaves its
 * sealed copy there too, so Sval installed again and pointed at either folder
 * finds the key.
 */
add_task(async function each_folder_gets_the_sealed_key_copy() {
  const first = await makeTempDir("sval-first-folder");
  const win = await sharingInstallation(first);
  const second = await makeTempDir("sval-second-folder");
  Assert.ok(
    (await win.SvalPanel.chooseSharedFolder(second)).reached,
    "the device moves to the second folder"
  );
  await keyCopyIn(second, "the second folder holds a sealed copy");
  await keyCopyIn(first, "and the first still holds its own");
});

/**
 * A new Mac, which holds no sealed copy it can open, finds the sync key in
 * iCloud Keychain and joins with no code (decision 0084). A key there that
 * opens nothing in this folder is not taken.
 *
 * iCloud Keychain is reached through the Security framework with this
 * build's entitlement, which no test build carries, so its read stands in.
 */
add_task(async function a_key_in_icloud_keychain_joins_a_new_mac() {
  const root = await makeTempDir("sval-icloud");
  const { syncKey: ourKey } = await svalKeys();
  const us = await peerPublishing(root, ourKey, "Made on the other Mac");
  const { SvalICloudKeychain } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalICloudKeychain.sys.mjs"
  );
  const realRead = SvalICloudKeychain.read;
  atTaskEnd(() => {
    SvalICloudKeychain.read = realRead;
  });

  // A new Mac: the folder holds no sealed copy, so only iCloud Keychain can
  // answer.
  const panel = (await installedAgain("icloud", ourKey)).win.SvalPanel;

  SvalICloudKeychain.read = () => randomBytes(32);
  Assert.ok(
    (await panel.chooseSharedFolder(root, { mint: true })).otherWorkspaces,
    "a key that opens nothing here is not taken"
  );

  SvalICloudKeychain.read = () => Uint8Array.from(ourKey);
  const joined = await panel.chooseSharedFolder(root, { mint: true });
  Assert.ok(joined.joined, `the user's key from iCloud Keychain is taken`);
  Assert.ok(us.id in panel.nodes, "and opens the other Mac's workspaces");
  Assert.deepEqual(
    asArray(panel.engine.syncKey),
    asArray(ourKey),
    "under that key"
  );
});

/**
 * A profile that last ran on another computer is asked with Firefox's plain
 * prompt, and its two buttons answer "moved" and "new device".
 * Dismissing it is "new device".
 */
add_task(async function a_profile_from_another_computer_is_asked() {
  const { PromptTestUtils } = ChromeUtils.importESModule(
    "resource://testing-common/PromptTestUtils.sys.mjs"
  );
  for (const [click, moved] of [
    [0, true],
    [1, false],
  ]) {
    const shown = PromptTestUtils.waitForPrompt(null, {
      modalType: Services.prompt.MODAL_TYPE_WINDOW,
      promptType: "confirmEx",
    }).then(dialog => {
      const ui = dialog.ui;
      Assert.ok(
        ui.button0.label && ui.button1.label,
        "the move and a new device each have a button"
      );
      return PromptTestUtils.handlePrompt(dialog, { buttonNumClick: click });
    });
    Assert.equal(SvalIdentity.askIfMoved(), moved, `button ${click} answers`);
    await within(shown, 10_000, "the moved-here prompt");
  }
});
