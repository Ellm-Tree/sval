/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The status panel's tab (`sval-header.css`, status panel): in a see-through
 * window the tab paints no colour of its own, and the page, its backdrop and
 * the frame's edge are cut away in the tab's shape, on whichever corner the
 * tab stands.
 */

const panel = document.getElementById("statuspanel");
const label = document.getElementById("statuspanel-label");

function seeThrough() {
  const root = document.documentElement;
  root.setAttribute("data-sval-tint", "");
  root.setAttribute("data-sval-see-through", "");
  registerCleanupFunction(() => {
    root.removeAttribute("data-sval-tint");
    root.removeAttribute("data-sval-see-through");
  });
}

async function showLink() {
  XULBrowserWindow.setOverLink("https://example.com/a/long/address");
  await TestUtils.waitForCondition(
    () => !panel.hidden && !panel.hasAttribute("inactive"),
    "the status panel shows the link"
  );
}

async function hideLink() {
  XULBrowserWindow.setOverLink("", { hideStatusPanelImmediately: true });
  await TestUtils.waitForCondition(
    () => panel.hidden,
    "the status panel hides"
  );
}

/** The layers of each element the tab cuts through, empty where uncut. */
function cuts() {
  const pane = gBrowser.selectedBrowser.closest(".browserSidebarContainer");
  const masks = [
    getComputedStyle(gBrowser.selectedBrowser).maskImage,
    getComputedStyle(pane, "::after").maskImage,
    getComputedStyle(pane.querySelector(".browserContainer"), "::before")
      .maskImage,
  ];
  return masks.map(mask =>
    mask === "none" ? 0 : mask.split("gradient(").length - 1
  );
}

/** Where the label's body is cut from the page, as `x y`. */
function labelCut() {
  return getComputedStyle(gBrowser.selectedBrowser).maskPosition.split(", ")[1];
}

add_setup(solidWindows);

add_task(async function a_plain_window_paints_the_tab_over_the_page() {
  await showLink();
  try {
    Assert.notEqual(
      getComputedStyle(label).backgroundColor,
      "rgba(0, 0, 0, 0)",
      "the tab wears the window's colour"
    );
    Assert.deepEqual(cuts(), [0, 0, 0], "nothing is cut from the page");
  } finally {
    await hideLink();
  }
});

add_task(async function a_see_through_window_shows_itself_through_the_tab() {
  seeThrough();
  await showLink();
  try {
    Assert.equal(
      getComputedStyle(label).backgroundColor,
      "rgba(0, 0, 0, 0)",
      "the tab paints no colour of its own"
    );
    Assert.deepEqual(
      cuts(),
      [6, 6, 6],
      "the page, the frame's edge and the backdrop are cut in the tab's shape"
    );
    await TestUtils.waitForCondition(
      () =>
        gBrowser.tabpanels.style.getPropertyValue("--sval-status-w") ===
        `${label.getBoundingClientRect().width}px`,
      "the cut is the label's width"
    );
    Assert.equal(
      labelCut(),
      "0px 100%",
      "the label's cut stands in the page's near corner"
    );

    panel.setAttribute("mirror", "true");
    Assert.equal(
      labelCut(),
      "100% 100%",
      "a mirrored tab's cut stands in the far corner"
    );
  } finally {
    await hideLink();
  }
  Assert.deepEqual(cuts(), [0, 0, 0], "a hidden tab leaves the page whole");
});
