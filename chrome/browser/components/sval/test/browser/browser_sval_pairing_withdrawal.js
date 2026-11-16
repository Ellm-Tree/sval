/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_pairing_helpers.js */

/**
 * Withdrawing a pairing offer as the offering page closes or moves, and
 * again after a withdrawal that failed (spec §6.7). The file shares a fresh
 * profile with `browser_sval_pairing_offer.js` (browser-pairing-offer.toml).
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_pairing_helpers.js",
  this
);

/**
 * Closes `ui`'s tab and resolves once its page is gone: `pagehide` is the
 * last of the page's own listeners to hear about it.
 *
 * @param {object} ui What `openSettingsPage` returned.
 */
async function closeSettingsPage(ui) {
  const hidden = BrowserTestUtils.waitForEvent(ui.page, "pagehide");
  BrowserTestUtils.removeTab(ui.tab);
  await within(hidden, 10_000, "the settings page's pagehide");
}

/**
 * A withdrawal from the page that failed, because the folder was away,
 * leaves the offer in the folder, so closing the page tries again.
 */
add_task(async function closing_the_page_retries_a_withdrawal_that_failed() {
  const us = await thisDevice("close-retry");
  const ui = await openSettingsPage("offer");
  await showACode(ui);
  const path = ui.settings._offer.path;

  const bringBack = await folderAway(us.root);
  ui.els.offerWithdraw.click();
  await TestUtils.waitForCondition(
    () => ui.els.offerStatus.dataset.said === "not-withdrawn",
    "the page says the withdrawal failed"
  );
  await bringBack();
  Assert.ok(await IOUtils.exists(path), "and the offer is still there");

  await closeSettingsPage(ui);
  await TestUtils.waitForCondition(
    async () => !(await IOUtils.exists(path)),
    "closing the page withdrew it"
  );
});

/**
 * Moving the offering page's tab into a window of its own is not closing it:
 * the offer stays, and so does the page's hold on it, until that window
 * closes.
 */
add_task(async function moving_the_offering_page_keeps_its_offer() {
  await thisDevice("move-page");
  const ui = await openSettingsPage("offer");
  await showACode(ui);
  const offer = ui.settings._offer;

  const opened = BrowserTestUtils.waitForNewWindow();
  gBrowser.replaceTabWithWindow(ui.tab);
  const win = await within(opened, 10_000, "the moved page's window");
  Assert.equal(ui.settings._offer, offer, "the page still holds its offer");
  Assert.ok(await IOUtils.exists(offer.path), "and it is still in the folder");

  await within(
    BrowserTestUtils.closeWindow(win),
    10_000,
    "the moved page's window's close"
  );
  await TestUtils.waitForCondition(
    async () => !(await IOUtils.exists(offer.path)),
    "closing it withdrew it"
  );
});
