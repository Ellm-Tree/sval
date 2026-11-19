/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A popover's window reaches above its button by its shadow's room, and
 * macOS keeps a popup's window below the menu bar, at the top of the
 * screen's available rect. A window that stands at that top gives up the
 * room above it, so its window opens where the stem is drawn
 * (`SvalHeader`, `--sval-stem-top-trim`). The window starts at the top of
 * the screen.
 */

/** Where `sval-stem.css` draws no stem inside the popup. */
const OPAQUE_POPUPS = window.matchMedia(
  "(-moz-platform: linux) and (not (-moz-gtk-csd-transparency-available))"
).matches;

add_task(async function test_window_stays_below_the_screen_top() {
  if (OPAQUE_POPUPS) {
    Assert.ok(true, "no stem is drawn in an opaque popup");
    return;
  }
  const was = { x: window.screenX, y: window.screenY };
  atTaskEnd(async () => {
    window.moveTo(was.x, was.y);
    await within(
      TestUtils.waitForCondition(
        () => window.screenX === was.x && window.screenY === was.y,
        "the window going back"
      ),
      10_000,
      "the window going back"
    );
  });
  window.moveTo(screen.availLeft, screen.availTop);
  await within(
    TestUtils.waitForCondition(
      () => window.screenY === screen.availTop,
      "the window at the top of the screen"
    ),
    10_000,
    "the window moving to the top of the screen"
  );
  const popup = document.getElementById("unified-extensions-panel");
  const shown = BrowserTestUtils.waitForPopupEvent(popup, "shown");
  gUnifiedExtensions.openPanel();
  await within(shown, 10_000, "the extensions menu opening");
  await TestUtils.waitForCondition(
    () => popup.getAttribute("sval-stem") === "placed",
    "the stem is placed"
  );
  const frameTop = window.mozInnerScreenY + popup.getBoundingClientRect().top;
  const icon = gUnifiedExtensions.button
    .querySelector(":scope > .toolbarbutton-icon")
    .getBoundingClientRect();
  Assert.greaterOrEqual(
    frameTop,
    screen.availTop - 0.5,
    "the popover's window opens below the top of the screen"
  );
  const content = popup.shadowRoot
    .querySelector('[part~="content"]')
    .getBoundingClientRect();
  Assert.greater(
    window.mozInnerScreenY + content.top,
    window.mozInnerScreenY + icon.bottom,
    "and its content stays below the button"
  );
  const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
  PanelMultiView.hidePopup(popup);
  await within(hidden, 10_000, "the extensions menu closing");
});
