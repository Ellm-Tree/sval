/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * General's Battery Saver: when `SvalBatterySaver` turns on, as one radio
 * group over its mode pref. The header's Battery Saver popover links here,
 * as `paneSync-batterySaver`, which `settings-pane.js` hands to {@link show}.
 *
 * `SvalPreferences` loads this as a classic script into the preferences page;
 * `settings-pane.js` calls `register` once the page's own settings exist.
 */

"use strict";

{
  const { MODE_PREF } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalBatterySaver.sys.mjs"
  );

  const GROUP_ID = "svalBatterySaver";
  const SETTING_ID = "svalBatterySaverMode";

  window.SvalBatterySaverSettings = {
    GROUP_ID,

    register() {
      const { Preferences, SettingGroupManager } = window;
      if (Preferences.getSetting(SETTING_ID)) {
        return;
      }
      Preferences.addAll([{ id: MODE_PREF, type: "string" }]);
      Preferences.addSetting({ id: SETTING_ID, pref: MODE_PREF });

      SettingGroupManager.registerGroups({
        [GROUP_ID]: {
          headingLevel: 2,
          controlAttrs: {
            label: "Battery Saver",
            description:
              "Battery Saver makes your battery last longer. While Battery Saver is on, Sval draws fewer frames on a fast screen, slows tabs in the background, and puts a Workspace to sleep 30 minutes after you leave it.",
            searchkeywords: "battery saver power energy plugged unplugged",
          },
          items: [
            {
              id: SETTING_ID,
              control: "moz-radio-group",
              controlAttrs: { label: "Turn on Battery Saver" },
              options: [
                {
                  value: "unplugged",
                  controlAttrs: { label: "When your computer is on battery" },
                },
                { value: "always", controlAttrs: { label: "Always" } },
                { value: "never", controlAttrs: { label: "Never" } },
              ],
            },
          ],
        },
      });
    },

    /**
     * Whether the group is configured, and a `show` asked for before it was.
     * `preferences.js` shows the section the address names as the page
     * starts, which can be before the panes' markup arrives.
     */
    _ready: false,
    _showPending: false,

    /** After `initSettingGroup` configures the group: runs a waiting `show`. */
    async ready() {
      this._ready = true;
      if (this._showPending) {
        this._showPending = false;
        await this.show();
      }
    },

    /** Scrolls to the group and puts the caret on its choice. */
    async show() {
      if (!this._ready) {
        this._showPending = true;
        return;
      }
      const group = document.querySelector(
        `setting-group[groupid="${GROUP_ID}"]`
      );
      if (!group) {
        return;
      }
      // Firefox's setting-group draws its controls after it is configured.
      await group.updateComplete;
      group.scrollIntoView();
      group
        .querySelector(`#setting-control-${SETTING_ID} moz-radio-group`)
        ?.focus();
    },
  };
}
