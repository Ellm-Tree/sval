/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * General's Warnings: asking before quitting with the quit key, and warning
 * before opening many tabs at once. Both are Firefox's own settings from its
 * Tabs group, which no category of Sval's lists (spec §10.8), with Firefox's
 * words and its rules for when each shows: the quit key's where the window
 * has a quit key and the platform is not Windows, the many-tabs warning once
 * the user has turned it off in its dialog (`TransientPrefs`). `main.js`
 * imports `tabs-browsing.mjs`, which adds both settings, on every load of the
 * page. A group with no control showing hides itself
 * (`SettingGroup.handleVisibilityChange`).
 *
 * `SvalPreferences` loads this as a classic script into the preferences page;
 * `settings-pane.js` calls `register` once the page's own settings exist.
 */

"use strict";

{
  const GROUP_ID = "svalWarnings";

  window.SvalWarningsSettings = {
    GROUP_ID,

    register() {
      window.SettingGroupManager.registerGroups({
        [GROUP_ID]: {
          headingLevel: 2,
          controlAttrs: {
            label: "Warnings",
            searchkeywords: "quit warn confirm tabs",
          },
          items: [
            { id: "warnOnQuitKey", l10nId: "ask-on-quit-with-key" },
            { id: "warnOpenMany", l10nId: "warn-on-open-many-tabs" },
          ],
        },
      });
    },
  };
}
