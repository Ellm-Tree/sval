/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_first_run_helpers.js */
/* import-globals-from sval_first_run_scenario_helpers.js */

for (const helpers of [
  "sval_first_run_helpers.js",
  "sval_first_run_scenario_helpers.js",
]) {
  Services.scriptloader.loadSubScript(
    getRootDirectory(gTestPath) + helpers,
    this
  );
}

/**
 * A quit or close-tabs warning replaces first run's dialog
 * (`replaceDialogIfOpen`), and cancelling the warning leaves the window open
 * without it (first-run spec §3.3, §8). Startup goes on and the window has
 * its workspace, but first run records nothing done, so the next launch asks
 * again: the profile on disk says first run started and did not end. What a
 * step applied as it was chosen stays, for that launch to preset, and what
 * a step holds until the questions end (`SvalFirstRunModel.HELD_STEPS`), the
 * search engine, was never written.
 */
add_task(async function a_replaced_dialog_leaves_first_run_to_ask_again() {
  keepFirstRunChoices();
  const search = SvalSettingsSync.searchService();
  const before = await search.currentId();
  const doc = await firstRunShown();
  await walkTo(doc, STEPS.search);
  const other = before === "startpage" ? "ddg" : "startpage";
  await firstRunSearch(doc, other);
  await walkTo(doc, STEPS.more);
  pick(doc, "right");
  await TestUtils.waitForCondition(
    () => SvalPanel.settings.placement === "right",
    "the side is applied as it is chosen"
  );

  gDialogBox.replaceDialogIfOpen();
  await within(SvalPanel.started, 40_000, "the panel's startup");
  Assert.equal(
    (await workspacesInEngine()).length,
    1,
    "the window, still open, has its workspace"
  );
  // The settings store writes a change soon after it, not with it.
  let onDisk;
  await TestUtils.waitForCondition(async () => {
    onDisk = await IOUtils.readJSON(SvalLocalSettings.profilePath());
    return onDisk.placement === "right";
  }, "the panel's side is kept on disk");
  Assert.strictEqual(onDisk.firstRunStarted, true, "first run started");
  Assert.notStrictEqual(onDisk.firstRunDone, true, "and is not done");
  Assert.equal(
    await search.currentId(),
    before,
    "the engine the dialog held was never written"
  );
});
