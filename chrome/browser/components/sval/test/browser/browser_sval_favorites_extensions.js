/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from sval_favorites_menu_helpers.js */
/* globals browser */

/**
 * Extensions' bookmarks are Favorites (favorites-native spec §8): what an
 * extension does through `browser.bookmarks` shows in the Favorites menu,
 * and a change made in the menu or on another device reaches the
 * extension's listeners.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_favorites_menu_helpers.js",
  this
);

const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);

/** The name every pass in this file runs under. */
const DOCUMENT = "workspace-under-test";

const A = "https://example.com/a";
const B = "https://example.com/b";
const C = "https://example.com/c";

/** The folder both devices exchange files through, their key, and ours. */
let folder;
let keyBytes;
let engine;

add_setup(async function () {
  await TestUtils.waitForCondition(() => SvalPanel._els?.favoritesMenu);
  folder = await makeTempDir("sval-favorites-extensions");
  keyBytes = randomBytes(32);
  ({ engine } = await favoritesFixture({
    root: folder,
    sharedRoot: folder,
    keyBytes,
  }));
});

/**
 * An extension with the bookmarks permission that calls `browser.bookmarks`
 * as the test asks, answering "done", and sends each event it hears as
 * "event".
 *
 * @returns {Promise<object>} The extension, started.
 */
async function bookmarksExtension() {
  const extension = ExtensionTestUtils.loadExtension({
    manifest: { permissions: ["bookmarks"] },
    background() {
      for (const name of ["onCreated", "onMoved", "onChanged", "onRemoved"]) {
        browser.bookmarks[name].addListener((id, info) =>
          browser.test.sendMessage("event", { name, id, info })
        );
      }
      browser.test.onMessage.addListener(async (method, args) => {
        const result = await browser.bookmarks[method](...args);
        browser.test.sendMessage("done", result ?? null);
      });
      browser.test.sendMessage("ready");
    },
  });
  await extension.startup();
  await within(extension.awaitMessage("ready"), 10_000, "the extension ready");
  return extension;
}

/**
 * @param {object} extension
 * @param {string} method A `browser.bookmarks` function.
 * @param {...*} args
 * @returns {Promise<*>} What it answered.
 */
async function call(extension, method, ...args) {
  extension.sendMessage(method, args);
  return within(extension.awaitMessage("done"), 10_000, `bookmarks.${method}`);
}

/**
 * @param {object} extension
 * @returns {Promise<object>} The next event it heard: `{ name, id, info }`.
 */
function nextEvent(extension) {
  return within(extension.awaitMessage("event"), 10_000, "a bookmarks event");
}

/**
 * Opens Favorites and waits for the menu to show `names`, in order, at its
 * top level.
 *
 * @param {string[]} names
 * @param {string} what
 */
async function menuShows(names, what) {
  const popup = await openFavorites();
  const shown = () =>
    Array.from(popup.querySelectorAll(":scope > menuitem[data-guid]")).map(el =>
      el.getAttribute("label")
    );
  await TestUtils.waitForCondition(
    () => JSON.stringify(shown()) === JSON.stringify(names),
    `${what}: ${JSON.stringify(names)}`
  );
  await closeMenus();
}

add_task(async function an_extensions_changes_show_in_the_menu() {
  await emptyFavorites();
  const extension = await bookmarksExtension();

  const alpha = await call(extension, "create", { title: "Alpha", url: A });
  const beta = await call(extension, "create", { title: "Beta", url: B });
  await menuShows(["Alpha", "Beta"], "the menu shows what it made");

  await call(extension, "move", beta.id, { index: 0 });
  await menuShows(["Beta", "Alpha"], "and where it moved one");

  await call(extension, "update", alpha.id, { title: "Renamed" });
  await menuShows(["Beta", "Renamed"], "and what it renamed one");

  await call(extension, "remove", beta.id);
  await menuShows(["Renamed"], "and not what it removed");

  const heard = [];
  for (let i = 0; i < 5; i++) {
    const { name, id } = await nextEvent(extension);
    heard.push([name, id]);
  }
  Assert.deepEqual(
    heard,
    [
      ["onCreated", alpha.id],
      ["onCreated", beta.id],
      ["onMoved", beta.id],
      ["onChanged", alpha.id],
      ["onRemoved", beta.id],
    ],
    "it heard each of its own changes"
  );
  await extension.unload();
});

add_task(async function a_menu_change_and_another_devices_fire_events() {
  await emptyFavorites();
  const [guid] = await favoritesStore().insertTree([
    { title: "Alpha", url: A },
  ]);
  const extension = await bookmarksExtension();

  const popup = await openFavorites();
  const menu = await contextOn(await itemIn(popup, n => n.uri === A));
  await chooseInContextMenu(menu, "delete");
  await closeMenus();
  const removed = await nextEvent(extension);
  Assert.equal(removed.name, "onRemoved", "a delete in the menu is heard");
  Assert.equal(removed.id, guid, "for the favorite deleted");
  Assert.equal(removed.info.parentId, FAVORITES_ROOT, "from Favorites");
  Assert.equal(removed.info.node.title, "Alpha", "with what it held");

  const peer = new SvalEngine({
    root: folder,
    sharedRoot: folder,
    keyBytes,
    deviceId: randomBytes(16),
  });
  const theirs = new SvalFavoritesStore({
    engine: peer,
    requestPass: () => {},
  });
  registerCleanupFunction(async () => {
    theirs.stop();
    await stopEngine(peer);
  });
  await theirs.start();
  const ours = favoritesStore();
  const fromThem = async () => {
    await peer.sync(DOCUMENT, Date.now());
    await within(ours.whenIdle(), 10_000, "ours going idle");
    await engine.sync(DOCUMENT, Date.now());
    await within(ours.whenIdle(), 10_000, "ours going idle");
  };

  const added = await theirs.add({ url: C, title: "Gamma" });
  await fromThem();
  const created = await nextEvent(extension);
  Assert.deepEqual(
    [created.name, created.id, created.info.title, created.info.url],
    ["onCreated", added, "Gamma", C],
    "a favorite another device adds is heard"
  );
  Assert.equal(created.info.parentId, FAVORITES_ROOT, "in Favorites");

  await theirs.rename(added, "Renamed");
  await fromThem();
  const changed = await nextEvent(extension);
  Assert.deepEqual(
    [changed.name, changed.id, changed.info],
    ["onChanged", added, { title: "Renamed" }],
    "and its rename"
  );

  await theirs.delete(added);
  await fromThem();
  const gone = await nextEvent(extension);
  Assert.deepEqual(
    [gone.name, gone.id, gone.info.node.title],
    ["onRemoved", added, "Renamed"],
    "and its deletion"
  );
  await extension.unload();
});
