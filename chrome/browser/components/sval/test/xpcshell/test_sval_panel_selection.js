/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from panel_model_head.js */

/**
 * The panel's selection of several rows (spec §10.5), as the model decides
 * it: the keys, the range a Shift-click selects, and the one batch each
 * command on a selection writes.
 */

/**
 * The nested fixture with a loose tab and a third group at the top level:
 * ws holds t-top, g-a (t-1, t-2, t-3), t-mid, g-b (t-4) and g-c, in that
 * order.
 *
 * @returns {object} a `nodes` map.
 */
function mixedDocument() {
  return {
    ...nestedDocument(),
    "t-top": node({ kind: "tab", name: "Top", parent: "ws", order: "20" }),
    "t-mid": node({ kind: "tab", name: "Middle", parent: "ws", order: "80" }),
    "g-c": node({ kind: "group", name: "Later", parent: "ws", order: "e0" }),
  };
}

/**
 * Applies moves in order to a copy of `nodes`, as the engine applies a
 * batch, placing each between its two siblings by position.
 *
 * @param {object} nodes
 * @param {object[]} moves `{ id, newParent, before, after }` each.
 * @returns {Map<string, string[]>} each parent's children afterwards.
 */
function applied(nodes, moves) {
  const byParent = SvalTree.childrenByParent(nodes);
  for (const { id, newParent, before, after } of moves) {
    for (const children of byParent.values()) {
      const at = children.indexOf(id);
      if (at >= 0) {
        children.splice(at, 1);
      }
    }
    const children = byParent.get(newParent) ?? [];
    byParent.set(newParent, children);
    if (before !== null) {
      Assert.ok(children.includes(before), `${id} follows a sibling`);
      children.splice(children.indexOf(before) + 1, 0, id);
    } else if (after !== null) {
      children.splice(children.indexOf(after), 0, id);
    } else {
      children.push(id);
    }
    if (after !== null) {
      Assert.greater(
        children.indexOf(after),
        children.indexOf(id),
        `${id} precedes the sibling it names`
      );
    }
  }
  return byParent;
}

add_task(function the_selection_keys_are_the_aria_tree_patterns() {
  const { keyCommand } = SvalPanelModel;
  const leaf = { id: "t", hasChildren: false, expanded: false, depth: 1 };
  const key = (k, extra = {}) => ({ key: k, ...extra });

  Assert.equal(
    keyCommand(key("ArrowDown", { shiftKey: true }), leaf),
    "extendNext"
  );
  Assert.equal(
    keyCommand(key("ArrowUp", { shiftKey: true }), leaf),
    "extendPrevious"
  );
  Assert.equal(keyCommand(key(" ", { ctrlKey: true }), leaf), "toggleSelected");
  Assert.equal(
    keyCommand(key("Escape"), leaf, { selecting: true }),
    "clearSelection"
  );
  Assert.equal(
    keyCommand(key("Escape"), leaf),
    null,
    "with nothing to clear, Escape is the browser's"
  );
  Assert.equal(
    keyCommand(key(" "), leaf, { selecting: true }),
    "activate",
    "Space still shows the tab"
  );
  Assert.equal(
    keyCommand(key("ArrowDown", { shiftKey: true, altKey: true }), leaf),
    null,
    "Shift with Alt is no selection key"
  );
});

add_task(function a_range_runs_between_two_rows_in_the_order_drawn() {
  const { rangeIds } = SvalPanelModel;
  const ids = ["a", "b", "c", "d"];
  Assert.deepEqual(rangeIds(ids, "b", "d"), ["b", "c", "d"]);
  Assert.deepEqual(rangeIds(ids, "d", "b"), ["b", "c", "d"], "either way");
  Assert.deepEqual(rangeIds(ids, "c", "c"), ["c"]);
  Assert.deepEqual(rangeIds(ids, null, "c"), ["c"], "from nowhere, the row");
  Assert.deepEqual(rangeIds(ids, "b", "x"), [], "to an undrawn row, nothing");
});

add_task(function a_row_inside_a_selected_group_goes_with_it() {
  const nodes = mixedDocument();
  Assert.deepEqual(
    SvalPanelModel.outermostIds(nodes, ["g-a", "t-2", "t-mid", "t-mid"]),
    ["g-a", "t-mid"]
  );
});

add_task(function a_selection_moves_into_a_group_in_its_order() {
  const { moveIntoTargets } = SvalPanelModel;
  const nodes = mixedDocument();
  const moves = moveIntoTargets(nodes, ["t-top", "g-c", "t-mid"], "g-b");
  Assert.deepEqual(
    applied(nodes, moves).get("g-b"),
    ["g-c", "t-4", "t-top", "t-mid"],
    "the group after the groups there, the tabs at the end, each kind in order"
  );
  Assert.deepEqual(
    applied(nodes, moveIntoTargets(nodes, ["t-1", "t-top"], "g-a")).get("g-a"),
    ["t-1", "t-2", "t-3", "t-top"],
    "a node already there stays where it is"
  );
  Assert.deepEqual(
    moveIntoTargets(nodes, ["t-top", "g-a"], "g-a"),
    [],
    "no selection goes into one of its own"
  );
  Assert.deepEqual(
    moveIntoTargets(nodes, ["t-top"], "t-mid"),
    [],
    "nor into a tab"
  );
  Assert.deepEqual(
    moveIntoTargets(nodes, ["t-mid"], "g-b"),
    [SvalPanelModel.moveIntoTarget(nodes, "t-mid", "g-b")],
    "one node moves as Move to group moves it alone"
  );
});

add_task(function move_to_group_lists_where_a_whole_selection_can_go() {
  const nodes = mixedDocument();
  const ids = SvalPanelModel.moveToGroupChoices(
    nodes,
    ["t-1", "g-b"],
    "ws"
  ).map(choice => choice.id);
  Assert.deepEqual(ids, ["ws", "g-a", "g-c"]);
});

add_task(function a_dropped_selection_lands_together_where_it_was_dropped() {
  const { dropTargets } = SvalPanelModel;
  const nodes = mixedDocument();
  Assert.deepEqual(
    applied(nodes, dropTargets(nodes, ["t-top", "t-2"], "g-b", "after")).get(
      "ws"
    ),
    ["g-a", "t-mid", "g-b", "t-top", "t-2", "g-c"],
    "after a row, in the order drawn"
  );
  Assert.deepEqual(
    applied(nodes, dropTargets(nodes, ["t-1", "t-3"], "t-3", "after")).get(
      "g-a"
    ),
    ["t-2", "t-1", "t-3"],
    "beside a row of its own"
  );
  Assert.deepEqual(
    applied(
      nodes,
      dropTargets(nodes, ["t-mid", "t-4"], "g-a", "firstChild")
    ).get("g-a"),
    ["t-mid", "t-4", "t-1", "t-2", "t-3"],
    "first in a group"
  );
  Assert.deepEqual(
    applied(nodes, dropTargets(nodes, ["t-top", "t-1"], null, "end", "ws")).get(
      "ws"
    ),
    ["g-a", "t-mid", "g-b", "g-c", "t-top", "t-1"],
    "at the end of the workspace"
  );
  Assert.equal(
    dropTargets(nodes, ["t-1", "t-2"], "t-3", "before"),
    null,
    "a drop that leaves every row where it is writes nothing"
  );
  Assert.equal(
    dropTargets(nodes, ["g-a", "t-mid"], "t-2", "after"),
    null,
    "nor into a selected group"
  );
  Assert.equal(
    dropTargets(nodes, ["g-a", "t-mid"], "g-a", "into"),
    null,
    "nor into a selected group's row"
  );
});

add_task(function a_dragged_selection_drops_beside_or_into() {
  const { dropIntent } = SvalPanelModel;
  const { TAB, GROUP } = SvalTree;
  const nodes = mixedDocument();
  const at = y => ({ x: 10, y, w: 300, h: 32 });
  const carried = ["t-top", "g-c"];
  const tab = { id: "t-mid", kind: TAB };
  Assert.deepEqual(
    dropIntent(nodes, "t-top", tab, at(16), carried),
    { kind: "after" },
    "a tab's middle takes no new group from a selection"
  );
  Assert.deepEqual(dropIntent(nodes, "t-top", tab, at(10), carried), {
    kind: "before",
  });
  Assert.deepEqual(
    dropIntent(nodes, "t-top", { id: "g-b", kind: GROUP }, at(16), carried),
    { kind: "into" },
    "a collapsed group's middle takes it in"
  );
  Assert.deepEqual(
    dropIntent(nodes, "t-top", { id: "g-c", kind: GROUP }, at(16), carried),
    { kind: "noop" },
    "a row of its own is no place"
  );
  Assert.deepEqual(
    dropIntent(nodes, "t-1", { id: "t-2", kind: TAB }, at(16), ["t-1", "g-a"]),
    { kind: "refused" },
    "and a row inside one is refused"
  );
});

add_task(function a_selection_makes_a_group_where_its_first_row_was() {
  const { groupSelectionTarget } = SvalPanelModel;
  const nodes = mixedDocument();
  Assert.deepEqual(groupSelectionTarget(nodes, ["t-mid", "t-1", "g-c"]), {
    parent: "ws",
    before: "g-a",
    after: "g-b",
    members: ["t-mid", "t-1", "g-c"],
  });
  Assert.deepEqual(groupSelectionTarget(nodes, ["t-top", "t-mid"]), {
    parent: "ws",
    before: null,
    after: "g-a",
    members: ["t-top", "t-mid"],
  });
  Assert.deepEqual(
    groupSelectionTarget(nodes, ["t-mid"]),
    { parent: "ws", before: "g-a", after: "g-b", members: ["t-mid"] },
    "one row, as Move to group's New group… makes"
  );
  Assert.equal(groupSelectionTarget(nodes, ["gone"]), null, "no row");
});

add_task(function a_menu_on_a_selection_offers_a_group_from_it() {
  const { contextMenuItems, SELECTION_COMMANDS } = SvalPanelModel;
  const { TAB } = SvalTree;
  const items = contextMenuItems(TAB, { several: true });
  Assert.equal(
    items[items.indexOf("moveToGroup") + 1],
    "groupSelection",
    "after Move to group"
  );
  Assert.ok(!contextMenuItems(TAB).includes("groupSelection"), "one row's");
  for (const command of SELECTION_COMMANDS) {
    Assert.ok(items.includes(command), `${command} is on a tab's menu`);
  }
});
