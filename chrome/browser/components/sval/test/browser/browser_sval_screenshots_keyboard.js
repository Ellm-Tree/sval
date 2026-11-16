/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * Screenshots' Save visible and Save full page buttons, and its overlay, by
 * keyboard alone (patch `screenshots-keyboard-focus`).
 */

const RED_PAGE = ROOT + "sval_agent_red.html";

/**
 * Starts Screenshots on `browser` and resolves with its two buttons once
 * the overlay is up and one of them has focus.
 *
 * @param {Element} browser
 */
async function startScreenshots(browser) {
  ScreenshotsUtils.start(browser, "Shortcut");
  const panel = await waitForCondition(
    () => ScreenshotsUtils.panelForBrowser(browser),
    "the buttons' panel"
  );
  await waitForCondition(
    () =>
      !panel.hidden && panel.querySelector("screenshots-buttons").shadowRoot,
    "the buttons showing"
  );
  await waitForCondition(
    () =>
      SpecialPowers.spawn(
        browser,
        [],
        () =>
          !!content.windowGlobalChild.getActor("ScreenshotsComponent").overlay
            ?.initialized
      ),
    "the overlay"
  );
  const root = panel.querySelector("screenshots-buttons").shadowRoot;
  const visible = root.getElementById("visible-page");
  const full = root.getElementById("full-page");
  await waitForCondition(
    () => [visible, full].includes(root.activeElement),
    "a button focused on opening"
  );
  return { root, visible, full };
}

/**
 * Whether the overlay's face has focus in `browser`'s page.
 *
 * @param {Element} browser
 */
function faceFocused(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const { overlay } = content.windowGlobalChild.getActor(
      "ScreenshotsComponent"
    );
    return Services.focus.focusedElement === overlay.previewFace;
  });
}

add_task(async function left_and_right_move_between_the_buttons() {
  const tab = await openPage(RED_PAGE);
  const { root, visible, full } = await startScreenshots(tab.linkedBrowser);

  visible.focus({ focusVisible: true });
  EventUtils.synthesizeKey("KEY_ArrowRight");
  await waitForCondition(
    () => root.activeElement === full,
    "Right moving to Save full page"
  );
  EventUtils.synthesizeKey("KEY_ArrowRight");
  await waitForCondition(
    () => root.activeElement === visible,
    "Right wrapping to Save visible"
  );
  EventUtils.synthesizeKey("KEY_ArrowLeft");
  await waitForCondition(
    () => root.activeElement === full,
    "Left wrapping to Save full page"
  );
  ScreenshotsUtils.cancel(tab.linkedBrowser, "Escape");
});

add_task(async function tab_enters_the_overlay_when_nothing_has_focus() {
  const tab = await openPage(RED_PAGE);
  const browser = tab.linkedBrowser;
  await startScreenshots(browser);

  // Where Up or Down leaves focus as it moves the crosshair
  // (`ScreenshotsUtils.handleArrowKeyDown`): on the page, with nothing in
  // it focused.
  ScreenshotsUtils.clearContentFocus(browser);
  Services.focus.clearFocus(window);
  Services.focus.setFocus(browser, 0);

  EventUtils.synthesizeKey("KEY_Tab");
  await waitForCondition(() => faceFocused(browser), "Tab focusing the face");
  ScreenshotsUtils.cancel(browser, "Escape");
});
