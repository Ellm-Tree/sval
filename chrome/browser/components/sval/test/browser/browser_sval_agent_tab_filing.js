/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_agent_sites_helpers.js */

/**
 * Where an agent's tabs are filed (agent-control spec §5.2, §5.4): a tab its
 * page opens lands in the agent's own window and workspace, which is never a
 * popup, and a tab that cannot be filed is closed. A tab the user takes into
 * their own workspace is theirs for good, and a tab open in the user's window
 * is never the agent's.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_agent_sites_helpers.js",
  this
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * Firefox would send a tab a popup opens to the frontmost full window, which
 * is usually the user's. A tab an agent's popup opens goes straight to the
 * agent's own window instead, in the background, with its opener.
 */
add_task(async function a_tab_from_an_agent_popup_lands_in_its_workspace() {
  const { tabs, agent, gate, call, win } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: LINKS });
  const { browser } = await tabs.tabIn(agent, tab);
  const popupWin = await newWindowAfter(() => clickIn(browser, "#link-popup"));
  await within(popupWin.SvalPanel.started, 10_000, "the panel's startup");
  const popupTab = popupWin.gBrowser.selectedTab;
  const popupURL = ROOT + "sval_agent_popup.html";
  await committed(popupTab.linkedBrowser, popupURL);
  let popupNode;
  await TestUtils.waitForCondition(() => {
    popupNode = popupWin.SvalPanel.observer?.nodeIdFor(popupTab);
    return popupNode;
  }, "the popup's tab is filed");
  const userAlerts = countAlerts(window);

  // A `_blank` link (no opener, `crossGroupOpener` only), then
  // `window.open` (an opener the page can use).
  for (const [pattern, withOpener] of [
    [/link "Links in a new tab" \[(e\d+)\]/, false],
    [/button "Opener" \[(e\d+)\]/, true],
  ]) {
    await within(SimpleTest.promiseFocus(window), 10_000, "the window's focus");
    const inUsers = tabsOpenedIn(window);
    const inAgents = tabsOpenedIn(win);
    const ref = await refFor(call, popupNode, pattern);
    await call("click_element", { tab: popupNode, ref });
    let moved;
    await TestUtils.waitForCondition(() => {
      moved = inAgents.find(
        b => b.browserId && gate.agentOf(b)?.agentId === agent.agentId
      );
      return moved;
    }, "the tab opened in the agent's window");
    Assert.equal(inUsers.length, 0, "the user's window never had it");
    Assert.notEqual(
      win.gBrowser.selectedBrowser,
      moved,
      "it opened in the background"
    );
    await committed(moved, LINKS);
    Assert.equal(
      moved.browsingContext.crossGroupOpener?.browserId,
      popupTab.linkedBrowser.browserId,
      "crossGroupOpener survives the move"
    );
    if (withOpener) {
      Assert.ok(
        await SpecialPowers.spawn(moved, [], () => !!content.opener),
        "window.opener survives the move"
      );
    }
    const movedTab = win.gBrowser.getTabForBrowser(moved);
    let node;
    await TestUtils.waitForCondition(() => {
      node = win.SvalPanel.observer.nodeIdFor(movedTab);
      return node;
    }, "the moved tab is filed");
    await TestUtils.waitForCondition(
      async () =>
        (await tabs.listTabs(agent.workspaceId)).some(t => t.tab === node),
      "the agent's tab list has it"
    );
  }
  Assert.equal(userAlerts.opened, 0, "no alert in the user's window");
});

/**
 * Records every browser window that opens until the task ends.
 *
 * @returns {Window[]}
 */
function windowsOpening() {
  const opened = [];
  const observer = (subject, topic) => {
    if (topic === "domwindowopened") {
      opened.push(subject);
    }
  };
  Services.ww.registerNotification(observer);
  atTaskEnd(() => Services.ww.unregisterNotification(observer));
  return opened;
}

/**
 * Under `browser.link.open_newwindow` 2 a `_blank` link opens a window. One
 * in an agent's page opens no window: its tab opens in the background of
 * the agent's own window, and no node of it is ever written under a
 * workspace of the user's. Sval locks the pref at 3, and a page asks for the
 * same featureless window while the user holds Shift
 * (`nsWindowWatcher::IsWindowOpenLocationModified`), which an agent's click
 * cannot, so the pref stands in for it here.
 */
add_task(async function a_link_that_would_open_a_window_opens_a_tab() {
  Services.prefs.unlockPref("browser.link.open_newwindow");
  await SpecialPowers.pushPrefEnv({
    set: [["browser.link.open_newwindow", 2]],
  });
  atTaskEnd(async () => {
    await SpecialPowers.popPrefEnv();
    Services.prefs.lockPref("browser.link.open_newwindow");
  });
  const { tabs, agent, gate, call, win } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: LINKS });
  const inAgents = tabsOpenedIn(win);
  const ref = await refFor(
    call,
    tab,
    /link "Allowed site in a new tab" \[(e\d+)\]/
  );
  const strays = strayNodes(agent);
  const windows = windowsOpening();
  const selected = win.gBrowser.selectedBrowser;
  await call("click_element", { tab, ref });
  let opened;
  await TestUtils.waitForCondition(() => {
    opened = inAgents.find(
      b => b.browserId && gate.agentOf(b)?.agentId === agent.agentId
    );
    return opened?.currentURI.spec === PAGE2;
  }, "the page's new tab loaded in the agent's window");
  Assert.equal(win.gBrowser.selectedBrowser, selected, "in the background");
  let node;
  await TestUtils.waitForCondition(async () => {
    node = win.SvalPanel.observer.nodeIdFor(
      win.gBrowser.getTabForBrowser(opened)
    );
    return (
      node && (await tabs.listTabs(agent.workspaceId)).some(t => t.tab === node)
    );
  }, "the agent's tab list has it");
  Assert.deepEqual(windows, [], "no window opened");
  Assert.deepEqual(
    strays.filed,
    [{ id: node, parent: agent.workspaceId }],
    "its node was written under the agent's workspace"
  );
  Assert.deepEqual(strays, [], "and none for a workspace of the user's");
});

/** The agent's tabs never open in a popup, even when only a popup shows its workspace. */
add_task(async function the_agents_window_is_never_a_popup() {
  const { tabs, agent, call, win } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: LINKS });
  const { browser } = await tabs.tabIn(agent, tab);
  const popupWin = await newWindowAfter(() =>
    clickIn(browser, "#allowed-popup")
  );
  await within(popupWin.SvalPanel.started, 10_000, "the panel's startup");
  Assert.equal(SvalWindowWorkspace.of(popupWin).id, agent.workspaceId);
  await within(BrowserTestUtils.closeWindow(win), 10_000, "the window closing");
  Assert.equal(
    await tabs.windowFor(agent.workspaceId),
    null,
    "a popup is no window for the agent's tabs"
  );
  const opened = await tabs.windowFor(agent.workspaceId, { open: true });
  Assert.notEqual(opened, popupWin);
  Assert.ok(opened.toolbar.visible, "a full window was opened");
});

/**
 * With the agent's own window closed, a tab its popup opens never lands in
 * the user's window, where Firefox would put it: it opens in a new window,
 * which shows the agent's workspace, and no node of it is ever written
 * under a workspace of the user's.
 */
add_task(async function a_popups_tab_opens_a_window_of_the_agents_own() {
  const { tabs, agent, gate, call, win } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: LINKS });
  const { browser } = await tabs.tabIn(agent, tab);
  const popupWin = await newWindowAfter(() => clickIn(browser, "#link-popup"));
  const popupTab = popupWin.gBrowser.selectedTab;
  const popupURL = ROOT + "sval_agent_popup.html";
  // Loaded, and not only navigated: the snapshot below reads its links.
  await TestUtils.waitForCondition(
    () =>
      popupTab.linkedBrowser.currentURI.spec === popupURL &&
      !popupTab.linkedBrowser.webProgress.isLoadingDocument,
    "the popup loaded"
  );
  let popupNode;
  await TestUtils.waitForCondition(() => {
    popupNode = popupWin.SvalPanel.observer?.nodeIdFor(popupTab);
    return popupNode;
  }, "the popup's tab is filed");
  const ref = await refFor(
    call,
    popupNode,
    /link "Links in a new tab" \[(e\d+)\]/
  );
  await within(BrowserTestUtils.closeWindow(win), 10_000, "the window closing");
  await within(SimpleTest.promiseFocus(window), 10_000, "the window's focus");

  const strays = strayNodes(agent);
  const inUsers = tabsOpenedIn(window);
  const agentWin = await newWindowAfter(() =>
    call("click_element", { tab: popupNode, ref })
  );
  Assert.ok(agentWin.toolbar.visible, "a full window opened");
  Assert.equal(
    SvalWindowWorkspace.of(agentWin).id,
    agent.workspaceId,
    "showing the agent's workspace"
  );
  let opened;
  await TestUtils.waitForCondition(() => {
    opened = agentWin.gBrowser.browsers.find(
      b =>
        b.browsingContext?.crossGroupOpener?.browserId ===
        popupTab.linkedBrowser.browserId
    );
    return opened?.currentURI.spec === LINKS;
  }, "the popup's tab loaded in it");
  Assert.equal(
    gate.agentOf(opened)?.agentId,
    agent.agentId,
    "and is the agent's"
  );
  let node;
  await TestUtils.waitForCondition(async () => {
    node = agentWin.SvalPanel.observer.nodeIdFor(
      agentWin.gBrowser.getTabForBrowser(opened)
    );
    return (
      node && (await tabs.listTabs(agent.workspaceId)).some(t => t.tab === node)
    );
  }, "the agent's tab list has it");
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  Assert.equal(inUsers.length, 0, "the user's window never had it");
  Assert.deepEqual(
    strays,
    [],
    "no node was written for a workspace of the user's"
  );
});

/**
 * A tab an agent's popup asks for that the agent's own window cannot take
 * opens nowhere else: no window opens for it, and neither the user's window
 * nor any workspace of the user's ever has it.
 */
add_task(async function a_tab_the_agents_window_cannot_take_opens_nowhere() {
  const { tabs, agent, call, win } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: LINKS });
  const { browser } = await tabs.tabIn(agent, tab);
  const popupWin = await newWindowAfter(() => clickIn(browser, "#link-popup"));
  const popup = popupWin.gBrowser.selectedBrowser;
  await committed(popup, ROOT + "sval_agent_popup.html");
  const real = win.browserDOMWindow;
  win.browserDOMWindow = null;
  atTaskEnd(() => (win.browserDOMWindow = real));
  const strays = strayNodes(agent);
  const windows = windowsOpening();
  const inUsers = tabsOpenedIn(window);
  const inAgents = tabsOpenedIn(win);
  const got = await SpecialPowers.spawn(
    popup,
    [],
    () => !!content.open("sval_agent_page2.html")
  );
  Assert.ok(!got, "the page's open failed");
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  Assert.deepEqual(windows, [], "no window opened");
  Assert.equal(inUsers.length, 0, "the user's window never had it");
  Assert.equal(inAgents.length, 0, "and the agent's window did not take it");
  Assert.deepEqual(
    strays,
    [],
    "no node was written for a workspace of the user's"
  );
});

/**
 * A tab an agent's popup opens by a way the gate does not route, such as a
 * chrome feature handing `addTab` the page as its opener, is closed where
 * it landed: the user's window does not keep it, and no workspace of the
 * user's gets a node for it.
 */
add_task(async function a_tab_landing_outside_the_agents_workspace_closes() {
  const { tabs, agent, call } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: LINKS });
  const { browser } = await tabs.tabIn(agent, tab);
  const popupWin = await newWindowAfter(() => clickIn(browser, "#link-popup"));
  const popup = popupWin.gBrowser.selectedBrowser;
  await committed(popup, ROOT + "sval_agent_popup.html");
  const strays = strayNodes(agent);
  const closing = BrowserTestUtils.waitForEvent(
    gBrowser.tabContainer,
    "TabClose"
  );
  const opened = gBrowser.addTab(PAGE2, {
    openerBrowser: popup,
    inBackground: true,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  const closed = await within(closing, 10_000, "a tab closing");
  Assert.equal(closed.target, opened, "the tab the page opened closed");
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  Assert.ok(!gBrowser.tabs.includes(opened), "the user's window lost it");
  Assert.deepEqual(
    strays,
    [],
    "no node was written for a workspace of the user's"
  );
});

/**
 * A tab the user tears off into a window of their own lands in their
 * workspace, and is theirs: no agent's policy governs it from then on.
 */
add_task(async function a_tab_torn_off_into_the_users_workspace_is_let_go() {
  const { tabs, agent, store, gate, call } = await agentSetup({
    sites: { "example.com": "full", "example.org": "blocked" },
  });
  const { tab } = await call("open_tab", { url: LINKS });
  const found = await tabs.tabIn(agent, tab);
  const windowOpened = BrowserTestUtils.domWindowOpenedAndLoaded();
  found.win.gBrowser.replaceTabWithWindow(found.tab);
  const userWin = await within(windowOpened, 10_000, "a window opening");
  atTaskEnd(async () => {
    if (!userWin.closed) {
      await within(
        BrowserTestUtils.closeWindow(userWin),
        10_000,
        "the window closing"
      );
    }
  });
  await within(userWin.SvalPanel.started, 10_000, "the panel's startup");
  Assert.notEqual(
    SvalWindowWorkspace.of(userWin).id,
    agent.workspaceId,
    "the new window shows the user's workspace"
  );
  const moved = userWin.gBrowser.selectedBrowser;
  await TestUtils.waitForCondition(
    () => gate.agentOf(moved) === null,
    "the tab is let go"
  );
  const alerts = countAlerts(userWin);
  const before = structuredClone(store.policyOf(agent.agentId));

  let loaded = BrowserTestUtils.browserLoaded(moved, false, "about:license");
  loadPastLayer(moved, "about:license");
  await within(loaded, 10_000, "the tab's load");
  loaded = BrowserTestUtils.browserLoaded(moved, false, ORG_PAGE);
  loadPastLayer(moved, ORG_PAGE);
  await within(loaded, 10_000, "the tab's load");
  loaded = BrowserTestUtils.browserLoaded(moved, false, NET_PAGE);
  loadPastLayer(moved, NET_PAGE);
  await within(loaded, 10_000, "the tab's load");
  Assert.equal(alerts.opened, 0, "no agent alert");
  Assert.deepEqual(store.policyOf(agent.agentId), before, "policy unchanged");
});

/**
 * A tab an agent's page opened, taken by the user into their own
 * workspace, is theirs for good: its loads are not gated, raise no agent
 * alert, write nothing to the agent's policy, and what it opens is not the
 * agent's either.
 */
add_task(async function a_tab_the_user_takes_is_theirs_for_good() {
  const { tabs, agent, store, gate, call, win } = await agentSetup({
    sites: { "example.com": "full", "example.org": "blocked" },
  });
  const { tab } = await call("open_tab", { url: LINKS });
  const inAgents = tabsOpenedIn(win);
  const ref = await refFor(
    call,
    tab,
    /link "Allowed site in a new tab" \[(e\d+)\]/
  );
  await call("click_element", { tab, ref });
  await TestUtils.waitForCondition(() => inAgents.length, "a tab opens");
  const born = inAgents[0];
  Assert.equal(
    gate.agentOf(born)?.agentId,
    agent.agentId,
    "the agent's while in its workspace"
  );
  await committed(born, PAGE2);
  const userWin = await newWindowAfter(() =>
    win.gBrowser.replaceTabWithWindow(win.gBrowser.getTabForBrowser(born))
  );
  await within(userWin.SvalPanel.started, 10_000, "the panel's startup");
  Assert.notEqual(SvalWindowWorkspace.of(userWin).id, agent.workspaceId);
  const taken = userWin.gBrowser.selectedBrowser;
  await TestUtils.waitForCondition(
    () => gate.agentOf(taken) === null,
    "the tab is let go"
  );
  const takenNode = userWin.SvalPanel.observer.nodeIdFor(
    userWin.gBrowser.selectedTab
  );
  Assert.ok(takenNode, "the taken tab keeps its node");
  const agentSees = async () =>
    (await tabs.listTabs(agent.workspaceId)).filter(
      t => t.tab === takenNode || [ORG_PAGE, NET_PAGE].includes(t.url)
    );
  Assert.deepEqual(
    await agentSees(),
    [],
    "the agent's tab list no longer has it"
  );
  const alerts = countAlerts(userWin);
  const before = structuredClone(store.policyOf(agent.agentId));
  for (const url of [ORG_PAGE, NET_PAGE, LINKS]) {
    const loaded = BrowserTestUtils.browserLoaded(taken, false, url);
    BrowserTestUtils.startLoadingURIString(taken, url);
    await within(loaded, 10_000, "the tab's load");
    Assert.equal(gate.agentOf(taken), null, "still the user's");
  }
  await within(
    userWin.SvalPanel.observer.settled(),
    10_000,
    "userWin.SvalPanel.observer settling"
  );
  Assert.deepEqual(
    await agentSees(),
    [],
    "the agent sees nothing of what the user browses in it"
  );
  const opened = tabsOpenedIn(userWin);
  await clickIn(taken, "#allowed-tab");
  await TestUtils.waitForCondition(() => opened.length, "it opens a tab");
  Assert.equal(gate.agentOf(opened[0]), null, "what it opens is not adopted");
  userWin.gBrowser.moveTabToEnd(userWin.gBrowser.getTabForBrowser(taken));
  await within(
    userWin.SvalPanel.observer.settled(),
    10_000,
    "userWin.SvalPanel.observer settling"
  );
  Assert.deepEqual(
    await agentSees(),
    [],
    "moving it along the user's strip keeps it the user's"
  );
  Assert.equal(alerts.opened, 0, "no agent alert");
  Assert.deepEqual(store.policyOf(agent.agentId), before, "policy unchanged");
});

/**
 * A tab the user took, closed, and brought back with undo-close comes back
 * where the user filed it, and the agent never sees it again.
 */
add_task(async function a_taken_tab_closed_and_restored_stays_the_users() {
  const { tabs, agent, gate, call } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: PAGE2 });
  const found = await tabs.tabIn(agent, tab);
  const userWin = await newWindowAfter(() =>
    found.win.gBrowser.replaceTabWithWindow(found.tab)
  );
  await within(userWin.SvalPanel.started, 10_000, "the panel's startup");
  const userWs = SvalWindowWorkspace.of(userWin).id;
  Assert.notEqual(userWs, agent.workspaceId, "the user's window");
  const taken = userWin.gBrowser.selectedTab;
  await TestUtils.waitForCondition(
    () => gate.agentOf(taken.linkedBrowser) === null,
    "the tab is let go"
  );
  const observer = userWin.SvalPanel.observer;
  await within(observer.settled(), 10_000, "observer settling");
  Assert.equal(observer.nodeIdFor(taken), tab, "the taken tab keeps its node");
  await within(
    BrowserTestUtils.openNewForegroundTab(userWin.gBrowser, PAGE),
    10_000,
    "a new tab's load"
  );
  await within(observer.settled(), 10_000, "observer settling");

  await closeAndRestore(userWin, taken);
  const nodes = (await SvalPanel.engine.tree()).nodes;
  Assert.equal(
    nodes[tab].placement?.parent,
    userWs,
    "it is restored under the user's workspace"
  );
  Assert.ok(
    !(await tabs.listTabs(agent.workspaceId)).some(t => t.tab === tab),
    "the agent's tab list does not have it"
  );
});

/**
 * A user's tab moved to a group, closed, and brought back with undo-close
 * comes back in that group.
 */
add_task(async function a_tab_moved_to_a_group_comes_back_to_it() {
  const engine = SvalPanel.engine;
  const observer = SvalPanel.observer;
  const group = await engine.mutate({
    kind: "addGroup",
    parent: SvalWindowWorkspace.of(window).id,
    name: "Kept",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  atTaskEnd(async () => {
    await engine.mutate({ kind: "remove", id: group });
    await SvalPanel.refresh();
  });
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE2),
    10_000,
    "a new tab's load"
  );
  atTaskEnd(() => {
    if (gBrowser.tabs.includes(tab)) {
      BrowserTestUtils.removeTab(tab);
    }
  });
  await within(observer.settled(), 10_000, "observer settling");
  const id = observer.nodeIdFor(tab);
  Assert.ok(id, "the tab is filed");
  await SvalPanel.refresh();
  await SvalPanel._moveInto(id, group);
  Assert.equal(
    (await engine.tree()).nodes[id].placement?.parent,
    group,
    "Move to group filed it in the group"
  );

  await closeAndRestore(window, tab);
  Assert.equal(
    (await engine.tree()).nodes[id].placement?.parent,
    group,
    "it comes back in the group"
  );
});

/**
 * Whatever the tree says, a tab open in a window that shows another
 * workspace is not the agent's: the agent does not see it and cannot act in
 * it.
 */
add_task(async function a_tab_open_in_the_users_window_is_never_listed() {
  const { tabs, agent } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const engine = SvalPanel.engine;
  const observer = SvalPanel.observer;
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE2),
    10_000,
    "a new tab's load"
  );
  atTaskEnd(async () => {
    await BrowserTestUtils.removeTab(tab);
    await within(observer.settled(), 10_000, "observer settling");
  });
  await within(observer.settled(), 10_000, "observer settling");
  const id = observer.nodeIdFor(tab);
  const target = moveIntoTarget(
    (await engine.tree()).nodes,
    id,
    agent.workspaceId
  );
  await engine.mutate({ kind: "moveNode", ...target, now: Date.now() });
  Assert.ok(
    tabsIn((await engine.tree()).nodes, agent.workspaceId).some(
      t => t.tab === id
    ),
    "the tree files it under the agent's workspace"
  );

  Assert.ok(
    !(await tabs.listTabs(agent.workspaceId)).some(t => t.tab === id),
    "listTabs leaves it out"
  );
  await Assert.rejects(
    tabs.tabIn(agent, id),
    e => e.code === "not_controlled",
    "tabIn refuses it"
  );
});
