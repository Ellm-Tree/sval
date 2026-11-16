/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_pins_helpers.js */

/**
 * Nothing is closed for being unrecognised (favorites-native spec §3.1,
 * §5.5): a pin's page whose Favorite the document does not hold survives a
 * redraw and a pass, and a page closes once another device's delete of its
 * Favorite arrives.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_pins_helpers.js",
  this
);

const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { SvalIdentity } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalIdentity.sys.mjs"
);

add_setup(pinsSetup);

/** The document the other device's passes sync; it holds no tab. */
const TREE = "sval-pins-absence-tree";

/**
 * This profile and another device sharing one folder, which is how a pass
 * on one reads what the other wrote: the window's panel chooses the folder
 * as Settings does, making this profile's sync key if it has none, and the
 * other device holds that key, as pairing gives it, and a folder and local
 * key of its own. The panel goes back to the folder it had when the file
 * ends.
 *
 * @returns {Promise<{store: object, here: object, there: object}>}
 */
async function twoDevices() {
  const shared = await makeTempDir("sval-pins-absence-shared");
  const had = SvalPanel.settings.sharedFolder;
  registerCleanupFunction(() =>
    within(
      SvalPanel.chooseSharedFolder(had),
      10_000,
      "the panel's own folder chosen again"
    )
  );
  const minting = SvalPanel.syncKeyState === SvalIdentity.SYNC_KEY_STATES.none;
  const chosen = await within(
    SvalPanel.chooseSharedFolder(shared, { mint: true }),
    20_000,
    "the panel choosing the shared folder"
  );
  Assert.ok(chosen.reached, "this profile reaches the shared folder");
  if (minting) {
    // Making the key offers its backup on a sheet over the window
    // (`_offerBackupLater`), which the user closes to go on.
    await TestUtils.waitForCondition(
      () => gDialogBox.isOpen,
      "the backup's sheet opens"
    );
    const sheet = gDialogBox.dialog;
    await dialogShown(sheet, "the backup's sheet loading");
    EventUtils.synthesizeKey("KEY_Escape", {}, sheet._frame.contentWindow);
    await TestUtils.waitForCondition(
      () => !gDialogBox.isOpen,
      "Escape closes the sheet"
    );
  }
  const sync = await SvalIdentity.syncKey();
  Assert.equal(
    sync.state,
    SvalIdentity.SYNC_KEY_STATES.present,
    "the profile holds a sync key"
  );
  const there = new SvalEngine({
    root: await makeTempDir("sval-pins-absence-there"),
    sharedRoot: shared,
    localKey: randomBytes(32),
    syncKey: sync.bytes,
    deviceId: randomBytes(16),
  });
  registerCleanupFunction(() => stopEngine(there));
  await there.openDocument("favorites", null);
  return { store: pinsFixture.store, here: SvalPanel, there };
}

add_task(async function a_page_is_closed_by_a_delete_and_never_by_absence() {
  const { store, here, there } = await twoDevices();
  const url = `${PAGE}?absence=1`;
  const entry = { url, title: "Known" };
  const [known] = await store.insertTree([], { pins: [entry] });
  atTaskEnd(async () => {
    closePinPages();
    if (store.get(known)) {
      await store.delete(known);
    }
  });
  await clickTile(known, url);

  // A page of a Favorite this device's document does not hold, as at launch
  // before the profile's copy is read.
  const unknown = "absent000001";
  const pages = SvalPinPages.of(window);
  pages.select({ guid: unknown, url: PAGE2, name: "Unknown" });
  await TestUtils.waitForCondition(
    () => pages.tabOf(unknown),
    "the unknown Favorite's page opens"
  );

  await SvalPanel.pins.refresh();
  Assert.equal(
    await within(here.syncWithFolder(), 20_000, "this profile's pass"),
    "reached",
    "this profile's pass reaches the folder"
  );
  await within(store.whenIdle(), 10_000, "store going idle");
  await SvalPanel.pins.refresh();
  Assert.ok(pages.tabOf(unknown), "a redraw and a pass leave it open");
  Assert.ok(pages.tabOf(known), "and the known Favorite's page too");

  // The other device has the Favorite, then deletes it.
  await there.sync(TREE);
  const id = await there.favoriteId(known);
  Assert.ok(
    (await there.favorites("favorites")).some(row => row.id === id),
    "the other device holds the Favorite"
  );
  await there.mutate({
    kind: "remove",
    document: "favorites",
    id,
    now: Date.now(),
  });
  await there.sync(TREE);
  await within(here.syncWithFolder(), 20_000, "this profile's pass");
  await within(store.whenIdle(), 10_000, "store going idle");
  await TestUtils.waitForCondition(
    () => !pages.tabOf(known),
    "the delete that arrived closes its page"
  );
  Assert.ok(!store.get(known), "and the Favorite is gone here");
  Assert.ok(pages.tabOf(unknown), "the unknown Favorite's page stays open");
  closePinPages();
});
