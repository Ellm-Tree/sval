/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Skip Setup while the other device's offer has not arrived leaves pairing
 * claiming in the background, with no workspace of this device's own; when
 * the offer arrives, pairing lands and its workspace is the one shown
 * (first-run spec §3.2).
 *
 * The one test that waits out the background claim's look
 * (`_firstRunClaimMs`).
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

add_task(async function set_up_later_while_waiting_keeps_claiming() {
  keepFirstRunPrefs();
  const doc = await firstRunShown();
  const { theirs, code, offerPath, level } = await theOtherDevice();
  // The offer has not reached this device's copy of the folder yet.
  const away = tempPath("sval-fr-offer");
  await IOUtils.move(offerPath, away);

  await joinUpToWaiting(doc, code, noOwnWorkspace());
  await endWith(doc, "later");
  await within(SvalPanel.started, 40_000, "the panel's startup");
  Assert.ok(SvalPanel.settings.firstRunDone, "first run is done");
  Assert.ok(SvalFirstRun.pairing, "and pairing goes on claiming");
  Assert.deepEqual(await workspacesInEngine(), [], "with no workspace made");

  await IOUtils.move(away, offerPath);
  // The next look finds the offer, a poll later, and the join's first
  // exchange with the folder takes every document.
  await TestUtils.waitForCondition(
    () => SvalWindowWorkspace.of(window).id === theirs && !SvalFirstRun.pairing,
    "pairing lands, its workspace is shown and the claim stops",
    250,
    160
  );
  Assert.deepEqual(
    await workspacesInEngine(),
    [theirs],
    "the other device's workspace is the only one"
  );
  // Pairing brings the other device's settings too, on a settings pass of
  // its own after the join. The file ends once they have arrived, so the
  // prefs they write are put back with the rest (`keepFirstRunPrefs`).
  await TestUtils.waitForCondition(
    () => Services.prefs.getStringPref(LEVEL_PREF) === level,
    "the other device's ad-blocking level arrives",
    250,
    80
  );
});
