/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */
/* import-globals-from history_head.js */
/* import-globals-from history_shared_head.js */

const { HISTORY_INDEX } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalHistorySync.sys.mjs"
);

// A week counts as published only once a step has exchanged the index that
// announces it (history-sync spec §3), so a quit between the index naming
// the week and a pass writing the index loses nothing.

add_task(async function a_week_announced_just_before_quitting_reaches_a_peer() {
  const a = await device("hist-announce");
  // The state file, which outlives the quit.
  const storage = memoryStorage();
  const launch = async history => {
    const engine = a.make();
    const sync = new SvalHistorySync({
      engine,
      places: history,
      storage,
      requestPass: () => {},
    });
    registerCleanupFunction(() => sync.stop());
    await sync.start();
    return { engine, sync };
  };

  // A visit from three weeks ago, which only the seed writes, so its week is
  // never the current one.
  const old = Date.now() - 3 * WEEK_MS;
  const week = weekOf(old);
  const first = await launch(
    new FakeHistory([
      { url: "https://announced.example/", visitedAt: old, title: "Late" },
    ])
  );
  const named = async () =>
    (await first.engine.shards(HISTORY_INDEX)).some(s => s.name === week);
  for (let i = 0; i < 4 && !(await named()); i++) {
    Assert.equal(
      (await step(first.engine, first.sync)).shared,
      "reached",
      "the folder is there"
    );
  }
  Assert.ok(await named(), "the index names the week");

  // Quit before any pass writes the index: the last pass at quit did not
  // finish, or Sval did not get to run it.
  first.sync.stop();
  first.engine.terminate();

  const second = await launch(new FakeHistory());
  for (let i = 0; i < 3; i++) {
    await step(second.engine, second.sync);
  }

  const bobHistory = new FakeHistory();
  const bob = new SvalEngine({
    root: await makeTempDir("sval-hist-announce-b-local"),
    sharedRoot: a.shared,
    keyBytes: a.keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  registerCleanupFunction(() => bob.terminate());
  const bobSync = await historyOn(bob, bobHistory);
  for (let i = 0; i < 3; i++) {
    await step(bob, bobSync);
  }

  Assert.ok(
    bobHistory.has("https://announced.example/", old),
    "the visit reached the other device after the next start"
  );
});
