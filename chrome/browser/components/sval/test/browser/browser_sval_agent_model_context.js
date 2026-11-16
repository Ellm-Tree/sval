/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * WebMCP's `modelContext` reaches only pages in agent tabs, and only while
 * its pref is on (site-tools spec §3.1). A page's interfaces are fixed when
 * its global is made, so each case loads a fresh document.
 */

"use strict";

/* import-globals-from head.js */

// PAGE, an https page on example.com, comes from head.js.

/**
 * @param {Element} tab The tab to load the page in.
 * @param {string} [url] The page.
 * @returns {Promise<boolean>} whether the loaded page sees `modelContext`.
 */
async function pageSeesModelContext(tab, url = PAGE) {
  const browser = tab.linkedBrowser;
  BrowserTestUtils.startLoadingURIString(browser, url);
  await within(
    BrowserTestUtils.browserLoaded(browser, false, url),
    10_000,
    "the tab's load"
  );
  return SpecialPowers.spawn(
    browser,
    [],
    () =>
      "modelContext" in content.navigator &&
      typeof content.ModelContext === "function"
  );
}

add_task(async function only_agent_tabs_see_model_context() {
  await SpecialPowers.pushPrefEnv({
    set: [["dom.modelcontext.enabled", true]],
  });
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser),
    10_000,
    "a new tab's load"
  );
  registerCleanupFunction(() => {
    if (gBrowser.tabs.includes(tab)) {
      BrowserTestUtils.removeTab(tab);
    }
  });
  const bc = tab.linkedBrowser.browsingContext;
  Assert.ok(!bc.svalAgentTab, "a tab is not an agent's by default");
  Assert.ok(!(await pageSeesModelContext(tab)), "an ordinary tab: hidden");

  tab.linkedBrowser.browsingContext.svalAgentTab = true;
  Assert.ok(await pageSeesModelContext(tab), "an agent tab: exposed");

  await SpecialPowers.pushPrefEnv({
    set: [["dom.modelcontext.enabled", false]],
  });
  Assert.ok(
    !(await pageSeesModelContext(tab)),
    "an agent tab with the pref off: hidden"
  );
  await SpecialPowers.popPrefEnv();

  tab.linkedBrowser.browsingContext.svalAgentTab = false;
  Assert.ok(
    !(await pageSeesModelContext(tab)),
    "a tab taken back: hidden at its next load"
  );
  BrowserTestUtils.removeTab(tab);
});

/**
 * A load that isolates the page replaces the tab's top-level browsing
 * context, and the replacement keeps the flag.
 */
add_task(async function a_replaced_context_keeps_the_flag() {
  await SpecialPowers.pushPrefEnv({
    set: [["dom.modelcontext.enabled", true]],
  });
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE),
    10_000,
    "a new tab's load"
  );
  registerCleanupFunction(() => {
    if (gBrowser.tabs.includes(tab)) {
      BrowserTestUtils.removeTab(tab);
    }
  });
  const before = tab.linkedBrowser.browsingContext;
  before.svalAgentTab = true;
  Assert.ok(
    await pageSeesModelContext(tab, ROOT + "sval_agent_coop.sjs"),
    "the isolated page sees modelContext"
  );
  const after = tab.linkedBrowser.browsingContext;
  Assert.notEqual(after, before, "the load replaced the browsing context");
  Assert.ok(after.svalAgentTab, "and the replacement carries the flag");
  BrowserTestUtils.removeTab(tab);
});

/**
 * Sval marks the tabs an agent works in, and unmarks a tab the user takes
 * out into their own window.
 */
add_task(async function agent_tabs_are_marked_and_a_taken_tab_is_not() {
  const { tabs, agent, call } = await agentSetup({
    sites: { "example.com": "full" },
  });
  Assert.ok(
    !gBrowser.selectedBrowser.browsingContext.svalAgentTab,
    "the user's own tab is not marked"
  );
  const { tab } = await call("open_tab", { url: PAGE });
  const found = await tabs.tabIn(agent, tab);
  await TestUtils.waitForCondition(
    () => found.tab.linkedBrowser.browsingContext.svalAgentTab,
    "the agent's tab is marked"
  );

  const taken = gBrowser.adoptTab(found.tab, { selectTab: false });
  atTaskEnd(async () => {
    if (taken.isConnected && !taken.closing) {
      await BrowserTestUtils.removeTab(taken);
    }
  });
  await TestUtils.waitForCondition(
    () => !taken.linkedBrowser.browsingContext.svalAgentTab,
    "a tab the user takes is unmarked"
  );
});
