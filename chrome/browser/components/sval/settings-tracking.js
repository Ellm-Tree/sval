/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Firefox's tracking prefs in Privacy and protection, as the switches and
 * selects `SvalTrackingSettings` lists, each drawn from the prefs it writes:
 * the switches in More tracking protection, under Advanced, and the
 * fingerprinting select in the Fingerprinting card. The cookie choice is
 * Cookies and site data's (`settings-cookies.js`), which writes through
 * `_writeTracking`.
 *
 * `SvalPreferences` loads this as a classic script after `settings.js`; it
 * adds its methods to `SvalSettings`.
 */

"use strict";

{
  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    ContentBlockingPrefs:
      "moz-src:///browser/components/protections/ContentBlockingPrefs.sys.mjs",
    SvalTrackingSettings:
      "moz-src:///browser/components/sval/SvalTrackingSettings.sys.mjs",
  });

  /**
   * @param {string} name A boolean or integer pref.
   * @returns {boolean|number}
   */
  function readPref(name) {
    return Services.prefs.getPrefType(name) === Ci.nsIPrefBranch.PREF_INT
      ? Services.prefs.getIntPref(name)
      : Services.prefs.getBoolPref(name);
  }

  /**
   * Writes `value`, or clears the user value when `value` is the default:
   * `ContentBlockingPrefs.prefsMatch` reads a pref with a user value as
   * changed, whatever the value.
   *
   * @param {string} name
   * @param {boolean|number} value
   */
  function writePref(name, value) {
    const defaults = Services.prefs.getDefaultBranch("");
    const isInt = typeof value === "number";
    const fallback = isInt
      ? defaults.getIntPref(name, NaN)
      : defaults.getBoolPref(name, !value);
    if (value === fallback) {
      Services.prefs.clearUserPref(name);
    } else if (isInt) {
      Services.prefs.setIntPref(name, value);
    } else {
      Services.prefs.setBoolPref(name, value);
    }
  }

  /**
   * Writes tracking prefs, then lets Firefox's level read them.
   * `ContentBlockingPrefs` observes only some of these prefs, and a level
   * left at standard or strict is written back over them at the next start.
   *
   * @param {Array<[string, boolean|number]>} entries Each pref and its value.
   */
  function writeTracking(entries) {
    for (const [name, value] of entries) {
      writePref(name, value);
    }
    lazy.ContentBlockingPrefs.matchCBCategory();
  }

  /** The selects this file draws: every choice but the cookie one. */
  const SELECTS = () =>
    lazy.SvalTrackingSettings.CHOICES.filter(
      ([id]) => id !== lazy.SvalTrackingSettings.COOKIE_CHOICE
    );

  const SvalTrackingSettingsPane = {
    _writeTracking: writeTracking,

    /**
     * Finds and wires the tracking switches and selects.
     *
     * @param {Function} byId Finds one of the page's elements by id.
     * @param {SvalScope} lifetime Ends as the page goes.
     */
    _initTracking(byId, lifetime) {
      for (const [id, prefs] of lazy.SvalTrackingSettings.SWITCHES) {
        const input = byId(id);
        input.addEventListener("change", () => {
          // Each write redraws the switch from the prefs, so the choice is
          // read once, before the first.
          const index = input.checked ? 0 : 1;
          writeTracking(
            Object.entries(prefs).map(([name, values]) => [name, values[index]])
          );
        });
      }
      for (const [id, options] of SELECTS()) {
        const select = byId(id);
        select.addEventListener("change", () => {
          const chosen = options.find(([value]) => value === select.value);
          if (chosen) {
            const [, prefs, also] = chosen;
            writeTracking(Object.entries({ ...prefs, ...also }));
          }
        });
      }
      // Firefox's tracking prefs move from about:config.
      const trackingPref = () => this._describeTracking();
      for (const name of lazy.SvalTrackingSettings.PREFS) {
        lifetime.pref(name, trackingPref);
      }
    },

    /** The tracking switches and selects, each from the prefs it writes. */
    _describeTracking() {
      for (const [id, prefs] of lazy.SvalTrackingSettings.SWITCHES) {
        document.getElementById(id).checked = Object.entries(prefs).every(
          ([name, [on]]) => readPref(name) === on
        );
      }
      for (const [id, options] of SELECTS()) {
        const shown = options.find(([, prefs]) =>
          Object.entries(prefs).every(
            ([name, value]) => readPref(name) === value
          )
        );
        document.getElementById(id).value = shown?.[0] ?? "";
      }
    },
  };

  Object.assign(window.SvalSettings, SvalTrackingSettingsPane);
}
