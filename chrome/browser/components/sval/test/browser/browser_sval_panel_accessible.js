/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_panel_helpers.js */

/**
 * The panel as a screen reader and a keyboard meet it: what the
 * accessibility tree says of each row, where focus goes when the focused row
 * leaves and when the tree is entered, what Space does, and whether a
 * group's name can be read on its colour.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_panel_helpers.js",
  this
);

const accService = Cc["@mozilla.org/accessibilityService;1"].getService(
  Ci.nsIAccessibilityService
);

/**
 * A row's name and description as the accessibility tree gives them.
 *
 * @param {string} id A node id.
 * @returns {Promise<{name: string, description: string}>}
 */
async function spoken(id) {
  const acc = await accessibleOf(SvalPanel._rowElementFor(id));
  return { name: acc.name, description: acc.description };
}

/**
 * The tree is named for the workspace it shows, and every row says what the
 * eye reads from its look: a group is a group, its colour, how many tabs a
 * collapsed one holds, and a tab not loaded here is not.
 */
add_task(async function each_row_says_what_it_shows() {
  const { tree, engine, settings, ids } = await withFreshPanel();

  const treeAcc = await accessibleOf(tree);
  Assert.equal(treeAcc.role, Ci.nsIAccessibleRole.ROLE_OUTLINE, "a tree");
  Assert.equal(treeAcc.name, "Tabs in Work", "named for its workspace");

  await engine.mutate({
    kind: "setAppearance",
    id: ids.groupA,
    color: "blue",
    emoji: null,
    now: Date.now(),
  });
  settings.setCollapsed(ids.groupB, true);
  await SvalPanel.refresh();

  Assert.deepEqual(
    await spoken(ids.groupA),
    { name: "Reading", description: "group, blue" },
    "a coloured group says it is a group, and its colour"
  );
  Assert.deepEqual(
    await spoken(ids.groupB),
    { name: "Shipping", description: "group, 1 tab" },
    "a collapsed group says how many tabs it holds, and its name does not " +
      "end in a bare number"
  );
  // The switch loads the one tab it selects and leaves the rest unloaded.
  await viewTab(ids.tab1);
  Assert.deepEqual(
    await spoken(ids.tab2),
    { name: "Two", description: "not loaded" },
    "a tab with no page in this window says it is not loaded"
  );
  settings.setCollapsed(ids.groupB, false);
});

/**
 * A collapsed group above the selected tab still draws that tab, and says
 * so: "collapsed" alone, followed by a child row, would not add up.
 */
add_task(async function a_collapsed_group_says_it_shows_the_selection() {
  const { ids } = await withFreshPanel();
  await viewTab(ids.tab2);
  await SvalPanel._setCollapsed(ids.groupA, true);

  const acc = await accessibleOf(SvalPanel._rowElementFor(ids.groupA));
  const state = {};
  acc.getState(state, {});
  Assert.ok(
    !(state.value & Ci.nsIAccessibleStates.STATE_EXPANDED),
    "the group is collapsed"
  );
  Assert.equal(
    acc.description,
    "group, 3 tabs, showing only the selected tab",
    "and says the one tab under it is only the selection"
  );
});

/**
 * Space on a tab row shows its page, as Enter does, so the row the tree
 * calls selected is the tab on screen.
 */
add_task(async function space_shows_the_tab() {
  const { ids } = await withFreshPanel();
  await viewTab(ids.loose);
  await within(SimpleTest.promiseFocus(window), 10_000, "window focus");
  SvalPanel._focusRow(ids.tab2);
  EventUtils.synthesizeKey(" ");
  await TestUtils.waitForCondition(
    () => gBrowser.selectedTab === SvalPanel.observer.tabFor(ids.tab2),
    "Space showed the focused tab"
  );
  await switchDone();
});

/**
 * A focused row that leaves any way but the Delete key, here a peer's
 * delete, hands focus to the row in its place, not the top of the tree.
 */
add_task(async function focus_stays_in_place_when_its_row_leaves() {
  const { engine, ids } = await withFreshPanel();
  await within(SimpleTest.promiseFocus(window), 10_000, "window focus");
  SvalPanel._focusRow(ids.tab2);

  await engine.mutate({ kind: "remove", id: ids.tab2, now: Date.now() });
  await SvalPanel.refresh();

  Assert.equal(
    document.activeElement.dataset.nodeId,
    ids.tab3,
    "focus is on the row that took the closed row's place"
  );
});

/**
 * Tab into the tree lands on the tab being viewed, wherever focus was last
 * in the tree (the ARIA tree pattern).
 */
add_task(async function the_tree_is_entered_on_the_selected_tab() {
  const { settings, ids } = await withFreshPanel();
  await within(SimpleTest.promiseFocus(window), 10_000, "window focus");
  SvalPanel._focusRow(ids.tab1);

  const before = SvalPanel._els.header.querySelector(
    '[data-command="addGroup"]'
  );
  before.focus();
  settings.setSelection(SvalPanel.workspaceId, ids.tab3);
  await SvalPanel.refresh();

  EventUtils.synthesizeKey("KEY_Tab");
  Assert.equal(
    document.activeElement.dataset.nodeId,
    ids.tab3,
    "Tab into the tree lands on the selected tab"
  );
  settings.setSelection(SvalPanel.workspaceId, null);
});

/**
 * @param {string} css A computed colour.
 * @returns {{r: number, g: number, b: number, a: number}}
 */
function rgba(css) {
  return InspectorUtils.colorToRGBA(css);
}

/**
 * @param {{r: number, g: number, b: number}} c
 * @returns {number} its relative luminance (WCAG 2).
 */
function luminance({ r, g, b }) {
  const lin = v => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * A coloured group's name reads at 4.5:1 or better on its own block, in
 * every colour, in an untinted window and in every workspace tint.
 */
add_task(async function a_group_name_reads_on_its_colour() {
  const { engine, ids } = await withFreshPanel();
  const { PRESETS: COLOR_TOKENS } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalColor.sys.mjs"
  );
  const setColor = (id, color) =>
    engine.mutate({
      kind: "setAppearance",
      id,
      color,
      emoji: null,
      now: Date.now(),
    });

  const failing = [];
  for (const tint of [null, ...COLOR_TOKENS]) {
    await setColor(ids.workspace, tint);
    for (const color of COLOR_TOKENS) {
      await setColor(ids.groupA, color);
      await SvalPanel.refresh();
      const name = SvalPanel._rowElementFor(ids.groupA).querySelector(
        ".sval-row-name"
      );
      const behind = drawnBehind(name);
      const ink = paintedOver(rgba(getComputedStyle(name).color), behind);
      const [hi, lo] = [luminance(ink), luminance(behind)].sort(
        (a, b) => b - a
      );
      const ratio = (hi + 0.05) / (lo + 0.05);
      if (ratio < 4.5) {
        failing.push(`${color} in ${tint ?? "no tint"}: ${ratio.toFixed(2)}`);
      }
    }
  }
  await setColor(ids.workspace, null);
  Assert.deepEqual(failing, [], "every group name reads at 4.5:1");
});
