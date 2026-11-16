/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */

/**
 * Devices that meet in one shared folder (local-copy spec): what neither
 * writes while both are idle.
 */

/** Spec §6 test 11, the idle half. */
add_task(async function two_idle_devices_write_nothing_in_either_location() {
  const shared = await chosenFolder("idle-shared");
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const make = async name =>
    new SvalEngine({
      root: await makeTempDir(`sval-idle-${name}`),
      sharedRoot: shared,
      keyBytes,
      deviceId: crypto.getRandomValues(new Uint8Array(16)),
    });
  const a = await make("a");
  const b = await make("b");
  registerCleanupFunction(() => {
    a.terminate();
    b.terminate();
  });
  await a.mutate({ kind: "addWorkspace", name: "A", now: 1000 });
  await b.mutate({ kind: "addWorkspace", name: "B", now: 1000 });
  let now = 2000;
  for (let i = 0; i < 3; i++) {
    await a.sync(WORKSPACE, (now += 1000));
    await b.sync(WORKSPACE, (now += 1000));
  }
  for (let i = 0; i < 4; i++) {
    for (const engine of [a, b]) {
      const report = await engine.sync(WORKSPACE, (now += 1000));
      Assert.equal(report.wrote, null, "no profile write while idle");
      Assert.equal(report.sharedWrote, null, "and no shared write");
    }
  }
});
