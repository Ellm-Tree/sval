/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * An agent's window adds nothing to the user's workspaces: the blank
 * tab it opens with and the agent's tabs are filed under the agent's
 * workspace, or nowhere.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * @param {string} agentWs The agent's workspace, left out.
 * @returns {Promise<string[]>} Every tab node outside `agentWs`, as id and
 *   address.
 */
async function tabsOutside(agentWs) {
  const nodes = (await SvalPanel.engine.tree()).nodes ?? {};
  const under = id => {
    for (let n = nodes[id]; n; n = nodes[n.placement?.parent]) {
      if (n.placement?.parent === agentWs) {
        return true;
      }
    }
    return false;
  };
  return Object.entries(nodes)
    .filter(([id, n]) => n.kind === "tab" && !under(id))
    .map(([id, n]) => `${id} ${n.content?.url}`)
    .sort();
}

/**
 * Lets every window's panel write what it has seen.
 *
 * @param {Window[]} wins
 */
async function settle(wins) {
  for (const w of wins) {
    // A late write would come from a window still finishing its startup,
    // which ends once its tab observer is attached.
    if (w.SvalPanel) {
      await within(w.SvalPanel.started, 10_000, "the panel's startup");
    }
    await within(
      w.SvalPanel?.observer?.settled(),
      10_000,
      "w.SvalPanel.observer settling"
    );
    await w.SvalPanel?.syncNow();
  }
}

add_task(async function an_agent_window_adds_no_node_to_the_users_workspace() {
  await settle([window]);
  const userTabs = window.gBrowser.tabs.length;
  const setup = await agentSetup({ sites: { "example.com": "full" } });
  const { win, ws, call } = setup;
  const prior = await tabsOutside(ws);
  await call("open_tab", { url: PAGE });
  await settle([window, win]);
  const afterOpen = await tabsOutside(ws);
  Assert.deepEqual(
    afterOpen,
    prior,
    "opening the agent's window and tab adds no node outside its workspace"
  );
  Assert.equal(
    window.gBrowser.tabs.length,
    userTabs,
    "the user's window gained no tab"
  );
  await within(BrowserTestUtils.closeWindow(win), 10_000, "the window closing");
  await settle([window]);
  Assert.deepEqual(await tabsOutside(ws), prior, "closing it adds none either");
});

add_task(
  async function tabs_and_windows_an_agents_page_opens_add_no_node_to_the_users_workspace() {
    await settle([window]);
    const userTabs = window.gBrowser.tabs.length;
    const { win, ws, call, tabs, agent } = await agentSetup({
      sites: { "example.com": "full" },
    });
    const prior = await tabsOutside(ws);
    const { tab } = await call("open_tab", { url: LINKS });
    const { browser } = await tabs.tabIn(agent, tab);
    const opened = BrowserTestUtils.waitForEvent(
      win.gBrowser.tabContainer,
      "TabOpen"
    );
    await BrowserTestUtils.synthesizeMouseAtCenter("#allowed-tab", {}, browser);
    await within(
      BrowserTestUtils.browserLoaded(
        (await within(opened, 10_000, "the TabOpen event")).target
          .linkedBrowser,
        false,
        PAGE2
      ),
      10_000,
      "the tab's load"
    );
    const popupWin = await newWindowAfter(() =>
      BrowserTestUtils.synthesizeMouseAtCenter("#link-popup", {}, browser)
    );
    await committed(
      popupWin.gBrowser.selectedBrowser,
      ROOT + "sval_agent_popup.html"
    );
    await settle([window, win, popupWin]);
    Assert.deepEqual(
      await tabsOutside(ws),
      prior,
      "the agent's page opening a tab and a window adds no node outside its workspace"
    );
    Assert.equal(
      window.gBrowser.tabs.length,
      userTabs,
      "the user's window gained no tab"
    );
    await within(
      BrowserTestUtils.closeWindow(popupWin),
      10_000,
      "the window closing"
    );
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the window closing"
    );
    await settle([window]);
    Assert.deepEqual(
      await tabsOutside(ws),
      prior,
      "closing them adds none either"
    );
  }
);
