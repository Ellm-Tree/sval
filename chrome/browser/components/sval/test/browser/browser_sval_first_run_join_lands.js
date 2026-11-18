/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * First run's join path on a fresh profile, with the other device's offer
 * already in the folder: the code joins at once, and the device ends up
 * with the other device's workspace and settings and none of its own
 * (first-run spec §2, §3.4). The other device's history weeks, which this
 * device has not read when it joins, are its key's, so the indicator never
 * offers to pair with them.
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

add_task(async function the_join_path_makes_nothing_of_its_own() {
  keepFirstRunPrefs();
  const doc = await firstRunShown();
  const { theirs, code, level } = await theOtherDevice({
    week: "history-2020-W01",
  });
  await joinUpToWaiting(doc, code, noOwnWorkspace());
  await TestUtils.waitForCondition(
    () => !button(doc, "continue").disabled,
    "pairing lands",
    250,
    120
  );
  Assert.deepEqual(
    (await workspacesInEngine()).filter(id => id !== theirs),
    [],
    "nothing of this device's own was made before pairing landed"
  );

  await continueToEnd(doc);
  await within(SvalPanel.started, 40_000, "the panel's startup");
  Assert.deepEqual(
    await workspacesInEngine(),
    [theirs],
    "the other device's workspace is the only one"
  );
  Assert.equal(SvalWindowWorkspace.of(window).id, theirs, "and it is shown");
  await TestUtils.waitForCondition(
    () => Services.prefs.getStringPref(LEVEL_PREF) === level,
    "the other device's ad-blocking level arrives, and first run wrote none"
  );
  Assert.ok(SvalPanel.settings.firstRunDone, "first run is done");

  // History begins on the first pass past first run, and the step after it
  // has read this key's history index.
  await within(SvalPanel.syncWithFolder(), 30_000, "the first pass");
  await within(SvalHistorySync.instance.whenIdle(), 30_000, "history's start");
  Assert.equal(
    await within(SvalPanel.syncWithFolder(), 30_000, "a step"),
    "reached",
    "a step reaches the folder"
  );
  await TestUtils.waitForCondition(
    () =>
      SvalPanel.syncState.otherWorkspacesIn === SvalPanel.sharedRootSetting(),
    "the window looked for another key's workspaces"
  );
  Assert.deepEqual(
    SvalPanel.syncState.otherWorkspaces,
    [],
    "the other device's week is this key's"
  );
  Assert.notEqual(
    SvalPanel._els.indicator.dataset.state,
    "unpaired-device",
    "and the indicator does not offer to pair"
  );
});
