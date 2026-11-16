/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_agent_session_helpers.js */

/**
 * What an agent that is not paired meets on Sval's listener (agent-control
 * spec §3.2): MCP's handshake and versions, the two pairing tools, and the
 * protocol's edges.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_agent_session_helpers.js",
  this
);
const { SERVER_INSTRUCTIONS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentSession.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
});

/**
 * A modern request (MCP 2026-07-28): its version, the client's capabilities
 * and who the client is travel in its `_meta`, with no `initialize` before it.
 *
 * @param {object} [params]
 * @param {object} [meta] Replaces `_meta`'s fields.
 * @returns {object}
 */
const modern = (params = {}, meta = {}) => ({
  ...params,
  _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": { name: "modern-agent" },
    ...meta,
  },
});

const errorOf = result => JSON.parse(result.content[0].text).error;

add_task(async function initialize_echoes_the_version_and_offers_tools() {
  const agent = await connectAgent();
  const { result } = await agent.request("initialize", {
    protocolVersion: "2025-06-18",
    clientInfo: { name: "Claude Code", version: "2" },
  });
  Assert.equal(result.protocolVersion, "2025-06-18");
  Assert.equal(result.serverInfo.name, "sval");
  Assert.ok(result.capabilities.tools.listChanged);
  Assert.equal(result.instructions, SERVER_INSTRUCTIONS);
  // Claude Code keeps only the first 4096 characters of a server's
  // instructions.
  Assert.lessOrEqual(SERVER_INSTRUCTIONS.length, 2048, "they are short");
});

add_task(async function initialize_answers_a_version_sval_supports() {
  for (const [asked, answered] of [
    ["2025-06-18", "2025-06-18"],
    ["2025-11-25", "2025-11-25"],
    ["2026-07-28", "2025-11-25"],
    [undefined, "2025-11-25"],
  ]) {
    const agent = await connectAgent();
    const { result } = await agent.request("initialize", {
      protocolVersion: asked,
      clientInfo: { name: "x" },
    });
    Assert.equal(result.protocolVersion, answered, String(asked));
  }
});

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
  Assert.deepEqual((await agent.request("ping")).result, {});
  Assert.equal((await agent.request("no/such/method")).error.code, -32601);
  // A notification gets no reply, so the next frame Sval sends answers the
  // ping after it.
  agent.notify("notifications/initialized");
  const before = agent.client.frames.length;
  const id = agent.send("ping");
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
  agent.notify("initialize", { clientInfo: { name: "X" } });
  const id = agent.send("ping");
  await agent.reply(id);
  Assert.deepEqual(
    agent.client.frames.slice(before).map(f => f.mcp?.id),
    [id],
    "nothing but the ping's reply is sent"
  );
  Assert.ok(!alertOpenAnywhere(), "no alert is asked for");
});

add_task(async function a_modern_request_is_answered_with_no_initialize() {
  const agent = await connectAgent();
  const { result: list } = await agent.request("tools/list", modern());
  Assert.deepEqual(
    list.tools.map(t => t.name),
    ["request_isolated_pairing", "request_shared_pairing"]
  );
  Assert.equal(list.resultType, "complete");
  Assert.equal(list.ttlMs, 0, "a tool list is stale at once");
  Assert.equal(list.cacheScope, "private", "and the agent's own");
  Assert.equal(list._meta["io.modelcontextprotocol/serverInfo"].name, "sval");

  const { result: call } = await agent.request(
    "tools/call",
    modern({ name: "list_tabs", arguments: {} })
  );
  Assert.equal(call.resultType, "complete");
  Assert.equal(call.ttlMs, undefined, "only a list carries caching hints");
  Assert.equal(errorOf(call), "not_paired");

  Assert.equal(
    (await agent.request("tools/list")).result.resultType,
    undefined,
    "a legacy request's result is as it was"
  );
});

add_task(
  async function a_request_names_a_version_sval_speaks_or_is_told_them() {
    for (const version of ["2025-06-18", "2025-11-25", "2026-07-28"]) {
      const agent = await connectAgent();
      const reply = await agent.request(
        "tools/list",
        modern({}, { "io.modelcontextprotocol/protocolVersion": version })
      );
      Assert.ok(reply.result, version);
    }
    const agent = await connectAgent();
    const { error } = await agent.request(
      "tools/list",
      modern({}, { "io.modelcontextprotocol/protocolVersion": "1900-01-01" })
    );
    Assert.equal(error.code, -32022);
    Assert.deepEqual(error.data, {
      supported: ["2026-07-28", "2025-11-25", "2025-06-18"],
      requested: "1900-01-01",
    });
    for (const meta of [
      { "io.modelcontextprotocol/clientCapabilities": undefined },
      { "io.modelcontextprotocol/clientCapabilities": [] },
      { "io.modelcontextprotocol/protocolVersion": 2026 },
    ]) {
      const reply = await agent.request("tools/list", modern({}, meta));
      Assert.equal(reply.error.code, -32602, JSON.stringify(meta));
    }
  }
);

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
