/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The Peek (link routing spec §4): a small browser window of its own for one
 * page, in no workspace, which the user reads and closes or opens in a
 * workspace. A link from another app opens one, and so does New Peek, empty,
 * from a window of Sval's. It is a separate thing from a Quick Peek
 * (`SvalQuickPeek`), which shows a link over a tab inside a window.
 *
 * It is a full browser window, so it carries the main window's address bar,
 * keys and titlebar. What sets it apart:
 *
 * - **No workspace.** It runs no panel and no tab observer (`SvalWindow`), so
 *   its page is never written to the tree. A link from another app's page is
 *   in the shared jar, the default one ordinary workspaces use
 *   (`SvalWorkspaceJar`); New Peek's is in the jar of the window it was
 *   opened from, so the page is signed in as that window's workspace
 *   (decision 1995).
 * - **No session.** It is marked unsaved (`sessionstore-unsaved-windows.patch`),
 *   so no restart, crash or Restore Previous Session brings it back, and its
 *   closed page goes with it rather than into another window's undo-close
 *   list. The page stays in browsing history, as every visited page does.
 * - **Never the frontmost window** for Firefox's "open this in the top
 *   window" (`peek-not-top-window.patch`).
 *
 * A tab that opens in it, from a link with `target=_blank`, a Ctrl/Cmd-click
 * or a page's `window.open` without features, is moved into another Peek,
 * so each holds one page. A popup with features is Firefox's own
 * window, so sign-in flows keep their opener.
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { htmlElement } from "moz-src:///browser/components/sval/SvalDom.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalWindowWorkspace:
    "moz-src:///browser/components/sval/SvalWindowWorkspace.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SessionHistory: "resource://gre/modules/sessionstore/SessionHistory.sys.mjs",
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
  SvalDownloadWorkspaces:
    "moz-src:///browser/components/sval/SvalDownloadWorkspaces.sys.mjs",
  SvalEngine: "moz-src:///browser/components/sval/SvalEngine.sys.mjs",
  SvalColor: "moz-src:///browser/components/sval/SvalColor.sys.mjs",
  SvalFirefox: "moz-src:///browser/components/sval/SvalFirefox.sys.mjs",
  SvalLinkDownloads:
    "moz-src:///browser/components/sval/SvalLinkDownloads.sys.mjs",
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  SvalMacWindowOrder:
    "moz-src:///browser/components/sval/SvalMacWindowOrder.sys.mjs",
  SvalTabs: "moz-src:///browser/components/sval/SvalTabs.sys.mjs",
  SvalWorkspaceJar:
    "moz-src:///browser/components/sval/SvalWorkspaceJar.sys.mjs",
  clickText: "moz-src:///browser/components/sval/SvalKeys.sys.mjs",
  displayDomain: "moz-src:///browser/components/sval/SvalHeader.sys.mjs",
  openSvalDialog: "moz-src:///browser/components/sval/SvalDialog.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "model", () =>
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
  )
);

export const ENABLED_PREF = "browser.sval.peek.enabled";
export const IDLE_PREF = "browser.sval.peek.idleCloseMinutes";

/** The idle close times Settings offers, in minutes; 0 is never. */
export const IDLE_CHOICES = Object.freeze([60, 360, 1440, 10080, 0]);

/** What `SvalSettingsSync` lets a synced value of the idle time be. */
export const SYNC_RULES = Object.freeze({
  [IDLE_PREF]: Object.freeze({
    accepts: value => IDLE_CHOICES.includes(value),
  }),
});

/**
 * The root attribute that marks a Peek, which Firefox's
 * `BrowserWindowTracker.getTopWindow` reads too, and the key of the window's
 * extra options that asks for one.
 */
export const PEEK_ATTRIBUTE = "svalpeek";

/**
 * The custom window value that keeps a window out of saved sessions and the
 * recently closed windows (`sessionstore-unsaved-windows.patch`).
 */
export const UNSAVED_KEY = "sval-unsaved";

const STYLESHEET = "chrome://browser/content/sval/sval-peek.css";
const APP_ICON = "chrome://branding/content/about-logo.svg";

/** How far each new Peek opens from the newest one still open. */
const CASCADE_STEP = 28;

/**
 * Where xulStore keeps the size and place of the Peek closed last,
 * apart from the main window's own (`persist`, which {@link
 * SvalPeek.mount} removes).
 */
export const PLACE_STORE = Object.freeze({
  doc: AppConstants.BROWSER_CHROME_URL,
  id: "sval-peek",
});
export const PLACE_KEYS = Object.freeze(["left", "top", "width", "height"]);

const ISOLATED_TEXT =
  "Isolated: sites here can’t see sign-ins from other Workspaces";

/**
 * The Peeks this session opened, oldest first. A closed one leaves
 * at its `unload`.
 *
 * @type {Window[]}
 */
const opened = [];

/**
 * When each Peek last had focus, in milliseconds since the epoch.
 * Wall-clock time, so a computer that slept counts the time it slept: the
 * idle close is about the person's absence, which a sleep is part of.
 *
 * @type {WeakMap<Window, number>}
 */
const lastFocused = new WeakMap();

/**
 * The place each Peek was asked to open at, which the next one
 * cascades from. A window manager may place a new window itself whatever it
 * was asked (mutter cascades new windows from the corner), so the window is
 * moved there once it is shown, and its own `screenX` and `screenY` can lag
 * that move.
 *
 * @type {WeakMap<Window, {left: number, top: number}>}
 */
const asked = new WeakMap();

/** @type {WeakMap<Window, number>} each window's pending idle check. */
const idleTimers = new WeakMap();

/**
 * The pages of the Peeks the user closed, newest last, each as the
 * session store describes a tab (`SessionStore.getTabState`), for Reopen
 * Closed Tab in a Peek ({@link SvalPeek.reopenClosed}). They
 * live in memory alone, since a Peek is in no saved session, and go
 * as Firefox's own closed tabs go when the user clears their history.
 *
 * @type {object[]}
 */
const closedPages = [];

/**
 * Peeks closing because their page went on to a workspace or a
 * download, which the user did not close.
 *
 * @type {WeakSet<Window>}
 */
const handedOff = new WeakSet();

/**
 * The closed page each reopening Peek takes once it has started.
 *
 * @type {WeakMap<Window, object>}
 */
const reopening = new WeakMap();

/**
 * @param {Window} win
 * @returns {boolean} whether `win` is a Peek.
 */
export function isPeek(win) {
  return !!win?.document?.documentElement?.hasAttribute(PEEK_ATTRIBUTE);
}

/**
 * Where the first Peek on a screen opens: 49.5% of the screen's
 * available width, between 792 and 1144 pixels, 73% as tall as it is wide,
 * centred across and 12% of the height down. It keeps within the available
 * area, with 8% of the height below it.
 *
 * @param {{left: number, top: number, width: number, height: number}} area
 *   The screen's available area, in CSS pixels.
 * @returns {{left: number, top: number, width: number, height: number}}
 */
export function firstPlace(area) {
  const width = Math.round(
    Math.min(area.width, 1144, Math.max(792, area.width * 0.495))
  );
  const height = Math.round(Math.min(area.height * 0.8, width * 0.73));
  return {
    left: Math.round(area.left + (area.width - width) / 2),
    top: Math.round(area.top + area.height * 0.12),
    width,
    height,
  };
}

/**
 * @param {{left: number, top: number, width: number, height: number}} place
 * @param {object} area As {@link firstPlace} takes it.
 * @returns {boolean} whether `place` lies wholly within `area`.
 */
function fitsIn(place, area) {
  return (
    place.width > 0 &&
    place.height > 0 &&
    place.left >= area.left &&
    place.top >= area.top &&
    place.left + place.width <= area.left + area.width &&
    place.top + place.height <= area.top + area.height
  );
}

/**
 * Where the next Peek opens: a step down and right of the newest one
 * still open, or at the first place when there is none or the step would
 * cross the screen's available area. The first place is where the Peek
 * closed last was, when that lies within the area, so a Peek the
 * user moved and sized opens there again; otherwise {@link firstPlace}.
 *
 * @param {object} area As {@link firstPlace} takes it.
 * @param {{left: number, top: number}|null} newest
 * @param {object|null} [remembered] As {@link firstPlace} returns it.
 * @returns {{left: number, top: number, width: number, height: number}}
 */
export function nextPlace(area, newest, remembered = null) {
  const first =
    remembered && fitsIn(remembered, area)
      ? { ...remembered }
      : firstPlace(area);
  if (!newest) {
    return first;
  }
  const left = newest.left + CASCADE_STEP;
  const top = newest.top + CASCADE_STEP;
  if (
    left + first.width > area.left + area.width ||
    top + first.height > area.top + area.height
  ) {
    return first;
  }
  return { ...first, left, top };
}

/**
 * How the idle close time reads in the Peek tag's tooltip.
 *
 * @param {number} minutes
 * @returns {string}
 */
export function idleText(minutes) {
  const units = [
    [10080, "week"],
    [1440, "day"],
    [60, "hour"],
    [1, "minute"],
  ];
  for (const [size, unit] of units) {
    if (minutes % size === 0) {
      const count = minutes / size;
      return `${count} ${unit}${count === 1 ? "" : "s"}`;
    }
  }
  return `${minutes} minutes`;
}

/**
 * How a workspace is named on the open button and in its menu: "Home
 * Workspace", or a name that already ends in "Workspace" as it is.
 *
 * @param {string} name
 * @returns {string}
 */
export function workspaceTitle(name) {
  return /workspace$/i.test(name.trim()) ? name : `${name} Workspace`;
}

/**
 * @returns {Window[]} the Peeks open, oldest first.
 */
function openPeeks() {
  return opened.filter(win => !win.closed);
}

/**
 * @returns {Window[]} the user's ordinary windows, frontmost first: full,
 *   non-private browser windows with a workspace panel on the user's tree.
 */
function normalWindows() {
  return lazy.BrowserWindowTracker.getOrderedWindows({ private: false }).filter(
    win =>
      !win.closed &&
      win.toolbar.visible &&
      !isPeek(win) &&
      !lazy.PrivateBrowsingUtils.isWindowPrivate(win) &&
      win.SvalPanel &&
      // A WebDriver window shows a tree in memory, not the user's.
      !win.SvalPanel.inMemory
  );
}

/**
 * The available area of the screen a Peek opens on, in CSS pixels:
 * the screen of the newest Peek, or of the window the user used
 * last, which is where they are looking.
 *
 * @param {Window|null} near
 * @returns {{left: number, top: number, width: number, height: number}}
 */
function availableArea(near) {
  const { screen } =
    near ??
    Services.wm.getMostRecentWindow("navigator:browser") ??
    Services.appShell.hiddenDOMWindow;
  return {
    left: screen.availLeft,
    top: screen.availTop,
    width: screen.availWidth,
    height: screen.availHeight,
  };
}

/**
 * @returns {object|null} the size and place of the Peek closed
 *   last, as {@link firstPlace} returns one, or null when none is kept.
 */
function rememberedPlace() {
  const { doc, id } = PLACE_STORE;
  const place = {};
  for (const key of PLACE_KEYS) {
    const value = parseInt(Services.xulStore.getValue(doc, id, key), 10);
    if (!Number.isFinite(value)) {
      return null;
    }
    place[key] = value;
  }
  return place;
}

/**
 * Keeps `win`'s size and place for the next Peek to open at, in
 * the units the window's `screenX`, `screenY`, `width` and `height`
 * attributes take (`AppWindow::SavePersistentAttributes`): CSS pixels, its
 * size inside the frame. A full-screen or minimized window's would be
 * no place to open at, so neither is kept.
 *
 * @param {Window} win A Peek.
 */
function rememberPlace(win) {
  if (win.windowState !== win.STATE_NORMAL) {
    return;
  }
  const { doc, id } = PLACE_STORE;
  const place = {
    left: win.screenX,
    top: win.screenY,
    width: win.innerWidth,
    height: win.innerHeight,
  };
  for (const key of PLACE_KEYS) {
    Services.xulStore.setValue(doc, id, key, String(Math.round(place[key])));
  }
}

/**
 * `SSWindowClosing`, while the session store still tracks the window: keeps
 * its page for Reopen Closed Tab, as Firefox keeps a closed tab
 * (`browser.sessionstore.max_tabs_undo` of them). A page never left the new
 * tab page is nothing to reopen.
 *
 * @param {Window} win A Peek.
 */
function keepClosedPage(win) {
  const tab = win.gBrowser.selectedTab;
  if (
    handedOff.has(win) ||
    !tab?.linkedBrowser ||
    (win.isBlankPageURL(tab.linkedBrowser.currentURI.spec) &&
      lazy.SvalFirefox.hasNoHistory(tab))
  ) {
    return;
  }
  // The session store's copy of the history catches up on a timer
  // (`SHistoryListener.collectFrom`), so the history is read from the
  // parent's own, as that listener reads it.
  const state = JSON.parse(lazy.SessionStore.getTabState(tab));
  const context = tab.linkedBrowser.browsingContext;
  const { entries, index } = lazy.SessionHistory.collectFromParent(
    context.currentURI?.spec,
    true,
    context.sessionHistory
  );
  closedPages.push({ ...state, entries, index });
  const max = Services.prefs.getIntPref("browser.sessionstore.max_tabs_undo");
  closedPages.splice(0, Math.max(0, closedPages.length - max));
}

/**
 * Drops the closed pages that `keep` answers false for.
 *
 * @param {function(object): boolean} keep
 */
function filterClosedPages(keep) {
  const kept = closedPages.filter(keep);
  closedPages.splice(0, closedPages.length, ...kept);
}

/**
 * Opens a Peek, in front and focused, for a page from another app,
 * a tab a Peek's page opened, or New Peek's page.
 *
 * @param {object} what
 * @param {nsIURI} [what.uri] The page to load, none for a reopened page.
 * @param {nsIPrincipal} [what.triggeringPrincipal]
 * @param {Element} [what.tab] A tab to move into the new window as it is.
 * @param {number} [what.userContextId] The jar `uri` loads in, the shared
 *   one unless given.
 * @param {boolean} [what.fromExternal] Whether `uri` is a link from another
 *   app, which Firefox loads as one (`gBrowserInit._handleURIToLoad`).
 * @returns {Window}
 */
function openPeek({
  uri,
  triggeringPrincipal,
  tab,
  userContextId = Services.scriptSecurityManager.DEFAULT_USER_CONTEXT_ID,
  fromExternal = !tab,
}) {
  const all = openPeeks();
  const newest = all.at(-1) ?? null;
  const place = nextPlace(
    availableArea(newest),
    newest && asked.get(newest),
    rememberedPlace()
  );
  const options = Cc["@mozilla.org/hash-property-bag;1"].createInstance(
    Ci.nsIWritablePropertyBag2
  );
  options.setPropertyAsBool(PEEK_ATTRIBUTE, true);
  options.setPropertyAsBool("fromExternal", fromExternal);
  for (const [key, value] of Object.entries(place)) {
    options.setPropertyAsInt32(`${PEEK_ATTRIBUTE}.${key}`, value);
  }
  const args = Cc["@mozilla.org/array;1"].createInstance(Ci.nsIMutableArray);
  if (tab) {
    args.appendElement(tab);
    args.appendElement(options);
  } else {
    // With no page, the window loads none (`gBrowserInit.uriToLoadPromise`),
    // so nothing lands over the session store's restore of a reopened page.
    let url = null;
    if (uri) {
      url = Cc["@mozilla.org/supports-string;1"].createInstance(
        Ci.nsISupportsString
      );
      url.data = uri.spec;
    }
    const jar = Cc["@mozilla.org/supports-PRUint32;1"].createInstance(
      Ci.nsISupportsPRUint32
    );
    jar.data = userContextId;
    for (const arg of [url, options, null, null, null, jar, null, null]) {
      args.appendElement(arg);
    }
    args.appendElement(
      triggeringPrincipal ?? Services.scriptSecurityManager.getSystemPrincipal()
    );
  }
  const win = lazy.BrowserWindowTracker.openWindow({ args, private: false });
  opened.push(win);
  asked.set(win, place);
  lastFocused.set(win, SvalPeek._now());
  return win;
}

/**
 * The workspaces a page from another app can go to, in the tree `nodes`:
 * every workspace but an agent's, which the user never sends a page to
 * (agent-control spec §6), in the switcher's order. A Peek's open
 * button and menu offer these, and link routing's rules name them.
 *
 * @param {object} nodes The document's nodes, by id.
 * @returns {object[]} `{ id, name, color, emoji, isolated }`.
 */
export function destinationChoices(nodes) {
  return lazy.model
    .switcherItems(nodes, null)
    .filter(item => item.agent === null)
    .map(({ id, name, color, emoji }) => ({
      id,
      name: name || "Untitled Workspace",
      color,
      emoji,
      isolated: lazy.SvalWorkspaceJar.isIsolated(nodes, id),
    }));
}

/**
 * The workspaces a Peek's page can go to, read from the tree afresh
 * ({@link destinationChoices}), with the default first: the workspace of the
 * ordinary window the user used last that shows one of them.
 *
 * @returns {Promise<{nodes: object, choices: object[]}|null>} `choices` as
 *   {@link destinationChoices} gives them, or null before any window has
 *   started the engine.
 */
async function destinations() {
  const windows = normalWindows();
  await Promise.all(windows.map(win => win.SvalPanel.started));
  // The engine every window of the profile shares (`SvalEngine.forProfile`).
  const engine = windows[0]?.SvalPanel.engine ?? lazy.SvalEngine.sharedInstance;
  if (!engine) {
    return null;
  }
  const nodes = (await engine.tree()).nodes ?? {};
  const { currentWorkspace } = lazy.model;
  const choices = destinationChoices(nodes);
  const ids = choices.map(choice => choice.id);
  const first =
    windows
      .map(win => lazy.SvalWindowWorkspace.of(win).id)
      .find(id => ids.includes(id)) ?? currentWorkspace(nodes, null);
  choices.sort((a, b) => (b.id === first) - (a.id === first));
  return { nodes, choices };
}

/**
 * Opens an ordinary window and waits for its panel to start.
 *
 * @param {(win: Window) => void} [prepare] Called on the window before its
 *   delayed startup.
 * @returns {Promise<Window>}
 */
export async function openNormalWindow(prepare) {
  const win = lazy.BrowserWindowTracker.openWindow({ private: false });
  prepare?.(win);
  await new Promise(resolve => {
    const started = subject => {
      if (subject === win) {
        Services.obs.removeObserver(
          started,
          "browser-delayed-startup-finished"
        );
        resolve();
      }
    };
    Services.obs.addObserver(started, "browser-delayed-startup-finished");
  });
  await win.SvalPanel.started;
  return win;
}

/**
 * Brings `workspaceId` to the screen: in the window that shows it, or in the
 * frontmost ordinary window, which switches to it, through the panel's own
 * switch. With `newWindow`, or with no ordinary window open but an agent's,
 * a new one opens on it.
 *
 * @param {string} workspaceId
 * @param {object} nodes The document's nodes, by id.
 * @param {object} [options]
 * @param {boolean} [options.newWindow] Whether a window that shows another
 *   workspace stays as it is.
 * @returns {Promise<Window|null>} the window, or null when the workspace is
 *   gone.
 */
async function showWorkspace(workspaceId, nodes, { newWindow = false } = {}) {
  const windows = normalWindows();
  let target =
    windows.find(win => lazy.SvalWindowWorkspace.of(win).id === workspaceId) ??
    (newWindow
      ? null
      : // Never a window showing an agent's workspace: the user is watching it.
        windows.find(
          win =>
            lazy.model.agentLabelOf(
              nodes,
              lazy.SvalWindowWorkspace.of(win).id
            ) === null
        ));
  if (!target) {
    target = await openNormalWindow(win =>
      lazy.model.handWorkspaceTo(win, workspaceId)
    );
  }
  if (
    lazy.SvalWindowWorkspace.of(target).id !== workspaceId &&
    !(await target.SvalPanel.switchTo(workspaceId))
  ) {
    return null;
  }
  target.focus();
  lazy.SvalMacWindowOrder.bringForward(target);
  return target;
}

/**
 * @param {nsIURI} uri
 * @returns {boolean} Whether `uri` is a web page's address, the only kind a
 *   link from another app opens in Sval's own way (`destinationFor`).
 */
function isWebAddress(uri) {
  return uri.schemeIs("https") || uri.schemeIs("http");
}

/**
 * Opens `uri` as a new tab in the window `showWorkspace` brought to the
 * screen, in the jar of the workspace it shows (`SvalWorkspaceJar`), as a
 * link from another app opens there: with the system principal, as Firefox
 * opens one (`handURIToExistingBrowser`). That principal may load any
 * address, so only a web page's opens here.
 *
 * @param {Window} target
 * @param {nsIURI} uri
 * @returns {boolean} Whether it opened.
 */
function openAsNewTab(target, uri) {
  if (!isWebAddress(uri)) {
    return false;
  }
  lazy.SvalLinkDownloads.opened(
    target.browserDOMWindow.openURI(
      uri,
      null,
      Ci.nsIBrowserDOMWindow.OPEN_NEWTAB,
      Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL,
      Services.scriptSecurityManager.getSystemPrincipal()
    )
  );
  return true;
}

/**
 * Opens a page from another app in the first of `workspaceIds` that is still
 * a destination ({@link destinationChoices}), as a new tab in its jar from
 * the start, in the window showing it or the frontmost one switched to it.
 * A workspace that was deleted, or that a link may not open in, is passed
 * over (link routing spec §2).
 *
 * @param {nsIURI} uri
 * @param {string[]} workspaceIds In the order to try them.
 * @returns {Promise<boolean>} whether it opened, false when none of them is
 *   a destination.
 */
async function openInFirstWorkspace(uri, workspaceIds) {
  const found = await destinations();
  const ids = new Set(found?.choices.map(choice => choice.id));
  const workspaceId = workspaceIds.find(id => ids.has(id));
  if (!workspaceId) {
    return false;
  }
  const target = await showWorkspace(workspaceId, found.nodes);
  if (!target) {
    return false;
  }
  return openAsNewTab(target, uri);
}

/**
 * @param {Element} tab A Peek's tab.
 * @returns {nsIURI|null} The web address of a page its load never showed,
 *   or null for a page it shows. Until its first load commits, the tab holds
 *   the initial `about:blank` with no history and the address as if typed
 *   (`window-first-page-kept-as-typed.patch`), and a load stopped or refused
 *   leaves it so; a load that failed shows an error page at the address it
 *   was for (`nsDocShell::DisplayLoadError`). A tab still busy with its
 *   first load counts as unshown as well: busy ends when the page's process
 *   reports the stop, which comes after the parent has already cancelled a
 *   load it started itself (`AttemptSpeculativeLoadInParent`), so the tab
 *   moved as it is would carry a load that never commits. A page with an
 *   opener is left as it is, as Firefox leaves one (`checkEmptyPageOrigin`):
 *   its opener can write into its blank page. The typed value is whatever
 *   the address bar holds, which the user can edit, so only a web address
 *   counts ({@link openAsNewTab}).
 */
function unshownAddress(tab) {
  const browser = tab.linkedBrowser;
  let uri = null;
  if (
    browser.currentURI.spec === "about:blank" &&
    lazy.SvalFirefox.hasNoHistory(tab) &&
    !browser.hasContentOpener
  ) {
    try {
      uri = browser.userTypedValue
        ? Services.io.newURI(browser.userTypedValue)
        : null;
    } catch {}
  } else if (
    browser.documentURI?.schemeIs("about") &&
    !browser.currentURI.schemeIs("about")
  ) {
    uri = browser.currentURI;
  }
  return uri && isWebAddress(uri) ? uri : null;
}

/**
 * The principal a Peek's page opens again with in another jar, as
 * Firefox's Reopen in Container opens a tab (`TabContextMenu.reopenInContainer`):
 * the page's own principal, a content one moved to the jar, or a new null
 * principal for a null one. A privileged page keeps the system principal,
 * the only one that may load it.
 *
 * @param {Element} tab A Peek's tab.
 * @param {number} userContextId The jar it opens in.
 * @returns {nsIPrincipal}
 */
function reopeningPrincipal(tab, userContextId) {
  const principal = tab.linkedBrowser.contentPrincipal;
  if (principal.isContentPrincipal) {
    return Services.scriptSecurityManager.principalWithOA(principal, {
      userContextId,
    });
  }
  if (principal.isSystemPrincipal) {
    return principal;
  }
  return Services.scriptSecurityManager.createNullPrincipal({ userContextId });
}

/**
 * @param {Element} tab A Peek's tab.
 * @returns {boolean} Whether its page's principal may load its address
 *   again ({@link reopeningPrincipal}), the check Firefox's context menu makes
 *   before it opens an address the user chose (`urlSecurityCheck`).
 */
function mayReopen(tab) {
  try {
    Services.scriptSecurityManager.checkLoadURIWithPrincipal(
      reopeningPrincipal(tab, 0),
      tab.linkedBrowser.currentURI,
      Ci.nsIScriptSecurityManager.STANDARD
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * The `TabOpen` detail key that marks a Peek's page opened again in
 * a workspace, which `SvalTabs` reads as a tab from outside every workspace.
 */
export const REOPENED_DETAIL = "svalReopenedFromPeek";

/**
 * Opens a Peek's page again as the selected tab of `target`, in the
 * jar of the workspace it shows, at the address it shows: Reader View's
 * address names the page it reads, so the page opens in Reader View. A
 * `data:` address opens too, as the context menu's Open Image in New Tab
 * allows one the user chose (`forceAllowDataURI`).
 *
 * @param {Window} target
 * @param {Element} tab A Peek's tab.
 */
function reopenIn(target, tab) {
  const userContextId = target.gBrowser.defaultUserContextId;
  const reopened = target.gBrowser.addTab(tab.linkedBrowser.currentURI.spec, {
    userContextId,
    triggeringPrincipal: reopeningPrincipal(tab, userContextId),
    forceAllowDataURI: true,
    inBackground: false,
    eventDetail: { [REOPENED_DETAIL]: true },
  });
  target.gBrowser.selectedTab = reopened;
}

/**
 * Opens a Peek's page in a workspace, then closes the Peek.
 * A workspace whose jar is the page's takes the page as it is, moved with no
 * reload. Any other opens its address again in its own jar, after the user
 * agrees to the reload ({@link reopenIn}): an isolated workspace for a page
 * in the shared jar, or any other workspace for a New Peek page opened in an
 * isolated one's jar. A page whose load never showed it
 * ({@link unshownAddress}) opens again in any workspace, the way a link from
 * another app opens there, since moving it would move the blank or error
 * page in its place. Every way, the window's tab observer files it at the end
 * of the workspace's own list, in no group (`SvalTabs` `isFromOutside`).
 *
 * @param {Window} win A Peek.
 * @param {string} workspaceId
 * @param {object} [options]
 * @param {boolean} [options.newWindow] Whether the workspace opens in a new
 *   window when no window shows it ({@link showWorkspace}).
 * @returns {Promise<void>}
 */
async function openInWorkspace(win, workspaceId, { newWindow = false } = {}) {
  const found = await destinations();
  const choice = found?.choices.find(item => item.id === workspaceId);
  if (!choice || win.closed) {
    renderOpenButton(win);
    return;
  }
  const tab = win.gBrowser.selectedTab;
  const unshown = unshownAddress(tab);
  const reload =
    tab.userContextId !==
    lazy.SvalWorkspaceJar.userContextIdFor(found.nodes, workspaceId);
  if (reload) {
    const title = workspaceTitle(choice.name);
    const why = choice.isolated
      ? `${title} is isolated`
      : "This Peek is signed in as another Workspace";
    if (!unshown && !mayReopen(tab)) {
      await lazy.openSvalDialog(win, {
        title: `This page can't open in ${title}`,
        body: `${why}, so the page would have to load again in ${title}, and this page can't be loaded that way.`,
        primary: "OK",
        secondary: null,
      });
      return;
    }
    const answer = await lazy.openSvalDialog(win, {
      title: `Open in ${title}?`,
      body: `${why}, so this page reloads with ${title}'s sign-ins, and you may need to sign in again. The page loses its back history and anything typed into it.`,
      primary: "Open",
    });
    if (!answer.ok || win.closed) {
      return;
    }
  }
  const target = await showWorkspace(workspaceId, found.nodes, { newWindow });
  if (!target || win.closed) {
    return;
  }
  if (unshown) {
    if (openAsNewTab(target, unshown)) {
      handedOff.add(win);
      win.close();
    }
  } else if (reload) {
    reopenIn(target, tab);
    handedOff.add(win);
    win.close();
  } else {
    // The Peek closes with its last tab.
    handedOff.add(win);
    target.gBrowser.adoptTab(tab, { selectTab: true });
  }
}

/**
 * A workspace's tile, as the panel's switcher draws it: its emoji, or the
 * workspace glyph, on its colour.
 *
 * @param {Document} doc
 * @param {object} choice From {@link destinations}.
 * @returns {Element}
 */
function tile(doc, choice) {
  const el = htmlElement(doc, "span", { className: "sval-peek-tile" });
  el.setAttribute("aria-hidden", "true");
  if (choice.emoji) {
    el.textContent = choice.emoji;
  }
  if (choice.color) {
    el.style.setProperty("--sval-tile", lazy.SvalColor.markOf(choice.color));
  }
  return el;
}

/**
 * Draws the open button for the default destination, read afresh: a Peek
 * is used after a look at another window, which may have changed
 * which workspace the user is in.
 *
 * @param {Window} win A Peek.
 * @returns {Promise<void>}
 */
async function renderOpenButton(win) {
  const doc = win.document;
  const group = doc.getElementById("sval-peek-open");
  if (!group) {
    return;
  }
  let found = null;
  try {
    found = await destinations();
  } catch (err) {
    lazy.SvalLog.warn(
      `could not read the workspaces: ${lazy.SvalLog.errorName(err)}`
    );
  }
  if (win.closed) {
    return;
  }
  const choice = found?.choices[0];
  group.hidden = !choice;
  if (!choice) {
    return;
  }
  const main = doc.getElementById("sval-peek-open-main");
  const title = workspaceTitle(choice.name);
  main.dataset.workspace = choice.id;
  main.title = `Open in ${title}`;
  // The words around the name give way in a narrow window
  // (`sval-peek.css`); the whole sentence stays its name.
  main.setAttribute("aria-label", `Open in ${title}`);
  main.textContent = "";
  const lead = htmlElement(doc, "span", { className: "sval-peek-open-lead" });
  lead.textContent = "Open in";
  const name = htmlElement(doc, "span", { className: "sval-peek-open-name" });
  name.textContent = choice.name;
  main.append(tile(doc, choice), lead, name);
  if (title !== choice.name) {
    const tail = htmlElement(doc, "span", {
      className: "sval-peek-open-tail",
    });
    tail.textContent = "Workspace";
    main.append(tail);
  }
  if (choice.isolated) {
    main.append(htmlElement(doc, "span", { className: "sval-peek-isolated" }));
  }
  doc.getElementById("sval-peek-open-more").hidden = found.choices.length < 2;
}

/**
 * Fills and opens the menu of the other workspaces.
 *
 * @param {Window} win A Peek.
 * @returns {Promise<void>}
 */
async function openWorkspaceMenu(win) {
  const doc = win.document;
  const panel = doc.getElementById("sval-peek-menu");
  const anchor = doc.getElementById("sval-peek-open");
  const found = await destinations();
  if (win.closed || !found) {
    return;
  }
  const list = panel.querySelector(".sval-peek-menu-list");
  list.textContent = "";
  const open = (choice, newWindow) => {
    panel.hidePopup();
    openInWorkspace(win, choice.id, { newWindow }).catch(err =>
      lazy.SvalLog.error(
        `could not open the page in a workspace: ${lazy.SvalLog.errorName(err)}`
      )
    );
  };
  for (const choice of found.choices.slice(1)) {
    const item = htmlElement(doc, "div", {
      className: "sval-peek-menu-item",
    });
    const row = htmlElement(doc, "button", {
      className: "sval-peek-menu-row",
    });
    row.type = "button";
    if (choice.isolated) {
      row.title = ISOLATED_TEXT;
    }
    const text = htmlElement(doc, "span", {
      className: "sval-peek-menu-text",
    });
    const label = htmlElement(doc, "span", {
      className: "sval-peek-menu-label",
    });
    label.textContent = `Open in ${workspaceTitle(choice.name)}`;
    text.append(label);
    if (choice.isolated) {
      const hint = htmlElement(doc, "span", {
        className: "sval-peek-menu-hint",
      });
      hint.textContent = "Isolated. You may need to sign in again.";
      text.append(hint);
    }
    row.append(tile(doc, choice), text);
    if (choice.isolated) {
      row.append(htmlElement(doc, "span", { className: "sval-peek-isolated" }));
    }
    row.addEventListener("click", event => open(choice, event.shiftKey));
    const inWindow = htmlElement(doc, "button", {
      className: "sval-peek-menu-window",
    });
    inWindow.type = "button";
    // The row's Shift-click does the same.
    inWindow.title = `Open in New Window (${lazy.clickText("shift")})`;
    inWindow.setAttribute(
      "aria-label",
      `Open in ${workspaceTitle(choice.name)} in a new window`
    );
    inWindow.addEventListener("click", () => open(choice, true));
    item.append(row, inWindow);
    list.append(item);
  }
  panel.openPopup(anchor, { position: "bottomright topright", y: 4 });
}

/**
 * When a Peek was last used, as its switcher row says it.
 *
 * @param {number} ms Milliseconds since the epoch.
 * @param {number} now
 * @returns {string}
 */
export function lastUsedText(ms, now) {
  const minutes = Math.floor((now - ms) / 60000);
  if (minutes < 1) {
    return "now";
  }
  const format = new Services.intl.RelativeTimeFormat(undefined, {
    style: "short",
  });
  if (minutes < 60) {
    return format.format(-minutes, "minute");
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return format.format(-hours, "hour");
  }
  return format.format(-Math.floor(hours / 24), "day");
}

/**
 * Fills and opens the switcher: every Peek, in the order they
 * opened, which is the order they cascade in. A row keeps its place while
 * the user moves between them, so the list never reorders under the
 * pointer.
 *
 * @param {Window} win The Peek whose tag was pressed.
 * @param {object} [options]
 * @param {boolean} [options.byKey] Whether a key pressed the tag.
 */
function openSwitcher(win, { byKey = false } = {}) {
  const doc = win.document;
  const panel = doc.getElementById("sval-peek-switcher");

  const now = SvalPeek._now();
  const all = openPeeks();
  const count = panel.querySelector(".sval-peek-switcher-count");
  count.textContent = String(all.length);
  const list = panel.querySelector(".sval-peek-switcher-list");
  list.textContent = "";
  for (const other of all) {
    const tab = other.gBrowser.selectedTab;
    const row = htmlElement(doc, "div", {
      className: "sval-peek-switcher-row",
    });
    row.setAttribute("role", "listitem");
    row.toggleAttribute("current", other === win);
    const go = htmlElement(doc, "button", {
      className: "sval-peek-switcher-go",
    });
    go.type = "button";
    if (other === win) {
      go.setAttribute("aria-current", "true");
    }
    const icon = htmlElement(doc, "img", {
      className: "sval-peek-switcher-icon",
    });
    icon.alt = "";
    icon.src =
      other.gBrowser.getIcon(tab) ||
      "chrome://global/skin/icons/defaultFavicon.svg";
    const text = htmlElement(doc, "span", {
      className: "sval-peek-menu-text",
    });
    const title = htmlElement(doc, "span", {
      className: "sval-peek-menu-label",
    });
    title.textContent = tab.label;
    const sub = htmlElement(doc, "span", { className: "sval-peek-menu-hint" });
    const domain =
      lazy.displayDomain(tab.linkedBrowser.currentURI) ||
      tab.linkedBrowser.currentURI.spec;
    sub.textContent = `${domain} · ${lastUsedText(
      other === win ? now : (lastFocused.get(other) ?? now),
      now
    )}`;
    text.append(title, sub);
    go.append(icon, text);
    go.addEventListener("click", () => {
      panel.hidePopup();
      other.focus();
    });
    const close = htmlElement(doc, "button", {
      className: "sval-peek-switcher-close",
    });
    close.type = "button";
    close.title = "Close";
    close.setAttribute("aria-label", `Close ${tab.label}`);
    close.addEventListener("click", () => {
      other.close();
      row.remove();
      const left = list.children.length;
      count.textContent = String(left);
      // One left is this window alone, with nothing to switch to.
      if (other === win || left < 2) {
        panel.hidePopup();
      }
    });
    row.append(go, close);
    list.append(row);
  }
  // Opened from the keyboard, focus goes to the first row, as a menu's does;
  // a click leaves it where it was.
  if (byKey) {
    const focusIn = () => doc.commandDispatcher.advanceFocusIntoSubtree(panel);
    panel.addEventListener("popupshown", focusIn, { once: true });
    panel.addEventListener(
      "popuphidden",
      () => panel.removeEventListener("popupshown", focusIn),
      { once: true }
    );
  }
  panel.openPopup(doc.getElementById("sval-peek-tag"), {
    position: "bottomleft topleft",
    y: 4,
  });
}

/**
 * Draws every Peek's tag with the count of Peeks open, which
 * changes as one opens or closes.
 */
function renderTags() {
  const all = openPeeks();
  const minutes = Services.prefs.getIntPref(IDLE_PREF, 360);
  const tip = minutes
    ? `This Peek isn't in a Workspace. It closes if you don't use it for ${idleText(minutes)}.`
    : "This Peek isn't in a Workspace.";
  for (const win of all) {
    const tag = win.document.getElementById("sval-peek-tag");
    if (!tag) {
      continue;
    }
    tag.querySelector(".sval-peek-count").textContent = String(all.length);
    const several = all.length > 1;
    tag.toggleAttribute("several", several);
    tag.setAttribute("aria-disabled", String(!several));
    tag.tabIndex = several ? 0 : -1;
    tag.title = tip;
  }
}

/**
 * Closes `win` once it has gone the idle close time without focus, checking
 * again when the time is up. A window that has focus is not idle. A timer
 * may not count a computer's sleep, so each wake checks again too
 * ({@link SvalPeek.init}).
 *
 * @param {Window} win A Peek.
 */
function checkIdle(win) {
  win.clearTimeout(idleTimers.get(win));
  idleTimers.delete(win);
  const minutes = Services.prefs.getIntPref(IDLE_PREF, 360);
  const since = lastFocused.get(win);
  if (win.closed || !minutes || since === undefined) {
    return;
  }
  const left = since + minutes * 60000 - SvalPeek._now();
  if (left <= 0) {
    win.close();
    return;
  }
  // `setTimeout` holds at most a signed 32-bit delay.
  idleTimers.set(
    win,
    win.setTimeout(() => checkIdle(win), Math.min(left, 2 ** 31 - 1))
  );
}

function checkAllIdle() {
  for (const win of openPeeks()) {
    checkIdle(win);
  }
}

/**
 * Builds the Peek's own parts of the header: the Peek tag before
 * the address bar, the open button after it, and their popups.
 *
 * @param {Window} win A Peek.
 */
function buildHeader(win) {
  const doc = win.document;
  const navbar = doc.getElementById("nav-bar");
  const target = doc.getElementById("nav-bar-customization-target");

  const tag = htmlElement(doc, "button", { id: "sval-peek-tag" });
  tag.type = "button";
  tag.setAttribute("aria-haspopup", "dialog");
  const icon = htmlElement(doc, "img", { className: "sval-peek-app-icon" });
  icon.alt = "";
  icon.src = APP_ICON;
  const word = htmlElement(doc, "span");
  word.textContent = "Peek";
  const count = htmlElement(doc, "span", { className: "sval-peek-count" });
  const chevron = htmlElement(doc, "span", { className: "sval-peek-chevron" });
  tag.append(icon, word, count, chevron);
  tag.addEventListener("click", event => {
    if (tag.hasAttribute("several")) {
      openSwitcher(win, {
        byKey: event.inputSource === win.MouseEvent.MOZ_SOURCE_KEYBOARD,
      });
    }
  });
  navbar.insertBefore(tag, target);

  const group = htmlElement(doc, "div", { id: "sval-peek-open" });
  group.hidden = true;
  const main = htmlElement(doc, "button", { id: "sval-peek-open-main" });
  main.type = "button";
  main.addEventListener("click", event =>
    openInWorkspace(win, main.dataset.workspace, {
      newWindow: event.shiftKey,
    }).catch(err =>
      lazy.SvalLog.error(
        `could not open the page in a workspace: ${lazy.SvalLog.errorName(err)}`
      )
    )
  );
  const divider = htmlElement(doc, "span", {
    className: "sval-peek-open-divider",
  });
  const more = htmlElement(doc, "button", { id: "sval-peek-open-more" });
  more.type = "button";
  more.setAttribute("aria-label", "Open in another Workspace");
  more.setAttribute("aria-haspopup", "menu");
  more.addEventListener("click", () =>
    openWorkspaceMenu(win).catch(err =>
      lazy.SvalLog.warn(
        `could not list the workspaces: ${lazy.SvalLog.errorName(err)}`
      )
    )
  );
  group.append(main, divider, more);
  target.after(group);

  const popups = doc.getElementById("mainPopupSet");
  const menu = doc.createXULElement("panel");
  menu.id = "sval-peek-menu";
  menu.className = "sval-peek-popup";
  menu.setAttribute("type", "arrow");
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", "Open in another Workspace");
  menu.append(htmlElement(doc, "div", { className: "sval-peek-menu-list" }));
  menu.addEventListener("popupshown", () => {
    more.setAttribute("open", "true");
    doc.commandDispatcher.advanceFocusIntoSubtree(menu);
  });
  menu.addEventListener("popuphidden", () => more.removeAttribute("open"));

  const switcher = doc.createXULElement("panel");
  switcher.id = "sval-peek-switcher";
  switcher.className = "sval-peek-popup";
  switcher.setAttribute("type", "arrow");
  switcher.setAttribute("role", "dialog");
  switcher.setAttribute("aria-label", "Peeks");
  const header = htmlElement(doc, "div", {
    className: "sval-peek-switcher-header",
  });
  const heading = htmlElement(doc, "span", {
    className: "sval-peek-switcher-heading",
  });
  heading.textContent = "Peeks";
  header.append(
    heading,
    htmlElement(doc, "span", { className: "sval-peek-switcher-count" })
  );
  const rows = htmlElement(doc, "div", {
    className: "sval-peek-switcher-list",
  });
  rows.setAttribute("role", "list");
  const closeAll = htmlElement(doc, "button", {
    className: "sval-peek-switcher-close-all",
  });
  closeAll.type = "button";
  closeAll.textContent = "Close all Peeks";
  closeAll.addEventListener("click", () => {
    switcher.hidePopup();
    SvalPeek.closeAll();
  });
  // A panel lays its content out in a row unless it is vertical.
  switcher.setAttribute("orient", "vertical");
  const footer = htmlElement(doc, "div", {
    className: "sval-peek-switcher-footer",
  });
  footer.append(closeAll);
  switcher.append(header, rows, footer);
  switcher.addEventListener("popupshown", () => {
    tag.setAttribute("open", "true");
  });
  switcher.addEventListener("popuphidden", () => tag.removeAttribute("open"));
  popups.append(menu, switcher);
}

let initialized = false;

export const SvalPeek = {
  ENABLED_PREF,
  IDLE_PREF,
  IDLE_CHOICES,
  isPeek,
  destinationChoices,
  openInFirstWorkspace,

  /**
   * The clock idle closes are timed by, which a test of a computer's sleep
   * moves.
   *
   * @returns {number}
   */
  _now() {
    return Date.now();
  },

  /**
   * Once a session: re-checks every Peek's idle time when the
   * computer wakes or the setting changes.
   */
  init() {
    if (initialized) {
      return;
    }
    initialized = true;
    Services.obs.addObserver(checkAllIdle, "wake_notification");
    // "domwindowclosed" comes as the window is unregistered, before its
    // widget hides (`AppWindow::Destroy`), while it is still the key window.
    Services.obs.addObserver(win => {
      if (!isPeek(win)) {
        return;
      }
      rememberPlace(win);
      if (Services.focus.activeWindow === win) {
        lazy.SvalMacWindowOrder.passActivationBehind();
      }
    }, "domwindowclosed");
    Services.prefs.addObserver(IDLE_PREF, () => {
      renderTags();
      checkAllIdle();
    });
    // What clearing history removes from Firefox's closed tabs
    // (`SessionStoreInternal.observe`).
    Services.obs.addObserver(
      () => filterClosedPages(() => false),
      "browser:purge-session-history"
    );
    Services.obs.addObserver((subject, topic, domain) => {
      filterClosedPages(
        state =>
          !state.entries.some(entry => {
            try {
              return Services.eTLD.hasRootDomain(
                Services.io.newURI(entry.url).host,
                domain
              );
            } catch {
              return false;
            }
          })
      );
    }, "browser:purge-session-history-for-domain");
    Services.obs.addObserver((subject, topic, data) => {
      let userContextId = 0;
      try {
        userContextId = JSON.parse(data).userContextId ?? 0;
      } catch {}
      if (userContextId) {
        filterClosedPages(state => state.userContextId !== userContextId);
      }
    }, "clear-origin-attributes-data");
  },

  /**
   * Reopen Closed Tab in a Peek: the Peek the user closed
   * last opens again, with its page's history, in its jar.
   *
   * @param {Window} win The window the key was pressed in.
   * @returns {boolean} Whether a Peek reopened, false for a window
   *   of another kind or with none closed.
   */
  reopenClosed(win) {
    if (!isPeek(win) || !closedPages.length) {
      return false;
    }
    const state = closedPages.pop();
    const reopened = openPeek({
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      userContextId: state.userContextId ?? 0,
      fromExternal: false,
    });
    reopening.set(reopened, state);
    return true;
  },

  /**
   * Opens a page from another app in a Peek of its own.
   *
   * @param {nsIURI} uri
   * @param {object} [options]
   * @param {nsIPrincipal} [options.triggeringPrincipal]
   * @returns {Window}
   */
  open(uri, { triggeringPrincipal } = {}) {
    this.init();
    return openPeek({ uri, triggeringPrincipal });
  },

  /**
   * New Peek: an empty Peek on the page a new tab opens, whose
   * address bar Firefox focuses for it (`gBrowserInit._setInitialFocus`),
   * in the jar of `win`, the window it was asked for in. That is the jar
   * new tabs there take (`gBrowser.defaultUserContextId`): the workspace's,
   * or a Peek's own. A private window's jar belongs to its private
   * session (`SvalPrivateJars`), and a Peek is never private, so one
   * opened from a private window takes the shared jar.
   *
   * @param {Window} win A browser window.
   * @returns {Window}
   */
  openEmpty(win) {
    this.init();
    const shared = Services.scriptSecurityManager.DEFAULT_USER_CONTEXT_ID;
    return openPeek({
      uri: Services.io.newURI(win.BROWSER_NEW_TAB_URL),
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      userContextId: lazy.PrivateBrowsingUtils.isWindowPrivate(win)
        ? shared
        : (win.gBrowser.defaultUserContextId ?? shared),
      fromExternal: false,
    });
  },

  /**
   * A Peek whose first load became `download` closes, and the
   * window the Downloads panel announces it in (`windowToTell`) comes to the
   * front, opened if there is none. Firefox opens the panel only in the
   * active window (`DownloadsDataCtor._notifyDownloadEvent`), so the
   * announcement waits until that window is active, or gone.
   *
   * @param {Window} win A Peek.
   * @param {object} download
   * @returns {Promise<void>}
   */
  async handOver(win, download) {
    // Handed off first, so `windowToTell` passes over this Peek.
    handedOff.add(win);
    const target =
      lazy.SvalDownloadWorkspaces.windowToTell(download, false) ??
      (await openNormalWindow());
    target.focus();
    lazy.SvalMacWindowOrder.bringForward(target);
    win.close();
    if (Services.focus.activeWindow === target) {
      return;
    }
    await new Promise(resolve => {
      target.addEventListener("activate", resolve, { once: true });
      target.addEventListener("unload", resolve, { once: true });
    });
  },

  /**
   * @param {Window} win A Peek.
   * @returns {boolean} Whether `win` is closing because its page went on to
   *   a workspace or a download.
   */
  isHandedOff(win) {
    return handedOff.has(win);
  },

  /**
   * @returns {Window|null} the user's frontmost ordinary window, null when
   *   none is open.
   */
  openOrdinaryWindow() {
    return normalWindows()[0] ?? null;
  },

  /**
   * The window `openPreferences` opens Settings in: the user's frontmost
   * ordinary window that shows none of an agent's workspaces. An agent's
   * window holds the user's input under its overlay (`SvalAgentMarking`), and
   * a tab opened there joins the agent's workspace. With none open, Firefox
   * opens Settings in a new window, which shows one of the user's own
   * workspaces (`currentWorkspace`).
   *
   * @returns {Window|null}
   */
  settingsWindow() {
    return (
      normalWindows().find(
        win =>
          lazy.model.agentLabelOf(
            win.SvalPanel.nodes,
            lazy.SvalWindowWorkspace.of(win).id
          ) === null
      ) ?? null
    );
  },

  /**
   * The user's frontmost ordinary window, or a new one when none is open,
   * brought to the front.
   *
   * @returns {Promise<Window>}
   */
  async ordinaryWindow() {
    const target = this.openOrdinaryWindow() ?? (await openNormalWindow());
    target.focus();
    lazy.SvalMacWindowOrder.bringForward(target);
    return target;
  },

  /** Closes every Peek, with no question: each page is in history. */
  closeAll() {
    for (const win of openPeeks()) {
      win.close();
    }
  },

  /**
   * @returns {Window[]} the Peeks open, oldest first.
   */
  windows() {
    return openPeeks();
  },

  /**
   * Whether `win` is being opened as a Peek, from its arguments,
   * which `SvalWindow.mount` asks before the window's first layout.
   *
   * @param {Window} win A browser window.
   * @returns {boolean}
   */
  isOpening(win) {
    const options = win.arguments?.[1];
    return (
      options instanceof Ci.nsIPropertyBag2 && options.hasKey(PEEK_ATTRIBUTE)
    );
  },

  /**
   * `browser-window-before-initial-xul-layout`, for a Peek in place
   * of the panel: its mark, its size and place, its stylesheet, its tab strip
   * hidden and its header. The size and place are the window's own, so none
   * is read from or written to the main window's in xulStore (`persist`).
   *
   * @param {Window} win A browser window {@link isOpening} answers yes for.
   */
  mount(win) {
    const root = win.document.documentElement;
    const options = win.arguments[1].QueryInterface(Ci.nsIPropertyBag2);
    root.setAttribute(PEEK_ATTRIBUTE, "true");
    root.removeAttribute("persist");
    root.removeAttribute("sizemode");
    for (const [key, attribute] of [
      ["left", "screenX"],
      ["top", "screenY"],
      ["width", "width"],
      ["height", "height"],
    ]) {
      const name = `${PEEK_ATTRIBUTE}.${key}`;
      if (options.hasKey(name)) {
        root.setAttribute(attribute, options.getPropertyAsInt32(name));
      }
    }
    win.windowUtils.loadSheetUsingURIString(
      STYLESHEET,
      win.windowUtils.AUTHOR_SHEET
    );
    // Before the first layout, so the window is first drawn as one row, with
    // no tab strip above it.
    lazy.SvalFirefox.hideTabStrip(win, { persist: false });
    buildHeader(win);
    win.addEventListener(
      "unload",
      () => {
        const at = opened.indexOf(win);
        if (at >= 0) {
          opened.splice(at, 1);
        }
        renderTags();
      },
      { once: true }
    );
    win.addEventListener("SSWindowClosing", () => keepClosedPage(win), {
      once: true,
    });
  },

  /**
   * `browser-window-load`, which `gBrowserInit.onLoad` runs as soon as the
   * session store tracks the window (`browser-window-before-show`): out of
   * every saved session from then on.
   *
   * @param {Window} win A Peek.
   */
  loadWindow(win) {
    lazy.SessionStore.setCustomWindowValue(win, UNSAVED_KEY, "1");
  },

  /**
   * After the window's delayed startup: moved to the place it was asked to
   * open at, a second tab moved into a Peek of its own, and the idle
   * close and the header's state started.
   *
   * @param {Window} win A Peek.
   */
  startWindow(win) {
    const place = asked.get(win);
    if (place) {
      win.moveTo(place.left, place.top);
    }
    const state = reopening.get(win);
    if (state) {
      reopening.delete(win);
      lazy.SessionStore.setTabState(win.gBrowser.selectedTab, state);
    }
    if (!opened.includes(win)) {
      opened.push(win);
    }
    // A tab opened here with no opener, by Cmd+T or the File menu, takes the
    // window's default jar (`workspace-jar-for-new-tabs.patch`), and goes on
    // to a Peek of its own in that jar: the page's.
    win.gBrowser.defaultUserContextId = win.gBrowser.selectedTab.userContextId;
    win.gBrowser.tabContainer.addEventListener("TabOpen", event => {
      const tab = event.target;
      // After `addTab` has started its load: the move swaps the tab's
      // browser into the new window, load and all.
      Services.tm.dispatchToMainThread(() => {
        if (tab.closing || !tab.linkedBrowser || win.closed) {
          return;
        }
        // A workspace's tab, such as one Reopen Closed Tab brought back from
        // another window's list, goes back to an ordinary window, where its
        // node is watched.
        if (lazy.SvalTabs.nodeIdOf(tab)) {
          const home = normalWindows()[0];
          if (home) {
            home.gBrowser.adoptTab(tab, { selectTab: true });
            home.focus();
            return;
          }
        }
        openPeek({ tab });
      });
    });
    win.addEventListener("activate", () => {
      lastFocused.delete(win);
      checkIdle(win);
      renderOpenButton(win);
    });
    win.addEventListener("deactivate", () => {
      lastFocused.set(win, this._now());
      checkIdle(win);
    });
    if (Services.focus.activeWindow !== win) {
      lastFocused.set(win, lastFocused.get(win) ?? this._now());
    } else {
      lastFocused.delete(win);
    }
    renderTags();
    checkIdle(win);
    renderOpenButton(win);
  },
};
