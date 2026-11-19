/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The tools for an agent's pairing and its workspace (agent-control spec
 * §3, §4). Each is a row of `SvalAgentToolTable`.
 *
 * What each does is the session's: a connection's pairing and the
 * workspace it holds are `SvalAgentSession`'s state, which lends a call the
 * operations these rows name (`call.session`).
 */

import { politeRules } from "moz-src:///browser/components/sval/SvalAgentPolite.sys.mjs";

/** The most characters of the task an agent states that Sval keeps. */
export const MAX_TASK_CHARS = 48;
/** The most characters of the model an agent states that Sval keeps. */
export const MAX_MODEL_CHARS = 32;

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
 * @param {boolean} isolated Whether it asks for an isolated workspace.
 * @returns {object}
 */
const pairingTool = (name, title, kind, isolated) => ({
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
  when: "unpaired",
  unhoused: true,
  page: null,
  run: (call, args) => call.session.requestPairing(args, isolated, call.task),
});

export const requestIsolatedPairing = pairingTool(
  "request_isolated_pairing",
  "Pair with Sval, isolated",
  "Ask the user to pair this agent with Sval in an isolated workspace: one with its own cookies, so sites there see none of the user's sign-ins, and you sign in yourself where a task needs it.",
  true
);

export const requestSharedPairing = pairingTool(
  "request_shared_pairing",
  "Pair with Sval, shared",
  "Ask the user to pair this agent with Sval in a shared workspace: sites there see the accounts the user is signed in to elsewhere in Sval.",
  false
);

export const listTabs = {
  name: "list_tabs",
  title: "List tabs",
  description:
    "List the tabs in your workspace, each with its tab id, title and URL. user_in_control: true means the user has taken over your workspace. human_verification: true means a tab is waiting for the user to complete a check.",
  inputSchema: EMPTY_INPUT,
  annotations: { readOnlyHint: true },
  page: null,
  alsoSays: agent => politeSentence(politeRules(agent.agentId)),
  run: call => call.session.listTabs(),
};

export const setTask = {
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
  page: null,
  unhoused: true,
  run: (call, args) => call.session.setTask(args),
};

export const useWorkspace = {
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
  page: null,
  unhoused: true,
  run: (call, { workspace }) => call.session.useWorkspace(workspace),
};

export const closeWindow = {
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
  page: null,
  run: call => call.session.closeWindow(),
};

export const deleteWorkspace = {
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
  page: null,
  run: call => call.session.deleteWorkspace(),
};
