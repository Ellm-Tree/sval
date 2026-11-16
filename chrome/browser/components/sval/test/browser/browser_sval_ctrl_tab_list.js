/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */
/* import-globals-from sval_ctrl_tab_helpers.js */

/**
 * Holding Ctrl+Tab lists every tab of the window's workspace in order of
 * use, with a picture of each: a loaded tab's page, drawn in memory, and for
 * a tab that has not loaded, its site (`SvalTabSwitcher`). Another
 * workspace's tabs, hidden in the window while it is away, are never in it.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_ctrl_tab_helpers.js",
  this
);

const { keptPreview } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTabSwitcher.sys.mjs"
);

/** More than the seven Firefox's panel showed. */
const RECENT = 9;

/**
 * Two workspaces, the first holding `RECENT` more tabs, made in the tree and
 * opened by a switch back to it, so they are restored and not loaded. The
 * second's tab is left loaded and hidden in the window.
 *
 * @returns {Promise<object>} `withSwitcherTabs`' fixture.
 */
async function workspaceOfManyTabs() {
  const fixture = await withSwitcherTabs();
  const { engine, ids } = fixture;
  const [first, second] = ids.workspaces;
  const now = Date.now();
  for (let i = 1; i <= RECENT; i++) {
    await engine.mutate({
      kind: "addTab",
      parent: first,
      name: `Recent ${i}`,
      url: titledPage(`Recent ${i}`),
      id: crypto.randomUUID(),
      now,
    });
  }
  await SvalPanel.refresh();
  expectWorkspaceTabs();
  Assert.ok(
    await within(SvalPanel.switchTo(second), 10_000, "the switch away"),
    "the window shows the second workspace"
  );
  Assert.ok(
    await within(SvalPanel.switchTo(first), 10_000, "the switch back"),
    "and the first again"
  );
  await within(SvalPanel.observer.settled(), 10_000, "the observer settling");
  return fixture;
}

add_task(async function every_tab_of_the_workspace_and_no_other() {
  const { ids, observer } = await workspaceOfManyTabs();
  const away = observer.tabFor(ids.tabs[1]);
  Assert.ok(
    away && !gBrowser.visibleTabs.includes(away),
    "the other workspace's tab is in the window, hidden"
  );
  Assert.greater(gBrowser.visibleTabs.length, 7, "more tabs than seven");

  await holdCtrlTab();
  const titles = switcherOptions().map(optionTitle);
  Assert.equal(
    titles.length,
    gBrowser.visibleTabs.length,
    "the switcher lists every tab the workspace has in the window"
  );
  for (let i = 1; i <= RECENT; i++) {
    Assert.ok(titles.includes(`Recent ${i}`), `among them Recent ${i}`);
  }
  Assert.ok(titles.includes("Tab in 1"), "and the tab shown");
  Assert.ok(!titles.includes("Tab in 2"), "and none of the other workspace's");
  Assert.equal(
    document.getElementById("ctrlTab-panel"),
    null,
    "Firefox's panel is not in the window to show"
  );

  const frame = gBrowser.selectedBrowser.closest(".browserSidebarContainer");
  const scrim = getComputedStyle(frame, "::before");
  Assert.notEqual(scrim.content, "none", "the page's frame draws the scrim");
  for (const corner of ["TopLeft", "TopRight", "BottomRight", "BottomLeft"]) {
    Assert.equal(
      scrim[`border${corner}Radius`],
      getComputedStyle(frame)[`border${corner}Radius`],
      `with the frame's ${corner} corner`
    );
  }
  Assert.equal(
    getComputedStyle(document.getElementById("sval-tab-switcher"))
      .backgroundColor,
    "rgba(0, 0, 0, 0)",
    "and nothing dims the chrome around the frame"
  );

  const list = document.getElementById("sval-tab-switcher-list");
  Assert.lessOrEqual(
    list.scrollWidth,
    list.clientWidth,
    "the grid fits its width and never scrolls sideways"
  );
  Assert.equal(document.activeElement, list, "the list has focus");
  const accessible = await accessibleOf(list);
  Assert.equal(
    accessible.role,
    Ci.nsIAccessibleRole.ROLE_LISTBOX,
    "the list is a listbox"
  );
  const heading = document.getElementById("sval-tab-switcher-list-heading");
  const workspaceName = SvalPanel.nodes[SvalPanel.workspaceId].content.name;
  Assert.ok(
    heading.textContent.endsWith(` ${workspaceName}`),
    "the heading names the Workspace the tabs are in"
  );
  Assert.equal(accessible.name, heading.textContent, "and is the list's name");
  const selected = await accessibleOf(
    document.getElementById(list.getAttribute("aria-activedescendant"))
  );
  Assert.equal(
    selected.name,
    selectedTitle(),
    "and the selected option is named by its tab's title"
  );

  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    () => !switcherShown(),
    "the switcher closing"
  );
  await releaseCtrl();
});

add_task(
  async function a_loaded_tab_shows_its_page_and_one_not_loaded_its_site() {
    const { ids, observer } = await workspaceOfManyTabs();
    const shown = observer.tabFor(ids.tabs[0]);
    const visited = gBrowser.visibleTabs.find(tab => tab.label === "Recent 1");
    Assert.ok(
      !visited.linkedPanel,
      "a restored tab has not loaded before it is looked at"
    );
    await selectTab(visited);
    await pageReady(visited.linkedBrowser, titledPage("Recent 1"));
    await selectTab(shown);

    await holdCtrlTab();
    const option = title =>
      switcherOptions().find(item => optionTitle(item) === title);
    Assert.equal(
      selectedTitle(),
      "Recent 1",
      "the tab used before is selected"
    );
    const loaded = option("Recent 1").querySelector(".sval-switcher-preview");
    await TestUtils.waitForCondition(
      () => loaded.dataset.preview === "snapshot",
      "the loaded tab's page drawn"
    );
    Assert.ok(
      loaded.querySelector("canvas, .sval-switcher-picture"),
      "the loaded tab shows a picture of its page"
    );

    const notLoaded = option(`Recent ${RECENT}`).querySelector(
      ".sval-switcher-preview"
    );
    Assert.equal(
      notLoaded.dataset.preview,
      "placeholder",
      "a tab not loaded shows its placeholder"
    );
    Assert.equal(
      notLoaded.querySelector(".sval-switcher-site").textContent,
      "example.com",
      "with its site"
    );

    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(
      () => !switcherShown(),
      "the switcher closing"
    );
    await releaseCtrl();
    Assert.equal(gBrowser.selectedTab, shown, "Escape picked nothing");
  }
);

add_task(
  async function a_tab_unloaded_since_it_was_looked_at_keeps_its_picture() {
    const { ids, observer } = await workspaceOfManyTabs();
    const shown = observer.tabFor(ids.tabs[0]);
    const visited = gBrowser.visibleTabs.find(tab => tab.label === "Recent 2");
    await selectTab(visited);
    await pageReady(visited.linkedBrowser, titledPage("Recent 2"));
    await selectTab(shown);
    await TestUtils.waitForCondition(
      () => keptPreview(visited),
      "the tab left drawn"
    );
    Assert.ok(gBrowser.discardBrowser(visited), "the tab unloads");

    await holdCtrlTab();
    const option = switcherOptions().find(
      item => optionTitle(item) === "Recent 2"
    );
    const preview = option.querySelector(".sval-switcher-preview");
    Assert.equal(
      preview.dataset.preview,
      "snapshot",
      "the unloaded tab still shows its page"
    );
    Assert.ok(
      preview.querySelector(".sval-switcher-picture"),
      "as it was when the user left it"
    );

    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(
      () => !switcherShown(),
      "the switcher closing"
    );
    await releaseCtrl();
  }
);
