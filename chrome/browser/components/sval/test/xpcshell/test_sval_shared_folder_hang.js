/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */

/**
 * A shared folder whose helper hangs (local-copy spec §6 test 4): a stand-in
 * helper that says hello and never answers (`useStuckHelper`), so these run
 * only where `/bin/sh` exists.
 */

const { AsyncShutdown } = ChromeUtils.importESModule(
  "resource://gre/modules/AsyncShutdown.sys.mjs"
);

/** Spec §6 test 4. */
add_task(
  { skip_if: noFifo },
  async function a_hung_folder_does_not_hold_up_the_profile_write() {
    const { local, keyBytes, make } = await device("hang");
    await SvalSharedFolder.release();
    await SvalSharedFolder._whenIdle();
    useStuckHelper();
    const engine = make({ sharedStepTimeoutMs: 2000 });
    try {
      const started = Date.now();
      const first = await engine.sync(WORKSPACE, 3000);
      Assert.equal(
        first.shared,
        "unreachable",
        "a read that hangs is given up"
      );
      // A helper nobody gave up on would never answer.
      Assert.less(Date.now() - started, 5000, "at the limit");

      // A write that waited for a hung read would take the step's whole
      // allowance, so it is made long and the write must take under half.
      engine.sharedStepTimeoutMs = 20_000;
      const before = Date.now();
      const id = await engine.mutate({
        kind: "addWorkspace",
        name: "Made during the hang",
        now: 4000,
      });
      const second = await engine.sync(WORKSPACE, 5000, {
        shared: "background",
      });
      Assert.less(
        Date.now() - before,
        10_000,
        "a local change and its write did not wait for the hung read"
      );
      Assert.notEqual(second.wrote, null, "and the profile copy was written");
      Assert.ok(id in (await readBack(local, keyBytes)));
    } finally {
      await endStuckHelper();
    }
  }
);

/** Spec §6 test 4a. */
add_task(
  { skip_if: noFifo },
  async function quitting_with_a_stuck_helper_keeps_the_change_locally() {
    const { local, shared, keyBytes, deviceId } = await device("quit-hang");
    const barrier = new AsyncShutdown.Barrier("sval test: quit during a hang");
    SvalEngine.setShutdownClient(barrier.client, { timeoutMs: 1000 });
    const engine = SvalEngine.forProfile({
      root: local,
      sharedRoot: shared,
      keyBytes,
      deviceId,
    });
    const realKill = SvalSharedFolder._kill;
    try {
      await engine.sync(WORKSPACE, 1000);
      await SvalSharedFolder.release();
      await SvalSharedFolder._whenIdle();
      useStuckHelper();
      // The helper the operating system will not let die.
      SvalSharedFolder._kill = () => {};
      engine.setSharedRoot(shared);
      await engine.sync(WORKSPACE, 1500, { shared: "background" });
      await waitForCondition(() => SvalSharedFolder.busy, "stuck");
      const id = await engine.mutate({
        kind: "addWorkspace",
        name: "Made just before quitting",
        now: 2000,
      });
      const started = Date.now();
      await barrier.wait();
      // A quit that waited for the stuck helper would never end, since
      // nothing here lets it exit.
      Assert.less(Date.now() - started, 5000, "quitting was not held up");
      Assert.ok(
        id in (await readBack(local, keyBytes)),
        "and the change is in the profile copy"
      );
    } finally {
      SvalSharedFolder._kill = realKill;
      // The engine goes first: once the stand-in has gone, the background
      // step would go on to publish through a helper of its own after this
      // task had ended.
      engine.terminate();
      await endStuckHelper();
      SvalEngine.setSharedInstance(null);
      SvalEngine.setShutdownClient(null);
    }
  }
);

/** The same replacement, with the old folder's step held by a hung helper. */
add_task(
  { skip_if: noFifo },
  async function a_hung_step_for_a_replaced_folder_does_not_mark_the_new_one() {
    const { make } = await device("replaced-hang");
    await SvalSharedFolder.release();
    await SvalSharedFolder._whenIdle();
    useStuckHelper();
    const b = await chosenFolder("replaced-hang-b");
    const engine = make({ sharedStepTimeoutMs: 2000 });
    const heard = [];
    const stop = engine.addSharedListener(report => heard.push(report));
    try {
      await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
      await engine.sync(WORKSPACE, 2000, { shared: "background" });
      await waitForCondition(() => SvalSharedFolder.busy, "stuck");
      engine.setSharedRoot(b);
      // b's steps start the real helper once a's stand-in is killed.
      SvalSharedFolder._helperCommand = null;
      // a's step keeps the short limit it started with. b's steps are meant
      // to succeed, and a helper on a loaded machine can take longer than
      // that just to start.
      engine.sharedStepTimeoutMs = SHARED_STEP_TIMEOUT_MS;

      const first = await engine.sync(WORKSPACE, 3000);
      Assert.notEqual(
        first.shared,
        "unreachable",
        "b is not unreachable because a was"
      );
      await SvalSharedFolder._whenIdle();
      const second = await engine.sync(WORKSPACE, 4000);
      Assert.equal(second.shared, "reached", "the next step reaches b");
      // The first pass found a's helper still alive, or, when its kill had
      // already landed, ran b's own step.
      Assert.notEqual(
        first.sharedWrote ?? second.sharedWrote,
        null,
        "and b's own step wrote this device's file"
      );
      Assert.ok(
        await IOUtils.exists(
          resolve(b, second.sharedWrote ?? first.sharedWrote)
        )
      );
      Assert.ok(
        heard.every(report => report.shared != "unreachable"),
        "and no listener was told b is unreachable"
      );
    } finally {
      stop();
      await endStuckHelper();
      await SvalSharedFolder._whenIdle();
    }
  }
);

/**
 * A step queued behind a helper the operating system will not let die waits
 * for its turn only until its own deadline. The first such step asked the
 * folder nothing and says so, and the second in a row reports the folder
 * unreachable (decision 0032); once that helper has gone, the next step
 * reaches the folder.
 */
add_task(
  { skip_if: noFifo },
  async function a_step_behind_a_stuck_helper_is_unreachable_at_its_deadline() {
    const { make } = await device("stuck");
    await SvalSharedFolder.release();
    await SvalSharedFolder._whenIdle();
    useStuckHelper();
    const b = await chosenFolder("stuck-b");
    const engine = make({ sharedStepTimeoutMs: STUCK_DEADLINE_MS });
    const realKill = SvalSharedFolder._kill;
    try {
      // The helper the operating system will not let die.
      SvalSharedFolder._kill = () => {};
      await engine.sync(WORKSPACE, 1000, { shared: "background" });
      await waitForCondition(() => SvalSharedFolder.busy, "stuck");
      engine.sharedStepTimeoutMs = 1000;
      engine.setSharedRoot(b);
      const started = Date.now();
      const first = await engine.sync(WORKSPACE, 2000);
      Assert.equal(
        first.shared,
        "unknown",
        "a step whose turn never came asked the folder nothing"
      );
      const late = await engine.sync(WORKSPACE, 2100);
      Assert.equal(
        late.shared,
        "unreachable",
        "and a second in a row is an unreachable folder"
      );
      // The step waits for the stuck one before it, which has the longer
      // deadline, and then for its own turn for one second.
      Assert.less(
        Date.now() - started,
        STUCK_DEADLINE_MS + 5000,
        "at its own deadline"
      );
      Assert.deepEqual(
        await IOUtils.getChildren(PathUtils.join(b, TOP_DIR)),
        [],
        "and nothing was written there"
      );
      Assert.ok(SvalSharedFolder.busy, "the stuck helper is still alive");

      SvalSharedFolder._kill = realKill;
      await endStuckHelper();
      engine.sharedStepTimeoutMs = SHARED_STEP_TIMEOUT_MS;
      const next = await engine.sync(WORKSPACE, 3000);
      Assert.equal(
        next.shared,
        "reached",
        "once the stuck helper has gone, the next step reaches the folder"
      );
    } finally {
      SvalSharedFolder._kill = realKill;
      await endStuckHelper();
    }
  }
);
