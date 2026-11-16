/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A first-run dialog closed without an answer records nothing, so first run
 * shows again at the next launch (first-run spec §8), and the panel still
 * starts.
 */

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_first_run_helpers.js */
/* import-globals-from sval_first_run_dialog_helpers.js */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_first_run_helpers.js",
  this
);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_first_run_dialog_helpers.js",
  this
);

add_task(async function a_closed_dialog_records_nothing() {
  keepFirstRunPrefs();
  const doc = await firstRunShown();
  await toQuestion(doc);
  doc.defaultView.close();
  await TestUtils.waitForCondition(
    () => !gDialogBox.isOpen,
    "the dialog closes"
  );
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const stored = await IOUtils.readJSON(SvalLocalSettings.profilePath());
  Assert.ok(stored.firstRunStarted, "the start stays recorded");
  Assert.ok(!stored.firstRunDone, "and first run is not recorded as done");
});
