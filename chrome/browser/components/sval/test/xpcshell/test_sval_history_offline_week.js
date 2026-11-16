/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */
/* import-globals-from history_head.js */
/* import-globals-from history_shared_head.js */

// A week written while the shared folder was away counts as published only
// once a step has reached the folder with it (history-sync spec §3).

add_task(async function a_week_written_offline_reaches_a_peer_once_back() {
  const a = await device("hist-offline");
  const away = `${a.shared}-away`;
  await IOUtils.move(a.shared, away);

  // A visit from three weeks ago, which only the seed writes, so its week is
  // never the current one and is let go once published.
  const old = Date.now() - 3 * WEEK_MS;
  const alice = a.make();
  const aliceSync = await historyOn(
    alice,
    new FakeHistory([
      { url: "https://offline.example/", visitedAt: old, title: "Offline" },
    ])
  );
  // Enough steps for the week to have been let go twice over, had they
  // counted: once after its write, once after the index named it.
  for (let i = 0; i < 6; i++) {
    Assert.equal(
      (await step(alice, aliceSync)).shared,
      "unreachable",
      "the folder is away"
    );
  }

  await IOUtils.move(away, a.shared);
  for (let i = 0; i < 3; i++) {
    Assert.equal(
      (await step(alice, aliceSync)).shared,
      "reached",
      "the folder is back"
    );
  }

  const bobHistory = new FakeHistory();
  const bob = new SvalEngine({
    root: await makeTempDir("sval-hist-offline-b-local"),
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
    bobHistory.has("https://offline.example/", old),
    "the visit made while the folder was away reached the other device"
  );
});
