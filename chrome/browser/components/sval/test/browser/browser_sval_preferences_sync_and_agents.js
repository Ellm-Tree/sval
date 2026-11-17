/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */

/**
 * Sval's Sync and Agents categories of about:preferences (spec §10.8): the
 * sync folder's field changes and reveals the folder, the sync readout says
 * one state at a time beside it, the device flow shows only the path the
 * user chose, and without a folder sends the user to the Sync card, and
 * agent access is the
 * pref and says why it could not start.
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
  Assert.ok(
    !("tone" in ui.byId("sval-storage-choose").dataset),
    "the folder's button changes it"
  );
  Assert.ok(ui.byId("sval-storage-reuse").hidden, "the folder is reached");

  // Revealing opens the system's file manager, outside the browser.
  const revealed = [];
  ui.settings._reveal = path => revealed.push(path);
  ui.byId("sval-folder-reveal").click();
  Assert.deepEqual(revealed, [icloud], "reveal shows the folder");

  const other = await makeTempDir("sval-other");
  MockFilePicker.useDirectory(other);
  ui.byId("sval-storage-choose").click();
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
  Assert.equal(state.dataset.state, "synced");
  Assert.equal(
    ui.byId("sval-sync-last").textContent,
    SvalPanel.syncIndicator().detail,
    "it says what the footer's indicator says"
  );

  ui.byId("sval-sync-now").click();
  Assert.equal(state.dataset.state, "syncing", "pressing Sync now syncs");
  Assert.ok(ui.byId("sval-sync-status").textContent, "and says so");
  await TestUtils.waitForCondition(
    () => !ui.byId("sval-sync-now").disabled,
    "the pass came back"
  );
  Assert.equal(state.dataset.state, "synced", "then says it synced");
  Assert.equal(ui.byId("sval-sync-status").textContent, "");

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
  ui.byId("sval-sync-now").click();
  await TestUtils.waitForCondition(
    () => state.dataset.state === "problem",
    "a pass that failed is a problem"
  );
  Assert.equal(state.dataset.outcome, "failed", "the pass failed");
  const said = ui.byId("sval-sync-status").textContent;
  Assert.ok(said, "and the readout says so");
  // The panel redraws its rows whenever a tab changes, and a redraw runs no
  // pass: what the last one said stays until another comes back.
  SvalPanel.render();
  Assert.equal(state.dataset.outcome, "failed");
  Assert.equal(
    ui.byId("sval-sync-status").textContent,
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
  ui.byId("sval-sync-now").click();
  await TestUtils.waitForCondition(
    () => !ui.byId("sval-sync-now").disabled,
    "the pass came back"
  );
  Assert.equal(
    SvalPanel.syncState.folderState,
    "unreachable",
    "the read was refused"
  );
  Assert.equal(SvalPanel.syncIndicator().severity, "synced");
  Assert.equal(ui.byId("sval-sync-state").dataset.state, "synced");
  Assert.equal(ui.byId("sval-sync-status").textContent, "");
});

/**
 * The readout says what the footer's indicator says, with its buttons
 * (messages spec §3).
 */
add_task(async function the_sync_readout_carries_the_indicators_detail() {
  await panelWithFolder(await makeTempDir("sval-shared"));
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

  const ui = await openSettings();
  const shown = SvalPanel.syncIndicator();
  Assert.equal(ui.byId("sval-sync-state").dataset.state, "problem");
  Assert.equal(ui.byId("sval-sync-status").textContent, shown.label);
  Assert.equal(ui.byId("sval-sync-last").textContent, shown.detail);
  Assert.deepEqual(
    [...ui.byId("sval-sync-actions").children].map(button => [
      button.textContent,
      button.dataset.command,
    ]),
    shown.actions.map(action => [action.label, action.command]),
    "with the footer's button"
  );
  Assert.deepEqual(
    shown.actions.map(action => action.command),
    ["pairAgain"],
    "which pairs again"
  );

  await putBack();
  Assert.equal(
    SvalPanel.syncState.keyState,
    SvalIdentity.SYNC_KEY_STATES.present
  );
  await TestUtils.waitForCondition(
    () => !ui.byId("sval-sync-actions").childElementCount,
    "and none once the state has passed"
  );
});

/**
 * A Sync now that finds the folder unreachable, while the indicator already
 * says so, shows the indicator's words alone.
 */
add_task(async function an_unreachable_folder_is_said_once() {
  const shared = await makeTempDir("sval-shared");
  await panelWithFolder(shared);
  const away = `${shared}-away`;
  await IOUtils.move(shared, away);
  atTaskEnd(() => IOUtils.move(away, shared));
  const ui = await openSettings();
  ui.byId("sval-sync-now").click();
  await TestUtils.waitForCondition(
    () => !ui.byId("sval-sync-now").disabled,
    "the pass came back"
  );
  Assert.equal(
    SvalPanel.syncState.folderState,
    "unreachable",
    "the folder is gone"
  );
  const shown = SvalPanel.syncIndicator();
  Assert.notEqual(
    ui.byId("sval-sync-state").dataset.outcome,
    "failed",
    "the pass adds no failure of its own"
  );
  Assert.equal(ui.byId("sval-sync-status").textContent, shown.label);
  Assert.equal(
    ui.byId("sval-sync-last").textContent,
    shown.detail,
    "and the reason is said once"
  );
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
  const chooser = ui.byId("sval-pairing-choose");
  const offer = ui.byId("sval-path-offer-steps");
  const claim = ui.byId("sval-path-claim-steps");
  const visible = el => !el.hidden && el.getBoundingClientRect().height > 0;
  const focused = () => ui.page.document.activeElement;
  const stepsShown = steps =>
    [...steps.querySelectorAll(".sval-step")]
      .filter(step => !step.hidden)
      .map(step => step.dataset.step);

  Assert.ok(visible(open), "the devices card offers to sync another device");
  Assert.ok(!visible(chooser), "and shows no flow until asked");
  Assert.ok(!visible(offer) && !visible(claim), "nor any steps");

  open.click();
  Assert.ok(visible(chooser), "then it asks which device shows the code");
  Assert.equal(open.getAttribute("aria-expanded"), "true");
  Assert.ok(
    ui.byId("sval-this-device").contains(chooser),
    "in the devices card"
  );
  Assert.ok(!visible(open), "in place of the button that opened it");
  const back = ui.byId("sval-choose-back").getBoundingClientRect();
  const heading = ui
    .byId("sval-pairing-choose-heading")
    .getBoundingClientRect();
  Assert.equal(
    Math.round(back.left),
    Math.round(heading.left),
    "with Back in line with the question"
  );
  Assert.equal(focused(), ui.byId("sval-path-offer"), "at the first choice");

  ui.byId("sval-path-offer").click();
  Assert.ok(visible(offer), "choosing to show a code shows that path");
  Assert.ok(!visible(chooser) && !visible(claim), "and only that path");
  Assert.ok(visible(ui.byId("sval-offer-start")), "at its first step");
  Assert.ok(!visible(ui.byId("sval-offer-live")), "one step at a time");
  Assert.deepEqual(stepsShown(offer), ["1"], "at step one");
  Assert.ok(ui.byId("sval-offer-progress").textContent, "which it counts");

  ui.byId("sval-offer-back").click();
  Assert.ok(visible(chooser), "Back returns to the question");
  Assert.equal(focused(), ui.byId("sval-path-offer"), "at the path left");

  ui.byId("sval-choose-back").click();
  Assert.ok(!visible(chooser), "and its own Back closes the flow");
  Assert.equal(open.getAttribute("aria-expanded"), "false");
  Assert.equal(focused(), open, "with the caret on the button that opened it");

  open.click();
  ui.byId("sval-path-claim").click();
  Assert.ok(visible(claim) && !visible(offer) && !visible(chooser));
  Assert.ok(!visible(ui.byId("sval-claim-code")), "the code waits its turn");
  ui.byId("sval-claim-next").click();
  // Next looks in the folder for this user's own key before asking for a
  // code, so the code step follows that look.
  await TestUtils.waitForCondition(
    () => visible(ui.byId("sval-claim-code")),
    "and comes at step two"
  );
  Assert.deepEqual(stepsShown(claim), ["2"]);
  Assert.ok(ui.byId("sval-claim-progress").textContent, "which it counts");
  Assert.equal(focused(), ui.byId("sval-claim-code"), "with the caret in it");
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
  for (const id of ["sval-folder-field", "sval-sync-state", "sval-sync-now"]) {
    Assert.ok(card.contains(ui.byId(id)), `the Sync card holds #${id}`);
    Assert.ok(ui.byId(id).checkVisibility(), `and shows #${id}`);
  }

  // The page offers the key's actions once it has read where the key is
  // kept (`_describeKeyring`), after the pane shows.
  await TestUtils.waitForCondition(
    () => !ui.byId("sval-key-actions").hidden,
    "the key's actions are drawn"
  );
  const advanced = ui.byId("sval-sync-advanced");
  Assert.ok(advanced.contains(ui.byId("sval-key")), "the key is in Advanced");
  Assert.ok(!advanced.open, "which starts closed");
  Assert.ok(!ui.byId("sval-backup-save").checkVisibility(), "so it is tucked");
  advanced.querySelector("summary").click();
  Assert.ok(ui.byId("sval-backup-save").checkVisibility(), "until opened");
});

add_task(async function without_a_folder_the_devices_card_sends_to_sync() {
  await panelWithFolder(null);
  const ui = await openSettings("offer");
  await TestUtils.waitForCondition(
    () => !paneOf(ui.page, "svalSync").hidden,
    "the Sync and devices pane is showing"
  );
  Assert.ok(!ui.byId("sval-pairing-needs-folder").hidden, "it asks for one");
  Assert.ok(ui.byId("sval-folder").textContent, "and says why");
  Assert.ok(ui.byId("sval-pairing-start").hidden, "and offers no code yet");
  Assert.ok(!ui.byId("sval-sync-row").checkVisibility(), "nor a readout");
  Assert.ok(
    ui.byId("sval-path-offer-steps").classList.contains("sval-unmet"),
    "and the steps wait for it"
  );
  ui.byId("sval-pairing-go-sync").click();
  await TestUtils.waitForCondition(
    () => ui.page.document.activeElement === ui.byId("sval-storage-choose"),
    "its button takes the caret to the Sync card's folder"
  );
  Assert.ok(!paneOf(ui.page, "svalSync").hidden, "on the same pane");
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
