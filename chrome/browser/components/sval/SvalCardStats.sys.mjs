/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The counts the card dialog shows beside the user's card. Each comes from
 * the store that already answers it, read on this device; nothing is kept or
 * sent. A count that cannot be read is null, and the dialog leaves its row
 * out.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  descendantTabCount:
    "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
  KEY_PREFIX: "moz-src:///browser/components/sval/SvalDeviceNames.sys.mjs",
  FAVORITES_ROOT:
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
  PINS_ROOT: "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
  myFilters: "moz-src:///browser/components/sval/SvalBlockingLists.sys.mjs",
  SvalFavoritesStore:
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  SvalSettingsRegistry:
    "moz-src:///browser/components/sval/SvalSettingsRegistry.sys.mjs",
  workspaceIds: "moz-src:///browser/components/sval/SvalTree.sys.mjs",
});

/**
 * @param {Function} read
 * @param {string} what Named in the log when it fails.
 * @returns {Promise<*>} what `read` answers, or null when it fails.
 */
async function orNull(read, what) {
  try {
    return (await read()) ?? null;
  } catch (err) {
    lazy.SvalLog.warn(
      `card stats: ${what} could not be read: ${lazy.SvalLog.errorName(err)}`
    );
    return null;
  }
}

/**
 * The card dialog's counts.
 *
 * @param {object|null} engine The profile's engine, or null before one runs.
 * @returns {Promise<object>} `{ workspaces, tabs, devices, favorites, pins,
 *   blocked, rules }`, each a number or null. Every count but `blocked`
 *   covers every device the user syncs; `blocked` counts this one only.
 */
export async function cardStats(engine) {
  const tree = engine
    ? await orNull(async () => (await engine.tree()).nodes, "the tree")
    : null;
  // The user's own Workspaces: an agent's workspace is the agent's.
  const own = tree
    ? lazy.workspaceIds(tree).filter(id => !tree[id]?.agent)
    : null;
  const favorites = lazy.SvalFavoritesStore.readyInstance;
  const [devices, blocked] = await Promise.all([
    engine
      ? orNull(async () => {
          const synced = await engine.settings(
            lazy.SvalSettingsRegistry.SETTINGS_DOCUMENT
          );
          return Object.keys(synced).filter(key =>
            key.startsWith(lazy.KEY_PREFIX)
          ).length;
        }, "the devices")
      : null,
    // Firefox's tally of what content blocking stopped on this device,
    // where Sval's blocked ads count as tracking content.
    orNull(
      () =>
        Cc["@mozilla.org/tracking-db-service;1"]
          .getService(Ci.nsITrackingDBService)
          .sumAllEvents(),
      "the blocking tally"
    ),
  ]);
  return {
    workspaces: own?.length ?? null,
    tabs: own
      ? own.reduce((n, id) => n + lazy.descendantTabCount(tree, id), 0)
      : null,
    devices,
    favorites: favorites ? favorites.countIn(lazy.FAVORITES_ROOT) : null,
    pins: favorites ? favorites.countIn(lazy.PINS_ROOT) : null,
    blocked,
    // My filters, one rule a line; `!` starts a comment.
    rules: lazy
      .myFilters()
      .split("\n")
      .filter(line => line.trim() && !line.trim().startsWith("!")).length,
  };
}
