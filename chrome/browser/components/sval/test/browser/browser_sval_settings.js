/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Sval's settings page as the one place Sval is configured (spec §10.8): where
 * this device keeps its workspaces, and the page itself.
 *
 * Choosing a folder from this page shares through it and loses no workspace,
 * and a folder Sval cannot reach is kept and explained, with the way back on
 * offer. Driven through the page's own button, because what can break is
 * the wiring between the page and the panel. The
 * page has no engine of its own and must not acquire one: there is one engine
 * per profile, and a second engine for one device loses data.
 *
 * The panel's half is asserted too, negatively: a storage control left behind
 * in the panel would be a second route to the same setting, and the two would
 * disagree the moment one of them was used. Where a plain open lands and the
 * panel's side are here too. "Sync now" and the last-synced line are in
 * `browser_sval_settings_sync_now.js`, the sync key in
 * `browser_sval_settings_sync_key.js`, the sync folder's harder states in
 * `browser_sval_settings_folder.js`, Sval's own folder in it in
 * `browser_sval_settings_sval_folder.js`, and Kagi's sign-in for private
 * windows in
 * `browser_sval_settings_kagi.js`; the helpers the files share are in
 * `head.js`.
 */

/* import-globals-from ../../sval-panel.js */

const MockFilePicker = SpecialPowers.MockFilePicker;
const { ON_THIS_DEVICE_ONLY } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);
const { SvalIdentity } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalIdentity.sys.mjs"
);
const { SvalTestDeny } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestDeny.sys.mjs"
);

add_setup(async function () {
  // The real picker cannot be driven from a test.
  MockFilePicker.init();
  registerCleanupFunction(() => MockFilePicker.cleanup());
});

/**
 * The page offers a shared folder, and choosing one publishes this device's
 * workspaces there while the profile keeps its copy (local-copy spec §4.5).
 */
add_task(async function choosing_a_folder_in_settings_publishes_there() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const device = await panelOnAFolder("choose");
  const destination = await device.folder("to");

  const ui = await openSvalSettings();
  Assert.equal(
    ui.els.storageChoose.dataset.tone,
    "primary",
    "with no folder chosen the page offers one"
  );
  Assert.ok(ui.els.storageStop.hidden, "and offers nothing to stop");

  MockFilePicker.useDirectory(destination);
  ui.els.storageChoose.click();
  await TestUtils.waitForCondition(
    () => ui.els.folderPath.textContent === destination,
    "the page redrew around the folder the user chose"
  );
  Assert.equal(
    device.settings.sharedFolder,
    destination,
    "the setting holds it"
  );
  Assert.equal(
    device.engine.sharedRoot,
    destination,
    "the engine shares there"
  );
  Assert.equal(
    device.engine.root,
    device.root,
    "and keeps its own copy where it was"
  );
  Assert.ok(
    await IOUtils.exists(PathUtils.join(destination, "sval")),
    "choosing the folder made sval/ in it"
  );
  for (const id of [device.workspace, device.tab]) {
    Assert.ok(id in (await nodes(device.engine)), `the task's ${id} is kept`);
  }
  Assert.ok(
    (await IOUtils.getChildren(PathUtils.join(destination, "sval"))).length,
    "the chosen folder received this device's document"
  );
  Assert.equal(ui.els.storageStatus.textContent, "", "with nothing to report");
  Assert.ok(
    !("tone" in ui.els.storageChoose.dataset) && ui.els.storageReuse.hidden,
    "the button changes the folder that is reached"
  );
  Assert.ok(!ui.els.storageStop.hidden, "and Stop syncing is offered");
});

/**
 * A folder Sval cannot reach yet is still the user's choice: the setting is
 * kept, nothing is lost, and the page says what will happen.
 */
add_task(async function a_folder_sval_cannot_reach_yet_is_kept_and_explained() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const device = await panelOnAFolder("not-yet");
  const missing = tempPath("sval-missing");
  const ui = await openSvalSettings();
  MockFilePicker.useDirectory(missing);
  ui.els.storageChoose.click();
  await TestUtils.waitForCondition(
    () => ui.els.storageStatus.textContent,
    "the page said something about the folder"
  );
  Assert.ok(
    ui.els.storageStatus.hasAttribute("data-unreachable"),
    "that it can't reach the folder yet"
  );
  Assert.equal(ui.els.folderPath.textContent, missing, "and names it");
  Assert.equal(device.settings.sharedFolder, missing, "the choice is kept");
  Assert.equal(SvalPanel.folderState, "unreachable");
  Assert.ok(!ui.els.storageChoose.disabled, "and the button works again");
});

/**
 * This page's contract is that the panel's words come back for it to render,
 * so the user is never left with a page that says nothing after answering
 * the picker. The panel it asks is a window's whose startup failed, so it
 * has a settings store and no engine: `init` opens the store before `_start`
 * reads the identity file, which is unreadable while that window starts.
 */
add_task(async function choosing_a_folder_with_no_engine_says_so() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const before = SvalPanel.sharedRootSetting();
  const destination = await makeTempDir("sval-settings-engineless");
  const ui = await openSvalSettings();

  const identity = SvalIdentity._identityPath();
  Assert.ok(await IOUtils.exists(identity), "the profile has an identity file");
  SvalIdentity.forgetCachedValues();
  await SvalTestDeny.read(identity);
  let other;
  try {
    other = await within(
      BrowserTestUtils.openNewBrowserWindow(),
      10_000,
      "the new window's opening"
    );
    await within(other.SvalPanel.started, 40_000, "its failed startup");
  } finally {
    await SvalTestDeny.allow(identity);
    SvalIdentity.forgetCachedValues();
  }
  expectWorkspaceTabs(other);
  try {
    Assert.strictEqual(other.SvalPanel.engine, null, "its startup failed");
    Assert.equal(
      ui.settings.panel,
      other.SvalPanel,
      "and the page asks its panel"
    );

    MockFilePicker.useDirectory(destination);
    ui.els.storageChoose.click();
    await TestUtils.waitForCondition(
      () => ui.els.storageStatus.textContent,
      "the page said something rather than nothing"
    );
    Assert.equal(
      other.SvalPanel.sharedRootSetting(),
      before,
      "and the setting is unchanged: a stored root nothing has published to " +
        "is a folder the user has been told holds their workspaces and does not"
    );
    ui.settings._describeStorage();
    Assert.ok(
      ui.els.storageStatus.textContent,
      "and the sentence survives the page redrawing around it"
    );
    Assert.ok(
      !ui.els.storageChoose.disabled,
      "with the button back, so a folder can be chosen once sval is running"
    );
  } finally {
    await within(
      BrowserTestUtils.closeWindow(other),
      10_000,
      "the failed window's close"
    );
  }
});

/**
 * `_describeStorage` runs on every window `focus` as well as at open, so the
 * lead paragraph is not a live region: announcing the whole explanation each
 * time is what the status line beside it exists to avoid. The control is
 * withheld only where no window of the profile runs a panel with a settings
 * store, which the harness's own window always does.
 */
add_task(async function the_storage_section_announces_only_its_outcome() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  await panelOnAFolder("hidden");
  const ui = await openSvalSettings();

  Assert.ok(
    !ui.els.storageText.hasAttribute("aria-live"),
    "the section's lead is not announced on every redraw"
  );
  Assert.equal(
    ui.els.storageStatus.getAttribute("aria-live"),
    "polite",
    "the line that reports an outcome is the one that is"
  );

  ui.settings._describeStorage();
  Assert.ok(
    !ui.els.storageChoose.hidden,
    "the control is offered while there is a panel to change it"
  );
  Assert.ok(
    ui.els.storageText.textContent && ui.settings._els.folderField.hidden,
    "beside a sentence that says the workspaces are on this device only"
  );
});

/**
 * This page reaches Sval through the profile, so it works in whatever window
 * session restore puts it back in (spec §10.8). Panels start per window, and
 * every window's panel is on the profile's one engine and settings store, so
 * the page asks the most recent window's panel, which here is a second
 * window's: it says where the workspaces are, it syncs, and it chooses a
 * shared folder.
 *
 * Neither the page nor this task builds an engine, for the reason the file's
 * top comment gives.
 */
add_task(async function settings_reaches_sval_through_the_profile() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const device = await panelOnAFolder("profile");
  const destination = await device.folder("to");
  const ui = await openSvalSettings();

  const other = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    10_000,
    "the new window's opening"
  );
  expectWorkspaceTabs(other);
  try {
    await within(
      other.SvalPanel.started,
      40_000,
      "the other window's panel startup"
    );
    Assert.equal(
      other.SvalPanel.engine,
      device.engine,
      "both windows are on the profile's one engine"
    );
    Assert.equal(
      ui.settings.panel,
      other.SvalPanel,
      "the page asks the panel that is running, not the window it is in"
    );

    ui.settings._describeStorage();
    Assert.ok(
      ui.els.storageText.textContent && ui.settings._els.folderField.hidden,
      "it says the workspaces are on this device only"
    );
    Assert.ok(
      !ui.els.storageChoose.hidden,
      "and offers the control that chooses a folder"
    );
    Assert.equal(
      ui.els.storageStatus.textContent,
      "",
      "with nothing explaining a state the user is not in"
    );

    await syncFromSettings(ui);
    Assert.equal(
      ui.els.syncStatus.textContent,
      ON_THIS_DEVICE_ONLY,
      "the button beside it runs a real pass from here"
    );

    MockFilePicker.useDirectory(destination);
    ui.els.storageChoose.click();
    await TestUtils.waitForCondition(
      () => ui.els.folderPath.textContent === destination,
      "the page redrew around the folder the user chose"
    );
    Assert.equal(
      device.settings.sharedFolder,
      destination,
      "the setting holds the folder the user chose"
    );
    Assert.equal(
      device.engine.sharedRoot,
      destination,
      "the profile's one engine shares there now"
    );
    for (const id of [device.workspace, device.tab]) {
      Assert.ok(
        id in (await nodes(device.engine)),
        `choosing from another window's page lost none of the task's nodes: ${id}`
      );
    }
  } finally {
    await within(
      BrowserTestUtils.closeWindow(other),
      10_000,
      "the other window's close"
    );
  }
});

/**
 * A plain open names no section, so the page chooses where to land. The
 * caret must not go to pairing, the last section and the one most people
 * never use.
 *
 * The named sections are asserted in the same task, as what the plain case
 * must not have cost.
 */
add_task(async function opening_settings_plainly_lands_on_the_page() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  await panelOnAFolder("plain");
  const ui = await openSvalSettings();

  await TestUtils.waitForCondition(
    () => ui.page.document.activeElement === ui.els.heading,
    "opening settings with no section named focuses the page itself"
  );

  ui.settings.focusSection("claim");
  await TestUtils.waitForCondition(
    () => ui.page.document.activeElement === ui.els.claimCode,
    "and a named section still takes the caret: pairing does not regress"
  );

  ui.settings.focusSection("");
  await TestUtils.waitForCondition(
    () => ui.page.document.activeElement === ui.els.heading,
    "while opening settings plainly again lands on the page"
  );
});

/**
 * @param {object} ui `openSvalSettings`'s result.
 * @param {string} name The radio group's `name`.
 * @returns {HTMLInputElement[]} the group's radios, in page order.
 */
function radios(ui, name) {
  return [...ui.page.document.querySelectorAll(`input[name="${name}"]`)];
}

/**
 * @param {object} ui `openSvalSettings`'s result.
 * @param {string} name The radio group's `name`.
 * @returns {string|undefined} the value of the checked radio.
 */
function checkedValue(ui, name) {
  return radios(ui, name).find(radio => radio.checked)?.value;
}

/** The panel side moves the panel in every window and is kept for next time. */
add_task(async function settings_moves_the_panel() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const device = await panelOnAFolder("side");
  const was = device.settings.placement;
  const away = was === "left" ? "right" : "left";
  const placed = side =>
    TestUtils.waitForCondition(
      () =>
        device.settings.placement === side &&
        SvalPanel.container.getAttribute("sval-placement") === side,
      `the panel moves to the ${side} and the side is recorded`
    );

  let ui = await openSvalSettings();
  Assert.equal(checkedValue(ui, "sval-side"), was);

  radios(ui, "sval-side")
    .find(radio => radio.value === away)
    .click();
  await placed(away);

  await closeSvalSettings(ui);
  ui = await openSvalSettings();
  Assert.equal(checkedValue(ui, "sval-side"), away, "kept for next time");

  radios(ui, "sval-side")
    .find(radio => radio.value === was)
    .click();
  await placed(was);
});

/**
 * At both storage states, because a storage control could change its label
 * with the state: a check at one state only would pass against a panel that
 * still offered the other.
 */
add_task(async function the_panel_offers_no_storage_control() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const device = await panelOnAFolder("panel");
  const shared = await device.folder("shared");

  const states = [
    ["a shared folder", shared],
    ["the default", null],
  ];
  for (const [state, root] of states) {
    await SvalPanel.chooseSharedFolder(root);
    Assert.equal(SvalPanel.sharedRootSetting(), root, `${state} is chosen`);
    Assert.equal(
      SvalPanel.container.querySelector('[data-command="chooseFolder"]'),
      null,
      `no folder button in the panel with ${state} configured`
    );
  }
});
