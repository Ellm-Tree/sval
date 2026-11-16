/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */

/**
 * The settings document's share stays out of the tree's way: a broken share
 * does not stop the tree's, and a key adoption shares no settings. Apart from
 * test_sval_settings_shared.js to keep each file inside the harness's budget.
 */

const { failEngineCalls } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestFault.sys.mjs"
);

const SETTINGS = "settings";

add_task(async function a_broken_settings_share_leaves_the_tree_syncing() {
  const a = await device("ss-broken");
  const alice = a.make();
  await alice.addDocument(SETTINGS);
  await alice.mutate({ kind: "addWorkspace", name: "W", now: 1000 });
  const fault = failEngineCalls(alice, "mergeSnapshot", {
    when: args => args?.[0]?.workspace === SETTINGS,
  });

  const report = await alice.sync(WORKSPACE, 2000, { shared: "wait" });
  fault.mend();
  Assert.equal(report.shared, "reached", "the tree's share went on");
  Assert.notEqual(report.sharedWrote, null, "and published the tree");
});
