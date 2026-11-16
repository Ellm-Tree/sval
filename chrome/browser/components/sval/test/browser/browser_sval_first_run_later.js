/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A fresh profile's first launch opens first run, and Skip setup on the
 * question shows the welcome with the new user's card and nothing imported,
 * then makes one workspace and records first run as done (first-run spec
 * §2, §3; 2026-11-09 spec §2.4), so no window asks again. The welcome's Set
 * up sync closes first run and opens Settings › Sync and devices.
 */

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_first_run_helpers.js */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_first_run_helpers.js",
  this
);

add_task(async function skip_setup_makes_one_workspace_and_asks_once() {
  keepFirstRunPrefs();
  const doc = await firstRunShown();
  const settingsPath = SvalLocalSettings.profilePath();
  Assert.ok(
    (await IOUtils.readJSON(settingsPath)).firstRunStarted,
    "the start is recorded before anything is answered"
  );
  Assert.deepEqual(
    await workspacesInEngine(),
    [],
    "no workspace exists while first run is open"
  );

  await toQuestion(doc);
  await settled(doc);
  button(doc, "later").click();
  await TestUtils.waitForCondition(
    () => shownStep(doc) === STEPS.welcome,
    "Skip setup shows the welcome"
  );
  const welcome = shownSection(doc);
  Assert.equal(welcome.dataset.card, "new", "with the new user's card");
  Assert.ok(
    BrowserTestUtils.isHidden(welcome.querySelector(".sval-fr-import")),
    "and nothing imported"
  );
  Assert.ok(
    BrowserTestUtils.isVisible(welcome.querySelector(".sval-fr-set-up-sync")),
    "a new device is offered sync"
  );
  const opened = BrowserTestUtils.waitForNewTab(
    gBrowser,
    url => url.startsWith("about:preferences"),
    true
  );
  await settled(doc);
  welcome.querySelector(".sval-fr-set-up-sync").click();
  const settings = await within(opened, 20_000, "Settings' tab");
  expectOpened(settings);
  Assert.ok(!gDialogBox.isOpen, "Set up sync closes first run");
  Assert.equal(gBrowser.selectedTab, settings, "and Settings is the tab shown");
  Assert.equal(
    settings.linkedBrowser.currentURI.ref,
    "svalSync",
    "at Sync and devices"
  );
  await within(SvalPanel.started, 40_000, "the panel's startup");

  const workspaces = await workspacesInEngine();
  Assert.equal(workspaces.length, 1, "one workspace was made");
  Assert.equal(
    SvalPanel.nodes[workspaces[0]].content.name,
    "",
    "unnamed, since the Workspace step was never continued through"
  );
  Assert.equal(SvalPanel.workspaceId, workspaces[0], "and is shown");
  Assert.equal(SvalPanel.settings.placement, "left");
  Assert.equal(
    Services.prefs.getStringPref(LEVEL_PREF),
    "balanced",
    "ad blocking is Balanced"
  );
  Assert.strictEqual(
    (await IOUtils.readJSON(settingsPath)).firstRunDone,
    true,
    "first run is recorded as done on disk"
  );

  const second = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    10_000,
    "the second window's opening"
  );
  await within(second.SvalPanel.started, 40_000, "the second panel's startup");
  Assert.ok(!second.gDialogBox.isOpen, "a later window asks nothing");
  await within(
    BrowserTestUtils.closeWindow(second),
    10_000,
    "the second window's close"
  );
});
