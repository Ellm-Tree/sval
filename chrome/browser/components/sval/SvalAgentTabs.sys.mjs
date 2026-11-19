/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * An agent's window and tabs (agent-control spec §3.5). An agent works in
 * its own workspace, and that workspace opens in a window of its own, the
 * way a torn-off workspace does (main spec §10.7). A tab the agent opens is
 * filed under the workspace by that window's tab observer, like any tab
 * opened there, so the tree has one path for tabs whoever opened them.
 *
 * Every load an agent starts carries a null principal. The system principal
 * would let a page the agent names inherit chrome privileges; a null
 * principal is what tabbrowser itself gives web content it opens
 * (`Tabbrowser.addWebTab`).
 *
 * A tab is the agent's only while its node sits under the agent's workspace
 * and a window showing that workspace holds a live tab for it. Anything else
 * is `not_controlled`, so a tab the user dragged out stops being the agent's
 * the moment it lands elsewhere. While the user has taken control of the
 * workspace (`SvalAgentControl`) its tabs are still listed, and every other
 * tool answers `user_in_control` until the user gives it back.
 *
 * An open Quick Peek in the agent's window (`SvalQuickPeek`) is the agent's too
 * (`agentHomeOf`), though the tree holds no node for it: an open Quick Peek is the
 * window's and the device's alone, and transient. The agent names it by an
 * id made from its content's `browserId`, which holds while it stays open.
 * Closed, the id answers as a closed tab does. Kept, the Quick Peek is filed as any
 * new tab is and is named by its node id from then on; the Quick Peek's id answers
 * as a closed tab does, so no tab has two ids.
 */

import { ToolError } from "moz-src:///browser/components/sval/SvalAgentErrors.sys.mjs";
import {
  asAgentLoad,
  beginAgentNavigation,
  recordAgentEntry,
  isUserEntry,
  isWorkspaceHeld,
  refuseIfUserHolds,
  refuseIfWorkspaceHeld,
  untilTaken,
} from "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs";
import {
  addressOfDocument,
  hostOf,
  hostOfDocument,
  agentSiteOf,
} from "moz-src:///browser/components/sval/SvalAgentPolicy.sys.mjs";
import { tabsIn } from "moz-src:///browser/components/sval/SvalAgentSession.sys.mjs";
import {
  detect,
  foundIn,
} from "moz-src:///browser/components/sval/SvalAgentChallenge.sys.mjs";
import {
  agentHomeOf,
  browserIdOf,
} from "moz-src:///browser/components/sval/SvalAgentTabRegistry.sys.mjs";
import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { isQuickPeek } from "moz-src:///browser/components/sval/SvalQuickPeekTab.sys.mjs";
import { handWorkspaceTo } from "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs";
import { ancestorIds } from "moz-src:///browser/components/sval/SvalTree.sys.mjs";
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  SvalWindowWorkspace:
    "moz-src:///browser/components/sval/SvalWindowWorkspace.sys.mjs",
  SvalFirefox: "moz-src:///browser/components/sval/SvalFirefox.sys.mjs",
  SvalQuickPeek: "moz-src:///browser/components/sval/SvalQuickPeek.sys.mjs",
  SvalRestore: "moz-src:///browser/components/sval/SvalRestore.sys.mjs",
  SvalTabs: "moz-src:///browser/components/sval/SvalTabs.sys.mjs",
  SvalWorkspaceJar:
    "moz-src:///browser/components/sval/SvalWorkspaceJar.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  ProgressListener: "chrome://remote/content/shared/Navigate.sys.mjs",
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
});

const DELAYED_STARTUP_TOPIC = "browser-delayed-startup-finished";
const WINDOW_CLOSED_TOPIC = "domwindowclosed";
const STOP_REQUEST_TOPIC = "http-on-stop-request";
const MODIFY_REQUEST_TOPIC = "http-on-modify-request";

/**
 * How long a navigation may run before the agent is told it failed. The
 * listener waits for an expected navigation with no timeout of its own, and a
 * load that never starts would otherwise leave the tool call unanswered.
 */
const NAVIGATION_TIMEOUT_MS = 60000;

/**
 * The stable code a failed load is reported under, by the name the load
 * failed with: an `NS_ERROR_*` name, or the error page's id, which is what
 * the progress listener names a failure whose status has no XPCOM name. A
 * failure not listed here is `navigation_failed`.
 */
const FAILURE_CODES = new Map([
  ["NS_ERROR_UNKNOWN_HOST", "dns_failure"],
  ["dnsNotFound", "dns_failure"],
  ["NS_ERROR_CONNECTION_REFUSED", "connection_refused"],
  ["connectionFailure", "connection_refused"],
  ["NS_ERROR_NET_TIMEOUT", "timeout"],
  ["NS_ERROR_NET_TIMEOUT_EXTERNAL", "timeout"],
  ["netTimeout", "timeout"],
  ["NS_ERROR_NET_INADEQUATE_SECURITY", "tls_error"],
  ["nssFailure2", "tls_error"],
  ["nssBadCert", "tls_error"],
  ["sslv3Used", "tls_error"],
  ["weakCryptoUsed", "tls_error"],
  ["inadequateSecurityError", "tls_error"],
  ["mitm", "tls_error"],
]);

/**
 * What the gate cancels a load the user blocked for the agent with, which
 * shows about:agentblocked. The page is the navigation's answer, with
 * `BLOCKED_STATUS`, HTTP's Forbidden, as its status: no request was sent,
 * and the refusal is the user's.
 */
const BLOCKED_BY_USER = "NS_ERROR_BLOCKED_BY_USER";
const BLOCKED_STATUS = 403;

/**
 * @param {string} name What a load failed with.
 * @returns {string} The code to report it under.
 */
export function failureCodeOf(name) {
  // A status in the security module has no name of its own: it reads
  // `NS_ERROR_GENERATE_FAILURE(NS_ERROR_MODULE_SECURITY, SSL_ERROR_…)`.
  if (name.includes("NS_ERROR_MODULE_SECURITY")) {
    return "tls_error";
  }
  return FAILURE_CODES.get(name) ?? "navigation_failed";
}

/**
 * Notes the response each top-level document load in one tab gets, from
 * `http-on-stop-request`, which is the one place the parent sees a document
 * channel's status. A redirect's last hop is the one kept.
 *
 * @param {number} browserId
 * @returns {{
 *   last: () => {status: number, url: string}|null,
 *   stop: () => void,
 * }}
 */
function watchResponses(browserId) {
  let latest = null;
  const observer = {
    observe(subject) {
      try {
        const channel = subject.QueryInterface(Ci.nsIHttpChannel);
        const { loadInfo } = channel;
        const bc = loadInfo.browsingContext;
        if (
          loadInfo.externalContentPolicyType !==
            Ci.nsIContentPolicy.TYPE_DOCUMENT ||
          bc?.top !== bc ||
          bc.browserId !== browserId
        ) {
          return;
        }
        latest = {
          status: channel.responseStatus,
          url: channel.URI.specIgnoringRef,
        };
      } catch {
        // Not an HTTP channel, or one that got no response.
      }
    },
  };
  Services.obs.addObserver(observer, STOP_REQUEST_TOPIC);
  return {
    last: () => latest,
    stop: () => Services.obs.removeObserver(observer, STOP_REQUEST_TOPIC),
  };
}

/**
 * Cancels each top-level document load in one tab with `BLOCKED_BY_USER`
 * before it connects, at `http-on-modify-request`, where the agent gate
 * refuses it too. A load the agent asks for on a site the user blocked goes
 * ahead only to show about:agentblocked, and this keeps it from reaching the
 * site even where the gate cannot tell whose tab it is (`watcherOf`).
 *
 * @param {number} browserId
 * @returns {() => void} Stops it.
 */
function refuseLoadsIn(browserId) {
  const observer = {
    observe(subject) {
      const channel = subject.QueryInterface(Ci.nsIHttpChannel);
      const { loadInfo } = channel;
      const bc = loadInfo.browsingContext;
      if (
        loadInfo.externalContentPolicyType ===
          Ci.nsIContentPolicy.TYPE_DOCUMENT &&
        bc?.top === bc &&
        bc.browserId === browserId
      ) {
        channel.cancel(Cr.NS_ERROR_BLOCKED_BY_USER);
      }
    },
  };
  Services.obs.addObserver(observer, MODIFY_REQUEST_TOPIC);
  return () => Services.obs.removeObserver(observer, MODIFY_REQUEST_TOPIC);
}

/**
 * How long a restored tab waits for session store to put its history in
 * place before the agent's fresh load goes ahead anyway.
 */
const RESTORE_WAIT_MS = 10000;

const notControlled = () =>
  new ToolError(
    "not_controlled",
    "That tab is not in your workspace. list_tabs shows yours."
  );

const noWindow = () =>
  new ToolError(
    "no_window",
    "Sval could not open a window for your workspace. Ask the user to open a Sval window, then try again."
  );

/** What an open Quick Peek's tab id starts with, which no node id does. */
const QUICK_PEEK_ID_PREFIX = "quick-peek-";

/**
 * @param {object} tab An open Quick Peek's tab.
 * @returns {string} The id the agent names it by.
 */
function quickPeekIdOf(tab) {
  return QUICK_PEEK_ID_PREFIX + browserIdOf(tab.linkedBrowser);
}

/**
 * @param {string} workspaceId
 * @returns {Array<{win: object, tab: object}>} The Quick Peeks open in windows
 *   showing `workspaceId` that are the agent's there.
 */
function quickPeeksIn(workspaceId) {
  const found = [];
  for (const win of windowsShowing(workspaceId)) {
    const tab = lazy.SvalQuickPeek.tabOf(win);
    if (tab && !tab.closing && agentHomeOf(tab.linkedBrowser) === workspaceId) {
      found.push({ win, tab });
    }
  }
  return found;
}

/**
 * Windows being opened for a workspace, by workspace id. Shared across every
 * caller, so two tools racing to open an agent's first tab get one window.
 *
 * @type {Map<string, Promise<object>>}
 */
const opening = new Map();

/**
 * @param {string} workspaceId
 * @returns {object[]} the open browser windows showing `workspaceId`, front
 *   to back.
 */
function windowsShowing(workspaceId) {
  // An agent never sees or acts in a private window.
  return lazy.BrowserWindowTracker.getOrderedWindows({ private: false }).filter(
    win => !win.closed && lazy.SvalWindowWorkspace.of(win).id === workspaceId
  );
}

/**
 * The nodes whose live tab is in a window that does not show `workspaceId`.
 *
 * Such a tab is not the agent's, whatever the tree says of its node: the
 * user has it open in their own window. The tree can lag that, as when a
 * tab the user took has not been filed yet, so this reads only what the
 * windows hold.
 *
 * @param {string} workspaceId
 * @returns {Set<string>} node ids.
 */
function openElsewhere(workspaceId) {
  const ids = new Set();
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    if (
      win.closed ||
      lazy.PrivateBrowsingUtils.isWindowPrivate(win) ||
      lazy.SvalWindowWorkspace.of(win).id === workspaceId
    ) {
      continue;
    }
    for (const tab of win.gBrowser?.tabs ?? []) {
      const id = lazy.SessionStore.getCustomTabValue(
        tab,
        lazy.SvalTabs.NODE_ID_KEY
      );
      if (id) {
        ids.add(id);
      }
    }
  }
  return ids;
}

/**
 * Resolves once `win` has run its delayed startup, which is what starts its
 * panel; rejects if it closes first.
 *
 * @param {object} win A browser window that has just been opened.
 * @returns {Promise<void>}
 */
function delayedStartupOf(win) {
  return new Promise((resolve, reject) => {
    const observer = (subject, topic) => {
      if (subject !== win) {
        return;
      }
      Services.obs.removeObserver(observer, DELAYED_STARTUP_TOPIC);
      Services.obs.removeObserver(observer, WINDOW_CLOSED_TOPIC);
      if (topic === DELAYED_STARTUP_TOPIC) {
        resolve();
      } else {
        reject(noWindow());
      }
    };
    Services.obs.addObserver(observer, DELAYED_STARTUP_TOPIC);
    Services.obs.addObserver(observer, WINDOW_CLOSED_TOPIC);
  });
}

/**
 * Closes `win`, resolving once it has gone.
 *
 * @param {object} win A browser window.
 * @returns {Promise<void>}
 */
function closeWindow(win) {
  const closed = new Promise(resolve => {
    const observer = subject => {
      if (subject === win) {
        Services.obs.removeObserver(observer, WINDOW_CLOSED_TOPIC);
        resolve();
      }
    };
    Services.obs.addObserver(observer, WINDOW_CLOSED_TOPIC);
  });
  win.close();
  return closed;
}

/**
 * Opens a window that shows `workspaceId`.
 *
 * The hand-off is written before anything yields. `openWindow` returns before
 * the new window has run any of its startup, and the window's panel consumes
 * the hand-off in `SvalPanel._start`, so it is in place before anything reads
 * it.
 *
 * @param {string} workspaceId
 * @returns {Promise<object>} the window, once its panel has started.
 */
async function openWindowFor(workspaceId) {
  // An explicit blank page, never the default arguments: those are the
  // user's home page (`BrowserContentHandler.getNewWindowArgs`), which would
  // load with the user's cookies and, once it is not blank, be filed under the
  // agent's workspace as a tab the agent never opened. The blank tab stays,
  // so closing the agent's last tab does not close the window.
  const args = Cc["@mozilla.org/supports-string;1"].createInstance(
    Ci.nsISupportsString
  );
  args.data = "about:blank";
  // Behind the window in front, unfocused, so the agent never takes the
  // user's keyboard or covers their window (agent-control spec §7.1).
  const win = lazy.BrowserWindowTracker.openWindow({
    args,
    features: "background",
  });
  handWorkspaceTo(win, workspaceId, { agent: true });
  await delayedStartupOf(win);
  await win.SvalPanel.started;
  if (lazy.SvalWindowWorkspace.of(win).id !== workspaceId) {
    // The workspace was not in the document by the time the window read it,
    // so the window adopted another one. It is the user's window now.
    SvalLog.warn(`agent window did not open on workspace ${workspaceId}`);
    throw noWindow();
  }
  return win;
}

const pageChanged = () =>
  new ToolError(
    "page_changed",
    "The tab moved to another page while Sval was checking where it would go. Check the tab and try again."
  );

/**
 * Whether `browser`'s tab carries a node id it does not stand for
 * (`SvalTabs.isUnsettled`): a copy whose history may be the user's, which
 * the agent is kept out of until it has a node of its own.
 *
 * @param {object} browser A tab's `<browser>`.
 * @returns {boolean}
 */
function isUnsettled(browser) {
  try {
    const tab = browser.documentGlobal.gBrowser.getTabForBrowser(browser);
    return lazy.SvalTabs.isUnsettled(tab);
  } catch {
    return true;
  }
}

/**
 * @param {object} browser A tab's `<browser>`.
 * @returns {string|null} The tab's node id.
 */
function nodeIdOf(browser) {
  try {
    const tab = browser.documentGlobal.gBrowser.getTabForBrowser(browser);
    return lazy.SvalTabs.nodeIdOf(tab);
  } catch {
    return null;
  }
}

/**
 * Whether the tab id an agent passes in can name a node at all.
 *
 * @param {unknown} tabId
 * @returns {boolean}
 */
function isNodeId(tabId) {
  return typeof tabId === "string" && tabId !== "";
}

/**
 * What a browser shows once a navigation has finished.
 *
 * @param {object} browser A `<browser>`.
 * @returns {{url: string, title: string}}
 */
function shown(browser) {
  return { url: browser.currentURI.spec, title: browser.contentTitle };
}

/**
 * A fresh load of `uri` with a null principal: what every load an agent
 * starts must be.
 *
 * @param {object} browser A `<browser>`.
 * @param {nsIURI} uri
 * @returns {Function} starts the load.
 */
function freshLoad(browser, uri) {
  const triggeringPrincipal =
    Services.scriptSecurityManager.createNullPrincipal(
      browser.browsingContext.originAttributes
    );
  return () =>
    browser.loadURI(uri, {
      triggeringPrincipal,
      loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_NONE,
    });
}

/**
 * @param {nsISHEntry} entry
 * @returns {boolean} Whether `entry`, or any frame's entry under it, holds
 *   post data.
 */
function holdsPost(entry) {
  if (entry.hasPostData) {
    return true;
  }
  for (let i = 0; i < entry.childCount; i++) {
    const child = entry.GetChildAt(i);
    if (child && holdsPost(child)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a history entry may be loaded again for an agent.
 *
 * A history load replays the entry's own triggering principal, and every
 * load an agent starts carries a null principal (agent-control spec §4). So
 * only an entry whose triggering principal is a null principal is replayed:
 * one the agent's own load made. Any other entry, one the user, a page or
 * session restore made, carries someone else's authority, the site's own
 * SameSite=Strict cookies among it: a reload loads it afresh, and history
 * does not step into it.
 *
 * A history load also replays post data (nsISHEntry.idl `postData`), which
 * would send a form's write again outside the write gate. A frame's post is
 * held by the frame's own entry, a child of the page's, and its frame loads
 * from that entry too, so an entry is not replayed if it or any entry under
 * it holds any.
 *
 * @param {nsISHEntry|null} entry
 * @returns {boolean}
 */
function isReplayable(entry) {
  if (
    !entry?.URI ||
    entry.triggeringPrincipal?.isNullPrincipal !== true ||
    holdsPost(entry)
  ) {
    return false;
  }
  try {
    agentSiteOf(entry.URI.spec);
  } catch {
    return false;
  }
  return true;
}

/**
 * How to go one step through history, or a `no_history` refusal.
 *
 * Goes to the checked index itself rather than through `goBack`/`goForward`,
 * so the entry loaded is the entry checked. That also ignores the
 * user-interaction requirement, which an agent's own loads could never meet:
 * they carry no user interaction, and honouring it would skip every page the
 * agent visited. Marionette's `goBack` ignores it too.
 *
 * @param {object} browser A `<browser>`.
 * @param {number} step -1 or 1.
 * @param {{index: number, id: number}} [checked] The entry a caller has
 *   already approved. The step must still lead to that very entry: one that
 *   took its place, or a history that moved on meanwhile, is refused.
 * @returns {Function} starts the load.
 */
function historyStep(browser, step, checked) {
  const history = browser.browsingContext.sessionHistory;
  const index = history ? history.index + step : -1;
  if (
    checked &&
    (index !== checked.index ||
      index < 0 ||
      index >= history.count ||
      history.getEntryAtIndex(index).ID !== checked.id)
  ) {
    throw pageChanged();
  }
  if (!history || index < 0 || index >= history.count) {
    throw new ToolError(
      "no_history",
      step < 0
        ? "There is no page to go back to."
        : "There is no page to go forward to."
    );
  }
  const entry = history.getEntryAtIndex(index);
  if (
    isUnsettled(browser) ||
    isUserEntry(browser.browsingContext.browserId, entry.ID, nodeIdOf(browser))
  ) {
    throw new ToolError(
      "no_history",
      "That page was opened by the user, so it cannot be loaded from history."
    );
  }
  if (isReplayable(entry)) {
    return () => browser.gotoIndex(index);
  }
  // An entry the agent's own load did not make, or one holding a sent form,
  // is not replayed, and history cannot load it afresh in its place. The
  // agent is given its address to open as a load of its own, when it is one
  // an agent may open.
  try {
    agentSiteOf(entry.URI.spec);
  } catch {
    throw new ToolError(
      "no_history",
      "That page is not one an agent can open, so it cannot be loaded from history."
    );
  }
  throw new ToolError(
    "no_history",
    "Sval loads from history only the pages you loaded, never a sent form. Open this address with navigate_tab instead, which loads it afresh.",
    { url: entry.URI.spec }
  );
}

/**
 * How to reload what `browser` shows. A reload replays the current entry's
 * triggering principal and post data, its frames' included, so an entry an
 * agent may not replay is loaded afresh instead: a new GET of its address,
 * whose frames load from their own sources.
 *
 * @param {object} browser A `<browser>`.
 * @returns {Function} starts the load.
 */
function reloadOf(browser) {
  const history = browser.browsingContext.sessionHistory;
  const entry =
    history && history.index >= 0
      ? history.getEntryAtIndex(history.index)
      : null;
  if (isReplayable(entry)) {
    return () => browser.reload();
  }
  const current = browser.currentURI;
  agentSiteOf(current.spec);
  return freshLoad(browser, current);
}

/**
 * What a navigation to `target` would load now, for a caller to approve
 * before calling {@link navigate} with it as `checked`.
 *
 * @param {object} browser A `<browser>`.
 * @param {string} target A URL, or `"back"`, `"forward"` or `"reload"`.
 * @returns {{url: string, entry?: {index: number, id: number}}|null} null
 *   when there is no page in that direction, which `navigate` refuses
 *   itself.
 */
export function checkedTarget(browser, target) {
  if (target === "reload") {
    return { url: browser.currentURI.spec };
  }
  if (target !== "back" && target !== "forward") {
    return { url: target };
  }
  const history = browser.browsingContext.sessionHistory;
  const index = history ? history.index + (target === "back" ? -1 : 1) : -1;
  if (!history || index < 0 || index >= history.count) {
    return null;
  }
  const entry = history.getEntryAtIndex(index);
  if (!entry.URI) {
    return null;
  }
  return { url: entry.URI.spec, entry: { index, id: entry.ID } };
}

let topLevelListenerClass = null;

/**
 * Navigate.sys.mjs's progress listener, told of a frame's loads only when
 * they can be the navigation.
 *
 * A context's web progress passes on every notification of its subframes
 * (`BrowsingContextWebProgress::UpdateAndNotifyListeners`), and the
 * listener acts on them as on its own: a frame's error page or failed load
 * would fail the tab's navigation, and a frame's same-document change would
 * end it early. So a notification whose web progress is not the top level's
 * is dropped, as Firefox's own listeners drop them (`isTopLevel`, as in
 * browser.js's `XULBrowserWindow`).
 *
 * A step through session history is the exception: an entry a frame's own
 * navigation added moves only that frame, and the top level reports
 * nothing. With `frames`, a frame's notification counts while the top
 * level is not loading a document, so a step that moves a frame ends with
 * it, and a frame's failure during a load of the whole page still cannot
 * end that load.
 *
 * @returns {Function} The class, made once Navigate.sys.mjs has loaded. Its
 *   constructor takes Navigate.sys.mjs's arguments, and `frames` among the
 *   options.
 */
function topLevelProgressListener() {
  topLevelListenerClass ??= class extends lazy.ProgressListener {
    #top;
    #frames;

    constructor(webProgress, { frames = false, ...options } = {}) {
      super(webProgress, options);
      this.#top = webProgress;
      this.#frames = frames;
    }

    #counts(progress) {
      return (
        progress.isTopLevel || (this.#frames && !this.#top.isLoadingDocument)
      );
    }

    onStateChange(progress, ...rest) {
      if (this.#counts(progress)) {
        super.onStateChange(progress, ...rest);
      }
    }

    onLocationChange(progress, ...rest) {
      if (this.#counts(progress)) {
        super.onLocationChange(progress, ...rest);
      }
    }
  };
  return topLevelListenerClass;
}

/**
 * Ends the document load `browser` is in, if any, and waits until the parent
 * has heard it end.
 *
 * The parent counts a top-level document as loading from its first
 * `STATE_START` to its `STATE_STOP`, and drops any other `STATE_START` in
 * between as a duplicate (`BrowsingContextWebProgress::OnStateChange`). It
 * hears of a page's load event before that `STATE_STOP`, so a navigation can
 * be asked for in between. A load begun then starts in the parent
 * (`CanonicalBrowsingContext::AttemptSpeculativeLoadInParent`) and its start
 * is dropped. When it also moves the tab into a new browsing context, as a
 * load that keeps the page in the back-forward cache does, the old
 * context's `STATE_STOP` is dropped too
 * (`BrowserParent::ReceiveProgressListenerData`), and a listener waiting for
 * the load's start never hears it. The load in flight is stopped, since the
 * navigation would replace it anyway, so the wait is no longer than the stop
 * takes to arrive.
 *
 * @param {object} browser A `<browser>`.
 * @param {object} webProgress Its browsing context's web progress.
 * @returns {Promise<void>} Settles once no document is loading, whether the
 *   load ended or failed.
 */
async function endLoadInFlight(browser, webProgress) {
  if (!webProgress.isLoadingDocument) {
    return;
  }
  const TopLevelProgressListener = topLevelProgressListener();
  // Not waiting for an explicit start, the listener counts the load in
  // flight as started, and settles at its stop; one that ended meanwhile
  // leaves it to the listener's unload timer.
  const listener = new TopLevelProgressListener(webProgress);
  try {
    const ended = listener.start();
    asAgentLoad(() => browser.stop());
    await ended;
  } catch (err) {
    SvalLog.debug(`the load in flight ended with ${SvalLog.errorName(err)}`);
  } finally {
    if (listener.isStarted) {
      listener.stop();
    }
    listener.destroy();
  }
}

/**
 * Selects `browser`'s tab in its window, so the tab the agent works in is
 * the one whose page has focus (agent-control spec §4.1). Called only as an
 * input or load of the agent's goes, after the last check that the user
 * does not hold the tab (`refuseIfUserHolds`), so a tab the user holds is
 * never switched.
 *
 * @param {object} browser A `<browser>`.
 */
export function workIn(browser) {
  const gBrowser = browser.documentGlobal?.gBrowser;
  const tab = gBrowser?.getTabForBrowser(browser);
  // An open Quick Peek is shown over the selected tab, and selecting its own
  // hidden tab would close it (`SvalQuickPeek`, on `TabSelect`).
  if (tab && !isQuickPeek(tab) && gBrowser.selectedTab !== tab) {
    gBrowser.selectedTab = tab;
  }
}

/**
 * Loads `target` in `browser` and waits for the load to finish.
 *
 * The progress listener is started before the load is triggered and waits for
 * an explicit start, so a load already in flight is not mistaken for this one
 * (`remote/shared/Navigate.sys.mjs`, as WebDriver BiDi's `#awaitNavigation`
 * uses it). The browser's `webProgress` is read once, first, because it stays
 * the same object across the process switch and history swaps a navigation
 * can cause, while `browser.browsingContext` does not.
 *
 * The wait is raced against a timeout of its own. The listener has none when
 * a navigation is expected, and the agent must get an answer whatever the
 * listener does. It is raced against the user taking control of the tab
 * too, which stops the load and answers `user_in_control` at once. The load
 * itself starts only if the user does not hold the tab then, however long
 * the caller waited on the user before.
 *
 * @param {object} browser A `<browser>`.
 * @param {string} target A URL, or `"back"`, `"forward"` or `"reload"`.
 * @param {object} [options]
 * @param {object} [options.checked] What {@link checkedTarget} returned when
 *   the target was approved. The load is refused with `page_changed` unless
 *   it would load exactly that.
 * @param {boolean} [options.workIn] Whether the tab is selected as the load
 *   starts ({@link workIn}).
 * @param {boolean} [options.blocked] Whether the user blocked the target's
 *   site for the agent, so that the load only shows about:agentblocked.
 * @returns {Promise<{url: string, title: string, status?: number}>} Where
 *   the tab is now, and, when the load was one request the page answered over
 *   HTTP, that response's status. A page restored from memory (back or
 *   forward to one the browser kept) made no request, and gets none.
 */
export async function navigate(
  browser,
  target,
  { checked, workIn: select, blocked: siteBlocked = false } = {}
) {
  if (!browser.browsingContext?.webProgress) {
    throw new ToolError("navigation_failed", "NoBrowsingContext");
  }
  let targetURI;
  if (target !== "back" && target !== "forward" && target !== "reload") {
    agentSiteOf(target);
    targetURI = Services.io.newURI(target);
  }
  // What the tab's history and page say decides the load, so it is read
  // again once a load in flight has ended (`endLoadInFlight`), which can
  // move both. Read first too, so a navigation that cannot happen is refused
  // before anything waits.
  const loadFor = () => {
    if (target === "back") {
      return historyStep(browser, -1, checked?.entry);
    }
    if (target === "forward") {
      return historyStep(browser, 1, checked?.entry);
    }
    if (target === "reload") {
      if (checked && browser.currentURI.spec !== checked.url) {
        throw pageChanged();
      }
      return reloadOf(browser);
    }
    return freshLoad(browser, targetURI);
  };
  loadFor();

  const webProgress = browser.browsingContext.webProgress;
  const TopLevelProgressListener = topLevelProgressListener();
  const listener = new TopLevelProgressListener(webProgress, {
    frames: target === "back" || target === "forward",
    expectNavigation: true,
    waitForExplicitStart: true,
    targetURI,
  });
  const timeout = new Error("Timeout");
  let timer;
  const timedOut = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(timeout), NAVIGATION_TIMEOUT_MS);
  });
  // Stopped the moment the user takes the tab, before any gate lets go of
  // what it holds for the tab, so no load of the agent's, nor a redirect of
  // one held for its site alert, goes on as the user's.
  const browserId = browser.browsingContext.browserId;
  const taken = untilTaken(browserId, () => asAgentLoad(() => browser.stop()));
  // The load is the agent's for as long as the tool waits on it, so a load
  // the gate holds for its site meanwhile is known to be the agent's.
  const navigated = beginAgentNavigation(browserId);
  const responses = watchResponses(browserId);
  const stopRefusing = siteBlocked ? refuseLoadsIn(browserId) : () => {};
  let blocked = false;
  try {
    refuseIfUserHolds(browser);
    await Promise.race([
      endLoadInFlight(browser, webProgress),
      timedOut,
      taken.promise,
    ]);
    refuseIfUserHolds(browser);
    if (select) {
      workIn(browser);
    }
    const startLoad = loadFor();
    const loaded = listener.start();
    // Made as the agent's, which the layer over the tab lets through.
    asAgentLoad(startLoad);
    await Promise.race([loaded, timedOut, taken.promise]);
  } catch (err) {
    // The user taking the tab, or `loadFor` finding the page changed or no
    // history to step to, says so as it is.
    if (err instanceof ToolError) {
      throw err;
    }
    if (err === timeout) {
      asAgentLoad(() => browser.stop());
    }
    // The listener rejects with the error's name as its message
    // (`NavigationError`, or the error page's code), never with the address.
    const name = err?.message || err?.name || "Error";
    if (err !== timeout && name === BLOCKED_BY_USER) {
      blocked = true;
    } else {
      throw new ToolError(
        err === timeout ? "timeout" : failureCodeOf(name),
        name
      );
    }
  } finally {
    stopRefusing();
    responses.stop();
    clearTimeout(timer);
    taken.done();
    navigated();
    try {
      // Still registered with the web progress when the load threw before it
      // began or the timeout won; a settled navigation has removed it.
      if (listener.isStarted) {
        listener.stop();
      }
      listener.destroy();
    } catch (err) {
      SvalLog.debug(
        `stopping a navigation listener threw ${SvalLog.errorName(err)}`
      );
    }
  }
  recordAgentEntry(browserId);
  if (blocked) {
    return {
      url: addressOfDocument(browser.browsingContext.currentWindowGlobal),
      title: browser.contentTitle,
      status: BLOCKED_STATUS,
    };
  }
  // The status belongs to the page the tab shows only when that page is the
  // response's own address: a download, or a load that left the tab where
  // it was, answers a request that is not the page.
  const response = responses.last();
  if (response?.url === browser.currentURI.specIgnoringRef) {
    return { ...shown(browser), status: response.status };
  }
  return shown(browser);
}

/**
 * @param {string} workspaceId
 * @returns {object|null} The full browser window showing `workspaceId`, if
 *   one is open now.
 */
export function fullWindowShowing(workspaceId) {
  return windowsShowing(workspaceId).find(win => win.toolbar.visible) ?? null;
}

/**
 * The full browser window showing `workspaceId`, where an agent's tabs open.
 *
 * A popup a page opened can show the workspace too, but it is never where
 * the agent's own tabs go: those open in a full window, which a popup is not
 * (`toolbar.visible`, as `BrowserDOMWindow` tells them apart). With only a
 * popup showing the workspace, a full window is opened.
 *
 * @param {string} workspaceId
 * @param {{open?: boolean}} [options] `open: true` opens one when there is
 *   none.
 * @returns {Promise<object|null>}
 */
export async function windowForWorkspace(workspaceId, { open = false } = {}) {
  const shownBy = fullWindowShowing(workspaceId);
  if (shownBy) {
    return shownBy;
  }
  if (!open) {
    return null;
  }
  let pending = opening.get(workspaceId);
  if (!pending) {
    pending = openWindowFor(workspaceId).finally(() =>
      opening.delete(workspaceId)
    );
    opening.set(workspaceId, pending);
  }
  return pending;
}

/**
 * Tabs being brought up to an agent's terms, so two calls for one tab load it
 * once.
 *
 * @type {WeakMap<object, Promise<void>>}
 */
const materializing = new WeakMap();

/**
 * Gives a lazy or discarded tab a browser, and loads afresh a tab session
 * store has yet to restore, so session store never loads a system-principal
 * entry on an agent's behalf.
 *
 * A tab `SvalRestore` opened, or one Firefox discarded, has no browser
 * (`createLazyBrowser`; `discardBrowser` puts a tab back into that state), so
 * there is nothing to act in. `_insertBrowser` is the call tabbrowser itself
 * makes when such a tab is selected, and inserting it makes session store
 * restore the tab's saved history. The entry it would load carries the
 * user's authority (`SvalRestore`), so the node's page is loaded afresh with
 * a null principal instead. A tab session store is still restoring
 * (`SessionStore.isTabRestoring`) is loaded afresh for the same reason.
 *
 * A tab that has finished loading is left as it is, whatever its entry's
 * triggering principal: the page's own principal does not depend on it, and
 * reloading it would throw away whatever the user had typed into it. What a
 * history entry would replay is checked where history is replayed
 * ({@link isReplayable}).
 *
 * The fresh load waits for `SSTabRestoring` after an insertion: session store
 * dispatches it once the history is in place and it is listening for a load
 * it did not start (`SessionStore._restoreHistory`), and a load that started
 * before then would leave the tab pending, to be replaced by the restored
 * entry when it is next selected. The wait is bounded because a failed
 * history restore dispatches nothing.
 *
 * A node whose address agents may not open, or a fresh load that fails,
 * rejects: the agent is never handed a tab on session store's terms.
 *
 * @param {object} win The tab's window.
 * @param {object} tab A Firefox tab.
 * @param {string|null} url The node's address.
 * @returns {Promise<void>}
 */
function materialize(win, tab, url) {
  const inFlight = materializing.get(tab);
  if (inFlight) {
    return inFlight;
  }
  if (!lazy.SvalFirefox.isLazy(tab) && !lazy.SvalFirefox.isRestoring(tab)) {
    return Promise.resolve();
  }
  const done = (async () => {
    const site = agentSiteOf(url || "about:blank");
    if (lazy.SvalFirefox.isLazy(tab)) {
      let timer;
      const restoring = new Promise(resolve => {
        tab.addEventListener("SSTabRestoring", resolve, { once: true });
        timer = setTimeout(resolve, RESTORE_WAIT_MS);
      });
      lazy.SvalFirefox.insertBrowser(win, tab);
      if (lazy.SvalFirefox.isRestoring(tab)) {
        await restoring;
      }
      clearTimeout(timer);
    }
    if (site !== null) {
      await navigate(tab.linkedBrowser, url);
    }
  })().finally(() => materializing.delete(tab));
  materializing.set(tab, done);
  return done;
}

/**
 * The agent tab functions, bound to one engine and one gate.
 *
 * @param {object} options
 * @param {{tree: Function}} options.engine The engine whose tree says which
 *   tabs are in which workspace.
 * @param {{watch: Function}} options.gate Checks every top-level load in the
 *   tabs it is handed (`SvalAgentGate`). Required, so a caller that forgets
 *   it fails at once instead of leaving the agent's tabs unwatched.
 */
export function createAgentTabs({ engine, gate }) {
  if (typeof gate?.watch !== "function") {
    throw new TypeError("createAgentTabs needs a gate");
  }

  async function nodes() {
    return (await engine.tree()).nodes ?? {};
  }

  const windowFor = windowForWorkspace;

  /**
   * Opens `url` in a new tab in the agent's window.
   *
   * The tab opens on `about:blank` and is filed and handed to the gate before
   * it loads anything, so it has its node id before the page can do anything
   * at all, and its first load, with any redirect, is already checked.
   *
   * `skipLoad` keeps the browser on its initial document. Without it a blank
   * tab's browser loads `about:blank` once it is set up (tabbrowser.js only
   * sets `nodefaultsrc` for a tab that will load something else), and in a
   * window that has just opened that load can start after the navigation's
   * listener has, which would then report the blank page as the result.
   *
   * @param {{agentId: string, workspaceId: string}} agent
   * @param {string} url
   * @param {{blocked?: boolean}} [options] As `navigate` takes.
   * @returns {Promise<{tab: string, url: string, title: string}>}
   */
  async function openTab(agent, url, { blocked } = {}) {
    const { workspaceId } = agent;
    refuseIfWorkspaceHeld(workspaceId);
    const site = agentSiteOf(url);
    const win = await windowFor(workspaceId, { open: true });
    await win.SvalPanel.started;
    const observer = win.SvalPanel.observer;
    if (!observer) {
      // The window's first sync pass failed, so nothing is filing its tabs
      // yet. A tab opened now would belong to no workspace.
      throw noWindow();
    }
    // The tab opens in its workspace's jar, so an isolated workspace's
    // tab never starts in the default one (isolated workspaces spec §4).
    const userContextId = lazy.SvalWorkspaceJar.userContextIdFor(
      await nodes(),
      workspaceId
    );
    // Again after the last wait: the user can take the workspace during it.
    refuseIfWorkspaceHeld(workspaceId);
    const tab = win.gBrowser.addWebTab("about:blank", {
      triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({
        userContextId,
      }),
      userContextId,
      inBackground: false,
      skipLoad: true,
    });
    await observer.settled();
    const id = observer.nodeIdFor(tab);
    if (!id) {
      win.gBrowser.removeTab(tab, { animate: false });
      SvalLog.warn(`agent tab was not filed in workspace ${workspaceId}`);
      throw noWindow();
    }
    const browser = tab.linkedBrowser;
    gate.watch(browser, agent);
    const loaded =
      site === null
        ? shown(browser)
        : await navigate(browser, url, { blocked });
    return { tab: id, ...loaded };
  }

  /**
   * The live tab `tabId` names, if it is the agent's, as it is: a tab session
   * restore left lazy has no browser yet. Every tab of a workspace the user
   * has taken control of is refused with `user_in_control`.
   *
   * @param {string} workspaceId
   * @param {string} tabId A node id, or an open Quick Peek's id.
   * @returns {Promise<{win: object, tab: object, url: string|null}>}
   */
  async function find(workspaceId, tabId) {
    if (!isNodeId(tabId)) {
      throw notControlled();
    }
    if (tabId.startsWith(QUICK_PEEK_ID_PREFIX)) {
      const quickPeek = quickPeeksIn(workspaceId).find(
        p => quickPeekIdOf(p.tab) === tabId
      );
      if (!quickPeek) {
        throw notControlled();
      }
      refuseIfWorkspaceHeld(workspaceId);
      return { ...quickPeek, url: null };
    }
    // Up from the tab, as `listTabs` would find it walking down: through
    // groups and splits alone to the workspace.
    const all = await nodes();
    const node = all[tabId];
    const up = node?.kind === "tab" ? ancestorIds(all, tabId) : [];
    const at = up.indexOf(workspaceId);
    if (
      at < 0 ||
      !up
        .slice(0, at)
        .every(id => all[id].kind === "group" || all[id].kind === "split") ||
      openElsewhere(workspaceId).has(tabId)
    ) {
      throw notControlled();
    }
    // By the workspace, before anything gives the tab a browser: a tab
    // Firefox discarded, or a restart made again, has none yet.
    refuseIfWorkspaceHeld(workspaceId);
    const showing = windowsShowing(workspaceId);
    for (const win of showing) {
      const tab = win.SvalPanel.observer?.tabFor(tabId);
      if (tab) {
        return { win, tab, url: node.content?.url ?? null };
      }
    }
    // A node the agent's window has no tab for, such as a tab the user
    // handed over by moving it into the workspace (agent-control spec §5.4),
    // gets one lazily, as a row the user goes to does (`SvalRestore`), in
    // the workspace's jar, with the selection left alone. With no window
    // showing the workspace, as after `close_window`, one is opened for it.
    const win =
      showing.find(w => w.SvalPanel.observer) ??
      (await windowFor(workspaceId, { open: true }));
    refuseIfWorkspaceHeld(workspaceId);
    if (!win.SvalPanel.observer) {
      throw noWindow();
    }
    const opened = win.SvalPanel.observer.tabFor(tabId);
    if (opened) {
      return { win, tab: opened, url: node.content?.url ?? null };
    }
    const tab =
      node.content?.url &&
      lazy.SvalRestore.open(
        win,
        node,
        tabId,
        lazy.SvalWorkspaceJar.userContextIdFor(all, workspaceId)
      );
    if (tab) {
      return { win, tab, url: node.content.url };
    }
    throw notControlled();
  }

  /**
   * The live tab `tabId` names, if it is the agent's, with a browser to act
   * in and a page an agent may open.
   *
   * A tab in the agent's workspace can show a page the agent could not have
   * opened: the user can type `about:` or `view-source:` into it, and session
   * store can restore one. Such a tab is the agent's to close and nothing
   * else, so it answers `unsupported_url` here.
   *
   * The tab is handed to the gate before anything loads in it, so a tab this
   * session did not open, such as one restored from an earlier run, is
   * watched from its first load here on, materializing's own load included.
   *
   * @param {{agentId: string, workspaceId: string}} agent
   * @param {string} tabId A node id.
   * @param {object} [found] What {@link find} answered for the tab in this
   *   turn, which is not looked up again.
   * @returns {Promise<{win: object, tab: object, browser: object}>}
   */
  async function tabIn(agent, tabId, found) {
    const { win, tab, url } = found ?? (await find(agent.workspaceId, tabId));
    // A lazy tab's browser is the element `_insertBrowser` puts in the
    // document, so it is watched once, here, before anything loads in it.
    gate.watch(tab.linkedBrowser, agent);
    await materialize(win, tab, url);
    const browser = tab.linkedBrowser;
    agentSiteOf(browser.currentURI?.spec ?? "");
    return { win, tab, browser };
  }

  /**
   * Closes the agent's tab. The window's observer deletes its node on
   * `TabClose`, as it does for any tab closed there. A lazy tab, or one
   * showing a page agents may not open, is closed as it is.
   *
   * `keepOneTab` first: removing a window's last tab closes the window before
   * `TabClose` is dispatched (`_beginRemoveTab`'s `closeWindowFastpath`), and
   * the node would outlive its tab. The panel's own close does the same
   * (`SvalTabObserver.keepOneTab`). The tab kept is a blank page rather than
   * the home page, which would be filed into the agent's workspace as a tab
   * the agent never opened.
   *
   * @param {string} workspaceId
   * @param {string} tabId
   */
  async function closeTab(workspaceId, tabId) {
    const { win, tab } = await find(workspaceId, tabId);
    if (isQuickPeek(tab)) {
      lazy.SvalQuickPeek.close(win);
      return;
    }
    win.SvalPanel.observer?.keepOneTab([tabId], { blank: true });
    win.gBrowser.removeTab(tab, { animate: false });
    await win.SvalPanel.observer?.settled();
  }

  /**
   * The tabs filed under the agent's workspace, less any open in a window
   * that shows another workspace ({@link openElsewhere}), then the Quick Peek open
   * in the agent's window, marked `quickPeek`.
   *
   * @param {string} workspaceId
   * @returns {Promise<Array<{tab: string, title: string, url: string|null, quickPeek?: true}>>}
   */
  async function listTabs(workspaceId) {
    const listed = tabsIn(await nodes(), workspaceId);
    const elsewhere = openElsewhere(workspaceId);
    return [
      ...listed.filter(t => !elsewhere.has(t.tab)),
      ...quickPeeksIn(workspaceId).map(({ tab }) => ({
        tab: quickPeekIdOf(tab),
        title: null,
        url: null,
        quickPeek: true,
      })),
    ];
  }

  /**
   * The agent's tab list, as `list_tabs` answers it: {@link listTabs}, less
   * what the agent may not read now.
   *
   * - A tab with a page in the agent's window is named by its document, and
   *   judged by the document's principal, as `gate.checkPage` judges it: a
   *   blank page a site's page opened and wrote into holds that site's
   *   content. Its node can lag the page, and would name the page before
   *   it. The name and the judgement come from one window global: a
   *   browser's own title and address are updated on schedules of their
   *   own, and can still name the page before.
   * - A tab with no page yet is named by its node, and judged by the node's
   *   address (`gate.checkSite`): a site can be blocked after its page
   *   loaded, and the node still names the page.
   * - Refused, a tab has no title or address. A blank page, or a tab with no
   *   address, has no title: the title of a page with no site of its own is
   *   whatever wrote into it.
   * - While the user holds the workspace, every tab is listed with no title
   *   or address and `user_in_control: true`: what the user does there is
   *   theirs, and the agent is told why every other tool is refused, and
   *   can poll for the user giving the workspace back.
   * - A tab whose page last showed a human-verification check is checked
   *   again, and listed with `human_verification: true` while it still
   *   shows one (`SvalAgentChallenge`), so the agent can poll for the user
   *   having completed it.
   *
   * @param {{agentId: string, workspaceId: string}} agent
   * @returns {Promise<Array<{tab: string, title: string|null, url: string|null, quickPeek?: true, user_in_control?: true, human_verification?: true}>>}
   */
  async function listTabsFor(agent) {
    const windows = windowsShowing(agent.workspaceId);
    const browserOf = id => {
      for (const win of windows) {
        const quickPeek = lazy.SvalQuickPeek.tabOf(win);
        const tab =
          quickPeek && quickPeekIdOf(quickPeek) === id
            ? quickPeek
            : win.SvalPanel.observer?.tabFor(id);
        if (tab) {
          return tab.linkedPanel ? tab.linkedBrowser : null;
        }
      }
      return null;
    };
    const documentOf = id =>
      browserOf(id)?.browsingContext?.currentWindowGlobal ?? null;
    const named = t => {
      const windowGlobal = documentOf(t.tab);
      if (windowGlobal) {
        gate.checkSite(agent, hostOfDocument(windowGlobal));
        return {
          tab: t.tab,
          title: windowGlobal.documentTitle,
          url: addressOfDocument(windowGlobal),
        };
      }
      if (t.url !== null) {
        gate.checkSite(agent, hostOf(t.url));
      }
      return t;
    };
    const checked = async listed => {
      const browser = browserOf(listed.tab);
      if (!browser || !foundIn(browser)) {
        return listed;
      }
      // A page that does not answer keeps the check last found in it.
      let check = null;
      try {
        check = await detect(browser, { grace: false });
      } catch {
        check = foundIn(browser);
      }
      return check ? { ...listed, human_verification: true } : listed;
    };
    const listedTabs = await listTabs(agent.workspaceId);
    // Read after the wait: the user can take the workspace during it.
    const held = isWorkspaceHeld(agent.workspaceId);
    const listedAs = t => {
      if (held) {
        return { tab: t.tab, title: null, url: null, user_in_control: true };
      }
      let listed;
      try {
        listed = named(t);
      } catch {
        return { tab: t.tab, title: null, url: null };
      }
      if (listed.url === null || listed.url === "about:blank") {
        return { ...listed, title: null };
      }
      return checked(listed);
    };
    return Promise.all(
      listedTabs.map(async t => {
        const listed = await listedAs(t);
        return t.quickPeek ? { ...listed, quickPeek: true } : listed;
      })
    );
  }

  /**
   * Closes every window showing the agent's workspace. The workspace keeps
   * its tabs, as it does when the user closes the window: the tree holds
   * them. Windows that are all of Sval's stay open, since closing the last
   * window quits Sval on Windows and Linux.
   *
   * @param {string} workspaceId
   * @returns {Promise<boolean>} Whether Sval has no window showing the
   *   workspace once it returns.
   */
  async function closeWindows(workspaceId) {
    refuseIfWorkspaceHeld(workspaceId);
    const showing = windowsShowing(workspaceId);
    if (!showing.length) {
      return true;
    }
    if (lazy.BrowserWindowTracker.windowCount <= showing.length) {
      return false;
    }
    await Promise.all(showing.map(closeWindow));
    return true;
  }

  return {
    windowFor,
    openTab,
    find,
    tabIn,
    navigate,
    closeTab,
    listTabs,
    listTabsFor,
    closeWindows,
  };
}
