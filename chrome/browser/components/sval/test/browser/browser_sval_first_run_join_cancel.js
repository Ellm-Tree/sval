/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Cancel on first run's code step gives the code up: Skip Setup afterwards
 * leaves nothing claiming it in the background (first-run spec §3.2). The
 * folder step takes the `sval` folder itself as the folder holding it.
 */

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_first_run_helpers.js */
/* import-globals-from sval_join_scenario_helpers.js */

for (const helpers of [
  "sval_first_run_helpers.js",
  "sval_join_scenario_helpers.js",
]) {
  Services.scriptloader.loadSubScript(
    getRootDirectory(gTestPath) + helpers,
    this
  );
}

add_task(async function cancel_while_waiting_leaves_nothing_claiming() {
  keepFirstRunPrefs();
  const doc = await firstRunShown();
  const { shared, code, offerPath } = await theOtherDevice();
  await IOUtils.remove(offerPath);
  MockFilePicker.useDirectory(PathUtils.join(shared, "sval"));

  await joinUpToWaiting(doc, code, noOwnWorkspace());
  Assert.equal(SvalPanel.sharedRootSetting(), shared, "its folder is stored");
  Assert.ok(SvalPanel._firstRunJoin, "the code is being claimed");
  button(doc, "cancel").click();
  Assert.equal(
    shownSection(doc).dataset.join,
    "idle",
    "the code step stops waiting"
  );
  Assert.equal(SvalPanel._firstRunJoin, null, "and gives the claim up");
  await endWith(doc, "later");
  await within(SvalPanel.started, 40_000, "the panel's startup");
  Assert.ok(SvalPanel.settings.firstRunDone, "first run is done");
  Assert.ok(!SvalFirstRun.pairing, "and nothing goes on claiming");
});
