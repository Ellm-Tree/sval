/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A tab Sval takes out of the window while a window-modal dialog is up leaves
 * the window a tab to show. First run is such a dialog, and a folder chosen in
 * it can bring a document that does not hold the window's tab, which
 * `closeOrphanTabs` then takes out. tabbrowser's `selectedTab` setter ignores
 * a switch while the dialog is open (`window-modal-open`), so the removal must
 * not rely on it to move off the tab it removes.
 */

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

const { SvalFirstRun } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFirstRun.sys.mjs"
);

add_task(
  async function a_tab_closed_behind_first_run_leaves_a_working_window() {
    const kept = gBrowser.selectedTab;
    const doomed = await within(
      BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank"),
      10_000,
      "a new tab"
    );
    await within(SvalPanel.observer.settled(), 10_000, "the tab is filed");

    const shown = SvalFirstRun.open(window, {
      actions: SvalPanel._firstRunActions(),
      facts: { importAvailable: false, isDefaultBrowser: true, earlier: {} },
    });
    await TestUtils.waitForCondition(
      () => gDialogBox.isOpen,
      "first run opens"
    );
    await dialogShown(gDialogBox.dialog, "the dialog's load");

    // A document holding the window's other tab, and not this one's node.
    const keptId = SessionStore.getCustomTabValue(kept, "sval-node-id");
    Assert.ok(keptId, "the other tab has its node");
    SvalPanel.observer.closeOrphanTabs({ [keptId]: { kind: "tab" } });

    Assert.ok(!doomed.linkedBrowser, "the tab is gone");
    Assert.equal(
      gBrowser.selectedTab,
      kept,
      "the tab left is the one selected"
    );
    Assert.equal(
      gBrowser.selectedBrowser,
      kept.linkedBrowser,
      "its page is the one shown"
    );

    await closeLeftoverDialog();
    await within(shown, 10_000, "first run's end");
    const other = await within(
      BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank"),
      10_000,
      "a new tab"
    );
    await selectTab(kept);
    Assert.equal(
      gBrowser.selectedBrowser,
      kept.linkedBrowser,
      "a tab clicked after first run is the tab shown"
    );
    BrowserTestUtils.removeTab(other);
  }
);
