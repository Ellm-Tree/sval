/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Sval's notification bar (`notification-bar.css`, `notification-bar-shadow.css`)
 * on the bars Firefox's own boxes append, and where `SvalWindow` puts them.
 */

const PRIORITIES = {
  info: "PRIORITY_INFO_HIGH",
  warning: "PRIORITY_WARNING_MEDIUM",
  critical: "PRIORITY_CRITICAL_HIGH",
};

/**
 * Appends a bar with one button and a "Learn more" link, as Firefox's bars
 * carry, and waits for Sval's sheet inside it, which its shadow root loads
 * after the bar is shown.
 *
 * @param {object} box A notification box.
 * @param {string} type The bar's type.
 * @returns {Promise<Element>} The `<notification-message>`.
 */
async function appendBar(box, type) {
  const bar = await box.appendNotification(
    `sval-test-${type}`,
    { label: `A ${type} bar.`, priority: box[PRIORITIES[type]] },
    [
      { label: "Act", primary: true, callback: () => true },
      { label: "Not now", callback: () => true },
      { supportPage: "sval-test" },
    ]
  );
  await TestUtils.waitForCondition(
    () => getComputedStyle(bar, "::before").display == "none",
    `sval's sheet reaches the ${type} bar's shadow root`
  );
  return bar;
}

add_task(async function each_type_takes_its_colours_and_no_stripe() {
  const box = gBrowser.getNotificationBox();
  registerCleanupFunction(() => box.removeAllNotifications(true));
  for (const type of Object.keys(PRIORITIES)) {
    const bar = await appendBar(box, type);
    Assert.equal(bar.getAttribute("type"), type, `the bar is ${type}`);
    for (const scheme of ["dark", "light"]) {
      bar.style.colorScheme = scheme;
      const style = getComputedStyle(bar);
      Assert.greaterOrEqual(
        contrastRatio(style.color, style.backgroundColor),
        4.5,
        `a ${type} bar's text is readable in the ${scheme} scheme`
      );
      const link = getComputedStyle(bar.querySelector(".notification-link"));
      Assert.greaterOrEqual(
        contrastRatio(link.color, style.backgroundColor),
        4.5,
        `and so is its link`
      );
    }
    bar.style.removeProperty("color-scheme");
  }
  box.removeAllNotifications(true);
});

add_task(async function the_window_bar_spans_the_web_view_pane() {
  const bar = await appendBar(gNotificationBox, "warning");
  registerCleanupFunction(() => gNotificationBox.removeAllNotifications(true));
  const pane = document
    .getElementById("tabbrowser-tabpanels")
    .getBoundingClientRect();
  const rect = bar.getBoundingClientRect();
  Assert.equal(Math.round(rect.left), Math.round(pane.left), "from its left");
  Assert.equal(Math.round(rect.width), Math.round(pane.width), "to its right");
  // The bar may still be sliding in, so its place is its box's.
  const stack = gNotificationBox.stack.getBoundingClientRect();
  Assert.greaterOrEqual(
    Math.round(stack.top),
    Math.round(
      document.getElementById("navigator-toolbox").getBoundingClientRect()
        .bottom
    ),
    "under the header"
  );
  Assert.lessOrEqual(
    Math.round(stack.bottom),
    Math.round(pane.top),
    "and above the page"
  );
  gNotificationBox.removeAllNotifications(true);
});
