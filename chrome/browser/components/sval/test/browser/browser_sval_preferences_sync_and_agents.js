/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */

/**
 * Sval's Sync and Agents categories of about:preferences (spec §10.8): in
 * each state the Sync and devices page can be brought to, it shows that
 * state's parts and buttons alone, saying what the footer says; the sync
 * folder's field changes and reveals the folder; Add a device shows only its
 * own steps; and agent access is the pref and says why it could not start.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

const MockFilePicker = SpecialPowers.MockFilePicker;
const { friendlyFolderName } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);
const { SvalIdentity } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalIdentity.sys.mjs"
);
const { SvalSecretStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSecretStore.sys.mjs"
);
const { SvalTestDeny } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestDeny.sys.mjs"
);

add_setup(async function () {
  MockFilePicker.init();
  registerCleanupFunction(() => MockFilePicker.cleanup());
  await within(SvalPanel.started, 10_000, "the panel starting");
});

add_task(async function the_folder_field_shows_changes_and_reveals() {
  const icloud = PathUtils.join(
    await makeTempDir("sval-home"),
    "Library",
    "Mobile Documents",
    "com~apple~CloudDocs"
  );
  await IOUtils.makeDirectory(icloud, { createAncestors: true });
  await panelWithFolder(icloud);
  const ui = await openSettings("storage");
  const field = ui.byId("sval-folder-field");
  Assert.ok(!field.hidden, "the folder is shown as a field");
  Assert.equal(
    ui.byId("sval-folder-name").textContent,
    friendlyFolderName(icloud),
    "named as the panel names it"
  );
  Assert.equal(ui.byId("sval-folder-path").textContent, icloud);
  await TestUtils.waitForCondition(
    () => ui.byId("sval-storage").dataset.state === "synced",
    "the folder syncs"
  );
  assertOnlyPageControls(ui, {
    primary: "syncNow",
    shown: [
      "sval-folder-field",
      "sval-folder-reveal",
      "sval-storage-change",
      "sval-storage-stop",
      "sval-backup-missing",
      "sval-pairing-start",
      "sval-sync-advanced",
    ].filter(
      id => id !== "sval-backup-missing" || !SvalPanel.settings.backupSaved
    ),
  });

  // Revealing opens the system's file manager, outside the browser.
  const revealed = [];
  ui.settings._reveal = path => revealed.push(path);
  ui.byId("sval-folder-reveal").click();
  Assert.deepEqual(revealed, [icloud], "reveal shows the folder");

  const other = await makeTempDir("sval-other");
  MockFilePicker.useDirectory(other);
  ui.byId("sval-storage-change").click();
  ui.page.document
    .querySelector('#sval-location-dialog button[data-command="chooseLocal"]')
    .click();
  await TestUtils.waitForCondition(
    () => SvalPanel.sharedRootSetting() === other,
    "Change… makes the picked folder the shared one"
  );
  await TestUtils.waitForCondition(
    () => ui.byId("sval-folder-path").textContent === other,
    "and the field shows it"
  );
});

add_task(async function the_sync_readout_says_one_state() {
  await panelWithFolder(await makeTempDir("sval-shared"));
  Assert.equal(
    SvalPanel.syncState.folderState,
    "reached",
    "the folder answers"
  );
  const ui = await openSettings();
  const state = ui.byId("sval-sync-state");
  const syncNow = () =>
    ui.page.document.querySelector(
      '#sval-sync-buttons sval-button[data-command="syncNow"]'
    );
  const status = ui.byId("sval-storage-status");
  Assert.equal(state.dataset.state, "synced");
  Assert.equal(
    ui.byId("sval-sync-status").textContent,
    SvalPanel.syncIndicator().tooltip,
    "it says what the footer's indicator says"
  );

  syncNow().click();
  Assert.equal(state.dataset.state, "syncing", "pressing Sync now syncs");
  Assert.ok(syncNow().disabled, "and holds the button while it does");
  await TestUtils.waitForCondition(
    () => !ui.settings._syncOutcome,
    "the pass came back"
  );
  Assert.equal(state.dataset.state, "synced", "then says it synced");
  Assert.equal(status.textContent, "", "with nothing more to say");

  // A pass fails when it cannot save this device's copy in the profile, as
  // a directory that refuses a new file makes it fail.
  const wrote = SvalPanel.syncState.lastPass?.wrote;
  Assert.ok(wrote, "the pass saved this device's copy");
  const ownDir = PathUtils.parent(
    PathUtils.join(SvalPanel.engine.root, ...wrote.split("/"))
  );
  await SvalTestDeny.write(ownDir);
  atTaskEnd(async () => {
    await SvalTestDeny.allow(ownDir);
    await within(SvalPanel.syncNow(), 30_000, "a pass that saves again");
  });
  await SvalPanel.engine.mutate({
    kind: "addWorkspace",
    name: "Needs saving",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  syncNow().click();
  await TestUtils.waitForCondition(
    () => status.dataset.reason === "sync-failed",
    "a pass that failed says so"
  );
  Assert.equal(status.dataset.status, "error", "as an error");
  const said = status.textContent;
  // The panel redraws its rows whenever a tab changes, and a redraw runs no
  // pass: what the last one said stays until the state moves on.
  SvalPanel.render();
  Assert.equal(
    status.textContent,
    said,
    "and the panel redrawing leaves it said"
  );
});

/**
 * A pass that could not read this device's own file in the folder shows no
 * fault: Sval recovers that file (messages spec §3, §8.2), and the readout
 * says what the footer's indicator says.
 */
add_task(async function an_unreadable_own_file_shows_no_fault() {
  const shared = await makeTempDir("sval-shared");
  await panelWithFolder(shared);
  const wrote = SvalPanel.syncState.lastPass?.sharedWrote;
  Assert.ok(wrote, "this device published its file");
  const own = PathUtils.join(shared, ...wrote.split("/"));
  await SvalTestDeny.read(own);
  atTaskEnd(() => SvalTestDeny.allow(own));
  const ui = await openSettings();
  ui.page.document
    .querySelector('#sval-sync-buttons sval-button[data-command="syncNow"]')
    .click();
  await TestUtils.waitForCondition(
    () => !ui.settings._syncOutcome,
    "the pass came back"
  );
  Assert.equal(
    SvalPanel.syncState.folderState,
    "unreachable",
    "the read was refused"
  );
  Assert.equal(SvalPanel.syncIndicator().severity, "synced");
  Assert.equal(ui.byId("sval-storage").dataset.state, "synced");
  Assert.equal(ui.byId("sval-storage-status").textContent, "");
});

/**
 * A device whose sync key is gone says sync is off once, and offers only the
 * ways to get the key back: nothing that changes the folder, syncs it, or
 * gives another device a key this one lacks (messages spec §3, key-storage
 * spec "Starting up").
 */
add_task(async function a_gone_key_offers_only_the_ways_back() {
  const shared = await makeTempDir("sval-shared");
  await panelWithFolder(shared);
  // With no sealed copy of the key in the folder, Enter code's Next has none
  // to find and asks for the code (key-storage spec, "Installing again").
  const { SvalSharedFolder } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
  );
  await within(SvalSharedFolder._whenIdle(), 45_000, "the helper's exit");
  await IOUtils.remove(PathUtils.join(shared, "sval", "keys"), {
    recursive: true,
    ignoreAbsent: true,
  });
  // A sync key gone from the store is missing once the panel reads it again,
  // as the indicator's Allow Access does.
  const key = await SvalSecretStore.read("sync key");
  Assert.ok(key, "this device holds a sync key");
  const putBack = async () => {
    await SvalIdentity.adoptSyncKey(key);
    await within(SvalPanel.run("retrySyncKey"), 30_000, "the key read again");
  };
  await SvalSecretStore.remove("sync key");
  atTaskEnd(async () => {
    if (SvalPanel.syncState.keyState !== SvalIdentity.SYNC_KEY_STATES.present) {
      await putBack();
    }
  });
  await within(SvalPanel.run("retrySyncKey"), 30_000, "the key read again");
  Assert.equal(
    SvalPanel.syncState.keyState,
    SvalIdentity.SYNC_KEY_STATES.missing
  );

  // The footer's Enter code… opens the page at the same act.
  const shown = SvalPanel.syncIndicator();
  Assert.equal(shown.state, "key-gone");
  Assert.deepEqual(
    shown.actions.map(action => action.command),
    ["pairAgain"],
    "the footer offers to enter a code"
  );
  const ui = await openSettings("claim");
  await TestUtils.waitForCondition(
    () => !paneOf(ui.page, "svalSync").hidden,
    "the Sync and devices pane is showing"
  );
  ui.settings._drawSyncPage();
  const primary = () =>
    ui.page.document.querySelector('#sval-sync-buttons [type="primary"]');
  Assert.equal(ui.byId("sval-storage").dataset.state, "key-gone");
  Assert.equal(
    primary()?.textContent,
    shown.actions[0].label,
    "the page's way back has the footer's name"
  );
  // The footer's button opens Enter code's dialog at once, with the field
  // ready: Sval finds no copy of the key in the folder to join with first.
  const win = ui.page.browsingContext.topChromeWindow;
  let asked = await svalDialogAsking(win, "enter-code");
  Assert.equal(
    asked.doc.activeElement,
    asked.input,
    "the dialog opens with the code field focused"
  );
  asked.cancel.click();
  await svalDialogClosed(win, asked, "Cancel closes the dialog");
  assertOnlyPageControls(ui, {
    primary: "enterCode",
    secondary: ["restore", "startOver"],
    shown: ["sval-folder-field", "sval-folder-reveal", "sval-storage-stop"],
  });

  // The page's own button opens the same dialog.
  primary().click();
  asked = await svalDialogAsking(win, "enter-code");
  asked.cancel.click();
  await svalDialogClosed(win, asked, "and Cancel closes it again");

  // Restore from a backup… is one dialog too.
  ui.page.document
    .querySelector('#sval-sync-buttons sval-button[data-command="restore"]')
    .click();
  asked = await svalDialogAsking(win, "restore");
  Assert.equal(asked.doc.activeElement, asked.input, "with its field focused");
  asked.cancel.click();
  await svalDialogClosed(win, asked, "and Cancel closes the backup's dialog");

  await putBack();
  Assert.equal(
    SvalPanel.syncState.keyState,
    SvalIdentity.SYNC_KEY_STATES.present
  );
  await TestUtils.waitForCondition(
    () => ui.byId("sval-storage").dataset.state === "synced",
    "and the page moves on once the key is back"
  );
  Assert.ok(
    !ui.page.document.querySelector(
      '#sval-sync-buttons sval-button[data-command="enterCode"]'
    ),
    "with no way back left to offer"
  );
});

/**
 * A folder that went away is said once, by the state, as soon as a Sync now
 * finds it missing: the pass adds no failure of its own.
 */
add_task(async function a_missing_folder_is_said_once() {
  const shared = await makeTempDir("sval-shared");
  await panelWithFolder(shared);
  const away = `${shared}-away`;
  await IOUtils.move(shared, away);
  atTaskEnd(() => IOUtils.move(away, shared));
  const ui = await openSettings();
  const status = ui.byId("sval-storage-status");
  ui.page.document
    .querySelector('#sval-sync-buttons sval-button[data-command="syncNow"]')
    .click();
  await TestUtils.waitForCondition(
    () => !ui.settings._syncOutcome,
    "the pass came back"
  );
  Assert.equal(SvalPanel.syncState.folderProblem, "gone", "the folder is gone");
  Assert.equal(status.textContent, "", "the pass adds no failure of its own");
  Assert.equal(
    ui.byId("sval-storage").dataset.state,
    "folder-missing",
    "and the page says the folder is missing at once"
  );
  assertOnlyPageControls(ui, {
    primary: "syncNow",
    secondary: [],
    shown: [
      "sval-folder-field",
      "sval-storage-change",
      "sval-storage-stop",
      "sval-pairing-start",
      "sval-sync-advanced",
      ...(SvalPanel.settings.backupSaved ? [] : ["sval-backup-missing"]),
    ],
  });
  Assert.equal(status.textContent, "", "still with no line beside it");
});

/**
 * Stands in for the shared folder for one task: every request the helper
 * gets is answered `answer`.
 *
 * @param {object} answer A `SvalSharedFolder` answer.
 */
function everyFolderRequestAnswers(answer) {
  const { SvalSharedFolder } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
  );
  const run = SvalSharedFolder._run;
  SvalSharedFolder._run = async () => answer;
  atTaskEnd(() => {
    SvalSharedFolder._run = run;
  });
}

/**
 * A folder that does not answer, on this computer or an SMB server, keeps
 * the device's Workspaces and offers to try again, naming what it can't
 * reach; a remote one has nothing on this computer to show.
 */
add_task(async function an_unreachable_folder_offers_to_try_again() {
  const { SvalRemoteFolder } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalRemoteFolder.sys.mjs"
  );
  const local = await makeTempDir("sval-shared");
  await panelWithFolder(local);
  everyFolderRequestAnswers({
    reachable: false,
    reason: "io-error",
    error: "NetworkError",
  });
  const smb = "smb://me@127.0.0.1:9/Shared/Sval";
  for (const [root, reveal] of [
    [local, true],
    [smb, false],
  ]) {
    if (root === smb) {
      await SvalRemoteFolder.keepSignIn(smb, { password: "hunter2" });
      await SvalPanel.chooseSharedFolder(smb, { mint: true });
    }
    await SvalPanel.syncWithFolder();
    Assert.equal(SvalPanel.syncState.folderProblem, "offline");
    outageRepeats();
    const ui = await openSettings();
    // A server never reached has no last-synced time to give.
    Assert.equal(
      ui.byId("sval-storage").dataset.state,
      root === smb ? "offline-never-synced" : "offline",
      root
    );
    Assert.equal(
      ui.byId("sval-folder-field").dataset.via,
      reveal ? "folder" : "smb"
    );
    assertOnlyPageControls(ui, {
      primary: "syncNow",
      shown: [
        "sval-folder-field",
        "sval-storage-change",
        "sval-storage-stop",
        "sval-pairing-start",
        "sval-sync-advanced",
        ...(SvalPanel.settings.backupSaved ? [] : ["sval-backup-missing"]),
      ],
    });
    closeSettings();
  }
});

/**
 * A folder too large to read stops sync and offers another folder, and
 * nothing that would act on the folder as if it synced.
 */
add_task(async function a_folder_too_large_offers_another() {
  await panelWithFolder(await makeTempDir("sval-shared"));
  everyFolderRequestAnswers({
    reachable: false,
    reason: "too-large",
    error: "ResponseTooLarge",
  });
  await SvalPanel.syncWithFolder();
  Assert.equal(SvalPanel.syncState.folderState, "too-large");
  const ui = await openSettings();
  Assert.equal(ui.byId("sval-storage").dataset.state, "too-large");
  assertOnlyPageControls(ui, {
    primary: "changeLocation",
    shown: [
      "sval-folder-field",
      "sval-folder-reveal",
      "sval-storage-stop",
      "sval-pairing-start",
      "sval-sync-advanced",
      ...(SvalPanel.settings.backupSaved ? [] : ["sval-backup-missing"]),
    ],
  });
});

add_task(async function the_device_flow_shows_only_the_chosen_path() {
  await panelWithFolder(await makeTempDir("sval-shared"));
  const ui = await openSettings();
  await showPane(ui.page, "svalSync");
  await TestUtils.waitForCondition(
    () => !paneOf(ui.page, "svalSync").hidden,
    "the Sync and devices pane is showing"
  );
  const open = ui.byId("sval-pairing-open");
  const offer = ui.byId("sval-path-offer-steps");
  const visible = el => !el.hidden && el.getBoundingClientRect().height > 0;
  const focused = () => ui.page.document.activeElement;

  Assert.ok(visible(open), "the devices card offers to add a device");
  Assert.ok(!visible(offer), "and shows no code until asked");

  open.click();
  Assert.ok(visible(offer), "Add a device… opens in the devices card");
  Assert.equal(open.getAttribute("aria-expanded"), "true");
  Assert.ok(ui.byId("sval-this-device").contains(offer), "in the devices card");
  Assert.ok(!visible(open), "in place of the button that opened it");
  await TestUtils.waitForCondition(
    () => visible(ui.byId("sval-offer-live")),
    "and shows the code at once, with no step before it"
  );
  Assert.equal(focused(), ui.byId("sval-offer-code"), "with the caret there");

  ui.byId("sval-offer-withdraw").click();
  await TestUtils.waitForCondition(
    () => !visible(offer),
    "Cancel code closes Add a device"
  );
  Assert.equal(open.getAttribute("aria-expanded"), "false");
  Assert.equal(focused(), open, "with the caret on the button that opened it");
  Assert.ok(
    !ui.page.document.querySelector(
      '#sval-sync-buttons sval-button[data-command="enterCode"]'
    ),
    "and a device that syncs is offered no code to enter"
  );
});

/**
 * One folder, one readout: the Sync card holds the folder, the sync state and
 * Sync now; the sync key waits in the category's Advanced; and nothing on the
 * page speaks of pairing, a word Agents uses for something else.
 */
add_task(async function the_sync_card_holds_the_folder_and_its_state() {
  await panelWithFolder(await makeTempDir("sval-shared"));
  Assert.equal(
    SvalPanel.syncState.keyState,
    SvalIdentity.SYNC_KEY_STATES.present
  );
  const ui = await openSettings();
  await showPane(ui.page, "svalSync");
  await TestUtils.waitForCondition(
    () => !paneOf(ui.page, "svalSync").hidden,
    "the Sync and devices pane is showing"
  );
  const card = ui.byId("sval-storage");
  const syncNow = ui.page.document.querySelector(
    '#sval-sync-buttons sval-button[data-command="syncNow"]'
  );
  for (const el of [
    ui.byId("sval-folder-field"),
    ui.byId("sval-sync-state"),
    syncNow,
  ]) {
    Assert.ok(card.contains(el), `the Sync card holds #${el.id || "Sync now"}`);
    Assert.ok(el.checkVisibility(), `and shows it`);
  }

  const advanced = ui.byId("sval-sync-advanced");
  Assert.ok(!advanced.hidden, "a device that syncs has its key's actions");
  Assert.ok(advanced.contains(ui.byId("sval-key")), "the key is in Advanced");
  Assert.ok(!advanced.open, "which starts closed");
  Assert.ok(!ui.byId("sval-backup-save").checkVisibility(), "so it is tucked");
  advanced.querySelector("summary").click();
  Assert.ok(ui.byId("sval-backup-save").checkVisibility(), "until opened");

  // Opened, Advanced is one card: the summary and the key's actions inside
  // one box, with no card of their own.
  const outer = advanced.getBoundingClientRect();
  for (const el of [
    advanced.querySelector("summary"),
    ui.byId("sval-backup-save"),
    ui.byId("sval-set-up-again"),
  ]) {
    const inner = el.getBoundingClientRect();
    Assert.ok(
      inner.top >= outer.top && inner.bottom <= outer.bottom,
      `${el.id || "the summary"} sits inside Advanced's card`
    );
  }
  Assert.ok(
    !advanced.querySelector(".sval-card"),
    "which holds no card of its own"
  );
  Assert.equal(
    ui.byId("sval-set-up-again").className,
    ui.byId("sval-backup-save").className,
    "and both key actions are the same kind of button"
  );
});

/**
 * With no folder the page offers the ways to choose one and nothing else: no
 * device can be added before this one syncs, and a link to Add a device
 * lands on the first way to sync.
 */
add_task(async function without_a_folder_the_page_offers_only_a_folder() {
  await panelWithFolder(null);
  const ui = await openSettings("offer");
  await TestUtils.waitForCondition(
    () => !paneOf(ui.page, "svalSync").hidden,
    "the Sync and devices pane is showing"
  );
  Assert.equal(ui.byId("sval-storage").dataset.state, "no-folder");
  assertOnlyPageControls(ui, {
    primary: null,
    shown: ["sval-location-choices"],
  });
  await TestUtils.waitForCondition(
    () => ui.page.document.activeElement === ui.byId("sval-storage-choose"),
    "the caret goes to the first way to sync"
  );
});

add_task(async function agent_access_is_the_pref() {
  // Cleared, so the switch reads the default Sval ships.
  await SpecialPowers.pushPrefEnv({
    clear: [["browser.sval.agents.enabled"]],
  });
  await panelWithFolder(null);
  const ui = await openSettings();
  await showPane(ui.page, "svalAgents");
  await TestUtils.waitForCondition(
    () => !paneOf(ui.page, "svalAgents").hidden,
    "the Agents pane is showing"
  );
  const toggle = ui.byId("sval-agents-enabled");
  Assert.ok(!toggle.checked, "off by default");
  Services.prefs.setBoolPref("browser.sval.agents.enabled", true);
  Assert.ok(toggle.checked, "follows the pref");
  toggle.click();
  Assert.ok(
    !Services.prefs.getBoolPref("browser.sval.agents.enabled"),
    "and sets it"
  );
});

/**
 * The WebDriver switch is in the Agents pane's Advanced, is the
 * pref, off by default, and is this device's alone.
 */
add_task(async function the_webdriver_switch_is_advanced_and_per_device() {
  const pref = "browser.sval.webdriver.useWorkspaceCookies";
  await SpecialPowers.pushPrefEnv({ clear: [[pref]] });
  await panelWithFolder(null);
  const ui = await openSettings();
  await showPane(ui.page, "svalAgents");
  await TestUtils.waitForCondition(
    () => !paneOf(ui.page, "svalAgents").hidden,
    "the Agents pane is showing"
  );
  const toggle = ui.byId("sval-webdriver-cookies");
  Assert.ok(!toggle.checkVisibility(), "tucked away in Agents' Advanced");
  ui.byId("sval-agents-advanced").querySelector("summary").click();
  Assert.ok(toggle.checkVisibility(), "shown once Advanced opens");
  Assert.ok(!toggle.checked, "off by default");
  // A screen reader hears the warning with the switch.
  const acc = await accessibleOf(toggle);
  Assert.ok(
    acc.description.includes(
      ui
        .byId("sval-webdriver-cookies-note")
        .textContent.replace(/\s+/g, " ")
        .trim()
    ),
    "the switch is described by its warning"
  );
  toggle.click();
  Assert.ok(Services.prefs.getBoolPref(pref), "turning it on sets the pref");
  Services.prefs.setBoolPref(pref, false);
  Assert.ok(!toggle.checked, "and it follows the pref");

  const { SvalSettingsRegistry } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSettingsRegistry.sys.mjs"
  );
  Assert.ok(
    !SvalSettingsRegistry.SYNCED_PREFS.includes(pref),
    "it does not sync"
  );
});

/**
 * Agent access switched on with nothing listening says why in the section,
 * as well as in the log, and the line goes once access starts.
 */
add_task(async function agent_access_says_why_it_could_not_start() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.sval.agents.enabled", false]],
  });
  const dir = PathUtils.join(PathUtils.profileDir, "sval-agents");
  const agentsFile = PathUtils.join(dir, "agents.json");
  await IOUtils.makeDirectory(dir, { permissions: 0o700 });
  const kept = (await IOUtils.exists(agentsFile))
    ? await IOUtils.read(agentsFile)
    : null;
  registerCleanupFunction(async () => {
    if (kept) {
      await IOUtils.write(agentsFile, kept);
    } else {
      await IOUtils.remove(agentsFile, { ignoreAbsent: true });
    }
  });
  await IOUtils.writeUTF8(agentsFile, "{ not json");

  await panelWithFolder(null);
  const ui = await openSettings();
  await showPane(ui.page, "svalAgents");
  await TestUtils.waitForCondition(
    () => !paneOf(ui.page, "svalAgents").hidden,
    "the Agents pane is showing"
  );
  const status = ui.byId("sval-agents-status");
  Assert.equal(status.dataset.state, "off", "it says access is off");
  Services.prefs.setBoolPref("browser.sval.agents.enabled", true);
  await TestUtils.waitForCondition(
    () => status.dataset.state === "problem",
    "the section says why"
  );
  Assert.equal(
    status.dataset.problem,
    "agents-file",
    "Sval can't read its list of paired agents"
  );

  await IOUtils.remove(agentsFile);
  Services.prefs.setBoolPref("browser.sval.agents.enabled", false);
  await TestUtils.waitForCondition(
    () => status.dataset.state === "off" && !status.dataset.problem,
    "it goes"
  );
  await SpecialPowers.popPrefEnv();
});
