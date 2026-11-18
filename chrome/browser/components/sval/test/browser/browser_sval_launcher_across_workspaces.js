/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * Alt+Enter on an open tab of another workspace, where it would cross a
 * boundary (launcher spec §3, §6). A tab of an agent's workspace never joins
 * the user's split: Alt+Enter goes to it, as Enter does. A tab that would
 * move into another cookie jar asks first, as Move this tab to… does, and
 * Cancel leaves everything as it was. `browser_sval_launcher_agent_commands.js`
 * covers Alt+Enter in an agent's window.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);

add_setup(failOnConsoleErrors);

add_setup(async function () {
  await PlacesUtils.history.clear();
  registerCleanupFunction(async () => {
    // Firefox records the first split it shows, as its own tests clear.
    Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed");
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      await UrlbarTestUtils.promisePopupClose(win);
      win.gURLBar.handleRevert();
    }
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
 * Two workspaces, Work and Home, with this window on Work showing its tab,
 * and an agent's workspace holding a tab "Atlas", shown in a window of its
 * own.
 *
 * @returns {Promise<object>} `withSwitcherTabs`' result, plus `work`,
 *   `home`, `shownId`, the node of the tab this window shows, `agentWs`,
 *   `atlas`, its tab's node, and `agentWin`.
 */
async function withAgentWindow() {
  const fixture = await withSwitcherTabs({ names: ["Work", "Home"] });
  const [work, home] = fixture.ids.workspaces;
  const { engine } = fixture;
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
  const shownId = taggedId(gBrowser.selectedTab);
  const agentWin = await tearOff(agentWs);
  expectWorkspaceTabs(agentWin);
  atTaskEnd(async () => {
    if (!agentWin.closed) {
      await within(
        BrowserTestUtils.closeWindow(agentWin),
        10_000,
        "the agent's window closing"
      );
    }
  });
  await untilRestored(agentWin.gBrowser.selectedTab);
  return { ...fixture, work, home, shownId, agentWs, atlas, agentWin };
}

/**
 * Types `value` into `win`'s address bar and waits for its rows.
 *
 * @param {Window} win
 * @param {string} value
 * @returns {Promise<object[]>} `{ result, element }` per row.
 */
async function rowsFor(win, value) {
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
 * The l10n ids of the line under the list, once its words are in.
 *
 * @param {Window} win
 * @returns {Promise<string[]>}
 */
async function footItems(win) {
  const line = win.gURLBar.querySelector(".sval-launcher-foot");
  await TestUtils.waitForCondition(
    () =>
      line.children.length &&
      [...line.querySelectorAll("[data-l10n-id]")].every(el => el.textContent),
    "the line's words"
  );
  return [...line.querySelectorAll("[data-l10n-id]")].map(el =>
    el.getAttribute("data-l10n-id")
  );
}

/**
 * The tabs of the split `win` shows, by node.
 *
 * @param {Window} win
 * @returns {string[]}
 */
function shownSplit(win) {
  return (win.gBrowser.selectedTab.splitview?.tabs ?? []).map(taggedId);
}

/**
 * @param {object} engine
 * @param {string} id A tab's node.
 * @returns {Promise<string|undefined>} the node it is placed under.
 */
async function parentOf(engine, id) {
  return (await engine.tree()).nodes?.[id]?.placement?.parent;
}

/**
 * Answers the next Sval dialog this window opens with its Move or its Cancel
 * button (`SvalDialog`'s `ok` and `cancel`).
 *
 * @param {boolean} ok
 * @returns {Promise<string>} the dialog's title.
 */
async function answerDialog(ok) {
  const doc = await dialogDocument('.sval-dialog-btn[data-button="ok"]');
  const title = doc.querySelector(".sval-dialog-title").textContent;
  doc
    .querySelector(`.sval-dialog-btn[data-button="${ok ? "ok" : "cancel"}"]`)
    .click();
  return title;
}

/**
 * In the user's window, Alt+Enter on an agent's tab offers no split and
 * goes to the agent's window, as Enter does; the tab stays the agent's.
 */
add_task(async function alt_enter_on_an_agents_tab_goes_to_it() {
  const { engine, work, shownId, agentWs, atlas, agentWin } =
    await withAgentWindow();
  window.focus();
  await untilFocused(window, "this window has the focus");
  const [, top] = await rowsFor(window, "atl");
  Assert.equal(top.result.payload.svalNodeId, atlas, "the agent's tab");
  EventUtils.synthesizeKey("KEY_ArrowDown", {}, window);
  Assert.ok(
    !(await footItems(window)).some(id => id.startsWith("launcher-foot-split")),
    "the line offers no split"
  );
  EventUtils.synthesizeKey("KEY_Enter", { altKey: true }, window);
  await untilFocused(agentWin, "the agent's window comes forward");
  Assert.equal(await parentOf(engine, atlas), agentWs, "the tab stays");
  Assert.equal(SvalWindowWorkspace.of(window).id, work, "this window stays");
  Assert.deepEqual(shownSplit(window), [], "in no split");
  Assert.equal(taggedId(gBrowser.selectedTab), shownId, "on its tab");
});

/**
 * Alt+Enter on a tab of an isolated workspace asks first, naming the
 * workspace it would move to. Cancel leaves the tab where it was and this
 * window as it was; Move splits this tab with it.
 */
add_task(async function alt_enter_into_another_jar_asks_first() {
  const fixture = await withSwitcherTabs({ names: ["Work", "Home"] });
  const { engine } = fixture;
  const [work, home] = fixture.ids.workspaces;
  await engine.mutate({
    kind: "setIsolation",
    id: home,
    isolated: true,
    now: Date.now(),
  });
  const calendar = await engine.mutate({
    kind: "addTab",
    parent: home,
    name: "Calendar",
    url: titled("Calendar"),
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  await SvalPanel.refresh();
  const shownId = taggedId(gBrowser.selectedTab);

  const [, top] = await rowsFor(window, "ca");
  Assert.equal(
    top.result.payload.svalNodeId,
    calendar,
    "Calendar follows the search"
  );
  EventUtils.synthesizeKey("KEY_ArrowDown");
  EventUtils.synthesizeKey("KEY_Enter", { altKey: true });
  const title = await within(answerDialog(false), 10_000, "Alt+Enter asking");
  Assert.ok(title.includes("Work"), "naming Work");
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  Assert.equal(await parentOf(engine, calendar), home, "Cancel moves nothing");
  Assert.equal(SvalWindowWorkspace.of(window).id, work, "this window stays");
  Assert.equal(taggedId(gBrowser.selectedTab), shownId, "on its tab");
  Assert.deepEqual(shownSplit(window), [], "in no split");

  await rowsFor(window, "ca");
  EventUtils.synthesizeKey("KEY_ArrowDown");
  EventUtils.synthesizeKey("KEY_Enter", { altKey: true });
  await within(answerDialog(true), 10_000, "Alt+Enter asking again");
  await TestUtils.waitForCondition(
    () =>
      JSON.stringify(shownSplit(window)) ===
      JSON.stringify([shownId, calendar]),
    "Move splits this tab with Calendar"
  );
});
