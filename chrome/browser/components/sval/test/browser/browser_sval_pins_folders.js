/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_pins_helpers.js */
/* import-globals-from sval_favorites_menu_helpers.js */

/**
 * Pins apart from Favorites (pins-root spec §5, §6): the favorite button on
 * a pin's page, pin folders made in the row by dragging, the row's New Pin
 * Folder…, Move to Pin Folder and a pin folder's Move Contents to Row.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_pins_helpers.js",
  this
);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_favorites_menu_helpers.js",
  this
);

add_setup(pinsSetup);

/** @returns {Promise<object>} a tab of the workspace, selected. */
async function aTab() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE),
    10_000,
    "a tab opening"
  );
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  return tab;
}

/**
 * Drags the pin `guid`'s tile onto `target`, at `x` of the way across it.
 *
 * @param {Element} source A pin's tile, in the row or a popover.
 * @param {Element} target
 * @param {number} x
 */
function dragPin(source, target, x) {
  const dataTransfer = new DataTransfer();
  const send = (type, element, at) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(
      new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width * at,
        clientY: rect.top + rect.height / 2,
        dataTransfer,
      })
    );
  };
  send("dragstart", source, 0.5);
  send("dragover", target, x);
  send("drop", target, x);
  send("dragend", source, 0.5);
}

/**
 * @param {Element} tile
 * @returns {Promise<Element>} the pin's menu, open on it.
 */
async function pinMenuOn(tile) {
  EventUtils.synthesizeMouseAtCenter(tile, { type: "contextmenu", button: 2 });
  await TestUtils.waitForCondition(
    () => document.getElementById("sval-pin-context-menu")?.state === "open",
    "the pin's menu opens"
  );
  return document.getElementById("sval-pin-context-menu");
}

/**
 * @param {Element} menu
 * @returns {string[]} the commands it shows, "-" for a separator.
 */
function shown(menu) {
  return Array.from(menu.children)
    .filter(el => !el.hidden)
    .map(el => (el.localName === "menuseparator" ? "-" : el.dataset.command));
}

async function choose(menu, command) {
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(menu.querySelector(`[data-command="${command}"]`));
  await within(hidden, 10_000, `the menu closing on ${command}`);
}

/**
 * Answers the next Sval dialog, as the Rename… and New Pin Folder… dialogs
 * ask.
 *
 * @param {string} value What is typed into its field.
 * @returns {Promise<string>} the dialog's title, once it is answered.
 */
async function answerDialog(value) {
  const doc = await typeInto(value);
  const title = doc.getElementById("sval-dialog-title").textContent;
  await confirm(doc);
  return title;
}

/**
 * The favorite button on a pin's page shows and changes Favorites alone
 * (pins-root spec §6): unlit, a press adds a favorite, a second press takes
 * it out, and the pin stays.
 */
add_task(async function the_favorite_button_on_a_pins_page_is_the_favorites() {
  forgetFavorites();
  await aTab();
  const { store } = pinsFixture;
  const guid = await pinFavorite(LINKS_PAGE, "Links");
  await clickTile(guid, LINKS_PAGE);
  const button = document.getElementById("sval-favorite-button");
  await TestUtils.waitForCondition(
    () => !button.hasAttribute("starred"),
    "a pin's page is no favorite"
  );

  EventUtils.synthesizeMouseAtCenter(button, {});
  await TestUtils.waitForCondition(
    () => button.hasAttribute("starred"),
    "a press makes it a favorite"
  );
  const [favorite] = store.favoritesWithUrl(LINKS_PAGE);
  Assert.equal(favorite?.parentGuid, TOOLBAR, "in Favorites");
  atTaskEnd(() => store.removeUrl(LINKS_PAGE));

  EventUtils.synthesizeMouseAtCenter(button, {});
  await TestUtils.waitForCondition(
    () => !button.hasAttribute("starred"),
    "a second press takes it out"
  );
  Assert.ok(!store.isFavorite(LINKS_PAGE), "Favorites hold none");
  Assert.ok(store.get(guid), "and the pin stays");
  Assert.ok(tileOf(guid), "in the row");
  Assert.equal(selectedPinGuid(), guid, "still selected");
});

/**
 * A pin dropped on the middle of another asks for a pin folder's name,
 * "Untitled pin folder" selected. Cancel makes nothing; Create makes a pin
 * folder of both where the other stood.
 * A pin dragged out of the pin folder's popover onto the row leaves the pin
 * folder, and Move Contents to Row puts the rest back where the pin folder
 * stood.
 */
add_task(async function a_pin_dropped_on_a_pin_makes_a_folder() {
  forgetFavorites();
  await aTab();
  const { store } = pinsFixture;
  const a = await pinFavorite(PAGE2, "A");
  const b = await pinFavorite(LINKS_PAGE, "B");
  const c = await pinFavorite(`${PAGE}?c=1`, "C");
  const d = await pinFavorite(`${PAGE}?d=1`, "D");
  await TestUtils.waitForCondition(
    () => rowGuids().join() === [a, b, c, d].join(),
    "four pins"
  );

  dragPin(tileOf(c), tileOf(a), 0.5);
  const doc = await within(dialog(), 10_000, "the pin folder's name is asked");
  Assert.equal(
    doc.getElementById("sval-dialog-title").textContent,
    "Create Pin Folder"
  );
  const input = doc.querySelector(".sval-dialog-input");
  Assert.equal(input.value, "Untitled pin folder", "the name it offers");
  Assert.equal(
    input.selectionEnd - input.selectionStart,
    input.value.length,
    "selected"
  );
  const closed = TestUtils.waitForCondition(
    () => !gDialogBox.isOpen,
    "the dialog closes"
  );
  EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
  await within(closed, 10_000, "Cancel closing the dialog");
  Assert.deepEqual(rowGuids(), [a, b, c, d], "Cancel leaves the pins be");
  Assert.ok(
    store.home().every(row => row.kind !== "folder"),
    "and makes no pin folder"
  );

  const named = answerDialog("Work");
  dragPin(tileOf(c), tileOf(a), 0.5);
  Assert.equal(
    await within(named, 10_000, "the pin folder's name is asked again"),
    "Create Pin Folder"
  );
  // Create closes the dialog before the drop writes the pin folder.
  const folder = await TestUtils.waitForCondition(() => {
    const [first] = rowGuids();
    return store.get(first)?.kind === "folder" ? first : null;
  }, "the pin folder is made");
  Assert.equal(store.get(folder).name, "Work", "named as typed");
  Assert.deepEqual(rowGuids(), [folder, b, d], "it stands where A stood");
  Assert.deepEqual(
    store.children(folder).map(row => row.guid),
    [a, c],
    "holding A, then C"
  );
  for (const guid of [folder, a, c, d]) {
    atTaskEnd(() => store.get(guid) && store.delete(guid));
  }

  // An edge reorders, as it does not make a folder.
  dragPin(tileOf(b), tileOf(folder), 0.05);
  await TestUtils.waitForCondition(
    () => rowGuids().join() === [b, folder, d].join(),
    "a drop on an edge moves the pin along the row"
  );
  dragPin(tileOf(d), tileOf(folder), 0.5);
  await TestUtils.waitForCondition(
    () => store.get(d)?.parentGuid === folder,
    "a pin dropped on the pin folder's middle goes into it"
  );

  EventUtils.synthesizeMouseAtCenter(tileOf(folder), {});
  const panel = await TestUtils.waitForCondition(() => {
    const p = document.getElementById("sval-pins-popover");
    return p?.state === "open" ? p : null;
  }, "the folder's popover opens");
  dragPin(panel.querySelector(`button[data-guid="${c}"]`), tileOf(b), 0.05);
  await TestUtils.waitForCondition(
    () => rowGuids().join() === [c, b, folder].join(),
    "a pin dragged out of the popover lands in the row"
  );
  Assert.deepEqual(
    store.children(folder).map(row => row.guid),
    [a, d],
    "and leaves the folder"
  );

  await choose(await pinMenuOn(tileOf(folder)), "moveContents");
  await TestUtils.waitForCondition(
    () => rowGuids().join() === [c, b, a, d].join(),
    "Move Contents to Row puts A where the folder stood"
  );
  Assert.ok(!store.get(folder), "and the folder goes");
});

/**
 * A pin dropped on a pin folder's tile goes into it; Move to Pin Folder
 * lists the row's pin folders; a pin folder's menu is its own (pins-root
 * spec §5).
 */
add_task(async function a_folders_menu_and_move_to_folder() {
  forgetFavorites();
  await aTab();
  const { store } = pinsFixture;
  const folder = await pinsFolder("Team");
  const a = await pinFavorite(PAGE2, "A");
  const b = await pinFavorite(LINKS_PAGE, "B");
  await untilPinShows(b);

  dragPin(tileOf(a), tileOf(folder), 0.5);
  await TestUtils.waitForCondition(
    () => store.get(a)?.parentGuid === folder,
    "a pin dropped on a folder's middle goes into it"
  );

  let menu = await pinMenuOn(tileOf(b));
  Assert.ok(shown(menu).includes("moveToPinFolder"), "a pin's menu offers it");
  const moveTo = menu.querySelector('[data-command="moveToPinFolder"]');
  const opened = BrowserTestUtils.waitForPopupEvent(moveTo.menupopup, "shown");
  moveTo.openMenu(true);
  await within(opened, 10_000, "Move to Pin Folder opens");
  const item = moveTo.menupopup.querySelector(`[data-folder="${folder}"]`);
  Assert.ok(item, "listing the row's folder");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  moveTo.menupopup.activateItem(item);
  await within(hidden, 10_000, "the menu closing");
  await TestUtils.waitForCondition(
    () =>
      store
        .children(folder)
        .map(row => row.guid)
        .join() === [a, b].join(),
    "the pin moves to the end of the folder"
  );

  menu = await pinMenuOn(tileOf(folder));
  Assert.deepEqual(shown(menu), [
    "showIn",
    "-",
    "rename",
    "-",
    "moveContents",
    "moveToFavorites",
    "delete",
  ]);
  await choose(menu, "moveToFavorites");
  await TestUtils.waitForCondition(
    () => store.get(folder)?.parentGuid === TOOLBAR,
    "Move to Favorites moves the folder whole to Favorites"
  );
  Assert.ok(!tileOf(folder), "out of the row");
  Assert.deepEqual(
    store.children(folder).map(row => row.guid),
    [a, b],
    "with its contents"
  );
  await within(SvalPanel.undo.commit(), 10_000, "the message going");
  atTaskEnd(() => store.get(folder) && store.delete(folder));
});

/**
 * Move to Pin Folder lists only the pin folders this workspace's row shows
 * (pins spec §7).
 */
add_task(async function move_to_folder_leaves_out_another_workspaces() {
  forgetFavorites();
  await aTab();
  const { store, work } = pinsFixture;
  const elsewhere = await pinsFolder("Work only");
  const pin = await pinFavorite(PAGE2, "A");
  await untilPinShows(pin);
  await store.setPinScope(elsewhere, [work]);
  await TestUtils.waitForCondition(
    () => !tileOf(elsewhere),
    "a folder limited to Work is not in Home"
  );

  let menu = await pinMenuOn(tileOf(pin));
  Assert.ok(
    !shown(menu).includes("moveToPinFolder"),
    "with no folder in this row, the menu leaves it out"
  );
  let hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(hidden, 10_000, "the menu closing");

  const here = await pinsFolder("Home");
  await untilPinShows(here);
  menu = await pinMenuOn(tileOf(pin));
  const moveTo = menu.querySelector('[data-command="moveToPinFolder"]');
  const opened = BrowserTestUtils.waitForPopupEvent(moveTo.menupopup, "shown");
  moveTo.openMenu(true);
  await within(opened, 10_000, "Move to Pin Folder opens");
  Assert.deepEqual(
    [...moveTo.menupopup.children].map(el => el.dataset.folder),
    [here],
    "listing this row's folder alone"
  );
  hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(hidden, 10_000, "the menu closing");
});

/** The row's own menu makes an empty pin folder at the end of the row. */
add_task(async function the_rows_menu_makes_a_folder() {
  forgetFavorites();
  await aTab();
  const { store } = pinsFixture;
  const a = await pinFavorite(PAGE2, "A");
  await untilPinShows(a);
  const block = SvalPanel._els.pins;
  const lines = block.querySelector(".sval-pins-lines");
  const rect = lines.getBoundingClientRect();
  EventUtils.synthesizeMouse(
    lines,
    rect.width - 2,
    rect.height / 2,
    { type: "contextmenu", button: 2 },
    window
  );
  const menu = await TestUtils.waitForCondition(() => {
    const m = document.getElementById("sval-pins-row-context-menu");
    return m?.state === "open" ? m : null;
  }, "the row's menu opens");
  const asked = answerDialog("Reading");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(menu.querySelector('[data-command="newPinFolder"]'));
  await within(hidden, 10_000, "the menu closing");
  Assert.equal(
    await within(asked, 10_000, "the pin folder's name is asked"),
    "Create Pin Folder"
  );
  await TestUtils.waitForCondition(
    () => store.home().length === 2,
    "a folder is made"
  );
  const [, folder] = store.home();
  atTaskEnd(() => store.delete(folder.guid));
  Assert.equal(folder.kind, "folder", "a folder");
  Assert.equal(folder.name, "Reading", "named as asked");
  Assert.deepEqual(folder.children, [], "empty");
});

/**
 * A pin folder holding A and B, then the pin F, in the row, with the pin
 * folder's popover open.
 *
 * @returns {Promise<{folder: string, a: string, b: string, f: string, panel:
 *   Element}>}
 */
async function openPinFolderBesideF() {
  forgetFavorites();
  await aTab();
  const { store } = pinsFixture;
  const folder = await pinsFolder("Boom");
  const a = await pinFavorite(PAGE2, "A");
  const b = await pinFavorite(LINKS_PAGE, "B");
  const f = await pinFavorite(`${PAGE}?f=1`, "F");
  await store.movePin(a, { parentGuid: folder });
  await store.movePin(b, { parentGuid: folder });
  await TestUtils.waitForCondition(
    () => rowGuids().join() === [folder, f].join(),
    "a pin folder and F"
  );
  EventUtils.synthesizeMouseAtCenter(tileOf(folder), {});
  const panel = await TestUtils.waitForCondition(() => {
    const p = document.getElementById("sval-pins-popover");
    return p?.state === "open" ? p : null;
  }, "the pin folder's popover opens");
  atTaskEnd(() => panel.hidePopup());
  return { folder, a, b, f, panel };
}

/**
 * @param {number} x
 * @param {number} y
 * @returns {Element} what the pointer at the window's `x`, `y` is over,
 *   popups included, as the window routes a drag's events.
 */
function elementAt(x, y) {
  let hit = null;
  const heard = event => {
    hit = event.target;
    event.stopPropagation();
  };
  window.addEventListener("mousemove", heard, { capture: true, once: true });
  EventUtils.synthesizeMouseAtPoint(x, y, { type: "mousemove" }, window);
  window.removeEventListener("mousemove", heard, { capture: true });
  return hit;
}

/**
 * The pin folder's popover stays under its tile when the row is drawn
 * again while it is open, as a drag's end draws it.
 */
add_task(async function a_redraw_keeps_the_popover_on_its_tile() {
  const { folder, panel } = await openPinFolderBesideF();
  const box = () => panel.querySelector(".sval-pins-popover-box");
  const tileBottom = () => tileOf(folder).getBoundingClientRect().bottom;
  const gap = box().getBoundingClientRect().top - tileBottom();

  SvalPanel.pins.dragEnded();
  // A change of the popover's size has Gecko place it again.
  box().style.minHeight = `${box().getBoundingClientRect().height + 40}px`;
  await TestUtils.waitForCondition(
    () => box().getBoundingClientRect().height > 100,
    "the popover grows"
  );
  Assert.ok(panel.anchorNode.isConnected, "its tile is still in the row");
  await TestUtils.waitForCondition(
    () =>
      Math.round(box().getBoundingClientRect().top - tileBottom()) ===
      Math.round(gap),
    "and the popover still opens under it"
  );
});

/**
 * A pin dragged out of the popover reaches the row under the popover's
 * window: the popover closes once the drag leaves what it draws, and the
 * pin lands where it is dropped.
 */
add_task(async function a_pin_dragged_out_of_the_popover_reaches_the_row() {
  const { store } = pinsFixture;
  const { folder, a, b, f, panel } = await openPinFolderBesideF();
  const rect = tileOf(f).getBoundingClientRect();
  const x = rect.right - 2;
  const y = rect.top + rect.height / 2;
  const dataTransfer = new DataTransfer();
  const send = (type, element) =>
    element.dispatchEvent(
      new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        dataTransfer,
      })
    );
  const source = panel.querySelector(`button[data-guid="${a}"]`);
  send("dragstart", source);
  send("dragover", elementAt(x, y));
  await TestUtils.waitForCondition(
    () => panel.state === "closed",
    "the popover closes as the drag leaves it"
  );
  const target = elementAt(x, y);
  Assert.ok(
    SvalPanel._els.pins.contains(target),
    "the pointer is over the row"
  );
  send("dragover", target);
  send("drop", target);
  send("dragend", source);
  await TestUtils.waitForCondition(
    () => rowGuids().join() === [b, f, a].join(),
    "the pin lands after F, and B stands where its pin folder stood"
  );
  Assert.ok(!store.get(folder), "the pin folder left with one pin goes");
});
