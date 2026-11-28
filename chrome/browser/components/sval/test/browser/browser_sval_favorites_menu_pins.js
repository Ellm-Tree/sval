/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from sval_favorites_menu_helpers.js */

/**
 * Pins and the panel's Favorites menu (pins-root spec §6): the menu draws the
 * whole Favorites root, and "Pin" copies a favorite or folder into the row,
 * leaving it where it is.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_favorites_menu_helpers.js",
  this
);

const A = "https://example.com/a";
const P = "https://example.com/p";
const B = "https://example.com/b";
const Q = "https://example.com/q";
const C = "https://example.com/c";

/**
 * Favorites A, P, a folder holding B and Q, then C.
 *
 * @returns {Promise<{p: string, folder: string, q: string}>} guids.
 */
async function seed() {
  await emptyFavorites();
  const store = favoritesStore();
  const [, p, folder] = await store.insertTree([
    { title: "A", url: A },
    { title: "P", url: P },
    {
      title: "Folder",
      children: [
        { title: "B", url: B },
        { title: "Q", url: Q },
      ],
    },
    { title: "C", url: C },
  ]);
  return { p, folder, q: favoritesFor(Q)[0].guid };
}

/**
 * @param {string} guid A folder.
 * @returns {string[]} the guids it holds, in the document's order.
 */
function guidsIn(guid) {
  return favoritesStore()
    .children(guid)
    .map(row => row.guid);
}

/**
 * @param {Element} popup
 * @returns {string[]} what a menu draws, in order: a guid for each favorite
 *   or folder, "-" for anything else.
 */
function drawn(popup) {
  return Array.from(popup.children)
    .filter(el => !el.hidden && el.localName !== "menupopup")
    .map(el => el.dataset.guid ?? "-");
}

/**
 * Opens the submenu of the folder item `menu`.
 *
 * @param {Element} menu
 * @returns {Promise<Element>} its popup.
 */
async function openFolder(menu) {
  const shown = BrowserTestUtils.waitForPopupEvent(menu.menupopup, "shown");
  menu.openMenu(true);
  await within(shown, 10_000, "a folder's submenu showing");
  return menu.menupopup;
}

/**
 * Dispatches a drag event at `target`, `at` of the way down it.
 *
 * @param {string} type
 * @param {Element} target
 * @param {DataTransfer} dataTransfer
 * @param {number} [at]
 * @returns {DragEvent}
 */
function drag(type, target, dataTransfer, at = 0.5) {
  const rect = target.getBoundingClientRect();
  const event = new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    dataTransfer,
    clientX: rect.x + rect.width / 2,
    clientY: rect.y + rect.height * at,
  });
  target.dispatchEvent(event);
  return event;
}

add_setup(async function () {
  await TestUtils.waitForCondition(() => SvalPanel._els?.favoritesMenu);
  await favoritesFixture();
});

/**
 * Pin copies a favorite into the row with a guid of its own, and the menu
 * still draws the favorite where it was. A favorite whose address a pin has
 * is offered no Pin.
 */
add_task(async function pin_copies_a_favorite_into_the_row() {
  const { p } = await seed();
  const store = favoritesStore();
  const root = guidsIn(FAVORITES_ROOT);

  let popup = await openFavorites();
  let menu = await contextOn(await itemIn(popup, n => n.guid === p));
  Assert.ok(shownCommands(menu).includes("pinHome"), "Pin is offered");
  await chooseInContextMenu(menu, "pinHome");
  await TestUtils.waitForCondition(
    () => store.pinsWithUrl(P).length === 1,
    "a pin of its address"
  );
  const [pin] = store.pinsWithUrl(P);
  Assert.notEqual(pin.guid, p, "a copy, with a guid of its own");
  Assert.equal(pin.parentGuid, PINS_ROOT, "at the end of the row");
  Assert.deepEqual(guidsIn(FAVORITES_ROOT), root, "the favorite stays put");
  Assert.ok(store.isFavorite(P), "and is still a favorite");
  await closeMenus();

  popup = await openFavorites();
  await TestUtils.waitForCondition(
    () => drawn(popup).join() === root.join(),
    "the menu draws every favorite, the pin's address included"
  );
  menu = await contextOn(await itemIn(popup, n => n.guid === p));
  Assert.ok(
    !shownCommands(menu).includes("pinHome"),
    "no Pin for an address a pin has"
  );
  await closeMenus();

  await store.undo();
  Assert.equal(store.pinsWithUrl(P).length, 0, "Undo takes the pin back");
  Assert.deepEqual(guidsIn(FAVORITES_ROOT), root, "and leaves the favorite");
});

/** Pin on a folder copies it whole, and leaves the folder as it was. */
add_task(async function pin_copies_a_folder_whole() {
  const { folder } = await seed();
  const store = favoritesStore();
  const inFolder = guidsIn(folder);

  const copy = await store.pin(folder);
  Assert.equal(store.get(copy).parentGuid, PINS_ROOT, "the copy is a pin");
  Assert.deepEqual(
    store.children(copy).map(row => row.url),
    [B, Q],
    "holding copies of what the folder holds"
  );
  Assert.ok(
    store.children(copy).every(row => !inFolder.includes(row.guid)),
    "each with a guid of its own"
  );
  Assert.deepEqual(guidsIn(folder), inFolder, "the folder keeps its own");
  await emptyFavorites();
});
