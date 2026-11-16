/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_take_control_helpers.js */

/**
 * Take control (agent-control spec §6) across a crash. This task has a file
 * of its own because `BrowserTestUtils.crashFrame` waits for the crash report
 * to be recorded, which can take half a minute on a loaded runner. Its
 * siblings are `browser_sval_agent_overlay.js`,
 * `browser_sval_agent_take_control_hands_over.js` and
 * `browser_sval_agent_take_control_kept.js`.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_take_control_helpers.js",
  this
);

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

const { TabStateFlusher } = ChromeUtils.importESModule(
  "resource:///modules/sessionstore/TabStateFlusher.sys.mjs"
);

/**
 * A crashed agent tab comes back under the overlay when session store revives
 * it (`SessionStore.reviveCrashedTab`).
 */
add_task(async function a_crashed_agent_tab_can_be_restored() {
  const { call, tab, win, browser } = await layerSetup();
  await call("navigate_tab", { tab, to: PAGE });
  const firefoxTab = win.gBrowser.getTabForBrowser(browser);
  // Session store collects the history it restores on a timer
  // (`browser.sessionstore.interval`), so it is collected now.
  await TabStateFlusher.flush(browser);
  await BrowserTestUtils.crashFrame(browser);
  Assert.ok(firefoxTab.hasAttribute("crashed"), "the tab crashed");
  SessionStore.reviveCrashedTab(firefoxTab);
  await TestUtils.waitForCondition(
    () => !firefoxTab.hasAttribute("crashed"),
    "the tab is revived"
  );
  await committed(firefoxTab.linkedBrowser, PAGE);
  Assert.ok(
    !partsOf(firefoxTab.linkedBrowser).overlay.hidden,
    "under the overlay"
  );
});
