/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * What the site page's test files share: its address, opening a settings
 * tab, waiting for the page, and reading its parts. Each file loads this
 * with `loadSubScript` into its own scope.
 */

/* exported PAGE_URL, until, change, partsOf, untilSitePage, openAt */

const PAGE_URL = site => `about:preferences#svalSites-site?host=${site}`;

/**
 * @param {Function} check
 * @param {string} what
 * @returns {Promise<void>} once `check` passes, bounded.
 */
function until(check, what) {
  return within(TestUtils.waitForCondition(check, what), 10_000, what);
}

function change(select, value) {
  select.value = value;
  select.dispatchEvent(new Event("change"));
}

/**
 * @param {Window} page
 * @returns {object} The page's parts.
 */
function partsOf(page) {
  const doc = page.document;
  const byKey = key => doc.querySelector(`[data-sval-key="${key}"]`);
  return {
    doc,
    byId: id => doc.getElementById(id),
    byKey,
    shown: () => doc.getElementById("sval-site-page")?.checkVisibility(),
    sitesShown: () => doc.getElementById("sval-sites")?.checkVisibility(),
    title: () => doc.getElementById("sval-site-title")?.textContent,
  };
}

/**
 * Waits for the page to show `site`.
 *
 * @param {Window} page
 * @param {string} site
 */
async function untilSitePage(page, site) {
  const ui = partsOf(page);
  await until(
    () => ui.shown() && ui.title() === site,
    `the page for ${site} showing`
  );
  return ui;
}

/**
 * Opens a settings tab at `url` and waits for Sval's panes.
 *
 * @param {string} url
 * @returns {Promise<{tab: Element, page: Window}>}
 */
async function openAt(url) {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, url),
    15_000,
    "the settings tab opening"
  );
  atTaskEnd(() => {
    if (tab.parentNode) {
      BrowserTestUtils.removeTab(tab);
    }
  });
  const page = tab.linkedBrowser.contentWindow;
  await until(
    () => page.document?.documentElement?.dataset.svalSettings === "ready",
    "Sval's panes loading"
  );
  return { tab, page };
}
