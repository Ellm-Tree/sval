/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The tools a page offers agents through WebMCP (site-tools spec), read and
 * called through Gecko's `nsIModelContextService`. Everything a page supplies
 * is untrusted: names, descriptions, schemas, results and errors are cleaned
 * and capped here before an agent sees them (§5.3).
 *
 * This module is the only caller of the service. The decision of whether a
 * call runs, asks or is refused is `decideCall`, from the permission layers of
 * §4.1 and the site's level.
 */

import { printable } from "moz-src:///browser/components/sval/SvalAgentArgs.sys.mjs";
import { ToolError } from "moz-src:///browser/components/sval/SvalAgentErrors.sys.mjs";
import { sha256Hex } from "moz-src:///browser/components/sval/SvalBytes.sys.mjs";
import {
  raceTimeout,
  TIMED_OUT,
} from "moz-src:///browser/components/sval/SvalTimeout.sys.mjs";

/** How long a call may run before it fails with `page_tool_timeout`. */
export const CALL_TIMEOUT_MS = 60_000;

/** The caps on what a page supplies (§5.3). */
export const MAX_NAME_CHARS = 64;
export const MAX_DESCRIPTION_CHARS = 2048;
export const MAX_SCHEMA_BYTES = 16 * 1024;
export const MAX_RESULT_BYTES = 256 * 1024;

/**
 * @param {unknown} text
 * @param {number} max The most characters kept.
 * @returns {string} `text` printable, and cut at a whole character.
 */
export function clean(text, max) {
  return [...printable(text ?? "")].slice(0, max).join("");
}

/**
 * @param {unknown} value
 * @returns {number} The UTF-8 size of `value` as JSON.
 */
function jsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * One tool as an agent sees it.
 *
 * @param {object} tool A `ModelContextToolDefinition` from the service.
 * @returns {{name: string, description: string, input_schema: ?object, read_only: boolean}}
 */
function shown(tool) {
  let schema = tool.inputSchema ?? null;
  let description = clean(tool.description, MAX_DESCRIPTION_CHARS);
  if (schema !== null && jsonBytes(schema) > MAX_SCHEMA_BYTES) {
    schema = null;
    description = `${description} (Its input schema was too large to show.)`;
  }
  return {
    name: clean(tool.name, MAX_NAME_CHARS),
    description,
    input_schema: schema,
    read_only: tool.annotations?.readOnlyHint === true,
  };
}

/**
 * The tools the document `innerWindowId` offers, as the page registered
 * them. A tool whose cleaned name is empty, or repeats an earlier one, is
 * left out, because an agent could not name it apart.
 *
 * @param {number} innerWindowId
 * @returns {Promise<Array<{name: string, description: string, input_schema: ?object, read_only: boolean, raw: object}>>}
 */
export async function toolsOf(innerWindowId) {
  let tools;
  try {
    tools = await Services.modelContext.getToolsForWindow(innerWindowId);
  } catch (err) {
    throw new ToolError(
      "page_changed",
      "The page changed while its tools were read. Call list_page_tools again."
    );
  }
  const seen = new Set();
  const out = [];
  for (const tool of tools ?? []) {
    const one = shown(tool);
    if (!one.name || seen.has(one.name)) {
      continue;
    }
    seen.add(one.name);
    out.push({ ...one, raw: tool });
  }
  return out;
}

/**
 * The SHA-256, as hex, of what "Always allow this tool" was answered about:
 * the tool's name, description, input schema and hint (§4.3). A change to
 * any of them asks again.
 *
 * @param {{name: string, description: string, input_schema: ?object, read_only: boolean}} tool
 * @returns {Promise<string>}
 */
export async function definitionHash(tool) {
  const canonical = value => {
    if (Array.isArray(value)) {
      return value.map(canonical);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map(key => [key, canonical(value[key])])
      );
    }
    return value;
  };
  const text = JSON.stringify(
    canonical({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
      read_only: tool.read_only,
    })
  );
  return sha256Hex(text);
}

/**
 * `promise`, or `page_tool_timeout` once `timeoutMs` has passed.
 *
 * @param {Promise} promise
 * @param {number} [timeoutMs]
 * @returns {Promise}
 */
export async function withinTimeout(promise, timeoutMs = CALL_TIMEOUT_MS) {
  const result = await raceTimeout(promise, timeoutMs);
  if (result === TIMED_OUT) {
    throw new ToolError(
      "page_tool_timeout",
      `The page's tool did not answer within ${timeoutMs / 1000} seconds. It may still be working: check the page before calling it again.`
    );
  }
  return result;
}

/**
 * A call the page dropped unanswered. Gecko rejects the call with an
 * `AbortError` when the page's side lets go of it without an answer
 * (`ModelContextService::InvokeTool`), as it does once the cycle collector
 * frees the promise of a tool that never settles
 * (`WindowGlobalChild::RecvInvokeModelContextTool`). What the tool started,
 * such as a timer, can still be running then.
 */
export class UnansweredPageToolCall extends ToolError {}

/**
 * Calls `name` in the document `innerWindowId` with `input`, and gives back
 * its result as JSON data. It has no timeout of its own: a call can wait on
 * the user's answer about its writes (`withinTimeout`).
 *
 * @param {number} innerWindowId
 * @param {string} name The tool's name as the page registered it.
 * @param {object} input
 * @returns {Promise<unknown>} The result.
 */
export async function invoke(innerWindowId, name, input) {
  let result;
  try {
    result = await Services.modelContext.invokeTool(innerWindowId, name, input);
  } catch (err) {
    const why = clean(err?.message ?? String(err), MAX_DESCRIPTION_CHARS);
    const Failure =
      err?.name === "AbortError" ? UnansweredPageToolCall : ToolError;
    throw new Failure(
      "page_tool_failed",
      `The page's tool failed${why ? `: ${why}` : "."}`
    );
  }
  let data;
  try {
    data = result === undefined ? null : JSON.parse(JSON.stringify(result));
  } catch {
    throw new ToolError(
      "page_tool_bad_result",
      "The page's tool answered with something that is not JSON data."
    );
  }
  if (jsonBytes(data) > MAX_RESULT_BYTES) {
    throw new ToolError(
      "page_tool_result_too_large",
      `The page's tool answered with more than ${MAX_RESULT_BYTES / 1024} KiB.`
    );
  }
  return data;
}

/**
 * What a call does (§4.3), once layers A, B and C let the agent see the
 * site's tools.
 *
 * - `refused`: refused without asking, `refused_read_only`.
 * - `ask`: the call alert, with or without "Always allow".
 * - `run`: runs, and the write gate judges its writes by the site's level.
 * - `run_allowed`: runs, and its writes pass (a matching grant).
 *
 * @param {object} options
 * @param {"ask"|"on"} options.setting Layer B.
 * @param {string} options.level The site's level.
 * @param {boolean} options.hinted Whether the tool claims `readOnlyHint`.
 * @param {boolean} options.granted Whether a grant matches the tool.
 * @returns {{action: "refused"|"ask"|"run"|"run_allowed", always?: boolean}}
 */
export function decideCall({ setting, level, hinted, granted }) {
  if (level === "read-only" && !hinted) {
    return { action: "refused" };
  }
  if (setting !== "on") {
    return { action: "ask", always: false };
  }
  if (hinted || level === "full") {
    return { action: "run" };
  }
  if (level === "ask-before-writes") {
    return granted
      ? { action: "run_allowed" }
      : { action: "ask", always: true };
  }
  // A level Sval does not know asks, as no decision never grants more than
  // asking does (agent-control spec §5.2).
  return { action: "ask", always: false };
}
