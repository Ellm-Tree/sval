/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The page's zoom in the site menu: its slider, a tick at each step, and
 * Reset.
 */

const ZOOM_PAGE = "https://example.com/";

function byId(id) {
  return document.getElementById(id);
}

async function openMenuFrom(button) {
  const menu = byId("sval-site-menu");
  const shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
  button.click();
  await within(shown, 5_000, "the site menu's popupshown");
}

async function closeMenu() {
  const menu = byId("sval-site-menu");
  if (menu.state === "closed") {
    return;
  }
  const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
  menu.hidePopup();
  await within(hidden, 5_000, "the site menu's popuphidden");
}

async function zoomed(change) {
  const changed = BrowserTestUtils.waitForEvent(window, "FullZoomChange");
  await change();
  await within(changed, 5_000, "the page's zoom change");
}

/** Leaves no site zoom behind, should a task fail before its own reset. */
registerCleanupFunction(async () => {
  await within(FullZoom.reset(), 5_000, "the zoom reset");
});

add_task(async function the_slider_zooms_and_reset_returns_to_the_default() {
  await BrowserTestUtils.withNewTab(ZOOM_PAGE, async browser => {
    await zoomed(() => FullZoom.enlarge(browser));
    await openMenuFrom(byId("sval-site-menu-button"));
    try {
      const slider = byId("sval-site-zoom");
      const values = ZoomManager.zoomValues;
      const at = values.indexOf(
        ZoomManager.snap(ZoomManager.getZoomForBrowser(browser))
      );
      Assert.equal(slider.valueAsNumber, at, "the slider is at the zoom");
      Assert.equal(
        byId("sval-site-zoom-section").querySelectorAll(".sval-site-zoom-tick")
          .length,
        values.length,
        "a tick marks each step"
      );
      Assert.ok(!byId("sval-site-zoom-reset").disabled, "Reset can be used");

      slider.focus();
      await zoomed(() =>
        EventUtils.synthesizeKey(
          window.RTL_UI ? "KEY_ArrowLeft" : "KEY_ArrowRight"
        )
      );
      Assert.equal(
        ZoomManager.getZoomForBrowser(browser),
        values[at + 1],
        "a step on the slider zooms the page a step"
      );
      Assert.equal(slider.valueAsNumber, at + 1, "and the slider stays there");

      await zoomed(() => byId("sval-site-zoom-reset").click());
      await TestUtils.waitForCondition(
        () => byId("sval-site-zoom-reset").disabled,
        "Reset is done"
      );
      Assert.equal(
        ZoomManager.getZoomForBrowser(browser),
        1,
        "Reset returns the page to the default zoom"
      );
      Assert.equal(
        byId("sval-site-zoom")
          .closest(".sval-site-zoom-row")
          .querySelector("output").value,
        "100%",
        "and the menu says so"
      );
    } finally {
      await closeMenu();
    }
  });
});
