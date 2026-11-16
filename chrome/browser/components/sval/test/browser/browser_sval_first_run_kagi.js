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
 * Opens first run's Kagi sign-in from the search step, and waits for its
 * window: a popup, which the panel leaves to Kagi's page, with a banner
 * saying what it is for (first-run spec §5).
 *
 * @param {Document} doc The dialog's document.
 * @returns {Promise<Window>} the sign-in window.
 */
async function openSignIn(doc) {
  const opened = BrowserTestUtils.waitForNewWindow();
  kagiNotice(doc).querySelector(".sval-fr-kagi-signin").click();
  const popup = await within(opened, 15_000, "Kagi's sign-in window");
  await committed(
    popup.gBrowser.selectedBrowser,
    SvalKagi.SIGNIN_URL,
    "the window loads Kagi's sign-in"
  );
  Assert.ok(!popup.toolbar.visible, "a popup, left to Kagi's page");
  await TestUtils.waitForCondition(
    () => popup.gNotificationBox.getNotificationWithValue("sval-kagi-sign-in"),
    "a banner says what the window is for"
  );
  Assert.equal(kagiNotice(doc).dataset.state, "opened", "the step says so");
  return popup;
}

/**
 * A new user who chooses Kagi on first run's search step and signs in from
 * it: a sign-in window closed unsigned leaves the step asking, the next one
 * closes itself once Kagi's session cookie is set, and first run then makes
 * Kagi the engine, starts Sval's watch on the sign-in, and opens no sign-in
 * of its own at the end. Yes on the Agents step turns agent access on and
 * leaves sites' tools off.
 */
add_task(async function signing_in_to_kagi_from_first_run() {
  keepFirstRunChoices();
  registerCleanupFunction(signOutOfKagi);
  signOutOfKagi();
  const search = SvalSettingsSync.searchService();
  const before = await search.currentId();
  const doc = await firstRunShown();

  await walkTo(doc, STEPS.search);
  await firstRunSearch(doc, "kagi");
  await TestUtils.waitForCondition(
    () => kagiNotice(doc).dataset.state === "needs-account",
    "choosing Kagi offers its sign-in"
  );

  const unsigned = await openSignIn(doc);
  unsigned.close();
  await TestUtils.waitForCondition(
    () => kagiNotice(doc).dataset.state === "needs-account",
    "a window closed unsigned leaves the step asking"
  );

  const popup = await openSignIn(doc);
  const closed = BrowserTestUtils.domWindowClosed(popup);
  signInToKagi();
  await within(closed, 10_000, "signing in closing Kagi's window");
  await TestUtils.waitForCondition(
    () => kagiNotice(doc).dataset.state === "signed-in",
    "the step says Kagi is signed in"
  );
  Assert.equal(
    await search.currentId(),
    before,
    "the engine waits for the end of the questions"
  );

  // Set the other way, so what the step writes is seen.
  Services.prefs.setBoolPref("browser.sval.agents.enabled", false);
  Services.prefs.setBoolPref("browser.sval.agents.pageTools.enabled", true);
  await walkTo(doc, STEPS.more);
  pick(doc, "on");
  const tabsBefore = gBrowser.tabs.length;
  await finishFirstRun(doc);

  Assert.equal(await search.currentId(), "kagi", "Kagi is the engine");
  Assert.ok(SvalKagi._started, "and Sval watches for the sign-in");
  Assert.equal(
    gBrowser.tabs.length,
    tabsBefore,
    "a signed-in Kagi opens no sign-in at the end"
  );
  Assert.ok(
    Services.prefs.getBoolPref("browser.sval.agents.enabled"),
    "Yes turns agent access on"
  );
  Assert.ok(
    !Services.prefs.getBoolPref("browser.sval.agents.pageTools.enabled"),
    "and leaves sites' tools off"
  );
});
