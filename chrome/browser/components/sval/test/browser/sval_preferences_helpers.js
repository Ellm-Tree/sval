/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * What the about:preferences test files share: opening settings the way the
 * panel does, finding a category's pane, and choosing the window's shared
 * folder through its panel. Each file loads this with `loadSubScript` into
 * its own scope.
 */

/* exported panelWithFolder, openSettings, openPane, closeSettings, paneOf, assertShownLabel, atTwiceTheText, assertPaneFits, assertRowFits */

/** Closes every settings tab, so a task starts from a page of its own. */
function closeSettings() {
  for (const tab of [...gBrowser.tabs]) {
    if (tab.linkedBrowser.currentURI?.spec.startsWith("about:preferences")) {
      BrowserTestUtils.removeTab(tab);
    }
  }
}

/**
 * Makes `path` the window's shared folder, chosen as Settings' Change… does
 * on a device that holds a sync key, and stops sharing when the task ends.
 * Null stops sharing now.
 *
 * A device without a key adopts one first, as pairing does, and the panel
 * reads it from the store as Allow Access does. A device that makes its key
 * in the choice offers its backup in a dialog
 * (`SvalPanel._offerBackupLater`), which would hold the window's focus past
 * the task.
 *
 * @param {string|null} path
 * @returns {Promise<object>} `chooseSharedFolder`'s answer.
 */
async function panelWithFolder(path) {
  if (path !== null) {
    const { SvalIdentity } = ChromeUtils.importESModule(
      "moz-src:///browser/components/sval/SvalIdentity.sys.mjs"
    );
    const { present } = SvalIdentity.SYNC_KEY_STATES;
    if ((await SvalIdentity.syncKey()).state !== present) {
      await SvalIdentity.adoptSyncKey(
        crypto.getRandomValues(new Uint8Array(32))
      );
    }
    if (SvalPanel.syncKeyState !== present) {
      await within(SvalPanel.run("retrySyncKey"), 30_000, "the key read");
    }
    atTaskEnd(() =>
      within(SvalPanel.chooseSharedFolder(null), 10_000, "sharing stopping")
    );
  }
  return within(
    SvalPanel.chooseSharedFolder(path, { mint: true }),
    30_000,
    "the shared folder chosen"
  );
}

/**
 * Opens settings the way the panel does and waits for Sval's panes.
 *
 * @param {string} [section]
 * @returns {Promise<object>} `{ tab, page, settings, byId }`.
 */
async function openSettings(section) {
  closeSettings();
  const tab = expectOpened(SvalPanel.openSettingsPage(section));
  await TestUtils.waitForCondition(
    () => tab.linkedBrowser.contentWindow?.SvalSettings?._els,
    "about:preferences loaded with Sval's panes"
  );
  registerCleanupFunction(() => {
    if (tab.parentNode) {
      BrowserTestUtils.removeTab(tab);
    }
  });
  const page = tab.linkedBrowser.contentWindow;
  return {
    tab,
    page,
    settings: page.SvalSettings,
    byId: id => page.document.getElementById(id),
  };
}

/**
 * Opens settings afresh on `category` and waits until `ready` holds.
 *
 * @param {string} category A friendly name, such as `privacy`.
 * @param {Function} ready Given the page's `{ page, byId }`; true once the
 *   part under test is drawn.
 * @param {string} what What `ready` waits for.
 * @returns {Promise<object>} as {@link openSettings}.
 */
async function openPane(category, ready, what) {
  const ui = await openSettings();
  await showPane(ui.page, category);
  await TestUtils.waitForCondition(() => ready(ui), what);
  return ui;
}

/**
 * The container `preferences.js` shows for `category`: Sval's own, or
 * Firefox's `setting-pane`, which holds Sval's sections in it once shown.
 *
 * @param {Window} page
 * @param {string} category A friendly name, such as `svalSync` or `privacy`.
 * @returns {Element}
 */
function paneOf(page, category) {
  const name = `pane${category[0].toUpperCase()}${category.slice(1)}`;
  return page.document.querySelector(
    `.sval-pane[data-category="${name}"]:not(.sval-pane-section), setting-pane[data-category="${name}"]`
  );
}

/**
 * Asserts that `input` has a shown label with words in it, and that the
 * accessibility tree names the field with that label.
 *
 * @param {HTMLInputElement} input
 */
async function assertShownLabel(input) {
  const [label] = input.labels;
  Assert.ok(label?.checkVisibility(), "the field's label is shown");
  const text = label.textContent.replace(/\s+/g, " ").trim();
  Assert.ok(text, "with words in it");
  const acc = await accessibleOf(input);
  Assert.equal(acc.name, text, "the label names the field");
}

/**
 * Shows the settings page at twice the text size until the task ends, as a
 * user who zooms text alone sees it (WCAG 2.2 success criteria 1.4.4 and
 * 1.4.10).
 *
 * @param {object} ui From `openSettings`.
 */
function atTwiceTheText(ui) {
  const browsingContext = ui.tab.linkedBrowser.browsingContext;
  browsingContext.textZoom = 2;
  atTaskEnd(() => (browsingContext.textZoom = 1));
}

/**
 * Asserts that the category showing fits the window's width, so reading it
 * needs no scrolling sideways.
 *
 * @param {object} ui From `openSettings`.
 * @param {string} what The category.
 */
function assertPaneFits(ui, what) {
  const main = ui.page.document.querySelector(".main-content");
  Assert.lessOrEqual(
    main.scrollWidth,
    main.clientWidth,
    `${what} fits the window's width`
  );
}

/**
 * Asserts that an add row's label, field, choices and buttons each show
 * their text whole, inside the row.
 *
 * @param {Element} row The `.sval-agent-adding` row.
 * @param {string} what The row, for the messages.
 */
function assertRowFits(row, what) {
  const edge = row.getBoundingClientRect();
  for (const control of row.querySelectorAll("label, input, select, button")) {
    // A control the row hides, such as the scope of a site, takes no room.
    if (!control.checkVisibility()) {
      continue;
    }
    const name = `${what}: ${control.localName} "${control.textContent || control.placeholder}"`;
    Assert.lessOrEqual(
      control.scrollHeight,
      control.clientHeight,
      `${name} shows its text whole`
    );
    const box = control.getBoundingClientRect();
    Assert.ok(
      box.left >= edge.left && box.right <= edge.right,
      `${name} is inside the row`
    );
  }
}
