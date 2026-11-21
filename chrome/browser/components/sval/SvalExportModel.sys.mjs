/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * What an export writes for each browser (export spec §2–§3).
 *
 * Pure: no I/O, no clock, no randomness. Export reads Sval's data once into
 * the shape import's readers return, a `Harvest` (SvalImportModel), and each
 * writer here turns that shape into the bytes of one file, so each target's
 * layout is tested on its own.
 *
 * The export's harvest:
 *
 *     {
 *       windows: [Window],     // one per workspace chosen, in switcher order
 *       bookmarks: Roots|null, // Favorites, when chosen
 *       history: [Page]|null,  // Safari only, when chosen
 *     }
 *
 *     Window, Node, Roots and Mark are SvalImportModel's. Roots' `toolbar` is
 *     Favorites, `menu` Favorites Menu, and `other` Other Favorites (Places'
 *     unfiled root).
 *     Page = { url, title, lastVisit, visits }, `lastVisit` in microseconds
 *     since the epoch, as Places keeps it.
 */

import { agentLabelOf } from "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs";
import {
  childrenByParent,
  displayName,
  TAB,
  workspaceIds,
} from "moz-src:///browser/components/sval/SvalTree.sys.mjs";
import { importableUrl } from "moz-src:///browser/components/sval/SvalImportModel.sys.mjs";
import { workspaceIcon } from "moz-src:///browser/components/sval/SvalWorkspaceEntries.sys.mjs";

/** The folder every workspace folder sits in (export spec §3). */
export const WORKSPACES_FOLDER = "Sval Workspaces";

/** What a nameless workspace or group is called, as the panel draws it. */
const UNTITLED = Object.freeze({
  workspace: "Untitled Workspace",
  group: "Untitled group",
});

/**
 * Each target's file:
 *
 * - `html`: a Netscape bookmarks file.
 * - `firefox`: a Firefox bookmarks backup, which Firefox's file import
 *   (`BookmarksFileMigrator`) hands to `BookmarkJSONUtils.importFromFile`.
 * - `safari`: the ZIP Safari itself exports, with `Bookmarks.html` and,
 *   when chosen, `History.json` (Apple's "Importing data exported from
 *   Safari").
 * - `complete`: every engine document as plain JSON, in a ZIP.
 *
 * `flat` writes each workspace as one folder of its tabs in panel order.
 * Chromium's "Open all in new tab group" opens only a folder's own
 * bookmarks, not its subfolders' (`GetURLsToOpen` in
 * `bookmark_utils_desktop.cc`), and Apple documents no more for Safari's
 * "Open in New Tab Group", so a workspace is one folder for both, and
 * reopens whole.
 */
export const TARGETS = Object.freeze([
  { key: "chrome", name: "Chrome", format: "html", flat: true },
  { key: "edge", name: "Edge", format: "html", flat: true },
  { key: "brave", name: "Brave", format: "html", flat: true },
  { key: "vivaldi", name: "Vivaldi", format: "html", flat: true },
  { key: "opera", name: "Opera", format: "html", flat: true },
  { key: "arc", name: "Arc", format: "html", flat: true },
  { key: "dia", name: "Dia", format: "html", flat: true },
  { key: "firefox", name: "Firefox", format: "firefox", flat: false },
  { key: "zen", name: "Zen", format: "firefox", flat: false },
  { key: "safari", name: "Safari", format: "safari", flat: true },
  { key: "other", name: "Another browser", format: "html", flat: false },
  {
    key: "sval",
    name: "Sval (complete data)",
    format: "complete",
    flat: false,
  },
]);

/**
 * @param {string} key
 * @returns {object} The target `key` names.
 */
export function targetOf(key) {
  const target = TARGETS.find(t => t.key === key);
  if (!target) {
    throw new Error(`no export target "${key}"`);
  }
  return target;
}

/**
 * Where to import the file in each browser, and how to turn a folder back
 * into a tab group or workspace there (export spec §3). Each path is the
 * browser's own help page's, as of 2026-10.
 */
const NOTICES = Object.freeze({
  chrome: [
    "In Chrome, choose Bookmarks and lists › Import bookmarks and settings, " +
      "then Bookmarks HTML file, and pick this file.",
    "To open a Workspace as a tab group, right-click its folder and choose " +
      "Open all in new tab group.",
  ],
  edge: [
    "In Edge, open Settings › Profiles › Import browser data, choose " +
      "Favorites or bookmarks HTML file, and pick this file.",
    "To open a Workspace as a tab group, right-click its folder and choose " +
      "Open all in new tab group. To make it an Edge workspace, open the " +
      "folder in a new window and choose Create workspace.",
  ],
  brave: [
    "In Brave, choose Bookmarks › Import bookmarks and settings, then " +
      "Bookmarks HTML file, and pick this file.",
    "To open a Workspace as a tab group, right-click its folder and choose " +
      "Open all in new tab group.",
  ],
  vivaldi: [
    "In Vivaldi, choose File › Import from applications or files, then " +
      "Bookmarks HTML file, and pick this file.",
    "Each Workspace is a folder of its tabs. Open a folder to get them back.",
  ],
  opera: [
    "In Opera, open Settings › Import bookmarks and settings, choose " +
      "Bookmarks HTML file, and pick this file.",
    "Each Workspace is a folder of its tabs. Open a folder to get them back.",
  ],
  arc: [
    "Arc imports only from another browser, so import this file into Chrome " +
      "first: Bookmarks and lists › Import bookmarks and settings › " +
      "Bookmarks HTML file. Then import from Chrome in Arc.",
    "Each Workspace arrives as a folder of its tabs.",
  ],
  dia: [
    "Dia imports only from another browser, so import this file into Chrome " +
      "first: Bookmarks and lists › Import bookmarks and settings › " +
      "Bookmarks HTML file. Then import from Chrome in Dia.",
    "Each Workspace arrives as a folder of its tabs.",
  ],
  firefox: [
    "In Firefox, open Settings › General › Import Data, choose Import from " +
      "a file, then Bookmarks (HTML or JSON), and pick this file.",
    "Favorites land on the bookmarks toolbar, and each Workspace is a " +
      "folder under Other Bookmarks.",
  ],
  zen: [
    "In Zen, open Settings › General › Import Data, choose Import from a " +
      "file, then Bookmarks (HTML or JSON), and pick this file.",
    "Favorites land on the bookmarks toolbar, and each Workspace is a " +
      "folder under Other Bookmarks.",
  ],
  safari: [
    "In Safari, choose File › Import Browsing Data from File or Folder, " +
      "and pick this file.",
    "To open a Workspace as a Tab Group, Control-click its folder and " +
      "choose Open in New Tab Group.",
  ],
  other: [
    "Import this file from your browser's bookmarks settings, where it " +
      "offers a bookmarks HTML file.",
    "Each Workspace is a folder, with its groups as folders inside it.",
  ],
  sval: [
    "This file holds everything Sval keeps, as plain JSON, with a README " +
      "describing it.",
    "It is not encrypted, so keep it somewhere only you can reach.",
  ],
});

/**
 * @param {string} key A target's key.
 * @returns {string[]} The notice Sval shows once that target's file is saved.
 */
export function noticeOf(key) {
  return NOTICES[targetOf(key).key];
}

/**
 * The file name Sval suggests: the target and the day.
 *
 * @param {string} key A target's key.
 * @param {Date} date
 * @returns {string}
 */
export function exportFileName(key, date) {
  const { format } = targetOf(key);
  const day = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  if (format === "complete") {
    return `Sval data ${day}.zip`;
  }
  const extension = { html: "html", firefox: "json", safari: "zip" }[format];
  return `Sval for ${targetOf(key).name} ${day}.${extension}`;
}

/**
 * The workspaces export offers: the user's own, in switcher order. An
 * agent's workspace holds the agent's work, not the person's (export spec
 * §3).
 *
 * @param {object} nodes The tree's `nodes`.
 * @returns {Array<{id: string, name: string, mark: string|null,
 *   emoji: string|null}>} `mark` and `emoji` as `workspaceIcon` gives them.
 */
export function exportableWorkspaces(nodes) {
  return workspaceIds(nodes)
    .filter(id => agentLabelOf(nodes, id) === null)
    .map(id => ({
      id,
      name: nodes[id].content?.name || UNTITLED.workspace,
      ...workspaceIcon(nodes, id),
    }));
}

/**
 * The chosen workspaces as a harvest's windows, each a tree of groups and
 * tabs in panel order. A tab on a page only Sval has (`about:`, `chrome:`)
 * means nothing elsewhere and is left out, by import's own rule
 * (`importableUrl`), and a group or workspace that leaves empty is left out
 * with it, since an empty folder opens nothing.
 *
 * @param {object} nodes The tree's `nodes`.
 * @param {string[]} ids The workspaces chosen; any id that is not one of
 *   {@link exportableWorkspaces} is ignored.
 * @returns {object[]} Windows, in switcher order.
 */
export function windowsOf(nodes, ids) {
  const chosen = new Set(ids);
  const byParent = childrenByParent(nodes);
  const walk = parent => {
    const out = [];
    for (const id of byParent.get(parent) ?? []) {
      const node = nodes[id];
      if (node.kind === TAB) {
        const url = node.content?.url;
        if (importableUrl(url)) {
          out.push({ type: "tab", title: displayName(node) || url, url });
        }
        continue;
      }
      const children = walk(id);
      if (children.length) {
        out.push({
          type: "group",
          name: node.content?.name || UNTITLED.group,
          color: null,
          children,
        });
      }
    }
    return out;
  };
  const windows = [];
  for (const { id, name } of exportableWorkspaces(nodes)) {
    if (!chosen.has(id)) {
      continue;
    }
    const children = walk(id);
    if (children.length) {
      windows.push({
        kind: "workspace",
        name,
        emoji: null,
        color: null,
        children,
      });
    }
  }
  return windows;
}

/**
 * Every tab in `nodes`, depth first: a group's tabs where the group sits.
 *
 * @param {object[]} nodes A window's children.
 * @returns {object[]} Tabs.
 */
function flatTabs(nodes) {
  return nodes.flatMap(node =>
    node.type === "tab" ? [node] : flatTabs(node.children)
  );
}

/**
 * The workspaces folder as marks: a folder per workspace, its groups
 * folders inside it unless `flat`.
 *
 * @param {object[]} windows
 * @param {boolean} flat
 * @returns {object[]} Marks.
 */
function workspaceMarks(windows, flat) {
  const toMark = node =>
    node.type === "tab"
      ? { type: "bookmark", title: node.title, url: node.url }
      : {
          type: "folder",
          title: node.name,
          children: node.children.map(toMark),
        };
  return windows.map(win => ({
    type: "folder",
    title: win.name,
    children: (flat ? flatTabs(win.children) : win.children).map(toMark),
  }));
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A Netscape bookmarks file (export spec §3).
 *
 * Favorites are the folder marked `PERSONAL_TOOLBAR_FOLDER`, which Chromium
 * puts straight on an empty bookmarks bar (`ProfileWriter::AddBookmarks`)
 * and Firefox and Sval read as the toolbar. The file is headed "Bookmarks",
 * as Chromium writes its own, so Other Favorites go loose at the top, where
 * Chromium writes Other bookmarks and Sval's import reads them back
 * (`SvalImportHtml`). Favorites Menu has no counterpart in a Chromium
 * browser, so it is a folder of that name, and the workspaces folder comes
 * last.
 *
 * @param {object} harvest
 * @param {object} options
 * @param {boolean} options.flat See {@link TARGETS}.
 * @returns {string}
 */
export function bookmarksHtml(harvest, { flat }) {
  const lines = [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    "<!-- This is an automatically generated file.",
    "     It will be read and overwritten.",
    "     DO NOT EDIT! -->",
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    "<TITLE>Bookmarks</TITLE>",
    "<H1>Bookmarks</H1>",
    "<DL><p>",
  ];
  const indent = depth => "    ".repeat(depth);
  const write = (marks, depth) => {
    for (const mark of marks) {
      if (mark.type === "bookmark") {
        lines.push(
          `${indent(depth)}<DT><A HREF="${escapeHtml(mark.url)}">` +
            `${escapeHtml(mark.title)}</A>`
        );
      } else {
        folder(mark.title, mark.children, depth);
      }
    }
  };
  const folder = (title, children, depth, attrs = "") => {
    lines.push(`${indent(depth)}<DT><H3${attrs}>${escapeHtml(title)}</H3>`);
    lines.push(`${indent(depth)}<DL><p>`);
    write(children, depth + 1);
    lines.push(`${indent(depth)}</DL><p>`);
  };
  const roots = harvest.bookmarks;
  if (roots?.toolbar.length) {
    folder("Favorites", roots.toolbar, 1, ' PERSONAL_TOOLBAR_FOLDER="true"');
  }
  if (roots?.other.length) {
    write(roots.other, 1);
  }
  if (roots?.menu.length) {
    folder("Favorites Menu", roots.menu, 1);
  }
  if (harvest.windows.length) {
    folder(WORKSPACES_FOLDER, workspaceMarks(harvest.windows, flat), 1);
  }
  lines.push("</DL><p>", "");
  return lines.join("\n");
}

/** Places' container and bookmark types, as a bookmarks backup spells them. */
const CONTAINER = "text/x-moz-place-container";
const PLACE = "text/x-moz-place";

/**
 * A Firefox bookmarks backup (export spec §3). Firefox's JSON import keeps
 * each root (`BookmarkImporter.import`), so Favorites go on the toolbar,
 * Favorites Menu on the menu, and Other Favorites and the workspaces folder
 * under Other Bookmarks. HTML would not do: Firefox's HTML import puts
 * everything under the Bookmarks Menu.
 *
 * @param {object} harvest
 * @returns {string}
 */
export function firefoxJson(harvest) {
  const toNode = mark =>
    mark.type === "bookmark"
      ? { type: PLACE, title: mark.title, uri: mark.url }
      : {
          type: CONTAINER,
          title: mark.title,
          children: mark.children.map(toNode),
        };
  const roots = harvest.bookmarks ?? { toolbar: [], menu: [], other: [] };
  const unfiled = [...roots.other];
  if (harvest.windows.length) {
    unfiled.push({
      type: "folder",
      title: WORKSPACES_FOLDER,
      children: workspaceMarks(harvest.windows, false),
    });
  }
  const root = (guid, name, marks) => ({
    guid,
    root: name,
    type: CONTAINER,
    title: "",
    children: marks.map(toNode),
  });
  return JSON.stringify({
    guid: "root________",
    root: "placesRoot",
    type: CONTAINER,
    title: "",
    children: [
      root("menu________", "bookmarksMenuFolder", roots.menu),
      root("toolbar_____", "toolbarFolder", roots.toolbar),
      root("unfiled_____", "unfiledBookmarksFolder", unfiled),
    ],
  });
}

/**
 * Safari's `History.json`, in the schema Apple documents for its own export
 * (Apple's "Importing data exported from Safari"): a `metadata` block, then
 * one entry per page with its last visit and how many visits it had.
 *
 * @param {object[]} pages Places' pages, as the harvest's `history`.
 * @param {object} context
 * @param {string} context.version Sval's version.
 * @param {number} context.now Milliseconds since the epoch.
 * @returns {string}
 */
export function safariHistoryJson(pages, { version, now }) {
  return JSON.stringify({
    metadata: {
      browser_name: "Sval",
      browser_version: version,
      data_type: "history",
      export_time_usec: now * 1000,
      schema_version: 1,
    },
    history: pages.map(page => ({
      url: page.url,
      ...(page.title && { title: page.title }),
      time_usec: page.lastVisit,
      visits_count: Math.max(1, page.visits),
    })),
  });
}

/** CRC-32 (IEEE 802.3), as each ZIP header carries its entry's. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A ZIP archive of `entries`, stored without compression, as bytes.
 *
 * The archive is built in memory so the export is one write of the file the
 * user chose: `nsIZipWriter` writes to a file as it goes. Names are UTF-8
 * (general-purpose flag bit 11).
 *
 * @param {Array<{name: string, text: string}>} entries
 * @param {Date} date Every entry's modification time.
 * @returns {Uint8Array}
 */
export function zip(entries, date) {
  const encoder = new TextEncoder();
  const time =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);
  const day =
    ((date.getFullYear() - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  const header = (size, fill) => {
    const bytes = new Uint8Array(size);
    fill(new DataView(bytes.buffer));
    return bytes;
  };
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = encoder.encode(entry.text);
    const crc = crc32(data);
    const common = (view, at) => {
      view.setUint16(at, 20, true); // version needed: 2.0
      view.setUint16(at + 2, 0x0800, true); // UTF-8 names
      view.setUint16(at + 4, 0, true); // stored
      view.setUint16(at + 6, time, true);
      view.setUint16(at + 8, day, true);
      view.setUint32(at + 10, crc, true);
      view.setUint32(at + 14, data.length, true);
      view.setUint32(at + 18, data.length, true);
      view.setUint16(at + 22, name.length, true);
      view.setUint16(at + 24, 0, true); // no extra field
    };
    const local = header(30, view => {
      view.setUint32(0, 0x04034b50, true);
      common(view, 4);
    });
    central.push(
      header(46, view => {
        view.setUint32(0, 0x02014b50, true);
        view.setUint16(4, 20, true); // made by: 2.0
        common(view, 6);
        // Comment length, disk number, attributes: all zero.
        view.setUint32(42, offset, true);
      }),
      name
    );
    parts.push(local, name, data);
    offset += local.length + name.length + data.length;
  }
  const centralSize = central.reduce((n, part) => n + part.length, 0);
  const end = header(22, view => {
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, entries.length, true);
    view.setUint16(10, entries.length, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, offset, true);
  });
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * The README the complete-data ZIP carries.
 *
 * @param {string[]} names The documents in the archive.
 * @returns {string}
 */
export function completeReadme(names) {
  return [
    "Sval: everything this device holds",
    "",
    "Each .json file here is one of Sval's documents, decrypted: the same",
    "document Sval syncs, written out as plain JSON. No key is included.",
    "",
    "workspaces.json   Your Workspaces, groups and tabs. Each entry in",
    '                  "nodes" has a kind (workspace, group or tab), its',
    "                  content (name, url), its placement (parent, order)",
    "                  and its appearance (color, emoji).",
    "favorites.json    Your Favorites, their folders and order.",
    "settings.json     Your settings that sync.",
    "history-*.json    Your history, one file per week, with an index.",
    "",
    "Siblings sort by placement.order, compared as plain strings.",
    "",
    "Files in this archive:",
    ...names.map(name => `  ${name}`),
    "",
  ].join("\n");
}
