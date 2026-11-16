/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Reads Orion's profiles for import: open windows, bookmarks and history
 * (import spec §4).
 *
 * Orion is WebKit, on macOS. Its files are Kagi's own and undocumented beyond
 * where they live (Orion's "Technical" help page), so their reading follows a
 * real profile as of Orion 1.0 (2026-10):
 *
 * - `profiles`, a property list at Orion's root: `defaults` and `profiles`,
 *   each `{ name, identifier }`, the identifier naming the profile's
 *   directory.
 * - `browser_state.plist`: an array of windows, each with `isPrivate` and
 *   `tabStates`, each tab with `url` and `title`.
 * - `favourites.plist`: a dictionary of items by id, each with `type`
 *   (`folder` or `bookmark`), `parentId`, `index`, `title` and `url`. Item
 *   `0` is the root; its folders "Bookmarks Bar" and "Favorites" are what
 *   Orion shows above the page and on its start page.
 * - `history`: SQLite, `history_items` and their `visits`, timestamps as
 *   UTC text.
 *
 * Saved passwords are in Orion's own keychain, which Orion offers no export
 * of, so none are counted and the logins hand-off leaves Orion out. Read
 * only (SvalImportFiles).
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { importableUrl } from "moz-src:///browser/components/sval/SvalImportModel.sys.mjs";
import {
  historySince,
  insertPages,
  pagesFromVisits,
} from "moz-src:///browser/components/sval/SvalImportFirefox.sys.mjs";
import {
  isDirectory,
  readPlist,
  withCopy,
} from "moz-src:///browser/components/sval/SvalImportFiles.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
});

const SOURCE = "orion";

/** The profile Orion makes first, which `profiles` lists as `defaults`. */
const DEFAULT_IDENTIFIER = "Defaults";

/** The root's folders that are Favorites in Sval (§3). */
const TOOLBAR_FOLDERS = new Set(["Bookmarks Bar", "Favorites"]);

/**
 * Orion's roots: its own, and its release candidate's, which keeps a
 * directory of its own.
 *
 * @returns {string[]}
 */
export function defaultRoots() {
  if (AppConstants.platform !== "macosx") {
    return [];
  }
  const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
  const support = PathUtils.join(home, "Library", "Application Support");
  return [
    PathUtils.join(support, "Orion"),
    PathUtils.join(support, "Orion RC"),
  ];
}

/**
 * Every Orion profile under the given roots. A root with no readable
 * `profiles` still has its default profile.
 *
 * @param {string[]} [roots]
 * @returns {Promise<object[]>} `[{ source, id, name, dir }]`.
 */
export async function findProfiles(roots = defaultRoots()) {
  const profiles = [];
  for (const root of roots) {
    let entries = [];
    try {
      const list = await readPlist(PathUtils.join(root, "profiles"));
      entries = [
        list?.get("defaults"),
        ...(Array.isArray(list?.get("profiles")) ? list.get("profiles") : []),
      ];
    } catch {
      // Unreadable or absent: the default profile, below.
    }
    const seen = new Set();
    for (const entry of entries) {
      const id = entry instanceof Map ? entry.get("identifier") : null;
      if (typeof id !== "string" || !id || id.includes("/") || seen.has(id)) {
        continue;
      }
      seen.add(id);
      const name = entry.get("name");
      profiles.push({
        source: SOURCE,
        id,
        name: typeof name === "string" && name ? name : null,
        dir: PathUtils.join(root, id),
      });
    }
    if (!seen.size) {
      profiles.push({
        source: SOURCE,
        id: DEFAULT_IDENTIFIER,
        name: null,
        dir: PathUtils.join(root, DEFAULT_IDENTIFIER),
      });
    }
  }
  const found = [];
  for (const profile of profiles) {
    if (await isDirectory(profile.dir)) {
      found.push(profile);
    }
  }
  return found;
}

/**
 * Open windows and bookmarks from one profile.
 *
 * @param {object} profile One of {@link findProfiles}'s results.
 * @returns {Promise<object>} A `Harvest` (SvalImportModel).
 */
export async function harvest(profile) {
  const state = { skipped: 0 };
  return {
    windows: await readWindows(profile.dir, state),
    bookmarks: await readBookmarks(profile.dir, state),
    logins: null,
    encryptedSession: false,
    skipped: state.skipped,
  };
}

async function readWindows(dir, state) {
  let root;
  try {
    root = await readPlist(PathUtils.join(dir, "browser_state.plist"));
  } catch (e) {
    throw new Error(`Orion windows could not be read (${e.name})`, {
      cause: e,
    });
  }
  const windows = [];
  for (const win of Array.isArray(root) ? root : []) {
    if (!(win instanceof Map) || win.get("isPrivate") === true) {
      continue;
    }
    const tabs = win.get("tabStates");
    const children = [];
    for (const tab of Array.isArray(tabs) ? tabs : []) {
      if (!(tab instanceof Map)) {
        continue;
      }
      const url = tab.get("url");
      if (!importableUrl(url)) {
        state.skipped++;
        continue;
      }
      const title = tab.get("title");
      children.push({
        type: "tab",
        title: typeof title === "string" ? title : "",
        url,
      });
    }
    if (children.length) {
      windows.push({
        kind: "window",
        name: null,
        emoji: null,
        color: null,
        children,
      });
    }
  }
  return windows;
}

async function readBookmarks(dir, state) {
  let root;
  try {
    root = await readPlist(PathUtils.join(dir, "favourites.plist"));
  } catch (e) {
    throw new Error(`Orion bookmarks could not be read (${e.name})`, {
      cause: e,
    });
  }
  if (!(root instanceof Map)) {
    return null;
  }
  const byParent = new Map();
  for (const item of root.values()) {
    if (!(item instanceof Map)) {
      continue;
    }
    const parent = item.get("parentId");
    if (typeof parent !== "string") {
      continue;
    }
    if (!byParent.has(parent)) {
      byParent.set(parent, []);
    }
    byParent.get(parent).push(item);
  }
  const ordered = id =>
    (byParent.get(id) ?? []).sort(
      (a, b) => (a.get("index") ?? 0) - (b.get("index") ?? 0)
    );
  const visited = new Set();
  const walk = id => {
    const out = [];
    if (visited.has(id)) {
      return out;
    }
    visited.add(id);
    for (const item of ordered(id)) {
      const title = item.get("title");
      if (item.get("type") === "folder") {
        out.push({
          type: "folder",
          title: typeof title === "string" ? title : "",
          children: walk(item.get("id")),
        });
      } else if (item.get("type") === "bookmark") {
        const url = item.get("url");
        if (importableUrl(url)) {
          out.push({
            type: "bookmark",
            title: typeof title === "string" ? title : "",
            url,
          });
        } else {
          state.skipped++;
        }
      }
    }
    return out;
  };

  const roots = { toolbar: [], menu: [], other: [] };
  visited.add("0");
  for (const item of ordered("0")) {
    if (item.get("type") === "folder") {
      const into = TOOLBAR_FOLDERS.has(item.get("title"))
        ? roots.toolbar
        : roots.other;
      into.push(...walk(item.get("id")));
    } else {
      roots.other.push(...leaf(item, state));
    }
  }
  return roots.toolbar.length || roots.other.length ? roots : null;
}

/**
 * A bookmark at the root, outside every folder.
 *
 * @param {Map} item
 * @param {object} state `{ skipped }`, counted into.
 * @returns {object[]} The bookmark, or nothing.
 */
function leaf(item, state) {
  const url = item.get("url");
  if (item.get("type") !== "bookmark") {
    return [];
  }
  if (!importableUrl(url)) {
    state.skipped++;
    return [];
  }
  const title = item.get("title");
  return [
    { type: "bookmark", title: typeof title === "string" ? title : "", url },
  ];
}

/**
 * Inserts the profile's recent history into Sval's Places, as Firefox's
 * reader does its own.
 *
 * @param {object} profile One of {@link findProfiles}'s results.
 * @returns {Promise<number>} Pages inserted.
 */
export async function importHistory(profile) {
  let rows;
  try {
    rows = await withCopy(PathUtils.join(profile.dir, "history"), db =>
      db.execute(
        `SELECT h.URL AS url, h.TITLE AS title, v.VISIT_TIME AS time,
                v.TRANSITION_TYPE AS transition
           FROM visits v JOIN history_items h ON h.ID = v.HISTORY_ITEM_ID
           ORDER BY h.ID, v.VISIT_TIME`
      )
    );
  } catch (e) {
    throw new Error(`Orion history could not be read (${e.name})`, {
      cause: e,
    });
  }
  if (!rows) {
    return 0;
  }
  const { TRANSITIONS } = lazy.PlacesUtils.history;
  const since = historySince();
  const visits = [];
  for (const row of rows) {
    const time = visitTime(row.getResultByName("time"));
    if (time === null || time < since) {
      continue;
    }
    visits.push({
      url: row.getResultByName("url"),
      title: row.getResultByName("title"),
      time,
      transition:
        row.getResultByName("transition") === "typed"
          ? TRANSITIONS.TYPED
          : TRANSITIONS.LINK,
    });
  }
  return insertPages(pagesFromVisits(visits));
}

/**
 * SQLite's `CURRENT_TIMESTAMP` text, `YYYY-MM-DD HH:MM:SS` in UTC.
 *
 * @param {*} text
 * @returns {number|null} Milliseconds since the epoch.
 */
function visitTime(text) {
  if (typeof text !== "string") {
    return null;
  }
  const ms = Date.parse(`${text.trim().replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms : null;
}
