/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from panel_model_head.js */

/**
 * The context menu's item set per row kind, spec §10.5's F2/dblclick rename
 * plus right-click: a tab is a leaf and gets no "New group"; a group and a
 * workspace both get it, filed inside the row it was opened on. No kind
 * offers "New workspace": the switcher is where a workspace is made.
 */
add_task(function context_menu_items_depend_on_row_kind() {
  const { contextMenuItems, TAB, GROUP, WORKSPACE } = SvalPanelModel;

  Assert.deepEqual(
    contextMenuItems(TAB),
    [
      "addTab",
      "nameSeparator",
      "rename",
      "clearLabel",
      "moveSeparator",
      "moveBefore",
      "moveAfter",
      "moveToGroup",
      "moveToWorkspace",
      "keepSeparator",
      "pin",
      "pinHere",
      "favorite",
      "copyMarkdownLink",
      "styleSite",
      "createSplitSeparator",
      "createSplit",
      "addToSplit",
      "loadSeparator",
      "unload",
      "keepLoaded",
      "media",
      "closeSeparator",
      "close",
    ],
    "a tab is a leaf: a new tab beside it, rename and its undoing, the moves, Pin and Pin " +
      "to This Workspace, Add to Favorites, copy as a Markdown link, style " +
      "its site, a " +
      "split beside it or one to join, unload, keep loaded, the media button'sentry, and close, " +
      "each block of like entries after a separator, and no colour or " +
      "emoji, which would need a row wide enough to show them"
  );
  Assert.deepEqual(
    contextMenuItems(GROUP),
    [
      "addTab",
      "addGroup",
      "nameSeparator",
      "edit",
      "moveSeparator",
      "moveBefore",
      "moveAfter",
      "moveToGroup",
      "moveToWorkspace",
      "loadSeparator",
      "unload",
      "media",
      "closeSeparator",
      "deleteGroup",
    ],
    "a group can also hold a new group, and is a place, so it is edited " +
      "in its dialog; it is deleted, never closed; a block it offers " +
      "nothing from has no separator"
  );
  Assert.deepEqual(
    contextMenuItems(WORKSPACE),
    [
      "addTab",
      "addGroup",
      "nameSeparator",
      "edit",
      "closeSeparator",
      "deleteWorkspace",
    ],
    "a workspace has no moves: it is not a row, so it has no siblings here " +
      "to move among. It is deleted, never closed: closing its window is " +
      "what closes it"
  );
  Assert.deepEqual(
    contextMenuItems(TAB, { temporary: true }),
    [
      "addTab",
      "moveSeparator",
      "moveBefore",
      "moveAfter",
      "moveToGroup",
      "keepSeparator",
      "copyMarkdownLink",
      "createSplitSeparator",
      "createSplit",
      "addToSplit",
      "loadSeparator",
      "unload",
      "keepLoaded",
      "media",
      "closeSeparator",
      "close",
    ],
    "a private window's tab keeps its blocks without what that window " +
      "lacks, a name of the user's included"
  );
  Assert.deepEqual(
    contextMenuItems(WORKSPACE, { temporary: true }),
    ["addTab", "addGroup", "nameSeparator", "edit"],
    "a block left empty takes its separator with it, at the end too"
  );
  Assert.ok(
    !contextMenuItems(WORKSPACE, { temporary: true }).includes(
      "deleteWorkspace"
    ),
    "a private window cannot delete its one workspace"
  );
  Assert.ok(
    !contextMenuItems(TAB, { temporary: true }).includes("moveToWorkspace"),
    "a private window has no other workspace to move a row to"
  );
  Assert.ok(
    !contextMenuItems(TAB, { temporary: true }).some(item =>
      item.startsWith("pin")
    ),
    "a private window shows no pins, so none is made there"
  );
  Assert.ok(
    !contextMenuItems(TAB, { temporary: true }).includes("favorite"),
    "a private window files nothing in Favorites"
  );
  Assert.ok(
    contextMenuItems(TAB, { pane: true }).includes("favorite"),
    "a pane's page can be a favorite, as the favorite button makes it"
  );
  Assert.ok(
    !contextMenuItems(TAB, { pane: true }).some(item => item.startsWith("pin")),
    "a pane is its split's, and is not pinned"
  );
  for (const kind of [TAB, GROUP, WORKSPACE]) {
    Assert.ok(
      !contextMenuItems(kind).includes("addWorkspace"),
      `${kind} does not offer a new workspace: the switcher does`
    );
  }

  for (const kind of [TAB, GROUP, WORKSPACE]) {
    Assert.ok(
      contextMenuItems(kind).includes("addTab"),
      `${kind} offers a new tab: the panel is the only tab surface there is`
    );
  }
});

/**
 * Deleting a container with its contents deletes outright (spec §5.4: no
 * closed state, no tombstone), so the count offered before confirming is
 * every descendant the delete would take with it, at any depth.
 */
add_task(function descendant_count_is_every_descendant_not_just_children() {
  const { descendantCount } = SvalPanelModel;
  const nodes = nestedDocument();

  Assert.equal(
    descendantCount(nodes, "t-1"),
    0,
    "a leaf tab has no descendants"
  );
  Assert.equal(
    descendantCount(nodes, "g-a"),
    3,
    "the first group's three tabs are its descendants"
  );
  Assert.equal(
    descendantCount(nodes, "ws"),
    6,
    "the workspace's descendants are both groups and all four tabs"
  );

  const deep = {
    ...nodes,
    "g-c": node({ kind: "group", name: "Nested", parent: "g-b", order: "80" }),
    "t-5": node({ kind: "tab", name: "Five", parent: "g-c", order: "80" }),
  };
  Assert.equal(
    descendantCount(deep, "g-b"),
    3,
    "a group nested inside another group still counts as a live descendant"
  );
  Assert.equal(
    descendantCount(deep, "ws"),
    8,
    "and so does everything under it, transitively"
  );
});

add_task(function delete_workspace_text_says_the_tabs_go_too() {
  const { deleteWorkspaceText } = SvalPanelModel;

  const five = deleteWorkspaceText("Work", 5, 2);
  const empty = deleteWorkspaceText("Work", 0, 0);
  Assert.stringContains(five.title, "Work", "the workspace is named");
  Assert.stringContains(five.body, "5", "its tabs are counted");
  Assert.ok(!five.body.includes("2"), "without the groups");
  Assert.notEqual(five.body, empty.body, "the text says the tabs go with it");
  Assert.stringContains(
    deleteWorkspaceText("Work", 1, 0).body,
    "1",
    "one tab is counted"
  );
  const groupsOnly = deleteWorkspaceText("Work", 0, 2).body;
  Assert.stringContains(
    groupsOnly,
    "2",
    "with no tabs inside, the groups are what would be lost"
  );
  Assert.notEqual(
    groupsOnly,
    deleteWorkspaceText("Work", 2, 0).body,
    "and are told as groups"
  );
  Assert.equal(empty.title, five.title, "an empty workspace asks the same");
  Assert.ok(!/\d/.test(empty.body), "and names nothing inside it");
});

add_task(function delete_group_text_offers_both_fates() {
  const { deleteGroupText } = SvalPanelModel;

  const reading = deleteGroupText("Reading", 3, 0);
  Assert.stringContains(
    reading.title,
    "Reading",
    "the question names the group"
  );
  Assert.stringContains(reading.body, "3", "and counts its tabs");
  const projects = deleteGroupText("Projects", 0, 1).body;
  Assert.stringContains(
    projects,
    "1",
    "a group holding only a group counts that group"
  );
  Assert.notEqual(
    projects,
    deleteGroupText("Projects", 1, 0).body,
    "as a group"
  );
});

/**
 * The delete questions count tabs. A workspace of three groups each holding
 * two tabs has nine descendants and six tabs.
 */
add_task(function the_close_count_is_tabs_and_not_every_node() {
  const { descendantTabCount, descendantCount } = SvalPanelModel;
  const nodes = nestedDocument();

  Assert.equal(
    descendantCount(nodes, "ws"),
    6,
    "the workspace has six descendants: two groups and four tabs"
  );
  Assert.equal(
    descendantTabCount(nodes, "ws"),
    4,
    "but only four tabs, so the groups do not inflate the count"
  );
  Assert.equal(
    descendantTabCount(nodes, "t-1"),
    0,
    "a leaf tab has no tabs under it"
  );

  const empty = {
    ...nodes,
    "g-c": node({ kind: "group", name: "Empty", parent: "g-b", order: "e0" }),
  };
  Assert.equal(
    descendantTabCount(empty, "g-c"),
    0,
    "and a container holding nothing has none either"
  );

  // A group holding only groups has no tab to count, and deleting it still
  // destroys what the user made.
  const { descendantGroupCount } = SvalPanelModel;
  Assert.equal(
    descendantGroupCount(nodes, "ws"),
    2,
    "the workspace's two groups are counted as groups"
  );
  Assert.equal(
    descendantGroupCount(empty, "g-b"),
    1,
    "and so is a group nested inside a group"
  );
  Assert.equal(
    descendantGroupCount(nodes, "g-a"),
    0,
    "a group holding only tabs has no groups in it"
  );
});
