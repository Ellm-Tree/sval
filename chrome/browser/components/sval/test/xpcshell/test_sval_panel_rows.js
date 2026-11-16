/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from panel_model_head.js */

/**
 * The tree the panel draws is the nested structure the engine holds, in
 * sibling order, at the right depth.
 *
 * Its top level is the current workspace's children, and the workspace itself
 * is not a row: the switcher above the tree names it (spec §10.7).
 */
add_task(function rows_render_the_engines_nested_structure() {
  const rows = SvalPanelModel.rows(nestedDocument(), allExpanded);

  Assert.deepEqual(
    rows.map(row => [row.id, row.depth]),
    [
      ["g-a", 0],
      ["t-1", 1],
      ["t-2", 1],
      ["t-3", 1],
      ["g-b", 0],
      ["t-4", 1],
    ],
    "rows are depth-first in sibling order, rooted at the workspace's children"
  );

  Assert.ok(
    !rows.some(row => row.kind === "workspace"),
    "the workspace itself is not drawn as a row"
  );

  const group = rows[0];
  Assert.ok(group.hasChildren, "a group with tabs has children");
  Assert.ok(group.expanded, "and is expanded when not collapsed");

  const tab = rows.find(row => row.id === "t-1");
  Assert.equal(tab.url, "https://example.com/1", "a tab row carries its URL");
  Assert.ok(!tab.hasChildren, "a tab can never have children");
});

add_task(function a_tab_an_extension_hid_has_no_row() {
  const rows = SvalPanelModel.rows(nestedDocument(), {
    ...allExpanded,
    hidden: new Set(["t-1"]),
  });
  Assert.deepEqual(
    rows.map(row => row.id),
    ["g-a", "t-2", "t-3", "g-b", "t-4"],
    "the hidden tab is left out and nothing else is"
  );
  const next = rows.find(row => row.id === "t-2");
  Assert.ok(next.firstShown, "the row after it starts its siblings' rail");
  Assert.deepEqual(
    [next.posinset, next.setsize],
    [1, 2],
    "and the set counts only the tabs shown"
  );
});

/**
 * A group whose delete moves its contents out is drawn as its contents
 * while the delete waits on the Undo message: each child in the group's
 * place, one level up.
 */
add_task(function a_transparent_group_is_drawn_as_its_contents() {
  const rows = SvalPanelModel.rows(nestedDocument(), {
    ...allExpanded,
    transparent: new Set(["g-a"]),
  });
  Assert.deepEqual(
    rows.map(row => [row.id, row.depth]),
    [
      ["t-1", 0],
      ["t-2", 0],
      ["t-3", 0],
      ["g-b", 0],
      ["t-4", 1],
    ],
    "the group's tabs take its place, at its depth"
  );
  const last = rows.find(row => row.id === "g-b");
  Assert.deepEqual(
    [last.posinset, last.setsize],
    [4, 4],
    "and count in the set they joined"
  );
});

/**
 * A workspace holds tabs and groups as siblings in one ordered list, the way
 * loose files sit beside folders. Nothing may sort by kind: a tab whose order
 * key puts it between two groups is drawn between them, and it is counted in
 * their set size.
 */
add_task(function tabs_and_groups_are_siblings_in_one_ordered_list() {
  const nodes = {
    ws: node({ kind: "workspace", name: "Work", order: "80" }),
    "g-a": node({ kind: "group", name: "Reading", parent: "ws", order: "20" }),
    loose: node({
      kind: "tab",
      name: "Loose",
      parent: "ws",
      order: "60",
      url: "https://example.com/loose",
    }),
    "g-b": node({ kind: "group", name: "Shipping", parent: "ws", order: "a0" }),
    inner: node({ kind: "tab", name: "Inner", parent: "g-a", order: "80" }),
  };

  const rows = SvalPanelModel.rows(nodes, allExpanded);
  Assert.deepEqual(
    rows.map(row => [row.id, row.depth, row.posinset, row.setsize]),
    [
      ["g-a", 0, 1, 3],
      ["inner", 1, 1, 1],
      ["loose", 0, 2, 3],
      ["g-b", 0, 3, 3],
    ],
    "the loose tab sits between the two groups and is the second of three"
  );
  Assert.ok(
    !rows.find(row => row.id === "loose").hasChildren,
    "and is still a leaf, so it reports no expansion state"
  );
});

/**
 * Sibling order comes from `placement.order`, which the engine serialises as
 * lowercase hex whose lexicographic order is its index order. Orders that
 * sort differently as numbers than as strings catch a comparison done the
 * wrong way.
 */
add_task(function siblings_sort_by_the_fractional_index_as_a_string() {
  const nodes = {
    ws: node({ kind: "workspace", name: "W", order: "80" }),
    high: node({ kind: "tab", name: "high", parent: "ws", order: "9f" }),
    low: node({ kind: "tab", name: "low", parent: "ws", order: "10" }),
    mid: node({ kind: "tab", name: "mid", parent: "ws", order: "80" }),
  };

  Assert.deepEqual(
    SvalPanelModel.rows(nodes, allExpanded).map(row => row.name),
    ["low", "mid", "high"],
    "hex order keys sort lexicographically"
  );
});

/**
 * Spec §10.4: ARIA reports the full set size, not the visible subset, so the
 * numbers come from the document. That includes a collapsed branch, whose
 * children are not drawn and whose own `posinset` still counts them.
 */
add_task(function aria_set_size_counts_every_sibling_in_the_document() {
  const nodes = nestedDocument();
  const rows = SvalPanelModel.rows(nodes, allExpanded);
  const numbers = new Map(
    rows.map(row => [row.id, [row.posinset, row.setsize]])
  );

  Assert.ok(
    !numbers.has("ws"),
    "the workspace is named by the switcher, not drawn"
  );
  Assert.deepEqual(numbers.get("g-a"), [1, 2], "the first of two groups");
  Assert.deepEqual(numbers.get("g-b"), [2, 2], "the second of two groups");
  Assert.deepEqual(numbers.get("t-1"), [1, 3], "first of three tabs");
  Assert.deepEqual(numbers.get("t-2"), [2, 3], "second of three tabs");
  Assert.deepEqual(numbers.get("t-3"), [3, 3], "third of three tabs");
  Assert.deepEqual(
    numbers.get("t-4"),
    [1, 1],
    "the lone tab under the second group"
  );

  // Collapsing the first group removes three rows, and the second group is
  // still the second of two, which a set size computed from the drawn rows
  // would also get right. So the second group is collapsed, and the first
  // group's siblings are still counted as two.
  const collapsed = SvalPanelModel.rows(nodes, {
    isCollapsed: id => id === "g-a",
    root: "ws",
  });
  Assert.deepEqual(
    collapsed.map(row => [row.id, row.posinset, row.setsize]),
    [
      ["g-a", 1, 2],
      ["g-b", 2, 2],
      ["t-4", 1, 1],
    ],
    "a collapsed branch's own numbers are unchanged by its children going"
  );
});

/**
 * A collapsed group still draws the selection, as a collapsed Firefox tab
 * group still shows its active tab, and hides every other child. The ARIA
 * numbers stay the document's.
 */
add_task(function a_collapsed_group_still_draws_the_selected_tab() {
  const nodes = nestedDocument();
  const drawn = SvalPanelModel.rows(nodes, {
    isCollapsed: id => id === "g-a",
    root: "ws",
    selected: "t-2",
  });
  Assert.deepEqual(
    drawn.map(row => [row.id, row.depth, row.posinset, row.setsize]),
    [
      ["g-a", 0, 1, 2],
      ["t-2", 1, 2, 3],
      ["g-b", 0, 2, 2],
      ["t-4", 1, 1, 1],
    ],
    "only the selected tab shows under its collapsed group, at its own place"
  );
  const byId = new Map(drawn.map(row => [row.id, row]));
  Assert.equal(byId.get("g-a").expanded, false, "the group is still collapsed");
  Assert.ok(byId.get("g-a").showsSelection, "and shows the selection");
  Assert.ok(!byId.get("g-b").showsSelection, "a group without it does not");
  Assert.ok(byId.get("t-2").firstShown, "the tab is the first row under it");

  Assert.deepEqual(
    SvalPanelModel.rows(nodes, {
      isCollapsed: id => id === "g-a",
      root: "ws",
      selected: "t-4",
    }).map(row => row.id),
    ["g-a", "g-b", "t-4"],
    "with the selection elsewhere the collapsed group hides all it holds"
  );
  Assert.deepEqual(
    SvalPanelModel.rows(nodes, { ...allExpanded, selected: "t-2" }).map(row => [
      row.id,
      row.showsSelection,
    ]),
    [
      ["g-a", false],
      ["t-1", false],
      ["t-2", false],
      ["t-3", false],
      ["g-b", false],
      ["t-4", false],
    ],
    "an expanded group draws everything and shows no path"
  );
  Assert.deepEqual(
    SvalPanelModel.rows(nodes, {
      isCollapsed: id => id === "g-a",
      root: "ws",
      selected: "g-a",
    }).map(row => row.id),
    ["g-a", "g-b", "t-4"],
    "a selected container that is collapsed draws none of its children"
  );
});

/**
 * With nesting, the selection is drawn whichever groups above it are
 * collapsed, under the outermost collapsed one, with only the groups on the
 * path between them.
 */
add_task(function a_nested_selection_shows_through_every_collapsed_group() {
  const nodes = nestedDocument();
  nodes["g-in"] = node({
    kind: "group",
    name: "Inner",
    parent: "g-a",
    order: "c0",
  });
  nodes["t-in-1"] = node({
    kind: "tab",
    name: "Inner one",
    parent: "g-in",
    order: "20",
    url: "https://example.com/in-1",
  });
  nodes["t-in-2"] = node({
    kind: "tab",
    name: "Inner two",
    parent: "g-in",
    order: "60",
    url: "https://example.com/in-2",
  });
  const drawnWith = collapsed =>
    SvalPanelModel.rows(nodes, {
      isCollapsed: id => collapsed.includes(id),
      root: "ws",
      selected: "t-in-2",
    }).map(row => [
      row.id,
      row.depth,
      row.expanded,
      row.showsSelection,
      row.posinset,
      row.setsize,
    ]);

  const path = [
    ["t-in-2", 2, false, false, 2, 2],
    ["g-b", 0, false, false, 2, 2],
  ];
  Assert.deepEqual(
    drawnWith(["g-a", "g-in", "g-b"]),
    [["g-a", 0, false, true, 1, 2], ["g-in", 1, false, true, 4, 4], ...path],
    "both collapsed: the inner header and the tab, each at its depth"
  );
  Assert.deepEqual(
    drawnWith(["g-a", "g-b"]),
    [["g-a", 0, false, true, 1, 2], ["g-in", 1, true, true, 4, 4], ...path],
    "outer collapsed: the open inner group still shows only the path"
  );
  Assert.deepEqual(
    drawnWith(["g-in", "g-b"]),
    [
      ["g-a", 0, true, false, 1, 2],
      ["t-1", 1, false, false, 1, 4],
      ["t-2", 1, false, false, 2, 4],
      ["t-3", 1, false, false, 3, 4],
      ["g-in", 1, false, true, 4, 4],
      ...path,
    ],
    "inner collapsed: the outer group draws as usual, the inner only the tab"
  );
});

/**
 * A kind written by a newer build is carried by the engine and shown by
 * nobody: no row for it or beneath it, and no place in its siblings' ARIA
 * count (spec §5.5).
 */
add_task(function an_unknown_kind_and_everything_beneath_it_is_not_drawn() {
  const nodes = nestedDocument();
  nodes.note = node({ kind: "note", name: "Later", parent: "ws", order: "e0" });
  nodes["under-note"] = node({
    kind: "tab",
    name: "Under",
    parent: "note",
    order: "80",
    url: "https://example.com/under",
  });
  nodes["root-note"] = node({ kind: "note", name: "Root", order: "f0" });
  nodes["under-root-note"] = node({
    kind: "tab",
    name: "Under root",
    parent: "root-note",
    order: "80",
    url: "https://example.com/under-root",
  });

  const rows = SvalPanelModel.rows(nodes, allExpanded);
  const ids = rows.map(row => row.id);

  for (const hidden of ["note", "under-note", "root-note", "under-root-note"]) {
    Assert.ok(!ids.includes(hidden), `${hidden} is not drawn`);
  }
  const groupA = rows.find(row => row.id === "g-a");
  Assert.deepEqual(
    [groupA.posinset, groupA.setsize],
    [1, 2],
    "an unknown sibling is not counted"
  );
});

/**
 * `aria-expanded` is only meaningful on a node that can hold children, and a
 * leaf that reported it would announce as a collapsed branch.
 */
add_task(function only_containers_with_children_report_expansion() {
  const nodes = nestedDocument();
  const collapsedRows = SvalPanelModel.rows(nodes, {
    isCollapsed: () => true,
    root: "ws",
  });

  Assert.deepEqual(
    collapsedRows.map(row => [row.id, row.hasChildren, row.expanded]),
    [
      ["g-a", true, false],
      ["g-b", true, false],
    ],
    "collapsed by default, so only the workspace's own children are drawn"
  );

  const empty = {
    ws: node({ kind: "workspace", name: "Empty", order: "80" }),
    g: node({ kind: "group", name: "No tabs", parent: "ws", order: "80" }),
  };
  const rows = SvalPanelModel.rows(empty, allExpanded);
  const group = rows.find(row => row.id === "g");
  Assert.ok(
    !group.hasChildren,
    "a group with no children reports none, so no aria-expanded is written"
  );
});

/**
 * Spec §10.7: the panel draws one workspace's children and nothing else. The
 * other workspaces' tabs are data this window holds and does not show, which
 * is what makes a workspace a place.
 */
add_task(function rows_hold_nothing_from_another_workspace() {
  const nodes = {
    ws: node({ kind: "workspace", name: "Work", order: "40" }),
    home: node({ kind: "workspace", name: "Home", order: "c0" }),
    "work-tab": node({ kind: "tab", name: "Deck", parent: "ws", order: "80" }),
    "home-group": node({
      kind: "group",
      name: "Recipes",
      parent: "home",
      order: "80",
    }),
    "home-tab": node({
      kind: "tab",
      name: "Bread",
      parent: "home-group",
      order: "80",
    }),
  };

  Assert.deepEqual(
    SvalPanelModel.rows(nodes, allExpanded).map(row => row.id),
    ["work-tab"],
    "the Work window draws Work's tab only"
  );
  Assert.deepEqual(
    SvalPanelModel.rows(nodes, { isCollapsed: () => false, root: "home" }).map(
      row => row.id
    ),
    ["home-group", "home-tab"],
    "and a window showing Home draws Home's, from the same document"
  );
});

/**
 * Whether a node sits under a workspace, which is what keeps a window's acts
 * inside the workspace it shows.
 */
add_task(function containment_is_walked_to_the_root() {
  const { isWithin } = SvalPanelModel;
  const nodes = {
    ws: node({ kind: "workspace", name: "Work", order: "40" }),
    home: node({ kind: "workspace", name: "Home", order: "c0" }),
    g: node({ kind: "group", name: "Deep", parent: "ws", order: "80" }),
    t: node({ kind: "tab", name: "Deeper", parent: "g", order: "80" }),
    theirs: node({ kind: "tab", name: "Theirs", parent: "home", order: "80" }),
  };

  Assert.ok(isWithin(nodes, "t", "ws"), "a grandchild is within");
  Assert.ok(isWithin(nodes, "ws", "ws"), "and a node is within itself");
  Assert.ok(!isWithin(nodes, "theirs", "ws"), "another workspace's tab is not");
  Assert.ok(!isWithin(nodes, "gone", "ws"), "nor is a node that is not there");
  Assert.ok(!isWithin(nodes, "t", null), "and nothing is within no workspace");
});

/**
 * The containers above a node, which are what the panel opens to keep the
 * selected tab's row on screen.
 */
add_task(function ancestors_are_listed_nearest_first() {
  const { ancestorIds } = SvalPanelModel;
  const nodes = {
    ws: node({ kind: "workspace", name: "Work", order: "40" }),
    outer: node({ kind: "group", name: "Outer", parent: "ws", order: "80" }),
    inner: node({ kind: "group", name: "Inner", parent: "outer", order: "80" }),
    t: node({ kind: "tab", name: "Deep", parent: "inner", order: "80" }),
  };

  Assert.deepEqual(
    ancestorIds(nodes, "t"),
    ["inner", "outer", "ws"],
    "every container above a tab two groups deep, nearest first"
  );
  Assert.deepEqual(ancestorIds(nodes, "ws"), [], "a workspace has none");
  Assert.deepEqual(ancestorIds(nodes, "gone"), [], "nor does a missing node");
  Assert.deepEqual(ancestorIds(nodes, null), [], "nor does no node");
});

add_task(function a_container_row_counts_the_tabs_it_holds() {
  const nodes = nestedDocument();
  nodes["g-in"] = node({
    kind: "group",
    name: "Inner",
    parent: "g-a",
    order: "c0",
  });
  nodes["t-in"] = node({
    kind: "tab",
    name: "Deep",
    parent: "g-in",
    order: "20",
    url: "https://example.com/deep",
  });

  const byId = Object.fromEntries(
    SvalPanelModel.rows(nodes, allExpanded).map(row => [row.id, row])
  );
  Assert.equal(byId["g-a"].count, 4, "a group counts its tabs at any depth");
  Assert.equal(byId["g-in"].count, 1, "a nested group counts its own");
  Assert.equal(byId["g-b"].count, 1, "and a flat one counts its children");
  Assert.equal(byId["t-1"].count, 0, "a tab holds none");
});
