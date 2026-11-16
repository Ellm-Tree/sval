/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Reads Zen's profiles for import: its Spaces, Essentials, bookmarks and
 * history (import spec §4.4).
 *
 * Zen is a Firefox, so its profiles, bookmarks and history are Firefox's and
 * are read by Firefox's reader. What it adds is the sidebar: every window
 * shows the same Spaces, kept in `zen-sessions.jsonlz4` in the profile as
 * `{ tabs, folders, groups, spaces }`. Each tab names its Space in
 * `zenWorkspace`; a tab in a folder or tab group names it in `groupId`; a
 * folder names the folder it is inside in `parentId`. A split view is a tab
 * group or folder marked `splitView` or `splitViewGroup`, its layout kept in
 * `splitViewData` under its `groupId`. Essentials are `zenEssential` tabs
 * shown in every Space, and are imported as Favorites, as Arc's are. The
 * format is read from Zen's source (`ZenSessionManager`, `ZenFolders`,
 * `ZenViewSplitter.storeDataForSessionStore`, its `TabState` patch) as of
 * 2026-10.
 *
 * Read only, as Firefox's reader is (SvalImportFiles).
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { nearestColor } from "moz-src:///browser/components/sval/SvalImportModel.sys.mjs";
import { isPreset } from "moz-src:///browser/components/sval/SvalColor.sys.mjs";
import {
  findProfiles as findFirefoxProfiles,
  importBookmarks as importFirefoxBookmarks,
  importHistory as importFirefoxHistory,
  readBookmarks,
  readSessionFile,
  tabNode,
} from "moz-src:///browser/components/sval/SvalImportFirefox.sys.mjs";

const SOURCE = "zen";

const SIDEBAR = "zen-sessions.jsonlz4";

/** Folders nest; nesting deeper than this is a loop in the file. */
const MAX_DEPTH = 32;

/**
 * The directories Zen keeps `profiles.ini` in. Its `MOZ_APP_PROFILE` is
 * `zen`, so they are Firefox's with `zen` for `Mozilla/Firefox`: Linux's
 * legacy `~/.zen`, its XDG one, and the Flatpak's `~/.zen` inside its own
 * home.
 *
 * @returns {string[]}
 */
export function defaultRoots() {
  const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
  if (AppConstants.platform === "macosx") {
    return [PathUtils.join(home, "Library", "Application Support", "zen")];
  }
  if (AppConstants.platform === "win") {
    const appData = Services.dirsvc.get("AppData", Ci.nsIFile).path;
    return [PathUtils.join(appData, "zen")];
  }
  const xdg =
    Services.env.get("XDG_CONFIG_HOME") || PathUtils.join(home, ".config");
  return [
    PathUtils.join(home, ".zen"),
    PathUtils.join(xdg, "zen"),
    PathUtils.join(home, ".var", "app", "app.zen_browser.zen", ".zen"),
  ];
}

/**
 * @param {string[]} [roots] Directories holding a `profiles.ini`.
 * @returns {Promise<object[]>} `[{ source, id, name, dir }]`.
 */
export function findProfiles(roots = defaultRoots()) {
  return findFirefoxProfiles(roots, SOURCE);
}

/**
 * One Space per window, Essentials and bookmarks as Favorites (§3). Logins
 * are never read, as Firefox's are not.
 *
 * @param {object} profile One of {@link findProfiles}'s results.
 * @returns {Promise<object>} A `Harvest` (SvalImportModel).
 */
export async function harvest(profile) {
  const state = { skipped: 0 };
  const sidebar = await readSidebar(profile.dir);
  return {
    windows: sidebar ? spaceWindows(sidebar, state) : [],
    bookmarks: withEssentials(
      sidebar,
      await readBookmarks(profile.dir, state),
      state
    ),
    logins: null,
    encryptedSession: false,
    skipped: state.skipped,
  };
}

/**
 * The profile's Essentials and bookmarks as they are now, read as Firefox's
 * reader reads its bookmarks for an import.
 *
 * @param {object} profile One of {@link findProfiles}'s results.
 * @returns {Promise<object|null>} `Roots`, or null when there are none.
 */
export async function importBookmarks(profile) {
  return withEssentials(
    await readSidebar(profile.dir),
    await importFirefoxBookmarks(profile),
    { skipped: 0 }
  );
}

/**
 * Places' bookmarks with the sidebar's Essentials ahead of the toolbar's.
 *
 * @param {object|null} sidebar
 * @param {object|null} places `Roots`.
 * @param {object} state `{ skipped }`, counted into.
 * @returns {object|null} `Roots`.
 */
function withEssentials(sidebar, places, state) {
  const essentials = sidebar ? essentialMarks(sidebar, state) : [];
  if (!essentials.length) {
    return places;
  }
  const bookmarks = places ?? { toolbar: [], menu: [], other: [] };
  bookmarks.toolbar = [...essentials, ...bookmarks.toolbar];
  return bookmarks;
}

/** Zen's history is Firefox's. */
export const importHistory = importFirefoxHistory;

/**
 * The sidebar: `zen-sessions.jsonlz4`, else the first window of Firefox's
 * session file, which carries the same four lists. A Zen that predates the
 * sidebar file wrote them there only.
 *
 * @param {string} dir The profile directory.
 * @returns {Promise<object|null>}
 */
async function readSidebar(dir) {
  const path = PathUtils.join(dir, SIDEBAR);
  if (await IOUtils.exists(path)) {
    let data;
    try {
      data = await IOUtils.readJSON(path, { decompress: true });
    } catch (e) {
      throw new Error(`Zen sidebar could not be read (${e.name})`, {
        cause: e,
      });
    }
    if (Array.isArray(data?.tabs)) {
      return data;
    }
  }
  const session = await readSessionFile(dir);
  return session?.windows.find(win => win && !win.isPrivate) ?? null;
}

const list = value => (Array.isArray(value) ? value : []);

/**
 * Whether a tab is one Zen shows: not the placeholder an empty Space or
 * folder holds, and not a Glance preview.
 *
 * @param {object} tab
 * @returns {boolean}
 */
function shown(tab) {
  return !!tab && !tab.zenIsEmpty && !tab.zenIsGlance;
}

/**
 * Each Space, in Zen's order, as a window of its tabs, folders and groups.
 * Tabs naming no Space Zen lists go into one window of their own.
 *
 * @param {object} sidebar
 * @param {object} state `{ skipped }`, counted into.
 * @returns {object[]}
 */
function spaceWindows(sidebar, state) {
  const spaces = list(sidebar.spaces)
    .filter(space => typeof space?.uuid === "string")
    .map((space, at) => ({ space, at }))
    .sort(
      (a, b) =>
        (Number.isFinite(a.space.position) ? a.space.position : a.at) -
          (Number.isFinite(b.space.position) ? b.space.position : b.at) ||
        a.at - b.at
    )
    .map(({ space }) => space);
  const known = new Set(spaces.map(space => space.uuid));
  const bySpace = new Map();
  for (const tab of list(sidebar.tabs)) {
    if (!shown(tab) || tab.zenEssential) {
      continue;
    }
    const key = known.has(tab.zenWorkspace) ? tab.zenWorkspace : null;
    if (!bySpace.has(key)) {
      bySpace.set(key, []);
    }
    bySpace.get(key).push(tab);
  }

  const containers = containerInfo(sidebar);
  const windows = [];
  for (const space of spaces) {
    const children = spaceNodes(
      bySpace.get(space.uuid) ?? [],
      containers,
      state
    );
    if (children.length) {
      windows.push({
        kind: "space",
        name: typeof space.name === "string" && space.name ? space.name : null,
        emoji: spaceEmoji(space.icon),
        color: spaceColor(space.theme),
        children,
      });
    }
  }
  const loose = spaceNodes(bySpace.get(null) ?? [], containers, state);
  if (loose.length) {
    windows.push({
      kind: "window",
      name: null,
      emoji: null,
      color: null,
      children: loose,
    });
  }
  return windows;
}

/**
 * Folders, tab groups and split views by id: what each is called, its
 * colour, the folder it is inside, and for a split view its panes' widths.
 *
 * @param {object} sidebar
 * @returns {Map<string, object>} `{ name, color, parent, split, sizes }`.
 */
function containerInfo(sidebar) {
  const layouts = new Map();
  for (const data of list(sidebar.splitViewData)) {
    if (data?.groupId != null) {
      layouts.set(String(data.groupId), data);
    }
  }
  const sizes = (id, split) => (split ? paneSizes(layouts.get(id)) : null);
  const info = new Map();
  for (const group of list(sidebar.groups)) {
    if (group?.id == null) {
      continue;
    }
    const id = String(group.id);
    const split = !!group.splitView || !!group.splitViewGroup;
    info.set(id, {
      name: (typeof group.name === "string" && group.name) || null,
      color: isPreset(group.color) ? group.color : null,
      parent: null,
      split,
      sizes: sizes(id, split),
    });
  }
  for (const folder of list(sidebar.folders)) {
    if (folder?.id == null) {
      continue;
    }
    const id = String(folder.id);
    const split = !!folder.splitViewGroup;
    info.set(id, {
      name: (typeof folder.name === "string" && folder.name) || null,
      color: null,
      parent: folder.parentId == null ? null : String(folder.parentId),
      split,
      sizes: sizes(id, split),
    });
  }
  return info;
}

/**
 * A split view's pane widths by tab id, in the order its layout shows them,
 * for a `vsep` split only: its layout is one row of panes, each
 * `sizeInParent` percent of the row. Sval has no top/bottom or grid layout,
 * so an `hsep` or `grid` split lands side by side with equal widths
 * (split-view spec §7).
 *
 * @param {object} [data] The split's `splitViewData` entry.
 * @returns {Map<string, number>|null}
 */
function paneSizes(data) {
  const tree = data?.layoutTree;
  if (
    data?.gridType !== "vsep" ||
    tree?.type !== "splitter" ||
    tree.direction !== "row"
  ) {
    return null;
  }
  const sizes = new Map();
  for (const leaf of list(tree.children)) {
    if (leaf?.type !== "leaf" || !(leaf.sizeInParent > 0)) {
      return null;
    }
    sizes.set(String(leaf.tabId), leaf.sizeInParent);
  }
  return sizes;
}

/**
 * A Space's tabs as nodes: each folder or group one group node and each
 * split view one split node, inside the folder it is inside, placed where its
 * first tab is.
 *
 * @param {object[]} tabs The Space's tabs, in Zen's order.
 * @param {Map<string, object>} containers From {@link containerInfo}.
 * @param {object} state `{ skipped }`, counted into.
 * @returns {object[]}
 */
function spaceNodes(tabs, containers, state) {
  const top = [];
  const nodes = new Map();
  // Each split's panes' tab ids, beside its children, and its layout.
  const panes = new Map();
  const into = (id, depth = 0) => {
    const c = id == null ? null : containers.get(String(id));
    if (!c || depth > MAX_DEPTH) {
      return top;
    }
    if (!nodes.has(c)) {
      const node = c.split
        ? { type: "split", name: c.name, shares: null, children: [] }
        : { type: "group", name: c.name, color: c.color, children: [] };
      nodes.set(c, node);
      into(c.parent, depth + 1).push(node);
    }
    return nodes.get(c).children;
  };
  for (const tab of tabs) {
    const node = tabNode(tab, state);
    if (!node) {
      continue;
    }
    into(tab.groupId).push(node);
    const c = tab.groupId == null ? null : containers.get(String(tab.groupId));
    if (c?.split) {
      const split = nodes.get(c);
      if (!panes.has(split)) {
        panes.set(split, { ids: [], sizes: c.sizes });
      }
      panes.get(split).ids.push(String(tab.zenSyncId));
    }
  }
  // A vsep split shows its panes in its layout's order, which moving a pane
  // in the split changes without moving the tabs, so the panes take that
  // order with their widths.
  for (const [split, { ids, sizes }] of panes) {
    if (!sizes || !ids.every(id => sizes.has(id))) {
      continue;
    }
    const order = [...sizes.keys()];
    const placed = split.children
      .map((child, at) => ({ child, id: ids[at] }))
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    split.children = placed.map(pane => pane.child);
    split.shares = placed.map(pane => sizes.get(pane.id));
  }
  return prune(top);
}

/**
 * Drops group and split nodes left with no tabs, at any depth.
 *
 * @param {object[]} nodes
 * @returns {object[]}
 */
function prune(nodes) {
  const out = [];
  for (const node of nodes) {
    if (node.type === "tab") {
      out.push(node);
      continue;
    }
    node.children = prune(node.children);
    if (node.children.length) {
      out.push(node);
    }
  }
  return out;
}

/**
 * A Space's icon is an emoji, or the URL of an SVG of Zen's own set, which
 * is not carried.
 *
 * @param {*} icon
 * @returns {string|null}
 */
function spaceEmoji(icon) {
  if (typeof icon !== "string" || !icon || icon.length > 16) {
    return null;
  }
  return /[:/.]/.test(icon) ? null : icon;
}

/**
 * A Space's colour: the nearest token to its theme's primary gradient
 * colour, `c` being `[r, g, b]` from 0 to 255.
 *
 * @param {object} theme
 * @returns {string|null}
 */
function spaceColor(theme) {
  const colors = list(theme?.gradientColors).filter(color =>
    Array.isArray(color?.c)
  );
  const primary = colors.find(color => color.isPrimary) ?? colors[0];
  if (!primary) {
    return null;
  }
  const [red, green, blue] = primary.c.map(v => Number(v) / 255);
  return nearestColor({ red, green, blue });
}

/**
 * Essentials, once each, as bookmarks.
 *
 * @param {object} sidebar
 * @param {object} state `{ skipped }`, counted into.
 * @returns {object[]}
 */
function essentialMarks(sidebar, state) {
  const seen = new Set();
  const marks = [];
  for (const tab of list(sidebar.tabs)) {
    if (!shown(tab) || !tab.zenEssential) {
      continue;
    }
    const node = tabNode(tab, state);
    if (node && !seen.has(node.url)) {
      seen.add(node.url);
      marks.push({
        type: "bookmark",
        title: tab.zenStaticLabel || node.title,
        url: node.url,
        pinned: true,
      });
    }
  }
  return marks;
}
