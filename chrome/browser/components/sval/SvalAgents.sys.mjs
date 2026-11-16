/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The door local agents knock on (agent-control spec §3.2). A loopback-only
 * TCP listener, open while `browser.sval.agents.enabled` is true, whose port is
 * written to `<profile>/sval-agents/port.json` for `sval-mcp` to find, beside a
 * random token for this listen. `sval-agents` is a directory only its OS user
 * can open, and holds the agents file too.
 *
 * A port file can outlive Sval, and another process can then listen on that
 * port, so `sval-mcp` must not hand that process its secret until the listener
 * proves it is Sval. And any local process can connect to Sval, including
 * another OS user's, so Sval must not show it the pairing alert, or say
 * whether an agent id exists, until the client proves it can read the port
 * file. Both proofs are challenge-responses, because the token itself cannot
 * cross the wire: anyone who connects while Sval runs would learn it, and could
 * replay it later from a stale port.
 *
 * 1. `sval-mcp` sends `{challenge: nonce_c}`, a fresh 64-character lowercase
 *    hex nonce on every attempt.
 * 2. Sval answers `{ctl: {sval: proof, challenge: nonce_b}}`. `proof` is the hex
 *    HMAC-SHA256 of `"sval:" + nonce_c`, keyed by the token's text, and
 *    `nonce_b` is fresh for this connection and used once.
 * 3. `sval-mcp` checks the proof, then sends its handshake with
 *    `proof: HMAC(token, "agent:" + nonce_b)`.
 * 4. Sval checks that proof before it reads anything else in the handshake. A
 *    wrong or missing one closes the connection with nothing sent.
 *
 * The two prefixes stop reflection (`SvalAgentWire`,
 * `tools/sval-mcp/src/proof.rs`). A recorded proof is useless against a
 * fresh nonce. The port file is readable by its owner only, in a directory
 * only its owner can open, so only that user's processes can make either
 * proof. Sval sends nothing until it has received a valid challenge, and
 * closes at once on anything else. The token is never logged.
 *
 * The challenge and the handshake must both complete within
 * `HANDSHAKE_TIMEOUT_MS`, in at most `PRE_AUTH_MAX_BYTES`, so a peer that
 * cannot prove itself cannot make Sval buffer more. The handshake frame is
 * `{hello: 1, pair: true, proof}` for an agent with no secret, or
 * `{hello: 1, agent_id, secret, proof}`, each with `launch`, where
 * and when the agent's `sval-mcp` started (`launchFrom`), and `workspace`, the
 * workspace it held on its last connection, once it has held one. Anything
 * else closes the connection. After the handshake, frames go to a `SvalAgentSession`.
 *
 * One listener per process. `start` is called by every window's panel and acts
 * once.
 */

import {
  SvalLog,
  describeError,
} from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import {
  svalProof,
  encodeFrame,
  freshNonce,
  FrameDecoder,
  HEX64,
  isAgentProof,
  MAX_FRAME_BYTES,
  proofKey,
} from "moz-src:///browser/components/sval/SvalAgentWire.sys.mjs";
import {
  SvalAgentStore,
  makePrivateDirectory,
} from "moz-src:///browser/components/sval/SvalAgentStore.sys.mjs";
import { writePrivateJSON } from "moz-src:///browser/components/sval/SvalPrivateFile.sys.mjs";
import {
  SvalAgentSession,
  launchFrom,
} from "moz-src:///browser/components/sval/SvalAgentSession.sys.mjs";
import { PAGE_ACTOR } from "moz-src:///browser/components/sval/SvalAgentPageParent.sys.mjs";
import { markProfile } from "moz-src:///browser/components/sval/SvalAgentPolicy.sys.mjs";
import {
  POLITE_RATE_PREF,
  POLITE_TOPIC,
} from "moz-src:///browser/components/sval/SvalAgentPolite.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  SvalClock: "moz-src:///browser/components/sval/SvalClock.sys.mjs",
  SvalAgentClients:
    "moz-src:///browser/components/sval/SvalAgentClients.sys.mjs",
  createAgentDialogs:
    "moz-src:///browser/components/sval/SvalAgentPageDialogs.sys.mjs",
  createAgentGate: "moz-src:///browser/components/sval/SvalAgentGate.sys.mjs",
  createAgentTabs: "moz-src:///browser/components/sval/SvalAgentTabs.sys.mjs",
  createAgentTools: "moz-src:///browser/components/sval/SvalAgentTools.sys.mjs",
  SYNC_DOCUMENT: "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
  TOOL_DEFINITIONS: "moz-src:///browser/components/sval/SvalAgentTools.sys.mjs",
  untilStopped: "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs",
  refuseIfWorkspaceHeld:
    "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs",
  isWorkspaceHeld:
    "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
  PAGE_TOOL_DEFINITIONS:
    "moz-src:///browser/components/sval/SvalAgentTools.sys.mjs",
  pageToolsSettingOf:
    "moz-src:///browser/components/sval/SvalAgentPageTools.sys.mjs",
  workspaceIds: "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
});

const PREF = "browser.sval.agents.enabled";

/**
 * How many days an agent workspace no session has held is kept before Sval
 * deletes it, or 0 to keep it (decision 1998).
 */
const WORKSPACE_RETENTION_PREF = "browser.sval.agents.workspaceRetentionDays";

/** The choices Settings offers for it, 0 being Never. */
export const WORKSPACE_RETENTION_DAYS = Object.freeze([7, 30, 90, 0]);

const DEFAULT_WORKSPACE_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @returns {number} The days an unused agent workspace is kept, 0 for
 *   always: the setting, or 30 when it holds no choice Settings offers.
 */
export function workspaceRetentionDays() {
  const days = Services.prefs.getIntPref(
    WORKSPACE_RETENTION_PREF,
    DEFAULT_WORKSPACE_RETENTION_DAYS
  );
  return WORKSPACE_RETENTION_DAYS.includes(days)
    ? days
    : DEFAULT_WORKSPACE_RETENTION_DAYS;
}

/**
 * The handshake version Sval speaks. Sval also accepts the one before it, so
 * the `sval-mcp` an agent started before an update keeps working until the
 * agent restarts it (sval-mcp-ships-with-sval spec §6).
 */
const HELLO = 1;
/** "Let sites offer tools to agents" (site-tools spec §4.1, layer A). */
const PAGE_TOOLS_PREF = "browser.sval.agents.pageTools.enabled";
/** Gecko's own switch for WebMCP, which Sval derives from the two above. */
export const MODEL_CONTEXT_PREF = "dom.modelcontext.enabled";
/**
 * Told whenever `SvalAgents.problem` may have changed, or the paired agents
 * and their policies have.
 */
const STATE_TOPIC = "sval-agents-state";
const HANDSHAKE_TIMEOUT_MS = 10_000;
/**
 * What a connection may send before its handshake succeeds: room for the
 * challenge and the handshake, and no more for a peer that has proven nothing.
 */
const PRE_AUTH_MAX_BYTES = 4096;
/**
 * How many connections may be open at once before their handshake succeeds.
 * Each accepted socket takes a place in the socket transport service, which
 * the whole process shares and which attaches no more than a fixed number
 * (`nsSocketTransportService::CanAttachSocket`). A local peer that opens
 * connections and sends nothing holds each place for `HANDSHAKE_TIMEOUT_MS`,
 * so without a cap it could leave the user's page loads waiting for one.
 * Each sval-mcp opens one connection at a time and finishes its handshake in
 * two round trips, so a few places serve agents that start together.
 */
export const MAX_UNPROVEN_CONNECTIONS = 8;
/** Sval's private directory in the profile, and the files it holds. */
export const AGENT_DIR = "sval-agents";
const PORT_FILE = "port.json";
const AGENTS_FILE = "agents.json";

// The output pipe holds the largest frame and its 4-byte header with room to
// spare, so writing one frame never blocks.
const OUTPUT_SEGMENT_BYTES = 65536;
const OUTPUT_SEGMENTS = Math.ceil((MAX_FRAME_BYTES + 4) / OUTPUT_SEGMENT_BYTES);

const ServerSocket = Components.Constructor(
  "@mozilla.org/network/server-socket;1",
  "nsIServerSocket",
  "initSpecialConnection"
);
const BinaryInputStream = Components.Constructor(
  "@mozilla.org/binaryinputstream;1",
  "nsIBinaryInputStream",
  "setInputStream"
);
const BinaryOutputStream = Components.Constructor(
  "@mozilla.org/binaryoutputstream;1",
  "nsIBinaryOutputStream",
  "setOutputStream"
);

let pageActorRegistered = false;
/** Where the shutdown blocker is registered, while it is. */
let shutdownClient = null;
/** What `start` was given. Null until the first call. */
let config = null;
/** The open listener, its connections and its store. Null while closed. */
let open = null;
/** Serialises listen and stop, so a pref flipped twice quickly settles. */
let transition = Promise.resolve();
let stopping = null;
/** Why the listener is not open although the pref is on, or null. */
let problem = null;
const changeListeners = new Set();

/**
 * An error that says which `SvalAgents.problem` it is.
 *
 * @param {string} reason
 * @param {Error} cause
 * @returns {Error}
 */
function withProblem(reason, cause) {
  const err = new Error(`${reason}: ${cause?.message ?? cause}`, { cause });
  err.name = cause?.name ?? "Error";
  err.svalAgentsProblem = reason;
  return err;
}

/**
 * One accepted socket: the challenge, the handshake, then a `SvalAgentSession`.
 */
class Connection {
  QueryInterface = ChromeUtils.generateQI([
    "nsIStreamListener",
    "nsIRequestObserver",
  ]);
  #input;
  #out;
  #decoder = new FrameDecoder();
  #session = null;
  #proven = false;
  #proofKey;
  /** The challenge Sval sent this connection, until a handshake answers it. */
  #challenge = null;
  #timer;
  #onClosed;
  #closed = false;

  /** Whether the handshake has succeeded. */
  get inSession() {
    return this.#session !== null;
  }

  /** The paired agent this connection acts for, or null. */
  get agentId() {
    return this.#session?.agent?.agentId ?? null;
  }

  toolsMayHaveChanged() {
    this.#session?.toolsMayHaveChanged();
  }
  /** Bytes received while there is no session. */
  #preAuthBytes = 0;
  /**
   * Frames handled one at a time, in arrival order, except that a request
   * waiting for the user's answer to an alert lets the next frame go ahead:
   * the user may take hours, and the agent's other calls must not wait
   * behind it. Every call that waits on one alert settles on its answer.
   */
  #queue = Promise.resolve();

  /**
   * Opens the socket's streams. Nothing is read or sent until `begin`, so the
   * caller can register the connection before anything can close it.
   *
   * @param {nsISocketTransport} transport
   * @param {CryptoKey} key Both proofs' key, made from the port file's token.
   * @param {(connection: Connection) => void} onClosed
   */
  constructor(transport, key, onClosed) {
    this.#proofKey = key;
    this.#onClosed = onClosed;
    this.#out = new BinaryOutputStream(
      transport.openOutputStream(0, OUTPUT_SEGMENT_BYTES, OUTPUT_SEGMENTS)
    );
    this.#input = transport.openInputStream(0, 0, 0);
  }

  begin() {
    const pump = Cc["@mozilla.org/network/input-stream-pump;1"].createInstance(
      Ci.nsIInputStreamPump
    );
    pump.init(this.#input, 0, 0, false);
    pump.asyncRead(this);
    this.#timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    this.#timer.initWithCallback(
      () => {
        if (!this.#session) {
          SvalLog.info("agent connection closed: no handshake in time");
          this.close();
        }
      },
      HANDSHAKE_TIMEOUT_MS,
      Ci.nsITimer.TYPE_ONE_SHOT
    );
  }

  send(frame) {
    if (this.#closed) {
      return;
    }
    try {
      this.#out.writeByteArray(encodeFrame(frame));
    } catch (err) {
      SvalLog.warn(`agent connection write failed: ${describeError(err)}`);
      this.close();
    }
  }

  /**
   * Closes the connection once anything already written has reached the
   * socket. Closing the output pipe lets its copier drain what is queued, such
   * as a `refused` frame sent just before, into the socket and then close it.
   * The socket is released once both of its streams are closed
   * (`nsSocketTransport::OnMsgOutputClosed`). `nsITransport.close` closes the
   * socket's streams at once and drops whatever is still queued.
   */
  close() {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#timer?.cancel();
    this.#session?.close();
    try {
      this.#out.close();
    } catch {}
    try {
      this.#input.close();
    } catch {}
    this.#onClosed(this);
  }

  onStartRequest() {}

  onDataAvailable(_request, stream, _offset, count) {
    const buffer = new ArrayBuffer(count);
    new BinaryInputStream(stream).readArrayBuffer(count, buffer);
    if (this.#closed) {
      return;
    }
    if (!this.#session) {
      this.#preAuthBytes += count;
      if (this.#preAuthBytes > PRE_AUTH_MAX_BYTES) {
        SvalLog.info("agent connection closed: too much before the handshake");
        this.close();
        return;
      }
    }
    let frames;
    try {
      frames = this.#decoder.push(new Uint8Array(buffer));
    } catch (err) {
      SvalLog.info(`agent connection closed: ${SvalLog.errorName(err)}`);
      this.close();
      return;
    }
    for (const frame of frames) {
      this.#queue = this.#queue.then(
        () =>
          new Promise(next => {
            this.#handle(frame, next).finally(next);
          })
      );
    }
  }

  onStopRequest() {
    this.close();
  }

  /**
   * @param {object} frame
   * @param {() => void} onWaiting Lets the next frame go ahead.
   */
  async #handle(frame, onWaiting) {
    if (this.#closed) {
      return;
    }
    if (this.#session) {
      try {
        await this.#session.handle(frame, { onWaiting });
      } catch (err) {
        // The session answers every failure it can foresee. Past that, a
        // request may have gone unanswered, and closing is what tells
        // sval-mcp, so the agent is not left waiting.
        SvalLog.error(`agent request failed: ${describeError(err)}`);
        this.close();
      }
      return;
    }
    try {
      if (this.#proven) {
        await this.#handshake(frame);
      } else {
        await this.#prove(frame);
      }
    } catch (err) {
      SvalLog.error(`agent handshake failed: ${describeError(err)}`);
      this.close();
    }
  }

  /**
   * Answers the agent's challenge. A first frame that is not one closes the
   * connection with nothing sent. A well-formed challenge is signed before
   * the peer has proven anything, so any peer learns that the port is
   * Sval's listener; the `sval:` prefix keeps the answer from serving as an
   * agent's proof (`SvalAgentWire`).
   *
   * @param {object} frame The first frame the agent sent.
   */
  async #prove(frame) {
    const nonce = frame?.challenge;
    if (typeof nonce !== "string" || !HEX64.test(nonce)) {
      SvalLog.info("agent connection closed: first frame was not a challenge");
      this.close();
      return;
    }
    const proof = await svalProof(this.#proofKey, nonce);
    if (this.#closed) {
      return;
    }
    this.#proven = true;
    this.#challenge = freshNonce();
    this.send({ ctl: { sval: proof, challenge: this.#challenge } });
  }

  /**
   * Checks the handshake's proof before anything else in it is read, so a
   * peer that cannot read the port file learns nothing past what `#prove`
   * told it, that the port is Sval's listener: not whether an agent id
   * exists. A failed proof closes the connection with nothing sent. The
   * challenge is used once.
   *
   * @param {object} frame The frame after Sval's proof.
   */
  async #handshake(frame) {
    const challenge = this.#challenge;
    this.#challenge = null;
    if (!(await isAgentProof(this.#proofKey, challenge, frame.proof))) {
      SvalLog.info("agent connection closed: the handshake proved nothing");
      this.close();
      return;
    }
    if (this.#closed) {
      return;
    }
    const speaks = config?.hello ?? HELLO;
    if (
      !Number.isSafeInteger(frame.hello) ||
      frame.hello < 1 ||
      frame.hello > speaks
    ) {
      SvalLog.info("agent connection closed: first frame was not a handshake");
      this.close();
      return;
    }
    if (frame.hello < speaks - 1) {
      // The shim's pairing secret is still good, so it is told why rather
      // than refused as an unknown agent, which would make it pair again.
      SvalLog.info(
        `agent connection refused: sval-mcp speaks hello ${frame.hello}`
      );
      this.send({ ctl: { refused: "outdated" } });
      this.close();
      return;
    }
    let agent = null;
    if (frame.pair !== true) {
      agent = await open?.store.verify(frame.agent_id, frame.secret);
      if (!agent) {
        this.send({ ctl: { refused: "unknown_agent" } });
        this.close();
        return;
      }
    }
    if (!open || this.#closed) {
      // Agent access was switched off, or the peer left, while this handshake
      // was in flight.
      this.close();
      return;
    }
    this.#timer.cancel();
    const launch = launchFrom(frame.launch);
    this.#session = new SvalAgentSession({
      agent,
      launch,
      workspace: workspaceFrom(frame.workspace),
      send: f => this.send(f),
      deps: sessionDeps(),
    });
    this.send({ ctl: { ready: agent ? "paired" : "unpaired" } });
    const build = launch?.build ?? "unknown";
    SvalLog.info(
      agent
        ? `agent ${agent.agentId} connected, sval-mcp ${build}`
        : `unpaired agent connected, sval-mcp ${build}`
    );
  }
}

/**
 * Publishes a change Sval made to an agent's workspace, and redraws what
 * shows it. One pass for the process publishes it. Every window draws its
 * report as another window's pass, so the listeners only redraw: a pass per
 * window would run one pass per window for one change.
 *
 * @param {object} engine
 */
function publishWorkspaceChange(engine) {
  Promise.resolve()
    .then(() =>
      engine.sync(lazy.SYNC_DOCUMENT, lazy.SvalClock.now(), {
        shared: "background",
      })
    )
    .catch(err =>
      SvalLog.warn(
        `sync after changing an agent's workspace failed: ${describeError(err)}`
      )
    );
  // A listener may be async, so a failure is caught as a rejection too.
  for (const listener of changeListeners) {
    Promise.resolve()
      .then(listener)
      .catch(err =>
        SvalLog.warn(`agent change listener failed: ${describeError(err)}`)
      );
  }
}

/**
 * Deletes agent workspace `id` through the document's own delete, as a
 * deletion synced from another device is, so each window closes the tabs it
 * had for it. The last workspace stays, because a window with none has
 * nothing to show.
 *
 * @param {object} engine
 * @param {string} id
 * @returns {Promise<boolean>} Whether it was deleted.
 */
async function deleteAgentWorkspace(engine, id) {
  const ids = lazy.workspaceIds((await engine.tree()).nodes ?? {});
  if (!ids.includes(id) || ids.length < 2) {
    return false;
  }
  await engine.mutate({
    kind: "batch",
    ops: [{ kind: "remove", id }],
    now: lazy.SvalClock.now(),
  });
  publishWorkspaceChange(engine);
  return true;
}

/**
 * Deletes every agent workspace that no session has held for longer than
 * `workspaceRetentionDays`, an unpaired agent's included, except one a
 * session holds now and one the user has taken control of. The agents file is this device's alone, so only the
 * device whose sessions used a workspace ever deletes it.
 *
 * @param {number} now
 * @returns {Promise<string[]>} The workspaces deleted.
 */
async function sweepIdleWorkspaces(now) {
  const days = workspaceRetentionDays();
  const current = open;
  if (!days || !current) {
    return [];
  }
  const before = now - days * DAY_MS;
  const deleted = [];
  const workspaces = [
    ...current.store.agents().flatMap(agent => agent.workspaces),
    ...current.store.keptWorkspaces(),
  ];
  for (const { workspaceId, lastUsed, started } of workspaces) {
    const used = lastUsed ?? started;
    if (
      used === null ||
      used > before ||
      current.holders.has(workspaceId) ||
      lazy.isWorkspaceHeld(workspaceId)
    ) {
      continue;
    }
    if (await deleteAgentWorkspace(config.engine, workspaceId)) {
      await current.store.workspaceDeleted(workspaceId);
      deleted.push(workspaceId);
    }
  }
  if (deleted.length) {
    SvalLog.info(`deleted ${deleted.length} unused agent workspaces`);
  }
  return deleted;
}

/**
 * The workspace a handshake says its `sval-mcp` held, or null for anything
 * that is not a workspace id.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
function workspaceFrom(raw) {
  return typeof raw === "string" && /^[0-9a-f-]{1,64}$/i.test(raw) ? raw : null;
}

/**
 * What a session needs from Sval, bound to the open listener's store and the
 * engine `start` was given.
 *
 * @returns {object}
 */
function sessionDeps() {
  const { engine, askToPair, version } = config;
  const tabs = lazy.createAgentTabs({ engine, gate: open.gate });
  return {
    version,
    store: open.store,
    pairings: open.pairings,
    holders: open.holders,
    askToPair,
    now: () => lazy.SvalClock.now(),
    async createAgentWorkspace(name, label, isolated = false) {
      const id = await engine.mutate({
        kind: "addAgentWorkspace",
        name,
        agentLabel: label,
        id: crypto.randomUUID(),
        now: lazy.SvalClock.now(),
        isolated,
      });
      publishWorkspaceChange(engine);
      return id;
    },
    async renameWorkspace(id, name) {
      await engine.mutate({
        kind: "rename",
        id,
        name,
        now: lazy.SvalClock.now(),
      });
      publishWorkspaceChange(engine);
    },
    async hasWorkspace(id) {
      return lazy.workspaceIds((await engine.tree()).nodes ?? {}).includes(id);
    },
    deleteWorkspace: id => deleteAgentWorkspace(engine, id),
    untilStopped: lazy.untilStopped,
    refuseIfWorkspaceHeld: lazy.refuseIfWorkspaceHeld,
    // The tools' own list, so `list_tabs` leaves out what the tools refuse,
    // and names no page the agent may not read.
    listTabs: agent => tabs.listTabsFor(agent),
    closeWindows: id => tabs.closeWindows(id),
    // Site policy, writes and page dialogs are the listen's.
    tools: lazy.createAgentTools({
      engine,
      store: open.store,
      tabs,
      gate: open.gate,
      sites: open.gate,
      dialogs: open.dialogs,
    }),
    toolDefinitions: lazy.TOOL_DEFINITIONS,
    extraTools: agent =>
      pageToolsVisibleTo(open.store, agent) ? lazy.PAGE_TOOL_DEFINITIONS : [],
  };
}

/**
 * @param {string} name A file in Sval's private directory.
 * @returns {string} Its path.
 */
function agentPath(name) {
  return PathUtils.join(config.profileDir, AGENT_DIR, name);
}

/**
 * Registers the actor that reads agents' pages, once per process. It declares
 * no events, so no page gets one until Sval asks for it in an agent's tab.
 *
 * `remoteTypes` matches by prefix after the `=` suffix is dropped
 * (`JSActorProtocol::RemoteTypePrefixMatches`), so `web` alone would cover
 * every web process; the others are listed so the reader need not know that.
 * The parent process, extensions and privileged pages are not listed, so the
 * actor never exists there and `getActor` refuses them.
 */
function registerPageActor() {
  if (pageActorRegistered) {
    return;
  }
  try {
    ChromeUtils.registerWindowActor(PAGE_ACTOR, {
      parent: {
        esModuleURI:
          "moz-src:///browser/components/sval/SvalAgentPageParent.sys.mjs",
      },
      child: {
        esModuleURI:
          "moz-src:///browser/components/sval/SvalAgentPageChild.sys.mjs",
      },
      remoteTypes: ["web", "webIsolated", "webCOOP+COEP", "file"],
    });
  } catch (err) {
    // Already registered in this process, which is all this needs.
    if (err.name !== "NotSupportedError") {
      throw err;
    }
  }
  pageActorRegistered = true;
}

function unregisterPageActor() {
  if (!pageActorRegistered) {
    return;
  }
  pageActorRegistered = false;
  ChromeUtils.unregisterWindowActor(PAGE_ACTOR);
}

async function listen() {
  if (open) {
    return;
  }
  registerPageActor();
  try {
    await makePrivateDirectory(PathUtils.join(config.profileDir, AGENT_DIR));
  } catch (err) {
    throw withProblem("agent-directory", err);
  }
  let store;
  try {
    store = await SvalAgentStore.open(agentPath(AGENTS_FILE), {
      onChange: () => {
        Services.obs.notifyObservers(null, STATE_TOPIC);
        // An agent's own setting for sites' tools is in its policy.
        toolsMayHaveChanged();
      },
    });
  } catch (err) {
    throw withProblem("agents-file", err);
  }
  // 64 hex characters from 32 random bytes. It goes in the port file and
  // nowhere else: connections hold only the key made from it.
  const token = freshNonce();
  const key = await proofKey(token);
  // Any free port, loopback only, and on Windows no other account's socket
  // can bind it too (agent-control spec §3.6), with the default backlog.
  const server = new ServerSocket(
    -1,
    Ci.nsIServerSocket.LoopbackOnly | Ci.nsIServerSocket.ExclusiveAddress,
    -1
  );
  const connections = new Set();
  let gate = null;
  let dialogs = null;
  try {
    server.asyncListen({
      QueryInterface: ChromeUtils.generateQI(["nsIServerSocketListener"]),
      onSocketAccepted(_server, transport) {
        let unproven = 0;
        for (const each of connections) {
          unproven += each.inSession ? 0 : 1;
        }
        if (unproven >= MAX_UNPROVEN_CONNECTIONS) {
          SvalLog.info("agent connection refused: too many before a handshake");
          transport.close(Cr.NS_ERROR_ABORT);
          return;
        }
        let connection;
        try {
          connection = new Connection(transport, key, c =>
            connections.delete(c)
          );
        } catch (err) {
          SvalLog.warn(
            `agent connection failed to open: ${describeError(err)}`
          );
          transport.close(Cr.NS_ERROR_ABORT);
          return;
        }
        // Registered before it can read, so a close always finds it in the set.
        connections.add(connection);
        connection.begin();
      },
      onStopListening() {},
    });
    // One gate for the listen, so every session's tabs share its watch list
    // and its open alerts, and the page dialogs it answers are in those tabs.
    gate = lazy.createAgentGate({ store });
    dialogs = lazy.createAgentDialogs({ gate });
    open = {
      server,
      connections,
      store,
      // Pairing requests in flight, shared by every session (`SvalAgentSession`).
      pairings: new Map(),
      // The session holding each agent workspace, so two never act in one.
      holders: new Map(),
      gate,
      dialogs,
    };
    // Readable by this OS user only, so only their processes can make the
    // proofs the token keys.
    await writePrivateJSON(agentPath(PORT_FILE), {
      port: server.port,
      token,
    });
  } catch (err) {
    // A listener no port file names cannot be reached, and while `open` is
    // set `listen` does nothing, so switching access on again would not
    // retry.
    open = null;
    server.close();
    dialogs?.close();
    gate?.close();
    for (const connection of [...connections]) {
      connection.close();
    }
    throw err;
  }
  SvalLog.info(`agent access listening on port ${server.port}`);
  // At once, then daily for as long as access stays on.
  const sweep = () =>
    sweepIdleWorkspaces(lazy.SvalClock.now()).catch(err =>
      SvalLog.warn(
        `deleting unused agent workspaces failed: ${SvalLog.errorName(err)}`
      )
    );
  open.sweeper = lazy.setInterval(sweep, DAY_MS);
  sweep();
}

/**
 * Closes the listener, if one is open, and removes the port file either way:
 * a crash can leave one behind with nothing listening, and while access is
 * off no discovery file may exist (spec §7.2).
 */
async function close() {
  unregisterPageActor();
  if (open) {
    const { server, connections, gate, dialogs, sweeper } = open;
    open = null;
    lazy.clearInterval(sweeper);
    server.close();
    dialogs.close();
    gate.close();
    for (const connection of [...connections]) {
      connection.close();
    }
    SvalLog.info("agent access closed");
  }
  await IOUtils.remove(agentPath(PORT_FILE), { ignoreAbsent: true });
}

/**
 * The shutdown blocker: a clean quit removes the port file before the process
 * exits, so the next run never finds a port nobody is listening on. Never
 * rejects, because AsyncShutdown reports a rejected blocker as an error.
 *
 * @returns {Promise<void>}
 */
async function closeBeforeShutdown() {
  // A barrier drops a blocker once it has run, so there is nothing to remove.
  shutdownClient = null;
  try {
    await SvalAgents.stop();
  } catch (err) {
    SvalLog.warn(
      `agent access did not close at shutdown: ${describeError(err)}`
    );
  }
}

function holdShutdown() {
  if (shutdownClient) {
    return;
  }
  try {
    const client = config.shutdownClient ?? IOUtils.profileBeforeChange;
    client.addBlocker(
      "sval: closing agent access and removing its port file",
      closeBeforeShutdown
    );
    shutdownClient = client;
  } catch (err) {
    // The phase has already finished, which only happens when a window opens
    // during shutdown. There is nothing left to hold.
    SvalLog.warn(`could not hold shutdown: ${describeError(err)}`);
  }
}

function releaseShutdown() {
  if (!shutdownClient) {
    return;
  }
  shutdownClient.removeBlocker(closeBeforeShutdown);
  shutdownClient = null;
}

function enabled() {
  return Services.prefs.getBoolPref(PREF, false);
}

/**
 * Opens or closes the listener as the pref says. A listener that cannot open
 * says why through `SvalAgents.problem`, so the Agents settings section can
 * tell the user, who otherwise sees access switched on and nothing working.
 *
 * @returns {Promise<void>}
 */
function settle() {
  transition = transition
    .then(async () => {
      try {
        await (enabled() ? listen() : close());
        setProblem(null);
      } catch (err) {
        SvalLog.error(`agent access failed: ${describeError(err)}`);
        setProblem(enabled() ? (err?.svalAgentsProblem ?? "failed") : null);
      }
    })
    .catch(() => {});
  return transition;
}

/** @param {string|null} next */
function setProblem(next) {
  problem = next;
  Services.obs.notifyObservers(null, STATE_TOPIC);
}

/**
 * Whether `agent` is given sites' tools (site-tools spec §5.1): sites' tools
 * are on, and the agent's own setting is not off.
 *
 * @param {object} store
 * @param {object} agent
 * @returns {boolean}
 */
function pageToolsVisibleTo(store, agent) {
  return (
    Services.prefs.getBoolPref(MODEL_CONTEXT_PREF, false) &&
    lazy.pageToolsSettingOf(store.policyOf(agent.agentId)) !== "off"
  );
}

function toolsMayHaveChanged() {
  for (const connection of open?.connections ?? []) {
    connection.toolsMayHaveChanged?.();
  }
}

/**
 * Gecko's WebMCP switch is on only while agent access and sites' tools are
 * both on (site-tools spec §3.1), so its service refuses calls otherwise.
 */
function syncModelContext() {
  Services.prefs.setBoolPref(
    MODEL_CONTEXT_PREF,
    enabled() && Services.prefs.getBoolPref(PAGE_TOOLS_PREF, false)
  );
}

const prefObserver = {
  QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
  observe: (_subject, _topic, name) => {
    syncModelContext();
    toolsMayHaveChanged();
    if (name === PREF) {
      settle();
    }
  },
};
/**
 * The rules Be polite holds an agent to are said in its tool list, so a
 * change to them, the user's tick or the rate, is a change to its tools.
 */
const politeObserver = {
  QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
  observe: () => toolsMayHaveChanged(),
};
const quitObserver = {
  QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
  observe: () =>
    SvalAgents.stop().catch(err =>
      SvalLog.warn(`agent access did not close at quit: ${describeError(err)}`)
    ),
};

/**
 * Agent access for this process: the listener, opened and closed as
 * `browser.sval.agents.enabled` changes.
 */
export const SvalAgents = {
  PREF,
  PAGE_TOOLS_PREF,
  WORKSPACE_RETENTION_PREF,

  /**
   * Deletes the agent workspaces unused past the setting, as the daily
   * sweep does, at `now`.
   *
   * @param {number} now
   * @returns {Promise<string[]>} The workspaces deleted.
   */
  sweepIdleWorkspaces,
  STATE_TOPIC,

  /**
   * Why agent access is switched on with nothing listening, or null:
   * `"agent-directory"` when Sval's directory cannot be made private,
   * `"agents-file"` when the agents file cannot be read, and `"failed"` for
   * anything else. `STATE_TOPIC` is notified whenever it may have changed.
   *
   * @returns {string|null}
   */
  get problem() {
    return problem;
  },

  /**
   * The open listener's store of paired agents and their policies, or null
   * while agent access is off. A change made through it applies to the
   * agent's live connection at once, because the gate reads the policy for
   * every decision, and `STATE_TOPIC` is told of it.
   *
   * @returns {SvalAgentStore|null}
   */
  get store() {
    return open?.store ?? null;
  },

  /**
   * The open listener's gate, which every session's tabs share, or null
   * while agent access is off. Its readers, such as `agentOf`, answer for
   * every connection's tabs.
   *
   * @returns {object|null} `createAgentGate`'s.
   */
  get gate() {
    return open?.gate ?? null;
  },

  /**
   * The open listener's page dialog handling, in front of every session's
   * tools, or null while agent access is off.
   *
   * @returns {object|null} `createAgentDialogs`'s.
   */
  get dialogs() {
    return open?.dialogs ?? null;
  },

  /**
   * Unpairs an agent and closes its live connections, so it can do nothing
   * more once the user has removed it. Its workspaces stay unless the user
   * deletes them with it; kept, the idle sweep still deletes them in time.
   *
   * @param {string} agentId
   * @param {object} [options]
   * @param {boolean} [options.deleteWorkspaces] Deletes the agent's
   *   workspaces too, all but one when they are every workspace there is.
   * @returns {Promise<boolean>} Whether the agent was paired. False too while
   *   agent access is off, when there is no store open to change.
   */
  async unpair(agentId, { deleteWorkspaces = false } = {}) {
    const current = open;
    const workspaces =
      current?.store
        .agents()
        .find(a => a.agentId === String(agentId))
        ?.workspaces.map(w => w.workspaceId) ?? [];
    if (!current || !(await current.store.unpair(String(agentId)))) {
      return false;
    }
    for (const connection of [...current.connections]) {
      if (connection.agentId === String(agentId)) {
        connection.close();
      }
    }
    if (deleteWorkspaces) {
      for (const workspaceId of workspaces) {
        if (await deleteAgentWorkspace(config.engine, workspaceId)) {
          await current.store.workspaceDeleted(workspaceId);
        }
      }
    }
    return true;
  },

  /**
   * Starts following the pref. Every window calls this; the first call acts
   * and later ones wait for the listener to settle.
   *
   * @param {object} options
   * @param {string} options.profileDir Where the port and agents files live.
   * @param {{mutate: Function, tree: Function}} options.engine The engine
   *   agents' workspaces are created in and read from.
   * @param {(label: string, facts: string[], isolated: boolean) =>
   *   Promise<{action: string, isolated?: boolean}>} options.askToPair Asks
   *   the user whether to pair an agent, and in which kind of workspace.
   * @param {string} options.version What Sval reports as its version to MCP.
   * @param {object} [options.shutdownClient] Where the shutdown blocker is
   *   registered: an `nsIAsyncShutdownClient`, which a test supplies from its
   *   own barrier. Defaults to `IOUtils.profileBeforeChange`.
   * @param {number} [options.hello] The handshake version Sval speaks, which a
   *   test raises to reach a shim older than Sval. Defaults to `HELLO`.
   * @returns {Promise<void>}
   */
  async start(options) {
    if (config) {
      return transition;
    }
    config = options;
    markProfile();
    // AI apps start their shim whether or not access is on, so the shim they
    // are given is kept current from every start.
    lazy.SvalAgentClients.startup().catch(err =>
      SvalLog.warn(
        `updating AI apps' sval entries failed: ${SvalLog.errorName(err)}`
      )
    );
    Services.prefs.addObserver(PREF, prefObserver);
    Services.prefs.addObserver(PAGE_TOOLS_PREF, prefObserver);
    Services.obs.addObserver(quitObserver, "quit-application");
    Services.prefs.addObserver(POLITE_RATE_PREF, politeObserver);
    Services.obs.addObserver(politeObserver, POLITE_TOPIC);
    syncModelContext();
    holdShutdown();
    return settle();
  },

  /**
   * Closes the listener and forgets `start`, so tests can start again.
   *
   * @returns {Promise<void>}
   */
  stop() {
    if (!config) {
      return Promise.resolve();
    }
    // Quit and a test's cleanup can both call this; the second call waits
    // for the first rather than removing the observers twice.
    stopping ??= (async () => {
      Services.prefs.removeObserver(PREF, prefObserver);
      Services.prefs.removeObserver(PAGE_TOOLS_PREF, prefObserver);
      Services.obs.removeObserver(quitObserver, "quit-application");
      Services.prefs.removeObserver(POLITE_RATE_PREF, politeObserver);
      Services.obs.removeObserver(politeObserver, POLITE_TOPIC);
      try {
        await transition;
        await close();
      } finally {
        // quit-application runs this long before profile-before-change and
        // does not wait for it, so the blocker has to outlive `close`: it is
        // what holds the process until the port file is gone. A failing
        // `close` still lets it go, so it cannot hang shutdown.
        releaseShutdown();
        config = null;
        stopping = null;
      }
    })();
    return stopping;
  },

  /**
   * Registers the page actor without opening the listener, for tests that
   * drive an agent's page directly. Safe to call again.
   */
  registerPageActorForTests() {
    registerPageActor();
  },

  /** @returns {number|null} The listening port, or null while closed. */
  get port() {
    return open?.server.port ?? null;
  },

  /**
   * Called after Sval adds or renames an agent's workspace, so panels redraw.
   *
   * @param {() => void} fn
   * @returns {() => void} Removes the listener.
   */
  addChangeListener(fn) {
    changeListeners.add(fn);
    return () => changeListeners.delete(fn);
  },
};
