/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_agent_session_helpers.js */

/**
 * Pairing an agent over Sval's listener and what its session answers once
 * paired (agent-control spec §3.2): the secret goes to sval-mcp alone, the
 * task names the workspace, connections of one launch share one pairing,
 * and every refusal is a tool error the agent can read.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_agent_session_helpers.js",
  this
);
const { MAX_WAITING_CALLS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentAlerts.sys.mjs"
);
const { POLITE_RATE_PREF, politeRules } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentPolite.sys.mjs"
);
const { politeSentence } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentToolsWorkspace.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
});

const bodyOf = result => JSON.parse(result.content[0].text);
const errorOf = result => bodyOf(result).error;

/**
 * Pairs `agent`: says who its client is, asks with `args`, and presses Pair
 * on the alert.
 *
 * @param {object} agent What `connectAgent` returned.
 * @param {object} [options]
 * @param {object} [options.args] request_shared_pairing's arguments.
 * @param {object} [options.clientInfo] Who the agent's client says it is.
 * @returns {Promise<{result: object, agentId: string, secret: string,
 *   record: object}>}
 */
async function pairAgent(
  agent,
  { args = { task: AGENT_LABEL }, clientInfo = { name: AGENT_LABEL } } = {}
) {
  agent.identify(clientInfo);
  const id = agent.pairing(args);
  await pair(await pairingAlert());
  const { result } = await agent.reply(id);
  return { result, ...(await agent.paired()) };
}

/**
 * Asks to pair from each of `agents` at once, and waits for the one alert
 * they share.
 *
 * @param {object[]} agents What `connectAgent` returned, each.
 * @returns {Promise<{ids: number[], doc: Document}>}
 */
async function pairTogether(agents) {
  for (const agent of agents) {
    agent.identify({ name: AGENT_LABEL });
  }
  const ids = agents.map(agent => agent.pairing());
  return { ids, doc: await pairingAlert() };
}

add_task(
  async function allowing_pairs_and_hands_the_secret_to_the_bridge_only() {
    const agent = await connectAgent();
    const before = await agentsWorkspaces();
    const { result, secret, record } = await pairAgent(agent, {
      clientInfo: { name: "Claude Code" },
    });
    Assert.ok(!result.isError);
    Assert.ok(/^[0-9a-f]{64}$/.test(secret), "sval-mcp gets the secret");
    Assert.ok(
      !JSON.stringify(result).includes(secret),
      "the secret never reaches the model"
    );
    const frames = agent.client.frames;
    Assert.less(
      frames.findIndex(f => f.ctl?.paired),
      frames.findIndex(f => f.mcp?.id === 1),
      "secret before result"
    );
    Assert.ok(
      frames.some(f => f.mcp?.method === "notifications/tools/list_changed")
    );
    Assert.equal(record.label, "Claude Code");
    Assert.deepEqual(
      (await agentsWorkspaces()).filter(ws => !before.includes(ws)),
      record.workspaces.map(w => w.workspaceId),
      "one workspace made, the session's"
    );
    Assert.stringContains(
      result.content[0].text,
      record.workspaces[0].workspaceId,
      "and the agent is given its id"
    );

    const { result: list } = await agent.request("tools/list");
    const names = list.tools.map(t => t.name);
    Assert.deepEqual(names.slice(0, 5), [
      "list_tabs",
      "set_task",
      "use_workspace",
      "close_window",
      "delete_workspace",
    ]);
    Assert.ok(names.includes("open_tab"), "and the agent's tools");
    Assert.deepEqual(
      list.tools[0].annotations,
      { readOnlyHint: true },
      "list_tabs is read-only"
    );
  }
);

add_task(async function denying_pairs_nothing() {
  const agent = await connectAgent();
  const before = await agentsWorkspaces();
  const id = agent.pairing();
  (await pairingAlert()).querySelector(".sval-ap-deny").click();
  const { result } = await agent.reply(id);
  Assert.equal(errorOf(result), "pairing_denied");
  Assert.ok(!agent.client.frames.some(f => f.ctl?.paired), "no secret");
  Assert.deepEqual(await agentsWorkspaces(), before, "no workspace");
});

add_task(async function concurrent_pairing_requests_share_one_alert() {
  const agent = await connectAgent();
  const alerts = countAlerts(window);
  const first = agent.pairing();
  const second = agent.pairing();
  await pair(await pairingAlert());
  for (const id of [first, second]) {
    Assert.ok(!(await agent.reply(id)).result.isError, `request ${id}`);
  }
  Assert.equal(alerts.opened, 1, "one alert");
  Assert.equal(
    agent.client.frames.filter(f => f.ctl?.paired).length,
    1,
    "one secret"
  );
});

add_task(async function a_paired_agent_lists_its_own_workspace() {
  const agent = await connectAgent();
  const { agentId, record } = await pairAgent(agent, {
    args: { task: "Compare prices" },
  });
  const { result } = await agent.request("tools/call", {
    name: "list_tabs",
    arguments: {},
  });
  Assert.deepEqual(bodyOf(result), {
    workspace: "Compare prices",
    workspace_id: record.workspaces[0].workspaceId,
    tabs: [],
    polite: politeRules(agentId),
  });
});

/**
 * A refused call is a tool error: JSON carrying its code, and the tab it
 * names once its arguments are checked.
 */
add_task(async function every_refusal_is_a_tool_error_naming_its_tab() {
  const agent = await connectAgent();
  await pairAgent(agent);
  const call = async (name, args) =>
    (await agent.request("tools/call", { name, arguments: args })).result;

  const unchecked = await call("get_snapshot", {});
  Assert.ok(unchecked.isError);
  Assert.equal(errorOf(unchecked), "invalid_arguments");
  Assert.equal(bodyOf(unchecked).tab, undefined, "unchecked names no tab");

  const elsewhere = await call("get_snapshot", { tab: "no-such-tab" });
  Assert.ok(elsewhere.isError);
  Assert.equal(errorOf(elsewhere), "not_controlled");
  Assert.equal(bodyOf(elsewhere).tab, "no-such-tab", "checked names its tab");

  Assert.equal(errorOf(await call("nope", {})), "unknown_tool");
});

/**
 * The user tells agents apart by what each is doing, so the task names the
 * workspace, and the client names the agent wherever Sval says what it does.
 */
add_task(
  async function the_task_names_the_workspace_and_the_client_the_agent() {
    const agent = await connectAgent({
      launch: freshLaunch({ dir: "/work/sval", started: 1_700_000_000_000 }),
    });
    const { record } = await pairAgent(agent, {
      args: { task: "Fix login redirect" },
      clientInfo: { name: "claude-code" },
    });
    Assert.equal(record.label, "claude-code", "the client names the agent");
    Assert.equal(record.client, "claude-code");
    const [workspace] = record.workspaces;
    Assert.equal(workspace.task, "Fix login redirect");
    Assert.equal(workspace.dir, "/work/sval");
    Assert.equal(workspace.started, 1_700_000_000_000);
    const { nodes } = await SvalPanel.engine.tree();
    Assert.equal(
      nodes[workspace.workspaceId].content.name,
      "Fix login redirect",
      "the task names the workspace"
    );
    const { result } = await agent.request("tools/call", {
      name: "list_tabs",
      arguments: {},
    });
    Assert.equal(bodyOf(result).workspace, "Fix login redirect");
  }
);

add_task(async function the_agent_is_named_by_its_clients_title() {
  const title = "Claude Code";
  const model = "Opus 5.5";
  const agent = await connectAgent();
  const { record } = await pairAgent(agent, {
    args: { task: "Compare prices", model },
    clientInfo: { name: "claude-code", title },
  });
  Assert.equal(record.label, title, "one agent, whatever model a session runs");
  Assert.equal(record.client, title);
  Assert.equal(record.workspaces[0].model, model, "kept with its workspace");
});

/**
 * A paired agent renames its workspace when it moves on to other work, and
 * a pairing tool called once paired does the same.
 */
add_task(async function a_paired_agent_renames_its_workspace_for_a_new_task() {
  const agent = await connectAgent();
  const { record } = await pairAgent(agent, { args: { task: "First job" } });
  const nameNow = async () =>
    (await SvalPanel.engine.tree()).nodes[record.workspaces[0].workspaceId]
      .content.name;
  for (const [tool, task] of [
    ["set_task", "Second job"],
    ["request_shared_pairing", "Third job"],
  ]) {
    const { result } = await agent.request("tools/call", {
      name: tool,
      arguments: { task },
    });
    Assert.ok(!result.isError, tool);
    Assert.equal(await nameNow(), task, `${tool} renames the workspace`);
    const listed = await agent.request("tools/call", {
      name: "list_tabs",
      arguments: {},
    });
    Assert.equal(bodyOf(listed.result).workspace, task);
    const bad = await agent.request("tools/call", {
      name: tool,
      arguments: { task: "‮" },
    });
    Assert.equal(errorOf(bad.result), "invalid_arguments");
    Assert.equal(await nameNow(), task, "a task Sval cannot show renames none");
  }
});

/**
 * Connections that say one launch id are sessions of one app: they raise one
 * alert between them, Allow pairs them as one agent, and each has a
 * workspace of its own. Two ids are two apps, and pair as two.
 */
add_task(async function one_launch_pairs_once_and_two_pair_twice() {
  const launch = freshLaunch();
  const same = [await connectAgent({ launch }), await connectAgent({ launch })];
  const alerts = countAlerts(window);
  const { ids, doc } = await pairTogether(same);
  await pair(doc);
  for (const [i, agent] of same.entries()) {
    Assert.ok(!(await agent.reply(ids[i])).result.isError);
  }
  const [a, b] = await Promise.all(same.map(agent => agent.paired()));
  Assert.equal(a.agentId, b.agentId, "one agent");
  Assert.equal(alerts.opened, 1, "one alert");
  Assert.equal(
    SvalAgents.store.agents().find(x => x.agentId === a.agentId).workspaces
      .length,
    2,
    "a workspace for each session"
  );

  const two = [await connectAgent(), await connectAgent()];
  for (const agent of two) {
    await pairAgent(agent);
  }
  const [c, d] = await Promise.all(two.map(agent => agent.paired()));
  Assert.notEqual(c.agentId, d.agentId, "two apps pair as two");
  Assert.notEqual(
    c.record.workspaces[0].workspaceId,
    d.record.workspaces[0].workspaceId
  );
});

/**
 * An app whose sval-mcp lost its secret pairs again as the agent it was, so
 * Settings lists it once and its rules still apply.
 */
add_task(async function an_app_that_pairs_again_keeps_its_agent() {
  const launch = freshLaunch();
  const first = await pairAgent(await connectAgent({ launch }));
  await SvalAgents.store.setSiteLevel(first.agentId, "example.com", "full");
  const again = await pairAgent(await connectAgent({ launch }));
  Assert.equal(again.agentId, first.agentId, "the same agent");
  Assert.equal(
    SvalAgents.store.agents().filter(a => a.agentId === first.agentId).length,
    1
  );
  Assert.equal(
    SvalAgents.store.policyOf(first.agentId).sites["example.com"],
    "full",
    "its rules stay"
  );
});

add_task(async function a_denied_shared_pairing_denies_both() {
  const launch = freshLaunch();
  const agents = [
    await connectAgent({ launch }),
    await connectAgent({ launch }),
  ];
  const before = await agentsWorkspaces();
  const { ids, doc } = await pairTogether(agents);
  doc.querySelector(".sval-ap-deny").click();
  for (const [i, agent] of agents.entries()) {
    Assert.equal(errorOf((await agent.reply(ids[i])).result), "pairing_denied");
  }
  Assert.deepEqual(await agentsWorkspaces(), before, "no workspace");
});

/** One connection leaving does not stop the other from pairing. */
add_task(async function a_shared_pairing_survives_one_side_closing() {
  const launch = freshLaunch();
  const agents = [
    await connectAgent({ launch }),
    await connectAgent({ launch }),
  ];
  const before = await agentsWorkspaces();
  const { ids, doc } = await pairTogether(agents);
  agents[0].client.close();
  await pair(doc);
  Assert.ok(!(await agents[1].reply(ids[1])).result.isError);
  const { record } = await agents[1].paired();
  Assert.ok(record, "the open side is paired");
  Assert.deepEqual(
    (await agentsWorkspaces()).filter(ws => !before.includes(ws)),
    record.workspaces.map(w => w.workspaceId),
    "in one workspace"
  );
});

/**
 * Sites' tools join a paired agent's list when the user lets sites offer
 * them, and the agent is told its tools changed (site-tools spec §5.1).
 */
add_task(async function site_tools_come_and_go_with_list_changed() {
  await SpecialPowers.pushPrefEnv({
    set: [[SvalAgents.PAGE_TOOLS_PREF, false]],
  });
  const agent = await connectAgent();
  await pairAgent(agent);
  const names = async () =>
    (await agent.request("tools/list")).result.tools.map(t => t.name);
  const changed = () =>
    agent.client.frames.filter(
      f => f.mcp?.method === "notifications/tools/list_changed"
    ).length;
  Assert.ok(!(await names()).includes("list_page_tools"));
  const before = changed();
  await SpecialPowers.pushPrefEnv({
    set: [[SvalAgents.PAGE_TOOLS_PREF, true]],
  });
  await agent.client.waitFor(
    () => changed() > before,
    10_000,
    "the agent is told its tools changed"
  );
  Assert.ok((await names()).includes("list_page_tools"), "they join the list");
  await SpecialPowers.popPrefEnv();
  await agent.client.waitFor(
    () => changed() > before + 1,
    10_000,
    "and again as they go"
  );
  Assert.ok(!(await names()).includes("list_page_tools"), "they leave it");
});

/**
 * The agent is told the rules Be polite holds it to: in list_tabs's result
 * and description, and, when the user changes them, by list_changed.
 */
add_task(async function the_polite_rules_are_told_and_a_change_is_announced() {
  await SpecialPowers.pushPrefEnv({ clear: [[POLITE_RATE_PREF]] });
  const agent = await connectAgent();
  const { agentId } = await pairAgent(agent);
  const description = async () =>
    (await agent.request("tools/list")).result.tools.find(
      t => t.name === "list_tabs"
    ).description;
  const changed = () =>
    agent.client.frames.filter(
      f => f.mcp?.method === "notifications/tools/list_changed"
    ).length;
  const first = await description();
  Assert.ok(first.endsWith(politeSentence(politeRules(agentId))));
  const { result } = await agent.request("tools/call", {
    name: "list_tabs",
    arguments: {},
  });
  Assert.deepEqual(bodyOf(result).polite, politeRules(agentId));

  const before = changed();
  await SpecialPowers.pushPrefEnv({ set: [[POLITE_RATE_PREF, 2]] });
  await agent.client.waitFor(
    () => changed() > before,
    10_000,
    "a new rate is announced"
  );
  const second = await description();
  Assert.ok(second.endsWith(politeSentence(politeRules(agentId))));
  Assert.notEqual(second, first, "and the description says it");
});

/**
 * At most `MAX_WAITING_CALLS` calls of one connection wait for the user at
 * once. One more that would wait answers awaiting_approval at once, and a
 * call that does not wait still runs.
 */
add_task(async function a_ninth_waiting_call_answers_awaiting_approval() {
  const agent = await connectAgent();
  agent.identify({ name: AGENT_LABEL });
  const waiting = [];
  for (let i = 0; i < MAX_WAITING_CALLS; i++) {
    waiting.push(
      agent.send("tools/call", {
        name: "request_shared_pairing",
        arguments: { task: AGENT_LABEL },
        _meta: { progressToken: `wait-${i}` },
      })
    );
  }
  const doc = await pairingAlert();
  await agent.client.waitFor(
    () =>
      waiting.every(id =>
        agent.client.frames.some(
          f =>
            f.mcp?.method === "notifications/progress" &&
            f.mcp.params.progressToken === `wait-${waiting.indexOf(id)}`
        )
      ),
    10_000,
    "every call waiting for the user"
  );
  const { result } = await agent.reply(agent.pairing());
  Assert.equal(
    errorOf(result),
    "awaiting_approval",
    "one more answers at once"
  );
  Assert.ok(
    (await agent.request("tools/list")).result,
    "a request that does not wait"
  );
  await pair(doc);
  for (const id of waiting) {
    Assert.ok(!(await agent.reply(id)).result.isError, "those waiting pair");
  }
});
