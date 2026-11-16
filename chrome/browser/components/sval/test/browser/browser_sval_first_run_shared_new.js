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

const MockFilePicker = SpecialPowers.MockFilePicker;

add_setup(function () {
  MockFilePicker.init(window.browsingContext);
  registerCleanupFunction(() => MockFilePicker.cleanup());
});

/**
 * Chooses `folder` on the folder step, as its Choose button does through
 * the system's folder picker, and waits for the step to find it reached.
 *
 * @param {Document} doc The dialog's document.
 * @param {string} folder
 */
async function chooseFolder(doc, folder) {
  MockFilePicker.useDirectory(folder);
  shownSection(doc).querySelector(".sval-fr-choose-folder").click();
  await TestUtils.waitForCondition(
    () => !button(doc, "continue").disabled,
    "the folder is reached",
    100,
    200
  );
}

/**
 * The window as the user finds it: a selected tab showing its own page, and
 * every tab with a page to show.
 *
 * @param {string} what Which moment this is, for the assertion messages.
 */
function assertWindowWorks(what) {
  Assert.equal(
    gBrowser.tabs.filter(tab => !tab.linkedBrowser).length,
    0,
    `${what}: every tab has its page`
  );
  Assert.strictEqual(
    gBrowser.getTabForBrowser(gBrowser.selectedBrowser),
    gBrowser.selectedTab,
    `${what}: the page shown is the selected tab's`
  );
}

/**
 * I use Sval on another device with a folder chosen, Back from the code
 * step to the question, then I'm new to Sval: nothing the abandoned join
 * started may leave the window broken, and the device has one workspace of
 * its own, saved on this device, since the new path chooses no folder
 * (first-run spec §3.2, 2026-11-09 spec §1).
 */
add_task(
  async function a_join_abandoned_for_a_new_start_leaves_a_working_window() {
    keepFirstRunChoices();
    const shared = await makeTempDir("sval-fr-shared");
    const doc = await firstRunShown();

    await choosePath(doc, "join", STEPS.joinFolder);
    await chooseFolder(doc, shared);
    await press(doc, "continue", STEPS.joinCode);
    await press(doc, "back", STEPS.joinFolder);
    await press(doc, "back", STEPS.question);
    pick(doc, "new");
    await finishFirstRun(doc);

    Assert.equal(
      (await workspacesInEngine()).length,
      1,
      "one workspace of this device's own"
    );
    Assert.equal(
      SvalPanel.sharedRootSetting(),
      null,
      "saved on this device, not in the folder the join chose"
    );
    Assert.equal(
      (await SvalIdentity.syncKey()).state,
      SvalIdentity.SYNC_KEY_STATES.none,
      "with no sync key made"
    );
    assertWindowWorks("after first run");
    for (const tab of gBrowser.visibleTabs.slice(0, 2)) {
      await selectTab(tab);
      Assert.equal(
        gBrowser.selectedBrowser,
        tab.linkedBrowser,
        "a tab clicked is the tab shown"
      );
    }
    const opened = BrowserTestUtils.waitForEvent(
      gBrowser.tabContainer,
      "TabOpen"
    );
    EventUtils.synthesizeKey("t", { accelKey: true });
    const { target: newTab } = await within(opened, 10_000, "⌘T's tab");
    Assert.equal(gBrowser.selectedTab, newTab, "⌘T shows a new tab");
    assertWindowWorks("after ⌘T");
    expectOpened(newTab);
  }
);
