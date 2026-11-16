/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Reads Safari's open windows, Tab Groups and bookmarks (import spec §4.3).
 *
 * Safari is macOS only and has one profile as far as import is concerned.
 * Every file it reads sits behind Full Disk Access, which
 * {@link hasFullDiskAccess} checks before anything is offered.
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { importableUrl } from "moz-src:///browser/components/sval/SvalImportModel.sys.mjs";
import {
  readPlist,
  withCopy,
} from "moz-src:///browser/components/sval/SvalImportFiles.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  MigrationUtils: "resource:///modules/MigrationUtils.sys.mjs",
});

const SAFARI = ["Library", "Safari"];
const BOOKMARKS = [...SAFARI, "Bookmarks.plist"];
const TABS = [
  "Library",
  "Containers",
  "com.apple.Safari",
  "Data",
  "Library",
  "Safari",
  "SafariTabs.db",
];

/**
 * Folders in `SafariTabs.db` that are type 1 but are Safari's own bookkeeping,
 * keyed by `external_uuid` as Safari 26 writes them.
 */
const SPECIAL_FOLDERS = new Set([
  "Root",
  "pinned",
  "privatePinned",
  "recentlyClosed",
  "DefaultProfile",
]);

/** The Reading List's title in `Bookmarks.plist`, which is an identifier. */
export const READING_LIST = "com.apple.ReadingList";

/** Titles Safari gives each window's unnamed groups. */
const UNNAMED_GROUPS = new Set(["Local", "Private"]);

function defaultRoots() {
  return {
    home:
      AppConstants.platform === "macosx"
        ? Services.dirsvc.get("Home", Ci.nsIFile).path
        : null,
  };
}

/**
 * @param {object} [roots] `{ home }`; a null home finds nothing.
 * @returns {Promise<object[]>} The one Safari profile, when `Library/Safari`
 *   exists under the home directory.
 */
export async function findProfiles(roots = defaultRoots()) {
  if (!roots?.home) {
    return [];
  }
  if (!(await IOUtils.exists(PathUtils.join(roots.home, ...SAFARI)))) {
    return [];
  }
  // `dir` is the home Safari's paths hang off; `lastUsedPath` is Safari's
  // own directory, whose change time says when Safari was last used, which
  // the home directory's does not.
  return [
    {
      source: "safari",
      id: "default",
      name: null,
      dir: roots.home,
      lastUsedPath: PathUtils.join(roots.home, ...SAFARI),
    },
  ];
}

/**
 * Whether Sval may read Safari's files: one byte of `Bookmarks.plist`, as
 * Firefox's `SafariProfileMigrator.hasPermissions` reads. A missing file is
 * no access, since there is then nothing to show either way.
 *
 * @param {object} [roots] `{ home }`.
 * @returns {Promise<boolean>}
 */
export async function hasFullDiskAccess(roots = defaultRoots()) {
  if (!roots?.home) {
    return false;
  }
  try {
    await IOUtils.read(PathUtils.join(roots.home, ...BOOKMARKS), {
      maxBytes: 1,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} profile One of {@link findProfiles}'s.
 * @returns {Promise<object>} A `Harvest` (SvalImportModel).
 */
export async function harvest(profile) {
  const state = { skipped: 0 };
  // Safari's tab database is undocumented and may change under an update;
  // losing it costs the tabs and keeps the bookmarks.
  let windows = [];
  try {
    windows = await readWindows(PathUtils.join(profile.dir, ...TABS), state);
  } catch (e) {
    lazy.SvalLog.warn(
      `import: Safari's tabs could not be read: ${lazy.SvalLog.errorName(e.cause)}`
    );
  }
  const bookmarks = await readBookmarks(
    PathUtils.join(profile.dir, ...BOOKMARKS),
    state
  );
  return {
    windows,
    bookmarks,
    logins: null,
    encryptedSession: false,
    skipped: state.skipped,
  };
}

/**
 * History goes through Firefox's own Safari migrator, which reads
 * `~/Library/Safari/History.db` whatever the profile says.
 *
 * @returns {Promise<number>} URLs inserted into Places.
 */
export async function importHistory() {
  const migrator = await lazy.MigrationUtils.getMigrator("safari");
  if (!migrator) {
    return 0;
  }
  const { HISTORY } = lazy.MigrationUtils.resourceTypes;
  let succeeded = false;
  await migrator.migrate(HISTORY, false, null, (type, success) => {
    succeeded = type === HISTORY && success;
  });
  if (!succeeded) {
    throw new Error("safari history import failed");
  }
  return lazy.MigrationUtils.getImportedCount("history");
}

async function columns(db, table) {
  const rows = await db.execute(`PRAGMA table_info(${table})`);
  return new Set(rows.map(row => row.getResultByName("name")));
}

const TAB_COLUMNS = ["id", "parent", "type", "title", "url", "order_index"];

/**
 * Safari's open windows, each one's own tabs, and its named Tab Groups, from
 * `SafariTabs.db` (spec §4.3). A schema without the columns this needs reads
 * as no windows, so a Safari update costs the tabs and keeps the bookmarks.
 *
 * The windows are what the import carries, so the database is read from a
 * copy, with what a running Safari has not checkpointed (SvalImportFiles).
 *
 * @param {string} path `SafariTabs.db`.
 * @param {{skipped: number}} state Counts what is left out.
 * @returns {Promise<object[]>} Harvest windows.
 */
async function readWindows(path, state) {
  try {
    return (await withCopy(path, db => windowsFrom(db, state))) ?? [];
  } catch (e) {
    throw new Error(`Safari tabs unreadable: ${e.name || "Error"}`, {
      cause: e,
    });
  }
}

async function windowsFrom(db, state) {
  const marks = await columns(db, "bookmarks");
  const wins = await columns(db, "windows");
  if (
    !TAB_COLUMNS.every(c => marks.has(c)) ||
    !wins.has("id") ||
    !wins.has("local_tab_group_id")
  ) {
    return [];
  }
  const live = marks.has("deleted") ? "AND deleted = 0" : "";

  const tabsOf = async groupId => {
    const rows = await db.execute(
      `SELECT title, url FROM bookmarks
       WHERE type = 0 AND parent = :groupId ${live}
       ORDER BY order_index, id`,
      { groupId }
    );
    const tabs = [];
    for (const row of rows) {
      const url = row.getResultByName("url");
      if (!importableUrl(url)) {
        state.skipped++;
        continue;
      }
      tabs.push({
        type: "tab",
        title: row.getResultByName("title") || null,
        url,
      });
    }
    return tabs;
  };

  const result = [];
  const ownGroups = new Set();
  const windowRows = await db.execute(
    `SELECT local_tab_group_id${
      wins.has("private_tab_group_id") ? ", private_tab_group_id" : ""
    } FROM windows ORDER BY id`
  );
  const localGroups = [];
  for (const row of windowRows) {
    const local = row.getResultByName("local_tab_group_id");
    if (wins.has("private_tab_group_id")) {
      ownGroups.add(row.getResultByName("private_tab_group_id"));
    }
    if (local !== null && !ownGroups.has(local)) {
      ownGroups.add(local);
      localGroups.push(local);
    }
  }
  // Safari shows the pinned tabs at the head of every window, so they
  // arrive once, as ordinary tabs at the head of the first, as Arc's
  // pinned tabs do (spec §3). Private windows' pinned tabs never import.
  let pinned = [];
  if (marks.has("external_uuid")) {
    const folders = await db.execute(
      `SELECT id FROM bookmarks
       WHERE type = 1 AND external_uuid = 'pinned' ${live}
       ORDER BY id`
    );
    for (const row of folders) {
      pinned.push(...(await tabsOf(row.getResultByName("id"))));
    }
  }
  for (const local of localGroups) {
    const children = [...pinned, ...(await tabsOf(local))];
    pinned = [];
    if (children.length) {
      result.push(windowOf("window", null, children));
    }
  }
  if (pinned.length) {
    result.push(windowOf("window", null, pinned));
  }

  const named = await db.execute(
    `SELECT id, title${
      marks.has("external_uuid") ? ", external_uuid" : ""
    } FROM bookmarks
     WHERE type = 1 ${live}
       ${marks.has("subtype") ? "AND subtype = 0" : ""}
       ${marks.has("hidden") ? "AND hidden = 0" : ""}
     ORDER BY order_index, id`
  );
  for (const row of named) {
    const id = row.getResultByName("id");
    const title = row.getResultByName("title");
    const uuid = marks.has("external_uuid")
      ? row.getResultByName("external_uuid")
      : null;
    if (
      !title ||
      UNNAMED_GROUPS.has(title) ||
      SPECIAL_FOLDERS.has(uuid) ||
      ownGroups.has(id)
    ) {
      continue;
    }
    const children = await tabsOf(id);
    if (children.length) {
      result.push(windowOf("tabGroup", title, children));
    }
  }
  return result;
}

function windowOf(kind, name, children) {
  return { kind, name, emoji: null, color: null, children };
}

/**
 * Safari's bookmarks, from `Bookmarks.plist`. The Favorites bar is the
 * toolbar, the Bookmarks Menu the menu, and the Reading List a folder of its
 * own in other (spec §3), as Firefox's `SafariProfileMigrator` places them.
 *
 * @param {string} path `Bookmarks.plist`.
 * @param {{skipped: number}} state Counts what is left out.
 * @returns {Promise<object|null>} Harvest roots, or null with no file.
 */
async function readBookmarks(path, state) {
  let root;
  try {
    root = await readPlist(path);
  } catch (e) {
    throw new Error(`Safari bookmarks unreadable: ${e.name || "Error"}`, {
      cause: e,
    });
  }
  if (root === null) {
    return null;
  }
  const top = root instanceof Map ? root.get("Children") : null;
  if (!Array.isArray(top)) {
    throw new Error("Safari bookmarks unreadable: not a bookmarks list");
  }

  // The collections are recognised by title before ShouldOmitFromUI is
  // consulted, as `SafariProfileMigrator`'s `_migrateCollection` does:
  // Safari may mark the Reading List itself as omitted from its sidebar.
  const roots = { toolbar: [], menu: [], other: [] };
  // The folder takes the name Firefox's own Safari import gives it, in the
  // user's language.
  const readingList = await lazy.MigrationUtils.getLocalizedString(
    "migration-imported-safari-reading-list"
  );
  for (const entry of top) {
    if (!(entry instanceof Map)) {
      continue;
    }
    // Safari writes an empty collection without Children.
    const children = entry.get("Children") ?? [];
    const title = entry.get("Title");
    if (isFolder(entry) && Array.isArray(children)) {
      if (title === "BookmarksBar") {
        roots.toolbar.push(...convert(children, state));
        continue;
      }
      if (title === "BookmarksMenu") {
        roots.menu.push(...convert(children, state));
        continue;
      }
      if (title === READING_LIST) {
        roots.other.push({
          type: "folder",
          title: readingList,
          children: convert(children, state),
        });
        continue;
      }
    }
    roots.other.push(...convert([entry], state));
  }
  return roots;
}

function isFolder(entry) {
  return entry.get("WebBookmarkType") === "WebBookmarkTypeList";
}

/**
 * Safari entries to `Mark`s, leaving out what is hidden or not importable.
 *
 * @param {Map[]} entries
 * @param {{skipped: number}} state
 * @returns {object[]}
 */
function convert(entries, state) {
  const marks = [];
  for (const entry of entries) {
    if (!(entry instanceof Map) || entry.get("ShouldOmitFromUI") === true) {
      continue;
    }
    if (isFolder(entry)) {
      const children = entry.get("Children");
      marks.push({
        type: "folder",
        title: entry.get("Title") || null,
        children: Array.isArray(children) ? convert(children, state) : [],
      });
    } else if (entry.get("WebBookmarkType") === "WebBookmarkTypeLeaf") {
      const url = entry.get("URLString");
      if (!importableUrl(url)) {
        state.skipped++;
        continue;
      }
      const uri = entry.get("URIDictionary");
      marks.push({
        type: "bookmark",
        title: (uri instanceof Map && uri.get("title")) || null,
        url,
      });
    }
  }
  return marks;
}
