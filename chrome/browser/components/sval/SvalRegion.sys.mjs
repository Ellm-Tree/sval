/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The user's region, taken from the operating system (spec §10.9).
 *
 * Firefox asks a Mozilla server which country the user's IP address is in.
 * Sval does not make that request: its URL is blanked in app-sval-prefs.js.
 * It reads the region the user chose in their operating system's settings,
 * which is also right behind a VPN. Many features read the region, address
 * and card autofill among them, and an unknown region would leave those
 * silently off.
 *
 * `Region._setHomeRegion` is Firefox's own path for a changed home region: it
 * writes `browser.search.region` and notifies the search service. It is safe
 * whichever runs first. `Region.init` reads the pref this writes, and a
 * `Region` already initialised without a home takes the new one.
 */

import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Region: "resource://gre/modules/Region.sys.mjs",
});

const COUNTRY = /^[A-Z]{2}$/;

// Every window's panel calls in; the region is process-wide, so the first does
// it for the launch.
let applied = false;

/**
 * The first two-letter country in a list of BCP 47 locale tags.
 *
 * A region can be a UN M.49 area such as "419" (Latin America), which names no
 * single country, so those are skipped.
 *
 * @param {string[]} tags Locale tags, most preferred first.
 * @returns {?string} An ISO 3166 country code, or null.
 */
export function countryFromLocales(tags) {
  for (const tag of tags) {
    let region;
    try {
      region = new Intl.Locale(tag).region;
    } catch {
      continue;
    }
    if (region && COUNTRY.test(region)) {
      return region;
    }
  }
  return null;
}

export const SvalRegion = {
  /**
   * Sets Firefox's home region to the operating system's. Once per
   * launch, so a change in the system settings is followed on the next one.
   */
  applyFromOperatingSystem() {
    if (applied) {
      return;
    }
    applied = true;
    const osPrefs = Cc["@mozilla.org/intl/ospreferences;1"].getService(
      Ci.mozIOSPreferences
    );
    const region = countryFromLocales(osPrefs.regionalPrefsLocales);
    if (!region) {
      SvalLog.warn("the operating system names no country; region left unset");
      return;
    }
    lazy.Region._setHomeRegion(region);
  },
};
