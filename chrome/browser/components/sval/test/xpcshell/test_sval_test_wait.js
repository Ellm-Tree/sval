/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * `explained`, which adds the state a failed wait gave up on to its error,
 * and `waitForCondition`, which ends on time.
 */

const { explained, waitForCondition, within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);

add_task(async function a_wait_that_settles_reports_nothing() {
  let asked = false;
  const value = await explained(Promise.resolve(7), () => {
    asked = true;
    return {};
  });
  Assert.equal(value, 7, "it resolves with the wait's value");
  Assert.ok(!asked, "and reads no state");
});

add_task(async function a_timed_out_wait_names_its_step_and_state() {
  await Assert.rejects(
    explained(within(new Promise(() => {}), 10, "the step"), async () => ({
      queue: ["GetEngine"],
    })),
    /^Error: the step did not happen within 10 ms; state: \{"queue":\["GetEngine"\]\}$/,
    "the error keeps its message and adds the state"
  );
});

add_task(async function state_that_cannot_be_read_says_so() {
  await Assert.rejects(
    explained(Promise.reject(new Error("gone")), () => {
      throw new Error("no window");
    }),
    /^Error: gone; state: unreadable: Error: no window$/,
    "the wait's own failure is still reported"
  );
});

add_task(async function a_met_condition_resolves_with_its_value() {
  let checks = 0;
  const value = await waitForCondition(
    async () => ++checks >= 3 && "met",
    "the third check"
  );
  Assert.equal(value, "met", "it resolves with what the condition returned");
  Assert.equal(checks, 3, "after the checks it took");
});

add_task(async function a_check_that_never_settles_fails_at_the_deadline() {
  const start = Date.now();
  await Assert.rejects(
    waitForCondition(() => new Promise(() => {}), "the hung wait", 10, 20),
    /^Error: the hung wait - threw exception: Error: the check did not happen within \d+ ms$/,
    "the wait fails naming itself"
  );
  Assert.less(Date.now() - start, 5000, "at its own deadline");
});

add_task(async function slow_checks_do_not_stretch_the_bound() {
  // Each check takes 50 ms, so twenty tries would take a second; the bound
  // is 200 ms of time.
  let checks = 0;
  await Assert.rejects(
    waitForCondition(
      () => {
        checks++;
        return within(new Promise(() => {}), 50, "a slow check").catch(
          () => false
        );
      },
      "the slow wait",
      10,
      20
    ),
    /^Error: the slow wait - /,
    "the wait fails"
  );
  Assert.less(checks, 20, "on time, before its tries run out");
});

add_task(async function a_throwing_condition_fails_the_wait() {
  await Assert.rejects(
    waitForCondition(() => {
      throw new Error("broken");
    }, "the broken wait"),
    /^Error: the broken wait - threw exception: Error: broken$/,
    "the condition's error is reported"
  );
});
