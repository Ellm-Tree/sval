/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { CorrectedClock, ReadingRetry, FIRST_RETRY_MS, LONGEST_RETRY_MS } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalClock.sys.mjs"
  );

/**
 * A clock over sources a test moves by hand.
 *
 * @param {object} [start]
 * @param {number} [start.wall]
 * @param {number} [start.mono]
 * @param {number|null} [start.skew]
 * @returns {object} `{ at, clock }`, where `at` holds the sources' values.
 */
function sources({ wall = 1_000_000, mono = 0, skew = null } = {}) {
  const at = { wall, mono, skew };
  const clock = new CorrectedClock({
    wall: () => at.wall,
    monotonic: () => at.mono,
    skewSeconds: () => at.skew,
  });
  return { at, clock };
}

add_task(function the_measured_difference_is_taken_off_the_wall_clock() {
  const { at, clock } = sources({ skew: 30 });
  Assert.equal(clock.now(), 1_000_000 - 30_000);
  at.skew = -5;
  clock.readingChanged();
  at.wall += 1000;
  at.mono += 1000;
  Assert.equal(clock.now(), 1_001_000 + 5_000, "a new reading re-anchors");
});

add_task(function a_wall_clock_change_between_readings_moves_nothing() {
  const { at, clock } = sources({ skew: 0 });
  Assert.equal(clock.now(), 1_000_000);
  at.wall += 3_600_000;
  at.mono += 10;
  Assert.equal(clock.now(), 1_000_010, "set forward an hour");
  at.wall -= 7_200_000;
  at.mono += 10;
  Assert.equal(clock.now(), 1_000_020, "set back two hours");
});

add_task(function a_small_drift_of_the_wall_clock_is_followed() {
  const { at, clock } = sources({ skew: 0 });
  Assert.equal(clock.now(), 1_000_000);
  // The monotonic clock ran 150 ms slow over ten minutes.
  at.wall += 600_000;
  at.mono += 599_850;
  Assert.equal(clock.now(), 1_600_000, "the wall clock's time");
  at.wall += 3_600_000;
  at.mono += 10;
  Assert.equal(clock.now(), 1_600_010, "a step of an hour is not followed");
});

add_task(function a_wake_adds_the_time_the_system_slept() {
  const { at, clock } = sources({ skew: 0 });
  Assert.equal(clock.now(), 1_000_000);
  // Asleep for a minute, which the monotonic clock did not count.
  at.wall += 60_000;
  at.mono += 5;
  clock.wake();
  Assert.equal(clock.now(), 1_060_000);
  // A monotonic clock that counted the sleep adds nothing more.
  at.wall += 60_000;
  at.mono += 60_000;
  clock.wake();
  Assert.equal(clock.now(), 1_120_000);
});

add_task(function stamps_only_move_forward() {
  const { at, clock } = sources({ skew: 0 });
  const first = clock.now();
  Assert.equal(clock.now(), first + 1, "a second stamp in the same ms");
  at.skew = 2;
  clock.readingChanged();
  Assert.equal(clock.now(), first + 2, "a reading two seconds lower");
});

add_task(function without_a_reading_the_wall_clock_is_used() {
  const { at, clock } = sources();
  Assert.ok(!clock.hasReading);
  Assert.equal(clock.now(), 1_000_000);
  at.wall += 3_600_000;
  Assert.equal(clock.now(), 4_600_000, "the wall clock, as it is set");
});

add_task(function the_first_reading_lets_stamps_fall_back_and_says_from_when() {
  const { at, clock } = sources({ wall: 9_000_000 });
  Assert.equal(clock.now(), 9_000_000);
  const heard = [];
  clock.onFirstReading(from => heard.push(from));
  at.skew = 8_000;
  clock.readingChanged();
  Assert.deepEqual(heard, [1_000_000], "told the corrected time");
  Assert.equal(clock.now(), 1_000_001, "the next stamp follows it");
  at.skew = 7_999;
  clock.readingChanged();
  Assert.equal(heard.length, 1, "a later reading is no first reading");
});

/** Waits for every promise already settling: a task runs after them all. */
function settle() {
  return new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
}

/**
 * A retry over fake timers.
 *
 * @param {object} [hooks]
 * @param {Function} [hooks.fail] Whether the next poll fails.
 * @param {Function} [hooks.backoffUntil] As `ReadingRetry` takes it.
 * @returns {object}
 */
function retryWith({ fail = () => true, backoffUntil = () => 0 } = {}) {
  const timers = [];
  let reading = false;
  let polls = 0;
  const retry = new ReadingRetry({
    async poll() {
      polls++;
      if (fail()) {
        throw new Error("NetworkError");
      }
      reading = true;
    },
    hasReading: () => reading,
    setTimeout(fn, ms) {
      const timer = { fn, ms };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      timer.cleared = true;
    },
    backoffUntil,
    wall: () => 0,
  });
  return {
    retry,
    timers,
    get polls() {
      return polls;
    },
    /** Fires the last timer and waits for its poll to settle. */
    async fire() {
      const timer = timers.at(-1);
      Assert.ok(timer && !timer.cleared, "a retry is scheduled");
      timer.fn();
      await settle();
    },
  };
}

add_task(async function a_failure_retries_after_a_growing_delay() {
  const run = retryWith();
  run.retry.start();
  await settle();
  Assert.equal(run.polls, 1, "the first attempt runs at once");
  const delays = [run.timers.at(-1).ms];
  for (let i = 0; i < 8; i++) {
    await run.fire();
    delays.push(run.timers.at(-1).ms);
  }
  Assert.equal(delays[0], FIRST_RETRY_MS);
  Assert.equal(delays[1], FIRST_RETRY_MS * 2);
  Assert.equal(delays.at(-1), LONGEST_RETRY_MS, "capped");
  run.retry.stop();
});

add_task(async function success_stops_the_retries() {
  let failing = true;
  const run = retryWith({ fail: () => failing });
  run.retry.start();
  await settle();
  failing = false;
  await run.fire();
  Assert.equal(run.polls, 2);
  Assert.ok(!run.retry.scheduled, "nothing more is scheduled");
  run.retry.nudge();
  await settle();
  Assert.equal(run.polls, 2, "and a nudge polls no more");
});

add_task(async function the_network_coming_back_tries_at_once() {
  const run = retryWith();
  run.retry.start();
  await settle();
  await run.fire();
  Assert.equal(run.timers.at(-1).ms, FIRST_RETRY_MS * 2, "the delay grew");
  run.retry.nudge();
  await settle();
  Assert.equal(run.polls, 3, "polled without waiting");
  Assert.equal(run.timers.at(-1).ms, FIRST_RETRY_MS, "the delays start over");
  run.retry.stop();
});

add_task(async function a_server_backoff_is_waited_out() {
  const run = retryWith({ backoffUntil: () => 600_000 });
  run.retry.start();
  await settle();
  Assert.equal(run.polls, 0, "no poll inside the server's backoff");
  Assert.equal(run.timers.at(-1).ms, 600_000, "the next try is at its end");
  run.retry.stop();
});
