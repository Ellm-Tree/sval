/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Every code a failed tool call can carry, and the error that carries one.
 *
 * An agent's model reads a code to decide what to do next, so the set is
 * part of what Sval promises an agent: a code exists once it is listed in
 * `ERRORS`, and `ToolError` takes no other.
 */

/**
 * Each code with the sentence an agent reads for it, where the sentence is
 * the same wherever the code is raised. Null is a code whose sentence names
 * what was refused, which only the code raising it knows.
 *
 * @type {Readonly<{[code: string]: string|null}>}
 */
export const ERRORS = Object.freeze({
  // The call itself.
  invalid_arguments: null,
  unknown_tool: "Sval has no tool by that name.",
  cancelled: "The agent cancelled the call.",
  rate_limited: null,
  result_too_large:
    "The result was too large to send. Ask for less of the page.",
  internal_error: null,
  disconnected: null,

  // The agent's pairing and its workspace.
  not_paired: null,
  pairing_denied: null,
  no_workspace:
    "This session has no workspace in Sval. Call set_task with what you are doing to make one, or use_workspace with the id of the workspace you used before.",
  workspace_in_use:
    "Another session holds that workspace now. Call set_task to make a workspace of your own.",
  not_found: null,
  not_deleted: null,
  no_window: null,
  not_controlled: null,

  // What the user decides.
  awaiting_approval: null,
  policy_denied: null,
  console_denied: null,
  page_tools_off:
    "The user has not let sites offer tools to agents. They can turn it on in Sval's Agents settings.",
  user_in_control:
    "The user has taken control of your workspace, and you cannot act in it until they give it back. Wait until list_tabs no longer shows user_in_control.",
  stopped_by_user:
    "Stopped by the user. They pressed Stop in Sval, and every call you make fails until they press Resume. Tell the user you have stopped, and wait for them.",
  human_verification_required: null,

  // A load.
  unsupported_url: null,
  no_history: null,
  navigation_failed: null,
  dns_failure: null,
  connection_refused: null,
  timeout: null,
  tls_error: null,

  // The page.
  no_document: "The tab has no page yet.",
  page_changed:
    "The page changed while Sval was reading it. Take a new snapshot.",
  page_failed: "Sval could not read the page.",
  page_unresponsive: "The page did not respond. Take a new snapshot.",
  frame_not_readable:
    "The page holds a frame from a site you may not read, in a way Sval cannot leave out of a screenshot. Use get_snapshot instead.",
  screenshot_failed: null,
  screenshot_too_large: null,

  // An element.
  stale_ref: "That ref is from an older snapshot or page. Take a new snapshot.",
  not_visible:
    "That element takes up no space on the page, so it cannot be clicked. Take a new snapshot.",
  click_intercepted:
    "Something else covers that element where it would be clicked. Take a new snapshot.",
  not_clickable:
    "That element holds another page, so Sval does not click into it. Take a new snapshot.",
  not_editable: "That element cannot be typed into or changed.",
  not_focusable:
    "That field cannot take the keyboard focus, or the page moved focus away from it, so nothing more was typed. Take a new snapshot.",
  not_a_select: "That element is not a list of options.",
  one_option: "That list takes one option at a time.",
  no_such_option: "That list has no option with that value or label.",
  unknown_key:
    "Each key must be one character or one of Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown or Space.",

  // A page's dialog.
  dialog_open:
    "A dialog is open in that tab and the page waits for it. Answer it with answer_dialog first.",
  no_dialog: "No confirm or prompt dialog is open in that tab.",

  // A file.
  not_file_input: "That element is not a file input.",
  bad_file:
    "That input takes one file at a time, or a file could not be read. Check the paths and try again.",
  file_too_large: null,

  // A site's own tools.
  unknown_page_tool:
    "The page has no tool by that name now. Call list_page_tools again.",
  page_tool_running: null,
  page_tool_failed: null,
  page_tool_timeout: null,
  page_tool_bad_result: null,
  page_tool_result_too_large: null,
});

/**
 * A tool failure, which the agent sees as JSON carrying `error: code` and
 * `message` (`SvalAgentResult`'s `refusal`).
 */
export class ToolError extends Error {
  /**
   * @param {string} code One of `ERRORS`' codes.
   * @param {string} [message] A sentence for the agent: the code's own when
   *   it has one and none is given.
   * @param {object} [details] More fields for the result, each one the
   *   agent may see.
   */
  constructor(code, message = undefined, details = undefined) {
    if (!Object.hasOwn(ERRORS, code)) {
      throw new TypeError(`no agent error code "${code}"`);
    }
    super(message ?? ERRORS[code] ?? "");
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }
}
