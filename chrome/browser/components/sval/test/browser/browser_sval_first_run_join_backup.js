/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * First run's join path for a user with no other device left: the folder
 * holds another device's synced workspace, and its sync key comes back from
 * the backup typed in the code step's place (key-storage spec, "Backup and
 * recovery"). A key that does not open the folder's workspaces is refused
 * under the field, and the right one brings the workspace.
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

/**
 * Types `text` into the backup step's field and presses Continue.
 *
 * @param {Document} doc The dialog's document.
 * @param {string} text What is typed.
 */
async function submitBackup(doc, text) {
  const field = shownSection(doc).querySelector(".sval-fr-code");
  field.value = text;
  field.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
  await settled(doc);
  button(doc, "continue").click();
}

add_task(async function a_backup_key_brings_the_workspaces_back() {
  keepFirstRunPrefs();
  const doc = await firstRunShown();
  const { theirs, keyBytes } = await theOtherDevice();

  await choosePath(doc, "join", STEPS.joinFolder);
  shownSection(doc).querySelector(".sval-fr-choose-folder").click();
  await TestUtils.waitForCondition(
    () => !button(doc, "continue").disabled,
    "the shared folder is reached"
  );
  await press(doc, "continue", STEPS.joinCode);
  await press(doc, "use-backup", STEPS.joinBackup);

  const section = shownSection(doc);
  const field = section.querySelector(".sval-fr-code");
  const error = section.querySelector(".sval-fr-error");
  const wrong = crypto.getRandomValues(new Uint8Array(32));
  await submitBackup(doc, SvalPanelModel.backupCode(wrong));
  await TestUtils.waitForCondition(
    () => error.dataset.said === "mismatch",
    "a key that opens nothing here is refused"
  );
  Assert.ok(error.textContent, "and the refusal is said under the field");
  Assert.equal(field.getAttribute("aria-invalid"), "true", "on the field");
  Assert.ok(!field.disabled, "which takes the key again");
  Assert.deepEqual(await workspacesInEngine(), [], "nothing was joined");

  await submitBackup(doc, SvalPanelModel.backupCode(keyBytes));
  Assert.equal(error.textContent, "", "typing again clears the refusal");
  await TestUtils.waitForCondition(
    () => section.dataset.join === "landed",
    "the backup opens the folder's workspaces",
    250,
    120
  );
  Assert.equal(field.getAttribute("aria-invalid"), "false");

  await continueToEnd(doc);
  await within(SvalPanel.started, 40_000, "the panel's startup");
  Assert.deepEqual(
    await workspacesInEngine(),
    [theirs],
    "the other device's workspace is the only one"
  );
  Assert.equal(SvalWindowWorkspace.of(window).id, theirs, "and it is shown");
  Assert.ok(SvalPanel.settings.firstRunDone, "first run is done");
});
