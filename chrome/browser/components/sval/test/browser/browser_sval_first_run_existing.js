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
 * A profile that already has a workspace has what first run sets up, so it
 * is never asked, and is recorded as done without asking (first-run spec
 * §3). This profile's first launch ran with first run off and made its
 * workspace; the window opened once first run is on starts as a launch
 * does, and finds it.
 */
add_task(async function a_profile_with_a_workspace_is_never_asked() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  Assert.equal((await workspacesInEngine()).length, 1, "it has a workspace");
  const settingsPath = SvalLocalSettings.profilePath();
  Assert.notStrictEqual(
    (await IOUtils.readJSON(settingsPath)).firstRunDone,
    true,
    "and no record of first run"
  );

  await SpecialPowers.pushPrefEnv({ set: [[FIRST_RUN_PREF, true]] });
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    10_000,
    "the new window's opening"
  );
  await within(win.SvalPanel.started, 40_000, "the new window's startup");
  Assert.ok(!win.gDialogBox.isOpen, "a profile with a workspace is not asked");
  Assert.strictEqual(
    (await IOUtils.readJSON(settingsPath)).firstRunDone,
    true,
    "and is recorded as done"
  );
  await within(
    BrowserTestUtils.closeWindow(win),
    10_000,
    "the new window's close"
  );
});
