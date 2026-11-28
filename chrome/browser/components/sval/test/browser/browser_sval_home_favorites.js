/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from sval_favorites_menu_helpers.js */

/**
 * The home page's row of pinned Favorites (home-favorites spec): pinning
 * from the Favorites menu, the row and its tiles, a folder's panel, the
 * switch, the keyboard, unpinning, and no row in a private window.
 */

const { FAVORITES_ROOT: TOOLBAR, PINS_ROOT: PINS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs"
);
const { HOME_FAVORITES_PREF } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalHomePage.sys.mjs"
);

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_favorites_menu_helpers.js",
  this
);

/**
 * Favorites of this task's own, empty: the process's Favorites, which the
 * home page's actor and the Favorites menu read (`favoritesFixture`).
 *
 * @returns {Promise<object>} the `SvalFavoritesStore`.
 */
async function taskFavorites() {
  const { store } = await favoritesFixture();
  return store;
}

/**
 * Moves the favorite or folder `guid` into the pins row, at its end, or out
 * of it to the end of Favorites, keeping its guid, so a tile is named by
 * what the task set up for it. "Pin" from the Favorites menu copies, and has
 * a task of its own.
 *
 * @param {object} store
 * @param {string} guid
 * @param {boolean} pinned
 */
async function setPinned(store, guid, pinned) {
  if (pinned) {
    await store.move(guid, PINS, undefined, { undoable: false });
  } else if (store.isPinned(guid)) {
    await store.moveToFavorites(guid);
  }
}

/**
 * One favorite, made as setup, which Undo does not take back.
 *
 * @param {object} store
 * @param {string} url
 * @param {string} title
 * @returns {Promise<string>} its guid.
 */
async function aFavorite(store, url, title) {
  const [guid] = await store.insertTree([{ url, title }]);
  return guid;
}

/**
 * A favorite, a folder holding two favorites and a subfolder, and a second
 * favorite, all in Favorites.
 *
 * @param {object} store This task's Favorites.
 * @returns {Promise<object>} their guids.
 */
async function someFavorites(store) {
  const [docs, work, mail, inner, , news] = await store.insertTree([
    { url: "https://docs.example/", title: "Docs" },
    {
      title: "Work",
      children: [
        { url: "https://mail.example/", title: "Mail" },
        {
          title: "Inner",
          children: [{ url: "https://deep.example/", title: "Deep" }],
        },
      ],
    },
    { url: "https://news.example/", title: "News" },
  ]);
  return { docs, work, mail, inner, news };
}

/**
 * Opens the home page in a new tab and waits for its row to draw.
 *
 * @param {number} expectedTiles How many tiles the row shows.
 * @returns {Promise<object>} the tab.
 */
async function homeTab(expectedTiles) {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "about:home"),
    10_000,
    "the home page opens"
  );
  registerCleanupFunction(() => BrowserTestUtils.removeTab(tab));
  await SpecialPowers.spawn(tab.linkedBrowser, [expectedTiles], async n => {
    await ContentTaskUtils.waitForCondition(
      () =>
        content.document.querySelectorAll(".fav-row .fav-tile").length === n,
      `the row shows ${n} tiles`
    );
  });
  return tab;
}

function tileNames(browser) {
  return SpecialPowers.spawn(browser, [], () =>
    [...content.document.querySelectorAll(".fav-row .fav-name")].map(
      el => el.textContent
    )
  );
}

add_task(async function pinning_from_the_favorites_menu_puts_a_tile_on_home() {
  const store = await taskFavorites();
  const { docs, work } = await someFavorites(store);

  // A favorite and a folder, each pinned from its context menu in the
  // panel's Favorites menu, which puts a copy of each in the row.
  for (const [n, guid] of [docs, work].entries()) {
    const popup = await openFavorites();
    const item = await itemIn(popup, row => row.guid === guid);
    await chooseMenuItem(await contextOn(item), "pinHome");
    await closeMenus();
    await TestUtils.waitForCondition(
      () => store.home().length === n + 1,
      "the pin reaches the document"
    );
  }

  const tab = await homeTab(2);
  Assert.deepEqual(await tileNames(tab.linkedBrowser), ["Docs", "Work"]);
});

/**
 * A tile is the pin it shows (pins spec §9): a click selects the pin's page,
 * as the panel's row does, and the home tab, opened only to get there,
 * closes.
 */
add_task(
  async function a_tile_selects_its_pin_and_an_untouched_home_tab_closes() {
    const store = await taskFavorites();
    const { news } = await someFavorites(store);
    await setPinned(store, news, true);
    const tab = await homeTab(1);
    const closed = BrowserTestUtils.waitForTabClosing(tab);
    await BrowserTestUtils.synthesizeMouseAtCenter(
      ".fav-row .fav-tile",
      {},
      tab.linkedBrowser
    );
    await within(closed, 10_000, "the home tab closes");
    const { isPin, pinGuidOf } = ChromeUtils.importESModule(
      "moz-src:///browser/components/sval/SvalPinTab.sys.mjs"
    );
    const page = gBrowser.selectedTab;
    Assert.ok(isPin(page), "the pin's page shows");
    Assert.equal(pinGuidOf(page), news, "the tile's pin");
    // Tests reach no network, so its page is an error page, at its address.
    await TestUtils.waitForCondition(
      () =>
        page.linkedBrowser.currentURI.spec === "https://news.example/" ||
        page.linkedBrowser.documentURI?.spec.startsWith("about:neterror"),
      "loading its address"
    );
    BrowserTestUtils.removeTab(page);
    await setPinned(store, news, false);
  }
);

add_task(async function a_folder_opens_a_panel_that_moves_into_subfolders() {
  const store = await taskFavorites();
  const { work } = await someFavorites(store);
  await setPinned(store, work, true);
  const tab = await homeTab(1);

  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const doc = content.document;
    const folder = doc.querySelector(".fav-row .fav-tile[data-kind=folder]");
    Assert.equal(
      doc.querySelectorAll(
        ".fav-row .fav-mini img, .fav-row .fav-mini .fav-letter"
      ).length,
      2,
      "the folder's well shows its first favorites, depth first"
    );
    folder.click();
    const panel = doc.getElementById("fav-panel");
    Assert.ok(!panel.hidden, "the panel opened");
    Assert.equal(folder.getAttribute("aria-expanded"), "true");
    Assert.equal(doc.querySelector(".fav-panel-title").textContent, "Work");
    const names = () =>
      [...panel.querySelectorAll(".fav-panel-body .fav-name")].map(
        el => el.textContent
      );
    Assert.deepEqual(names(), ["Mail", "Inner"]);

    panel.querySelector(".fav-tile[data-kind=folder]").click();
    Assert.equal(doc.querySelector(".fav-panel-title").textContent, "Inner");
    Assert.deepEqual(names(), ["Deep"]);
    const back = panel.querySelector(".fav-back");
    Assert.ok(!back.hidden);
    Assert.ok(
      back.getAttribute("aria-label").includes("Work"),
      "Back names the folder it goes back to"
    );
    back.click();
    Assert.equal(doc.querySelector(".fav-panel-title").textContent, "Work");

    folder.focus();
    EventUtils.synthesizeKey("KEY_Escape", {}, content);
    Assert.ok(panel.hidden, "Escape closes the panel");
    Assert.equal(doc.activeElement, folder, "and returns focus to the folder");
  });

  await setPinned(store, work, false);
});

add_task(async function a_folders_panel_opens_in_view_in_a_short_window() {
  const store = await taskFavorites();
  const { work } = await someFavorites(store);
  await setPinned(store, work, true);
  const tab = await homeTab(1);
  const browser = tab.linkedBrowser;

  // A window just tall enough to show the row: the panel opens below it.
  const width = window.outerWidth;
  const height = window.outerHeight;
  atTaskEnd(async () => {
    window.resizeTo(width, height);
    await TestUtils.waitForCondition(
      () => window.outerHeight === height,
      "the window is its own height again"
    );
  });
  // The page centres its content in a tall view, so the row moves as the
  // window shrinks: measure again until the view ends just below it.
  const measure = () =>
    SpecialPowers.spawn(browser, [], () => ({
      view: content.document.documentElement.clientHeight,
      gap:
        content.document.documentElement.clientHeight -
        content.document.querySelector(".fav-row").getBoundingClientRect()
          .bottom,
    }));
  for (let tries = 0; tries < 4; tries++) {
    const { view, gap } = await measure();
    if (gap >= 0 && gap <= 32) {
      break;
    }
    const target = window.outerHeight - Math.round(gap - 16);
    window.resizeTo(width, target);
    await TestUtils.waitForCondition(
      () => window.outerHeight === target,
      "the window is shorter"
    );
    await SpecialPowers.spawn(browser, [view], was =>
      ContentTaskUtils.waitForCondition(
        () => content.document.documentElement.clientHeight !== was,
        "the page has its new size"
      )
    );
  }
  const { gap } = await measure();
  Assert.ok(gap >= 0 && gap <= 32, "the view ends just below the row");

  await BrowserTestUtils.synthesizeMouseAtCenter(
    ".fav-row .fav-tile[data-kind=folder]",
    {},
    browser
  );
  await SpecialPowers.spawn(browser, [], async () => {
    const panel = content.document.getElementById("fav-panel");
    await ContentTaskUtils.waitForCondition(
      () => !panel.hidden,
      "the panel opened"
    );
    // Rounded: the page lays out in fractions of a pixel, and the view's
    // height is whole.
    const box = panel.getBoundingClientRect();
    Assert.ok(
      Math.round(box.top) >= 0 &&
        Math.round(box.bottom) <= content.document.documentElement.clientHeight,
      "and it is in view"
    );
  });
  await setPinned(store, work, false);
});

add_task(async function a_folder_never_files_into_a_folder_inside_it() {
  const store = await taskFavorites();
  const { docs, work, inner } = await someFavorites(store);
  await setPinned(store, docs, true);
  await setPinned(store, work, true);
  const tab = await homeTab(2);

  const file = (guid, folderGuid) =>
    SpecialPowers.spawn(tab.linkedBrowser, [guid, folderGuid], (g, f) => {
      content.dispatchEvent(
        new content.CustomEvent("SvalHomeFavorites", {
          detail: Cu.cloneInto(
            { type: "File", data: { guid: g, folderGuid: f } },
            content
          ),
        })
      );
    });
  await file(work, inner);
  // The store writes in order, so once this one has filed Docs the
  // refused one has finished.
  await file(docs, work);
  await TestUtils.waitForCondition(
    () => store.get(docs)?.parentGuid === work,
    "Docs is filed into Work"
  );
  Assert.equal(store.get(work).parentGuid, PINS, "Work stays where it was");
  Assert.equal(store.get(inner).parentGuid, work, "and so does Inner");
  await TestUtils.waitForCondition(
    async () =>
      JSON.stringify(await tileNames(tab.linkedBrowser)) ===
      JSON.stringify(["Work"]),
    "Work stays on the row"
  );
  await setPinned(store, work, false);
});

add_task(async function the_switch_hides_the_row_and_keeps_the_pins() {
  const store = await taskFavorites();
  const { docs } = await someFavorites(store);
  await setPinned(store, docs, true);
  const tab = await homeTab(1);

  await BrowserTestUtils.synthesizeMouseAtCenter(
    ".fav-switch-track",
    {},
    tab.linkedBrowser
  );
  await TestUtils.waitForCondition(
    () => !Services.prefs.getBoolPref(HOME_FAVORITES_PREF, true),
    "the switch turned the setting off"
  );
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    await ContentTaskUtils.waitForCondition(
      () => content.document.querySelector(".favorites").hidden,
      "the row is hidden"
    );
    Assert.equal(
      content.document
        .querySelector(".fav-switch-track")
        .getAttribute("aria-checked"),
      "false"
    );
  });
  Assert.ok(store.isPinned(docs), "the pin is kept");

  Services.prefs.setBoolPref(HOME_FAVORITES_PREF, true);
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    await ContentTaskUtils.waitForCondition(
      () =>
        content.document.querySelectorAll(".fav-row .fav-tile").length === 1,
      "the row is back"
    );
  });
  await setPinned(store, docs, false);
});

add_task(async function the_keyboard_moves_a_tile_and_a_tile_can_be_unpinned() {
  const store = await taskFavorites();
  const { docs, news } = await someFavorites(store);
  await setPinned(store, docs, true);
  await setPinned(store, news, true);
  const tab = await homeTab(2);
  Assert.deepEqual(await tileNames(tab.linkedBrowser), ["Docs", "News"]);

  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const service = Cc["@mozilla.org/accessibilityService;1"].getService(
      Ci.nsIAccessibilityService
    );
    const [first, second] =
      content.document.querySelectorAll(".fav-row .fav-tile");
    let acc;
    await ContentTaskUtils.waitForCondition(
      () => (acc = service.getAccessibleFor(first)),
      "the tile is in the accessibility tree"
    );
    // Neither favorite has a cached icon, so each well shows a letter.
    Assert.equal(acc.role, Ci.nsIAccessibleRole.ROLE_LINK, "a tile is a link");
    Assert.equal(acc.name, "Docs", "named by its label alone");

    first.focus();
    EventUtils.synthesizeKey("KEY_ArrowRight", {}, content);
    Assert.equal(content.document.activeElement, second, "arrows rove");
    EventUtils.synthesizeKey("KEY_ArrowLeft", {}, content);
    Assert.equal(content.document.activeElement, first);
    EventUtils.synthesizeKey(
      "KEY_ArrowRight",
      { ctrlKey: true, shiftKey: true },
      content
    );
    Assert.deepEqual(
      content.document.querySelector(".fav-status").textContent.match(/\d+/g),
      ["2", "2"],
      "the status says the position and how many there are"
    );
  });
  await TestUtils.waitForCondition(
    async () =>
      JSON.stringify(await tileNames(tab.linkedBrowser)) ===
      JSON.stringify(["News", "Docs"]),
    "the row is in its new order"
  );

  await setPinned(store, news, false);
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    await ContentTaskUtils.waitForCondition(
      () =>
        content.document.querySelectorAll(".fav-row .fav-tile").length === 1,
      "the unpinned tile left the row"
    );
  });
  await setPinned(store, docs, false);
});

add_task(
  async function with_nothing_pinned_the_row_says_where_pins_come_from() {
    const store = await taskFavorites();
    await someFavorites(store);
    const tab = await homeTab(0);
    await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
      const empty = content.document.querySelector(".fav-empty");
      await ContentTaskUtils.waitForCondition(
        () => !empty.hidden,
        "the empty line shows"
      );
    });
  }
);

add_task(async function a_private_window_shows_no_row() {
  const store = await taskFavorites();
  const { docs } = await someFavorites(store);
  await setPinned(store, docs, true);
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20_000,
    "a private window opens"
  );
  const browser = win.gBrowser.selectedBrowser;
  await pageReady(browser, "about:privatebrowsing");
  await SpecialPowers.spawn(browser, [], async () => {
    await ContentTaskUtils.waitForCondition(
      () => content.document.readyState === "complete",
      "the page has loaded"
    );
    Assert.equal(
      content.document.querySelector(".favorites"),
      null,
      "the private page has no row"
    );
  });
  await within(BrowserTestUtils.closeWindow(win), 10_000, "it closes");
  await setPinned(store, docs, false);
});

/**
 * Right-clicks `selector` in `browser` and waits for the Favorites context
 * menu, which a tile shows in place of the page's.
 *
 * @param {object} browser
 * @param {string} selector
 * @returns {Promise<Element>} the menu, shown.
 */
async function tileMenuOn(browser, selector) {
  const menu = contextMenu();
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  // As a user scrolls to a tile before right-clicking it: in a short window
  // the row is below the bottom of the page's view, where a click lands on
  // no element.
  await SpecialPowers.spawn(browser, [selector], sel =>
    content.document.querySelector(sel).scrollIntoView({ block: "nearest" })
  );
  // A right click as Windows sends it: the press and release, which give the
  // page its user activation, then the menu.
  for (const type of ["mousedown", "mouseup", "contextmenu"]) {
    await BrowserTestUtils.synthesizeMouseAtCenter(
      selector,
      { type, button: 2 },
      browser
    );
  }
  await within(shown, 10_000, "the Favorites context menu opens");
  Assert.equal(
    document.getElementById("contentAreaContextMenu").state,
    "closed",
    "and the page's own menu does not"
  );
  return menu;
}

add_task(async function a_tile_menu_is_the_favorites_menu() {
  const store = await taskFavorites();
  const { docs, work } = await someFavorites(store);
  await setPinned(store, docs, true);
  await setPinned(store, work, true);
  const tab = await homeTab(2);
  const browser = tab.linkedBrowser;

  let menu = await tileMenuOn(
    browser,
    ".fav-row .fav-tile[data-kind=favorite]"
  );
  Assert.deepEqual(
    shownWithoutUndo(menu),
    [
      "open",
      "openWindow",
      "openPrivate",
      "-",
      "pinHome",
      "showIn",
      "-",
      "rename",
      "editAddress",
      "delete",
      "-",
      "moveLeft",
      "moveRight",
      "-",
      "newFolder",
      "-",
      "export",
    ],
    "a pin's menu is a favorite's, moving along the row"
  );
  Assert.equal(
    menu.querySelector('[data-command="pinHome"]').dataset.pinned,
    "true",
    "the item moves a pin to Favorites"
  );
  await chooseMenuItem(menu, "rename");
  await confirm(await typeInto("Handbook"));
  await TestUtils.waitForCondition(
    async () =>
      JSON.stringify(await tileNames(browser)) ===
      JSON.stringify(["Handbook", "Work"]),
    "Rename… renames the tile"
  );

  // A favorite inside a pinned folder's panel is managed the same way, and
  // moves within its folder.
  await SpecialPowers.spawn(browser, [], () => {
    content.document
      .querySelector(".fav-row .fav-tile[data-kind=folder]")
      .click();
  });
  menu = await tileMenuOn(
    browser,
    ".fav-panel-body .fav-tile[data-kind=favorite]"
  );
  const shown = shownWithoutUndo(menu);
  Assert.ok(
    shown.includes("moveDown") && !shown.includes("moveLeft"),
    "a folder's pin moves within the folder"
  );
  Assert.ok(
    !shown.includes("pinHome"),
    "and goes to Favorites with its folder, as its own menu says"
  );
  await closeMenus();

  menu = await tileMenuOn(browser, ".fav-row .fav-tile[data-kind=favorite]");
  await chooseMenuItem(menu, "pinHome");
  await TestUtils.waitForCondition(
    () => !store.isPinned(docs),
    "Move to Favorites moves the tile it was opened on"
  );
  Assert.ok(store.isPinned(work), "and nothing else");
  await setPinned(store, work, false);
});

add_task(async function off_a_tile_the_page_keeps_its_own_menu() {
  const store = await taskFavorites();
  const { docs } = await someFavorites(store);
  await setPinned(store, docs, true);
  const tab = await homeTab(1);
  const pageMenu = document.getElementById("contentAreaContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(pageMenu, "shown");
  await BrowserTestUtils.synthesizeMouseAtCenter(
    ".brand",
    { type: "contextmenu", button: 2 },
    tab.linkedBrowser
  );
  await within(shown, 10_000, "the page's menu opens");
  Assert.equal(contextMenu().state, "closed", "not the Favorites menu");
  const hidden = BrowserTestUtils.waitForPopupEvent(pageMenu, "hidden");
  pageMenu.hidePopup();
  await within(hidden, 10_000, "the page's menu closes");
  await setPinned(store, docs, false);
});

add_task(async function the_tile_menu_moves_a_tile_without_a_drag() {
  const store = await taskFavorites();
  const { docs, work, news } = await someFavorites(store);
  await setPinned(store, docs, true);
  await setPinned(store, work, true);
  await setPinned(store, news, true);
  const tab = await homeTab(3);
  const browser = tab.linkedBrowser;
  Assert.deepEqual(await tileNames(browser), ["Docs", "Work", "News"]);
  const item = (menu, command) =>
    menu.querySelector(`[data-command="${command}"]`);

  let menu = await tileMenuOn(browser, ".fav-row li:first-child .fav-tile");
  Assert.ok(item(menu, "moveLeft").disabled, "the first tile cannot move left");
  Assert.ok(!item(menu, "moveRight").disabled);
  await chooseMenuItem(menu, "moveRight");
  await TestUtils.waitForCondition(
    async () =>
      JSON.stringify(await tileNames(browser)) ===
      JSON.stringify(["Work", "Docs", "News"]),
    "Move Right moved the tile one place"
  );
  Assert.deepEqual(
    await SpecialPowers.spawn(browser, [], () =>
      content.document.querySelector(".fav-status").textContent.match(/\d+/g)
    ),
    ["2", "3"],
    "and said where it went"
  );

  // A folder's tile is a button, and moves the same way.
  menu = await tileMenuOn(browser, ".fav-row .fav-tile[data-kind=folder]");
  Assert.ok(item(menu, "moveLeft").disabled, "the folder is first");
  await chooseMenuItem(menu, "moveRight");
  await TestUtils.waitForCondition(
    async () =>
      JSON.stringify(await tileNames(browser)) ===
      JSON.stringify(["Docs", "Work", "News"]),
    "the folder moved right"
  );

  menu = await tileMenuOn(browser, ".fav-row li:last-child .fav-tile");
  Assert.ok(
    item(menu, "moveRight").disabled,
    "the last tile cannot move right"
  );
  await chooseMenuItem(menu, "moveLeft");
  await TestUtils.waitForCondition(
    async () =>
      JSON.stringify(await tileNames(browser)) ===
      JSON.stringify(["Docs", "News", "Work"]),
    "Move Left moved the tile one place"
  );

  for (const guid of [docs, work, news]) {
    await setPinned(store, guid, false);
  }
});

add_task(async function a_favorite_without_a_title_is_named_by_its_host() {
  const store = await taskFavorites();
  await someFavorites(store);
  const untitled = {
    guid: await aFavorite(store, "https://www.untitled.example/page", ""),
  };
  await setPinned(store, untitled.guid, true);
  const tab = await homeTab(1);
  Assert.deepEqual(await tileNames(tab.linkedBrowser), ["untitled.example"]);
  await setPinned(store, untitled.guid, false);
});

add_task(async function focus_in_a_folder_panel_survives_a_row_update() {
  const store = await taskFavorites();
  const { work, news } = await someFavorites(store);
  await setPinned(store, work, true);
  const tab = await homeTab(1);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const doc = content.document;
    doc.querySelector(".fav-row .fav-tile[data-kind=folder]").click();
    doc.querySelector(".fav-panel-body .fav-tile[data-kind=favorite]").focus();
  });

  // Another window, or a pass, changes the row while the panel has focus.
  await setPinned(store, news, true);
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const doc = content.document;
    await ContentTaskUtils.waitForCondition(
      () => doc.querySelectorAll(".fav-row .fav-tile").length === 2,
      "the row redrew"
    );
    const focused = doc.activeElement;
    Assert.ok(
      doc.querySelector(".fav-panel-body").contains(focused),
      "focus is still in the panel"
    );
    Assert.equal(
      focused.querySelector(".fav-name").textContent,
      "Mail",
      "on the same favorite"
    );
  });
  await setPinned(store, work, false);
  await setPinned(store, news, false);
});

/**
 * The colours from the page's field, in the order its gradient lays them out
 * from the centre to the edge.
 *
 * @param {object} browser
 */
function fieldStops(browser) {
  return SpecialPowers.spawn(browser, [], () =>
    content
      .getComputedStyle(content.document.documentElement)
      .backgroundImage.match(/rgba?\([^)]*\)/g)
  );
}

/**
 * The colours a field of `stops` shows: each opaque stop, and each
 * see-through stop, a Workspace's wash, over each opaque one, the sky it
 * lies on.
 *
 * @param {string[]} stops
 * @returns {object[]}
 */
function fieldColours(stops) {
  const all = stops.map(rgbaOf);
  const opaque = all.filter(c => c.a === 1);
  const washes = all.filter(c => c.a > 0 && c.a < 1);
  return [
    ...opaque,
    ...washes.flatMap(wash => opaque.map(sky => paintedOver(wash, sky))),
  ];
}

add_task(async function the_row_and_its_switch_read_on_either_field() {
  const store = await taskFavorites();
  await someFavorites(store);
  // The window's own look is the page's field: Sval's own on a solid
  // window, and a wash of the window's colour on a see-through one, which
  // takes its colour from the window's theme.
  for (const see of [false, true]) {
    for (const windowDark of [0, 1]) {
      await windowSeeThrough(see);
      await SpecialPowers.pushPrefEnv({
        set: [["ui.systemUsesDarkTheme", windowDark]],
      });
      await TestUtils.waitForCondition(
        () =>
          matchMedia("(prefers-color-scheme: dark)").matches === !!windowDark,
        "the theme changes"
      );
      const where = `${see ? "see-through" : "solid"} ${windowDark ? "dark" : "light"} window`;
      await readOnEitherField(await homeTab(0), where);
      await SpecialPowers.popPrefEnv();
    }
  }
});

/**
 * Checks the row's empty line, the switch and its focus ring on `tab`'s
 * home page, in the page's dark and light schemes.
 *
 * @param {Tab} tab
 * @param {string} where Which window it is, for the messages.
 */
async function readOnEitherField(tab, where) {
  const browser = tab.linkedBrowser;
  const context = browser.browsingContext;
  try {
    for (const scheme of ["dark", "light"]) {
      context.prefersColorSchemeOverride = scheme;
      const seen = await SpecialPowers.spawn(browser, [scheme], async name => {
        await ContentTaskUtils.waitForCondition(
          () => content.matchMedia(`(prefers-color-scheme: ${name})`).matches,
          `the page is ${name}`
        );
        const doc = content.document;
        const empty = doc.querySelector(".fav-empty");
        await ContentTaskUtils.waitForCondition(
          () => !empty.hidden,
          "the empty line shows"
        );
        const track = doc.querySelector(".fav-switch-track");
        track.focus({ focusVisible: true });
        const style = content.getComputedStyle(track);
        // The track eases between colours; read the colour it settles on.
        await ContentTaskUtils.waitForCondition(
          () =>
            style.backgroundColor &&
            !track.getAnimations({ subtree: true }).length,
          "the switch has settled"
        );
        return {
          hint: content.getComputedStyle(empty).color,
          ring: style.outlineColor,
          on: style.backgroundColor,
          checked: track.getAttribute("aria-checked"),
        };
      });
      const stops = await fieldStops(browser);
      Assert.greaterOrEqual(
        stops?.length ?? 0,
        2,
        `${scheme}: the field is a gradient`
      );
      Assert.equal(seen.checked, "true", "the switch is on");
      for (const shown of fieldColours(stops)) {
        const at = `${where}, ${scheme} page: on ${JSON.stringify(shown)}`;
        Assert.greaterOrEqual(
          contrastRatio(seen.hint, shown),
          4.5,
          `${at}, the empty line reads`
        );
        Assert.greaterOrEqual(
          contrastRatio(seen.ring, shown),
          3,
          `${at}, the focus ring shows`
        );
      }
      // The switch sits in the page's corner, on the field's edge.
      Assert.greaterOrEqual(
        contrastRatio(seen.on, stops.at(-1)),
        3,
        `${where}, ${scheme} page: the switch's on state shows on the field's edge`
      );
    }
  } finally {
    context.prefersColorSchemeOverride = "none";
  }
}

add_task(async function the_switch_shows_its_state_in_forced_colours() {
  const store = await taskFavorites();
  await someFavorites(store);
  const tab = await homeTab(0);
  const browser = tab.linkedBrowser;
  const context = browser.browsingContext;
  const read = () =>
    SpecialPowers.spawn(browser, [], async () => {
      await ContentTaskUtils.waitForCondition(
        () => content.matchMedia("(forced-colors: active)").matches,
        "forced colours apply"
      );
      return content.document
        .querySelector(".fav-switch-track")
        .getAttribute("aria-checked");
    });
  try {
    context.forcedColorsOverride = "active";
    Assert.equal(await read(), "true");
    await BrowserTestUtils.synthesizeMouseAtCenter(
      ".fav-switch-track",
      {},
      browser
    );
    await TestUtils.waitForCondition(
      () => !Services.prefs.getBoolPref(HOME_FAVORITES_PREF, true),
      "the switch turned the row off"
    );
    await TestUtils.waitForCondition(
      async () => (await read()) === "false",
      "the switch shows off"
    );
  } finally {
    context.forcedColorsOverride = "none";
    Services.prefs.setBoolPref(HOME_FAVORITES_PREF, true);
  }
});

add_task(async function a_pinned_bookmarklet_never_shows() {
  const store = await taskFavorites();
  const { docs } = await someFavorites(store);
  const other = await aFavorite(store, "javascript:void(1)", "Other");
  Assert.equal(await store.pin(other), null, "a bookmarklet is never pinned");
  // Pinned as another device could have pinned it.
  const entry = { url: "javascript:void(0)", title: "Script" };
  const [script] = await store.insertTree([], { pins: [entry] });
  Assert.ok(store.isPinned(script), "the other device's pin is in the row");
  await setPinned(store, docs, true);
  const tab = await homeTab(1);
  Assert.deepEqual(await tileNames(tab.linkedBrowser), ["Docs"]);
  await setPinned(store, script, false);
  await setPinned(store, docs, false);
});

/**
 * What a request from the page names, as the page would send it, for any
 * guid: the page is content, so its actor trusts only what its row shows.
 *
 * @param {Element} browser The home page's browser.
 * @param {string} type
 * @param {object} data
 * @param {object} [options]
 * @param {boolean} [options.activated] Whether the page holds user
 *   activation, as it does after a click or key of the user's.
 */
function forge(browser, type, data, { activated = true } = {}) {
  return SpecialPowers.spawn(browser, [type, data, activated], (t, d, a) => {
    if (a) {
      content.document.notifyUserGestureActivation();
    } else {
      content.document.clearUserGestureActivation();
    }
    content.dispatchEvent(
      new content.CustomEvent("SvalHomeFavorites", {
        detail: Cu.cloneInto({ type: t, data: d }, content),
      })
    );
  });
}

/**
 * The document as each favorite's place, name and address, a place in the
 * pins root being a pin's.
 *
 * @param {object} store
 * @returns {object}
 */
function snapshot(store) {
  return Object.fromEntries(
    store
      .all()
      .map(row => [
        row.guid,
        [row.parentGuid, row.index, row.name, row.url].join("|"),
      ])
  );
}

add_task(
  async function a_request_for_what_the_page_does_not_show_does_nothing() {
    const store = await taskFavorites();
    const { docs, work, mail, news } = await someFavorites(store);
    const [hidden] = await store.insertTree([
      {
        title: "Hidden",
        children: [{ url: "https://h.example/", title: "H" }],
      },
    ]);
    await setPinned(store, docs, true);
    await setPinned(store, work, true);
    const tab = await homeTab(2);
    const browser = tab.linkedBrowser;
    const before = snapshot(store);
    const tabs = gBrowser.tabs.length;

    await forge(browser, "Open", { guid: news, modifiers: { button: 1 } });
    await forge(browser, "Open", { guid: hidden, modifiers: {} });
    await forge(browser, "OpenAll", { guid: hidden });
    await forge(browser, "Move", { guid: news, afterGuid: docs });
    await forge(browser, "Move", { guid: docs, afterGuid: news });
    await forge(browser, "File", { guid: news, folderGuid: work });
    await forge(browser, "File", { guid: docs, folderGuid: mail });
    await forge(browser, "File", { guid: docs, folderGuid: TOOLBAR });
    await forge(browser, "File", { guid: TOOLBAR, folderGuid: work });
    await forge(browser, "File", { guid: docs, folderGuid: hidden });
    await forge(browser, "Context", { guid: news, screenX: 10, screenY: 10 });
    // Requests arrive in order, so once this one has acted every one before
    // it has been heard.
    atTaskEnd(() => Services.prefs.clearUserPref(HOME_FAVORITES_PREF));
    await forge(browser, "Enabled", { on: false });
    await TestUtils.waitForCondition(
      () => !Services.prefs.getBoolPref(HOME_FAVORITES_PREF, true),
      "the page's own switch acts"
    );
    await within(store.whenIdle(), 10_000, "store going idle");

    Assert.deepEqual(
      snapshot(store),
      before,
      "no forged request changed the document"
    );
    Assert.equal(gBrowser.tabs.length, tabs, "and none opened a tab");
    Assert.equal(
      document.getElementById("sval-favorites-context-menu")?.state ?? "closed",
      "closed",
      "nor a menu"
    );
    await setPinned(store, work, false);
  }
);

/**
 * A request that opens a page, opens a menu or turns the row off goes on
 * only while the page holds the user's activation, so a page script acting
 * by itself reaches nothing. A name the page never sends reaches nothing.
 */
add_task(async function a_request_without_the_users_activation_does_nothing() {
  const store = await taskFavorites();
  const { docs, work } = await someFavorites(store);
  await setPinned(store, docs, true);
  await setPinned(store, work, true);
  const tab = await homeTab(2);
  const browser = tab.linkedBrowser;
  const { SvalHomeFavoritesParent } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalHomeFavoritesParent.sys.mjs"
  );
  const { prototype } = SvalHomeFavoritesParent;
  const receiveMessage = prototype.receiveMessage;
  // What reaches the parent, heard and not acted on.
  const heard = [];
  prototype.receiveMessage = ({ name }) => heard.push(name);
  atTaskEnd(() => {
    prototype.receiveMessage = receiveMessage;
  });
  const idle = { activated: false };

  await forge(browser, "Open", { guid: docs, modifiers: {} }, idle);
  await forge(browser, "OpenAll", { guid: work }, idle);
  await forge(
    browser,
    "Context",
    { guid: docs, screenX: 10, screenY: 10 },
    idle
  );
  await forge(browser, "Enabled", { on: false }, idle);
  await forge(browser, "Unpin", { guid: docs });
  await forge(browser, "Move", { guid: docs, afterGuid: work }, idle);
  // Requests arrive in order, so once this one is heard every one before it
  // has been.
  await forge(browser, "Open", { guid: docs, modifiers: {} });
  await TestUtils.waitForCondition(
    () => heard.includes("Open"),
    "an Open with the user's activation reaches the parent"
  );
  Assert.deepEqual(
    heard,
    ["Move", "Open"],
    "only the drop's Move and the activated Open reached the parent"
  );
  prototype.receiveMessage = receiveMessage;
  await setPinned(store, docs, false);
  await setPinned(store, work, false);
});
