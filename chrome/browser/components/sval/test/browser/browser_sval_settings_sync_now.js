/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The button on Sval's settings page that asks for a sync pass, and the
 * words that say when the last one finished, in the page and in the panel's
 * sync indicator (spec §6.4, §10.8). The rest of the settings page is in
 * `browser_sval_settings.js`; the helpers the files share are in `head.js`.
 *
 * The panel's half is asserted too: nothing that starts a pass is left there,
 * and everything that reports one still is.
 */

const { SvalSharedFolder } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
);
const SvalPanelModel = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);
const SvalTree = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTree.sys.mjs"
);
const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { SvalTestDeny } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestDeny.sys.mjs"
);

// What a last-synced time reads as, from the model both readers draw from.
const NOT_SYNCED = SvalPanelModel.lastSyncedText(null, 0);
const JUST_NOW = SvalPanelModel.lastSyncedText(0, 0);
/* import-globals-from ../../sval-panel.js */

/**
 * Chooses a shared folder that is not there yet, so the panel has synced
 * nothing with it and its readouts have nothing to report, then makes it
 * there as a folder Sval chose, holding `sval/`, for the next pass to reach.
 * A choice resets what the panel knew of the last folder, `_lastSynced`
 * included, and its pass finds this one away.
 *
 * @param {object} device `panelOnAFolder`'s result.
 * @returns {Promise<string>} the folder.
 */
async function aFolderNotYetSynced(device) {
  const shared = PathUtils.join(await device.folder("later"), "shared");
  await within(SvalSharedFolder._whenIdle(), 45_000, "the helper's exit");
  const chosen = await SvalPanel.chooseSharedFolder(shared);
  Assert.ok(!chosen.reached, "the folder is not there yet");
  Assert.strictEqual(SvalPanel.lastSynced, null, "so nothing has synced");
  await IOUtils.makeDirectory(PathUtils.join(shared, "sval"), {
    createAncestors: true,
  });
  await within(SvalSharedFolder._whenIdle(), 45_000, "the helper's exit");
  return shared;
}

/**
 * Driven through the page's own button and asserted against the panel's own
 * footer (spec §6.4), because the wiring between them is what is under test.
 */
add_task(async function syncing_from_settings_updates_the_panels_timestamp() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const device = await panelOnAFolder("sync");
  await aFolderNotYetSynced(device);
  const ui = await openSvalSettings();

  Assert.equal(
    SvalPanel._els.indicator.title,
    NOT_SYNCED,
    "the panel has nothing to report before the pass under test"
  );

  await syncFromSettings(ui);

  Assert.equal(
    SvalPanel._els.indicator.title,
    JUST_NOW,
    "the panel's indicator says when the pass asked for here finished"
  );
  Assert.equal(
    SvalPanel.engine,
    device.engine,
    "the pass ran on the panel's engine; the page acquired none of its own"
  );
  Assert.ok(
    !ui.els.syncNow.disabled,
    "and the button comes back, so a second pass can be asked for"
  );
});

/**
 * With no shared folder nothing is synced, so the page has no last-synced
 * text to show beside the button, and nothing in it claims otherwise. The
 * panel shows no sync indicator.
 */
add_task(async function settings_shows_no_last_synced_text_with_no_folder() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  await panelOnAFolder("none");
  const ui = await openSvalSettings();

  Assert.equal(SvalPanel.folderState, "none", "no shared folder is chosen");
  Assert.equal(
    ui.els.syncLast.textContent,
    "",
    "the page says nothing about when sval last synced"
  );

  await syncFromSettings(ui);
  Assert.equal(
    ui.els.syncLast.textContent,
    "",
    "and a pass changes nothing about that, because it reached no folder"
  );
  Assert.ok(
    SvalPanel._els.syncRow.hidden,
    "and the panel's footer has no sync indicator (messages spec §3)"
  );
});

/**
 * Spec §10.8 puts a copy of the last-synced time (§6.4) beside the button
 * that starts a pass, and a copy that moved only when this page pressed the
 * button would go stale while its reader watched it. Driven through a pass
 * the panel runs for itself, the kind this page has no other way of hearing
 * about.
 */
add_task(async function a_background_pass_redraws_this_pages_timestamp() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const device = await panelOnAFolder("background");
  await aFolderNotYetSynced(device);
  const ui = await openSvalSettings();
  Assert.equal(
    ui.els.syncLast.textContent,
    NOT_SYNCED,
    "the page has nothing to report before the pass under test"
  );

  // A pass the panel runs for itself, as the observer's poll does once the
  // background step is due: that is thirty seconds after the choice's own
  // step (`SHARED_INTERVAL_MS`), past what a task may wait.
  Assert.equal(await SvalPanel.syncWithFolder(), "reached");
  await TestUtils.waitForCondition(
    () => ui.els.syncLast.textContent === JUST_NOW,
    "a pass this page did not ask for redrew it anyway"
  );
  Assert.equal(
    SvalPanel._els.indicator.title,
    ui.els.syncLast.textContent,
    "saying the same thing the panel says, because it is the same signal"
  );

  // Nothing the page registered outlives it, or every later pass writes into
  // a document that has gone away.
  const following = syncFollowers();
  BrowserTestUtils.removeTab(ui.tab);
  Assert.less(
    syncFollowers(),
    following,
    "and the page stopped following the panel when it went away"
  );
});

/**
 * Every window's panel runs passes for the profile, and the page follows
 * them all: one in a window other than the page's still redraws it, so the
 * readout does not depend on which window's panel was up when the page
 * opened, or on that window staying open.
 */
add_task(async function a_pass_in_another_window_redraws_this_page() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  await panelOnAFolder("another-window", { shared: true });
  const ui = await openSvalSettings();

  const other = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    20_000,
    "a second window"
  );
  expectWorkspaceTabs(other);
  await within(other.SvalPanel.started, 40_000, "its panel's startup");
  const state = ui.page.document.getElementById("sval-sync-state");
  Assert.notEqual(state.dataset.state, "problem", "the readout is calm");
  try {
    // A denied folder shows at once, so the readout has something to redraw
    // to after one pass (`syncIndicator` in SvalPanelModel.sys.mjs).
    const sval = PathUtils.join(SvalPanel.sharedRootSetting(), "sval");
    atTaskEnd(() => SvalTestDeny.allow(sval));
    await SvalTestDeny.read(sval);
    await within(SvalSharedFolder._whenIdle(), 45_000, "the helper's exit");
    Assert.equal(
      await other.SvalPanel.syncWithFolder(),
      "unreachable",
      "the other window's pass cannot read the folder"
    );
    await TestUtils.waitForCondition(
      () => state.dataset.state === "problem",
      "the other window's pass redrew the readout"
    );
  } finally {
    await within(
      BrowserTestUtils.closeWindow(other),
      20_000,
      "closing the second window"
    );
  }
});

/** How many observers follow the panel's sync passes. */
function syncFollowers() {
  return [...Services.obs.enumerateObservers(SvalPanelModel.SYNC_STATE_TOPIC)]
    .length;
}

/**
 * A pass started from this page still reports in the panel's indicator
 * (messages spec §3): a peer on a newer build asks for an update there.
 *
 * The peer's file carries a newer envelope format. The engine reads that
 * version byte before it decrypts anything (`open` in engine/src/crypto.rs),
 * so the file is the one a newer build writes, as far as this build can
 * tell.
 */
add_task(async function a_pass_asked_for_here_still_reports_in_the_panel() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  await panelOnAFolder("notices", { shared: true });
  const root = SvalPanel.sharedRootSetting();
  const { syncKey } = await svalKeys();
  const peer = new SvalEngine({
    root,
    keyBytes: syncKey,
    deviceId: randomBytes(16),
  });
  atTaskEnd(() => stopEngine(peer));
  await peer.mutate({
    kind: "addWorkspace",
    name: "On a newer build",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  const { wrote } = await peer.sync(SvalTree.SYNC_DOCUMENT, Date.now());
  Assert.notEqual(wrote, null, "the peer published its file");
  const file = PathUtils.join(root, ...wrote.split("/"));
  const bytes = await IOUtils.read(file);
  // The magic, then the format's version byte.
  bytes[3] += 1;
  await IOUtils.write(file, bytes);

  const ui = await openSvalSettings();
  const { indicator, syncActions } = SvalPanel._els;
  await within(SvalSharedFolder._whenIdle(), 45_000, "the helper's exit");
  await syncFromSettings(ui);
  Assert.equal(
    indicator.dataset.state,
    "newer-schema",
    "a peer on a newer build asks for an update in the panel's indicator"
  );
  Assert.equal(indicator.dataset.severity, "warning", "as a warning");
  Assert.ok(
    syncActions.querySelector('[data-command="checkForUpdate"]'),
    "with the button that checks for one"
  );
});

/**
 * A file from another device that cannot be read is not shown at all: it
 * clears when that device next writes.
 */
add_task(async function an_unreadable_peer_file_leaves_the_panel_synced() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  await panelOnAFolder("unreadable", { shared: true });
  const ui = await openSvalSettings();
  // Beside this device's own file, where a peer on this key writes: bytes
  // no key opens.
  const ws = PathUtils.join(SvalPanel.sharedRootSetting(), "sval", "ws");
  const [dir] = await IOUtils.getChildren(ws);
  await IOUtils.write(
    PathUtils.join(dir, `${"ab".repeat(16)}.json`),
    randomBytes(256)
  );

  await syncFromSettings(ui);
  Assert.ok(
    SvalPanel.lastPass?.errors?.length,
    "the pass met the file it cannot read"
  );
  Assert.equal(
    SvalPanel._els.indicator.dataset.severity,
    "synced",
    "a file sval cannot read leaves the indicator synced"
  );
});

/**
 * Both halves in one assertion block, because the button belongs on the
 * settings page only while the panel keeps the indicator.
 */
add_task(async function the_panel_offers_no_sync_button() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  Assert.equal(
    SvalPanel._els.root.querySelector('[data-command="syncNow"]'),
    null,
    "the panel carries no button that starts a pass"
  );
  Assert.ok(
    SvalPanel._els.indicator,
    "while the indicator that says how the last pass went stays in the panel"
  );
  Assert.equal(
    typeof SvalPanel.syncNow,
    "function",
    "the pass itself is still the panel's; settings only asks for one"
  );
});

/**
 * A user whose panel is collapsed has nowhere else to read the last-synced
 * time (spec §6.4).
 */
add_task(async function settings_says_when_the_last_sync_finished() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const device = await panelOnAFolder("stamp", { shared: true });

  let ui = await openSvalSettings();
  Assert.ok(
    ui.els.syncLast.textContent,
    "the page says where the last pass got to as soon as it is opened"
  );
  await closeSvalSettings(ui);

  await aFolderNotYetSynced(device);
  ui = await openSvalSettings();
  Assert.equal(
    ui.els.syncLast.textContent,
    NOT_SYNCED,
    "and has the same nothing to report as the panel when there is none"
  );

  await syncFromSettings(ui);

  Assert.equal(
    ui.els.syncLast.textContent,
    JUST_NOW,
    "and after the pass it says so beside the button that asked for it"
  );
  Assert.equal(
    SvalPanel._els.indicator.title,
    JUST_NOW,
    "while the panel's indicator says it too: this is a second reader"
  );
});
