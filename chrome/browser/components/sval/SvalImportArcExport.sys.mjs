/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The Markdown file Arc's data export writes, `Arc Data Export.md`, as an
 * import source: what is left of Arc for someone who no longer has it
 * installed (import spec §4.2).
 *
 * The file holds a `#` heading for each Space, a deeper heading for each
 * folder, one level per depth (`##` a folder in a Space, `###` a folder in
 * that folder), and a `- <address>` line for each tab. It names no tab, so a
 * tab arrives with no title, and holds no Split, colour, emoji, profile or
 * archived tab. An empty folder, such as a Live Folder with nothing fetched,
 * is a heading with nothing under it, and arrives as nothing.
 */

import { importableFromFile } from "moz-src:///browser/components/sval/SvalImportModel.sys.mjs";

const HEADING = /^(#+)\s+(.*?)\s*$/;
const TAB = /^-\s+(\S+)\s*$/;

/**
 * The Spaces in an export's text, as a harvest's windows.
 *
 * @param {string} text The file's contents.
 * @returns {{windows: object[], skipped: number}}
 */
export function parseArcExport(text) {
  const windows = [];
  let skipped = 0;
  // The open Space's children, then each open folder's, outermost first.
  let open = [];
  for (const line of text.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading) {
      const depth = heading[1].length;
      const name = heading[2] || null;
      if (depth === 1) {
        const win = {
          kind: "space",
          name,
          emoji: null,
          color: null,
          children: [],
        };
        windows.push(win);
        open = [win.children];
        continue;
      }
      if (!open.length) {
        continue;
      }
      // A heading deeper than one past the open folder sits in that folder.
      open.length = Math.min(open.length, depth - 1);
      const group = { type: "group", name, color: null, children: [] };
      open.at(-1).push(group);
      open.push(group.children);
      continue;
    }
    const tab = TAB.exec(line);
    if (tab && open.length) {
      if (importableFromFile(tab[1])) {
        open.at(-1).push({ type: "tab", title: null, url: tab[1] });
      } else {
        skipped++;
      }
    }
  }
  const prune = nodes =>
    nodes.filter(node => {
      if (node.type !== "group") {
        return true;
      }
      node.children = prune(node.children);
      return node.children.length;
    });
  for (const win of windows) {
    win.children = prune(win.children);
  }
  // A Space holding nothing importable would arrive as a blank workspace
  // (import spec §11).
  return { windows: windows.filter(win => win.children.length), skipped };
}

/**
 * @param {object} profile `{ dir }`, `dir` being the file.
 * @returns {Promise<object>} A `Harvest` (SvalImportModel) with windows
 *   alone, marked `file`.
 */
export async function harvest(profile) {
  const { windows, skipped } = parseArcExport(
    await IOUtils.readUTF8(profile.dir)
  );
  return {
    windows,
    bookmarks: null,
    logins: 0,
    encryptedSession: false,
    skipped,
    file: true,
  };
}
