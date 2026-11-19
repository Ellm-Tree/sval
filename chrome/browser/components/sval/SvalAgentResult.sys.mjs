/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * What a tool call comes to, and its one translation to MCP.
 *
 * A tool answers with a value made here, which every stage after it reads
 * and adds to as an object: Be polite's wait, a page dialog, what became of
 * the writes an input set off. `toMcp` writes the value out once, as the
 * reply leaves the session.
 *
 * @typedef {{body: object, failed?: boolean}|{text: string}|{image: string}}
 *   ToolResult
 */

import { ERRORS } from "moz-src:///browser/components/sval/SvalAgentErrors.sys.mjs";

/**
 * @param {object} body
 * @returns {ToolResult} A call that worked, answering `body` as JSON.
 */
export const json = body => ({ body });

/**
 * @param {string} words
 * @returns {ToolResult} A call that worked, answering a sentence.
 */
export const text = words => ({ text: words });

/**
 * @param {string} data A PNG, as base64.
 * @returns {ToolResult}
 */
export const image = data => ({ image: data });

/**
 * A failed call's result. Every failure has this one shape: `error` (the
 * code), `message` (which starts with the code, so a reader that only shows
 * text still sees it) and whatever else the failure says.
 *
 * @param {string} code One of `ERRORS`' codes.
 * @param {string} [message] The code's own sentence when none is given.
 * @param {object} [extra] More fields, each one the agent may see.
 * @returns {ToolResult}
 */
export function refusal(code, message = ERRORS[code], extra = {}) {
  return {
    body: { ...extra, error: code, message: `${code}: ${message}` },
    failed: true,
  };
}

/**
 * @param {ToolError} err
 * @param {object} [extra] Fields the error's own details add to.
 * @returns {ToolResult} The result a call that threw `err` answers with.
 */
export const refusalOf = (err, extra = {}) =>
  refusal(err.code, err.message, { ...extra, ...err.details });

/**
 * @param {ToolResult} result
 * @returns {string|undefined} The code a failed result carries.
 */
export const codeOf = result => (result.failed ? result.body.error : undefined);

/**
 * @param {ToolResult} result
 * @param {object} fields
 * @returns {ToolResult} `result` with `fields` in its JSON. A sentence or an
 *   image has nowhere to carry them and is answered as it is.
 */
export const withFields = (result, fields) =>
  result.body ? { ...result, body: { ...result.body, ...fields } } : result;

/**
 * @param {ToolResult} result
 * @returns {object} The MCP tool result that carries it.
 */
export function toMcp(result) {
  if (result.image !== undefined) {
    return {
      content: [{ type: "image", data: result.image, mimeType: "image/png" }],
    };
  }
  if (result.text !== undefined) {
    return { content: [{ type: "text", text: result.text }] };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result.body) }],
    ...(result.failed && { isError: true }),
  };
}
