/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { SvalRegion, countryFromLocales } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalRegion.sys.mjs"
);
const { Region } = ChromeUtils.importESModule(
  "resource://gre/modules/Region.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);
const { within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);

do_get_profile();

/**
 * Spec §10.9: the region is the one the user chose in the operating system.
 * The first tag that names a country wins. A tag without one, an area code
 * such as Latin America's "419", or a tag Intl cannot parse is passed over
 * and the search goes on.
 */
add_task(function the_first_country_named_wins() {
  Assert.equal(countryFromLocales(["en-GB", "en-US"]), "GB");
  Assert.equal(countryFromLocales(["de", "fr-CH"]), "CH");
  Assert.equal(countryFromLocales(["es-419", "es-MX"]), "MX");
  Assert.equal(countryFromLocales(["not a locale!", "ja-JP"]), "JP");
  Assert.equal(countryFromLocales(["en", "fr"]), null);
  Assert.equal(countryFromLocales([]), null);
});

const osCountry = () =>
  countryFromLocales(
    Cc["@mozilla.org/intl/ospreferences;1"].getService(Ci.mozIOSPreferences)
      .regionalPrefsLocales
  );

/**
 * Setting the region goes through Firefox's own path for a changed home
 * region, so `Region.home` answers with it and the search service hears of
 * it. Writing the pref alone would leave an initialised `Region` unaware.
 * Skipped on a machine whose operating system names no country.
 */
add_task(
  { skip_if: () => !osCountry() },
  async function the_operating_system_region_becomes_home() {
    const expected = osCountry();
    Services.prefs.clearUserPref("browser.search.region");
    const notified = TestUtils.topicObserved(Region.REGION_TOPIC);

    SvalRegion.applyFromOperatingSystem();

    Assert.equal(Region.home, expected);
    Assert.equal(Services.prefs.getCharPref("browser.search.region"), expected);
    const [subject] = await within(
      notified,
      5_000,
      "the region's change notification"
    );
    Assert.equal(subject.QueryInterface(Ci.nsISupportsString).data, expected);
  }
);
