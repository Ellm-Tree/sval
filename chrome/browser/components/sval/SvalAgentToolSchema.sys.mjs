/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * What the definitions of an agent's tools share: the arguments most of
 * them take, and what a tool tells a client of itself (MCP's annotations).
 *
 * A description says what its tool does, in a sentence or two. What to do
 * about a failure is in the error's message, which the agent reads when it
 * happens.
 */

/** The most characters an id an agent names may have. */
export const MAX_ID = 128;

export const READ_ONLY = { readOnlyHint: true };

/**
 * Input into a page, which can do anything the page lets a person do: place
 * an order, send a message, accept a "Delete?". MCP's default for a tool that
 * is not read-only is `destructiveHint: true`, and clients use it to decide
 * whether to confirm.
 */
export const ACTS = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
};

/** Loading or scrolling, which changes what a tab shows and nothing else. */
export const MOVES = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
};

export const TAB = {
  type: "string",
  maxLength: MAX_ID,
  description: "A tab id from open_tab or list_tabs.",
};

export const REF = {
  type: "string",
  maxLength: MAX_ID,
  description: "An element ref, like e12, from the latest get_snapshot.",
};

/**
 * The one result that needs a rule up front: a write the user has yet to
 * answer, which the agent must not repeat.
 */
export const WRITES =
  "If writes is awaiting_approval, Sval is asking the user: don't repeat the action.";

/**
 * @param {object} properties
 * @param {string[]} required
 * @returns {object} A JSON Schema for an object with exactly `properties`.
 */
export const input = (properties, required) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
