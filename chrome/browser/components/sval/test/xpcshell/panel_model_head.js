/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* exported SvalPanelModel, SvalTree, node, nestedDocument, allExpanded */

const SvalPanelModel = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);
const SvalTree = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTree.sys.mjs"
);

/**
 * Shared by the test_sval_panel_*.js files, which drive the panel's decisions
 * without a chrome window: which rows a document produces, what their ARIA
 * numbers are, what a keystroke means, and how a sync report reads. They
 * cannot prove that the attributes reach the DOM or that focus moves;
 * `test/browser/browser_sval_panel.js` covers that.
 */

/**
 * Builds a node the way the engine serialises one (`sval-core`'s
 * `src/types.rs`): nested fact groups, `placement.order` a lowercase-hex
 * fractional index whose lexicographic order is its sort order.
 *
 * @param {object} fields
 * @param {string} fields.kind One of workspace, group, tab.
 * @param {string} fields.name The node's name.
 * @param {string} [fields.parent] The parent's id, omitted for a workspace.
 * @param {string} fields.order The fractional index, as hex.
 * @param {string} [fields.url] A tab's URL.
 * @returns {object}
 */
function node({ kind, name, parent = null, order, url = null }) {
  return {
    kind,
    content: { name, ...(url ? { url } : {}) },
    content_at: 1,
    placement: { ...(parent ? { parent } : {}), order },
    placement_at: 1,
    lifecycle: {},
    lifecycle_at: 1,
  };
}

/**
 * A workspace holding two groups; the first group holds three tabs and the
 * second holds one. Nesting is what the panel exists to show, so nothing
 * shallower would exercise `aria-level` or the descent rule.
 *
 * @returns {object} a `nodes` map.
 */
function nestedDocument() {
  return {
    ws: node({ kind: "workspace", name: "Work", order: "80" }),
    "g-a": node({ kind: "group", name: "Reading", parent: "ws", order: "40" }),
    "g-b": node({ kind: "group", name: "Shipping", parent: "ws", order: "c0" }),
    "t-1": node({
      kind: "tab",
      name: "One",
      parent: "g-a",
      order: "20",
      url: "https://example.com/1",
    }),
    "t-2": node({
      kind: "tab",
      name: "Two",
      parent: "g-a",
      order: "60",
      url: "https://example.com/2",
    }),
    "t-3": node({
      kind: "tab",
      name: "Three",
      parent: "g-a",
      order: "a0",
      url: "https://example.com/3",
    }),
    "t-4": node({
      kind: "tab",
      name: "Four",
      parent: "g-b",
      order: "20",
      url: "https://example.com/4",
    }),
  };
}

/**
 * Everything expanded, which is the opposite of the §5.6 default, and rooted
 * at the one workspace every fixture here builds.
 *
 * `root` is not optional: a window shows one workspace (spec §10.7), so the
 * rows are always some workspace's children and there is no document-wide
 * view to ask for.
 */
const allExpanded = { isCollapsed: () => false, root: "ws" };
