/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * A link the user Quick Peeks at in the agent's window is the agent's to read and
 * act in while the Quick Peek is open (agent-control spec §3.5): `list_tabs`
 * lists it, marked `quickPeek`, and every tool takes its id under the same site
 * policy and take of control as the agent's other tabs. A Quick Peek in the
 * user's own window is no agent's.
 */

const { SvalQuickPeek } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalQuickPeek.sys.mjs"
);
const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);
const { giveBackWorkspace, holdWorkspace } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * Puts a link to `href` at the top of `browser`'s page, Alt-clicks it as
 * the user would, and waits for the Quick Peek's page to load.
 *
 * @param {Window} win
 * @param {object} browser The selected tab's `<browser>` in `win`.
 * @param {string} href
 * @returns {Promise<object>} The Quick Peek's tab.
 */
async function quickPeekFrom(win, browser, href) {
  await SpecialPowers.spawn(browser, [href], url => {
    const link = content.document.createElement("a");
    link.id = "quick-peek-link";
    link.href = url;
    link.textContent = "Quick Peek here";
    content.document.body.prepend(link);
  });
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#quick-peek-link",
    { altKey: true },
    browser
  );
  const quickPeek = await TestUtils.waitForCondition(
    () => SvalQuickPeek.tabOf(win),
    "a Quick Peek opens"
  );
  await TestUtils.waitForCondition(
    () =>
      quickPeek.linkedBrowser.currentURI.spec === href &&
      !quickPeek.hasAttribute("busy"),
    "the Quick Peek's page loads"
  );
  return quickPeek;
}

/**
 * @param {object} tabs
 * @param {object} agent
 * @returns {Promise<object[]>} The Quick Peeks `list_tabs` lists.
 */
async function listedQuickPeeks(tabs, agent) {
  return (await tabs.listTabsFor(agent)).filter(t => t.quickPeek);
}

/**
 * The agent sees the user's Quick Peek in its window, reads it and clicks in it,
 * and is refused a blocked site there. Closing the Quick Peek takes it out of the
 * list, and its id answers as a closed tab's does.
 */
add_task(async function the_agent_reads_and_acts_in_a_quick_peek() {
  const { call, tabs, agent, win, ws } = await agentSetup({
    sites: { "example.com": "full", "example.org": "blocked" },
  });
  const { tab } = await call("open_tab", { url: PAGE2 });
  const { browser } = await tabs.tabIn(agent, tab);
  await selectTab(win.gBrowser.getTabForBrowser(browser));
  const quickPeekTab = await quickPeekFrom(win, browser, PAGE);

  const [listed, ...others] = await listedQuickPeeks(tabs, agent);
  Assert.equal(others.length, 0, "one Quick Peek is listed");
  Assert.deepEqual(
    listed,
    { tab: listed.tab, title: "Agent test page", url: PAGE, quickPeek: true },
    "list_tabs names the Quick Peek's page and marks it a Quick Peek"
  );
  Assert.notEqual(listed.tab, tab, "under an id of its own");

  const read = await call("get_page_text", { tab: listed.tab });
  Assert.ok(read.text.includes("Plain words here."), "the agent reads it");

  const keep = await refFor(
    call,
    listed.tab,
    /checkbox "Keep me signed in" \[(e\d+)\]/
  );
  await call("click_element", { tab: listed.tab, ref: keep });
  Assert.ok(
    await SpecialPowers.spawn(
      quickPeekTab.linkedBrowser,
      [],
      () => content.document.getElementById("keep").checked
    ),
    "the click takes effect in the Quick Peek"
  );
  Assert.equal(
    SvalQuickPeek.tabOf(win),
    quickPeekTab,
    "and the Quick Peek stays open"
  );

  const refused = await call("navigate_tab", { tab: listed.tab, to: ORG_PAGE });
  Assert.equal(
    refused.status,
    403,
    "a blocked site is refused in the Quick Peek"
  );
  Assert.equal(refused.url, "about:agentblocked");
  const moved = await call("navigate_tab", { tab: listed.tab, to: PAGE2 });
  Assert.equal(moved.url, PAGE2, "an allowed one loads in the Quick Peek");
  Assert.equal(SvalQuickPeek.tabOf(win), quickPeekTab, "which stays open");

  holdWorkspace(ws, true);
  atTaskEnd(() => giveBackWorkspace(ws));
  Assert.deepEqual(
    await listedQuickPeeks(tabs, agent),
    [
      {
        tab: listed.tab,
        title: null,
        url: null,
        user_in_control: true,
        quickPeek: true,
      },
    ],
    "while the user holds the workspace, the Quick Peek is theirs"
  );
  await Assert.rejects(
    call("get_page_text", { tab: listed.tab }),
    e => e.code === "user_in_control",
    "and the tools are refused in it"
  );
  giveBackWorkspace(ws);

  await call("close_tab", { tab: listed.tab });
  await TestUtils.waitForCondition(
    () => !SvalQuickPeek.tabOf(win) && !quickPeekTab.isConnected,
    "close_tab closes the Quick Peek"
  );
  Assert.deepEqual(
    await listedQuickPeeks(tabs, agent),
    [],
    "the Quick Peek is no longer listed"
  );
  await Assert.rejects(
    call("get_page_text", { tab: listed.tab }),
    e => e.code === "not_controlled",
    "and its id answers as a closed tab's"
  );
});

/**
 * A Quick Peek the user keeps becomes an ordinary tab of the agent's, listed by
 * its node id; the Quick Peek's id answers as a closed tab's.
 */
add_task(async function a_kept_quick_peek_is_an_ordinary_tab() {
  const { call, tabs, agent, win } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: PAGE2 });
  const { browser } = await tabs.tabIn(agent, tab);
  await selectTab(win.gBrowser.getTabForBrowser(browser));
  const quickPeekTab = await quickPeekFrom(win, browser, PAGE);
  const [listed] = await listedQuickPeeks(tabs, agent);

  win.document
    .getElementById(quickPeekTab.linkedPanel)
    .querySelector(".sval-quick-peek-tab")
    .click();
  expectOpened(quickPeekTab);
  await TestUtils.waitForCondition(
    () => win.SvalPanel.observer.nodeIdFor(quickPeekTab),
    "the kept page is filed"
  );
  const nodeId = win.SvalPanel.observer.nodeIdFor(quickPeekTab);
  const all = await tabs.listTabsFor(agent);
  Assert.ok(
    all.every(t => !t.quickPeek),
    "no Quick Peek is listed once the page is kept"
  );
  Assert.deepEqual(
    all.find(t => t.tab === nodeId),
    { tab: nodeId, title: "Agent test page", url: PAGE },
    "the kept page is listed by its node id"
  );
  const read = await call("get_page_text", { tab: nodeId });
  Assert.ok(read.text.includes("Plain words here."), "and the tools reach it");
  await Assert.rejects(
    call("get_page_text", { tab: listed.tab }),
    e => e.code === "not_controlled",
    "the Quick Peek's id answers as a closed tab's"
  );
});

/**
 * A Quick Peek in the user's own window is in no agent's list, and its id
 * reaches nothing.
 */
add_task(async function a_quick_peek_in_the_users_window_is_no_agents() {
  const { call, tabs, agent } = await agentSetup({
    sites: { "example.com": "full" },
  });
  await call("open_tab", { url: PAGE2 });
  const userTab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE2),
    15_000,
    "the user's tab opening and loading"
  );
  atTaskEnd(() => BrowserTestUtils.removeTab(userTab));
  const quickPeekTab = await quickPeekFrom(window, userTab.linkedBrowser, PAGE);
  atTaskEnd(() => SvalQuickPeek.close(window));

  Assert.deepEqual(
    await listedQuickPeeks(tabs, agent),
    [],
    "the agent lists no Quick Peek"
  );
  const quickPeekId = `quick-peek-${quickPeekTab.linkedBrowser.browsingContext.browserId}`;
  await Assert.rejects(
    tabs.tabIn(agent, quickPeekId),
    e => e.code === "not_controlled",
    "and its id reaches nothing"
  );
});
