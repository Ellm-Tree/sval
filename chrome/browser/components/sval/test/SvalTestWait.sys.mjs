/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * `within`, the bound every Sval test puts on a wait for an event. The browser
 * tests' head.js binds it for every browser-chrome file; an xpcshell file
 * imports it:
 *
 *   const { within } = ChromeUtils.importESModule(
 *     "resource://testing-common/SvalTestWait.sys.mjs"
 *   );
 */

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

/**
 * Settles as `promise` does, or rejects once `ms` have passed, naming the
 * step that did not happen.
 *
 * A test file has a time limit from its harness. An await that never settles
 * uses all of it and ends in a timeout that names only the task, and in a
 * browser test the window it tears down breaks the tasks after it. Bounded,
 * the stuck step fails its own task in seconds and says which step it was.
 * The bound is a deadline: the test still goes on as soon as the event
 * happens.
 *
 * @param {Promise|*} promise What the test is waiting for.
 * @param {number} [ms] How long the step may take, well inside the file's
 *   budget.
 * @param {string} [what] The step, as the failure names it.
 * @returns {Promise<*>} what `promise` resolved with.
 */
export function within(promise, ms = 10_000, what = "the awaited step") {
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} did not happen within ${ms} ms`)),
      ms
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * `TestUtils.waitForCondition`, bounded by time: it rejects once
 * `interval × maxTries` ms have passed since it began, however long each
 * check takes, and a check still pending then is abandoned. Mozilla's counts
 * tries only between checks (`tryOnce` in testing/modules/TestUtils.sys.mjs),
 * so a slow check stretches its bound and a check that never settles holds
 * it open until the harness ends the whole file. The browser tests' head.js
 * puts this in place of Mozilla's; an xpcshell file or a test module calls
 * it in place of `TestUtils.waitForCondition`.
 *
 * Checks run every 10 ms, or every `interval` ms if that is shorter.
 * It resolves as Mozilla's does, with what the condition returned, and
 * rejects with an Error whose message is `msg` and what went wrong.
 *
 * @param {Function} condition Returns, or resolves to, a truthy value when
 *   the wait is over.
 * @param {string} msg The wait, as the failure names it.
 * @param {number} [interval] With `maxTries`, the bound.
 * @param {number} [maxTries] With `interval`, the bound.
 * @returns {Promise<*>} what `condition` last returned.
 */
export async function waitForCondition(
  condition,
  msg,
  interval = 100,
  maxTries = 50
) {
  const ms = interval * maxTries;
  const deadline = Date.now() + ms;
  const every = Math.min(interval, 10);
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new Error(`${msg} - timed out after ${ms} ms`);
    }
    let passed;
    try {
      passed = condition();
      if (typeof passed?.then == "function") {
        passed = await within(passed, left, "the check");
      }
    } catch (e) {
      throw new Error(`${msg} - threw exception: ${e}`);
    }
    if (passed) {
      return passed;
    }
    // This is the poll `sval/timer-wait` sends a test's fixed waits to.
    // eslint-disable-next-line sval/timer-wait
    await new Promise(resolve => setTimeout(resolve, every));
  }
}

/**
 * Settles as `promise` does, and when it rejects, adds what `describe`
 * returns to the error's message. A wait that fails once in many runs
 * fails where no one is watching, so its message is the only record of the
 * state it gave up on.
 *
 * @param {Promise} promise A bounded wait.
 * @param {Function} describe Returns the state to report, as an object;
 *   called only on failure, and its own failure is reported in its place.
 * @returns {Promise<*>} what `promise` resolved with.
 */
export async function explained(promise, describe) {
  try {
    return await promise;
  } catch (error) {
    let state;
    try {
      state = JSON.stringify(await describe());
    } catch (e) {
      state = `unreadable: ${e}`;
    }
    const message = `${error?.message ?? error}; state: ${state}`;
    if (error instanceof Error) {
      error.message = message;
      throw error;
    }
    throw new Error(message);
  }
}
