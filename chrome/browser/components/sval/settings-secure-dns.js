/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The Secure DNS card in Privacy and protection, drawn by
 * Firefox's `setting-group` like the rest of its settings. The choice is
 * `SvalSecureDns`'s, which the protection button's panel also offers. The
 * resolver, its status, the custom URL and the names that skip encrypted DNS
 * are Firefox's own DoH settings from `config/privacy.mjs`
 * (`dohProviderSelect`, `dohCustomProvider`, `dohStatusBox`,
 * `dohExceptionsButton`), so they keep Firefox's behaviour and the provider
 * list `DoHConfigController` gives them.
 *
 * Firefox's DoH group offers Default, Custom and Off, with fallback as a
 * checkbox under Custom; Sval offers its three choices as one radio group, so
 * the group is Sval's and its controls are Firefox's. Its provider select
 * reads the URL through `SvalSecureDns.canonicalURL`, so Mozilla's
 * Cloudflare URL reads as Cloudflare.
 *
 * `SvalPreferences` loads this as a classic script into the preferences page;
 * `settings-pane.js` calls `register` once the page's own settings exist.
 */

"use strict";

{
  const { SvalSecureDns, CHOICES, MODE_PREF } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSecureDns.sys.mjs"
  );

  const GROUP_ID = "svalSecureDns";

  window.SvalSecureDnsSettings = {
    GROUP_ID,

    register() {
      const { Preferences, SettingGroupManager } = window;
      if (Preferences.getSetting("svalSecureDnsChoice")) {
        return;
      }
      Preferences.addSetting({
        id: "svalSecureDnsChoice",
        pref: MODE_PREF,
        get: mode => SvalSecureDns.choiceOf(mode),
        set: value => SvalSecureDns.modeOf(value),
      });
      // The resolver and what goes with it matter only to encrypted DNS.
      Preferences.addSetting({
        id: "svalSecureDnsResolver",
        deps: ["svalSecureDnsChoice"],
        visible: ({ svalSecureDnsChoice }) =>
          svalSecureDnsChoice.value !== "network",
      });

      SettingGroupManager.registerGroups({
        [GROUP_ID]: {
          headingLevel: 2,
          controlAttrs: {
            label: "Secure DNS",
            description:
              "This setting controls how Sval looks up the sites you visit. It applies to every site and syncs to all your devices.",
            searchkeywords: "dns doh trr dns over https resolver ech",
          },
          items: [
            {
              id: "svalSecureDnsChoice",
              control: "moz-radio-group",
              controlAttrs: { "aria-label": "Secure DNS" },
              options: CHOICES.map(choice => ({
                value: choice.value,
                controlAttrs: {
                  label: choice.label,
                  description: choice.description,
                },
              })),
            },
            {
              id: "svalSecureDnsResolver",
              control: "moz-fieldset",
              controlAttrs: { label: "Resolver" },
              items: [
                {
                  id: "dohStatusBox",
                  control: "moz-message-bar",
                  controlAttrs: { role: "status" },
                },
                {
                  id: "dohProviderSelect",
                  l10nId: "preferences-doh-select-resolver-label",
                  control: "moz-select",
                },
                {
                  id: "dohCustomProvider",
                  control: "moz-input-text",
                  l10nId: "preferences-doh-custom-provider-label",
                },
                {
                  id: "dohExceptionsButton",
                  control: "moz-box-button",
                  controlAttrs: {
                    label: "Internal names",
                    description:
                      "These domains always use your network's DNS, like names on a home or work network.",
                  },
                },
              ],
            },
          ],
        },
      });
    },
  };
}
