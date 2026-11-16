/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Runs one export (export spec §4–§5): reads Sval's data once into the
 * export's harvest (SvalExportModel), and writes the chosen target's file in
 * one write to the path the user chose. It contacts no host and writes no
 * other file.
 *
 * The workspaces are read from the engine's tree as the export runs, the
 * Favorites from the favorites document and history from Places, which is
 * canonical for each. Nothing is kept between exports.
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import {
  bookmarksHtml,
  completeReadme,
  exportableWorkspaces,
  exportFileName,
  firefoxJson,
  noticeOf,
  safariHistoryJson,
  targetOf,
  TARGETS,
  windowsOf,
  zip,
} from "moz-src:///browser/components/sval/SvalExportModel.sys.mjs";
import { importableUrl } from "moz-src:///browser/components/sval/SvalImportModel.sys.mjs";
import { SYNC_DOCUMENT } from "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  HISTORY_INDEX: "moz-src:///browser/components/sval/SvalHistorySync.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  ROOT_GUIDS: "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
  PINS_ROOT: "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
  SvalFavoritesStore:
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
});

const DIALOG_URL = "chrome://browser/content/sval/export.xhtml";

/**
 * Opens the export page in `win`'s modal dialog. The page asks for the
 * target and what goes in it, then calls `save`, which asks where and
 * writes the file; the page shows the target's notice once it is saved.
 *
 * @param {Window} win A browser window.
 * @param {object} options
 * @param {object} options.engine The profile's engine.
 * @param {string} [options.target] The target to start on.
 * @returns {Promise<void>} Once the page has closed.
 */
export async function askExport(win, { engine, target = "chrome" }) {
  const { nodes } = await engine.tree();
  const args = {
    targets: TARGETS,
    target,
    workspaces: exportableWorkspaces(nodes),
    save: async choices => {
      const path = await pickPath(win, choices.target);
      if (!path) {
        return null;
      }
      await writeExport(choices, path, { engine });
      return noticeOf(choices.target);
    },
    // Read by `gDialogBox.open` while the window is in a modal state; see
    // `SvalAgentAlerts.askToPair`.
    getProperty: name => name === "async",
  };
  await win.gDialogBox?.open(DIALOG_URL, args);
}

/**
 * Asks where to save the target's file.
 *
 * @param {Window} win
 * @param {string} key A target's key.
 * @returns {Promise<string|null>} The path, or null when cancelled.
 */
async function pickPath(win, key) {
  const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
    Ci.nsIFilePicker
  );
  picker.init(win.browsingContext, "Export", Ci.nsIFilePicker.modeSave);
  const name = exportFileName(key, new Date());
  if (name.endsWith(".html")) {
    picker.appendFilters(Ci.nsIFilePicker.filterHTML);
  } else if (name.endsWith(".json")) {
    picker.appendFilter("JSON", "*.json");
  } else {
    picker.appendFilter("ZIP", "*.zip");
  }
  picker.defaultString = name;
  const result = await new Promise(resolve => picker.open(resolve));
  return result === Ci.nsIFilePicker.returnOK ||
    result === Ci.nsIFilePicker.returnReplace
    ? picker.file.path
    : null;
}

/**
 * One of the document's roots as a harvest's marks. Separators mean nothing
 * in another browser's bookmarks, so they are left out.
 *
 * @param {object} store The Favorites.
 * @param {string} guid A root.
 * @returns {object[]}
 */
function marksOf(store, guid) {
  const convert = (row, depth) => {
    if (row.kind === "folder") {
      return [
        {
          type: "folder",
          title: row.name,
          children:
            depth < 64
              ? store.children(row.guid).flatMap(c => convert(c, depth + 1))
              : [],
        },
      ];
    }
    if (row.kind === "favorite" && row.url) {
      return [{ type: "bookmark", title: row.name || row.url, url: row.url }];
    }
    return [];
  };
  return store.children(guid).flatMap(row => convert(row, 0));
}

/**
 * Favorites, from the favorites document (export spec §5): its three roots
 * as a harvest's toolbar, menu and other bookmarks, and the pins as a folder
 * named "Pins" at the end of the toolbar, so a pin exports as a bookmark
 * (pins-root spec §7).
 *
 * @param {object} [store] The Favorites: the profile's by default.
 * @returns {Promise<object>} A harvest's bookmark roots.
 */
export async function readFavorites(store = lazy.SvalFavoritesStore.instance) {
  if (!store) {
    return { toolbar: [], menu: [], other: [] };
  }
  await store.whenReady();
  const [toolbar, menu, other] = lazy.ROOT_GUIDS;
  const pins = marksOf(store, lazy.PINS_ROOT);
  return {
    toolbar: [
      ...marksOf(store, toolbar),
      ...(pins.length
        ? [{ type: "folder", title: "Pins", children: pins }]
        : []),
    ],
    menu: marksOf(store, menu),
    other: marksOf(store, other),
  };
}

/**
 * Every page Places holds a visit to, newest first, for Safari's
 * `History.json`. The window is Places' own: what history Sval keeps is what
 * goes.
 *
 * @returns {Promise<object[]>} A harvest's history.
 */
export async function readHistory() {
  const db = await lazy.PlacesUtils.promiseDBConnection();
  const rows = await db.execute(
    `SELECT url, title, last_visit_date, visit_count FROM moz_places
      WHERE last_visit_date NOT NULL AND visit_count > 0 AND hidden = 0
      ORDER BY last_visit_date DESC`
  );
  const pages = [];
  for (const row of rows) {
    const url = row.getResultByName("url");
    if (importableUrl(url)) {
      pages.push({
        url,
        title: row.getResultByName("title") ?? "",
        lastVisit: row.getResultByName("last_visit_date"),
        visits: row.getResultByName("visit_count"),
      });
    }
  }
  return pages;
}

/**
 * Every document the engine holds, each as `export_json` writes it: the
 * tree, every extra document, and every week of history the index lists,
 * past weeks included, which no pass is holding.
 *
 * @param {object} engine
 * @returns {Promise<Array<{name: string, text: string}>>}
 */
export async function completeDocuments(engine) {
  const names = engine.extraDocumentNames();
  if (engine.hasDocument(lazy.HISTORY_INDEX)) {
    for (const { name } of await engine.shards(lazy.HISTORY_INDEX)) {
      if (!names.includes(name)) {
        names.push(name);
      }
    }
  }
  const documents = [
    { name: `${SYNC_DOCUMENT}.json`, text: await engine.exportJson() },
  ];
  for (const name of names) {
    documents.push({
      name: `${name}.json`,
      text: await engine.exportJson(name),
    });
  }
  return documents;
}

/**
 * The bytes of the chosen target's file.
 *
 * @param {object} choices `{ target, workspaces, favorites, history }`:
 *   the target's key, the workspace ids chosen, and whether Favorites and
 *   history go.
 * @param {object} context
 * @param {object} context.engine The profile's engine.
 * @param {Date} [context.date] When the export runs.
 * @returns {Promise<Uint8Array|string>}
 */
export async function exportBytes(choices, { engine, date = new Date() }) {
  const target = targetOf(choices.target);
  if (target.format === "complete") {
    const documents = await completeDocuments(engine);
    return zip(
      [
        {
          name: "README.txt",
          text: completeReadme(documents.map(doc => doc.name)),
        },
        ...documents,
      ],
      date
    );
  }
  const { nodes } = await engine.tree();
  const harvest = {
    windows: windowsOf(nodes, choices.workspaces),
    bookmarks: choices.favorites ? await readFavorites() : null,
    history: null,
  };
  if (target.format === "firefox") {
    return firefoxJson(harvest);
  }
  const html = bookmarksHtml(harvest, { flat: target.flat });
  if (target.format === "html") {
    return html;
  }
  const entries = [{ name: "Bookmarks.html", text: html }];
  if (choices.history) {
    entries.push({
      name: "History.json",
      text: safariHistoryJson(await readHistory(), {
        version: AppConstants.MOZ_APP_VERSION_DISPLAY,
        now: date.getTime(),
      }),
    });
  }
  return zip(entries, date);
}

/**
 * Writes the chosen target's file to `path`, in one write.
 *
 * @param {object} choices As {@link exportBytes} takes them.
 * @param {string} path
 * @param {object} context As {@link exportBytes} takes it.
 * @returns {Promise<void>}
 */
export async function writeExport(choices, path, context) {
  const bytes = await exportBytes(choices, context);
  const written =
    typeof bytes === "string"
      ? await IOUtils.writeUTF8(path, bytes)
      : await IOUtils.write(path, bytes);
  SvalLog.info(`export: wrote ${written} bytes`);
}
