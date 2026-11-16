/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The write gate's two longest limits (agent-control spec §5.3), each waited
 * out once on Sval's own timers: an action window closes `CAP_MS` after its
 * input was done, and `OPEN_MAX_MS` after it opened, whatever its network
 * does.
 */

const { ActionWindow, CAP_MS, OPEN_MAX_MS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentGate.sys.mjs"
);
const { within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);

/**
 * A channel that records being suspended, resumed and cancelled. It counts
 * as finished, as a quick request would be by the time the window looks
 * again, unless `pending` is set.
 *
 * @param {string} method
 * @param {string} [url]
 * @param {object} [state]
 * @param {boolean} [state.pending]
 * @param {number} [state.status]
 * @param {number} [state.type] The `nsIContentPolicy` type that sent it.
 */
function fakeChannel(
  method,
  url = "https://api.example.com/v1/order?id=7",
  {
    pending = false,
    status = Cr.NS_OK,
    type = Ci.nsIContentPolicy.TYPE_FETCH,
  } = {}
) {
  const uri = Services.io.newURI(url);
  return {
    loadInfo: { externalContentPolicyType: type },
    requestMethod: method,
    URI: { spec: uri.spec, host: uri.host, filePath: uri.filePath },
    pending,
    status,
    isPending() {
      return this.pending;
    },
    done: [],
    suspend() {
      this.done.push("suspend");
    },
    resume() {
      this.done.push("resume");
    },
    cancel(reason) {
      this.done.push(reason === Cr.NS_ERROR_ABORT ? "cancel" : "cancel?");
    },
  };
}

/** An action window whose top-level page asks before writes. */
function actionWindow() {
  return {
    action: new ActionWindow({
      topOf: () => ({ site: "example.com", level: "ask-before-writes" }),
    }),
  };
}

/**
 * Says the input is done and waits for the window to close.
 *
 * @param {ActionWindow} action
 * @param {number} limit How long the close may take.
 * @returns {Promise<object>} What the window hands back.
 */
function inputDoneAndClosed(action, limit) {
  return within(action.inputDone(), limit, "the action window closing");
}

/**
 * A request that never ends holds the window open until `CAP_MS` after the
 * input was done: the one test that waits the cap out.
 */
add_task(async function a_request_that_never_ends_meets_the_cap() {
  const { action } = actionWindow();
  action.offer(fakeChannel("GET", undefined, { pending: true }));
  const done = ChromeUtils.now();
  await inputDoneAndClosed(action, CAP_MS + 10_000);
  Assert.greaterOrEqual(ChromeUtils.now() - done, CAP_MS);
});

/**
 * An input that never ends holds the window open until `OPEN_MAX_MS` after
 * it opened, and no longer: the one test that waits that limit out.
 */
add_task(async function the_window_closes_at_its_limit_regardless() {
  const opened = ChromeUtils.now();
  const { action } = actionWindow();
  Assert.equal(action.offer(fakeChannel("POST")), "held");
  const closed = await within(
    action.closed,
    OPEN_MAX_MS + 10_000,
    "the action window closing"
  );
  Assert.greaterOrEqual(ChromeUtils.now() - opened, OPEN_MAX_MS);
  Assert.equal(closed.held.length, 1, "and hands over what it holds");
});
