/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The sync key on Sval's settings page (key-storage spec): where it is kept,
 * and a device that finds another key's workspaces in its folder making no
 * key of its own.
 */

const { SvalSharedFolder } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
);
const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { SvalIdentity } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalIdentity.sys.mjs"
);
const { pairingLine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);
const { SYNC_DOCUMENT } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTree.sys.mjs"
);
const { HISTORY_INDEX } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalHistorySync.sys.mjs"
);
const { SvalSecretStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSecretStore.sys.mjs"
);
const { SvalTestDeny } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestDeny.sys.mjs"
);

const SVAL_DIALOG = "chrome://browser/content/sval/sval-dialog.xhtml";
/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_feedback_helpers.js */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_feedback_helpers.js",
  this
);

/**
 * A machine with no keyring keeps the sync key in the profile, and Settings
 * says so under storage; a machine with one says nothing (key-storage spec,
 * "What each system store does to Sval").
 */
add_task(async function storage_says_when_the_sync_key_is_in_the_profile() {
  await svalKeys();
  const ui = await openSvalSettings("storage");
  const line = ui.page.document.getElementById("sval-storage-keyring");

  await ui.settings._describeKeyring();
  Assert.ok(line.hidden, "a machine with a keyring is told nothing");

  const realPath = SvalSecretStore.path;
  SvalSecretStore.path = tempPath("sval-secrets-keyring", ".json");
  try {
    await IOUtils.writeJSON(SvalSecretStore.path, {
      backend: SvalSecretStore.BACKENDS.profile,
      label: "sval secrets test",
      secrets: {},
    });
    await ui.settings._describeKeyring();
    Assert.ok(!line.hidden, "one with no keyring is told where the key is");
  } finally {
    await IOUtils.remove(SvalSecretStore.path, { ignoreAbsent: true });
    SvalSecretStore.path = realPath;
  }
});

/**
 * A Mac that syncs is told to look for the Keychain item by name, so the
 * name Settings gives is the one the system store holds the secret under.
 */
add_task(async function the_keychain_line_names_the_item_sval_stores() {
  const { MemoryKeyStore } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSecretStore.sys.mjs"
  );
  const previous = {
    path: SvalSecretStore.path,
    keyStore: SvalSecretStore.keyStore,
    systemStoreUsable: SvalSecretStore.systemStoreUsable,
  };
  const keyStore = new MemoryKeyStore();
  SvalSecretStore.path = tempPath("sval-secrets-keychain", ".json");
  SvalSecretStore.keyStore = keyStore;
  SvalSecretStore.systemStoreUsable = true;
  let labels;
  try {
    await SvalSecretStore.write("probe", new Uint8Array([1, 2, 3]));
    labels = [...keyStore.secrets.keys()];
  } finally {
    await IOUtils.remove(SvalSecretStore.path, { ignoreAbsent: true });
    Object.assign(SvalSecretStore, previous);
  }
  Assert.equal(labels.length, 1, "the system store holds one item");

  const ui = await openSvalSettings("storage");
  const line = ui.page.document.getElementById("sval-storage-keychain");
  Assert.ok(
    line.textContent.replace(/\s+/g, " ").includes(`"${labels[0]}"`),
    "Settings names the item the system store holds"
  );
});

/**
 * Publishes one workspace into `shared` under a key of its own: another
 * device's workspaces, which this one cannot read.
 *
 * @param {string} shared
 */
async function anotherKeysWorkspaces(shared) {
  const { folder } = await panelOnAFolderless();
  // The other device chose the folder, which made `sval/` in it.
  await IOUtils.makeDirectory(PathUtils.join(shared, "sval"));
  const theirs = new SvalEngine({
    root: await folder("theirs"),
    sharedRoot: shared,
    keyBytes: randomBytes(32),
    deviceId: randomBytes(16),
  });
  registerCleanupFunction(() => stopEngine(theirs));
  await theirs.mutate({
    kind: "addWorkspace",
    name: "Theirs",
    now: Date.now(),
  });
  await SvalSharedFolder._whenIdle();
  await theirs.sync(SYNC_DOCUMENT, Date.now());
  await SvalSharedFolder._whenIdle();
}

/** A folder maker for a task that needs folders and no panel of its own. */
async function panelOnAFolderless() {
  return { folder: name => makeTempDir(`sval-settings-${name}`) };
}

/**
 * A new window of this profile as a device that has never shared starts it:
 * its identity file records no sync key, so `SvalIdentity.syncKey()` answers
 * `none` to the window's startup. The key this profile shares under is
 * adopted afresh when the task ends.
 *
 * @returns {Promise<Window>}
 */
async function aWindowThatNeverShared() {
  const path = SvalIdentity._identityPath();
  const identity = await IOUtils.readJSON(path);
  delete identity.syncKeyFingerprint;
  delete identity.adoptingSyncKeyFingerprint;
  atTaskEnd(() => svalKeys());
  await IOUtils.writeJSON(path, identity);
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    20_000,
    "a new window's opening"
  );
  expectWorkspaceTabs(win);
  await within(win.SvalPanel.started, 40_000, "its panel's startup");
  Assert.equal(
    win.SvalPanel.syncKeyState,
    SvalIdentity.SYNC_KEY_STATES.none,
    "the window starts with no sync key"
  );
  return win;
}

/**
 * Resolves once `win` shows the sync key's backup, which a key made or
 * replaced offers on a later turn, and closes it.
 *
 * @param {Window} win
 * @returns {Promise<void>}
 */
async function backupOffered(win) {
  let dialog;
  await TestUtils.waitForCondition(() => {
    dialog = win.gDialogBox.dialog;
    return dialog?._openedURL?.includes("backup-key") && !dialog._isClosing;
  }, "the backup is offered");
  await dialogShown(dialog, "the backup's load");
  dialog._frame.contentWindow.close();
  await TestUtils.waitForCondition(
    () => win.gDialogBox.dialog !== dialog,
    "the backup closes"
  );
}

/**
 * Presses `button` in the Sval dialog `win` opens: `"primary"` or a
 * button's id, such as `"cancel"`.
 *
 * @param {Window} win
 * @param {string} button
 */
async function answerSvalDialog(win, button) {
  let dialog;
  await TestUtils.waitForCondition(() => {
    dialog = win.gDialogBox.dialog;
    return dialog?._openedURL === SVAL_DIALOG && !dialog._isClosing;
  }, "Sval's dialog opens");
  await dialogShown(dialog, "the dialog's load");
  const selector =
    button === "primary"
      ? ".sval-dialog-actions .primary"
      : `.sval-dialog-actions [data-button="${button}"]`;
  let target;
  await TestUtils.waitForCondition(() => {
    target = dialog._frame.contentDocument?.querySelector(selector);
    return target;
  }, "the dialog draws its buttons");
  target.click();
}

/**
 * A new window of this profile whose startup failed, because the identity
 * file could not be read while it started: it has a settings store and no
 * engine. It is the most recent window, so the settings page asks its panel.
 *
 * @returns {Promise<Window>}
 */
async function aWindowThatFailedToStart() {
  const identity = SvalIdentity._identityPath();
  SvalIdentity.forgetCachedValues();
  await SvalTestDeny.read(identity);
  let win;
  try {
    win = await within(
      BrowserTestUtils.openNewBrowserWindow(),
      20_000,
      "a new window's opening"
    );
    await within(win.SvalPanel.started, 40_000, "its failed startup");
  } finally {
    await SvalTestDeny.allow(identity);
    SvalIdentity.forgetCachedValues();
  }
  expectWorkspaceTabs(win);
  Assert.strictEqual(win.SvalPanel.engine, null, "its startup failed");
  return win;
}

/**
 * Opens a new window, has it reach the shared folder, and waits for the look
 * for another key's workspaces its first reach starts
 * (`_afterReachingFolder`). A window looks at most once per
 * `_otherWorkspacesCheckMs`, so a look after the harness window's first is
 * a new window's.
 *
 * @returns {Promise<Window>}
 */
async function aWindowThatLooked() {
  const shared = SvalPanel.sharedRootSetting();
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    20_000,
    "a new window's opening"
  );
  expectWorkspaceTabs(win);
  await within(win.SvalPanel.started, 40_000, "its panel's startup");
  await within(SvalSharedFolder._whenIdle(), 45_000, "the helper's exit");
  await TestUtils.waitForCondition(
    async () => (await win.SvalPanel.syncWithFolder()) === "reached",
    "the window reaches the folder"
  );
  // A window's first look records the folder it looked in, whatever it found.
  await TestUtils.waitForCondition(
    () => win.SvalPanel._otherWorkspacesIn === shared,
    "the window's first look ended"
  );
  return win;
}

/**
 * The directories in the shared folder's `sval/ws`.
 *
 * @param {string} shared
 * @returns {Promise<string[]>}
 */
async function workspaceDirs(shared) {
  await within(SvalSharedFolder._whenIdle(), 45_000, "the helper's exit");
  return (
    await SvalSharedFolder.listNames({
      root: shared,
      path: "sval/ws",
      deadline: Date.now() + 20000,
    })
  ).names;
}

/**
 * A device setting up to share makes no key for a folder that already holds
 * Sval workspaces, and says how to sync with them instead; an empty folder
 * gets a key (key-storage spec, "Becoming a syncing device").
 */
add_task(async function a_folder_with_sval_workspaces_mints_no_key() {
  const { folder } = await panelOnAFolder("mint-check");
  const occupied = await folder("occupied");
  await anotherKeysWorkspaces(occupied);
  const win = await aWindowThatNeverShared();

  const before = win.SvalPanel.sharedRootSetting();
  const refused = await win.SvalPanel.chooseSharedFolder(occupied, {
    mint: true,
  });
  Assert.ok(refused.otherWorkspaces, "the folder's workspaces are named");
  Assert.ok(refused.message, "and the way to join them is said");
  Assert.equal(
    (await SvalIdentity.syncKey()).state,
    SvalIdentity.SYNC_KEY_STATES.none,
    "no key was made"
  );
  Assert.equal(
    win.SvalPanel.sharedRootSetting(),
    before,
    "the folder is unset"
  );

  const empty = await folder("empty");
  const offered = backupOffered(win);
  await win.SvalPanel.chooseSharedFolder(empty, { mint: true });
  Assert.equal(
    (await SvalIdentity.syncKey()).state,
    SvalIdentity.SYNC_KEY_STATES.present,
    "an empty folder gets a key"
  );
  await within(offered, 10_000, "and its backup is offered");
});

/**
 * A key that cannot be made because the system store will not answer, as when
 * a Mac's Keychain prompt is denied, is told apart from any other failure, so
 * first run can offer to ask again. The folder is left unset either way.
 *
 * The store is automation's (`MemoryKeyStore`), refusing through its own
 * `failing`; the other failure is a secrets file that cannot be read.
 */
add_task(async function a_refused_key_store_is_told_apart() {
  const { folder } = await panelOnAFolder("refused");
  const empty = await folder("empty");
  const win = await aWindowThatNeverShared();
  const before = win.SvalPanel.sharedRootSetting();

  const store = SvalSecretStore.keyStore;
  Assert.ok(store?.failing, "the profile's secrets are in automation's store");
  atTaskEnd(() => {
    delete store.failing.asyncGetRecoveryPhrase;
    SvalSecretStore.retry();
  });
  store.failing.asyncGetRecoveryPhrase = new Error("refused");
  SvalSecretStore.retry();
  const refused = await win.SvalPanel.chooseSharedFolder(empty, {
    mint: true,
  });
  Assert.ok(!refused.reached, "a refused store sets nothing up");
  Assert.ok(refused.keyStoreRefused, "and is named as a refusal");
  Assert.equal(
    win.SvalPanel.sharedRootSetting(),
    before,
    "the folder is unset"
  );
  delete store.failing.asyncGetRecoveryPhrase;
  SvalSecretStore.retry();

  const secrets = PathUtils.join(PathUtils.profileDir, "sval-secrets.json");
  atTaskEnd(() => SvalTestDeny.allow(secrets));
  await SvalTestDeny.read(secrets);
  const failed = await win.SvalPanel.chooseSharedFolder(empty, { mint: true });
  Assert.ok(!failed.reached, "another failure sets nothing up");
  Assert.ok(!failed.keyStoreRefused, "and is no refusal");
  await SvalTestDeny.allow(secrets);
});

/**
 * Another key's workspaces turning up after this device made its own put the
 * indicator in its unpaired state, offering to pair, and a dismissed one is
 * not raised again.
 */
add_task(async function another_keys_workspaces_found_later_are_offered() {
  const { settings } = await panelOnAFolder("found-later", { shared: true });
  const shared = SvalPanel.sharedRootSetting();
  const first = await aWindowThatLooked();
  Assert.deepEqual(first.SvalPanel._otherWorkspaces, [], "nothing at first");

  const ours = await workspaceDirs(shared);
  await anotherKeysWorkspaces(shared);
  const theirs = (await workspaceDirs(shared)).filter(
    name => !ours.includes(name)
  );
  const win = await aWindowThatLooked();
  const { indicator, syncActions } = win.SvalPanel._els;
  Assert.equal(
    indicator.dataset.state,
    "unpaired-device",
    "the indicator says so"
  );
  Assert.ok(
    syncActions.querySelector('[data-command="pairAgain"]'),
    "with the way to sync with them"
  );

  syncActions.querySelector('[data-command="dismissOtherWorkspaces"]').click();
  Assert.ok(
    !syncActions.querySelector('[data-command="dismissOtherWorkspaces"]'),
    "dismissing takes the state away"
  );
  Assert.ok(
    theirs.length &&
      theirs.every(name => settings.isDismissedOtherWorkspace(name)),
    "the dismissal is kept with this device's settings"
  );
  const later = await aWindowThatLooked();
  Assert.deepEqual(
    later.SvalPanel._otherWorkspaces,
    [],
    "and it is not raised again"
  );
});

/**
 * A week of history another device of this key published, which this device
 * has never held, is this key's: the history index names it (history-sync
 * spec §2). The indicator stays out of its unpaired state.
 */
add_task(async function a_peers_document_under_this_key_is_not_another_keys() {
  await panelOnAFolder("peer-document", { shared: true });
  const shared = SvalPanel.sharedRootSetting();
  // This device's tree reaches the folder first, as a joined device's does.
  await SvalPanel.engine.sync(SYNC_DOCUMENT, Date.now());

  const { syncKey } = await svalKeys();
  const peer = new SvalEngine({
    root: await makeTempDir("sval-settings-peer"),
    sharedRoot: shared,
    keyBytes: syncKey,
    deviceId: randomBytes(16),
  });
  registerCleanupFunction(() => stopEngine(peer));
  const week = "history-2020-W01";
  await peer.addDocument(week);
  await peer.mutate({
    kind: "addVisit",
    document: week,
    url: "https://example.com/visited",
    title: "Visited",
    visitedAt: Date.UTC(2020, 0, 1),
    transition: 1,
    workspace: null,
  });
  await peer.addDocument(HISTORY_INDEX);
  await peer.mutate({
    kind: "touchShard",
    document: HISTORY_INDEX,
    name: week,
    now: Date.now(),
  });
  await SvalSharedFolder._whenIdle();
  const report = await peer.sync(SYNC_DOCUMENT, Date.now());
  Assert.ok(
    report.exchanged && week in report.exchanged,
    "the peer published the week into the folder"
  );
  await SvalSharedFolder._whenIdle();
  // This device's pass merges the peer's index, as every pass does.
  await SvalPanel.engine.addDocument(HISTORY_INDEX);
  await SvalPanel.engine.sync(SYNC_DOCUMENT, Date.now());

  const win = await aWindowThatLooked();
  Assert.deepEqual(
    win.SvalPanel._otherWorkspaces,
    [],
    "the peer's week is this key's"
  );
  Assert.notEqual(
    win.SvalPanel._els.indicator.dataset.state,
    "unpaired-device",
    "and the indicator does not offer to pair"
  );
});

/**
 * Starts the page's Set Up Sync Again and, when `answer` names one, presses
 * that button in the confirmation the panel's window shows.
 *
 * @param {object} ui `openSvalSettings`'s result.
 * @param {string|null} answer `"primary"`, `"cancel"`, or null for none.
 * @returns {Promise<object>} `{ reason, status, buttons }` of the key's line.
 */
async function setUpAgainFromSettings(ui, answer) {
  const byId = id => ui.page.document.getElementById(id);
  await within(SvalSharedFolder._whenIdle(), 45_000, "the helper's exit");
  const pressed = ui.settings.setUpSyncAgain();
  if (answer) {
    await answerSvalDialog(window, answer);
  }
  await within(pressed, 45_000, "Set Up Sync Again");
  const status = byId("sval-key-status");
  return {
    reason: status.dataset.reason,
    status: status.dataset.status,
    buttons: [...byId("sval-key-result-actions").children].map(
      each => each.dataset.command
    ),
  };
}

/**
 * Set Up Sync Again says how it went under the sync key (messages spec §7):
 * on success, a line and the way to show another device a code; on failure,
 * the join line with "Setup failed:"; on a declined confirmation, nothing.
 */
add_task(async function set_up_sync_again_says_how_it_went() {
  await panelOnAFolder("set-up-again", { shared: true });
  const shared = SvalPanel.sharedRootSetting();
  const ui = await openSvalSettings();
  const byId = id => ui.page.document.getElementById(id);
  const status = byId("sval-key-status");
  const actions = byId("sval-key-result-actions");
  Assert.ok(
    byId("sval-set-up-again").textContent.trim(),
    "Set up sync again is offered"
  );

  let offered = backupOffered(window);
  Assert.deepEqual(await setUpAgainFromSettings(ui, "primary"), {
    reason: "set-up",
    status: "success",
    buttons: ["offerCode"],
  });
  await within(offered, 10_000, "the new key's backup");

  const sval = PathUtils.join(shared, "sval");
  atTaskEnd(() => SvalTestDeny.allow(sval));
  await SvalTestDeny.read(sval);
  await within(SvalSharedFolder._whenIdle(), 45_000, "the helper's exit");
  Assert.deepEqual(await setUpAgainFromSettings(ui, "primary"), {
    reason: "folder",
    status: "error",
    buttons: ["tryAgain"],
  });
  await SvalTestDeny.allow(sval);

  await within(SvalSharedFolder._whenIdle(), 45_000, "the helper's exit");
  await SvalPanel.chooseSharedFolder(null);
  Assert.deepEqual(await setUpAgainFromSettings(ui, null), {
    reason: "no-folder",
    status: "error",
    buttons: ["chooseSharedFolder"],
  });
  const said = status.textContent;

  // Declining leaves what was said before.
  await SvalPanel.chooseSharedFolder(shared);
  Assert.equal(
    (await setUpAgainFromSettings(ui, "cancel")).reason,
    "no-folder",
    "a declined confirmation says nothing new"
  );
  Assert.equal(status.textContent, said, "in the same words");

  offered = backupOffered(window);
  await setUpAgainFromSettings(ui, "primary");
  await within(offered, 10_000, "the new key's backup");
  const paneShown = TestUtils.waitForCondition(
    () => byId("sval-devices").dataset.path === "offer",
    "Show Code… opens the offering side"
  );
  actions.firstElementChild.click();
  await within(paneShown, 10_000, "the offering side");
  BrowserTestUtils.removeTab(ui.tab);
});

/**
 * The key store's line names this platform's store, and its button is the
 * indicator's: Try Again on Windows, Allow Access elsewhere (messages spec
 * §3 and §7). The store is automation's (`MemoryKeyStore`), refusing through
 * its own `failing` as the new key is stored.
 */
add_task(async function a_key_store_failure_names_the_store() {
  await panelOnAFolder("key-store", { shared: true });
  const ui = await openSvalSettings();
  const byId = id => ui.page.document.getElementById(id);
  const store = SvalSecretStore.keyStore;
  Assert.ok(store?.failing, "the profile's secrets are in automation's store");
  atTaskEnd(() => {
    delete store.failing.asyncGetRecoveryPhrase;
    SvalSecretStore.retry();
  });
  store.failing.asyncGetRecoveryPhrase = new Error("refused");
  SvalSecretStore.retry();
  await within(SvalSharedFolder._whenIdle(), 45_000, "the helper's exit");
  await setUpAgainFromSettings(ui, "primary");
  const line = pairingLine(
    { failure: "key-store" },
    AppConstants.platform,
    "Setup"
  );
  Assert.equal(
    byId("sval-key-status").dataset.reason,
    "key-store",
    "the line is the key store's"
  );
  Assert.equal(
    byId("sval-key-status").textContent,
    line.text,
    "naming this platform's store"
  );
  const buttons = [...byId("sval-key-result-actions").children];
  Assert.deepEqual(
    buttons.map(each => [each.dataset.command, each.textContent]),
    [["tryAgain", line.action.label]],
    "with the indicator's button for this platform"
  );
  BrowserTestUtils.removeTab(ui.tab);
});

/**
 * A restore from a backup says it worked when it did, and "Restore failed:"
 * with the pairing line's button when the key fitted and the join did not:
 * here the folder refuses this device's file in the key's directory.
 */
add_task(async function a_restore_says_how_it_went() {
  const { backupCode } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
  );
  await panelOnAFolder("restore", { shared: true });
  const shared = SvalPanel.sharedRootSetting();
  const theirKey = randomBytes(32);
  const them = new SvalEngine({
    root: shared,
    keyBytes: theirKey,
    deviceId: randomBytes(16),
  });
  atTaskEnd(() => stopEngine(them));
  await them.mutate({
    kind: "addWorkspace",
    name: "Theirs",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  await within(SvalSharedFolder._whenIdle(), 45_000, "the helper's exit");
  const { wrote } = await them.sync(SYNC_DOCUMENT, Date.now());
  const theirDir = PathUtils.parent(
    PathUtils.join(shared, ...wrote.split("/"))
  );

  const ui = await openSvalSettings();
  const byId = id => ui.page.document.getElementById(id);
  const status = byId("sval-key-status");
  const actions = byId("sval-key-result-actions");
  const code = byId("sval-restore-code");

  atTaskEnd(() => SvalTestDeny.allow(theirDir));
  await SvalTestDeny.write(theirDir);
  await within(SvalSharedFolder._whenIdle(), 45_000, "the helper's exit");
  code.value = backupCode(theirKey);
  await within(ui.settings.restoreFromBackup(), 45_000, "the restore");
  Assert.equal(
    status.dataset.reason,
    "folder",
    "the folder could not be reached"
  );
  Assert.equal(status.dataset.status, "error");
  Assert.deepEqual(
    [...actions.children].map(each => each.dataset.command),
    ["tryAgain"]
  );

  await SvalTestDeny.allow(theirDir);
  await within(SvalSharedFolder._whenIdle(), 45_000, "the helper's exit");
  actions.firstElementChild.click();
  await TestUtils.waitForCondition(
    () => status.dataset.status === "success",
    "Try Again restores again"
  );
  Assert.equal(actions.childElementCount, 0, "with nothing to press");

  code.value = "not a key";
  await within(ui.settings.restoreFromBackup(), 10_000, "the restore");
  Assert.ok(!("status" in status.dataset), "a typing mistake has no glyph");
  Assert.equal(code.getAttribute("aria-invalid"), "true", "on the field");
  BrowserTestUtils.removeTab(ui.tab);
});

/**
 * Send Report… in Settings opens the feedback form with the failure and the
 * sync state as its context, and once the form has sent, says so and is
 * done (feedback spec §2). The collector is on localhost. The failure is
 * Set Up Sync Again in a window whose startup failed, which holds no engine.
 */
add_task(async function send_report_opens_the_form_from_settings() {
  await panelOnAFolder("report", { shared: true });
  await appDataInTemp();
  await feedbackServer();
  atTaskEnd(() => discardFeedbackDraft());
  const ui = await openSvalSettings();
  const failed = await aWindowThatFailedToStart();
  Assert.equal(ui.settings.panel, failed.SvalPanel, "the page asks it");
  const byId = id => ui.page.document.getElementById(id);
  const actions = byId("sval-key-result-actions");
  await setUpAgainFromSettings(ui, null);
  const button = actions.querySelector("button");
  Assert.equal(button.dataset.command, "sendReport");
  const unsent = button.textContent;
  button.click();
  const form = await feedbackShown();
  const parts = formParts(form);
  const indicator = failed.SvalPanel.syncIndicator();
  Assert.ok(
    indicator &&
      [indicator.severity, indicator.label]
        .filter(Boolean)
        .every(part => parts.context.textContent.includes(part)),
    "the form has the sync state as its context"
  );
  parts.message.focus();
  EventUtils.sendString("Setting up sync again failed.", window);
  parts.send.click();
  await TestUtils.waitForCondition(
    () => form.dataset.state === "sent",
    "the report is sent"
  );
  parts.close.click();
  Assert.notEqual(button.textContent, unsent, "the button says so");
  Assert.ok(button.disabled, "and is done");
  BrowserTestUtils.removeTab(ui.tab);
});
