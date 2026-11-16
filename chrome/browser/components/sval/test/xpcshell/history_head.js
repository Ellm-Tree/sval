/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * What the history-sync test files share: a device's history as Places
 * reports it, and a state file in memory. The test files that use this name
 * it in an `import-globals-from` comment.
 */

// Read off the module, so the name PlacesUtils stays free for the test files
// that import it themselves into the scope this head shares.
const { TYPED, LINK, FRAMED_LINK, DOWNLOAD } = ChromeUtils.importESModule(
  "resource://gre/modules/PlacesUtils.sys.mjs"
).PlacesUtils.history.TRANSITIONS;

/**
 * One device's history: the store `SvalHistorySync` uses, and what the user
 * does, reported as Places reports it. Inserting a visit reports it as
 * visited, as `insertMany` does; expiry reports nothing, as Places reports
 * nothing `SvalHistorySync` hears. A visit's row is its visit id, and `workspace` the one `sval_visit_workspaces` holds for it.
 * `seedPages` orders pages by their latest visit where Places orders them by
 * frecency.
 */
class FakeHistory {
  constructor(visits = []) {
    this.visits = [];
    this.rows = 0;
    this.add(...visits.map(v => ({ transition: LINK, title: "", ...v })));
    this.on = null;
    this.recording = true;
  }

  /**
   * Records `visits`, each numbered as Places numbers its rows.
   *
   * @param {...object} visits `{ url, title, visitedAt, transition }`.
   */
  add(...visits) {
    for (const visit of visits) {
      const row = ++this.rows;
      visit.visitId = row;
      this.visits.push({ workspace: null, ...visit, row });
    }
  }

  // The store interface.
  enabled() {
    return this.recording;
  }
  observe(on) {
    this.on = on;
    return () => (this.on = null);
  }
  async insert(rows) {
    const added = rows.map(row => ({
      url: row.url,
      title: row.title,
      visitedAt: row.visitedAt,
      transition: row.transition,
      workspace: null,
    }));
    this.add(...added);
    this.on?.visited(added);
  }
  async removeVisits(list) {
    const emptied = [];
    for (const { url, at } of list) {
      this.visits = this.visits.filter(
        v => !(v.url === url && v.visitedAt === at)
      );
      if (!this.visits.some(v => v.url === url)) {
        emptied.push(url);
      }
    }
    if (emptied.length) {
      this.on?.removed(emptied);
    }
  }
  async workspacesOf(visitIds) {
    const found = new Map();
    for (const visit of this.visits) {
      if (visitIds.includes(visit.visitId) && visit.workspace) {
        found.set(visit.visitId, visit.workspace);
      }
    }
    return found;
  }
  async recordWorkspaces(rows) {
    for (const row of rows) {
      for (const visit of this.visits) {
        if (visit.url === row.url && visit.visitedAt === row.visitedAt) {
          visit.workspace = row.workspace ?? null;
        }
      }
    }
  }
  async seedPages(since, limit) {
    const latest = new Map();
    for (const v of this.visits) {
      if (v.visitedAt > since && !v.hidden) {
        latest.set(v.url, Math.max(latest.get(v.url) ?? 0, v.visitedAt));
      }
    }
    return [...latest]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([url]) => url);
  }
  async recentVisits(url) {
    return this.visits
      .filter(v => v.url === url)
      .sort((a, b) => b.visitedAt - a.visitedAt)
      .slice(0, 20)
      .map(({ visitedAt, transition }) => ({ visitedAt, transition }));
  }
  async visitsBefore(after, limit) {
    const newestFirst = (a, b) => b.visitedAt - a.visitedAt || b.row - a.row;
    const visits = this.visits
      .filter(v => !after || newestFirst(after, v) < 0)
      .sort(newestFirst)
      .slice(0, limit);
    const last = visits.at(-1);
    return {
      visits,
      next:
        visits.length < limit
          ? null
          : { visitedAt: last.visitedAt, row: last.row },
    };
  }

  // What the user does.
  visit(
    url,
    visitedAt,
    {
      title = "Page",
      transition = TYPED,
      workspace = null,
      hidden = false,
    } = {}
  ) {
    const visit = { url, title, visitedAt, transition, workspace, hidden };
    this.add(visit);
    this.on?.visited([visit]);
  }
  deletePage(url) {
    this.visits = this.visits.filter(v => v.url !== url);
    this.on?.removed([url]);
  }
  expire(url) {
    this.visits = this.visits.filter(v => v.url !== url);
  }
  clearBetween(from, to) {
    const before = new Set(this.visits.map(v => v.url));
    this.visits = this.visits.filter(
      v => v.visitedAt < from || v.visitedAt > to
    );
    const emptied = [...before].filter(
      url => !this.visits.some(v => v.url === url)
    );
    if (emptied.length) {
      this.on?.removed(emptied);
    }
  }

  has(url, visitedAt) {
    return this.visits.some(
      v =>
        v.url === url && (visitedAt === undefined || v.visitedAt === visitedAt)
    );
  }
}

function memoryStorage() {
  let saved = null;
  return {
    async read() {
      return saved && JSON.parse(saved);
    },
    async write(state) {
      saved = JSON.stringify(state);
    },
    saver(get) {
      return {
        saveSoon: () => (saved = JSON.stringify(get())),
        finalize: () => {},
      };
    },
  };
}
