/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * Where Enter in the address bar opens what is picked (launcher spec §3): a
 * page in this tab, Shift in a new tab, Accel+Shift in a new window, Alt
 * beside this tab in a split. Accel alone loads what was typed, never
 * completed to `www.….com`. On an open tab every modifier but Alt switches,
 * and Alt splits this tab with it. On a pin a page of another site opens in
 * a new tab, and in a split Enter loads in the focused pane alone. On a
 * Favorite, Shift opens its address in a new tab.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);
const { SearchTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/SearchTestUtils.sys.mjs"
);
SearchTestUtils.init(this);
const { isPin } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPinTab.sys.mjs"
);

add_setup(failOnConsoleErrors);

let store;

/** A page on a host no word typed here starts. */
const MOCHI_PAGE = PAGE.replace(
  "https://example.com/",
  "http://mochi.test:8888/"
);

add_setup(async function () {
  await PlacesUtils.history.clear();
  ({ store } = await favoritesFixture());
  registerCleanupFunction(async () => {
    // Firefox records the first split it shows, as its own tests clear.
    Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed");
    await UrlbarTestUtils.promisePopupClose(window);
    gURLBar.handleRevert();
    await PlacesUtils.history.clear();
  });
});

/**
 * A served page titled `title`.
 *
 * @param {string} title
 * @returns {string}
 */
function titled(title) {
  return `${ROOT}sval_switcher_page.sjs?%3Ctitle%3E${percentEncoded(title)}%3C/title%3E`;
}

/**
 * Two workspaces, Work and Home, with this window on Work showing its tab
 * at its node's address. Until its restore commits, the tab reads
 * `about:blank`, so an address read from it before then is not the one it
 * keeps.
 *
 * @returns {Promise<object>} `withSwitcherTabs`' result, plus `work`,
 *   `home`, and `shown`, the tab the window shows, and `shownId`, its node.
 */
async function workAndHome() {
  const fixture = await withSwitcherTabs({ names: ["Work", "Home"] });
  const [work, home] = fixture.ids.workspaces;
  const shown = gBrowser.selectedTab;
  const shownId = taggedId(shown);
  Assert.equal(shownId, fixture.ids.tabs[0], "the window shows Work's tab");
  await committed(shown.linkedBrowser, TITLED_TAB_URL.replace("%s", "1"));
  return { ...fixture, work, home, shown, shownId };
}

/**
 * A tab named `title`, never loaded, in workspace `parent`.
 *
 * @param {object} engine
 * @param {string} parent
 * @param {string} title
 * @returns {Promise<string>} its node.
 */
async function addTab(engine, parent, title) {
  const id = await engine.mutate({
    kind: "addTab",
    parent,
    name: title,
    url: titled(title),
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  await SvalPanel.refresh();
  return id;
}

/**
 * A tab named `title` opened in the workspace the window shows, which then
 * shows `shown` again.
 *
 * @param {object} observer
 * @param {object} shown
 * @param {string} title
 * @returns {Promise<{tab: object, id: string}>}
 */
async function openTab(observer, shown, title) {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, titled(title)),
    10_000,
    "a tab opening"
  );
  await within(observer.settled(), 10_000, "observer settling");
  await selectTab(shown);
  return { tab, id: taggedId(tab) };
}

/**
 * Types `value` into the address bar and waits for its rows.
 *
 * @param {string} value
 * @returns {Promise<object[]>} `{ result, element }` per row.
 */
async function rowsFor(value) {
  await within(
    UrlbarTestUtils.promiseAutocompleteResultPopup({ window, value }),
    10_000,
    "the address bar's results"
  );
  const rows = [];
  for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
    rows.push(await UrlbarTestUtils.getDetailsOfResultAt(window, i));
  }
  return rows;
}

/**
 * Selects the row for `url` among `rows`.
 *
 * @param {object[]} rows {@link rowsFor}'s.
 * @param {string} url
 */
function selectRowFor(rows, url) {
  const index = rows.findIndex(r => r.result.payload.url === url);
  Assert.greater(index, 0, "the page has a row below the first");
  while (UrlbarTestUtils.getSelectedRowIndex(window) !== index) {
    EventUtils.synthesizeKey("KEY_ArrowDown");
  }
}

/**
 * The tabs of the split the window shows, by node, in pane order.
 *
 * @returns {string[]}
 */
function shownSplit() {
  return (gBrowser.selectedTab.splitview?.tabs ?? []).map(taggedId);
}

/** @returns {number} the browser windows open. */
function browserWindows() {
  return [...Services.wm.getEnumerator("navigator:browser")].length;
}

/**
 * @param {object} engine
 * @returns {Promise<number>} the number of tabs in the tree.
 */
async function tabCount(engine) {
  const nodes = (await engine.tree()).nodes ?? {};
  return Object.values(nodes).filter(n => n.kind === "tab").length;
}

/**
 * Favorites, deleted when the task ends with any pin's page; those in
 * `pinned` are pins.
 *
 * @param {object[]} entries `{ title, url }`
 * @param {object[]} [pinned] Entries of `entries` that are pins instead.
 * @returns {Promise<string[]>} their guids.
 */
async function favorites(entries, pinned = []) {
  const plain = entries.filter(entry => !pinned.includes(entry));
  const pins = entries.filter(entry => pinned.includes(entry));
  const made = await store.insertTree(plain, { pins });
  const guids = entries.map(entry =>
    pinned.includes(entry)
      ? made[plain.length + pins.indexOf(entry)]
      : made[plain.indexOf(entry)]
  );
  atTaskEnd(async () => {
    for (const tab of Array.from(gBrowser.tabs)) {
      if (isPin(tab)) {
        gBrowser.removeTab(tab, { animate: false, skipSessionStore: true });
      }
    }
    for (const guid of guids) {
      await store.delete(guid);
    }
  });
  await TestUtils.waitForCondition(
    () =>
      pinned.every(entry =>
        SvalPanel.pins.slots.some(slot => slot.url === entry.url)
      ),
    "the pins show in the row"
  );
  return guids;
}

/**
 * Accel+Enter on a word loads what was typed, as Enter does, and never
 * completes it to `www.example.com`. No visit is on a host the word starts,
 * so the row Enter takes is the search.
 */
add_task(async function accel_enter_does_not_complete_to_www() {
  const shown = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, MOCHI_PAGE),
    10_000,
    "a page opening"
  );
  await SearchTestUtils.installSearchExtension(
    {
      name: "Sval Enter",
      search_url: "https://example.com/",
      search_url_get_params: "q={searchTerms}",
    },
    { setAsDefault: true }
  );
  const [top] = await rowsFor("example");
  Assert.equal(top.result.type, UrlbarUtils.RESULT_TYPE.SEARCH, "a search");
  const loaded = BrowserTestUtils.browserLoaded(shown.linkedBrowser);
  EventUtils.synthesizeKey("KEY_Enter", { accelKey: true });
  await within(loaded, 10_000, "this tab loading");
  Assert.equal(
    shown.linkedBrowser.currentURI.spec,
    "https://example.com/?q=example",
    "this tab searches for the word"
  );
});

/**
 * An address and Enter loads in this tab; Shift+Enter opens a new tab and
 * this tab keeps its page; Alt+Enter opens it beside this tab in a split,
 * which the tree holds.
 */
add_task(async function an_address_opens_where_its_modifier_says() {
  const { engine, shown, shownId } = await workAndHome();
  const before = gBrowser.tabs.length;

  const here = titled("Here");
  await rowsFor(here);
  EventUtils.synthesizeKey("KEY_Enter");
  await committed(shown.linkedBrowser, here);
  Assert.equal(gBrowser.tabs.length, before, "and opens no tab");

  const inTab = titled("In a tab");
  await rowsFor(inTab);
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, inTab, true);
  EventUtils.synthesizeKey("KEY_Enter", { shiftKey: true });
  const tab = await within(opened, 10_000, "Shift+Enter opening a tab");
  Assert.equal(gBrowser.selectedTab, tab, "the new tab is shown");
  Assert.equal(shown.linkedBrowser.currentURI.spec, here, "this tab stays");

  await selectTab(shown);
  const beside = titled("Beside");
  await rowsFor(beside);
  const split = BrowserTestUtils.waitForNewTab(gBrowser, beside, true);
  EventUtils.synthesizeKey("KEY_Enter", { altKey: true });
  const pane = await within(split, 10_000, "Alt+Enter opening a tab");
  await TestUtils.waitForCondition(
    () =>
      taggedId(pane) &&
      JSON.stringify(shownSplit()) ===
        JSON.stringify([shownId, taggedId(pane)]) &&
      gBrowser.selectedTab === pane,
    "Alt+Enter shows the page beside this tab in a split, focused"
  );
  Assert.equal(shown.linkedBrowser.currentURI.spec, here, "this pane stays");
  const nodes = (await engine.tree()).nodes;
  Assert.equal(
    nodes[taggedId(pane)].placement.parent,
    nodes[shownId].placement.parent,
    "the tree holds both in one split"
  );
  Assert.equal(nodes[nodes[shownId].placement.parent].kind, "split");
});

/**
 * Accel+Shift+Enter on an address opens it in a new window, and this tab
 * keeps its page.
 */
add_task(async function accel_shift_enter_opens_a_new_window() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE),
    10_000,
    "a page opening"
  );
  const url = titled("In a window");
  await rowsFor(url);
  const opening = BrowserTestUtils.domWindowOpenedAndLoaded();
  EventUtils.synthesizeKey("KEY_Enter", { accelKey: true, shiftKey: true });
  const win = await within(opening, 20_000, "a window opening");
  try {
    await committed(() => win.gBrowser?.selectedBrowser, url);
    Assert.equal(tab.linkedBrowser.currentURI.spec, PAGE, "this tab stays");
    // The panel's start restores into the window, so the close waits for it
    // and tests the close alone.
    await within(win.SvalPanel.started, 20_000, "its panel starting");
  } finally {
    await within(BrowserTestUtils.closeWindow(win), 10_000, "closing it");
  }
});

/**
 * While Shift, Alt or Accel is held, an open tab's row still says it
 * switches to the tab, since every Enter on it does.
 */
add_task(async function a_held_modifier_leaves_the_row_switching() {
  const { engine, home } = await workAndHome();
  await addTab(engine, home, "Calendar");
  const [, top] = await rowsFor("ca");
  EventUtils.synthesizeKey("KEY_ArrowDown");
  // What Enter does on the selected row (`SvalLauncherRows`).
  const hint = top.element.row.querySelector(".sval-launcher-hint-verb");
  const switching = () => {
    const { id, args } = document.l10n.getAttributes(hint);
    return id === "launcher-hint-switch-to" && args?.workspace === "Home";
  };
  await TestUtils.waitForCondition(switching, "the row says it switches");
  const accel = AppConstants.platform == "macosx" ? "KEY_Meta" : "KEY_Control";
  for (const key of ["KEY_Shift", "KEY_Alt", accel]) {
    EventUtils.synthesizeKey(key, { type: "keydown" });
    try {
      Assert.ok(
        BrowserTestUtils.isVisible(hint) && switching(),
        `with ${key} held, the row still says Switch to Home`
      );
    } finally {
      EventUtils.synthesizeKey(key, { type: "keyup" });
    }
  }
  await within(
    UrlbarTestUtils.promisePopupClose(window),
    10_000,
    "the results closing"
  );
});

/**
 * Shift+Enter and Accel+Shift+Enter on the row of an open tab of this
 * workspace switch to it, as Enter does, opening no tab and no window.
 * `browser_sval_launcher_new_window.js` covers a tab of another workspace. Alt+Enter splits this tab with
 * it, from this workspace or another, and focuses it.
 */
add_task(async function modifiers_on_an_open_tab_switch_or_split() {
  for (const modifiers of [
    { shiftKey: true },
    { accelKey: true, shiftKey: true },
  ]) {
    const { engine, observer, work, home } = await workAndHome();
    const calendar = await addTab(engine, work, "Calendar");
    const before = await tabCount(engine);
    const windows = browserWindows();

    const [, top] = await rowsFor("ca");
    Assert.equal(
      top.result.payload.svalNodeId,
      calendar,
      "Calendar follows the search"
    );
    EventUtils.synthesizeKey("KEY_ArrowDown");
    EventUtils.synthesizeKey("KEY_Enter", modifiers);
    await TestUtils.waitForCondition(
      () =>
        SvalPanel.workspaceId === work &&
        taggedId(gBrowser.selectedTab) === calendar,
      `${JSON.stringify(modifiers)} switches to Calendar`
    );
    await within(observer.settled(), 10_000, "observer settling");
    Assert.equal(await tabCount(engine), before, "the tree has no new tab");
    Assert.equal(browserWindows(), windows, "no window opens");
    // So the next round's search finds only its own Calendar.
    await removeWorkspace(home);
    await removeWorkspace(work);
  }

  const opened = await workAndHome();
  const { observer, shown, shownId } = opened;
  const { id: calendar } = await openTab(observer, shown, "Calendar");
  const [, top] = await rowsFor("ca");
  Assert.equal(
    top.result.payload.svalNodeId,
    calendar,
    "Calendar follows the search"
  );
  EventUtils.synthesizeKey("KEY_ArrowDown");
  EventUtils.synthesizeKey("KEY_Enter", { altKey: true });
  // The window shows the split before it goes to Calendar
  // (`splitWithTab`), so the wait is for both.
  await TestUtils.waitForCondition(
    () =>
      JSON.stringify(shownSplit()) === JSON.stringify([shownId, calendar]) &&
      taggedId(gBrowser.selectedTab) === calendar,
    "Alt+Enter splits this tab with Calendar and focuses Calendar"
  );
  await removeWorkspace(opened.home);
  await removeWorkspace(opened.work);

  // A tab of another workspace joins this one's split.
  const fixture = await workAndHome();
  const journal = await addTab(fixture.engine, fixture.home, "Journal");
  const [, first] = await rowsFor("jo");
  Assert.equal(
    first.result.payload.svalNodeId,
    journal,
    "Journal follows the search"
  );
  EventUtils.synthesizeKey("KEY_ArrowDown");
  EventUtils.synthesizeKey("KEY_Enter", { altKey: true });
  await TestUtils.waitForCondition(
    () =>
      JSON.stringify(shownSplit()) ===
      JSON.stringify([fixture.shownId, journal]),
    "Alt+Enter splits this tab with Journal, from Home"
  );
  Assert.equal(SvalPanel.workspaceId, fixture.work, "on Work still");
});

/**
 * Alt+Enter on a tab of a workspace another window shows brings the tab
 * here, beside this tab in a split, and that window no longer has it, as
 * Move this tab to… moves a tab.
 */
add_task(async function alt_enter_brings_a_tab_from_another_window() {
  const { engine, home, shownId, ids } = await workAndHome();
  const calendar = await addTab(engine, home, "Calendar");
  const win = await tearOff(home);
  expectWorkspaceTabs(win);
  try {
    await win.SvalPanel.activate({ id: calendar, kind: "tab" });
    await untilRestored(win.gBrowser.selectedTab);
    await win.SvalPanel.activate({ id: ids.tabs[1], kind: "tab" });

    window.focus();
    await untilFocused(window, "this window has the focus");
    const [, top] = await rowsFor("ca");
    Assert.equal(
      top.result.payload.svalNodeId,
      calendar,
      "Calendar follows the search"
    );
    EventUtils.synthesizeKey("KEY_ArrowDown");
    EventUtils.synthesizeKey("KEY_Enter", { altKey: true });
    await TestUtils.waitForCondition(
      () =>
        JSON.stringify(shownSplit()) === JSON.stringify([shownId, calendar]),
      "Calendar shows beside this tab in a split"
    );
    await TestUtils.waitForCondition(
      () => !win.gBrowser.tabs.some(tab => taggedId(tab) === calendar),
      "the other window no longer has Calendar"
    );
    Assert.equal(win.SvalPanel.workspaceId, home, "it stays on Home");
  } finally {
    await within(BrowserTestUtils.closeWindow(win), 10_000, "closing it");
  }
});

/**
 * On a pin, an address on another site opens in a new tab, and the pin
 * keeps its page; Alt+Enter there opens a new tab too.
 */
add_task(async function a_pin_keeps_its_site() {
  await workAndHome();
  const mail = titled("Mail");
  const entry = { title: "Mail", url: mail };
  const [guid] = await favorites([entry], [entry]);
  SvalPanel.pins.select(SvalPanel.pins.slots.find(s => s.guid === guid));
  const pinTab = gBrowser.selectedTab;
  Assert.ok(isPin(pinTab), "the pin's page shows");
  await committed(pinTab.linkedBrowser, mail);

  await rowsFor(ORG_PAGE);
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, ORG_PAGE, true);
  EventUtils.synthesizeKey("KEY_Enter");
  const tab = await within(opened, 10_000, "a new tab opening");
  Assert.ok(!isPin(tab), "the page opens in a tab of its own");
  Assert.equal(pinTab.linkedBrowser.currentURI.spec, mail, "the pin stays");

  // A pin's page is in no split, so Alt+Enter beside it opens a tab.
  await selectTab(pinTab);
  const beside = titled("Beside a pin");
  await rowsFor(beside);
  const besideOpened = BrowserTestUtils.waitForNewTab(gBrowser, beside, true);
  EventUtils.synthesizeKey("KEY_Enter", { altKey: true });
  const besideTab = await within(besideOpened, 10_000, "a new tab opening");
  Assert.equal(gBrowser.selectedTab, besideTab, "it is shown");
  Assert.ok(!besideTab.splitview && !pinTab.splitview, "in no split");
  Assert.equal(pinTab.linkedBrowser.currentURI.spec, mail, "the pin stays");
});

/**
 * On a pin, the row of an address on another site says Enter opens it in a
 * new tab, and the line under the list offers no second new tab.
 */
add_task(async function on_a_pin_the_row_says_it_opens_a_tab() {
  await workAndHome();
  const mail = titled("Mail");
  const entry = { title: "Mail", url: mail };
  const [guid] = await favorites([entry], [entry]);
  SvalPanel.pins.select(SvalPanel.pins.slots.find(s => s.guid === guid));
  Assert.ok(isPin(gBrowser.selectedTab), "the pin's page shows");

  const [top] = await rowsFor(ORG_PAGE);
  Assert.equal(top.result.payload.url, ORG_PAGE, "the address is first");
  const verb = top.element.row.querySelector(".sval-launcher-hint-verb");
  await TestUtils.waitForCondition(
    () => document.l10n.getAttributes(verb).id === "launcher-hint-open-new-tab",
    "the row says Enter opens a new tab"
  );
  const line = gURLBar.querySelector(".sval-launcher-foot");
  await TestUtils.waitForCondition(
    () => line.children.length,
    "the line under the rows"
  );
  const offered = [...line.querySelectorAll("[data-l10n-id]")].map(el =>
    el.getAttribute("data-l10n-id")
  );
  Assert.ok(
    !offered.includes("launcher-foot-new-tab"),
    "the line offers no other new tab"
  );
  Assert.ok(
    offered.includes("launcher-foot-new-window"),
    "and still a new window"
  );
  await within(
    UrlbarTestUtils.promisePopupClose(window),
    10_000,
    "the results closing"
  );
});

/**
 * In a split, Enter loads in the focused pane alone, and the split stays.
 */
add_task(async function in_a_split_enter_loads_in_the_focused_pane() {
  const { observer, shown, shownId } = await workAndHome();
  const { id: right } = await openTab(observer, shown, "Right");
  Assert.ok(await SvalPanel.splitBeside(shownId, right), "a split is made");
  await TestUtils.waitForCondition(
    () => JSON.stringify(shownSplit()) === JSON.stringify([shownId, right]),
    "the window shows the split"
  );
  const [left, rightTab] = gBrowser.selectedTab.splitview.tabs;
  await untilRestored(rightTab);
  await selectTab(left);

  const url = titled("In the pane");
  await rowsFor(url);
  EventUtils.synthesizeKey("KEY_Enter");
  await committed(left.linkedBrowser, url);
  Assert.equal(
    rightTab.linkedBrowser.currentURI.spec,
    titled("Right"),
    "the other pane keeps its page"
  );
  Assert.deepEqual(shownSplit(), [shownId, right], "the split stays");
});

/**
 * Shift+Enter on a Favorite's row opens its address in a new tab, and on a
 * pin's row too, leaving this tab and the pin as they were.
 */
add_task(async function shift_enter_on_a_favorite_opens_a_tab() {
  const { shown } = await workAndHome();
  const page = shown.linkedBrowser.currentURI.spec;
  const notes = titled("Quokka notes");
  const board = titled("Quokka board");
  const pinned = { title: "Quokka board", url: board };
  await favorites([{ title: "Quokka notes", url: notes }, pinned], [pinned]);

  for (const url of [notes, board]) {
    const rows = await rowsFor("quokka");
    selectRowFor(rows, url);
    const opened = BrowserTestUtils.waitForNewTab(gBrowser, url, true);
    EventUtils.synthesizeKey("KEY_Enter", { shiftKey: true });
    const tab = await within(opened, 10_000, "a new tab opening");
    Assert.ok(!isPin(tab), "in a tab of its own");
    Assert.equal(shown.linkedBrowser.currentURI.spec, page, "this tab stays");
    await selectTab(shown);
  }
});

/**
 * Enter on a Favorite's row that is no pin opens it as the Favorites menu
 * does: in a new tab, leaving this tab's page.
 */
add_task(async function enter_on_a_favorite_opens_it_as_the_menu_does() {
  const { shown } = await workAndHome();
  const page = shown.linkedBrowser.currentURI.spec;
  const notes = titled("Wombat notes");
  await favorites([{ title: "Wombat notes", url: notes }]);
  selectRowFor(await rowsFor("wombat"), notes);
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, notes, true);
  EventUtils.synthesizeKey("KEY_Enter");
  const tab = await within(opened, 10_000, "the Favorite opening");
  Assert.equal(gBrowser.selectedTab, tab, "in a new tab, shown");
  Assert.equal(shown.linkedBrowser.currentURI.spec, page, "this tab stays");
});

/**
 * Accel+Shift+Enter on a Favorite's row, and on a pin's row, opens its
 * address in a new window.
 */
add_task(async function accel_shift_enter_on_a_favorite_opens_a_window() {
  const { shown } = await workAndHome();
  const page = shown.linkedBrowser.currentURI.spec;
  const notes = titled("Numbat notes");
  const board = titled("Numbat board");
  const pinned = { title: "Numbat board", url: board };
  await favorites([{ title: "Numbat notes", url: notes }, pinned], [pinned]);

  for (const url of [notes, board]) {
    selectRowFor(await rowsFor("numbat"), url);
    const opening = BrowserTestUtils.domWindowOpenedAndLoaded();
    EventUtils.synthesizeKey("KEY_Enter", { accelKey: true, shiftKey: true });
    const win = await within(opening, 20_000, "a window opening");
    try {
      await committed(() => win.gBrowser?.selectedBrowser, url);
      Assert.equal(shown.linkedBrowser.currentURI.spec, page, "this tab stays");
      await within(win.SvalPanel.started, 20_000, "its panel starting");
    } finally {
      await within(BrowserTestUtils.closeWindow(win), 10_000, "closing it");
    }
    // The window started the profile's Favorites in place of the file's.
    await restoreFixtureFavorites();
    window.focus();
    await untilFocused(window, "this window has the focus again");
  }
});

/**
 * Shift+Enter and Alt+Enter on a command's row run the command and nothing
 * else: Duplicate tab makes one copy of this tab, in no split or window.
 */
add_task(async function modifiers_on_a_command_just_run_it() {
  const { shown } = await workAndHome();
  const page = shown.linkedBrowser.currentURI.spec;
  for (const modifiers of [{ shiftKey: true }, { altKey: true }]) {
    const windows = browserWindows();
    const rows = await rowsFor("duplicate tab");
    const row = rows.find(r => r.result.payload.commandId === "duplicate");
    Assert.ok(row, "Duplicate tab is listed");
    while (UrlbarTestUtils.getSelectedRowIndex(window) !== rows.indexOf(row)) {
      EventUtils.synthesizeKey("KEY_ArrowDown");
    }
    const opened = BrowserTestUtils.waitForNewTab(gBrowser, page, true);
    EventUtils.synthesizeKey("KEY_Enter", modifiers);
    const copy = await within(opened, 10_000, "the copy opening");
    Assert.ok(!copy.splitview && !shown.splitview, "in no split");
    Assert.equal(shown.linkedBrowser.currentURI.spec, page, "this tab stays");
    Assert.equal(browserWindows(), windows, "no window opens");
    await selectTab(shown);
  }
});
