/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * Accessibility's work for a subtree of a shadow tree that is framed again
 * grows with the subtree plus the host's children, never with their product.
 *
 * Chrome's XUL popups and panels are shadow hosts whose children have no
 * frame while closed, and the window keeps every one it has built. Gecko's
 * `DocAccessible::PruneOrInsertSubtree` prunes a host's unslotted children,
 * and pruning them again for each node it walks inside the host's shadow
 * tree costs a window that has built many popups seconds over each update of
 * its chrome. The counts are Gecko's own PerfStats metrics, which count
 * calls rather than time them.
 */

const CHILDREN = 2000;
const ITEMS = 200;

const METRICS = ["A11Y_ContentRemovedNode", "A11Y_PruneOrInsertSubtree"];

/** Each of `METRICS`' calls since collection started, by name. */
async function calls() {
  const { processes } = JSON.parse(await ChromeUtils.collectPerfStats());
  const parent = processes.find(each => each.type == "parent");
  return Object.fromEntries(
    parent.perfstats.metrics.map(({ metric, count }) => [metric, count])
  );
}

const html = tag =>
  document.createElementNS("http://www.w3.org/1999/xhtml", tag);

add_task(async function a_reframed_shadow_subtree_costs_its_own_size() {
  // A host in the browser window, as a popup is, with children no slot
  // renders, so none of them has a frame.
  const host = html("div");
  host.setAttribute("role", "group");
  host.setAttribute("aria-label", "host");
  for (let i = 0; i < CHILDREN; i++) {
    host.append(html("div"));
  }
  const list = html("div");
  list.setAttribute("role", "list");
  const items = [];
  for (let i = 0; i < ITEMS; i++) {
    const item = html("div");
    item.setAttribute("role", "listitem");
    item.textContent = `${i}`;
    items.push(item);
  }
  list.append(...items);
  host.attachShadow({ mode: "open" }).append(list);
  document.documentElement.append(host);
  registerCleanupFunction(() => host.remove());
  await accessibleOf(items.at(-1));

  ChromeUtils.setPerfStatsFeatures(METRICS);
  registerCleanupFunction(() => ChromeUtils.setPerfStatsFeatures([]));
  // A new display type frames the list again, and accessibility walks the
  // list's existing accessibles to keep or prune each of them.
  list.style.display = "flex";
  let counts = {};
  await TestUtils.waitForCondition(
    async () => (counts = await calls()).A11Y_PruneOrInsertSubtree >= ITEMS,
    "accessibility walking the framed list"
  );
  info(`calls: ${JSON.stringify(counts)}`);
  Assert.lessOrEqual(
    counts.A11Y_ContentRemovedNode,
    4 * (CHILDREN + ITEMS),
    "the host's unslotted children were checked a bounded number of times"
  );
});
