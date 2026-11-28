/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The Launcher's settings (launcher spec §5): the order of the
 * address bar's sections and how many rows each lists. Each default is in
 * `app-sval-prefs.js`, and each syncs (`SvalSettingsRegistry.SYNCED_PREFS`).
 */

export const LAUNCHER_PREFS = Object.freeze({
  /** The sections, by {@link SECTION_LIMIT_PREFS} key, comma-separated, in order. */
  order: "browser.sval.launcher.order",
  /** How many open tabs the Open tabs section lists. */
  limitTabs: "browser.sval.launcher.limit.tabs",
  /** How many pins and Favorites the Pins and Favorites section lists. */
  limitFavorites: "browser.sval.launcher.limit.favorites",
  /** How many commands the Commands section lists. */
  limitCommands: "browser.sval.launcher.limit.commands",
  /** How many pages the History section lists. */
  limitHistory: "browser.sval.launcher.limit.history",
  /** How many suggestions the Search suggestions section lists. */
  limitSuggestions: "browser.sval.launcher.limit.suggestions",
});

/** Each section's limit pref, by the section's key. */
export const SECTION_LIMIT_PREFS = Object.freeze({
  tabs: LAUNCHER_PREFS.limitTabs,
  favorites: LAUNCHER_PREFS.limitFavorites,
  commands: LAUNCHER_PREFS.limitCommands,
  history: LAUNCHER_PREFS.limitHistory,
  suggestions: LAUNCHER_PREFS.limitSuggestions,
});

/**
 * @param {string} name One of {@link LAUNCHER_PREFS}' limits.
 * @returns {number} The limit, never below zero.
 */
export function launcherLimit(name) {
  return Math.max(0, Services.prefs.getIntPref(name));
}

/**
 * The sections in the order the setting gives. A key it names twice counts
 * once, and a word that is no section's key is skipped; a section it leaves
 * out is not shown.
 *
 * @returns {string[]} {@link SECTION_LIMIT_PREFS} keys.
 */
export function launcherOrder() {
  const keys = Services.prefs
    .getCharPref(LAUNCHER_PREFS.order)
    .split(",")
    .map(key => key.trim())
    .filter(key => Object.hasOwn(SECTION_LIMIT_PREFS, key));
  return [...new Set(keys)];
}
