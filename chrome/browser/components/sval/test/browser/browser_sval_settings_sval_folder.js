/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Sval's own folder in the sync folder, from the settings page (spec §10.8):
 * a deleted one is not made again until asked, choosing a folder makes it or
 * waits to be confirmed, and choosing or syncing while Sval's folder work
 * holds the helper waits its turn. `browser_sval_settings_folder.js` holds
 * the folder's other states; the helpers they share are in `head.js`.
 */

const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { SvalSharedFolder } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
);
const { SYNC_DOCUMENT } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTree.sys.mjs"
);

/* import-globals-from ../../sval-panel.js */

const MockFilePicker = SpecialPowers.MockFilePicker;

add_setup(async function () {
  MockFilePicker.init();
  registerCleanupFunction(() => MockFilePicker.cleanup());
});

/** Spec §6 test 6. */
add_task(async function a_deleted_sval_folder_is_not_recreated_until_asked() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const device = await panelOnAFolder("reuse");
  const shared = await device.folder("shared");
  Assert.ok(
    (await SvalPanel.chooseSharedFolder(shared)).reached,
    "first use publishes"
  );

  const peer = new SvalEngine({
    root: await device.folder("peer-local"),
    sharedRoot: shared,
    localKey: randomBytes(32),
    syncKey: (await svalKeys()).syncKey,
    deviceId: randomBytes(16),
  });
  registerCleanupFunction(() => stopEngine(peer));
  Assert.equal((await peer.sync(SYNC_DOCUMENT, Date.now())).shared, "reached");
  await keyCopyIn(shared, "the step that reached the folder left the key");

  await IOUtils.remove(PathUtils.join(shared, "sval"), { recursive: true });
  await SvalPanel.syncWithFolder();
  Assert.equal(
    SvalPanel.syncState.folderState,
    "unreachable",
    "a used folder without sval/"
  );
  Assert.ok(
    !(await IOUtils.exists(PathUtils.join(shared, "sval"))),
    "and sval did not recreate it"
  );
  await SvalSharedFolder._whenIdle();
  Assert.equal(
    (await peer.sync(SYNC_DOCUMENT, Date.now())).shared,
    "unreachable",
    "the other device finds it unreachable too"
  );

  const ui = await openSvalSettings("storage");
  Assert.ok(
    ui.els.storageText.textContent,
    "the card says Sval can't find its files"
  );
  Assert.equal(ui.els.folderPath.textContent, shared, "in the folder named");
  Assert.ok(!ui.els.storageReuse.hidden, "Use this folder again is offered");
  Assert.ok(
    !ui.els.storageChoose.hidden && !("tone" in ui.els.storageChoose.dataset),
    "beside choosing another"
  );
  Assert.equal(
    ui.page.document.activeElement,
    ui.els.storageReuse,
    "and has the caret"
  );

  ui.els.storageReuse.click();
  await TestUtils.waitForCondition(
    () => ui.els.storageReuse.hidden,
    "the page redrew once the folder was reached"
  );
  Assert.ok(
    await IOUtils.exists(PathUtils.join(shared, "sval")),
    "sval/ is back"
  );
  await SvalSharedFolder._whenIdle();
  const recovered = await peer.sync(SYNC_DOCUMENT, Date.now());
  Assert.equal(
    recovered.shared,
    "reached",
    "the other device recovers by itself"
  );
  Assert.ok(device.workspace in (await nodes(peer)));
});

/**
 * Choosing a folder makes `sval/` in it before anything is synced there, so a
 * folder that answers is the one chosen and not an empty mount point. A step
 * finds a folder without `sval/` unavailable (`folderProblem` in
 * SvalSharedFolder.sys.mjs, and the task after this), so a choice of an
 * empty folder that is reached made `sval/` before its first step.
 */
add_task(async function choosing_a_folder_makes_sval_in_it() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const device = await panelOnAFolder("marks");
  const shared = await device.folder("marked");
  Assert.deepEqual(await IOUtils.getChildren(shared), [], "an empty folder");
  Assert.ok(
    (await SvalPanel.chooseSharedFolder(shared)).reached,
    "is reached once chosen"
  );
  Assert.ok(await IOUtils.exists(PathUtils.join(shared, "sval", "ws")));
});

/**
 * A chosen folder that does not hold `sval/`, as one chosen and never synced
 * into may not, is unavailable: nothing is written there, and the page offers
 * to use it, which makes `sval/` and syncs. Choosing it again does the same.
 */
add_task(async function a_chosen_folder_without_sval_waits_to_be_confirmed() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const device = await panelOnAFolder("unmarked");
  const shared = await device.folder("unmarked-shared");
  Assert.ok((await SvalPanel.chooseSharedFolder(shared)).reached);
  // What a folder chosen and never synced into looks like: the folder is
  // there, and `sval/` is not.
  await keyCopyIn(shared, "the step that reached the folder left the key");
  await IOUtils.remove(PathUtils.join(shared, "sval"), { recursive: true });
  await within(SvalSharedFolder._whenIdle(), 45_000, "the helper's exit");
  Assert.equal(await SvalPanel.syncWithFolder(), "unreachable");
  Assert.deepEqual(await IOUtils.getChildren(shared), [], "nothing written");

  const ui = await openSvalSettings("storage");
  Assert.ok(
    ui.els.storageText.textContent,
    "the card says Sval can't find its files"
  );
  Assert.ok(!ui.els.storageReuse.hidden, "Use this folder again is offered");
  ui.els.storageReuse.click();
  await TestUtils.waitForCondition(
    () => ui.els.storageReuse.hidden,
    "the page redrew once the folder was reached"
  );
  Assert.equal(SvalPanel.syncState.folderState, "reached");
  Assert.ok(
    (await IOUtils.getChildren(PathUtils.join(shared, "sval", "ws"))).length,
    "the folder received this device's document"
  );

  // The step that reached the folder can still be writing in it. The key
  // copy is not written again, since this session wrote it here
  // (`_publishKeyCopy`).
  await within(SvalSharedFolder._whenIdle(), 45_000, "the helper's exit");
  await IOUtils.remove(PathUtils.join(shared, "sval"), { recursive: true });
  await SvalSharedFolder._whenIdle();
  Assert.equal(await SvalPanel.syncWithFolder(), "unreachable");
  await SvalSharedFolder._whenIdle();
  MockFilePicker.useDirectory(shared);
  ui.els.storageChoose.click();
  await TestUtils.waitForCondition(
    () => ui.els.storageReuse.hidden,
    "choosing the same folder again confirms it"
  );
  Assert.equal(SvalPanel.syncState.folderState, "reached");
  Assert.ok(await IOUtils.exists(PathUtils.join(shared, "sval", "ws")));
});

/**
 * Picking `sval/` itself in Settings chooses the folder that holds it (spec
 * §6.4): Sval's files stay where they are, and no `sval/` is made inside it.
 */
add_task(async function picking_sval_itself_chooses_its_folder() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const device = await panelOnAFolder("pick-sval");
  const shared = await device.folder("pick-sval-shared");
  const inner = PathUtils.join(shared, "sval");
  await IOUtils.makeDirectory(PathUtils.join(inner, "keys"), {
    createAncestors: true,
  });

  const ui = await openSvalSettings("storage");
  MockFilePicker.useDirectory(inner);
  ui.els.storageChoose.click();
  await TestUtils.waitForCondition(
    () =>
      SvalPanel.sharedRootSetting() !== null && !ui.els.storageChoose.disabled,
    "the picked folder is chosen"
  );
  Assert.equal(SvalPanel.sharedRootSetting(), shared, "its folder is stored");
  Assert.equal(SvalPanel.syncState.folderState, "reached", "and reached");
  Assert.ok(
    await IOUtils.exists(PathUtils.join(inner, "ws")),
    "this device's document went into the sval folder picked"
  );
  Assert.ok(
    !(await IOUtils.exists(PathUtils.join(inner, "sval"))),
    "and no sval folder was made inside it"
  );
});

/**
 * Choosing a folder, and using it again, while Sval's own folder work holds
 * the helper wait their turn and reach the folder.
 */
add_task(async function choosing_a_folder_while_sval_uses_one_reaches_it() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const device = await panelOnAFolder("busy-choice");
  const shared = await device.folder("shared");
  await IOUtils.makeDirectory(PathUtils.join(shared, "sval"));
  const ahead = () =>
    SvalSharedFolder.exists({
      root: shared,
      path: "sval",
      deadline: Date.now() + 20_000,
    });

  let other = ahead();
  const chosen = await SvalPanel.chooseSharedFolder(shared);
  Assert.ok(chosen.reached, `the folder was reached: ${chosen.message}`);
  await within(other, 20_000, "the other request");

  other = ahead();
  const again = await SvalPanel.useFolderAgain();
  Assert.ok(again.reached, `and reached again: ${again.message}`);
  await within(other, 20_000, "the other request");
});

/**
 * "Sync now" pressed while Sval's own folder work holds the helper waits its
 * turn and syncs: Sval's own work is not a busy folder.
 */
add_task(async function sync_now_while_sval_uses_the_folder_syncs() {
  await within(SvalPanel.started, 10_000, "the panel starting");
  await panelOnAFolder("busy-sync", { shared: true });
  const ui = await openSvalSettings();
  const state = () =>
    ui.page.document.getElementById("sval-sync-state").dataset.state;
  const other = SvalSharedFolder.exists({
    root: SvalPanel.sharedRootSetting(),
    path: "sval",
    deadline: Date.now() + 20_000,
  });
  await syncFromSettings(ui);
  Assert.equal(ui.els.syncStatus.textContent, "", "nothing is said");
  Assert.equal(state(), "synced", "and the folder synced");
  await within(other, 20_000, "the other request");
});
