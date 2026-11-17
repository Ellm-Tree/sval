/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * One agent connection, after the handshake (agent-control spec §3.2, §4,
 * §5.1). It speaks MCP: frames carrying `{mcp}` are JSON-RPC. It answers
 * `{ctl}` frames toward `sval-mcp` only, so the pairing secret goes to the
 * bridge, which stores it, and never into the agent's model context.
 *
 * No sockets here. `SvalAgents` owns the connection and hands each decoded
 * frame to `handle`.
 *
 * Every request gets exactly one reply, even when what it needed failed: an
 * agent left waiting has no way to tell a slow answer from none. A
 * notification gets none, and runs nothing.
 */

import {
  printable,
  ToolError,
  validateArgs,
} from "moz-src:///browser/components/sval/SvalAgentArgs.sys.mjs";
import {
  ApprovalWait,
  Ending,
} from "moz-src:///browser/components/sval/SvalAgentAlerts.sys.mjs";
import {
  SvalLog,
  describeError,
} from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { politeRules } from "moz-src:///browser/components/sval/SvalAgentPolite.sys.mjs";
import {
  GROUP,
  SPLIT,
  TAB,
  childrenByParent,
} from "moz-src:///browser/components/sval/SvalTree.sys.mjs";

/**
 * The MCP versions Sval speaks. A legacy version opens with `initialize`, and
 * a modern one carries its version and the client's capabilities in every
 * request's `_meta` (MCP 2026-07-28, "Versioning and Compatibility").
 * `sval-mcp`'s `build.rs` takes both lists and
 * `LATEST_LEGACY_PROTOCOL_VERSION` from this source, so each stays a list of
 * plain string literals, oldest first.
 */
const LEGACY_PROTOCOL_VERSIONS = ["2025-06-18", "2025-11-25"];
const MODERN_PROTOCOL_VERSIONS = ["2026-07-28"];
/** What `initialize` answers a version Sval does not speak with. */
const LATEST_LEGACY_PROTOCOL_VERSION = "2025-11-25";
/** Every version Sval speaks, newest first, as an unsupported one is told. */
const SUPPORTED_PROTOCOL_VERSIONS = [
  ...LEGACY_PROTOCOL_VERSIONS,
  ...MODERN_PROTOCOL_VERSIONS,
].reverse();
/** The `_meta` keys of a modern request and result (MCP 2026-07-28, "_meta"). */
const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";
const CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";
/** MCP's `UNSUPPORTED_PROTOCOL_VERSION` error code. */
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const MAX_LABEL_CHARS = 64;
/** The most characters of the task an agent states that Sval keeps. */
const MAX_TASK_CHARS = 48;
/** The most characters of the model an agent states that Sval keeps. */
const MAX_MODEL_CHARS = 32;
/** The most characters of a launch directory Sval keeps. */
const MAX_DIR_CHARS = 1024;
/** A build id as `sval-mcp` reports one: Sval's build id, or a dev version. */
const BUILD_PATTERN = /^[0-9A-Za-z._+-]{1,64}$/;

/**
 * What `initialize` and `server/discover` tell the agent's model about Sval as
 * a whole: the model no single tool description holds, and the recovery map
 * across tools. Every rule it states is enforced in Sval's own code; the text
 * only explains them. `sval-mcp` answers both itself with the same text, which
 * its `build.rs` takes from this constant's source, so it stays a template
 * literal with no substitutions or escapes.
 */
export const SERVER_INSTRUCTIONS = `Sval is the user's own web browser, and you are signed in as them: your tabs
share their cookies and logins. Do only what the user asked, and ask them
before anything that spends money, sends messages, posts, deletes, or accepts
terms.

You work in a workspace of your own, in a window the user can watch. set_task
names it for your task, in a few words the user would recognise, and gives you
its id. Keep the id: in a later session, call use_workspace with it to get your
tabs back. When you finish a task, close the tabs you no longer need and call
close_window.

Act on elements by ref from your latest get_snapshot. Refs expire when the
page changes.

Unless the user has already decided, Sval asks them before you open a new
site, send what you typed, upload, or download. A failed call returns an error
code and a message that says what to do next: follow it. Never try to solve a
CAPTCHA or other check that a person is there, and never look for another way
into a site the user blocked. If you can't reach the user, stop and tell
whoever started you what Sval is waiting for. Don't add random delays or try to
look human.

Sval's documentation is at https://sval.app/docs/, in Markdown if you ask for
it.`;

const EMPTY_INPUT = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

/**
 * What an agent says it is working on, which names its workspace, and the
 * model it runs on, which names it beside its client.
 */
const TASK_INPUT = {
  type: "object",
  properties: {
    task: {
      type: "string",
      maxLength: 200,
      description: `What you are doing, in a few words the user would recognise, such as "Fix login redirect" or "Compare laptop prices". It names your workspace, which is how the user tells you from their other agents. At most ${MAX_TASK_CHARS} characters are kept.`,
    },
    model: {
      type: "string",
      maxLength: 200,
      description: `Optional. The model you run on, such as "Opus 5.5" or "GPT-5". At most ${MAX_MODEL_CHARS} characters are kept.`,
    },
  },
  required: ["task"],
  additionalProperties: false,
};

/**
 * The pairing tools, one for each kind of workspace (isolated workspaces spec
 * §7). The user's answer decides the kind; the tool says which the agent asked
 * for.
 *
 * @param {string} name
 * @param {string} title
 * @param {string} kind What the description says of the workspace.
 * @returns {object}
 */
const pairingTool = (name, title, kind) => ({
  name,
  title,
  description: `${kind} Tell the user to answer the Pair/Deny alert in Sval. The call waits for their answer. Once paired, the result gives your workspace id: keep it.`,
  inputSchema: TASK_INPUT,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
});

const UNPAIRED_TOOLS = [
  pairingTool(
    "request_isolated_pairing",
    "Pair with Sval, isolated",
    "Ask the user to pair this agent with Sval in an isolated workspace: one with its own cookies, so sites there see none of the user's sign-ins, and you sign in yourself where a task needs it."
  ),
  pairingTool(
    "request_shared_pairing",
    "Pair with Sval, shared",
    "Ask the user to pair this agent with Sval in a shared workspace: sites there see the accounts the user is signed in to elsewhere in Sval."
  ),
];

/** @type {Set<string>} */
const PAIRING_TOOLS = new Set(UNPAIRED_TOOLS.map(t => t.name));

const PAIRED_TOOLS = [
  {
    name: "list_tabs",
    title: "List tabs",
    description:
      "List the tabs in your workspace, each with its tab id, title and URL. user_in_control: true means the user has taken over your workspace. human_verification: true means a tab is waiting for the user to complete a check.",
    inputSchema: EMPTY_INPUT,
    annotations: { readOnlyHint: true },
  },
  {
    name: "set_task",
    title: "Set your task",
    description:
      "Name your workspace for the task you are doing now, so the user can tell it from their other agents. With no workspace yet, it makes one and gives its id: keep it.",
    inputSchema: TASK_INPUT,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "use_workspace",
    title: "Go back to a workspace",
    description:
      "Go back to the workspace with this id, from an earlier session, and its tabs. Call it first when a conversation resumes.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          maxLength: 64,
          description: "The workspace id Sval gave you.",
        },
      },
      required: ["workspace"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "close_window",
    title: "Close your window",
    description:
      "Close your workspace's window when you have finished. Your workspace keeps its tabs, and opening or acting in a tab opens the window again.",
    inputSchema: EMPTY_INPUT,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "delete_workspace",
    title: "Delete your workspace",
    description:
      "Delete your workspace and close every tab in it. Call it only when the user asks or agrees.",
    inputSchema: EMPTY_INPUT,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];

/**
 * The rules Be polite holds an agent to, as a sentence of a tool's
 * description.
 *
 * @param {{on: boolean, actions_per_second: number, interval_ms: number,
 *   max_queued: number}} rules `politeRules`.
 * @returns {string}
 */
export function politeSentence(rules) {
  if (!rules.on) {
    return "Be polite is off for you: Sval does not space out your actions.";
  }
  const rate =
    rules.actions_per_second === 1
      ? "1 action"
      : `${rules.actions_per_second} actions`;
  return `Be polite is on for you: at most ${rate} a second on each site, so Sval starts your actions on a site at least ${rules.interval_ms} ms apart. Up to ${rules.max_queued} wait their turn; one more fails with rate_limited.`;
}

/**
 * The agent's client as people know it, made safe to draw: its MCP display
 * name (`title`), or its programmatic `name` when it gives none.
 *
 * @param {unknown} clientInfo What the client says it is: `initialize`'s
 *   `params.clientInfo`, or a modern request's `_meta` one.
 * @returns {string}
 */
export function labelFrom(clientInfo) {
  const raw = [clientInfo?.title, clientInfo?.name]
    .map(v => (typeof v === "string" ? printable(v) : ""))
    .find(Boolean);
  const label = raw ?? "";
  return label ? [...label].slice(0, MAX_LABEL_CHARS).join("") : "Agent";
}

/**
 * What `sval-mcp` says of where and when it was launched (its handshake's
 * `launch`), made safe to keep and draw, or null when it says nothing usable.
 * `id` tells one app's launches from another's: every session of a client
 * has the same id, wherever it was launched. `build` is the build of Sval the
 * shim was packaged with, kept only for the log and the agent's details.
 *
 * @param {unknown} raw
 * @returns {{id: string, dir: string, started: number|null,
 *   build: string|null}|null}
 */
export function launchFrom(raw) {
  if (
    !raw ||
    typeof raw !== "object" ||
    typeof raw.id !== "string" ||
    !/^[0-9a-f]{16}$/.test(raw.id)
  ) {
    return null;
  }
  const dir = typeof raw.dir === "string" ? printable(raw.dir) : "";
  return {
    id: raw.id,
    dir: [...dir].slice(-MAX_DIR_CHARS).join(""),
    started:
      Number.isSafeInteger(raw.started) && raw.started > 0 ? raw.started : null,
    build:
      typeof raw.build === "string" && BUILD_PATTERN.test(raw.build)
        ? raw.build
        : null,
  };
}

/**
 * Text an agent gave about itself, kept to characters that read the same
 * wherever it is drawn, or "" when nothing of it is left.
 *
 * @param {unknown} raw
 * @param {number} max The most characters kept.
 * @returns {string}
 */
function statedFrom(raw, max) {
  const kept = printable(typeof raw === "string" ? raw : "")
    .replace(/[^\p{L}\p{M}\p{N} ._:/#&+,()'-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return [...kept].slice(0, max).join("").trim();
}

/**
 * The task an agent said it is doing, which names its workspace.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function taskFrom(raw) {
  return statedFrom(raw, MAX_TASK_CHARS);
}

/**
 * The model an agent said it runs on.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function modelFrom(raw) {
  return statedFrom(raw, MAX_MODEL_CHARS);
}

/**
 * The facts Sval shows beside an agent's name: its client, and where and
 * when the agent's `sval-mcp` was started. The agent chose none of them.
 *
 * @param {{client?: string, dir?: string, started?: number|null}} facts
 * @param {object} [options]
 * @param {string} [options.when] What the start time is called.
 * @returns {string[]}
 */
export function launchLines(
  { client, dir, started } = {},
  { when = "Started" } = {}
) {
  const lines = [];
  if (client) {
    lines.push(`Client: ${client}`);
  }
  if (dir) {
    lines.push(`Launched in: ${dir}`);
  }
  if (started) {
    const time = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(started));
    lines.push(`${when}: ${time}`);
  }
  return lines;
}

/**
 * Every tab under `workspaceId`, depth first, each level in placement order.
 *
 * @param {object} nodes The tree JSON's `nodes` map.
 * @param {string} workspaceId
 */
export function tabsIn(nodes, workspaceId) {
  const byParent = childrenByParent(nodes);
  const out = [];
  const walk = parent => {
    for (const id of byParent.get(parent) ?? []) {
      const node = nodes[id];
      if (node.kind === TAB) {
        out.push({
          tab: id,
          title: node.content?.name ?? "",
          url: node.content?.url ?? null,
        });
      } else if (node.kind === GROUP || node.kind === SPLIT) {
        // A split's panes are tabs like any other (split-view spec §9.2).
        walk(id);
      }
    }
  };
  walk(workspaceId);
  return out;
}

const result = (id, value) => ({ jsonrpc: "2.0", id, result: value });
const failure = (id, code, message, data) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data !== undefined && { data }) },
});

/**
 * How one request is served. One whose `_meta` names no version, or a legacy
 * one, is served as the `initialize` before it set up. One that names a
 * modern version is served from what it carries alone, and is refused when it
 * lacks the client's capabilities, which a modern request must carry
 * (MCP 2026-07-28, "_meta"). A version Sval does not speak is refused with
 * the ones it does, from which the client picks one and asks again.
 *
 * @param {object} msg A JSON-RPC request.
 * @returns {{modern: boolean, clientInfo?: unknown, refusal?: object}}
 */
export function eraOf(msg) {
  const meta = msg.params?._meta;
  if (!meta || typeof meta !== "object" || !Object.hasOwn(meta, VERSION_KEY)) {
    return { modern: false };
  }
  const version = meta[VERSION_KEY];
  if (typeof version !== "string") {
    return {
      modern: false,
      refusal: failure(msg.id, -32602, `invalid params: ${VERSION_KEY}`),
    };
  }
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    return {
      modern: false,
      refusal: failure(
        msg.id,
        UNSUPPORTED_PROTOCOL_VERSION,
        "Unsupported protocol version",
        { supported: SUPPORTED_PROTOCOL_VERSIONS, requested: version }
      ),
    };
  }
  if (!MODERN_PROTOCOL_VERSIONS.includes(version)) {
    return { modern: false };
  }
  const capabilities = meta[CAPABILITIES_KEY];
  if (
    !capabilities ||
    typeof capabilities !== "object" ||
    Array.isArray(capabilities)
  ) {
    return {
      modern: true,
      refusal: failure(msg.id, -32602, `invalid params: ${CAPABILITIES_KEY}`),
    };
  }
  return { modern: true, clientInfo: meta[CLIENT_INFO_KEY] ?? null };
}
const toolText = text => ({ content: [{ type: "text", text }] });
/**
 * A failed tool call's result. Every tool error has this one shape, JSON
 * text carrying `error` (the code), `message` (which starts with the code,
 * so a reader that only shows text still sees it) and, where there is one,
 * `tab`, plus whatever else the error says (`ToolError.details`).
 *
 * @param {string} code
 * @param {string} text
 * @param {object} [extra]
 * @returns {object}
 */
export const toolError = (code, text, extra = {}) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        ...extra,
        error: code,
        message: `${code}: ${text}`,
      }),
    },
  ],
  isError: true,
});
const noTask = () =>
  toolError(
    "invalid_arguments",
    "task has nothing Sval can show. Say what you are doing in a few words, in letters and digits."
  );
const noLongerPaired = () =>
  toolError(
    "not_paired",
    "This agent is no longer paired with Sval. Call request_isolated_pairing or request_shared_pairing to pair again."
  );
const noWorkspace = () =>
  toolError(
    "no_workspace",
    "This session has no workspace in Sval. Call set_task with what you are doing to make one, or use_workspace with the id of the workspace you used before."
  );
const workspaceInUse = () =>
  toolError(
    "workspace_in_use",
    "Another session holds that workspace now. Call set_task to make a workspace of your own."
  );
const workspaceNotFound = () =>
  toolError(
    "not_found",
    "No workspace of yours has that id. The user may have deleted it. Call set_task to make a new one."
  );

/** The codes of a workspace the user holds, by take or by Stop. */
const USER_HOLDS = new Set(["user_in_control", "stopped_by_user"]);

/**
 * @param {object} refusal A tool error, as `toolError` makes it.
 * @returns {string} Its code.
 */
const codeOf = refusal => JSON.parse(refusal.content[0].text).error;

/**
 * What every answer that gives a session its workspace says of it.
 *
 * @param {string} workspaceId
 * @returns {string}
 */
const keepId = workspaceId =>
  `Your workspace id is "${workspaceId}". Keep it for as long as this conversation may go on: it is the only way back to this workspace. When the conversation resumes in a later session, call use_workspace with it before anything else. If you lose it, you cannot reconnect to this workspace.`;

const awaitingPairing = () =>
  toolError(
    "awaiting_approval",
    "Sval is showing a Pair/Deny alert. Ask the user to approve the request in Sval, then call the same pairing tool again."
  );

/**
 * One connection's MCP state: who the agent is, whether it is paired, and
 * what it may call.
 *
 * `sval-mcp` answers `server/discover` and holds a modern client's
 * `subscriptions/listen` streams itself, since they outlive any one
 * connection to Sval. So Sval tells the bridge of every change to the tool
 * list, and the bridge sends it on to the streams that asked for it.
 */
export class SvalAgentSession {
  #agent;
  #send;
  #deps;
  #clientInfo = null;
  /** What `sval-mcp` said of its launch (`launchFrom`), or null. */
  #launch;
  #closed = false;
  /** Ends when the connection closes, which ends every wait for the user. */
  #ending = new Ending();
  /** How many of this connection's calls are waiting for the user. */
  #slots = { waiting: 0 };
  /** Each call in flight's wait, by request id, so the agent can cancel it. */
  #calls = new Map();
  /** The pairing in flight, which every pairing request meanwhile shares. */
  #pairing = null;
  /** The check that the session's workspace exists, which concurrent calls share. */
  #housing = null;
  /**
   * The workspace `sval-mcp` held on its last connection, which this one
   * takes back at its first call if no other connection holds it.
   */
  #resume;

  /**
   * @param {object} options
   * @param {{agentId: string, label: string, isolated: boolean}|null}
   *   options.agent The paired agent this connection authenticated as, or
   *   null. The session's own workspace is added to it once it has one.
   * @param {object|null} [options.launch] Where and when the agent's
   *   `sval-mcp` was started, from `launchFrom`.
   * @param {string|null} [options.workspace] The workspace `sval-mcp` held
   *   on its last connection, which it names in its handshake.
   * @param {(frame: object) => void} options.send Writes one frame to the bridge.
   * @param {object} options.deps The store, the pairing dialog, the workspace
   *   and tab operations, the connections holding workspaces, and the version
   *   to report.
   */
  constructor({ agent, launch = null, workspace = null, send, deps }) {
    this.#agent = agent && { ...agent, workspaceId: null, task: "", model: "" };
    this.#launch = launch;
    this.#resume = workspace;
    this.#send = send;
    this.#deps = deps;
  }

  /** The paired agent, or null until pairing completes. */
  get agent() {
    return this.#agent;
  }

  /**
   * What the agent was last given: its tools' names and the rules Be polite
   * holds it to, as one string.
   */
  #listed = null;

  /** @returns {string} What `#listed` compares against. */
  #listing() {
    return JSON.stringify([
      this.#definitions().map(t => t.name),
      politeRules(this.#agent.agentId),
    ]);
  }

  /**
   * The paired agent's own tools, `list_tabs` saying the rules Be polite
   * holds it to as they stand, since a tool list is what an agent reads again
   * when it is told its tools changed.
   *
   * @returns {object[]}
   */
  #pairedTools() {
    return PAIRED_TOOLS.map(tool =>
      tool.name === "list_tabs"
        ? {
            ...tool,
            description: `${tool.description} ${politeSentence(politeRules(this.#agent.agentId))}`,
          }
        : tool
    );
  }

  /**
   * The paired agent's tools: Sval's own, and those `extraTools` gives it as
   * things stand, such as sites' tools (site-tools spec §5.1).
   *
   * @returns {object[]}
   */
  #definitions() {
    return [
      ...(this.#deps.toolDefinitions ?? []),
      ...(this.#agent ? (this.#deps.extraTools?.(this.#agent) ?? []) : []),
    ];
  }

  /**
   * Tells the agent its tools changed, when the ones it would be given now
   * differ from the last list it was given, or the rules Be polite holds it
   * to do.
   */
  toolsMayHaveChanged() {
    if (!this.#agent || this.#listed === null) {
      return;
    }
    const now = this.#listing();
    if (now !== this.#listed) {
      this.#listed = now;
      this.#emit({
        mcp: { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
      });
    }
  }

  /**
   * Stop sending, end every wait for the user, and stop a pairing in flight
   * from creating anything.
   */
  close() {
    this.#closed = true;
    this.#ending.end();
    this.#detach();
  }

  #emit(frame) {
    if (!this.#closed) {
      this.#send(frame);
    }
  }

  /**
   * Handle one decoded frame from the bridge.
   *
   * @param {object} frame
   * @param {object} [options]
   * @param {() => void} [options.onWaiting] Told when the request starts
   *   waiting for the user, which a request may do more than once.
   */
  async handle(frame, { onWaiting } = {}) {
    const msg = frame.mcp;
    if (!msg || typeof msg !== "object") {
      return;
    }
    // A notification has no id to answer, so it gets no reply. Nothing an
    // agent may call is a notification either, so none runs: a `tools/call`
    // notification must not raise the pairing alert. The one Sval heeds is
    // the agent cancelling a call: its wait for the user ends, and it gets
    // no reply (MCP, "Cancellation").
    if (!Object.hasOwn(msg, "id")) {
      if (msg.method === "notifications/cancelled") {
        this.#calls.get(msg.params?.requestId)?.cancel();
      }
      return;
    }
    const era = eraOf(msg);
    if (era.refusal) {
      this.#emit({ mcp: era.refusal });
      return;
    }
    const wait =
      msg.method === "tools/call"
        ? this.#waitFor(msg.params?._meta?.progressToken, onWaiting)
        : null;
    if (wait) {
      this.#calls.set(msg.id, wait);
    }
    let reply;
    try {
      reply = await this.#dispatch(msg, wait, era);
    } finally {
      if (wait && this.#calls.get(msg.id) === wait) {
        this.#calls.delete(msg.id);
      }
    }
    if (!wait?.cancelled) {
      this.#emit({
        mcp: era.modern ? this.#dressed(msg.method, reply) : reply,
      });
    }
  }

  /**
   * A modern request's reply, with the fields a modern result carries: its
   * `resultType`, the server's name and version, and on a tool list the
   * caching hints MCP 2026-07-28 requires there ("Caching"). A list is this
   * agent's own, by its pairing and its Be polite rules, so it is private,
   * and it is stale at once: it changes when the agent pairs or the user
   * changes its rules, and a client that has not subscribed hears of
   * neither.
   *
   * @param {string} method
   * @param {object} reply
   * @returns {object}
   */
  #dressed(method, reply) {
    if (!reply.result) {
      return reply;
    }
    const dressed = {
      ...reply.result,
      resultType: "complete",
      _meta: {
        ...reply.result._meta,
        [SERVER_INFO_KEY]: { name: "sval", version: this.#deps.version },
      },
    };
    if (method === "tools/list") {
      Object.assign(dressed, { ttlMs: 0, cacheScope: "private" });
    }
    return { ...reply, result: dressed };
  }

  /**
   * The reply to one request. A failure becomes an error reply naming only
   * the error's name: its message can carry a path, and the agent's model
   * reads what a tool returns.
   *
   * @param {object} msg A JSON-RPC request.
   * @param {ApprovalWait|null} wait How a tool call waits for the user.
   * @param {object} era How the request is served (`eraOf`).
   * @returns {Promise<object>}
   */
  async #dispatch(msg, wait, era) {
    try {
      return await this.#answer(msg, wait, era);
    } catch (err) {
      SvalLog.error(`agent request failed: ${describeError(err)}`);
      const errorName = typeof err?.name === "string" ? err.name : "Error";
      return msg.method === "tools/call"
        ? result(
            msg.id,
            toolError(
              "internal_error",
              `${errorName}: Sval hit a fault. Try once more, then tell the user.`
            )
          )
        : failure(msg.id, -32603, `internal_error: ${errorName}`);
    }
  }

  async #answer(msg, wait, era) {
    switch (msg.method) {
      case "initialize":
        this.#clientInfo = msg.params?.clientInfo ?? null;
        return result(msg.id, {
          protocolVersion: LEGACY_PROTOCOL_VERSIONS.includes(
            msg.params?.protocolVersion
          )
            ? msg.params.protocolVersion
            : LATEST_LEGACY_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "sval", version: this.#deps.version },
          instructions: SERVER_INSTRUCTIONS,
        });
      case "ping":
        return result(msg.id, {});
      case "tools/list": {
        if (!this.#agent) {
          return result(msg.id, { tools: UNPAIRED_TOOLS });
        }
        this.#listed = this.#listing();
        return result(msg.id, {
          tools: [...this.#pairedTools(), ...this.#definitions()],
        });
      }
      case "tools/call":
        return result(
          msg.id,
          await this.#call(
            msg.params?.name,
            msg.params?.arguments,
            wait,
            era.modern ? era.clientInfo : this.#clientInfo
          )
        );
      default:
        return failure(msg.id, -32601, "method not found");
    }
  }

  /**
   * How one call waits for the user, reporting progress to the agent when
   * the call carries a progress token.
   *
   * @param {unknown} progressToken
   * @param {() => void} [onWaiting]
   * @returns {ApprovalWait}
   */
  #waitFor(progressToken, onWaiting) {
    return new ApprovalWait({
      progressToken,
      notify: notification => this.#emit({ mcp: notification }),
      ending: this.#ending,
      slots: this.#slots,
      onWaiting,
    });
  }

  /**
   * @param {string} name
   * @param {unknown} rawArgs
   * @param {ApprovalWait} wait How this call waits for the user.
   * @param {unknown} clientInfo Who the agent's client says it is: the
   *   call's own `_meta` says on a modern request, `initialize` on a legacy one.
   * @returns {Promise<object>} The tool result.
   */
  async #call(name, rawArgs, wait, clientInfo) {
    if (!this.#agent) {
      if (!PAIRING_TOOLS.has(name)) {
        return toolError(
          "not_paired",
          "This agent is not paired with Sval. Call request_isolated_pairing or request_shared_pairing first."
        );
      }
      let args;
      try {
        args = validateArgs(
          UNPAIRED_TOOLS.find(t => t.name === name).inputSchema,
          rawArgs
        );
      } catch (err) {
        if (err instanceof ToolError) {
          return toolError(err.code, err.message, err.details);
        }
        throw err;
      }
      const task = taskFrom(args.task);
      if (!task) {
        return noTask();
      }
      if (wait.full) {
        return awaitingPairing();
      }
      this.#pairing ??= this.#pair(
        task,
        modelFrom(args.model),
        name === "request_isolated_pairing",
        clientInfo
      ).finally(() => {
        this.#pairing = null;
      });
      return this.#awaitApproval(this.#pairing, wait);
    }
    // The user's Stop refuses every call of the paired agent, and answers
    // one already running at once, whatever it waits on (agent-control spec
    // §6). What the call set off is ended beneath (`SvalAgentControl`).
    // A session that has reconnected is stopped as the workspace it held
    // is, before its first call takes that workspace back.
    const held = this.#agent.workspaceId ?? this.#resume;
    const stop = held && this.#deps.untilStopped?.(held);
    if (!stop) {
      return this.#callPaired(name, rawArgs, wait);
    }
    if (stop.stopped) {
      const err = await stop.promise.catch(e => e);
      return toolError(err.code, err.message, err.details);
    }
    // A call Stop answers has had its reply, and its tool acts no more, a
    // Resume included, until it ends (`keepStopped`). A call after the
    // Resume starts once those have ended, as every step of it would be
    // refused until then.
    let answered = false;
    const start = () =>
      answered ? null : this.#callPaired(name, rawArgs, wait);
    const running = stop.drained ? stop.drained.then(start) : start();
    const stopped = stop.promise.catch(err => {
      answered = true;
      wait.answeredElsewhere();
      stop.keepStopped(running);
      return toolError(err.code, err.message, err.details);
    });
    try {
      return await Promise.race([stopped, running]);
    } finally {
      stop.done();
    }
  }

  /**
   * @param {string} name
   * @param {unknown} rawArgs
   * @param {ApprovalWait} wait
   * @returns {Promise<object>} The tool result of the paired agent's call.
   */
  async #callPaired(name, rawArgs, wait) {
    switch (name) {
      case "request_isolated_pairing":
      case "request_shared_pairing":
      case "set_task":
        return this.#setTask(name, rawArgs);
      case "use_workspace":
        return this.#useWorkspace(rawArgs);
    }
    const definition = this.#definitions().find(t => t.name === name);
    if (!definition && !PAIRED_TOOLS.some(t => t.name === name)) {
      return toolError("unknown_tool", "Sval has no tool by that name.");
    }
    const housed = await this.#ensureHoused();
    if (housed !== true) {
      return housed;
    }
    if (definition && this.#deps.tools?.[name]) {
      let args;
      try {
        args = validateArgs(definition.inputSchema, rawArgs);
        return await this.#deps.tools[name](this.#agent, args, { wait });
      } catch (err) {
        if (err instanceof ToolError) {
          // The tab is named only once the arguments are checked: an
          // unchecked one is whatever the agent sent.
          return toolError(err.code, err.message, {
            ...(typeof args?.tab === "string" && { tab: args.tab }),
            ...err.details,
          });
        }
        throw err;
      }
    }
    switch (name) {
      case "close_window":
        return this.#closeWindow();
      case "delete_workspace":
        return this.#deleteWorkspace();
      case "list_tabs":
        return toolText(
          JSON.stringify({
            workspace: this.#agent.task,
            workspace_id: this.#agent.workspaceId,
            tabs: await this.#deps.listTabs(this.#agent),
            polite: politeRules(this.#agent.agentId),
          })
        );
      default:
        return toolError("unknown_tool", "Sval has no tool by that name.");
    }
  }

  /**
   * The pairing's result, or `awaiting_approval` if the user has not answered
   * by the end of the wait. The alert stays open and the pairing stays in
   * flight, so a retry attaches to it, and an Allow after this reply still
   * pairs.
   *
   * @param {Promise<object>} pairing
   * @param {ApprovalWait} wait
   * @returns {Promise<object>}
   */
  #awaitApproval(pairing, wait) {
    return wait.until(pairing, awaitingPairing);
  }

  /**
   * Names the session's workspace for the task it gives, making the
   * workspace when the session has none. A pairing tool called again once
   * paired does the same, so a new session of a paired agent names its own
   * task the way an unpaired one would.
   *
   * @param {string} name The tool called.
   * @param {unknown} rawArgs
   * @returns {Promise<object>}
   */
  async #setTask(name, rawArgs) {
    let args;
    try {
      args = validateArgs(
        [...UNPAIRED_TOOLS, ...PAIRED_TOOLS].find(t => t.name === name)
          .inputSchema,
        rawArgs
      );
    } catch (err) {
      if (err instanceof ToolError) {
        return toolError(err.code, err.message, err.details);
      }
      throw err;
    }
    const task = taskFrom(args.task);
    if (!task) {
      return noTask();
    }
    const housed = await this.#ensureHoused();
    if (housed !== true) {
      if (!this.#agent || codeOf(housed) !== "no_workspace") {
        return housed;
      }
      const id = await this.#makeWorkspace(task, modelFrom(args.model));
      return toolText(`Your workspace is named "${task}". ${keepId(id)}`);
    }
    const { agentId, workspaceId } = this.#agent;
    const named = toolText(
      `Your workspace is named "${task}". Its id is "${workspaceId}".`
    );
    if (task === this.#agent.task) {
      return named;
    }
    await this.#deps.renameWorkspace(workspaceId, task);
    await this.#deps.store.setTask(agentId, workspaceId, task);
    // The pairing may have ended, or the session moved, while the writes ran.
    if (this.#agent?.workspaceId === workspaceId) {
      this.#agent = { ...this.#agent, task };
    }
    return named;
  }

  /**
   * Takes the session to one of its agent's workspaces, unless another
   * connection holds it.
   *
   * @param {unknown} rawArgs
   * @returns {Promise<object>}
   */
  async #useWorkspace(rawArgs) {
    let args;
    try {
      args = validateArgs(
        PAIRED_TOOLS.find(t => t.name === "use_workspace").inputSchema,
        rawArgs
      );
    } catch (err) {
      if (err instanceof ToolError) {
        return toolError(err.code, err.message, err.details);
      }
      throw err;
    }
    if (!this.#paired()) {
      return noLongerPaired();
    }
    const id = args.workspace;
    if (id === this.#agent.workspaceId) {
      return this.#usingResult();
    }
    const taken = await this.#take(id);
    if (taken !== true) {
      return taken;
    }
    return this.#usingResult();
  }

  /**
   * @returns {object} What `use_workspace` answers once the session is in
   *   its workspace.
   */
  #usingResult() {
    return toolText(
      `You are working in your workspace "${this.#agent.task}" again. Its id is "${this.#agent.workspaceId}". list_tabs shows its tabs.`
    );
  }

  /**
   * Closes the windows showing the session's workspace, which keeps its tabs.
   *
   * @returns {Promise<object>}
   */
  async #closeWindow() {
    let closed;
    try {
      closed = await this.#deps.closeWindows(this.#agent.workspaceId);
    } catch (err) {
      if (err instanceof ToolError) {
        return toolError(err.code, err.message, err.details);
      }
      throw err;
    }
    return toolText(
      closed
        ? "Your window is closed, and your workspace keeps its tabs."
        : "Your window is Sval's only window, so it stays open."
    );
  }

  /**
   * Deletes the session's workspace with its tabs. The agent stays paired,
   * and the session has no workspace until it makes or takes one.
   *
   * @returns {Promise<object>}
   */
  async #deleteWorkspace() {
    const { workspaceId } = this.#agent;
    // A workspace the user has taken control of, or whose agent they
    // stopped, is theirs until they give it back, as for every other tool.
    try {
      this.#deps.refuseIfWorkspaceHeld?.(workspaceId);
    } catch (err) {
      if (err instanceof ToolError) {
        return toolError(err.code, err.message, err.details);
      }
      throw err;
    }
    if (!(await this.#deps.deleteWorkspace(workspaceId))) {
      return toolError(
        "not_deleted",
        "Sval keeps at least one workspace, so it cannot delete this one now."
      );
    }
    await this.#deps.store.workspaceDeleted(workspaceId);
    this.#leave();
    return toolText(
      "Your workspace and its tabs are deleted. Call set_task to make a new one if you need the browser again."
    );
  }

  /**
   * Asks the user to pair, and pairs on Allow. Connections from one app
   * share one alert and one pairing (`deps.pairings`), keyed by the launch's
   * id, which is the app's: two alerts would make two records, one of them
   * orphaned. Each connection then makes its own workspace, named for the
   * task its own call gave.
   *
   * @param {string} task What `taskFrom` kept of the task the agent gave,
   *   which names its workspace.
   * @param {string} model What `modelFrom` kept of the model it gave.
   * @param {boolean} isolated Whether the agent asked for an isolated
   *   workspace. The alert offers it as the choice, and the user's answer
   *   decides.
   * @param {unknown} clientInfo Who the agent's client says it is.
   */
  async #pair(task, model, isolated, clientInfo) {
    const launch = this.#launch;
    // With no launch, connections of one client program share a pairing,
    // and a program is told apart by its name, which a title need not do.
    const key = launch?.id ?? labelFrom({ name: clientInfo?.name });
    const pairings = this.#deps.pairings ?? new Map();
    let shared = pairings.get(key);
    if (!shared) {
      const label = labelFrom(clientInfo);
      const facts = {
        client: label,
        dir: launch?.dir ?? "",
        started: launch?.started ?? null,
      };
      shared = {
        label,
        answer: (async () =>
          this.#deps.askToPair(
            label,
            [`Task: ${task}`, ...launchLines(facts)],
            isolated
          ))(),
        created: null,
      };
      pairings.set(key, shared);
      // Once answered, a new request is a new question.
      const forget = () => {
        if (pairings.get(key) === shared) {
          pairings.delete(key);
        }
      };
      shared.answer.then(forget, forget);
    }
    const answer = await shared.answer;
    // No one is left to hand a secret to, so nothing is created.
    if (this.#closed) {
      return toolError(
        "disconnected",
        "The agent disconnected before the user answered."
      );
    }
    if (this.#agent) {
      return this.#pairedResult();
    }
    if (answer?.action === "no_window") {
      return toolError(
        "no_window",
        "Sval has no open window to ask the user in. Open a Sval window and try again."
      );
    }
    if (answer?.action !== "allow") {
      return toolError(
        "pairing_denied",
        "The user declined to pair this agent with Sval. Don't ask again unless they tell you to."
      );
    }
    // The first connection back from the answer creates the record; the
    // others wait for it and hand the same secret to their bridges.
    const { label } = shared;
    const chosen = answer.isolated === true;
    shared.created ??= this.#deps.store.pair({
      label,
      client: label,
      isolated: chosen,
      launchId: this.#launch?.id ?? null,
    });
    const { agentId, secret } = await shared.created;
    this.#agent = {
      agentId,
      label,
      isolated: chosen,
      workspaceId: null,
      task: "",
      model: "",
    };
    this.#emit({ ctl: { paired: { agent_id: agentId, secret } } });
    this.#emit({
      mcp: { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
    });
    await this.#makeWorkspace(task, model);
    return this.#pairedResult(chosen);
  }

  /**
   * Whether the agent is still paired. Unpairing ends the record, and this
   * connection then offers the pairing tools again.
   *
   * @returns {boolean}
   */
  #paired() {
    const { agentId } = this.#agent;
    if (this.#deps.store.agents().some(a => a.agentId === agentId)) {
      return true;
    }
    this.#unpaired();
    return false;
  }

  /**
   * `#house`, shared by the calls that arrive while it runs.
   *
   * @returns {Promise<true|object>}
   */
  #ensureHoused() {
    this.#housing ??= this.#house().finally(() => {
      this.#housing = null;
    });
    return this.#housing;
  }

  /**
   * Whether the session has a workspace to act in. One the user deleted is
   * forgotten, and the session has none until it makes or takes one. A
   * session that has none takes back the workspace `sval-mcp` held on its
   * last connection, if no other connection holds it now.
   *
   * @returns {Promise<true|object>} true, or the tool error to answer.
   */
  async #house() {
    if (!this.#paired()) {
      return noLongerPaired();
    }
    const { workspaceId } = this.#agent;
    if (workspaceId) {
      if (await this.#deps.hasWorkspace(workspaceId)) {
        return true;
      }
      await this.#deps.store.workspaceDeleted(workspaceId);
      this.#leave();
      return noWorkspace();
    }
    const resume = this.#resume;
    if (resume) {
      const taken = await this.#take(resume);
      // While the user holds it, the session waits for it, as it would
      // had it never reconnected.
      if (taken !== true && USER_HOLDS.has(codeOf(taken))) {
        return taken;
      }
      this.#resume = null;
      if (taken === true) {
        return true;
      }
    }
    return noWorkspace();
  }

  /**
   * Makes a workspace for this session, named for `task`, of the kind the
   * user chose for its agent, and makes it the session's.
   *
   * @param {string} task
   * @param {string} model
   * @returns {Promise<string>} The workspace's id.
   */
  async #makeWorkspace(task, model) {
    const { agentId, label } = this.#agent;
    // The kind as the user chose it last, which may have changed since this
    // connection opened.
    const isolated =
      this.#deps.store.agents().find(a => a.agentId === agentId)?.isolated ===
      true;
    const id = await this.#deps.createAgentWorkspace(task, label, isolated);
    await this.#deps.store.addWorkspace(agentId, id, {
      task,
      model,
      dir: this.#launch?.dir ?? "",
      started: this.#launch?.started ?? null,
      lastUsed: this.#deps.now(),
    });
    this.#hold(id, { task, model });
    SvalLog.info(`agent ${agentId} has a new workspace ${id}`);
    return id;
  }

  /**
   * Makes workspace `id` the session's, if it is one of its agent's, it
   * still exists, and no other connection holds it.
   *
   * @param {string} id
   * @returns {Promise<true|object>} true, or the tool error to answer.
   */
  async #take(id) {
    const { agentId } = this.#agent;
    const entry = this.#deps.store.workspaceOf(agentId, id);
    if (!entry) {
      return workspaceNotFound();
    }
    if (!(await this.#deps.hasWorkspace(id))) {
      await this.#deps.store.workspaceDeleted(id);
      return workspaceNotFound();
    }
    const holder = this.#deps.holders.get(id);
    if (holder && holder !== this) {
      return workspaceInUse();
    }
    // A workspace the user has taken control of, or whose agent they
    // stopped, is theirs until they give it back.
    try {
      this.#deps.refuseIfWorkspaceHeld?.(id);
    } catch (err) {
      if (err instanceof ToolError) {
        return toolError(err.code, err.message, err.details);
      }
      throw err;
    }
    this.#hold(id, entry);
    await this.#deps.store.touchWorkspace(agentId, id, this.#deps.now());
    return true;
  }

  /**
   * Holds workspace `id` for this connection, letting go of any other, and
   * tells `sval-mcp`, which names it when it connects again.
   *
   * @param {string} id
   * @param {{task: string, model: string}} entry
   */
  #hold(id, { task, model }) {
    this.#detach();
    this.#deps.holders.set(id, this);
    this.#agent = {
      ...this.#agent,
      workspaceId: id,
      task: task || this.#agent.label,
      model,
    };
    this.#emit({ ctl: { workspace: id } });
  }

  /** Lets go of the session's workspace, which then has none. */
  #leave() {
    this.#detach();
    this.#agent = { ...this.#agent, workspaceId: null, task: "", model: "" };
    this.#emit({ ctl: { workspace: null } });
  }

  /** Lets another connection take the workspace this one holds. */
  #detach() {
    const id = this.#agent?.workspaceId;
    if (id && this.#deps.holders?.get(id) === this) {
      this.#deps.holders.delete(id);
    }
  }

  /**
   * Makes this connection an unpaired one, once the agent's pairing has
   * ended, so it is offered the pairing tools again.
   */
  #unpaired() {
    if (!this.#agent) {
      return;
    }
    SvalLog.info(`agent ${this.#agent.agentId} is no longer paired`);
    this.#detach();
    this.#agent = null;
    this.#listed = null;
    this.#emit({
      mcp: { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
    });
  }

  /**
   * @param {boolean} [isolated] The kind of workspace the user chose, when
   *   this connection is the one the pairing was answered for.
   */
  #pairedResult(isolated) {
    let kind = "";
    if (isolated === true) {
      kind =
        " The user chose an isolated workspace: sites in it see none of their sign-ins.";
    } else if (isolated === false) {
      kind =
        " The user chose a shared workspace: sites in it see the accounts they are signed in to.";
    }
    const where = this.#agent.workspaceId
      ? ` ${keepId(this.#agent.workspaceId)}`
      : "";
    return toolText(
      `Paired with Sval as "${this.#agent.label}", in a workspace named "${this.#agent.task}".${kind}${where} Sval's tools are now available.`
    );
  }
}
