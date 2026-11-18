/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_agent_on_helpers.js */

/**
 * Handing a tab to an agent (agent-control spec §5.4): the row menu's Move to
 * Workspace lists the agents' workspaces apart from the user's, choosing one
 * asks first, and the move that follows makes the tab the agent's for every
 * check.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_agent_on_helpers.js",
  this
);

const { isUserEntry } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * Answers the hand-over question the window asks, as a person does: leaves
 * its checkbox `checked` when it offers one, then presses Hand Over, or
 * Cancel unless `ok`.
 *
 * @param {boolean} ok
 * @param {boolean} [checked]
 * @returns {Promise<{state: string, history: boolean}>} the sign-ins the
 *   question said the tabs keep (`handToAgentText`), and whether it offered
 *   to include their history.
 */
async function answerHandOver(ok, checked = false) {
  const doc = await dialogIn(window, ".sval-dialog-actions button");
  const check = doc.querySelector(".sval-dialog-check");
  const asked = {
    state: doc.querySelector(".sval-dialog").dataset.state,
    history: !check.hidden,
  };
  const box = check.querySelector("input");
  if (!check.hidden && box.checked !== checked) {
    box.click();
  }
  doc.querySelector(`[data-button="${ok ? "ok" : "cancel"}"]`).click();
  await TestUtils.waitForCondition(
    () => gDialogBox.dialog?._frame?.contentDocument !== doc,
    "the question closes"
  );
  return asked;
}

/**
 * Records, for each of `ids`, whether the tab was marked as holding the
 * user's history at the moment its row left this window's panel, which is
 * the redraw the move into the agent's workspace makes.
 *
 * @param {string[]} ids Tab nodes.
 * @returns {boolean[]} filled in as each row goes.
 */
function markedAsRowsGo(ids) {
  const marked = [];
  const waiting = new Set(ids);
  const watch = new MutationObserver(() => {
    for (const id of [...waiting]) {
      if (!rowIn(window, id)) {
        waiting.delete(id);
        marked.push(SvalPanel.settings.hasUserHistory(id));
      }
    }
  });
  watch.observe(SvalPanel._els.tree, {
    subtree: true,
    childList: true,
    attributeFilter: ["class"],
  });
  atTaskEnd(() => watch.disconnect());
  return marked;
}

/**
 * A tab of the user's in this window, showing the test page.
 *
 * @returns {Promise<{tab: object, id: string}>}
 */
async function usersTab() {
  const tab = await openPage(PAGE);
  return { tab, id: await nodeOfTab(tab) };
}

/**
 * Chooses workspace `ws` in Move to Workspace on `id`'s row.
 *
 * @param {string} id
 * @param {string} ws
 */
async function moveVia(id, ws) {
  const menu = await contextMenuIn(window, id);
  await menuCommand(menu, `[data-move-workspace="${CSS.escape(ws)}"]`);
}

/**
 * @returns {Promise<object>} The tree as the engine holds it.
 */
async function treeNodes() {
  return (await SvalPanel.engine.tree()).nodes;
}

add_task(async function the_menu_lists_agents_workspaces_apart() {
  const { ws } = await agentSetup({ openWindow: false });
  const own = await SvalPanel.engine.mutate({
    kind: "addWorkspace",
    name: "Elsewhere",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  atTaskEnd(() => removeWorkspace(own));
  await SvalPanel.refresh();
  const { id } = await usersTab();

  const menu = await contextMenuIn(window, id);
  const entries = [
    ...menu.querySelector('[data-command="moveToWorkspace"] menupopup')
      .children,
  ];
  const at = selector => entries.findIndex(el => el.matches(selector));
  const caption = at("[data-agents-caption]");
  const ownAt = at(`[data-move-workspace="${CSS.escape(own)}"]`);
  const appAt = at("menu[data-agent-app]");
  Assert.greater(ownAt, -1, "the user's workspace is offered");
  Assert.ok(
    !entries[ownAt].hasAttribute("data-agent"),
    "as one of the user's own"
  );
  Assert.less(
    ownAt,
    at('[data-move-workspace=""]'),
    "the user's come before New Workspace"
  );
  Assert.less(
    at('[data-move-workspace=""]'),
    caption,
    "and New Workspace before the agents' caption"
  );
  Assert.ok(
    entries[caption].hasAttribute("disabled"),
    "the caption is no choice"
  );
  Assert.greater(appAt, caption, "the agent's app follows it");
  const agentEntry = entries[appAt].querySelector(
    `:scope > menupopup > [data-move-workspace="${CSS.escape(ws)}"]`
  );
  Assert.ok(agentEntry, "and lists the agent's workspace");
  Assert.equal(
    agentEntry.getAttribute("data-agent"),
    "true",
    "marked as an agent's"
  );
  Assert.ok(
    entries.slice(caption + 1).every(el => el.matches("menu[data-agent-app]")),
    "nothing of the user's is listed among the agents'"
  );
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(hidden, 10_000, "the row's menu closing");
});

add_task(async function cancelling_hands_nothing_over() {
  const { ws, gate, tabs, agent } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab, id } = await usersTab();
  const home = SvalWindowWorkspace.of(window).id;

  await moveVia(id, ws);
  Assert.deepEqual(
    await answerHandOver(false),
    { state: "kept", history: false },
    "Sval asks first, saying the tab keeps its sign-ins"
  );
  Assert.equal(
    (await treeNodes())[id].placement.parent,
    home,
    "the tab stays in the user's workspace"
  );
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  Assert.ok(gBrowser.tabs.includes(tab), "and in the user's window");
  Assert.equal(gate.agentOf(tab.linkedBrowser), null, "the gate's answer");
  Assert.ok(
    !(await tabs.listTabs(agent.workspaceId)).some(t => t.tab === id),
    "the agent's tab list does not have it"
  );
  Assert.ok(!gDialogBox.isOpen, "one question");
});

/**
 * Confirms a hand-over of a tab of the user's to the agent `setup` paired,
 * and waits until the agent's tools reach it.
 *
 * @param {object} setup What `agentSetup` returned.
 * @param {object} [options]
 * @param {string|null} [options.id] The tab's node, or null for a new tab
 *   of the test page.
 * @param {boolean} [options.checked] The dialog's checkbox, as left.
 * @returns {Promise<{asked: object, found: object, id: string}>} `asked` is
 *   what {@link answerHandOver} read of the one question.
 */
async function handOver(setup, { id = null, checked = false } = {}) {
  const { ws, tabs, agent } = setup;
  id ??= (await usersTab()).id;
  await moveVia(id, ws);
  const asked = await answerHandOver(true, checked);
  await TestUtils.waitForCondition(
    async () => (await treeNodes())[id]?.placement.parent === ws,
    "the tab is filed under the agent's workspace"
  );
  let found = null;
  await TestUtils.waitForCondition(async () => {
    try {
      found = await tabs.tabIn(agent, id);
      return found.tab.documentGlobal === setup.win;
    } catch {
      return false;
    }
  }, "the agent's window holds the tab, and its tools reach it");
  Assert.ok(!gDialogBox.isOpen, "Sval asked once");
  return { asked, found, id };
}

add_task(async function confirming_hands_the_tab_to_the_agent() {
  const setup = await agentSetup({ sites: { "example.com": "full" } });
  const { found } = await handOver(setup);
  const browser = found.tab.linkedBrowser;
  await TestUtils.waitForCondition(
    () => setup.gate.agentOf(browser) !== null,
    "the gate decides for the tab as the agent's"
  );
  await TestUtils.waitForCondition(
    () => browser.browsingContext?.svalAgentTab,
    "and its pages get WebMCP"
  );
});

add_task(async function a_released_tab_arrives_without_its_history() {
  const setup = await agentSetup({ sites: { "example.com": "full" } });
  const id = await tabWithHistory();
  const { asked, found } = await handOver(setup, { id });
  Assert.deepEqual(
    asked,
    { state: "kept", history: false },
    "the question offers no history, as none goes with the tab"
  );
  const { sessionHistory } = found.tab.linkedBrowser.browsingContext;
  const urls = [];
  for (let i = 0; i < sessionHistory.count; i++) {
    urls.push(sessionHistory.getEntryAtIndex(i).URI.spec);
  }
  Assert.ok(!urls.includes(PAGE2), "the user's earlier page is not in it");
});

/**
 * A tab of the user's with two pages in its history, the earlier one PAGE2.
 *
 * @returns {Promise<object>} the tab.
 */
async function tabWithTwoPages() {
  const tab = await openPage(PAGE2);
  const browser = tab.linkedBrowser;
  const loaded = BrowserTestUtils.browserLoaded(browser, false, PAGE);
  await SpecialPowers.spawn(browser, [PAGE], u => {
    content.location.href = u;
  });
  await within(loaded, 10_000, "the tab's second page");
  return tab;
}

/**
 * @returns {Promise<string>} The node id of {@link tabWithTwoPages}'s tab.
 */
async function tabWithHistory() {
  return nodeOfTab(await tabWithTwoPages());
}

/**
 * {@link tabWithTwoPages}'s tab with text typed into its page, which the
 * release keeps loaded.
 *
 * @returns {Promise<string>} its node id.
 */
async function typedTabWithHistory() {
  const tab = await tabWithTwoPages();
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [], () => {
    const field = content.document.getElementById("email");
    field.value = "typed@example.com";
    field.dispatchEvent(new content.Event("input", { bubbles: true }));
  });
  return nodeOfTab(tab);
}

/**
 * Hands over a typed tab with two pages of history, leaving the dialog's
 * checkbox `checked`.
 *
 * @param {boolean} checked
 * @returns {Promise<{asked: object, browser: object, id: string}>}
 */
async function handOverTypedTab(checked) {
  const setup = await agentSetup({ sites: { "example.com": "full" } });
  const id = await typedTabWithHistory();
  const { asked, found } = await handOver(setup, { id, checked });
  Assert.deepEqual(
    asked,
    { state: "kept", history: true },
    "the question offers the tab's history"
  );
  const browser = found.tab.linkedBrowser;
  Assert.equal(
    browser.browsingContext.sessionHistory.count,
    2,
    "the tab arrives loaded, with its history"
  );
  Assert.equal(
    await SpecialPowers.spawn(
      browser,
      [],
      () => content.document.getElementById("email").value
    ),
    "typed@example.com",
    "and the text typed into it"
  );
  return { asked, browser, id };
}

/**
 * @param {object} browser
 * @param {string} id Its node id.
 * @returns {boolean} Whether the agent is kept from the tab's first entry.
 */
function firstEntryIsUsers(browser, id) {
  const { sessionHistory, browserId } = browser.browsingContext;
  return isUserEntry(browserId, sessionHistory.getEntryAtIndex(0).ID, id);
}

add_task(async function a_hand_over_keeps_the_users_history_by_default() {
  const { browser, id } = await handOverTypedTab(false);
  Assert.ok(
    firstEntryIsUsers(browser, id),
    "the agent cannot step into the user's earlier page"
  );
});

add_task(async function a_hand_over_can_include_the_users_history() {
  const { browser, id } = await handOverTypedTab(true);
  Assert.ok(
    !firstEntryIsUsers(browser, id),
    "the agent may step into the user's earlier page"
  );
});

add_task(async function a_hand_over_into_an_isolated_workspace_asks_once() {
  const setup = await agentSetup({
    sites: { "example.com": "full" },
    isolated: true,
  });
  const { asked, found } = await handOver(setup);
  Assert.deepEqual(
    asked,
    { state: "separate", history: false },
    "one question, saying the tab reloads with separate sign-ins"
  );
  await TestUtils.waitForCondition(
    () => found.tab.userContextId === setup.win.gBrowser.defaultUserContextId,
    "the tab is in the agent's jar"
  );
  Assert.notEqual(found.tab.userContextId, 0, "which is not the user's");
});

/**
 * A tab handed over without its history is marked as the user's before the
 * move makes it the agent's, so no check the agent's tools make on the moved
 * tab finds it unmarked.
 */
add_task(async function the_mark_comes_before_the_move() {
  const setup = await agentSetup({ sites: { "example.com": "full" } });
  const id = await typedTabWithHistory();
  const marked = markedAsRowsGo([id]);
  const { found } = await handOver(setup, { id, checked: false });
  Assert.deepEqual(marked, [true], "the tab was marked before it moved");
  Assert.ok(
    firstEntryIsUsers(found.tab.linkedBrowser, id),
    "and the agent cannot step into the user's earlier page"
  );
});

add_task(async function a_selection_is_handed_over_after_one_question() {
  const setup = await agentSetup({ sites: { "example.com": "full" } });
  const { id: plain } = await usersTab();
  const typed = await typedTabWithHistory();
  const markedAtMove = markedAsRowsGo([plain, typed]);
  // The typed tab is on screen, so an Accel-click on the other selects both
  // (spec §10.5).
  AccessibilityUtils.setEnv({ nonNegativeTabIndexRule: false });
  EventUtils.synthesizeMouseAtCenter(
    rowIn(window, plain),
    { accelKey: true },
    window
  );
  AccessibilityUtils.resetEnv();
  Assert.deepEqual(
    [plain, typed].map(
      id => rowIn(window, id).getAttribute("aria-selected") === "true"
    ),
    [true, true],
    "both rows are selected"
  );

  await moveVia(plain, setup.ws);
  const asked = await answerHandOver(true, false);
  await TestUtils.waitForCondition(async () => {
    const nodes = await treeNodes();
    return [plain, typed].every(id => nodes[id]?.placement.parent === setup.ws);
  }, "both tabs are filed under the agent's workspace");
  Assert.deepEqual(
    asked,
    { state: "kept", history: true },
    "one question, for both tabs, offering the history one of them has"
  );
  Assert.ok(!gDialogBox.isOpen, "and no other");
  await TestUtils.waitForCondition(
    () => markedAtMove.length === 2,
    "both rows leave the panel"
  );
  Assert.deepEqual(
    markedAtMove,
    [true, true],
    "each tab was marked before the move"
  );
});
