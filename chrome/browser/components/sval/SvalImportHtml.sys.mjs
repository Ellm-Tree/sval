/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * A bookmarks HTML file as an import source (favorites-native spec §15.3):
 * the Netscape format every browser exports, Sval's own export included.
 * Arc's Markdown export comes in through the same file picker, and
 * `SvalImportArcExport` reads it.
 *
 * The file goes through the same model and choices as a browser's
 * bookmarks (Favorites, a workspace, or nothing), so Firefox's
 * `BookmarkHTMLUtils.importFromFile`, which writes straight into Places, is
 * not used. Tags and keywords are not part of Sval (decision 0099), so the
 * `TAGS` and `SHORTCUTURL` attributes are ignored.
 */

import { harvest as arcExportHarvest } from "moz-src:///browser/components/sval/SvalImportArcExport.sys.mjs";
import { importableFromFile } from "moz-src:///browser/components/sval/SvalImportModel.sys.mjs";

/**
 * A file is chosen by the user, never found, so there are no profiles to
 * list.
 *
 * @returns {Promise<object[]>}
 */
export async function findProfiles() {
  return [];
}

/**
 * The folder a `DT` heads: the `DL` inside it, or, as some exporters write
 * it, the `DL` right after it.
 *
 * @param {Element} dt
 * @returns {Element|null}
 */
function listOf(dt) {
  const inside = dt.querySelector(":scope > dl");
  if (inside) {
    return inside;
  }
  const next = dt.nextElementSibling;
  return next?.localName === "dl" ? next : null;
}

/**
 * Which root a top-level folder stands for, as Firefox and Chromium mark it.
 *
 * @param {Element} heading The folder's `H3`.
 * @returns {"toolbar"|"other"|null}
 */
function markerOf(heading) {
  if (heading.hasAttribute("personal_toolbar_folder")) {
    return "toolbar";
  }
  if (heading.hasAttribute("unfiled_bookmarks_folder")) {
    return "other";
  }
  return null;
}

/**
 * The root a file's loose top-level items belong to. Firefox heads its file
 * with the menu folder's own name and writes the menu's items loose at the
 * top. Chromium heads its file "Bookmarks" and writes its Other bookmarks
 * loose there instead, with no folder or marker (`bookmark_html_writer.cc`).
 *
 * @param {Document} doc
 * @returns {"menu"|"other"}
 */
function looseRootOf(doc) {
  const heading = doc.querySelector("h1")?.textContent.trim();
  return heading === "Bookmarks" ? "other" : "menu";
}

/**
 * The bookmarks in one file, as a harvest's bookmark roots.
 *
 * The toolbar and unfiled folders are marked by attribute, as Firefox and
 * Chromium write them. Every other top-level item goes to the root
 * {@link looseRootOf} names.
 *
 * @param {Document} doc The file, parsed as HTML.
 * @returns {{roots: object, skipped: number}}
 */
function parseBookmarksDocument(doc) {
  let skipped = 0;
  const walk = dl => {
    const out = [];
    for (const dt of dl.querySelectorAll(":scope > dt, :scope > p > dt")) {
      const heading = dt.querySelector(":scope > h3");
      if (heading) {
        out.push({
          type: "folder",
          title: heading.textContent.trim(),
          children: (() => {
            const list = listOf(dt);
            return list ? walk(list) : [];
          })(),
          marker: markerOf(heading),
        });
        continue;
      }
      const link = dt.querySelector(":scope > a");
      if (!link) {
        continue;
      }
      const url = link.getAttribute("href");
      if (importableFromFile(url)) {
        out.push({ type: "bookmark", title: link.textContent.trim(), url });
      } else {
        skipped++;
      }
    }
    return out;
  };
  const roots = { toolbar: [], menu: [], other: [] };
  const loose = looseRootOf(doc);
  const top = doc.querySelector("dl");
  for (const item of top ? walk(top) : []) {
    if (item.marker) {
      roots[item.marker].push(...item.children);
    } else {
      roots[loose].push(item);
    }
  }
  const clean = items =>
    items.map(item =>
      item.type === "folder"
        ? { type: "folder", title: item.title, children: clean(item.children) }
        : item
    );
  return {
    roots: {
      toolbar: clean(roots.toolbar),
      menu: clean(roots.menu),
      other: clean(roots.other),
    },
    skipped,
  };
}

/**
 * The bookmarks in a file's text, as {@link parseBookmarksDocument} reads
 * them.
 *
 * @param {string} text The file's contents.
 * @returns {{roots: object, skipped: number}}
 */
export function parseBookmarksHtml(text) {
  return parseBookmarksDocument(
    new DOMParser().parseFromString(text, "text/html")
  );
}

/**
 * A file parsed as `BookmarkHTMLUtils.importFromFile` parses it: an
 * `XMLHttpRequest` for an HTML document, so the file's own `META` charset
 * decides how its bytes are read, and a file a legacy browser wrote in a
 * legacy encoding reads as it was written.
 *
 * @param {string} path
 * @returns {Promise<Document>}
 */
function loadDocument(path) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.onload = () => resolve(xhr.responseXML);
    xhr.onabort =
      xhr.onerror =
      xhr.ontimeout =
        () => reject(new Error("the bookmarks file could not be read"));
    xhr.open("GET", PathUtils.toFileURI(path));
    xhr.responseType = "document";
    xhr.overrideMimeType("text/html");
    xhr.send();
  });
}

/**
 * @param {object} profile `{ source: "html", dir }`, `dir` being the file.
 * @returns {Promise<object>} A `Harvest` (SvalImportModel) with bookmarks
 *   alone, marked `file`, or for Arc's Markdown export its Spaces alone.
 */
export async function harvest(profile) {
  if (/\.md$/i.test(profile.dir)) {
    return arcExportHarvest(profile);
  }
  const { roots, skipped } = parseBookmarksDocument(
    await loadDocument(profile.dir)
  );
  return {
    windows: [],
    bookmarks: roots,
    logins: 0,
    encryptedSession: false,
    skipped,
    file: true,
  };
}

/** A file carries no history. @returns {Promise<number>} */
export async function importHistory() {
  return 0;
}
