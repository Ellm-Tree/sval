/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Reads Arc: its Spaces, Favorites, bookmarks and login count (import spec
 * §4.2), and how long it let a tab go unused before archiving it (idle-tab
 * archive spec §7.5).
 *
 * Arc keeps its sidebar in `StorableSidebar.json` at its root, shared by every
 * profile, and keeps ordinary Chromium profiles under `User Data/`. Each Space
 * names the profile it belongs to, so a profile's harvest is the Spaces and
 * Favorites that name it, plus what Chromium's reader reads from that
 * profile.
 *
 * The sidebar's format is undocumented. Its reading follows the prior art the
 * spec cites (Helium's Arc importer, arc2zen, the Raycast extension), checked
 * against a real install.
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { arcCardOf } from "moz-src:///browser/components/sval/SvalCard.sys.mjs";
import { DEFAULT_CHOICE } from "moz-src:///browser/components/sval/SvalArchive.sys.mjs";
import { readPlist } from "moz-src:///browser/components/sval/SvalImportFiles.sys.mjs";
import {
  DEFAULT_PROFILE,
  importableUrl,
  nearestColor,
} from "moz-src:///browser/components/sval/SvalImportModel.sys.mjs";
import {
  countLogins,
  importHistory,
  listedProfiles,
  readBookmarks,
} from "moz-src:///browser/components/sval/SvalImportChromium.sys.mjs";

const SIDEBAR = "StorableSidebar.json";
const ARCHIVE = "StorableArchiveItems.json";
const MEMBERSHIP_CARD = "StorableMembershipCard.json";
const AUTH_STATE = "StorableAuthState.json";

/**
 * Seconds from the Unix epoch to 2001-01-01, the reference date Swift's
 * `Date` encodes its times from, as Arc's files hold them.
 */
const REFERENCE_DATE = 978307200;
const USER_DATA = "User Data";

/** Arc's macOS preferences, in `Library/Preferences` beside its root's. */
const PREFERENCES = "company.thebrowser.Browser.plist";

/** Arc's choices for archiving idle tabs, as its binary names them, in Sval's. */
const ARCHIVE_CHOICES = Object.freeze({
  twelveHours: "12h",
  twentyFourHours: "24h",
  sevenDays: "7d",
  thirtyDays: "30d",
  never: "never",
});

/**
 * Where to look when the caller names nowhere: the home directory, and on
 * Windows the local application data directory Arc's package lives under.
 *
 * @returns {{home: string|null, localAppData: string|null}}
 */
export function defaultRoots() {
  const dir = key => {
    try {
      return Services.dirsvc.get(key, Ci.nsIFile).path;
    } catch {
      return null;
    }
  };
  return {
    home: dir("Home"),
    localAppData: AppConstants.platform == "win" ? dir("LocalAppData") : null,
  };
}

/**
 * Arc's root directories under the given roots that exist: macOS's under
 * Application Support, and each Windows package's (the package directory
 * carries a publisher hash, so it is found by listing `Packages`).
 *
 * @param {object} roots
 * @returns {Promise<string[]>}
 */
async function arcRoots(roots) {
  const found = [];
  if (roots.home) {
    const mac = PathUtils.join(
      roots.home,
      "Library",
      "Application Support",
      "Arc"
    );
    if (await isArcRoot(mac)) {
      found.push(mac);
    }
  }
  if (roots.localAppData) {
    const packages = PathUtils.join(roots.localAppData, "Packages");
    let children = [];
    try {
      children = await IOUtils.getChildren(packages);
    } catch {
      // No Packages directory: no Store-installed Arc.
    }
    for (const child of children.sort()) {
      if (!PathUtils.filename(child).startsWith("TheBrowserCompany.Arc_")) {
        continue;
      }
      const root = PathUtils.join(child, "LocalCache", "Local", "Arc");
      if (await isArcRoot(root)) {
        found.push(root);
      }
    }
  }
  return found;
}

async function isArcRoot(dir) {
  return (
    (await IOUtils.exists(PathUtils.join(dir, SIDEBAR))) ||
    (await IOUtils.exists(PathUtils.join(dir, USER_DATA, "Local State")))
  );
}

/**
 * Every Arc profile under the given roots: each one its `User Data`'s
 * `Local State` lists, whether or not its directory exists, since its Spaces
 * are in the sidebar. A sidebar with no readable profile list still has the
 * default profile, which every Space names unless it names another.
 *
 * @param {object} [roots] `{ home, localAppData }`.
 * @returns {Promise<object[]>} `{ source, id, name, dir, root }`: `dir` is the
 *   Chromium profile directory and `root` is Arc's, which holds the sidebar.
 */
export async function findProfiles(roots = defaultRoots()) {
  const profiles = [];
  for (const root of await arcRoots(roots)) {
    const userData = PathUtils.join(root, USER_DATA);
    let listed = (await listedProfiles(userData)) ?? [];
    if (
      !listed.length &&
      (await IOUtils.exists(PathUtils.join(root, SIDEBAR)))
    ) {
      listed = [{ id: DEFAULT_PROFILE, name: null }];
    }
    for (const { id, name } of listed) {
      profiles.push({
        source: "arc",
        id,
        name,
        dir: PathUtils.join(userData, id),
        root,
      });
    }
  }
  return profiles;
}

/**
 * What one Arc profile holds, as a `Harvest` (SvalImportModel).
 *
 * @param {object} profile One of {@link findProfiles}'s.
 * @returns {Promise<object>}
 * @throws {Error} when the sidebar exists and cannot be read; the import page
 *   then asks the user to quit Arc and try again (§4.2).
 */
export async function harvest(profile) {
  const counter = { skipped: 0 };
  let windows = [];
  let favorites = [];
  // Undefined when Arc has no sidebar, null when it cannot be read. The
  // underlying error's message names the path, so it travels only as the
  // cause, whose name alone is logged.
  let data;
  let failure = null;
  try {
    const path = PathUtils.join(profile.root, SIDEBAR);
    data = (await IOUtils.exists(path))
      ? dataContainer(await IOUtils.readJSON(path))
      : undefined;
  } catch (e) {
    data = null;
    failure = e;
  }
  if (data === null) {
    throw new Error("sval: the Arc sidebar could not be read", {
      cause: failure,
    });
  }
  const spaces = data ? pairs(data.spaces) : new Map();
  if (data) {
    const items = pairs(data.items);
    windows = Array.from(spaces)
      .filter(([, space]) => spaceProfile(space.profile) === profile.id)
      .map(([id, space]) => spaceWindow(id, space, items, counter))
      // A Space holding nothing importable would arrive as a blank
      // workspace (import spec §11).
      .filter(win => win.children.length);
    favorites = favoritesOf(data, items, profile.id, counter);
  }

  // An unreadable bookmarks file costs only its bookmarks; the Spaces and
  // Favorites still import.
  let chromium = null;
  try {
    chromium = await readBookmarks(profile.dir, counter);
  } catch {}
  const roots = {
    toolbar: [...favorites, ...(chromium?.toolbar ?? [])],
    menu: [],
    other: chromium?.other ?? [],
  };
  const bookmarks = roots.toolbar.length || roots.other.length ? roots : null;

  const archived = await archivedOf(profile, spaces, counter);
  const card = await arcCardFrom(profile);
  return {
    windows,
    bookmarks,
    logins: await countLogins(profile.dir),
    encryptedSession: false,
    skipped: counter.skipped,
    autoArchive: await autoArchiveOf(profile),
    ...(archived.length && { archived }),
    ...(card && { arcCard: card }),
  };
}

/**
 * The card Arc gave its user (`SvalCard.arcCardOf`), from two files beside
 * the sidebar, one per install. Either file missing or unreadable costs only
 * the card.
 *
 * @param {object} profile One of {@link findProfiles}'s.
 * @returns {Promise<object|null>}
 */
async function arcCardFrom(profile) {
  try {
    const [membership, auth] = await Promise.all(
      [MEMBERSHIP_CARD, AUTH_STATE].map(name =>
        IOUtils.readJSON(PathUtils.join(profile.root, name))
      )
    );
    return arcCardOf(membership, auth);
  } catch {
    return null;
  }
}

/**
 * The tabs Arc archived from this profile's Spaces, as `Archived` entries
 * (SvalImportModel), from `StorableArchiveItems.json`: `{ items: [id,
 * entry, …] }`, each entry `{ source: { space: { _0: id } }, sidebarItem,
 * archivedAt }`. An entry from a Space the sidebar no longer holds has no
 * profile to name, and goes with the default profile's. An unreadable file
 * costs only the archived tabs.
 *
 * @param {object} profile One of {@link findProfiles}'s.
 * @param {Map<string, object>} spaces The sidebar's Spaces, by id.
 * @param {{skipped: number}} counter
 * @returns {Promise<object[]>}
 */
async function archivedOf(profile, spaces, counter) {
  let json;
  try {
    json = await IOUtils.readJSON(PathUtils.join(profile.root, ARCHIVE));
  } catch {
    return [];
  }
  const archived = [];
  for (const entry of pairs(json?.items).values()) {
    const spaceId = entry.source?.space?._0;
    const space = typeof spaceId == "string" ? spaces.get(spaceId) : null;
    const owner = space ? spaceProfile(space.profile) : DEFAULT_PROFILE;
    if (owner !== profile.id) {
      continue;
    }
    const item = entry.sidebarItem ?? {};
    const tab = item.data?.tab;
    const at = entry.archivedAt;
    if (!tab || !importableUrl(tab.savedURL) || !Number.isFinite(at)) {
      counter.skipped++;
      continue;
    }
    const title = [item.title, tab.savedTitle].find(
      text => typeof text == "string" && text
    );
    archived.push({
      title: title ?? null,
      url: tab.savedURL,
      closedAt: (at + REFERENCE_DATE) * 1000,
      source: space ? spaceId : null,
    });
  }
  return archived;
}

/**
 * How long Arc let one of this profile's tabs go unused before archiving
 * it, as Sval's choice (idle-tab archive spec §7.5): the profile's own entry
 * in `autoArchiveTimeThresholdsPerProfile`, a JSON string of
 * `{"thresholds": [marker, choice, …]}` whose markers are the ones Spaces
 * carry, else the global `autoArchiveTimeThreshold`. Anything else, or no
 * file, is 7 days. Arc's settings are read on macOS only, where Firefox
 * builds its property-list reader.
 *
 * @param {object} profile One of {@link findProfiles}'s.
 * @returns {Promise<string>}
 */
async function autoArchiveOf(profile) {
  if (AppConstants.platform != "macosx") {
    return DEFAULT_CHOICE;
  }
  let prefs = null;
  try {
    prefs = await readPlist(
      PathUtils.join(
        PathUtils.parent(profile.root, 2),
        "Preferences",
        PREFERENCES
      )
    );
  } catch {
    // Not a property list: no choice to carry over.
  }
  let choice = prefs?.get?.("autoArchiveTimeThreshold");
  let thresholds = null;
  try {
    thresholds = JSON.parse(
      prefs?.get?.("autoArchiveTimeThresholdsPerProfile")
    )?.thresholds;
  } catch {}
  if (Array.isArray(thresholds)) {
    for (let i = 0; i + 1 < thresholds.length; i++) {
      const marker = thresholds[i];
      if (
        marker &&
        typeof marker == "object" &&
        spaceProfile(marker) === profile.id &&
        typeof thresholds[i + 1] == "string"
      ) {
        choice = thresholds[i + 1];
        break;
      }
    }
  }
  return Object.hasOwn(ARCHIVE_CHOICES, choice)
    ? ARCHIVE_CHOICES[choice]
    : DEFAULT_CHOICE;
}

/**
 * The sidebar container that holds Spaces and items: the one after the
 * `{global}` entry, or failing that the first that has both.
 *
 * @param {object} json The parsed sidebar.
 * @returns {object|null}
 */
function dataContainer(json) {
  const containers = json?.sidebar?.containers;
  if (!Array.isArray(containers)) {
    return null;
  }
  const hasData = c => Array.isArray(c?.spaces) && Array.isArray(c?.items);
  const global = containers.findIndex(
    c => c && typeof c == "object" && "global" in c
  );
  if (global >= 0 && hasData(containers[global + 1])) {
    return containers[global + 1];
  }
  return containers.find(hasData) ?? null;
}

/**
 * A flat `[id, object, id, object, …]` array as a Map.
 *
 * @param {Array} list
 * @returns {Map<string, object>}
 */
function pairs(list) {
  const map = new Map();
  if (!Array.isArray(list)) {
    return map;
  }
  for (let i = 0; i + 1 < list.length; i++) {
    if (
      typeof list[i] == "string" &&
      list[i + 1] &&
      typeof list[i + 1] == "object"
    ) {
      map.set(list[i], list[i + 1]);
      i++;
    }
  }
  return map;
}

/**
 * The profile directory a Space's or Favorites' marker names: `{default}` is
 * the default profile, `{custom: {_0: {directoryBasename}}}` another. A Space
 * with no marker belongs to the default profile.
 *
 * @param {object} marker
 * @returns {string|null}
 */
function spaceProfile(marker) {
  if (!marker || typeof marker != "object" || marker.default !== undefined) {
    return DEFAULT_PROFILE;
  }
  return marker.custom?._0?.directoryBasename ?? null;
}

/**
 * Whether a container list's entry is the given marker, written either as the
 * bare string or as an object keyed by it.
 *
 * @param {string|object} entry
 * @param {string} marker "pinned" or "unpinned".
 * @returns {boolean}
 */
function isMarker(entry, marker) {
  return (
    entry === marker ||
    (entry && typeof entry == "object" && Object.hasOwn(entry, marker))
  );
}

/**
 * A Space's containers of one kind, in the order its list gives them. Arc's
 * `SpaceModel` keeps them in `newContainerIDs`, as `[marker, id, …]` pairs, and
 * writes `containerIDs` beside it as a legacy copy that can name one container
 * of each kind. An unpinned marker is `shared` or `desktop`, a machine's and
 * window's own, so a Space can hold several, and all of them are read.
 *
 * @param {object} space
 * @param {string} marker "pinned" or "unpinned".
 * @returns {string[]}
 */
function containerIds(space, marker) {
  const list = Array.isArray(space.newContainerIDs)
    ? space.newContainerIDs
    : space.containerIDs;
  const ids = [];
  for (let i = 0; Array.isArray(list) && i + 1 < list.length; i++) {
    if (isMarker(list[i], marker) && typeof list[i + 1] == "string") {
      ids.push(list[++i]);
    }
  }
  return ids;
}

function spaceWindow(id, space, items, counter) {
  const children = [];
  // One `seen` for the whole Space, so an item two containers list arrives
  // once.
  const seen = new Set();
  for (const marker of ["pinned", "unpinned"]) {
    for (const containerId of new Set(containerIds(space, marker))) {
      const container = items.get(containerId);
      if (container) {
        children.push(
          ...walk(container.childrenIds, items, counter, tabNode, seen)
        );
      }
    }
  }
  const info = space.customInfo ?? {};
  const emoji = info.iconType?.emoji_v2;
  const midTone = info.windowTheme?.primaryColorPalette?.midTone;
  return {
    kind: "space",
    source: id,
    name: typeof space.title == "string" && space.title ? space.title : null,
    emoji: typeof emoji == "string" && emoji ? emoji : null,
    color: midTone ? nearestColor(midTone) : null,
    children,
  };
}

function favoritesOf(data, items, profileId, counter) {
  const list = data.topAppsContainerIDs;
  if (!Array.isArray(list)) {
    return [];
  }
  for (let i = 0; i + 1 < list.length; i++) {
    const marker = list[i];
    if (
      marker &&
      typeof marker == "object" &&
      spaceProfile(marker) === profileId &&
      typeof list[i + 1] == "string"
    ) {
      const container = items.get(list[i + 1]);
      // Arc's Favorites are pins, in every Space (pins spec §10).
      return container
        ? walk(container.childrenIds, items, counter, markNode).map(mark => ({
            ...mark,
            pinned: true,
          }))
        : [];
    }
  }
  return [];
}

const tabNode = {
  tab: (title, url, emoji) =>
    emoji ? { type: "tab", title, url, emoji } : { type: "tab", title, url },
  folder: (name, children) => ({ type: "group", name, color: null, children }),
  split: (name, children, shares) => [
    { type: "split", name, shares, children },
  ],
};

// Favorites stay flat: a split among them is its tabs, in its place.
const markNode = {
  tab: (title, url) => ({ type: "bookmark", title, url }),
  folder: (title, children) => ({ type: "folder", title, children }),
  split: (title, children) => children,
};

/**
 * Each pane's width factor, by item id, from a split's `itemWidthFactors`:
 * a flat `[id, factor, …]` list of fractions of the split's width. Arc can
 * leave a pane out, as its own starter split does, and a pane left out takes
 * an equal part of what the listed ones leave.
 *
 * @param {object} splitView The item's `data.splitView`.
 * @param {string[]} ids The split's pane ids.
 * @returns {Map<string, number>} Empty when there are no usable factors.
 */
function widthFactors(splitView, ids) {
  const listed = new Map();
  const list = splitView.itemWidthFactors;
  for (let i = 0; Array.isArray(list) && i + 1 < list.length; i += 2) {
    if (typeof list[i] == "string" && list[i + 1] > 0) {
      listed.set(list[i], list[i + 1]);
    }
  }
  const missing = ids.filter(id => !listed.has(id));
  const left = 1 - [...listed.values()].reduce((sum, f) => sum + f, 0);
  if (!listed.size || (missing.length && !(left > 0))) {
    return new Map();
  }
  for (const id of missing) {
    listed.set(id, left / missing.length);
  }
  return listed;
}

/**
 * Arc items in order, as nodes `make` builds. Kinds import does not carry
 * are counted as skipped.
 *
 * @param {string[]} ids Child item ids, in order.
 * @param {Map<string, object>} items Every sidebar item, by id.
 * @param {{skipped: number}} counter
 * @param {object} make {@link tabNode} or {@link markNode}.
 * @param {Set<string>} [seen] Ids already walked, so a cycle ends.
 * @returns {object[]}
 */
function walk(ids, items, counter, make, seen = new Set()) {
  const out = [];
  if (!Array.isArray(ids)) {
    return out;
  }
  for (const id of ids) {
    const item = items.get(id);
    if (!item || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const data = item.data ?? {};
    const title =
      typeof item.title == "string" && item.title ? item.title : null;
    if (data.tab) {
      const url = data.tab.savedURL;
      if (!importableUrl(url)) {
        counter.skipped++;
        continue;
      }
      const saved = data.tab.savedTitle;
      // The emoji Arc shows in place of the tab's icon.
      const emoji = data.tab.customInfo?.iconType?.emoji_v2;
      out.push(
        make.tab(
          title ?? (typeof saved == "string" && saved ? saved : null),
          url,
          typeof emoji == "string" && emoji ? emoji : null
        )
      );
    } else if (data.list) {
      const children = walk(item.childrenIds, items, counter, make, seen);
      if (children.length) {
        out.push(make.folder(title, children));
      }
    } else if (data.splitView) {
      // Where Arc keeps a split's name is unconfirmed: no export at hand
      // names one, and `title` is where a folder's lives.
      const paneIds = Array.isArray(item.childrenIds) ? item.childrenIds : [];
      const factors = widthFactors(data.splitView, paneIds);
      const panes = [];
      const widths = [];
      for (const pane of paneIds) {
        for (const node of walk([pane], items, counter, make, seen)) {
          panes.push(node);
          widths.push(factors.get(pane));
        }
      }
      if (panes.length) {
        out.push(...make.split(title, panes, factors.size ? widths : null));
      }
    } else {
      counter.skipped++;
    }
  }
  return out;
}

/**
 * Arc's history is its Chromium profile's, imported through Firefox's own
 * Chrome migrator pointed at Arc's `User Data` (§4.2).
 */
export { importHistory };
