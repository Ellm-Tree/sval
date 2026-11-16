/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { SvalSerialQueue } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSerialQueue.sys.mjs"
);
const { PromiseTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PromiseTestUtils.sys.mjs"
);
const { within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);

// Short, so a re-entry is reported long before `within` gives up on it.
const GRACE_MS = 200;

/**
 * What a re-entry rejects with, or null when the wait resolved.
 *
 * @param {Promise} wait
 * @returns {Promise<Error|null>}
 */
async function reentryOf(wait) {
  try {
    await within(wait, 10_000, "a wait on the queue");
    return null;
  } catch (err) {
    return err;
  }
}

add_setup(() => {
  // The check reads async stacks, which only automation captures.
  Assert.ok(Cu.isInAutomation, "the harness runs as automation");
});

add_task(async function tasks_run_in_order_and_a_failure_stops_nothing() {
  const queue = new SvalSerialQueue("test queue");
  const ran = [];
  const first = queue.run(async () => {
    await Promise.resolve();
    ran.push(1);
    return "one";
  });
  const failed = queue.run(() => {
    ran.push(2);
    throw new Error("expected");
  });
  queue.post(() => ran.push(3));
  Assert.equal(await first, "one");
  await Assert.rejects(failed, /expected/);
  await within(queue.idle(), 10_000, "queue going idle");
  Assert.deepEqual(ran, [1, 2, 3]);
});

add_task(async function a_task_waiting_for_its_own_queue_is_named() {
  PromiseTestUtils.expectUncaughtRejection(/SvalQueueReentry|own queue/);
  const queue = new SvalSerialQueue("test queue", { graceMs: GRACE_MS });
  let reported = null;
  async function waitsForItsOwnQueue() {
    reported = await reentryOf(queue.run(() => "behind it"));
  }
  const task = queue.run(() => waitsForItsOwnQueue());
  await within(task, 10_000, "the re-entrant task");
  Assert.equal(reported?.name, "SvalQueueReentry");
  Assert.stringContains(reported.message, "test queue");
  Assert.stringContains(reported.message, "waitsForItsOwnQueue");
  // The task unwound, so the work behind it ran.
  await within(queue.idle(), 10_000, "the queue after a re-entry");
});

add_task(async function a_wait_through_callbacks_is_named_with_its_path() {
  PromiseTestUtils.expectUncaughtRejection(/SvalQueueReentry|own queue/);
  const queue = new SvalSerialQueue("observer", { graceMs: GRACE_MS });
  let reported = null;
  const panel = {
    async refresh() {
      await Promise.resolve();
      return this.handOver();
    },
    async handOver() {
      reported = await reentryOf(
        within(queue.idle(), 10_000, "the queue going idle")
      );
    },
  };
  await within(
    queue.run(async () => {
      await Promise.resolve();
      await panel.refresh();
    }),
    10_000,
    "the task that called the panel back"
  );
  Assert.equal(reported?.name, "SvalQueueReentry");
  Assert.stringContains(reported.message, "observer");
  Assert.stringContains(reported.message, "refresh");
  Assert.stringContains(reported.message, "handOver");
});

add_task(async function two_queues_waiting_on_each_other_are_named() {
  PromiseTestUtils.expectUncaughtRejection(/SvalQueueReentry|own queue/);
  const tabs = new SvalSerialQueue("tabs", { graceMs: GRACE_MS });
  const handOvers = new SvalSerialQueue("hand-overs", { graceMs: GRACE_MS });
  let reported = null;
  await within(
    tabs.run(() =>
      handOvers.run(async () => {
        reported = await reentryOf(tabs.idle());
      })
    ),
    10_000,
    "the task that waited on the other queue"
  );
  Assert.equal(reported?.name, "SvalQueueReentry");
  Assert.stringContains(reported.message, "tabs: task");
});

add_task(async function a_wait_across_a_second_queue_is_followed_back() {
  PromiseTestUtils.expectUncaughtRejection(/SvalQueueReentry|own queue/);
  // The shape of a hand-over started from the tab observer's queue: the
  // observer's task waits on the hand-over, and the hand-over waits on work
  // queued on the observer.
  const observer = new SvalSerialQueue("observer", { graceMs: GRACE_MS });
  const handOvers = new SvalSerialQueue("hand-over", { graceMs: GRACE_MS });
  let reported = null;
  async function handOverOnce() {
    await Promise.resolve();
    reported = await reentryOf(observer.run(() => "keep tabs in jar"));
  }
  async function refresh() {
    await Promise.resolve();
    await handOvers.run(() => handOverOnce());
  }
  await within(
    observer.run(() => refresh()),
    10_000,
    "the observer task that started a hand-over"
  );
  Assert.equal(reported?.name, "SvalQueueReentry");
  Assert.stringContains(reported.message, "observer: task");
  Assert.stringContains(reported.message, "handOverOnce");
  Assert.stringContains(reported.message, "refresh");
});

add_task(async function work_a_task_does_not_wait_for_is_not_a_reentry() {
  const queue = new SvalSerialQueue("test queue", { graceMs: GRACE_MS });
  let later = null;
  await queue.run(async () => {
    queue.post(() => {});
    // Started here and left running: it waits, the task does not.
    later = reentryOf(within(queue.idle(), 10_000, "the queue going idle"));
    await Promise.resolve();
  });
  Assert.equal(await later, null, "the wait ended with the task");
});
