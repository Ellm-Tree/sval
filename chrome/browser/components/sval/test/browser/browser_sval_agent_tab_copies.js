/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_take_control_helpers.js */

/**
 * A copy of a tab filed into an agent's workspace is the agent's only when
 * its original was the agent's to use (agent-control spec §6). A copy of one
 * of the user's own tabs carries the user's history and form data, so the
 * user takes the workspace it lands in; a copy in a workspace the user holds
 * is theirs with every other tab there.
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

function nodeIdOf(tab) {
  return SessionStore.getCustomTabValue(tab, "sval-node-id") || null;
}

/**
 * Waits for `copy` to have been restored and filed as a node of its own in
 * the agent's window.
 *
 * @param {Window} win The agent's window.
 * @param {object} copy
 * @param {string} originalId The node id its original carries.
 * @returns {Promise<string>} the copy's node id.
 */
async function filedCopy(win, copy, originalId) {
  await within(
    BrowserTestUtils.waitForEvent(copy, "SSTabRestored"),
    10_000,
    "the copy's restore"
  );
  await within(win.SvalPanel.observer.settled(), 10_000, "the agent window");
  const id = nodeIdOf(copy);
  Assert.ok(id && id !== originalId, "the copy is a node of its own");
  return id;
}

/**
 * What `list_tabs` says of node `id`.
 *
 * @param {object} tabs The agent's tabs.
 * @param {object} agent
 * @param {string} id A node id.
 */
async function listed(tabs, agent, id) {
  return (await tabs.listTabsFor(agent)).find(t => t.tab === id);
}

add_task(async function a_copy_of_a_taken_tab_is_the_users() {
  const { call, tab, tabs, agent, win, browser } = await layerSetup();
  await takeControlOf(win, browser);
  const copy = win.gBrowser.duplicateTab(
    win.gBrowser.getTabForBrowser(browser),
    true
  );
  const id = await filedCopy(win, copy, tab);

  Assert.ok(
    isUserInControl(copy.linkedBrowser.browsingContext.browserId),
    "the copy is in the user's control"
  );
  Assert.ok(
    SvalPanel.settings.isUserHeld(win.SvalPanel.workspaceId),
    "with the workspace"
  );
  Assert.ok((await listed(tabs, agent, id))?.user_in_control, "list_tabs");
  await Assert.rejects(
    call("get_page_text", { tab: id }),
    e => e.code === "user_in_control",
    "the agent cannot read it"
  );
});

add_task(async function a_copy_of_the_users_tab_in_an_agents_window() {
  const { call, tabs, agent, win } = await layerSetup();
  const mine = BrowserTestUtils.addTab(gBrowser, INPUT);
  await within(
    BrowserTestUtils.browserLoaded(mine.linkedBrowser, false, INPUT),
    10_000,
    "the user's tab's load"
  );
  await within(SvalPanel.observer.settled(), 10_000, "the user's window");
  atTaskEnd(() => BrowserTestUtils.removeTab(mine));
  const copy = SessionStore.duplicateTab(win, mine);
  const id = await filedCopy(win, copy, nodeIdOf(mine));

  Assert.ok(
    isUserInControl(copy.linkedBrowser.browsingContext.browserId),
    "the copy is in the user's control"
  );
  Assert.ok(
    SvalPanel.settings.isUserHeld(win.SvalPanel.workspaceId),
    "for the user took the workspace it landed in"
  );
  Assert.ok((await listed(tabs, agent, id))?.user_in_control, "list_tabs");
  await Assert.rejects(
    call("get_page_text", { tab: id }),
    e => e.code === "user_in_control",
    "the agent cannot read it"
  );
});

add_task(async function a_copy_of_an_agents_tab_is_the_agents() {
  const { tab, tabs, agent, win, browser } = await layerSetup();
  const copy = win.gBrowser.duplicateTab(
    win.gBrowser.getTabForBrowser(browser),
    true
  );
  const id = await filedCopy(win, copy, tab);

  Assert.ok(
    !isUserInControl(copy.linkedBrowser.browsingContext.browserId),
    "the copy is the agent's"
  );
  const entry = await listed(tabs, agent, id);
  Assert.ok(entry && !entry.user_in_control, "and list_tabs lists it so");
});

/**
 * A copy of a tab in a workspace the user holds is the user's from the
 * moment the copied values land, while its filing still waits on the
 * observer's queue: it never stands for the original's node, and the agent's
 * tools reach the original, in the workspace the user holds, and never the
 * copy.
 */
add_task(async function a_copy_not_yet_filed_reaches_no_agent_tool() {
  const { call, tab, win, browser } = await layerSetup();
  await takeControlOf(win, browser);
  const original = win.gBrowser.getTabForBrowser(browser);
  const engine = win.SvalPanel.engine;
  const mutate = engine.mutate;
  const held = Promise.withResolvers();
  let holding = true;
  engine.mutate = async op => {
    if (holding && op.kind === "addTab") {
      holding = false;
      await held.promise;
    }
    return mutate.call(engine, op);
  };
  atTaskEnd(() => {
    held.resolve();
    engine.mutate = mutate;
  });
  const copy = win.gBrowser.duplicateTab(original, true);
  await within(
    BrowserTestUtils.waitForEvent(copy, "SSTabCustomValuesRestored"),
    10_000,
    "the copy's values landing"
  );
  Assert.notEqual(nodeIdOf(copy), tab, "the copy carries an id of its own");
  Assert.ok(
    isUserInControl(copy.linkedBrowser.browsingContext.browserId),
    "and is in the user's control already"
  );
  Assert.equal(
    win.SvalPanel.observer.tabFor(tab),
    original,
    "the node's tab is the original"
  );
  await Assert.rejects(
    call("get_page_text", { tab }),
    e => e.code === "user_in_control",
    "and the agent's tools reach the original, which the user holds"
  );

  held.resolve();
  await within(win.SvalPanel.observer.settled(), 10_000, "the agent window");
  const id = nodeIdOf(copy);
  Assert.ok(id && id !== tab, "filed, the copy is a node of its own");
  Assert.ok(
    SvalPanel.settings.isUserHeld(win.SvalPanel.workspaceId),
    "the workspace is the user's"
  );
});

/**
 * A tool already running on an agent's tab sends it nothing more once
 * another tab's state lands in it: the copied values make it a copy of the
 * user's tab, and the user takes the workspace as they land, before the
 * tool's next input is dispatched.
 */
add_task(async function a_running_tool_sends_nothing_once_a_copy_lands() {
  const { call, reply, tab, tabEl: target, browser } = await layerSetup();
  await SpecialPowers.spawn(browser, [], () => {
    const second = content.document.createElement("input");
    second.id = "second";
    second.setAttribute("aria-label", "Second");
    content.document.body.append(second);
  });
  const first = await refFor(call, tab, /textbox "Field" \[(e\d+)\]/);
  const second = await refFor(call, tab, /textbox "Second" \[(e\d+)\]/);
  const mine = BrowserTestUtils.addTab(gBrowser, INPUT);
  await within(
    BrowserTestUtils.browserLoaded(mine.linkedBrowser, false, INPUT),
    10_000,
    "the user's tab's load"
  );
  await within(SvalPanel.observer.settled(), 10_000, "the user's window");
  atTaskEnd(() => BrowserTestUtils.removeTab(mine));

  // The copy lands as the first field takes its first input: the page's
  // event reaches the parent before the input's own answer does, so it
  // lands before the form goes on to the second field.
  const firstInput = BrowserTestUtils.waitForContentEvent(
    browser,
    "input",
    true,
    event => event.target.id !== "second"
  );
  const landed = firstInput.then(() =>
    SessionStore.setTabState(target, SessionStore.getTabState(mine))
  );
  const result = await reply("fill_form", {
    tab,
    fields: [
      { ref: first, text: "one" },
      { ref: second, text: "two" },
    ],
  });
  await within(landed, 10_000, "the copy landing");
  Assert.equal(result.error, "user_in_control", "the form stops");
  Assert.less(
    result.filled ?? 0,
    2,
    "and the field after the copy landed was never filled"
  );
  Assert.ok(
    isUserInControl(target.linkedBrowser.browsingContext.browserId),
    "the tab is in the user's control"
  );
  Assert.equal(nodeIdOf(target), tab, "under its own node");
});
