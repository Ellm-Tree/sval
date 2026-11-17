/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Sval's cards in About: release candidates, and in About's Advanced the
 * diagnostics log level and the way to about:config.
 *
 * `SvalPreferences` loads this as a classic script after `settings.js`; it
 * adds its methods to `SvalSettings`.
 */

"use strict";

{
  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
    SVAL_LOG_LEVEL_PREF: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
    UpdateUtils: "resource://gre/modules/UpdateUtils.sys.mjs",
  });

  const SvalAdvancedSettings = {
    /**
     * Finds and wires the Advanced preferences, Release candidates and Diagnostics cards.
     *
     * @param {Function} byId Finds one of the page's elements by id.
     * @param {SvalScope} lifetime Ends as the page goes.
     */
    _initAdvanced(byId, lifetime) {
      Object.assign(this._els, {
        advancedOpen: byId("sval-advanced-open"),
        releaseCandidatesCard: byId("sval-release-candidates-card"),
        logLevel: byId("sval-loglevel"),
      });
      this._els.advancedOpen.addEventListener("click", () =>
        window.browsingContext.topChromeWindow?.openTrustedLinkIn(
          "about:config",
          "tab"
        )
      );
      this._els.logLevel.addEventListener("change", () =>
        Services.prefs.setStringPref(
          lazy.SVAL_LOG_LEVEL_PREF,
          this._els.logLevel.value
        )
      );
      // The log level moves from about:config.
      lifetime.pref(lazy.SVAL_LOG_LEVEL_PREF, () => this._describeDisplay());
    },

    /**
     * The diagnostics log level, and whether the release candidates card
     * shows: only where Sval updates itself on the release channel, the
     * condition Firefox's own update settings show on
     * (`UpdatesHelpers.showUpdatesSettings`). A .deb or .rpm updates through
     * its package manager, and a development build never updates.
     */
    _describeDisplay() {
      this._els.logLevel.value = Services.prefs.getStringPref(
        lazy.SVAL_LOG_LEVEL_PREF
      );
      this._els.releaseCandidatesCard.hidden = !(
        lazy.AppConstants.MOZ_UPDATER &&
        !Services.sysinfo.getProperty("isPackagedApp") &&
        lazy.UpdateUtils.UpdateChannel === "release"
      );
    },
  };

  Object.assign(window.SvalSettings, SvalAdvancedSettings);
}
