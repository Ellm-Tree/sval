/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */

/**
 * The handshake's protocol check (decision 1437): a helper that speaks the
 * browser's protocol or the one before is accepted, and any other is refused
 * until Sval restarts. The refusal lasts for this process, so it has a file
 * of its own.
 */

const { HELPER_HELLO, isCompatibleHello } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
);

add_task(function a_helper_of_this_protocol_or_the_one_before_is_accepted() {
  Assert.ok(isCompatibleHello(HELPER_HELLO), "this browser's own");
  Assert.ok(isCompatibleHello(HELPER_HELLO - 1), "and the one before");
  for (const hello of [HELPER_HELLO + 1, HELPER_HELLO - 2, "1", null, 1.5]) {
    Assert.ok(!isCompatibleHello(hello), `${JSON.stringify(hello)} is not`);
  }
});

add_task(async function the_real_helper_speaks_this_browsers_protocol() {
  const root = await chosenFolder("version-real");
  Assert.deepEqual(
    await SvalSharedFolder.exists({ root, path: "sval", deadline: deadline() }),
    { reachable: true, exists: true }
  );
});

add_task(
  { skip_if: noFifo },
  async function an_incompatible_helper_is_refused_until_restart() {
    const root = await chosenFolder("version-outdated");
    await SvalSharedFolder.release();
    await SvalSharedFolder._whenIdle();
    useStuckHelper({ hello: HELPER_HELLO + 1, build: "newer" });
    const ask = () =>
      SvalSharedFolder.exists({ root, path: "sval", deadline: deadline() });
    const refused = {
      reachable: false,
      reason: "helper-failed",
      error: "HelperOutdated",
    };
    Assert.deepEqual(await ask(), refused, "the helper is refused");
    await endStuckHelper();

    let starts = 0;
    const realStart = SvalSharedFolder._start;
    SvalSharedFolder._start = (...args) => {
      starts++;
      return realStart.apply(SvalSharedFolder, args);
    };
    try {
      Assert.deepEqual(
        await ask(),
        refused,
        "and so is every request after it, with the real helper back"
      );
    } finally {
      SvalSharedFolder._start = realStart;
    }
    Assert.equal(starts, 0, "without starting another");
  }
);
