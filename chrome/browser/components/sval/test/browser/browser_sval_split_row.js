/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * A split's row in the panel and its panes in the content area
 * (split-view spec §6.3, §6.4, §8): what the user sees of a split, and that
 * each act on the row is the one write the tree holds afterwards, which the
 * window then shows. `browser_sval_split_view.js` is the same through
 * Firefox's own split UI.
 */

const { CustomKeys } = ChromeUtils.importESModule(
  "moz-src:///browser/components/customkeys/CustomKeys.sys.mjs"
);
const SvalPanelModel = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);
const SvalTree = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTree.sys.mjs"
);

const isMac = AppConstants.platform === "macosx";

/** Split View's key: Control+Plus on macOS, Control+Shift+Plus elsewhere. */
const SPLIT_MODIFIERS = isMac ? "control" : "control,shift";

/**
 * Presses Split View's key. On macOS, as Control with the Plus key on a
 * German or Spanish layout, which types Plus unshifted: a US layout's
 * Control+Shift+= matches through the alternative characters only a native
 * event carries (browser_sval_keyboard_layouts.js). Elsewhere, as the = key
 * with Control and Shift on a US layout.
 */
function pressSplitKey() {
  EventUtils.synthesizeKey(
    "+",
    isMac
      ? { ctrlKey: true, code: "BracketRight" }
      : { ctrlKey: true, shiftKey: true, code: "Equal" }
  );
}

/** The workspace the window shows between tasks. */
let home = null;

/**
 * A workspace of the file's own in the window's document, which the window
 * switches to, so what is asserted is the window's own panel and tab
 * observer, and no tab of the profile's startup workspace is in the strip.
 */
add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  home = await SvalPanel.engine.mutate({
    kind: "addWorkspace",
    name: "Home",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  expectWorkspaceTabs();
  Assert.ok(
    await within(
      SvalWindowWorkspace.of(window).switchTo(home),
      10_000,
      "the switch to Home"
    ),
    "the window shows the file's workspace"
  );
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "the observer filing the switch"
  );
  registerCleanupFunction(() => {
    // Firefox records the first split it shows, as its own tests clear.
    Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed");
  });
});

/**
 * Deletes the nodes of `ids` when the task ends. The harness takes a task's
 * tabs out of the window without closing them as a person does, so their
 * nodes stay, and later tasks would draw them.
 *
 * @param {string[]} ids
 */
function forgetAtTaskEnd(ids) {
  atTaskEnd(async () => {
    const nodes = await settledNodes();
    const ops = ids
      .filter(id => id && nodes[id])
      .map(id => ({ kind: "remove", id }));
    if (ops.length) {
      await SvalPanel.engine.mutate({ kind: "batch", ops, now: Date.now() });
      await SvalPanel.refresh();
    }
  });
}

/** @returns {Promise<object>} the tree's nodes once the window is quiet. */
async function settledNodes() {
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  return (await SvalPanel.engine.tree()).nodes ?? {};
}

/**
 * @param {object} nodes
 * @returns {string[][]} the tree's splits, each as its tabs in pane order.
 */
function treeSplits(nodes) {
  const byParent = SvalTree.childrenByParent(nodes);
  return Object.keys(nodes)
    .filter(id => nodes[id].kind === SvalTree.SPLIT)
    .map(id => byParent.get(id) ?? [])
    .filter(panes => panes.length);
}

/** @returns {string[][]} the window's splits, by node id. */
function windowSplits() {
  return gBrowser.splitViews
    .map(split => split.tabs.map(tab => SvalPanel.observer.nodeIdFor(tab)))
    .filter(ids => ids.length);
}

/**
 * Waits until the tree and the window hold the same splits, `expected`.
 *
 * @param {string[][]} expected
 * @param {string} what
 */
async function untilSplits(expected, what) {
  const key = list => JSON.stringify(list.map(ids => ids.join(" ")).sort());
  // An earlier task's tabs leave the window with the harness's cleanup, and
  // their nodes may stay.
  const held = id =>
    gBrowser.tabs.some(tab => SvalPanel.observer.nodeIdFor(tab) === id);
  await TestUtils.waitForCondition(async () => {
    const nodes = await settledNodes();
    return (
      key(treeSplits(nodes).filter(panes => panes.some(held))) ===
        key(expected) && key(windowSplits()) === key(expected)
    );
  }, what);
}

/**
 * Opens `count` tabs on titled pages in the workspace the window shows.
 *
 * @param {number} count
 * @returns {Promise<{tabs: object[], ids: string[]}>}
 */
async function openTabs(count) {
  const tabs = [];
  for (let i = 0; i < count; i++) {
    tabs.push(
      await within(
        BrowserTestUtils.openNewForegroundTab(
          gBrowser,
          `data:text/html,<title>Pane ${i}</title>`
        ),
        10_000,
        "a tab opening"
      )
    );
  }
  await settledNodes();
  const ids = tabs.map(tab => SvalPanel.observer.nodeIdFor(tab));
  forgetAtTaskEnd(ids);
  return { tabs, ids };
}

/**
 * Writes a split of `ids` into the tree, as another device's pass brings
 * one in, and redraws as a pass does.
 *
 * @param {string[]} ids Tab ids in the workspace the window shows.
 * @returns {Promise<string>} the split's id.
 */
async function splitInTree(ids) {
  const nodes = await settledNodes();
  const split = crypto.randomUUID();
  const parent = nodes[ids[0]].placement.parent;
  const siblings = SvalTree.childrenByParent(nodes).get(parent);
  const ops = [
    {
      kind: "addSplit",
      parent,
      id: split,
      before: siblings[siblings.indexOf(ids[0]) - 1] ?? null,
      after: ids[0],
    },
  ];
  let last = null;
  for (const id of ids) {
    ops.push({
      kind: "moveNode",
      id,
      newParent: split,
      before: last,
      after: null,
    });
    last = id;
  }
  await SvalPanel.engine.mutate({ kind: "batch", ops, now: Date.now() });
  await SvalPanel.refresh();
  forgetAtTaskEnd([split]);
  return split;
}

/**
 * Opens `count` tabs and splits them, shown with the first selected.
 *
 * @param {number} count
 * @returns {Promise<{tabs: object[], ids: string[], split: string}>}
 */
async function shownSplit(count) {
  const { tabs, ids } = await openTabs(count);
  const split = await splitInTree(ids);
  await untilSplits([ids], `the split of ${count} is shown`);
  await within(
    BrowserTestUtils.switchTab(gBrowser, tabs[0]),
    10_000,
    "the tab switch"
  );
  await TestUtils.waitForCondition(
    () =>
      SvalPanel._rowElementFor(split)?.hasAttribute("data-sval-viewed") &&
      paneCell(ids[0])?.hasAttribute("data-sval-active"),
    "the panel shows the first pane viewed"
  );
  return { tabs, ids, split };
}

/**
 * @param {string} id A pane's tab id.
 * @returns {Element|null} its tile in the split's row.
 */
function paneCell(id) {
  return SvalPanel._els.tree.querySelector(
    `.sval-split-pane[data-node-id="${CSS.escape(id)}"]`
  );
}

/**
 * Opens the row menu on a pane's tile, as a right-click does.
 *
 * @param {string} id A pane's tab id.
 * @returns {Promise<Element>} the open menu.
 */
function paneMenu(id) {
  return rightClickOpens(paneCell(id), SvalPanel._els.contextMenu);
}

/**
 * Chooses one entry of the open row menu.
 *
 * @param {Element} menu
 * @param {string} command
 * @returns {Promise<void>}
 */
function choose(menu, command) {
  return chooseMenuItem(
    menu.querySelector(`[data-command="${command}"]`),
    menu,
    `"${command}"`
  );
}

/** @returns {Element[]} the content area's panels on screen, left to right. */
function panesOnScreen() {
  return Array.from(
    gBrowser.tabpanels.querySelectorAll(".split-view-panel-active")
  ).sort(
    (a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left
  );
}

/**
 * Alt-clicks a tab's row, which splits it with the viewed tab. Control+Shift+Plus
 * is the keyboard's way to the same split; the rows are a tree with a roving
 * tabindex, so a row other than the focused one is not focusable on its own.
 *
 * @param {Element} row
 */
function altClickRow(row) {
  AccessibilityUtils.setEnv({
    focusableRule: false,
    nonNegativeTabIndexRule: false,
  });
  EventUtils.synthesizeMouseAtCenter(row, { altKey: true });
  AccessibilityUtils.resetEnv();
}

add_task(async function a_split_is_one_row_holding_its_panes() {
  const { ids, split } = await shownSplit(3);

  const row = SvalPanel._rowElementFor(split);
  Assert.equal(row.getAttribute("role"), "treeitem", "the split is a row");
  Assert.equal(row.getAttribute("aria-expanded"), "true", "always expanded");
  Assert.ok(
    ["Pane 0", "Pane 1", "Pane 2"].every(title =>
      row.getAttribute("aria-label").includes(title)
    ),
    "named by its pages' titles"
  );
  Assert.ok(
    !drawnIds().some(id => ids.includes(id)),
    "and no pane has a row of its own"
  );
  const tray = row.querySelector(".sval-split-tray");
  Assert.equal(tray.getAttribute("role"), "group", "its panes are a group");
  const level = Number(row.getAttribute("aria-level"));
  const cells = Array.from(tray.querySelectorAll(".sval-split-pane"));
  Assert.deepEqual(
    cells.map(cell => cell.dataset.nodeId),
    ids,
    "of every pane, in pane order"
  );
  cells.forEach((cell, index) => {
    Assert.equal(cell.getAttribute("role"), "treeitem", "each a tree item");
    Assert.equal(
      Number(cell.getAttribute("aria-level")),
      level + 1,
      "one level in"
    );
    Assert.equal(cell.getAttribute("aria-posinset"), String(index + 1));
    Assert.equal(cell.getAttribute("aria-setsize"), "3", `${index + 1} of 3`);
    Assert.equal(cell.getAttribute("aria-label"), `Pane ${index}`);
  });
  Assert.equal(
    cells[0].getAttribute("aria-selected"),
    "true",
    "the viewed pane is selected"
  );
});

add_task(async function separate_from_a_panes_menu() {
  const { ids, split } = await shownSplit(2);
  const menu = await paneMenu(ids[1]);
  assertTidySeparators(menu, "a pane's menu");
  for (const command of [
    "rename",
    "moveToGroup",
    "close",
    "addTabToSplit",
    "separate",
    "movePaneLeft",
    "renameSplit",
    "closeSplit",
  ]) {
    Assert.ok(
      !menu.querySelector(`[data-command="${command}"]`).hidden,
      `the pane's menu offers ${command}`
    );
  }
  for (const command of ["createSplit", "addToSplit"]) {
    Assert.ok(
      menu.querySelector(`[data-command="${command}"]`).hidden,
      `but not ${command}`
    );
  }
  Assert.ok(
    menu.querySelector('[data-command="closeSplit"]').hasAttribute("data-both"),
    "Close All reads Close Both for two"
  );
  Assert.ok(
    menu
      .querySelector('[data-command="movePaneRight"]')
      .hasAttribute("disabled"),
    "the last pane cannot move right"
  );
  await choose(menu, "separate");

  await untilSplits([], "Separate leaves no split");
  const nodes = await settledNodes();
  Assert.ok(!nodes[split], "the split is gone from the tree");
  Assert.deepEqual(
    SvalTree.childrenByParent(nodes)
      .get(home)
      .filter(id => ids.includes(id)),
    ids,
    "and its tabs are where it was, in order"
  );
  Assert.deepEqual(
    drawnIds().filter(id => ids.includes(id)),
    ids,
    "each with a row of its own"
  );
});

add_task(async function move_pane_left_and_right() {
  const { tabs, ids } = await shownSplit(3);
  let menu = await paneMenu(ids[0]);
  Assert.ok(
    menu
      .querySelector('[data-command="movePaneLeft"]')
      .hasAttribute("disabled"),
    "the first pane cannot move left"
  );
  for (const [command, keycode] of [
    ["movePaneLeft", "VK_LEFT"],
    ["movePaneRight", "VK_RIGHT"],
    ["addTabToSplit", null],
  ]) {
    const item = menu.querySelector(`[data-command="${command}"]`);
    const key = document.getElementById(item.getAttribute("key"));
    Assert.equal(
      item.getAttribute("acceltext"),
      ShortcutUtils.prettifyShortcut(key),
      `${command} shows its key`
    );
    if (keycode) {
      Assert.equal(key.getAttribute("keycode"), keycode, `${command}'s key`);
      Assert.equal(key.getAttribute("modifiers"), "alt", "with Alt");
    } else {
      Assert.equal(key.id, "key_addTabSplitView", "the add-split key");
    }
  }
  Assert.ok(
    !menu
      .querySelector('[data-command="closeSplit"]')
      .hasAttribute("data-both"),
    "Close All for more than two"
  );
  await choose(menu, "movePaneRight");
  const moved = [ids[1], ids[0], ids[2]];
  await untilSplits([moved], "the pane moved right in the tree and window");
  await TestUtils.waitForCondition(
    () =>
      panesOnScreen()
        .map(panel => gBrowser.getTabForBrowser(panel.querySelector("browser")))
        .join() === [tabs[1], tabs[0], tabs[2]].join(),
    "and on screen"
  );
  Assert.deepEqual(
    Array.from(
      SvalPanel._els.tree.querySelectorAll(".sval-split-pane"),
      cell => cell.dataset.nodeId
    ),
    moved,
    "and in the row"
  );

  menu = await paneMenu(ids[0]);
  await choose(menu, "movePaneLeft");
  await untilSplits([ids], "and back left");
});

add_task(async function rename_split_names_the_row_and_clearing_unnames_it() {
  const { ids, split } = await shownSplit(2);

  await choose(await paneMenu(ids[0]), "renameSplit");
  await answerNameDialog("Research");
  await TestUtils.waitForCondition(
    () =>
      SvalPanel._rowElementFor(split)?.getAttribute("aria-label") ===
      "Research",
    "the row is named"
  );
  const row = SvalPanel._rowElementFor(split);
  Assert.equal(
    row.querySelector(".sval-split-name")?.textContent,
    "Research",
    "with the name over its panes"
  );
  Assert.equal(
    (await settledNodes())[split].content.name,
    "Research",
    "and the tree holds it"
  );

  await choose(await paneMenu(ids[0]), "renameSplit");
  await answerNameDialog("");
  await TestUtils.waitForCondition(() => {
    const label = SvalPanel._rowElementFor(split)?.getAttribute("aria-label");
    return (
      label !== "Research" &&
      ["Pane 0", "Pane 1"].every(title => label?.includes(title))
    );
  }, "an empty name shows the titles again");
  Assert.ok(
    !SvalPanel._rowElementFor(split).querySelector(".sval-split-name"),
    "with no caption"
  );
});

add_task(async function close_all_closes_every_pane() {
  const { ids, split } = await shownSplit(3);
  await choose(await paneMenu(ids[2]), "closeSplit");
  await untilSplits([], "the split is closed");
  const nodes = await settledNodes();
  Assert.ok(
    [split, ...ids].every(id => !nodes[id]),
    "with every pane, in the tree"
  );
  Assert.ok(
    ids.every(id => !SvalPanel.observer.tabFor(id)),
    "and in the window"
  );
});

add_task(async function create_split_on_a_tab_opens_the_picker_beside_it() {
  const { tabs, ids } = await openTabs(2);
  const menu = await rightClickOpens(
    SvalPanel._rowElementFor(ids[0]),
    SvalPanel._els.contextMenu
  );
  const item = menu.querySelector('[data-command="createSplit"]');
  Assert.equal(
    item.getAttribute("acceltext"),
    ShortcutUtils.prettifyShortcut(
      document.getElementById("key_addTabSplitView")
    ),
    "Create Split shows the add-split key"
  );
  await choose(menu, "createSplit");

  await TestUtils.waitForCondition(
    () => gBrowser.selectedTab.splitview?.tabs.length === 2,
    "a split is on screen"
  );
  const panes = gBrowser.selectedTab.splitview.tabs;
  expectOpened(panes[1]);
  Assert.equal(panes[0], tabs[0], "the tab is the left pane");
  await committed(panes[1].linkedBrowser, "about:opentabs");
  const picker = SvalPanel.observer.nodeIdFor(panes[1]);
  await untilSplits([[ids[0], picker]], "the tree holds the split");
  await TestUtils.waitForCondition(
    () => paneCell(picker)?.hasAttribute("data-sval-picker"),
    "the row shows the waiting pane"
  );
  Assert.ok(
    paneCell(picker).getAttribute("title"),
    "with a tooltip saying it is a pane to choose"
  );
});

add_task(async function alt_click_splits_and_then_adds_a_pane() {
  const { tabs, ids } = await openTabs(3);
  await within(
    BrowserTestUtils.switchTab(gBrowser, tabs[0]),
    10_000,
    "the tab switch"
  );
  altClickRow(SvalPanel._rowElementFor(ids[1]));
  await untilSplits([[ids[0], ids[1]]], "the two tabs are a split");
  Assert.equal(gBrowser.selectedTab, tabs[0], "the viewed tab stays viewed");
  Assert.equal(panesOnScreen().length, 2, "both on screen");

  altClickRow(SvalPanel._rowElementFor(ids[2]));
  await untilSplits([ids], "the third joins the split, at its end");
  await TestUtils.waitForCondition(
    () => panesOnScreen().length === 3,
    "three pages on screen"
  );
});

add_task(async function a_drop_on_a_split_rows_edge_goes_before_or_after_it() {
  const { ids: loose } = await openTabs(1);
  const { ids, split } = await shownSplit(2);
  // The rows as the panel draws them, which is what the user drops onto. The
  // panel redraws after the engine has written a move, so the tree can hold
  // the new order a moment before the panel shows it.
  const drawn = () =>
    Array.from(
      SvalPanel._els.tree.querySelectorAll(".sval-row[data-node-id]"),
      element => element.dataset.nodeId
    ).filter(id => id === loose[0] || id === split);
  const drop = fraction => {
    const row = SvalPanel._rowElementFor(split);
    const rect = row.getBoundingClientRect();
    return EventUtils.synthesizeDrop(
      SvalPanel._rowElementFor(loose[0]),
      row,
      null,
      "move",
      window,
      window,
      { clientY: rect.top + rect.height * fraction }
    );
  };
  const order = async () =>
    SvalTree.childrenByParent(await settledNodes())
      .get(home)
      .filter(id => id === loose[0] || id === split);

  Assert.equal(drop(0.9), "move", "a drop on the bottom edge is taken");
  await TestUtils.waitForCondition(
    async () => (await order()).join() === [split, loose[0]].join(),
    "and lands after the split"
  );
  await TestUtils.waitForCondition(
    () => drawn().join() === [split, loose[0]].join(),
    "and is drawn there"
  );
  Assert.equal(drop(0.1), "move", "a drop on the top edge is taken");
  await TestUtils.waitForCondition(
    async () => (await order()).join() === [loose[0], split].join(),
    "and lands before it"
  );
  await TestUtils.waitForCondition(
    () => drawn().join() === [loose[0], split].join(),
    "and is drawn there"
  );
  Assert.deepEqual(
    treeSplits(await settledNodes()),
    [ids],
    "with the split as it was"
  );
});

/**
 * Opens the row menu of `id`'s tab row, as a right-click does.
 *
 * @param {string} id A tab's id, in no split.
 * @returns {Promise<Element>} the menu, shown.
 */
function tabMenu(id) {
  return rightClickOpens(
    SvalPanel._rowElementFor(id),
    SvalPanel._els.contextMenu
  );
}

/**
 * The picker pane the window added to the split `tab` is in, once the tree
 * holds it.
 *
 * @param {object} tab A tab in the split.
 * @param {number} count How many panes the split then has.
 * @returns {Promise<object>} the picker's tab.
 */
async function addedPicker(tab, count) {
  await TestUtils.waitForCondition(
    () => tab.splitview?.tabs.length === count,
    `the split shows ${count} panes`
  );
  const picker = tab.splitview.tabs.at(-1);
  expectOpened(picker);
  await committed(picker.linkedBrowser, "about:opentabs");
  Assert.equal(gBrowser.selectedTab, picker, "and is in view");
  return picker;
}

add_task(async function add_tab_to_split_adds_a_picker_pane_at_its_end() {
  const { tabs, ids } = await shownSplit(2);
  await choose(await paneMenu(ids[1]), "addTabToSplit");
  const picker = await addedPicker(tabs[0], 3);
  await untilSplits(
    [[...ids, SvalPanel.observer.nodeIdFor(picker)]],
    "the tree holds the picker as the rightmost pane"
  );
});

add_task(async function add_tab_to_split_is_disabled_on_a_full_split() {
  const { ids } = await shownSplit(4);
  const menu = await paneMenu(ids[0]);
  Assert.ok(
    menu
      .querySelector('[data-command="addTabToSplit"]')
      .hasAttribute("disabled"),
    "a split of four takes no more"
  );
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(hidden, 10_000, "the menu closing");
});

add_task(async function the_split_key_in_a_split_adds_a_pane() {
  const { tabs, ids } = await shownSplit(3);
  pressSplitKey();
  const picker = await addedPicker(tabs[0], 4);
  await untilSplits(
    [[...ids, SvalPanel.observer.nodeIdFor(picker)]],
    "the tree holds the fourth pane"
  );

  const count = gBrowser.tabs.length;
  pressSplitKey();
  await settledNodes();
  Assert.equal(tabs[0].splitview.tabs.length, 4, "a full split stays as it is");
  Assert.equal(gBrowser.tabs.length, count, "and no tab opened");
});

add_task(async function add_to_split_moves_a_tab_into_the_chosen_split() {
  const { ids: loose } = await openTabs(1);
  const { ids, split } = await shownSplit(2);
  await SvalPanel.engine.mutate({
    kind: "rename",
    id: split,
    name: "Reading",
    now: Date.now(),
  });
  await SvalPanel.refresh();
  const menu = await tabMenu(loose[0]);
  const parent = menu.querySelector('[data-command="addToSplit"]');
  Assert.ok(!parent.hidden && !parent.disabled, "Add to Split is offered");
  const entries = Array.from(parent.querySelectorAll("menuitem"));
  Assert.deepEqual(
    entries.map(entry => entry.label),
    ["Reading"],
    "listing the split by its name"
  );
  await chooseMenuItem(entries[0], menu, "the split");

  await untilSplits([[...ids, loose[0]]], "the tab is the rightmost pane");
});

add_task(async function a_drop_on_a_split_rows_split_zone_joins_it() {
  const { ids: loose } = await openTabs(1);
  const { ids, split } = await shownSplit(2);
  const row = SvalPanel._rowElementFor(split);
  const rect = row.getBoundingClientRect();
  const effect = EventUtils.synthesizeDrop(
    SvalPanel._rowElementFor(loose[0]),
    row,
    null,
    "move",
    window,
    window,
    { clientX: rect.right - 20, clientY: rect.top + rect.height / 2 }
  );
  Assert.equal(effect, "move", "the drop is taken");
  await untilSplits([[...ids, loose[0]]], "the tab joins the split's end");
});

/**
 * A drag from `source` over `target`, through dispatched `DragEvent`s carrying
 * one `DataTransfer`, so a test can look at what is drawn between `dragover`
 * and `drop` (`browser_sval_panel_drag.js`' `DispatchedDrag` has the reason).
 *
 * @param {Element} source The row or tile dragged.
 * @param {Element} target The row dragged over.
 * @param {object} [options]
 * @param {string} [options.zone] "group", the middle's inline-start half;
 *   "split", the split zone at the row's inline end; or "tile", the middle
 *   of `options.tile`.
 * @param {Element} [options.tile] For "tile".
 * @returns {object} `{ over, drop }`.
 */
function dispatchedDrag(source, target, { zone = "group", tile } = {}) {
  const dataTransfer = new DataTransfer();
  const send = (type, element, at) => {
    const rect = element.getBoundingClientRect();
    const event = new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: at?.x ?? rect.left + rect.width / 2,
      clientY: at?.y ?? rect.top + rect.height / 2,
      dataTransfer,
    });
    element.dispatchEvent(event);
    return event;
  };
  const point = () => {
    const rect = target.getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    if (zone === "split") {
      return { x: rect.right - 20, y };
    }
    if (zone === "tile") {
      const box = tile.getBoundingClientRect();
      return { x: box.left + box.width * 0.9, y };
    }
    return { x: rect.left + 60, y };
  };
  send("dragstart", source);
  return {
    over: () => send("dragover", target, point()),
    drop: () => {
      send("dragover", target, point());
      send("drop", target, point());
      send("dragend", source);
    },
  };
}

/**
 * The document of the window's dialog once it has drawn `selector`. A dialog
 * that is closing is still `gDialogBox.dialog` until it goes, so it is passed
 * over for the one after it.
 *
 * @param {string} selector
 * @returns {Promise<Document>}
 */
async function dialogDrawing(selector) {
  let dialog;
  await TestUtils.waitForCondition(() => {
    dialog = gDialogBox.dialog;
    return dialog && !dialog._isClosing;
  }, "a dialog opens");
  await dialogShown(dialog, "the dialog's load");
  const doc = dialog._frame.contentDocument;
  await TestUtils.waitForCondition(
    () => doc.querySelector(selector),
    `the dialog has drawn ${selector}`
  );
  return doc;
}

/**
 * Types `value` into the field of a dialog, presses `button`, and waits for
 * the dialog to go.
 *
 * @param {Document} doc
 * @param {string} field The field's selector.
 * @param {string} button The button's selector.
 * @param {string} value
 */
async function typeAndPress(doc, field, button, value) {
  const input = doc.querySelector(field);
  input.value = value;
  input.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
  doc.querySelector(button).click();
  await TestUtils.waitForCondition(
    () => gDialogBox.dialog?._frame?.contentDocument !== doc,
    "the dialog closes"
  );
}

/**
 * Answers the new group dialog the window shows (`SvalNewWorkspace`) as a
 * person does: types `name` and presses Create.
 *
 * @param {string} name
 */
async function answerContainerDialog(name) {
  const doc = await dialogDrawing(".sval-nw-name");
  await typeAndPress(doc, ".sval-nw-name", ".sval-nw-create", name);
}

/**
 * Answers the Sval dialog that asks for a name (`openSvalDialog`) as a
 * person does: types `value` and presses its OK button.
 *
 * @param {string} value
 */
async function answerNameDialog(value) {
  const doc = await dialogDrawing(".sval-dialog-input");
  await typeAndPress(
    doc,
    ".sval-dialog-input",
    '.sval-dialog-actions [data-button="ok"]',
    value
  );
}

/**
 * Waits until a group holds `children` in that order, and returns it.
 *
 * @param {string} split A split among `children`.
 * @param {string[]} children
 * @returns {Promise<string>} the group's id.
 */
async function untilGrouped(split, children) {
  let group = null;
  await TestUtils.waitForCondition(async () => {
    const nodes = await settledNodes();
    group = nodes[split]?.placement.parent;
    return (
      nodes[group]?.kind === "group" &&
      SvalTree.childrenByParent(nodes).get(group).join() === children.join()
    );
  }, "a group holds the two, the target first");
  forgetAtTaskEnd([group]);
  return group;
}

/** @returns {string} the drop the mark shows: its `data-kind`. */
function markKind() {
  return SvalPanel._els.dropMark.dataset.kind;
}

/**
 * @param {string} name "group" or "split".
 * @returns {object} how the mark draws that half: `{ kind, active, faint }`,
 *   `kind` the drop it shows.
 */
function markHalf(name) {
  const half = SvalPanel._els.dropMark.querySelector(`[data-half="${name}"]`);
  return {
    kind: half.dataset.kind,
    active: half.hasAttribute("data-active"),
    faint: half.hasAttribute("data-faint"),
  };
}

add_task(async function a_split_on_a_tabs_middle_makes_a_group_of_both() {
  const { ids: loose } = await openTabs(1);
  const { ids, split } = await shownSplit(2);
  const target = SvalPanel._rowElementFor(loose[0]);
  const drag = dispatchedDrag(SvalPanel._rowElementFor(split), target);
  Assert.ok(drag.over().defaultPrevented, "the drop is taken");
  Assert.deepEqual(
    markHalf("group"),
    { kind: "newGroup", active: true, faint: false },
    "as a new group, its half filled"
  );
  Assert.equal(markKind(), "newGroup", "and labelled");
  drag.drop();
  await answerContainerDialog("Pair");
  await untilGrouped(split, [loose[0], split]);
  await untilSplits([ids], "and the split is whole, in the tree and on screen");
});

add_task(async function the_split_icon_carries_the_whole_split() {
  const { ids: loose } = await openTabs(1);
  const { ids, split } = await shownSplit(2);
  const drag = dispatchedDrag(
    SvalPanel._rowElementFor(split).querySelector(".sval-split-glyph"),
    SvalPanel._rowElementFor(loose[0])
  );
  drag.over();
  Assert.equal(SvalPanel._drag.id, split, "the drag carries the split");
  drag.drop();
  await answerContainerDialog("Pair");
  await untilGrouped(split, [loose[0], split]);
  await untilSplits([ids], "whole");
});

add_task(async function a_full_splits_split_zone_is_refused_and_says_so() {
  const { ids: loose } = await openTabs(1);
  const { ids, split } = await shownSplit(4);
  const target = SvalPanel._rowElementFor(split);
  const tab = SvalPanel._rowElementFor(loose[0]);
  let drag = dispatchedDrag(tab, target, { zone: "split" });
  Assert.ok(
    !drag.over().defaultPrevented,
    "a full split refuses its split zone"
  );
  Assert.equal(markKind(), "full", "and says why");
  Assert.deepEqual(
    markHalf("split"),
    { kind: "full", active: true, faint: true },
    "on a faint half"
  );
  const label = SvalPanel._els.dropMark.querySelector(
    '[data-half="split"] .sval-drop-label'
  ).textContent;
  Assert.ok(label.includes("4"), "naming the limit");
  Assert.deepEqual(
    markHalf("group"),
    { kind: "newGroup", active: false, faint: false },
    "beside the group half, which still writes"
  );
  Assert.equal(
    SvalPanel._els.dropAnnounce.textContent,
    label,
    "and says so to a screen reader"
  );
  drag = dispatchedDrag(tab, target);
  Assert.ok(drag.over().defaultPrevented, "its middle still makes a group");
  drag.drop();
  await answerContainerDialog("Pair");
  await untilGrouped(split, [split, loose[0]]);
  await untilSplits([ids], "and the split is whole");
});

add_task(async function a_tab_in_a_splits_split_zone_joins_it() {
  const { ids: loose } = await openTabs(1);
  const { ids, split } = await shownSplit(2);
  const target = SvalPanel._rowElementFor(split);
  const drag = dispatchedDrag(SvalPanel._rowElementFor(loose[0]), target, {
    zone: "split",
  });
  Assert.ok(drag.over().defaultPrevented, "the drop is taken");
  Assert.deepEqual(
    markHalf("split"),
    { kind: "join", active: true, faint: false },
    "its half filled"
  );
  Assert.equal(markKind(), "join", "and labelled");
  drag.drop();
  await untilSplits([[...ids, loose[0]]], "the tab joins the split's end");
});

add_task(async function a_tab_in_a_tabs_split_zone_splits_them_together() {
  const { ids } = await openTabs(2);
  const drag = dispatchedDrag(
    SvalPanel._rowElementFor(ids[1]),
    SvalPanel._rowElementFor(ids[0]),
    { zone: "split" }
  );
  drag.over();
  Assert.equal(markKind(), "split", "labelled for a new split");
  drag.drop();
  await untilSplits([ids], "a split of the two, the target on the left");
  forgetAtTaskEnd([(await settledNodes())[ids[0]].placement.parent]);
});

add_task(async function a_split_in_a_splits_split_zone_merges_them() {
  const { ids: first, split } = await shownSplit(2);
  const { ids: second } = await openTabs(2);
  const other = await splitInTree(second);
  await untilSplits([first, second], "two splits are shown");
  const drag = dispatchedDrag(
    SvalPanel._rowElementFor(other),
    SvalPanel._rowElementFor(split),
    { zone: "split" }
  );
  drag.over();
  Assert.equal(markKind(), "merge", "labelled for a merge");
  drag.drop();
  await untilSplits([[...first, ...second]], "one split of all four");
});

add_task(async function a_tile_dragged_along_its_split_reorders_it() {
  const { ids, split } = await shownSplit(3);
  const row = SvalPanel._rowElementFor(split);
  const drag = dispatchedDrag(paneCell(ids[0]), row, {
    zone: "tile",
    tile: paneCell(ids[2]),
  });
  Assert.ok(drag.over().defaultPrevented, "the drop is taken");
  Assert.equal(SvalPanel._drag.id, ids[0], "the tile carries its page");
  Assert.ok(!SvalPanel._els.dropBar.hidden, "with a bar where it would land");
  drag.drop();
  await untilSplits([[ids[1], ids[2], ids[0]]], "the page moved to the end");
  for (const tab of gBrowser.selectedTab.splitview.tabs) {
    const footer = document
      .getElementById(tab.linkedPanel)
      .querySelector("split-view-footer");
    Assert.equal(
      footer?.querySelector(".split-view-uri").textContent,
      BrowserUtils.formatURIForDisplay(tab.linkedBrowser.currentURI),
      "each pane's footer still names its own page"
    );
  }
});

add_task(async function the_split_button_stands_after_the_address_bar() {
  const { tabs: loose } = await openTabs(1);
  const button = document.getElementById("split-view-button");
  Assert.ok(
    !button.closest("#urlbar-container"),
    "the split button is outside the address bar"
  );
  // Firefox decides on the button in a deferred task after a tab is
  // selected (`updateUrlbarButton` in tabsplitview.js).
  await TestUtils.waitForCondition(
    () => BrowserTestUtils.isHidden(button),
    "and hidden with no split"
  );

  const { tabs } = await shownSplit(2);
  await TestUtils.waitForCondition(
    () => BrowserTestUtils.isVisible(button),
    "it shows while a pane is selected"
  );
  const menu = document.getElementById("split-view-menu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  button.click();
  await within(shown, 10_000, "the split menu showing");
  Assert.equal(menu.anchorNode, button, "from the split button");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(hidden, 10_000, "the split menu closing");

  await within(
    BrowserTestUtils.switchTab(gBrowser, loose[0]),
    10_000,
    "the tab switch"
  );
  await TestUtils.waitForCondition(
    () => BrowserTestUtils.isHidden(button),
    "and hides again on a tab in no split"
  );
  Assert.ok(tabs[0].splitview, "while the split stays");
});

add_task(async function a_dragged_tile_leaves_the_split() {
  const { ids: loose } = await openTabs(1);
  const { ids } = await shownSplit(3);
  const target = SvalPanel._rowElementFor(loose[0]);
  const rect = target.getBoundingClientRect();
  const dataTransfer = new DataTransfer();
  const send = (type, element, y) =>
    element.dispatchEvent(
      new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 60,
        clientY: y,
        dataTransfer,
      })
    );
  send("dragstart", paneCell(ids[2]), rect.top);
  send("dragover", target, rect.top + 2);
  send("drop", target, rect.top + 2);
  send("dragend", paneCell(ids[2]), rect.top);
  await untilSplits([[ids[0], ids[1]]], "the split keeps the other two");
  const nodes = await settledNodes();
  Assert.equal(
    nodes[ids[2]].placement.parent,
    home,
    "the dragged pane is an ordinary tab"
  );
  Assert.ok(drawnIds().includes(ids[2]), "with a row of its own");
});

add_task(async function arrow_keys_move_between_rows_and_panes() {
  const { ids: before } = await openTabs(1);
  const { ids, split } = await shownSplit(3);
  const { ids: after } = await openTabs(1);
  await within(
    BrowserTestUtils.switchTab(gBrowser, SvalPanel.observer.tabFor(ids[0])),
    10_000,
    "the tab switch"
  );
  SvalPanel._focusRow(ids[0]);
  const focused = () =>
    document.activeElement?.closest?.("[data-node-id]")?.dataset.nodeId;
  Assert.equal(focused(), ids[0], "the first pane has the focus");

  EventUtils.synthesizeKey("KEY_ArrowRight");
  Assert.equal(focused(), ids[1], "Right goes to the next pane");
  EventUtils.synthesizeKey("KEY_ArrowRight");
  EventUtils.synthesizeKey("KEY_ArrowRight");
  Assert.equal(focused(), ids[2], "and stops at the last");
  EventUtils.synthesizeKey("KEY_ArrowLeft");
  Assert.equal(focused(), ids[1], "Left goes back");

  EventUtils.synthesizeKey("KEY_ArrowDown");
  Assert.equal(focused(), after[0], "Down goes to the next row");
  EventUtils.synthesizeKey("KEY_ArrowUp");
  Assert.equal(focused(), ids[0], "Up comes back to the active pane");
  EventUtils.synthesizeKey("KEY_ArrowUp");
  Assert.equal(focused(), before[0], "and on to the row above");
  EventUtils.synthesizeKey("KEY_ArrowDown");

  EventUtils.synthesizeKey("KEY_ArrowRight");
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(
    () => SvalPanel.observer.nodeIdFor(gBrowser.selectedTab) === ids[1],
    "Enter shows the focused pane"
  );
  Assert.ok(
    SvalPanel._rowElementFor(split).hasAttribute("data-sval-viewed"),
    "and the split stays viewed"
  );
});

add_task(async function a_footer_follows_its_pane_to_another_site() {
  const { tabs } = await shownSplit(2);
  const footer = document
    .getElementById(tabs[1].linkedPanel)
    .querySelector("split-view-footer");
  for (const url of ["https://example.com/", "https://example.org/"]) {
    const loaded = BrowserTestUtils.browserLoaded(
      tabs[1].linkedBrowser,
      false,
      url
    );
    BrowserTestUtils.startLoadingURIString(tabs[1].linkedBrowser, url);
    await within(loaded, 10_000, "the inactive pane loading");
    await TestUtils.waitForCondition(
      () =>
        footer.querySelector(".split-view-uri").textContent ===
        new URL(url).host,
      `the footer names ${new URL(url).host}`
    );
  }
});

add_task(async function a_restored_panes_footer_names_its_page() {
  const { SvalFirefox } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalFirefox.sys.mjs"
  );
  const { tabs } = await openTabs(1);
  // As Sval restores a tab: lazy, given its page, loading nothing yet.
  const restored = gBrowser.addTrustedTab(null, {
    createLazyBrowser: true,
    skipLoad: true,
  });
  expectOpened(restored);
  SessionStore.setTabState(restored, {
    entries: [
      {
        url: "https://example.org/",
        title: "Example",
        triggeringPrincipal_base64: E10SUtils.SERIALIZED_SYSTEMPRINCIPAL,
      },
    ],
    index: 1,
  });
  SvalFirefox.showSplit(window, [tabs[0], restored]);
  Assert.equal(
    gBrowser.selectedTab,
    tabs[0],
    "the other pane is the active one"
  );
  await committed(restored.linkedBrowser, "https://example.org/");
  const footer = document
    .getElementById(restored.linkedPanel)
    .querySelector("split-view-footer");
  await TestUtils.waitForCondition(
    () => footer.querySelector(".split-view-uri").textContent === "example.org",
    () =>
      `the footer names it, not "${footer.querySelector(".split-view-uri").textContent}"`
  );
});

add_task(
  async function a_footer_follows_its_pane_through_a_remoteness_change() {
    const { tabs } = await shownSplit(2);
    const browser = tabs[1].linkedBrowser;
    const footer = document
      .getElementById(tabs[1].linkedPanel)
      .querySelector("split-view-footer");
    // What a restored tab's first load can do: the browser is rebuilt in
    // another kind of process, with a new web progress.
    gBrowser.updateBrowserRemoteness(browser, {
      remoteType: E10SUtils.NOT_REMOTE,
    });
    const loaded = BrowserTestUtils.browserLoaded(
      browser,
      false,
      "https://example.org/"
    );
    BrowserTestUtils.startLoadingURIString(browser, "https://example.org/");
    await within(loaded, 10_000, "the pane loading");
    await TestUtils.waitForCondition(
      () =>
        footer.querySelector(".split-view-uri").textContent === "example.org",
      "the footer names the page it loaded"
    );
  }
);

add_task(async function a_footer_put_back_in_its_pane_still_follows_it() {
  const { tabs } = await shownSplit(2);
  const panel = document.getElementById(tabs[1].linkedPanel);
  const footer = panel.querySelector("split-view-footer");
  // Taken out of the document and put back, as any move of it does.
  footer.parentNode.append(footer);
  const loaded = BrowserTestUtils.browserLoaded(
    tabs[1].linkedBrowser,
    false,
    "https://example.org/"
  );
  BrowserTestUtils.startLoadingURIString(
    tabs[1].linkedBrowser,
    "https://example.org/"
  );
  await within(loaded, 10_000, "the pane loading");
  await TestUtils.waitForCondition(
    () => footer.querySelector(".split-view-uri").textContent === "example.org",
    "the footer names the page it loaded"
  );
});

add_task(async function the_active_pane_has_no_footer() {
  const { tabs } = await shownSplit(3);
  const footerOf = tab =>
    document.getElementById(tab.linkedPanel).querySelector("split-view-footer");
  await TestUtils.waitForCondition(
    () => tabs.slice(1).every(tab => BrowserTestUtils.isVisible(footerOf(tab))),
    "the inactive panes show their footers"
  );
  Assert.ok(
    !BrowserTestUtils.isVisible(footerOf(tabs[0])),
    "the active pane shows none"
  );

  // A click on a footer makes its pane the active one. The footer's address
  // is a mouse target alone: keyboard focus moves into a pane's page, which
  // makes that pane the active one.
  AccessibilityUtils.setEnv({ mustHaveAccessibleRule: false });
  EventUtils.synthesizeMouseAtCenter(
    footerOf(tabs[1]).querySelector(".split-view-uri"),
    {}
  );
  AccessibilityUtils.resetEnv();
  await TestUtils.waitForCondition(
    () => gBrowser.selectedTab === tabs[1],
    "a click on a footer makes its pane active"
  );
  Assert.ok(
    !BrowserTestUtils.isVisible(footerOf(tabs[1])),
    "and its footer goes"
  );
});

add_task(async function a_footers_close_closes_its_pane_alone() {
  const { tabs, ids } = await shownSplit(3);
  const menu = document.getElementById("split-view-menu");
  const closeAll = menu.querySelector('[command="splitViewCmd_closeTabs"]');

  // Opened from the header's split button, which the user sees.
  const button = document.getElementById("split-view-button");
  await TestUtils.waitForCondition(
    () => BrowserTestUtils.isVisible(button),
    "the split button shows"
  );
  let shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  button.click();
  await within(shown, 10_000, "the header's split menu");
  await TestUtils.waitForCondition(
    () =>
      document.l10n.getAttributes(closeAll).id ===
      "split-view-menuitem-close-all-tabs",
    "it closes all of a split of three"
  );
  Assert.ok(
    document.getElementById("sval-split-view-close-tab").hidden,
    "and has no Close for one pane"
  );
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(hidden, 10_000, "the menu closing");

  const footer = document
    .getElementById(tabs[2].linkedPanel)
    .querySelector("split-view-footer");
  shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  AccessibilityUtils.setEnv({ focusableRule: false });
  EventUtils.synthesizeMouseAtCenter(footer.menuButtonElement, {});
  AccessibilityUtils.resetEnv();
  await within(shown, 10_000, "the footer's split menu");
  Assert.equal(gBrowser.selectedTab, tabs[0], "its pane did not become active");
  const closeOne = document.getElementById("sval-split-view-close-tab");
  Assert.ok(closeAll.hidden, "a footer's menu does not close the split");
  await TestUtils.waitForCondition(
    () =>
      document.l10n.getAttributes(closeOne).id ===
        "split-view-menuitem-close-tab" && !!closeOne.label,
    "it closes its own pane"
  );
  await chooseMenuItem(closeOne, menu, "Close tab");

  await untilSplits([[ids[0], ids[1]]], "the other two stay split");
  Assert.ok(!(await settledNodes())[ids[2]], "and the pane is closed");
});

add_task(async function a_pane_waiting_for_a_pick_says_so_in_its_footer() {
  const { tabs } = await openTabs(1);
  document.getElementById("Browser:AddTabSplitView").doCommand();
  await TestUtils.waitForCondition(
    () => gBrowser.selectedTab.splitview?.tabs.length === 2,
    "the picker opens beside the tab"
  );
  const picker = gBrowser.selectedTab;
  expectOpened(picker);
  await within(
    BrowserTestUtils.switchTab(gBrowser, tabs[0]),
    10_000,
    "the tab switch"
  );
  const footer = document
    .getElementById(picker.linkedPanel)
    .querySelector("split-view-footer");
  await TestUtils.waitForCondition(
    () =>
      BrowserTestUtils.isVisible(footer) &&
      document.l10n.getAttributes(footer.uriElement).id ===
        "split-view-footer-new-pane",
    "the picker's footer names it a new pane"
  );
  Assert.ok(
    BrowserTestUtils.isVisible(footer.menuButtonElement),
    "and keeps its menu"
  );
});

add_task(async function the_split_key_opens_the_picker() {
  const { tabs } = await openTabs(1);
  const key = document.getElementById("key_addTabSplitView");
  Assert.equal(key.getAttribute("key"), "+", "the key is Plus");
  Assert.equal(
    key.getAttribute("modifiers"),
    SPLIT_MODIFIERS,
    "with the platform's modifiers"
  );

  pressSplitKey();
  await TestUtils.waitForCondition(
    () => gBrowser.selectedTab.splitview?.tabs.length === 2,
    "the picker opens beside the tab"
  );
  const panes = gBrowser.selectedTab.splitview.tabs;
  expectOpened(panes[1]);
  Assert.equal(panes[0], tabs[0], "the tab is the left pane");
  Assert.equal(gBrowser.selectedTab, panes[1], "and the picker is in view");
  Assert.equal(
    ZoomManager.getZoomForBrowser(tabs[0].linkedBrowser),
    1,
    "nothing zoomed"
  );

  await within(
    BrowserTestUtils.switchTab(gBrowser, tabs[0]),
    10_000,
    "the tab switch"
  );
  const zoomed = BrowserTestUtils.waitForEvent(window, "FullZoomChange");
  EventUtils.synthesizeKey("=", { accelKey: true, code: "Equal" });
  await within(zoomed, 10_000, "the page zooming");
  Assert.greater(
    ZoomManager.getZoomForBrowser(tabs[0].linkedBrowser),
    1,
    "the zoom key still zooms in"
  );
  await within(FullZoom.reset(), 10_000, "the zoom reset");
});

/**
 * Settings' Keyboard shortcuts pane shows the platform's key as Split View's
 * default and resets to it, because the element carries it when `CustomKeys`
 * saves its original.
 */
add_task(function the_split_keys_default_is_the_platforms() {
  registerCleanupFunction(() => CustomKeys.resetKey("key_addTabSplitView"));
  CustomKeys.changeKey("key_addTabSplitView", {
    modifiers: "accel,alt",
    key: "X",
  });
  Assert.deepEqual(
    CustomKeys.getDefaultKey("key_addTabSplitView"),
    { modifiers: SPLIT_MODIFIERS, key: "+" },
    "the default is the platform's key"
  );
  CustomKeys.resetKey("key_addTabSplitView");
  const key = document.getElementById("key_addTabSplitView");
  Assert.deepEqual(
    [key.getAttribute("key"), key.getAttribute("modifiers")],
    ["+", SPLIT_MODIFIERS],
    "and resetting brings it back"
  );
});

/**
 * On macOS no other `<key>` in the window answers Control with Plus or =,
 * with Shift or without: zoom is Command there.
 */
add_task({ skip_if: () => !isMac }, function no_other_key_takes_control_plus() {
  const takers = [...document.querySelectorAll("key")].filter(el => {
    const modifiers = (el.getAttribute("modifiers") ?? "").split(/[\s,]+/);
    const plus =
      ["+", "="].includes(el.getAttribute("key")) ||
      ["VK_ADD", "VK_PLUS", "VK_EQUALS"].includes(el.getAttribute("keycode"));
    return (
      plus &&
      modifiers.includes("control") &&
      !["accel", "meta", "alt"].some(m => modifiers.includes(m))
    );
  });
  Assert.deepEqual(
    takers.map(el => el.id),
    ["key_addTabSplitView"],
    "Split View's key alone"
  );
});
