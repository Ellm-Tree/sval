/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */

/**
 * Settings sync as the window's panel started it, over the profile's engine
 * (settings-sync spec §4.2).
 */

const { SvalSettingsSync } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSettingsSync.sys.mjs"
);

const PREF = "privacy.globalprivacycontrol.enabled";

add_setup(async function () {
  await within(SvalPanel.started, 40_000, "the panel's startup");
});

add_task(async function a_pref_change_lands_in_the_settings_document() {
  const { engine } = SvalPanel;
  Assert.equal(
    SvalSettingsSync.shared?.engine,
    engine,
    "settings sync runs over the window's engine"
  );
  const current = Services.prefs.getBoolPref(PREF);
  await SpecialPowers.pushPrefEnv({ set: [[PREF, !current]] });

  await TestUtils.waitForCondition(
    async () => (await engine.settings("settings"))[PREF] === !current,
    "the change is recorded in the settings document"
  );
  await SpecialPowers.popPrefEnv();
});

add_task(async function settings_sync_starts_once_per_process() {
  const first = SvalSettingsSync.shared?.sync;
  Assert.ok(first, "settings sync is running");
  // Every window's startup asks for it.
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    20_000,
    "a second window's opening"
  );
  expectWorkspaceTabs(win);
  await within(win.SvalPanel.started, 40_000, "its panel's startup");
  Assert.equal(SvalSettingsSync.shared.sync, first, "a second start reuses it");
});
