/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */
/* import-globals-from history_head.js */
/* import-globals-from history_shared_head.js */

const { CURRENT_WEEK_PUBLISH_MS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalHistorySync.sys.mjs"
);

// A device writes the current week to the shared folder at most once per
// interval, and a delete at once (history-sync spec §4.1).

add_task(async function the_current_week_publishes_once_per_interval() {
  const a = await device("hist-interval");
  const alice = a.make();
  const aliceHistory = new FakeHistory();
  const aliceSync = await historyOn(alice, aliceHistory);

  const bobHistory = new FakeHistory();
  const bob = new SvalEngine({
    root: await makeTempDir("sval-hist-interval-b-local"),
    sharedRoot: a.shared,
    keyBytes: a.keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  registerCleanupFunction(() => bob.terminate());
  const bobSync = await historyOn(bob, bobHistory);

  const exchange = async (aliceAt = Date.now()) => {
    for (let i = 0; i < 3; i++) {
      await step(alice, aliceSync, aliceAt);
    }
    for (let i = 0; i < 3; i++) {
      await step(bob, bobSync);
    }
  };

  const at = Date.now();
  aliceHistory.visit("https://first.example/", at);
  await exchange();
  Assert.ok(
    bobHistory.has("https://first.example/", at),
    "the first write of the week reaches the other device at once"
  );

  aliceHistory.visit("https://second.example/", at + 1);
  await exchange();
  Assert.ok(
    !bobHistory.has("https://second.example/", at + 1),
    "a visit within the interval waits on this device"
  );

  aliceHistory.deletePage("https://first.example/");
  await exchange();
  Assert.ok(
    !bobHistory.has("https://first.example/", at),
    "a delete reaches the other device without waiting out the interval"
  );
  Assert.ok(
    bobHistory.has("https://second.example/", at + 1),
    "the visit that waited goes with it"
  );

  aliceHistory.visit("https://third.example/", at + 2);
  await exchange();
  Assert.ok(
    !bobHistory.has("https://third.example/", at + 2),
    "the delete's write starts the interval again"
  );
  await exchange(Date.now() + CURRENT_WEEK_PUBLISH_MS);
  Assert.ok(
    bobHistory.has("https://third.example/", at + 2),
    "once the interval has passed, the next step publishes the week"
  );
});
