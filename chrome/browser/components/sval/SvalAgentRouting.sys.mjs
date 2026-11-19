/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Where a tab a page in an agent's tab opens goes, and what PDF.js's Save
 * does there (spec §4.1, §5.2). Firefox's `BrowserDOMWindow`,
 * `URILoadingHelper` and `PdfjsParent` ask here first
 * (`sval-agent-routing.patch`), and each open gate answers for its agents
 * (`SvalAgentHooks`).
 */

import { openGates } from "moz-src:///browser/components/sval/SvalAgentHooks.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  URILoadingHelper: "resource:///modules/URILoadingHelper.sys.mjs",
});

/**
 * The ways a page's request for a new tab or window reaches
 * `createContentWindowInFrame`. `OPEN_NEWWINDOW` reaches it only from an
 * agent's tab, for a window asked for without window features
 * (`sval-agent-new-windows.patch`), and Firefox's own method opens nothing
 * for it.
 */
const NEW_TAB = new Set([
  Ci.nsIBrowserDOMWindow.OPEN_NEWTAB,
  Ci.nsIBrowserDOMWindow.OPEN_NEWTAB_BACKGROUND,
  Ci.nsIBrowserDOMWindow.OPEN_NEWTAB_FOREGROUND,
  Ci.nsIBrowserDOMWindow.OPEN_NEWWINDOW,
]);

const LINK_TABS = new Set(["tab", "tabshifted"]);

/** Marks the `openLinkIn` params of a link open this module routed. */
const ROUTED = Symbol("routed");

/**
 * The route of the first gate that answers for `opener`, or null.
 *
 * @param {Element|undefined} opener
 * @returns {{window: Window|null, open: () => Promise<Window>}|null}
 */
function routeOf(opener) {
  for (const gate of openGates()) {
    const route = gate.routeTab(opener);
    if (route) {
      return route;
    }
  }
  return null;
}

/**
 * Asked first by `BrowserDOMWindow.createContentWindowInFrame`, which a
 * content process's request for a new tab reaches with the opener's
 * `<browser>` (`ContentParent::CommonCreateWindow`), from a `target=_blank`
 * link or a `window.open` without popup features, and so does one from an
 * agent's tab that Firefox would make a window of (`NEW_TAB`). Firefox opens
 * a tab in the opener's window, selected there, and from a popup in the
 * frontmost full window, which it then focuses (`#openURIInNewTab`).
 *
 * An agent's request is made of the agent's own window, as a background tab:
 * no window takes focus, and the agent's selected tab stays selected. While
 * the agent has no full window, the request is answered with no tab, which
 * makes Firefox open the tab in a new full window instead
 * (`ContentParent::CommonCreateWindow`), and the gate hands that window the
 * agent's workspace before it shows (`onWindowBeforeShow`).
 *
 * A popup a page asks for with window features takes another path, which
 * opens a window from C++ with no JS on the way (`nsWindowWatcher::
 * OpenWindowWithRemoteTab`); the gate hands it the agent's workspace as it
 * opens (`onWindowBeforeShow`).
 *
 * @param {BrowserDOMWindow} asked The `BrowserDOMWindow` asked.
 * @param {nsIURI} uri
 * @param {nsIOpenURIInFrameParams} params
 * @param {number} where
 * @param {number} flags
 * @param {string} name
 * @returns {Element|null|undefined} What the method answers, or undefined
 *   for Firefox's own answer.
 * @throws NS_ERROR_ABORT when the tab can open nowhere.
 */
export function routeNewTab(asked, uri, params, where, flags, name) {
  let route = null;
  try {
    const opener = params?.openerBrowser;
    if (opener && NEW_TAB.has(where)) {
      route = routeOf(opener);
    }
  } catch (err) {
    lazy.SvalLog.warn(
      `the gate could not tell who a new tab is for: ${lazy.SvalLog.errorName(err)}`
    );
  }
  if (!route) {
    // No element makes Firefox open the window it was asked for.
    return where === Ci.nsIBrowserDOMWindow.OPEN_NEWWINDOW ? null : undefined;
  }
  const agentWindow = route.window;
  if (!agentWindow) {
    return null;
  }
  if (
    asked.win === agentWindow &&
    where === Ci.nsIBrowserDOMWindow.OPEN_NEWTAB_BACKGROUND
  ) {
    return undefined;
  }
  // Asked again of the agent's window's own `BrowserDOMWindow`, which opens
  // it there. If that fails, as in a window that is closing, the tab opens as
  // Firefox would open it from the agent's own window. From anywhere else the
  // open fails: a new window would be a second full window for a workspace
  // that has one, which no window may be (main spec §10.7), and so would show
  // a workspace of the user's.
  try {
    const routed = agentWindow.browserDOMWindow.createContentWindowInFrame(
      uri,
      params,
      Ci.nsIBrowserDOMWindow.OPEN_NEWTAB_BACKGROUND,
      flags,
      name
    );
    if (routed) {
      return routed;
    }
  } catch (err) {
    lazy.SvalLog.warn(
      `a new tab could not open in the agent's window: ${lazy.SvalLog.errorName(err)}`
    );
  }
  if (asked.win === agentWindow) {
    return undefined;
  }
  throw Components.Exception("", Cr.NS_ERROR_ABORT);
}

/**
 * Asked first by `URILoadingHelper.openLinkIn`. The tabs the user opens from
 * a link in a page, by a middle or modified click or the context menu, are
 * the chrome's own (`ClickHandlerParent`, `nsContextMenu`), and reach it with
 * the page's `<browser>` as `openerBrowser`, which makes it the new tab's
 * opener (`gBrowser.addTab`). From a popup, Firefox opens the tab in the
 * frontmost full window (`getTargetWindow`), which is usually the user's.
 *
 * A tab opened from an agent's page opens in the background of the agent's
 * own window, asked of `openLinkIn` again, which raises that window. While
 * the agent has no full window, its window opens first and the tab opens
 * there.
 *
 * @param {Window} window The window `openLinkIn` was asked of.
 * @param {string} url
 * @param {string} where
 * @param {object} params `openLinkIn`'s.
 * @returns {boolean} Whether the open was routed, and Firefox's own is
 *   skipped.
 */
export function routeLinkOpen(window, url, where, params) {
  let route = null;
  try {
    const opener = params?.openerBrowser;
    if (opener && LINK_TABS.has(where) && !params[ROUTED]) {
      route = routeOf(opener);
    }
  } catch (err) {
    lazy.SvalLog.warn(
      `the gate could not tell who a link is for: ${lazy.SvalLog.errorName(err)}`
    );
  }
  if (!route) {
    return false;
  }
  const background = { ...params, inBackground: true, [ROUTED]: true };
  if (route.window) {
    lazy.URILoadingHelper.openLinkIn(route.window, url, "tab", background);
    return true;
  }
  route.open().then(
    win => lazy.URILoadingHelper.openLinkIn(win, url, "tab", background),
    err =>
      lazy.SvalLog.warn(
        `a link's tab found no agent window: ${lazy.SvalLog.errorName(err)}`
      )
  );
  return true;
}

/**
 * Asked first by `PdfjsParent._saveURL`, which saves the viewer's PDF with no
 * browsing context on the transfer it makes, so the download guard
 * (`SvalAgentDownloads`) never learns whose save it is. In an agent's tab the
 * save is the agent's saver's, a download like any other.
 *
 * Every gate is asked, and PDF.js saves only when each answered that the tab
 * is no agent's. A saver that throws may have been an agent's, so the save is
 * dropped, and the viewer is told it is over.
 *
 * @param {PdfjsParent} actor
 * @param {{data: {blobUrl: string}}} message
 * @returns {boolean} Whether Sval took the save, and PDF.js's own is skipped.
 */
export function takePdfSave(actor, message) {
  let save = null;
  try {
    for (const gate of openGates()) {
      save = gate.pdfSaver(actor.browser) ?? save;
    }
  } catch (err) {
    lazy.SvalLog.warn(`a PDF save was dropped: ${lazy.SvalLog.errorName(err)}`);
    endPdfSave(message);
    return true;
  }
  if (!save) {
    return false;
  }
  save(actor, message);
  return true;
}

/**
 * Ends a PDF.js save that is not carried out, as PDF.js ends one it carried
 * out (`PdfjsParent._saveURL`'s completion), so the viewer does not wait.
 *
 * @param {{data: {blobUrl: string}}} message
 */
export function endPdfSave(message) {
  const blobUrl = message?.data?.blobUrl;
  if (typeof blobUrl === "string" && blobUrl.startsWith("blob:")) {
    URL.revokeObjectURL(blobUrl);
  }
  Services.obs.notifyObservers(null, "pdfjs:saveComplete");
}

/** What Firefox's patched files ask (`sval-agent-routing.patch`). */
export const SvalAgentRouting = { routeLinkOpen, routeNewTab, takePdfSave };
