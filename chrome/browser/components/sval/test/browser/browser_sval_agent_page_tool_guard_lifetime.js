/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_page_tools_helpers.js */

/**
 * Sites' tools (site-tools spec), continued from
 * `browser_sval_agent_page_tool_guards.js`: a call that stops waiting for the
 * user's answer about its tool, and the guard over the tool's page, which
 * lasts until its page goes, while the user holds the tab, and past agent
 * access.
 *
 * Each call here carries a progress token, and the agent cancels it while
 * the user decides: it stops waiting as a call does that runs out of time
 * (`ApprovalWait`), and leaves the tool running and the alert up.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_page_tools_helpers.js",
  this
);

add_setup(async function () {
  // "Let sites offer tools to agents", from which agent access derives
  // Gecko's own WebMCP switch (`SvalAgents`).
  await SpecialPowers.pushPrefEnv({
    set: [[SvalAgents.PAGE_TOOLS_PREF, true]],
  });
});

/**
 * Calls the tool `name` in `tab`, and stops waiting once the user is asked.
 *
 * @param {object} setup `toolsSetup`'s.
 * @param {Function} setup.callWithProgress
 * @param {Window} setup.win
 * @param {string} tab
 * @param {string} name
 * @param {object} [input]
 * @returns {Promise<Document>} The alert, still open.
 */
async function callThenStopWaiting(
  { callWithProgress, win },
  tab,
  name,
  input = {}
) {
  const calling = callWithProgress("call_page_tool", { tab, name, input });
  const doc = await alertIn(win);
  await calling.cancel();
  Assert.ok(win.gDialogBox.isOpen, "the alert stays up");
  return doc;
}

/**
 * A call that stops waiting for the user leaves its tool running. Whatever
 * the tool sends after that is refused, since no call is left to judge it.
 */
add_task(async function a_tool_left_running_sends_nothing_more() {
  const setup = await toolsSetup({ siteTools: "allow" });
  const posts = requestsTo(POST_PATH);
  const doc = await callThenStopWaiting(setup, setup.tab, "twice");
  // The user answers late, and lets the first write go.
  await choose(doc, "allow");
  await stopped(posts, 2);
  Assert.deepEqual(
    posts.stopped,
    [Cr.NS_OK, Cr.NS_ERROR_ABORT],
    "the first write was sent, and the second refused"
  );
});

/**
 * An Allow once given after the call stopped waiting is kept for the same
 * call, and while the call alert is open nothing else acts in the tab.
 */
add_task(async function a_late_allow_once_lets_the_same_call_run() {
  const setup = await toolsSetup({ siteTools: "allow" });
  const { call, tab, win, alerts } = setup;
  const doc = await callThenStopWaiting(setup, tab, "order", { item: "x" });
  const meanwhile = await call("call_page_tool", {
    tab,
    name: "search",
    input: { q: "y" },
  });
  Assert.equal(
    meanwhile.error,
    "awaiting_approval",
    "the tab waits on the open call alert"
  );
  await choose(doc, "allow");
  await TestUtils.waitForCondition(
    () => !win.gDialogBox.isOpen,
    "the alert closes"
  );
  const before = alerts.opened;
  const again = await call("call_page_tool", {
    tab,
    name: "order",
    input: { item: "x" },
  });
  Assert.deepEqual(again.result, { status: 200 });
  Assert.equal(
    alerts.opened,
    before,
    "the late answer is used, not asked again"
  );
  const other = call("call_page_tool", {
    tab,
    name: "order",
    input: { item: "z" },
  });
  await choose(await alertIn(win), "deny");
  Assert.equal(alerts.opened, before + 1, "another call is asked again");
  Assert.equal((await other).result, undefined, "and does not run");
});

/**
 * A tool that never answers keeps its tab from other actions only while its
 * page is the tab's: once the agent loads another page, the guard ends.
 */
add_task(async function a_guard_ends_with_its_page() {
  const setup = await toolsSetup({ siteTools: "allow" });
  const { call, tab } = setup;
  await choose(await callThenStopWaiting(setup, tab, "hang"), "deny");
  const busy = await call("call_page_tool", { tab, name: "search", input: {} });
  Assert.equal(busy.error, "page_tool_running", "the tool still runs");
  await call("navigate_tab", { tab, to: TOOLS_PAGE });
  const after = await call("call_page_tool", {
    tab,
    name: "search",
    input: { q: "again" },
  });
  Assert.deepEqual(after.result, { found: "again" }, "a new page acts again");
});

/**
 * A workspace the user takes is theirs to use, so the guard of a tool still
 * running there refuses nothing they send; given back, the page is guarded
 * again.
 */
add_task(async function the_user_writes_on_a_guarded_page_they_took() {
  const { giveBackWorkspace, holdWorkspace } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs"
  );
  const setup = await toolsSetup({ siteTools: "allow" });
  const { call, tab, tabs, agent } = setup;
  await choose(await callThenStopWaiting(setup, tab, "hang"), "deny");
  const busy = await call("call_page_tool", { tab, name: "search", input: {} });
  Assert.equal(busy.error, "page_tool_running", "the tool still runs");

  const { browser } = await tabs.tabIn(agent, tab);
  const post = () =>
    SpecialPowers.spawn(browser, [], () =>
      content
        .fetch("sval_agent_post.sjs", { method: "POST", body: "a=1" })
        .then(
          r => r.status,
          () => "refused"
        )
    );
  // As the layer's buttons do.
  holdWorkspace(agent.workspaceId, true);
  try {
    Assert.equal(await post(), 200, "the user's own write goes");
  } finally {
    giveBackWorkspace(agent.workspaceId);
  }
  Assert.equal(await post(), "refused", "given back, the page is guarded");
});

/**
 * A page the agent leaves for the back-forward cache, and comes back to,
 * is still guarded: its tool goes on running when it returns.
 */
add_task(async function a_page_back_from_the_cache_is_still_guarded() {
  const setup = await toolsSetup({ siteTools: "allow" });
  const { call, tab, tabs, agent } = setup;
  const posts = requestsTo(POST_PATH);
  const { browser } = await tabs.tabIn(agent, tab);
  const documentId = browser.browsingContext.currentWindowGlobal.innerWindowId;
  await choose(await callThenStopWaiting(setup, tab, "later"), "deny");
  await stopped(posts, 1);
  await call("navigate_tab", { tab, to: PAGE });
  await call("navigate_tab", { tab, to: "back" });
  if (
    browser.browsingContext.currentWindowGlobal.innerWindowId !== documentId
  ) {
    todo(false, "the page did not come back from the back-forward cache");
    return;
  }
  await postAgain(browser);
  await stopped(posts, 2);
  Assert.equal(
    posts.stopped[1],
    Cr.NS_ERROR_ABORT,
    "its later write is refused"
  );
});

/** Agent access going off does not stop a tool, nor its guard. */
add_task(async function a_guard_outlives_agent_access() {
  const setup = await toolsSetup({ siteTools: "allow" });
  const { tab, tabs, agent } = setup;
  const posts = requestsTo(POST_PATH);
  const { browser } = await tabs.tabIn(agent, tab);
  await choose(await callThenStopWaiting(setup, tab, "later"), "deny");
  await stopped(posts, 1);
  await agentAccessOff();
  await postAgain(browser);
  await stopped(posts, 2);
  Assert.equal(
    posts.stopped[1],
    Cr.NS_ERROR_ABORT,
    "its later write is refused"
  );
});
