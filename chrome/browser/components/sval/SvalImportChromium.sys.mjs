/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Reads the Chromium browsers' profiles for import (import spec §4.1):
 * Chrome, Edge, Brave, Vivaldi and Dia.
 *
 * Dia keeps its open tabs in an encrypted database of its own, so its
 * session holds no tabs and only its bookmarks, history and login count
 * import. Dia is listed on macOS alone: its Windows build is a beta whose
 * data directory is not documented.
 *
 * Read only (SvalImportFiles). Arc's reader is this one with Arc's sidebar
 * added, so what is exported here is what it shares.
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import {
  chromiumColor,
  DEFAULT_PROFILE,
  importableUrl,
  nearestColor,
} from "moz-src:///browser/components/sval/SvalImportModel.sys.mjs";
import { readLevelDB } from "moz-src:///browser/components/sval/SvalImportLevelDB.sys.mjs";
import {
  isDirectory,
  withCopy,
} from "moz-src:///browser/components/sval/SvalImportFiles.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ChromeProfileMigrator: "resource:///modules/ChromeProfileMigrator.sys.mjs",
  MigrationUtils: "resource:///modules/MigrationUtils.sys.mjs",
});

/**
 * Each source's user data directories, per platform, as path segments below
 * the home directory or, on Windows, below `LocalAppData`. The first of each
 * is the one `ChromeMigrationUtils.getDataPath` resolves, so a profile found
 * there is one Firefox's migrator can import history from; the migrator here
 * is pointed at whichever directory the profile was found in. Linux adds each
 * browser's Flatpak and Snap homes.
 */
const DATA_PATHS = Object.freeze({
  macosx: {
    chrome: [["Library", "Application Support", "Google", "Chrome"]],
    edge: [["Library", "Application Support", "Microsoft Edge"]],
    brave: [
      ["Library", "Application Support", "BraveSoftware", "Brave-Browser"],
    ],
    vivaldi: [["Library", "Application Support", "Vivaldi"]],
    dia: [["Library", "Application Support", "Dia", "User Data"]],
  },
  win: {
    chrome: [["Google", "Chrome", "User Data"]],
    edge: [["Microsoft", "Edge", "User Data"]],
    brave: [["BraveSoftware", "Brave-Browser", "User Data"]],
    vivaldi: [["Vivaldi", "User Data"]],
  },
  linux: {
    chrome: [
      [".config", "google-chrome"],
      [".var", "app", "com.google.Chrome", "config", "google-chrome"],
    ],
    edge: [
      [".config", "microsoft-edge"],
      [".var", "app", "com.microsoft.Edge", "config", "microsoft-edge"],
    ],
    brave: [
      [".config", "BraveSoftware", "Brave-Browser"],
      [
        ".var",
        "app",
        "com.brave.Browser",
        "config",
        "BraveSoftware",
        "Brave-Browser",
      ],
      ["snap", "brave", "current", ".config", "BraveSoftware", "Brave-Browser"],
    ],
    vivaldi: [
      [".config", "vivaldi"],
      [".var", "app", "com.vivaldi.Vivaldi", "config", "vivaldi"],
      ["snap", "vivaldi", "current", ".config", "vivaldi"],
    ],
  },
});

/**
 * Every Chromium browser's user data directories on this platform.
 *
 * @returns {object[]} `[{ source, dir }]`.
 */
export function defaultRoots() {
  const platform = AppConstants.platform;
  const paths = DATA_PATHS[platform] ?? DATA_PATHS.linux;
  const base = Services.dirsvc.get(
    platform === "win" ? "LocalAppData" : "Home",
    Ci.nsIFile
  ).path;
  return Object.entries(paths).flatMap(([source, dirs]) =>
    dirs.map(segments => ({ source, dir: PathUtils.join(base, ...segments) }))
  );
}

/**
 * Every Chromium profile under the given user data directories, from
 * `Local State`'s `profile.info_cache`. A data directory without a readable
 * `Local State` offers its `Default` profile, as Firefox's migrator does.
 *
 * @param {object[]} [roots] `[{ source, dir }]`, `dir` a user data directory.
 * @returns {Promise<object[]>} `[{ source, id, name, dir }]`, where `id` is the
 *   profile's directory name and `name` its display name.
 */
export async function findProfiles(roots = defaultRoots()) {
  const profiles = [];
  for (const { source, dir: root } of roots) {
    const entries = (await listedProfiles(root)) ?? [
      { id: DEFAULT_PROFILE, name: null },
    ];
    for (const { id, name } of entries) {
      const dir = PathUtils.join(root, id);
      if (await isDirectory(dir)) {
        profiles.push({ source, id, name, dir });
      }
    }
  }
  return profiles;
}

/**
 * Profiles a browser makes for its own use, by the name it gives them. Dia
 * signs in to work accounts in a profile named so (the name is in Dia's
 * binary); it holds none of the user's tabs or bookmarks.
 */
const INTERNAL_PROFILE_NAMES = new Set(["Embedded_SSO_Temp"]);

/**
 * The profiles a user data directory's `Local State` lists in
 * `profile.info_cache`, less the browser's own internal ones.
 *
 * @param {string} root A user data directory.
 * @returns {Promise<object[]|null>} `[{ id, name }]`, where `id` is the
 *   profile's directory name and `name` the name the user gave it, or null
 *   while it has the name the browser made up (`is_using_default_name`, as
 *   "Your Chrome" or "Person 1"); null when `Local State` is absent or
 *   unreadable.
 */
export async function listedProfiles(root) {
  try {
    const state = await IOUtils.readJSON(PathUtils.join(root, "Local State"));
    const cache = state?.profile?.info_cache;
    if (cache && typeof cache === "object") {
      return Object.entries(cache)
        .filter(([, info]) => !INTERNAL_PROFILE_NAMES.has(info?.name))
        .map(([id, info]) => ({
          id,
          name:
            typeof info?.name === "string" &&
            info.name &&
            info.is_using_default_name !== true
              ? info.name
              : null,
        }));
    }
  } catch {}
  return null;
}

/**
 * Open windows, bookmarks and the saved-login count from one profile (§4.1).
 *
 * @param {object} profile One of {@link findProfiles}'s results.
 * @returns {Promise<object>} A `Harvest` (SvalImportModel).
 */
export async function harvest(profile) {
  const state = { skipped: 0 };
  let workspaces = null;
  if (profile.source === "vivaldi") {
    workspaces = await readVivaldiWorkspaces(profile.dir);
  } else if (profile.source === "edge") {
    workspaces = await readEdgeWorkspaces(profile.dir);
  }
  const session = await readSession(profile, state, workspaces);
  return {
    windows: session.windows,
    bookmarks: await readBookmarks(profile.dir, state),
    logins: await countLogins(profile.dir),
    encryptedSession: session.encrypted,
    skipped: state.skipped,
  };
}

// Sessions

/** `SNSS`, read as a little-endian int32 (`SessionFileReader`). */
const SNSS_MAGIC = 0x53534e53;

/** Cleartext SNSS versions: `kFileVersion1` and `kFileVersionWithMarker`. */
const SNSS_VERSIONS = new Set([1, 3]);

/** Command ids, from `components/sessions/core/session_service_commands.cc`. */
const CMD = Object.freeze({
  setTabWindow: 0,
  setTabIndexInWindow: 2,
  prunedFromBack: 5,
  updateTabNavigation: 6,
  setSelectedNavigationIndex: 7,
  setWindowType: 9,
  prunedFromFront: 11,
  tabClosed: 16,
  windowClosed: 17,
  prunedRange: 24,
  setTabGroup: 25,
  setTabGroupMetadata2: 27,
  // Edge's, undocumented: present on a window that is an Edge Workspace
  // (§4.1). A pickle of the window's id and the Workspace's id, a string.
  edgeWorkspace: 48,
  // Vivaldi's, undocumented: a pickle of the tab's id and its `vivExtData`,
  // a JSON object whose `workspaceId` names the workspace the tab is in and
  // whose `group` names the tab stack it is in. Chromium's own command 21 is
  // a tab's last active time, so this is read only from Vivaldi.
  vivaldiTabExtData: 21,
  // `kInitialStateMarkerCommandId`: the file holds a complete initial state.
  marker: 255,
});

/** `SessionWindow::TYPE_NORMAL`. Popups, apps and devtools are not imported. */
const WINDOW_TYPE_NORMAL = 0;

const SESSION_FILE = /^Session_(\d+)$/;

/**
 * The open windows of the newest session file that holds a complete initial
 * state, else of the newest session file.
 *
 * @param {object} profile
 * @param {object} state `{ skipped }`, counted into.
 * @param {Map|null} workspaces Vivaldi's workspaces, from
 *   {@link readVivaldiWorkspaces}, or Edge's, from
 *   {@link readEdgeWorkspaces}; null for every other browser.
 * @returns {Promise<{windows: object[], encrypted: boolean}>}
 */
async function readSession(profile, state, workspaces) {
  const files = await sessionFiles(PathUtils.join(profile.dir, "Sessions"));
  if (!files.length) {
    const encrypted = (
      await sessionFiles(PathUtils.join(profile.dir, "Sessions_Encrypted"))
    ).length;
    return { windows: [], encrypted: encrypted > 0 };
  }
  let chosen = null;
  for (const name of files) {
    let bytes;
    try {
      bytes = await IOUtils.read(PathUtils.join(profile.dir, "Sessions", name));
    } catch (e) {
      throw new Error(`Chromium session is not readable (${e.name})`, {
        cause: e,
      });
    }
    const commands = parseSnss(bytes);
    chosen ??= commands;
    if (commands.some(c => c.id === CMD.marker)) {
      chosen = commands;
      break;
    }
  }
  return {
    windows: buildWindows(replay(chosen, profile.source), state, workspaces),
    encrypted: false,
  };
}

/**
 * `Session_<ts>` file names in `dir`, newest first.
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function sessionFiles(dir) {
  let children;
  try {
    children = await IOUtils.getChildren(dir);
  } catch {
    return [];
  }
  return children
    .map(path => PathUtils.filename(path))
    .filter(name => SESSION_FILE.test(name))
    .sort((a, b) => {
      const ta = BigInt(SESSION_FILE.exec(a)[1]);
      const tb = BigInt(SESSION_FILE.exec(b)[1]);
      if (ta === tb) {
        return 0;
      }
      return ta < tb ? 1 : -1;
    });
}

/**
 * Splits an SNSS file into commands. A command whose size runs past the end
 * of the file is the tail of an interrupted write, and reading stops there,
 * as `SessionFileReader::ReadCommand` does.
 *
 * @param {Uint8Array} bytes
 * @returns {object[]} `[{ id, payload: DataView }]`.
 */
function parseSnss(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.byteLength < 8 ||
    view.getInt32(0, true) !== SNSS_MAGIC ||
    !SNSS_VERSIONS.has(view.getInt32(4, true))
  ) {
    throw new Error("Chromium session is not a cleartext SNSS file");
  }
  const commands = [];
  let offset = 8;
  while (offset + 2 <= bytes.byteLength) {
    const size = view.getUint16(offset, true);
    offset += 2;
    if (size === 0 || offset + size > bytes.byteLength) {
      break;
    }
    commands.push({
      id: bytes[offset],
      payload: new DataView(
        bytes.buffer,
        bytes.byteOffset + offset + 1,
        size - 1
      ),
    });
    offset += size;
  }
  return commands;
}

/**
 * Replays commands into tabs and windows as Chromium's
 * `CreateTabsAndWindows` does: each command overwrites what an earlier one
 * said, and a command too short for its fields is ignored.
 *
 * @param {object[]} commands From {@link parseSnss}.
 * @param {string} source The profile's `source`.
 * @returns {{tabs: Map, windows: Map, groups: Map}}
 */
function replay(commands, source) {
  const tabs = new Map();
  const windows = new Map();
  const groups = new Map();
  const tab = id => {
    if (!tabs.has(id)) {
      tabs.set(id, {
        window: null,
        index: -1,
        current: -1,
        navigations: [],
        group: null,
        stack: null,
        workspace: null,
      });
    }
    return tabs.get(id);
  };
  const win = id => {
    if (!windows.has(id)) {
      windows.set(id, { type: WINDOW_TYPE_NORMAL, edgeWorkspace: null });
    }
    return windows.get(id);
  };

  for (const { id, payload: p } of commands) {
    const n = p.byteLength;
    try {
      switch (id) {
        case CMD.setTabWindow:
          if (n >= 8) {
            const w = p.getInt32(0, true);
            win(w);
            tab(p.getInt32(4, true)).window = w;
          }
          break;
        case CMD.setTabIndexInWindow:
          if (n >= 8) {
            tab(p.getInt32(0, true)).index = p.getInt32(4, true);
          }
          break;
        case CMD.setSelectedNavigationIndex:
          if (n >= 8) {
            tab(p.getInt32(0, true)).current = p.getInt32(4, true);
          }
          break;
        case CMD.setWindowType:
          if (n >= 8) {
            win(p.getInt32(0, true)).type = p.getInt32(4, true);
          }
          break;
        case CMD.tabClosed:
          if (n >= 4) {
            tabs.delete(p.getInt32(0, true));
          }
          break;
        case CMD.windowClosed:
          if (n >= 4) {
            windows.delete(p.getInt32(0, true));
          }
          break;
        case CMD.updateTabNavigation: {
          const nav = readNavigation(p);
          if (nav) {
            const t = tab(nav.tab);
            const at = t.navigations.findIndex(e => e.index >= nav.index);
            if (at === -1) {
              t.navigations.push(nav);
            } else if (t.navigations[at].index === nav.index) {
              t.navigations[at] = nav;
            } else {
              t.navigations.splice(at, 0, nav);
            }
          }
          break;
        }
        case CMD.prunedFromBack:
          if (n >= 8) {
            const t = tab(p.getInt32(0, true));
            const from = p.getInt32(4, true);
            t.navigations = t.navigations.filter(e => e.index < from);
          }
          break;
        case CMD.prunedFromFront:
          if (n >= 8) {
            const t = tab(p.getInt32(0, true));
            const count = p.getInt32(4, true);
            t.current = Math.max(-1, t.current - count);
            t.navigations = t.navigations
              .filter(e => e.index >= count)
              .map(e => ({ ...e, index: e.index - count }));
          }
          break;
        case CMD.prunedRange:
          if (n >= 12) {
            const t = tab(p.getInt32(0, true));
            const from = p.getInt32(4, true);
            const count = p.getInt32(8, true);
            if (t.current >= from + count) {
              t.current -= count;
            } else if (t.current >= from) {
              t.current = Math.max(0, from - 1);
            }
            t.navigations = t.navigations
              .filter(e => e.index < from || e.index >= from + count)
              .map(e =>
                e.index >= from + count ? { ...e, index: e.index - count } : e
              );
          }
          break;
        case CMD.setTabGroup:
          // { int32 tab; pad; uint64 high; uint64 low; bool has_group; pad }
          if (n >= 25) {
            tab(p.getInt32(0, true)).group = p.getUint8(24)
              ? tokenKey(p, 8)
              : null;
          }
          break;
        case CMD.setTabGroupMetadata2: {
          const meta = readGroupMetadata(p);
          if (meta) {
            groups.set(meta.token, {
              title: meta.title,
              color: chromiumColor(meta.color),
            });
          }
          break;
        }
        case CMD.edgeWorkspace:
          if (source === "edge" && n >= 8) {
            win(p.getInt32(4, true)).edgeWorkspace = readEdgeWorkspaceId(p, n);
          }
          break;
        case CMD.vivaldiTabExtData:
          if (source === "vivaldi") {
            const ext = readVivaldiExtData(p);
            if (ext) {
              const t = tab(ext.tab);
              t.workspace = ext.workspace;
              t.stack = ext.stack?.key ?? null;
              if (ext.stack) {
                groups.set(ext.stack.key, ext.stack);
              }
            }
          }
          break;
      }
    } catch {
      // A malformed command is one bad item; the rest of the log still reads.
    }
  }
  return { tabs, windows, groups };
}

/**
 * A group token's sixteen bytes as a map key.
 *
 * @param {DataView} view
 * @param {number} offset
 * @returns {string}
 */
function tokenKey(view, offset) {
  let key = "";
  for (let i = 0; i < 16; i++) {
    key += view
      .getUint8(offset + i)
      .toString(16)
      .padStart(2, "0");
  }
  return key;
}

/**
 * A reader over a `base::Pickle`: a uint32 payload size, then fields each
 * aligned to four bytes.
 */
class PickleReader {
  constructor(view) {
    this.view = view;
    this.offset = 4;
  }
  #need(n) {
    if (this.offset + n > this.view.byteLength) {
      throw new RangeError("pickle too short");
    }
  }
  int() {
    this.#need(4);
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }
  uint() {
    this.#need(4);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }
  skip(n) {
    this.#need(n);
    this.offset += (n + 3) & ~3;
  }
  string() {
    const length = this.int();
    this.#need(length);
    const bytes = new Uint8Array(
      this.view.buffer,
      this.view.byteOffset + this.offset,
      length
    );
    this.offset += (length + 3) & ~3;
    return new TextDecoder().decode(bytes);
  }
  string16() {
    const length = this.int();
    this.#need(length * 2);
    let s = "";
    for (let i = 0; i < length; i++) {
      s += String.fromCharCode(this.view.getUint16(this.offset + i * 2, true));
    }
    this.offset += (length * 2 + 3) & ~3;
    return s;
  }
}

/**
 * Command 6: the tab id, then `SerializedNavigationEntry::WriteToPickle`'s
 * leading fields (index, virtual URL, title).
 *
 * @param {DataView} view
 * @returns {object|null}
 */
function readNavigation(view) {
  try {
    const r = new PickleReader(view);
    const tab = r.int();
    const index = r.int();
    const url = r.string();
    const title = r.string16();
    return { tab, index, url, title };
  } catch {
    return null;
  }
}

/**
 * Vivaldi's tab stack colours, as `vivExtData.groupColor` names them:
 * `color1` to `color9` are grey, blue, red, yellow, green, pink, purple, teal
 * and orange (Vivaldi 8.2's stack editor), which is Chromium's
 * `TabGroupColorId` order counted from one.
 */
const VIVALDI_STACK_COLOR = /^color([1-9])$/;

/**
 * Vivaldi's command 21: the tab id, then its `vivExtData` JSON. A tab in a
 * tab stack carries the stack's id in `group`, and every tab of the stack
 * carries its title in `fixedGroupTitle` and its colour in `groupColor`, as
 * of Vivaldi 8.2.
 *
 * @param {DataView} view
 * @returns {{tab: number, workspace: number|null, stack: object|null}|null}
 *   `stack` is `{ key, title, color }`, keyed apart from Chromium's group
 *   tokens.
 */
function readVivaldiExtData(view) {
  try {
    const r = new PickleReader(view);
    const tab = r.int();
    const ext = JSON.parse(r.string());
    const id = ext?.workspaceId;
    let stack = null;
    if (typeof ext?.group === "string" && ext.group) {
      const color = VIVALDI_STACK_COLOR.exec(ext.groupColor ?? "");
      stack = {
        key: `vivaldi:${ext.group}`,
        title:
          typeof ext.fixedGroupTitle === "string" && ext.fixedGroupTitle
            ? ext.fixedGroupTitle
            : null,
        color: color ? chromiumColor(Number(color[1]) - 1) : null,
      };
    }
    return { tab, workspace: Number.isFinite(id) ? id : null, stack };
  } catch {
    return null;
  }
}

/**
 * Command 27: the group token, its title and its colour.
 *
 * @param {DataView} view
 * @returns {object|null}
 */
function readGroupMetadata(view) {
  try {
    const r = new PickleReader(view);
    r.skip(16);
    const token = tokenKey(view, 4);
    const title = r.string16();
    const color = r.uint();
    return { token, title, color };
  } catch {
    return null;
  }
}

/**
 * The navigation a tab shows: the one at its selected index, else the first
 * after it, else its last, as `FindClosestNavigationWithIndex` picks.
 *
 * @param {object} t A replayed tab.
 * @returns {object}
 */
function selectedNavigation(t) {
  return t.navigations.find(e => e.index >= t.current) ?? t.navigations.at(-1);
}

/**
 * The replayed state as harvest windows: normal windows in id order, their
 * tabs in index order, and each run of tabs sharing a group token one group.
 * A Vivaldi tab in a workspace goes to that workspace's window instead, one
 * per workspace whichever windows its tabs are in, after the plain windows
 * and in the order Vivaldi lists its workspaces. An Edge Workspace's window
 * takes its name and colour from Edge's own record of the Workspace, where
 * there is one.
 *
 * @param {object} replayed From {@link replay}.
 * @param {object} state `{ skipped }`, counted into.
 * @param {Map|null} workspaces From {@link readVivaldiWorkspaces} or
 *   {@link readEdgeWorkspaces}.
 * @returns {object[]}
 */
function buildWindows(replayed, state, workspaces) {
  const { tabs, windows, groups } = replayed;
  const byWindow = new Map();
  for (const [id, t] of tabs) {
    if (t.window === null || !windows.has(t.window) || !t.navigations.length) {
      continue;
    }
    if (!byWindow.has(t.window)) {
      byWindow.set(t.window, []);
    }
    byWindow.get(t.window).push({ id, ...t });
  }
  const result = [];
  const inWorkspace = new Map();
  const ids = [...byWindow.keys()].sort((a, b) => a - b);
  for (const windowId of ids) {
    const w = windows.get(windowId);
    if (w.type !== WINDOW_TYPE_NORMAL) {
      continue;
    }
    const ordered = byWindow
      .get(windowId)
      .sort((a, b) => a.index - b.index || a.id - b.id);
    const plain = [];
    for (const t of ordered) {
      if (t.workspace === null) {
        plain.push(t);
      } else {
        if (!inWorkspace.has(t.workspace)) {
          inWorkspace.set(t.workspace, []);
        }
        inWorkspace.get(t.workspace).push(t);
      }
    }
    const children = tabNodes(plain, groups, state);
    if (children.length) {
      const edge =
        w.edgeWorkspace === null ? null : workspaces?.get(w.edgeWorkspace);
      result.push({
        kind: w.edgeWorkspace === null ? "window" : "edgeWorkspace",
        name: edge?.name ?? null,
        emoji: null,
        color: edge?.color ?? null,
        children,
      });
    }
  }
  const listed = [...(workspaces?.keys() ?? [])];
  const order = [
    ...listed.filter(id => inWorkspace.has(id)),
    ...[...inWorkspace.keys()].filter(id => !workspaces?.has(id)),
  ];
  for (const id of order) {
    const children = tabNodes(inWorkspace.get(id), groups, state);
    if (children.length) {
      const info = workspaces?.get(id);
      result.push({
        kind: "workspace",
        name: info?.name ?? null,
        emoji: info?.emoji ?? null,
        color: null,
        children,
      });
    }
  }
  return result;
}

/**
 * Whether `url` is Edge's New Tab page, an empty tab import skips as it does
 * `edge://newtab/`. A signed-in Edge with its news feed logs the page MSN
 * serves there, `https://ntp.msn.com/edge/ntp`, in place of `edge://newtab/`.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isEdgeNewTab(url) {
  return /^https:\/\/ntp\.msn\.com\/edge\/ntp(?:[?#]|$)/.test(url);
}

/**
 * Tabs, in order, as harvest nodes: each run sharing a group token, or a
 * Vivaldi tab stack, one group.
 *
 * @param {object[]} ordered Replayed tabs.
 * @param {Map} groups `{ title, color }` by group token or stack key.
 * @param {object} state `{ skipped }`, counted into.
 * @returns {object[]}
 */
function tabNodes(ordered, groups, state) {
  const children = [];
  let run = null;
  for (const t of ordered) {
    const nav = selectedNavigation(t);
    if (!importableUrl(nav.url) || isEdgeNewTab(nav.url)) {
      state.skipped++;
      continue;
    }
    const node = { type: "tab", title: nav.title, url: nav.url };
    const group = t.stack ?? t.group;
    if (!group) {
      run = null;
      children.push(node);
      continue;
    }
    if (run?.token !== group) {
      const meta = groups.get(group);
      run = {
        token: group,
        node: {
          type: "group",
          name: meta?.title ?? null,
          color: meta?.color ?? null,
          children: [],
        },
      };
      children.push(run.node);
    }
    run.node.children.push(node);
  }
  return children;
}

// Vivaldi's workspaces

/**
 * Vivaldi's workspaces, from `vivaldi.workspaces.list` in the profile's
 * `Preferences`, in the order Vivaldi lists them. A workspace's icon is an
 * SVG of Vivaldi's own set, or an emoji the user picked, which Vivaldi's UI
 * stores as the workspace's `emoji` (its `SET_WORKSPACE_EMOJI` action, as of
 * Vivaldi 8.2). Only the emoji is carried.
 *
 * @param {string} dir The profile directory.
 * @returns {Promise<Map<number, {name: string|null, emoji: string|null}>>}
 *   Empty when the profile has none or they cannot be read.
 */
async function readVivaldiWorkspaces(dir) {
  const workspaces = new Map();
  let list;
  try {
    list = (await IOUtils.readJSON(PathUtils.join(dir, "Preferences")))?.vivaldi
      ?.workspaces?.list;
  } catch {
    return workspaces;
  }
  for (const entry of Array.isArray(list) ? list : []) {
    if (!Number.isFinite(entry?.id)) {
      continue;
    }
    const name =
      typeof entry.name === "string" && entry.name ? entry.name : null;
    const emoji =
      typeof entry.emoji === "string" && entry.emoji ? entry.emoji : null;
    workspaces.set(entry.id, { name, emoji });
  }
  return workspaces;
}

/**
 * The Workspace id an Edge Workspace command names: after the window's id, a
 * length-prefixed string.
 *
 * @param {DataView} p The command's payload.
 * @param {number} n Its length.
 * @returns {string} The id, or "" when the payload holds none.
 */
function readEdgeWorkspaceId(p, n) {
  if (n < 12) {
    return "";
  }
  const length = p.getInt32(8, true);
  if (length <= 0 || 12 + length > n) {
    return "";
  }
  return new TextDecoder().decode(
    new Uint8Array(p.buffer, p.byteOffset + 12, length)
  );
}

/** The sync database's key prefix for an Edge Workspace's record. */
const EDGE_WORKSPACE_KEY = "edge_workspace-dt-";

/**
 * Each Edge Workspace's name and colour, by its id, from Edge's sync
 * database, the one file on the computer that ties them to the id the
 * session names (§4.1). Each
 * record is a protobuf whose field 2 is the Workspace: its field 1 the id,
 * and its field 4 the name (field 1) and colour (field 2, ARGB). This is
 * observed, undocumented behaviour; a record that does not match is passed
 * over.
 *
 * @param {string} dir The profile directory.
 * @returns {Promise<Map<string, {name: string|null, color: string|null}>>}
 */
async function readEdgeWorkspaces(dir) {
  const workspaces = new Map();
  const records = await readLevelDB(
    PathUtils.join(dir, "Sync Data", "LevelDB"),
    EDGE_WORKSPACE_KEY
  );
  for (const value of records.values()) {
    try {
      const entity = protoFields(protoFields(value).get(2));
      const id = new TextDecoder().decode(entity.get(1));
      const details = protoFields(entity.get(4));
      const name = details.has(1)
        ? new TextDecoder().decode(details.get(1))
        : "";
      const argb = details.get(2);
      workspaces.set(id, {
        name: name || null,
        color:
          typeof argb === "number"
            ? nearestColor({
                red: ((argb >>> 16) & 0xff) / 255,
                green: ((argb >>> 8) & 0xff) / 255,
                blue: (argb & 0xff) / 255,
              })
            : null,
      });
    } catch {
      // Not a Workspace record of the shape described above.
    }
  }
  return workspaces;
}

/**
 * A protobuf message's fields by number, the last of each kept: a varint as
 * a Number, a length-delimited field as its bytes. Fixed-width fields are
 * skipped.
 *
 * @param {Uint8Array} bytes
 * @returns {Map<number, number|Uint8Array>}
 * @throws {Error} when the message is malformed or `bytes` is not bytes.
 */
function protoFields(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error("protobuf: not a message");
  }
  const fields = new Map();
  let at = 0;
  const varint = () => {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      if (at >= bytes.length) {
        throw new Error("protobuf: past the end");
      }
      const b = bytes[at++];
      value += (b & 0x7f) * scale;
      if (!(b & 0x80)) {
        return value;
      }
      scale *= 128;
    }
    throw new Error("protobuf: varint too long");
  };
  while (at < bytes.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    switch (key & 7) {
      case 0:
        fields.set(field, varint());
        break;
      case 1:
        at += 8;
        break;
      case 2: {
        const length = varint();
        if (at + length > bytes.length) {
          throw new Error("protobuf: past the end");
        }
        fields.set(field, bytes.subarray(at, at + length));
        at += length;
        break;
      }
      case 5:
        at += 4;
        break;
      default:
        throw new Error("protobuf: unknown wire type");
    }
  }
  return fields;
}

// Bookmarks

/**
 * `Bookmarks`, Chromium's JSON: the bookmark bar to the toolbar, and the
 * other and synced (mobile) roots to other (§3).
 *
 * @param {string} dir The profile directory.
 * @param {object} state `{ skipped }`, counted into.
 * @returns {Promise<object|null>} `Roots`, or null when the profile has none.
 * @throws {Error} when the file exists and cannot be read.
 */
export async function readBookmarks(dir, state) {
  const path = PathUtils.join(dir, "Bookmarks");
  if (!(await IOUtils.exists(path))) {
    return null;
  }
  let json;
  try {
    json = await IOUtils.readJSON(path);
  } catch (e) {
    throw new Error(`Chromium bookmarks are not readable (${e.name})`, {
      cause: e,
    });
  }
  const roots = json?.roots ?? {};
  const convert = nodes => {
    const out = [];
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (node?.type === "folder") {
        out.push({
          type: "folder",
          title: node.name ?? "",
          children: convert(node.children),
        });
      } else if (node?.type === "url") {
        if (importableUrl(node.url)) {
          out.push({ type: "bookmark", title: node.name ?? "", url: node.url });
        } else {
          state.skipped++;
        }
      }
    }
    return out;
  };
  return {
    toolbar: convert(roots.bookmark_bar?.children),
    menu: [],
    other: [
      ...convert(roots.other?.children),
      ...convert(roots.synced?.children),
    ],
  };
}

// Logins

/**
 * How many saved logins the profile holds, so the logins hand-off is offered
 * only when there are some (§5.1). Only the count is ever selected. It is read
 * from a copy, since a count read in place misses what a running browser has
 * not checkpointed and could hide the hand-off (SvalImportFiles); the store is
 * small.
 *
 * @param {string} dir The profile directory.
 * @returns {Promise<number|null>} null when absent or unreadable.
 */
export async function countLogins(dir) {
  try {
    const rows = await withCopy(PathUtils.join(dir, "Login Data"), db =>
      db.execute("SELECT count(*) FROM logins")
    );
    return rows ? rows[0].getResultByIndex(0) : null;
  } catch {
    return null;
  }
}

// History

/**
 * Imports the profile's history through Firefox's own migrator, which runs
 * only its history resource (§2, §4.1).
 *
 * A migrator of Sval's own per run, pointed at the profile's user data
 * directory. `MigrationUtils.getMigrator` hands out one shared instance that
 * caches its resources per profile, and those resources include a passwords
 * one built against the original `Login Data`; a fresh instance whose
 * password resource is never built is the only way to be sure no password
 * store is opened (spec §7.3).
 *
 * @param {object} profile One of {@link findProfiles}'s results.
 * @returns {Promise<number>} URLs handed to Places, or 0 when the profile has
 *   no history.
 */
export async function importHistory(profile) {
  const migrator = new (chromiumMigratorClass())(PathUtils.parent(profile.dir));
  const source = { id: profile.id, name: profile.name ?? profile.id };
  const { HISTORY } = lazy.MigrationUtils.resourceTypes;
  const resources = await migrator.getResources(source);
  if (!resources.some(resource => resource.type == HISTORY)) {
    return 0;
  }
  let succeeded = false;
  await migrator.migrate(HISTORY, false, source, (type, success) => {
    succeeded = type === HISTORY && success;
  });
  if (!succeeded) {
    throw new Error(`${profile.source} history import failed`);
  }
  return lazy.MigrationUtils.getImportedCount("history");
}

let ChromiumMigrator = null;

/**
 * `ChromeProfileMigrator` reading one user data directory, with no password
 * resource. Defined on first use, so reading a session does not load
 * Firefox's migration modules.
 *
 * @returns {Function} the class.
 */
function chromiumMigratorClass() {
  ChromiumMigrator ??= class extends lazy.ChromeProfileMigrator {
    #userData;

    constructor(userData) {
      super();
      this.#userData = userData;
    }

    async _getChromeUserDataPathIfExists() {
      return (await IOUtils.exists(this.#userData)) ? this.#userData : null;
    }

    // The base class asks for `Local State`, but {@link findProfiles} offers
    // a profile from a directory without one, and Arc may have none; its
    // history is read from the profile directory alone.
    async hasPermissions() {
      return true;
    }

    async _GetPasswordsResource() {
      return null;
    }
  };
  return ChromiumMigrator;
}
