/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * What the element picker's and the snip's test files share: reading the
 * overlay the child draws in the page, waiting for it, and clicking in it.
 * Each file loads this with `loadSubScript` into its own scope.
 */

/* exported inPrivateWindow, overlayState, overlayUntil, displayOf, clickOverlay */

/**
 * Opens a private window on `url`, runs `test` with its browser and closes
 * the window.
 *
 * @param {string} url
 * @param {Function} test Given the browser.
 */
async function inPrivateWindow(url, test) {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    15_000,
    "a private window opening"
  );
  try {
    const browser = win.gBrowser.selectedBrowser;
    await within(
      BrowserTestUtils.loadURIString({ browser, uriString: url }),
      15_000,
      "the page loading in a private window"
    );
    await test(browser);
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the private window closing"
    );
  }
}

/**
 * What the overlay shows, read from its shadow root.
 *
 * @param {Element} browser
 * @returns {Promise<?object>} null when the page has no overlay.
 */
function overlayState(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const root =
      content.windowGlobalChild.getActor("SvalElementPicker").overlay;
    if (!root) {
      return null;
    }
    const byId = id => root.getElementById(id);
    const shown = id => !!byId(id) && !byId(id).hidden;
    const text = id => (shown(id) ? byId(id).textContent : null);
    return {
      bar: shown("bar"),
      scheme: root.querySelector(".overlay").getAttribute("scheme"),
      reducedMotion: root
        .querySelector(".overlay")
        .hasAttribute("reduced-motion"),
      mode: root.querySelector(".overlay").getAttribute("mode"),
      outline: shown("outline"),
      // The element the outline is on, by its tag, and its size.
      labelElement: shown("label") ? byId("label").dataset.element : null,
      labelSize: shown("label")
        ? byId("label").querySelector(".label-size").textContent
        : null,
      card: shown("card"),
      title: text("card-title"),
      // The scope the card saves at, on a host with a choice of scope.
      scope: shown("card-title")
        ? (byId("card-title").dataset.scope ?? null)
        : null,
      element: shown("depth-name") ? byId("depth-name").dataset.element : null,
      outlineTop: shown("outline") ? byId("outline").style.top : null,
      matches: shown("count") ? Number(byId("count").dataset.matches) : null,
      selector: text("selector"),
      rules: shown("rules")
        ? [...byId("rules").children]
            .filter(r => !r.hidden)
            .map(r => r.textContent)
        : null,
      download: shown("download")
        ? byId("download-box").getAttribute("aria-checked")
        : null,
      toast: text("toast-text"),
      refused: shown("toast") ? byId("toast").dataset.refused : null,
      // The shadow root's activeElement is null for anonymous content.
      focused:
        Services.focus.focusedElement?.getRootNode() === root
          ? Services.focus.focusedElement.id
          : null,
    };
  });
}

/**
 * Waits for the overlay to pass `check`.
 *
 * @param {Element} browser
 * @param {(state: ?object) => boolean} check
 * @param {string} what
 * @returns {Promise<?object>} the state that passed.
 */
async function overlayUntil(browser, check, what) {
  let state;
  await within(
    TestUtils.waitForCondition(async () => {
      state = await overlayState(browser);
      return check(state);
    }, what),
    10_000,
    what
  );
  return state;
}

/**
 * @param {Element} browser
 * @param {string} id An element of the page.
 * @returns {Promise<string>} its computed display.
 */
function displayOf(browser, id) {
  return SpecialPowers.spawn(
    browser,
    [id],
    target =>
      content.getComputedStyle(content.document.getElementById(target)).display
  );
}

/**
 * Clicks an element of the overlay where it is drawn.
 *
 * @param {Element} browser
 * @param {string} id The overlay element's id.
 */
async function clickOverlay(browser, id) {
  const { x, y } = await SpecialPowers.spawn(browser, [id], target => {
    const root =
      content.windowGlobalChild.getActor("SvalElementPicker").overlay;
    const rect = root.getElementById(target).getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await BrowserTestUtils.synthesizeMouseAtPoint(x, y, {}, browser);
}
