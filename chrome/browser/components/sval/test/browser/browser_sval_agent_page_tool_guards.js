/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_page_tools_helpers.js */

/**
 * Sites' tools (site-tools spec), continued from
 * `browser_sval_agent_page_tools.js`: the write gate around a running tool,
 * the guard over what it sends between its windows, and a call waiting on a
 * dialog. `browser_sval_agent_page_tool_guard_lifetime.js` continues it.
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
 * A write the tool sends after the user answered about its first is judged
 * too: the tool's whole run is gated, however many windows it takes.
 */
add_task(async function every_write_of_a_running_tool_is_judged() {
  const { call, tab, win } = await toolsSetup({ siteTools: "allow" });
  const calling = call("call_page_tool", { tab, name: "twice", input: {} });
  await choose(await alertIn(win), "allow");
  await TestUtils.waitForCondition(
    () => !win.gDialogBox.isOpen,
    "the first alert closes"
  );
  const second = await alertIn(win);
  Assert.strictEqual(
    second.querySelector(".sval-aa").dataset.kind,
    "writes",
    "the second write is asked about"
  );
  await choose(second, "deny");
  const answer = await calling;
  Assert.deepEqual(answer.result, { first: 200, second: "refused" });
  Assert.equal(answer.writes, "denied");
});

/**
 * A write the tool sends while the user is still answering about an earlier
 * one falls between the call's windows, and the guard refuses it.
 */
add_task(async function a_write_between_windows_is_refused() {
  const { call, tab, win, tabs, agent } = await toolsSetup({
    siteTools: "allow",
  });
  const posts = requestsTo(POST_PATH);
  const { browser } = await tabs.tabIn(agent, tab);
  const calling = call("call_page_tool", { tab, name: "gap", input: {} });
  const doc = await alertIn(win);
  // The tool's second write goes, and ends, while the alert is up: the first
  // is still held.
  await postAgain(browser);
  await stopped(posts, 1);
  Assert.deepEqual(posts.stopped, [Cr.NS_ERROR_ABORT], "the second, refused");
  await choose(doc, "allow");
  const answer = await calling;
  Assert.deepEqual(answer.result, { first: 200, second: "refused" });
});

/**
 * A tool that raises a confirm waits for it like a click does: the call
 * answers with the dialog, answer_dialog gets through the tool's guard, and
 * what the answer sets off meets the write gate.
 */
add_task(async function a_tool_waiting_on_a_dialog_is_answered() {
  const made = await dialogsSetup({ level: "ask-before-writes" });
  const { store, agent, win, tab } = made;
  await store.setPageTools(agent.agentId, "on");
  await store.setPageToolSite(agent.agentId, "example.com", "allow");
  const call = async (name, args) => {
    try {
      return await made.call(name, args);
    } catch (err) {
      if (!err?.code) {
        throw err;
      }
      return { error: err.code, message: err.message, ...err.details };
    }
  };
  await call("navigate_tab", { tab, to: TOOLS_PAGE });
  const answer = await call("call_page_tool", {
    tab,
    name: "confirm",
    input: {},
  });
  Assert.ok(answer.dialog_open, "the call answers with the dialog open");
  const answering = call("answer_dialog", { tab, accept: true });
  const doc = await alertIn(win);
  Assert.strictEqual(
    doc.querySelector(".sval-aa").dataset.kind,
    "writes",
    "the write the answer set off is asked about"
  );
  await choose(doc, "allow");
  const answered = await answering;
  Assert.notEqual(answered.error, "page_tool_running");
  Assert.equal(answered.writes, "allowed");
});
