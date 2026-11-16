/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Every browser import can read on this computer (import spec §4), found
 * through each reader's own `findProfiles`.
 *
 * Each reader module exports the same three functions: `findProfiles(roots)`,
 * `harvest(profile)` and `importHistory(profile)`. This module is the one
 * place that knows which modules those are, and the one place that gathers a
 * browser's profiles into the browser, so the page and the runner deal in
 * browsers, each `{ source, profiles }`, and never in readers.
 */

import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { SvalVisitWorkspaces } from "moz-src:///browser/components/sval/SvalVisitWorkspaces.sys.mjs";
import { heldOpen } from "moz-src:///browser/components/sval/SvalImportFiles.sys.mjs";
import {
  combineProfiles,
  holdsNothing,
  mergeRoots,
} from "moz-src:///browser/components/sval/SvalImportModel.sys.mjs";

const READERS = Object.freeze({
  chromium: "moz-src:///browser/components/sval/SvalImportChromium.sys.mjs",
  arc: "moz-src:///browser/components/sval/SvalImportArc.sys.mjs",
  safari: "moz-src:///browser/components/sval/SvalImportSafari.sys.mjs",
  firefox: "moz-src:///browser/components/sval/SvalImportFirefox.sys.mjs",
  zen: "moz-src:///browser/components/sval/SvalImportZen.sys.mjs",
  orion: "moz-src:///browser/components/sval/SvalImportOrion.sys.mjs",
  html: "moz-src:///browser/components/sval/SvalImportHtml.sys.mjs",
});

/** Which reader serves each source key a profile carries. */
const READER_OF = Object.freeze({
  chrome: "chromium",
  edge: "chromium",
  brave: "chromium",
  vivaldi: "chromium",
  dia: "chromium",
  arc: "arc",
  safari: "safari",
  firefox: "firefox",
  zen: "zen",
  orion: "orion",
  html: "html",
});

/** Display names, in the order sources are listed. */
export const SOURCE_NAMES = Object.freeze({
  chrome: "Chrome",
  edge: "Edge",
  brave: "Brave",
  vivaldi: "Vivaldi",
  arc: "Arc",
  dia: "Dia",
  safari: "Safari",
  orion: "Orion",
  firefox: "Firefox",
  zen: "Zen",
  html: "Bookmarks file",
});

/**
 * Where each browser exports its saved passwords to a CSV, for import's
 * logins hand-off (import spec §5.1). Sval reads no password; the user moves
 * the file. From each vendor's help pages as of 2026-10, except Arc's,
 * Brave's and Dia's, which have none and are Chromium's own page, and Zen's,
 * which is Firefox's. Orion has none: it offers no export.
 */
export const EXPORT_STEPS = Object.freeze({
  chrome:
    "⋮ › Passwords and autofill › Google Password Manager › Settings › " +
    "Export passwords",
  edge: "⋯ › Passwords › ⋯ › Export passwords",
  brave: "open brave://password-manager/settings, then Export passwords",
  vivaldi: "open vivaldi://password-manager/settings, then Export passwords",
  arc: "open arc://password-manager/settings, then Export passwords",
  dia: "open chrome://password-manager/settings, then Export passwords",
  safari: "in the Passwords app, File › Export All Passwords to File…",
  firefox: "☰ › Passwords, then ⋯ › Export Passwords…",
  zen: "open about:logins, then ⋯ › Export Passwords…",
});

const ORDER = Object.keys(SOURCE_NAMES);

/**
 * @param {string} source A profile's `source`.
 * @returns {object} Its reader module.
 */
export function readerFor(source) {
  const key = READER_OF[source];
  if (!key) {
    throw new Error(`sval: no reader for source "${source}"`);
  }
  return ChromeUtils.importESModule(READERS[key]);
}

/**
 * Every profile of every browser found, in source order. A reader that fails
 * costs only its own browser's rows.
 *
 * @param {object} [roots] For tests: by reader (`chromium`, `arc`, `safari`,
 *   `firefox`, `zen`, `orion`), the roots that reader's `findProfiles` takes.
 *   A reader left out looks nowhere; with no `roots` at all, every reader
 *   looks where the browser keeps its data.
 * @returns {Promise<object[]>} `{ source, id, name, dir }` profiles.
 */
export async function findAll(roots) {
  const found = await Promise.all(
    Object.entries(READERS).map(async ([key, url]) => {
      if (roots && !roots[key]) {
        return [];
      }
      try {
        const reader = ChromeUtils.importESModule(url);
        return await (roots
          ? reader.findProfiles(roots[key])
          : reader.findProfiles());
      } catch (err) {
        SvalLog.warn(
          `import: looking for a browser failed: ${SvalLog.errorName(err)}`
        );
        return [];
      }
    })
  );
  return found
    .flat()
    .sort((a, b) => ORDER.indexOf(a.source) - ORDER.indexOf(b.source));
}

/**
 * Every browser found, each with its profiles, in source order. A browser is
 * one thing to import from however many profiles it keeps (import spec §3).
 *
 * @param {object} [roots] As {@link findAll} takes them.
 * @returns {Promise<object[]>} `{ source, profiles }` browsers.
 */
export async function findBrowsers(roots) {
  const browsers = [];
  for (const profile of await findAll(roots)) {
    if (browsers.at(-1)?.source !== profile.source) {
      browsers.push({ source: profile.source, profiles: [] });
    }
    browsers.at(-1).profiles.push(profile);
  }
  return browsers;
}

/**
 * What one browser holds, its profiles as workspaces
 * (`SvalImportModel.combineProfiles`). A profile holding nothing brings
 * nothing. A profile that cannot be read is left out and counted as
 * `unread`, and as `held` too when the browser holds its files open
 * (`SvalImportFiles.heldOpen`). The browser fails only when none of its
 * profiles can be read.
 *
 * @param {object} browser `{ source, profiles }`.
 * @returns {Promise<object>} A `Harvest`.
 * @throws {Error} The reader's own error, when no profile could be read.
 */
export async function harvestBrowser(browser) {
  const reader = readerFor(browser.source);
  const parts = [];
  let failure = null;
  let read = 0;
  let held = 0;
  for (const profile of browser.profiles) {
    try {
      const harvest = await reader.harvest(profile);
      read++;
      if (!holdsNothing(harvest)) {
        parts.push({ profile, harvest });
      }
    } catch (err) {
      SvalLog.warn(
        `import: a ${browser.source} profile failed: ${SvalLog.errorName(err)}`
      );
      failure = err;
      held += heldOpen(err) ? 1 : 0;
    }
  }
  if (!read && failure) {
    throw failure;
  }
  return {
    ...combineProfiles(parts, SOURCE_NAMES[browser.source]),
    unread: browser.profiles.length - read,
    held,
  };
}

/**
 * A browser's bookmarks read again for the import, from each profile its
 * harvest holds, for a reader that can (SvalImportFiles); a reader that
 * cannot keeps the page's reading.
 *
 * @param {string} source
 * @param {object} harvest From {@link harvestBrowser}.
 * @returns {Promise<object|null>} The merged `Roots`.
 */
export async function importBookmarks(source, harvest) {
  const reader = readerFor(source);
  if (!reader.importBookmarks) {
    return harvest.bookmarks;
  }
  const list = [];
  for (const part of harvest.parts) {
    list.push(await reader.importBookmarks(part.profile));
  }
  return mergeRoots(list);
}

/**
 * Inserts the recent history of each profile a browser's harvest holds.
 * One profile's history failing costs only that profile's pages: the others
 * still go in, and the first failure is thrown once they have.
 *
 * @param {string} source
 * @param {object} harvest From {@link harvestBrowser}.
 * @param {string[]} [landed] Ids of the profiles whose history is already
 *   in, which are skipped; each profile that goes in is added.
 * @param {object} [workspaces] Profile id -> the workspace its visits take
 *   (`historyWorkspaces`). A profile with none takes none.
 * @param {(url: string, visitedAt: number) => boolean} [isSyncing] Names
 *   the visits history sync inserts meanwhile, which keep their own.
 * @returns {Promise<number>} Pages inserted.
 * @throws {Error} The first reader's error, with its cause.
 */
export async function importHistory(
  source,
  harvest,
  landed = [],
  workspaces = {},
  isSyncing = () => false
) {
  const reader = readerFor(source);
  let pages = 0;
  let failure = null;
  for (const part of harvest.parts) {
    if (landed.includes(part.profile.id)) {
      continue;
    }
    const workspace = workspaces[part.profile.id];
    try {
      pages += workspace
        ? await SvalVisitWorkspaces.whileImporting(
            workspace,
            () => reader.importHistory(part.profile),
            isSyncing
          )
        : await reader.importHistory(part.profile);
      landed.push(part.profile.id);
    } catch (err) {
      SvalLog.warn(
        `import: a ${source} profile's history failed: ${SvalLog.errorName(err)}`
      );
      failure ??= err;
    }
  }
  if (failure) {
    throw failure;
  }
  return pages;
}
