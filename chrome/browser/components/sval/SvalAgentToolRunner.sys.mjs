/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Runs an agent's tool calls: the one path every call of a tool in
 * `SvalAgentToolTable` takes, from its name to its result.
 *
 * In order: the tool is one the agent may call, paired or not; the session
 * has a workspace, unless the tool runs without one; the arguments match
 * the tool's schema (`validateArgs`); Be polite gives the call its turn on
 * the site it acts on; the arguments pass the tool's own `check`; the tab
 * is entered as the tool's `page` says; the tool runs; and whatever it
 * threw as a `ToolError` becomes the failed result the agent reads.
 *
 * A runner given the listen's parts runs every tool. Each of `gate`,
 * `sites` and `dialogs` is then required, so a caller that forgets one
 * fails at once instead of leaving that check out. A runner given none
 * runs the session's own tools alone, which need no browser.
 */

import { validateArgs } from "moz-src:///browser/components/sval/SvalAgentArgs.sys.mjs";
import { ToolError } from "moz-src:///browser/components/sval/SvalAgentErrors.sys.mjs";
import {
  refusal,
  refusalOf,
  withFields,
} from "moz-src:///browser/components/sval/SvalAgentResult.sys.mjs";
import {
  limiterFor,
  isPolite,
  MAX_QUEUED,
  politeRate,
  RateLimited,
} from "moz-src:///browser/components/sval/SvalAgentPolite.sys.mjs";
import { ToolCall } from "moz-src:///browser/components/sval/SvalAgentToolCall.sys.mjs";
import {
  definitionOf,
  SESSION_TOOLS,
  TOOLS,
} from "moz-src:///browser/components/sval/SvalAgentToolTable.sys.mjs";
import { MAX_UPLOAD_BYTES } from "moz-src:///browser/components/sval/SvalAgentUploads.sys.mjs";

/**
 * @param {object} gate
 * @param {object} sites
 * @param {object} dialogs
 * @returns {boolean} Whether the three are what the tools in tabs call.
 */
const complete = (gate, sites, dialogs) =>
  typeof gate?.act === "function" &&
  typeof sites?.allowLoad === "function" &&
  typeof sites?.checkPage === "function" &&
  typeof sites?.checkSite === "function" &&
  typeof sites?.allowUpload === "function" &&
  typeof sites?.uploadAllowed === "function" &&
  typeof sites?.listDownloads === "function" &&
  typeof sites?.allowConsole === "function" &&
  typeof sites?.consoleAllowed === "function" &&
  typeof sites?.allowPageTools === "function" &&
  typeof sites?.pageToolsAllowed === "function" &&
  typeof sites?.decidePageToolCall === "function" &&
  typeof sites?.allowPageToolCall === "function" &&
  typeof sites?.guardWrites === "function" &&
  typeof dialogs?.takeReport === "function" &&
  typeof dialogs?.openDialog === "function" &&
  typeof dialogs?.waitForOpen === "function" &&
  typeof dialogs?.answer === "function";

/**
 * @param {object} [parts] The listen's parts. With none, the runner has
 *   the session's own tools alone.
 * @param {object} parts.tabs `createAgentTabs`'s functions.
 * @param {{act: Function}} parts.gate
 * @param {object} parts.sites
 * @param {object} parts.dialogs
 * @param {(agent: object) => boolean} parts.siteToolsVisibleTo Whether the
 *   agent is given sites' tools as things stand.
 * @param {number} [parts.maxUploadBytes] The most one upload sends.
 * @returns {{
 *   definitions: (agent: object|null) => object[],
 *   call: (session: object, name: string, rawArgs: unknown, task: object) =>
 *     Promise<object>,
 * }}
 */
export function createToolRunner(parts = null) {
  if (parts && !complete(parts.gate, parts.sites, parts.dialogs)) {
    throw new TypeError("createToolRunner needs a gate, sites and dialogs");
  }
  const tools = parts ? TOOLS : SESSION_TOOLS;
  const { tabs, siteToolsVisibleTo } = parts ?? {};
  const lent = {
    tabs,
    gate: parts?.gate,
    sites: parts?.sites,
    dialogs: parts?.dialogs,
    maxUploadBytes: parts?.maxUploadBytes ?? MAX_UPLOAD_BYTES,
  };

  /**
   * @param {object|null} agent Null is an agent not paired yet.
   * @returns {object[]} The tools the agent is offered as things stand.
   */
  const offeredTo = agent =>
    tools.filter(tool => {
      if (!agent) {
        return tool.when === "unpaired";
      }
      return (
        tool.when !== "unpaired" &&
        (tool.when !== "siteTools" || siteToolsVisibleTo(agent))
      );
    });

  /**
   * The site the call is about to act on: the page it loads, or the page
   * its tab shows. Null when there is none to name, as for a blank tab or
   * a call that will fail as it runs, which then says why.
   *
   * The tab is looked up as it is, and never loaded here: a tab session
   * restore left unloaded loads only once its turn comes. The call keeps
   * the tab found, to look it up once (`ToolCall.foundEarlier`).
   *
   * @param {ToolCall} call
   * @param {object} args
   * @returns {Promise<string|null>}
   */
  async function siteActedOn(call, args) {
    try {
      let found = null;
      if (args.tab !== undefined) {
        found = await tabs.find(call.agent.workspaceId, args.tab);
        call.foundEarlier = { tab: args.tab, found };
      }
      return call.tool.actsOn(args, found);
    } catch {
      return null;
    }
  }

  /**
   * Holds an acting tool until its site may be acted on again, when the
   * user has Be polite ticked for the agent.
   *
   * While it waits its turn, the agent's next requests go ahead, so a read
   * or an action on another site is not held behind it.
   *
   * @param {ToolCall} call
   * @param {object} args
   * @returns {Promise<number>} The milliseconds waited.
   */
  async function beingPolite(call, args) {
    const { agent, task, tool } = call;
    if (!tool.actsOn || !isPolite(agent.agentId)) {
      return 0;
    }
    const site = await siteActedOn(call, args);
    if (!site) {
      return 0;
    }
    try {
      return await limiterFor(agent.agentId).wait(site, politeRate(), () => {
        call.foundEarlier = null;
        task?.wait?.standAside?.();
      });
    } catch (err) {
      if (!(err instanceof RateLimited)) {
        throw err;
      }
      throw new ToolError(
        "rate_limited",
        `Be polite: ${MAX_QUEUED} actions are already waiting their turn on this site, at most ${politeRate()} a second. Nothing was done. Wait retry_after_ms, then try again, and pace your actions on this site.`,
        { retry_after_ms: err.retryAfterMs }
      );
    }
  }

  /**
   * @param {object} tool
   * @param {object} session
   * @param {object} args Checked arguments.
   * @param {object} [task] The call's task, whose `wait` is the call's own.
   * @returns {Promise<object>} The tool's result. A result says how long Be
   *   polite held the call when it did, a failed one included.
   */
  async function run(tool, session, args, task) {
    const call = new ToolCall(lent, tool, session, task);
    const throttledMs = await beingPolite(call, args);
    // An action the agent cancelled while it waited its turn is not taken;
    // the session sends no reply to a cancelled call.
    if (task?.wait?.cancelled) {
      throw new ToolError("cancelled");
    }
    try {
      tool.check?.(args);
      if (tool.page) {
        await call.enter(args.tab, tool.page);
      }
      const result = await tool.run(call, args);
      return throttledMs
        ? withFields(result, { throttled_ms: throttledMs })
        : result;
    } catch (err) {
      if (throttledMs && err instanceof ToolError) {
        err.details = { ...err.details, throttled_ms: throttledMs };
      }
      throw err;
    }
  }

  return {
    definitions: agent =>
      offeredTo(agent).map(tool => definitionOf(tool, agent)),

    async call(session, name, rawArgs, task) {
      const { agent } = session;
      // A pairing tool called once paired names the session's task, so a
      // new session of a paired agent says what it is doing the way an
      // unpaired one would.
      const tool =
        offeredTo(agent).find(t => t.name === name) ??
        (agent && tools.find(t => t.name === name && t.when === "unpaired"));
      if (!tool) {
        return agent
          ? refusal("unknown_tool")
          : refusal(
              "not_paired",
              "This agent is not paired with Sval. Call request_isolated_pairing or request_shared_pairing first."
            );
      }
      if (agent && !tool.unhoused) {
        const housed = await session.ensureHoused();
        if (housed !== true) {
          return housed;
        }
      }
      let args;
      try {
        args = validateArgs(tool.inputSchema, rawArgs);
        return await run(tool, session, args, task);
      } catch (err) {
        if (!(err instanceof ToolError)) {
          throw err;
        }
        // The tab is named only once the arguments are checked: an
        // unchecked one is whatever the agent sent.
        return refusalOf(
          err,
          typeof args?.tab === "string" ? { tab: args.tab } : {}
        );
      }
    },
  };
}
