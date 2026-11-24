/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * The address bar's rows in fixed sections (launcher spec §5): after the row
 * Enter takes, which is always what was typed, Open tabs, Pins and
 * Favorites, Commands, History and Search suggestions, each under its
 * heading and within its limit. An open tab that matches strongly moves
 * Open tabs up, right after the first row. A page shows once, in the first
 * section it qualifies for, and a pin's open tab is its pin's row. With
 * nothing typed the list is the most recently used tabs of every workspace,
 * then the frequent sites.
 * ⇧Delete removes a history row. Enter pressed before the slow rows arrive
 * searches, and a late row never moves the open tab's.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);
const { PlacesTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PlacesTestUtils.sys.mjs"
);
const { SearchTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/SearchTestUtils.sys.mjs"
);
SearchTestUtils.init(this);
const { SearchService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/search/SearchService.sys.mjs"
);
const { ProvidersManager } = ChromeUtils.importESModule(
  "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs"
);
const providersManager = ProvidersManager.getInstanceForSap("urlbar");
const { UrlbarResult } = ChromeUtils.importESModule(
  "chrome://browser/content/urlbar/UrlbarResult.mjs"
);
const { isPin } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPinTab.sys.mjs"
);

add_setup(failOnConsoleErrors);

let store;

add_setup(async function () {
  await PlacesUtils.history.clear();
  ({ store } = await favoritesFixture());
  registerCleanupFunction(async () => {
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
 * Two workspaces, Work and Home, with this window on Work, and in Home a tab
 * for each of `titles`, never loaded.
 *
 * @param {string[]} titles
 * @returns {Promise<object>} `withSwitcherTabs`' result, plus `work`, `home`
 *   and `tabs`, the new tabs' nodes in order.
 */
async function workAndHome(titles) {
  const fixture = await withSwitcherTabs({ names: ["Work", "Home"] });
  const [work, home] = fixture.ids.workspaces;
  const tabs = [];
  for (const title of titles) {
    tabs.push(
      await fixture.engine.mutate({
        kind: "addTab",
        parent: home,
        name: title,
        url: titled(title),
        id: crypto.randomUUID(),
        now: Date.now(),
      })
    );
  }
  await SvalPanel.refresh();
  return { ...fixture, work, home, tabs };
}

/**
 * Favorites, deleted when the task ends; those in `pinned` are pins.
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
 * Types `value` into the address bar and answers its rows once the query is
 * done, each with the l10n id of the heading drawn above it, or null.
 *
 * @param {string} value
 * @returns {Promise<object[]>} `{ result, element, heading }` per row.
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
  // The view fills in a heading's words after it draws the row.
  await TestUtils.waitForCondition(
    () =>
      rows.every(
        r =>
          !r.element.row.hasAttribute("data-l10n-id") ||
          r.element.row.hasAttribute("label")
      ),
    "the headings have their words"
  );
  return rows.map(r => ({
    ...r,
    heading: r.element.row.hasAttribute("label")
      ? r.element.row.getAttribute("data-l10n-id")
      : null,
  }));
}

async function close() {
  await within(
    UrlbarTestUtils.promisePopupClose(window),
    10_000,
    "the address bar's results closing"
  );
  gURLBar.handleRevert();
}

/**
 * The rows after the first, grouped under the heading each follows.
 *
 * @param {object[]} rows {@link rowsFor}'s.
 * @returns {Array<{heading: string, rows: object[]}>}
 */
function sections(rows) {
  const out = [];
  for (const row of rows.slice(1)) {
    if (row.heading) {
      out.push({ heading: row.heading, rows: [] });
    }
    out.at(-1)?.rows.push(row);
  }
  return out;
}

/**
 * Search suggestions on, as Sval ships them, from an engine this file serves.
 * The manifest and the harness's profile turn them off, so no test reaches
 * the network. The engine stays the default until the file ends, when
 * `SearchTestUtils` removes it.
 */
async function withSuggestions() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.search.suggest.enabled", true],
      ["browser.urlbar.suggest.searches", true],
    ],
  });
  if (SearchService.getEngineByName("Sval Suggestions")) {
    return;
  }
  await SearchTestUtils.installSearchExtension(
    {
      name: "Sval Suggestions",
      search_url: "https://example.com/",
      suggest_url: `${ROOT}sval_launcher_suggestions.sjs`,
      suggest_url_get_params: "q={searchTerms}",
    },
    { setAsDefault: true }
  );
}

/**
 * For words that match open tabs, a pin, Favorites, a command, history and
 * suggestions, each section shows under its heading, in the default
 * order, with no more rows than its limit.
 */
add_task(async function the_sections_come_in_order_within_their_limits() {
  await withSuggestions();
  await workAndHome([1, 2, 3, 4, 5, 6].map(n => `Private window tab ${n}`));
  const pin = {
    title: "Private window pin",
    url: "https://example.com/private-window-pin",
  };
  await favorites(
    [
      pin,
      ...[1, 2, 3, 4].map(n => ({
        title: `Private window favorite ${n}`,
        url: `https://example.com/private-window-favorite-${n}`,
      })),
    ],
    [pin]
  );
  await PlacesTestUtils.addVisits(
    [1, 2, 3, 4, 5, 6, 7].map(n => ({
      uri: `https://example.com/private-window-history-${n}`,
      title: `Private window history ${n}`,
    }))
  );

  const rows = await rowsFor("private window");
  Assert.ok(rows[0].result.heuristic, "the row Enter takes comes first");
  Assert.equal(rows[0].result.type, UrlbarUtils.RESULT_TYPE.SEARCH);
  Assert.equal(rows[0].heading, null, "under no heading");
  const shown = sections(rows);
  Assert.deepEqual(
    shown.map(s => s.heading),
    [
      "launcher-section-tabs",
      "launcher-section-favorites",
      "launcher-section-commands",
      "launcher-section-history",
      "launcher-section-suggestions",
    ],
    "the headings, in the default order"
  );
  const [tabs, pinsAndFavorites, commands, history, suggestions] = shown.map(
    s => s.rows
  );
  Assert.equal(tabs.length, 4, "four open tabs");
  Assert.ok(
    tabs.every(r => r.result.payload.svalNodeId),
    "each one of the tree's tabs"
  );
  Assert.equal(pinsAndFavorites.length, 3, "three pins and Favorites");
  Assert.equal(pinsAndFavorites[0].result.payload.url, pin.url, "pin first");
  Assert.ok(
    pinsAndFavorites
      .slice(1)
      .every(r => /private-window-favorite/.test(r.result.payload.url)),
    "then Favorites"
  );
  Assert.deepEqual(
    commands.map(r => r.result.payload.commandId),
    ["private-window"],
    "the New private window command"
  );
  Assert.equal(history.length, 5, "five history rows");
  Assert.ok(
    history.every(r => /private-window-history/.test(r.result.payload.url)),
    "all from history"
  );
  Assert.equal(suggestions.length, 3, "three suggestions");
  Assert.ok(
    suggestions.every(r =>
      r.result.payload.suggestion?.startsWith("private window ")
    ),
    "all the engine's"
  );
  await close();
  await PlacesUtils.history.clear();
  await SpecialPowers.popPrefEnv();
});

/**
 * The order and limits are settings: a section moves where the order puts
 * it, one the order leaves out is not shown, and a limit is kept.
 */
add_task(async function the_order_and_limits_are_settings() {
  // Each word starts a word of the titles, the whole text none, so no tab
  // matches strongly and Open tabs keeps its place in the order.
  await workAndHome([1, 2, 3, 4].map(n => `Tab ${n} lantern`));
  await PlacesTestUtils.addVisits(
    [1, 2, 3].map(n => ({
      uri: `https://example.com/lantern-history-${n}`,
      title: `Lantern tab history ${n}`,
    }))
  );
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.sval.launcher.order", "history,tabs"],
      ["browser.sval.launcher.limit.tabs", 2],
      ["browser.sval.launcher.limit.history", 1],
    ],
  });
  const shown = sections(await rowsFor("lantern tab"));
  Assert.deepEqual(
    shown.map(s => [s.heading, s.rows.length]),
    [
      ["launcher-section-history", 1],
      ["launcher-section-tabs", 2],
    ],
    "History first, then two open tabs"
  );
  await close();
  await SpecialPowers.popPrefEnv();
  await PlacesUtils.history.clear();
});

/**
 * A page open as a tab, a Favorite and in history shows once, as its tab.
 */
add_task(async function a_page_shows_once_as_its_tab() {
  const { tabs } = await workAndHome(["Quokka board"]);
  const url = titled("Quokka board");
  await favorites([{ title: "Quokka board", url }]);
  await PlacesTestUtils.addVisits([{ uri: url, title: "Quokka board" }]);

  const rows = await rowsFor("quokka");
  const forPage = rows.filter(r => r.result.payload.url === url);
  Assert.deepEqual(
    forPage.map(r => r.result.payload.svalNodeId),
    [tabs[0]],
    "one row, the open tab's"
  );
  await close();
  await PlacesUtils.history.clear();
});

/**
 * A pin whose page is open is listed once, as the pin, under Pins and
 * Favorites, and Enter on it shows the pin's page, as a click on the pin
 * does, opening no tab.
 */
add_task(async function a_pins_open_tab_is_its_pin_row() {
  await workAndHome([]);
  const shown = gBrowser.selectedTab;
  const url = titled("Pinned notes");
  const entry = { title: "Pinned notes", url };
  const [guid] = await favorites([entry], [entry]);
  const pin = SvalPanel.pins.slots.find(slot => slot.guid === guid);
  SvalPanel.pins.select(pin);
  const pinTab = gBrowser.selectedTab;
  await committed(pinTab.linkedBrowser, url);
  await selectTab(shown);
  const tabsBefore = gBrowser.tabs.length;

  const rows = await rowsFor("pinned");
  const forPage = rows.filter(r => r.result.payload.url === url);
  Assert.equal(forPage.length, 1, "one row for the pin's page");
  Assert.equal(
    forPage[0].result.type,
    UrlbarUtils.RESULT_TYPE.URL,
    "the pin's own row"
  );
  Assert.ok(!forPage[0].result.heuristic, "below the row Enter takes");
  Assert.equal(forPage[0].heading, "launcher-section-favorites");

  while (
    UrlbarTestUtils.getSelectedRowIndex(window) !== rows.indexOf(forPage[0])
  ) {
    EventUtils.synthesizeKey("KEY_ArrowDown");
  }
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(
    () => gBrowser.selectedTab === pinTab,
    "the pin's page shows"
  );
  Assert.equal(gBrowser.tabs.length, tabsBefore, "no tab opened");
  await selectTab(shown);
});

/**
 * With nothing typed, the list starts with the most recently used tabs of
 * every workspace, at most five, newest first, each named with its
 * workspace.
 */
add_task(async function the_empty_launcher_lists_recent_tabs() {
  const { work, tabs, engine, observer } = await workAndHome(
    [1, 2, 3, 4, 5, 6, 7].map(n => `Recent ${n}`)
  );
  const workTab = await engine.mutate({
    kind: "addTab",
    parent: work,
    name: "Recent in Work",
    url: titled("Recent in Work"),
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  await SvalPanel.refresh();
  // Newest first: Home's tabs in reverse, with Work's between.
  const now = Date.now();
  const order = [tabs[6], tabs[5], workTab, tabs[4], tabs[3], tabs[2]];
  order.forEach((id, i) => SvalPanel.settings.setLastActive(id, now - i));
  const shownId = observer.nodeIdFor(gBrowser.selectedTab);

  // Any frequent sites follow the tabs (browser_sval_launcher_top_sites.js).
  const rows = (await rowsFor("")).filter(r => r.result.payload.svalNodeId);
  Assert.deepEqual(
    rows.map(r => r.result.payload.svalNodeId),
    order.slice(0, 5),
    "five tabs, the most recently used first"
  );
  Assert.ok(
    !rows.some(r => r.result.payload.svalNodeId === shownId),
    "without the tab on screen"
  );
  Assert.equal(
    rows[0].heading,
    "launcher-section-recent-tabs",
    "under Recent tabs"
  );
  Assert.ok(
    rows.slice(1).every(r => !r.heading),
    "one heading for the list"
  );
  Assert.equal(
    UrlbarTestUtils.getSelectedRowIndex(window),
    -1,
    "nothing selected"
  );
  Assert.deepEqual(
    rows.map(r => r.result.payload.svalWorkspaceName),
    ["Home", "Home", "Work", "Home", "Home"],
    "each named with its workspace"
  );
  await close();
});

/**
 * ⇧Delete on a history row removes the page from history, and retyping does
 * not bring it back. On an open tab's row or a Favorite's it removes
 * nothing.
 */
add_task(async function shift_delete_removes_a_history_row() {
  const { tabs, engine } = await workAndHome(["Zebra tab", "Zebra stripes"]);
  const favorite = "https://example.com/sval-zebra-favorite";
  const [guid] = await favorites([{ title: "Zebra favorite", url: favorite }]);
  const page = "https://example.com/sval-zebra-crossing";
  await PlacesTestUtils.addVisits([{ uri: page, title: "Zebra crossing" }]);

  const shiftDelete = predicate => {
    const index = gURLBar.view.visibleResults.findIndex(predicate);
    Assert.greater(index, 0, "the row is listed");
    gURLBar.view.selectedRowIndex = index;
    EventUtils.synthesizeKey("KEY_Delete", { shiftKey: true });
  };
  const isTab = r => r.payload.svalNodeId && !r.heuristic;
  const isFavorite = r => r.payload.url === favorite;
  const isPage = r => r.payload.url === page;

  const rows = await rowsFor("zebra");
  shiftDelete(isTab);
  shiftDelete(isFavorite);
  const removed = PlacesTestUtils.waitForNotification("page-removed", events =>
    events.some(e => e.url === page)
  );
  shiftDelete(isPage);
  await within(removed, 10_000, "the page leaving history");
  await TestUtils.waitForCondition(
    () => !gURLBar.view.visibleResults.some(isPage),
    "its row goes"
  );
  Assert.equal(
    UrlbarTestUtils.getResultCount(window),
    rows.length - 1,
    "only that row goes"
  );
  Assert.ok(
    gURLBar.view.visibleResults.some(isTab),
    "the open tab's row stays"
  );
  Assert.ok(gURLBar.view.visibleResults.some(isFavorite), "and the Favorite's");
  const nodes = (await engine.tree()).nodes;
  Assert.ok(
    tabs.every(id => nodes[id]),
    "the tabs stay"
  );
  Assert.ok(store.get(guid), "and so does the Favorite");
  await close();

  const again = await rowsFor("zebra");
  Assert.ok(
    !again.some(r => r.result.payload.url === page),
    "retyping does not bring it back"
  );
  await close();
  await PlacesUtils.history.clear();
});

/**
 * Enter pressed in the same turn as the typing searches for what was typed,
 * even with an open tab matching it and a history row still to come.
 */
add_task(async function an_early_enter_searches() {
  const { work } = await workAndHome(["Calendar"]);
  await withSuggestions();
  const here = gBrowser.selectedTab;
  const late = Promise.withResolvers();
  const provider = new UrlbarTestUtils.TestProvider({
    results: [
      new UrlbarResult({
        type: UrlbarUtils.RESULT_TYPE.URL,
        source: UrlbarUtils.RESULT_SOURCE.HISTORY,
        payload: {
          url: "https://example.com/sval-calendar-history",
          title: "Calendar history",
        },
      }),
    ],
    delayResultsPromise: late.promise,
  });
  providersManager.registerProvider(provider);
  atTaskEnd(() => providersManager.unregisterProvider(provider));

  // Typed and then Enter before any row has drawn.
  const searched = BrowserTestUtils.browserLoaded(
    here.linkedBrowser,
    false,
    url => URL.parse(url)?.host === "example.com"
  );
  gURLBar.focus();
  gURLBar.select();
  EventUtils.sendString("ca");
  EventUtils.synthesizeKey("KEY_Enter");
  await within(searched, 10_000, "the search loading in this tab");
  Assert.equal(gBrowser.selectedTab, here, "this tab stays selected");
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    work,
    "and this window stays on Work"
  );
  late.resolve();
  await SpecialPowers.popPrefEnv();
});

/**
 * The open tab stays right after the first row when a slow provider answers
 * after it.
 */
add_task(async function a_late_row_does_not_move_the_first() {
  const { tabs } = await workAndHome(["Calendar"]);
  const [calendar] = tabs;
  const late = Promise.withResolvers();
  const provider = new UrlbarTestUtils.TestProvider({
    results: [
      new UrlbarResult({
        type: UrlbarUtils.RESULT_TYPE.URL,
        source: UrlbarUtils.RESULT_SOURCE.HISTORY,
        payload: {
          url: "https://example.com/sval-calendar-history",
          title: "Calendar history",
        },
      }),
    ],
    delayResultsPromise: late.promise,
  });
  providersManager.registerProvider(provider);
  atTaskEnd(() => providersManager.unregisterProvider(provider));

  gURLBar.focus();
  gURLBar.select();
  EventUtils.sendString("ca");
  // The query is not done while the slow provider waits, so the rows are
  // read from the view as they show.
  await TestUtils.waitForCondition(
    () => gURLBar.view.visibleResults[1]?.payload.svalNodeId === calendar,
    "Calendar shows after the first row"
  );
  late.resolve();
  await TestUtils.waitForCondition(
    () =>
      gURLBar.view.visibleResults.some(
        r => r.payload.url === "https://example.com/sval-calendar-history"
      ),
    "the late row arrives"
  );
  Assert.equal(
    gURLBar.view.visibleResults[1].payload.svalNodeId,
    calendar,
    "Calendar stays there"
  );
  Assert.equal(
    UrlbarTestUtils.getSelectedRowIndex(window),
    0,
    "and the first row stays selected"
  );
  await close();
});

/**
 * The site that fills in is the row Enter takes even when an open tab
 * matches the same letters strongly, and Open tabs follows it, above the
 * sections.
 */
add_task(async function the_open_tabs_follow_the_autofilled_site() {
  const { tabs } = await workAndHome(["Calendar"]);
  const site = "https://calendar.example.com/";
  await PlacesTestUtils.addVisits(
    Array(3).fill({
      uri: site,
      title: "Calendar site",
      transition: PlacesUtils.history.TRANSITIONS.TYPED,
    })
  );
  // Autofill reads the frecency Places works out after the visits.
  await Cc["@mozilla.org/places/frecency-recalculator;1"]
    .getService(Ci.nsIObserver)
    .wrappedJSObject.recalculateAnyOutdatedFrecencies();
  const rows = await rowsFor("ca");
  Assert.equal(rows[0].result.payload.url, site, "the site first");
  Assert.ok(rows[0].result.heuristic, "as the row Enter takes");
  Assert.ok(rows[0].result.autofill, "filled in");
  Assert.equal(rows[1].result.payload.svalNodeId, tabs[0], "then the tab");
  Assert.equal(rows[1].heading, "launcher-section-tabs", "under Open tabs");
  Assert.equal(
    rows.filter(r => r.result.payload.url === site).length,
    1,
    "the site is not listed again in History"
  );
  Assert.equal(UrlbarTestUtils.getSelectedRowIndex(window), 0, "selected");
  await close();
  await PlacesUtils.history.clear();
});

/**
 * A page picked before for the same letters stays in the top area, above
 * the sections, as Firefox lists it, and is not repeated in History.
 */
add_task(async function a_page_picked_before_is_in_the_top_area() {
  await workAndHome([]);
  const picked = "https://example.com/sval-otter-notes";
  await PlacesTestUtils.addVisits([
    { uri: picked, title: "Otter notes" },
    { uri: "https://example.com/sval-otter-history", title: "Otter history" },
  ]);
  await UrlbarUtils.addToInputHistory(picked, "otter");
  const rows = await rowsFor("otter");
  const at = rows.findIndex(r => r.result.payload.url === picked);
  Assert.equal(
    rows[at]?.result.providerName,
    "UrlbarProviderInputHistory",
    "the picked page is listed from input history"
  );
  const firstHeading = rows.findIndex(r => r.heading);
  Assert.less(at, firstHeading, "above the sections");
  Assert.ok(!rows[at].heading, "under no heading");
  Assert.equal(
    rows.filter(r => r.result.payload.url === picked).length,
    1,
    "and only there"
  );
  Assert.equal(
    rows[firstHeading].heading,
    "launcher-section-history",
    "History follows"
  );
  await close();
  await PlacesUtils.history.clear();
});

/**
 * Firefox's row for an open pin's page stays where the pin's own row does
 * not list it, as after `%`, which lists only open tabs.
 */
add_task(async function an_open_pin_is_listed_after_percent() {
  await workAndHome([]);
  const shown = gBrowser.selectedTab;
  const url = titled("Pinned notes");
  const entry = { title: "Pinned notes", url };
  const [guid] = await favorites([entry], [entry]);
  SvalPanel.pins.select(SvalPanel.pins.slots.find(s => s.guid === guid));
  const pinTab = gBrowser.selectedTab;
  await committed(pinTab.linkedBrowser, url);
  await selectTab(shown);
  const rows = await rowsFor("% pinned");
  Assert.ok(
    rows.some(r => r.result.payload.url === url),
    "the pin's page is listed"
  );
  await close();
});

/**
 * `%` with nothing after it lists every open tab, beyond the five recent
 * ones.
 */
add_task(async function percent_alone_lists_every_open_tab() {
  const { observer } = await workAndHome(
    [1, 2, 3, 4, 5, 6, 7, 8].map(n => `Tab ${n}`)
  );
  const nodes = (await SvalPanel.engine.tree()).nodes;
  const shownId = observer.nodeIdFor(gBrowser.selectedTab);
  const others = Object.entries(nodes).filter(
    ([id, n]) => n.kind === "tab" && n.content?.url && id !== shownId
  );
  const rows = await rowsFor("% ");
  const listed = rows.filter(r => r.result.payload.svalNodeId);
  Assert.equal(listed.length, others.length, "every other tab is listed");
  Assert.greater(listed.length, 6, "more than the empty address bar's five");
  Assert.equal(listed[0].heading, "launcher-section-tabs", "under Open tabs");
  await close();
});

/**
 * A bookmark keyword typed whole is the row Enter takes, as Firefox ranks a
 * keyword above autofill, and an open tab matching the same letters
 * strongly follows it under Open tabs.
 */
add_task(async function a_keyword_outranks_an_open_tab() {
  const { tabs } = await workAndHome(["Calendar"]);
  const url = "https://example.com/sval-keyword-calendar";
  await PlacesUtils.keywords.insert({ keyword: "cal", url });
  atTaskEnd(() => PlacesUtils.keywords.remove("cal"));
  const rows = await rowsFor("cal");
  Assert.equal(rows[0].result.type, UrlbarUtils.RESULT_TYPE.KEYWORD);
  Assert.equal(rows[0].result.payload.url, url, "the keyword is first");
  Assert.ok(rows[0].result.heuristic, "as the row Enter takes");
  const [open] = sections(rows);
  Assert.equal(open?.heading, "launcher-section-tabs", "Open tabs follows");
  Assert.deepEqual(
    open?.rows.map(r => r.result.payload.svalNodeId),
    [tabs[0]],
    "Calendar is listed there"
  );
  await close();
});

/**
 * The web search for what was typed shows once, as the row Enter takes,
 * even when the engine suggests the same words.
 */
add_task(async function the_typed_search_shows_once() {
  const { tabs } = await workAndHome(["Calendar"]);
  await withSuggestions();
  const echo = on => fetch(`${ROOT}sval_launcher_suggestions.sjs?echo=${on}`);
  await echo("on");
  atTaskEnd(() => echo("off"));
  const rows = await rowsFor("ca");
  Assert.equal(rows[1].result.payload.svalNodeId, tabs[0], "the tab second");
  const typed = rows.filter(
    r =>
      r.result.type === UrlbarUtils.RESULT_TYPE.SEARCH &&
      (r.result.payload.suggestion ?? r.result.payload.query) === "ca"
  );
  Assert.equal(typed.length, 1, "one row searches for “ca”");
  Assert.ok(
    rows.some(r => r.result.payload.suggestion === "ca alpha"),
    "beside the engine's other suggestions"
  );
  await close();
  await SpecialPowers.popPrefEnv();
});
