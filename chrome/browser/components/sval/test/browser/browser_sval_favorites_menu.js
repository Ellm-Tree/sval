/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from sval_favorites_menu_helpers.js */

/**
 * The Favorites context menu (`SvalFavoritesMenu.sys.mjs`,
 * favorites-native spec §15.2), the end of Firefox's Library (§15.4) and the
 * settings that point at Favorites (§15.5).
 */

const { parseBookmarksHtml } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImportHtml.sys.mjs"
);
const MockFilePicker = SpecialPowers.MockFilePicker;

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_favorites_menu_helpers.js",
  this
);

const A = "https://example.com/a";
const B = "https://example.com/b";

/**
 * Puts favorite A at the top and favorite B in a folder named "Folder".
 *
 * @returns {Promise<{guid: string}>} the folder.
 */
async function seed() {
  await emptyFavorites();
  const [, guid] = await favoritesStore().insertTree([
    { title: "A", url: A },
    { title: "Folder", children: [{ title: "B", url: B }] },
  ]);
  return { guid };
}

/**
 * @param {string} guid A folder.
 * @returns {string[]} what it holds, each by name, "-" for a separator.
 */
function childrenOf(guid) {
  return favoritesStore()
    .children(guid)
    .map(row => (row.kind === "separator" ? "-" : row.name));
}

/**
 * Opens the context menu on `el` from the keyboard: the arrow keys move to
 * it in its open menu, then Shift+F10.
 *
 * @param {Element} popup The open menu `el` is in.
 * @param {Element} el
 * @returns {Promise<Element>} the context menu, shown.
 */
async function contextFromKeyboard(popup, el) {
  await TestUtils.waitForCondition(() => {
    if (el.hasAttribute("_moz-menuactive")) {
      return true;
    }
    EventUtils.synthesizeKey("KEY_ArrowDown", {}, window);
    return false;
  }, "the arrow keys reach the item");
  info("the item is active; Shift+F10");
  const menu = contextMenu();
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeKey("KEY_F10", { shiftKey: true }, window);
  await within(shown, 10_000, "the context menu showing");
  return menu;
}

/**
 * The open Favorites menu's row for `url`.
 *
 * @param {Element} popup
 * @param {string} url
 * @returns {Element|undefined}
 */
function rowFor(popup, url) {
  return Array.from(popup.querySelectorAll(":scope > menuitem")).find(
    el => el.dataset.url === url
  );
}

/**
 * Undoes the last change from the context menu.
 *
 * @param {Function} el Given the open Favorites menu, finds what to open the
 *   context menu on.
 */
async function undoFrom(el) {
  const popup = await openFavorites();
  const target = el(popup);
  const menu = await contextOn(await target);
  Assert.ok(!menuItem({ popup: menu }, "undo").hidden, "the menu offers Undo");
  await chooseInContextMenu(menu, "undo");
  await closeMenus();
}

add_setup(async function () {
  await TestUtils.waitForCondition(() => SvalPanel._els?.favoritesMenu);
  MockFilePicker.init(window.browsingContext);
  registerCleanupFunction(() => MockFilePicker.cleanup());
  await favoritesFixture();
});

add_task(async function the_keyboard_opens_the_menu_and_renames() {
  await seed();
  info("opening Favorites");
  const popup = await openFavorites();
  info("Favorites open");
  const item = await itemIn(popup, n => n.uri === A);
  const menu = await contextFromKeyboard(popup, item);
  Assert.equal(menu._svalTrigger, item, "the menu is about the favorite");
  Assert.deepEqual(
    shownWithoutUndo(menu),
    [
      "open",
      "openWindow",
      "openPrivate",
      "-",
      "pinHome",
      "pinHere",
      "-",
      "rename",
      "editAddress",
      "delete",
      "-",
      "moveTo",
      "moveDown",
      "-",
      "newFolder",
      "newSeparator",
      "-",
      "export",
    ],
    "a favorite's menu"
  );
  await TestUtils.waitForCondition(() => {
    const rename = menuItem({ popup: menu }, "rename");
    if (rename.hasAttribute("_moz-menuactive")) {
      return true;
    }
    EventUtils.synthesizeKey("KEY_ArrowDown", {}, window);
    return false;
  }, "the arrow keys reach Rename");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  EventUtils.synthesizeKey("KEY_Enter", {}, window);
  await within(hidden, 10_000, "the context menu closing on Enter");
  await confirm(await typeInto("Renamed"));
  await TestUtils.waitForCondition(
    () => rowFor(popup, A)?.getAttribute("label") === "Renamed",
    "Enter renamed it in the menu"
  );
  Assert.equal(favoritesFor(A)[0].name, "Renamed", "and in the document");
  await closeMenus();

  await undoFrom(p => itemIn(p, n => n.uri === A));
  await TestUtils.waitForCondition(
    () => favoritesFor(A)[0].name === "A",
    "Undo put the name back"
  );
});

add_task(async function a_folder_menu() {
  const folder = await seed();
  const popup = await openFavorites();
  let menu = await contextOn(await itemIn(popup, n => n.title === "Folder"));
  Assert.deepEqual(
    shownWithoutUndo(menu),
    [
      "openAll",
      "-",
      "pinHome",
      "pinHere",
      "-",
      "rename",
      "delete",
      "-",
      "moveTo",
      "moveUp",
      "-",
      "newFolder",
      "newSeparator",
      "-",
      "export",
    ],
    "a folder's menu"
  );
  await chooseInContextMenu(menu, "newFolder");
  await confirm(await typeInto("Inside"));
  await TestUtils.waitForCondition(
    () => childrenOf(folder.guid).join() === "B,Inside",
    "New Folder… makes it in the folder"
  );
  await closeMenus();

  await undoFrom(p => itemIn(p, n => n.uri === A));
  await TestUtils.waitForCondition(
    () => childrenOf(folder.guid).join() === "B",
    "Undo takes the new folder away"
  );
});

add_task(async function new_separator_goes_before_the_item() {
  const folder = await seed();

  let popup = await openFavorites();
  let menu = await contextOn(await itemIn(popup, n => n.title === "Folder"));
  await chooseInContextMenu(menu, "newSeparator");
  await TestUtils.waitForCondition(
    () => childrenOf(FAVORITES_ROOT).join() === "A,-,Folder",
    "New Separator puts one before the folder"
  );
  await closeMenus();

  popup = await openFavorites();
  menu = await contextOn(
    await TestUtils.waitForCondition(() =>
      Array.from(popup.children).find(
        el => el.localName === "menuseparator" && el.dataset.guid
      )
    )
  );
  Assert.deepEqual(
    shownWithoutUndo(menu),
    [
      "delete",
      "-",
      "moveTo",
      "moveUp",
      "moveDown",
      "-",
      "newFolder",
      "newSeparator",
      "-",
      "export",
    ],
    "a separator's menu"
  );
  await closeMenus();

  await undoFrom(p => itemIn(p, n => n.uri === A));
  await TestUtils.waitForCondition(
    () => childrenOf(FAVORITES_ROOT).join() === "A,Folder",
    "Undo takes the separator away"
  );
  Assert.deepEqual(childrenOf(folder.guid), ["B"], "the folder is untouched");
});

add_task(async function edit_address_refuses_a_non_address() {
  await seed();
  const popup = await openFavorites();
  const menu = await contextOn(await itemIn(popup, n => n.uri === A));
  await chooseInContextMenu(menu, "editAddress");
  const doc = await typeInto("javascript:alert(1)");
  const buttons = doc.querySelectorAll("sval-dialog sval-button");
  await TestUtils.waitForCondition(
    () => doc.querySelector(".sval-dialog-input").error,
    "a reason shows"
  );
  buttons[buttons.length - 1].click();
  Assert.ok(gDialogBox.isOpen, "and Save answers nothing while it shows");
  await typeInto("example.org/new");
  await confirm(doc);
  await TestUtils.waitForCondition(
    // eslint-disable-next-line sdl/no-insecure-url
    () => favoritesFor("http://example.org/new").length,
    "a typed address is fixed up as the address bar would"
  );
  await closeMenus();

  await undoFrom(p => itemIn(p, n => n.title === "Folder"));
  await TestUtils.waitForCondition(
    () => favoritesFor(A).length === 1,
    "Undo puts the address back"
  );
});

add_task(async function move_to_lists_folders_and_moves() {
  const folder = await seed();
  const popup = await openFavorites();
  let menu = await contextOn(await itemIn(popup, n => n.title === "Folder"));
  const moveTo = menuItem({ popup: menu }, "moveTo");
  const listShown = BrowserTestUtils.waitForPopupEvent(
    moveTo.menupopup,
    "shown"
  );
  moveTo.openMenu(true);
  await within(listShown, 10_000, "the Move To list showing");
  await TestUtils.waitForCondition(() => moveTo.menupopup.children.length);
  const listed = Array.from(moveTo.menupopup.children, el =>
    el.getAttribute("data-sval-menu-id")
  );
  Assert.deepEqual(
    listed,
    [`folder:${FAVORITES_ROOT}`],
    "a folder is never offered itself"
  );
  Assert.equal(
    moveTo.menupopup.children[0].getAttribute("disabled"),
    "true",
    "its own folder is offered disabled"
  );
  await closeMenus();

  const again = await openFavorites();
  menu = await contextOn(await itemIn(again, n => n.uri === A));
  const target = menuItem({ popup: menu }, "moveTo");
  const shown = BrowserTestUtils.waitForPopupEvent(target.menupopup, "shown");
  target.openMenu(true);
  await within(shown, 10_000, "the Move To list showing");
  const into = await TestUtils.waitForCondition(() =>
    menuItem({ popup: menu }, `folder:${folder.guid}`)
  );
  Assert.ok(
    into
      .getAttribute("aria-description")
      ?.includes(
        menuItem({ popup: menu }, `folder:${FAVORITES_ROOT}`).getAttribute(
          "aria-label"
        )
      ),
    "a nested folder says what it is in, which its indent shows the eye"
  );
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  target.menupopup.activateItem(into);
  await within(hidden, 10_000, "the context menu closing on the move");
  await TestUtils.waitForCondition(
    () => favoritesFor(A)[0]?.parentGuid === folder.guid,
    "A moved into the folder"
  );
  await closeMenus();

  await undoFrom(p => itemIn(p, n => n.title === "Folder"));
  await TestUtils.waitForCondition(
    () => childrenOf(FAVORITES_ROOT).join() === "A,Folder",
    "Undo moves it back where it was"
  );
});

/**
 * Move Up and Move Down put a favorite in order without dragging, and each
 * is offered only where there is a place to move to.
 */
add_task(async function move_up_and_down_reorder_without_dragging() {
  await seed();
  const order = () => childrenOf(FAVORITES_ROOT);
  Assert.deepEqual(order(), ["A", "Folder"]);

  let popup = await openFavorites();
  let menu = await contextOn(await itemIn(popup, n => n.uri === A));
  await chooseInContextMenu(menu, "moveDown");
  await TestUtils.waitForCondition(
    () => order().join() === "Folder,A",
    "Move Down put A after the folder"
  );
  await closeMenus();

  popup = await openFavorites();
  menu = await contextOn(await itemIn(popup, n => n.uri === A));
  Assert.ok(
    !shownCommands(menu).includes("moveDown"),
    "the last one has no Move Down"
  );
  await chooseInContextMenu(menu, "moveUp");
  await TestUtils.waitForCondition(
    () => order().join() === "A,Folder",
    "Move Up put it back first"
  );
  await closeMenus();
});

add_task(async function delete_and_undo() {
  const folder = await seed();
  let popup = await openFavorites();
  let menu = await contextOn(await itemIn(popup, n => n.uri === A));
  await chooseInContextMenu(menu, "delete");
  await TestUtils.waitForCondition(
    () => !rowFor(popup, A),
    "a favorite leaves the menu at once"
  );
  Assert.deepEqual(favoritesFor(A), [], "and is deleted");
  await closeMenus();
  await undoFrom(p => itemIn(p, n => n.title === "Folder"));
  await TestUtils.waitForCondition(
    () => favoritesFor(A)[0]?.index === 0,
    "Undo brings it back where it was"
  );

  popup = await openFavorites();
  menu = await contextOn(await itemIn(popup, n => n.title === "Folder"));
  await chooseInContextMenu(menu, "delete");
  const doc = await dialog();
  Assert.ok(
    doc.querySelector(".sval-dialog-body").textContent.includes("1"),
    "a folder holding favorites asks first, naming how many"
  );
  gDialogBox.dialog.close();
  await TestUtils.waitForCondition(() => !gDialogBox.isOpen);
  Assert.ok(favoritesStore().get(folder.guid), "Cancel keeps the folder");
  await closeMenus();

  popup = await openFavorites();
  menu = await contextOn(await itemIn(popup, n => n.title === "Folder"));
  await chooseInContextMenu(menu, "delete");
  await confirm(await dialog());
  await TestUtils.waitForCondition(
    () => !favoritesStore().get(folder.guid) && !favoritesFor(B).length,
    "Delete folder takes it with what it holds"
  );
  await closeMenus();
  await undoFrom(p => itemIn(p, n => n.uri === A));
  await TestUtils.waitForCondition(
    () => favoritesFor(B)[0]?.parentGuid === folder.guid,
    "Undo brings the folder back with what it held"
  );
});

add_task(async function open_all_asks_above_the_limit() {
  await seed();
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.tabs.warnOnOpen", true],
      ["browser.tabs.maxOpenBeforeWarn", 0],
    ],
  });
  const popup = await openFavorites();
  const menu = await contextOn(await itemIn(popup, n => n.title === "Folder"));
  await chooseInContextMenu(menu, "openAll");
  const doc = await dialog();
  Assert.ok(
    doc.querySelector(".sval-dialog-title").textContent.includes("1"),
    "it asks with the count"
  );
  const box = doc.querySelector(".sval-dialog-check sval-checkbox");
  Assert.ok(box.checked, "it offers to stop asking, ticked to keep asking");
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, B);
  await confirm(doc);
  const tab = await within(opened, 10_000, "the folder's tab opening");
  Assert.equal(gBrowser.selectedTab, tab, "the first opens in front");
  Assert.ok(
    Services.prefs.getBoolPref("browser.tabs.warnOnOpen"),
    "left ticked, it asks again"
  );
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
  await closeMenus();
});

add_task(async function open_all_stops_asking_once_told() {
  await seed();
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.tabs.warnOnOpen", true],
      ["browser.tabs.maxOpenBeforeWarn", 1],
    ],
  });
  const popup = await openFavorites();
  const menu = await contextOn(await itemIn(popup, n => n.title === "Folder"));
  await chooseInContextMenu(menu, "openAll");
  // One tab at a limit of one asks, as `OpenInTabsUtils` does.
  const doc = await dialog();
  const box = doc.querySelector(".sval-dialog-check sval-checkbox");
  box.click();
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, B);
  await confirm(doc);
  BrowserTestUtils.removeTab(
    await within(opened, 10_000, "the folder's tab opening")
  );
  Assert.ok(
    !Services.prefs.getBoolPref("browser.tabs.warnOnOpen"),
    "unticked, it stops asking"
  );
  await SpecialPowers.popPrefEnv();
  await closeMenus();
});

/**
 * A bookmarklet counts its runs on the page, so a run shows on the page it
 * acted on.
 */
const BOOKMARKLET =
  "javascript:void(document.body.dataset.svalRuns=" +
  "Number(document.body.dataset.svalRuns||0)+1)";

/** @returns {Promise<string|undefined>} how often it ran on the selected page. */
function runsOnPage() {
  return SpecialPowers.spawn(
    gBrowser.selectedBrowser,
    [],
    () => content.document.body.dataset.svalRuns
  );
}

/**
 * Opens Favorites and its Folder submenu.
 *
 * @returns {Promise<Element>} the bookmarklet's item there.
 */
async function bookmarkletItem() {
  const popup = await openFavorites();
  const folderMenu = await itemIn(popup, n => n.title === "Folder");
  const shown = BrowserTestUtils.waitForPopupEvent(
    folderMenu.menupopup,
    "shown"
  );
  folderMenu.openMenu(true);
  await within(shown, 5_000, "the Folder submenu's popupshown");
  return itemIn(folderMenu.menupopup, n => n.uri === BOOKMARKLET);
}

add_task(async function a_bookmarklet_runs_on_the_page_both_ways() {
  const folder = await seed();
  await favoritesStore().insertTree(
    [{ title: "Bookmarklet", url: BOOKMARKLET }],
    {
      parentGuid: folder.guid,
    }
  );
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    const tabs = gBrowser.tabs.length;
    let item = await bookmarkletItem();
    item.parentNode.activateItem(item);
    await TestUtils.waitForCondition(
      async () => (await runsOnPage()) === "1",
      "a click runs it on the page"
    );
    await closeMenus();

    item = await bookmarkletItem();
    let menu = await contextOn(item);
    Assert.deepEqual(
      shownWithoutUndo(menu),
      [
        "open",
        "-",
        "rename",
        "editAddress",
        "delete",
        "-",
        "moveTo",
        "moveUp",
        "-",
        "newFolder",
        "newSeparator",
        "-",
        "export",
      ],
      "a bookmarklet has one Open"
    );
    await chooseInContextMenu(menu, "open");
    await TestUtils.waitForCondition(
      async () => (await runsOnPage()) === "2",
      "Open runs it on the page"
    );
    Assert.equal(gBrowser.tabs.length, tabs, "and opens no tab");
    await closeMenus();

    await SpecialPowers.pushPrefEnv({
      set: [["browser.sval.favorites.bookmarklets", false]],
    });
    item = await bookmarkletItem();
    menu = await contextOn(item);
    Assert.ok(
      !shownCommands(menu).includes("open"),
      "turned off, a bookmarklet has no Open"
    );
    await closeMenus();
    item = await bookmarkletItem();
    item.parentNode.activateItem(item);
    await closeMenus();
    await SpecialPowers.popPrefEnv();

    item = await bookmarkletItem();
    item.parentNode.activateItem(item);
    await TestUtils.waitForCondition(
      async () => (await runsOnPage()) === "3",
      "turned on again, a click runs it"
    );
    Assert.equal(
      await runsOnPage(),
      "3",
      "the click while it was off ran nothing"
    );
    await closeMenus();
  });
});

/**
 * Runs a script on `browser`'s page as `PlacesUIUtils.openNodeIn` runs a
 * bookmarklet, with the system principal, and waits for it. Its
 * `nsJSChannel` evaluates on the page's window after one the page was given
 * before, so a bookmarklet that was going to run there has run.
 *
 * @param {Element} browser
 */
async function afterEarlierScripts(browser) {
  browser.loadURI(
    Services.io.newURI("javascript:void(document.body.dataset.svalProbe=1)"),
    { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }
  );
  await TestUtils.waitForCondition(
    () =>
      SpecialPowers.spawn(
        browser,
        [],
        () => content.document.body.dataset.svalProbe === "1"
      ),
    "the later script runs on the page"
  );
}

/**
 * Runs the bookmarklet from the Favorites menu on the page `url` opens, in
 * a new tab, and says whether it ran there.
 *
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function bookmarkletRanOn(url) {
  return BrowserTestUtils.withNewTab(url, async browser => {
    const item = await bookmarkletItem();
    const picked = BrowserTestUtils.waitForEvent(item, "command");
    item.parentNode.activateItem(item);
    await within(picked, 5_000, "the bookmarklet's command");
    await closeMenus();
    await afterEarlierScripts(browser);
    return (await runsOnPage()) !== undefined;
  });
}

add_task(async function a_bookmarklet_runs_only_on_a_web_page() {
  const folder = await seed();
  await favoritesStore().insertTree(
    [{ title: "Bookmarklet", url: BOOKMARKLET }],
    { parentGuid: folder.guid }
  );
  const extension = ExtensionTestUtils.loadExtension({
    files: { "page.html": "<!doctype html><body></body>" },
  });
  await extension.startup();

  Assert.ok(
    !(await bookmarkletRanOn("about:home")),
    "on the home page, it runs nothing"
  );
  Assert.ok(
    !(await bookmarkletRanOn(`moz-extension://${extension.uuid}/page.html`)),
    "on an extension's page, it runs nothing"
  );
  Assert.ok(
    await bookmarkletRanOn("https://example.com/"),
    "on a site, it runs on the page"
  );
  await extension.unload();
});

add_task(async function open_all_leaves_bookmarklets_out() {
  const folder = await seed();
  await favoritesStore().insertTree(
    [{ title: "Bookmarklet", url: BOOKMARKLET }],
    {
      parentGuid: folder.guid,
    }
  );
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.tabs.warnOnOpen", true],
      ["browser.tabs.maxOpenBeforeWarn", 0],
    ],
  });
  const popup = await openFavorites();
  const menu = await contextOn(await itemIn(popup, n => n.title === "Folder"));
  await chooseInContextMenu(menu, "openAll");
  const doc = await dialog();
  Assert.ok(
    doc.querySelector(".sval-dialog-title").textContent.includes("1"),
    "only the page counts"
  );
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, B);
  await confirm(doc);
  BrowserTestUtils.removeTab(
    await within(opened, 15_000, "the confirmed tab opening on the page")
  );
  await SpecialPowers.popPrefEnv();
  await closeMenus();
});

add_task(async function export_gives_back_the_same_tree() {
  await seed();
  const file = new FileUtils.File(tempPath("sval-favorites-export", ".html"));
  MockFilePicker.setFiles([file]);
  MockFilePicker.returnValue = MockFilePicker.returnOK;
  const popup = await openFavorites();
  const menu = await contextOn(await itemIn(popup, n => n.uri === A));
  await chooseInContextMenu(menu, "export");
  // The menu's Export opens the export page, where Favorites start ticked.
  const doc = await openedDialog(".sval-ex-target");
  Assert.ok(doc.querySelector(".sval-ex-favorites").checked);
  const exportButton = doc.querySelector(".sval-ex-export");
  await clickInDialog(exportButton, "Export");
  await TestUtils.waitForCondition(
    () => !doc.querySelector(".sval-ex-notice").hidden,
    "the page says the file is saved"
  );
  const closed = BrowserTestUtils.waitForEvent(
    gDialogBox.dialog._frame.contentWindow,
    "unload"
  );
  await clickInDialog(exportButton, "Done");
  await within(closed, 10_000, "Done closing the page");
  const { roots } = parseBookmarksHtml(await IOUtils.readUTF8(file.path));
  Assert.deepEqual(
    roots.toolbar,
    [
      { type: "bookmark", title: "A", url: A },
      {
        type: "folder",
        title: "Folder",
        children: [{ type: "bookmark", title: "B", url: B }],
      },
    ],
    "the export reads back as the same Favorites"
  );
  await closeMenus();
});

/**
 * Opens the submenu of the folder item `menu` and waits for it to show.
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

/** Folders nest, each drawn from the document and again as it changes. */
add_task(async function folders_nest_and_follow_the_document() {
  const folder = await seed();
  const [inner] = await favoritesStore().insertTree(
    [{ title: "Inner", children: [] }],
    { parentGuid: folder.guid }
  );
  const popup = await openFavorites();
  const a = await itemIn(popup, n => n.uri === A);
  Assert.ok(
    a.classList.contains("bookmark-item"),
    "a favorite is drawn as Firefox's bookmarks menus draw one"
  );
  Assert.ok(
    a.getAttribute("image").startsWith("page-icon:"),
    "with the icon history keeps for its page"
  );
  const folderPopup = await openFolder(
    await itemIn(popup, n => n.title === "Folder")
  );
  const innerPopup = await openFolder(
    await itemIn(folderPopup, n => n.guid === inner)
  );
  const empty = await TestUtils.waitForCondition(
    () => innerPopup.querySelector("menuitem[disabled]"),
    "an empty folder shows the empty item"
  );
  await translated(empty);
  Assert.ok(empty.getAttribute("label"), "which says it is empty");

  await favoritesStore().insertTree(
    [{ title: "C", url: "https://example.com/c" }],
    {
      parentGuid: inner,
    }
  );
  await TestUtils.waitForCondition(
    () =>
      innerPopup.querySelector("menuitem[data-guid]")?.getAttribute("label") ===
      "C",
    "an open folder draws a favorite added to it"
  );
  Assert.ok(
    !innerPopup.querySelector("menuitem[disabled]"),
    "and stops saying it is empty"
  );
  await favoritesStore().rename(folder.guid, "Renamed");
  await TestUtils.waitForCondition(
    () =>
      popup
        .querySelector(`menu[data-guid="${folder.guid}"]`)
        ?.getAttribute("label") === "Renamed",
    "an open menu follows a rename"
  );
  Assert.equal(innerPopup.state, "open", "and keeps its submenus open");
  await closeMenus();
});

/**
 * A change to Favorites while their menu is open draws each favorite again
 * on the item it had, through `SvalMenu.fill`, moving only what moved.
 */
add_task(async function a_redraw_keeps_each_favorites_item() {
  const folder = await seed();
  const [c] = await favoritesStore().insertTree([
    { title: "C", url: "https://example.com/c" },
  ]);
  const popup = await openFavorites();
  const a = await itemIn(popup, n => n.uri === A);
  const folderItem = await itemIn(popup, n => n.title === "Folder");
  const b = await itemIn(await openFolder(folderItem), n => n.uri === B);
  const cItem = popup.querySelector(`[data-guid="${c}"]`);
  const guids = () =>
    [...popup.children]
      .filter(el => el.dataset.guid)
      .map(el => el.dataset.guid);

  await favoritesStore().move(c, FAVORITES_ROOT, 0);
  await favoritesStore().rename(a.dataset.guid, "A renamed");
  await TestUtils.waitForCondition(
    () => guids()[0] === c && a.getAttribute("label") === "A renamed",
    "the menu draws the move and the rename"
  );
  Assert.deepEqual(
    guids(),
    favoritesStore()
      .children(FAVORITES_ROOT)
      .map(row => row.guid),
    "in the document's order"
  );
  Assert.equal(
    popup.querySelector(`[data-guid="${c}"]`),
    cItem,
    "the moved favorite keeps its item"
  );
  Assert.ok(a.isConnected, "the renamed one keeps its item");
  Assert.equal(
    popup.querySelector(`[data-guid="${folder.guid}"]`),
    folderItem,
    "the folder keeps its item"
  );
  Assert.equal(folderItem.menupopup.state, "open", "and stays open");
  Assert.ok(b.isConnected, "with its own items");
  await closeMenus();
});

/** A favorite dragged within the menu moves, and Undo takes the move back. */
add_task(async function dragging_reorders_and_moves_into_a_folder() {
  const folder = await seed();
  const popup = await openFavorites();
  let dt = new DataTransfer();
  drag("dragstart", await itemIn(popup, n => n.uri === A), dt);
  Assert.equal(
    dt.getData("text/uri-list"),
    A,
    "a dragged favorite carries its address, for a page or another app"
  );
  Assert.equal(dt.getData("text/x-moz-url"), `${A}\nA`);
  const folderItem = await itemIn(popup, n => n.title === "Folder");
  const over = drag("dragover", folderItem, dt, 0.95);
  Assert.ok(over.defaultPrevented, "the menu takes it");
  Assert.equal(
    folderItem.getAttribute("data-drop"),
    "after",
    "the drop line shows below the folder"
  );
  drag("drop", folderItem, dt, 0.95);
  await TestUtils.waitForCondition(
    () => childrenOf(FAVORITES_ROOT).join() === "Folder,A",
    "a drop below the folder puts A after it"
  );
  Assert.ok(
    !folderItem.hasAttribute("data-drop"),
    "the drop line goes with the drop"
  );

  dt = new DataTransfer();
  drag("dragstart", await itemIn(popup, n => n.uri === A), dt);
  drag("dragover", folderItem, dt, 0.5);
  drag("drop", folderItem, dt, 0.5);
  await TestUtils.waitForCondition(
    () => favoritesFor(A)[0]?.parentGuid === folder.guid,
    "a drop on the folder's middle files A in it"
  );
  Assert.deepEqual(childrenOf(folder.guid), ["B", "A"], "at its end");

  dt = new DataTransfer();
  drag("dragstart", folderItem, dt);
  const folderPopup = await openFolder(folderItem);
  const intoItself = drag(
    "dragover",
    await itemIn(folderPopup, n => n.uri === B),
    dt
  );
  Assert.ok(!intoItself.defaultPrevented, "a folder never drops into itself");
  await closeMenus();

  await undoFrom(p => itemIn(p, n => n.title === "Folder"));
  await TestUtils.waitForCondition(
    () => childrenOf(FAVORITES_ROOT).join() === "Folder,A",
    "Undo takes the last move back"
  );
});

/**
 * A favorite dropped into an open folder, or past it, leaves the menu and
 * the folder's submenu open, as Firefox's bookmarks menus do
 * (`places-popup`'s `on_drop` closes none), with the menu's outline traced
 * around what it holds then.
 */
add_task(async function a_drop_by_an_open_folder_keeps_both_menus_open() {
  const folder = await seed();
  const popup = await openFavorites();
  const folderItem = await itemIn(popup, n => n.title === "Folder");
  const folderPopup = await openFolder(folderItem);
  const content = popup.shadowRoot.querySelector('[part~="content"]');
  const dropA = async (from, target, at, root, inFolder) => {
    const dt = new DataTransfer();
    drag("dragstart", await itemIn(from, n => n.uri === A), dt);
    Assert.ok(drag("dragover", target, dt, at).defaultPrevented, "it drops");
    drag("drop", target, dt, at);
    await TestUtils.waitForCondition(
      () =>
        childrenOf(FAVORITES_ROOT).join() === root &&
        childrenOf(folder.guid).join() === inFolder,
      `the drop leaves ${root} with ${inFolder} in the folder`
    );
    await TestUtils.waitForCondition(
      () =>
        Array.from(popup.querySelectorAll(":scope > [data-guid]"), el =>
          el.getAttribute("label")
        ).join() === root,
      "the menu draws the move"
    );
    Assert.equal(popup.state, "open", "the Favorites menu stays open");
    Assert.equal(folderPopup.state, "open", "and so does the folder's");
    Assert.equal(
      popup.querySelector(`menu[data-guid="${folder.guid}"]`),
      folderItem,
      "the folder keeps its item"
    );
    Assert.ok(folderItem.open, "which shows its submenu open");
    await TestUtils.waitForCondition(() => {
      const body = parseFloat(
        popup.style.getPropertyValue("--sval-stem-body-height")
      );
      return (
        popup.getAttribute("sval-stem") === "placed" &&
        Math.abs(body - content.getBoundingClientRect().height) < 1
      );
    }, "the menu's outline is traced around what it holds");
  };

  await dropA(
    popup,
    await itemIn(folderPopup, n => n.uri === B),
    0.95,
    "Folder",
    "B,A"
  );
  await dropA(folderPopup, folderItem, 0.95, "Folder,A", "B");
  await dropA(popup, folderItem, 0.05, "A,Folder", "B");
  await closeMenus();
});

/**
 * The undo key, pressed while Favorites is open, takes back the last change
 * to them: a drag's reorder, an add, a rename and a delete.
 */
add_task(async function the_undo_key_in_favorites_takes_a_change_back() {
  await seed();
  const store = favoritesStore();
  const popup = await openFavorites();
  const undoKey = async (what, expected) => {
    EventUtils.synthesizeKey("z", { accelKey: true }, window);
    await TestUtils.waitForCondition(
      () => childrenOf(FAVORITES_ROOT).join() === expected,
      `the undo key takes back ${what}`
    );
    Assert.equal(popup.state, "open", "and Favorites stay open");
  };

  const dt = new DataTransfer();
  const folderItem = await itemIn(popup, n => n.title === "Folder");
  drag("dragstart", await itemIn(popup, n => n.uri === A), dt);
  drag("dragover", folderItem, dt, 0.95);
  drag("drop", folderItem, dt, 0.95);
  await TestUtils.waitForCondition(
    () => childrenOf(FAVORITES_ROOT).join() === "Folder,A",
    "the drag puts A after the folder"
  );
  await undoKey("the reorder", "A,Folder");

  await store.add({ url: "https://example.com/c", title: "C" });
  Assert.equal(childrenOf(FAVORITES_ROOT).join(), "A,Folder,C");
  await undoKey("the add", "A,Folder");

  const [{ guid }] = favoritesFor(A);
  await store.rename(guid, "Renamed");
  Assert.equal(childrenOf(FAVORITES_ROOT).join(), "Renamed,Folder");
  await undoKey("the rename", "A,Folder");

  await store.delete(guid);
  Assert.equal(childrenOf(FAVORITES_ROOT).join(), "Folder");
  await undoKey("the delete", "A,Folder");

  const menu = await contextOn(await itemIn(popup, n => n.uri === A));
  const undo = menuItem({ popup: menu }, "undo");
  Assert.equal(undo.getAttribute("key"), "key_undo", "Undo names the key");
  Assert.equal(
    undo.getAttribute("aria-keyshortcuts"),
    AppConstants.platform === "macosx" ? "Meta+Z" : "Control+Z",
    "to assistive technology too"
  );
  await closeMenus();
});

/** With Favorites closed, the undo key in a field undoes its text. */
add_task(async function the_undo_key_in_a_field_undoes_the_text() {
  await seed();
  const [{ guid }] = favoritesFor(A);
  await favoritesStore().rename(guid, "Renamed");
  gURLBar.focus();
  gURLBar.select();
  EventUtils.sendString("sval", window);
  Assert.equal(gURLBar.value, "sval", "typed in the address bar");
  EventUtils.synthesizeKey("z", { accelKey: true }, window);
  Assert.notEqual(gURLBar.value, "sval", "the key undoes the typing");
  Assert.equal(
    childrenOf(FAVORITES_ROOT).join(),
    "Renamed,Folder",
    "and leaves Favorites as they are"
  );
  gURLBar.handleRevert();
  gURLBar.blur();
});

/** A link dropped on the menu becomes a favorite where it lands. */
add_task(async function a_dropped_link_becomes_a_favorite_there() {
  await seed();
  const C = "https://example.com/c";
  const popup = await openFavorites();
  const a = await itemIn(popup, n => n.uri === A);
  let dt = new DataTransfer();
  dt.mozSetDataAt("text/x-moz-url", `${C}\nC`, 0);
  Assert.ok(drag("dragover", a, dt, 0.1).defaultPrevented, "a link is taken");
  Assert.equal(a.getAttribute("data-drop"), "before");
  drag("drop", a, dt, 0.1);
  await TestUtils.waitForCondition(
    () => childrenOf(FAVORITES_ROOT).join() === "C,A,Folder",
    "the link lands before A"
  );

  dt = new DataTransfer();
  dt.mozSetDataAt("text/plain", "not an address", 0);
  drag("dragover", a, dt);
  drag("drop", a, dt);
  await within(
    favoritesStore().whenIdle(),
    10_000,
    "favoritesStore going idle"
  );
  Assert.deepEqual(
    childrenOf(FAVORITES_ROOT),
    ["C", "A", "Folder"],
    "text that is no address adds nothing"
  );
  await closeMenus();
});

/** A dropped script asks first, and is added only on Add. */
add_task(async function a_dropped_script_asks_before_it_is_added() {
  await seed();
  const dropScript = async () => {
    const popup = await openFavorites();
    const a = await itemIn(popup, n => n.uri === A);
    const dt = new DataTransfer();
    dt.mozSetDataAt("text/x-moz-url", "javascript:alert(1)\nScript", 0);
    Assert.ok(
      drag("dragover", a, dt, 0.1).defaultPrevented,
      "the drop is taken"
    );
    drag("drop", a, dt, 0.1);
    return dialog();
  };

  let doc = await dropScript();
  Assert.equal(
    doc.querySelector(".sval-dialog-title").textContent,
    new Localization(["sval/favorites.ftl"], true).formatValueSync(
      "sval-favorites-bookmarklet-question"
    ),
    "Sval asks what the favorite does"
  );
  Assert.equal(
    doc.activeElement?.dataset.button,
    "cancel",
    "with Cancel focused"
  );
  const cancelled = TestUtils.waitForCondition(() => !gDialogBox.isOpen);
  doc.querySelector('[data-button="cancel"]').click();
  await cancelled;
  await within(
    favoritesStore().whenIdle(),
    10_000,
    "favoritesStore going idle"
  );
  Assert.deepEqual(
    childrenOf(FAVORITES_ROOT),
    ["A", "Folder"],
    "Cancel adds nothing"
  );
  await closeMenus();

  doc = await dropScript();
  await confirm(doc);
  await TestUtils.waitForCondition(
    () => childrenOf(FAVORITES_ROOT).join() === "Script,A,Folder",
    "Add puts it where it was dropped"
  );
  await closeMenus();
});

add_task(async function a_drop_of_several_links_is_one_change() {
  await seed();
  const C = "https://example.com/c";
  const D = "https://example.com/d";
  const popup = await openFavorites();
  const a = await itemIn(popup, n => n.uri === A);
  const dt = new DataTransfer();
  dt.mozSetDataAt("text/x-moz-url", `${C}\nC\n${D}\nD`, 0);
  drag("dragover", a, dt, 0.9);
  drag("drop", a, dt, 0.9);
  await TestUtils.waitForCondition(
    () => childrenOf(FAVORITES_ROOT).join() === "A,C,D,Folder",
    "both links land after A, in order"
  );
  await closeMenus();
  await undoFrom(p => itemIn(p, n => n.uri === A));
  await TestUtils.waitForCondition(
    () => childrenOf(FAVORITES_ROOT).join() === "A,Folder",
    "one Undo takes the whole drop back"
  );
});

add_task(async function a_middle_click_opens_a_favorite_in_a_tab() {
  await seed();
  // From a page: an empty tab is the one a favorite opens in
  // (`PlacesUIUtils.openNodeWithEvent`).
  await BrowserTestUtils.withNewTab(PAGE, async () => {
    const popup = await openFavorites();
    const a = await itemIn(popup, n => n.uri === A);
    const opened = BrowserTestUtils.waitForNewTab(gBrowser, A);
    EventUtils.synthesizeMouseAtCenter(a, { button: 1 });
    const tab = await within(opened, 10_000, "the favorite's tab opening");
    Assert.equal(tab.linkedBrowser.currentURI.spec, A, "a tab of its own");
    BrowserTestUtils.removeTab(tab);
    await closeMenus();
  });
});

add_task(async function nothing_opens_the_library() {
  const before = gBrowser.tabs.length;
  const reach = [
    () => PlacesCommandHook.showPlacesOrganizer("AllBookmarks"),
    () => PlacesCommandHook.showPlacesOrganizer("History"),
    () => PlacesCommandHook.showPlacesOrganizer("Downloads"),
    () => BrowserCommands.downloadsUI(),
    () => document.getElementById("Browser:ShowAllHistory")?.doCommand(),
    () => document.getElementById("Browser:ShowAllBookmarks")?.doCommand(),
  ];
  for (const go of reach) {
    go();
  }
  // The Library opens synchronously from `openDialog`, so by the time the
  // tab and the sidebar these lead to are there, it would be too.
  await TestUtils.waitForCondition(
    () =>
      gBrowser.tabs.some(
        t => t.linkedBrowser.currentURI.spec === "about:downloads"
      ),
    "downloads open in a tab"
  );
  Assert.ok(
    !Services.wm.getMostRecentWindow("Places:Organizer"),
    "no Library window"
  );
  Assert.equal(SidebarController.currentID, "viewHistorySidebar");
  SidebarController.hide();
  await closeMenus();
  while (gBrowser.tabs.length > before) {
    BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
  }
});

add_task(async function the_history_sidebar_menu_has_no_stray_separators() {
  const { PlacesTestUtils } = ChromeUtils.importESModule(
    "resource://testing-common/PlacesTestUtils.sys.mjs"
  );
  await PlacesUtils.history.clear();
  await PlacesTestUtils.addVisits(A);
  await within(
    SidebarController.show("viewHistorySidebar"),
    10_000,
    "the history sidebar showing"
  );
  // Right-clicked where it rests, once it has slid in.
  await TestUtils.waitForCondition(
    () => !document.getElementById("sidebar-box").hasAttribute("sval-overlay"),
    "the history sidebar sliding in"
  );
  const doc = SidebarController.browser.contentDocument;
  const menu = doc.getElementById("placesContext");
  await TestUtils.waitForCondition(
    () => menu._svalHidden,
    "sval hid its items in the sidebar's menu"
  );
  doc.getElementById("bylastvisited").doCommand();
  const tree = doc.getElementById("historyTree");
  await TestUtils.waitForCondition(
    () => tree.view?.rowCount > 0 && tree.getBoundingClientRect().width > 0,
    "the visit is listed"
  );
  tree.view.selection.select(0);
  const rect = tree.getCoordsForCellItem(0, tree.columns[0], "text");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  AccessibilityUtils.setEnv({ labelRule: false });
  EventUtils.synthesizeMouse(
    tree.body,
    rect.x + rect.width / 2,
    rect.y + rect.height / 2,
    { type: "contextmenu", button: 2 },
    doc.defaultView
  );
  AccessibilityUtils.resetEnv();
  await within(shown, 10_000, "the sidebar's context menu showing");

  const visible = [...menu.children].filter(item => !item.hidden);
  const kinds = visible.map(item =>
    item.localName === "menuseparator" ? "-" : "item"
  );
  Assert.notEqual(kinds[0], "-", "no separator first");
  Assert.notEqual(kinds.at(-1), "-", "no separator last");
  Assert.ok(
    kinds.every((kind, i) => kind !== "-" || kinds[i + 1] !== "-"),
    "no two separators together"
  );
  Assert.ok(
    !visible.some(item => item.id === "placesContext_createBookmark"),
    "no Bookmark Page"
  );

  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(hidden, 10_000, "the sidebar's context menu hiding");
  SidebarController.hide();
  await PlacesUtils.history.clear();
});

add_task(async function a_history_click_opens_a_new_tab() {
  const { PlacesTestUtils } = ChromeUtils.importESModule(
    "resource://testing-common/PlacesTestUtils.sys.mjs"
  );
  await PlacesUtils.history.clear();
  await PlacesTestUtils.addVisits(B);
  const page = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, A),
    10_000,
    "the page's tab loading"
  );
  await within(
    SidebarController.show("viewHistorySidebar"),
    10_000,
    "the history sidebar showing"
  );
  // Clicked where it rests, once it has slid in.
  await TestUtils.waitForCondition(
    () => !document.getElementById("sidebar-box").hasAttribute("sval-overlay"),
    "the history sidebar sliding in"
  );
  const doc = SidebarController.browser.contentDocument;
  doc.getElementById("bylastvisited").doCommand();
  const tree = doc.getElementById("historyTree");
  // The open page is a visit too, so the row is found by its address.
  const row = await TestUtils.waitForCondition(() => {
    if (!tree.view || !tree.getBoundingClientRect().width) {
      return null;
    }
    for (let i = 0; i < tree.view.rowCount; i++) {
      if (tree.view.nodeForTreeIndex(i).uri === B) {
        return { index: i };
      }
    }
    return null;
  }, "the visit is listed");
  const rect = tree.getCoordsForCellItem(row.index, tree.columns[0], "text");
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, B);
  // A history tree with columns is a tree table, which Tab reaches and the
  // arrow keys and Enter work, and which the checker does not count among
  // interactive roles.
  AccessibilityUtils.setEnv({
    labelRule: false,
    mustHaveAccessibleRule: false,
  });
  EventUtils.synthesizeMouse(
    tree.body,
    rect.x + rect.width / 2,
    rect.y + rect.height / 2,
    {},
    doc.defaultView
  );
  AccessibilityUtils.resetEnv();
  const tab = await within(opened, 10_000, "the visit's tab opening");
  Assert.equal(page.linkedBrowser.currentURI.spec, A, "the page stays");
  SidebarController.hide();
  await TestUtils.waitForCondition(
    () => !SidebarController.isOpen,
    "the sidebar sliding out"
  );
  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(page);
  await PlacesUtils.history.clear();
});

add_task(async function the_library_shortcut_opens_favorites() {
  const popup = SvalPanel._els.favoritesMenu;
  const shown = BrowserTestUtils.waitForPopupEvent(popup, "shown");
  EventUtils.synthesizeKey("O", { accelKey: true, shiftKey: true });
  await within(shown, 10_000, "the Favorites menu showing");
  Assert.ok(
    !Services.wm.getMostRecentWindow("Places:Organizer"),
    "no Library window"
  );
  await closeMenus();
});

add_task(function view_toolbars_lists_nothing_so_does_not_show() {
  const { onViewMenuShowing } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalHeader.sys.mjs"
  );
  // The View menu is in the menu bar, whose autohide would take a real
  // `popupshowing` there as the menu bar opening (`AutoHideMenubar`).
  onViewMenuShowing({ target: document.getElementById("menu_viewPopup") });
  Assert.ok(
    document.getElementById("viewToolbarsMenu").hidden,
    "neither the bookmarks toolbar nor the menu bar can be toggled"
  );
});

/** Import, in Workspaces alone, says it brings favorites. */
add_task(async function import_says_it_brings_favorites() {
  await BrowserTestUtils.withNewTab("about:preferences", async browser => {
    const win = browser.contentWindow;
    const doc = browser.contentDocument;
    const text = el =>
      `${el?.getAttribute("label")} ${el?.getAttribute("description")}`;

    await showPane(win, "paneSync");
    await showPane(win, "paneHome");
    const migration = await TestUtils.waitForCondition(() =>
      doc.querySelector(
        '[data-category="paneHome"] ' +
          'setting-group[groupid="importBrowserData"] moz-fieldset'
      )
    );
    await doc.l10n.translateFragment(migration);
    Assert.ok(
      text(migration).includes("tabs, favorites and history"),
      "import says what sval imports"
    );
    Assert.equal(
      doc.querySelectorAll('setting-group[groupid="importBrowserData"]').length,
      1,
      "Workspaces alone offers import"
    );
    const exportButton = doc.getElementById("data-export");
    Assert.ok(exportButton, "and Export beside it");
    exportButton.click();
    const { doc: page } = await openedSvalDialog();
    Assert.ok(
      page.querySelector(".sval-ex-cancel"),
      "Export opens the export page"
    );
    const closed = BrowserTestUtils.waitForEvent(page.defaultView, "unload");
    await pressDialogButton(page, "cancel");
    await within(closed, 10_000, "Cancel closing the page");
  });
});
