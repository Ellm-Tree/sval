/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Archiving idle tabs in Workspaces (idle-tab archive spec §5), drawn by
 * Firefox's `setting-group` like the rest of its settings. Both are synced
 * prefs (`SvalArchive`): checking the box chooses 7 days, and how long the
 * Archive keeps a tab is always offered, because a workspace's own choice can
 * archive while the box is clear.
 *
 * `SvalPreferences` loads this as a classic script into the preferences page;
 * `settings-pane.js` calls `register` once the page's own settings exist.
 */

"use strict";

{
  const {
    ARCHIVE_TIMES,
    AUTO_ARCHIVE_PREF,
    DEFAULT_CHOICE,
    NEVER,
    RETENTION_DAYS,
    RETENTION_PREF,
  } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalArchive.sys.mjs"
  );

  const GROUP_ID = "svalTabArchive";

  window.SvalArchiveSettings = {
    GROUP_ID,

    register() {
      const { Preferences, SettingGroupManager } = window;
      if (Preferences.getSetting("svalAutoArchive")) {
        return;
      }
      Preferences.addAll([
        { id: AUTO_ARCHIVE_PREF, type: "string" },
        { id: RETENTION_PREF, type: "int" },
      ]);
      Preferences.addSetting({
        id: "svalAutoArchive",
        pref: AUTO_ARCHIVE_PREF,
        get: choice => choice !== NEVER,
        set: on => (on ? DEFAULT_CHOICE : NEVER),
      });
      Preferences.addSetting({
        id: "svalAutoArchiveAfter",
        pref: AUTO_ARCHIVE_PREF,
        deps: ["svalAutoArchive"],
        disabled: ({ svalAutoArchive }) => !svalAutoArchive.value,
        get: choice => (choice === NEVER ? DEFAULT_CHOICE : choice),
      });
      Preferences.addSetting({
        id: "svalArchiveRetention",
        pref: RETENTION_PREF,
        get: days => String(days),
        set: days => Number(days),
      });

      SettingGroupManager.registerGroups({
        [GROUP_ID]: {
          headingLevel: 2,
          controlAttrs: {
            label: "Idle tabs",
            description:
              "Tabs you haven't used on any device leave their Workspace. You'll find them in History, under Archived tabs.",
            searchkeywords: "archive idle tabs auto close unused",
          },
          items: [
            {
              id: "svalAutoArchive",
              controlAttrs: { label: "Archive idle tabs" },
              items: [
                {
                  id: "svalAutoArchiveAfter",
                  control: "moz-select",
                  controlAttrs: { label: "After" },
                  options: ARCHIVE_TIMES.map(time => ({
                    value: time.value,
                    controlAttrs: { label: time.label },
                  })),
                },
              ],
            },
            {
              id: "svalArchiveRetention",
              control: "moz-select",
              controlAttrs: { label: "Keep archived tabs for" },
              options: RETENTION_DAYS.map(days => ({
                value: String(days),
                controlAttrs: { label: `${days} days` },
              })),
            },
          ],
        },
      });
    },
  };
}
