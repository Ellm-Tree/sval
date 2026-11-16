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
 * A profile that holds this device's Sval file with no workspace in it is
 * skipped without a record (first-run spec §9): it may be one emptied by
 * hand. This profile's first launch ran with first run off and wrote its
 * file; once its workspaces are gone and first run is on, the window opened
 * next starts as a launch does, and finds the file.
 */
add_task(async function a_profile_holding_a_sval_file_is_not_asked() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const { engine } = SvalPanel;
  for (const id of await workspacesInEngine()) {
    await engine.mutate({ kind: "remove", id, now: Date.now() });
  }
  Assert.deepEqual(
    await workspacesInEngine(),
    [],
    "the profile holds no workspace"
  );
  const report = await engine.sync(SYNC_DOCUMENT, Date.now());
  Assert.ok(report.hadLocalCopy, "and holds this device's file");

  await SpecialPowers.pushPrefEnv({ set: [[FIRST_RUN_PREF, true]] });
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    10_000,
    "the new window's opening"
  );
  await within(win.SvalPanel.started, 40_000, "the new window's startup");
  Assert.ok(!win.gDialogBox.isOpen, "first run does not open");
  Assert.notStrictEqual(
    (await IOUtils.readJSON(SvalLocalSettings.profilePath())).firstRunDone,
    true,
    "and nothing is recorded"
  );
  await within(
    BrowserTestUtils.closeWindow(win),
    10_000,
    "the new window's close"
  );
});
