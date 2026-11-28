/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Cookies and site data in Privacy and protection (decision 1484), drawn by
 * Firefox's `setting-group` like the rest of its settings: which cookies sites
 * may set, then Firefox's own controls for the data they keep, from
 * `config/privacy.mjs`'s `cookiesAndSiteData2` group (`siteDataSize`,
 * `clearSiteDataButton`, `deleteOnClose`), so they keep Firefox's
 * behaviour. Firefox's site data list and cookie exceptions are left out:
 * Sites lists the sites storing data (Storing data), and each site's page
 * sets that site's cookies. The cookie choice is
 * `SvalTrackingSettings`' `sval-cookies`, written as Sval writes every
 * tracking pref (`settings-tracking.js`).
 *
 * `SvalPreferences` loads this as a classic script into the preferences page;
 * `settings-pane.js` calls `register` once the page's own settings exist.
 */

"use strict";

{
  const { CHOICES, COOKIE_CHOICE } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalTrackingSettings.sys.mjs"
  );

  const GROUP_ID = "svalCookies";
  const COOKIE_PREF = "network.cookie.cookieBehavior";

  /** What each `network.cookie.cookieBehavior` value is called. */
  const WORDS = new Map([
    [Ci.nsICookieService.BEHAVIOR_ACCEPT, "Allow every cookie"],
    [
      Ci.nsICookieService.BEHAVIOR_PARTITION_FOREIGN,
      "Keep each site's cookies to that site",
    ],
    [
      Ci.nsICookieService.BEHAVIOR_REJECT_TRACKER,
      "Block cookies from trackers",
    ],
    [
      Ci.nsICookieService.BEHAVIOR_LIMIT_FOREIGN,
      "Block cookies from sites you haven't visited",
    ],
    [
      Ci.nsICookieService.BEHAVIOR_REJECT_FOREIGN,
      "Block cookies from other sites",
    ],
    [Ci.nsICookieService.BEHAVIOR_REJECT, "Block every cookie"],
  ]);

  const OPTIONS = new Map(CHOICES)
    .get(COOKIE_CHOICE)
    .map(([value, prefs, also]) => ({ value, prefs, also }));

  window.SvalCookiesSettings = {
    GROUP_ID,

    register() {
      const { Preferences, SettingGroupManager } = window;
      if (Preferences.getSetting("svalCookieBehavior")) {
        return;
      }
      Preferences.addSetting({
        id: "svalCookieBehavior",
        get: () =>
          OPTIONS.find(option =>
            Object.entries(option.prefs).every(
              ([name, value]) => Services.prefs.getIntPref(name) === value
            )
          )?.value ?? "",
        set: value => {
          const option = OPTIONS.find(o => o.value === value);
          if (option) {
            window.SvalSettings._writeTracking(
              Object.entries({ ...option.prefs, ...option.also })
            );
          }
        },
        setup: emitChange => {
          Services.prefs.addObserver(COOKIE_PREF, emitChange);
          return () => Services.prefs.removeObserver(COOKIE_PREF, emitChange);
        },
      });

      SettingGroupManager.registerGroups({
        [GROUP_ID]: {
          subcategory: "sitedata",
          headingLevel: 2,
          iconSrc: "chrome://browser/skin/controlcenter/3rdpartycookies.svg",
          controlAttrs: {
            label: "Cookies and site data",
            searchkeywords: "cookies site data storage third party",
          },
          items: [
            {
              id: "svalCookieBehavior",
              control: "moz-select",
              controlAttrs: { label: "Cookies" },
              options: OPTIONS.map(({ value }) => ({
                value,
                controlAttrs: { label: WORDS.get(Number(value)) },
              })),
            },
            {
              id: "siteDataSize",
              l10nId: "sitedata-total-size-calculating",
              control: "moz-box-item",
              supportPage: "sitedata-learn-more",
            },
            {
              id: "manageDataSettingsGroup",
              control: "moz-box-group",
              controlAttrs: { type: "default" },
              items: [
                {
                  id: "clearSiteDataButton",
                  l10nId: "sitedata-clear2",
                  control: "moz-box-button",
                  iconSrc: "chrome://browser/skin/flame.svg",
                },
              ],
            },
            { id: "deleteOnClose", l10nId: "sitedata-delete-on-close2" },
          ],
        },
      });
    },
  };
}
