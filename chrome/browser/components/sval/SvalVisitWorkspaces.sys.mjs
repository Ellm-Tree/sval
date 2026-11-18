/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The workspace each visit was made in (decision 1287).
 *
 * Places keeps it in `sval_visit_workspaces`, a table of Sval's in
 * `places.sqlite`: one row per visit made in a workspace, removed with its
 * visit (`ON DELETE CASCADE`). A visit with no row was made in none: a
 * private window records no visit, and a Peek's page, an import, a
 * visit from before Sval recorded them, and a visit another device made in
 * none have no workspace. A query's `svalWorkspace` lists a page when one of
 * its visits is in that workspace or in none (`nsNavHistory.cpp`).
 *
 * Places writes the row for a visit a page makes as it writes the visit,
 * asking here which workspace the browser is in, through
 * `nsISvalVisitWorkspaces` ({@link SvalVisitWorkspacesService}). Visits inserted for other devices, and an
 * import's, are written here once Places holds them.
 */

import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  isPeek: "moz-src:///browser/components/sval/SvalPeek.sys.mjs",
  SvalTabs: "moz-src:///browser/components/sval/SvalTabs.sys.mjs",
});

/** The table Places keeps visits' workspaces in. */
export const TABLE = "sval_visit_workspaces";

/**
 * Visit id -> workspace, for an import's visits not yet written: the history
 * sync reads them before the write lands.
 */
const pending = new Map();

/**
 * The workspace `browser`'s page is in: the workspace of its tab's node, or,
 * for a tab no node describes yet, such as an open Quick Peek, the workspace
 * its window shows. A Peek's page, a private window's and a browser
 * that is no tab's are in none.
 *
 * @param {Element} browser A `<browser>`.
 * @returns {string|null}
 */
export function workspaceOfBrowser(browser) {
  const win = browser?.documentGlobal;
  if (
    !win ||
    win.closed ||
    lazy.PrivateBrowsingUtils.isWindowPrivate(win) ||
    lazy.isPeek(win)
  ) {
    return null;
  }
  const panel = win.SvalPanel;
  const tab = win.gBrowser?.getTabForBrowser(browser);
  if (!panel || !tab) {
    return null;
  }
  return lazy.SvalTabs.workspaceOfTab(win, tab);
}

/** `@sval/visit-workspaces;1`, which Places asks as it records a visit. */
export class SvalVisitWorkspacesService {
  QueryInterface = ChromeUtils.generateQI(["nsISvalVisitWorkspaces"]);

  workspaceOfBrowser(browser) {
    try {
      return workspaceOfBrowser(browser);
    } catch (err) {
      SvalLog.warn(`visit workspaces: ${SvalLog.errorName(err)}`);
      return null;
    }
  }
}

/**
 * Tells every view of history to read Places again: a visit's workspace
 * changed where no Places event reports it.
 */
function purgeViews() {
  PlacesObservers.notifyListeners([new PlacesPurgeCaches()]);
}

export const SvalVisitWorkspaces = {
  /**
   * The workspace of each visit, by Places' visit id.
   *
   * @param {number[]} visitIds
   * @returns {Promise<Map<number, string>>} Only visits made in one.
   */
  async workspacesOf(visitIds) {
    const found = new Map();
    const unknown = [];
    for (const id of visitIds) {
      if (pending.has(id)) {
        found.set(id, pending.get(id));
      } else {
        unknown.push(id);
      }
    }
    if (!unknown.length) {
      return found;
    }
    const db = await lazy.PlacesUtils.promiseDBConnection();
    for (let at = 0; at < unknown.length; at += 500) {
      const ids = unknown.slice(at, at + 500);
      const rows = await db.execute(
        `SELECT visit_id, workspace FROM ${TABLE}
         WHERE visit_id IN (${ids.map(() => "?").join(",")})`,
        ids
      );
      for (const row of rows) {
        found.set(
          row.getResultByName("visit_id"),
          row.getResultByName("workspace")
        );
      }
    }
    return found;
  },

  /**
   * The workspace of the latest visit to `url`, the one a History row shows.
   *
   * @param {string} url
   * @returns {Promise<string|null>}
   */
  async latestOf(url) {
    const db = await lazy.PlacesUtils.promiseDBConnection();
    const rows = await db.executeCached(
      `SELECT w.workspace
       FROM moz_places h
       JOIN moz_historyvisits v ON v.place_id = h.id
       LEFT JOIN ${TABLE} w ON w.visit_id = v.id
       WHERE h.url_hash = hash(:url) AND h.url = :url
       ORDER BY v.visit_date DESC LIMIT 1`,
      { url }
    );
    return rows[0]?.getResultByName("workspace") ?? null;
  },

  /**
   * Records the workspace of visits Places already holds, found by page and
   * time, as another device's visits arrive: each takes the one its node
   * names, and one made in none takes none.
   *
   * @param {object[]} visits `{ url, visitedAt, workspace }`, `visitedAt` in
   *   milliseconds and `workspace` an id or null.
   */
  async record(visits) {
    if (!visits.length) {
      return;
    }
    await lazy.PlacesUtils.withConnectionWrapper(
      "SvalVisitWorkspaces.record",
      db =>
        db.executeTransaction(async () => {
          for (const { url, visitedAt, workspace } of visits) {
            const params = {
              url,
              from: visitedAt * 1000,
              to: visitedAt * 1000 + 1000,
            };
            if (workspace) {
              await db.executeCached(
                `INSERT OR REPLACE INTO ${TABLE} (visit_id, workspace)
                 SELECT v.id, :workspace
                 FROM moz_historyvisits v JOIN moz_places h ON h.id = v.place_id
                 WHERE h.url_hash = hash(:url) AND h.url = :url
                   AND v.visit_date >= :from AND v.visit_date < :to`,
                { ...params, workspace }
              );
            } else {
              await db.executeCached(
                `DELETE FROM ${TABLE} WHERE visit_id IN (
                   SELECT v.id
                   FROM moz_historyvisits v JOIN moz_places h ON h.id = v.place_id
                   WHERE h.url_hash = hash(:url) AND h.url = :url
                     AND v.visit_date >= :from AND v.visit_date < :to)`,
                params
              );
            }
          }
        })
    );
    purgeViews();
  },

  /**
   * Runs `insert`, an import's insertion of one profile's history, and
   * records `workspace` for every visit it makes that Places recorded no
   * workspace for. Visits another device made, which history sync inserts
   * meanwhile, are left to it: `isSyncing(url, visitedAt)` names them.
   *
   * @param {string} workspace
   * @param {() => Promise<number>} insert
   * @param {(url: string, visitedAt: number) => boolean} [isSyncing]
   * @returns {Promise<number>} What `insert` answers.
   */
  async whileImporting(workspace, insert, isSyncing = () => false) {
    const ids = [];
    const listener = events => {
      for (const event of events) {
        if (!isSyncing(event.url, event.visitTime)) {
          ids.push(event.visitId);
          pending.set(event.visitId, workspace);
        }
      }
    };
    PlacesObservers.addListener(["page-visited"], listener);
    let result;
    try {
      result = await insert();
    } finally {
      PlacesObservers.removeListener(["page-visited"], listener);
      try {
        await lazy.PlacesUtils.withConnectionWrapper(
          "SvalVisitWorkspaces.whileImporting",
          db =>
            db.executeTransaction(async () => {
              for (let at = 0; at < ids.length; at += 500) {
                const slice = ids.slice(at, at + 500);
                await db.execute(
                  `INSERT OR IGNORE INTO ${TABLE} (visit_id, workspace)
                   SELECT id, ? FROM moz_historyvisits
                   WHERE id IN (${slice.map(() => "?").join(",")})`,
                  [workspace, ...slice]
                );
              }
            })
        );
      } finally {
        for (const id of ids) {
          pending.delete(id);
        }
      }
      if (ids.length) {
        purgeViews();
      }
    }
    return result;
  },
};
