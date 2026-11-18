/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */
/* import-globals-from sval_workspace_windows_helpers.js */

/**
 * Tabs and queued work as a window goes: a window left with nothing to show,
 * stale tabs dragged between windows, and a window or its last tab closing
 * while work is queued.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_workspace_windows_helpers.js",
  this
);

add_setup(failOnConsoleErrors);

/**
 * A window whose workspace is deleted, with every other workspace open in a
 * window of its own, has nothing left to show, so it closes. The rest of the
 * document is untouched.
 */
add_task(async function a_window_left_with_no_free_workspace_closes() {
  const { ids, engine } = await withSwitcherPanel({
    tabUrl: TITLED_TAB_URL,
  });
  const [first, second] = ids.workspaces;

  // The profile's own workspace in a window too, so none is free.
  await tearOff(SvalTree.workspaceIds(SvalPanel.nodes)[0]);
  const win = await tearOff(second);
  const observer = win.SvalPanel.observer;
  const closed = BrowserTestUtils.domWindowClosed(win);
  await engine.mutate({ kind: "remove", id: ids.tabs[1] });
  await engine.mutate({ kind: "remove", id: second });
  // The redraw is what closes the window, and a promise of a closed window's
  // may never settle, so only the closing is waited for.
  win.SvalPanel.refresh().catch(() => {});
  await within(closed, 10_000, "the window with no free workspace closing");
  // Its observer's last flush is over before the document is read.
  await stopFixture({ observer });

  const nodes = JSON.parse(await treeJson(engine));
  Assert.ok(first in nodes, "the other workspace is still there");
  Assert.ok(ids.tabs[0] in nodes, "with its tab");
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    first,
    "and the window showing it still does"
  );
});

/**
 * The panel is Sval's only tab surface, so an undrawn tab is a tab the user
 * cannot see or close. It is also still tagged, so dragging it anywhere
 * reaches `#reconcile`'s tagged-but-missing branch.
 */
add_task(async function a_tab_whose_node_another_device_deleted_goes_too() {
  const { ids, engine, observer } = await withSwitcherTabs();

  const held = observer.tabFor(ids.tabs[0]);
  Assert.ok(held, "this window holds a tab for the node");

  // Deleted as a peer's pass would bring it in. This window has not been told
  // anything yet, which is the state under test.
  await engine.mutate({ kind: "remove", id: ids.tabs[0] });
  Assert.ok(
    !(ids.tabs[0] in JSON.parse(await treeJson(engine))),
    "the node is gone"
  );
  Assert.ok(
    gBrowser.tabs.includes(held),
    "and this window is, for the moment, still holding its tab for it"
  );

  await SvalPanel.refresh();
  Assert.ok(
    !heldIds().includes(ids.tabs[0]),
    "once this window redraws, the tab goes with the row — a window never " +
      "holds a tab for a node its document does not have"
  );
  Assert.ok(gBrowser.tabs.length, "and the window still has a tab");
});

/**
 * This is the resurrection §5.4 exists to prevent: another device deletes the
 * node, and the user drags this window's tab for it into another window
 * before this one has redrawn. The node would be re-added under this device
 * with a fresh timestamp, which no watermark can reject as stale, and the
 * deletion would be undone everywhere.
 *
 * The tab itself survives. The user can see it and has just dragged it, so it
 * is filed under a new id in the workspace the destination window shows.
 *
 * The window is not refreshed before the drag. That leaves the stale tab in
 * place, the same race a user wins by dragging within the poll interval.
 */
add_task(async function a_stale_tab_dragged_across_resurrects_nothing() {
  const { ids, engine, observer } = await withSwitcherTabs();
  const [, second] = ids.workspaces;

  const win = await tearOff(second);
  try {
    const stale = observer.tabFor(ids.tabs[0]);
    Assert.ok(stale, "this window holds a tab for the node");
    // The window's last tab adopted away would close the window
    // (`gBrowser.adoptTab`), so it keeps a blank one, which stays unfiled.
    BrowserTestUtils.addTab(gBrowser, "about:blank");
    await within(observer.settled(), 10_000, "observer settling");
    await engine.mutate({ kind: "remove", id: ids.tabs[0] });
    Assert.equal(
      taggedId(stale),
      ids.tabs[0],
      "and still holds it, still tagged, for a node that is now gone"
    );

    const before = JSON.parse(await treeJson(engine));
    const moved = win.gBrowser.adoptTab(stale, {
      tabIndex: 0,
      selectTab: true,
    });
    Assert.ok(moved, "the tab is dragged into the other window");
    Assert.deepEqual(
      win.SvalPanel.observer.closeOrphanTabs(before),
      [],
      "and a redraw landing before the window has reconciled it leaves it open"
    );
    await within(
      win.SvalPanel.observer.settled(),
      10_000,
      "win.SvalPanel.observer settling"
    );
    await win.SvalPanel.refresh();

    const nodes = JSON.parse(await treeJson(engine));
    Assert.ok(
      !(ids.tabs[0] in nodes),
      "the closed node stayed closed: a tab carried in from another window is " +
        "not Firefox handing a closed tab back, and only that reuses an id"
    );

    Assert.deepEqual(
      win.gBrowser.tabs.map(taggedId).filter(id => id === ids.tabs[0]),
      [],
      "and no tab in that window is still claiming that id"
    );

    Assert.ok(
      win.gBrowser.tabs.includes(moved),
      "the dragged tab is still open: a tab the user can see never vanishes " +
        "because it was dragged"
    );
    const filed = taggedId(moved);
    Assert.ok(filed, "it is filed");
    Assert.notEqual(
      filed,
      ids.tabs[0],
      "under a new id, because it is a new tab in this window"
    );
    Assert.ok(filed in nodes, "and the document holds that node");
    Assert.ok(
      SvalTree.isWithin(nodes, filed, second),
      "in the workspace that window shows"
    );
    for (const id of ids.workspaces) {
      Assert.ok(id in nodes, `${id} is untouched`);
    }
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the test window closing"
    );
  }
});

/**
 * The same resurrection by the commoner drag: the stale tab out to a new
 * window.
 *
 * Only one side of the pair fires on both routes. `replaceTabWithWindow`
 * hands the tab to the new window's initial tab through
 * `swapBrowsersAndCloseOther` (`gBrowserInit.onLoad`), so no `TabOpen`
 * happens there. The node id crosses anyway, because SessionStore's
 * `TabClose` handler calls `moveCustomTabValue`
 * (`SessionStoreInternal.handleEvent`). The tab then reaches the new window's
 * `start()` looking like any tagged tab whose node is missing.
 *
 * So the mark is taken on the close side, from `adoptedBy`, which both
 * routes raise and where the id crosses.
 */
add_task(async function a_stale_tab_dragged_out_resurrects_nothing() {
  const { ids, engine, observer } = await withSwitcherTabs();

  let out = null;
  try {
    const stale = observer.tabFor(ids.tabs[0]);
    Assert.ok(stale, "this window holds a tab for the node");
    // The window keeps a blank tab, which stays unfiled.
    BrowserTestUtils.addTab(gBrowser, "about:blank");
    await within(observer.settled(), 10_000, "observer settling");
    await engine.mutate({ kind: "remove", id: ids.tabs[0] });
    Assert.equal(
      taggedId(stale),
      ids.tabs[0],
      "and still holds it, still tagged, for a node that is now gone"
    );
    Assert.greater(
      gBrowser.tabs.length,
      1,
      "the window has another tab, which `replaceTabWithWindow` requires"
    );

    const opening = BrowserTestUtils.domWindowOpenedAndLoaded();
    Assert.ok(
      gBrowser.replaceTabWithWindow(stale),
      "the tab is dragged out into a window of its own"
    );
    out = await within(opening, 20_000, "the dragged-out window's opening");
    await within(
      out.SvalPanel.started,
      20_000,
      "the dragged-out window's panel starting"
    );
    await within(
      out.SvalPanel.observer?.settled(),
      10_000,
      "out.SvalPanel.observer settling"
    );

    const nodes = JSON.parse(await treeJson(engine));
    Assert.ok(
      !(ids.tabs[0] in nodes),
      "the closed node stayed closed: dragging a tab out is not Firefox " +
        "handing a closed tab back either"
    );
    Assert.deepEqual(
      out.gBrowser.tabs.map(taggedId).filter(id => id === ids.tabs[0]),
      [],
      "and no tab in the new window is still claiming that id"
    );
    for (const id of ids.workspaces) {
      Assert.ok(id in nodes, `${id} is untouched`);
    }
  } finally {
    if (out) {
      await within(
        BrowserTestUtils.closeWindow(out),
        10_000,
        "the torn-out window closing"
      );
    }
  }
});

/**
 * `removeTab` on a window's only tab closes the window
 * (`browser.tabs.closeWindowWithLastTab`), and `_close` has work after the
 * close: the containers' removal, the settings flush, the sync pass. A
 * window torn down under those `await`s never runs them, and `_close` never
 * returns.
 */
add_task(async function closing_a_torn_off_windows_only_tab_finishes() {
  const { ids, engine } = await withSwitcherTabs();
  const [, second] = ids.workspaces;

  const win = await tearOff(second);
  try {
    Assert.deepEqual(
      win.gBrowser.tabs.map(taggedId).filter(Boolean),
      [ids.tabs[1]],
      "the torn-off window holds exactly its workspace's one tab"
    );
    Assert.equal(
      win.gBrowser.tabs.length,
      1,
      "and nothing else, the startup tab having been closed as debris"
    );

    // Would never return if the window went with the tab.
    await win.SvalPanel._close(ids.tabs[1]);

    Assert.ok(!win.closed, "the window is still open");
    Assert.ok(
      win.gBrowser.tabs.length,
      "with a tab, because a window with none is not a state Firefox has"
    );
    const nodes = JSON.parse(await treeJson(engine));
    Assert.ok(!(ids.tabs[1] in nodes), "the node was deleted");
    Assert.ok(
      second in nodes,
      "and the workspace was not: closing its last tab empties it, it does " +
        "not close it"
    );
    const [kept] = win.gBrowser.tabs;
    await TestUtils.waitForCondition(
      () => taggedId(kept),
      "the tab the window kept is filed"
    );
    await within(
      win.SvalPanel.observer.settled(),
      10_000,
      "win.SvalPanel.observer settling"
    );
    const after = JSON.parse(await treeJson(engine));
    Assert.equal(
      after[taggedId(kept)]?.placement?.parent,
      second,
      "as the workspace's home tab, because the home page is always a tab"
    );
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the test window closing"
    );
  }
});

/**
 * Closing a named workspace's window deletes nothing (spec §5.4): not the
 * workspace, and not its tabs. That holds for the window's close box and for
 * Cmd/Ctrl+W on its last tab, which closes the window rather than the tab.
 */
for (const how of ["window", "lastTab"]) {
  add_task(async function closing_a_workspaces_window_deletes_nothing() {
    info(`closed by: ${how}`);
    const { ids, engine } = await withSwitcherTabs();
    const [, second] = ids.workspaces;

    const win = await tearOff(second);
    await settleBoth(engine, win);
    const before = JSON.parse(await treeJson(engine));
    Assert.ok(ids.tabs[1] in before, "the workspace's tab is in the document");

    await closeWindowBy(win, how);
    await within(
      SvalPanel.observer?.settled(),
      10_000,
      "SvalPanel.observer settling"
    );

    const after = JSON.parse(await treeJson(engine));
    Assert.deepEqual(
      Object.keys(after).sort(),
      Object.keys(before).sort(),
      "every node the document held before the close is still there"
    );
    Assert.ok(second in after, "the workspace was kept");
    Assert.ok(ids.tabs[1] in after, "and so was its tab");
  });
}

/**
 * A torn-off window holding its workspace's tab and one more, both filed.
 *
 * @returns {Promise<object>} `withSwitcherTabs`'s result, plus `win`, its
 *   `extra` tab and that tab's `extraId`.
 */
async function withTwoTabWindow() {
  const fixture = await withSwitcherTabs();
  const { ids, engine } = fixture;
  const win = await tearOff(ids.workspaces[1]);
  const extra = BrowserTestUtils.addTab(
    win.gBrowser,
    `${ROOT}sval_switcher_page.sjs?%3Ctitle%3EExtra%3C/title%3E`
  );
  await TestUtils.waitForCondition(() => taggedId(extra), "the tab is filed");
  // removeTab animates a close only once the tab's fade-in has begun and
  // given it a width (`removeTab` in tabbrowser.js).
  await TestUtils.waitForCondition(
    () =>
      extra.hasAttribute("fadein") &&
      win.windowUtils.getBoundsWithoutFlushing(extra).width > 0,
    "the tab has faded in"
  );
  await settleBoth(engine, win);
  const extraId = taggedId(extra);
  const nodes = JSON.parse(await treeJson(engine));
  Assert.ok(extraId in nodes, "the second tab is in the document");
  return { ...fixture, win, extra, extraId };
}

/**
 * Closes `extra` with its animation, then closes the window from its last tab
 * while that animation runs, the way Cmd/Ctrl+W does. The first close is
 * still in the observer's queue, waiting on the engine, when the window goes.
 *
 * @param {DOMWindow} win The window.
 * @param {object} extra A tab of `win` other than the one it shows last.
 * @returns {Promise<object>} the window's observer, detached.
 */
async function closeTabThenWindow(win, extra) {
  const observer = win.SvalPanel.observer;
  const closed = BrowserTestUtils.domWindowClosed(win);
  // A new window reduces motion until an idle task reads
  // prefers-reduced-motion (`_schedulePerWindowIdleTasks` in
  // browser-init.js), and `removeTab` skips the animation while it does.
  // `gReduceMotionOverride` is browser.js's switch for tests.
  win.gReduceMotionOverride = false;
  win.gBrowser.removeTab(extra, { animate: true });
  Assert.ok(
    win.gBrowser._removingTabs.size,
    "the first tab is still closing, so the second close takes the slow path"
  );
  win.BrowserCommands.closeTabOrWindow();
  await within(closed, 10_000, "the window closing with its last tab");
  await stopFixture({ observer });
  return observer;
}

/**
 * A window closing while its observer still has work in flight. Every queued
 * step runs, and so does the flush the window's `unload` queued after them.
 * Off the fast path, closing the last tab opens a new one first
 * (`_beginRemoveTab`), and filing that tab asks the panel for a parent after
 * the window has gone.
 */
add_task(async function a_window_closing_mid_queue_finishes_its_queue() {
  const { engine, win, extra, extraId } = await withTwoTabWindow();
  await closeTabThenWindow(win, extra);
  const nodes = JSON.parse(await treeJson(engine));
  Assert.ok(!(extraId in nodes), "the tab closed first was deleted");
});

/**
 * The last tab's `TabClose` that takes the window with it, off Firefox's fast
 * path: another tab is still animating closed, so `removeTab` raises the
 * event. Closing a window deletes nothing (spec §5.4), so the last tab's node
 * stays.
 */
add_task(async function a_last_tab_closing_its_window_mid_animation_stays() {
  const { ids, engine, win, extra } = await withTwoTabWindow();
  let raised = false;
  win.addEventListener(
    "TabClose",
    event => {
      if (event.target !== extra) {
        raised = true;
      }
    },
    true
  );
  await closeTabThenWindow(win, extra);
  Assert.ok(raised, "the last tab's close raised TabClose");
  const nodes = JSON.parse(await treeJson(engine));
  Assert.ok(ids.tabs[1] in nodes, "the last tab's node is kept");
  Assert.ok(ids.workspaces[1] in nodes, "and so is its workspace");
});

/**
 * On macOS the first window to close puts the hidden window's History menu
 * in step with the closed-window list (`maybeSaveClosedWindow`), and that
 * menu goes on following history. A history change after it logs nothing:
 * the file's console check reads what the menu does with the page's visit
 * and title.
 */
add_task(async function history_after_a_window_closes_logs_nothing() {
  for (const { closedId } of SessionStore.getClosedWindowData()) {
    SessionStore.forgetClosedWindowById(closedId);
  }
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    10_000,
    "a second window"
  );
  const page = ROOT + "sval_agent_page.html";
  const loaded = BrowserTestUtils.browserLoaded(
    win.gBrowser.selectedBrowser,
    false,
    page
  );
  BrowserTestUtils.startLoadingURIString(win.gBrowser.selectedBrowser, page);
  await within(loaded, 10_000, "a page in the second window");
  await within(
    BrowserTestUtils.closeWindow(win),
    10_000,
    "the second window closing"
  );
  await TestUtils.waitForCondition(
    () => SessionStore.getClosedWindowCount() == 1,
    "the closed window is kept"
  );
  try {
    await PlacesUtils.history.clear();
    const titled = new Promise(resolve => {
      const listener = events => {
        if (events.some(event => event.url == page)) {
          PlacesUtils.observers.removeListener(
            ["page-title-changed"],
            listener
          );
          resolve();
        }
      };
      PlacesUtils.observers.addListener(["page-title-changed"], listener);
    });
    await BrowserTestUtils.withNewTab(page, () =>
      within(titled, 10_000, "the visit's title")
    );
  } finally {
    const [closed] = SessionStore.getClosedWindowData();
    SessionStore.forgetClosedWindowById(closed.closedId);
  }
});
