/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Work that runs one task at a time, in the order it was queued, and the
 * deadlock that shape invites.
 *
 * **A task must never wait for its own queue.** Each task starts once the one
 * before it has settled, so a task that waits for the queue to drain, or for
 * work queued behind it, waits for itself. Nothing ends that wait: no error,
 * no timeout, only a queue that stops. The path is rarely direct. A tab
 * observer's task calls the panel back, the panel switches workspace, the
 * switch hands the window over, and the hand-over waits for the observer.
 *
 * Work queued from inside a task and not waited for is fine, which is what
 * {@link SvalSerialQueue#post} is for. {@link SvalSerialQueue#run} and
 * {@link SvalSerialQueue#idle} hand back a promise to wait on.
 *
 * **The queue checks the rule where it can.** SpiderMonkey records an async
 * function's caller chain across every `await` when `javascript.options.
 * asyncstack_capture_debuggee_only` is false, which the mochitest and
 * xpcshell test profiles set in their `user.js`. Each task runs inside a
 * function named for its queue and its place in it, so a wait asked
 * for by the running task carries that frame in its stack. A task starts in
 * its own queue's promise job, so each task also keeps the stack it was
 * queued from, and a wait that crossed another queue on the way is followed
 * back through it. A stack holds at most 128 frames, so a path deeper than
 * that loses its oldest frames and goes unreported. If the task is still
 * running {@link REENTRY_GRACE_MS} later, the wait rejects with a
 * `SvalQueueReentry` error that names the queue and the call path, and under
 * automation an uncaught rejection fails the test. Rejecting ends a wait that
 * could never resolve, so the task unwinds and the queue moves again. A wait
 * from work the task started but does not itself wait on carries the frame
 * too, and that is why the check waits: such a wait ends with the task, and
 * then nothing is reported.
 *
 * A release build records no async caller chain, so the check is skipped
 * there. What a release build does instead is notice a task that has run for
 * {@link STALL_MS} and log it once, naming the queue, the next time anything
 * touches the queue. A task can be slow for its own reasons, such as a system
 * keyring waiting on its password prompt, so that line is a warning.
 */

import {
  SvalLog,
  describeError,
} from "moz-src:///browser/components/sval/SvalLog.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/**
 * How long a wait the running task asked for may stay unanswered before it is
 * called a re-entry. Far below a test's time limit, so the report names the
 * queue before the harness times the test out; far above any task Sval runs.
 */
export const REENTRY_GRACE_MS = 3000;

/** How long a task may run before a release build logs it. */
export const STALL_MS = 30_000;

/** Numbers each queue, so one queue's frames never match another's. */
let created = 0;

/** Matches a task's frame name in a stack. */
const TASK_FRAME = /svalQueue_\d+_\d+_(?=@)/g;

/**
 * Where each task not yet finished was queued from, by frame name, under
 * automation. A task starts in a promise job of its own queue, so its stack
 * begins there and says nothing of the task on another queue that queued it.
 */
const queuedFrom = new Map();

/**
 * `stack`, followed by where each task in it was queued from, and so on back.
 * This is the path a wait took across queues.
 *
 * @param {string} stack
 * @returns {string}
 */
function causalPath(stack) {
  let path = stack;
  const seen = new Set();
  for (let grew = true; grew; ) {
    grew = false;
    for (const [frame] of path.matchAll(TASK_FRAME)) {
      if (seen.has(frame)) {
        continue;
      }
      seen.add(frame);
      const origin = queuedFrom.get(frame);
      if (origin) {
        path += `queued by ${frame} from:\n${origin}`;
        grew = true;
      }
    }
  }
  return path;
}

/** One queue: its tasks run one at a time, in the order they were queued. */
export class SvalSerialQueue {
  #what;
  #graceMs;
  #frameStem;
  #tail = Promise.resolve();
  #queued = 0;
  /** `{ frame, n, since, stalled }` for the task running, or null. */
  #running = null;

  /**
   * @param {string} name What a report calls this queue. It is logged, so it
   *   names code, never anything the user is browsing.
   * @param {object} [options]
   * @param {number} [options.graceMs] {@link REENTRY_GRACE_MS}, for tests.
   */
  constructor(name, { graceMs = REENTRY_GRACE_MS } = {}) {
    this.#what = name;
    this.#graceMs = graceMs;
    this.#frameStem = `svalQueue_${++created}_`;
  }

  /**
   * Runs `work` after everything already queued.
   *
   * @param {Function} work Called with no arguments; may return a promise.
   * @returns {Promise<*>} settles as `work` does. Wait on it from outside the
   *   queue; a task that only needs the work done later uses `post`.
   */
  run(work) {
    return this.#guard(this.#push(work));
  }

  /**
   * Queues `work` and waits for nothing. A failure is logged and the queue
   * goes on.
   *
   * @param {Function} work
   */
  post(work) {
    this.#push(work).catch(err =>
      SvalLog.warn(`${this.#what} failed: ${describeError(err)}`)
    );
  }

  /**
   * @returns {Promise<void>} resolves once everything queued so far has
   *   settled, however it settled.
   */
  idle() {
    return this.#guard(this.#tail);
  }

  #push(work) {
    this.#noteStall();
    const n = ++this.#queued;
    const frame = `${this.#frameStem}${n}_`;
    // A function defined as a computed property takes the key as its name,
    // and its frame in a stack carries it.
    const named = { [frame]: () => work() }[frame];
    if (Cu.isInAutomation) {
      queuedFrom.set(frame, new Error().stack ?? "");
    }
    const task = this.#tail.then(async () => {
      this.#running = { frame, n, since: ChromeUtils.now(), stalled: false };
      try {
        return await named();
      } finally {
        this.#running = null;
        queuedFrom.delete(frame);
      }
    });
    this.#tail = task.then(
      () => {},
      () => {}
    );
    return task;
  }

  #guard(promise) {
    this.#noteStall();
    const running = this.#running;
    if (!running || !Cu.isInAutomation) {
      return promise;
    }
    const stack = causalPath(new Error().stack ?? "");
    if (!stack.includes(`${running.frame}@`)) {
      return promise;
    }
    const waited = Promise.withResolvers();
    promise.then(waited.resolve, waited.reject);
    lazy.setTimeout(() => {
      if (this.#running !== running) {
        return;
      }
      const err = new Error(
        `${this.#what}: task ${running.n} is waiting for its own queue, ` +
          `which cannot move until that task ends. The wait was asked for ` +
          `at:\n${stack}`
      );
      err.name = "SvalQueueReentry";
      SvalLog.error(describeError(err));
      waited.reject(err);
      // Whoever waited may catch the rejection and carry on. This one is
      // caught by nobody, so the harness fails the test with it.
      Promise.reject(err);
    }, this.#graceMs);
    return waited.promise;
  }

  #noteStall() {
    const running = this.#running;
    if (!running || running.stalled) {
      return;
    }
    const seconds = Math.round((ChromeUtils.now() - running.since) / 1000);
    if (seconds * 1000 >= STALL_MS) {
      running.stalled = true;
      SvalLog.warn(
        `${this.#what}: task ${running.n} has run for ${seconds} s, holding ` +
          `back everything queued behind it`
      );
    }
  }
}
