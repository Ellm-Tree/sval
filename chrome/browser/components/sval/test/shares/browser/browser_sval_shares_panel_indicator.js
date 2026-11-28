/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_shares_panel_helpers.js */

/**
 * The panel's indicator shows a dropped share once a pass someone waited on
 * finds it away, and clears when it answers (real-share tests spec §3.3,
 * test 7).
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_shares_panel_helpers.js",
  this
);

// Each wait in a task has its own bound. The file's limit is the harness's
// last resort: both shares' tasks, with room for one wait to fail and the
// task's restore after it.
requestLongerTimeout(14);

add_task(the_job_is_configured_or_off);

for (const share of ["nfs", "smb"]) {
  /** Spec test 7. */
  shareTask(
    share,
    async function the_indicator_shows_a_dropped_share_and_clears() {
      await shareChosen(share);
      Assert.equal(await ask(), "reached", "the share answers to begin with");
      await requireIdle(SHARED_STEP_TIMEOUT_MS, "after the first step");

      limitSteps(FAULT_STEP_MS);
      await Shares.control("drop", share, 300);
      Assert.equal(
        await askUntil("unreachable"),
        "unreachable",
        "the dropped share is unreachable"
      );
      const { indicator, syncLabel } = SvalPanel._els;
      // A dropped share reads as unreachable or as gone. The pass that found
      // it was one the test waited on, as Sync now is, so the indicator
      // shows it at once (decision 0032).
      const away = ["offline", "warning"];
      Assert.ok(
        away.includes(indicator.dataset.severity),
        `the indicator says so at once: ${JSON.stringify({
          severity: indicator.dataset.severity,
          problem: SvalPanel.syncState.folderProblem,
          failures: SvalPanel.syncState.failedSteps,
        })}`
      );
      Assert.deepEqual(
        [syncLabel.getAttribute("role"), syncLabel.getAttribute("aria-live")],
        ["status", "polite"],
        "announced politely, as a status"
      );

      await restoreShare(share);
      limitSteps(SHARED_STEP_TIMEOUT_MS);
      Assert.equal(await ask(), "reached", "the restored share is reached");
      Assert.equal(
        indicator.dataset.severity,
        "synced",
        "and it clears when the share answers"
      );
    }
  );
}
