/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * What about:processes shows of a private window's processes
 * (`about-processes-private-windows.patch`). The page lists each process
 * with the site it serves and, under it, each document with its address and
 * its tab's title. It shows neither for a private session the page is
 * outside of: nothing outside a private session says what it has open.
 * Opened in a normal window that is every private session,
 * and opened in a private window it is every session but the window's own
 * (`SvalPrivateJars`).
 */

import { PrivateBrowsingUtils } from "resource://gre/modules/PrivateBrowsingUtils.sys.mjs";

/**
 * @param {string} origin A process's origin, as `ChromeUtils.requestProcInfo`
 *   gives it: a site with its origin attributes' suffix, or "".
 * @returns {?number} The jar of the private session the process serves, or
 *   null for a process that serves none. An origin whose suffix cannot be
 *   read names a site all the same, and counts as a session nobody is in.
 */
function sessionOfOrigin(origin) {
  if (!origin.includes("^")) {
    return null;
  }
  try {
    const attrs = ChromeUtils.createOriginAttributesFromOrigin(origin);
    return attrs.privateBrowsingId > 0 ? attrs.userContextId : null;
  } catch {
    return -1;
  }
}

/**
 * @param {Window} win A browser window.
 * @returns {?number} The jar of the private session `win` is in, or null
 *   for a normal window.
 */
function sessionOfWindow(win) {
  if (!PrivateBrowsingUtils.isWindowPrivate(win)) {
    return null;
  }
  return win.gBrowser?.defaultUserContextId ?? -1;
}

/**
 * @param {Window} viewer The about:processes page's window.
 * @returns {?number} The jar of the private session the page is shown in,
 *   or null in a normal window.
 */
function sessionOfViewer(viewer) {
  const win = viewer.browsingContext.topChromeWindow;
  return win ? sessionOfWindow(win) : null;
}

/**
 * @param {?number} session The viewer's session.
 * @returns {Set<number>} The outer window id of every document a private
 *   window of another session shows: each browser in the window, a tab's or
 *   any other, and the frames under it.
 */
function hiddenDocuments(session) {
  const ids = new Set();
  for (const win of Services.wm.getEnumerator(null)) {
    const its = sessionOfWindow(win);
    if (its === null || its === session) {
      continue;
    }
    for (const browser of win.document.querySelectorAll("browser")) {
      const contexts =
        browser.browsingContext?.getAllBrowsingContextsInSubtree() ?? [];
      for (const context of contexts) {
        const id = context.currentWindowGlobal?.outerWindowId;
        if (id) {
          ids.add(id);
        }
      }
    }
  }
  return ids;
}

export const SvalPrivateProcesses = {
  /**
   * @param {Window} viewer The about:processes page's window.
   * @param {string} origin A process's origin.
   * @returns {string} The origin the page names the process by: none for a
   *   process of a private session the page is outside of.
   */
  originFor(viewer, origin) {
    const its = sessionOfOrigin(origin);
    return its === null || its === sessionOfViewer(viewer) ? origin : "";
  },

  /**
   * @param {Window} viewer The about:processes page's window.
   * @param {object} process A process, as `ChromeUtils.requestProcInfo`
   *   gives it.
   * @returns {object[]} The process's documents the page lists: none that a
   *   private session the page is outside of shows.
   */
  windowsFor(viewer, process) {
    const session = sessionOfViewer(viewer);
    const its = sessionOfOrigin(process.origin || "");
    if (its !== null) {
      return its === session ? process.windows : [];
    }
    const hidden = hiddenDocuments(session);
    return process.windows.filter(win => !hidden.has(win.outerWindowId));
  },
};
