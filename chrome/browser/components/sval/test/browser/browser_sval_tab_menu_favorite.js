/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_pins_helpers.js */

/**
 * A tab's menu in the panel adds the tab's page to Favorites, and takes it
 * out when it is one, as the favorite button does for the selected tab.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_pins_helpers.js",
  this
);

add_setup(pinsSetup);

/**
 * @param {string} url
 * @returns {Promise<{tab: object, id: string}>} a tab of the workspace.
 */
async function aTab(url) {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, url),
    10_000,
    "a tab opening"
  );
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  return { tab, id: SvalPanel.observer.nodeIdFor(tab) };
}

/**
 * Opens the menu on a row, as a right-click does.
 *
 * @param {string} id A row's node id.
 * @returns {Promise<Element>} the menu's Add to Favorites item.
 */
async function favoriteItemOn(id) {
  const menu = SvalPanel._els.contextMenu;
  const showing = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(SvalPanel._rowElementFor(id), {
    type: "contextmenu",
    button: 2,
  });
  await within(showing, 10_000, "the tab's menu opens");
  return menuItem(SvalPanel.rowMenu.menu, "favorite");
}

async function closeMenu() {
  const menu = SvalPanel._els.contextMenu;
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(hidden, 10_000, "the menu closing");
}

async function choose(item) {
  const menu = SvalPanel._els.contextMenu;
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(item);
  await within(hidden, 10_000, "the menu closing");
}

add_task(async function a_tab_menu_adds_and_removes_its_page() {
  forgetFavorites();
  const { store } = pinsFixture;
  const { id } = await aTab(LINKS_PAGE);
  // The row's tab is in the background, so the item acts on the row's page
  // and leaves the selected tab's alone.
  await aTab(PAGE);

  let item = await favoriteItemOn(id);
  Assert.ok(!item.hidden, "a tab's menu offers Add to Favorites");
  Assert.ok(!item.disabled, "and it can be chosen");
  Assert.equal(item.dataset.favorite, "false", "for a page that is none");
  await choose(item);
  await TestUtils.waitForCondition(
    () => store.isFavorite(LINKS_PAGE),
    "the row's page is a favorite"
  );
  Assert.ok(!store.isFavorite(PAGE), "the selected tab's page is not");

  item = await favoriteItemOn(id);
  Assert.equal(item.dataset.favorite, "true", "it offers to remove it");
  await choose(item);
  await TestUtils.waitForCondition(
    () => !store.isFavorite(LINKS_PAGE),
    "the row's page is no longer a favorite"
  );
});

/**
 * Accel+D adds a page to Favorites, so Add to Favorites names it on every
 * tab's row, and Remove from Favorites names nothing, since the key never
 * removes one.
 */
add_task(async function the_item_names_the_key_that_adds() {
  forgetFavorites();
  const { store } = pinsFixture;
  const { id: background } = await aTab(LINKS_PAGE);
  const { id: selected } = await aTab(PAGE);

  for (const id of [selected, background]) {
    const item = await favoriteItemOn(id);
    Assert.equal(
      item.getAttribute("key"),
      "addBookmarkAsKb",
      "it names Accel+D"
    );
    Assert.ok(item.getAttribute("acceltext"), "and shows it");
    await closeMenu();
  }

  let item = await favoriteItemOn(selected);
  await choose(item);
  await TestUtils.waitForCondition(
    () => store.isFavorite(PAGE),
    "the selected tab's page is a favorite"
  );
  item = await favoriteItemOn(selected);
  Assert.equal(item.dataset.favorite, "true", "it offers to remove it");
  Assert.ok(!item.hasAttribute("key"), "and names no key");
  await closeMenu();
  forgetFavorites();
});
