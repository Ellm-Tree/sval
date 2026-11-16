/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_shares_panel_helpers.js */

/**
 * "Use this folder again" recreates a sval/ deleted from the share
 * (real-share tests spec §3.3, test 6, the settings half).
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_shares_panel_helpers.js",
  this
);

add_task(the_job_is_configured_or_off);

for (const share of ["nfs", "smb"]) {
  /** Spec test 6, the settings half. */
  shareTask(
    share,
    async function use_this_folder_again_recreates_a_deleted_sval_dir() {
      const { shared } = await shareChosen(share);
      await IOUtils.remove(PathUtils.join(shared, "sval"), { recursive: true });
      Assert.equal(
        await ask(),
        "unreachable",
        "a deleted sval/ is unreachable"
      );
      Assert.ok(
        !(await IOUtils.exists(PathUtils.join(shared, "sval"))),
        "and is not recreated"
      );
      await requireIdle(SHARED_STEP_TIMEOUT_MS, "after the unreachable step");
      const again = await SvalPanel.useFolderAgain();
      Assert.ok(again.reached, "Use this folder again reaches it");
      Assert.ok(
        await IOUtils.exists(PathUtils.join(shared, "sval")),
        "and sval/ is back"
      );
    }
  );
}
