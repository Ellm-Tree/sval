/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_pins_helpers.js */
/* import-globals-from sval_launcher_home_helpers.js */

/**
 * Home's field takes the address bar's keys and lists the rows the address
 * bar draws from other providers (launcher spec §3, §5): the same text gives
 * the same rows and the same keys do the same there. Each task does a thing
 * in the address bar, then the same in the field, and compares.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_pins_helpers.js",
  this
);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_launcher_home_helpers.js",
  this
);

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);
const { PlacesTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PlacesTestUtils.sys.mjs"
);

add_setup(failOnConsoleErrors);
add_setup(pinsSetup);
add_setup(async function () {
  await PlacesUtils.history.clear();
  registerCleanupFunction(async () => {
    await UrlbarTestUtils.promisePopupClose(window);
    gURLBar.handleRevert();
    await PlacesUtils.history.clear();
  });
});

/**
 * Pages in history whose titles start with "Moth", visited once each.
 *
 * @param {number} count
 * @returns {Promise<string[]>} their addresses.
 */
async function mothPages(count) {
  const urls = Array.from(
    { length: count },
    (_, i) => `https://example.net/sval-moth-${i}`
  );
  await PlacesTestUtils.addVisits(
    urls.map((uri, i) => ({ uri, title: `Moth page ${i}` }))
  );
  atTaskEnd(() => PlacesUtils.history.clear());
  return urls;
}

/**
 * Types `text` in the address bar and waits for its rows.
 *
 * @param {string} text
 */
async function typeInUrlbar(text) {
  await within(
    UrlbarTestUtils.promiseAutocompleteResultPopup({ window, value: text }),
    10_000,
    "the address bar's results"
  );
}

/**
 * The index of the selected row among the page's rows, -1 for none.
 *
 * @param {object} browser
 * @returns {Promise<number>}
 */
function homeSelected(browser) {
  return SpecialPowers.spawn(browser, [], () =>
    [...content.document.querySelectorAll(".suggestions .result")].findIndex(
      li => li.getAttribute("aria-selected") == "true"
    )
  );
}

/**
 * Selects the page's row whose title contains `text`, with the arrow keys.
 *
 * @param {object} browser
 * @param {string} text
 */
async function arrowToTitle(browser, text) {
  await TestUtils.waitForCondition(
    async () => !(await homeList(browser)).hidden,
    "the field lists rows"
  );
  for (let left = 30; left; left--) {
    const on = await SpecialPowers.spawn(
      browser,
      [],
      () =>
        content.document.querySelector(
          ".suggestions [aria-selected='true'] .title"
        )?.textContent ?? ""
    );
    if (on.includes(text)) {
      return;
    }
    await BrowserTestUtils.synthesizeKey("KEY_ArrowDown", {}, browser);
  }
  info(JSON.stringify(await homeList(browser)));
  Assert.ok(false, `the arrow keys reach "${text}"`);
}

/**
 * Selects the address bar's row whose title contains `text`.
 *
 * @param {string} text
 */
async function urlbarArrowToTitle(text) {
  for (let left = 30; left; left--) {
    const row = UrlbarTestUtils.getSelectedRow(window);
    const title =
      row?.result?.type == UrlbarUtils.RESULT_TYPE.DYNAMIC
        ? dynamicTexts(row).title
        : row?.querySelector(".urlbarView-title")?.textContent;
    if (title?.includes(text)) {
      return;
    }
    EventUtils.synthesizeKey("KEY_ArrowDown");
  }
  Assert.ok(false, `the arrow keys reach "${text}" in the address bar`);
}

/**
 * The calculator's row, which another provider draws from its own template,
 * lists alike, and Enter on it copies its answer in both.
 */
add_task(async function a_providers_own_row_lists_and_acts_alike() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.urlbar.suggest.calculator", true]],
  });
  const { tab } = await homeTab();
  const browser = tab.linkedBrowser;

  await typeInUrlbar("7*6");
  const urlbar = await urlbarItems();
  info(urlbar.join("\n"));
  const calculator = urlbar.find(item => item.includes(" | dynamic | "));
  Assert.ok(calculator, "the address bar lists the calculator's row");
  Assert.ok(calculator.includes("42"), "with its answer");
  await urlbarArrowToTitle("42");
  await SimpleTest.promiseClipboardChange("42", () =>
    EventUtils.synthesizeKey("KEY_Enter")
  );
  gURLBar.handleRevert();

  await typeInHomeField(browser, "7*6");
  await untilHomeLists(browser, urlbar);
  await arrowToTitle(browser, "42");
  await SimpleTest.promiseClipboardChange("42", () =>
    BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser)
  );
  await TestUtils.waitForCondition(
    async () => (await homeList(browser)).hidden,
    "the field's list closes, as the address bar's view does"
  );
});

/**
 * "@" lists the search modes alike; picking one enters it, with the address
 * bar's placeholder and a chip, the rows are that mode's, and Backspace at
 * the field's start leaves it. "@history " typed enters it too.
 */
add_task(async function search_modes_list_and_enter_alike() {
  await mothPages(2);
  const { tab } = await homeTab();
  const browser = tab.linkedBrowser;

  await typeInUrlbar("@");
  const offers = await urlbarItems();
  info(offers.join("\n"));
  Assert.ok(
    offers.some(item => item.includes(" | searchmode | ")),
    "the address bar offers its search modes"
  );
  await urlbarArrowToTitle("history");
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(
    () => gURLBar.searchMode?.source == UrlbarUtils.RESULT_SOURCE.HISTORY,
    "the address bar is in history's search mode"
  );
  await translated(gURLBar.inputField);
  const placeholder = gURLBar.inputField.placeholder;
  await typeInUrlbar("moth");
  const inMode = await closeUrlbarWithItems();
  info(inMode.join("\n"));
  gURLBar.searchMode = null;

  await typeInHomeField(browser, "@");
  await untilHomeLists(browser, offers);
  await arrowToTitle(browser, "history");
  await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
  await TestUtils.waitForCondition(
    async () => (await homeList(browser)).chip !== null,
    "the field shows history's chip"
  );
  let home = await homeList(browser);
  Assert.equal(home.placeholder, placeholder, "with the address bar's words");
  Assert.equal(home.value, "", "and nothing typed");

  await typeInHomeField(browser, "moth");
  await untilHomeLists(browser, inMode);

  await typeInHomeField(browser, "");
  await BrowserTestUtils.synthesizeKey("KEY_Backspace", {}, browser);
  await TestUtils.waitForCondition(
    async () => (await homeList(browser)).chip === null,
    "Backspace at the field's start leaves the mode"
  );

  await typeInHomeField(browser, "@history ");
  await TestUtils.waitForCondition(async () => {
    home = await homeList(browser);
    return home.chip !== null && home.value === "";
  }, "the mode's keyword and a space enter it");
  Assert.equal(home.placeholder, placeholder, "the same mode");
  await BrowserTestUtils.synthesizeKey("KEY_Escape", {}, browser);
  await BrowserTestUtils.synthesizeKey("KEY_Escape", {}, browser);
  await TestUtils.waitForCondition(
    async () => (await homeList(browser)).chip === null,
    "Escape with the list closed leaves the mode"
  );
});

/**
 * Shift+Delete removes a history row from the list and from history, in the
 * address bar and in the field, and the selection stays where it was.
 */
add_task(async function shift_delete_removes_a_history_row_alike() {
  const [first, second] = await mothPages(3);
  const { tab } = await homeTab();
  const browser = tab.linkedBrowser;

  await typeInUrlbar("moth page");
  await urlbarArrowToTitle("Moth page 0");
  const at = UrlbarTestUtils.getSelectedRowIndex(window);
  const removed = PlacesTestUtils.waitForNotification("page-removed");
  EventUtils.synthesizeKey("KEY_Delete", { shiftKey: true });
  await within(removed, 10_000, "the address bar removes the page");
  Assert.ok(
    !(await PlacesUtils.history.hasVisits(first)),
    "it is gone from history"
  );
  await TestUtils.waitForCondition(
    async () => !(await urlbarItems()).some(i => i.includes("Moth page 0")),
    "and from the address bar's list"
  );
  const count = UrlbarTestUtils.getResultCount(window);
  Assert.equal(
    UrlbarTestUtils.getSelectedRowIndex(window),
    Math.min(at, count - 1),
    "the selection stays at its place"
  );
  await closeUrlbarWithItems();

  await typeInHomeField(browser, "moth page");
  await TestUtils.waitForCondition(
    async () =>
      (await homeList(browser)).items.some(i => i.includes("Moth page 1")),
    "the field lists the page"
  );
  await arrowToTitle(browser, "Moth page 1");
  const homeAt = await homeSelected(browser);
  const gone = PlacesTestUtils.waitForNotification("page-removed");
  await BrowserTestUtils.synthesizeKey(
    "KEY_Delete",
    { shiftKey: true },
    browser
  );
  await within(gone, 10_000, "the field removes the page");
  Assert.ok(
    !(await PlacesUtils.history.hasVisits(second)),
    "it is gone from history"
  );
  await TestUtils.waitForCondition(
    async () =>
      !(await homeList(browser)).items.some(i => i.includes("Moth page 1")),
    "and from the field's list"
  );
  const homeCount = (await homeList(browser)).items.filter(
    i => !i.startsWith("## ")
  ).length;
  Assert.equal(
    await homeSelected(browser),
    Math.min(homeAt, homeCount - 1),
    "the selection stays at its place"
  );
});

/**
 * Tab, Shift+Tab, Page Up and Down and the arrows move through the rows the
 * same way in the address bar and in the field, round the list's ends
 * included; with the list closed, the Down arrow opens it in both. Tab past
 * either end is left out: the address bar moves on to its search-mode
 * button there (`UrlbarController.handleKeyNavigation`), a control of the
 * toolbar's field that Home's field does not have.
 */
add_task(async function the_keys_move_through_the_rows_alike() {
  await mothPages(9);
  const { tab } = await homeTab();
  const browser = tab.linkedBrowser;
  const keys = [
    ["KEY_Tab", {}],
    ["KEY_Tab", {}],
    ["KEY_PageDown", {}],
    ["KEY_PageDown", {}],
    ["KEY_PageDown", {}],
    ["KEY_ArrowDown", {}],
    ["KEY_ArrowDown", {}],
    ["KEY_Tab", { shiftKey: true }],
    ["KEY_PageUp", {}],
    ["KEY_ArrowUp", {}],
    ["KEY_ArrowUp", {}],
  ];

  await typeInUrlbar("moth page");
  const urlbarRows = await urlbarItems();
  const urlbar = [];
  for (const [key, mods] of keys) {
    EventUtils.synthesizeKey(key, mods);
    urlbar.push(UrlbarTestUtils.getSelectedRowIndex(window));
  }
  info(`address bar: ${urlbar}`);
  await closeUrlbarWithItems();

  await typeInHomeField(browser, "moth page");
  await untilHomeLists(browser, urlbarRows);
  const home = [];
  for (const [key, mods] of keys) {
    await BrowserTestUtils.synthesizeKey(key, mods, browser);
    home.push(await homeSelected(browser));
  }
  Assert.deepEqual(home, urlbar, "each key selects the same row");

  await BrowserTestUtils.synthesizeKey("KEY_Escape", {}, browser);
  Assert.ok((await homeList(browser)).hidden, "Escape closes the list");
  await SpecialPowers.spawn(browser, [], () => {
    const input = content.document.querySelector(".search input");
    input.setSelectionRange(input.value.length, input.value.length);
  });
  await BrowserTestUtils.synthesizeKey("KEY_ArrowDown", {}, browser);
  await TestUtils.waitForCondition(
    async () => !(await homeList(browser)).hidden,
    "the Down arrow opens it again, as it opens the address bar's view"
  );
});

/**
 * Typing the start of a visited site completes it in the field as in the
 * address bar, the completion selected after what was typed, and deleting
 * does not complete again.
 */
add_task(async function typing_autofills_alike() {
  await PlacesTestUtils.addVisits(
    Array.from({ length: 4 }, () => ({
      uri: "https://example.com/",
      transition: PlacesUtils.history.TRANSITIONS.TYPED,
    }))
  );
  // Autofill reads the frecency Places works out after the visits.
  await Cc["@mozilla.org/places/frecency-recalculator;1"]
    .getService(Ci.nsIObserver)
    .wrappedJSObject.recalculateAnyOutdatedFrecencies();
  atTaskEnd(() => PlacesUtils.history.clear());
  const { tab } = await homeTab();
  const browser = tab.linkedBrowser;

  await within(
    UrlbarTestUtils.promiseAutocompleteResultPopup({
      window,
      value: "exa",
      fireInputEvent: true,
    }),
    10_000,
    "the address bar's results"
  );
  Assert.notEqual(gURLBar.value, "exa", "the address bar autofills");
  const urlbar = {
    value: gURLBar.value,
    selection: [gURLBar.selectionStart, gURLBar.selectionEnd],
  };
  info(JSON.stringify(urlbar));
  Assert.equal(urlbar.selection[0], 3, "after what was typed");
  await closeUrlbarWithItems();

  await typeInHomeField(browser, "exa");
  let home;
  await TestUtils.waitForCondition(async () => {
    home = await homeList(browser);
    return home.value === urlbar.value;
  }, "the field autofills the same site");
  Assert.deepEqual(home.selection, urlbar.selection, "selected alike");

  await BrowserTestUtils.synthesizeKey("KEY_Backspace", {}, browser);
  await TestUtils.waitForCondition(async () => {
    home = await homeList(browser);
    return home.value === "exa" && !home.hidden;
  }, "Backspace takes the completion away");
  Assert.deepEqual(home.selection, [3, 3], "and leaves the caret");
});

/**
 * The rows with a menu in the address bar have one in the field, and the
 * menu opens from the field over the page: Remove from history there
 * removes the page and its row, as in the address bar.
 */
add_task(async function a_rows_menu_lists_and_acts_alike() {
  await mothPages(2);
  const { tab } = await homeTab();
  const browser = tab.linkedBrowser;

  await typeInUrlbar("moth page");
  const urlbar = await urlbarItems();
  const urlbarMenus = [];
  for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
    const { element } = await UrlbarTestUtils.getDetailsOfResultAt(window, i);
    urlbarMenus.push(!!element.row.querySelector(".urlbarView-button-menu"));
  }
  info(JSON.stringify(urlbarMenus));
  Assert.ok(urlbarMenus.includes(true), "the address bar's rows have menus");
  await closeUrlbarWithItems();

  await typeInHomeField(browser, "moth page");
  await untilHomeLists(browser, urlbar);
  const homeMenus = await SpecialPowers.spawn(browser, [], () =>
    [...content.document.querySelectorAll(".suggestions .result")].map(
      li => !!li.querySelector(".menu-button")
    )
  );
  Assert.deepEqual(homeMenus, urlbarMenus, "the same rows have a menu");

  const shown = BrowserTestUtils.waitForEvent(document, "popupshown");
  await BrowserTestUtils.synthesizeMouseAtCenter(
    ".result:has(.menu-button) .menu-button",
    {},
    browser
  );
  const { target: menu } = await within(shown, 10_000, "the row's menu");
  Assert.equal(menu.id, "sval-home-result-menu", "the row's menu opens");
  await translated(menu.querySelector("menuitem"));
  const items = [...menu.querySelectorAll("menuitem")].map(i => i.label);
  info(JSON.stringify(items));
  Assert.ok(items.length, "with the address bar's commands");
  const remove = menuItem({ popup: menu }, "dismiss");
  Assert.equal(
    remove.getAttribute("key"),
    "sval-key-dismiss",
    "Remove from history names Shift+Delete, which removes the row too"
  );
  Assert.ok(remove.getAttribute("acceltext"), "and shows it");
  const title = await SpecialPowers.spawn(
    browser,
    [],
    () =>
      content.document.querySelector(".result:has(.menu-button) .title")
        .textContent
  );
  const removed = PlacesTestUtils.waitForNotification("page-removed");
  menu.activateItem(remove);
  await within(removed, 10_000, "Remove from history removes the page");
  await TestUtils.waitForCondition(
    async () => !(await homeList(browser)).items.some(i => i.includes(title)),
    "and its row"
  );
  Assert.ok(!(await homeList(browser)).hidden, "the list stays open");
});

/**
 * The address bar's engine menu, as its search-mode switcher lists it: the
 * engines, then the local search modes, then Search Settings.
 *
 * @returns {Promise<string[]>}
 */
async function switcherItems() {
  const popup = await UrlbarTestUtils.openSearchModeSwitcher(window);
  const items = [...popup.querySelectorAll("panel-item")].map(
    item =>
      item.dataset.engineName ??
      (item.dataset.restrict ? `@${item.dataset.restrict}` : "settings")
  );
  const hidden = UrlbarTestUtils.searchModeSwitcherPopupClosed(window);
  popup.hide(null, { force: true });
  await within(hidden, 10_000, "the address bar's engine menu closes");
  return items;
}

/**
 * Opens Home's engine list with `open` and answers it once it shows.
 *
 * @param {Function} open
 * @returns {Promise<Element>} the list, a `panel-list`.
 */
async function homeEngineMenu(open) {
  const shown = BrowserTestUtils.waitForEvent(document, "shown", false, event =>
    event.target.matches?.(".searchmode-switcher-panel-list")
  );
  await open();
  const { target: list } = await within(shown, 10_000, "Home's engine list");
  Assert.notEqual(
    list,
    UrlbarTestUtils.searchModeSwitcherPopup(window),
    "Home's own list"
  );
  return list;
}

/**
 * What Home's engine button shows: its icon, the mode's name, and whether
 * its Close button shows.
 *
 * @param {object} browser
 * @returns {Promise<{icon: string, title: string, close: boolean}>}
 */
function engineButtonShows(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const button = content.document.querySelector(".engine-button");
    return {
      icon: button.querySelector(".engine").src,
      title: button.querySelector(".engine-title").textContent,
      close: !button.querySelector(".engine-close").hidden,
    };
  });
}

/**
 * Home's engine button opens the address bar's engine list: the same list,
 * the same items in the same order. An engine picked there puts the field
 * in its search mode with what it holds, shown on the button as the address
 * bar shows it, focus back in the field; the button's Close leaves the
 * mode, and Alt+Down in the field opens the list too.
 */
add_task(async function the_engine_menu_lists_and_picks_alike() {
  const { tab } = await homeTab();
  const browser = tab.linkedBrowser;
  const expected = await switcherItems();
  info(expected.join("\n"));
  await TestUtils.waitForCondition(
    async () => (await engineButtonShows(browser)).icon,
    "the button shows the default engine"
  );
  const before = await engineButtonShows(browser);

  // Picked before anything is typed, the engine shows on the button too.
  const first = await homeEngineMenu(() =>
    BrowserTestUtils.synthesizeMouseAtCenter(".engine-button", {}, browser)
  );
  const firstEngine = first.querySelector("panel-item[data-engine-name]");
  const firstHidden = BrowserTestUtils.waitForEvent(first, "hidden");
  EventUtils.synthesizeMouseAtCenter(firstEngine, {});
  await within(firstHidden, 10_000, "the engine list closes");
  await TestUtils.waitForCondition(
    async () =>
      (await homeList(browser)).chip === firstEngine.dataset.engineName,
    "an empty field's button names the engine"
  );
  await BrowserTestUtils.synthesizeMouseAtCenter(".engine-close", {}, browser);
  await TestUtils.waitForCondition(
    async () => (await homeList(browser)).chip === null,
    "Close leaves that mode"
  );

  await typeInHomeField(browser, "moth");
  const list = await homeEngineMenu(() =>
    BrowserTestUtils.synthesizeMouseAtCenter(".engine-button", {}, browser)
  );
  Assert.ok(
    list.parentElement.matches(".searchmode-switcher-panel.toolbar-menupopup"),
    "in the address bar's panel"
  );
  const items = [...list.querySelectorAll("panel-item")].map(
    item =>
      item.dataset.engineName ??
      (item.dataset.restrict ? `@${item.dataset.restrict}` : "settings")
  );
  Assert.deepEqual(items, expected, "the address bar's items, in its order");
  Assert.ok(
    await SpecialPowers.spawn(
      browser,
      [],
      () =>
        content.document
          .querySelector(".engine-button")
          .getAttribute("aria-expanded") == "true"
    ),
    "the button says its list is open"
  );

  const engine = [...list.querySelectorAll("panel-item[data-engine-name]")].at(
    -1
  );
  const engineName = engine.dataset.engineName;
  const hidden = BrowserTestUtils.waitForEvent(list, "hidden");
  // The list opens above the field with the room there is and scrolls the
  // rest (`setAlign` in panel-list.mjs), and a press past its edge closes it.
  engine.scrollIntoView({ block: "nearest" });
  EventUtils.synthesizeMouseAtCenter(engine, {});
  await within(hidden, 10_000, "the engine list closes");
  await TestUtils.waitForCondition(
    async () => (await homeList(browser)).chip === engineName,
    "the button names the engine"
  );
  const inMode = await engineButtonShows(browser);
  Assert.ok(inMode.close, "with its Close button");
  Assert.notEqual(inMode.icon, before.icon, "and the engine's icon");
  Assert.equal((await homeList(browser)).value, "moth", "and what it held");
  Assert.ok(
    await SpecialPowers.spawn(
      browser,
      [],
      () =>
        content.document.activeElement ==
        content.document.querySelector(".search input")
    ),
    "focus is back in the field"
  );

  await BrowserTestUtils.synthesizeMouseAtCenter(".engine-close", {}, browser);
  await TestUtils.waitForCondition(
    async () => (await homeList(browser)).chip === null,
    "Close leaves the mode"
  );
  Assert.deepEqual(
    await engineButtonShows(browser),
    before,
    "the button shows the default engine again"
  );

  const keyList = await homeEngineMenu(() =>
    BrowserTestUtils.synthesizeKey("KEY_ArrowDown", { altKey: true }, browser)
  );
  const closed = BrowserTestUtils.waitForEvent(keyList, "hidden");
  EventUtils.synthesizeKey("KEY_Escape");
  await within(closed, 10_000, "Escape closes the engine list");
  await TestUtils.waitForCondition(
    () =>
      SpecialPowers.spawn(
        browser,
        [],
        () =>
          content.document.activeElement ==
          content.document.querySelector(".search input")
      ),
    "focus goes back to the field"
  );
});
