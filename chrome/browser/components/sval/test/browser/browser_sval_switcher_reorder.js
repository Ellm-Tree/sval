/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * The user's Workspaces are put in order in the switcher by dragging an
 * entry, as Favorites are dragged in theirs. The order is the document's
 * sibling order, so the switcher and every other list of Workspaces read it
 * from there.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);

/**
 * Dispatches a drag event at `target`, `at` of the way down it, carrying the
 * one `DataTransfer` a drag hands every event.
 *
 * @param {string} type
 * @param {Element} target
 * @param {DataTransfer} dataTransfer
 * @param {number} [at]
 * @returns {DragEvent}
 */
function drag(type, target, dataTransfer, at = 0.5) {
  const rect = target.getBoundingClientRect();
  const event = new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    dataTransfer,
    clientX: rect.x + rect.width / 2,
    clientY: rect.y + rect.height * at,
  });
  target.dispatchEvent(event);
  return event;
}

/** The document's Workspaces, in the order every list of them reads. */
async function documentOrder() {
  const nodes = (await SvalPanel.engine.tree()).nodes ?? {};
  return SvalPanelModel.workspaceIds(nodes);
}

add_task(async function dragging_an_entry_reorders_the_workspaces() {
  const { ids } = await withSwitcherPanel({ workspaces: 3 });
  const [first, second, third] = ids.workspaces;
  const [profiles] = await documentOrder();
  const menu = await openSwitcher();
  const entry = id => switcherEntries(menu, [id])[0];

  const dt = new DataTransfer();
  drag("dragstart", entry(third), dt);
  Assert.ok(
    drag("dragover", entry(first), dt, 0.1).defaultPrevented,
    "an entry takes a dragged Workspace"
  );
  Assert.equal(entry(first).getAttribute("data-drop"), "before");
  drag("dragover", entry(first), dt, 0.9);
  Assert.equal(entry(first).getAttribute("data-drop"), "after", "by halves");
  drag("dragover", entry(first), dt, 0.1);
  drag("drop", entry(first), dt, 0.1);
  await TestUtils.waitForCondition(
    async () =>
      (await documentOrder()).join() ===
      [profiles, third, first, second].join(),
    "the Workspace landing before the one it was dropped on"
  );
  Assert.ok(
    !menu.querySelector("[data-drop]"),
    "and the drop line is gone with the drop"
  );
  await TestUtils.waitForCondition(
    () =>
      switcherEntries(menu, ids.workspaces)
        .map(el => el.dataset.workspaceId)
        .join() === [third, first, second].join(),
    "the open switcher redrawn in the new order"
  );

  const text = new DataTransfer();
  text.mozSetDataAt("text/plain", "not a Workspace", 0);
  Assert.ok(
    !drag("dragover", entry(first), text).defaultPrevented,
    "anything else dragged over an entry is refused"
  );
  await closeSwitcher(menu);
});
