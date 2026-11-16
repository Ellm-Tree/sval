/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */
/* import-globals-from history_head.js */

// What the files about history sync over a real shared folder share
// (history-sync spec §3).

/* exported weekOf, WEEK_MS, historyOn, step */

const { SvalHistorySync, weekOf } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalHistorySync.sys.mjs"
);

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * `engine`'s history sync over `history`, started.
 *
 * @param {SvalEngine} engine
 * @param {FakeHistory} history
 * @returns {Promise<SvalHistorySync>}
 */
async function historyOn(engine, history) {
  const sync = new SvalHistorySync({
    engine,
    places: history,
    storage: memoryStorage(),
    requestPass: () => {},
  });
  registerCleanupFunction(() => sync.stop());
  await sync.start();
  return sync;
}

/**
 * One shared step for `engine`, and everything history does after it.
 *
 * @param {SvalEngine} engine
 * @param {SvalHistorySync} sync
 * @param {number} [now] When the step runs.
 * @returns {Promise<object>} the step's report.
 */
async function step(engine, sync, now = Date.now()) {
  await within(sync.whenIdle(), 10_000, "sync going idle");
  const report = await engine.sync(WORKSPACE, now, { shared: "wait" });
  await within(sync.whenIdle(), 10_000, "sync going idle");
  return report;
}
