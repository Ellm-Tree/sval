/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_take_control_helpers.js */

/**
 * A take is of the agent's whole workspace and is kept (agent-control spec
 * §6): in the device's settings, across a discard
 * and a restore, listed by `list_tabs`, and refused when it could not be
 * kept. It covers every tab, those opened while it holds included, and only
 * the user's Give back ends it. History the user made while holding the
 * workspace stays out of the agent's reach.
 *
 * Take control's other files are `browser_sval_agent_overlay.js`,
 * `browser_sval_agent_take_control_hands_over.js` and
 * `browser_sval_agent_take_control_crash.js`. Their shared helpers are in
 * `sval_take_control_helpers.js`.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_take_control_helpers.js",
  this
);

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

const control = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs"
);

/**
 * `list_tabs` lists every tab of a taken workspace, with nothing of what the
 * user does there and `user_in_control: true`.
 */
add_task(async function list_tabs_says_the_workspace_is_taken() {
  const { win, browser, tab, tabs, agent, call } = await layerSetup();
  const { tab: other } = await call("open_tab", { url: PAGE });
  await takeControlOf(win, browser);
  Assert.deepEqual(
    (await tabs.listTabsFor(agent)).filter(t => [tab, other].includes(t.tab)),
    [tab, other].map(id => ({
      tab: id,
      title: null,
      url: null,
      user_in_control: true,
    })),
    "every tab is listed as the user's"
  );
});

/**
 * A take outlives a tab's content. Discarded, the tab is refused by its
 * workspace while it has no browser, and is the user's again the moment its
 * browser goes back in, before its page loads.
 */
add_task(async function a_take_survives_a_discard() {
  const { win, browser, tabEl, tab, call } = await layerSetup();
  const { tab: other } = await call("open_tab", { url: PAGE });
  await showTab(win, tabEl);
  await takeControlOf(win, browser);
  await showTab(win, win.SvalPanel.observer.tabFor(other));
  Assert.ok(win.gBrowser.discardBrowser(tabEl), "the tab is discarded");
  Assert.ok(!tabEl.linkedPanel, "and has no browser");
  await Assert.rejects(
    call("get_snapshot", { tab }),
    e => e.code === "user_in_control",
    "the agent is refused by the tab's workspace"
  );
  await showTab(win, tabEl);
  const again = tabEl.linkedBrowser;
  await TestUtils.waitForCondition(
    () => isUserInControl(again.browsingContext.browserId),
    "the new content is the user's"
  );
  Assert.ok(!partsOf(again).bar.hidden, "with the bar");
  Assert.ok(!again.hasAttribute("sval-agent-layer"), "and no overlay");
});

/**
 * Takes are kept by workspace: a take kept under a tab's node is dropped once
 * the tree is read, and the workspace stays the agent's until the user takes
 * it.
 */
add_task(async function a_take_kept_by_tab_is_dropped() {
  const { win, tab, call } = await layerSetup();
  const workspace = SvalWindowWorkspace.of(win).id;
  SvalPanel.settings.setUserHeld(tab, true);
  atTaskEnd(() => SvalPanel.settings.setUserHeld(tab, false));
  Assert.ok(
    control.forgetGoneTabs((await SvalPanel.engine.tree()).nodes ?? {}),
    "the record changes"
  );
  Assert.ok(!SvalPanel.settings.isUserHeld(tab), "the tab's take is gone");
  Assert.ok(!control.isWorkspaceHeld(workspace), "the workspace is not held");
  await call("get_snapshot", { tab });
});

/**
 * A take outlives the window and the session: the agent's window opened
 * again restores the tab from the tree, and it is still the user's.
 */
add_task(async function a_take_survives_a_restore() {
  const { win, browser, tab, tabs, call, agent } = await layerSetup();
  await takeControlOf(win, browser);
  await within(BrowserTestUtils.closeWindow(win), 10_000, "the window closing");
  const again = await tabs.windowFor(agent.workspaceId, { open: true });
  let restored;
  await TestUtils.waitForCondition(
    () => (restored = again.SvalPanel.observer?.tabFor(tab)),
    "the tab is restored"
  );
  await Assert.rejects(
    call("get_snapshot", { tab }),
    e => e.code === "user_in_control",
    "the agent is refused before the tab has a browser"
  );
  await showTab(again, restored);
  await TestUtils.waitForCondition(
    () =>
      isUserInControl(restored.linkedBrowser.browsingContext.browserId) &&
      !partsOf(restored.linkedBrowser).bar.hidden,
    "the restored tab is the user's, with the bar"
  );
});

/**
 * History the user made while holding the tab is theirs: after giving it
 * back, the agent cannot go back or forward to it.
 */
add_task(async function history_the_user_made_is_not_the_agents() {
  const { call, tab, win, browser } = await layerSetup();
  await call("navigate_tab", { tab, to: PAGE });
  await takeControlOf(win, browser);
  for (const url of [PAGE2, INPUT]) {
    const loaded = BrowserTestUtils.browserLoaded(browser, false, url);
    await SpecialPowers.spawn(browser, [url], u => {
      content.location.href = u;
    });
    await within(loaded, 10_000, "the tab's load");
  }
  const back = BrowserTestUtils.waitForLocationChange(win.gBrowser, PAGE2);
  browser.goBack();
  await within(back, 10_000, "the tab's location change");
  await giveBackFrom(win, browser);
  await Assert.rejects(
    call("navigate_tab", { tab, to: "forward" }),
    e => e.code === "no_history",
    "forward to a page the user opened is refused"
  );
  Assert.equal(
    (await call("navigate_tab", { tab, to: "back" })).url,
    PAGE,
    "back to the agent's own page goes on"
  );
});

/**
 * History the user made while holding a tab stays out of the agent's reach
 * once the tab's content has gone and come back, closed and brought back
 * here. Which entries were the user's is then unknown, so the agent may step
 * only into entries its own navigations made since.
 */
add_task(async function history_the_user_made_survives_the_tab_going() {
  const { call, tab, win, browser, tabEl } = await layerSetup();
  await call("navigate_tab", { tab, to: PAGE });
  await takeControlOf(win, browser);
  const loaded = BrowserTestUtils.browserLoaded(browser, false, PAGE2);
  await SpecialPowers.spawn(browser, [PAGE2], u => {
    content.location.href = u;
  });
  await within(loaded, 10_000, "the tab's load");
  await giveBackFrom(win, browser);
  const restored = await closeAndRestore(win, tabEl);
  await showTab(win, restored);
  await TestUtils.waitForCondition(
    () =>
      restored.linkedBrowser.browsingContext?.sessionHistory?.count > 1 &&
      !SessionStore.isTabRestoring(restored),
    "its history is back"
  );
  await Assert.rejects(
    call("navigate_tab", { tab, to: "back" }),
    e => e.code === "no_history",
    "an entry that can no longer be told apart is refused"
  );
  await call("navigate_tab", { tab, to: INPUT });
  await call("navigate_tab", { tab, to: PAGE });
  Assert.equal(
    (await call("navigate_tab", { tab, to: "back" })).url,
    INPUT,
    "an entry the agent made since is not"
  );
});

/**
 * A tab the user opens while they hold the workspace is theirs with the rest
 * of it: they can open a tab, sign in there and give the workspace back when
 * they are done. Until they do, the agent is refused it.
 */
add_task(async function a_tab_the_user_opens_while_in_control_is_theirs() {
  const { win, browser, tabs, agent, call } = await layerSetup();
  await takeControlOf(win, browser);
  const opened = BrowserTestUtils.waitForEvent(
    win.gBrowser.tabContainer,
    "TabOpen"
  );
  EventUtils.synthesizeKey("t", { accelKey: true }, win);
  const born = (await within(opened, 10_000, "the TabOpen event")).target;
  await TestUtils.waitForCondition(
    () => win.gBrowser.selectedTab === born,
    "the new tab is selected"
  );
  const bornBrowser = born.linkedBrowser;
  Assert.ok(
    isUserInControl(bornBrowser.browsingContext.browserId),
    "the new tab is in the user's control"
  );
  await TestUtils.waitForCondition(
    () => !partsOf(bornBrowser).bar?.hidden,
    "it shows the bar"
  );
  Assert.ok(!bornBrowser.hasAttribute("sval-agent-layer"), "and no layer");
  Assert.ok(partsOf(bornBrowser).overlay?.hidden ?? true, "nor the overlay");

  let nodeId;
  await TestUtils.waitForCondition(
    () => (nodeId = win.SvalPanel.observer.nodeIdFor(born)),
    "the new tab is filed"
  );
  Assert.deepEqual(
    (await tabs.listTabsFor(agent)).find(t => t.tab === nodeId),
    { tab: nodeId, title: null, url: null, user_in_control: true },
    "the agent sees it as the user's"
  );
  for (const [name, args] of [
    ["get_snapshot", { tab: nodeId }],
    ["navigate_tab", { tab: nodeId, to: PAGE }],
    ["close_tab", { tab: nodeId }],
  ]) {
    await Assert.rejects(
      call(name, args),
      e =>
        e.code === "user_in_control" && e.message === USER_IN_CONTROL_MESSAGE,
      `${name} fails with user_in_control`
    );
  }

  await giveBackFrom(win, bornBrowser);
  Assert.ok(
    !isUserInControl(browser.browsingContext.browserId),
    "given back, the first tab is the agent's too"
  );
  Assert.ok(
    !(await tabs.listTabsFor(agent)).some(t => t.user_in_control),
    "and list_tabs says so of every tab"
  );
});

/**
 * The agent cannot act in, or take back, a workspace the user holds:
 * opening a tab, and every tool on every tab, is refused, the window stays
 * the user's, and only Give back returns it, every tab at once.
 */
add_task(async function the_agent_cannot_take_the_workspace_back() {
  const { win, browser, tabEl, tab, call } = await layerSetup();
  const { tab: other } = await call("open_tab", { url: PAGE });
  const otherTab = win.SvalPanel.observer.tabFor(other);
  await showTab(win, tabEl);
  await takeControlOf(win, browser);
  Assert.ok(
    isUserInControl(otherTab.linkedBrowser.browsingContext.browserId),
    "the agent's other tab is the user's too"
  );
  const tabsBefore = win.gBrowser.tabs.length;
  for (const [name, args] of [
    ["open_tab", { url: PAGE2 }],
    ["get_snapshot", { tab }],
    ["navigate_tab", { tab: other, to: PAGE2 }],
    ["click_element", { tab, ref: "e1" }],
    ["close_tab", { tab: other }],
  ]) {
    await Assert.rejects(
      call(name, args),
      e =>
        e.code === "user_in_control" && e.message === USER_IN_CONTROL_MESSAGE,
      `${name} fails with user_in_control`
    );
  }
  Assert.equal(win.gBrowser.tabs.length, tabsBefore, "no tab opened or closed");
  Assert.equal(win.gBrowser.selectedTab, tabEl, "the user's tab stays shown");
  Assert.ok(partsOf(browser).overlay?.hidden ?? true, "with no overlay");
  Assert.ok(
    isUserInControl(browser.browsingContext.browserId),
    "the user still holds the workspace"
  );

  await giveBackFrom(win, browser);
  Assert.ok(
    !isUserInControl(otherTab.linkedBrowser.browsingContext.browserId),
    "given back, every tab is the agent's"
  );
  Assert.ok(!partsOf(browser).overlay.hidden, "under the overlay");
  await call("get_snapshot", { tab });
  await call("get_snapshot", { tab: other });
});

/**
 * A popup a page opens while the user holds the agent's workspace is still
 * the workspace's: it opens filed under it, in the user's control as its
 * opener is, and no workspace of the user's ever gains a node for it.
 */
add_task(async function a_popup_opened_while_the_user_holds_stays_in_it() {
  await SpecialPowers.pushPrefEnv({
    set: [["dom.disable_open_during_load", false]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const { win, browser, agent } = await layerSetup();
  await takeControlOf(win, browser);
  const strays = strayNodes(agent);
  const popupWin = await newWindowAfter(() =>
    SpecialPowers.spawn(browser, [PAGE2], url => {
      content.open(url, "_blank", "popup,width=300,height=300");
    })
  );
  Assert.ok(!popupWin.toolbar.visible, "it stays a popup");
  Assert.equal(
    SvalWindowWorkspace.of(popupWin).id,
    agent.workspaceId,
    "showing the agent's workspace"
  );
  const popupTab = popupWin.gBrowser.selectedTab;
  await TestUtils.waitForCondition(
    () => popupWin.SvalPanel.observer?.nodeIdFor(popupTab),
    "the popup's tab is filed"
  );
  Assert.ok(
    isUserInControl(popupTab.linkedBrowser.browsingContext.browserId),
    "in the user's control"
  );
  await within(
    popupWin.SvalPanel.observer.settled(),
    10_000,
    "popupWin.SvalPanel.observer settling"
  );
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
