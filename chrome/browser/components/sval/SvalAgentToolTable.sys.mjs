/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Every tool an agent may call (agent-control spec §3, §4), in the order
 * `tools/list` gives them.
 *
 * A tool is one object, and everything Sval knows of the tool is in it:
 * what a client is told (`definitionOf`), when the tool is offered, what
 * its page must be, whether Be polite spaces it out, what the window's
 * overlay says while it runs, and what it does. `SvalAgentToolRunner` reads
 * the rest of these and runs the tool. A new tool is a new object here.
 *
 * @typedef {object} Tool
 * @property {string} name What an agent calls it by.
 * @property {string} title What a client shows a person.
 * @property {string} description What it does, for the agent's model.
 * @property {object} inputSchema The JSON Schema `validateArgs` checks the
 *   call's arguments against.
 * @property {object} annotations MCP's hints to a client.
 * @property {"unpaired"|"siteTools"} [when] When the tool is offered: to
 *   every paired agent unless this says otherwise. `"unpaired"` is an agent
 *   not paired yet, and a paired one may still call such a tool.
 *   `"siteTools"` is an agent given sites' tools (site-tools spec §5.1).
 * @property {boolean} [unhoused] The tool runs for a session with no
 *   workspace. Every other tool is refused until the session has one.
 * @property {(agent: object) => string} [alsoSays] A sentence the
 *   description ends with that depends on the agent's settings.
 * @property {PageNeeds|null} page What the page in `arguments.tab` must be
 *   before the tool runs (`SvalAgentToolCall`). Null is a tool with no tab,
 *   or one that looks its tab up itself and says why.
 * @property {(args: object) => void} [check] Throws for arguments the
 *   schema cannot refuse, before anything is asked of a tab. A call refused
 *   here has still taken its turn on the site.
 * @property {(args: object, found: object|null) => string|null} [actsOn]
 *   The site the call is about to act on, which makes the tool one Be
 *   polite spaces out per site (`SvalAgentPolite`). Reads, and closing a
 *   tab, have none and are never held back.
 * @property {string} [activity] What the window's overlay says the agent
 *   is doing while the tool is in a tab.
 * @property {boolean} [namesWhereItGoes] The tool reports its activity
 *   itself, with the site it goes to (`ToolCall.report`).
 * @property {(call: ToolCall, args: object) => Promise<ToolResult>} run
 *   What it does, in a tab entered as `page` says.
 */

import {
  closeTab,
  navigateTab,
  openTab,
} from "moz-src:///browser/components/sval/SvalAgentToolsTabs.sys.mjs";
import {
  getConsoleMessages,
  getPageSource,
  getPageText,
  getScreenshot,
  getSnapshot,
  listDownloads,
  waitForText,
} from "moz-src:///browser/components/sval/SvalAgentToolsRead.sys.mjs";
import {
  answerDialog,
  clickElement,
  fillForm,
  pressKeys,
  scrollPage,
  selectOption,
  typeText,
  uploadFile,
} from "moz-src:///browser/components/sval/SvalAgentToolsInput.sys.mjs";
import {
  callPageTool,
  listPageTools,
} from "moz-src:///browser/components/sval/SvalAgentToolsSite.sys.mjs";
import {
  closeWindow,
  deleteWorkspace,
  listTabs,
  requestIsolatedPairing,
  requestSharedPairing,
  setTask,
  useWorkspace,
} from "moz-src:///browser/components/sval/SvalAgentToolsWorkspace.sys.mjs";

/**
 * The tools of the session itself: an agent's pairing and its workspace.
 *
 * @type {ReadonlyArray<Tool>}
 */
export const SESSION_TOOLS = Object.freeze([
  requestIsolatedPairing,
  requestSharedPairing,
  listTabs,
  setTask,
  useWorkspace,
  closeWindow,
  deleteWorkspace,
]);

/** @type {ReadonlyArray<Tool>} */
export const TOOLS = Object.freeze([
  ...SESSION_TOOLS,
  openTab,
  closeTab,
  navigateTab,
  getSnapshot,
  getScreenshot,
  getPageSource,
  getPageText,
  clickElement,
  typeText,
  fillForm,
  selectOption,
  pressKeys,
  scrollPage,
  waitForText,
  answerDialog,
  uploadFile,
  getConsoleMessages,
  listDownloads,
  listPageTools,
  callPageTool,
]);

/**
 * @param {Tool} tool
 * @param {object|null} agent The agent told, null while it is not paired.
 * @returns {object} What `tools/list` says of it.
 */
export const definitionOf = (
  { name, title, description, inputSchema, annotations, alsoSays },
  agent
) => ({
  name,
  title,
  description:
    alsoSays && agent ? `${description} ${alsoSays(agent)}` : description,
  inputSchema,
  annotations,
});
