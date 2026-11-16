/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */
/* import-globals-from history_head.js */
/* import-globals-from history_shared_head.js */

const { failEngineCalls } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestFault.sys.mjs"
);

// A week whose exchange failed counts as published only once a later step
// has exchanged it (history-sync spec §3).

add_task(async function a_week_whose_exchange_failed_is_published_next_step() {
  const a = await device("hist-exchange");
  const old = Date.now() - 3 * WEEK_MS;
  const week = weekOf(old);
  const alice = a.make();
  // The week's own exchange fails in the first two steps that reach the
  // folder, which go on with the other documents: as many steps as would
  // have let the week go, had they counted.
  const fault = failEngineCalls(alice, "mergeSnapshot", {
    when: args => args[0].workspace === week,
    times: 2,
  });
  const aliceSync = await historyOn(
    alice,
    new FakeHistory([
      { url: "https://exchange.example/", visitedAt: old, title: "Exchange" },
    ])
  );

  const bobHistory = new FakeHistory();
  const bob = new SvalEngine({
    root: await makeTempDir("sval-hist-exchange-b-local"),
    sharedRoot: a.shared,
    keyBytes: a.keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  registerCleanupFunction(() => bob.terminate());
  const bobSync = await historyOn(bob, bobHistory);

  // Steps until both have run: the week loads once the seed has written it.
  for (let i = 0; i < 6 && fault.fired < 2; i++) {
    Assert.equal((await step(alice, aliceSync)).shared, "reached");
  }
  Assert.equal(fault.fired, 2, "the week's exchange failed in two steps");
  for (let i = 0; i < 3; i++) {
    await step(bob, bobSync);
  }
  Assert.ok(
    !bobHistory.has("https://exchange.example/", old),
    "the other device has nothing of a week that was not exchanged"
  );

  for (let i = 0; i < 2; i++) {
    await step(alice, aliceSync);
  }
  for (let i = 0; i < 3; i++) {
    await step(bob, bobSync);
  }
  Assert.ok(
    bobHistory.has("https://exchange.example/", old),
    "a later step publishes it, and the other device has the visit"
  );
});
