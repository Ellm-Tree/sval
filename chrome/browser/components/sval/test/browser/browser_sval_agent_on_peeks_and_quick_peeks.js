/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_agent_on_helpers.js */

/**
 * A Peek or a Quick Peek kept as a page of a workspace, with agent access
 * on: a link from another app moved from its Peek into the workspace, and a
 * link Alt-clicked in a window, the main one or a second, kept as a tab
 * there. An open Peek or Quick Peek is never filed and never waits for a
 * filing (`awaitsFiling`), and once kept it is filed like any tab, so each
 * page loads and paints where it opened and again in the workspace.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_agent_on_helpers.js",
  this
);

add_setup(failOnConsoleErrors);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  await agentAccessOn(registerCleanupFunction);
});

add_task(async function a_link_from_another_app_moves_into_the_workspace() {
  const url = titledRed("From an app");
  const win = await linkFromAnotherApp(url);
  await shows(win.gBrowser.selectedBrowser, url, "the peek");
  const tab = await movedInShows(win, url);
  const id = await nodeOfTab(tab);
  Assert.equal(
    SvalPanel.nodes[id]?.placement.parent,
    SvalWindowWorkspace.of(window).id,
    "filed in the workspace the window shows"
  );
  await TestUtils.waitForCondition(
    () => rowNameIn(window, id) === "From an app",
    "with its row"
  );
});

/**
 * Alt-clicks a link to `url` on a page of `win`'s, and keeps the Quick Peek it
 * opens as a tab with its "Open as tab" button, asserting the page loads
 * and paints in the Quick Peek and in the tab.
 *
 * @param {Window} win
 * @param {string} url
 * @returns {Promise<object>} the kept tab.
 */
async function quickPeekAndKeep(win, url) {
  const tab = await openPage(titledRed("Quick-peeking"), win);
  await SpecialPowers.spawn(tab.linkedBrowser, [url], href => {
    const link = content.document.createElement("a");
    link.id = "quick-peek-link";
    link.href = href;
    link.textContent = "Quick Peek here";
    link.style = "display:block;font-size:40px;color:white";
    content.document.body.prepend(link);
  });
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#quick-peek-link",
    { altKey: true },
    tab.linkedBrowser
  );
  const quickPeek = await TestUtils.waitForCondition(
    () => SvalQuickPeek.tabOf(win),
    "a Quick Peek opens"
  );
  expectOpened(quickPeek);
  await shows(quickPeek.linkedBrowser, url, "the Quick Peek");

  const card = win.document.getElementById(quickPeek.linkedPanel);
  card.querySelector(".sval-quick-peek-tab").click();
  await TestUtils.waitForCondition(
    () =>
      win.gBrowser.selectedTab === quickPeek &&
      win.SvalPanel.observer.nodeIdFor(quickPeek),
    "the page is a tab of its own, in front"
  );
  await switchDone(win);
  await selectedShows(win, url, "the kept tab");
  const id = await nodeOfTab(quickPeek);
  Assert.equal(
    win.SvalPanel.nodes[id]?.placement.parent,
    SvalWindowWorkspace.of(win).id,
    "filed in the workspace its window shows"
  );
  await TestUtils.waitForCondition(
    () => rowNameIn(win, id) === "Quick-peeked",
    "with its row"
  );
  return quickPeek;
}

add_task(async function a_quick_peek_kept_as_a_tab_loads_in_the_workspace() {
  expectWorkspaceTabs();
  await quickPeekAndKeep(window, titledRed("Quick-peeked"));
});

add_task(async function a_quick_peek_kept_in_a_second_window_loads_there() {
  const win = await secondWindow();
  await quickPeekAndKeep(win, titledRed("Quick-peeked"));
});
