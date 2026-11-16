/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Split view between the tree and a window (split-view spec §6.1): which
 * splits a window shows for the document, and what the document writes when
 * the user changes a split through Firefox's own UI. Pure, so both answers
 * are asserted without a window; `SvalTabs` reads the window and acts on them.
 *
 * A window's splits are given as lists of node ids, one list per Firefox
 * split in strip order, each in pane order. Which panes a split node shows is
 * `SvalPanelModel.splitPanes`'s answer, the one the panel draws from.
 */

import {
  SPLIT,
  TAB,
  childrenByParent,
  splitPanes,
} from "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs";

/**
 * The splits a window holding the tabs `present` shows for the document:
 * each run of a split's panes, as `splitPanes` gives it, narrowed to the
 * panes this window holds, when two or more are left. A pane whose tab is in
 * another window, as a kept tab moves between windows one tab at a time, is
 * no pane here.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {Set<string>} present Node ids of the tabs the window holds.
 * @returns {string[][]} the splits, each in pane order.
 */
export function splitsToShow(nodes, present) {
  const byParent = childrenByParent(nodes);
  const shown = [];
  for (const [id, node] of Object.entries(nodes)) {
    if (node.kind !== SPLIT) {
      continue;
    }
    for (const run of splitPanes(nodes, id, byParent)) {
      const here = run.filter(pane => present.has(pane));
      if (here.length > 1) {
        shown.push(here);
      }
    }
  }
  return shown;
}

/**
 * How a window's splits change to show what the document holds: the window's
 * splits that show nothing the document has, which end, and the document's
 * splits the window does not show, which are made. A split of the window's
 * holding a tab with no node is the tree's to say nothing about, so it stays.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {Set<string>} present Node ids of the tabs the window holds.
 * @param {Array<Array<string|null>>} splits The window's splits, a tab with
 *   no node as null.
 * @returns {{end: number[], make: string[][]}} `end` indexes `splits`.
 */
export function splitChanges(nodes, present, splits) {
  const wanted = new Map(
    splitsToShow(nodes, present).map(panes => [panes.join(" "), panes])
  );
  const end = [];
  splits.forEach((panes, index) => {
    if (panes.includes(null)) {
      return;
    }
    if (!wanted.delete(panes.join(" "))) {
      end.push(index);
    }
  });
  return { end, make: [...wanted.values()] };
}

/**
 * The one batch that brings the document's splits in line with the window's
 * after the user changed one through Firefox's own UI (split-view spec §5.2,
 * §6.1): the link menu's "Open Link in Split View", the address bar's split
 * menu, a pane's footer, the picker, or closing a pane.
 *
 * Only the splits the act reached are written: those holding a tab it moved
 * or closed, and the window's splits holding one of their tabs. Each of the
 * window's splits among them becomes a split node holding exactly its panes,
 * in its order. It keeps the split node its first pane is in, unless an
 * earlier one has it, and a new node otherwise. A tab of those split nodes no
 * split of the window holds becomes an ordinary tab where its split was. A
 * split node no split of the window keeps is removed, keeping its tabs at
 * its place. So a split a merge left over-full, or holding one tab, is back
 * in shape (§5.1).
 *
 * Nothing is written when the window already shows what the document holds
 * for those tabs, as when Firefox separates the other pane of a split Sval
 * closed one pane of.
 *
 * @param {object} nodes The document's `nodes` map.
 * @param {object} window
 * @param {string[][]} window.splits The window's splits, in strip order.
 * @param {Set<string>} window.present Node ids of the tabs the window holds.
 * @param {Set<string>} window.moved Node ids of the tabs the act moved.
 * @param {Set<string>} window.closed Node ids of the tabs the act closed.
 * @param {object} [window.shares] `{ panes, shares }`: the widths the user
 *   gave the split holding exactly `panes`, as {@link sharesOf} measured them.
 * @param {Function} newId Mints the id of a split node the act makes.
 * @returns {object[]} the batch's operations, none when there is nothing to
 *   write.
 */
export function splitWrites(
  nodes,
  { splits, present, moved, closed, shares = null },
  newId
) {
  const byParent = childrenByParent(nodes);
  const splitOf = id => {
    const parent = nodes[id]?.placement?.parent;
    return nodes[parent]?.kind === SPLIT ? parent : null;
  };
  const tabsIn = split =>
    (byParent.get(split) ?? []).filter(child => nodes[child]?.kind === TAB);
  const isTab = id => nodes[id]?.kind === TAB;

  const reached = new Set();
  for (const id of [...moved, ...closed]) {
    const split = splitOf(id);
    if (split) {
      reached.add(split);
    }
  }
  const actsOn = panes =>
    panes.some(id => moved.has(id) || reached.has(splitOf(id)));
  let involved = splits.filter(actsOn);
  for (const panes of involved) {
    for (const id of panes) {
      const split = splitOf(id);
      if (split) {
        reached.add(split);
      }
    }
  }
  involved = splits.filter(actsOn);

  if (!closed.size && !shares) {
    const held = new Set(
      splitsToShow(nodes, present)
        .filter(panes => panes.some(id => reached.has(splitOf(id))))
        .map(panes => panes.join(" "))
    );
    const shown = new Set(involved.map(panes => panes.join(" ")));
    if (held.size === shown.size && [...held].every(key => shown.has(key))) {
      return [];
    }
  }

  const ops = [];
  for (const id of closed) {
    if (nodes[id]) {
      ops.push({ kind: "remove", id });
    }
  }

  // Which split node each of the window's splits becomes.
  // Each split node goes to the window's split holding the most of its
  // panes, so the panes moved are the fewest, and no move puts a fifth tab
  // into a node still holding four.
  const kept = new Map();
  const plans = involved
    .map(window => ({
      panes: window.filter(id => isTab(id) && !closed.has(id)),
    }))
    .filter(plan => plan.panes.length > 1);
  const claims = [];
  plans.forEach((plan, index) => {
    const counts = new Map();
    for (const split of plan.panes.map(splitOf).filter(Boolean)) {
      counts.set(split, (counts.get(split) ?? 0) + 1);
    }
    for (const [split, count] of counts) {
      claims.push({ split, count, index });
    }
  });
  claims.sort((a, b) => b.count - a.count || a.index - b.index);
  for (const { split, index } of claims) {
    if (!kept.has(split) && !plans[index].split) {
      plans[index].split = split;
      kept.set(split, plans[index]);
    }
  }
  for (const plan of plans) {
    plan.made = !plan.split;
    plan.split ??= newId();
  }
  const placed = new Set(plans.flatMap(plan => plan.panes));

  // Where each split node's place is followed: what goes beside it goes
  // between the last thing placed there and its next sibling.
  const cursors = new Map();
  const beside = split => {
    if (!cursors.has(split)) {
      const parent = nodes[split].placement?.parent ?? null;
      const siblings = byParent.get(parent) ?? [];
      const next = siblings[siblings.indexOf(split) + 1] ?? null;
      cursors.set(split, { parent, last: split, next });
    }
    return cursors.get(split);
  };

  // A tab the act took out of a kept split becomes an ordinary tab beside
  // it. A pane the act did not touch, such as one another device added or
  // one whose tab is in another window, stays.
  for (const split of reached) {
    if (!kept.has(split)) {
      continue;
    }
    for (const id of tabsIn(split)) {
      if (placed.has(id) || closed.has(id) || !moved.has(id)) {
        continue;
      }
      const cursor = beside(split);
      ops.push({
        kind: "moveNode",
        id,
        newParent: cursor.parent,
        before: cursor.last,
        after: cursor.next,
      });
      cursor.last = id;
    }
  }

  // New split nodes first: what they take from a kept one leaves room in it.
  for (const plan of [
    ...plans.filter(each => each.made),
    ...plans.filter(each => !each.made),
  ]) {
    const { panes, split } = plan;
    if (plan.made) {
      const from = splitOf(panes[0]);
      if (from) {
        const cursor = beside(from);
        ops.push({
          kind: "addSplit",
          parent: cursor.parent,
          id: split,
          before: cursor.last,
          after: cursor.next,
        });
        cursor.last = split;
      } else {
        const parent = nodes[panes[0]].placement?.parent;
        const siblings = (byParent.get(parent) ?? []).filter(
          id => !closed.has(id)
        );
        ops.push({
          kind: "addSplit",
          parent,
          id: split,
          before: siblings[siblings.indexOf(panes[0]) - 1] ?? null,
          after: panes[0],
        });
      }
    }
    const holds = plan.made ? [] : tabsIn(split).filter(id => !closed.has(id));
    if (holds.join(" ") === panes.join(" ")) {
      continue;
    }
    // Each pane goes after the one before it, the first after whatever else
    // the split holds, which an earlier operation has moved out.
    let last = holds.filter(id => !panes.includes(id)).at(-1) ?? null;
    for (const id of panes) {
      ops.push({
        kind: "moveNode",
        id,
        newParent: split,
        before: last,
        after: null,
      });
      last = id;
    }
  }

  // A split node no split of the window keeps.
  for (const split of reached) {
    if (!kept.has(split)) {
      ops.push({ kind: "removeKeepingChildren", id: split });
    }
  }

  // Widths: the ones the user set, and otherwise equal ones where the list
  // does not fit the panes.
  for (const plan of plans) {
    const content = plan.made ? {} : (nodes[plan.split].content ?? {});
    const given =
      shares && shares.panes.join(" ") === plan.panes.join(" ")
        ? shares.shares
        : null;
    if (
      !given &&
      !(content.shares && content.shares.length !== plan.panes.length)
    ) {
      continue;
    }
    ops.push({
      kind: "setContent",
      id: plan.split,
      name: content.name ?? "",
      url: content.url ?? null,
      icon: content.icon ?? null,
      ...(given ? { shares: given } : {}),
    });
  }
  return ops;
}

/**
 * The split's widths as the document stores them: one percentage per pane,
 * in pane order, summing to 100 (split-view spec §5.1). Rounded to a
 * hundredth, the last taking what rounding left over.
 *
 * @param {number[]} widths Each pane's width on screen, in pane order.
 * @returns {number[]|null} null when a pane has no width to measure.
 */
export function sharesOf(widths) {
  const total = widths.reduce((sum, width) => sum + width, 0);
  if (widths.length < 2 || widths.some(width => !(width > 0))) {
    return null;
  }
  const shares = widths
    .slice(0, -1)
    .map(width => Math.round((width / total) * 10000) / 100);
  const rest =
    Math.round((100 - shares.reduce((a, b) => a + b, 0)) * 100) / 100;
  // A pane too narrow to show at a hundredth rounds to 0, which the engine
  // refuses.
  return rest > 0 && shares.every(share => share > 0)
    ? [...shares, rest]
    : null;
}

/**
 * Each pane's width on screen for `shares`, out of `total`, the panes' widths
 * together. The last pane takes what is left, as Firefox's last panel fills
 * the space after the others.
 *
 * @param {number[]|null} shares A split's `content.shares`.
 * @param {number} panes How many panes it shows.
 * @param {number} total The panes' widths together.
 * @returns {number[]|null} the widths of every pane but the last, or null for
 *   equal widths: no list, or one that does not fit the panes.
 */
export function widthsOf(shares, panes, total) {
  if (!Array.isArray(shares) || shares.length !== panes || !(total > 0)) {
    return null;
  }
  return shares.slice(0, -1).map(share => Math.round((share / 100) * total));
}
