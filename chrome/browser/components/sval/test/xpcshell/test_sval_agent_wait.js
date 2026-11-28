/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * How a tool call waits for the user's answer to an alert (agent-control
 * spec §5.6): as long as the user takes, up to the wait Settings › Agents
 * sets.
 */

const {
  ApprovalWait,
  Ending,
  MAX_WAITING_CALLS,
  PROGRESS_EVERY_MS,
  APPROVAL_WAIT_PREF,
  approvalWaitMs,
  WAITING_MESSAGE,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentAlerts.sys.mjs"
);
const { within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);

/** An answer that never comes. */
const never = new Promise(() => {});

/**
 * @param {object[]} sent What a wait sent.
 * @param {string|number} token
 */
function assertProgress(sent, token) {
  let last = -Infinity;
  for (const notification of sent) {
    Assert.deepEqual(Object.keys(notification).sort(), [
      "jsonrpc",
      "method",
      "params",
    ]);
    Assert.equal(notification.jsonrpc, "2.0");
    Assert.equal(notification.method, "notifications/progress");
    const { progressToken, progress, message } = notification.params;
    Assert.strictEqual(progressToken, token);
    Assert.equal(message, WAITING_MESSAGE);
    Assert.greater(progress, last, "progress rises with each notification");
    last = progress;
  }
}

add_task(function the_limits_suit_the_clients_agents_use() {
  Assert.equal(
    approvalWaitMs(),
    60 * 60_000,
    "an hour, unless the user sets another"
  );
  Assert.equal(PROGRESS_EVERY_MS, 10_000);
  Assert.ok(
    typeof WAITING_MESSAGE === "string" && WAITING_MESSAGE,
    "a waiting call has something to show"
  );
});

/**
 * A call that carries a progress token is told why it waits as the wait
 * begins and again every `PROGRESS_EVERY_MS`, the one interval this file
 * waits out, and the answer carries it on.
 */
add_task(async function with_a_token_a_call_is_told_it_waits_every_interval() {
  const sent = [];
  let answer;
  const answered = new Promise(resolve => (answer = resolve));
  const { promise: second, resolve: onSecond } = Promise.withResolvers();
  const wait = new ApprovalWait({
    progressToken: "tok-1",
    notify: n => {
      sent.push(n);
      if (sent.length === 2) {
        onSecond();
      }
    },
  });
  const waiting = wait.until(answered, () => "gave up");
  await Promise.resolve();
  Assert.equal(sent.length, 1, "the wait says why at once");
  await within(second, PROGRESS_EVERY_MS + 10_000, "the second notification");
  answer("allow");
  Assert.equal(await waiting, "allow", "the answer carries the call on");
  assertProgress(sent, "tok-1");
});

/**
 * A call that carries a progress token gives up when the wait Settings ›
 * Agents sets runs out, read as the call first waits: the one test that
 * waits that limit out, set short here.
 */
add_task(async function with_a_token_a_call_gives_up_when_the_setting_says() {
  const seconds = 10;
  Services.prefs.setIntPref(APPROVAL_WAIT_PREF, seconds);
  registerCleanupFunction(() =>
    Services.prefs.clearUserPref(APPROVAL_WAIT_PREF)
  );
  const sent = [];
  const wait = new ApprovalWait({
    progressToken: 3,
    notify: n => sent.push(n),
  });
  const started = ChromeUtils.now();
  const waiting = wait.until(never, () => "gave up");
  Assert.equal(
    await within(waiting, (seconds + 10) * 1000, "the call giving up"),
    "gave up"
  );
  Assert.greaterOrEqual(ChromeUtils.now() - started, seconds * 1000);
  assertProgress(sent, 3);
  Services.prefs.clearUserPref(APPROVAL_WAIT_PREF);
});

add_task(async function the_answer_ends_the_wait_at_once() {
  const wait = new ApprovalWait();
  Assert.equal(
    await wait.until(Promise.resolve("deny"), () => "gave up"),
    "deny"
  );
  await Assert.rejects(
    wait.until(Promise.reject(new Error("boom")), () => "gave up"),
    /boom/,
    "a failed answer is passed on"
  );
});

add_task(async function a_throw_from_giving_up_rejects() {
  const wait = new ApprovalWait();
  const waiting = wait.until(never, () => {
    throw new Error("awaiting");
  });
  wait.cancel();
  await Assert.rejects(waiting, /awaiting/);
});

add_task(async function the_caller_going_ends_the_wait_and_silences_it() {
  const ending = new Ending();
  const sent = [];
  const wait = new ApprovalWait({
    progressToken: "tok-2",
    notify: n => sent.push(n),
    ending,
  });
  const waiting = wait.until(never, () => "gave up");
  ending.end();
  Assert.equal(await waiting, "gave up", "at once, with the limit far off");
  const count = sent.length;
  Assert.equal(
    await wait.until(never, () => "gone"),
    "gone",
    "a wait that starts after the caller went ends at once"
  );
  Assert.equal(sent.length, count, "and says nothing");
});

add_task(async function progress_rises_across_one_calls_waits() {
  const sent = [];
  const wait = new ApprovalWait({
    progressToken: "tok-3",
    notify: n => sent.push(n),
  });
  Assert.equal(await wait.until(Promise.resolve("a"), () => "gave up"), "a");
  Assert.equal(await wait.until(Promise.resolve("b"), () => "gave up"), "b");
  Assert.equal(sent.length, 2, "each wait reports as it begins");
  assertProgress(sent, "tok-3");
});

add_task(async function only_a_string_or_a_number_is_a_progress_token() {
  for (const token of [null, undefined, {}, [], true, NaN, Infinity]) {
    const sent = [];
    const wait = new ApprovalWait({
      progressToken: token,
      notify: n => sent.push(n),
    });
    const waiting = wait.until(never, () => "gave up");
    wait.cancel();
    Assert.equal(await waiting, "gave up");
    Assert.deepEqual(sent, [], `${token} is no token`);
  }
});

/**
 * A wait says when it begins, so the connection can go on to the agent's
 * next request meanwhile. A wait whose caller is already gone does not.
 */
add_task(async function a_wait_says_when_it_begins() {
  let began = 0;
  const wait = new ApprovalWait({ onWaiting: () => began++ });
  const waiting = wait.until(never, () => "gave up");
  Assert.equal(began, 1, "at once");
  wait.cancel();
  Assert.equal(await waiting, "gave up");

  const ending = new Ending();
  let goneBegan = 0;
  const gone = new ApprovalWait({ onWaiting: () => goneBegan++, ending });
  ending.end();
  Assert.equal(await gone.until(never, () => "gone"), "gone");
  Assert.equal(goneBegan, 0, "not for a caller already gone");
});

/**
 * An ending another party holds, such as agent access going off, ends a
 * wait too, and every wait lets go of every ending it listened to.
 */
add_task(async function a_wait_listens_to_its_endings_only_while_it_waits() {
  const own = new Ending();
  const access = new Ending();
  const wait = new ApprovalWait({ ending: own });
  Assert.equal(
    await wait.until(Promise.resolve("allow"), () => "gave up", access),
    "allow"
  );
  Assert.equal(own.listening, 0, "the call's ending is let go");
  Assert.equal(access.listening, 0, "and so is the other");
  const waiting = wait.until(never, () => "gave up", access);
  Assert.equal(access.listening, 1, "listened to while it waits");
  access.end();
  Assert.equal(await waiting, "gave up", "access going off ends the wait");
  Assert.equal(own.listening, 0);
});

/** A string token longer than 256 characters is no token. */
add_task(async function a_long_string_is_no_progress_token() {
  for (const [length, isToken] of [
    [257, false],
    [256, true],
  ]) {
    const sent = [];
    const wait = new ApprovalWait({
      progressToken: "x".repeat(length),
      notify: n => sent.push(n),
    });
    const waiting = wait.until(never, () => "gave up");
    wait.cancel();
    Assert.equal(await waiting, "gave up");
    Assert.equal(sent.length, isToken ? 1 : 0, `${length} characters`);
  }
});

/**
 * A cancelled call stops waiting at once, and any later wait of it gives up
 * at once without saying it waits.
 */
add_task(async function cancelling_ends_a_wait_and_silences_it() {
  const sent = [];
  const wait = new ApprovalWait({
    progressToken: "c",
    notify: n => sent.push(n),
  });
  const waiting = wait.until(never, () => "gave up");
  wait.cancel();
  Assert.equal(await waiting, "gave up");
  Assert.ok(wait.cancelled);
  const count = sent.length;
  Assert.equal(await wait.until(never, () => "again"), "again");
  Assert.equal(sent.length, count, "the later wait says nothing");
});

/**
 * At most `MAX_WAITING_CALLS` calls of one connection wait at once. A call
 * that would be one more gives up at once, and says so before it asks.
 */
add_task(async function a_connection_has_at_most_eight_waiting_calls() {
  Assert.equal(MAX_WAITING_CALLS, 8);
  const slots = { waiting: 0 };
  const answers = [];
  const waits = [];
  for (let i = 0; i < MAX_WAITING_CALLS; i++) {
    const { promise, resolve } = Promise.withResolvers();
    answers.push(resolve);
    const wait = new ApprovalWait({ slots });
    Assert.ok(!wait.full, `call ${i + 1} may wait`);
    waits.push(wait.until(promise, () => "gave up"));
  }
  const ninth = new ApprovalWait({ slots });
  Assert.ok(ninth.full, "a ninth may not");
  let began = false;
  const late = new ApprovalWait({ slots, onWaiting: () => (began = true) });
  Assert.equal(await late.until(never, () => "full"), "full");
  Assert.ok(!began, "and never began waiting");
  answers[0]("allow");
  Assert.equal(await waits[0], "allow");
  Assert.ok(!ninth.full, "a call that ends frees its place");
  for (const resolve of answers.slice(1)) {
    resolve("deny");
  }
  await Promise.all(waits);
  Assert.equal(slots.waiting, 0);
});

/** What a full connection answers names the limit it holds to. */
add_task(function a_full_connection_names_its_limit() {
  const { tooManyWaiting, tooManyWaitingToAct } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgentAsk.sys.mjs"
  );
  for (const error of [tooManyWaiting(), tooManyWaitingToAct()]) {
    Assert.equal(error.code, "awaiting_approval");
    Assert.deepEqual(error.details, { waiting_calls: MAX_WAITING_CALLS });
  }
});
