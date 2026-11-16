/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Sval's settings page and the sync folder's harder states (spec §10.8): the
 * storage section, a folder that goes missing, a folder the page watches
 * while open, and stopping. `browser_sval_settings.js` holds choosing a
 * folder, `browser_sval_settings_sval_folder.js` Sval's own folder in it,
 * `browser_sval_settings_sync_now.js` syncing from the page, and
 * `browser_sval_settings_sync_key.js` the sync key; the helpers they share are
 * in `head.js`.
 */

const { SvalSharedFolder } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
);
const { SvalTestDeny } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestDeny.sys.mjs"
);

/* import-globals-from ../../sval-panel.js */

const SETTINGS_URL = "about:preferences";

const MockFilePicker = SpecialPowers.MockFilePicker;

add_setup(async function () {
  MockFilePicker.init();
  registerCleanupFunction(() => MockFilePicker.cleanup());
});

/**
 * Takes the shared folder's `sval/` from this user's reach and runs a pass,
 * which finds access to it denied. The footer offers another folder for a
 * denied one at once (`syncIndicator` in SvalPanelModel.sys.mjs), where a
 * folder that is gone waits three minutes first. Access comes back when the
 * task ends.
 */
async function aFolderDenied() {
  const sval = PathUtils.join(SvalPanel.sharedRootSetting(), "sval");
  atTaskEnd(() => SvalTestDeny.allow(sval));
  await SvalTestDeny.read(sval);
  await within(SvalSharedFolder._whenIdle(), 45_000, "the helper's exit");
  Assert.equal(
    await SvalPanel.syncWithFolder(),
    "unreachable",
    "a pass cannot read the folder"
  );
  Assert.equal(
    SvalPanel._els.indicator.dataset.state,
    "folder-denied",
    "and the footer says access to it is denied"
  );
}

add_task(async function choose_folder_opens_the_storage_settings() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  await panelOnAFolder("notice", { shared: true });
  // The panel brings an open settings tab forward instead of opening another,
  // so an earlier task's tab would answer the click and open nothing new.
  for (const tab of Array.from(gBrowser.tabs)) {
    if (tab.linkedBrowser?.currentURI?.spec.startsWith(SETTINGS_URL)) {
      BrowserTestUtils.removeTab(tab);
    }
  }
  await aFolderDenied();
  const choose = SvalPanel._els.syncActions.querySelector(
    '[data-command="chooseSharedFolder"]'
  );
  Assert.ok(choose?.textContent, "the button is there");
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, url =>
    url.startsWith(SETTINGS_URL)
  );
  choose.click();
  const tab = await within(opened, 10_000, "the folder's tab");
  registerCleanupFunction(() => BrowserTestUtils.removeTab(tab));
  Assert.ok(
    tab.linkedBrowser.currentURI.spec.endsWith("#svalSync-storage"),
    "the page opens on the storage section"
  );
});

add_task(async function the_storage_section_follows_the_folder_while_open() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const device = await panelOnAFolder("follows");
  const shared = await device.folder("shared");
  await SvalPanel.chooseSharedFolder(shared);
  const ui = await openSvalSettings();
  Assert.ok(ui.els.storageReuse.hidden, "nothing to recover while it answers");

  const away = `${shared}-away`;
  await IOUtils.move(shared, away);
  // A background pass would run its shared step within thirty seconds; the
  // test asks for one now.
  await SvalPanel.syncWithFolder();
  await TestUtils.waitForCondition(
    () => !ui.els.storageReuse.hidden,
    "the open page offers the way back after the next pass"
  );

  await IOUtils.move(away, shared);
  await SvalPanel.syncWithFolder();
  await TestUtils.waitForCondition(
    () => ui.els.storageReuse.hidden,
    "and withdraws it when the folder returns"
  );
});

/**
 * The readout's Choose Folder opens the folder picker, as the pairing line's
 * does, since the page is already where the footer's would lead.
 */
add_task(async function the_readouts_choose_folder_opens_the_picker() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  await panelOnAFolder("readout-choose", { shared: true });
  await aFolderDenied();
  const shown = new Promise(resolve => {
    MockFilePicker.showCallback = () => {
      resolve();
      return MockFilePicker.returnCancel;
    };
  });
  try {
    const ui = await openSvalSettings();
    const choose = ui.page.document.querySelector(
      '#sval-sync-actions [data-command="chooseSharedFolder"]'
    );
    Assert.ok(choose?.textContent, "the button is there");
    choose.click();
    await within(shown, 10_000, "the folder picker");
  } finally {
    MockFilePicker.showCallback = null;
  }
});

/** Stop syncing keeps every workspace and goes back to offering a folder. */
add_task(async function stop_syncing_keeps_the_workspaces() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const device = await panelOnAFolder("stop", { shared: true });
  const ui = await openSvalSettings();
  ui.settings._describeStorage();
  Assert.ok(!ui.els.storageStop.hidden, "Stop syncing is offered");

  ui.els.storageStop.click();
  await TestUtils.waitForCondition(
    () => ui.els.storageStop.hidden,
    "the page redrew once syncing stopped"
  );
  Assert.equal(device.settings.sharedFolder, null, "the setting is none");
  Assert.equal(device.engine.sharedRoot, null, "the engine shares nowhere");
  Assert.equal(SvalPanel.folderState, "none");
  Assert.equal(
    ui.els.storageChoose.dataset.tone,
    "primary",
    "and the card offers choosing a folder first"
  );
  for (const id of [device.workspace, device.tab]) {
    Assert.ok(id in (await nodes(device.engine)), `the task's ${id} is kept`);
  }
});

/**
 * A Sync now that finds the folder gone says what the footer's indicator
 * says, which waits three minutes before it shows (messages spec §3), so
 * nothing at first.
 */
add_task(async function sync_now_leaves_a_gone_folder_to_the_indicator() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const device = await panelOnAFolder("unavailable", { shared: true });
  const ui = await openSvalSettings();
  await syncFromSettings(ui);
  Assert.equal(ui.els.syncStatus.textContent, "");
  Assert.equal(
    ui.page.document.getElementById("sval-sync-state").dataset.state,
    "synced"
  );

  await keyCopyIn(
    device.settings.sharedFolder,
    "the step that reached the folder left the key"
  );
  await IOUtils.remove(PathUtils.join(device.settings.sharedFolder, "sval"), {
    recursive: true,
  });
  await syncFromSettings(ui);
  Assert.equal(SvalPanel._folderProblem, "gone", "the folder is gone");
  const shown = ui.page.document.getElementById("sval-sync-state");
  Assert.equal(ui.els.syncStatus.textContent, "", "and nothing says so yet");
  Assert.equal(shown.dataset.state, "synced");
});

/**
 * The sentence about a folder Sval could not reach goes when the folder
 * answers, without the page being reloaded.
 */
add_task(
  async function the_unreachable_sentence_clears_when_the_folder_answers() {
    await within(SvalPanel.started, 40_000, "the panel's startup");
    const device = await panelOnAFolder("clears");
    const later = tempPath("sval-later");
    const ui = await openSvalSettings();

    MockFilePicker.useDirectory(later);
    ui.els.storageChoose.click();
    await TestUtils.waitForCondition(
      () =>
        ui.els.storageStatus.hasAttribute("data-unreachable") &&
        ui.els.storageStatus.textContent,
      "the page says the folder cannot be reached yet"
    );

    // An empty directory where the folder was is what a share that is not
    // mounted looks like, so it stays unavailable until the user says it is
    // the folder.
    await IOUtils.makeDirectory(later);
    await SvalSharedFolder._whenIdle();
    Assert.equal(await SvalPanel.syncWithFolder(), "unreachable");
    Assert.deepEqual(await IOUtils.getChildren(later), [], "nothing written");
    ui.settings._describeStorage();
    Assert.ok(!ui.els.storageReuse.hidden, "Use this folder again is offered");
    ui.els.storageReuse.click();
    await TestUtils.waitForCondition(
      () => ui.els.storageStatus.textContent === "",
      "the open page withdrew the sentence once the folder answered"
    );
    Assert.equal(SvalPanel.folderState, "reached");
    Assert.equal(ui.els.folderPath.textContent, later);
    Assert.equal(ui.els.storageText.textContent, "");

    const reuse = await device.folder("reuse-clears");
    await SvalPanel.chooseSharedFolder(reuse);
    await keyCopyIn(reuse, "the step that reached the folder left the key");
    await IOUtils.remove(PathUtils.join(reuse, "sval"), { recursive: true });
    await SvalPanel.syncWithFolder();
    ui.settings._describeStorage();
    await IOUtils.remove(reuse, { recursive: true });
    ui.els.storageReuse.click();
    await TestUtils.waitForCondition(
      () =>
        ui.els.storageStatus.hasAttribute("data-unreachable") &&
        ui.els.storageStatus.textContent,
      "Use this folder again says the folder is still away"
    );
    // The folder comes back as the chosen one, holding `sval/`.
    await IOUtils.makeDirectory(PathUtils.join(reuse, "sval"));
    await TestUtils.waitForCondition(
      async () => (await SvalPanel.syncWithFolder()) === "reached",
      "the folder answers once it is back"
    );
    await TestUtils.waitForCondition(
      () => ui.els.storageStatus.textContent === "",
      "and that sentence is withdrawn too"
    );
  }
);
