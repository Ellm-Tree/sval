/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Protections' tracking settings as data: the switches and selects the
 * settings page draws, and the values settings sync takes for the prefs they
 * write, both read from the one table (protections spec §3.3). A value the
 * settings page cannot show is not one sync applies, and a choice the page
 * offers is one sync carries.
 */

/**
 * Firefox's tracking protection prefs that are one switch each: the ones
 * its Strict level sets (`ContentBlockingPrefs.setPrefExpectations`) and
 * the ones its Enhanced Tracking Protection pages reached, which Sval's
 * cards replace (protections spec §3.3), apart from those that ran on
 * Disconnect's lists, which Sval does not run (decision 1051). Each switch's
 * id, then every pref it writes with its value on and off. A switch is on
 * while every pref it writes reads on.
 */
export const SWITCHES = [
  [
    "sval-query-stripping",
    {
      "privacy.query_stripping.enabled": [true, false],
      "privacy.query_stripping.enabled.pbmode": [true, false],
    },
  ],
  [
    "sval-bounce-tracking",
    {
      "privacy.bounceTrackingProtection.mode": [
        Ci.nsIBounceTrackingProtection.MODE_ENABLED,
        Ci.nsIBounceTrackingProtection.MODE_ENABLED_DRY_RUN,
      ],
    },
  ],
  [
    "sval-referrer-trim",
    {
      "network.http.referer.disallowCrossSiteRelaxingDefault.top_navigation": [
        true,
        false,
      ],
    },
  ],
];

/** The id of the cookie choice in `CHOICES`. */
export const COOKIE_CHOICE = "sval-cookies";

/**
 * The rest of those prefs, which take one of several settings: each
 * select's id, then its options. An option shows while every pref in its
 * `prefs` reads as given; choosing it writes those and `also`, the prefs
 * Firefox's own control moved with them (`etpCustomize` in
 * `browser/components/preferences/config/privacy.mjs`). Gecko applies a
 * protection's every-window pref in private windows too
 * (`BrowsingContext::GetUseTrackingProtection`, `IsFPPEnabled` in
 * `nsRFPService.cpp`), so "all" reads that pref alone.
 */
export const CHOICES = [
  [
    "sval-fp-windows",
    [
      [
        "all",
        { "privacy.fingerprintingProtection": true },
        { "privacy.fingerprintingProtection.pbmode": true },
      ],
      [
        "private",
        {
          "privacy.fingerprintingProtection": false,
          "privacy.fingerprintingProtection.pbmode": true,
        },
        {},
      ],
      [
        "off",
        {
          "privacy.fingerprintingProtection": false,
          "privacy.fingerprintingProtection.pbmode": false,
        },
        {},
      ],
    ],
  ],
  [
    COOKIE_CHOICE,
    [
      Ci.nsICookieService.BEHAVIOR_ACCEPT,
      Ci.nsICookieService.BEHAVIOR_PARTITION_FOREIGN,
      Ci.nsICookieService.BEHAVIOR_REJECT_TRACKER,
      Ci.nsICookieService.BEHAVIOR_LIMIT_FOREIGN,
      Ci.nsICookieService.BEHAVIOR_REJECT_FOREIGN,
      Ci.nsICookieService.BEHAVIOR_REJECT,
    ].map(value => [
      String(value),
      { "network.cookie.cookieBehavior": value },
      {},
    ]),
  ],
];

/** Every pref the tracking switches and selects write. */
export const PREFS = [
  ...new Set([
    ...SWITCHES.flatMap(([, prefs]) => Object.keys(prefs)),
    ...CHOICES.flatMap(([, options]) =>
      options.flatMap(([, prefs, also]) => [
        ...Object.keys(prefs),
        ...Object.keys(also),
      ])
    ),
  ]),
];

/**
 * pref -> `accepts(value)` for `SvalSettingsRegistry.VALUE_RULES`: a synced
 * value applies only when it is one the switches and selects write, so a
 * value this device's settings could not show leaves its own as it is.
 */
export const SYNC_RULES = Object.freeze(
  Object.fromEntries(
    PREFS.map(name => {
      const values = new Set([
        ...SWITCHES.flatMap(([, prefs]) => prefs[name] ?? []),
        ...CHOICES.flatMap(([, options]) =>
          options.flatMap(([, prefs, also]) =>
            [prefs, also].filter(set => name in set).map(set => set[name])
          )
        ),
      ]);
      return [name, Object.freeze({ accepts: value => values.has(value) })];
    })
  )
);

export const SvalTrackingSettings = Object.freeze({
  SWITCHES,
  CHOICES,
  COOKIE_CHOICE,
  PREFS,
  SYNC_RULES,
});
