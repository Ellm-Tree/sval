/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * What a page in an agent's tab opens never takes focus (agent-control spec
 * §4.1): a new tab it asks for is a background tab in the agent's own window.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * An agent's tab on the links page, its window behind the user's.
 *
 * @returns {Promise<object>}
 */
async function focusSetup() {
  const setup = await agentSetup({ sites: { "example.com": "full" } });
  const { tab } = await setup.call("open_tab", { url: LINKS });
  const { browser } = await setup.tabs.tabIn(setup.agent, tab);
  await within(SimpleTest.promiseFocus(window), 10_000, "the window's focus");
  return { ...setup, tab, browser };
}

/**
 * Runs `open` in the agent's page and checks the tab it opens: in the
 * agent's window, not selected there, the agent's, and focus where it was.
 *
 * @param {object} setup
 * @param {Function} open
 */
async function opensInTheBackground(setup, open) {
  const { win, gate, agent } = setup;
  const selected = win.gBrowser.selectedTab;
  const userTabs = gBrowser.tabs.length;
  const opened = BrowserTestUtils.waitForEvent(
    win.gBrowser.tabContainer,
    "TabOpen"
  );
  await open();
  const tab = (await within(opened, 10_000, "the TabOpen event")).target;
  await within(
    BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, PAGE2),
    10_000,
    "the tab's load"
  );
  Assert.equal(
    gate.agentOf(tab.linkedBrowser)?.agentId,
    agent.agentId,
    "it is the agent's"
  );
  Assert.equal(
    win.gBrowser.selectedTab,
    selected,
    "it opened in the background"
  );
  Assert.equal(
    gBrowser.tabs.length,
    userTabs,
    "nothing opened in the user's window"
  );
  Assert.equal(
    Services.focus.activeWindow,
    window,
    "focus stayed with the user"
  );
}

add_task(async function a_link_to_a_new_tab_opens_in_the_background() {
  const setup = await focusSetup();
  await opensInTheBackground(setup, () =>
    BrowserTestUtils.synthesizeMouseAtCenter("#allowed-tab", {}, setup.browser)
  );
});

add_task(async function window_open_without_features_opens_in_the_background() {
  const setup = await focusSetup();
  await opensInTheBackground(setup, () =>
    SpecialPowers.spawn(setup.browser, [], () => {
      content.open("sval_agent_page2.html");
    })
  );
});

/**
 * When the tab cannot be put in the agent's window, Firefox opens it as it
 * would have: Sval never makes a page's `window.open` fail.
 */
add_task(async function a_tab_that_cannot_be_routed_still_opens() {
  const setup = await focusSetup();
  const { win, browser } = setup;
  const real = win.browserDOMWindow;
  win.browserDOMWindow = null;
  atTaskEnd(() => (win.browserDOMWindow = real));
  const opened = BrowserTestUtils.waitForEvent(
    win.gBrowser.tabContainer,
    "TabOpen"
  );
  const got = await SpecialPowers.spawn(
    browser,
    [],
    () => !!content.open("sval_agent_page2.html")
  );
  Assert.ok(got, "window.open gave the page a window");
  const tab = (await within(opened, 10_000, "the TabOpen event")).target;
  await within(
    BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, PAGE2),
    10_000,
    "the tab's load"
  );
  Assert.equal(
    setup.gate.agentOf(tab.linkedBrowser)?.agentId,
    setup.agent.agentId,
    "the gate still watches the tab"
  );
});

/**
 * The agent's window opens behind the user's (agent-control spec §7.1):
 * the user's window keeps focus and stays the window in front.
 */
add_task(async function the_agents_window_opens_behind_the_users() {
  const { tabs, agent } = await agentSetup({ openWindow: false });
  await within(SimpleTest.promiseFocus(window), 10_000, "the window's focus");
  const win = await newWindowAfter(() =>
    tabs.windowFor(agent.workspaceId, { open: true })
  );
  Assert.equal(win.SvalPanel.workspaceId, agent.workspaceId);
  Assert.equal(
    Services.focus.activeWindow,
    window,
    "focus stayed with the user's window"
  );
  Assert.ok(!win.document.hasFocus(), "the agent's window has none");
  Assert.equal(
    BrowserWindowTracker.getTopWindow(),
    window,
    "the user's window is still the one in front"
  );
  Assert.equal(
    BrowserWindowTracker.orderedWindows.indexOf(win),
    1,
    "the agent's window is right behind it"
  );
});
