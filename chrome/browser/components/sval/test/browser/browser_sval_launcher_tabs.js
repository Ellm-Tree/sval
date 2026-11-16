/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * Open tabs from every workspace in the address bar (launcher spec §5, §6):
 * two letters of a tab's title find it in whichever workspace it is, its row
 * names that workspace, and Enter goes to it, through the window that shows
 * the workspace. Firefox's own row for the same page does not show, and the
 * Address bar settings' Open tabs switch turns the rows off.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);
const { UrlbarProviderOpenTabs } = ChromeUtils.importESModule(
  "moz-src:///browser/components/urlbar/UrlbarProviderOpenTabs.sys.mjs"
);

add_setup(failOnConsoleErrors);

add_setup(async function () {
  await PlacesUtils.history.clear();
  registerCleanupFunction(async () => {
    await UrlbarTestUtils.promisePopupClose(window);
    gURLBar.handleRevert();
    await PlacesUtils.history.clear();
  });
});

/**
 * A served page titled `title`, as `TITLED_TAB_URL` serves one.
 *
 * @param {string} title
 * @returns {string}
 */
function titled(title) {
  return `${ROOT}sval_switcher_page.sjs?%3Ctitle%3E${percentEncoded(title)}%3C/title%3E`;
}

const CALENDAR = titled("Calendar");

/**
 * Two workspaces, Work and Home, with this window on Work, and a tab
 * "Calendar" in Home that has never been loaded.
 *
 * @returns {Promise<object>} `withSwitcherTabs`' result, plus `work`, `home`
 *   and `calendar`, the tab's node.
 */
async function workAndHome() {
  const fixture = await withSwitcherTabs({ names: ["Work", "Home"] });
  const [work, home] = fixture.ids.workspaces;
  const calendar = await fixture.engine.mutate({
    kind: "addTab",
    parent: home,
    name: "Calendar",
    url: CALENDAR,
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  await SvalPanel.refresh();
  Assert.equal(SvalPanel.workspaceId, work, "the window is on Work");
  Assert.ok(!fixture.observer.tabFor(calendar), "Calendar is not loaded");
  return { ...fixture, work, home, calendar };
}

/**
 * Types `value` into `win`'s address bar and answers its rows.
 *
 * @param {string} value
 * @param {Window} [win]
 * @returns {Promise<object[]>} `{ result, element }` per row.
 */
async function rowsFor(value, win = window) {
  await within(
    UrlbarTestUtils.promiseAutocompleteResultPopup({ window: win, value }),
    10_000,
    "the address bar's results"
  );
  const rows = [];
  for (let i = 0; i < UrlbarTestUtils.getResultCount(win); i++) {
    rows.push(await UrlbarTestUtils.getDetailsOfResultAt(win, i));
  }
  return rows;
}

/**
 * What a row says, once its words have arrived: a screen reader's name for
 * it, holding the tab's title and its workspace's name, or, with no name,
 * what it says Enter does there.
 *
 * @param {object} row One of {@link rowsFor}'s.
 * @param {object} expected
 * @param {string[]} [expected.name] The title and the workspace's name its
 *   accessible name holds.
 * @param {string} [expected.hint] Its Enter hint's l10n id.
 * @returns {Promise<void>}
 */
async function untilRowSays(row, { name, hint }) {
  const option = row.element.row.querySelector(".urlbarView-row-inner");
  const verb = row.element.row.querySelector(".sval-launcher-hint-verb");
  await TestUtils.waitForCondition(
    () =>
      name
        ? name.every(part => option.getAttribute("aria-label")?.includes(part))
        : verb && document.l10n.getAttributes(verb).id === hint,
    `the row says "${name ?? hint}"`
  );
}

/**
 * The number of tabs in the tree.
 *
 * @param {object} engine
 * @returns {Promise<number>}
 */
async function tabCount(engine) {
  const nodes = (await engine.tree()).nodes ?? {};
  return Object.values(nodes).filter(n => n.kind === "tab").length;
}

/**
 * A tab in another workspace, never loaded: two letters of its title list it
 * right after the search, and Enter on its row takes the window to its
 * workspace and selects it, loaded, without adding a tab to the tree.
 */
add_task(async function enter_goes_to_a_tab_in_another_workspace() {
  const { engine, observer, home, calendar } = await workAndHome();
  const before = await tabCount(engine);

  const rows = await rowsFor("ca");
  const [first, top] = rows;
  Assert.ok(first.result.heuristic, "the first row is the one Enter takes");
  Assert.equal(
    first.result.type,
    UrlbarUtils.RESULT_TYPE.SEARCH,
    "and searches for what was typed"
  );
  Assert.ok(!top.result.heuristic, "the tab is the next row");
  Assert.equal(top.result.type, UrlbarUtils.RESULT_TYPE.TAB_SWITCH);
  Assert.equal(top.result.payload.svalNodeId, calendar, "it is Calendar");
  Assert.equal(top.result.payload.title, "Calendar");
  await untilRowSays(top, { name: ["Calendar", "Home"] });

  EventUtils.synthesizeKey("KEY_ArrowDown");
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(
    () =>
      SvalPanel.workspaceId === home &&
      taggedId(gBrowser.selectedTab) === calendar,
    "the window shows Home with Calendar selected"
  );
  await untilRestored(gBrowser.selectedTab);
  Assert.equal(
    gBrowser.selectedBrowser.currentURI.spec,
    CALENDAR,
    "Calendar is loaded"
  );
  await within(observer.settled(), 10_000, "observer settling");
  Assert.equal(await tabCount(engine), before, "the tree has no new tab");
  await assertNoHandOverFailure();
});

/**
 * An address typed whole is visited, even when an open tab is on that site:
 * the first row is the visit, the tab is the next row, and Enter loads the
 * address in this tab (launcher spec §3).
 */
add_task(async function a_typed_address_is_visited_over_an_open_tab() {
  const { work, calendar } = await workAndHome();
  const here = gBrowser.selectedTab;

  const rows = await rowsFor("example.com");
  const [first, next] = rows;
  Assert.ok(first.result.heuristic, "the first row is the one Enter takes");
  Assert.equal(
    first.result.type,
    UrlbarUtils.RESULT_TYPE.URL,
    "and visits what was typed"
  );
  Assert.equal(
    URL.parse(first.result.payload.url)?.host,
    "example.com",
    "the address typed"
  );
  Assert.equal(
    next.result.type,
    UrlbarUtils.RESULT_TYPE.TAB_SWITCH,
    "the open tabs on that site follow it"
  );
  Assert.ok(
    rows.some(r => r.result.payload.svalNodeId === calendar),
    "Calendar among them"
  );

  const loaded = BrowserTestUtils.browserLoaded(
    here.linkedBrowser,
    false,
    url => URL.parse(url)?.host === "example.com"
  );
  EventUtils.synthesizeKey("KEY_Enter");
  await within(loaded, 10_000, "the address loading in this tab");
  Assert.equal(gBrowser.selectedTab, here, "this tab stays selected");
  Assert.equal(SvalPanel.workspaceId, work, "and this window stays on Work");
});

/**
 * A tab in a workspace another window shows: Enter brings that window
 * forward, where the tab is selected, and this window stays where it was.
 * Firefox's own row for the page, which is open in that window, does not
 * show beside Sval's.
 */
add_task(async function a_workspace_another_window_shows_is_brought_forward() {
  const { work, home, calendar, ids } = await workAndHome();
  const win = await tearOff(home);
  expectWorkspaceTabs(win);
  try {
    Assert.equal(win.SvalPanel.workspaceId, home, "it shows Home");
    // Calendar loaded there, and another of Home's tabs on screen.
    await win.SvalPanel.activate({ id: calendar, kind: "tab" });
    await untilRestored(win.gBrowser.selectedTab);
    await win.SvalPanel.activate({ id: ids.tabs[1], kind: "tab" });
    await TestUtils.waitForCondition(
      () => UrlbarProviderOpenTabs.getOpenTabUrls().has(CALENDAR),
      "Firefox counts Calendar as an open tab"
    );

    window.focus();
    await untilFocused(window, "this window has the focus");
    const rows = await rowsFor("ca");
    const forPage = rows.filter(r => r.result.payload.url === CALENDAR);
    Assert.deepEqual(
      forPage.map(r => r.result.payload.svalNodeId),
      [calendar],
      "the page shows once, as Sval's row"
    );
    Assert.equal(rows.indexOf(forPage[0]), 1, "right after the search");

    EventUtils.synthesizeKey("KEY_ArrowDown");
    EventUtils.synthesizeKey("KEY_Enter");
    await untilFocused(win, "the window showing Home comes forward");
    await TestUtils.waitForCondition(
      () => taggedId(win.gBrowser.selectedTab) === calendar,
      "and selects Calendar"
    );
    Assert.equal(SvalPanel.workspaceId, work, "this window stays");
    Assert.equal(win.SvalPanel.workspaceId, home, "and so does that");
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the test window closing"
    );
  }
});

/**
 * The Address bar settings' Open tabs switch governs Sval's rows, as it does
 * Firefox's.
 */
add_task(async function the_open_tabs_setting_turns_the_rows_off() {
  const { calendar } = await workAndHome();
  let rows = await rowsFor("ca");
  Assert.ok(
    rows.some(r => r.result.payload.svalNodeId === calendar),
    "listed while Open tabs is checked"
  );
  await UrlbarTestUtils.promisePopupClose(window);

  await SpecialPowers.pushPrefEnv({
    set: [["browser.urlbar.suggest.openpage", false]],
  });
  rows = await rowsFor("ca");
  Assert.ok(
    !rows.some(r => r.result.payload.svalNodeId),
    "no open tab is listed once it is unchecked"
  );
  await UrlbarTestUtils.promisePopupClose(window);
  gURLBar.handleRevert();
  await SpecialPowers.popPrefEnv();
});

/**
 * A tab in an agent's workspace is named by the agent. Enter brings the
 * agent's window forward, or opens one for it, and the user's window keeps
 * its workspace.
 */
add_task(async function an_agents_tab_goes_to_the_agents_window() {
  const { engine, work } = await workAndHome();
  const now = Date.now();
  const agentWs = await engine.mutate({
    kind: "addAgentWorkspace",
    name: "Test Agent",
    agentLabel: "Test Agent",
    id: crypto.randomUUID(),
    now,
  });
  leftWhenTheTaskEnds([agentWs]);
  const atlas = await engine.mutate({
    kind: "addTab",
    parent: agentWs,
    name: "Atlas",
    url: titled("Atlas"),
    id: crypto.randomUUID(),
    now,
  });
  await SvalPanel.refresh();

  const agentWin = await tearOff(agentWs);
  expectWorkspaceTabs(agentWin);
  try {
    window.focus();
    await untilFocused(window, "this window has the focus");
    const [, top] = await rowsFor("atl");
    Assert.equal(top.result.payload.svalNodeId, atlas, "the agent's tab");
    await untilRowSays(top, { name: ["Atlas", "Test Agent"] });
    EventUtils.synthesizeKey("KEY_ArrowDown");
    EventUtils.synthesizeKey("KEY_Enter");
    await untilFocused(agentWin, "the agent's window comes forward");
    Assert.equal(SvalPanel.workspaceId, work, "this window stays");
  } finally {
    await within(
      BrowserTestUtils.closeWindow(agentWin),
      10_000,
      "the agent's window closing"
    );
  }

  // With no window showing it, the agent's workspace gets one of its own.
  window.focus();
  await untilFocused(window, "this window has the focus again");
  await rowsFor("atl");
  const opening = BrowserTestUtils.domWindowOpenedAndLoaded();
  EventUtils.synthesizeKey("KEY_ArrowDown");
  EventUtils.synthesizeKey("KEY_Enter");
  const opened = await within(opening, 20_000, "a window for the agent");
  expectWorkspaceTabs(opened);
  try {
    await within(opened.SvalPanel.started, 20_000, "its panel starting");
    Assert.equal(
      opened.SvalPanel.workspaceId,
      agentWs,
      "it shows the agent's workspace"
    );
    await TestUtils.waitForCondition(
      () => taggedId(opened.gBrowser.selectedTab) === atlas,
      "with the agent's tab selected"
    );
    Assert.equal(SvalPanel.workspaceId, work, "this window stays");
  } finally {
    await within(
      BrowserTestUtils.closeWindow(opened),
      10_000,
      "that window closing"
    );
  }
});

/**
 * A private window lists only its own tabs (launcher spec §6), and Enter
 * selects one.
 */
add_task(async function a_private_window_lists_only_its_own_tabs() {
  const { calendar } = await workAndHome();
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20_000,
    "a private window opening"
  );
  try {
    await within(win.SvalPanel.started, 20_000, "its panel starting");
    const first = win.gBrowser.selectedTab;
    const cascade = await within(
      BrowserTestUtils.openNewForegroundTab(win.gBrowser, titled("Cascade")),
      10_000,
      "a tab of its own opening"
    );
    await within(
      win.SvalPanel.observer.settled(),
      10_000,
      "win.SvalPanel.observer settling"
    );
    const id = win.SvalPanel.observer.nodeIdFor(cascade);
    Assert.ok(id, "the tab is in the window's tree");
    await selectTab(first);

    const rows = await rowsFor("ca", win);
    const ids = rows.map(r => r.result.payload.svalNodeId).filter(Boolean);
    Assert.ok(!ids.includes(calendar), "no tab of another window's tree");
    Assert.equal(ids[0], id, "its own tab is listed");
    Assert.equal(
      rows[1].result.payload.svalNodeId,
      id,
      "right after the search"
    );
    EventUtils.synthesizeKey("KEY_ArrowDown", {}, win);
    await untilRowSays(rows[1], { hint: "launcher-hint-switch-tab" });

    EventUtils.synthesizeKey("KEY_Enter", {}, win);
    await TestUtils.waitForCondition(
      () => win.gBrowser.selectedTab === cascade,
      "Enter selects it"
    );
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the private window closing"
    );
  }
});

/**
 * A tab of the home page in this window, filed in the tree, and empty: no
 * history and nothing loaded but the home page.
 *
 * @param {object} observer The fixture's tab observer.
 * @returns {Promise<{tab: object, id: string}>}
 */
async function emptyHomeTab(observer) {
  const tab = await openPage("about:home");
  await within(observer.settled(), 10_000, "observer settling");
  const id = observer.nodeIdFor(tab);
  Assert.ok(id, "the home tab is in the tree");
  Assert.ok(tab.isEmpty, "and empty");
  return { tab, id };
}

/**
 * ⌘T, two letters, ↓ and Enter leave no blank tab behind: the empty tab the
 * row was picked in closes, in the address bar as in the home page's
 * field, as Firefox closes one after a switch to a tab.
 */
add_task(async function the_empty_tab_picked_from_closes() {
  for (const where of ["address bar", "home page field"]) {
    const { engine, observer, work, home, calendar } = await workAndHome();
    const { tab, id } = await emptyHomeTab(observer);
    if (where === "address bar") {
      await rowsFor("ca");
      EventUtils.synthesizeKey("KEY_ArrowDown");
      EventUtils.synthesizeKey("KEY_Enter");
    } else {
      const browser = tab.linkedBrowser;
      await SpecialPowers.spawn(browser, ["ca"], async value => {
        const input = content.document.querySelector(".search input");
        await ContentTaskUtils.waitForCondition(
          () => !!input.placeholder,
          "the page is answered"
        );
        input.focus();
        input.setUserInput(value);
        await ContentTaskUtils.waitForCondition(
          () =>
            content.document.querySelector(".suggestions li[data-kind='tab']"),
          "the open tab is listed"
        );
      });
      await BrowserTestUtils.synthesizeKey("KEY_ArrowDown", {}, browser);
      await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
    }
    await TestUtils.waitForCondition(
      () =>
        SvalPanel.workspaceId === home &&
        taggedId(gBrowser.selectedTab) === calendar,
      `${where}: the window shows Calendar in Home`
    );
    await TestUtils.waitForCondition(
      async () => !((await engine.tree()).nodes ?? {})[id],
      `${where}: the empty tab's node is gone`
    );
    Assert.ok(!gBrowser.tabs.includes(tab), `${where}: and so is the tab`);
    await assertNoHandOverFailure();
    // So the next round finds only its own Calendar.
    await removeWorkspace(home);
    await removeWorkspace(work);
  }
});

/**
 * One page open in two workspaces is two rows, each named with its
 * workspace.
 */
add_task(async function one_page_in_two_workspaces_is_two_rows() {
  const { engine, work, calendar } = await workAndHome();
  const workCalendar = await engine.mutate({
    kind: "addTab",
    parent: work,
    name: "Calendar",
    url: CALENDAR,
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  await SvalPanel.refresh();
  const rows = (await rowsFor("ca")).filter(
    r => r.result.payload.url === CALENDAR
  );
  Assert.deepEqual(
    rows.map(r => r.result.payload.svalNodeId),
    [workCalendar, calendar],
    "two rows, this workspace's first"
  );
  await untilRowSays(rows[0], { name: ["Calendar", "Work"] });
  await untilRowSays(rows[1], { name: ["Calendar", "Home"] });
  await UrlbarTestUtils.promisePopupClose(window);
  gURLBar.handleRevert();
});
