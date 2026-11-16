/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * A wait that gives up after a while, with its timer cleared however it
 * ends, so a race that is over leaves nothing scheduled.
 */

import {
  clearTimeout as timerClear,
  setTimeout as timerSet,
} from "resource://gre/modules/Timer.sys.mjs";

/** What {@link raceTimeout} resolves to when the time ran out first. */
export const TIMED_OUT = Symbol("timed out");

/**
 * `promise`'s value, or {@link TIMED_OUT} once `ms` have passed. A rejection
 * of `promise` rejects this.
 *
 * @param {Promise|*} promise
 * @param {number} ms
 * @param {object} [clock] The timer functions to run on, such as a window's,
 *   whose clock a test may hold; Timer.sys.mjs's by default.
 * @returns {Promise<*>}
 */
export async function raceTimeout(promise, ms, clock = null) {
  const set = clock ? (fn, wait) => clock.setTimeout(fn, wait) : timerSet;
  const clear = clock ? timer => clock.clearTimeout(timer) : timerClear;
  let timer = null;
  const late = new Promise(resolve => {
    timer = set(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clear(timer);
  }
}
