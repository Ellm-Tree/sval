/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * A clock whose time moves only when the test says so, for code that takes
 * `now` and the timer functions as an option. A test that moves it never
 * waits on real time, so a loaded machine cannot make it late.
 *
 *   const { SvalTestClock } = ChromeUtils.importESModule(
 *     "resource://testing-common/SvalTestClock.sys.mjs"
 *   );
 *   const clock = SvalTestClock.manual();
 */
export const SvalTestClock = {
  /**
   * @returns {{now: Function, setTimeout: Function, clearTimeout: Function,
   *   setInterval: Function, clearInterval: Function, advance: Function,
   *   pending: Map}} `pending` holds the timers not yet fired or cleared.
   */
  manual() {
    let time = 0;
    let nextId = 1;
    const timers = new Map();
    const add = (fire, ms, every) => {
      timers.set(nextId, { at: time + Math.max(ms, 0), fire, every });
      return nextId++;
    };
    return {
      pending: timers,
      now: () => time,
      setTimeout: (fire, ms) => add(fire, ms, 0),
      setInterval: (fire, ms) => add(fire, ms, Math.max(ms, 1)),
      clearTimeout: id => timers.delete(id),
      clearInterval: id => timers.delete(id),
      /**
       * Moves time on, firing each timer that falls due on the way, in order.
       *
       * @param {number} ms How far.
       */
      advance(ms) {
        const end = time + ms;
        for (;;) {
          let due = null;
          for (const [id, timer] of timers) {
            if (timer.at <= end && (!due || timer.at < due.timer.at)) {
              due = { id, timer };
            }
          }
          if (!due) {
            break;
          }
          time = due.timer.at;
          if (due.timer.every) {
            due.timer.at += due.timer.every;
          } else {
            timers.delete(due.id);
          }
          due.timer.fire();
        }
        time = end;
      },
    };
  },
};
