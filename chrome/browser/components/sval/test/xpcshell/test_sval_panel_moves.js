/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from panel_model_head.js */

/**
 * A move is expressed as the sibling pair `moveNode` orders against, because
 * only siblings under one parent can bound a fractional index. A direction
 * with nowhere to go produces nothing.
 */
add_task(function move_targets_name_the_siblings_a_node_lands_between() {
  const { moveTarget } = SvalPanelModel;
  const nodes = nestedDocument();

  Assert.deepEqual(
    moveTarget(nodes, "t-2", "moveBefore"),
    { id: "t-2", newParent: "g-a", before: null, after: "t-1" },
    "moving the second tab up puts it before the first"
  );
  Assert.deepEqual(
    moveTarget(nodes, "t-2", "moveAfter"),
    { id: "t-2", newParent: "g-a", before: "t-3", after: null },
    "moving it down puts it after the third"
  );
  Assert.equal(
    moveTarget(nodes, "t-1", "moveBefore"),
    null,
    "the first sibling cannot move up"
  );
  Assert.equal(
    moveTarget(nodes, "t-3", "moveAfter"),
    null,
    "the last sibling cannot move down"
  );

  Assert.deepEqual(
    moveTarget(nodes, "g-b", "moveIn"),
    { id: "g-b", newParent: "g-a", before: null, after: "t-1" },
    "indenting nests a group under the sibling above it, ahead of its tabs"
  );
  Assert.equal(
    moveTarget(nodes, "t-2", "moveIn"),
    null,
    "a tab cannot become a parent, so there is nowhere to indent into"
  );

  Assert.deepEqual(
    moveTarget(nodes, "t-1", "moveOut"),
    { id: "t-1", newParent: "ws", before: "g-a", after: null },
    "outdenting lifts a tab to its grandparent, just after the group it left"
  );
  Assert.equal(
    moveTarget(nodes, "g-a", "moveOut"),
    null,
    "a group directly under a workspace has nowhere further out to go"
  );
  Assert.equal(
    moveTarget(nodes, "ws", "moveOut"),
    null,
    "and a workspace is already a root"
  );
});

/**
 * The nested fixture with a loose tab and a third group at the workspace's top
 * level, interleaved as tab, group, tab, group, group, so a default slot has
 * both kinds to find its place among.
 *
 * @returns {object} a `nodes` map.
 */
function mixedDocument() {
  return {
    ...nestedDocument(),
    "t-top": node({
      kind: "tab",
      name: "Top",
      parent: "ws",
      order: "20",
      url: "https://example.com/top",
    }),
    "t-mid": node({
      kind: "tab",
      name: "Middle",
      parent: "ws",
      order: "80",
      url: "https://example.com/mid",
    }),
    "g-c": node({ kind: "group", name: "Later", parent: "ws", order: "e0" }),
    "g-inner": node({
      kind: "group",
      name: "Inner",
      parent: "g-a",
      order: "f0",
    }),
  };
}

/**
 * Where a node lands when nobody named a place: a group after the last group
 * already there, a tab at the end. The existing order is read as it is: a
 * tab sitting above a group stays there, and the new group goes after the
 * last group wherever that is.
 */
add_task(function a_default_slot_puts_groups_after_groups_and_tabs_last() {
  const { defaultSlot } = SvalPanelModel;
  const nodes = mixedDocument();
  // ws: t-top(20) g-a(40) t-mid(80) g-b(c0) g-c(e0)

  nodes["g-new"] = node({
    kind: "group",
    name: "New",
    parent: "ws",
    order: "f8",
  });
  Assert.deepEqual(
    defaultSlot(nodes, "ws", "g-new"),
    { before: "g-c", after: null },
    "with groups last already, a new group goes after the last of them"
  );

  nodes["t-new"] = node({
    kind: "tab",
    name: "New tab",
    parent: "ws",
    order: "fc",
    url: "https://example.com/new",
  });
  Assert.deepEqual(
    defaultSlot(nodes, "ws", "g-new"),
    { before: "g-c", after: "t-new" },
    "and ahead of a tab that follows them"
  );
  Assert.deepEqual(
    defaultSlot(nodes, "ws", "t-new"),
    { before: "g-new", after: null },
    "a tab goes at the end, leaving itself out of the list it is placed in"
  );

  // g-a holds three tabs and then g-inner.
  Assert.deepEqual(
    defaultSlot(nodes, "g-a", "g-b"),
    { before: "g-inner", after: null },
    "a group joining a container whose only group is last goes after it"
  );
  Assert.deepEqual(
    defaultSlot(nodes, "g-b", "g-c"),
    { before: null, after: "t-4" },
    "a group joining a container of tabs goes first"
  );
  Assert.deepEqual(
    defaultSlot(nodes, "g-c", "t-1"),
    { before: null, after: null },
    "anything joining an empty container is its only child"
  );
});

/**
 * "Move into" is refused for every parent that cannot take the node, so the
 * menu can leave those out and a drag can show no target for them.
 */
add_task(function moving_into_is_refused_where_it_could_not_happen() {
  const { moveIntoTarget } = SvalPanelModel;
  const nodes = mixedDocument();

  Assert.deepEqual(
    moveIntoTarget(nodes, "t-top", "g-b"),
    { id: "t-top", newParent: "g-b", before: "t-4", after: null },
    "a tab joins a group at its end"
  );
  Assert.deepEqual(
    moveIntoTarget(nodes, "g-c", "g-a"),
    { id: "g-c", newParent: "g-a", before: "g-inner", after: null },
    "a group joins after the groups already there"
  );
  Assert.deepEqual(
    moveIntoTarget(nodes, "t-1", "ws"),
    { id: "t-1", newParent: "ws", before: "g-c", after: null },
    "the workspace itself is a destination: out of every group"
  );
  Assert.equal(
    moveIntoTarget(nodes, "t-top", "t-mid"),
    null,
    "a tab cannot hold anything"
  );
  Assert.equal(moveIntoTarget(nodes, "g-a", "g-a"), null, "nor can itself");
  Assert.equal(
    moveIntoTarget(nodes, "g-a", "g-inner"),
    null,
    "nor anything inside it, which would be a cycle"
  );
  Assert.equal(
    moveIntoTarget(nodes, "t-1", "g-a"),
    null,
    "nor the parent it is already in"
  );
  Assert.equal(
    moveIntoTarget(nodes, "t-1", "nowhere"),
    null,
    "nor a parent that is not there"
  );
});

/**
 * "Move to group" lists the workspace, then every group in it at its depth,
 * collapsed or not, leaving out the node, what is inside it, and where it
 * already is.
 */
add_task(function move_to_group_lists_every_group_it_could_join() {
  const { moveToGroupChoices } = SvalPanelModel;
  const nodes = mixedDocument();

  Assert.deepEqual(
    moveToGroupChoices(nodes, "t-1", "ws"),
    [
      { id: "ws", kind: "workspace", depth: 0 },
      { id: "g-inner", kind: "group", depth: 1 },
      { id: "g-b", kind: "group", depth: 0 },
      { id: "g-c", kind: "group", depth: 0 },
    ],
    "a tab in g-a can go out of every group, into g-a's own inner group, " +
      "or into either other group — but not into g-a, where it already is"
  );
  Assert.deepEqual(
    moveToGroupChoices(nodes, "g-a", "ws"),
    [
      { id: "g-b", kind: "group", depth: 0 },
      { id: "g-c", kind: "group", depth: 0 },
    ],
    "a top-level group cannot go into the workspace it is in, itself, or " +
      "the group inside it"
  );
  Assert.deepEqual(
    moveToGroupChoices(nodes, "t-1", null),
    [],
    "with no workspace shown there is nowhere to list"
  );
});

/**
 * A pointer's place on a row picks the drop: the edges go beside it, the
 * middle joins a group, or makes one once the pointer has rested.
 */
add_task(function a_drop_zone_depends_on_the_pointers_place_on_the_row() {
  const { dropIntent } = SvalPanelModel;
  const nodes = mixedDocument();
  const tab = { id: "t-mid", kind: "tab", expanded: false };
  const collapsedGroup = { id: "g-b", kind: "group", expanded: false };
  const openGroup = { id: "g-b", kind: "group", expanded: true };
  // A 240px panel's row, 32px tall.
  const at = (y, x = 100) => ({ x, y, w: 224, h: 32 });
  const kind = (id, over, place) => dropIntent(nodes, id, over, place).kind;

  Assert.equal(kind("t-top", tab, at(4)), "before", "the top 8px");
  Assert.equal(kind("t-top", tab, at(28)), "after", "the bottom 8px");
  Assert.equal(
    kind("t-top", tab, at(16)),
    "newGroup",
    "a tab's middle makes a group of the two, with no wait"
  );
  Assert.equal(
    kind("t-top", tab, at(16, 111)),
    "newGroup",
    "across the whole inline-start half"
  );
  Assert.equal(
    kind("t-top", tab, at(16, 112)),
    "split",
    "and its inline-end half splits the two together"
  );
  Assert.equal(
    kind("t-top", tab, at(16, 223)),
    "split",
    "out to the row's end"
  );
  Assert.equal(
    kind("t-top", tab, { ...at(16, 200), narrow: true }),
    "newGroup",
    "except in a panel too narrow for a split zone"
  );
  Assert.equal(
    kind("t-top", collapsedGroup, at(16)),
    "into",
    "a tab on a collapsed group's middle goes into it"
  );
  Assert.equal(
    kind("g-a", collapsedGroup, at(16)),
    "into",
    "and so does a group, which nests"
  );
  Assert.equal(
    kind("g-a", tab, at(10)),
    "before",
    "a group on a tab goes before or after it, by halves"
  );
  Assert.equal(kind("g-a", tab, at(20)), "after", "either way");
  Assert.equal(
    kind("t-top", openGroup, at(20)),
    "firstChild",
    "an open group's lower half is its first child's place"
  );
  Assert.equal(kind("t-top", openGroup, at(12)), "before", "its upper half");
  Assert.equal(
    kind("t-top", collapsedGroup, at(28)),
    "after",
    "under a collapsed one, it is after the group"
  );
  Assert.equal(
    kind("t-top", { ...collapsedGroup, showsSelection: true }, at(20)),
    "firstChild",
    "unless the selection is drawn under it, which puts a row there"
  );
  Assert.equal(
    kind("g-a", { id: "g-a", kind: "group", expanded: true }, at(16)),
    "noop",
    "a row on itself does nothing"
  );
});

/**
 * A drop names the same sibling pair a keystroke does, and refuses what would
 * be a cycle, a broken chain, or no move at all.
 */
add_task(function a_drop_lands_between_the_rows_it_was_aimed_at() {
  const { dropTarget } = SvalPanelModel;
  const nodes = mixedDocument();
  // ws: t-top(20) g-a(40) t-mid(80) g-b(c0) g-c(e0)

  Assert.deepEqual(
    dropTarget(nodes, "g-c", "t-top", "before", "ws"),
    { id: "g-c", newParent: "ws", before: null, after: "t-top" },
    "a group can go above a tab: groups first is a default, not a rule"
  );
  Assert.deepEqual(
    dropTarget(nodes, "t-top", "g-b", "after", "ws"),
    { id: "t-top", newParent: "ws", before: "g-b", after: "g-c" },
    "and a tab between two groups"
  );
  Assert.deepEqual(
    dropTarget(nodes, "t-mid", "t-2", "after", "ws"),
    { id: "t-mid", newParent: "g-a", before: "t-2", after: "t-3" },
    "a drop beside a row inside a group goes into that group"
  );
  Assert.deepEqual(
    dropTarget(nodes, "t-top", "g-a", "firstChild", "ws"),
    { id: "t-top", newParent: "g-a", before: null, after: "t-1" },
    "the first child's place is ahead of whatever is first now"
  );
  Assert.deepEqual(
    dropTarget(nodes, "t-1", null, "end", "ws"),
    { id: "t-1", newParent: "ws", before: "g-c", after: null },
    "the space under the last row is the end of the workspace"
  );
  Assert.deepEqual(
    dropTarget(nodes, "t-top", "g-b", "into", "ws"),
    { id: "t-top", newParent: "g-b", before: "t-4", after: null },
    "joining a group uses its default slot"
  );

  Assert.equal(
    dropTarget(nodes, "t-top", "g-a", "before", "ws"),
    null,
    "a drop that leaves the node exactly where it is is no move"
  );
  Assert.equal(
    dropTarget(nodes, "g-c", null, "end", "ws"),
    null,
    "including at the end, for what is already last"
  );
  Assert.equal(
    dropTarget(nodes, "g-a", "g-a", "after", "ws"),
    null,
    "a node cannot be dropped beside itself"
  );
  Assert.equal(
    dropTarget(nodes, "g-a", "t-2", "before", "ws"),
    null,
    "nor anywhere inside itself"
  );
});

/**
 * A merge pairs a tab with a tab or a group with a group, and makes the new
 * group where the target was.
 */
add_task(function a_merge_makes_a_group_where_the_target_was() {
  const { mergeTarget } = SvalPanelModel;
  const nodes = mixedDocument();
  // ws: t-top(20) g-a(40) t-mid(80) g-b(c0) g-c(e0)

  Assert.deepEqual(
    mergeTarget(nodes, "t-top", "t-mid"),
    {
      id: "t-top",
      target: "t-mid",
      parent: "ws",
      before: "g-a",
      after: "t-mid",
    },
    "two tabs: the group goes where the target is"
  );
  Assert.deepEqual(
    mergeTarget(nodes, "t-1", "t-mid"),
    { id: "t-1", target: "t-mid", parent: "ws", before: "g-a", after: "t-mid" },
    "from inside another group too"
  );
  Assert.deepEqual(
    mergeTarget(nodes, "g-c", "g-b"),
    { id: "g-c", target: "g-b", parent: "ws", before: "t-mid", after: "g-b" },
    "two groups"
  );
  Assert.equal(
    mergeTarget(nodes, "t-top", "g-b"),
    null,
    "a tab on a group joins"
  );
  Assert.equal(
    mergeTarget(nodes, "g-b", "t-mid"),
    null,
    "a group on a tab is nothing"
  );
  Assert.equal(mergeTarget(nodes, "t-top", "t-top"), null, "nor onto itself");
  Assert.equal(
    mergeTarget(nodes, "g-a", "g-inner"),
    null,
    "nor a group onto a group inside it"
  );
});
