/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * What the files about extension notices share: the extensions panel opened
 * and closed as the product opens it, and its notices read back
 * (`SvalExtensionNotices`).
 */

const extensionsButton = (win = window) =>
  win.document.getElementById("unified-extensions-button");

const extensionsPanel = (win = window) => win.gUnifiedExtensions.panel;

/**
 * The notices the open panel shows, in order.
 *
 * @param {Window} [win]
 * @returns {Element[]}
 */
function noticeBars(win = window) {
  const container = win.document.getElementById(
    "unified-extensions-messages-container"
  );
  return [...(container?.querySelectorAll(".sval-extension-notice") ?? [])];
}

const barButtons = bar => [...bar.querySelectorAll("button")];

const noticeText = bar =>
  bar.querySelector(".sval-extension-notice-text")?.textContent ?? "";

/**
 * Resolves once the extensions panel has shown, and closes it when the task
 * ends.
 *
 * @param {Window} [win]
 * @returns {Promise}
 */
function extensionsPanelShown(win = window) {
  atTaskEnd(() => closeExtensionsPanel(win));
  return within(
    BrowserTestUtils.waitForPopupEvent(extensionsPanel(win), "shown"),
    10_000,
    "the extensions panel opening"
  );
}

/**
 * Opens the extensions panel, unless it is open, and closes it when the task
 * ends.
 *
 * @param {Window} [win]
 */
async function openExtensionsPanel(win = window) {
  if (extensionsPanel(win).state === "open") {
    atTaskEnd(() => closeExtensionsPanel(win));
    return;
  }
  const shown = extensionsPanelShown(win);
  await win.gUnifiedExtensions.openPanel();
  await shown;
}

/**
 * Closes the extensions panel, if it is open.
 *
 * @param {Window} [win]
 */
async function closeExtensionsPanel(win = window) {
  const panel = win.gUnifiedExtensions._panel;
  if (!panel || panel.state === "closed") {
    return;
  }
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  win.PanelMultiView.hidePopup(panel);
  await within(hidden, 10_000, "the extensions panel closing");
}

/**
 * Opens the panel and waits for it to show `count` notices, each with its
 * buttons drawn: a bar shows its action slot only once it has rendered.
 *
 * @param {number} count
 * @param {string} message
 * @param {Window} [win]
 * @returns {Promise<Element[]>}
 */
async function waitForBars(count, message, win = window) {
  await openExtensionsPanel(win);
  await within(
    TestUtils.waitForCondition(() => {
      const bars = noticeBars(win);
      return (
        bars.length === count &&
        bars.every(bar => barButtons(bar).every(BrowserTestUtils.isVisible))
      );
    }, message),
    10_000,
    message
  );
  return noticeBars(win);
}
