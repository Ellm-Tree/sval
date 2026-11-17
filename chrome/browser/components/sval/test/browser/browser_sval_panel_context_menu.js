/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_panel_helpers.js */

/** The panel's context menu: its items per row kind, and what each does. */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_panel_helpers.js",
  this
);

/** @param {Element} menu An open `menupopup`. @returns {Promise<void>} */
async function closeContextMenu(menu) {
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(hidden, 10_000, "the context menu hiding");
}

/**
 * The commands a row's menu shows while nothing plays, on a tab nobody
 * renamed: the media entry shows only for a row with sound
 * (`_syncMediaItem`), and Remove Name only on a tab with a name of the
 * user's (`_syncRowMenu`).
 *
 * @param {string} kind A `NodeKind`.
 * @returns {string[]}
 */
function silentMenuItems(kind) {
  return SvalPanelModel.contextMenuItems(kind).filter(
    command => command !== "media" && command !== "clearLabel"
  );
}

/** @param {Element} menu @returns {string[]} the commands currently shown. */
function visibleMenuCommands(menu) {
  return Array.from(menu.children)
    .filter(item => !item.hidden)
    .map(item => item.dataset.command);
}

/**
 * Every row kind offers exactly the commands the spec lists for it, and no
 * others. A leaf offering "New group" would be reachable but wrong.
 */
add_task(async function the_context_menu_offers_the_right_items_per_kind() {
  const { engine, ids } = await withFreshPanel();

  // Colorshift is offered for the page a tab shows, and a tab loading its
  // first page shows a blank one until the load commits.
  await committed(
    SvalPanel.observer.tabFor(ids.tab1).linkedBrowser,
    "https://example.com/One"
  );
  const tabMenu = await openContextMenu(SvalPanel._rowElementFor(ids.tab1));
  Assert.deepEqual(
    visibleMenuCommands(tabMenu),
    silentMenuItems("tab"),
    "a tab offers a tab's commands"
  );
  assertTidySeparators(tabMenu, "a tab's menu");
  await closeContextMenu(tabMenu);

  const groupMenu = await openContextMenu(SvalPanel._rowElementFor(ids.groupA));
  Assert.deepEqual(
    visibleMenuCommands(groupMenu),
    silentMenuItems("group"),
    "a group also offers a new group inside it, but not a new workspace"
  );
  assertTidySeparators(groupMenu, "a group's menu");
  await closeContextMenu(groupMenu);

  // A tab that cannot be pinned has its pin entries hidden at popupshowing
  // (`SvalPinsRow.canPin`), past the list `contextMenuItems` names.
  const blank = crypto.randomUUID();
  await engine.mutate({
    kind: "addTab",
    parent: ids.groupB,
    name: "Blank",
    url: "about:blank",
    id: blank,
    now: Date.now(),
  });
  await SvalPanel.refresh();
  const blankMenu = await openContextMenu(SvalPanel._rowElementFor(blank));
  Assert.ok(
    blankMenu.querySelector('[data-command="pin"]').hidden,
    "a blank tab offers no pin"
  );
  assertTidySeparators(blankMenu, "an unpinnable tab's menu");
  await closeContextMenu(blankMenu);

  // A window shows one workspace and the workspace itself is not a row (spec
  // §10.7), so no right-click in the tree can land on one. The menu's
  // workspace entries stay in `contextMenuItems` because the switcher is
  // where a workspace is acted on, and the header's own buttons are the other
  // way to the same commands.
  Assert.ok(
    !SvalPanel._rowElementFor(ids.workspace),
    "there is no workspace row to right-click"
  );
});

/**
 * Rename names a tab, and Remove Name, offered once it has a name, takes
 * the name away again.
 */
add_task(async function rename_from_the_menu_names_and_remove_name_unnames() {
  const { engine, ids } = await withFreshPanel();
  const label = async () =>
    (await engine.tree()).nodes[ids.tab1].appearance?.label;

  let menu = await openContextMenu(SvalPanel._rowElementFor(ids.tab1));
  await activateMenuItem(menu, "rename");
  await answerDialog({ value: "Renamed by menu" });
  await TestUtils.waitForCondition(
    async () => (await label()) === "Renamed by menu",
    "the name reaches the document"
  );
  await TestUtils.waitForCondition(
    () =>
      SvalPanel._rowElementFor(ids.tab1)?.querySelector(".sval-row-name")
        ?.textContent === "Renamed by menu",
    "and the panel draws it"
  );

  menu = await openContextMenu(SvalPanel._rowElementFor(ids.tab1));
  Assert.ok(
    !menu.querySelector('[data-command="clearLabel"]').hidden,
    "a renamed tab offers its page's title back"
  );
  await activateMenuItem(menu, "clearLabel");
  await TestUtils.waitForCondition(
    async () => (await label()) === undefined,
    "the name is taken away"
  );
});

/**
 * A leaf tab has no descendants, so closing it from the menu deletes it with
 * no confirmation. The confirmation exists for what would otherwise be lost
 * silently, and a leaf loses nothing beyond itself.
 */
add_task(async function close_from_the_menu_on_a_leaf_deletes_it() {
  const { engine, ids } = await withFreshPanel();

  const menu = await openContextMenu(SvalPanel._rowElementFor(ids.tab1));
  await activateMenuItem(menu, "close");

  await TestUtils.waitForCondition(async () => {
    const nodes = (await engine.tree()).nodes;
    return !(ids.tab1 in nodes);
  }, "the leaf is gone");
  Assert.ok(!gDialogBox.isOpen, "no confirmation was shown for a tab");
});

/**
 * Only a tab row carries an X. A group toggles and is deleted from its menu,
 * and the workspace is not a row at all (spec §5.4, §10.7).
 */
add_task(async function only_tab_rows_have_a_close_button() {
  const { ids } = await withFreshPanel();

  for (const id of [ids.tab1, ids.loose, ids.tab4]) {
    Assert.ok(
      SvalPanel._rowElementFor(id).querySelector(".sval-row-close"),
      "a tab row has its X"
    );
  }
  for (const id of [ids.groupA, ids.groupB]) {
    Assert.ok(
      !SvalPanel._rowElementFor(id).querySelector(".sval-row-close"),
      "a group row has none"
    );
  }
  Assert.ok(
    !SvalPanel._rowElementFor(ids.workspace),
    "and there is no workspace row to carry one"
  );

  const groupMenu = await openContextMenu(SvalPanel._rowElementFor(ids.groupA));
  const offered = visibleMenuCommands(groupMenu);
  Assert.ok(offered.includes("deleteGroup"), "a group's menu offers Delete");
  Assert.ok(!offered.includes("close"), "and no Close");
  await closeContextMenu(groupMenu);
});

/**
 * A command whose engine call fails is redrawn from the engine's tree and
 * not narrated: the user cannot act on an engine failure (spec §10.7). The
 * failure must not escape as an unhandled rejection either.
 */
add_task(async function a_command_that_fails_redraws_and_says_nothing() {
  const { engine, ids } = await withFreshPanel();
  // The switch loads the selected tab, and the observer redraws from the
  // engine's tree when it files the page's title. That redraw would draw the
  // other device's group below before the delete goes, so it comes first.
  const tab = gBrowser.selectedTab;
  const id = SvalPanel.observer.nodeIdFor(tab);
  await pageReady(tab.linkedBrowser, SvalPanel.nodes[id].content.url);
  await TestUtils.waitForCondition(async () => {
    await within(SvalPanel.observer.settled(), 10_000, "the window settling");
    return SvalPanel.nodes[id].content.name === tab.linkedBrowser.contentTitle;
  }, "the panel draws the loaded page's title");

  const empty = await engine.mutate({
    kind: "addGroup",
    parent: ids.workspace,
    name: "Empty",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  await SvalPanel.refresh();

  // The delete waits on the Undo message, and another device deletes the
  // group meanwhile, so the engine refuses this window's delete
  // (`require_node`) when the message goes. The same device adds a group,
  // which only a redraw from the engine's tree shows.
  await SvalPanel.run("deleteGroup", SvalPanel._rowFor(empty));
  await engine.mutate({ kind: "remove", id: empty, now: Date.now() });
  const arrived = await engine.mutate({
    kind: "addGroup",
    parent: ids.workspace,
    name: "Arrived",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  await within(SvalPanel.observer.settled(), 10_000, "the window settling");
  Assert.ok(
    !SvalPanel._rowElementFor(arrived),
    "the other device's group is not drawn before the delete goes"
  );
  await dismissUndoMessage();
  await TestUtils.waitForCondition(
    () => SvalPanel._rowElementFor(arrived)?.isConnected,
    "the tree is drawn again, from the engine's tree"
  );
  Assert.ok(!SvalPanel._rowElementFor(empty), "without the group it lost");
  Assert.ok(!gDialogBox.isOpen, "and nothing is said");
});

/** The dialog's button for each answer to "Delete group". */
const DELETE_GROUP_BUTTON = { delete: "ok", move: "extra", cancel: "cancel" };

/**
 * "Delete group" asks what becomes of the tabs, and cancelling leaves the group
 * and everything in it untouched. "Delete All" takes the group and every tab in
 * it (spec §5.4).
 */
add_task(async function delete_group_with_its_tabs() {
  const { engine, ids } = await withFreshPanel();

  {
    const before = (await engine.tree()).nodes;
    const menu = await openContextMenu(SvalPanel._rowElementFor(ids.groupA));
    await activateMenuItem(menu, "deleteGroup");
    const asked = await answerDialog({ button: DELETE_GROUP_BUTTON.cancel });
    await within(SvalPanel.observer.settled(), 10_000, "the window settling");
    Assert.deepEqual(
      Object.keys((await engine.tree()).nodes).sort(),
      Object.keys(before).sort(),
      "cancelling left the group and its tabs in place"
    );
    Assert.deepEqual(
      { title: asked.title, body: asked.body },
      SvalPanelModel.deleteGroupText(
        "Reading",
        3,
        SvalPanelModel.descendantGroupCount(SvalPanel.nodes, ids.groupA)
      ),
      "the question named the group's three tabs, not just its one level"
    );
  }

  {
    const menu = await openContextMenu(SvalPanel._rowElementFor(ids.groupA));
    await activateMenuItem(menu, "deleteGroup");
    await answerDialog({ button: DELETE_GROUP_BUTTON.delete });
    await dismissUndoMessage();
    await TestUtils.waitForCondition(
      async () => !(ids.groupA in (await engine.tree()).nodes),
      "the group is gone"
    );
    const after = (await engine.tree()).nodes;
    for (const tab of [ids.tab1, ids.tab2, ids.tab3]) {
      Assert.ok(!(tab in after), `${tab} went with its group`);
    }
    for (const kept of [ids.workspace, ids.loose, ids.groupB, ids.tab4]) {
      Assert.ok(kept in after, `${kept} outside the group was not touched`);
    }
  }
});

/**
 * "Move Out of Group" deletes the group and keeps everything in it: the
 * children land one level up, in their order, where the group was. A group
 * inside comes out whole, with its own tabs still in it.
 */
add_task(async function delete_group_moving_its_tabs_out() {
  const { engine, ids } = await withFreshPanel();

  const inner = crypto.randomUUID();
  const innerTab = crypto.randomUUID();
  const now = Date.now();
  await engine.mutate({
    kind: "addGroup",
    parent: ids.groupA,
    name: "Archive",
    id: inner,
    now,
  });
  await engine.mutate({
    kind: "addTab",
    parent: inner,
    name: "Old",
    url: "https://example.com/Old",
    id: innerTab,
    now,
  });
  await SvalPanel.refresh();
  const groupAChildren = await childrenOf(engine, ids.groupA);
  const before = (await engine.tree()).nodes;

  const menu = await openContextMenu(SvalPanel._rowElementFor(ids.groupA));
  await activateMenuItem(menu, "deleteGroup");
  await answerDialog({ button: DELETE_GROUP_BUTTON.move });
  await dismissUndoMessage();
  await TestUtils.waitForCondition(
    async () => !(ids.groupA in (await engine.tree()).nodes),
    "the group is gone"
  );

  Assert.deepEqual(
    await childrenOf(engine, ids.workspace),
    [...groupAChildren, ids.loose, ids.groupB],
    "the group's children took its place, in their order"
  );
  Assert.deepEqual(
    await childrenOf(engine, inner),
    [innerTab],
    "the inner group came out whole"
  );
  const after = (await engine.tree()).nodes;
  for (const id of [ids.tab1, ids.tab2, ids.tab3, innerTab]) {
    Assert.equal(
      after[id].content.url,
      before[id].content.url,
      `${id} is the same node, not a copy`
    );
  }
  Assert.equal(
    Object.keys(after).length,
    Object.keys(before).length - 1,
    "the group itself was the one node deleted"
  );
});

/**
 * Deletes `group` from its menu, and files a tab into it while "Delete group"
 * asks, as another device's change reaching this document after the panel
 * last read it does; then answers `answer`.
 *
 * @param {object} engine The panel's engine.
 * @param {string} group A group id.
 * @param {string} answer `"move"` or `"delete"`.
 * @returns {Promise<string>} the tab's id.
 */
async function fileATabWhileAsked(engine, group, answer) {
  const late = crypto.randomUUID();
  const menu = await openContextMenu(SvalPanel._rowElementFor(group));
  await activateMenuItem(menu, "deleteGroup");
  await answerDialog({
    button: DELETE_GROUP_BUTTON[answer],
    meanwhile: () =>
      engine.mutate({
        kind: "addTab",
        parent: group,
        name: "Late",
        url: "https://example.com/Late",
        id: late,
        now: Date.now(),
      }),
  });
  await dismissUndoMessage();
  await TestUtils.waitForCondition(
    async () => !(group in (await engine.tree()).nodes),
    "the group is gone"
  );
  return late;
}

/**
 * A tab that reaches the group while "Delete group" is asking goes with the
 * group when the user deletes its contents, as the tabs drawn did.
 */
add_task(async function delete_group_takes_a_tab_that_arrived_while_asking() {
  const { engine, ids } = await withFreshPanel();
  const late = await fileATabWhileAsked(engine, ids.groupA, "delete");
  const after = (await engine.tree()).nodes;
  for (const tab of [ids.tab1, ids.tab2, ids.tab3, late]) {
    Assert.ok(!(tab in after), `${tab} went with its group`);
  }
});

/**
 * A tab that reaches the group while "Delete group" is asking moves out with
 * the rest when the user keeps the contents, into the group's place.
 */
add_task(async function moving_out_keeps_a_tab_that_arrived_while_asking() {
  const { engine, ids } = await withFreshPanel();
  const groupAChildren = await childrenOf(engine, ids.groupA);
  const late = await fileATabWhileAsked(engine, ids.groupA, "move");
  Assert.deepEqual(
    await childrenOf(engine, ids.workspace),
    [...groupAChildren, late, ids.loose, ids.groupB],
    "every tab the group held when it went took its place, in their order"
  );
});

/**
 * "Delete workspace" is on the workspace's own menu, the switcher's right-click.
 * Its confirmation says the tabs go too and offers no way to keep them. Declining
 * changes nothing; accepting deletes the workspace and everything in it, and the
 * window moves to a workspace that still exists (spec §5.4, §10.7).
 */
add_task(async function delete_workspace_from_its_menu() {
  const { engine, ids } = await withFreshPanel();
  const other = crypto.randomUUID();
  await engine.mutate({
    kind: "addWorkspace",
    name: "Home",
    id: other,
    now: Date.now(),
  });
  await SvalPanel.refresh();

  const openWorkspaceMenu = () =>
    rightClickOpens(SvalPanel._els.switcher, SvalPanel._els.workspaceMenu);

  {
    const before = Object.keys((await engine.tree()).nodes).sort();
    await activateMenuItem(await openWorkspaceMenu(), "deleteWorkspace");
    const asked = await answerDialog({ button: "cancel" });
    await within(SvalPanel.observer.settled(), 10_000, "the window settling");
    Assert.deepEqual(
      Object.keys((await engine.tree()).nodes).sort(),
      before,
      "declining deleted nothing"
    );
    Assert.deepEqual(
      { title: asked.title, body: asked.body },
      SvalPanelModel.deleteWorkspaceText(
        "Work",
        5,
        SvalPanelModel.descendantGroupCount(SvalPanel.nodes, ids.workspace)
      ),
      "the confirmation names the workspace and says its five tabs go too"
    );

    await activateMenuItem(await openWorkspaceMenu(), "deleteWorkspace");
    await answerDialog();
    // The window leaves the workspace as the delete is held for Undo, and
    // the delete is made when the message goes.
    await TestUtils.waitForCondition(
      () => SvalPanel.workspaceId && SvalPanel.workspaceId !== ids.workspace,
      "the window moves off the deleted workspace"
    );
    await dismissUndoMessage();
    await TestUtils.waitForCondition(
      async () => !(ids.workspace in (await engine.tree()).nodes),
      "the workspace is deleted"
    );
    const after = (await engine.tree()).nodes;
    Assert.equal(
      after[SvalPanel.workspaceId]?.kind,
      SvalPanelModel.WORKSPACE,
      "to a workspace that still exists"
    );
    for (const [name, id] of Object.entries(ids)) {
      Assert.ok(!(id in after), `${name} went with the workspace`);
    }
    Assert.ok(other in after, "the other workspace was not touched");

    // A window always shows a workspace, so the last one stays. The document
    // holds the profile's workspaces too, and another device deletes them.
    await engine.mutate({
      kind: "batch",
      ops: SvalPanelModel.workspaceIds(SvalPanel.nodes)
        .filter(id => id !== other)
        .map(id => ({ kind: "remove", id })),
      now: Date.now(),
    });
    await SvalPanel.refresh();
    await TestUtils.waitForCondition(
      () => SvalPanel.workspaceId === other,
      "the window shows the one workspace left"
    );
    const menu = await openWorkspaceMenu();
    Assert.ok(
      menu
        .querySelector('[data-command="deleteWorkspace"]')
        .hasAttribute("disabled"),
      "the last workspace offers no delete"
    );
    await closeContextMenu(menu);
  }
});

/**
 * Every workspace in the switcher carries the workspace menu's commands for
 * itself: in its entry's submenu, and in the workspace menu a right-click on
 * the entry opens. Each acts on that workspace, and the window stays where it
 * is.
 */
add_task(async function each_switcher_entry_has_its_workspace_commands() {
  const { engine } = await withFreshPanel();
  const shown = SvalPanel.workspaceId;
  const other = crypto.randomUUID();
  await engine.mutate({
    kind: "addWorkspace",
    name: "Home",
    id: other,
    now: Date.now(),
  });
  await SvalPanel.refresh();

  const switcher = SvalPanel._els.switcherMenu;
  const openSwitcher = async () => {
    const opened = BrowserTestUtils.waitForPopupEvent(switcher, "shown");
    EventUtils.synthesizeMouseAtCenter(SvalPanel._els.switcher, {});
    await within(opened, 10_000, "the switcher showing");
    return switcher.querySelector(`menu[data-workspace-id="${other}"]`);
  };

  try {
    info("the entry's submenu");
    const entry = await openSwitcher();
    const submenu = entry.menupopup;
    const opened = BrowserTestUtils.waitForPopupEvent(submenu, "shown");
    entry.openMenu(true);
    await within(opened, 10_000, "the entry's submenu showing");
    Assert.deepEqual(
      Array.from(submenu.children)
        .filter(item => !item.hidden && item.localName === "menuitem")
        .map(item => item.dataset.command ?? "open"),
      ["open", "edit", "isolateWorkspace", "deleteWorkspace"],
      "it opens the workspace in a window, and edits, isolates and deletes it"
    );
    await chooseMenuItem(
      submenu.querySelector('[data-command="deleteWorkspace"]'),
      switcher,
      "Delete workspace"
    );
    const declined = await answerDialog({ button: "cancel" });
    Assert.equal(
      declined.title,
      SvalPanelModel.deleteWorkspaceText("Home", 0, 0).title,
      "for that workspace"
    );

    info("a right-click on the entry");
    const menu = SvalPanel._els.workspaceMenu;
    const context = BrowserTestUtils.waitForPopupEvent(menu, "shown");
    EventUtils.synthesizeMouseAtCenter(await openSwitcher(), {
      type: "contextmenu",
      button: 2,
    });
    await within(context, 10_000, "the workspace menu showing");
    await activateMenuItem(menu, "deleteWorkspace");
    const accepted = await answerDialog();
    await dismissUndoMessage();
    await TestUtils.waitForCondition(
      async () => !(other in (await engine.tree()).nodes),
      "the workspace right-clicked on is deleted"
    );
    Assert.equal(
      accepted.title,
      SvalPanelModel.deleteWorkspaceText("Home", 0, 0).title,
      "after asking for it by name"
    );
    Assert.equal(
      SvalPanel.workspaceId,
      shown,
      "and the window still shows its own"
    );
  } finally {
    if (switcher.state !== "closed") {
      await closeContextMenu(switcher);
    }
  }
});

/**
 * "New group" from the row menu and "New workspace…" from the switcher go
 * through the same dialogs as everywhere else, so an empty answer is a
 * refusal here too: no string Sval chose may reach the document by any path.
 */
add_task(async function new_group_and_new_workspace_refuse_an_empty_name() {
  const { engine, ids } = await withFreshPanel();

  {
    const before = Object.keys((await engine.tree()).nodes).length;

    const groupMenu = await openContextMenu(
      SvalPanel._rowElementFor(ids.groupA)
    );
    await activateMenuItem(groupMenu, "addGroup");
    Assert.equal(
      await answerContainerDialog(null),
      "new-group",
      "the new group dialog asked"
    );

    // The switcher's "New workspace…", the one place a workspace is made.
    const switcher = SvalPanel._els.switcherMenu;
    const shown = BrowserTestUtils.waitForPopupEvent(switcher, "shown");
    SvalPanel._els.switcher.click();
    await within(shown, 10_000, "the switcher showing");
    await chooseMenuItem(
      switcher.querySelector("[data-sval-new-workspace]"),
      switcher,
      "New workspace"
    );
    Assert.equal(
      await answerContainerDialog(null),
      "new-workspace",
      "and so did the new workspace dialog"
    );
    await within(SvalPanel.observer.settled(), 10_000, "the window settling");
    Assert.equal(
      Object.keys((await engine.tree()).nodes).length,
      before,
      "a dismissed prompt from either entry point created nothing"
    );
  }
});

/**
 * The row and workspace menus open from the keyboard, with the keys
 * themselves: on macOS the widget makes no `contextmenu` of them, so these
 * keys are the one way a keyboard reaches Edit, Move to workspace, Isolate
 * and Delete workspace.
 */
add_task(async function the_context_menus_open_from_the_keyboard() {
  const { ids } = await withFreshPanel();
  await within(SimpleTest.promiseFocus(window), 10_000, "the window's focus");

  const menu = SvalPanel._els.contextMenu;
  for (const [key, modifiers] of [
    ["KEY_F10", { shiftKey: true }],
    ["KEY_ContextMenu", {}],
  ]) {
    SvalPanel._focusRow(ids.groupB);
    const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
    EventUtils.synthesizeKey(key, modifiers);
    await within(shown, 10_000, `${key} showing the row's menu`);
    Assert.equal(
      SvalPanel._contextRowId,
      ids.groupB,
      `${key} opened the menu for the focused row`
    );
    Assert.deepEqual(
      visibleMenuCommands(menu),
      silentMenuItems("group"),
      "with that row's items"
    );
    await closeContextMenu(menu);
    Assert.equal(
      document.activeElement.dataset.nodeId,
      ids.groupB,
      "and focus is still on the row once it closes"
    );
  }

  const workspaceMenu = SvalPanel._els.workspaceMenu;
  SvalPanel._els.switcher.focus();
  const shown = BrowserTestUtils.waitForPopupEvent(workspaceMenu, "shown");
  EventUtils.synthesizeKey("KEY_F10", { shiftKey: true });
  await within(shown, 10_000, "Shift+F10 showing the workspace menu");
  Assert.ok(
    !workspaceMenu.querySelector('[data-command="edit"]').hidden,
    "the switcher's menu offers the workspace's commands"
  );
  await closeContextMenu(workspaceMenu);
});

/**
 * The context menu moves a node up, down and into a group, for anyone who
 * does not drag (spec §10.5).
 */
add_task(async function the_context_menu_moves_a_node() {
  const { engine, ids } = await withFreshPanel();

  let menu = await openContextMenu(SvalPanel._rowElementFor(ids.tab1));
  const item = command => menu.querySelector(`[data-command="${command}"]`);
  Assert.ok(
    item("moveBefore").hasAttribute("disabled"),
    "the first tab in its group cannot move up, so that entry is disabled"
  );
  Assert.ok(
    !item("moveAfter").hasAttribute("disabled"),
    "but it can move down"
  );
  await activateMenuItem(menu, "moveAfter");
  await TestUtils.waitForCondition(async () => {
    const children = await childrenOf(engine, ids.groupA);
    return children.join() === [ids.tab2, ids.tab1, ids.tab3].join();
  }, "Move down put it after its next sibling");

  menu = await openContextMenu(SvalPanel._rowElementFor(ids.loose));
  const entries = Array.from(
    item("moveToGroup").querySelectorAll("menuitem[data-move-parent]")
  ).map(entry => [
    entry.getAttribute("data-move-parent"),
    entry.getAttribute("label"),
  ]);
  Assert.deepEqual(
    entries,
    [
      [ids.groupA, "Reading"],
      [ids.groupB, "Shipping"],
    ],
    "a loose tab is offered both groups, and no 'No group' — it is in none"
  );
  await chooseMenuItem(
    item("moveToGroup").querySelector(`[data-move-parent="${ids.groupB}"]`),
    menu,
    "the second group"
  );
  await TestUtils.waitForCondition(async () => {
    const children = await childrenOf(engine, ids.groupB);
    return children.join() === [ids.tab4, ids.loose].join();
  }, "Move to group filed it at the end of the group");
  await TestUtils.waitForCondition(
    () => SvalPanel.nodes[ids.loose]?.placement?.parent === ids.groupB,
    "and the panel has redrawn from the moved tree"
  );

  menu = await openContextMenu(SvalPanel._rowElementFor(ids.loose));
  Assert.equal(
    item("moveToGroup")
      .querySelector("menuitem")
      ?.getAttribute("data-move-parent"),
    ids.workspace,
    "once in a group, the first destination is out of every group"
  );
  await closeContextMenu(menu);
});

/**
 * "Move to group"'s "New group…" asks for a group, makes it in the tab's
 * place and moves the tab into it, and a cancelled dialog makes nothing.
 */
add_task(async function move_to_group_makes_a_new_group_for_the_tab() {
  const { engine, ids } = await withFreshPanel();
  const newGroupEntry = menu =>
    menu
      .querySelector('[data-command="moveToGroup"]')
      .querySelector("[data-new-group]");

  let menu = await openContextMenu(SvalPanel._rowElementFor(ids.loose));
  const before = Object.keys((await engine.tree()).nodes).length;
  await chooseMenuItem(newGroupEntry(menu), menu, "New group…");
  Assert.equal(
    await answerContainerDialog(null),
    "new-group",
    "the new group dialog asked"
  );
  await within(SvalPanel.observer.settled(), 10_000, "the window settling");
  Assert.equal(
    Object.keys((await engine.tree()).nodes).length,
    before,
    "a cancelled dialog made nothing"
  );

  menu = await openContextMenu(SvalPanel._rowElementFor(ids.loose));
  await chooseMenuItem(newGroupEntry(menu), menu, "New group…");
  await answerContainerDialog("Errands");
  await TestUtils.waitForCondition(
    async () =>
      (await engine.tree()).nodes[ids.loose].placement.parent !== ids.workspace,
    "the tab moved"
  );
  const { nodes } = await engine.tree();
  const made = nodes[ids.loose].placement.parent;
  Assert.deepEqual(
    await childrenOf(engine, ids.workspace),
    [ids.groupA, made, ids.groupB],
    "into a group in the tab's place"
  );
  Assert.equal(nodes[made].kind, "group");
  Assert.equal(nodes[made].content.name, "Errands");
  Assert.deepEqual(
    await childrenOf(engine, made),
    [ids.loose],
    "and the tab is in it"
  );
});

/**
 * "Move to workspace" takes a group, with every tab in it, into another
 * workspace, and leaves the window on its own (import spec §6).
 */
add_task(async function move_to_workspace_takes_a_group_with_its_tabs() {
  const { engine, ids } = await withFreshPanel();
  const other = crypto.randomUUID();
  await engine.mutate({
    kind: "addWorkspace",
    name: "Elsewhere",
    id: other,
    now: Date.now(),
  });
  await SvalPanel.refresh();

  const menu = await openContextMenu(SvalPanel._rowElementFor(ids.groupA));
  const parent = menu.querySelector('[data-command="moveToWorkspace"]');
  Assert.ok(parent && !parent.hidden, "a group offers Move to workspace");
  const entries = Array.from(parent.querySelectorAll("menuitem")).map(el => [
    el.getAttribute("data-move-workspace"),
    el.getAttribute("data-move-workspace") ? el.getAttribute("label") : null,
  ]);
  Assert.deepEqual(
    entries.filter(([id]) => id === other || id === ids.workspace),
    [[other, "Elsewhere"]],
    "another workspace is offered, and never the window's own"
  );
  Assert.deepEqual(entries.at(-1), ["", null], "then a new one, last");
  await chooseMenuItem(
    parent.querySelector(`[data-move-workspace="${other}"]`),
    menu,
    "the other workspace"
  );

  await TestUtils.waitForCondition(async () => {
    const children = await childrenOf(engine, other);
    return children.join() === ids.groupA;
  }, "the group moved into the other workspace");
  Assert.deepEqual(
    await childrenOf(engine, ids.groupA),
    [ids.tab1, ids.tab2, ids.tab3],
    "with its tabs, in their order"
  );
  Assert.equal(
    SvalPanel.workspaceId,
    ids.workspace,
    "and the window stayed where it was"
  );
});

/**
 * The items a row's key also runs show that key, and name it to assistive
 * technology.
 */
add_task(async function the_menu_names_the_keys_that_do_the_same() {
  const { ShortcutUtils } = ChromeUtils.importESModule(
    "resource://gre/modules/ShortcutUtils.sys.mjs"
  );
  const { ids } = await withFreshPanel();
  const { ariaShortcut, MENU_KEYS } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalKeys.sys.mjs"
  );
  const ariaKeys = {
    rename: "rename",
    moveBefore: "moveUp",
    moveAfter: "moveDown",
    close: "delete",
  };
  const menu = await openContextMenu(SvalPanel._rowElementFor(ids.tab1));
  const expected = {
    rename: "F2",
    moveBefore: ShortcutUtils.getModifierString("alt") + "Up Arrow",
    moveAfter: ShortcutUtils.getModifierString("alt") + "Down Arrow",
    close: "Del",
  };
  for (const [command, text] of Object.entries(expected)) {
    const item = menu.querySelector(`[data-command="${command}"]`);
    Assert.equal(
      item.getAttribute("acceltext"),
      text,
      `${command} shows ${text}`
    );
    const acc = await accessibleOf(item);
    Assert.equal(
      acc.attributes.getStringProperty("keyshortcuts"),
      ariaShortcut(MENU_KEYS[ariaKeys[command]]),
      `${command} names its key to assistive technology`
    );
  }
  // A key of Firefox's, which the item names by its id.
  const newTab = menu.querySelector('[data-command="addTab"]');
  Assert.equal(newTab.getAttribute("key"), "key_newNavigatorTab");
  Assert.equal(
    newTab.getAttribute("acceltext"),
    ShortcutUtils.prettifyShortcut(
      document.getElementById("key_newNavigatorTab")
    ),
    "New tab shows Accel+T"
  );
  await closeContextMenu(menu);
});
