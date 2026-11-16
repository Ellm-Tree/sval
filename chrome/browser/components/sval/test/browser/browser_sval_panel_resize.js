/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_panel_helpers.js */

/**
 * The panel's edge resizes it: dragged, from the keyboard, and back to its
 * default with a double-click. The width is this device's, kept in its local
 * settings, on either side of the window.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_panel_helpers.js",
  this
);

function container() {
  return document.getElementById("sval-panel-container");
}

function edge() {
  return container().querySelector(":scope > .sval-panel-resizer");
}

function drawnWidth() {
  return Math.round(container().getBoundingClientRect().width);
}

/**
 * Drags the edge `dx` CSS pixels along x, as a person does with the mouse.
 *
 * @param {number} dx
 */
function dragEdge(dx) {
  // Window coordinates, fixed at the start: the edge moves with the drag.
  const rect = edge().getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  withEdgeChecks(() => {
    EventUtils.synthesizeMouseAtPoint(x, y, { type: "mousedown" });
    EventUtils.synthesizeMouseAtPoint(x + dx / 2, y, { type: "mousemove" });
    EventUtils.synthesizeMouseAtPoint(x + dx, y, { type: "mousemove" });
    EventUtils.synthesizeMouseAtPoint(x + dx, y, { type: "mouseup" });
  });
}

/**
 * Clicks the edge, as a person does with the mouse.
 *
 * @param {object} [options] `EventUtils.synthesizeMouseAtCenter`'s.
 */
function clickEdge(options = {}) {
  withEdgeChecks(() => EventUtils.synthesizeMouseAtCenter(edge(), options));
}

/**
 * Runs `pointer` with the accessibility checks a click on the edge needs.
 *
 * @param {Function} pointer
 */
function withEdgeChecks(pointer) {
  // The edge is a focusable separator that Tab reaches and the arrow keys
  // move (the_keyboard_resizes_the_panel), which the checker does not count
  // among interactive roles.
  AccessibilityUtils.setEnv({ mustHaveAccessibleRule: false });
  try {
    pointer();
  } finally {
    AccessibilityUtils.resetEnv();
  }
}

add_task(async function dragging_the_edge_resizes_the_panel_and_keeps_it() {
  const { settings } = await withFreshPanel();
  const start = drawnWidth();
  Assert.equal(settings.panelWidth, null, "a fresh device has no width");

  clickEdge();
  await settings.flush();
  Assert.equal(settings.panelWidth, null, "a click alone keeps no width");

  dragEdge(60);
  await TestUtils.waitForCondition(
    () => settings.panelWidth === start + 60,
    "the drag's width is kept"
  );
  Assert.equal(drawnWidth(), start + 60, "the panel is drawn 60px wider");
  await settings.flush();
  Assert.equal(
    (await IOUtils.readJSON(settings.path)).panelWidth,
    start + 60,
    "the width is written to this device's settings"
  );

  dragEdge(-100);
  await TestUtils.waitForCondition(
    () => settings.panelWidth === start - 40,
    "a drag back narrows it"
  );

  clickEdge({ clickCount: 2 });
  await TestUtils.waitForCondition(
    () => settings.panelWidth === null,
    "a double-click forgets the width"
  );
  Assert.equal(drawnWidth(), start, "and the panel takes its default again");
});

add_task(async function the_width_stays_within_its_bounds() {
  const { settings } = await withFreshPanel();
  dragEdge(-10_000);
  await TestUtils.waitForCondition(
    () => settings.panelWidth !== null,
    "the drag is kept"
  );
  Assert.equal(
    drawnWidth(),
    48,
    "the narrowest panel is its 48px layout's width"
  );
  Assert.equal(settings.panelWidth, 48, "and that is the width kept");

  dragEdge(10_000);
  await TestUtils.waitForCondition(
    () => settings.panelWidth > 48,
    "the drag is kept"
  );
  Assert.lessOrEqual(
    drawnWidth(),
    Math.ceil(window.innerWidth * 0.75),
    "the widest panel leaves the page a quarter of the window"
  );
  SvalPanel._setPanelWidth(null);
});

add_task(async function the_keyboard_resizes_the_panel() {
  const { settings } = await withFreshPanel();
  const start = drawnWidth();
  edge().focus();
  Assert.equal(
    edge().getAttribute("aria-valuenow"),
    String(start),
    "the edge says the panel's width"
  );
  EventUtils.synthesizeKey("KEY_ArrowRight");
  await TestUtils.waitForCondition(
    () => settings.panelWidth === start + 16,
    "Right widens a left-hand panel"
  );
  EventUtils.synthesizeKey("KEY_ArrowLeft", { shiftKey: true });
  await TestUtils.waitForCondition(
    () => settings.panelWidth === start + 16 - 64,
    "Shift+Left narrows it a long step"
  );
  Assert.equal(
    edge().getAttribute("aria-valuenow"),
    String(start - 48),
    "and the edge says the new width"
  );
  SvalPanel._setPanelWidth(null);
});

/**
 * @returns {nsIAccessibleValue} the edge's value, as a screen reader reads it.
 */
async function edgeValue() {
  const acc = await accessibleOf(edge());
  return acc.QueryInterface(Ci.nsIAccessibleValue);
}

/**
 * The edge is a window splitter: Home and End take the panel to its
 * narrowest and widest, and Enter puts it back to its default, as a
 * double-click does. A screen reader reads its width against that range,
 * which follows the window's size.
 */
add_task(async function the_keyboard_restores_the_default_width() {
  const { settings } = await withFreshPanel();
  const start = drawnWidth();
  edge().focus();
  const value = await edgeValue();
  Assert.equal(value.currentValue, start, "the edge says the panel's width");
  Assert.equal(value.minimumValue, 48, "against its narrowest");
  Assert.equal(
    value.maximumValue,
    Math.round(window.innerWidth * 0.75),
    "and its widest"
  );
  EventUtils.synthesizeKey("KEY_ArrowRight");
  await TestUtils.waitForCondition(
    () => settings.panelWidth === start + 16,
    "Right widens the panel"
  );

  EventUtils.synthesizeKey("KEY_Home");
  await TestUtils.waitForCondition(
    () => settings.panelWidth === 48,
    "Home takes the panel to its narrowest"
  );
  Assert.equal(drawnWidth(), 48, "which is how it is drawn");

  EventUtils.synthesizeKey("KEY_End");
  await TestUtils.waitForCondition(
    () => settings.panelWidth > start,
    "End widens it"
  );
  Assert.lessOrEqual(
    drawnWidth(),
    Math.ceil(window.innerWidth * 0.75),
    "to its widest, which leaves the page a quarter of the window"
  );
  Assert.greaterOrEqual(
    drawnWidth(),
    Math.floor(window.innerWidth * 0.75),
    "and no less"
  );

  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(
    () => settings.panelWidth === null,
    "Enter forgets the width"
  );
  Assert.equal(drawnWidth(), start, "and the panel takes its default again");
  Assert.equal(
    edge().getAttribute("aria-valuenow"),
    String(start),
    "and the edge says so"
  );
  Assert.equal(document.activeElement, edge(), "with the keyboard still on it");

  const width = window.outerWidth;
  atTaskEnd(async () => {
    window.resizeTo(width, window.outerHeight);
    await TestUtils.waitForCondition(
      () => window.outerWidth === width,
      "the window is its own width again"
    );
  });
  window.resizeTo(width - 100, window.outerHeight);
  await TestUtils.waitForCondition(
    () =>
      window.outerWidth === width - 100 &&
      value.maximumValue === Math.round(window.innerWidth * 0.75),
    "a narrower window narrows the widest the edge says"
  );
});

add_task(async function a_right_hand_panel_widens_towards_the_page() {
  const { settings } = await withFreshPanel();
  settings.placement = "right";
  SvalPanel._applyPlacement();
  registerCleanupFunction(() => {
    settings.placement = "left";
    SvalPanel._applyPlacement();
  });
  const content = document.getElementById("tabbrowser-tabbox");
  await TestUtils.waitForCondition(
    () =>
      container().getBoundingClientRect().left >
      content.getBoundingClientRect().left,
    "the panel settles on the right"
  );
  const start = drawnWidth();
  dragEdge(-50);
  await TestUtils.waitForCondition(
    () => settings.panelWidth === start + 50,
    "dragging towards the page widens it"
  );
  SvalPanel._setPanelWidth(null);
});

/**
 * At 48px New tab and New group stack as icons, each named in its tooltip
 * and to a screen reader, as the buttons above them are.
 */
add_task(async function the_48px_panel_stacks_new_tab_and_new_group() {
  const { settings } = await withFreshPanel();
  atTaskEnd(() => {
    settings.panelWidth = null;
    SvalPanel._applyPanelWidth();
  });
  settings.panelWidth = 48;
  SvalPanel._applyPanelWidth();
  await TestUtils.waitForCondition(() => drawnWidth() === 48, "48px wide");
  const header = SvalPanel.container.querySelector(".sval-panel-header");
  const [newTab, newGroup] = header.querySelectorAll(".sval-newtab");
  Assert.ok(newTab.checkVisibility(), "New tab shows");
  Assert.ok(newGroup.checkVisibility(), "and so does New group");
  Assert.greaterOrEqual(
    newGroup.getBoundingClientRect().top,
    newTab.getBoundingClientRect().bottom - 0.5,
    "under it"
  );
  Assert.ok(newGroup.title, "with a tooltip");
  Assert.ok((await accessibleOf(newGroup)).name, "and an accessible name");
});
