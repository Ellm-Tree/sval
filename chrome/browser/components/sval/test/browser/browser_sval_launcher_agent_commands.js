/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_take_control_helpers.js */

/**
 * The Launcher in an agent's window the user has taken (launcher spec §4,
 * §6): Give workspace back does what the bar's button does, announcement
 * included, and no Take control is offered. Move this tab to… is not offered
 * there, as Rename workspace is not; Split with… is. Alt+Enter on a tab of
 * the user's goes to it, as Enter does, and never splits it into the
 * agent's workspace. Go to a workspace does what the panel's switcher does
 * there. `browser_sval_launcher_commands.js` covers the other commands.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_take_control_helpers.js",
  this
);

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);
const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * Types `value` into `win`'s address bar and answers its command rows.
 *
 * @param {Window} win
 * @param {string} value
 * @returns {Promise<object[]>} `{ i, commandId }` per row of a command.
 */
async function commandsFor(win, value) {
  await within(
    UrlbarTestUtils.promiseAutocompleteResultPopup({ window: win, value }),
    10_000,
    "the address bar's results"
  );
  const rows = [];
  for (let i = 0; i < UrlbarTestUtils.getResultCount(win); i++) {
    const { result } = await UrlbarTestUtils.getDetailsOfResultAt(win, i);
    if (result.payload.commandId) {
      rows.push({ i, commandId: result.payload.commandId });
    }
  }
  return rows;
}

/**
 * Selects the row of command `id` with the arrow keys and presses Enter.
 *
 * @param {Window} win
 * @param {object[]} rows From {@link commandsFor}.
 * @param {string} id
 */
function enterOn(win, rows, id) {
  const row = rows.find(r => r.commandId === id);
  Assert.ok(row, `${id} is listed`);
  for (
    let left = UrlbarTestUtils.getResultCount(win);
    left && UrlbarTestUtils.getSelectedRowIndex(win) !== row.i;
    left--
  ) {
    EventUtils.synthesizeKey("KEY_ArrowDown", {}, win);
  }
  EventUtils.synthesizeKey("KEY_Enter", {}, win);
}

/**
 * @param {Window} win
 * @returns {?string} What the window's live region last said, as its state.
 */
function announced(win) {
  return (
    win.document.querySelector(".sval-agent-announcer")?.dataset.state ?? null
  );
}

/**
 * Give workspace back, from the Launcher, gives it back as the bar's button
 * does, and a screen reader hears it.
 */
add_task(async function give_back_from_the_launcher() {
  const { win, browser } = await layerSetup();
  await takeControlOf(win, browser);
  const rows = await commandsFor(win, "give back");
  Assert.ok(!rows.some(r => r.commandId === "take-control"), "no Take control");
  enterOn(win, rows, "give-back");
  await TestUtils.waitForCondition(
    () => !isUserInControl(browser.browsingContext.browserId),
    "the agent controls the workspace again"
  );
  Assert.equal(announced(win), "agent", "the agent is said to control it");
});

/** Move this tab to… is not offered in an agent's window; Split with… is. */
add_task(async function an_agents_window_offers_no_move() {
  const { win, call } = await layerSetup();
  await call("open_tab", { url: PAGE });
  await takeControlOf(win, win.gBrowser.selectedBrowser);
  const ids = (await commandsFor(win, "move")).map(r => r.commandId);
  Assert.ok(!ids.includes("move-tab"), "no Move this tab to…");
  Assert.ok(
    (await commandsFor(win, "split with")).some(
      r => r.commandId === "split-with"
    ),
    "Split with… is listed"
  );
  await UrlbarTestUtils.promisePopupClose(win);
  await giveBackFrom(win, win.gBrowser.selectedBrowser);
});

/**
 * Types `value` into `win`'s address bar and answers its rows.
 *
 * @param {Window} win
 * @param {string} value
 * @returns {Promise<object[]>} `{ result, element }` per row.
 */
async function rowsIn(win, value) {
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
 * The line under the list, as the Fluent ids of its words.
 *
 * @param {Window} win
 * @returns {Promise<string[]>}
 */
async function footItems(win) {
  const line = win.gURLBar.querySelector(".sval-launcher-foot");
  await TestUtils.waitForCondition(
    () => line.children.length,
    "the line's items"
  );
  return [...line.querySelectorAll("[data-l10n-id]")].map(
    el => el.dataset.l10nId
  );
}

/**
 * Alt+Enter on a tab of the user's goes to it in the user's window, as Enter
 * does: the tab stays in the user's workspace, and the agent's window keeps
 * its tab, in no split.
 */
add_task(async function alt_enter_on_a_users_tab_goes_to_it() {
  const { win, browser, ws } = await layerSetup();
  const users = SvalWindowWorkspace.of(window).id;
  const viewed = gBrowser.selectedTab;
  const page = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE2),
    10_000,
    "a tab of the user's opening"
  );
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  const id = taggedId(page);
  await selectTab(viewed);
  // The agent's window reads the tree as a pass would bring it the tab.
  await win.SvalPanel.refresh();

  win.focus();
  await within(SimpleTest.promiseFocus(win), 10_000, "the agent's window");
  await takeControlOf(win, browser);
  const [, top] = await rowsIn(win, "second");
  Assert.equal(
    top.result.payload.svalNodeId,
    id,
    "the user's tab follows the search"
  );
  EventUtils.synthesizeKey("KEY_ArrowDown", {}, win);
  Assert.ok(
    !(await footItems(win)).some(item =>
      item.startsWith("launcher-foot-split")
    ),
    "the line offers no split"
  );
  EventUtils.synthesizeKey("KEY_Enter", { altKey: true }, win);
  await TestUtils.waitForCondition(
    () =>
      Services.focus.activeWindow === window && gBrowser.selectedTab === page,
    "the user's window shows the tab"
  );
  const nodes = (await SvalPanel.engine.tree()).nodes ?? {};
  Assert.equal(nodes[id].placement.parent, users, "the tab stays the user's");
  Assert.equal(SvalWindowWorkspace.of(win).id, ws, "the agent's window stays");
  Assert.ok(!win.gBrowser.selectedTab.splitview, "in no split");
  await giveBackFrom(win, browser);
});

/**
 * The switcher of an agent's window lists the user's workspaces and goes to
 * one there, so Go to a workspace does too.
 */
add_task(async function go_to_a_workspace_is_the_switchers() {
  const { win, browser, ws } = await layerSetup();
  const engine = SvalPanel.engine;
  const trips = await engine.mutate({
    kind: "addWorkspace",
    name: "Trips",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  atTaskEnd(async () => {
    if (!win.closed && SvalWindowWorkspace.of(win).id === trips) {
      await win.SvalPanel.switchTo(ws);
    }
    await engine.mutate({ kind: "remove", id: trips, now: Date.now() });
    await SvalPanel.refresh();
  });
  await SvalPanel.refresh();
  await win.SvalPanel.refresh();
  await takeControlOf(win, browser);
  Assert.ok(
    win.SvalPanel.switcherList().some(item => item.id === trips),
    "the switcher lists Trips"
  );
  const rows = await rowsIn(win, "go to trips");
  const row = rows.find(r => r.result.payload.commandId === "go-to-workspace");
  Assert.equal(row?.result.payload.choiceId, trips, "Go to Trips is listed");
  for (
    let left = UrlbarTestUtils.getResultCount(win);
    left && UrlbarTestUtils.getSelectedRowIndex(win) !== rows.indexOf(row);
    left--
  ) {
    EventUtils.synthesizeKey("KEY_ArrowDown", {}, win);
  }
  EventUtils.synthesizeKey("KEY_Enter", {}, win);
  await TestUtils.waitForCondition(
    () => SvalWindowWorkspace.of(win).id === trips,
    "the agent's window goes to Trips, as its switcher does"
  );
});
