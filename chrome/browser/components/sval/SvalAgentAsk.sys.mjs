/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * How a gate asks the user, and how a call waits for the answer
 * (`SvalAgentGate`, `SvalAgentWrites`): one alert per question in flight,
 * whoever else asks it meanwhile, and one shape of waiting for it.
 */

import { MAX_WAITING_CALLS } from "moz-src:///browser/components/sval/SvalAgentAlerts.sys.mjs";
import { ToolError } from "moz-src:///browser/components/sval/SvalAgentArgs.sys.mjs";
import { scopeOfHost } from "moz-src:///browser/components/sval/SvalSite.sys.mjs";

export const CHOICES = Object.freeze([
  Object.freeze({ id: "allow", label: "Allow" }),
  Object.freeze({ id: "deny", label: "Deny" }),
]);

/**
 * The "Remember for" menu of an alert whose answer is saved for `host`
 * (host-scoped rules spec §4): the host, picked to begin with, and its whole
 * site. A host that offers no choice (`scopeOfHost`) has no menu, and its
 * answer is saved for it.
 *
 * @param {string} host A host as `hostOf` names it.
 * @returns {{value: string, choices: Array<{id: string, label: string, sub: string}>}|undefined}
 *   `ask`'s `scope`.
 */
export function scopeMenuOf(host) {
  const scope = scopeOfHost(host);
  if (!scope?.choice) {
    return undefined;
  }
  return {
    value: scope.host,
    choices: [
      { id: scope.host, label: scope.host, sub: `Only on ${scope.host}` },
      {
        id: scope.site,
        label: `All of ${scope.site}`,
        sub: `Everywhere on ${scope.site}`,
      },
    ],
  };
}

/**
 * @param {string|{choice: string, scope?: string|null}} answered What `ask`
 *   answered.
 * @param {string} host What the alert asked about.
 * @returns {{choice: string, name: string}} The choice, and the name its
 *   answer is saved under: the scope picked in the alert's menu, or `host`.
 */
export function answerOf(answered, host) {
  return typeof answered === "string"
    ? { choice: answered, name: host }
    : { choice: answered?.choice, name: answered?.scope ?? host };
}

/**
 * @returns {ToolError} What a call answers when its connection has as many
 *   calls waiting for the user as it may (`ApprovalWait.full`), and it would
 *   ask the user.
 */
export const tooManyWaiting = () =>
  new ToolError(
    "awaiting_approval",
    `${MAX_WAITING_CALLS} of this agent's calls are already waiting for the user to answer in Sval, so this call did not ask. Ask them to answer, then call again.`,
    { waiting_calls: MAX_WAITING_CALLS }
  );

/**
 * @returns {ToolError} The same, for an input, which may hold writes the
 *   user would be asked about.
 */
export const tooManyWaitingToAct = () =>
  new ToolError(
    "awaiting_approval",
    `${MAX_WAITING_CALLS} of this agent's calls are already waiting for the user to answer in Sval, so this action was not performed. Ask them to answer, then act again.`,
    { waiting_calls: MAX_WAITING_CALLS }
  );

/**
 * The alert in flight for `key`, or a new one `run` asks. Whoever asks the
 * same question while it is up waits on the same answer, and once that is
 * in, the next ask opens a new alert.
 *
 * @param {Map<string, {answer: Promise<string>}>} inFlight
 * @param {string} key
 * @param {() => Promise<string>} run Asks, and records the answer.
 * @returns {{answer: Promise<string>}}
 */
export function alertOnce(inFlight, key, run) {
  const open = inFlight.get(key);
  if (open) {
    return open;
  }
  const entry = { answer: null };
  entry.answer = run().finally(() => inFlight.delete(key));
  inFlight.set(key, entry);
  return entry;
}

/**
 * Waits for the user's answer as a call's wait says (`ApprovalWait`). A call
 * whose connection is full is refused before anything is asked. One that
 * stops waiting answers `awaiting_approval` and leaves the alert up; an
 * alert with no window to ask in answers `no_window`.
 *
 * @param {object} options
 * @param {object} options.wait The call's `ApprovalWait`.
 * @param {() => Promise<string>} options.answer Asks, or joins the alert in
 *   flight. Called only once the call may wait.
 * @param {string} options.awaiting What the call says while the user has
 *   not answered.
 * @param {object} options.closing Ends with agent access (`Ending`).
 * @param {() => void} [options.onGiveUp] Told when the call stops waiting.
 * @returns {Promise<string>} The answer.
 */
export async function awaitAnswer({
  wait,
  answer,
  awaiting,
  closing,
  onGiveUp,
}) {
  if (wait.full) {
    throw tooManyWaiting();
  }
  const got = await wait.until(
    answer(),
    () => {
      onGiveUp?.();
      throw new ToolError("awaiting_approval", awaiting);
    },
    closing
  );
  if (got === "no_window") {
    throw new ToolError(
      "no_window",
      "Sval has no open window to ask the user in. Open a Sval window and try again."
    );
  }
  return got;
}
