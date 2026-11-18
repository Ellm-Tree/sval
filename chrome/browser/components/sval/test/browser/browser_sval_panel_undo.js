/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_panel_helpers.js */

/**
 * The panel's Undo message holds a delete back: closing several tabs,
 * deleting a group and deleting a Workspace hide what went at once, unload
 * its tabs, and leave the document alone until the message goes. Undo shows
 * it all again; the message timing out, being dismissed, another delete, or
 * the window closing makes the delete.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_panel_helpers.js",
  this
);

const { SvalFirefox } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFirefox.sys.mjs"
);
const { SPLIT, TAB } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTree.sys.mjs"
);
const { SvalTabs } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTabs.sys.mjs"
);

/**
 * @param {Window} [win]
 * @returns {Element|null} the message showing in `win`'s panel.
 */
function message(win = window) {
  return win.SvalPanel._els.undoRegion.querySelector(".sval-undo");
}

/**
 * Presses the message's Undo, as a click on it does, and waits for what it
 * brings back.
 *
 * @param {Function} back Answers whether Undo is done.
 */
async function pressUndo(back) {
  const undo = message()?.querySelector('[data-command="undo"]');
  Assert.ok(undo, "the message offers Undo");
  undo.click();
  Assert.ok(!message(), "the message goes");
  await TestUtils.waitForCondition(back, "Undo brings it back");
  await within(SvalPanel.observer.settled(), 10_000, "the observer settling");
}

/**
 * Keeps each message `win`'s panel shows up for the rest of the task, as a
 * person does by resting the pointer on it (`_armUndo` pauses the message's
 * timer while it is hovered), and makes any delete still held back when the
 * task ends.
 *
 * @param {Window} [win]
 */
function messageLasts(win = window) {
  const region = win.SvalPanel._els.undoRegion;
  const hover = () => {
    const shown = region.querySelector(".sval-undo");
    if (shown) {
      EventUtils.synthesizeMouseAtCenter(shown, { type: "mousemove" }, win);
    }
  };
  const watch = new win.MutationObserver(hover);
  watch.observe(region, { childList: true });
  atTaskEnd(async () => {
    watch.disconnect();
    if (!win.closed) {
      pointerOffTheMessage(win);
      await within(
        win.SvalPanel.commitPendingDelete(),
        10_000,
        "a delete still held back being made"
      );
    }
  });
}

/**
 * Moves the pointer onto the page, off the panel's Undo message.
 *
 * @param {Window} [win]
 */
function pointerOffTheMessage(win = window) {
  EventUtils.synthesizeMouseAtCenter(
    win.gBrowser.selectedBrowser,
    { type: "mousemove" },
    win
  );
}

/**
 * Opens `count` tabs in this window's Workspace, each filed.
 *
 * @param {number} count
 * @returns {Promise<{tabs: object[], ids: string[]}>}
 */
async function openTabs(count) {
  const tabs = [];
  const ids = [];
  for (let i = 0; i < count; i++) {
    const tab = await within(
      BrowserTestUtils.openNewForegroundTab(gBrowser, `${PAGE2}?${i}`),
      10_000,
      "a page opening"
    );
    await filedAt(tab);
    tabs.push(tab);
    ids.push(SvalPanel.observer.nodeIdFor(tab));
  }
  return { tabs, ids };
}

/**
 * Closes the tab rows `ids` as one selection, through the row menu's Close.
 *
 * @param {string[]} ids
 */
async function closeRows(ids) {
  await SvalPanel.selection.select(ids[0]);
  for (const id of ids.slice(1)) {
    SvalPanel.selection.toggle(id);
  }
  await within(
    SvalPanel.run("close", SvalPanel._rowFor(ids.at(-1))),
    10_000,
    "the close"
  );
}

/**
 * A group in this window's Workspace holding `tabs`.
 *
 * @param {object[]} tabs
 * @returns {Promise<string>} its id.
 */
async function aGroupOf(tabs) {
  const engine = SvalPanel.engine;
  const group = await engine.mutate({
    kind: "addGroup",
    parent: SvalWindowWorkspace.of(window).id,
    name: "Reading",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  for (const tab of tabs) {
    await engine.mutate({
      kind: "moveNode",
      id: SvalPanel.observer.nodeIdFor(tab),
      newParent: group,
      before: null,
      after: null,
      now: Date.now(),
    });
  }
  await SvalPanel.refresh();
  atTaskEnd(async () => {
    if ((await nodes(engine))[group]) {
      await engine.mutate({ kind: "removeKeepingChildren", id: group });
      await SvalPanel.refresh();
    }
  });
  return group;
}

/**
 * Deletes `group` through its row's "Delete group…", answering the question
 * with `button`, and waits for the Undo message that holds the delete back.
 *
 * @param {string} group
 * @param {string} button `"ok"` to delete its tabs with it, `"extra"` to
 *   move them out.
 */
async function deleteGroup(group, button) {
  const earlier = message();
  await chooseOnRow(group, "deleteGroup");
  await answerDialog({ button });
  await TestUtils.waitForCondition(
    () => message() && message() !== earlier,
    "the Undo message for the delete shows"
  );
}

/**
 * Deletes workspace `id` through its menu's "Delete Workspace…", accepting
 * the question, and waits for the Undo message that holds the delete back.
 *
 * @param {string} id
 */
async function deleteWorkspace(id) {
  const earlier = message();
  await chooseOnWorkspace(id, "deleteWorkspace");
  await answerDialog();
  await TestUtils.waitForCondition(
    () => message() && message() !== earlier,
    "the Undo message for the delete shows"
  );
}

/**
 * Asserts that each of `tabs` is held back: no row, hidden, not on screen,
 * and its node still in the document.
 *
 * @param {object[]} tabs
 * @param {string[]} ids
 */
async function assertHeldBack(tabs, ids) {
  const all = await nodes(SvalPanel.engine);
  for (const [i, tab] of tabs.entries()) {
    Assert.ok(!SvalPanel._rowFor(ids[i]), "its row went at once");
    Assert.ok(SvalFirefox.isHiddenForDelete(tab), "its tab is hidden");
    Assert.ok(!tab.selected, "and not on screen");
    Assert.ok(ids[i] in all, "the document still holds its node");
  }
}

/**
 * Asserts that each of `tabs` shows again with its row.
 *
 * @param {object[]} tabs
 * @param {string[]} ids
 */
function assertShownAgain(tabs, ids) {
  for (const [i, tab] of tabs.entries()) {
    Assert.ok(gBrowser.tabs.includes(tab), "its tab stayed in the window");
    Assert.ok(!tab.hidden, "and shows again");
    Assert.ok(SvalPanel._rowFor(ids[i]), "its row is back");
  }
}

add_task(async function closing_several_tabs_waits_on_the_message() {
  messageLasts();
  const { tabs, ids } = await openTabs(3);
  const [first, second, third] = ids;
  const before = SvalPanel._rows.map(row => row.id);
  const onScreen = gBrowser.selectedTab;

  await closeRows([first, second]);
  await assertHeldBack(tabs.slice(0, 2), [first, second]);
  Assert.ok(message(), "Undo is offered");
  Assert.equal(
    message().closest('[role="status"]'),
    SvalPanel._els.undoRegion,
    "in a status region a screen reader announces"
  );
  Assert.ok(SvalPanel._rowFor(third), "a tab not selected stays");

  await pressUndo(() => SvalPanel._rowFor(second));
  assertShownAgain(tabs.slice(0, 2), [first, second]);
  Assert.deepEqual(
    SvalPanel._rows.map(row => row.id),
    before,
    "every row is back in its place"
  );
  Assert.equal(gBrowser.selectedTab, onScreen, "the tab on screen stays");
});

add_task(async function a_hidden_tab_is_unloaded_and_its_audio_stops() {
  messageLasts();
  await SpecialPowers.pushPrefEnv({
    set: [["media.autoplay.site-permission-only.default", 1]],
  });
  const { tabs, ids } = await openTabs(2);
  const noisy = tabs[1];
  await SpecialPowers.spawn(noisy.linkedBrowser, [], async () => {
    const context = new content.AudioContext();
    const oscillator = context.createOscillator();
    oscillator.connect(context.destination);
    oscillator.start();
    await context.resume();
  });
  await TestUtils.waitForCondition(
    () => noisy.hasAttribute("soundplaying"),
    "the tab really is playing audio"
  );

  await closeRows(ids);
  Assert.ok(SvalFirefox.isLazy(noisy), "the tab holds no page");
  Assert.ok(!noisy.hasAttribute("soundplaying"), "and plays nothing");
  Assert.ok(SvalFirefox.isLazy(tabs[0]), "the other is unloaded too");
  await assertHeldBack(tabs, ids);

  Assert.notEqual(gBrowser.selectedTab, noisy, "another tab is on screen");
  await pressUndo(
    () => SvalPanel._rowFor(ids[1]) && gBrowser.selectedTab === noisy
  );
  assertShownAgain(tabs, ids);
  Assert.equal(gBrowser.selectedTab, noisy, "the tab on screen is again");
  await TestUtils.waitForCondition(
    () => !SvalFirefox.isLazy(noisy),
    "and loads its page again"
  );
});

/**
 * The one task that waits out the message's own timer (`_undoMessageMs`).
 * The pointer is moved off the message first, since resting on it is what
 * holds the message up.
 */
add_task(async function the_delete_is_made_when_the_message_times_out() {
  const { tabs, ids } = await openTabs(2);
  pointerOffTheMessage();
  await closeRows(ids);
  Assert.ok(message(), "Undo is offered");
  await TestUtils.waitForCondition(
    () => !message(),
    "the message goes when its time is up",
    100,
    Math.ceil((2 * SvalPanel._undoMessageMs) / 100)
  );
  await TestUtils.waitForCondition(async () => {
    const all = await nodes(SvalPanel.engine);
    return ids.every(id => !(id in all));
  }, "the document loses both nodes");
  await TestUtils.waitForCondition(
    () => tabs.every(tab => !gBrowser.tabs.includes(tab)),
    "their tabs close"
  );
  const closed = SessionStore.getClosedTabDataForWindow(window).slice(0, 2);
  Assert.ok(
    closed.every(entry => !entry.state.hidden),
    "each closed tab Firefox keeps comes back shown"
  );
});

add_task(async function dismissing_the_message_makes_the_delete() {
  messageLasts();
  const { ids } = await openTabs(2);
  await closeRows(ids);
  message().querySelector('[data-command="dismissUndo"]').click();
  Assert.ok(!message(), "the message goes");
  await TestUtils.waitForCondition(async () => {
    const all = await nodes(SvalPanel.engine);
    return ids.every(id => !(id in all));
  }, "the document loses both nodes");
});

add_task(async function deleting_a_group_waits_and_undo_keeps_its_tabs() {
  messageLasts();
  const { tabs, ids } = await openTabs(2);
  const group = await aGroupOf(tabs);

  await deleteGroup(group, "ok");
  Assert.ok(!SvalPanel._rowFor(group), "the group's row went");
  await assertHeldBack(tabs, ids);
  Assert.ok(group in (await nodes(SvalPanel.engine)), "the group stays");

  await pressUndo(() => SvalPanel._rowFor(ids[1]));
  Assert.ok(SvalPanel._rowFor(group), "the group's row is back");
  assertShownAgain(tabs, ids);
  const all = await nodes(SvalPanel.engine);
  for (const id of ids) {
    Assert.equal(all[id].placement.parent, group, "each tab is in the group");
  }
});

add_task(async function a_group_deleted_with_its_tabs_goes_on_commit() {
  messageLasts();
  const { tabs, ids } = await openTabs(2);
  const group = await aGroupOf(tabs);
  await deleteGroup(group, "ok");
  await within(SvalPanel.commitPendingDelete(), 10_000, "the commit");
  const all = await nodes(SvalPanel.engine);
  Assert.ok(!(group in all), "the group went");
  Assert.ok(
    ids.every(id => !(id in all)),
    "with its tabs"
  );
  Assert.ok(
    tabs.every(tab => !gBrowser.tabs.includes(tab)),
    "whose tabs closed"
  );
});

add_task(async function a_group_whose_tabs_move_out_shows_them_meanwhile() {
  messageLasts();
  const { tabs, ids } = await openTabs(3);
  const group = await aGroupOf(tabs.slice(0, 2));
  const other = await aGroupOf([]);
  await deleteGroup(group, "extra");
  Assert.ok(!SvalPanel._rowFor(group), "the group's row went");
  const menu = await openContextMenu(SvalPanel._rowElementFor(ids[2]));
  const offered = Array.from(
    menu.querySelectorAll('[data-command="moveToGroup"] [data-move-parent]'),
    entry => entry.getAttribute("data-move-parent")
  );
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(hidden, 10_000, "the row menu closing");
  Assert.ok(!offered.includes(group), "Move to group leaves it out");
  Assert.ok(offered.includes(other), "and offers the group that stays");
  for (const [i, tab] of tabs.slice(0, 2).entries()) {
    Assert.ok(SvalPanel._rowFor(ids[i]), "its tab's row shows");
    Assert.ok(!tab.hidden, "and its tab");
  }
  Assert.equal(
    (await nodes(SvalPanel.engine))[ids[0]].placement.parent,
    group,
    "the document keeps the tab in the group"
  );

  await within(SvalPanel.commitPendingDelete(), 10_000, "the commit");
  const all = await nodes(SvalPanel.engine);
  Assert.ok(!(group in all), "the group went");
  Assert.equal(
    all[ids[0]].placement.parent,
    SvalWindowWorkspace.of(window).id,
    "and its tabs moved out"
  );
});

/**
 * A second Workspace, removed when the task ends.
 *
 * @returns {Promise<string>} its id.
 */
async function anotherWorkspace() {
  const engine = SvalPanel.engine;
  const id = crypto.randomUUID();
  await engine.mutate({
    kind: "batch",
    ops: [
      { kind: "addWorkspace", name: "Home", id },
      {
        kind: "addTab",
        parent: id,
        name: "Kept",
        url: PAGE2,
        id: crypto.randomUUID(),
      },
    ],
    now: Date.now(),
  });
  await SvalPanel.refresh();
  atTaskEnd(async () => {
    if ((await nodes(engine))[id]) {
      await removeWorkspace(id);
    }
  });
  return id;
}

add_task(async function a_workspace_waits_on_the_message_then_goes() {
  messageLasts();
  const other = await anotherWorkspace();

  await deleteWorkspace(other);
  Assert.ok(!(other in SvalPanel.nodes), "the panel leaves it out");
  Assert.ok(
    other in (await nodes(SvalPanel.engine)),
    "the document still holds it"
  );
  Assert.ok(message(), "Undo is offered");

  await pressUndo(() => other in SvalPanel.nodes);
  Assert.ok(other in SvalPanel.nodes, "Undo brings it back");

  await deleteWorkspace(other);
  await within(SvalPanel.commitPendingDelete(), 10_000, "the commit");
  Assert.ok(
    !(other in (await nodes(SvalPanel.engine))),
    "the commit deletes it"
  );
});

add_task(async function the_workspace_on_screen_is_left_and_shown_on_undo() {
  messageLasts();
  expectWorkspaceTabs();
  const shown = SvalWindowWorkspace.of(window).id;
  const other = await anotherWorkspace();

  await deleteWorkspace(shown);
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    other,
    "the window shows the Workspace that is left"
  );
  Assert.ok(
    shown in (await nodes(SvalPanel.engine)),
    "the document still holds the one deleted"
  );

  await pressUndo(() => SvalWindowWorkspace.of(window).id === shown);
});

add_task(async function a_second_delete_makes_the_first() {
  messageLasts();
  const { tabs, ids } = await openTabs(4);
  const group = await aGroupOf(tabs.slice(2));

  await closeRows(ids.slice(0, 2));
  await deleteGroup(group, "ok");
  Assert.equal(
    SvalPanel._els.undoRegion.querySelectorAll(".sval-undo").length,
    1,
    "one message shows"
  );
  let all = await nodes(SvalPanel.engine);
  Assert.ok(
    ids.slice(0, 2).every(id => !(id in all)),
    "the tabs closed first are deleted"
  );
  Assert.ok(group in all, "the group waits");

  await pressUndo(() => SvalPanel._rowFor(group));
  all = await nodes(SvalPanel.engine);
  Assert.ok(SvalPanel._rowFor(group), "Undo takes back the group's delete");
  Assert.ok(
    ids.slice(0, 2).every(id => !(id in all)),
    "and leaves the tabs closed"
  );
});

add_task(async function closing_the_window_makes_the_delete() {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    20_000,
    "a window opening"
  );
  const panel = win.SvalPanel;
  await TestUtils.waitForCondition(
    () => panel._observer && SvalWindowWorkspace.of(win).id,
    "the window's panel starts"
  );
  messageLasts(win);
  const tabs = [];
  for (let i = 0; i < 2; i++) {
    const tab = await within(
      BrowserTestUtils.openNewForegroundTab(win.gBrowser, `${PAGE2}?w${i}`),
      10_000,
      "a page opening"
    );
    await within(panel._observer.settled(), 10_000, "the observer settling");
    tabs.push(tab);
  }
  const ids = tabs.map(tab => panel._observer.nodeIdFor(tab));
  await TestUtils.waitForCondition(async () => {
    const all = await nodes(panel._engine);
    return ids.every(id => id && all[id]);
  }, "both tabs are filed");
  await panel.selection.select(ids[0]);
  panel.selection.toggle(ids[1]);
  await within(panel.run("close", panel._rowFor(ids[1])), 10_000, "the close");
  Assert.ok(message(win), "Undo is offered");

  await within(BrowserTestUtils.closeWindow(win), 10_000, "the window closing");
  // The shutdown blocker waits for these.
  await within(
    panel._engine.closedWindowsFlushed(),
    10_000,
    "the closed window's last writes"
  );
  await TestUtils.waitForCondition(async () => {
    const all = await nodes(SvalPanel.engine);
    return ids.every(id => !(id in all));
  }, "the document loses both nodes");
  const kept = SessionStore.getClosedWindowData().flatMap(
    data => data.tabs ?? []
  );
  Assert.ok(
    kept.every(entry => !entry.hidden),
    "the closed window keeps no hidden tab"
  );
});

/**
 * Closes every tab row of this window's Workspace, which leaves the window
 * a home tab, and answers it.
 *
 * @returns {Promise<{home: object, before: object}>}
 */
async function closeEveryTab() {
  const before = gBrowser.selectedTab;
  const ids = SvalPanel._rows
    .filter(row => row.kind === TAB)
    .map(row => row.id);
  const opened = BrowserTestUtils.waitForEvent(
    gBrowser.tabContainer,
    "TabOpen"
  );
  await closeRows(ids);
  const { target: home } = await within(opened, 10_000, "a home tab opening");
  expectOpened(home);
  Assert.equal(gBrowser.selectedTab, home, "the home tab is on screen");
  return { home, before };
}

add_task(async function undo_closes_an_unused_home_tab() {
  messageLasts();
  await openTabs(1);
  const { home, before } = await closeEveryTab();
  await pressUndo(() => !gBrowser.tabs.includes(home));
  Assert.equal(gBrowser.selectedTab, before, "the tab on screen is again");
});

add_task(async function undo_keeps_a_home_tab_that_was_used() {
  messageLasts();
  await openTabs(1);
  const { home, before } = await closeEveryTab();
  BrowserTestUtils.startLoadingURIString(home.linkedBrowser, PAGE);
  await within(
    BrowserTestUtils.browserLoaded(home.linkedBrowser, false, PAGE),
    10_000,
    "the home tab loading a page"
  );
  await pressUndo(() => gBrowser.selectedTab === before);
  Assert.ok(gBrowser.tabs.includes(home), "the used home tab stays");
});

add_task(async function escape_dismisses_the_message() {
  messageLasts();
  const { ids } = await openTabs(2);
  await closeRows(ids);
  Assert.ok(message(), "Undo is offered");
  SvalPanel._focusRow(SvalPanel._rows[0].id);
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  Assert.ok(!message(), "Escape in the tree takes it away");
  await TestUtils.waitForCondition(async () => {
    const all = await nodes(SvalPanel.engine);
    return ids.every(id => !(id in all));
  }, "and the delete is made");
});

add_task(async function a_quit_makes_the_delete() {
  messageLasts();
  await SpecialPowers.pushPrefEnv({ set: [["browser.warnOnQuit", false]] });
  const { tabs, ids } = await openTabs(2);
  await closeRows(ids);

  // As Mozilla's quit tests ask (`browser_quit_close_current_tab.js`):
  // `canQuitApplication` raises `quit-application-requested` and quits
  // nothing itself.
  Assert.ok(canQuitApplication(undefined, "shortcut"), "nothing held the quit");
  Assert.ok(
    tabs.every(tab => !gBrowser.tabs.includes(tab)),
    "the hidden tabs close at once"
  );
  Assert.ok(!message(), "and the message goes");
  await TestUtils.waitForCondition(async () => {
    const all = await nodes(SvalPanel.engine);
    return ids.every(id => !(id in all));
  }, "the document loses both nodes");
  const saved = JSON.parse(SessionStore.getBrowserState()).windows.flatMap(
    data => data.tabs ?? []
  );
  Assert.ok(
    !saved.some(entry => entry.hidden),
    "the session saves no hidden tab"
  );
  Assert.ok(
    !saved.some(entry => ids.includes(entry.extData?.[SvalTabs.NODE_ID_KEY])),
    "and neither deleted tab as open"
  );
});

add_task(async function a_restored_hide_no_delete_holds_shows_again() {
  const { tabs } = await openTabs(2);
  const [tab] = tabs;
  // The session store's record of a tab whose window closed while its
  // delete waited on the message, a delete that was never made.
  const state = JSON.parse(SessionStore.getTabState(tab));
  state.hidden = true;
  state.extData = { ...state.extData, hiddenBy: "sval-pending-delete" };
  SessionStore.setTabState(tab, JSON.stringify(state));
  Assert.ok(SvalFirefox.isHiddenForDelete(tab), "the tab comes back hidden");

  await within(SvalPanel.refresh(), 10_000, "a redraw");
  Assert.ok(!tab.hidden, "the next redraw shows it");
});

add_task(async function undo_shows_a_workspace_again_in_the_window_it_left() {
  messageLasts();
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    20_000,
    "a window opening"
  );
  const panel = win.SvalPanel;
  await TestUtils.waitForCondition(
    () => panel._observer && SvalWindowWorkspace.of(win).id,
    "the window's panel starts"
  );
  const shown = SvalWindowWorkspace.of(win).id;
  // Somewhere for the other window to go while its Workspace is held back.
  await anotherWorkspace();
  await deleteWorkspace(shown);
  await TestUtils.waitForCondition(
    () => SvalWindowWorkspace.of(win).id !== shown,
    "the other window leaves it"
  );

  await pressUndo(() => SvalWindowWorkspace.of(win).id === shown);
  // The switch names its workspace before it redraws and fades in. Closing
  // the window before then leaves the switch unfinished, and the redraw's
  // queued `takeKeptTabs` then trips `SvalSerialQueue`'s re-entry check.
  await within(
    SvalWindowWorkspace.of(win).switchesSettled(),
    10_000,
    "the workspace switch"
  );
  Assert.ok(!win.closed, "the other window stays open");
  await within(BrowserTestUtils.closeWindow(win), 10_000, "the window closing");
});

/**
 * @param {object} tab
 * @returns {object[]} the tabs of the window's split holding `tab`, or none.
 */
function splitOf(tab) {
  return (
    gBrowser.splitViews.find(split => split.tabs.includes(tab))?.tabs ?? []
  );
}

add_task(async function one_pane_of_a_split_waits_on_the_message() {
  messageLasts();
  // Firefox records the first split it shows, as its own tests clear.
  atTaskEnd(() =>
    Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed")
  );
  const { tabs, ids } = await openTabs(3);
  gBrowser.addTabSplitView([tabs[0], tabs[1]]);
  let split;
  await TestUtils.waitForCondition(async () => {
    await within(SvalPanel.observer.settled(), 10_000, "the observer settling");
    const all = await nodes(SvalPanel.engine);
    split = all[ids[0]]?.placement.parent;
    return all[split]?.kind === SPLIT && all[ids[1]].placement.parent === split;
  }, "the tree holds the split");

  await closeRows([ids[0], ids[2]]);
  await assertHeldBack([tabs[0], tabs[2]], [ids[0], ids[2]]);
  Assert.ok(SvalPanel._rowFor(ids[1]), "the other pane has a row");
  await TestUtils.waitForCondition(
    () => splitOf(tabs[1]).length < 2,
    "and shows alone"
  );
  Assert.equal(
    (await nodes(SvalPanel.engine))[ids[1]].placement.parent,
    split,
    "the document keeps the split"
  );

  await pressUndo(() => splitOf(tabs[0]).includes(tabs[1]) && !tabs[0].hidden);
  Assert.ok(SvalPanel._rowFor(split), "the split's row is back");

  await closeRows([ids[0], ids[2]]);
  await within(SvalPanel.commitPendingDelete(), 10_000, "the commit");
  const all = await nodes(SvalPanel.engine);
  Assert.ok(!(ids[0] in all), "the pane is deleted");
  Assert.ok(!(split in all), "with the split it left one page in");
  Assert.equal(
    all[ids[1]].placement.parent,
    SvalWindowWorkspace.of(window).id,
    "the other is an ordinary tab"
  );
  Assert.less(splitOf(tabs[1]).length, 2, "shown alone");
});

add_task(async function the_undo_key_undoes_with_focus_in_the_panel() {
  messageLasts();
  const { tabs, ids } = await openTabs(2);
  await closeRows(ids);
  SvalPanel._focusRow(SvalPanel._rows[0].id);
  EventUtils.synthesizeKey("z", { accelKey: true }, window);
  Assert.ok(!message(), "the message goes");
  await TestUtils.waitForCondition(
    () => SvalPanel._rowFor(ids[1]),
    "the undo key brings the rows back"
  );
  assertShownAgain(tabs, ids);
});

add_task(async function the_undo_key_stays_the_pages_and_the_fields() {
  messageLasts();
  const { tabs, ids } = await openTabs(3);
  await closeRows(ids.slice(0, 2));
  const held = tabs.slice(0, 2);

  gBrowser.selectedBrowser.focus();
  await TestUtils.waitForCondition(
    () =>
      document.commandDispatcher.focusedElement === gBrowser.selectedBrowser,
    "the page has focus"
  );
  EventUtils.synthesizeKey("z", { accelKey: true }, window);
  Assert.ok(message(), "with focus in a page the message stays");
  await assertHeldBack(held, ids.slice(0, 2));

  gURLBar.focus();
  gURLBar.select();
  EventUtils.sendString("abc", window);
  Assert.equal(gURLBar.value, "abc", "the field holds what was typed");
  EventUtils.synthesizeKey("z", { accelKey: true }, window);
  Assert.notEqual(gURLBar.value, "abc", "the key undoes the typing");
  Assert.ok(message(), "and leaves the message");
  await assertHeldBack(held, ids.slice(0, 2));
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
});
