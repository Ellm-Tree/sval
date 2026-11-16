/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Each device's favorite icons (favorites-native spec §5.4): kept in a file
 * of the profile's, through a restart, and gone only when the last favorite
 * holding the address is deleted or re-addressed, here or on another device.
 * An address the document does not hold keeps its icon.
 */

const { makeTempDir, tempPath } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { SvalFavoritesStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs"
);
const { SvalFavoriteIconStore, MAX_ICON_LENGTH } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFavoriteIcons.sys.mjs"
);

const { within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);

do_get_profile();

const TREE = "workspace-under-test";
const GMAIL = "https://gmail.example/";
const MAIL = "https://mail.example/inbox";
const ICON = "data:image/png;base64,iVBORw0KGgo=";
const OTHER_ICON = "data:image/png;base64,R0lGODlh";

/** A device's Favorites and icons, sharing one folder with its peers. */
async function devices() {
  const root = await makeTempDir("sval-favorite-icons");
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  let tick = 10_000;
  const now = () => (tick += 1000);
  const made = [];
  registerCleanupFunction(() =>
    made.forEach(d => {
      d.store.stop();
      d.engine.terminate();
    })
  );
  return async () => {
    const engine = new SvalEngine({
      root,
      sharedRoot: root,
      keyBytes,
      deviceId: crypto.getRandomValues(new Uint8Array(16)),
    });
    const store = new SvalFavoritesStore({
      engine,
      requestPass: () => {},
      now,
    });
    const icons = new SvalFavoriteIconStore({
      path: tempPath("sval-favorite-icons", ".json"),
    });
    store.addChangeListener(change => icons.onFavoritesChanged(store, change));
    await store.start();
    await icons.load();
    const device = {
      engine,
      store,
      icons,
      pass: async () => {
        await engine.sync(TREE, now());
        await within(store.whenIdle(), 10_000, "store going idle");
      },
    };
    made.push(device);
    return device;
  };
}

add_task(async function an_icon_lasts_a_restart() {
  const path = tempPath("sval-favorite-icons", ".json");
  const first = new SvalFavoriteIconStore({ path });
  await first.load();
  first.remember(GMAIL, ICON);
  await first.flush();
  const second = new SvalFavoriteIconStore({ path });
  Assert.equal(second.iconFor(GMAIL), null, "nothing before the file is read");
  await second.load();
  Assert.equal(second.iconFor(GMAIL), ICON, "the icon is read back");
  Assert.equal(
    second.iconFor("https://GMAIL.example"),
    ICON,
    "under the address as a favorite holds it"
  );
});

add_task(async function only_a_small_data_icon_is_kept() {
  const icons = new SvalFavoriteIconStore({
    path: tempPath("sval-favorite-icons", ".json"),
  });
  await icons.load();
  icons.remember(GMAIL, "https://gmail.example/favicon.ico");
  Assert.equal(icons.iconFor(GMAIL), null, "a remote icon is not kept");
  icons.remember(GMAIL, `data:image/png;base64,${"A".repeat(MAX_ICON_LENGTH)}`);
  Assert.equal(icons.iconFor(GMAIL), null, "an oversized icon is not kept");
});

add_task(
  async function deleting_the_last_favorite_of_an_address_drops_its_icon() {
    const device = await (await devices())();
    const { store, icons } = device;
    const [one, two] = await store.insertTree([
      { title: "Gmail", url: GMAIL },
      { title: "Gmail again", url: GMAIL },
    ]);
    icons.remember(GMAIL, ICON);
    await store.delete(one);
    Assert.equal(icons.iconFor(GMAIL), ICON, "another favorite still holds it");
    await store.delete(two);
    Assert.equal(icons.iconFor(GMAIL), null, "the last one took its icon");
  }
);

add_task(async function a_delete_before_the_file_is_read_still_drops_it() {
  const path = tempPath("sval-favorite-icons", ".json");
  const earlier = new SvalFavoriteIconStore({ path });
  await earlier.load();
  earlier.remember(GMAIL, ICON);
  await earlier.flush();

  const device = await (await devices())();
  const { store } = device;
  const [guid] = await store.insertTree([{ title: "Gmail", url: GMAIL }]);
  const icons = new SvalFavoriteIconStore({ path });
  store.addChangeListener(change => icons.onFavoritesChanged(store, change));
  await store.delete(guid);
  await icons.load();
  Assert.equal(icons.iconFor(GMAIL), null, "the deleted favorite's icon");
  await icons.flush();
  const later = new SvalFavoriteIconStore({ path });
  await later.load();
  Assert.equal(later.iconFor(GMAIL), null, "and the file forgot it too");
});

add_task(async function re_addressing_a_favorite_drops_the_old_address_icon() {
  const device = await (await devices())();
  const { store, icons } = device;
  const [guid] = await store.insertTree([{ title: "Mail", url: GMAIL }]);
  icons.remember(GMAIL, ICON);
  await store.rename(guid, "Renamed");
  Assert.equal(icons.iconFor(GMAIL), ICON, "a rename keeps it");
  await store.setAddress(guid, MAIL);
  Assert.equal(icons.iconFor(GMAIL), null, "the old address's icon goes");
});

add_task(async function an_address_no_favorite_holds_keeps_its_icon() {
  const device = await (await devices())();
  const { store, icons } = device;
  icons.remember(MAIL, OTHER_ICON);
  const [guid] = await store.insertTree([{ title: "Gmail", url: GMAIL }]);
  icons.remember(GMAIL, ICON);
  await store.delete(guid);
  Assert.equal(
    icons.iconFor(MAIL),
    OTHER_ICON,
    "an icon for an address the document does not hold stays"
  );
});

add_task(async function a_delete_on_another_device_drops_the_icon_here() {
  const make = await devices();
  const here = await make();
  const there = await make();
  const [guid] = await here.store.insertTree([{ title: "Gmail", url: GMAIL }]);
  await here.pass();
  await there.pass();
  Assert.ok(there.store.get(guid), "the favorite reached the other device");
  here.icons.remember(GMAIL, ICON);
  // A pass that brings nothing about the favorite leaves its icon.
  await here.pass();
  Assert.equal(
    here.icons.iconFor(GMAIL),
    ICON,
    "a pass naming nothing keeps it"
  );
  await there.store.delete(guid);
  await there.pass();
  await here.pass();
  Assert.ok(!here.store.get(guid), "the delete arrived");
  Assert.equal(here.icons.iconFor(GMAIL), null, "and took the icon with it");
});
