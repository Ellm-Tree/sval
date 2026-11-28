/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * What the agent session files share: a connection to Sval's listener as
 * sval-mcp opens one, below `agentSetup`, for tasks about the protocol and
 * pairing themselves. Each file loads this with `loadSubScript` into its own
 * scope.
 */

/* exported SvalAgents, connectAgent, freshLaunch, pairingAlert,
            agentsWorkspaces, alertOpenAnywhere */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);
const { SvalTestAgentClient } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestAgentClient.sys.mjs"
);

/**
 * What sval-mcp says of a launch of its own: a fresh one names a new agent.
 *
 * @param {object} [fields] Replaces its fields.
 * @returns {{id: string, dir: string, started: number}}
 */
function freshLaunch(fields = {}) {
  return {
    id: crypto.randomUUID().replaceAll("-", "").slice(0, 16),
    dir: "",
    started: Date.now(),
    ...fields,
  };
}

/**
 * Opens a connection to Sval's listener, past the handshake, unpaired. It
 * closes when the task ends, and every agent it paired is unpaired and its
 * workspace removed.
 *
 * @param {object} [options]
 * @param {object|null} [options.launch] What sval-mcp says of its launch.
 * @returns {Promise<object>} `client`; `identify(info)`, which says who the
 *   agent's client is on every request after, as sval-mcp does from the
 *   agent's MCP session; `send(method, params)`, which sends a
 *   request and returns its id; `reply(id)`; `request(method, params)`,
 *   which sends one and waits for its reply; `notify(method, params)`;
 *   `pairing(args, tool)`, which sends a pairing call and returns its id;
 *   and `paired()`, the agent its `ctl.paired` frame names, once it has
 *   come.
 */
async function connectAgent({ launch = freshLaunch() } = {}) {
  const { port, token } = await agentAccessForTask();
  const client = await SvalTestAgentClient.connect(port, token);
  atTaskEnd(async () => {
    client.close();
    const ids = new Set(
      client.frames.filter(f => f.ctl?.paired).map(f => f.ctl.paired.agent_id)
    );
    if (!ids.size) {
      return;
    }
    if (!SvalAgents.store) {
      await agentAccessForTask();
    }
    const workspaces = SvalAgents.store
      .agents()
      .filter(a => ids.has(a.agentId))
      .flatMap(a => a.workspaces.map(w => w.workspaceId));
    for (const id of ids) {
      await SvalAgents.unpair(id);
    }
    for (const ws of workspaces) {
      await removeWorkspace(ws);
    }
  });
  client.sendFrame({
    hello: AGENT_HELLO,
    pair: true,
    proof: client.proof,
    ...(launch && { launch }),
  });
  await client.waitFor(f => f.ctl?.ready === "unpaired");
  let nextId = 1;
  let clientInfo = null;
  const send = (method, params) => {
    const id = nextId++;
    client.sendFrame({
      mcp: { jsonrpc: "2.0", id, method, params },
      ...(clientInfo && { client: clientInfo }),
    });
    return id;
  };
  const reply = async id =>
    (await client.waitFor(f => f.mcp?.id === id && !f.mcp.method, 60_000)).mcp;
  return {
    client,
    identify(info) {
      clientInfo = info;
    },
    send,
    reply,
    request: (method, params) => reply(send(method, params)),
    notify: (method, params) =>
      client.sendFrame({ mcp: { jsonrpc: "2.0", method, params } }),
    pairing: (args = { task: AGENT_LABEL }, tool = "request_shared_pairing") =>
      send("tools/call", { name: tool, arguments: args }),
    async paired() {
      const { ctl } = await client.waitFor(f => f.ctl?.paired, 60_000);
      const agentId = ctl.paired.agent_id;
      return {
        agentId,
        secret: ctl.paired.secret,
        record: SvalAgents.store.agents().find(a => a.agentId === agentId),
      };
    },
  };
}

/**
 * The pairing alert open in any window, once it has loaded: `agent-pair.js`
 * wires its buttons at `DOMContentLoaded`, which can come after the parser
 * has drawn them.
 *
 * @returns {Promise<Document>}
 */
async function pairingAlert() {
  let doc;
  await TestUtils.waitForCondition(() => {
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      const d = w.gDialogBox?.dialog?._frame.contentDocument;
      if (d?.querySelector(".sval-ap-allow") && d.readyState === "complete") {
        doc = d;
        return true;
      }
    }
    return false;
  }, "the pairing alert draws");
  atTaskEnd(closeLeftoverDialog);
  return doc;
}

/** @returns {boolean} Whether any browser window has a dialog open. */
function alertOpenAnywhere() {
  for (const w of Services.wm.getEnumerator("navigator:browser")) {
    if (w.gDialogBox?.isOpen) {
      return true;
    }
  }
  return false;
}

/**
 * @returns {Promise<string[]>} The ids of the agents' workspaces the
 *   document holds now.
 */
async function agentsWorkspaces() {
  const { nodes } = await SvalPanel.engine.tree();
  return Object.entries(nodes)
    .filter(([, node]) => node.kind === "workspace" && node.agent)
    .map(([id]) => id);
}
