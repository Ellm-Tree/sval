/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */

/**
 * A background step that is still running when its folder is replaced or
 * removed, or the document is re-keyed, touches nothing that now belongs to
 * the new choice (local-copy spec).
 */

/**
 * Re-keying while a shared step is reading leaves that step's snapshot, read
 * under the old key, out of the re-keyed document.
 */
add_task(
  async function a_step_in_flight_never_merges_into_a_rekeyed_document() {
    const { shared, keyBytes, make } = await device("rekeyed");
    const old = await peerPublishes(shared, keyBytes);
    const engine = make();
    await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
    await engine.sync(WORKSPACE, 1500, { shared: "skip" });

    const realReadDir = SvalSharedFolder.readDirs;
    let release;
    const gate = new Promise(done => (release = done));
    let reading;
    const started = new Promise(done => (reading = done));
    SvalSharedFolder.readDirs = async function (...args) {
      reading();
      await gate;
      return realReadDir.apply(this, args);
    };
    const merged = [];
    const realPost = engine.post.bind(engine);
    engine.post = (method, ...args) => {
      if (method == "mergeSnapshot") {
        merged.push(Array.from(args[0][0].keyBytes));
      }
      return realPost(method, ...args);
    };
    const newKey = crypto.getRandomValues(new Uint8Array(32));
    try {
      await engine.sync(WORKSPACE, 2000, { shared: "background" });
      await started;
      engine.useSyncKey(newKey);
    } finally {
      SvalSharedFolder.readDirs = realReadDir;
      release();
    }
    // Runs after the step in flight has finished, and starts one of its own.
    await engine.sync(WORKSPACE, 3000);
    engine.post = realPost;

    Assert.greater(merged.length, 0, "the pass after the re-key merged");
    Assert.ok(
      merged.every(key => key.join() === Array.from(newKey).join()),
      "nothing was merged under the old key"
    );
    Assert.ok(
      !(old.id in (await engine.tree()).nodes),
      "and the old document's workspace is not in the re-keyed one"
    );
  }
);

/**
 * A step for a folder that has since been replaced answers with a profile pass
 * and touches nothing the new choice owns.
 */
add_task(
  async function a_step_for_a_replaced_folder_leaves_the_new_one_alone() {
    const { shared: a, keyBytes, make } = await device("replaced");
    await peerPublishes(a, keyBytes);
    const b = await chosenFolder("replaced-b");
    const engine = make();
    await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
    const heard = [];
    const stop = engine.addSharedListener(report => heard.push(report));
    try {
      await engine.sync(WORKSPACE, 2000, { shared: "background" });
      // The step for `a` has started and cannot have finished.
      engine.setSharedRoot(b);

      const report = await engine.sync(WORKSPACE, 3000);
      Assert.equal(
        report.shared,
        "reached",
        "b is reached by a step of its own"
      );
      Assert.notEqual(
        report.sharedWrote,
        null,
        "and receives this device's file"
      );
      Assert.ok(await IOUtils.exists(resolve(b, report.sharedWrote)));
      Assert.equal(heard.length, 1, "only b's step was reported");
      Assert.equal(heard[0].sharedWrote, report.sharedWrote);
    } finally {
      stop();
    }
  }
);

add_task(async function a_step_for_a_removed_folder_leaves_none_chosen() {
  const { shared, keyBytes, make } = await device("removed");
  await peerPublishes(shared, keyBytes);
  const engine = make();
  await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
  const heard = [];
  const stop = engine.addSharedListener(report => heard.push(report));
  try {
    await engine.sync(WORKSPACE, 2000, { shared: "background" });
    engine.setSharedRoot(null);
    // `shared` is masked to "none" while no folder is chosen, so this does
    // not detect a stale step that marked the state; the checks below do.
    const report = await engine.sync(WORKSPACE, 3000);
    Assert.equal(report.shared, "none");

    // Choosing a folder again and waiting runs after the stale step has
    // finished, so what it left behind is what this step starts from.
    const fresh = await chosenFolder("removed-again");
    engine.setSharedRoot(fresh);
    const after = await engine.sync(WORKSPACE, 4000);
    Assert.equal(after.shared, "reached", "the new folder is reached");
    Assert.notEqual(after.sharedWrote, null, "by a first publish of its own");
    Assert.ok(await IOUtils.exists(resolve(fresh, after.sharedWrote)));
    Assert.equal(heard.length, 1, "and only that step was reported");
  } finally {
    stop();
  }
});
