/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_panel_helpers.js */

/**
 * The hidden Workspace panel sliding in over the page while the pointer
 * rests at the window's edge (`SvalPanelReveal`), and out again once the
 * pointer leaves it, a tab is picked, or the toggle's key shows it for good.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_panel_helpers.js",
  this
);

const { EDGE_ID, HIDE_DELAY_MS, REVEAL_PREF } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelReveal.sys.mjs"
);
const { PANEL_TOGGLE_KEY } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalKeys.sys.mjs"
);

const container = () => document.getElementById("sval-panel-container");
const edge = () => document.getElementById(EDGE_ID);

/** Presses the panel's toggle key as it is set, as the user would. */
function pressPanelKey() {
  const el = document.getElementById(PANEL_TOGGLE_KEY);
  const modifiers = (el.getAttribute("modifiers") ?? "").split(/[\s,]+/);
  const isMac = AppConstants.platform === "macosx";
  EventUtils.synthesizeKey(el.getAttribute("key"), {
    ctrlKey:
      modifiers.includes("control") || (modifiers.includes("accel") && !isMac),
    metaKey:
      modifiers.includes("meta") || (modifiers.includes("accel") && isMac),
    altKey: modifiers.includes("alt"),
    shiftKey: modifiers.includes("shift"),
  });
}

/** Waits for the panel and the page to stop moving. */
async function atRest() {
  await within(
    Promise.all(
      [
        ...container().getAnimations(),
        ...document.getElementById("tabbrowser-tabbox").getAnimations(),
      ].map(a => a.finished)
    ),
    10_000,
    "the panel and the page coming to rest"
  );
}

/** @returns {boolean} whether the panel can be seen, slid all the way in. */
function panelInView() {
  const panel = container();
  if (!panel.checkVisibility({ visibilityProperty: true })) {
    return false;
  }
  const own = panel.getBoundingClientRect();
  return own.left >= -1 && own.right <= window.innerWidth + 1;
}

/** @returns {boolean} whether the panel is out of sight. */
function panelGone() {
  return !container().checkVisibility({ visibilityProperty: true });
}

/** Hides the panel with its key, as a person does, until the task ends. */
async function hidePanel() {
  await moveWindowOnScreen();
  gBrowser.selectedBrowser.focus();
  pressPanelKey();
  // The page hears the key first, so the toggle runs once it answers.
  await TestUtils.waitForCondition(
    () => container().hasAttribute("sval-collapsed"),
    "the key hiding the panel"
  );
  await atRest();
  await TestUtils.waitForCondition(panelGone, "the panel out of sight");
  atTaskEnd(async () => {
    if (container().hasAttribute("sval-collapsed")) {
      SvalPanel.toggleVisible();
    }
    await atRest();
  });
}

/**
 * Moves the pointer through the platform to `x`, `y` in the window, and
 * waits for the window to hear it.
 *
 * @param {number} x
 * @param {number} y
 */
async function pointAt(x, y) {
  await nativeMouse({
    type: "mousemove",
    target: document.documentElement,
    screenX: Math.round(window.mozInnerScreenX + x),
    screenY: Math.round(window.mozInnerScreenY + y),
    eventTargetToListen: window,
  });
}

/** Puts the pointer in the middle of the page. */
async function pointAtPage() {
  const page = gBrowser.selectedBrowser.getBoundingClientRect();
  await pointAt(page.left + page.width / 2, page.top + page.height / 2);
}

/**
 * Brings the pointer from the page to the window's edge on the panel's
 * side, and waits there for the panel to slide in.
 */
async function pushPointerToEdge() {
  await pointAtPage();
  const strip = edge().getBoundingClientRect();
  await pointAt(strip.left + strip.width / 2, strip.top + strip.height / 2);
  await TestUtils.waitForCondition(
    () => panelInView() && !container().getAnimations().length,
    "the panel sliding in from the edge"
  );
}

add_task(async function the_edge_slides_the_hidden_panel_in_over_the_page() {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  await hidePanel();

  const strip = edge();
  Assert.ok(
    strip.checkVisibility(),
    "the hidden panel leaves a strip at the edge"
  );
  const pageBefore = gBrowser.selectedBrowser.getBoundingClientRect();
  const own = strip.getBoundingClientRect();
  Assert.ok(
    own.right <= pageBefore.left || own.left >= pageBefore.right,
    "the strip lies in the gap beside the page, so it takes none of its clicks"
  );

  await pushPointerToEdge();
  const pageAfter = gBrowser.selectedBrowser.getBoundingClientRect();
  Assert.equal(pageAfter.width, pageBefore.width, "the page keeps its width");
  Assert.equal(pageAfter.left, pageBefore.left, "and its place");
  Assert.ok(
    container().hasAttribute("sval-collapsed"),
    "the panel stays hidden as far as its toggle is concerned"
  );
  Assert.equal(
    document.getElementById("sval-panel-button").getAttribute("aria-pressed"),
    "false",
    "and the toggle is heard as off"
  );

  // The one wait on the delay before the panel hides.
  await pointAtPage();
  await TestUtils.waitForCondition(
    panelGone,
    "the panel sliding away once the pointer has left it"
  );
});

/**
 * A window against the screen's edge, as a maximised, snapped or full-screen
 * one is. macOS keeps a window's outermost pixels for resizing it, and
 * Windows puts its resize border outside the window's content, so a pointer
 * pushed into the screen's edge there leaves the window's content: the
 * window hears the pointer leave it from the strip.
 */
add_task(async function the_screen_edge_slides_the_hidden_panel_in() {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  await hidePanel();
  const { screen } = window;
  const was = { x: window.screenX, y: window.screenY };
  atTaskEnd(async () => {
    window.moveTo(was.x, was.y);
    await TestUtils.waitForCondition(
      () =>
        Math.abs(window.screenX - was.x) <= 1 &&
        Math.abs(window.screenY - was.y) <= 1,
      "the window going back"
    );
  });
  // The frame against the edge, as dragging a window there puts it. Where
  // the frame has a border beside the content, the content starts past it.
  window.moveTo(screen.left, window.screenY);
  await TestUtils.waitForCondition(
    () => Math.abs(window.screenX - screen.left) <= 1,
    "the window's side against the screen's edge"
  );

  const strip = edge();
  const own = strip.getBoundingClientRect();
  const y = own.top + own.height / 2;
  Assert.equal(
    document.elementFromPoint(0, y),
    strip,
    "the window's outermost pixel is the strip's"
  );
  await pointAtPage();
  await pointAt(own.left + own.width / 2, y);
  // The window's content losing the pointer at its edge, as the platform
  // reports it (`nsContentUtils::SendMouseEvent`).
  EventUtils.synthesizeMouse(strip, 0, own.height / 2, {
    type: "mousecancel",
  });
  await TestUtils.waitForCondition(
    () => panelInView() && !container().getAnimations().length,
    "the panel sliding in with the pointer pushed past the strip"
  );
});

add_task(async function a_menu_from_the_panel_keeps_it_in() {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  await hidePanel();
  await pushPointerToEdge();

  const row = drawnRows()[0];
  const menu = await openContextMenu(row);
  await pointAtPage();
  // The menu keeps the panel in for as long as it is open, which no event
  // marks, so the task waits past the moment the panel would have gone.
  const movedAt = performance.now();
  await TestUtils.waitForCondition(
    () => performance.now() - movedAt > 2 * HIDE_DELAY_MS,
    "past the wait before the panel would hide"
  );
  Assert.ok(panelInView(), "the panel stays in while its menu is open");

  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(hidden, 10_000, "the menu closing");
  await TestUtils.waitForCondition(
    panelGone,
    "the panel sliding away once the menu has closed"
  );
});

add_task(async function a_tab_picked_in_the_panel_puts_it_away() {
  const { ids } = await withFreshPanel();
  await viewTab(ids.tab1);
  await hidePanel();
  await pushPointerToEdge();

  const row = SvalPanel._rowElementFor(ids.tab2);
  const own = row.getBoundingClientRect();
  const x = own.left + own.width / 2;
  const y = own.top + own.height / 2;
  await pointAt(x, y);
  const selected = BrowserTestUtils.waitForEvent(
    gBrowser.tabContainer,
    "TabSelect"
  );
  // The rows are a tree with a roving tabindex: Tab reaches the focused row
  // and the arrow keys the rest.
  AccessibilityUtils.setEnv({ nonNegativeTabIndexRule: false });
  atTaskEnd(() => AccessibilityUtils.resetEnv());
  for (const type of ["mousedown", "mouseup"]) {
    await nativeMouse({
      type,
      target: document.documentElement,
      screenX: Math.round(window.mozInnerScreenX + x),
      screenY: Math.round(window.mozInnerScreenY + y),
    });
  }
  await within(selected, 10_000, "the click selecting the tab");
  await switchDone(window);
  Assert.equal(
    taggedId(gBrowser.selectedTab),
    ids.tab2,
    "the click goes to the tab"
  );
  await TestUtils.waitForCondition(
    panelGone,
    "and the panel slides away with the pointer still over it"
  );
  Assert.equal(
    document.activeElement,
    gBrowser.selectedBrowser,
    "leaving the focus on the page"
  );
});

add_task(async function the_toggle_key_shows_a_slid_in_panel_for_good() {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  await hidePanel();
  await pushPointerToEdge();

  pressPanelKey();
  await TestUtils.waitForCondition(
    () => !container().hasAttribute("sval-collapsed"),
    "the key showing the panel"
  );
  if (parseFloat(getComputedStyle(container()).transitionDuration)) {
    Assert.ok(
      document
        .getElementById("tabbrowser-tabbox")
        .getAnimations()
        .some(a => a.transitionProperty === "translate"),
      "the page slides aside"
    );
    Assert.ok(
      container().hasAttribute("sval-overlay"),
      "with the panel over it until the page has moved"
    );
  }
  await TestUtils.waitForCondition(
    () => !container().hasAttribute("sval-overlay"),
    "the panel back in the layout"
  );
  await atRest();
  const panel = container().getBoundingClientRect();
  const page = gBrowser.selectedBrowser.getBoundingClientRect();
  Assert.ok(
    page.left >= panel.right || page.right <= panel.left,
    "with the page moved aside beside it"
  );
  Assert.ok(!edge().checkVisibility(), "and no strip at the edge");
  Assert.ok(
    !container().hasAttribute("sval-reveal"),
    "and nothing left to slide it away"
  );
});

add_task(async function the_switch_takes_the_strip_away() {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  await hidePanel();
  Assert.ok(edge().checkVisibility(), "the strip is there by default");
  await SpecialPowers.pushPrefEnv({ set: [[REVEAL_PREF, false]] });
  Assert.ok(!edge().checkVisibility(), "and gone with the switch off");
  await SpecialPowers.popPrefEnv();
});
