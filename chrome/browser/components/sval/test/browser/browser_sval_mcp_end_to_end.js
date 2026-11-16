/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * sval-mcp end to end (agent-control spec §3.1, §7.1): the shim the package
 * carries beside this browser, launched as an MCP client launches it, against
 * this profile's real listener. It proves the listener and the handshake,
 * pairs through the real alert, relays a tool call both ways, and exits when
 * the client closes its input. The shim's own tests drive a fake Sval, and the
 * listener's drive a fake shim, so only this file runs the two together.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);
const { Subprocess } = ChromeUtils.importESModule(
  "resource://gre/modules/Subprocess.sys.mjs"
);

const agentDir = () => PathUtils.join(PathUtils.profileDir, "sval-agents");

/**
 * Where `scripts/stage-sval-mcp.sh` puts the shim: beside the browser binary,
 * as every package carries it.
 *
 * @returns {string}
 */
function shimPath() {
  const file = Services.dirsvc.get("XREExeF", Ci.nsIFile).parent;
  file.append(AppConstants.platform == "win" ? "sval-mcp.exe" : "sval-mcp");
  return file.path;
}

/** @returns {Promise<Set<string>>} The ids of every workspace now. */
async function workspaceIds() {
  const nodes = (await SvalPanel.engine.tree()).nodes ?? {};
  return new Set(
    Object.entries(nodes)
      .filter(([, node]) => node.kind === "workspace")
      .map(([id]) => id)
  );
}

/**
 * An MCP client over a running shim: one JSON-RPC message a line on its
 * input and its output.
 *
 * @param {object} proc A process from `Subprocess.call`.
 * @returns {{send: Function, next: Function, reply: Function}}
 */
function mcpClient(proc) {
  let partial = "";
  const lines = [];
  const nextMessage = async () => {
    while (!lines.length) {
      const chunk = await proc.stdout.readString();
      if (!chunk) {
        throw new Error("sval-mcp closed its output");
      }
      const parts = (partial + chunk).split("\n");
      partial = parts.pop();
      lines.push(...parts.filter(Boolean).map(line => JSON.parse(line)));
    }
    return lines.shift();
  };
  const next = async (wanted, what) => {
    for (;;) {
      const message = await within(nextMessage(), 30_000, what);
      if (wanted(message)) {
        return message;
      }
    }
  };
  return {
    send(message) {
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    },
    next,
    reply: id =>
      next(message => message.id === id, `sval-mcp's answer to request ${id}`),
  };
}

const toolNames = reply => reply.result.tools.map(tool => tool.name);

add_setup(async function agent_access_is_on() {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  await SpecialPowers.pushPrefEnv({
    set: [[SvalAgents.PREF, true]],
  });
  // The port file is what an agent finds Sval by, and Sval writes it after it
  // starts listening.
  await TestUtils.waitForCondition(async () => {
    const file = PathUtils.join(agentDir(), "port.json");
    return (
      SvalAgents.port !== null &&
      (await IOUtils.exists(file)) &&
      (await IOUtils.readJSON(file)).port === SvalAgents.port
    );
  }, "agent access listens and has written its port file");
  // The pairing this file makes, on both sides, goes with it: Sval's record of
  // the agent and the shim's secret and its live-session lock.
  registerCleanupFunction(async () => {
    await SpecialPowers.popPrefEnv();
    await TestUtils.waitForCondition(
      () => SvalAgents.port === null,
      "agent access closes"
    );
    for (const path of await IOUtils.getChildren(agentDir())) {
      const name = PathUtils.filename(path);
      if (
        name === "agents.json" ||
        name.startsWith("secret-") ||
        name === "live.lock"
      ) {
        await IOUtils.remove(path, { ignoreAbsent: true });
      }
    }
  });
});

/**
 * Starts the shim in a directory of its own, as an MCP client does, and
 * removes at the task's end what its pairing made.
 *
 * @returns {Promise<{proc: object, mcp: object, launchDir: string,
 *   ended: Function}>} `ended` closes the client's input and waits for the
 *   shim to exit.
 */
async function startShim() {
  const shim = shimPath();
  Assert.ok(
    await IOUtils.exists(shim),
    `${shim} is there; scripts/stage-sval-mcp.sh puts it beside the browser`
  );
  const before = await workspaceIds();
  const launchDir = await makeTempDir("sval-mcp-launch");
  const proc = await Subprocess.call({
    command: shim,
    arguments: ["--profile", PathUtils.profileDir],
    workdir: launchDir,
    stderr: "pipe",
  });
  let exited = false;
  atTaskEnd(async () => {
    if (!exited) {
      await proc.kill();
    }
    const record = SvalAgents.store.agents().find(a => a.client === "sval-e2e");
    if (record) {
      await SvalAgents.unpair(record.agentId);
    }
    for (const id of await workspaceIds()) {
      if (!before.has(id)) {
        await removeWorkspace(id);
      }
    }
  });
  const ended = async () => {
    await proc.stdin.close();
    const { exitCode } = await within(proc.wait(), 10_000, "sval-mcp exiting");
    exited = true;
    return exitCode;
  };
  return { proc, mcp: mcpClient(proc), launchDir, ended };
}

/**
 * Answers the pairing alert with Pair, once it says what the agent asked.
 *
 * @param {string} launchDir Where the shim was started.
 */
async function pairInAlert(launchDir) {
  // The alert opens in the top window, which an earlier task's agent window
  // may be.
  const doc = await TestUtils.waitForCondition(() => {
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      const d = w.gDialogBox?.dialog?._frame.contentDocument;
      if (d?.getElementById("sval-ap-question")?.textContent) {
        return d;
      }
    }
    return null;
  }, "the pairing alert draws");
  const facts = [...doc.getElementById("sval-ap-facts").children].map(
    li => li.textContent
  );
  Assert.ok(facts[0].includes("End to end"), "the alert says the task");
  Assert.ok(facts[1].includes("sval-e2e"), "and names the client");
  Assert.ok(
    facts[2].endsWith(PathUtils.filename(launchDir)),
    `the alert says where sval-mcp was launched: ${facts[2]}`
  );
  await pair(doc);
}

add_task(async function an_agent_pairs_and_calls_a_tool_through_sval_mcp() {
  const { mcp, launchDir, ended } = await startShim();

  mcp.send({
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "sval-e2e", version: "1" },
    },
  });
  const init = await mcp.reply(1);
  Assert.equal(init.result.serverInfo.name, "sval", "sval-mcp speaks for Sval");
  Assert.equal(
    init.result.serverInfo.version,
    AppConstants.MOZ_APP_VERSION_DISPLAY,
    "sval-mcp reports the version of the sval it was packaged with"
  );
  mcp.send({ method: "notifications/initialized" });

  mcp.send({ id: 2, method: "tools/list" });
  Assert.ok(
    toolNames(await mcp.reply(2)).includes("request_shared_pairing"),
    "an unpaired agent can ask to pair"
  );

  mcp.send({
    id: 3,
    method: "tools/call",
    params: {
      name: "request_shared_pairing",
      arguments: { task: "End to end" },
    },
  });
  await pairInAlert(launchDir);
  const paired = await mcp.reply(3);
  Assert.ok(!paired.result.isError, "pairing succeeds");

  mcp.send({ id: 4, method: "tools/list" });
  const tools = (await mcp.reply(4)).result.tools;
  Assert.ok(
    tools.some(tool => tool.name === "list_tabs"),
    "a paired agent has Sval's tools"
  );
  Assert.deepEqual(
    Object.keys(
      tools.find(tool => tool.name === "get_console_messages")?.inputSchema
        ?.properties ?? {}
    ).sort(),
    ["cursor", "max_messages", "tab"],
    "the console tool crosses the shim with its schema"
  );
  mcp.send({
    id: 6,
    method: "tools/call",
    params: { name: "get_console_messages", arguments: { tab: "no-such-tab" } },
  });
  const unknownTab = (await mcp.reply(6)).result;
  Assert.ok(unknownTab.isError, "a call reaches Sval's handler and back");
  Assert.equal(
    JSON.parse(unknownTab.content[0].text).error,
    "not_controlled",
    "which refuses a tab outside the agent's workspace"
  );
  mcp.send({
    id: 5,
    method: "tools/call",
    params: { name: "list_tabs", arguments: {} },
  });
  const listed = JSON.parse((await mcp.reply(5)).result.content[0].text);
  Assert.equal(
    listed.workspace,
    "End to end",
    "in its own workspace, named for its task"
  );

  Assert.equal(
    await ended(),
    0,
    "sval-mcp exits when its client closes its input"
  );
});

/**
 * A modern client (MCP 2026-07-28) sends no `initialize`: each request says
 * its version and who the client is, and it hears of new tools on the stream
 * it opened for them.
 */
add_task(async function a_modern_agent_pairs_through_sval_mcp() {
  const { mcp, launchDir, ended } = await startShim();
  const params = (rest = {}) => ({
    ...rest,
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "sval-e2e", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  });

  mcp.send({ id: 1, method: "server/discover", params: params() });
  const discovered = (await mcp.reply(1)).result;
  Assert.ok(
    discovered.supportedVersions.includes("2026-07-28"),
    "sval-mcp speaks MCP 2026-07-28"
  );
  Assert.equal(
    typeof discovered.instructions,
    "string",
    "and tells the agent about Sval"
  );
  Assert.equal(
    discovered._meta["io.modelcontextprotocol/serverInfo"].version,
    AppConstants.MOZ_APP_VERSION_DISPLAY,
    "as the sval it was packaged with"
  );

  mcp.send({
    id: "tools",
    method: "subscriptions/listen",
    params: params({ notifications: { toolsListChanged: true } }),
  });
  await mcp.next(
    m => m.method === "notifications/subscriptions/acknowledged",
    "the subscription's acknowledgment"
  );

  mcp.send({ id: 2, method: "tools/list", params: params() });
  const unpaired = await mcp.reply(2);
  Assert.equal(unpaired.result.resultType, "complete", "a modern result");
  Assert.ok(
    toolNames(unpaired).includes("request_shared_pairing"),
    "an unpaired agent can ask to pair"
  );

  mcp.send({
    id: 3,
    method: "tools/call",
    params: params({
      name: "request_shared_pairing",
      arguments: { task: "End to end" },
    }),
  });
  await pairInAlert(launchDir);
  const changed = await mcp.next(
    m => m.method === "notifications/tools/list_changed",
    "the notice that pairing changed the tools"
  );
  Assert.equal(
    changed.params._meta["io.modelcontextprotocol/subscriptionId"],
    "tools",
    "on the stream that asked for it"
  );
  Assert.ok(!(await mcp.reply(3)).result.isError, "pairing succeeds");

  mcp.send({
    id: 4,
    method: "tools/call",
    params: params({ name: "list_tabs", arguments: {} }),
  });
  const listed = JSON.parse((await mcp.reply(4)).result.content[0].text);
  Assert.equal(listed.workspace, "End to end", "in its own workspace");

  Assert.equal(await ended(), 0, "sval-mcp exits when its client closes");
});
