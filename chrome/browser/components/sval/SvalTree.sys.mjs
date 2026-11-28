/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Reads of the document's tree that need no window: the kinds of node, who
 * is whose child, which workspace a node is in, and what a node is called
 * and looks like. `nodes` is the document's map of id to node, as the
 * engine's `tree` gives it.
 */

import { isIsolated } from "moz-src:///browser/components/sval/SvalWorkspaceJar.sys.mjs";

/**
 * The name of the one document Sval syncs.
 *
 * The engine's fourth `sync` argument is a *document* name, which
 * `store::workspace_dir` hashes under the user's key into
 * `sval/ws/<hashed>/<device>.json` (spec §6.2). Every device pointed at one
 * folder must pass the same string or each enumerates a directory of its own
 * and they never see each other's files. So this is a constant: a device mints
 * its own workspace ids, so a directory named after one can only be found by
 * the device that made it.
 *
 * One document holds every workspace as a root. Nothing about the value
 * matters beyond being identical everywhere; it is hashed before it reaches a
 * path, so it leaks no name to the storage provider.
 */
export const SYNC_DOCUMENT = "workspaces";

/**
 * The node kinds this build draws. The engine also carries kinds written by a
 * newer build; the panel draws no row for one or for anything beneath it.
 */
export const WORKSPACE = "workspace";
export const GROUP = "group";
export const TAB = "tab";
export const SPLIT = "split";

/**
 * Groups a document's nodes by parent, each sibling list in tree order.
 *
 * `placement.order` is a fractional index serialised as lowercase hex whose
 * **lexicographic** order is its index order (`fractional_index`'s
 * `FractionalIndex::to_string`, via `#[serde(with = "stringify")]` in
 * `src/types.rs`), so a plain string comparison sorts siblings with no
 * parsing. Ties break on node id, so two devices that hold the same order key
 * draw the same list.
 *
 * **Every tree a host reads is a tree**: every parent a node names is in
 * `nodes`, and no walk over it meets a cycle, so the walks in this file and
 * in `SvalTabs` carry no guards of their own. The engine keeps that true on
 * every path into its document. `sync` repairs what it merged before it
 * returns (`sync::sync`, `tree::repair_unreachable_ancestry_knowing`). Each
 * mutation refuses a parent that is absent, a tab or below the node
 * (`require_node`, `tree::validate_move`), and `remove` takes the whole
 * subtree (`Document::remove`). `loadTree` is handed only what `tree`
 * produced.
 *
 * @param {object} nodes The document's `nodes` map, id to node.
 * @returns {Map<string|null, string[]>} parent id (null for roots) to its
 *   children's ids, in order.
 */
export function childrenByParent(nodes) {
  const byParent = new Map();
  for (const [id, node] of Object.entries(nodes)) {
    const parent = node.placement?.parent ?? null;
    if (!byParent.has(parent)) {
      byParent.set(parent, []);
    }
    byParent.get(parent).push(id);
  }
  for (const ids of byParent.values()) {
    ids.sort((a, b) => {
      const orderA = nodes[a].placement?.order ?? "";
      const orderB = nodes[b].placement?.order ?? "";
      if (orderA !== orderB) {
        return orderA < orderB ? -1 : 1;
      }
      return a < b ? -1 : 1;
    });
  }
  return byParent;
}

/**
 * Every root workspace, in sibling order.
 *
 * Sibling order is the shared fractional index, so this is the same list in
 * the same order on every device, and "the first one" is a fallback two
 * devices agree on.
 *
 * @param {object} nodes The document's `nodes` map.
 * @returns {string[]} workspace ids, in order.
 */
export function workspaceIds(nodes) {
  const roots = childrenByParent(nodes).get(null) ?? [];
  return roots.filter(id => nodes[id]?.kind === WORKSPACE);
}

/** The robot, with or without the variation selector that asks for emoji. */
const RESERVED_EMOJI = /^\u{1F916}\u{FE0F}?$/u;

/**
 * An emoji as a place of the user's may show it: the robot, which only an
 * agent's workspace wears, is no emoji. The picker never offers it, but a
 * document can still hold one, written by an older build or by hand.
 *
 * @param {unknown} emoji
 * @returns {string|null}
 */
export function unreserved(emoji) {
  if (typeof emoji !== "string" || RESERVED_EMOJI.test(emoji)) {
    return null;
  }
  return emoji;
}

/**
 * What a node is called wherever Sval shows it. A tab's label, the name a
 * user gave it, stands in for its page's title, which `content.name` keeps
 * following as the tab navigates (spec §5.1). Every other kind has no label.
 *
 * @param {object|undefined} node A node of the document.
 * @returns {string}
 */
export function displayName(node) {
  return node?.appearance?.label ?? node?.content?.name ?? "";
}

/**
 * Whether `id` is `ancestor` or sits somewhere beneath it.
 *
 * What keeps a window's acts inside the workspace it is showing: a selection
 * made in one workspace is still device-local state when the window switches
 * to another, and filing a new tab into it would put the tab somewhere the
 * user cannot see.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string|null} id A node id.
 * @param {string|null} ancestor A node id.
 * @returns {boolean}
 */
export function isWithin(nodes, id, ancestor) {
  if (!id || !ancestor) {
    return false;
  }
  for (let walk = id; walk; walk = nodes[walk]?.placement?.parent ?? null) {
    if (walk === ancestor) {
      return true;
    }
  }
  return false;
}

/**
 * Every container above `id`, nearest first, up to and including its
 * workspace. A row is drawn only when each of these is expanded, so this is
 * the list the panel opens to keep a node on screen.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string|null} id A node id.
 * @returns {string[]}
 */
export function ancestorIds(nodes, id) {
  const out = [];
  let walk = id ? (nodes[id]?.placement?.parent ?? null) : null;
  while (walk) {
    out.push(walk);
    walk = nodes[walk].placement?.parent ?? null;
  }
  return out;
}

/**
 * @param {object} nodes The document's `nodes` map.
 * @param {string|null} id A node id.
 * @returns {string|null} the workspace above `id`, or null when the document
 *   holds none above it.
 */
export function workspaceOfNode(nodes, id) {
  return ancestorIds(nodes, id).find(a => nodes[a]?.kind === WORKSPACE) ?? null;
}

/**
 * A node's appearance group **exactly as the document holds it**.
 *
 * Unfiltered on purpose, and this is the read every write starts from. The
 * appearance group is the unit: `setAppearance` replaces it entire, as
 * `setContent` does (spec §5.1, §5.3). So setting an emoji has to send the
 * colour back alongside it, and sending back the *filtered* colour would make
 * "add an emoji" quietly delete a colour chosen on a device whose palette is
 * larger than this build's. Rendering filters (`SvalColor.colorOf`); writing
 * does not.
 *
 * The one exception is the robot, which reads as no emoji here too
 * ({@link unreserved}): it marks an agent's workspace, so a write that drops
 * it, as setting a colour then does, takes nothing from the user.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string} id A node id.
 * @returns {{color: string|object|null, emoji: string|null,
 *   transparency: number|null}}
 */
export function appearanceOf(nodes, id) {
  const appearance = nodes[id]?.appearance ?? {};
  return {
    color: appearance.color ?? null,
    emoji: unreserved(appearance.emoji),
    transparency: appearance.transparency ?? null,
  };
}

/**
 * Every live descendant of `id`, at any depth.
 *
 * What the panel counts when it asks about a container's contents, and the
 * tabs it closes in this window before the engine's `remove` deletes the
 * container with everything in it.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string} id A node id.
 * @param {Map<string|null, string[]>} [byParent] `childrenByParent(nodes)`,
 *   for a caller asking about many nodes of one document.
 * @returns {string[]} descendant ids, depth first in sibling order: the
 *   order the panel draws them in.
 */
export function descendantIds(nodes, id, byParent = childrenByParent(nodes)) {
  const out = [];
  const walk = parent => {
    for (const child of byParent.get(parent) ?? []) {
      out.push(child);
      walk(child);
    }
  };
  walk(id);
  return out;
}

/**
 * Whether a tab on `url` is on one of the browser's own pages, the rule
 * `SvalTabs`' `opensBrowserPage` applies: an `about:` address, which takes in
 * the home page, the blank tab and Settings. A tab with no address yet has
 * gone nowhere either.
 *
 * @param {?string} url A tab's address.
 * @returns {boolean}
 */
export function onBrowserPage(url) {
  return !url || url.startsWith("about:");
}

/**
 * Whether nobody has touched workspace `id`: it has no name, colour or emoji
 * of the user's (`appearanceOf`), is not isolated (`isIsolated`), and holds
 * no group and no tab off the browser's own pages (`onBrowserPage`).
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {string} id A node id.
 * @param {Map<string|null, string[]>} [byParent] `childrenByParent(nodes)`,
 *   for a caller asking about many workspaces of one document.
 * @returns {boolean} false for anything that is not a workspace.
 */
export function isUntouchedWorkspace(
  nodes,
  id,
  byParent = childrenByParent(nodes)
) {
  const node = nodes[id];
  if (node?.kind !== WORKSPACE || (node.content?.name ?? "") !== "") {
    return false;
  }
  const { color, emoji } = appearanceOf(nodes, id);
  if (color || emoji || isIsolated(nodes, id)) {
    return false;
  }
  return (byParent.get(id) ?? []).every(
    child =>
      nodes[child].kind === TAB &&
      !byParent.has(child) &&
      onBrowserPage(nodes[child].content?.url)
  );
}

/**
 * `json`, a document as `treeJson` gives it, without the workspaces nobody
 * has touched (`isUntouchedWorkspace`).
 *
 * A device that joins has usually made its unnamed first workspace already,
 * and publishing it would put an empty workspace into the user's real ones.
 * Anything the user touched is kept and merges like every other workspace.
 *
 * @param {string} json A whole document.
 * @returns {{json: string, dropped: string[]}} the document to carry, and the
 *   ids left out of it.
 */
export function withoutUntouchedWorkspaces(json) {
  const doc = JSON.parse(json);
  const nodes = doc.nodes ?? {};
  const byParent = childrenByParent(nodes);
  const dropped = [];
  for (const id of Object.keys(nodes)) {
    if (isUntouchedWorkspace(nodes, id, byParent)) {
      dropped.push(id, ...(byParent.get(id) ?? []));
    }
  }
  if (!dropped.length) {
    return { json, dropped };
  }
  for (const id of dropped) {
    delete nodes[id];
  }
  return { json: JSON.stringify(doc), dropped };
}
