/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

// What the site style tests share: the test page and its kinds, opening the
// editor, and reading the page.

const { STYLES_PREF, SvalSiteStyles } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteStyles.sys.mjs"
);
const { STYLE_PANEL_ID } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteStylePanel.sys.mjs"
);

const STYLE_PATH =
  "/browser/browser/components/sval/test/browser/sval_site_styles.html";
const STYLE_PAGE = `https://example.com${STYLE_PATH}`;

registerCleanupFunction(() => Services.prefs.clearUserPref(STYLES_PREF));

function byId(id) {
  return document.getElementById(id);
}

/** @returns {Element} the editor's panel. */
function editor() {
  return byId(STYLE_PANEL_ID);
}

/**
 * @param {Function} check
 * @param {string} what
 * @returns {Promise<void>} once `check` passes, bounded.
 */
function until(check, what) {
  return within(TestUtils.waitForCondition(check, what), 10_000, what);
}

/** @returns {Promise<Event>} the editor's next popupshown. */
function editorShown() {
  return within(
    BrowserTestUtils.waitForEvent(
      document,
      "popupshown",
      false,
      event => event.target.id === STYLE_PANEL_ID
    ),
    10_000,
    "the style editor showing"
  );
}

async function closeEditor() {
  const panel = editor();
  if (!panel || panel.state === "closed") {
    return;
  }
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  panel.hidePopup();
  await within(hidden, 10_000, "the style editor hiding");
}

/** Waits for the site controls to know the selected tab's page. */
function menuReady() {
  return until(
    () => !byId("sval-site-menu-button").disabled,
    "the site controls reading the page"
  );
}

/** Opens the editor from the site menu's Style row. */
async function openFromSiteMenu() {
  await menuReady();
  const menu = byId("sval-site-menu");
  const menuShown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  byId("sval-site-menu-button").click();
  await within(menuShown, 10_000, "the site menu showing");
  const shown = editorShown();
  byId("sval-site-style").click();
  await shown;
}

/**
 * @param {Element} browser
 * @param {number} x
 * @param {number} y
 * @returns {Promise<{r: number, g: number, b: number}>} the color the page is
 *   drawn with at (x, y), as the person sees it: Gecko applies a site style
 *   as it paints, which the page's computed styles never show.
 */
async function pixelAt(browser, x, y) {
  const snapshot = await within(
    browser.browsingContext.currentWindowGlobal.drawSnapshot(
      new DOMRect(x, y, 1, 1),
      1,
      "rgb(255, 0, 255)"
    ),
    10_000,
    "a snapshot of the page"
  );
  const canvas = document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "canvas"
  );
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d");
  context.drawImage(snapshot, 0, 0);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  snapshot.close();
  return { r, g, b };
}

/**
 * @param {Element} browser
 * @param {string} selector
 * @returns {Promise<{r: number, g: number, b: number}>} the color the centre
 *   of the page's element matching `selector` is drawn with.
 */
async function drawnAt(browser, selector) {
  const { x, y } = await SpecialPowers.spawn(browser, [selector], sel => {
    const rect = content.document.querySelector(sel).getBoundingClientRect();
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    };
  });
  return pixelAt(browser, x, y);
}

/**
 * @param {Element} browser
 * @returns {Promise<{r: number, g: number, b: number}>} the page's background
 *   as drawn, at a point of the body past its content.
 */
function drawnBackground(browser) {
  return pixelAt(browser, browser.clientWidth - 8, browser.clientHeight - 8);
}

/**
 * @param {{r: number, g: number, b: number}} color
 * @returns {number} its WCAG relative luminance.
 */
function luminance({ r, g, b }) {
  const [lr, lg, lb] = [r, g, b].map(v => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

/**
 * @param {object} a
 * @param {object} b
 * @returns {number} the WCAG contrast ratio of two colors.
 */
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * @param {object} a
 * @param {object} b
 * @param {number} [tolerance] What antialiasing and rounding move a channel.
 * @returns {boolean} whether the two colors are the same to the eye.
 */
function sameColor(a, b, tolerance = 3) {
  return ["r", "g", "b"].every(k => Math.abs(a[k] - b[k]) <= tolerance);
}

const WHITE_RGB = { r: 255, g: 255, b: 255 };

/**
 * Picks a theme in the editor as a person clicks it: on the item's own
 * control, the radio its shadow root holds. `MozVisualPickerItem.handleClick`
 * dispatches the click again on the item's host, which has no accessible of
 * its own, so the a11y checks are told the host is not what was clicked.
 *
 * @param {"auto"|"light"|"dark"} value
 */
async function pickTheme(value) {
  const item = byId(`sval-style-theme-${value}`);
  await item.updateComplete;
  AccessibilityUtils.setEnv({ mustHaveAccessibleRule: false });
  item.itemEl.click();
  AccessibilityUtils.resetEnv();
}
