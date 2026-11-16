/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A first run that chooses Kagi (first-run spec §5): on a fresh profile its
 * notice says Kagi needs an account and offers the sign-in, which opens
 * Kagi's page in a window of its own. Closed unsigned, the notice asks
 * again, and Start browsing opens the sign-in in a tab.
 *
 * The manifest sends `kagi.com` to this machine, where nothing answers, so
 * Kagi's page fails to load and nothing leaves the machine.
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

add_task(async function a_closed_kagi_window_leaves_its_page_for_the_end() {
  keepFirstRunPrefs();
  const doc = await firstRunShown();
  const facts = await realFacts();
  await continueUntil(doc, STEPS.search);
  const kagi = shownSection(doc).querySelector(".sval-fr-kagi");
  Assert.ok(kagi.hidden, "Kagi's links wait until Kagi is chosen");
  pick(doc, "kagi");
  Assert.ok(!kagi.hidden, "and appear when it is");
  const signIn = kagi.querySelector(".sval-fr-kagi-signin");
  await TestUtils.waitForCondition(
    () => kagi.dataset.state === "needs-account",
    "a fresh profile is not signed in"
  );
  Assert.ok(BrowserTestUtils.isVisible(signIn), "and offers the sign-in");

  const opened = BrowserTestUtils.waitForNewWindow();
  signIn.click();
  const popup = await within(opened, 20_000, "Kagi's sign-in window");
  await committed(
    popup.gBrowser.selectedBrowser,
    SvalKagi.SIGNIN_URL,
    "the window loads Kagi's sign-in"
  );
  Assert.equal(kagi.dataset.state, "opened", "the notice says where it is");
  await within(
    BrowserTestUtils.closeWindow(popup),
    10_000,
    "closing Kagi's window"
  );
  await TestUtils.waitForCondition(
    () => kagi.dataset.state === "needs-account",
    "closed unsigned, the notice asks again"
  );
  Assert.ok(BrowserTestUtils.isVisible(signIn), "and offers it");

  const path = pathOf(SvalFirstRunModel.defaults(), facts);
  const tabOpened = BrowserTestUtils.waitForNewTab(
    gBrowser,
    SvalKagi.SIGNIN_URL,
    false
  );
  await walkToEnd(doc, path.slice(path.indexOf(STEPS.search) + 1));
  await finishFirstRun(doc);
  const tab = await within(tabOpened, 20_000, "the sign-in's tab");
  expectOpened(tab);
  Assert.equal(gBrowser.selectedTab, tab, "the sign-in is the tab shown");
  Assert.ok(SvalKagi._started, "and Sval watches for the sign-in");
  Assert.equal(
    await SvalSettingsSync.searchService().currentId(),
    "kagi",
    "Kagi is the search engine"
  );
});
