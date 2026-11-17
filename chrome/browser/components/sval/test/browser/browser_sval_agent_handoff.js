/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * Taking a tab from an agent (agent-control spec §5.4): a tab the user moves
 * out of the agent's workspace is theirs for good, however it moved and
 * whatever happens to it next. A take out of an isolated agent workspace
 * asks first, and Cancel hands the tab back.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);
const { TabStateFlusher } = ChromeUtils.importESModule(
  "resource:///modules/sessionstore/TabStateFlusher.sys.mjs"
);
const { createAgentTabs } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentTabs.sys.mjs"
);
const { isWithin, WORKSPACE } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTree.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * A tab the user takes and closes before its new window has filed it comes
 * back from undo-close under the user's workspace, never under the agent's
 * it was taken from.
 */
add_task(async function a_tab_taken_and_closed_at_once_comes_back_the_users() {
  const { tabs, agent, gate, call } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: PAGE2 });
  const found = await tabs.tabIn(agent, tab);
  const observer = SvalPanel.observer;
  const userWs = SvalPanel.workspaceId;
  const closedBefore = SessionStore.getClosedTabCountForWindow(window);

  // Taken into the user's window, and closed before the window files it
  // there: its refile is held until the tab has closed.
  const held = Promise.withResolvers();
  const refile = observer.refile;
  observer.refile = async (...args) => {
    await held.promise;
    return refile.apply(observer, args);
  };
  atTaskEnd(() => {
    held.resolve();
    delete observer.refile;
  });
  const taken = gBrowser.adoptTab(found.tab, { selectTab: false });
  const { browserId } = taken.linkedBrowser;
  await TabStateFlusher.flush(taken.linkedBrowser);
  gBrowser.removeTab(taken, { animate: false });
  await within(observer.settled(), 10_000, "observer settling");
  held.resolve();
  await within(observer.settled(), 10_000, "observer settling");
  await TestUtils.waitForCondition(
    () => gate.agentOf({ browserId }) === null,
    "the gate has let the taken tab go"
  );
  await TestUtils.waitForCondition(
    () => SessionStore.getClosedTabCountForWindow(window) > closedBefore,
    "Firefox keeps the closed tab"
  );
  // Into this window: undo-close otherwise picks the topmost one.
  const restored = SessionStore.undoCloseTab(window, 0, window);
  atTaskEnd(async () => {
    if (restored.isConnected && !restored.closing) {
      await BrowserTestUtils.removeTab(restored);
      await within(observer.settled(), 10_000, "observer settling");
    }
  });
  await TestUtils.waitForCondition(
    async () => (await SvalPanel.engine.tree()).nodes?.[tab],
    "the restored tab is filed"
  );
  await within(observer.settled(), 10_000, "observer settling");
  Assert.equal(observer.nodeIdFor(restored), tab, "it is the same node");
  Assert.equal(
    (await SvalPanel.engine.tree()).nodes[tab].placement?.parent,
    userWs,
    "it is restored under the user's workspace"
  );
  Assert.ok(
    !(await tabs.listTabs(agent.workspaceId)).some(t => t.tab === tab),
    "the agent's tab list does not have it"
  );
});

/**
 * An agent's page opens a tab, in the agent's window and watched.
 *
 * @param {object} setup What `agentSetup` returned.
 * @returns {Promise<{opener: object, openerNode: string, tab: object}>} The
 *   page's `<browser>` and node, and the tab it opened.
 */
async function aTabTheAgentsPageOpened(setup) {
  const { tabs, agent, gate, call, win } = setup;
  const { tab: openerNode } = await call("open_tab", { url: LINKS });
  const { browser: opener } = await tabs.tabIn(agent, openerNode);
  const opened = BrowserTestUtils.waitForEvent(
    win.gBrowser.tabContainer,
    "TabOpen"
  );
  await BrowserTestUtils.synthesizeMouseAtCenter("#allowed-tab", {}, opener);
  const tab = (await within(opened, 10_000, "the TabOpen event")).target;
  await within(
    BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, PAGE2),
    10_000,
    "the tab's load"
  );
  Assert.equal(
    gate.agentOf(tab.linkedBrowser)?.agentId,
    agent.agentId,
    "it is watched"
  );
  await within(
    win.SvalPanel.observer.settled(),
    10_000,
    "win.SvalPanel.observer settling"
  );
  return { opener, openerNode, tab };
}

/**
 * Switches agent access back on, which opens the listener with a new gate.
 *
 * @returns {Promise<{gate: object, tabs: object}>} The new gate, and tabs
 *   bound to it.
 */
async function reopenedGate() {
  await agentAccessForTask();
  const gate = SvalAgents.gate;
  return { gate, tabs: createAgentTabs({ engine: SvalPanel.engine, gate }) };
}

/**
 * Loads `url` in `browser` as the user would, and waits for it.
 *
 * @param {object} browser
 * @param {string} url
 */
async function userLoads(browser, url) {
  const loaded = BrowserTestUtils.browserLoaded(browser, false, url);
  BrowserTestUtils.startLoadingURIString(browser, url);
  await within(loaded, 10_000, "the tab's load");
}

/**
 * A tab the user took stays theirs after agent access is switched off and
 * on: the new gate does not reach it through the agent's page that opened
 * it.
 */
add_task(async function a_taken_tab_stays_the_users_across_a_new_gate() {
  const setup = await agentSetup({ sites: { "example.com": "full" } });
  const { agent, gate, win } = setup;
  const { openerNode, tab } = await aTabTheAgentsPageOpened(setup);
  const userWin = await newWindowAfter(() =>
    win.gBrowser.replaceTabWithWindow(tab)
  );
  const taken = userWin.gBrowser.selectedTab;
  await TestUtils.waitForCondition(
    () => gate.agentOf(taken.linkedBrowser) === null,
    "the tab is let go"
  );

  await agentAccessOff();
  const again = await reopenedGate();
  await again.tabs.tabIn(agent, openerNode);
  await userLoads(taken.linkedBrowser, PAGE);
  Assert.equal(
    again.gate.agentOf(taken.linkedBrowser),
    null,
    "the new gate does not watch the user's tab"
  );
});

/**
 * A tab the user drags out of the agent's window while agent access is off
 * is filed under the user's workspace all the same, and is the user's for
 * good once access is back on.
 */
add_task(async function a_tab_taken_with_access_off_is_the_users() {
  const setup = await agentSetup({ sites: { "example.com": "full" } });
  const { agent, win } = setup;
  const { openerNode, tab } = await aTabTheAgentsPageOpened(setup);
  const node = win.SvalPanel.observer.nodeIdFor(tab);
  const tree = async () => (await SvalPanel.engine.tree()).nodes ?? {};
  Assert.ok((await tree())[agent.workspaceId].agent, "the agent's mark");

  await agentAccessOff();
  const userWin = await newWindowAfter(() =>
    win.gBrowser.replaceTabWithWindow(tab)
  );
  const userWs = userWin.SvalPanel.workspaceId;
  Assert.notEqual(userWs, agent.workspaceId, "the user's window");
  const taken = userWin.gBrowser.selectedTab;
  await within(
    userWin.SvalPanel.observer.settled(),
    10_000,
    "userWin.SvalPanel.observer settling"
  );
  Assert.equal(userWin.SvalPanel.observer.nodeIdFor(taken), node);
  Assert.ok(
    isWithin(await tree(), node, userWs),
    "its node is filed under the user's workspace"
  );

  const again = await reopenedGate();
  Assert.ok(
    !(await again.tabs.listTabs(agent.workspaceId)).some(t => t.tab === node),
    "the agent's tab list does not have it"
  );
  await again.tabs.tabIn(agent, openerNode);
  await userLoads(taken.linkedBrowser, PAGE);
  Assert.equal(
    again.gate.agentOf(taken.linkedBrowser),
    null,
    "the new gate does not watch it"
  );
});

/**
 * Waits until the popup's page has loaded, so its links can be clicked. Its
 * address changes as the load commits, before the page is parsed.
 *
 * @param {Element} popup The popup's browser.
 */
async function popupLoaded(popup) {
  await pageReady(popup, ROOT + "sval_agent_popup.html");
  await SpecialPowers.spawn(popup, [], () =>
    ContentTaskUtils.waitForCondition(
      () => content.document.readyState === "complete",
      "the popup's page"
    )
  );
}

/**
 * A tab a page in an agent's popup opens goes to that agent's own window,
 * never to the frontmost one, which here is another agent's, and stays the
 * agent's: what the tab opens is still watched.
 */
add_task(async function a_tab_a_popup_opens_goes_to_its_agents_window() {
  const a = await agentSetup({ sites: { "example.com": "full" } });
  const b = await agentSetup({ sites: { "example.com": "full" } });
  const { tab } = await a.call("open_tab", { url: LINKS });
  const { browser } = await a.tabs.tabIn(a.agent, tab);
  const popupWin = await newWindowAfter(() =>
    BrowserTestUtils.synthesizeMouseAtCenter("#link-popup", {}, browser)
  );
  const popup = popupWin.gBrowser.selectedBrowser;
  await popupLoaded(popup);

  // Firefox would put a popup's new tab in the frontmost full window: agent
  // B's.
  await within(SimpleTest.promiseFocus(b.win), 10_000, "the window's focus");
  const bTabs = b.win.gBrowser.tabs.length;
  const inA = BrowserTestUtils.waitForEvent(
    a.win.gBrowser.tabContainer,
    "TabOpen"
  );
  await BrowserTestUtils.synthesizeMouseAtCenter("#out", {}, popup);
  const moved = (await within(inA, 10_000, "the TabOpen event")).target;
  Assert.equal(b.win.gBrowser.tabs.length, bTabs, "B's window got nothing");
  Assert.equal(Services.focus.activeWindow, b.win, "and kept the focus");
  await TestUtils.waitForCondition(
    () => a.gate.agentOf(moved.linkedBrowser)?.agentId === a.agent.agentId,
    "the tab is agent A's"
  );
  await within(
    BrowserTestUtils.browserLoaded(moved.linkedBrowser, false, LINKS),
    10_000,
    "the tab's load"
  );
  await within(
    a.win.SvalPanel.observer.settled(),
    10_000,
    "a.win.SvalPanel.observer settling"
  );
  const node = a.win.SvalPanel.observer.nodeIdFor(moved);
  Assert.ok(
    isWithin((await SvalPanel.engine.tree()).nodes, node, a.agent.workspaceId),
    "it is filed under A's workspace"
  );

  const child = BrowserTestUtils.waitForEvent(
    a.win.gBrowser.tabContainer,
    "TabOpen"
  );
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#allowed-tab",
    {},
    moved.linkedBrowser
  );
  const opened = (await within(child, 10_000, "the TabOpen event")).target;
  await within(
    BrowserTestUtils.browserLoaded(opened.linkedBrowser, false, PAGE2),
    10_000,
    "the tab's load"
  );
  Assert.equal(
    a.gate.agentOf(opened.linkedBrowser)?.agentId,
    a.agent.agentId,
    "the tab it opens is watched"
  );
});

/**
 * A tab the user opens from a link in an agent's popup, with a middle click,
 * opens in that agent's own window, in the background, and is that agent's.
 * Firefox would open it in the frontmost full window, here another agent's:
 * neither that window, the user's, nor any other workspace ever has it.
 */
add_task(async function a_tab_the_user_opens_from_a_popup_stays_its_agents() {
  const a = await agentSetup({ sites: { "example.com": "full" } });
  const b = await agentSetup({ sites: { "example.com": "full" } });
  const { tab } = await a.call("open_tab", { url: LINKS });
  const { browser } = await a.tabs.tabIn(a.agent, tab);
  const popupWin = await newWindowAfter(() =>
    BrowserTestUtils.synthesizeMouseAtCenter("#link-popup", {}, browser)
  );
  const popup = popupWin.gBrowser.selectedBrowser;
  await popupLoaded(popup);
  await within(SimpleTest.promiseFocus(b.win), 10_000, "B's window's focus");
  const selectedInA = a.win.gBrowser.selectedTab;
  const strays = strayNodes(a.agent);
  const inA = tabsOpenedIn(a.win);
  const inB = tabsOpenedIn(b.win);
  const inUsers = tabsOpenedIn(window);
  await within(SimpleTest.promiseFocus(popupWin), 10_000, "the popup's focus");
  await BrowserTestUtils.synthesizeMouseAtCenter("#out", { button: 1 }, popup);
  await TestUtils.waitForCondition(
    () => inA.length,
    "a tab opens in A's window"
  );
  const opened = inA[0];
  await pageReady(opened, LINKS);
  Assert.equal(a.gate.agentOf(opened)?.agentId, a.agent.agentId, "it is A's");
  Assert.notEqual(
    b.gate.agentOf(opened)?.agentId,
    b.agent.agentId,
    "and not B's"
  );
  Assert.equal(a.win.gBrowser.selectedTab, selectedInA, "in the background");
  await within(
    a.win.SvalPanel.observer.settled(),
    10_000,
    "a.win.SvalPanel.observer settling"
  );
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  Assert.equal(inB.length, 0, "B's window never had it");
  Assert.equal(inUsers.length, 0, "nor the user's");
  Assert.deepEqual(strays, [], "no node was written outside A's workspace");
});

/**
 * The Sval dialog this window shows, once it has drawn its buttons.
 *
 * @returns {Promise<Document>}
 */
async function jarQuestion() {
  let dialog;
  await TestUtils.waitForCondition(() => {
    dialog = gDialogBox.dialog;
    return dialog && !dialog._isClosing;
  }, "Sval asks");
  await dialogShown(dialog, "the dialog's load");
  const doc = dialog._frame.contentDocument;
  await TestUtils.waitForCondition(
    () => doc.querySelector('[data-button="ok"]'),
    "the dialog has drawn its buttons"
  );
  return doc;
}

/**
 * Drags the agent's tab into this window, the user's, and waits for the jar
 * question, which stays up until the test answers it.
 *
 * @returns {Promise<object>} `{ agentJar, answer, browserId, win, ws }`;
 *   `answer(ok)` presses Move or Cancel.
 */
async function takeFromIsolatedAgent() {
  const { tabs, agent, call, win, ws } = await agentSetup({
    sites: { "example.com": "full" },
    isolated: true,
  });
  const { tab } = await call("open_tab", { url: PAGE2 });
  const found = await tabs.tabIn(agent, tab);
  const agentJar = found.tab.userContextId;
  Assert.notEqual(agentJar, 0, "the agent's tab is in a jar of its own");
  const { browserId } = found.tab.linkedBrowser;
  const taken = gBrowser.adoptTab(found.tab, { selectTab: false });
  const doc = await jarQuestion();
  atTaskEnd(() => closeLeftoverDialog());
  const here = SvalPanel.nodes[SvalPanel.workspaceId];
  Assert.stringContains(
    doc.getElementById("sval-dialog-title").textContent,
    here?.content?.name || SvalPanel._untitled(WORKSPACE),
    "Sval asks before moving the tab across jars into this workspace"
  );
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  Assert.equal(
    taken.userContextId,
    agentJar,
    "and until the answer the tab stays in the agent's jar"
  );
  Assert.equal(
    taken.linkedBrowser.currentURI.spec,
    PAGE2,
    "on the page it showed"
  );
  const answer = async ok => {
    const button = doc.querySelector(`[data-button="${ok ? "ok" : "cancel"}"]`);
    await TestUtils.waitForCondition(
      () => !button.disabled,
      "it can be answered"
    );
    button.click();
  };
  return { agentJar, answer, browserId, taken, tab, win, ws };
}

add_task(async function cancelling_a_take_across_jars_hands_the_tab_back() {
  const { agentJar, answer, browserId, tab, win, ws } =
    await takeFromIsolatedAgent();
  await answer(false);
  await TestUtils.waitForCondition(
    () => win.gBrowser.tabs.some(t => t.linkedBrowser?.browserId === browserId),
    "Cancel hands the tab back to the agent's window"
  );
  const back = win.gBrowser.tabs.find(
    t => t.linkedBrowser.browserId === browserId
  );
  Assert.equal(back.userContextId, agentJar, "in the agent's jar");
  Assert.equal(back.linkedBrowser.currentURI.spec, PAGE2, "as it was");
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  Assert.ok(
    isWithin((await SvalPanel.engine.tree()).nodes, tab, ws),
    "and still the agent's"
  );
});

add_task(async function a_take_across_jars_moves_once_asked() {
  const { agentJar, answer, tab } = await takeFromIsolatedAgent();
  const userWs = SvalPanel.workspaceId;
  await answer(true);
  await TestUtils.waitForCondition(() => {
    const mine = gBrowser.tabs.find(
      t => SvalPanel.observer.nodeIdFor(t) === tab
    );
    return mine && mine.userContextId !== agentJar;
  }, "Move reopens the tab in the user's jar");
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  Assert.ok(
    isWithin((await SvalPanel.engine.tree()).nodes, tab, userWs),
    "under the user's workspace"
  );
  const mine = gBrowser.tabs.find(t => SvalPanel.observer.nodeIdFor(t) === tab);
  atTaskEnd(() => BrowserTestUtils.removeTab(mine));
  expectOpened(mine);
});
