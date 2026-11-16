/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */

/**
 * A shared-folder helper that hangs (local-copy spec §6 test 4): it is given
 * up and killed at the limit, requests behind it wait their turn, no second
 * helper joins it, its request's files go with it, and quitting kills it.
 *
 * The hang is a real named pipe the real helper reads as a payload, or a
 * stand-in that never answers, so these run only where `mkfifo` and
 * `/bin/sh` exist. Quitting comes last, because after it this process starts
 * no helper.
 */

/**
 * Writes one byte to `sval/ws/abc/<name>` under `root`.
 *
 * @param {string} root
 * @param {string} name
 * @param {number} [ms] How long the request may take.
 * @returns {Promise<object>} Its answer.
 */
function writeOne(root, name, ms = SHARED_STEP_TIMEOUT_MS) {
  return SvalSharedFolder.writeFile({
    root,
    path: `sval/ws/abc/${name}`,
    bytes: new Uint8Array([1]),
    requireTop: "sval",
    deadline: deadline(ms),
  });
}

/** Spec §6 test 4, the helper half. */
add_task(
  { skip_if: noFifo },
  async function a_hung_read_is_given_up_at_the_limit_and_sval_carries_on() {
    const root = await chosenFolder("hang");
    const { fifo } = hangNextWrite();
    try {
      const started = Date.now();
      const writing = writeOne(root, "me.json", 2000);
      await fifo;
      const next = SvalSharedFolder.exists({
        root,
        path: "sval",
        deadline: deadline(),
      });
      Assert.deepEqual(await writing, { reachable: false, reason: "timeout" });
      // A read nobody gave up would hang until the pipe was released, which
      // nothing here does.
      Assert.less(
        Date.now() - started,
        5000,
        "sval stopped waiting at the limit"
      );
      Assert.deepEqual(
        await next,
        { reachable: true, exists: true },
        "the request queued behind it ran once its helper was killed"
      );
      await SvalSharedFolder._whenIdle();
    } finally {
      await IOUtils.remove(await fifo, { ignoreAbsent: true });
    }
  }
);

/**
 * Spec §6 test 4: at most one helper alive. A request behind a helper the
 * operating system will not let die waits only until its own deadline, and
 * answers "busy" without starting a helper; once that helper exits, the next
 * request runs.
 */
add_task(
  { skip_if: noFifo },
  async function a_request_behind_a_stuck_helper_answers_busy_at_its_deadline() {
    const root = await chosenFolder("one-alive");
    await SvalSharedFolder.release();
    await SvalSharedFolder._whenIdle();
    useStuckHelper();
    // Stands in for a helper the operating system will not let die: a read
    // on a hard NFS mount that has gone away cannot be interrupted.
    const realKill = SvalSharedFolder._kill;
    SvalSharedFolder._kill = () => {};
    let starts = 0;
    const realStart = SvalSharedFolder._start;
    try {
      Assert.deepEqual(await writeOne(root, "me.json", STUCK_DEADLINE_MS), {
        reachable: false,
        reason: "timeout",
      });
      Assert.ok(SvalSharedFolder.busy, "the stuck helper is still alive");

      SvalSharedFolder._start = (...args) => {
        starts++;
        return realStart.apply(SvalSharedFolder, args);
      };
      const started = Date.now();
      Assert.deepEqual(
        await SvalSharedFolder.exists({
          root,
          path: "sval",
          deadline: deadline(1000),
        }),
        { reachable: false, reason: "busy" },
        "the request behind it answers busy"
      );
      Assert.less(Date.now() - started, 5000, "at its own deadline");
      Assert.equal(starts, 0, "without starting a helper");
    } finally {
      SvalSharedFolder._start = realStart;
      SvalSharedFolder._kill = realKill;
      await endStuckHelper();
    }
    Assert.deepEqual(
      await SvalSharedFolder.exists({
        root,
        path: "sval",
        deadline: deadline(),
      }),
      { reachable: true, exists: true },
      "once the stuck helper has gone, the next request runs"
    );
  }
);

/** Requests made while a helper is inside its 20 s wait their turn. */
add_task(
  { skip_if: noFifo },
  async function requests_made_while_a_helper_runs_all_complete_in_turn() {
    const root = await chosenFolder("busy-now");
    const { fifo } = hangNextWrite();
    try {
      const slow = writeOne(root, "slow.json");
      await fifo;
      const asking = SvalSharedFolder.exists({
        root,
        path: "sval",
        deadline: deadline(),
      });
      const writing = writeOne(root, "me.json");

      await releaseFifo(await fifo);
      Assert.deepEqual(await slow, { reachable: true }, "the first finished");
      Assert.deepEqual(
        await asking,
        { reachable: true, exists: true },
        "and the one behind it"
      );
      Assert.deepEqual(
        await writing,
        { reachable: true },
        "and the one behind that"
      );
      Assert.deepEqual(
        await IOUtils.read(
          PathUtils.join(root, "sval", "ws", "abc", "me.json")
        ),
        new Uint8Array([1]),
        "which wrote its file"
      );
      await SvalSharedFolder._whenIdle();
      Assert.ok(!SvalSharedFolder.busy, "and nothing is left waiting");
    } finally {
      await IOUtils.remove(await fifo, { ignoreAbsent: true });
    }
  }
);

/**
 * A request's files go when it ends, before it answers, even while its
 * helper lives on.
 */
add_task({ skip_if: noFifo }, async function a_requests_files_go_with_it() {
  const root = await chosenFolder("request-files");
  await SvalSharedFolder.release();
  await SvalSharedFolder._whenIdle();
  useStuckHelper();
  const realKill = SvalSharedFolder._kill;
  SvalSharedFolder._kill = () => {};
  const payloads = [];
  const realWrite = SvalSharedFolder._writePayload;
  SvalSharedFolder._writePayload = (path, bytes) => {
    payloads.push(path);
    return realWrite.call(SvalSharedFolder, path, bytes);
  };
  try {
    Assert.deepEqual(await writeOne(root, "me.json", STUCK_DEADLINE_MS), {
      reachable: false,
      reason: "timeout",
    });
    Assert.equal(payloads.length, 1, "the request wrote its payload");
    Assert.ok(
      !(await IOUtils.exists(payloads[0])),
      "and the request's files went with it"
    );
    Assert.ok(SvalSharedFolder.busy, "while the helper lives on");
  } finally {
    SvalSharedFolder._writePayload = realWrite;
    SvalSharedFolder._kill = realKill;
    await endStuckHelper();
  }
  Assert.ok(!SvalSharedFolder.busy, "the killed helper exited");
});

/**
 * Spec §6 test 4a, the helper half: quitting kills a live helper without
 * waiting for it, ends the request it was running and every request behind
 * it, and leaves none of its request's files behind.
 */
add_task(
  { skip_if: noFifo },
  async function quitting_kills_a_live_helper_without_waiting() {
    const root = await chosenFolder("quit");
    const { fifo } = hangNextWrite();
    const realKill = SvalSharedFolder._kill;
    let killed = 0;
    SvalSharedFolder._kill = proc => {
      killed++;
      realKill.call(SvalSharedFolder, proc);
    };
    try {
      const writing = writeOne(root, "me.json");
      const payload = await fifo;
      const queued = SvalSharedFolder.exists({
        root,
        path: "sval",
        deadline: deadline(),
      });

      const started = Date.now();
      Services.obs.notifyObservers(null, "quit-application");
      Assert.deepEqual(
        await writing,
        { reachable: false, reason: "busy" },
        "the running request ended"
      );
      Assert.deepEqual(
        await queued,
        { reachable: false, reason: "busy" },
        "and so did the one behind it"
      );
      Assert.less(Date.now() - started, 5000, "without waiting for either");
      Assert.equal(killed, 1, "and the helper was killed, once");
      Assert.ok(
        !(await IOUtils.exists(payload)),
        "and the running request's files are gone"
      );
      Assert.deepEqual(
        await SvalSharedFolder.exists({
          root,
          path: "sval",
          deadline: deadline(),
        }),
        { reachable: false, reason: "busy" },
        "a request after quit answers busy, without starting a helper"
      );
    } finally {
      SvalSharedFolder._kill = realKill;
      await SvalSharedFolder._whenIdle();
      await IOUtils.remove(await fifo, { ignoreAbsent: true });
    }
  }
);
