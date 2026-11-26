/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */

/**
 * Settings › Extensions sets how long a background check holds an extension
 * update, and an extension's page shows an update it holds, with Update now
 * (SvalUpdateDelay).
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

const { SvalUpdateDelay, WAIT_PREF } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalUpdateDelay.sys.mjs"
);

const ID = "update-wait@sval.invalid";

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel starting");
});

async function installExtension() {
  const extension = ExtensionTestUtils.loadExtension({
    manifest: {
      name: "Update wait test extension",
      browser_specific_settings: { gecko: { id: ID } },
    },
    useAddonManager: "temporary",
  });
  await extension.startup();
  atTaskEnd(async () => {
    SvalUpdateDelay.forget(ID);
    await extension.unload();
  });
}

/** Holds version 2.0 for the extension, first seen now. */
function holdUpdate() {
  Services.prefs.setStringPref(
    `browser.sval.extensions.updateSeen.${ID}`,
    JSON.stringify({ version: "2.0", seen: Date.now() })
  );
}

async function openExtensionPage() {
  const ui = await openPane(
    "svalExtensions",
    ({ byId }) =>
      byId("sval-extensions-list").querySelector(`[data-extension-id="${ID}"]`),
    "the extension is listed"
  );
  ui.byId("sval-extensions-list")
    .querySelector(`[data-extension-id="${ID}"] .sval-extension-link`)
    .click();
  await TestUtils.waitForCondition(
    () =>
      ui.byId("sval-extension-cards").querySelector("[data-extension-card]"),
    "the extension's page shows"
  );
  ui.waitingRow = () =>
    ui
      .byId("sval-extension-cards")
      .querySelector('[data-row="extension-update-waiting"]');
  return ui;
}

add_task(async function test_wait_setting_writes_pref() {
  await SpecialPowers.pushPrefEnv({ set: [[WAIT_PREF, 7]] });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const ui = await openPane(
    "svalExtensions",
    ({ page }) =>
      page.document.querySelector(
        'setting-group[groupid="svalExtensionUpdates"] moz-input-number'
      ),
    "the update wait shows"
  );
  const field = ui.page.document.querySelector(
    'setting-group[groupid="svalExtensionUpdates"] moz-input-number'
  );
  Assert.equal(field.value, "7", "the field shows the set days");
  field.value = "3";
  field.dispatchEvent(new Event("change", { bubbles: true }));
  await TestUtils.waitForCondition(
    () => Services.prefs.getIntPref(WAIT_PREF) === 3,
    "the field writes the pref"
  );
  field.value = "0";
  field.dispatchEvent(new Event("change", { bubbles: true }));
  await TestUtils.waitForCondition(
    () => Services.prefs.getIntPref(WAIT_PREF) === 0,
    "0 is a wait"
  );
});

add_task(async function test_no_row_without_wait() {
  await installExtension();
  const ui = await openExtensionPage();
  Assert.ok(!ui.waitingRow(), "no update waits, so no row");
});

add_task(async function test_waiting_row_shows() {
  await installExtension();
  holdUpdate();
  const ui = await openExtensionPage();
  Assert.ok(ui.waitingRow(), "the held update shows");
  Assert.ok(
    ui.waitingRow().querySelector('[data-sval-key="page-update-now"]'),
    "with Update now"
  );
});

// The harness's update server answers no check, so Update now fails here;
// test_sval_update_delay_background.js covers an update installed or none
// offered.
add_task(async function test_update_now_failed_check_keeps_row() {
  await installExtension();
  holdUpdate();
  const ui = await openExtensionPage();
  const cards = ui.byId("sval-extension-cards");
  const failed = new Promise(resolve => {
    const observer = new MutationObserver(() => {
      if (ui.waitingRow()?.dataset.state === "failed") {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(cards, {
      subtree: true,
      childList: true,
      attributeFilter: ["data-state"],
    });
  });
  ui.waitingRow().querySelector('[data-sval-key="page-update-now"]').click();
  // The outcome waits on a request to the harness's HTTP server, which
  // AddonUpdateChecker bounds at 60 s. The bound gives that request the
  // seconds a loaded machine takes, inside half the file's limit.
  await within(failed, 20_000, "the row saying the update did not install");
  Assert.ok(ui.waitingRow(), "the update still waits");
  Assert.equal(SvalUpdateDelay.waiting(ID)?.version, "2.0");
});
