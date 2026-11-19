/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_pins_helpers.js */

/**
 * Making and managing pins (pins spec §6, §7, §8): a tab pinned from its
 * menu or by a drop, the pin's own menu with "Show in", Delete and the
 * Favorites menu's Undo, and a pinned folder's popover.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_pins_helpers.js",
  this
);

const { SvalFavorites } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFavorites.sys.mjs"
);

add_setup(pinsSetup);

/**
 * @param {string} [url]
 * @returns {Promise<{tab: object, id: string}>} a tab of the workspace.
 */
async function aTab(url = PAGE) {
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
 * Opens the pin's menu on its tile, as a right-click does.
 *
 * @param {Element} tile
 * @returns {Promise<Element>}
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
 * @returns {string[]} the commands a menu shows, "-" for a separator.
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

add_task(async function a_tab_is_pinned_from_its_menu_as_it_was() {
  forgetFavorites();
  const { tab, id } = await aTab(LINKS_PAGE);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.wrappedJSObject.pinMark = "as it was";
  });
  const menu = SvalPanel._els.contextMenu;
  const showing = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(SvalPanel._rowElementFor(id), {
    type: "contextmenu",
    button: 2,
  });
  await within(showing, 10_000, "the tab's menu opens");
  Assert.ok(
    !menu.querySelector('[data-command="pin"]').hidden,
    "a tab's menu offers Pin"
  );
  await choose(menu, "pin");

  await TestUtils.waitForCondition(
    () => rowGuids().length === 1,
    "a pin shows"
  );
  const [guid] = rowGuids();
  const pin = pinsFixture.store.get(guid);
  Assert.equal(pin.url, LINKS_PAGE, "a pin of its address");
  Assert.equal(pin.parentGuid, PINS, "in the pins root");
  Assert.ok(
    !pinsFixture.store.isFavorite(LINKS_PAGE),
    "and no favorite (pins-root spec §6)"
  );
  Assert.ok(
    !(await tabNodes()).some(node => node.content?.url === LINKS_PAGE),
    "the tab left the tab list"
  );
  Assert.equal(selectedPinGuid(), guid, "and is the pin's page, selected");
  Assert.equal(
    await SpecialPowers.spawn(
      tab.linkedBrowser,
      [],
      () => content.wrappedJSObject.pinMark
    ),
    "as it was",
    "as it was"
  );
});

/**
 * Pin to This Workspace pins the tab, limited to the workspace it was in.
 */
add_task(async function a_tab_is_pinned_to_this_workspace() {
  forgetFavorites();
  const { id } = await aTab(LINKS_PAGE);
  const menu = SvalPanel._els.contextMenu;
  const showing = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(SvalPanel._rowElementFor(id), {
    type: "contextmenu",
    button: 2,
  });
  await within(showing, 10_000, "the tab's menu opens");
  Assert.ok(
    !menu.querySelector('[data-command="pinHere"]').hidden,
    "a tab's menu offers Pin to This Workspace"
  );
  await choose(menu, "pinHere");

  await TestUtils.waitForCondition(
    () => rowGuids().length === 1,
    "a pin shows"
  );
  const [guid] = rowGuids();
  Assert.deepEqual(
    pinsFixture.store.pinScopeOf(guid),
    [SvalWindowWorkspace.of(window).id],
    "limited to this workspace"
  );
  Assert.equal(selectedPinGuid(), guid, "and is the pin's page, selected");
});

add_task(async function a_tab_dropped_on_the_empty_row_is_pinned() {
  forgetFavorites();
  const { id } = await aTab(LINKS_PAGE);
  const block = SvalPanel._els.pins;
  Assert.ok(block.hidden, "with no pins there is no row");
  const dataTransfer = new DataTransfer();
  const send = (type, element) => {
    const rect = element.getBoundingClientRect();
    const event = new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      dataTransfer,
    });
    element.dispatchEvent(event);
    return event;
  };
  const source = SvalPanel._rowElementFor(id);
  send("dragstart", source);
  Assert.ok(!block.hidden, "a drag shows where to drop");
  const zone = block.querySelector(".sval-pins-drop");
  Assert.ok(send("dragover", zone).defaultPrevented, "the zone takes the tab");
  send("drop", zone);
  send("dragend", source);
  await TestUtils.waitForCondition(
    () => rowGuids().length === 1,
    "it is pinned"
  );
  Assert.ok(
    !(await tabNodes()).some(node => node.content?.url === LINKS_PAGE),
    "and left the tab list"
  );
});

/**
 * A drag from the tree ends with the panel's. A sync that changes the dragged
 * row mid-drag rebuilds it, and the `dragend` then goes to a row no longer in
 * the panel.
 */
add_task(async function the_drop_zone_goes_when_a_redrawn_drag_ends() {
  forgetFavorites();
  const { id } = await aTab(LINKS_PAGE);
  const block = SvalPanel._els.pins;
  Assert.ok(block.hidden, "with no pins there is no row");
  const dataTransfer = new DataTransfer();
  const send = (type, element) =>
    element.dispatchEvent(
      new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer })
    );
  const source = SvalPanel._rowElementFor(id);
  send("dragstart", source);
  Assert.ok(!block.hidden, "a drag shows where to drop");
  await pinsFixture.engine.mutate({
    kind: "setAppearance",
    id,
    color: null,
    emoji: "\u{1F34E}",
    now: Date.now(),
  });
  await SvalPanel.refresh();
  Assert.ok(!source.isConnected, "the redraw replaced the dragged row");
  send("dragend", source);
  Assert.equal(SvalPanel.draggedId, undefined, "the panel's drag is over");
  Assert.ok(block.hidden, "and the row is gone with it");
});

add_task(async function the_pins_menu_and_show_in() {
  forgetFavorites();
  const { store, home, work } = pinsFixture;
  await aTab();
  const guid = await pinFavorite(LINKS_PAGE, "Links");
  await clickTile(guid, LINKS_PAGE);
  let menu = await pinMenuOn(tileOf(guid));
  Assert.deepEqual(shown(menu), [
    "reset",
    "saveCurrent",
    "-",
    "showIn",
    "-",
    "rename",
    "editAddress",
    "-",
    "moveToFavorites",
    "delete",
  ]);
  Assert.ok(
    menu.querySelector('[data-command="reset"]').hasAttribute("disabled"),
    "Back to saved page is off on the saved page"
  );

  const showIn = menu.querySelector('[data-command="showIn"]');
  const popup = showIn.menupopup;
  const opened = BrowserTestUtils.waitForPopupEvent(popup, "shown");
  showIn.openMenu(true);
  await within(opened, 10_000, "Show in opens");
  const box = id => popup.querySelector(`[data-workspace="${id}"]`);
  Assert.ok(box(home) && box(work), "one box per workspace");
  Assert.equal(box(home).getAttribute("checked"), "true", "every one ticked");
  popup.activateItem(box(home));
  await TestUtils.waitForCondition(
    () => !box(home).hasAttribute("checked"),
    "Home is unticked"
  );
  Assert.equal(popup.state, "open", "the submenu stays open while ticking");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(hidden, 10_000, "the menu closes");
  await TestUtils.waitForCondition(() => {
    const scope = store.pinScopeOf(guid);
    return scope?.includes(work) && !scope.includes(home);
  }, "the pin is limited to the workspaces still ticked, Work among them");
  await TestUtils.waitForCondition(() => !tileOf(guid), "and leaves Home");

  // The Favorites menu's Undo puts the scope back.
  await SvalFavorites.undo();
  await TestUtils.waitForCondition(
    () => store.pinScopeOf(guid) === null,
    "Undo shows it everywhere again"
  );
  await untilPinShows(guid);
});

add_task(async function delete_removes_the_favorite_and_undo_brings_both() {
  forgetFavorites();
  await aTab();
  const { store } = pinsFixture;
  const first = await pinFavorite(PAGE2, "First");
  const guid = await pinFavorite(LINKS_PAGE, "Links");
  const last = await pinFavorite(ORG_PAGE, "Last");
  await TestUtils.waitForCondition(
    () => rowGuids().join() === [first, guid, last].join(),
    "three pins"
  );
  await choose(await pinMenuOn(tileOf(guid)), "delete");
  await TestUtils.waitForCondition(() => !tileOf(guid), "the pin goes");
  Assert.ok(store.get(guid), "its Favorite waits on the panel's message");
  await within(SvalPanel.undo.commit(), 10_000, "the delete");
  Assert.equal(store.get(guid), null, "and goes with it");
  Assert.ok(SvalFavorites.canUndo(), "Undo is offered");
  await SvalFavorites.undo();
  await TestUtils.waitForCondition(
    () => rowGuids().join() === [first, guid, last].join(),
    "Undo brings the Favorite and its pin back, in its place"
  );
  Assert.ok(store.isPinned(guid));
});

/**
 * Deleting a pin holds the delete back behind the panel's message, whose
 * Undo shows the pin again in its place, with the Workspaces it shows in.
 */
add_task(async function the_panels_undo_brings_a_deleted_pin_back() {
  forgetFavorites();
  await aTab();
  const { store } = pinsFixture;
  const first = await pinFavorite(PAGE2, "First");
  const guid = await pinFavorite(LINKS_PAGE, "Links");
  const last = await pinFavorite(ORG_PAGE, "Last");
  const scope = [SvalWindowWorkspace.of(window).id];
  await store.setPinScope(guid, scope);
  await TestUtils.waitForCondition(
    () => rowGuids().join() === [first, guid, last].join(),
    "three pins"
  );
  await choose(await pinMenuOn(tileOf(guid)), "delete");
  await TestUtils.waitForCondition(() => !tileOf(guid), "the pin goes");
  Assert.ok(store.isPinned(guid), "the store keeps it while Undo is offered");
  const undo = SvalPanel._els.undoRegion.querySelector(
    '.sval-undo [data-command="undo"]'
  );
  Assert.ok(undo, "the panel offers Undo");
  undo.click();
  await TestUtils.waitForCondition(
    () => rowGuids().join() === [first, guid, last].join(),
    "the Favorite and its pin come back, in its place"
  );
  Assert.deepEqual(store.pinScopeOf(guid), scope, "showing where it did");
  Assert.ok(
    !SvalPanel._els.undoRegion.querySelector(".sval-undo"),
    "and the message goes"
  );
});

/**
 * Move to Favorites makes an open pin's page a tab at once and puts the pin
 * at the end of Favorites with no scope (pins-root spec §6), and the panel's
 * Undo message takes it back: the pin in its place with the Workspaces it
 * shows in, and the tab its page again, the same browser, out of the tab
 * list.
 */
add_task(async function the_panels_undo_brings_a_pin_moved_to_favorites_back() {
  forgetFavorites();
  const { store } = pinsFixture;
  await aTab();
  const first = await pinFavorite(PAGE2, "First");
  const last = await pinFavorite(ORG_PAGE, "Last");
  const { tab, id } = await aTab(LINKS_PAGE);
  const guid = await SvalPanel.pins.pinTab(id, {
    afterGuid: first,
    beforeGuid: last,
  });
  const scope = [SvalWindowWorkspace.of(window).id];
  await store.setPinScope(guid, scope);
  await TestUtils.waitForCondition(
    () => rowGuids().join() === [first, guid, last].join(),
    "three pins, the tab's in the middle"
  );
  const page = await clickTile(guid, LINKS_PAGE);
  Assert.equal(page, tab, "the pin's page is the tab pinned");
  const browser = page.linkedBrowser;

  await choose(await pinMenuOn(tileOf(guid)), "moveToFavorites");
  await TestUtils.waitForCondition(() => !tileOf(guid), "the pin goes");
  Assert.equal(
    store.children(TOOLBAR).at(-1)?.guid,
    guid,
    "it is the last of Favorites"
  );
  Assert.ok(!store.isPinned(guid), "and no pin");
  Assert.equal(store.pinScopeOf(guid), null, "with no scope");
  await TestUtils.waitForCondition(
    () => SvalPanel.observer.nodeIdFor(page),
    "its page is a tab at once"
  );
  const made = SvalPanel.observer.nodeIdFor(page);
  const inTree = async () => {
    await tabNodes();
    return !!(await SvalPanel.engine.tree()).nodes?.[made];
  };
  Assert.ok(await inTree(), "in the tab list");
  const undo = SvalPanel._els.undoRegion.querySelector(
    '.sval-undo [data-command="undo"]'
  );
  Assert.ok(undo, "the panel offers Undo");
  undo.click();

  await TestUtils.waitForCondition(
    () => rowGuids().join() === [first, guid, last].join(),
    "the pin comes back, in its place"
  );
  Assert.deepEqual(store.pinScopeOf(guid), scope, "showing where it did");
  await TestUtils.waitForCondition(
    async () => !(await inTree()),
    "the tab the move made leaves the tab list"
  );
  Assert.equal(SvalPanel.observer.nodeIdFor(page), null, "no row is its page");
  Assert.equal(selectedPinGuid(), guid, "the pin is selected");
  Assert.equal(
    SvalPinPages.of(window).tabOf(guid)?.linkedBrowser,
    browser,
    "its page is the same browser"
  );
  Assert.equal(browser.currentURI.spec, LINKS_PAGE, "at the same address");
  Assert.ok(
    !SvalPanel._els.undoRegion.querySelector(".sval-undo"),
    "and the message goes"
  );
});

/**
 * A pin whose delete waits on one window's Undo message leaves every
 * window's row, and Undo brings it back to each.
 */
add_task(async function a_held_pin_leaves_every_windows_row() {
  forgetFavorites();
  await aTab();
  const guid = await pinFavorite(LINKS_PAGE, "Links");
  await untilPinShows(guid);
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    20_000,
    "a window opening"
  );
  await TestUtils.waitForCondition(
    () => win.SvalPanel.observer && win.SvalPanel.pins,
    "the window's panel starts"
  );
  // The window starting starts the profile's Favorites in the file's place.
  await restoreFixtureFavorites();
  await win.SvalPanel.pins?.refresh();
  await SvalPanel.pins.refresh();
  await untilPinShows(guid);
  const guidsThere = () =>
    (win.SvalPanel.pins?.slots ?? []).map(slot => slot.guid);
  await TestUtils.waitForCondition(
    () => guidsThere().includes(guid),
    "the other window's row shows the pin"
  );

  await choose(await pinMenuOn(tileOf(guid)), "delete");
  await TestUtils.waitForCondition(() => !tileOf(guid), "the pin goes here");
  Assert.ok(!guidsThere().includes(guid), "and from the other window's row");
  SvalPanel._els.undoRegion
    .querySelector('.sval-undo [data-command="undo"]')
    .click();
  await TestUtils.waitForCondition(() => tileOf(guid), "Undo brings it back");
  await TestUtils.waitForCondition(
    () => guidsThere().includes(guid),
    "to the other window's row too"
  );
  await within(BrowserTestUtils.closeWindow(win), 10_000, "the window closing");
});

add_task(async function a_pinned_folder_opens_its_pins_in_a_popover() {
  forgetFavorites();
  await aTab();
  const { store } = pinsFixture;
  const folder = { guid: await pinsFolder("Work") };
  const inner = await pinFavorite(LINKS_PAGE, "Links", {
    parentGuid: folder.guid,
    pin: false,
  });
  await within(store.whenIdle(), 10_000, "store going idle");
  const tile = await untilPinShows(folder.guid);
  Assert.ok(
    tile.querySelector(".sval-pin-plate"),
    "a folder is one tile, a plate of its icons"
  );
  EventUtils.synthesizeMouseAtCenter(tile, {});
  await TestUtils.waitForCondition(
    () => document.getElementById("sval-pins-popover")?.state === "open",
    "its popover opens"
  );
  const panel = document.getElementById("sval-pins-popover");
  Assert.equal(
    panel.querySelector(".sval-pins-popover-title").textContent,
    "Work"
  );
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  EventUtils.synthesizeMouseAtCenter(
    panel.querySelector(`button[data-guid="${inner}"]`),
    {}
  );
  await within(hidden, 10_000, "picking a pin closes the popover");
  await TestUtils.waitForCondition(
    () => selectedPinGuid() === inner,
    "and selects it"
  );
  await TestUtils.waitForCondition(
    () =>
      tileOf(folder.guid)?.closest(".sval-pin-slot").hasAttribute("data-wide"),
    "the folder widens with its selected pin"
  );
  Assert.equal(
    tileOf(folder.guid).querySelector(".sval-pin-name").textContent,
    "Links"
  );
});

/**
 * The home page shows the pins of the workspace its tab is in, as the row
 * does (pins spec §9).
 */
add_task(async function the_home_page_shows_this_workspaces_pins() {
  forgetFavorites();
  const { store, work } = pinsFixture;
  const mail = await pinFavorite(LINKS_PAGE, "Mail");
  const news = await pinFavorite(PAGE2, "News");
  await store.setPinScope(mail, [work]);
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "about:home"),
    10_000,
    "the home page opens"
  );
  const names = () =>
    SpecialPowers.spawn(tab.linkedBrowser, [], () =>
      [...content.document.querySelectorAll(".fav-row .fav-name")].map(
        el => el.textContent
      )
    );
  await TestUtils.waitForCondition(
    async () => JSON.stringify(await names()) === JSON.stringify(["News"]),
    "a pin limited to Work is not on Home's home page"
  );
  await store.setPinScope(mail, null);
  await TestUtils.waitForCondition(
    async () =>
      JSON.stringify(await names()) === JSON.stringify(["Mail", "News"]),
    "shown everywhere, it is there, in the row's order"
  );
  // The row redraws from the same change as the page, on its own turn.
  await TestUtils.waitForCondition(
    () => JSON.stringify(rowGuids()) === JSON.stringify([mail, news]),
    "the same order as the row"
  );
  BrowserTestUtils.removeTab(tab);
});
