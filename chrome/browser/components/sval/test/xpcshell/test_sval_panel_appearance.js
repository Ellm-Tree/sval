/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from panel_model_head.js */

const { SvalColor } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalColor.sys.mjs"
);

/**
 * Every preset is named to a person and drawable, as a Workspace's colour
 * and as a group's.
 */
add_task(function every_preset_is_named_and_drawable() {
  const { PRESETS, PRESET_LABELS, colorOf } = SvalColor;

  Assert.deepEqual(
    Object.keys(PRESET_LABELS).sort(),
    [...PRESETS].sort(),
    "each preset is named to a person: spec §10.5 forbids a swatch with no label"
  );
  for (const token of PRESETS) {
    Assert.equal(colorOf(token, "workspace"), token, `${token} is drawable`);
    Assert.equal(colorOf(token, "group"), token, `${token} is drawable`);
  }
});

/**
 * A custom colour is drawable in its own kind's shape, and a group reads a
 * Workspace's shape as its hue and chroma.
 */
add_task(function a_custom_colour_is_drawable_in_its_shape() {
  const { colorOf } = SvalColor;
  const custom = { h: 40, c: 0.18, l: 0.6, mode: "light" };
  Assert.deepEqual(colorOf(custom, "workspace"), custom);
  Assert.deepEqual(colorOf(custom, "group"), { h: 40, c: 0.18 });
  Assert.strictEqual(
    colorOf({ h: 40, c: 0.18 }, "workspace"),
    null,
    "a Workspace needs its lightness and the appearance it was picked in"
  );
});

/**
 * A colour this build cannot draw is ignored.
 *
 * A device on a later build writes a shape this one has never heard of.
 * Drawing it would paint the row with values that resolve to nothing; the
 * row must have no accent.
 */
add_task(function an_unknown_colour_reads_as_no_colour() {
  const { rows, switcherItems } = SvalPanelModel;

  for (const value of [
    "teal",
    "",
    "#ff0000",
    "BLUE",
    null,
    undefined,
    7,
    {},
    { h: 360, c: 0.1 },
    { h: 40, c: 0.5 },
    { h: 40, c: 0.1, l: 2, mode: "dark" },
    { h: 40, c: 0.1, l: 0.5, mode: "dusk" },
  ]) {
    Assert.strictEqual(
      SvalColor.colorOf(value, "workspace"),
      null,
      `${JSON.stringify(value)} is not a colour this build can draw`
    );
  }

  const nodes = {
    ws: node({ kind: "workspace", name: "Work", order: "80" }),
    g: node({ kind: "group", name: "Reading", parent: "ws", order: "80" }),
  };
  nodes.ws.appearance = { color: "teal", emoji: "🛠" };
  nodes.g.appearance = { color: "chartreuse" };

  Assert.strictEqual(
    switcherItems(nodes, "ws")[0].color,
    null,
    "the switcher offers no colour for a token it cannot draw"
  );
  Assert.strictEqual(
    switcherItems(nodes, "ws")[0].emoji,
    "🛠",
    "and the emoji beside it is untouched: one unknown field is not the other"
  );
  const drawn = rows(nodes, { isCollapsed: () => false, root: "ws" });
  Assert.strictEqual(
    drawn[0].color,
    null,
    "and the row draws with no accent rather than a broken one"
  );
  Assert.equal(drawn[0].name, "Reading", "while the row itself is intact");
});

/**
 * A tab inside a coloured group is drawn in a derivative of the group's colour,
 * so the row carries the nearest coloured ancestor's token as `tint` while its
 * own `color` stays what the document holds.
 */
add_task(function a_row_inherits_its_groups_tint() {
  const { rows } = SvalPanelModel;
  const nodes = {
    ws: node({ kind: "workspace", name: "Work", order: "80" }),
    g: node({ kind: "group", name: "Reading", parent: "ws", order: "40" }),
    inner: node({ kind: "group", name: "Inner", parent: "g", order: "40" }),
    t1: node({
      kind: "tab",
      name: "A",
      parent: "g",
      order: "80",
      url: "https://a.example/",
    }),
    t2: node({
      kind: "tab",
      name: "B",
      parent: "inner",
      order: "40",
      url: "https://b.example/",
    }),
    plain: node({
      kind: "tab",
      name: "C",
      parent: "ws",
      order: "c0",
      url: "https://c.example/",
    }),
  };
  nodes.g.appearance = { color: "green" };
  nodes.inner.appearance = { color: "red" };

  const byId = Object.fromEntries(
    rows(nodes, { isCollapsed: () => false, root: "ws" }).map(r => [r.id, r])
  );
  Assert.equal(
    byId.g.tint,
    "green",
    "a coloured group tints with its own colour"
  );
  Assert.equal(byId.t1.tint, "green", "its tab inherits it");
  Assert.strictEqual(
    byId.t1.color,
    null,
    "while the tab's own colour is untouched"
  );
  Assert.equal(byId.inner.tint, "red", "a nested group's own colour wins");
  Assert.equal(byId.t2.tint, "red", "and its tabs follow the nearer group");
  Assert.strictEqual(
    byId.plain.tint,
    null,
    "a tab outside any coloured group has no tint"
  );
});

/**
 * What a write starts from is the document's own value, unfiltered.
 *
 * The appearance group is replaced entire, so setting an emoji sends the colour
 * back beside it. Sending back the *filtered* colour would make adding an emoji
 * delete a colour a later build chose: silent data loss across devices
 * (engine/CLAUDE.md, "Preserve unknown fields").
 */
add_task(function the_write_path_reads_the_colour_unfiltered() {
  const { appearanceOf } = SvalPanelModel;
  const nodes = {
    ws: node({ kind: "workspace", name: "Work", order: "80" }),
    bare: node({ kind: "group", name: "Bare", parent: "ws", order: "80" }),
  };
  nodes.ws.appearance = { color: "teal", emoji: "🇯🇵" };

  Assert.deepEqual(
    appearanceOf(nodes, "ws"),
    { color: "teal", emoji: "🇯🇵", transparency: null },
    "the value the document holds, so re-sending it loses nothing"
  );
  Assert.deepEqual(
    appearanceOf(nodes, "bare"),
    { color: null, emoji: null, transparency: null },
    "a node written before this group existed has no appearance, not a throw"
  );
  Assert.deepEqual(
    appearanceOf(nodes, "nobody"),
    { color: null, emoji: null, transparency: null },
    "and neither does an id the document does not hold"
  );
});

/**
 * `nestedDocument` with the first group green and an inner red group holding
 * one tab, appended to it.
 */
function nestedColourDocument() {
  const nodes = nestedDocument();
  nodes["g-a"].appearance = { color: "green" };
  nodes["g-in"] = node({
    kind: "group",
    name: "Inner",
    parent: "g-a",
    order: "c0",
  });
  nodes["g-in"].appearance = { color: "red" };
  nodes["t-in"] = node({
    kind: "tab",
    name: "Deep",
    parent: "g-in",
    order: "20",
    url: "https://example.com/deep",
  });
  return nodes;
}

add_task(function a_row_lists_the_coloured_groups_it_sits_in() {
  const byId = Object.fromEntries(
    SvalPanelModel.rows(nestedColourDocument(), allExpanded).map(row => [
      row.id,
      row.chain,
    ])
  );
  Assert.deepEqual(
    byId["g-a"],
    [{ id: "g-a", color: "green", depth: 0 }],
    "a coloured group's chain starts with itself"
  );
  Assert.deepEqual(
    byId["t-1"].map(entry => entry.id),
    ["g-a"],
    "a tab in it sits in that one block"
  );
  Assert.deepEqual(
    byId["t-in"].map(entry => [entry.id, entry.color]),
    [
      ["g-a", "green"],
      ["g-in", "red"],
    ],
    "and a tab in the inner group sits in both, outermost first"
  );
  Assert.deepEqual(byId["g-b"], [], "an uncoloured group is in no block");
});

add_task(function a_block_ends_at_the_last_row_it_holds() {
  const ends = SvalPanelModel.blockEnds(
    SvalPanelModel.rows(nestedColourDocument(), allExpanded)
  );
  Assert.deepEqual(
    [...ends.get("t-in")].sort(),
    ["g-a", "g-in"],
    "the inner block and the outer one both end at the last tab"
  );
  Assert.ok(
    !ends.has("g-in"),
    "a header with its tabs showing does not end its block"
  );
  Assert.ok(!ends.has("t-1"), "and neither does a tab in the middle");

  const collapsed = SvalPanelModel.blockEnds(
    SvalPanelModel.rows(nestedColourDocument(), {
      isCollapsed: id => id === "g-in",
      root: "ws",
    })
  );
  Assert.deepEqual(
    [...collapsed.get("g-in")],
    ["g-a", "g-in"],
    "a collapsed inner group ends its own block at its header, and the outer one with it"
  );

  Assert.equal(
    SvalPanelModel.blockEnds(SvalPanelModel.rows(nestedDocument(), allExpanded))
      .size,
    0,
    "an uncoloured tree has no blocks"
  );
});

add_task(function adjacent_coloured_blocks_each_end() {
  const nodes = nestedDocument();
  nodes["g-a"].appearance = { color: "green" };
  nodes["g-b"].appearance = { color: "blue" };

  const ends = SvalPanelModel.blockEnds(
    SvalPanelModel.rows(nodes, allExpanded)
  );
  Assert.deepEqual(
    [...ends.get("t-3")],
    ["g-a"],
    "the first block ends before the second begins"
  );
  Assert.deepEqual([...ends.get("t-4")], ["g-b"], "and the second ends last");
});
