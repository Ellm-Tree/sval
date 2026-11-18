/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * The Workspace menu opens over the switcher, listing every Workspace once,
 * in its own place, the current one included. Picking one closes the menu on
 * the Workspace picked. The keyboard's ring shows on a row only once a key
 * is pressed in the menu.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);

/**
 * The popup's drawn box on the screen, without the room its window keeps
 * for the shadow.
 *
 * @param {Element} popup
 * @returns {{left: number, top: number, width: number}}
 */
function contentOf(popup) {
  const box = popup.getOuterScreenRect();
  const own = popup.getBoundingClientRect();
  const r = popup.shadowRoot
    .querySelector('[part~="content"]')
    .getBoundingClientRect();
  return {
    left: box.left + r.left - own.left,
    top: box.top + r.top - own.top,
    width: r.width,
  };
}

add_task(async function the_menu_opens_over_the_switcher_in_order() {
  const { ids } = await withSwitcherPanel({
    names: ["Work", "Home", "3D Printing"],
  });
  const last = ids.workspaces.at(-1);
  await within(SvalPanel.switchTo(last), 10_000, "the switch to the last");

  const switcher = SvalPanel._els.switcher;
  const menu = await openSwitcher();

  const box = contentOf(menu);
  const button = switcher.getBoundingClientRect();
  Assert.lessOrEqual(
    Math.abs(box.left - (window.mozInnerScreenX + button.left)),
    1,
    "the menu's left edge is the switcher's"
  );
  Assert.lessOrEqual(
    Math.abs(box.top - (window.mozInnerScreenY + button.top)),
    1,
    "and its top edge, so nothing opens above the switcher"
  );
  Assert.greaterOrEqual(
    box.width,
    button.width - 1,
    "it is at least as wide as the switcher"
  );

  const entries = switcherEntries(menu, ids.workspaces);
  Assert.deepEqual(
    entries.map(el => el.dataset.workspaceId),
    ids.workspaces,
    "each Workspace is listed once, in its order"
  );
  const current = menu.querySelectorAll('[aria-current="true"]');
  Assert.equal(current.length, 1, "one entry is the current Workspace");
  Assert.equal(current[0].dataset.workspaceId, last, "the one shown");
  const tops = entries.map(el => el.getBoundingClientRect().top);
  Assert.deepEqual(
    tops,
    tops.toSorted((a, b) => a - b),
    "the entries stand in that order on screen, the current one last"
  );

  await closeSwitcher(menu);
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    last,
    "closing changes nothing"
  );
});

add_task(async function picking_a_workspace_closes_the_menu_on_it() {
  const { ids } = await withSwitcherPanel({ workspaces: 3 });
  const [first, , third] = ids.workspaces;
  Assert.equal(SvalWindowWorkspace.of(window).id, first);
  const menu = await openSwitcher();

  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  EventUtils.synthesizeMouseAtCenter(switcherEntries(menu, [third])[0], {});
  await within(hidden, 10_000, "the menu closing");
  await within(
    SvalPanel._switching?.idle() ?? Promise.resolve(),
    10_000,
    "the switch"
  );
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    third,
    "the window shows the pick"
  );
});

add_task(async function the_ring_follows_the_keyboard_alone() {
  const { ids } = await withSwitcherPanel({ workspaces: 2 });
  const menu = await openSwitcher();
  const [entry] = switcherEntries(menu, ids.workspaces);
  const ring = el => window.getComputedStyle(el).outlineStyle;

  EventUtils.synthesizeMouseAtCenter(entry, { type: "mousemove" });
  await TestUtils.waitForCondition(
    () => entry.hasAttribute("_moz-menuactive"),
    "the pointer on an entry"
  );
  Assert.equal(ring(entry), "none", "the pointer draws no ring");

  EventUtils.synthesizeKey("KEY_ArrowDown", {}, window);
  const active = await TestUtils.waitForCondition(
    () => menu.querySelector(":scope > [_moz-menuactive]"),
    "the keyboard on an entry"
  );
  Assert.notEqual(ring(active), "none", "a key press draws the ring");

  EventUtils.synthesizeMouseAtCenter(active, { type: "mousemove" });
  Assert.equal(ring(active), "none", "and the pointer takes it away");
  await closeSwitcher(menu);
});
