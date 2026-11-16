/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Reads another Firefox's profiles for import (import spec §4.4), read only
 * (SvalImportFiles).
 */

import { importableUrl } from "moz-src:///browser/components/sval/SvalImportModel.sys.mjs";
import { isPreset } from "moz-src:///browser/components/sval/SvalColor.sys.mjs";
import {
  rowsInPlace,
  withCopy,
} from "moz-src:///browser/components/sval/SvalImportFiles.sys.mjs";

import {
  SvalLog,
  describeError,
} from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  MigrationUtils: "resource:///modules/MigrationUtils.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
});

const SOURCE = "firefox";

/**
 * Places' root folders, by their fixed guids (`PlacesUtils.bookmarks`), and
 * where each lands (§3), in the order roots sharing a destination are read.
 */
const ROOTS = Object.freeze({
  toolbar_____: "toolbar",
  menu________: "menu",
  unfiled_____: "other",
  mobile______: "other",
});

/** Pages per `insertMany` call, so one call never holds the whole history. */
const HISTORY_BATCH = 500;

/**
 * The directories Firefox keeps `profiles.ini` in on this platform. Linux has
 * the legacy `~/.mozilla/firefox` and the XDG `~/.config/mozilla/firefox`
 * that Firefox uses when the legacy one is absent (`nsXREDirProvider`), and
 * the same pair inside each sandbox's home: the Snap, Ubuntu's default
 * Firefox, keeps its profiles in its `common` directory, and the Flatpak
 * persists `.mozilla` and gives Firefox its own XDG config directory.
 *
 * @returns {string[]}
 */
export function defaultRoots() {
  const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
  if (AppConstants.platform === "macosx") {
    return [PathUtils.join(home, "Library", "Application Support", "Firefox")];
  }
  if (AppConstants.platform === "win") {
    const appData = Services.dirsvc.get("AppData", Ci.nsIFile).path;
    return [PathUtils.join(appData, "Mozilla", "Firefox")];
  }
  const xdg =
    Services.env.get("XDG_CONFIG_HOME") || PathUtils.join(home, ".config");
  const flatpak = PathUtils.join(home, ".var", "app", "org.mozilla.firefox");
  return [
    PathUtils.join(home, ".mozilla", "firefox"),
    PathUtils.join(xdg, "mozilla", "firefox"),
    PathUtils.join(home, "snap", "firefox", "common", ".mozilla", "firefox"),
    PathUtils.join(flatpak, ".mozilla", "firefox"),
    PathUtils.join(flatpak, "config", "mozilla", "firefox"),
  ];
}

/**
 * Every Firefox profile under the given roots, Sval's own excepted.
 *
 * @param {string[]} [roots] Directories holding a `profiles.ini`.
 * @param {string} [source] The `source` the profiles carry: Zen's reader
 *   finds its profiles here too.
 * @returns {Promise<object[]>} `[{ source, id, name, dir }]`, where `id` is the
 *   profile's `Path` in `profiles.ini` and `name` its `Name`.
 */
export async function findProfiles(roots = defaultRoots(), source = SOURCE) {
  const own = canonical(PathUtils.profileDir);
  const seen = new Set();
  const profiles = [];
  for (const root of roots) {
    let entries;
    try {
      entries = profilesIni(
        await IOUtils.readUTF8(PathUtils.join(root, "profiles.ini"))
      );
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.Path) {
        continue;
      }
      const dir =
        entry.IsRelative === "0"
          ? entry.Path
          : PathUtils.join(root, ...entry.Path.split("/").filter(Boolean));
      const key = canonical(dir);
      if (key === own || seen.has(key)) {
        continue;
      }
      let info;
      try {
        info = await IOUtils.stat(dir);
      } catch {
        continue;
      }
      if (info.type !== "directory") {
        continue;
      }
      seen.add(key);
      profiles.push({
        source,
        id: entry.Path,
        name: entry.Name || null,
        dir,
      });
    }
  }
  return profiles;
}

/**
 * The `[ProfileN]` sections of a `profiles.ini`, in the file's order, read by
 * Gecko's own INI parser.
 *
 * @param {string} text
 * @returns {object[]} `{ Path, Name, IsRelative }`, each a string or null.
 */
function profilesIni(text) {
  const parser = Cc["@mozilla.org/xpcom/ini-parser-factory;1"]
    .getService(Ci.nsIINIParserFactory)
    .createINIParser(null);
  parser.initFromString(text);
  const value = (section, key) => {
    try {
      return parser.getString(section, key);
    } catch {
      return null;
    }
  };
  return Array.from(parser.getSections())
    .filter(section => /^Profile\d+$/.test(section))
    .map(section => ({
      Path: value(section, "Path"),
      Name: value(section, "Name"),
      IsRelative: value(section, "IsRelative"),
    }));
}

/**
 * A path in the form two spellings of one directory share: symlinks resolved
 * where it exists (macOS's `/var` is `/private/var`), case folded on Windows.
 *
 * @param {string} path
 * @returns {string}
 */
function canonical(path) {
  let out = path;
  try {
    out = PathUtils.normalize(path);
  } catch {}
  return AppConstants.platform === "win" ? out.toLowerCase() : out;
}

/**
 * Open windows and bookmarks from one profile (§4.4). Logins are never read.
 *
 * @param {object} profile One of {@link findProfiles}'s results.
 * @returns {Promise<object>} A `Harvest` (SvalImportModel).
 */
export async function harvest(profile) {
  const state = { skipped: 0 };
  const windows = await readWindows(profile.dir, state);
  const bookmarks = await readBookmarks(profile.dir, state);
  return {
    windows,
    bookmarks,
    logins: null,
    encryptedSession: false,
    skipped: state.skipped,
  };
}

/**
 * The session Firefox is writing while it runs, else the one it wrote at
 * shutdown (`SessionFile`'s `recovery` and `clean` files), parsed.
 *
 * @param {string} dir The profile directory.
 * @returns {Promise<object|null>} The session, or null when there is none.
 */
export async function readSessionFile(dir) {
  let session = null;
  for (const path of [
    PathUtils.join(dir, "sessionstore-backups", "recovery.jsonlz4"),
    PathUtils.join(dir, "sessionstore.jsonlz4"),
  ]) {
    if (!(await IOUtils.exists(path))) {
      continue;
    }
    try {
      session = await IOUtils.readJSON(path, { decompress: true });
    } catch (e) {
      throw new Error(`Firefox session could not be read (${e.name})`, {
        cause: e,
      });
    }
    break;
  }
  if (!session) {
    return null;
  }
  if (!Array.isArray(session?.windows)) {
    throw new Error("Firefox session has no windows list");
  }
  return session;
}

/**
 * The open windows of the profile's session.
 *
 * @param {string} dir The profile directory.
 * @param {object} state `{ skipped }`, counted into.
 * @returns {Promise<object[]>} The harvest's windows.
 */
async function readWindows(dir, state) {
  const session = await readSessionFile(dir);
  if (!session) {
    return [];
  }
  const windows = [];
  for (const win of session.windows) {
    if (!win || win.isPrivate) {
      continue;
    }
    const children = windowNodes(win, state);
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

/**
 * A window's tabs in tab-strip order, each run of tabs sharing a `groupId`
 * gathered into one group node (`TabGroupState`'s `id`, `name`, `color`).
 *
 * @param {object} win A session window.
 * @param {object} state `{ skipped }`, counted into.
 * @returns {object[]} The window's nodes.
 */
function windowNodes(win, state) {
  const groups = new Map();
  for (const g of Array.isArray(win.groups) ? win.groups : []) {
    if (g && g.id != null) {
      groups.set(g.id, g);
    }
  }
  const nodes = [];
  let run = null;
  for (const tab of Array.isArray(win.tabs) ? win.tabs : []) {
    const node = tabNode(tab, state);
    const groupId = tab?.groupId ?? null;
    if (groupId == null) {
      run = null;
      if (node) {
        nodes.push(node);
      }
      continue;
    }
    if (!run || run.id !== groupId) {
      const g = groups.get(groupId);
      run = {
        id: groupId,
        node: {
          type: "group",
          name: (typeof g?.name === "string" && g.name) || null,
          color: isPreset(g?.color) ? g.color : null,
          children: [],
        },
      };
      nodes.push(run.node);
    }
    if (node) {
      run.node.children.push(node);
    }
  }
  return nodes.filter(n => n.type === "tab" || n.children.length);
}

/**
 * The tab's current history entry, at its 1-based `index`.
 *
 * @param {object} tab A session tab.
 * @param {object} state `{ skipped }`, counted into.
 * @returns {object|null} A tab node, or null for none.
 */
export function tabNode(tab, state) {
  const entries = Array.isArray(tab?.entries) ? tab.entries : [];
  if (!entries.length) {
    return null;
  }
  const index = Number.isInteger(tab.index) ? tab.index : entries.length;
  const entry =
    entries[Math.min(Math.max(index, 1), entries.length) - 1] ?? null;
  if (!importableUrl(entry?.url)) {
    state.skipped++;
    return null;
  }
  return {
    type: "tab",
    title: typeof entry.title === "string" ? entry.title : "",
    url: entry.url,
  };
}

const BOOKMARK_ROWS = `SELECT b.id, b.type, b.parent, b.title, b.guid, p.url
  FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk
  ORDER BY b.parent, b.position`;

/**
 * The profile's bookmarks, read in place for the import page (SvalImportFiles).
 *
 * @param {string} dir The profile directory.
 * @param {object} state `{ skipped }`, counted into.
 * @returns {Promise<object|null>} `Roots`, or null when there is no
 *   `places.sqlite`.
 */
export async function readBookmarks(dir, state) {
  const path = PathUtils.join(dir, "places.sqlite");
  let rows;
  try {
    rows = await rowsInPlace(path, BOOKMARK_ROWS);
  } catch {
    // An unlocked read can find the file mid-checkpoint and take it for
    // corrupt; a copy reads it as it is.
    try {
      rows = await withCopy(path, db => db.execute(BOOKMARK_ROWS));
    } catch (e) {
      throw new Error(`Firefox bookmarks could not be read (${e.name})`, {
        cause: e,
      });
    }
  }
  return rows ? bookmarkRoots(rows, state) : null;
}

/**
 * The profile's bookmarks as they are now, from a copy of `places.sqlite`, so
 * what a running Firefox has not yet checkpointed is in them (SvalImportFiles).
 *
 * @param {object} profile One of {@link findProfiles}'s results.
 * @returns {Promise<object|null>} `Roots`, or null when there is no
 *   `places.sqlite`.
 */
export async function importBookmarks(profile) {
  let rows;
  try {
    rows = await withCopy(PathUtils.join(profile.dir, "places.sqlite"), db =>
      db.execute(BOOKMARK_ROWS)
    );
  } catch (e) {
    throw new Error(`Firefox bookmarks could not be read (${e.name})`, {
      cause: e,
    });
  }
  return rows ? bookmarkRoots(rows, { skipped: 0 }) : null;
}

function bookmarkRoots(rows, state) {
  const byParent = new Map();
  const rootIds = new Map();
  for (const row of rows) {
    const item = {
      id: row.getResultByName("id"),
      type: row.getResultByName("type"),
      title: row.getResultByName("title"),
      url: row.getResultByName("url"),
    };
    const parent = row.getResultByName("parent");
    if (!byParent.has(parent)) {
      byParent.set(parent, []);
    }
    byParent.get(parent).push(item);
    const guid = row.getResultByName("guid");
    if (guid in ROOTS) {
      rootIds.set(guid, item.id);
    }
  }

  const visited = new Set();
  const walk = id => {
    const out = [];
    if (visited.has(id)) {
      return out;
    }
    visited.add(id);
    for (const item of byParent.get(id) ?? []) {
      if (item.type === lazy.PlacesUtils.bookmarks.TYPE_FOLDER) {
        out.push({
          type: "folder",
          title: item.title ?? "",
          children: walk(item.id),
        });
      } else if (item.type === lazy.PlacesUtils.bookmarks.TYPE_BOOKMARK) {
        if (importableUrl(item.url)) {
          out.push({
            type: "bookmark",
            title: item.title ?? "",
            url: item.url,
          });
        } else {
          state.skipped++;
        }
      }
    }
    return out;
  };

  const roots = { toolbar: [], menu: [], other: [] };
  for (const [guid, root] of Object.entries(ROOTS)) {
    if (rootIds.has(guid)) {
      roots[root].push(...walk(rootIds.get(guid)));
    }
  }
  return roots;
}

/**
 * Inserts the profile's recent history into Sval's Places (§3, §4.4): visits
 * within `browser.migrate.history.maxAgeInDays`, grouped by page, from a copy
 * of `places.sqlite` (SvalImportFiles).
 *
 * @param {object} profile One of {@link findProfiles}'s results.
 * @returns {Promise<number>} Pages inserted.
 */
export async function importHistory(profile) {
  // `visit_date` is PRTime, microseconds since the epoch.
  const since = historySince() * 1000;
  let rows;
  try {
    rows = await withCopy(PathUtils.join(profile.dir, "places.sqlite"), db =>
      db.execute(
        `SELECT p.url, p.title, v.visit_date, v.visit_type
           FROM moz_historyvisits v JOIN moz_places p ON p.id = v.place_id
           WHERE v.visit_date >= :since
           ORDER BY p.id, v.visit_date`,
        { since }
      )
    );
  } catch (e) {
    throw new Error(`Firefox history could not be read (${e.name})`, {
      cause: e,
    });
  }
  if (!rows) {
    return 0;
  }
  const history = lazy.PlacesUtils.history;
  return insertPages(
    pagesFromVisits(
      rows.map(row => {
        const type = row.getResultByName("visit_type");
        return {
          url: row.getResultByName("url"),
          title: row.getResultByName("title"),
          time: row.getResultByName("visit_date") / 1000,
          transition: history.isValidTransition(type)
            ? type
            : history.TRANSITIONS.LINK,
        };
      })
    )
  );
}

/**
 * The oldest visit import carries, in milliseconds since the epoch: Firefox's
 * own migrators' (`MigrationUtils.HISTORY_MAX_AGE_IN_MILLISECONDS`).
 *
 * @returns {number}
 */
export function historySince() {
  return Date.now() - lazy.MigrationUtils.HISTORY_MAX_AGE_IN_MILLISECONDS;
}

/**
 * Visits grouped into the pages `insertPages` takes, in the order their URLs
 * first appear. A visit whose URL import does not carry, or Places cannot
 * parse, is left out.
 *
 * @param {object[]} visits `{ url, title, time, transition }`, `time` in
 *   milliseconds since the epoch.
 * @returns {object[]}
 */
export function pagesFromVisits(visits) {
  const now = Date.now();
  const pages = new Map();
  for (const { url, title, time, transition } of visits) {
    if (!importableUrl(url) || !URL.canParse(url)) {
      continue;
    }
    let page = pages.get(url);
    if (!page) {
      page = { url, visits: [] };
      if (typeof title === "string" && title) {
        page.title = title;
      }
      pages.set(url, page);
    }
    // A visit dated ahead of the clock fails validation; Firefox's own
    // `insertVisitsWrapper` clamps it to now for the same reason.
    page.visits.push({ date: new Date(Math.min(time, now)), transition });
  }
  return [...pages.values()];
}

/**
 * Inserts pages into Sval's Places in batches.
 *
 * @param {object[]} pages `{ url, title?, visits: [{ date, transition }] }`.
 * @returns {Promise<number>} Pages Places took.
 * @throws {Error} When a batch was refused and Places took no page at all,
 *   so a history that failed whole reads as a failure.
 */
export async function insertPages(pages) {
  // `insertMany` reports each visit it stores, so pages are counted by URL.
  const inserted = new Set();
  // `insertMany` rejects a batch none of whose pages Places took, whether
  // the pages were refused or the database failed, and a batch it rejects
  // has inserted nothing.
  let refused = null;
  for (let i = 0; i < pages.length; i += HISTORY_BATCH) {
    const batch = pages.slice(i, i + HISTORY_BATCH);
    try {
      await lazy.PlacesUtils.history.insertMany(batch, page =>
        inserted.add(page.url.href)
      );
    } catch (e) {
      refused ??= e;
    }
  }
  if (refused) {
    if (!inserted.size) {
      throw Object.assign(
        new Error(`history could not be inserted (${describeError(refused)})`, {
          cause: refused,
        }),
        { code: "history_refused" }
      );
    }
    SvalLog.warn(
      `import: Places refused a batch of history: ${describeError(refused)}`
    );
  }
  return inserted.size;
}
