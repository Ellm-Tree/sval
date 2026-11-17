/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_shares_panel_helpers.js */

/**
 * The panel's indicator shows a dropped share after three minutes and clears
 * when it answers (real-share tests spec §3.3, test 7).
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_shares_panel_helpers.js",
  this
);

const { FOLDER_UNAVAILABLE_AFTER_MS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);

// Each wait in a task has its own bound. The file's limit is the harness's
// last resort: both shares' tasks, each waiting out the indicator's three
// minutes, with room for one wait to fail and the task's restore after it.
requestLongerTimeout(14);

add_task(the_job_is_configured_or_off);

for (const share of ["nfs", "smb"]) {
  /** Spec test 7. */
  shareTask(
    share,
    async function the_indicator_shows_after_three_minutes_and_clears() {
      await shareChosen(share);
      Assert.equal(await ask(), "reached", "the share answers to begin with");
      await requireIdle(SHARED_STEP_TIMEOUT_MS, "after the first step");

      limitSteps(FAULT_STEP_MS);
      // The drop outlasts the indicator's three minutes, at the longest fault
      // the share's control switch allows.
      await Shares.control("drop", share, 300);
      Assert.equal(
        await askUntil("unreachable"),
        "unreachable",
        "the dropped share is unreachable"
      );
      const droppedAt = Date.now();
      const { indicator, syncLabel } = SvalPanel._els;
      // A dropped share reads as unreachable or as gone, and the indicator
      // shows either only once the folder has been away three minutes
      // (messages spec §3). Each pass draws the indicator, and this is the
      // one test that waits that time out.
      const away = ["offline", "warning"];
      Assert.equal(await ask(), "unreachable", "a pass soon after the drop");
      Assert.ok(
        !away.includes(indicator.dataset.severity),
        "is silent about it"
      );
      // Every answer is counted, so a wait that fails says whether the
      // share stayed away.
      const answers = {};
      const shownBy = droppedAt + FOLDER_UNAVAILABLE_AFTER_MS + askLimitMs();
      for (;;) {
        const answer = await ask();
        answers[answer] = (answers[answer] ?? 0) + 1;
        if (
          Date.now() - droppedAt > FOLDER_UNAVAILABLE_AFTER_MS &&
          answer === "unreachable" &&
          away.includes(indicator.dataset.severity)
        ) {
          break;
        }
        if (Date.now() > shownBy) {
          throw new Error(
            `the indicator did not show the dropped share after three minutes: ${JSON.stringify(
              {
                answers,
                severity: indicator.dataset.severity,
                problem: SvalPanel.syncState.folderProblem,
                awayMs:
                  SvalPanel.syncState.unreachableSince === null
                    ? null
                    : Date.now() - SvalPanel.syncState.unreachableSince,
                state: await Shares.state(),
              }
            )}`
          );
        }
        await TestUtils.waitForTick();
      }
      Assert.ok(
        away.includes(indicator.dataset.severity),
        "the indicator says so after three minutes"
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
