/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Runs one import (import spec §7): the windows the user kept go into the
 * tree as one batch, bookmarks go to Favorites, one batch of the favorites
 * document, or a workspace, and history goes to Places.
 *
 * The page decides what to import and this module only carries it out, so
 * an import started from first run and one started from Settings are the
 * same import.
 */

import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { SvalClock } from "moz-src:///browser/components/sval/SvalClock.sys.mjs";
import {
  BOOKMARKS_TO,
  historyWorkspaces,
  planArchived,
  planFavorites,
  planTree,
} from "moz-src:///browser/components/sval/SvalImportModel.sys.mjs";
import {
  importBookmarks,
  importHistory,
} from "moz-src:///browser/components/sval/SvalImportSources.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AUTO_ARCHIVE_PREF: "moz-src:///browser/components/sval/SvalArchive.sys.mjs",
  takeArcCard: "moz-src:///browser/components/sval/SvalCard.sys.mjs",
  SvalArchive: "moz-src:///browser/components/sval/SvalArchive.sys.mjs",
  SvalFeedbackForm:
    "moz-src:///browser/components/sval/SvalFeedbackForm.sys.mjs",
  SvalFavoritesStore:
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
  FAVORITES_ROOT:
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
  PINS_ROOT: "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
  SvalHistorySync: "moz-src:///browser/components/sval/SvalHistorySync.sys.mjs",
});

const DIALOG_URL = "chrome://browser/content/sval/import.xhtml";

/**
 * The causes that mean a browser's files could not be opened, which a second
 * try may get past: `IOUtils` rejects with these `DOMException` names for a
 * file missing or refused by the system. Its `NotReadableError` is left out:
 * it also stands for content that could not be decoded
 * (`NS_ERROR_FILE_CORRUPTED`), which a second try reads the same.
 */
const OPEN_FAILURES = new Set(["NotFoundError", "NotAllowedError"]);

/**
 * A browser whose history alone failed, after everything else it brought
 * landed. Its reader's error is the cause.
 */
class HistoryFailure extends Error {
  name = "HistoryFailure";
}

/**
 * Which of messages spec §7's import failures `err` is. A reader wraps the
 * error it met in its own, as `cause`.
 *
 * @param {Error} err What a source's import threw.
 * @returns {"open"|"data"|"history"} `open` when its files could not be
 *   opened, `data` when what was read was not understood, `history` when
 *   only its history failed.
 */
export function importFailureKind(err) {
  if (err instanceof HistoryFailure) {
    return "history";
  }
  return OPEN_FAILURES.has(err?.cause?.name) ? "open" : "data";
}

/**
 * Opens the import page in `win`'s modal dialog. The page asks, then runs the
 * import through `run` and stays open, showing its progress and result
 * (messages spec §7), until the user presses Done.
 *
 * @param {Window} win A browser window.
 * @param {object} options
 * @param {Function} options.run `(plan, onProgress)`: runs a plan as
 *   {@link runImport} does, with its `onProgress`, and answers its report.
 * @param {object[]} [options.plan] A plan already chosen, which the page
 *   runs as it opens, asking nothing.
 * @param {object} [options.roots] Where the readers look, for tests; each
 *   reader's own default otherwise.
 * @returns {Promise<object|null>} What arrived, as `runImport`'s report
 *   summed over every run the page made, or null when nothing ran.
 */
export async function askImport(win, { run, plan = null, roots } = {}) {
  // What arrived is summed here, in this realm, as each run reports: a run
  // outlives a page closed some other way than Done, and a promise the page
  // made would settle its waiters through the page's global, which is gone
  // once the page closes.
  let total = null;
  // Whether each entry's last run failed, by entry, so a source that Try
  // Again brought counts as arrived.
  const failed = new Map();
  let running = null;
  // The context a failure's Send Report… asked for, if it was pressed.
  let reportContext = null;
  const record = async (chosen, onProgress) => {
    const report = await run(chosen, progress => {
      failed.set(chosen[progress.done - 1], !progress.ok);
      // The page may have closed under the run, which goes on without it.
      try {
        onProgress(progress);
      } catch (err) {
        SvalLog.warn(
          `import: the page missed a step: ${SvalLog.errorName(err)}`
        );
      }
    });
    total ??= { workspaces: [], tabs: 0, favorites: 0, history: 0 };
    total.workspaces.push(...report.workspaces);
    total.tabs += report.tabs;
    total.favorites += report.favorites;
    total.history += report.history;
    total.failed = [...failed]
      .filter(([, no]) => no)
      .map(([entry]) => entry.browser.source);
    return report;
  };
  const args = {
    roots,
    plan,
    run: (chosen, onProgress) => (running = record(chosen, onProgress)),
    // The page closes on Send Report…, and the feedback form takes its
    // place (feedback spec §2): the window's modal dialog would hold the
    // form out of reach.
    sendReport: context => {
      reportContext = context;
    },
    // Read by `gDialogBox.open` while the window is in a modal state; see
    // `SvalAgentAlerts.askToPair`.
    getProperty: name => name === "async",
  };
  await win.gDialogBox?.open(DIALOG_URL, args);
  if (reportContext) {
    lazy.SvalFeedbackForm.open(win, { context: reportContext });
  }
  await running?.catch(() => {});
  return total;
}

function countTree(children) {
  let n = 0;
  for (const child of children) {
    n += child.children ? countTree(child.children) : 1;
  }
  return n;
}

/**
 * @param {object[]} plan One entry per browser the user ticked, in order:
 *   `{ browser, harvest, windows, bookmarks, bookmarksName, history,
 *   autoArchive }`, where `browser` is `{ source, profiles }` and
 *   `harvest` its `SvalImportSources.harvestBrowser`, and `windows`, `bookmarks` and
 *   `bookmarksName` are `planTree`'s choices, `history` says whether to
 *   import history, and `autoArchive` is the choice for archiving idle tabs
 *   to make the global one, or null.
 * @param {object} context
 * @param {object} context.engine A `SvalEngine`.
 * @param {string|null} [context.reuseWorkspace] The empty first-launch
 *   workspace, which the first imported window fills (§3).
 * @param {object} [context.favorites] The Favorites bookmarks go to: the
 *   profile's (`SvalFavoritesStore.instance`) by default.
 * @param {object} [context.archive] The Archive a browser's archived tabs go
 *   to: the profile's (`SvalArchive.instance`) by default.
 * @param {Function} [context.mintId] Returns a fresh node id.
 * @param {Function} [context.onProgress] Called after each source with
 *   `{ source, done, total, ok, kind, error }`: `done` sources of `total`
 *   have run, this one's `ok` says whether it arrived, and `kind` is
 *   {@link importFailureKind}'s answer and `error` the error's name for one
 *   that failed.
 * @returns {Promise<{workspaces: string[], tabs: number, favorites: number,
 *   history: number, archived: number, failed: string[]}>} What arrived, and
 *   the sources that failed, by `source` key.
 */
export async function runImport(
  plan,
  {
    engine,
    reuseWorkspace = null,
    favorites = lazy.SvalFavoritesStore.instance,
    archive = lazy.SvalArchive.instance,
    mintId = () => crypto.randomUUID(),
    onProgress = () => {},
  }
) {
  const report = {
    workspaces: [],
    tabs: 0,
    favorites: 0,
    history: 0,
    archived: 0,
    failed: [],
  };
  let reuse = reuseWorkspace;
  let done = 0;
  for (const entry of plan) {
    // The first-launch workspace goes to the first source that brings a
    // window, and is offered no further once one has tried it: if a peer
    // deleted it before this ran, that source fails alone, and the next does
    // not inherit the same failing rename.
    const offer = { workspace: reuse, taken: false };
    const { source } = entry.browser;
    let kind = null;
    let error = null;
    try {
      await importOne(entry, {
        engine,
        favorites,
        archive,
        mintId,
        offer,
        report,
      });
    } catch (err) {
      kind = importFailureKind(err);
      error = err?.name ?? "Error";
      // The name only: a reader's message is written to carry no path or
      // title, but this line is not the place to rely on that.
      SvalLog.error(
        `import: a source failed: ${SvalLog.errorName(err)}, kind ${kind}`
      );
      report.failed.push(source);
    }
    if (offer.taken) {
      reuse = null;
    }
    onProgress({
      source,
      done: ++done,
      total: plan.length,
      ok: !kind,
      kind,
      error,
    });
  }
  SvalLog.info(
    `import: ${report.workspaces.length} workspaces, ${report.tabs} tabs, ` +
      `${report.favorites} favorites, ${report.history} history pages, ` +
      `${report.failed.length} sources failed`
  );
  return report;
}

async function importOne(
  entry,
  { engine, favorites, archive, mintId, offer, report }
) {
  const { source } = entry.browser;
  // What earlier runs of this entry added, so Try Again adds only the rest:
  // a second batch of the same windows would make their workspaces twice.
  const landed = (entry.landed ??= {
    windows: false,
    bookmarks: false,
    history: [],
  });
  let { harvest } = entry;
  // What failed while the rest went on: the source still reports it, and
  // what landed stays.
  let failure = null;
  let historyAlone = false;

  // The page's harvest may have read a database in place, missing what its
  // browser has not yet checkpointed; such a reader reads its bookmarks again
  // for the import (SvalImportFiles). Bookmarks it cannot read again are
  // left for Try Again, which the failure's line offers.
  let takesBookmarks =
    !landed.bookmarks &&
    (entry.bookmarks === BOOKMARKS_TO.favorites ||
      entry.bookmarks === BOOKMARKS_TO.workspace);
  if (takesBookmarks) {
    try {
      harvest = {
        ...harvest,
        bookmarks: await importBookmarks(source, harvest),
      };
    } catch (err) {
      failure = err;
      takesBookmarks = false;
    }
  }

  const toWorkspace =
    takesBookmarks && entry.bookmarks === BOOKMARKS_TO.workspace;
  const { ops, workspaces } = planTree(
    harvest,
    {
      windows: landed.windows ? [] : entry.windows,
      bookmarks: toWorkspace ? BOOKMARKS_TO.workspace : BOOKMARKS_TO.none,
      bookmarksName: entry.bookmarksName,
    },
    { mintId, reuseWorkspace: offer.workspace }
  );
  if (ops.length) {
    offer.taken = !!offer.workspace;
    await engine.mutate({ kind: "batch", ops, now: SvalClock.now() });
    report.workspaces.push(...workspaces);
    report.tabs += ops.filter(op => op.kind === "addTab").length;
  }
  if (!landed.windows) {
    landed.historyWorkspaces = historyWorkspaces(
      harvest,
      entry.windows,
      workspaces
    );
    // Planned with the workspaces this run filled, so Try Again adds what
    // is left of the same entries.
    landed.archived = planArchived(harvest, entry.windows, workspaces, {
      mintId,
    });
  }
  landed.windows = true;

  if (landed.archived?.length && archive) {
    const entries = landed.archived;
    landed.archived = [];
    const adding = archive.importEntries(entries);
    report.archived += entries.length;
    if (archive.ready) {
      try {
        await adding;
      } catch (err) {
        landed.archived = entries;
        report.archived -= entries.length;
        failure ??= err;
      }
    } else {
      // The Archive opens past first run, after this import has ended.
      adding.catch(err =>
        SvalLog.warn(
          `import: archived tabs did not arrive: ${SvalLog.errorName(err)}`
        )
      );
    }
  }
  if (toWorkspace) {
    landed.bookmarks = true;
  }

  if (
    takesBookmarks &&
    entry.bookmarks === BOOKMARKS_TO.favorites &&
    harvest.bookmarks
  ) {
    if (!favorites) {
      throw new Error("sval: Favorites have not started");
    }
    await favorites.whenReady();
    // A URL already a favorite gets no second copy (import spec §2), and
    // one already a pin no second pin.
    const urlsIn = root =>
      favorites
        .all()
        .filter(
          row =>
            row.kind === "favorite" &&
            row.url &&
            favorites.isWithin(row.guid, root)
        )
        .map(row => row.url);
    const planned = planFavorites(
      harvest.bookmarks,
      urlsIn(lazy.FAVORITES_ROOT),
      urlsIn(lazy.PINS_ROOT)
    );
    if (planned.favorites.length || planned.pins.length) {
      // The favorites and the pins are one batch (pins-root spec §7).
      await favorites.insertTree(planned.favorites, { pins: planned.pins });
      report.favorites +=
        countTree(planned.favorites) + countTree(planned.pins);
    }
  }
  if (takesBookmarks) {
    landed.bookmarks = true;
  }

  if (entry.history) {
    try {
      report.history += await importHistory(
        source,
        harvest,
        landed.history,
        landed.historyWorkspaces,
        (url, visitedAt) =>
          lazy.SvalHistorySync.instance?.isInserting(url, visitedAt) ?? false
      );
    } catch (err) {
      if (!failure) {
        failure = err;
        historyAlone = true;
      }
    }
  }

  // The browser archived idle tabs, and the user kept the box checked: the
  // global choice, as Settings sets it (idle-tab archive spec §7.5).
  if (entry.autoArchive) {
    Services.prefs.setStringPref(lazy.AUTO_ARCHIVE_PREF, entry.autoArchive);
  }
  // The card Arc gave its user comes with whatever else they brought.
  if (entry.harvest.arcCard) {
    lazy.takeArcCard(entry.harvest.arcCard);
    report.card = true;
  }
  if (historyAlone) {
    throw new HistoryFailure("sval: history could not be imported", {
      cause: failure,
    });
  }
  if (failure) {
    throw failure;
  }
}
