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
 * Other windows opened over first run on a fresh profile (first-run spec
 * §3.4): a private window never opens it, since nothing answered there would
 * be kept, and a second normal window waits for the first window's, opens
 * none of its own, and takes a workspace of its own once first run ends.
 * Skip setup from "A few more things" leaves agent access and sites' tools off
 * (site-tools spec §7), whatever the step showed.
 */
add_task(async function other_windows_wait_for_the_first_windows_first_run() {
  keepFirstRunChoices();
  const doc = await firstRunShown();

  const privateWin = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    10_000,
    "the private window's opening"
  );
  await within(
    privateWin.SvalPanel.started,
    40_000,
    "the private window's panel startup"
  );
  Assert.ok(!privateWin.gDialogBox.isOpen, "no dialog in the private window");
  await within(
    BrowserTestUtils.closeWindow(privateWin),
    10_000,
    "the private window's close"
  );

  // The windows share one engine, which names the window each pass is for.
  const passed = new Set();
  const forget = SvalPanel.engine.addPassListener((report, origin) =>
    passed.add(origin)
  );
  const second = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    10_000,
    "the second window's opening"
  );
  await TestUtils.waitForCondition(
    () => passed.has(second.SvalPanel),
    "the second window has read the document"
  );
  forget();
  const secondStarted = settledFlag(second.SvalPanel.started);
  Assert.ok(!secondStarted.settled, "and is waiting for first run");
  Assert.ok(!second.gDialogBox.isOpen, "with no dialog of its own");

  await walkTo(doc, STEPS.more);
  pick(doc, "on");
  shownSection(doc).querySelector(".sval-fr-tools").click();
  // Set the other way, so what Skip Setup writes is seen.
  Services.prefs.setBoolPref("browser.sval.agents.enabled", true);
  Services.prefs.setBoolPref("browser.sval.agents.pageTools.enabled", true);
  await endWith(doc, "later");
  await within(SvalPanel.started, 40_000, "the panel's startup");
  await within(
    second.SvalPanel.started,
    40_000,
    "the second window's panel startup"
  );

  Assert.ok(
    !Services.prefs.getBoolPref("browser.sval.agents.enabled"),
    "Skip Setup leaves agent access off"
  );
  Assert.ok(
    !Services.prefs.getBoolPref("browser.sval.agents.pageTools.enabled"),
    "and sites' tools"
  );
  // A workspace has at most one window (decision 0079), so the second window
  // takes a workspace of its own once first run has made the first one.
  const workspaces = await workspacesInEngine();
  Assert.equal(workspaces.length, 2, "one workspace per window");
  Assert.ok(
    workspaces.includes(SvalWindowWorkspace.of(window).id) &&
      workspaces.includes(SvalWindowWorkspace.of(second).id),
    "each window shows one of them"
  );
  Assert.notEqual(
    SvalWindowWorkspace.of(second).id,
    SvalWindowWorkspace.of(window).id,
    "and not the same one"
  );
  await within(
    BrowserTestUtils.closeWindow(second),
    10_000,
    "the second window's close"
  );
});
