/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * One agent connection, after the handshake (agent-control spec §3.2, §4,
 * §5.1). A frame carrying `{mcp}` is a JSON-RPC request for the agent's
 * tools or a call of one, with `client` saying who the agent's client is.
 * `sval-mcp` speaks MCP's versions with the agent: it answers `initialize`,
 * `server/discover` and `ping` itself, sends on only a request whose
 * version it has checked, and gives a result the shape that version wants.
 * `{ctl}` frames go toward `sval-mcp` only, so the pairing secret goes to
 * the bridge, which stores it, and never into the agent's model context.
 *
 * No sockets here. `SvalAgents` owns the connection and hands each decoded
 * frame to `handle`.
 *
 * Every request gets exactly one reply, even when what it needed failed: an
 * agent left waiting has no way to tell a slow answer from none. A
 * notification gets none, and runs nothing.
 */

import { printable } from "moz-src:///browser/components/sval/SvalAgentArgs.sys.mjs";
import { ToolError } from "moz-src:///browser/components/sval/SvalAgentErrors.sys.mjs";
import {
  codeOf,
  json,
  refusal,
  refusalOf,
  text,
  toMcp,
} from "moz-src:///browser/components/sval/SvalAgentResult.sys.mjs";
import {
  ApprovalWait,
  Ending,
} from "moz-src:///browser/components/sval/SvalAgentAlerts.sys.mjs";
import {
  SvalLog,
  describeError,
} from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { politeRules } from "moz-src:///browser/components/sval/SvalAgentPolite.sys.mjs";
import { createToolRunner } from "moz-src:///browser/components/sval/SvalAgentToolRunner.sys.mjs";
import {
  MAX_MODEL_CHARS,
  MAX_TASK_CHARS,
} from "moz-src:///browser/components/sval/SvalAgentToolsWorkspace.sys.mjs";

const MAX_LABEL_CHARS = 64;
/** The most characters of a launch directory Sval keeps. */
const MAX_DIR_CHARS = 1024;
/** A build id as `sval-mcp` reports one: Sval's build id, or a dev version. */
const BUILD_PATTERN = /^[0-9A-Za-z._+-]{1,64}$/;

/**
 * The agent's client as people know it, made safe to draw: its MCP display
 * name (`title`), or its programmatic `name` when it gives none.
 *
 * @param {unknown} clientInfo What the client says it is, in MCP's
 *   `clientInfo`.
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

const result = (id, value) => ({ jsonrpc: "2.0", id, result: value });
const failure = (id, code, message, data) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data !== undefined && { data }) },
});

const noTask = () =>
  refusal(
    "invalid_arguments",
    "task has nothing Sval can show. Say what you are doing in a few words, in letters and digits."
  );
const noLongerPaired = () =>
  refusal(
    "not_paired",
    "This agent is no longer paired with Sval. Call request_isolated_pairing or request_shared_pairing to pair again."
  );
const noWorkspace = () => refusal("no_workspace");
const workspaceInUse = () => refusal("workspace_in_use");
const workspaceNotFound = () =>
  refusal(
    "not_found",
    "No workspace of yours has that id. The user may have deleted it. Call set_task to make a new one."
  );

/** The codes of a workspace the user holds, by take or by Stop. */
const USER_HOLDS = new Set(["user_in_control", "stopped_by_user"]);

/**
 * What every answer that gives a session its workspace says of it.
 *
 * @param {string} workspaceId
 * @returns {string}
 */
const keepId = workspaceId =>
  `Your workspace id is "${workspaceId}". Keep it for as long as this conversation may go on: it is the only way back to this workspace. When the conversation resumes in a later session, call use_workspace with it before anything else. If you lose it, you cannot reconnect to this workspace.`;

const awaitingPairing = () =>
  refusal(
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
  /**
   * What runs the agent's tools (`SvalAgentToolRunner`): the listen's, or
   * one for the session's own tools alone when it is given none.
   */
  #tools;
  /**
   * What the session lends a tool call of itself (`call.session`): its
   * agent, whether it has a workspace, and the operations the tools of
   * `SvalAgentToolsWorkspace` name.
   */
  #lent;
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
    this.#tools = deps.tools ?? createToolRunner();
    const session = this;
    this.#lent = {
      get agent() {
        return session.#agent;
      },
      ensureHoused: () => this.#ensureHoused(),
      requestPairing: (args, isolated, call) =>
        this.#requestPairing(args, isolated, call),
      setTask: args => this.#setTask(args),
      useWorkspace: id => this.#useWorkspace(id),
      listTabs: () => this.#listTabs(),
      closeWindow: () => this.#closeWindow(),
      deleteWorkspace: () => this.#deleteWorkspace(),
    };
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
      this.#tools.definitions(this.#agent).map(t => t.name),
      politeRules(this.#agent.agentId),
    ]);
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
    const wait =
      msg.method === "tools/call"
        ? this.#waitFor(msg.params?._meta?.progressToken, onWaiting)
        : null;
    if (wait) {
      this.#calls.set(msg.id, wait);
    }
    let reply;
    try {
      reply = await this.#dispatch(msg, wait, frame.client ?? null);
    } finally {
      if (wait && this.#calls.get(msg.id) === wait) {
        this.#calls.delete(msg.id);
      }
    }
    if (!wait?.cancelled) {
      this.#emit({ mcp: reply });
    }
  }

  /**
   * The reply to one request. A failure becomes an error reply naming only
   * the error's name: its message can carry a path, and the agent's model
   * reads what a tool returns.
   *
   * @param {object} msg A JSON-RPC request.
   * @param {ApprovalWait|null} wait How a tool call waits for the user.
   * @param {unknown} client Who the agent's client says it is, as the
   *   bridge read it from the agent's MCP session.
   * @returns {Promise<object>}
   */
  async #dispatch(msg, wait, client) {
    try {
      return await this.#answer(msg, wait, client);
    } catch (err) {
      SvalLog.error(`agent request failed: ${describeError(err)}`);
      const errorName = typeof err?.name === "string" ? err.name : "Error";
      return msg.method === "tools/call"
        ? result(
            msg.id,
            toMcp(
              refusal(
                "internal_error",
                `${errorName}: Sval hit a fault. Try once more, then tell the user.`
              )
            )
          )
        : failure(msg.id, -32603, `internal_error: ${errorName}`);
    }
  }

  async #answer(msg, wait, client) {
    switch (msg.method) {
      case "tools/list": {
        if (this.#agent) {
          this.#listed = this.#listing();
        }
        return result(msg.id, {
          tools: this.#tools.definitions(this.#agent),
        });
      }
      case "tools/call":
        return result(
          msg.id,
          toMcp(
            await this.#call(
              msg.params?.name,
              msg.params?.arguments,
              wait,
              client
            )
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
   * @param {unknown} clientInfo Who the agent's client says it is.
   * @returns {Promise<object>} The tool result.
   */
  async #call(name, rawArgs, wait, clientInfo) {
    const run = () =>
      this.#tools.call(this.#lent, name, rawArgs, { wait, clientInfo });
    if (!this.#agent) {
      return run();
    }
    // The user's Stop refuses every call of the paired agent, and answers
    // one already running at once, whatever it waits on (agent-control spec
    // §6). What the call set off is ended beneath (`SvalAgentControl`).
    // A session that has reconnected is stopped as the workspace it held
    // is, before its first call takes that workspace back.
    const held = this.#agent.workspaceId ?? this.#resume;
    const stop = held && this.#deps.untilStopped?.(held);
    if (!stop) {
      return run();
    }
    if (stop.stopped) {
      const err = await stop.promise.catch(e => e);
      return refusalOf(err);
    }
    // A call Stop answers has had its reply, and its tool acts no more, a
    // Resume included, until it ends (`keepStopped`). A call after the
    // Resume starts once those have ended, as every step of it would be
    // refused until then.
    let answered = false;
    const start = () => (answered ? null : run());
    const running = stop.drained ? stop.drained.then(start) : start();
    const stopped = stop.promise.catch(err => {
      answered = true;
      wait.answeredElsewhere();
      stop.keepStopped(running);
      return refusalOf(err);
    });
    try {
      return await Promise.race([stopped, running]);
    } finally {
      stop.done();
    }
  }

  /**
   * Asks the user to pair, for an unpaired agent. Every pairing request
   * that arrives while the alert is open shares it. A pairing tool called
   * once paired names the session's task, as `set_task` does.
   *
   * @param {{task: string, model?: string}} args
   * @param {boolean} isolated Whether the agent asked for an isolated
   *   workspace.
   * @param {{wait: ApprovalWait, clientInfo: unknown}} call How the call
   *   waits for the user, and who the agent's client says it is.
   * @returns {Promise<object>}
   */
  #requestPairing(args, isolated, { wait, clientInfo }) {
    if (this.#agent) {
      return this.#setTask(args);
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
      isolated,
      clientInfo
    ).finally(() => {
      this.#pairing = null;
    });
    return this.#awaitApproval(this.#pairing, wait);
  }

  /**
   * @returns {Promise<object>} What `list_tabs` answers: the session's
   *   workspace, its tabs and the rules Be polite holds the agent to.
   */
  async #listTabs() {
    return json({
      workspace: this.#agent.task,
      workspace_id: this.#agent.workspaceId,
      tabs: await this.#deps.listTabs(this.#agent),
      polite: politeRules(this.#agent.agentId),
    });
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
   * @param {{task: string, model?: string}} args
   * @returns {Promise<object>}
   */
  async #setTask(args) {
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
      return text(`Your workspace is named "${task}". ${keepId(id)}`);
    }
    const { agentId, workspaceId } = this.#agent;
    const named = text(
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
   * @param {string} id The workspace's id.
   * @returns {Promise<object>}
   */
  async #useWorkspace(id) {
    if (!this.#paired()) {
      return noLongerPaired();
    }
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
    return text(
      `You are working in your workspace "${this.#agent.task}" again. Its id is "${this.#agent.workspaceId}". list_tabs shows its tabs.`
    );
  }

  /**
   * Closes the windows showing the session's workspace, which keeps its tabs.
   *
   * @returns {Promise<object>}
   */
  async #closeWindow() {
    const closed = await this.#deps.closeWindows(this.#agent.workspaceId);
    return text(
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
    this.#deps.refuseIfWorkspaceHeld?.(workspaceId);
    if (!(await this.#deps.deleteWorkspace(workspaceId))) {
      return refusal(
        "not_deleted",
        "Sval keeps at least one workspace, so it cannot delete this one now."
      );
    }
    await this.#deps.store.workspaceDeleted(workspaceId);
    this.#leave();
    return text(
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
            isolated,
            Boolean(launch?.id && this.#deps.store.pairedBefore(launch.id))
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
      return refusal(
        "disconnected",
        "The agent disconnected before the user answered."
      );
    }
    if (this.#agent) {
      return this.#pairedResult();
    }
    if (answer?.action === "no_window") {
      return refusal(
        "no_window",
        "Sval has no open window to ask the user in. Open a Sval window and try again."
      );
    }
    if (answer?.action !== "allow") {
      return refusal(
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
        return refusalOf(err);
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
    return text(
      `Paired with Sval as "${this.#agent.label}", in a workspace named "${this.#agent.task}".${kind}${where} Sval's tools are now available.`
    );
  }
}
