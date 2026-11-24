/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { SvalSettingsRegistry } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSettingsRegistry.sys.mjs"
);

add_task(function the_list_has_every_synced_pref() {
  Assert.equal(SvalSettingsRegistry.SYNCED_PREFS.length, 159);
});

// Synced prefs that have no default on the default branch of an xpcshell run.
// Every other synced pref must have one.
const NO_STATIC_DEFAULT = new Set([
  // Read only with a fallback (NewTabUtils' `Storage.get`, TopSites'
  // TOP_SITES_ROWS_PREF reads).
  "browser.newtabpage.pinned",
  "browser.newtabpage.activity-stream.topSitesRows",
  // No default by design: only ever set by the user (sanitizeDialog.js).
  "spellchecker.dictionary",
  "privacy.clearOnShutdown_v2.downloads",
  // Read only with a fallback (RFPHelper's letterboxing observer).
  "privacy.resistFingerprinting.letterboxing",
]);

// A fingerprinting switch's choice has no default by design: unset is Sval's
// default, which is whatever this build's overrides string says.
const CHOICE_BRANCH = "browser.sval.fingerprinting.switch.";

add_task(function every_synced_pref_exists_in_this_build() {
  // An ESR rebase that removes a pref must fail here rather than leave a key
  // that syncs to nothing (settings-sync spec §5).
  const defaults = Services.prefs.getDefaultBranch("");
  const missing = SvalSettingsRegistry.SYNCED_PREFS.filter(
    name =>
      !NO_STATIC_DEFAULT.has(name) &&
      !name.startsWith(CHOICE_BRANCH) &&
      defaults.getPrefType(name) === Ci.nsIPrefBranch.PREF_INVALID
  );
  Assert.deepEqual(
    missing,
    [],
    "every synced pref outside NO_STATIC_DEFAULT has a default in this build"
  );
});

add_task(function fingerprinting_settings_sync_but_per_device_ones() {
  const { PREFS, SYNCED_PREFS } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalFingerprinting.sys.mjs"
  );
  // Per device: proxy-only kills calls on a synced machine with no proxy, a
  // frame rate belongs to a display, and each device composes its own
  // overrides string from its build's defaults and the synced switches.
  const local = [
    "media.peerconnection.ice.proxy_only",
    "layout.frame_rate",
    "privacy.fingerprintingProtection.overrides",
  ];
  for (const name of local) {
    Assert.ok(
      !SvalSettingsRegistry.SYNCED_PREFS.includes(name),
      `${name} stays on its device`
    );
  }
  Assert.deepEqual(
    PREFS.filter(name => !local.includes(name)),
    SYNCED_PREFS,
    "every other pref the settings write syncs"
  );
  for (const name of SYNCED_PREFS) {
    Assert.ok(
      SvalSettingsRegistry.SYNCED_PREFS.includes(name),
      `${name} syncs`
    );
  }
});

add_task(function no_static_default_entries_are_synced_prefs() {
  const unlisted = [...NO_STATIC_DEFAULT].filter(
    name => !SvalSettingsRegistry.SYNCED_PREFS.includes(name)
  );
  Assert.deepEqual(unlisted, [], "NO_STATIC_DEFAULT names only synced prefs");
});

add_task(function no_dropped_pref_is_listed() {
  for (const name of [
    "browser.startup.page",
    "browser.contentblocking.category",
    "extensions.activeThemeID",
    "privacy.userContext.enabled",
    "signon.autofillForms",
    "signon.generation.enabled",
    "signon.rememberSignons",
    "ui.osk.enabled",
  ]) {
    Assert.ok(
      !SvalSettingsRegistry.SYNCED_PREFS.includes(name),
      `${name} is dropped by spec §5.2`
    );
  }
});
