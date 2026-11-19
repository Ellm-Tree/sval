/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_agent_session_helpers.js */

/**
 * What an agent that is not paired meets on Sval's listener (agent-control
 * spec §3.2): the two pairing tools, and the edges of what sval-mcp sends
 * on. MCP's versions, `initialize` and `ping` are sval-mcp's to answer, and
 * its own tests cover them.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_agent_session_helpers.js",
  this
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
});

const errorOf = result => JSON.parse(result.content[0].text).error;

add_task(async function an_unpaired_agent_sees_only_the_pairing_tools() {
  const agent = await connectAgent();
  const { result } = await agent.request("tools/list");
  Assert.deepEqual(
    result.tools.map(t => t.name),
    ["request_isolated_pairing", "request_shared_pairing"]
  );
  Assert.deepEqual(result.tools[0].annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  const listed = await agent.request("tools/call", {
    name: "list_tabs",
    arguments: {},
  });
  Assert.ok(listed.result.isError);
  Assert.equal(errorOf(listed.result), "not_paired");
});

add_task(async function protocol_edges() {
  const agent = await connectAgent();
  Assert.equal((await agent.request("no/such/method")).error.code, -32601);
  // A notification gets no reply, so the next frame Sval sends answers the
  // request after it.
  agent.notify("notifications/cancelled", { requestId: 99 });
  const before = agent.client.frames.length;
  const id = agent.send("tools/list");
  await agent.reply(id);
  Assert.deepEqual(
    agent.client.frames.slice(before).map(f => f.mcp?.id),
    [id],
    "notifications get no reply"
  );
});

/**
 * A request sent as a notification runs nothing: no pairing alert opens and
 * nothing is sent back.
 */
add_task(async function notifications_run_nothing_and_get_no_reply() {
  const agent = await connectAgent();
  const before = agent.client.frames.length;
  agent.notify("tools/call", {
    name: "request_shared_pairing",
    arguments: { task: AGENT_LABEL },
  });
  agent.notify("tools/list");
  const id = agent.send("tools/list");
  await agent.reply(id);
  Assert.deepEqual(
    agent.client.frames.slice(before).map(f => f.mcp?.id),
    [id],
    "nothing but the request's reply is sent"
  );
  Assert.ok(!alertOpenAnywhere(), "no alert is asked for");
});

/** A task Sval cannot show refuses the pairing before the user is asked. */
add_task(async function pairing_needs_a_task_it_can_show() {
  for (const args of [{}, { task: "‮​" }, { task: 7 }]) {
    const agent = await connectAgent();
    const { result } = await agent.reply(agent.pairing(args));
    Assert.ok(result.isError, JSON.stringify(args));
    Assert.equal(errorOf(result), "invalid_arguments");
    Assert.ok(!alertOpenAnywhere(), "the user is not asked");
  }
});
