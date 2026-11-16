/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Escape (first-run spec §7, 2026-11-09 spec §2.3): nothing on the
 * introduction, which has no Skip setup; Skip setup on a step; and Start
 * browsing on the welcome. Left from the search step with Kagi chosen and
 * not continued through, Skip setup applies its own answers: the search
 * engine and the side stay as they were, nothing of Kagi opens, and the one
 * workspace made is the one the Workspace step named.
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

add_task(async function escape_on_each_screen() {
  keepFirstRunPrefs();
  const doc = await firstRunShown();
  const search = SvalSettingsSync.searchService();
  const before = await search.currentId();

  await settled(doc);
  EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
  await settled(doc);
  Assert.ok(gDialogBox.isOpen, "Escape on the introduction leaves nothing");
  Assert.equal(shownStep(doc), STEPS.intro, "and stays on it");

  await continueUntil(doc, STEPS.workspace);
  const name = shownSection(doc).querySelector(".sval-nw-name").value;
  await continueUntil(doc, STEPS.search);
  pick(doc, "kagi");
  const tabs = gBrowser.tabs.length;
  EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
  await TestUtils.waitForCondition(
    () => shownStep(doc) === STEPS.welcome,
    "Escape on a step is Skip setup, which shows the welcome"
  );
  const start = shownSection(doc).querySelector(".sval-fr-start");
  await TestUtils.waitForCondition(() => !start.disabled, "nothing runs");
  await settled(doc);
  EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
  await TestUtils.waitForCondition(
    () => !gDialogBox.isOpen,
    "Escape on the welcome starts browsing"
  );
  await within(SvalPanel.started, 40_000, "the panel's startup");

  const later = SvalFirstRunModel.setUpLaterAnswers(
    SvalFirstRunModel.defaults()
  );
  Assert.equal(
    await search.currentId(),
    before,
    "the search choice left unconfirmed is not applied"
  );
  Assert.notEqual(before, "kagi", "and was not Kagi already");
  Assert.equal(SvalPanel.settings.placement, later.panelSide);
  Assert.equal(gBrowser.tabs.length, tabs, "an unconfirmed Kagi opens nothing");
  const workspaces = await workspacesInEngine();
  Assert.equal(workspaces.length, 1, "one workspace");
  Assert.equal(
    SvalPanel.nodes[workspaces[0]].content.name,
    name,
    "named as the Workspace step continued through named it"
  );
  Assert.ok(SvalPanel.settings.firstRunDone, "first run is done");
});
