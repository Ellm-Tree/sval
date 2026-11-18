/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * Each window's selection is its own: two windows of one profile share one
 * settings store, and each shows its own workspace (spec §10.7), so what one
 * window views is never where the other files a tab.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);

add_setup(failOnConsoleErrors);

/**
 * Window A views a pane of a split in its workspace, and window B, showing
 * another workspace, opens a link in a new tab. B files it beside the tab B
 * views, and A's selection is neither read nor changed by B.
 */
add_task(async function a_window_files_by_its_own_selection() {
  const { ids, engine } = await withSwitcherPanel({
    tabUrl: TITLED_TAB_URL,
  });
  const [first, second] = ids.workspaces;

  const pane = await engine.mutate({
    kind: "addTab",
    parent: first,
    name: "Beside",
    url: TITLED_TAB_URL.replace("%s", "beside"),
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  await SvalPanel.refresh();
  await engine.mutate({
    kind: "batch",
    ops: SvalPanelModel.altClickSplitOps(
      SvalPanel.nodes,
      ids.tabs[0],
      pane,
      () => crypto.randomUUID()
    ),
    now: Date.now(),
  });
  await SvalPanel.refresh();
  Assert.ok(
    SvalPanelModel.isPane(SvalPanel.nodes, ids.tabs[0]),
    "the first workspace's tab is a pane of a split"
  );

  const win = await tearOff(second);
  Assert.equal(
    win.SvalPanel.settings,
    SvalPanel.settings,
    "the two windows share the profile's one settings store"
  );
  try {
    const shown = win.SvalPanel.observer.tabFor(ids.tabs[1]);
    await selectTab(shown);
    Assert.equal(
      win.SvalPanel.selection.selectedId(),
      ids.tabs[1],
      "the new window views its workspace's tab"
    );

    // What this window's `TabSelect` reports when the user views the pane.
    await SvalPanel.selection.select(ids.tabs[0]);
    Assert.equal(
      SvalPanel.selection.selectedId(),
      ids.tabs[0],
      "this window views it"
    );
    Assert.equal(
      win.SvalPanel.selection.selectedId(),
      ids.tabs[1],
      "and the other window's selection stays its own"
    );

    const tab = await BrowserTestUtils.addTab(
      win.gBrowser,
      TITLED_TAB_URL.replace("%s", "link")
    );
    let filed = null;
    await within(
      TestUtils.waitForCondition(async () => {
        await win.SvalPanel.observer.settled();
        const id = win.SvalPanel.observer.nodeIdFor(tab);
        filed = id && (await engine.tree()).nodes[id];
        return !!filed;
      }, "the link's tab is filed"),
      10_000,
      "the link's tab being filed"
    );
    Assert.equal(
      filed.placement.parent,
      second,
      "beside the tab the other window views, in the workspace it shows"
    );

    await selectTab(tab);
    Assert.equal(
      SvalPanel.selection.selectedId(),
      ids.tabs[0],
      "and viewing it there leaves this window's selection alone"
    );
    BrowserTestUtils.removeTab(tab);
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the test window closing"
    );
  }
});
