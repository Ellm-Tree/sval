/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_agent_sites_helpers.js */

/**
 * Site policy (agent-control spec §5.2) reaches every tab the agent's work
 * opens: `open_tab`'s, a page's tab or window, the agent's click's, and one
 * whose opener is gone before it loads, each watched from the moment it opens.
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
 * open_tab watches the tab before it loads anything, and closing the tab
 * lets it go.
 */
add_task(async function open_tab_watches_and_close_tab_lets_go() {
  const { tabs, agent, gate, call } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: PAGE });
  const { browser } = await tabs.tabIn(agent, tab);
  Assert.equal(gate.agentOf(browser)?.agentId, agent.agentId);
  await call("close_tab", { tab });
  Assert.equal(gate.agentOf(browser), null, "a closed tab is not watched");
});

/**
 * A tab the page opens is the agent's too: watched for the same agent, and
 * its loads checked, so a Blocked site cannot be reached through a new tab.
 */
add_task(async function a_tab_the_page_opens_is_watched() {
  const { tabs, agent, gate, call, win } = await agentSetup({
    sites: { "example.com": "full", "example.org": "blocked" },
  });
  const stops = stopsIn(win);
  const { tab } = await call("open_tab", { url: LINKS });
  const { browser } = await tabs.tabIn(agent, tab);

  const opened = BrowserTestUtils.waitForEvent(
    win.gBrowser.tabContainer,
    "TabOpen"
  );
  await clickIn(browser, "#tab");
  const popup = (await within(opened, 10_000, "the TabOpen event")).target
    .linkedBrowser;
  await refused(stops, popup, ORG_PAGE);
  Assert.equal(
    gate.agentOf(popup)?.agentId,
    agent.agentId,
    "watched for the same agent"
  );
  await blockedPage(popup);

  const allowedOpened = BrowserTestUtils.waitForEvent(
    win.gBrowser.tabContainer,
    "TabOpen"
  );
  await clickIn(browser, "#allowed-tab");
  const allowed = (await within(allowedOpened, 10_000, "the TabOpen event"))
    .target.linkedBrowser;
  await within(
    BrowserTestUtils.browserLoaded(allowed, false, PAGE2),
    10_000,
    "the tab's load"
  );
  Assert.equal(gate.agentOf(allowed)?.agentId, agent.agentId);
});

/**
 * A page can open a window of its own. The window shows the agent's
 * workspace, its tab is filed there, and its loads are checked.
 */
add_task(async function a_window_the_page_opens_is_watched() {
  const { tabs, agent, gate, call, win } = await agentSetup({
    sites: { "example.com": "full", "example.org": "blocked" },
  });
  const { tab } = await call("open_tab", { url: LINKS });
  const { browser } = await tabs.tabIn(agent, tab);

  const windowOpened = BrowserTestUtils.domWindowOpenedAndLoaded();
  await clickIn(browser, "#popup");
  const popupWin = await within(windowOpened, 10_000, "a window opening");
  atTaskEnd(async () => {
    if (!popupWin.closed) {
      await within(
        BrowserTestUtils.closeWindow(popupWin),
        10_000,
        "the window closing"
      );
    }
  });
  await TestUtils.waitForCondition(
    () => popupWin.gBrowser?.selectedBrowser,
    "the new window has a tab"
  );
  // The page loads the blocked site only once told, so this listener is in
  // place first.
  const stops = stopsIn(popupWin);
  const popup = popupWin.gBrowser.selectedBrowser;
  await within(popupWin.SvalPanel.started, 10_000, "the panel's startup");
  Assert.equal(
    popupWin.SvalPanel.workspaceId,
    agent.workspaceId,
    "the window shows the agent's workspace"
  );
  Assert.equal(popupWin.gBrowser.tabs.length, 1, "and only its own page");
  await goOn(browser);
  await refused(stops, popup, ORG_PAGE);
  await blockedPage(popup);
  Assert.equal(
    gate.agentOf(popup)?.agentId,
    agent.agentId,
    "the popup is the agent's tab"
  );
  Assert.equal(
    await tabs.windowFor(agent.workspaceId),
    win,
    "the agent's tabs still open in its own window, not the popup"
  );
});

/**
 * A window a page opens is filed with the agent's tabs from the start, where
 * it can reach, and never under a workspace of the user's.
 */
add_task(async function a_window_the_page_opens_is_the_agents_tab() {
  const { tabs, agent, gate, call } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: LINKS });
  const { browser } = await tabs.tabIn(agent, tab);
  const strays = strayNodes(agent);
  await clickIn(browser, "#allowed-popup");
  let popupWin;
  await TestUtils.waitForCondition(() => {
    popupWin = [...Services.wm.getEnumerator("navigator:browser")].find(
      w =>
        !w.closed &&
        w.gBrowser?.selectedBrowser?.browsingContext?.opener?.browserId ===
          browser.browserId
    );
    return popupWin;
  }, "the page opened a window");
  atTaskEnd(async () => {
    if (!popupWin.closed) {
      await within(
        BrowserTestUtils.closeWindow(popupWin),
        10_000,
        "the window closing"
      );
    }
  });
  await TestUtils.waitForCondition(
    () => popupWin.SvalPanel?.initialized,
    "its panel starts"
  );
  await within(popupWin.SvalPanel.started, 10_000, "the panel's startup");
  const popupTab = popupWin.gBrowser.selectedTab;
  const popup = popupTab.linkedBrowser;
  try {
    await TestUtils.waitForCondition(async () => {
      try {
        return await SpecialPowers.spawn(
          popup,
          [PAGE2],
          url =>
            content.document.URL === url &&
            content.document.readyState === "complete"
        );
      } catch {
        // The page's actor goes away as a load replaces it.
        return false;
      }
    }, "the popup loaded its page");
  } catch (err) {
    info(
      `popup: toolbar ${popupWin.toolbar.visible}, its workspace ${popupWin.SvalPanel.workspaceId === agent.workspaceId ? "the agent's" : "another"}, ${popupWin.gBrowser.tabs.length} tabs, showing ${popup.currentURI.spec}, loading ${popup.webProgress?.isLoadingDocument}, watched ${gate.agentOf(popup)?.agentId === agent.agentId}`
    );
    throw err;
  }
  Assert.equal(gate.agentOf(popupTab.linkedBrowser)?.agentId, agent.agentId);
  let node;
  await TestUtils.waitForCondition(async () => {
    await within(
      popupWin.SvalPanel.observer.settled(),
      10_000,
      "popupWin.SvalPanel.observer settling"
    );
    node = popupWin.SvalPanel.observer.nodeIdFor(popupTab);
    return node;
  }, "the popup's tab is filed");
  const listed = await tabs.listTabs(agent.workspaceId);
  Assert.ok(
    listed.some(t => t.tab === node),
    "the agent's tab list has it"
  );
  const shot = await call("get_snapshot", { tab: node });
  Assert.equal(shot.url, PAGE2, "the agent can read it");
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  Assert.deepEqual(
    strays,
    [],
    "no node was written for a workspace of the user's"
  );
});

/**
 * A tab a page opens with `window.open` and no window features is a tab, and
 * the agent's, with its first load decided.
 */
add_task(async function a_tab_a_page_script_opens_is_watched() {
  const { tabs, agent, gate, call, win } = await agentSetup({
    sites: { "example.com": "full", "example.org": "blocked" },
  });
  const stops = stopsIn(win);
  const { tab } = await call("open_tab", { url: LINKS });
  const { browser } = await tabs.tabIn(agent, tab);
  const opened = BrowserTestUtils.waitForEvent(
    win.gBrowser.tabContainer,
    "TabOpen"
  );
  await SpecialPowers.spawn(browser, [ORG_PAGE], url => {
    content.document.notifyUserGestureActivation();
    content.window.open(url);
  });
  const popup = (await within(opened, 10_000, "the TabOpen event")).target
    .linkedBrowser;
  await refused(stops, popup, ORG_PAGE);
  Assert.equal(
    gate.agentOf(popup)?.agentId,
    agent.agentId,
    "watched for the same agent"
  );
  await blockedPage(popup);
});

/**
 * A link opened in a new tab with a modifier, from an agent's tab, opens
 * the agent's tab, whose first load is decided as the agent's.
 */
add_task(async function a_tab_a_modified_click_opens_is_watched() {
  const { tabs, agent, gate, call, win } = await agentSetup({
    sites: { "example.com": "full", "example.org": "blocked" },
  });
  const stops = stopsIn(win);
  const { tab } = await call("open_tab", { url: LINKS });
  const { browser } = await tabs.tabIn(agent, tab);
  const opened = BrowserTestUtils.waitForEvent(
    win.gBrowser.tabContainer,
    "TabOpen"
  );
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#blocked",
    { accelKey: true },
    browser
  );
  const popup = (await within(opened, 10_000, "the TabOpen event")).target
    .linkedBrowser;
  await refused(stops, popup, ORG_PAGE);
  Assert.equal(
    gate.agentOf(popup)?.agentId,
    agent.agentId,
    "watched for the same agent"
  );
  await blockedPage(popup);
});

/**
 * A page that opens a tab with no opener, by a `noopener noreferrer` link or
 * `window.open`'s `noopener`, still opens the agent's tab: its first load
 * waits for its filing and is refused as the agent's.
 */
add_task(async function a_tab_opened_without_an_opener_is_watched() {
  const { tabs, agent, gate, call, win } = await agentSetup({
    sites: { "example.com": "full", "example.org": "blocked" },
  });
  const stops = stopsIn(win);
  const { tab } = await call("open_tab", { url: LINKS });
  const { browser } = await tabs.tabIn(agent, tab);
  await SpecialPowers.spawn(browser, [ORG_PAGE], url => {
    const link = content.document.createElement("a");
    link.id = "noopener";
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "No opener";
    content.document.body.prepend(link);
  });
  const ways = [
    ["a noopener link", () => clickIn(browser, "#noopener")],
    [
      "window.open with noopener",
      () =>
        SpecialPowers.spawn(browser, [ORG_PAGE], url => {
          content.document.notifyUserGestureActivation();
          content.window.open(url, "_blank", "noopener");
        }),
    ],
  ];
  for (const [what, open] of ways) {
    const opened = BrowserTestUtils.waitForEvent(
      win.gBrowser.tabContainer,
      "TabOpen"
    );
    await open();
    const popup = (await within(opened, 10_000, `${what}: TabOpen`)).target
      .linkedBrowser;
    Assert.equal(
      popup.browsingContext.opener,
      null,
      `${what}: the tab has no opener`
    );
    await refused(stops, popup, ORG_PAGE);
    Assert.equal(
      gate.agentOf(popup)?.agentId,
      agent.agentId,
      `${what}: the agent's tab`
    );
    await blockedPage(popup);
  }
});

/**
 * A popup a page opens with `noopener` has no opener, and is still the
 * agent's: it shows the agent's workspace, and its first load is refused
 * as the agent's.
 */
add_task(async function a_popup_opened_without_an_opener_is_watched() {
  const { tabs, agent, gate, call } = await agentSetup({
    sites: { "example.com": "full", "example.org": "blocked" },
  });
  const { tab } = await call("open_tab", { url: LINKS });
  const { browser } = await tabs.tabIn(agent, tab);
  const stopped = Promise.withResolvers();
  const onStop = subject => {
    const channel = subject.QueryInterface(Ci.nsIChannel);
    if (channel.URI.spec === ORG_PAGE) {
      stopped.resolve(channel.status);
    }
  };
  Services.obs.addObserver(onStop, "http-on-stop-request");
  atTaskEnd(() => Services.obs.removeObserver(onStop, "http-on-stop-request"));
  const windowOpened = BrowserTestUtils.domWindowOpenedAndLoaded();
  await SpecialPowers.spawn(browser, [ORG_PAGE], url => {
    content.document.notifyUserGestureActivation();
    content.window.open(url, "x", "popup,noopener");
  });
  const popupWin = await within(windowOpened, 10_000, "a window opening");
  atTaskEnd(async () => {
    if (!popupWin.closed) {
      await within(
        BrowserTestUtils.closeWindow(popupWin),
        10_000,
        "the window closing"
      );
    }
  });
  Assert.notEqual(
    await within(stopped.promise, 10_000, "the popup's first load ending"),
    Cr.NS_OK,
    "the popup's first load is refused"
  );
  const popup = popupWin.gBrowser.selectedBrowser;
  Assert.equal(popup.browsingContext.opener, null, "the popup has no opener");
  await within(popupWin.SvalPanel.started, 10_000, "the panel's startup");
  Assert.equal(
    popupWin.SvalPanel.workspaceId,
    agent.workspaceId,
    "the popup shows the agent's workspace"
  );
  Assert.equal(
    gate.agentOf(popup)?.agentId,
    agent.agentId,
    "the popup is the agent's tab"
  );
  await blockedPage(popup);
});

add_task(async function a_tab_an_agent_click_opens_is_watched() {
  const { gate, agent, call, win } = await agentSetup({
    sites: { "example.com": "full", "example.org": "blocked" },
  });
  const stops = stopsIn(win);
  const opened = tabsOpenedIn(win);
  const { tab } = await call("open_tab", { url: LINKS });
  const { snapshot } = await call("get_snapshot", { tab });
  const ref = snapshot.match(/link "Blocked site in a new tab" \[(e\d+)\]/)[1];
  const before = opened.length;
  await call("click_element", { tab, ref });
  await TestUtils.waitForCondition(
    () => opened.length > before,
    "the click opened a tab"
  );
  const popup = opened.at(-1);
  Assert.equal(gate.agentOf(popup)?.agentId, agent.agentId);
  await refused(stops, popup, ORG_PAGE);
  await blockedPage(popup);
});

/**
 * A tab opened from a frame that is then removed has no opener left by the
 * time it loads. It is filed in the agent's workspace before it loads, so
 * its load is checked.
 */
add_task(async function a_removed_frame_cannot_free_the_tab_it_opened() {
  const { tabs, agent, gate, call, win } = await agentSetup({
    sites: { "example.com": "full", "example.org": "blocked" },
  });
  const stops = stopsIn(win);
  const opened = tabsOpenedIn(win);
  const { tab } = await call("open_tab", { url: LINKS });
  const { browser } = await tabs.tabIn(agent, tab);
  const before = opened.length;
  await clickIn(browser, "#escape");
  await TestUtils.waitForCondition(() => opened.length > before, "tab opens");
  const popup = opened.at(-1);
  await goOn(browser);
  await refused(stops, popup, ORG_PAGE);
  await blockedPage(popup);
  Assert.equal(gate.agentOf(popup)?.agentId, agent.agentId);
});

/**
 * A popup that opens a blank tab and closes itself leaves that tab with no
 * opener. The tab is filed in the agent's workspace before it loads, so its
 * load is checked.
 */
add_task(async function a_popup_that_closes_cannot_free_the_tab_it_opened() {
  await SpecialPowers.pushPrefEnv({
    set: [["dom.disable_open_during_load", false]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const { tabs, agent, gate, call, win } = await agentSetup({
    sites: { "example.com": "full", "example.org": "blocked" },
  });
  const stops = stopsIn(win);
  const opened = tabsOpenedIn(win);
  const { tab } = await call("open_tab", { url: LINKS });
  const { browser } = await tabs.tabIn(agent, tab);
  const before = opened.length;
  await clickIn(browser, "#hop");
  await TestUtils.waitForCondition(
    () => opened.length >= before + 2,
    "the popup and its blank tab open"
  );
  const blank = opened.at(-1);
  await refused(stops, blank, ORG_PAGE);
  await blockedPage(blank);
  Assert.equal(gate.agentOf(blank)?.agentId, agent.agentId);
});
