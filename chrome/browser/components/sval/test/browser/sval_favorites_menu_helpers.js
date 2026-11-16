/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* `SvalPanel` is a global of the chrome window, declared by a classic script the
 * window loads rather than by a module this file can import. */
/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * Driving the panel's Favorites menu and its context menu as a person does,
 * for the files that test what those menus do. Each file loads this with
 * `loadSubScript` into its own scope.
 */

/* exported contextMenu, openFavorites, closeMenus, itemIn, contextOn, chooseMenuItem,
   shownCommands, shownWithoutUndo, dialog, typeInto, confirm, favoritesStore,
   emptyFavorites */

const { SvalFavoritesStore, FAVORITES_ROOT, PINS_ROOT, ROOT_GUIDS } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs"
  );

/** @returns {object} the process's Favorites, which the menus draw. */
function favoritesStore() {
  return SvalFavoritesStore.instance;
}

/** Deletes every favorite, pin, folder and separator. */
async function emptyFavorites() {
  const store = favoritesStore();
  for (const root of ROOT_GUIDS) {
    for (const row of store.children(root)) {
      await store.delete(row.guid);
    }
  }
}

/** @returns {Element} the Favorites context menu. */
function contextMenu() {
  return document.getElementById("sval-favorites-context-menu");
}

/** Opens the panel's Favorites menu, as its button does. */
async function openFavorites() {
  const popup = SvalPanel._els.favoritesMenu;
  const shown = BrowserTestUtils.waitForPopupEvent(popup, "shown");
  EventUtils.synthesizeMouseAtCenter(SvalPanel._els.favorites, {});
  await within(shown, 10_000, "the Favorites menu showing");
  return popup;
}

/** Closes every menu this test opened. */
async function closeMenus() {
  for (const popup of [contextMenu(), SvalPanel._els.favoritesMenu]) {
    if (popup.state !== "closed") {
      const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
      popup.hidePopup();
      await within(hidden, 10_000, "an open menu hiding");
    }
  }
}

/**
 * @param {Element} popup
 * @param {Function} match Given the item's favorite, as the store reads it,
 *   with its address also as `uri` and its name as `title`.
 * @returns {Promise<Element>}
 */
function itemIn(popup, match) {
  return TestUtils.waitForCondition(() =>
    Array.from(
      popup.querySelectorAll(
        ":scope > menuitem[data-guid], :scope > menu[data-guid]"
      )
    ).find(el => {
      const row = favoritesStore().get(el.dataset.guid);
      return row && match({ ...row, uri: row.url, title: row.name });
    })
  );
}

/**
 * Opens the context menu on `el` with the mouse.
 *
 * @param {Element} el
 * @returns {Promise<Element>}
 */
async function contextOn(el) {
  const menu = contextMenu();
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(el, { type: "contextmenu", button: 2 });
  await within(shown, 10_000, "the context menu showing");
  return menu;
}

/**
 * Chooses `command` in the open context menu.
 *
 * @param {Element} menu
 * @param {string} command
 */
async function chooseMenuItem(menu, command) {
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(menu.querySelector(`[data-command="${command}"]`));
  await within(hidden, 10_000, `the context menu closing on ${command}`);
}

/**
 * @param {Element} menu
 * @returns {string[]} the commands the context menu shows, in order, with
 *   "-" for each separator it shows.
 */
function shownCommands(menu) {
  return Array.from(menu.children)
    .filter(el => !el.hidden)
    .map(el => (el.localName === "menuseparator" ? "-" : el.dataset.command));
}

/**
 * @param {Element} menu
 * @returns {string[]} {@link shownCommands} without Undo, which shows
 *   whenever an earlier task left a change to undo.
 */
function shownWithoutUndo(menu) {
  const shown = shownCommands(menu);
  return shown[0] === "undo" ? shown.slice(2) : shown;
}

/** @returns {Promise<Document>} the open Sval dialog's document. */
async function dialog() {
  await TestUtils.waitForCondition(() => gDialogBox.isOpen, "a dialog opens");
  await dialogShown(gDialogBox.dialog, "the dialog's load");
  let doc;
  await TestUtils.waitForCondition(() => {
    doc = gDialogBox.dialog?._frame.contentDocument;
    return doc?.querySelector(".sval-dialog-actions button");
  }, "the dialog has drawn");
  return doc;
}

/**
 * Types `value` into the open dialog's field.
 *
 * @param {string} value
 * @returns {Promise<Document>}
 */
async function typeInto(value) {
  const doc = await dialog();
  const input = doc.querySelector(".sval-dialog-input");
  input.focus();
  input.select();
  EventUtils.sendString(value, doc.defaultView);
  return doc;
}

/**
 * Presses the open dialog's primary button and waits for it to close. The
 * command that opened it writes its answer to Favorites after that, so a
 * caller waits for the write itself.
 *
 * @param {Document} doc
 */
async function confirm(doc) {
  const buttons = doc.querySelectorAll(".sval-dialog-actions button");
  const primary = buttons[buttons.length - 1];
  await TestUtils.waitForCondition(() => !primary.disabled);
  const closed = TestUtils.waitForCondition(() => !gDialogBox.isOpen);
  primary.click();
  await closed;
}
