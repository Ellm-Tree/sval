/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */

/**
 * Devices that meet in one shared folder (local-copy spec): what this device
 * reads of a peer there, and the profile write that reading makes.
 */

add_task(
  async function published_tree_reads_the_shared_folder_through_the_helper() {
    const { shared, keyBytes, make } = await device("published");
    const peer = await peerPublishes(shared, keyBytes);
    const engine = make();
    Assert.ok(
      peer.id in JSON.parse(await engine.publishedTree(WORKSPACE)).nodes,
      "the peer's workspace is in what is published"
    );
    engine.setSharedRoot(missingFolder("published"));
    await Assert.rejects(
      engine.publishedTree(WORKSPACE),
      err => err.code === "shared_folder_unreachable",
      "an unreachable folder is an error the caller can tell apart"
    );
  }
);

/** The profile write a shared step makes is the pass's write, too. */
add_task(async function a_profile_write_made_by_the_shared_step_is_reported() {
  const { local, shared, keyBytes, make } = await device("step-write");
  const engine = make();
  await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
  await engine.sync(WORKSPACE, 2000);

  const peer = await peerPublishes(shared, keyBytes);
  const report = await engine.sync(WORKSPACE, 3000);
  Assert.equal(report.shared, "reached");
  Assert.notEqual(
    report.wrote,
    null,
    "the profile copy that took in the peer's workspace was written"
  );
  Assert.ok(peer.id in (await readBack(local, keyBytes)));
});
