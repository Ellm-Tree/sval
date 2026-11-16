/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Private windows sign in to Kagi whenever Kagi becomes the default engine,
 * by any route (first-run spec §5): Sval's watch on the search engine starts
 * Kagi's header then. The watch runs one check for every change, the one at
 * launch included (`SvalKagi.watchSearch`), so a change of engine stands for
 * a launch with Kagi as the engine.
 */

const { SvalKagi } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalKagi.sys.mjs"
);
const { SvalSettingsSync } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSettingsSync.sys.mjs"
);

/* import-globals-from ../../sval-panel.js */

add_task(async function kagi_starts_when_it_becomes_the_engine() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const search = SvalSettingsSync.searchService();
  const before = await search.currentId();
  registerCleanupFunction(async () => {
    await within(
      search.setById(before),
      10_000,
      "putting back the search engine"
    );
    SvalKagi.stop();
  });
  Assert.equal(await SvalKagi.token(), null, "no Session Link is stored");
  await within(search.setById("ddg"), 10_000, "setting ddg as the engine");
  SvalKagi.stop();
  Assert.ok(!SvalKagi._started, "Kagi is stopped under another engine");

  await within(search.setById("kagi"), 10_000, "setting kagi as the engine");
  await TestUtils.waitForCondition(() => SvalKagi._started, "Kagi starts");
});
