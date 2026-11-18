/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * A tab the user moves into a window that shows another workspace, by a drag
 * (`gBrowser.adoptTab`), a drop of its row on that window's panel, or Move to
 * New Window (`gBrowser.replaceTabsWithWindow`), joins that window's
 * workspace (spec §10.7). Every task runs on the windows' own panels and the
 * profile's engine.
 */

const { childrenByParent, isWithin } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTree.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
});

add_setup(failOnConsoleErrors);

/**
 * @param {Window} win
 * @returns {Promise<void>} once `win`'s observer has nothing queued.
 */
function settledIn(win) {
  return within(
    win.SvalPanel.observer.settled(),
    10_000,
    "the window's observer settling"
  );
}

/** @returns {Promise<object>} the profile document's nodes. */
async function treeNodes() {
  return (await SvalPanel.engine.tree()).nodes ?? {};
}

/**
 * Closes the window showing workspace `id` and deletes the workspace when the
 * task ends. A window closing deletes a workspace made for it that nobody
 * touched (decision 0101), so whether there is one left to delete is read
 * once the closing window's observer has finished.
 *
 * @param {string} id
 */
function removedAtTaskEnd(id) {
  atTaskEnd(async () => {
    for (const win of BrowserWindowTracker.orderedWindows) {
      if (win !== window && SvalWindowWorkspace.of(win).id === id) {
        const observer = win.SvalPanel.observer;
        await within(
          BrowserTestUtils.closeWindow(win),
          10_000,
          "the test window closing"
        );
        await stopFixture({ observer });
      }
    }
    if ((await treeNodes())[id]) {
      await SvalPanel.engine.mutate({ kind: "remove", id });
    }
    await SvalPanel.refresh();
  });
}

/**
 * A second window, which opens on a workspace of its own, as a user's does.
 *
 * @returns {Promise<{win: Window, workspace: string}>}
 */
async function otherWindow() {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    20_000,
    "a new window's opening"
  );
  await within(win.SvalPanel.started, 20_000, "its panel starting");
  const workspace = SvalWindowWorkspace.of(win).id;
  Assert.ok(workspace, "the new window shows a workspace");
  Assert.notEqual(workspace, SvalWindowWorkspace.of(window).id, "of its own");
  removedAtTaskEnd(workspace);
  return { win, workspace };
}

/**
 * Opens `url` in a new tab of `win`, and waits for its node.
 *
 * @param {string} url
 * @param {Window} [win]
 * @returns {Promise<{tab: object, id: string}>}
 */
async function filedTab(url, win = window) {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(win.gBrowser, url),
    10_000,
    "the page's load"
  );
  await settledIn(win);
  const id = win.SvalPanel.observer.nodeIdFor(tab);
  Assert.ok(id && (await treeNodes())[id], "the tab is filed");
  return { tab, id };
}

/**
 * @param {Window} win
 * @param {string} id
 * @returns {boolean} whether `win`'s panel draws a row for `id`.
 */
function drawsRow(win, id) {
  return !!win.SvalPanel._els.tree.querySelector(
    `.sval-row:not(.sval-row-leaving)[data-node-id="${CSS.escape(id)}"]`
  );
}

/**
 * Waits for a Sval dialog to draw its buttons in `win`.
 *
 * @param {Window} win
 * @returns {Promise<Document>}
 */
async function dialogIn(win) {
  const box = win.gDialogBox;
  await TestUtils.waitForCondition(() => box.isOpen, "a question opens");
  await dialogShown(box.dialog, "the question's load");
  let doc;
  await TestUtils.waitForCondition(() => {
    doc = box.dialog?._frame.contentDocument;
    return doc?.querySelector(".sval-dialog-actions button.primary");
  }, "the question has drawn its buttons");
  return doc;
}

add_task(
  async function a_tab_dragged_into_another_workspaces_window_joins_it() {
    const home = SvalWindowWorkspace.of(window).id;
    const { win, workspace } = await otherWindow();
    const { tab, id } = await filedTab(PAGE);
    const before = (await treeNodes())[id];

    const moved = win.gBrowser.adoptTab(tab, { selectTab: true });
    Assert.ok(moved, "the tab moves to the other window");
    await settledIn(win);
    await settledIn(window);

    const nodes = await treeNodes();
    Assert.equal(
      win.SvalPanel.observer.nodeIdFor(moved),
      id,
      "it keeps its node"
    );
    Assert.equal(
      nodes[id].placement.parent,
      workspace,
      "which joins the workspace that window shows"
    );
    Assert.ok(!isWithin(nodes, id, home), "and leaves the one it came from");
    Assert.equal(nodes[id].content.url, before.content.url, "at its address");

    await win.SvalPanel.refresh();
    await SvalPanel.refresh();
    Assert.ok(drawsRow(win, id), "the window it reached draws its row");
    Assert.ok(!drawsRow(window, id), "and the window it left does not");
  }
);

add_task(async function a_grouped_tab_dragged_across_leaves_its_group() {
  const { group } = await viewingAGroupedTab();
  const tab = gBrowser.selectedTab;
  const id = SvalPanel.observer.nodeIdFor(tab);
  const { win, workspace } = await otherWindow();

  win.gBrowser.adoptTab(tab, { selectTab: true });
  await settledIn(win);
  await settledIn(window);

  const nodes = await treeNodes();
  Assert.equal(
    nodes[id].placement.parent,
    workspace,
    "the tab joins the other window's workspace itself"
  );
  Assert.equal(
    nodes[group].placement.parent,
    SvalWindowWorkspace.of(window).id,
    "and its group stays where it was"
  );
});

add_task(
  async function a_windows_last_tab_dragged_out_joins_the_window_it_reached() {
    const home = SvalWindowWorkspace.of(window).id;
    const { win } = await otherWindow();
    const { tab, id } = await filedTab(PAGE, win);
    for (const other of Array.from(win.gBrowser.tabs)) {
      if (other !== tab) {
        await BrowserTestUtils.removeTab(other);
      }
    }
    await settledIn(win);
    Assert.equal(win.gBrowser.tabs.length, 1, "the other window has one tab");

    const closed = BrowserTestUtils.domWindowClosed(win);
    const moved = gBrowser.adoptTab(tab, { selectTab: true });
    Assert.ok(moved, "the tab moves into this window");
    expectOpened(moved);
    await within(closed, 10_000, "the window it left closing with it");
    await settledIn(window);

    Assert.equal(SvalPanel.observer.nodeIdFor(moved), id, "it keeps its node");
    Assert.equal(
      (await treeNodes())[id]?.placement.parent,
      home,
      "which joins this window's workspace"
    );
    await BrowserTestUtils.removeTab(moved);
    await settledIn(window);
  }
);

add_task(async function a_tab_moved_to_a_new_window_joins_its_workspace() {
  const home = SvalWindowWorkspace.of(window).id;
  const { tab, id } = await filedTab(PAGE);

  const win = await newWindowAfter(() => {
    Assert.ok(
      gBrowser.replaceTabsWithWindow(tab),
      "Move to New Window takes the tab out"
    );
  });
  const workspace = SvalWindowWorkspace.of(win).id;
  removedAtTaskEnd(workspace);
  Assert.notEqual(workspace, home, "the new window shows another workspace");
  await settledIn(win);

  const moved = win.gBrowser.tabs.find(
    t => win.SvalPanel.observer.nodeIdFor(t) === id
  );
  Assert.ok(moved, "the new window holds the tab, under its node");
  Assert.equal(
    (await treeNodes())[id].placement.parent,
    workspace,
    "which joins the new window's workspace"
  );
});

/**
 * Opens a second window on an isolated workspace and drags a tab of this
 * window's, in the shared jar, into it.
 *
 * @returns {Promise<object>} `{ win, workspace, id, jar, question }`.
 */
async function dragIntoAnIsolatedWindow() {
  const { win, workspace } = await otherWindow();
  await SvalPanel.engine.mutate({
    kind: "setIsolation",
    id: workspace,
    isolated: true,
    now: Date.now(),
  });
  await win.SvalPanel.refresh();
  await settledIn(win);
  const { tab, id } = await filedTab(PAGE);
  const jar = tab.userContextId;

  const moved = win.gBrowser.adoptTab(tab, { selectTab: true });
  Assert.ok(moved, "the tab moves to the isolated workspace's window");
  const question = await dialogIn(win);
  Assert.ok(
    isWithin(await treeNodes(), id, SvalWindowWorkspace.of(window).id),
    "until the answer the tab stays in its workspace"
  );
  Assert.equal(moved.userContextId, jar, "and in its jar");
  return { win, workspace, id, jar, question };
}

add_task(async function a_drag_into_another_jar_moves_once_asked() {
  const { win, workspace, id, jar, question } =
    await dragIntoAnIsolatedWindow();
  question
    .querySelector('.sval-dialog-actions button[data-button="ok"]')
    .click();

  await TestUtils.waitForCondition(() => {
    const mine = win.gBrowser.tabs.find(
      t => win.SvalPanel.observer.nodeIdFor(t) === id
    );
    return mine && mine.userContextId !== jar;
  }, "Move reopens the tab in the isolated workspace's jar");
  await settledIn(win);
  Assert.equal(
    (await treeNodes())[id].placement.parent,
    workspace,
    "and the tab joins that workspace"
  );
});

add_task(
  async function cancelling_a_drag_into_another_jar_hands_the_tab_back() {
    const home = SvalWindowWorkspace.of(window).id;
    const { win, id, jar, question } = await dragIntoAnIsolatedWindow();
    const placed = (await treeNodes())[id].placement;
    question
      .querySelector('.sval-dialog-actions button[data-button="cancel"]')
      .click();

    let back;
    await TestUtils.waitForCondition(() => {
      back = gBrowser.tabs.find(t => SvalPanel.observer.nodeIdFor(t) === id);
      return back;
    }, "Cancel hands the tab back to the window it came from");
    expectOpened(back);
    await settledIn(window);
    await settledIn(win);
    Assert.equal(back.userContextId, jar, "in its own jar");
    Assert.deepEqual(
      (await treeNodes())[id].placement,
      placed,
      "and its node stays where it was, in this window's workspace"
    );
    Assert.ok(isWithin(await treeNodes(), id, home));
  }
);

/**
 * @param {string} parent
 * @returns {Promise<string[]>} the children of `parent`, in order.
 */
async function childrenIn(parent) {
  return childrenByParent(await treeNodes()).get(parent) ?? [];
}

/**
 * Drags row `id` from `from`'s panel and drops it on row `onto` of `to`'s, a
 * quarter of the way down it, in one drag session: the mouse starts it on
 * the row in `from`, and `dragover` and `drop` follow in `to`. A native mouse
 * cannot start a drag session where the suites run: headless GTK has no drag
 * service (`nsDragService::GetInstance`), and the macOS one starts a session
 * only from a real press on a view (`gLastDragView` in `nsDragService.mm`).
 * A session made for a test has no source node, so Gecko sends the source
 * no `dragend` (`nsBaseDragSession::FireDragEventAtSource`); this sends the
 * one a user's drag ends with, to the row it started on.
 *
 * @param {string} id
 * @param {Window} from
 * @param {string} onto
 * @param {Window} to
 * @returns {string} the drop's effect: "none" for a drop `to` refused.
 */
function dropRowOn(id, from, onto, to) {
  const target = to.SvalPanel._rowElementFor(onto);
  Assert.ok(target, "the window it is dropped on draws the row under it");
  const rect = target.getBoundingClientRect();
  const source = from.SvalPanel._rowElementFor(id);
  const effect = EventUtils.synthesizeDrop(
    source,
    target,
    null,
    "move",
    from,
    to,
    { clientY: rect.top + rect.height / 4 }
  );
  source.dispatchEvent(new from.DragEvent("dragend", { bubbles: true }));
  // The release a user's drop ends with. synthesizeDrop presses the button
  // and never lets it go, and while a press is held, a script's move or
  // resize of any window suppresses the drag service until a trusted mouseup
  // (`nsGlobalWindowOuter::CanMoveResizeWindows`), so every later drag in
  // the run would start without a session.
  EventUtils.synthesizeMouse(
    target,
    rect.width / 2,
    rect.height / 4,
    { type: "mouseup" },
    to
  );
  return effect;
}

/**
 * Opens another window holding two pages of its own, and a page in this
 * window whose row a task drops on that window's first row.
 *
 * @param {object} [options]
 * @param {boolean} [options.isolated] Whether the other workspace has a jar
 *   of its own.
 * @returns {Promise<object>} `{ win, workspace, id, first, children }`, with
 *   `children` the other workspace's before the drop.
 */
async function aRowToDropOnAnotherWindow({ isolated = false } = {}) {
  const { win, workspace } = await otherWindow();
  if (isolated) {
    await SvalPanel.engine.mutate({
      kind: "setIsolation",
      id: workspace,
      isolated: true,
      now: Date.now(),
    });
    await win.SvalPanel.refresh();
    await settledIn(win);
  }
  await filedTab(PAGE, win);
  await filedTab(PAGE2, win);
  const { id } = await filedTab(PAGE);
  await win.SvalPanel.refresh();
  await SvalPanel.refresh();
  const children = await childrenIn(workspace);
  Assert.greater(children.length, 1, "the other workspace holds rows");
  return { win, workspace, id, first: children[0], children };
}

add_task(
  async function a_tab_row_dropped_on_another_windows_panel_moves_there() {
    const home = SvalWindowWorkspace.of(window).id;
    const { win, workspace, id, first, children } =
      await aRowToDropOnAnotherWindow();
    const jar = SvalPanel.observer.tabFor(id).userContextId;

    Assert.equal(
      dropRowOn(id, window, first, win),
      "move",
      "the drop is taken"
    );
    let tab;
    await TestUtils.waitForCondition(() => {
      tab = win.SvalPanel.observer.tabFor(id);
      return tab;
    }, "the window it was dropped on holds the tab");
    await settledIn(win);
    await settledIn(window);

    Assert.ok(!SvalPanel.observer.tabFor(id), "and this window lets it go");
    Assert.equal(win.gBrowser.selectedTab, tab, "it is on screen there");
    Assert.equal(tab.userContextId, jar, "in the jar it had");
    Assert.deepEqual(
      await childrenIn(workspace),
      [id, ...children],
      "its node joins that window's workspace where it was dropped"
    );
    Assert.ok(!isWithin(await treeNodes(), id, home), "and leaves this one");
    Assert.equal(SvalPanel.draggedId, undefined, "the drag is over here");
    Assert.ok(
      win.SvalPanel._els.dropLine.hidden,
      "and the window it was dropped on draws no drop line"
    );

    await win.SvalPanel.refresh();
    await SvalPanel.refresh();
    Assert.ok(drawsRow(win, id), "the window it reached draws its row");
    Assert.ok(!drawsRow(window, id), "and the window it left does not");
  }
);

add_task(async function a_tab_row_dropped_into_another_jar_moves_once_asked() {
  const { win, workspace, id, first, children } =
    await aRowToDropOnAnotherWindow({ isolated: true });
  const jar = SvalPanel.observer.tabFor(id).userContextId;

  Assert.equal(dropRowOn(id, window, first, win), "move", "the drop is taken");
  const question = await dialogIn(win);
  Assert.ok(
    isWithin(await treeNodes(), id, SvalWindowWorkspace.of(window).id),
    "until the answer the tab stays in its workspace"
  );
  question
    .querySelector('.sval-dialog-actions button[data-button="ok"]')
    .click();

  await TestUtils.waitForCondition(() => {
    const tab = win.SvalPanel.observer.tabFor(id);
    return tab && tab.userContextId !== jar;
  }, "Move reopens the tab in the isolated workspace's jar");
  await settledIn(win);
  Assert.deepEqual(
    await childrenIn(workspace),
    [id, ...children],
    "and its node joins that workspace where it was dropped"
  );
});

add_task(async function another_windows_panel_refuses_a_group_row() {
  const { group } = await viewingAGroupedTab();
  const { win, workspace } = await otherWindow();
  await filedTab(PAGE, win);
  await win.SvalPanel.refresh();
  const [first] = await childrenIn(workspace);

  Assert.equal(
    dropRowOn(group, window, first, win),
    "none",
    "the other window's panel refuses the drop"
  );
  Assert.equal(
    (await treeNodes())[group].placement.parent,
    SvalWindowWorkspace.of(window).id,
    "and the group stays where it was"
  );
});
