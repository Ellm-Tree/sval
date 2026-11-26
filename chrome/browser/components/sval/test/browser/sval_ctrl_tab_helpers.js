/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * What the Ctrl+Tab switcher's tests share: holding Ctrl+Tab until the
 * switcher shows, letting Ctrl go, and reading the switcher as the user sees
 * it, by its options' titles.
 */

/**
 * A served page titled `title`, which a tab restores at as it would at any
 * web address (`SvalRestore`).
 *
 * @param {string} title
 * @returns {string}
 */
function titledPage(title) {
  return `${ROOT}sval_switcher_page.sjs?${encodeURIComponent(
    `<title>${title}</title>`
  )}`;
}

/** @returns {Element|null} The switcher, once the window has drawn it. */
function switcherRoot() {
  return document.getElementById("sval-tab-switcher");
}

/** @returns {boolean} Whether the switcher shows. */
function switcherShown() {
  const root = switcherRoot();
  return !!root && !root.hidden;
}

/** @returns {Element[]} The switcher's options, in order. */
function switcherOptions() {
  return [
    ...document.querySelectorAll("#sval-tab-switcher-list > [role=option]"),
  ];
}

/**
 * @param {Element} option
 * @returns {string} The title the option shows.
 */
function optionTitle(option) {
  return option.getAttribute("aria-label");
}

/** @returns {string|null} The title of the option selected. */
function selectedTitle() {
  const option = document.querySelector(
    "#sval-tab-switcher-list > [aria-selected=true]"
  );
  return option ? optionTitle(option) : null;
}

/**
 * Presses Ctrl+Tab `times` times with Ctrl held, and waits for the switcher
 * to show.
 *
 * @param {number} [times]
 */
async function holdCtrlTab(times = 1) {
  for (let i = 0; i < times; i++) {
    EventUtils.synthesizeKey("KEY_Tab", { ctrlKey: true });
  }
  await TestUtils.waitForCondition(() => switcherShown(), "the switcher shows");
}

/** Lets Ctrl go, which picks the selected tab while the switcher shows. */
async function releaseCtrl() {
  EventUtils.synthesizeKey("KEY_Control", { type: "keyup" });
  await switchDone(window);
}

// Firefox records that Ctrl+Tab was used (`ctrlTab.onKeyDown`).
registerCleanupFunction(() =>
  Services.prefs.clearUserPref("browser.engagement.ctrlTab.has-used")
);
