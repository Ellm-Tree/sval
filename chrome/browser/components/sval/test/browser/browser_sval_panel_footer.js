/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_panel_helpers.js */

/**
 * The panel's footer: what the sync indicator shows for each state (messages
 * spec §3, §9.2), where the panel sits, and what it does not offer.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_panel_helpers.js",
  this
);

const { SvalSecretStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSecretStore.sys.mjs"
);
const { SvalTestDeny } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestDeny.sys.mjs"
);

/**
 * The window's own panel on a fresh workspace, sharing a folder of the
 * task's own that a pass has reached.
 *
 * @returns {Promise<object>} `withFreshPanel`'s fixture and `shared`, the
 *   folder.
 */
async function panelSharing() {
  const fixture = await withFreshPanel();
  const shared = await makeTempDir("sval-footer-shared");
  await shareFolder(shared);
  Assert.equal(
    await SvalPanel.syncWithFolder(),
    "reached",
    "the folder answers"
  );
  return { ...fixture, shared };
}

/**
 * Another sync key's workspaces in `shared`, as a device set up as new
 * before this one's files reached it leaves them.
 *
 * @param {string} shared
 */
async function anotherKeysWorkspaces(shared) {
  // The other device chose the folder, which made `sval/` in it.
  await IOUtils.makeDirectory(PathUtils.join(shared, "sval"), {
    ignoreExisting: true,
  });
  const theirs = new SvalEngine({
    root: await makeTempDir("sval-footer-theirs"),
    sharedRoot: shared,
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  atTaskEnd(() => stopEngine(theirs));
  await theirs.mutate({
    kind: "addWorkspace",
    name: "Theirs",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  await theirs.sync(SvalTree.SYNC_DOCUMENT, Date.now(), {
    shared: "wait",
  });
}

/**
 * A second window, on a folder that holds another key's workspaces, once its
 * indicator is in its unpaired-device state. The profile looks for another
 * key's workspaces when a step first reaches the folder and then at most
 * once per `SvalFolderUpkeep.OTHER_WORKSPACES_CHECK_MS`, so the window's
 * step is told to look again.
 *
 * @returns {Promise<Window>}
 */
async function windowFindingAnotherKey() {
  const { shared } = await panelSharing();
  await anotherKeysWorkspaces(shared);
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    20_000,
    "the other window"
  );
  expectWorkspaceTabs(win);
  atTaskEnd(() =>
    within(BrowserTestUtils.closeWindow(win), 20_000, "the window closing")
  );
  await within(win.SvalPanel.started, 10_000, "the window's panel");
  await within(
    win.SvalPanel._passAfterDrawing ?? Promise.resolve(),
    10_000,
    "the window's first pass"
  );
  lookForOtherWorkspacesAgain(win.SvalPanel);
  Assert.equal(
    await win.SvalPanel.syncWithFolder(),
    "reached",
    "the window's step reaches the folder"
  );
  await TestUtils.waitForCondition(
    () => win.SvalPanel._els.indicator.dataset.state === "unpaired-device",
    "the window finds the other key's workspaces"
  );
  return win;
}

/**
 * The indicator's parts, as a test reads them.
 *
 * @param {Window} [win]
 * @returns {object}
 */
function indicatorParts(win = window) {
  const { syncRow, indicator, syncLabel, syncDetail, syncActions } =
    win.SvalPanel._els;
  return { syncRow, indicator, syncLabel, syncDetail, syncActions };
}

/**
 * Spec §3: with no sync folder chosen there is nothing to say about syncing,
 * so the indicator's row is absent, and the footer holds the Favorites row
 * and the feedback button (feedback spec §2).
 */
add_task(async function no_folder_leaves_the_feedback_button_alone() {
  await withFreshPanel();
  Assert.equal(
    SvalPanel.sharedRootSetting(),
    null,
    "the profile has chosen no folder"
  );
  SvalPanel.drawIndicator();
  const { syncRow } = indicatorParts();
  Assert.ok(syncRow.hidden, "the indicator's row is absent");
  Assert.ok(
    BrowserTestUtils.isHidden(syncRow),
    "and takes no room in the footer"
  );
  const { footer } = SvalPanel._els;
  const feedback = footer.querySelector(".sval-feedback-button");
  Assert.ok(BrowserTestUtils.isVisible(feedback), "the feedback button shows");
  Assert.ok(feedback.title, "named in its tooltip");
  const visible = [...footer.children].filter(child =>
    BrowserTestUtils.isVisible(child)
  );
  Assert.deepEqual(
    visible,
    [SvalPanel._els.favorites.parentElement, feedback],
    "the Favorites row and the feedback button are all the footer shows"
  );
});

/**
 * Spec §3: a healthy device shows the moon and nothing else. When it last
 * synced is the tooltip.
 */
add_task(async function synced_shows_the_moon_alone() {
  await panelSharing();
  await SvalPanel.syncNow();
  const { syncRow, indicator, syncLabel, syncActions } = indicatorParts();
  Assert.ok(BrowserTestUtils.isVisible(syncRow), "the row is shown");
  Assert.equal(indicator.dataset.severity, "synced", "synced");
  Assert.equal(indicator.dataset.icon, "moon", "with the plain moon");
  Assert.equal(syncLabel.textContent, "", "and no label");
  Assert.equal(syncActions.childElementCount, 0, "and no buttons");
  Assert.equal(indicator.dataset.state, "synced", "the synced state");
  Assert.equal(
    indicator.title,
    SvalPanel.syncIndicator().tooltip,
    "the tooltip says when"
  );
  Assert.ok(SvalPanel.syncState.lastSynced, "which a pass recorded");
  Assert.equal(
    indicator.dataset.command,
    "openSyncSettings",
    "a click opens Settings › Sync"
  );
});

/**
 * Spec §3 and decision 0032: a folder that stops answering says nothing at
 * first, and one that answers again is synced at once. The dimmed moon three
 * minutes on is the model's (`folder_offline` in `test_sval_panel_model.js`),
 * since a browser test cannot wait out the three minutes.
 */
add_task(async function an_away_folder_says_nothing_at_first() {
  const { shared } = await panelSharing();
  const { indicator } = indicatorParts();
  Assert.equal(indicator.dataset.severity, "synced", "it starts synced");

  const away = `${shared}-away`;
  await IOUtils.move(shared, away);
  atTaskEnd(async () => {
    if (await IOUtils.exists(away)) {
      await IOUtils.move(away, shared);
    }
  });
  Assert.equal(
    await SvalPanel.syncWithFolder(),
    "unreachable",
    "the folder is away"
  );
  Assert.equal(
    SvalPanel.syncState.folderState,
    "unreachable",
    "the panel knows it"
  );
  Assert.equal(indicator.dataset.severity, "synced", "and says nothing yet");

  await IOUtils.move(away, shared);
  Assert.equal(await SvalPanel.syncWithFolder(), "reached", "it is back");
  Assert.equal(
    indicator.dataset.severity,
    "synced",
    "a folder that answers again is synced at once"
  );
});

/**
 * Messages spec §3 and §8.2: a pass that could not read this device's own
 * file in the folder heard from the folder, so the indicator stays synced and
 * the folder's three minutes do not start.
 */
add_task(async function an_unreadable_own_file_starts_no_offline_wait() {
  const { shared, engine, ids } = await panelSharing();
  // A change, so the step publishes this device's file and names it.
  await engine.mutate({
    kind: "rename",
    id: ids.workspace,
    name: "Renamed",
    now: Date.now(),
  });
  await SvalPanel.syncWithFolder();
  const wrote = SvalPanel.syncState.lastPass?.sharedWrote;
  Assert.ok(wrote, "this device published its file");
  const own = PathUtils.join(shared, ...wrote.split("/"));
  await SvalTestDeny.read(own);
  atTaskEnd(() => SvalTestDeny.allow(own));
  Assert.equal(
    await SvalPanel.syncWithFolder(),
    "unreachable",
    "the read was refused"
  );
  Assert.equal(
    SvalPanel.syncState.unreachableSince,
    null,
    "no offline wait starts"
  );
  Assert.equal(
    indicatorParts().indicator.dataset.severity,
    "synced",
    "and it shows synced"
  );
});

/**
 * Spec §3: a state the user must act on carries its button. A key store
 * that will not answer gets its own, which reads the key again.
 */
add_task(async function a_warning_shows_its_button() {
  await panelSharing();
  const store = SvalSecretStore._store();
  const { present } = SvalIdentity.SYNC_KEY_STATES;
  atTaskEnd(async () => {
    delete store.failing.asyncGetRecoveryPhrase;
    if (SvalPanel.syncState.keyState !== present) {
      await within(SvalPanel.run("retrySyncKey"), 30_000, "the key read");
    }
  });
  store.failing.asyncGetRecoveryPhrase = new Error("the keychain is locked");
  await within(SvalPanel.run("retrySyncKey"), 30_000, "the key read");
  Assert.equal(
    SvalPanel.syncState.keyState,
    SvalIdentity.SYNC_KEY_STATES.unreadable,
    "the store would not answer"
  );

  const { indicator, syncLabel, syncActions } = indicatorParts();
  Assert.equal(indicator.dataset.severity, "warning", "a warning");
  Assert.equal(indicator.dataset.icon, "moon-warning", "with its badge");
  Assert.equal(indicator.dataset.state, "key-unreadable", "the key store's");
  Assert.deepEqual(
    [syncLabel.getAttribute("role"), syncLabel.getAttribute("aria-live")],
    ["status", "polite"],
    "in a polite status region, so a screen reader hears it appear"
  );
  const shown = SvalPanelModel.syncIndicator({
    ...SvalPanel.indicatorState(),
    platform: AppConstants.platform,
  });
  Assert.equal(
    indicator.title,
    shown.tooltip,
    "the tooltip is the one for this platform's key store"
  );
  const buttons = [...syncActions.children];
  Assert.deepEqual(
    buttons.map(button => [
      button.className,
      button.dataset.command,
      button.textContent,
    ]),
    [["sval-sync-action", "retrySyncKey", shown.actions[0].label]],
    "one button, which reads the key"
  );

  delete store.failing.asyncGetRecoveryPhrase;
  buttons[0].click();
  await TestUtils.waitForCondition(
    () => SvalPanel.syncState.keyState === present,
    "the button reads the key again"
  );
  await TestUtils.waitForCondition(
    () => indicator.dataset.severity === "synced",
    "and the warning is gone"
  );
});

/**
 * Decision 1714: a pass in which a device's clock set ahead replaced this
 * device's values is a warning naming that device, with its detail under
 * the label, and the next pass that finds none puts the moon back.
 */
add_task(async function a_device_with_its_clock_ahead_is_named() {
  const { shared, ids } = await panelSharing();
  // Another device of this key, whose clock runs past the engine's margin
  // (`CLOCK_AHEAD_MARGIN`, ten minutes), renames one of this device's tabs.
  const peer = new SvalEngine({
    root: await makeTempDir("sval-footer-ahead"),
    sharedRoot: shared,
    keyBytes: await SvalSecretStore.read("sync key"),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  atTaskEnd(() => stopEngine(peer));
  // It publishes its name in the settings document, as every device does
  // (`SvalDeviceNames`).
  const { SETTINGS_DOCUMENT } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSettingsRegistry.sys.mjs"
  ).SvalSettingsRegistry;
  await peer.addDocument(SETTINGS_DOCUMENT);
  const now = Date.now();
  await peer.mutate({
    kind: "setSetting",
    document: SETTINGS_DOCUMENT,
    key: `sval.device.name.${peer.deviceIdHex}`,
    valueJson: JSON.stringify("Work Laptop"),
    now,
  });
  await peer.sync(SvalTree.SYNC_DOCUMENT, now, { shared: "wait" });
  const ahead = now + 11 * 60_000;
  await peer.mutate({
    kind: "rename",
    id: ids.tab1,
    name: "Theirs",
    now: ahead,
  });
  await peer.sync(SvalTree.SYNC_DOCUMENT, ahead, { shared: "wait" });

  Assert.equal(await SvalPanel.syncWithFolder(), "reached", "a step merges it");
  const { indicator, syncDetail } = indicatorParts();
  Assert.equal(indicator.dataset.state, "clock-harm", "the clock's state");
  Assert.equal(indicator.dataset.severity, "warning", "a warning");
  Assert.equal(indicator.dataset.icon, "moon-warning", "with its badge");
  Assert.ok(BrowserTestUtils.isVisible(syncDetail), "its detail shows");
  await TestUtils.waitForCondition(
    () => syncDetail.textContent.includes("Work Laptop"),
    "naming the device"
  );

  Assert.equal(await SvalPanel.syncWithFolder(), "reached", "the next step");
  Assert.equal(indicator.dataset.state, "synced", "gone with the next pass");
});

/**
 * Spec §3: another device in the folder that is not paired is a warning with
 * Enter Code… and a dismiss button, and dismissing it puts the moon back.
 * The footer shows its detail under the label, with the buttons under the
 * detail, and the feedback button stays on the label's line.
 */
add_task(async function the_unpaired_line_dismisses() {
  const win = await windowFindingAnotherKey();
  const { syncRow, indicator, syncLabel, syncDetail, syncActions } =
    indicatorParts(win);
  Assert.equal(indicator.dataset.severity, "warning", "a warning");
  Assert.ok(!syncDetail.hidden, "its detail shows in the footer");
  const box = el => el.getBoundingClientRect();
  const labelStart = box(syncLabel).left;
  Assert.greaterOrEqual(
    box(syncDetail).top,
    box(indicator).bottom,
    "the detail is under the label's line"
  );
  Assert.greaterOrEqual(
    box(syncActions).top,
    box(syncDetail).bottom,
    "the buttons are under the detail"
  );
  const range = win.document.createRange();
  range.selectNodeContents(syncDetail);
  Assert.less(
    Math.abs(range.getBoundingClientRect().left - labelStart),
    1,
    "the detail starts under the label"
  );
  Assert.less(
    Math.abs(box(syncActions.firstElementChild).left - labelStart),
    1,
    "and so do the buttons"
  );
  const feedback = win.SvalPanel._els.footer.querySelector(
    ".sval-feedback-button"
  );
  Assert.equal(
    box(feedback).top,
    box(indicator).top,
    "the feedback button stays on the label's line"
  );
  Assert.lessOrEqual(
    box(syncRow).right,
    box(feedback).left,
    "clear of the detail and the buttons"
  );
  Assert.ok(indicator.title, "its tooltip");
  const pair = syncActions.querySelector(".sval-sync-action");
  Assert.equal(pair.dataset.command, "pairAgain", "a button that pairs");
  const dismiss = syncActions.querySelector(".sval-sync-dismiss");
  Assert.ok(dismiss.getAttribute("aria-label"), "a dismiss, named");
  Assert.equal(
    dismiss.dataset.command,
    "dismissOtherWorkspaces",
    "bound to the dismissal"
  );

  const found = [...win.SvalPanel.syncState.otherWorkspaces];
  Assert.equal(found.length, 1, "the other key's directory was found");
  dismiss.click();
  await TestUtils.waitForCondition(
    () => indicator.dataset.severity === "synced",
    "the moon is back"
  );
  Assert.ok(
    win.SvalPanel.settings.isDismissedOtherWorkspace(found[0]),
    "the directory is dismissed"
  );
  Assert.equal(syncLabel.textContent, "", "with no label");
  Assert.ok(syncDetail.hidden, "no detail");
  Assert.equal(syncActions.childElementCount, 0, "and no buttons");
});

/**
 * Spec §3: a folder the user chooses is looked in for another key's
 * workspaces once a step reaches it, whatever folder was looked in before.
 */
add_task(async function a_newly_chosen_folder_is_looked_in_at_once() {
  await panelSharing();
  const other = await makeTempDir("sval-footer-other");
  await anotherKeysWorkspaces(other);
  await within(
    SvalPanel.chooseSharedFolder(other, { mint: true }),
    30_000,
    "the other folder chosen"
  );
  Assert.equal(
    await SvalPanel.syncWithFolder(),
    "reached",
    "the step reaches the other folder"
  );
  await TestUtils.waitForCondition(
    () => SvalPanel._els.indicator.dataset.state === "unpaired-device",
    "the window finds the other key's workspaces there"
  );
});

/**
 * Spec §3: a private window's tabs are never saved or synced, so its
 * indicator is the outlined moon, with no label, saying so in its tooltip.
 */
add_task(async function a_private_window_shows_sync_off() {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20_000,
    "a private window's opening"
  );
  try {
    await within(win.SvalPanel.started, 10_000, "the private panel's startup");
    const { syncRow, indicator, syncLabel, syncActions } = win.SvalPanel._els;
    Assert.ok(BrowserTestUtils.isVisible(syncRow), "the row is shown");
    Assert.equal(indicator.dataset.severity, "off", "sync is off");
    Assert.equal(indicator.dataset.icon, "moon-off", "the outlined moon");
    Assert.equal(
      indicator.dataset.state,
      "private-window",
      "for a private window"
    );
    Assert.ok(indicator.title, "and the tooltip says why");
    Assert.equal(syncLabel.textContent, "", "with no label");
    Assert.equal(syncActions.childElementCount, 0, "and no buttons");
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the private window closing"
    );
  }
});

/**
 * The poll runs every five seconds and almost always finds what is already
 * on screen. A write to the DOM dirties the frame and costs a paint on an
 * idle window, so a state already drawn touches nothing.
 */
add_task(async function an_unchanged_state_is_not_redrawn() {
  await panelSharing();
  const { footer, indicator } = SvalPanel._els;
  Assert.equal(
    indicator.dataset.severity,
    "synced",
    "the state under test is drawn"
  );
  const observer = new MutationObserver(() => {});
  atTaskEnd(() => observer.disconnect());
  observer.observe(footer, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  for (let i = 0; i < 3; i++) {
    await SvalPanel.syncNow();
  }
  Assert.deepEqual(
    observer.takeRecords().map(record => record.type),
    [],
    "three passes that found the same state changed nothing in the footer"
  );
});

/**
 * Spec §9.2: at the 48px panel the indicator's tooltip still says the state.
 */
add_task(async function the_narrow_panel_keeps_only_the_icon() {
  const win = await windowFindingAnotherKey();
  const panel = win.SvalPanel;
  const { indicator, syncLabel, syncActions } = indicatorParts(win);
  Assert.ok(BrowserTestUtils.isVisible(syncLabel), "a wide panel's label");
  Assert.ok(BrowserTestUtils.isVisible(syncActions), "and its buttons");

  atTaskEnd(() => {
    panel.settings.panelWidth = null;
    panel._applyPanelWidth();
  });
  panel.settings.panelWidth = 48;
  panel._applyPanelWidth();
  const container = win.document.getElementById("sval-panel-container");
  Assert.equal(
    Math.round(container.getBoundingClientRect().width),
    48,
    "the panel is at its narrowest"
  );
  Assert.equal(
    indicator.dataset.state,
    "unpaired-device",
    "the state is still the unpaired device's"
  );
  Assert.equal(
    indicator.title,
    panel.syncIndicator().tooltip,
    "whose tooltip still says the state"
  );
});

/**
 * Spec §6.4: there is one storage location and it has a default. A profile that
 * has configured nothing gets a working panel, a workspace, and a real pass
 * against the profile directory. Where the workspaces are, and the control
 * that moves them, are Sval's settings page's (spec §10.8) and are asserted in
 * `browser_sval_settings.js`.
 */
add_task(
  async function with_nothing_configured_the_panel_still_stores_and_syncs() {
    await within(SvalPanel.started, 10_000, "the panel's startup");
    Assert.equal(
      SvalPanel.settings.sharedFolder,
      null,
      "nothing has been configured, which is the state under test"
    );
    Assert.equal(
      SvalPanel._localRoot(),
      PathUtils.profileDir,
      "and the location is the profile directory, not nowhere"
    );

    Assert.ok(
      SvalWindowWorkspace.of(window).id,
      "a workspace exists with nothing asked"
    );
    Assert.ok(
      await SvalPanel.syncNow(),
      "and a pass runs: storing and syncing are one path, not two"
    );

    const shown = el => window.getComputedStyle(el).display !== "none";
    Assert.ok(shown(SvalPanel._els.tree), "the tree is drawn");
    Assert.ok(
      shown(SvalPanel._els.header),
      "with the buttons that mutate it, because the tree is real"
    );
    Assert.ok(shown(SvalPanel._els.footer), "and the footer");
  }
);

/**
 * Spec §5.6: placement is device-local, and both sides have to work. Asserted
 * on the box's own position, because the property that moves it is one a
 * declaration alone does not change (see `_applyPlacement`).
 */
add_task(async function placement_puts_the_panel_on_either_side() {
  const { settings } = await withFreshPanel();
  const container = document.getElementById("sval-panel-container");
  const content = document.getElementById("tabbrowser-tabbox");

  Assert.equal(
    settings.placement,
    "left",
    "left is the default a fresh device starts on"
  );
  // Where the box *is* settles after the change: asked in the same turn,
  // `getBoundingClientRect` still reports the old position.
  const panelLeft = () =>
    container.getBoundingClientRect().left <
    content.getBoundingClientRect().left;
  await TestUtils.waitForCondition(panelLeft, "the box settles on the left");
  Assert.less(
    container.getBoundingClientRect().left,
    content.getBoundingClientRect().left,
    "and its box sits left of the content area"
  );

  settings.placement = "right";
  SvalPanel._applyPlacement();
  Assert.equal(
    container.getAttribute("sval-placement"),
    "right",
    "the attribute the stylesheet keys the separator edge on is set"
  );
  await TestUtils.waitForCondition(
    () => !panelLeft(),
    "the box settles on the right"
  );
  Assert.greater(
    container.getBoundingClientRect().left,
    content.getBoundingClientRect().left,
    "and the box itself has moved right of the content area"
  );

  settings.placement = "left";
  SvalPanel._applyPlacement();
  await TestUtils.waitForCondition(panelLeft, "the box settles back left");
  Assert.less(
    container.getBoundingClientRect().left,
    content.getBoundingClientRect().left,
    "and back again"
  );
});

/**
 * The footer holds Favorites, the sync indicator and the feedback button,
 * and no settings button, which the app menu is.
 */
add_task(
  async function the_footer_holds_the_indicator_and_no_settings_button() {
    await withFreshPanel();
    const { footer, syncRow } = SvalPanel._els;

    Assert.deepEqual(
      [...footer.children],
      [
        SvalPanel._els.favorites.parentElement,
        syncRow,
        SvalPanel._els.mediaBar,
        footer.querySelector(".sval-feedback-button"),
      ],
      "the footer holds Favorites, the sync indicator, the media controls " +
        "feedback button"
    );
    Assert.equal(
      SvalPanel._els.root.querySelector('[data-command="openSettings"]'),
      null,
      "nothing in the panel opens settings"
    );
    Assert.ok(!("settingsCog" in SvalPanel._els), "and it holds no cog");
    Assert.equal(
      SvalPanel._dispatch("openSettings", null),
      undefined,
      "nor a command that would work if markup for one reappeared"
    );
  }
);

/**
 * Pairing is a section of Sval's settings, so the panel offers no door of its
 * own into it. Two routes to one flow would mean two offers in the shared
 * folder and two codes with nothing to tell them apart.
 */
add_task(async function the_panel_offers_no_pairing_entry_points() {
  await withFreshPanel();

  for (const command of ["offerCode", "enterCode"]) {
    Assert.equal(
      SvalPanel._els.root.querySelector(`[data-command="${command}"]`),
      null,
      `the panel carries no ${command} button`
    );
    Assert.ok(!(command in SvalPanel._els), `and holds no element for one`);
    Assert.equal(
      SvalPanel._dispatch(command, null),
      undefined,
      `nor a command that would work if markup for it reappeared`
    );
  }
  Assert.equal(
    SvalPanel._els.root.querySelector(".sval-setup-pairing"),
    null,
    "and nothing is left of the row that held them"
  );
});
