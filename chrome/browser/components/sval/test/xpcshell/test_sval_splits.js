/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from tabs_head.js */
/* import-globals-from panel_model_head.js */

/**
 * Split view between the tree and a window (split-view spec §5, §6.1): which
 * splits a window shows for a document, how the panel draws them, and what
 * the document holds after the user changes a split in Firefox's own UI. The
 * writes are applied to a real engine, so what is asserted is the tree the
 * user's other devices and next launch read. `browser_sval_split_view.js` is
 * the same in a real window.
 */

/** The document the tests sync, named as the panel names it. */
const SYNC = "workspaces";

const { sharesOf, splitChanges, splitWrites, splitsToShow, widthsOf } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSplits.sys.mjs"
  );

/**
 * An engine holding one workspace with `count` tabs, and when `split` is
 * given, a split node holding the tabs it names by index, at the place of
 * the first of them.
 *
 * @param {number} count
 * @param {object} [options]
 * @param {number[]} [options.split] Indexes of the tabs in the split.
 * @param {number[]} [options.shares] The split's widths.
 * @returns {Promise<object>} `{ engine, workspace, tabs, split }`.
 */
async function workspaceWith(count, { split = null, shares = null } = {}) {
  const engine = new SvalEngine({
    root: await makeTempDir("sval-splits"),
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  const workspace = crypto.randomUUID();
  const tabs = Array.from({ length: count }, () => crypto.randomUUID());
  const ops = [{ kind: "addWorkspace", name: "Work", id: workspace }];
  tabs.forEach((id, index) =>
    ops.push({
      kind: "addTab",
      parent: workspace,
      name: `Tab ${index}`,
      url: `https://example.com/${index}`,
      id,
    })
  );
  const splitId = split ? crypto.randomUUID() : null;
  if (split) {
    ops.push({
      kind: "addSplit",
      parent: workspace,
      id: splitId,
      before: tabs[split[0] - 1] ?? null,
      after: tabs[split[0]],
    });
    let last = null;
    for (const index of split) {
      ops.push({
        kind: "moveNode",
        id: tabs[index],
        newParent: splitId,
        before: last,
        after: null,
      });
      last = tabs[index];
    }
  }
  await engine.mutate({ kind: "batch", ops, now: 1000 });
  if (shares) {
    await engine.mutate({
      kind: "setContent",
      id: splitId,
      name: "",
      shares,
      now: 1001,
    });
  }
  return { engine, workspace, tabs, split: splitId };
}

/**
 * The workspace as the user sees it in the panel and the window: each child
 * in order, a split as the list of its tabs.
 *
 * @param {object} engine
 * @param {string} workspace
 * @returns {Promise<Array<string|string[]>>}
 */
async function shape(engine, workspace) {
  const nodes = (await engine.tree()).nodes ?? {};
  const byParent = SvalPanelModel.childrenByParent(nodes);
  return (byParent.get(workspace) ?? []).map(id =>
    nodes[id].kind === SvalPanelModel.SPLIT ? (byParent.get(id) ?? []) : id
  );
}

/**
 * A split a merge left holding `count` tabs, more than a local edit allows:
 * two devices each add tabs to the same split of two before either has seen
 * the other's (split-view spec §5.3).
 *
 * @param {number} count Five or six.
 * @returns {Promise<object>} `{ engine, workspace, tabs }`, `tabs` in the
 *   merged split's pane order.
 */
async function overfull(count) {
  const root = await makeTempDir("sval-splits-merge");
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const [a, b] = [0, 1].map(
    () =>
      new SvalEngine({
        root,
        sharedRoot: root,
        keyBytes,
        deviceId: crypto.getRandomValues(new Uint8Array(16)),
      })
  );
  const workspace = crypto.randomUUID();
  const split = crypto.randomUUID();
  const first = [crypto.randomUUID(), crypto.randomUUID()];
  const addTab = (id, parent) => ({
    kind: "addTab",
    parent,
    name: "Tab",
    url: "https://example.com/",
    id,
  });
  await a.mutate({
    kind: "batch",
    ops: [
      { kind: "addWorkspace", name: "Work", id: workspace },
      { kind: "addSplit", parent: workspace, id: split },
      ...first.map(id => addTab(id, split)),
    ],
    now: 1000,
  });
  await a.sync(SYNC, 1100);
  await b.sync(SYNC, 1200);
  const more = n => Array.from({ length: n }, () => crypto.randomUUID());
  await a.mutate({
    kind: "batch",
    ops: more(2).map(id => addTab(id, split)),
    now: 1300,
  });
  await b.mutate({
    kind: "batch",
    ops: more(count - 4).map(id => addTab(id, split)),
    now: 1400,
  });
  await a.sync(SYNC, 1500);
  await b.sync(SYNC, 1600);
  const nodes = (await b.tree()).nodes ?? {};
  const tabs = SvalPanelModel.childrenByParent(nodes).get(split);
  Assert.equal(tabs.length, count, `the merge left ${count} tabs in the split`);
  return { engine: b, workspace, tabs };
}

/**
 * Applies `splitWrites`' answer to `engine`, as `SvalTabs` does.
 *
 * @param {object} engine
 * @param {object} act What `splitWrites` takes besides the tree.
 * @returns {Promise<object[]>} the operations written.
 */
async function write(engine, act) {
  const nodes = (await engine.tree()).nodes ?? {};
  const ops = splitWrites(
    nodes,
    {
      present: new Set(Object.keys(nodes)),
      moved: new Set(),
      closed: new Set(),
      ...act,
    },
    () => crypto.randomUUID()
  );
  if (ops.length) {
    await engine.mutate({ kind: "batch", ops, now: 2000 });
  }
  return ops;
}

add_task(async function a_split_shows_its_tabs_in_runs_of_four() {
  for (const count of [1, 2, 4]) {
    const all = Array.from({ length: count }, (_, i) => i);
    const { engine, tabs } = await workspaceWith(count, { split: all });
    const nodes = (await engine.tree()).nodes ?? {};
    Assert.deepEqual(
      splitsToShow(nodes, new Set(tabs)),
      count > 1 ? [tabs] : [],
      `a split of ${count} shows ${count > 1 ? "as one split" : "as a tab"}`
    );
  }

  const { engine: emptied, tabs: gone } = await workspaceWith(1, {
    split: [0],
  });
  await emptied.mutate({ kind: "remove", id: gone[0], now: 1500 });
  Assert.deepEqual(
    splitsToShow((await emptied.tree()).nodes, new Set()),
    [],
    "a split holding no tab shows nothing"
  );

  const five = await overfull(5);
  Assert.deepEqual(
    splitsToShow((await five.engine.tree()).nodes, new Set(five.tabs)),
    [five.tabs.slice(0, 4)],
    "five tabs show as a split of four, the fifth an ordinary tab"
  );
  const six = await overfull(6);
  Assert.deepEqual(
    splitsToShow((await six.engine.tree()).nodes, new Set(six.tabs)),
    [six.tabs.slice(0, 4), six.tabs.slice(4)],
    "six tabs show as a split of four and a split of two"
  );
});

add_task(async function the_panel_draws_a_split_as_one_row_where_it_is() {
  const { engine, workspace, tabs, split } = await workspaceWith(4, {
    split: [1, 2],
  });
  const nodes = (await engine.tree()).nodes ?? {};
  const rows = SvalPanelModel.rows(nodes, {
    isCollapsed: () => false,
    root: workspace,
  });
  Assert.deepEqual(
    rows.map(row => [row.id, row.kind, row.depth, row.posinset, row.setsize]),
    [
      [tabs[0], "tab", 0, 1, 3],
      [split, "split", 0, 2, 3],
      [tabs[3], "tab", 0, 3, 3],
    ],
    "the split is one row at its place, among its siblings"
  );
  Assert.deepEqual(
    rows[1].panes.map(pane => [
      pane.id,
      pane.split,
      pane.depth,
      pane.posinset,
      pane.setsize,
    ]),
    [
      [tabs[1], split, 1, 1, 2],
      [tabs[2], split, 1, 2, 2],
    ],
    "holding its panes in pane order, one level in"
  );
});

add_task(async function a_split_of_six_is_two_rows_and_a_hidden_pane_none() {
  const six = await overfull(6);
  const nodes = (await six.engine.tree()).nodes ?? {};
  const rows = SvalPanelModel.rows(nodes, {
    isCollapsed: () => false,
    root: six.workspace,
  });
  Assert.deepEqual(
    rows.map(row => row.panes?.map(pane => pane.id) ?? row.id),
    [six.tabs.slice(0, 4), six.tabs.slice(4)],
    "six panes are a row of four and a row of two"
  );
  const split = nodes[six.tabs[0]].placement.parent;
  Assert.deepEqual(
    rows.map(row => [row.id, row.split]),
    [
      [split, split],
      [`${split}:1`, split],
    ],
    "both of the one split"
  );

  const hidden = SvalPanelModel.rows(nodes, {
    isCollapsed: () => false,
    root: six.workspace,
    hidden: new Set([six.tabs[5]]),
  });
  Assert.equal(
    hidden[1].id,
    six.tabs[4],
    "a run left with one shown pane is that tab's own row"
  );
  Assert.equal(hidden[1].inSplit, split, "which moves with its split");
});

add_task(async function an_alt_click_splits_two_tabs_or_joins_a_split() {
  const { engine, tabs, workspace } = await workspaceWith(6);
  const mint = () => crypto.randomUUID();
  let nodes = (await engine.tree()).nodes;
  Assert.equal(
    SvalPanelModel.altClickSplitOps(nodes, tabs[1], tabs[1], mint),
    null,
    "a tab is not split with itself"
  );
  await engine.mutate({
    kind: "batch",
    ops: SvalPanelModel.altClickSplitOps(nodes, tabs[1], tabs[3], mint),
    now: 2000,
  });
  nodes = (await engine.tree()).nodes;
  const byParent = SvalPanelModel.childrenByParent(nodes);
  const split = nodes[tabs[1]].placement.parent;
  Assert.equal(nodes[split].kind, "split", "the two are a split");
  Assert.deepEqual(
    byParent.get(split),
    [tabs[1], tabs[3]],
    "the viewed tab on the left"
  );
  Assert.deepEqual(
    byParent.get(workspace),
    [tabs[0], split, tabs[2], tabs[4], tabs[5]],
    "at the viewed tab's place"
  );

  for (const clicked of [tabs[4], tabs[5]]) {
    await engine.mutate({
      kind: "batch",
      ops: SvalPanelModel.altClickSplitOps(nodes, tabs[1], clicked, mint),
      now: 3000,
    });
    nodes = (await engine.tree()).nodes;
  }
  Assert.deepEqual(
    SvalPanelModel.childrenByParent(nodes).get(split),
    [tabs[1], tabs[3], tabs[4], tabs[5]],
    "a split with room takes each clicked tab at its end"
  );
  Assert.equal(
    SvalPanelModel.altClickSplitOps(nodes, tabs[1], tabs[3], mint),
    null,
    "a pane is not split again"
  );

  await engine.mutate({
    kind: "batch",
    ops: SvalPanelModel.altClickSplitOps(nodes, tabs[1], tabs[2], mint),
    now: 4000,
  });
  nodes = (await engine.tree()).nodes;
  const full = SvalPanelModel.childrenByParent(nodes);
  const next = nodes[tabs[1]].placement.parent;
  Assert.notEqual(next, split, "a full split's viewed tab leaves it");
  Assert.deepEqual(full.get(next), [tabs[1], tabs[2]], "for a new split");
  Assert.deepEqual(
    full.get(split),
    [tabs[3], tabs[4], tabs[5]],
    "and the full one keeps the rest"
  );
  Assert.deepEqual(
    full.get(workspace),
    [tabs[0], split, next],
    "the new split beside it"
  );
});

add_task(function a_panes_keys_and_menu_are_its_splits() {
  let pane = { id: "p", kind: "tab", split: "s", depth: 1 };
  pane = { ...pane, posinset: 2, setsize: 3 };
  const key = (k, mods = {}) =>
    SvalPanelModel.keyCommand(
      {
        key: k,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        ...mods,
      },
      pane
    );
  Assert.equal(key("ArrowRight"), "focusNextPane");
  Assert.equal(key("ArrowLeft"), "focusPreviousPane");
  Assert.equal(key("ArrowDown"), "focusNext");
  Assert.equal(key("ArrowRight", { altKey: true }), "movePaneRight");
  Assert.equal(key("ArrowLeft", { altKey: true }), "movePaneLeft");
  Assert.equal(key("ArrowUp", { altKey: true }), "moveBefore");
  Assert.equal(key("Delete"), "close");
  pane = { ...pane, posinset: 1, setsize: 2 };
  Assert.equal(key("ArrowLeft", { altKey: true }), null, "not past its run");
  pane = { ...pane, posinset: 2 };
  Assert.equal(key("ArrowRight", { altKey: true }), null, "either way");

  const items = SvalPanelModel.contextMenuItems("tab", { pane: true });
  Assert.deepEqual(
    items.slice(items.indexOf("close")),
    [
      "close",
      "splitSeparator",
      "addTabToSplit",
      "separate",
      "movePaneLeft",
      "movePaneRight",
      "renameSplit",
      "closeSplitSeparator",
      "closeSplit",
    ],
    "a pane's menu is its tab's, then its split's, then Close All"
  );
  Assert.ok(
    !items.includes("createSplit") && !items.includes("addToSplit"),
    "and does not split it again"
  );
  Assert.ok(
    SvalPanelModel.contextMenuItems("tab").includes("createSplit") &&
      SvalPanelModel.contextMenuItems("tab").includes("addToSplit"),
    "a tab's menu offers Create Split and Add to Split"
  );

  Assert.equal(SvalPanelModel.chosenOverName(false, "x"), null);
  Assert.equal(SvalPanelModel.chosenOverName(true, "  "), "");
  Assert.equal(SvalPanelModel.chosenOverName(true, " Work "), "Work");
});

add_task(async function a_tab_joins_a_split_at_its_end() {
  const { engine, tabs, split, workspace } = await workspaceWith(6, {
    split: [0, 1],
    shares: [30, 70],
  });
  let nodes = (await engine.tree()).nodes;
  Assert.equal(
    SvalPanelModel.joinSplitOps(nodes, split, tabs[0]),
    null,
    "a pane does not join its own split"
  );
  Assert.equal(
    SvalPanelModel.joinSplitOps(nodes, split, workspace),
    null,
    "only a tab joins"
  );
  await engine.mutate({
    kind: "batch",
    ops: SvalPanelModel.joinSplitOps(nodes, split, tabs[4]),
    now: 2000,
  });
  nodes = (await engine.tree()).nodes;
  Assert.deepEqual(
    SvalPanelModel.childrenByParent(nodes).get(split),
    [tabs[0], tabs[1], tabs[4]],
    "the tab is the rightmost pane"
  );
  Assert.ok(!nodes[split].content.shares, "and the widths are equal again");

  await engine.mutate({
    kind: "batch",
    ops: SvalPanelModel.joinSplitOps(nodes, split, tabs[5]),
    now: 3000,
  });
  nodes = (await engine.tree()).nodes;
  Assert.ok(!SvalPanelModel.splitHasRoom(nodes, split), "four is full");
  Assert.equal(
    SvalPanelModel.joinSplitOps(nodes, split, tabs[2]),
    null,
    "a full split takes no more"
  );
});

add_task(function add_to_split_lists_the_splits_with_room() {
  const nodes = {
    ws: node({ kind: "workspace", name: "Work", order: "80" }),
    t: node({ kind: "tab", name: "T", parent: "ws", order: "10" }),
    s: node({ kind: "split", name: "", parent: "ws", order: "20" }),
    a: node({ kind: "tab", name: "A", parent: "s", order: "20" }),
    b: node({ kind: "tab", name: "B", parent: "s", order: "40" }),
    g: node({ kind: "group", name: "G", parent: "ws", order: "30" }),
    n: node({ kind: "split", name: "", parent: "g", order: "20" }),
    c: node({ kind: "tab", name: "C", parent: "n", order: "20" }),
    d: node({ kind: "tab", name: "D", parent: "n", order: "40" }),
    f: node({ kind: "split", name: "", parent: "ws", order: "40" }),
    o: node({ kind: "split", name: "", parent: "ws", order: "50" }),
    p: node({ kind: "tab", name: "P", parent: "o", order: "20" }),
    ...Object.fromEntries(
      ["e", "h", "i", "j"].map((id, index) => [
        id,
        node({ kind: "tab", name: id, parent: "f", order: `${index + 2}0` }),
      ])
    ),
  };
  Assert.deepEqual(
    SvalPanelModel.addToSplitChoices(nodes, "t", "ws"),
    ["s", "n"],
    "every split with room, a group's too, in tree order; not a full one, " +
      "nor one holding a single tab, which is drawn as no split"
  );
  Assert.deepEqual(
    SvalPanelModel.addToSplitChoices(nodes, "a", "ws"),
    ["n"],
    "a pane is not offered its own split"
  );
  Assert.deepEqual(
    SvalPanelModel.addToSplitChoices(nodes, "g", "ws"),
    [],
    "and nothing but a tab joins one"
  );
});

add_task(function a_rows_middle_groups_and_its_split_zone_combines() {
  const nodes = {
    ws: node({ kind: "workspace", name: "Work", order: "80" }),
    t: node({ kind: "tab", name: "T", parent: "ws", order: "10" }),
    u: node({ kind: "tab", name: "U", parent: "ws", order: "15" }),
    s: node({ kind: "split", name: "", parent: "ws", order: "20" }),
    a: node({ kind: "tab", name: "A", parent: "s", order: "20" }),
    b: node({ kind: "tab", name: "B", parent: "s", order: "40" }),
    r: node({ kind: "split", name: "", parent: "ws", order: "30" }),
    c: node({ kind: "tab", name: "C", parent: "r", order: "20" }),
    d: node({ kind: "tab", name: "D", parent: "r", order: "40" }),
    f: node({ kind: "split", name: "", parent: "ws", order: "40" }),
    ...Object.fromEntries(
      ["e", "h", "i", "j"].map((id, index) => [
        id,
        node({ kind: "tab", name: id, parent: "f", order: `${index + 2}0` }),
      ])
    ),
    g: node({ kind: "group", name: "G", parent: "ws", order: "50" }),
  };
  const split = id => ({ id, kind: "split", split: id });
  const tab = { id: "u", kind: "tab" };
  const group = { id: "g", kind: "group", expanded: false };
  const middle = { x: 100, y: 14, w: 224, h: 28 };
  const zone = { ...middle, x: 200 };
  const kind = (id, over, at) => SvalPanelModel.dropIntent(nodes, id, over, at);

  Assert.equal(kind("t", split("s"), middle).kind, "newGroup");
  Assert.equal(kind("t", split("s"), zone).kind, "join", "a tab joins");
  Assert.equal(kind("r", split("s"), zone).kind, "merge", "a split merges");
  Assert.equal(kind("r", tab, zone).kind, "split", "a split on a tab splits");
  Assert.equal(kind("c", split("s"), zone).kind, "join", "a page joins");
  Assert.deepEqual(
    kind("t", split("f"), zone),
    { kind: "refused", full: true },
    "a full split refuses its split zone"
  );
  Assert.equal(
    kind("t", split("f"), middle).kind,
    "newGroup",
    "and still makes a group in its middle"
  );
  Assert.deepEqual(
    kind("r", split("f"), zone),
    { kind: "refused", full: true },
    "as for any drop that would pass four pages"
  );
  Assert.deepEqual(
    kind("a", split("s"), { ...middle, slot: 2 }),
    { kind: "reorder", slot: 2 },
    "a page in its own split's middle reorders to the gap"
  );
  Assert.equal(
    kind("a", split("s"), { ...middle, slot: 1 }).kind,
    "noop",
    "and the gaps either side of it are where it is"
  );
  Assert.equal(kind("g", split("s"), zone).kind, "after", "a group by halves");
  Assert.equal(kind("s", split("s"), middle).kind, "noop", "a split on itself");
  Assert.equal(kind("t", group, middle).kind, "into");

  const mint = () => "n";
  Assert.deepEqual(
    SvalPanelModel.splitTogetherOps(nodes, "u", "t", mint),
    [
      { kind: "addSplit", id: "n", parent: "ws", before: null, after: "u" },
      { kind: "moveNode", id: "u", newParent: "n", before: null, after: null },
      { kind: "moveNode", id: "t", newParent: "n", before: "u", after: null },
    ],
    "two tabs split together where the target was, the target on the left"
  );
  Assert.deepEqual(
    SvalPanelModel.splitTogetherOps(nodes, "u", "r", mint).slice(-3),
    [
      { kind: "moveNode", id: "c", newParent: "n", before: "u", after: null },
      { kind: "moveNode", id: "d", newParent: "n", before: "c", after: null },
      { kind: "remove", id: "r" },
    ],
    "a dropped split brings its pages in order, and goes"
  );
  Assert.deepEqual(
    SvalPanelModel.splitTogetherOps(nodes, "u", "a", mint).at(-1),
    { kind: "removeKeepingChildren", id: "s" },
    "a page leaving a split of two leaves an ordinary tab"
  );
  Assert.equal(
    SvalPanelModel.splitTogetherOps(nodes, "u", "f", mint),
    null,
    "five pages are not a split"
  );
  Assert.deepEqual(
    SvalPanelModel.mergeSplitsOps(nodes, "s", "r"),
    [
      { kind: "moveNode", id: "c", newParent: "s", before: "b", after: null },
      { kind: "moveNode", id: "d", newParent: "s", before: "c", after: null },
      { kind: "remove", id: "r" },
    ],
    "a merge appends the dropped split's pages and removes it"
  );
  Assert.equal(SvalPanelModel.mergeSplitsOps(nodes, "f", "r"), null);
  Assert.deepEqual(
    SvalPanelModel.reorderPaneTarget(nodes, "a", 2),
    { id: "a", newParent: "s", before: "b", after: null },
    "a reorder past the last tile is the end"
  );
  Assert.equal(SvalPanelModel.reorderPaneTarget(nodes, "a", 0), null);
  Assert.deepEqual(
    SvalPanelModel.intoLastTarget(nodes, "t", "g"),
    { id: "t", newParent: "g", before: null, after: null },
    "into a collapsed group is in last"
  );
});

add_task(async function the_combining_drops_are_writes_the_engine_takes() {
  const { engine, tabs, split, workspace } = await workspaceWith(5, {
    split: [0, 1],
    shares: [30, 70],
  });
  let nodes = (await engine.tree()).nodes;
  const made = crypto.randomUUID();
  await engine.mutate({
    kind: "batch",
    ops: SvalPanelModel.splitTogetherOps(nodes, tabs[3], tabs[2], () => made),
    now: 2000,
  });
  nodes = (await engine.tree()).nodes;
  Assert.deepEqual(
    SvalPanelModel.childrenByParent(nodes).get(made),
    [tabs[3], tabs[2]],
    "the two tabs are a split"
  );
  await engine.mutate({
    kind: "batch",
    ops: SvalPanelModel.mergeSplitsOps(nodes, split, made),
    now: 3000,
  });
  nodes = (await engine.tree()).nodes;
  Assert.deepEqual(
    SvalPanelModel.childrenByParent(nodes).get(split),
    [tabs[0], tabs[1], tabs[3], tabs[2]],
    "merged, in order"
  );
  Assert.ok(!nodes[made], "the dropped split is gone");
  Assert.ok(!nodes[split].content.shares, "and the widths are equal again");
  Assert.ok(
    SvalPanelModel.childrenByParent(nodes).get(workspace).includes(tabs[4]),
    "with nothing else moved"
  );
});

add_task(async function a_window_ends_and_makes_splits_to_match_the_tree() {
  const { engine, tabs } = await workspaceWith(4, { split: [0, 1] });
  const nodes = (await engine.tree()).nodes ?? {};
  const present = new Set(tabs);
  Assert.deepEqual(
    splitChanges(nodes, present, [[tabs[2], tabs[3]]]),
    { end: [0], make: [[tabs[0], tabs[1]]] },
    "a split the tree does not hold ends and the one it holds is made"
  );
  Assert.deepEqual(
    splitChanges(nodes, present, [[tabs[0], tabs[1]]]),
    { end: [], make: [] },
    "a window showing the tree's split changes nothing"
  );
  Assert.deepEqual(
    splitChanges(nodes, present, [[tabs[1], tabs[0]]]),
    { end: [0], make: [[tabs[0], tabs[1]]] },
    "panes in another order are another split"
  );
  Assert.deepEqual(
    splitChanges(nodes, present, [[tabs[2], null]]),
    { end: [], make: [[tabs[0], tabs[1]]] },
    "a split holding a tab with no node is left as it is"
  );
  Assert.deepEqual(
    splitChanges(nodes, new Set([tabs[0]]), []),
    { end: [], make: [] },
    "a split with one pane in this window shows none here"
  );
});

add_task(
  async function splitting_two_tabs_writes_one_split_where_the_first_was() {
    const { engine, workspace, tabs } = await workspaceWith(3);
    const ops = await write(engine, {
      splits: [[tabs[1], tabs[2]]],
      moved: new Set([tabs[1], tabs[2]]),
    });
    Assert.equal(
      ops.filter(op => op.kind === "addSplit").length,
      1,
      "one split node is made"
    );
    Assert.deepEqual(
      await shape(engine, workspace),
      [tabs[0], [tabs[1], tabs[2]]],
      "holding both tabs in pane order, where the first of them was"
    );
  }
);

add_task(
  async function separating_leaves_the_tabs_in_order_where_the_split_was() {
    const { engine, workspace, tabs } = await workspaceWith(4, {
      split: [1, 2],
    });
    await write(engine, { splits: [], moved: new Set([tabs[1], tabs[2]]) });
    Assert.deepEqual(
      await shape(engine, workspace),
      tabs,
      "no split is left, and the tabs are where it was, in its order"
    );
  }
);

add_task(async function closing_one_pane_of_two_leaves_an_ordinary_tab() {
  const { engine, workspace, tabs } = await workspaceWith(3, {
    split: [0, 1],
  });
  // Firefox separates the pane left alone after the close.
  await write(engine, {
    splits: [],
    present: new Set([tabs[1], tabs[2]]),
    moved: new Set([tabs[1]]),
    closed: new Set([tabs[0]]),
  });
  Assert.deepEqual(
    await shape(engine, workspace),
    [tabs[1], tabs[2]],
    "the closed pane is gone and the other is an ordinary tab in its place"
  );
});

add_task(async function closing_one_pane_of_three_leaves_a_split_of_two() {
  const { engine, workspace, tabs } = await workspaceWith(3, {
    split: [0, 1, 2],
    shares: [20, 30, 50],
  });
  const ops = await write(engine, {
    splits: [[tabs[1], tabs[2]]],
    present: new Set([tabs[1], tabs[2]]),
    closed: new Set([tabs[0]]),
  });
  Assert.deepEqual(
    await shape(engine, workspace),
    [[tabs[1], tabs[2]]],
    "the split holds the other two"
  );
  Assert.ok(
    !ops.some(op => op.kind === "moveNode"),
    "and nothing that stayed is moved"
  );
  const nodes = (await engine.tree()).nodes ?? {};
  const split = nodes[tabs[1]].placement.parent;
  Assert.equal(
    nodes[split].content.shares,
    undefined,
    "with equal widths, as three widths do not fit two panes"
  );
});

add_task(async function picking_a_tab_puts_it_where_the_picker_was() {
  const { engine, workspace, tabs } = await workspaceWith(3, {
    split: [0, 1],
  });
  // `replaceTab`: the picker in tabs[1] closes and tabs[2] takes its pane.
  await write(engine, {
    splits: [[tabs[0], tabs[2]]],
    present: new Set([tabs[0], tabs[2]]),
    moved: new Set([tabs[2]]),
    closed: new Set([tabs[1]]),
  });
  Assert.deepEqual(
    await shape(engine, workspace),
    [[tabs[0], tabs[2]]],
    "the split holds the chosen tab where the picker was, and the picker is gone"
  );
});

add_task(
  async function an_act_on_an_overfull_split_writes_its_runs_as_splits() {
    const { engine, workspace, tabs } = await overfull(6);
    // Reverse on the second run, which a merge left in the same node.
    await write(engine, {
      splits: [
        [tabs[0], tabs[1], tabs[2], tabs[3]],
        [tabs[5], tabs[4]],
      ],
      moved: new Set([tabs[5]]),
    });
    Assert.deepEqual(
      await shape(engine, workspace),
      [
        [tabs[0], tabs[1], tabs[2], tabs[3]],
        [tabs[5], tabs[4]],
      ],
      "each split on screen is a split node of its own, in order"
    );
  }
);

add_task(async function a_window_already_showing_the_tree_writes_nothing() {
  const { engine, workspace, tabs } = await workspaceWith(3, {
    split: [0, 1],
  });
  // A peer closed tabs[0]: the split holds one tab, drawn as that tab, and
  // Firefox separates tabs[1] as Sval closes the other.
  await engine.mutate({ kind: "remove", id: tabs[0], now: 1500 });
  const ops = await write(engine, {
    splits: [],
    present: new Set([tabs[1], tabs[2]]),
    moved: new Set([tabs[1]]),
  });
  Assert.deepEqual(ops, [], "nothing is written");
  Assert.equal(
    (await shape(engine, workspace)).length,
    2,
    "and the split stays until the user next acts on it"
  );
});

add_task(async function letting_go_of_a_divider_writes_the_widths() {
  const { engine, tabs } = await workspaceWith(2, { split: [0, 1] });
  const shares = sharesOf([300, 700]);
  Assert.deepEqual(shares, [30, 70], "widths read as shares of the whole");
  const ops = await write(engine, {
    splits: [[tabs[0], tabs[1]]],
    moved: new Set(tabs),
    shares: { panes: tabs, shares },
  });
  Assert.deepEqual(
    ops.map(op => op.kind),
    ["setContent"],
    "the one write is the split's widths"
  );
  const nodes = (await engine.tree()).nodes ?? {};
  const split = nodes[nodes[tabs[0]].placement.parent];
  Assert.deepEqual(split.content.shares, [30, 70], "the tree holds them");
  Assert.deepEqual(
    widthsOf(split.content.shares, 2, 1500),
    [450],
    "and they give the same split the same share of a wider window"
  );
  Assert.equal(
    widthsOf(split.content.shares, 3, 1500),
    null,
    "a list that does not fit the panes is equal widths"
  );
});

add_task(function a_pane_leaving_its_split_leaves_it_in_shape() {
  const nodes = {
    ws: node({ kind: "workspace", name: "Work", order: "80" }),
    s: node({ kind: "split", name: "", parent: "ws", order: "40" }),
    a: node({ kind: "tab", name: "A", parent: "s", order: "20" }),
    b: node({ kind: "tab", name: "B", parent: "s", order: "40" }),
    c: node({ kind: "tab", name: "C", parent: "s", order: "60" }),
  };
  Assert.deepEqual(
    SvalPanelModel.splitShapeOps(nodes, ["a", "b"]),
    [{ kind: "removeKeepingChildren", id: "s" }],
    "a split left with one tab is removed, keeping it"
  );
  nodes.s.content.shares = [30, 30, 40];
  Assert.deepEqual(
    SvalPanelModel.splitShapeOps(nodes, ["a"]),
    [{ kind: "setContent", id: "s", name: "", url: null, icon: null }],
    "a split left with two gets equal widths"
  );
  Assert.deepEqual(
    SvalPanelModel.splitShapeOps(nodes, ["s"]),
    [],
    "a split going whole needs nothing"
  );
});

add_task(function a_drop_beside_a_pane_goes_beside_its_split() {
  const nodes = {
    ws: node({ kind: "workspace", name: "Work", order: "80" }),
    t: node({ kind: "tab", name: "T", parent: "ws", order: "20" }),
    s: node({ kind: "split", name: "", parent: "ws", order: "40" }),
    a: node({ kind: "tab", name: "A", parent: "s", order: "20" }),
    b: node({ kind: "tab", name: "B", parent: "s", order: "40" }),
    u: node({ kind: "tab", name: "U", parent: "ws", order: "60" }),
  };
  Assert.deepEqual(
    SvalPanelModel.dropTarget(nodes, "t", "b", "after"),
    { id: "t", newParent: "ws", before: "s", after: "u" },
    "a tab dropped after a pane lands after the split, not in it"
  );
  Assert.deepEqual(
    SvalPanelModel.dropTarget(nodes, "b", "a", "before"),
    { id: "b", newParent: "s", before: null, after: "a" },
    "a pane dropped beside another of its split moves within it"
  );
  Assert.equal(
    SvalPanelModel.mergeTarget(nodes, "t", "a"),
    null,
    "and no group is made inside a split"
  );
});

add_task(async function a_pane_the_act_did_not_touch_stays_in_its_split() {
  const { engine, workspace, tabs } = await workspaceWith(3, {
    split: [0, 1, 2],
  });
  // The window shows two of the three, as when another device's pane has no
  // tab here yet, and the user reverses them.
  await write(engine, {
    splits: [[tabs[1], tabs[0]]],
    present: new Set([tabs[0], tabs[1]]),
    moved: new Set([tabs[0]]),
  });
  const [split] = await shape(engine, workspace);
  Assert.ok(split.includes(tabs[2]), "the third pane is still in the split");
  Assert.deepEqual(
    split.filter(id => id !== tabs[2]),
    [tabs[1], tabs[0]],
    "and the two the user reversed are in their new order"
  );
});

add_task(async function splitting_a_pane_out_of_a_full_split_lands() {
  const { engine, workspace, tabs } = await workspaceWith(5, {
    split: [0, 1, 2, 3],
  });
  // Firefox splits tabs[0] with tabs[4], leaving the other three together.
  await write(engine, {
    splits: [
      [tabs[0], tabs[4]],
      [tabs[1], tabs[2], tabs[3]],
    ],
    moved: new Set([tabs[0], tabs[4]]),
  });
  const splits = (await shape(engine, workspace)).filter(Array.isArray);
  Assert.deepEqual(
    splits.map(panes => panes.join(" ")).sort(),
    [tabs.slice(1, 4).join(" "), [tabs[0], tabs[4]].join(" ")].sort(),
    "both splits are in the tree"
  );
});
