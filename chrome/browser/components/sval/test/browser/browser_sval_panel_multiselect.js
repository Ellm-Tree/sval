/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_panel_helpers.js */

/**
 * Selecting several rows in the panel (spec §10.5): with the pointer and the
 * keyboard, what assistive technology is told, and the commands that act on
 * every selected row.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_panel_helpers.js",
  this
);

/**
 * @param {string} id
 * @returns {Element} its row.
 */
function rowOf(id) {
  return SvalPanel._rowElementFor(id);
}

/** @returns {string[]} the drawn rows that say they are selected, in order. */
function selectedIds() {
  return drawnRows()
    .filter(row => row.getAttribute("aria-selected") === "true")
    .map(row => row.dataset.nodeId);
}

/**
 * Clicks a row with modifiers, as a pointer user does. A synthesized DOM
 * click is used because a headless widget drops a native event's modifiers
 * (`HeadlessWidget::SynthesizeNativeMouseEvent` never reads
 * `aModifierFlags`), and macOS runs the suites headless.
 *
 * @param {string} id
 * @param {object} modifiers `EventUtils.synthesizeMouseAtCenter`'s.
 */
function clickRow(id, modifiers) {
  // The rows are a tree with a roving tabindex: Tab reaches the focused row
  // and the arrow keys the rest.
  AccessibilityUtils.setEnv({ nonNegativeTabIndexRule: false });
  EventUtils.synthesizeMouseAtCenter(rowOf(id), modifiers, window);
  AccessibilityUtils.resetEnv();
}

/**
 * Closes an open context menu and waits for it to go.
 *
 * @param {Element} menu
 */
async function closeMenu(menu) {
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(hidden, 10_000, "the context menu hiding");
}

/**
 * A fresh panel whose tab on screen is `tab1`.
 *
 * @returns {Promise<object>} {@link withFreshPanel}'s fixture.
 */
async function viewingTab1() {
  const fixture = await withFreshPanel();
  await viewTab(fixture.ids.tab1);
  return fixture;
}

/**
 * Selects rows by Accel-click, the first one starting from the tab on
 * screen.
 *
 * @param {...string} ids
 */
function accelClick(...ids) {
  for (const id of ids) {
    clickRow(id, { accelKey: true });
  }
}

add_task(async function the_tree_says_several_rows_can_be_selected() {
  const { tree, ids } = await viewingTab1();
  Assert.equal(tree.getAttribute("aria-multiselectable"), "true");
  Assert.deepEqual(
    selectedIds(),
    [ids.tab1],
    "with nothing more selected, the tab on screen's row is"
  );
  Assert.ok(
    drawnRows().every(row => row.hasAttribute("aria-selected")),
    "and every row says whether it is selected"
  );
});

add_task(async function accel_click_adds_a_row_or_takes_it_out() {
  const { ids } = await viewingTab1();
  accelClick(ids.tab3);
  Assert.deepEqual(
    selectedIds(),
    [ids.tab1, ids.tab3],
    "the first starts from the tab on screen"
  );
  accelClick(ids.groupB);
  Assert.deepEqual(selectedIds(), [ids.tab1, ids.tab3, ids.groupB]);
  accelClick(ids.tab3);
  Assert.deepEqual(selectedIds(), [ids.tab1, ids.groupB], "and out again");
  Assert.equal(
    SvalPanel._selectedId(),
    ids.tab1,
    "the tab on screen stays the same"
  );
});

add_task(async function shift_click_selects_the_rows_between() {
  const { ids } = await viewingTab1();
  clickRow(ids.loose, { shiftKey: true });
  Assert.deepEqual(
    selectedIds(),
    [ids.tab1, ids.tab2, ids.tab3, ids.loose],
    "from the tab on screen, in the order drawn"
  );
  accelClick(ids.tab4);
  clickRow(ids.groupB, { shiftKey: true });
  Assert.deepEqual(
    selectedIds(),
    [ids.groupB, ids.tab4],
    "from the row last clicked, in place of what was selected"
  );
  clickRow(ids.tab2, { shiftKey: true, accelKey: true });
  Assert.deepEqual(
    selectedIds(),
    [ids.tab2, ids.tab3, ids.loose, ids.groupB, ids.tab4],
    "with Accel too, added to it"
  );
});

add_task(async function a_click_and_a_fold_leave_one_row_selected() {
  const { ids } = await viewingTab1();
  accelClick(ids.tab2, ids.tab4);
  // A group's row folds it on a click, and opens no page.
  clickRow(ids.groupB, {});
  Assert.deepEqual(selectedIds(), [ids.tab1], "a click clears the selection");

  SvalPanel.settings.setCollapsed(ids.groupB, false);
  SvalPanel.render();
  accelClick(ids.tab2, ids.tab4);
  SvalPanel.settings.setCollapsed(ids.groupB, true);
  SvalPanel.render();
  SvalPanel.settings.setCollapsed(ids.groupB, false);
  SvalPanel.render();
  Assert.deepEqual(
    selectedIds(),
    [ids.tab1, ids.tab2],
    "a row its group folds over leaves the selection"
  );
});

add_task(async function the_keyboard_selects_as_the_pointer_does() {
  const { ids } = await viewingTab1();
  await within(SimpleTest.promiseFocus(window), 10_000, "the window's focus");
  SvalPanel._focusRow(ids.tab1);

  EventUtils.synthesizeKey("KEY_ArrowDown", { shiftKey: true });
  EventUtils.synthesizeKey("KEY_ArrowDown", { shiftKey: true });
  Assert.deepEqual(selectedIds(), [ids.tab1, ids.tab2, ids.tab3]);
  EventUtils.synthesizeKey("KEY_ArrowUp", { shiftKey: true });
  Assert.deepEqual(selectedIds(), [ids.tab1, ids.tab2], "and back");

  EventUtils.synthesizeKey("KEY_ArrowDown");
  EventUtils.synthesizeKey("KEY_ArrowDown");
  Assert.equal(
    document.activeElement.dataset.nodeId,
    ids.loose,
    "the arrows alone move the focus"
  );
  Assert.deepEqual(selectedIds(), [ids.tab1, ids.tab2], "and keep the rows");
  EventUtils.synthesizeKey(" ", { ctrlKey: true });
  Assert.deepEqual(selectedIds(), [ids.tab1, ids.tab2, ids.loose]);
  EventUtils.synthesizeKey(" ", { ctrlKey: true });
  Assert.deepEqual(selectedIds(), [ids.tab1, ids.tab2]);

  // Focus on a tab's row opens its preview after a delay, and while it shows
  // the first Escape closes it (`browser_sval_tab_hover_preview.js`). This
  // task is about the selection, so the preview is put away first.
  gBrowser.tabContainer.previewPanel?.deactivate(null, { force: true });
  EventUtils.synthesizeKey("KEY_Escape");
  Assert.deepEqual(selectedIds(), [ids.tab1], "Escape clears it");
});

add_task(async function a_switch_of_workspace_clears_the_selection() {
  const { engine, ids } = await viewingTab1();
  accelClick(ids.tab2);
  const other = crypto.randomUUID();
  await engine.mutate({
    kind: "addWorkspace",
    name: "Elsewhere",
    id: other,
    now: Date.now(),
  });
  for (const id of [other, ids.workspace]) {
    Assert.ok(
      await within(SvalPanel.switchTo(id), 10_000, "a switch of workspace"),
      "the window switched"
    );
  }
  Assert.deepEqual(selectedIds(), [ids.tab1], "nothing selected came back");
});

add_task(async function a_menu_on_a_selection_offers_what_acts_on_it() {
  const { ids } = await viewingTab1();
  accelClick(ids.tab3);
  const menu = await openContextMenu(rowOf(ids.tab3));
  const enabled = command => {
    const item = menu.querySelector(`[data-command="${command}"]`);
    return !item.hidden && !item.hasAttribute("disabled");
  };
  for (const command of SvalPanelModel.SELECTION_COMMANDS) {
    Assert.ok(enabled(command), `${command} acts on the selection`);
  }
  for (const command of ["rename", "moveBefore", "pin", "createSplit"]) {
    Assert.ok(!enabled(command), `${command} acts on one row, and is off`);
  }
  Assert.deepEqual(
    selectedIds(),
    [ids.tab1, ids.tab3],
    "the menu keeps the selection"
  );
  await closeMenu(menu);

  accelClick(ids.groupB);
  const withGroup = await openContextMenu(rowOf(ids.tab3));
  Assert.ok(
    withGroup.querySelector('[data-command="close"]').hasAttribute("disabled"),
    "a selection with a group in it cannot be closed"
  );
  await closeMenu(withGroup);

  const single = await openContextMenu(rowOf(ids.loose));
  Assert.deepEqual(
    selectedIds(),
    [ids.loose],
    "a menu on another row clears the selection"
  );
  Assert.ok(
    single.querySelector('[data-command="groupSelection"]').hidden,
    "and offers one row's entries"
  );
  Assert.ok(
    !single.querySelector('[data-command="rename"]').hasAttribute("disabled"),
    "every one of them on"
  );
  await closeMenu(single);
});

add_task(async function delete_closes_every_selected_tab() {
  const { engine, ids } = await viewingTab1();
  accelClick(ids.tab3, ids.tab4);
  await within(SimpleTest.promiseFocus(window), 10_000, "the window's focus");
  SvalPanel._focusRow(ids.tab3);
  EventUtils.synthesizeKey("KEY_Delete");
  await dismissUndoMessage();
  await TestUtils.waitForCondition(async () => {
    const nodes = (await engine.tree()).nodes;
    return !nodes[ids.tab1] && !nodes[ids.tab3] && !nodes[ids.tab4];
  }, "the selected tabs closed");
  const nodes = (await engine.tree()).nodes;
  Assert.ok(nodes[ids.tab2] && nodes[ids.loose], "and nothing else");
});

add_task(async function move_to_group_takes_the_selection_in_its_order() {
  const { engine, ids } = await viewingTab1();
  accelClick(ids.loose, ids.tab3);
  const menu = await openContextMenu(rowOf(ids.loose));
  await chooseMenuItem(
    menu.querySelector(`[data-move-parent="${ids.groupB}"]`),
    menu,
    "the second group"
  );
  await TestUtils.waitForCondition(
    async () => (await childrenOf(engine, ids.groupB)).length === 4,
    "the selection moved"
  );
  Assert.deepEqual(await childrenOf(engine, ids.groupB), [
    ids.tab4,
    ids.tab1,
    ids.tab3,
    ids.loose,
  ]);
  Assert.deepEqual(
    selectedIds(),
    [ids.tab1, ids.tab3, ids.loose],
    "and it stays selected where it went"
  );
});

add_task(async function move_to_workspace_asks_once_for_the_selection() {
  const { engine, ids } = await viewingTab1();
  const other = crypto.randomUUID();
  await engine.mutate({
    kind: "addWorkspace",
    name: "Elsewhere",
    isolated: true,
    id: other,
    now: Date.now(),
  });
  await SvalPanel.refresh();

  accelClick(ids.groupA, ids.tab2, ids.tab4);
  const menu = await openContextMenu(rowOf(ids.tab4));
  await chooseMenuItem(
    menu.querySelector(`[data-move-workspace="${other}"]`),
    menu,
    "the other workspace"
  );
  await answerDialog();
  await TestUtils.waitForCondition(
    async () => (await childrenOf(engine, other)).length === 2,
    "the selection moved"
  );
  Assert.ok(!gDialogBox.isOpen, "one question for the whole selection");
  Assert.deepEqual(
    await childrenOf(engine, other),
    [ids.groupA, ids.tab4],
    "a row in a selected group went with its group"
  );
  Assert.deepEqual(await childrenOf(engine, ids.groupA), [
    ids.tab1,
    ids.tab2,
    ids.tab3,
  ]);
  // The tab on screen went with its group, and the window shows another of
  // its own tabs in its place, whose row is the one selected.
  await within(SvalPanel.observer.settled(), 10_000, "the window settling");
  const onScreen = SvalPanel.observer.nodeIdFor(gBrowser.selectedTab);
  Assert.equal(
    SvalPanel.nodes[onScreen]?.placement?.parent,
    ids.workspace,
    "the window shows a tab of its own workspace"
  );
  Assert.deepEqual(
    selectedIds(),
    [onScreen],
    "and left the selection with its rows"
  );
});

add_task(async function new_group_with_selection_holds_every_selected_row() {
  const { engine, ids } = await viewingTab1();
  accelClick(ids.loose, ids.tab4);
  const menu = await openContextMenu(rowOf(ids.loose));
  await activateMenuItem(menu, "groupSelection");
  await answerContainerDialog("Batch");
  await TestUtils.waitForCondition(
    async () => (await childrenOf(engine, ids.groupA)).length === 3,
    "a group made"
  );
  const inA = await childrenOf(engine, ids.groupA);
  const made = inA[0];
  Assert.equal((await engine.tree()).nodes[made].kind, "group");
  Assert.deepEqual(
    inA,
    [made, ids.tab2, ids.tab3],
    "in the place of the first selected row"
  );
  Assert.deepEqual(await childrenOf(engine, made), [
    ids.tab1,
    ids.loose,
    ids.tab4,
  ]);
});

add_task(async function a_dragged_selection_lands_together() {
  const { engine, ids } = await viewingTab1();
  accelClick(ids.tab3, ids.loose);
  const target = rowOf(ids.tab4);
  const rect = target.getBoundingClientRect();
  EventUtils.synthesizeDrop(
    rowOf(ids.tab3),
    target,
    null,
    "move",
    window,
    window,
    { clientY: rect.top + rect.height * 0.75 }
  );
  await TestUtils.waitForCondition(
    async () => (await childrenOf(engine, ids.groupB)).length === 4,
    "the selection dropped"
  );
  Assert.deepEqual(
    await childrenOf(engine, ids.groupB),
    [ids.tab4, ids.tab1, ids.tab3, ids.loose],
    "after the row it was dropped on, in the order drawn"
  );
});
