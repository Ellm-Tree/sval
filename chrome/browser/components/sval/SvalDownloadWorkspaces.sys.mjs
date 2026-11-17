/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Downloads belong to the workspace whose tab started them. The Downloads
 * panel of a window lists its own workspace's by default, or every
 * workspace's with each row labelled, and the toolbar button's progress and
 * attention follow only the workspace the window shows. An agent's download
 * never opens the panel, or draws attention, in a user's window.
 *
 * The workspace id is kept on the download itself, in the properties the
 * Downloads API carries through a restart for it (`_unknownProperties`,
 * serialized by `serializeUnknownProperties` in DownloadCore.sys.mjs), so a
 * paused download comes back to its workspace. A download whose workspace
 * was deleted keeps the id, and reads as from a deleted workspace.
 */

import {
  agentLabelOf,
  switcherItems,
} from "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  isPeek: "moz-src:///browser/components/sval/SvalPeek.sys.mjs",
  SvalPeek: "moz-src:///browser/components/sval/SvalPeek.sys.mjs",
  SvalPrivateJars: "moz-src:///browser/components/sval/SvalPrivateJars.sys.mjs",
  SvalTabs: "moz-src:///browser/components/sval/SvalTabs.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

/** The download property the workspace id is kept in. */
export const WORKSPACE_PROPERTY = "svalWorkspace";

/**
 * What a download a tab started is recorded as when that tab cannot be
 * found: it is of no workspace, so it is listed only under All
 * workspaces, and never announced. It is never taken for the focused
 * window's, which could put an agent's download in a user's window.
 */
export const UNKNOWN_WORKSPACE = "unknown";

/** The windows whose panel lists every workspace's downloads. */
const listingAll = new WeakSet();

/** Each window's toolbar indicator data, from `indicatorDataFor`. */
const indicatorData = new WeakMap();

/**
 * The Peek each download of this session was started in, held weakly so a
 * download kept on the list keeps no closed Peek alive.
 *
 * @type {WeakMap<object, WeakRef<Window>>}
 */
const startedInPeek = new WeakMap();

/**
 * @param {object} download
 * @returns {Window|null} The Peek `download` was started in, while it stays
 *   open. A Peek handed over to a window as it closes is gone already.
 */
function peekOf(download) {
  const win = startedInPeek.get(download)?.deref();
  return win && !win.closed && !lazy.SvalPeek.isHandedOff(win) ? win : null;
}

/**
 * @param {object} download
 * @returns {string|null} The workspace that started `download`, or null for
 *   one from before Sval kept it.
 */
export function workspaceOfDownload(download) {
  const id = download?._unknownProperties?.[WORKSPACE_PROPERTY];
  return typeof id === "string" ? id : null;
}

/**
 * The top browsing context whose page started a download, its browser and
 * its window, each null when no live context has the download's id.
 *
 * @param {object} download
 * @returns {{top: BrowsingContext|null, browser: Element|null, win: Window|null}}
 */
function startingPlace(download) {
  const contextId = download.source?.browsingContextId;
  // A module has no `BrowsingContext` global; a window has, as
  // `DownloadUIHelper` reaches it.
  const any = lazy.BrowserWindowTracker.getTopWindow({
    allowPopups: true,
    allowFromInactiveWorkspace: true,
  });
  try {
    const top = contextId ? any?.BrowsingContext.get(contextId)?.top : null;
    return {
      top,
      browser: top?.embedderElement ?? null,
      win: top?.topChromeWindow ?? null,
    };
  } catch {
    return { top: null, browser: null, win: null };
  }
}

/**
 * The workspace a download starts in: the one holding the tab that started
 * it, `UNKNOWN_WORKSPACE` for a tab that cannot be found, or, for a
 * download no tab started, the one the focused window shows. A private
 * download always gets a private window's workspace.
 *
 * @param {object} download
 * @param {{top: BrowsingContext|null, browser: Element|null, win: Window|null}} place
 *   Where it started, from {@link startingPlace}.
 * @returns {string|null}
 */
function startingWorkspace(download, { top, browser, win }) {
  const contextId = download.source?.browsingContextId;
  // A private popup has no toolbar to list a download in, so its download is
  // the window's whose session it shares (`SvalPrivateJars.windowOf`).
  if (download.source?.isPrivate && win && !win.toolbar.visible) {
    const owner = lazy.SvalPrivateJars.windowOf(
      top?.originAttributes?.userContextId
    );
    if (owner) {
      return owner.SvalPanel?.workspaceId ?? null;
    }
  }
  const panel = win?.SvalPanel;
  // A private download is always some private window's, or no window could
  // list it: one whose tab is gone, or that no tab started, is the focused
  // private window's.
  if (download.source?.isPrivate && !panel) {
    return (
      lazy.BrowserWindowTracker.getTopWindow({
        private: true,
        allowPopups: true,
      })?.SvalPanel?.workspaceId ?? null
    );
  }
  // A Peek's page is in no workspace, so its download is no
  // workspace's either, and goes to the most recent window, as Firefox's
  // does (`windowToTell`).
  if (lazy.isPeek(win)) {
    return null;
  }
  if (contextId && !panel) {
    return UNKNOWN_WORKSPACE;
  }
  if (panel) {
    return lazy.SvalTabs.workspaceOfTab(
      panel,
      win.gBrowser?.getTabForBrowser(browser)
    );
  }
  return (
    lazy.BrowserWindowTracker.getTopWindow()?.SvalPanel?.workspaceId ?? null
  );
}

/**
 * Records the workspace a download was started in, once, as it joins the
 * list, and the Peek it was started in, if any. A download restored from a
 * past session keeps the workspace it has.
 *
 * @param {object} download
 */
export function record(download) {
  if (workspaceOfDownload(download) !== null) {
    return;
  }
  const place = startingPlace(download);
  if (lazy.isPeek(place.win)) {
    startedInPeek.set(download, new WeakRef(place.win));
  }
  const id = startingWorkspace(download, place);
  if (id !== null) {
    download._unknownProperties ??= {};
    download._unknownProperties[WORKSPACE_PROPERTY] = id;
  }
}

/**
 * @param {Window} win A browser window.
 * @param {object} download
 * @returns {boolean} Whether `download` is of the workspace `win` shows. One
 *   from before Sval kept workspaces is every workspace's. A private window's
 *   workspace is its own session's (`SvalPrivateJars`), so it has only the
 *   downloads started in it, and a Peek, in no workspace, has only its own.
 */
export function inShownWorkspace(win, download) {
  if (lazy.isPeek(win)) {
    return peekOf(download) === win;
  }
  const id = workspaceOfDownload(download);
  if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
    return id !== null && id === win.SvalPanel?.workspaceId;
  }
  return id === null || id === win.SvalPanel?.workspaceId;
}

/**
 * @param {Window} win
 * @param {object} download
 * @returns {boolean} Whether `win`'s panel lists `download`. A private
 *   window lists its own alone.
 */
export function listed(win, download) {
  return (
    (listingAll.has(win) && !lazy.PrivateBrowsingUtils.isWindowPrivate(win)) ||
    inShownWorkspace(win, download)
  );
}

/**
 * @param {Window} page The window of a downloads list in a page or a window
 *   of its own, `about:downloads` or the Library.
 * @param {object} download
 * @returns {boolean} Whether that list shows `download`: every one, except in
 *   a private window, which lists its own alone.
 */
export function listedInPage(page, download) {
  const win = page.browsingContext?.topChromeWindow ?? page;
  return (
    !lazy.PrivateBrowsingUtils.isWindowPrivate(win) ||
    inShownWorkspace(win, download)
  );
}

/**
 * @param {Window} win
 * @returns {boolean} Whether `win`'s panel lists every workspace's downloads.
 */
export function listsAll(win) {
  return listingAll.has(win);
}

/**
 * Lists every workspace's downloads in `win`'s panel, or the shown
 * workspace's alone.
 *
 * @param {Window} win
 * @param {boolean} all
 */
export function listAll(win, all) {
  if (all) {
    listingAll.add(win);
  } else {
    listingAll.delete(win);
  }
  win.DownloadsView?.svalRelist?.();
}

/**
 * The window `win` came to show another workspace: its panel goes back to
 * that workspace's downloads, and its toolbar button follows them.
 *
 * @param {Window} win
 */
export function workspaceShown(win) {
  listingAll.delete(win);
  win.DownloadsView?.svalRelist?.();
  indicatorData.get(win)?.svalRefilter();
}

/**
 * `win`'s toolbar indicator data: one per window, made by `make` with the
 * window's filter, so its progress and attention are its workspace's.
 *
 * @param {Window} win
 * @param {(filter: Function) => object} make
 * @returns {object}
 */
export function indicatorDataFor(win, make) {
  // A page such as `about:downloads` asks for the data of its tab's window.
  win = win.browsingContext?.topChromeWindow ?? win;
  let data = indicatorData.get(win);
  if (!data) {
    data = make(download => inShownWorkspace(win, download));
    indicatorData.set(win, data);
  }
  return data;
}

/**
 * @param {Window} win
 * @param {string|null} id
 * @returns {boolean} Whether `id` is an agent's workspace.
 */
function isAgentWorkspace(win, id) {
  return agentLabelOf(win.SvalPanel?.nodes ?? {}, id) !== null;
}

/**
 * The window to tell about `download` starting, finishing or failing: the
 * Peek it was started in while that stays open, the most recent window
 * showing its workspace, or none for an agent's download or
 * one whose workspace no window shows. A download Sval has no workspace for
 * goes to the most recent window, as Firefox's does.
 *
 * @param {object} download
 * @param {boolean} isPrivate
 * @returns {Window|null}
 */
export function windowToTell(download, isPrivate) {
  const peek = peekOf(download);
  if (peek) {
    return peek;
  }
  const id = workspaceOfDownload(download);
  const top = lazy.BrowserWindowTracker.getTopWindow({
    private: isPrivate,
    allowFromInactiveWorkspace: true,
  });
  if (id === null || !top) {
    return top;
  }
  if (id === UNKNOWN_WORKSPACE || isAgentWorkspace(top, id)) {
    return null;
  }
  return (
    lazy.BrowserWindowTracker.orderedWindows.find(
      win =>
        !win.closed &&
        lazy.PrivateBrowsingUtils.isWindowPrivate(win) === isPrivate &&
        win.SvalPanel?.workspaceId === id
    ) ?? null
  );
}

/**
 * What a row in `win`'s panel says it is from, under "All Workspaces".
 *
 * @param {Window} win
 * @param {object} download
 * @returns {{name: string, emoji: string|null, color: string|null, agent: boolean, deleted: boolean, unknown?: boolean}|null}
 *   null for a download Sval has no workspace for.
 */
export function labelOf(win, download) {
  const id = workspaceOfDownload(download);
  if (id === null) {
    return null;
  }
  const panel = win.SvalPanel;
  const item = switcherItems(
    panel?.nodes ?? {},
    panel?.workspaceId ?? null
  ).find(entry => entry.id === id);
  if (!item) {
    return {
      name: "",
      emoji: null,
      color: null,
      agent: false,
      deleted: id !== UNKNOWN_WORKSPACE,
      unknown: id === UNKNOWN_WORKSPACE,
    };
  }
  return {
    name: panel.workspaceName(item),
    emoji: item.agent ? null : item.emoji,
    color: item.color,
    agent: !!item.agent,
    deleted: false,
  };
}

export const SvalDownloadWorkspaces = {
  WORKSPACE_PROPERTY,
  UNKNOWN_WORKSPACE,
  workspaceOfDownload,
  record,
  inShownWorkspace,
  listed,
  listedInPage,
  listsAll,
  listAll,
  workspaceShown,
  indicatorDataFor,
  windowToTell,
  labelOf,
};
