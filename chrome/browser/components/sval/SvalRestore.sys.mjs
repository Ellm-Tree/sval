/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * What each window holds at launch: the tabs its own tree says its workspace
 * has (spec §10.4). The tree is the tab model, and a document that survives a
 * restart is the only thing that has to survive one.
 *
 * Two public mechanisms cover it without a patch against Mozilla's code:
 *
 * 1. *Firefox brings back the windows.* `browser.startup.page` is 3
 *    (`app-sval-prefs.js`), so every launch resumes the last session: each
 *    window with its place, its size, its stacking, the workspace it showed
 *    (`SvalPanelModel.CURRENT_WORKSPACE_KEY`) and the tabs it held, each
 *    tagged with its node id. The session can be older than the tree: another
 *    device can have closed, moved or navigated a tab since. So
 *    {@link SvalRestore.restore} holds each window's tabs to the tree. A tab
 *    whose node is in the workspace is kept, and pointed at the node's
 *    address if it has not loaded yet (`matchNode`); a node with no tab gets
 *    one; and the panel lets the rest go (`releaseTabsOutside`), the observer
 *    closing a tab whose node is gone.
 *
 * 2. *Sval materialises a tab from a node with `SessionStore.setTabState`*,
 *    the same public call `undoCloseTab` uses: create the tab with
 *    `createLazyBrowser`, then hand it a one-entry history. `restoreTab` puts
 *    a lazy tab in `TAB_LAZY_STATES` and restores it for real when its
 *    browser is inserted, which is when the user selects it, so restored tabs
 *    cost `<tab>` elements and no content processes. The node id travels in
 *    the state's `extData`, where `setCustomTabValue` keeps it, so the tab
 *    comes back already tagged and `SvalTabs` recognises it instead of filing
 *    it as a stray.
 *
 * Nothing here reads a clock or mints an id: restoration creates no nodes.
 */

import { SvalFirefox } from "moz-src:///browser/components/sval/SvalFirefox.sys.mjs";
import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { SvalTabs } from "moz-src:///browser/components/sval/SvalTabs.sys.mjs";
import {
  TAB,
  descendantIds,
} from "moz-src:///browser/components/sval/SvalTree.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  SvalHomePage: "moz-src:///browser/components/sval/SvalHomePage.sys.mjs",
  SvalPreferences: "moz-src:///browser/components/sval/SvalPreferences.sys.mjs",
  refusedAddress:
    "moz-src:///browser/components/sval/SvalSyncableAddress.sys.mjs",
  SvalWorkspaceJar:
    "moz-src:///browser/components/sval/SvalWorkspaceJar.sys.mjs",
  E10SUtils: "resource://gre/modules/E10SUtils.sys.mjs",
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
});

/**
 * The principal a tree tab's address loads with, serialized, or null for an
 * address it may not load.
 *
 * An address marked `local` was written on this device and is read from
 * this device's own copy alone (decision 1372), so it restores as the user's
 * own choice of the tab, as Sval's home and settings pages do and as
 * Firefox's session restore reopens a tab with the principal that opened it.
 * The tree records no principal and not which device wrote any other
 * address, so such an address opens only where a web page could navigate
 * (`checkLoadURIWithPrincipal` with a null principal, which refuses local
 * files, browser pages, `view-source:` and script, and top-level data:
 * because it inherits its opener's principal). The gate is asked as a web
 * page because a URL's own origin may always load itself, file: and chrome:
 * included. An address that passes loads with a content principal for its
 * own origin in the tab's jar, so its first load is same-site, as the page
 * reloading itself would be.
 *
 * @param {object} content The node's content.
 * @param {string} content.url Its address.
 * @param {boolean} [content.local] Its `local` mark.
 * @param {number} userContextId The jar the tab opens in.
 * @returns {?string}
 */
function restorePrincipal({ url, local }, userContextId) {
  const opens = opensAs({ url, local }, userContextId);
  if (opens === SYSTEM) {
    return lazy.E10SUtils.SERIALIZED_SYSTEMPRINCIPAL;
  }
  return (
    opens &&
    lazy.E10SUtils.serializePrincipal(
      Services.scriptSecurityManager.createContentPrincipal(opens, {
        userContextId,
      })
    )
  );
}

/** What {@link opensAs} answers for an address that opens as the user's own. */
const SYSTEM = Symbol("system");

/**
 * {@link restorePrincipal}'s judgement without the principal it makes, for
 * a reader that asks only whether the address opens: the panel asks it of
 * every tab row not loaded on each redraw.
 *
 * @param {object} content As {@link restorePrincipal} takes it.
 * @param {string} content.url Its address.
 * @param {boolean} [content.local] Its `local` mark.
 * @param {number} userContextId
 * @returns {nsIURI|SYSTEM|null} the address to open with its own origin's
 *   principal, {@link SYSTEM}, or null for one that may not open.
 */
function opensAs({ url, local }, userContextId) {
  if (
    local === true ||
    lazy.SvalHomePage.isHomePage(url) ||
    lazy.SvalPreferences.isPreferencesURL(url)
  ) {
    return SYSTEM;
  }
  const ssm = Services.scriptSecurityManager;
  try {
    const uri = Services.io.newURI(url);
    ssm.checkLoadURIWithPrincipal(
      ssm.createNullPrincipal({ userContextId }),
      uri,
      ssm.DISALLOW_INHERIT_PRINCIPAL |
        ssm.DISALLOW_SCRIPT |
        ssm.DONT_REPORT_ERRORS
    );
    return uri;
  } catch {
    return null;
  }
}

/**
 * The address and principal a tree node's tab restores with, or why it may
 * not restore: another device wrote it at an address that stays on a device
 * (`refusedAddress`), or no web page could open it (`restorePrincipal`).
 * Such a node keeps its address in the tree.
 *
 * @param {object} node A tab node from the document.
 * @param {number} userContextId The jar of the node's workspace.
 * @returns {{url: string, principal: string} | {refused: string}}
 */
function restoreOf(node, userContextId) {
  const content = node.content ?? {};
  if (lazy.refusedAddress(content)) {
    return { refused: "another device wrote its address" };
  }
  const url = content.url || "about:blank";
  const principal = restorePrincipal(
    { url, local: content.local },
    userContextId
  );
  if (!principal) {
    return { refused: "its address is not a web page's" };
  }
  return { url, principal };
}

/**
 * The one-entry session state that restores a tree node's tab, or null for a
 * node whose tab may not restore (`restoreOf`).
 *
 * @param {object} node A tab node from the document.
 * @param {string} id The node's id.
 * @param {number} userContextId The jar of the node's workspace.
 * @returns {?object}
 */
function tabState(node, id, userContextId) {
  const restore = restoreOf(node, userContextId);
  if (restore.refused) {
    SvalLog.info(`a tab was not restored: ${restore.refused}`);
    return null;
  }
  const { url, principal } = restore;
  return {
    entries: [
      {
        url,
        title: node.content?.name || url,
        triggeringPrincipal_base64: principal,
      },
    ],
    index: 1,
    userContextId,
    extData: { [SvalTabs.NODE_ID_KEY]: id },
  };
}

/**
 * Every tab a window has announced with `TabOpen` since Sval started watching
 * it (`SvalRestore.watchWindow`). The tab a window is created with is the one
 * tab no `TabOpen` announces (`tabbrowser.js`'s `_setupInitialBrowserAndTab`),
 * so a tab in here is one somebody opened: the user, a page, or the session
 * store restoring one.
 *
 * @type {WeakSet<object>}
 */
const announced = new WeakSet();

/**
 * How a real chrome window is read and written. Swappable as a whole so the
 * ordering and matching logic above it is testable without a browser window.
 */
const chromeRestoreAdapter = {
  tabsOf(window) {
    return Array.from(window.gBrowser.tabs);
  },

  nodeId(tab) {
    return (
      lazy.SessionStore.getCustomTabValue(tab, SvalTabs.NODE_ID_KEY) || null
    );
  },

  /**
   * Opens a tab for one tree node, tagged with that node's id and loading
   * nothing until it is selected.
   *
   * The two calls are one unit: `addTrustedTab` with `createLazyBrowser` gives
   * a tab whose browser has never been instantiated, and `setTabState` is what
   * gives that tab its URL, its title and its node id. Loading the URL and
   * then tagging would start a content process per restored tab and lose the
   * title until the page answered.
   *
   * @param {DOMWindow} window The chrome window to open in.
   * @param {object} node A tab node from the document.
   * @param {string} id The node's id.
   * @param {number} [userContextId] The jar of the node's workspace
   *   (`SvalWorkspaceJar`). The browser takes its origin attributes when the
   *   tab is made, so the jar is chosen here, never changed after.
   * @returns {?object} the new tab, or null for a node whose address a tab
   *   may not restore (`restorePrincipal`), or that another device wrote at
   *   an address that stays on a device (`refusedAddress`). It keeps its
   *   address in the tree and gets no tab here.
   */
  openRestoredTab(window, node, id, userContextId = 0) {
    const state = tabState(node, id, userContextId);
    if (!state) {
      return null;
    }
    const tab = window.gBrowser.addTrustedTab(null, {
      createLazyBrowser: true,
      skipAnimation: true,
      skipLoad: true,
      skipBackgroundNotify: true,
      bulkOrderedOpen: true,
      userContextId,
    });
    lazy.SessionStore.setTabState(tab, state);
    return tab;
  },

  /**
   * Points a tab that has not loaded its page at the address its node holds,
   * when the two differ. The session that brought the tab back can predate a
   * navigation another device made in the tab since, and the tree is what
   * a tab shows (decision 0050). A tab that has loaded a page is the user's
   * to navigate, and is left as it is, as is one whose node's address no tab
   * may restore (`tabState`).
   *
   * @param {DOMWindow} window The tab's window.
   * @param {object} tab A tab carrying `id`.
   * @param {object} node The node, as the document holds it.
   * @param {string} id The node's id.
   * @param {number} userContextId The jar of the node's workspace.
   * @returns {boolean} whether the tab was pointed at the node's address.
   */
  matchNode(window, tab, node, id, userContextId) {
    const loaded =
      !SvalFirefox.isLazy(tab) && !lazy.SessionStore.isTabRestoring(tab);
    const url = node.content?.url || "about:blank";
    if (loaded || SvalTabs.openingUrl(tab) === url) {
      return false;
    }
    const state = tabState(node, id, userContextId);
    if (!state) {
      return false;
    }
    lazy.SessionStore.setTabState(tab, state);
    return true;
  },

  /**
   * Opens a tab for each of `entries`, as {@link openRestoredTab} does for
   * one, and puts them in the strip together, as Firefox's own restore does
   * (`createTabsForSessionRestore`). Inserted one at a time, each tab makes
   * tabbrowser walk every tab already in the strip (`#insertTabAtIndex`).
   *
   * @param {DOMWindow} window The chrome window to open in.
   * @param {Array<{node: object, id: string}>} entries Tab nodes from the
   *   document, with their ids.
   * @param {number} userContextId The jar of the nodes' workspace.
   * @returns {Array<?object>} each entry's tab, or null for one
   *   {@link openRestoredTab} would open none for.
   */
  openRestoredTabs(window, entries, userContextId) {
    const states = entries.map(({ node, id }) =>
      tabState(node, id, userContextId)
    );
    const opening = states.filter(Boolean);
    const tabs = opening.length
      ? window.gBrowser.createTabsForSessionRestore(true, 0, opening, [])
      : [];
    let next = 0;
    return states.map(state => {
      if (!state) {
        return null;
      }
      const tab = tabs[next++];
      lazy.SessionStore.setTabState(tab, state);
      return tab;
    });
  },

  /**
   * Whether `tab` is the empty tab a window opens with. It is internal to
   * startup: once the workspace has tabs of its own, it is closed and the user
   * lands on those, so it is never a screen they keep. Filing it would put a
   * fresh "New Tab" in the tree on every launch (spec §10.4).
   *
   * **Only the tab the window was created with can be debris** (`announced`).
   * Any other blank tab was opened by somebody, such as the user's new tab in
   * a window `undoCloseWindow` has just reopened, which can open before this
   * window's restore begins.
   *
   * The home page counts as blank here, so a startup tab showing it is closed
   * once the workspace has tabs of its own to show. With none, it stays and is
   * filed as the workspace's tab (`SvalTabs.sys.mjs`'s `isBlank`), so a window
   * always shows the home page as a real tab and a launch never adds a second.
   *
   * `isBlankPageURL` is Firefox's own definition of the set (`about:blank`,
   * `about:home`, whatever `browser.newtabpage.url` resolves to, and the
   * blank-tab document), read off the window so it stays that definition when
   * upstream changes it. The window is reached through `documentGlobal`, the
   * ChromeOnly `Node` attribute `SessionStore` itself uses on a tab.
   * `ownerGlobal` is `undefined` on a `<tab>`.
   *
   * **A lazy tab is never debris**, and that check comes first: `canGoBack` is
   * one of the properties `_createLazyBrowser` stubs with a getter that
   * *instantiates the browser*, so asking a restored tab about its history
   * would spin up a content process for every restored tab. A tab with no
   * `linkedPanel` has never had a browser, so it has no history.
   *
   * @param {object} tab A Firefox tab.
   * @returns {boolean}
   */
  isDebris(tab) {
    if (SvalFirefox.isLazy(tab) || announced.has(tab)) {
      return false;
    }
    // A tab on its way to a page is no blank tab, though it reads as one
    // until the page commits: a typed address, or a page a window opens on
    // (Sval's `_handleURIToLoad`), waits as `userTypedValue`, and a page a
    // popup's window opens with, an agent's included, has the page that opened
    // it as its `crossGroupOpener`. A startup tab loading with neither is
    // loading the window's default page, the home page or `about:blank`, and
    // is blank whether or not that load has committed; its `currentURI` stays
    // the initial `about:blank` until it does.
    const browser = tab.linkedBrowser;
    if (
      browser?.webProgress?.isLoadingDocument &&
      (browser.userTypedValue || browser.browsingContext?.crossGroupOpener)
    ) {
      return false;
    }
    const spec = browser?.currentURI?.spec ?? "";
    return (
      tab.documentGlobal.isBlankPageURL(spec) && SvalFirefox.hasNoHistory(tab)
    );
  },

  /**
   * Whether `window` was opened on a page of its own, such as a link from
   * another app, which its startup tab holds and still reads as blank while
   * it loads. Firefox's session restore asks the same before it overwrites a
   * window's tabs (`SessionStore._isCmdLineEmpty`): a first argument other
   * than the one `nsIBrowserHandler.defaultArgs` gives a new window. A blank
   * page, as an agent's window opens on, is no page of its own.
   *
   * @param {DOMWindow} window A browser window.
   * @returns {boolean}
   */
  openedOnPage(window) {
    // An nsISupportsString reads as its data, as `_isCmdLineEmpty` reads it.
    const opened = window.arguments?.[0]?.toString() ?? "";
    return (
      !!opened &&
      !window.isBlankPageURL(opened) &&
      opened !==
        Cc["@mozilla.org/browser/clh;1"].getService(Ci.nsIBrowserHandler)
          .defaultArgs
    );
  },

  removeTab(window, tab) {
    window.gBrowser.removeTab(tab, { animate: false });
  },

  /**
   * Closes a tab whose node another tab carries, so Firefox's
   * recently-closed list offers nothing that would come back as a second tab
   * for the node.
   *
   * @param {DOMWindow} window The tab's window.
   * @param {object} tab A Firefox tab.
   */
  closeDuplicate(window, tab) {
    window.gBrowser.removeTab(tab, { animate: false, skipSessionStore: true });
  },

  /**
   * The tabs other windows keep loaded, hidden, for a workspace they no
   * longer show (`SvalFirefox.hideForWorkspace`), by node id.
   *
   * @param {DOMWindow} window The window being filled.
   * @returns {Map<string, object>}
   */
  keptElsewhere(window) {
    const kept = new Map();
    for (const other of Services.wm.getEnumerator("navigator:browser")) {
      if (other === window || other.closed || !other.gBrowser) {
        continue;
      }
      for (const tab of other.gBrowser.tabs) {
        const id = SvalFirefox.isHiddenForWorkspace(tab) && this.nodeId(tab);
        if (id) {
          kept.set(id, tab);
        }
      }
    }
    return kept;
  },

  adoptKept(window, tab) {
    SvalFirefox.adoptKept(window, tab);
  },

  selectTab(window, tab) {
    window.gBrowser.selectedTab = tab;
  },

  closedUnwatched(window) {
    return SvalTabs.closedUnwatched(window);
  },

  /**
   * Resolves once Firefox has finished with its own session, so the set of
   * tabs restoration sees is final. A tab Firefox was still about to restore
   * would otherwise look absent and be opened a second time.
   */
  sessionSettled() {
    return lazy.SessionStore.promiseAllWindowsRestored;
  },
};

export const SvalRestore = {
  /**
   * Starts recording which of `window`'s tabs were opened (`announced`), from
   * before its first tab exists, so that the tab it was created with is the
   * only one {@link restore} can take for debris.
   *
   * @param {DOMWindow} window A browser window.
   */
  watchWindow(window) {
    window.addEventListener("TabOpen", event => announced.add(event.target));
  },

  /**
   * Whether some window has already restored this session's tabs. It is
   * per process because restoration happens once at launch: the second window
   * the user opens must not open the tree's tabs again.
   */
  _claimed: false,

  /**
   * Whether a tab may open on this device for `node`, which the panel says
   * on a row whose tab is not loaded.
   *
   * @param {object} node A tab node from the document.
   * @param {number} userContextId The jar of the node's workspace.
   * @returns {boolean}
   */
  opensHere(node, userContextId) {
    const content = node.content ?? {};
    return (
      !lazy.refusedAddress(content) &&
      !!opensAs(
        { url: content.url || "about:blank", local: content.local },
        userContextId
      )
    );
  },

  /**
   * Opens a tab for one node, lazily, and shows it.
   *
   * This is §10.4's materialisation, the same call restoration makes: a node
   * the panel holds but this window has no `<browser>` for gets one when the
   * user goes to it, with the node id already on the tab so the observer
   * recognises it and files no second node. Selecting the tab instantiates
   * the browser and loads the page; until then it costs a `<tab>` alone.
   *
   * @param {DOMWindow} window The chrome window to open in.
   * @param {object} node The tab node, as the document holds it.
   * @param {string} id The node's id.
   * @param {number} [userContextId] The jar of the node's workspace.
   * @param {object} [adapter] How the window is written. Defaults to the real one.
   * @returns {?object} the new tab, or null as `openRestoredTab` gives it.
   */
  materialise(
    window,
    node,
    id,
    userContextId = 0,
    adapter = chromeRestoreAdapter
  ) {
    const tab = this.open(window, node, id, userContextId, adapter);
    if (tab) {
      window.gBrowser.selectedTab = tab;
    }
    return tab;
  },

  /**
   * Opens a tab for one node, lazily, in the jar `userContextId` names, and
   * leaves the selection alone.
   *
   * @param {DOMWindow} window The chrome window to open in.
   * @param {object} node The tab node, as the document holds it.
   * @param {string} id The node's id.
   * @param {number} userContextId The jar of the node's workspace.
   * @param {object} [adapter] How the window is written. Defaults to the real one.
   * @returns {?object} the new tab, or null as `openRestoredTab` gives it.
   */
  open(window, node, id, userContextId, adapter = chromeRestoreAdapter) {
    return adapter.openRestoredTab(window, node, id, userContextId);
  },

  /**
   * Moves into `window` every tab another window keeps loaded, hidden, for
   * `workspaceId` (`SvalFirefox.hideForWorkspace`), each with its page, its
   * typed text and any call or picture-in-picture it carries
   * (`gBrowser.adoptTab`). A workspace's tabs are in the one window that
   * shows it (spec §10.7), so the window that starts showing a workspace, or
   * that a kept tab's node moves to, takes them then. A kept tab therefore
   * only ever belongs to a workspace no window shows.
   *
   * A window the session reopens can hold its own tab for a node another
   * window keeps, from the state the session saved when it closed. The kept
   * tab is the live one, and the window's own tab closes as soon as the kept
   * one arrives, before anything files the two as a node and its copy. A tab
   * carried here keeps its node when the window's observer attaches
   * (`isCarried`).
   *
   * @param {DOMWindow} window The window that shows `workspaceId`.
   * @param {object} options
   * @param {object} options.nodes The document's nodes, read just now.
   * @param {string} options.workspaceId
   * @param {object} [options.adapter] As {@link restore} takes it.
   */
  takeKept(window, { nodes, workspaceId, adapter = chromeRestoreAdapter }) {
    const kept = adapter.keptElsewhere?.(window) ?? new Map();
    if (!kept.size) {
      return;
    }
    const own = new Map();
    for (const tab of adapter.tabsOf(window)) {
      const id = adapter.nodeId(tab);
      if (id) {
        own.set(id, tab);
      }
    }
    for (const id of descendantIds(nodes, workspaceId)) {
      if (nodes[id]?.kind === TAB && kept.has(id)) {
        adapter.adoptKept(window, kept.get(id));
        if (own.has(id)) {
          adapter.closeDuplicate(window, own.get(id));
        }
      }
    }
  },

  /**
   * {@link restore}, but only for the first window that asks.
   *
   * @param {DOMWindow} window The chrome window to fill.
   * @param {object} options As {@link restore}.
   * @returns {Promise<object|null>} the restore result, or null if another
   *   window has already restored.
   */
  async restoreOnce(window, options) {
    if (this._claimed) {
      return null;
    }
    this._claimed = true;
    return this.restore(window, options);
  },

  /**
   * Opens this window's tabs from the tree.
   *
   * Runs **before** `SvalTabs.attach`, so a restored tab is no stray: every
   * tab this creates already carries its node's id, so the observer's
   * reconciliation recognises it and files nothing.
   *
   * A workspace switch (spec §10.7) calls this with the observer already
   * attached, and a materialised tab is still filed once: `openRestoredTab`
   * sets the node id the instant `addTrustedTab` returns, before the
   * observer's queued reconciliation of that tab's `TabOpen` can run.
   *
   * @param {DOMWindow} window The chrome window to fill.
   * @param {object} options
   * @param {object} options.engine A `SvalEngine`, used read-only: restoration
   *   creates no nodes and deletes none.
   * @param {string} options.workspaceId The workspace whose tabs this window
   *   shows.
   * @param {object} [options.adapter] How the window is read and written.
   *   Defaults to the real one.
   * @param {boolean} [options.closeDebris] Whether to close the empty tab the
   *   window opened with once there is something of the user's to show. True in
   *   production. A browser-chrome test turns it off because the window it runs
   *   in *is* a window whose only tab is the empty one, so restoration would
   *   close the harness's own tab; `test/xpcshell/test_sval_restore.js` is where
   *   the closing is asserted.
   * @param {Function} [options.show] Given `wanted`, the id of the tab to
   *   select. A launch passes the tab this device last looked at; an id that
   *   names no tab of the workspace selects nothing. Not called for a window
   *   opened on a page of its own.
   * @returns {Promise<object>} `{ wanted, opened, adopted, closed }`: every
   *   tab node of the workspace in the order the panel draws it, the ones this
   *   call opened a tab for, the ones that were already open, here or kept
   *   in another window, and were matched by id, and how many empty tabs it
   *   closed.
   *
   *   A window that closes while this waits gets none of it, and the
   *   lists are empty.
   *
   *   `wanted` is what a workspace switch needs: the set of tabs this window
   *   is to hold is the complement of the set it must let go of, and the order
   *   is which one to show. It is the one answer to "what is in this
   *   workspace", so the panel does not derive its own.
   */
  async restore(window, options) {
    const adapter = options.adapter ?? chromeRestoreAdapter;
    // A window closed while this waits has no tab strip left to fill:
    // tabbrowser fails to make a tab in it (`aWindow.docShell` is null).
    const nothing = { wanted: [], opened: [], adopted: [], closed: 0 };
    await adapter.sessionSettled();
    if (window.closed) {
      return nothing;
    }

    const nodes = (await options.engine.tree()).nodes ?? {};
    if (window.closed) {
      return nothing;
    }
    // Depth-first in sibling order, which is the order the panel draws and the
    // same order on every device, because sibling order is the shared
    // fractional index. Groups are walked through rather than around: a
    // workspace's children are one ordered list of tabs and groups, and
    // nothing here sorts by kind. A tab closed in this window before its
    // observer attached is not wanted: its node is about to go.
    const gone = adapter.closedUnwatched?.(window) ?? new Set();
    const wanted = descendantIds(nodes, options.workspaceId).filter(
      id => nodes[id]?.kind === TAB && !gone.has(id)
    );

    // Taken before anything opens, so no node gets a second tab here.
    this.takeKept(window, {
      nodes,
      workspaceId: options.workspaceId,
      adapter,
    });

    // Matching is by the node id the tab carries. Two nodes can hold the same
    // URL, and a tab whose page has since navigated still belongs to the node
    // that opened it.
    const open = new Map();
    for (const tab of adapter.tabsOf(window)) {
      const id = adapter.nodeId(tab);
      if (id) {
        open.set(id, tab);
      }
    }

    // Every tab of the workspace opens in the workspace's jar (isolated
    // workspaces spec §4), so restoring needs nothing stored per tab.
    const userContextId = lazy.SvalWorkspaceJar.userContextIdFor(
      nodes,
      options.workspaceId
    );
    // A window opened on a page of its own keeps that page on screen, as
    // Firefox's restore keeps it (`openedOnPage`), so it asks `show` nothing.
    const onPage = adapter.openedOnPage?.(window) ?? false;
    const showId = onPage ? null : (options.show?.(wanted) ?? null);
    const opened = [];
    const adopted = [];
    const opening = [];
    for (const id of wanted) {
      const tab = open.get(id);
      if (tab) {
        adopted.push(id);
        adapter.matchNode?.(window, tab, nodes[id], id, userContextId);
      } else {
        opening.push({ node: nodes[id], id });
      }
    }
    const made = adapter.openRestoredTabs(window, opening, userContextId);
    opening.forEach(({ id }, i) => {
      if (made[i]) {
        open.set(id, made[i]);
        opened.push(id);
      }
    });
    let first = null;
    let shown = null;
    for (const id of wanted) {
      const tab = open.get(id);
      if (!tab) {
        continue;
      }
      first ??= tab;
      if (id === showId) {
        shown = tab;
      }
    }

    // The tab to show is selected before the empty tab goes, so the empty
    // tab's close is not what picks the tab the user sees. Selecting a lazy tab
    // is what loads it, so a launch loads that one page and no neighbour first.
    // Firefox's own session restore does the same: `restoreWindow` selects the
    // window's recorded `selected` tab and replaces the tab it started with.
    if (shown) {
      adapter.selectTab(window, shown);
    }

    // The empty tab only goes once there is something to go to. A launch with
    // an empty tree keeps it, since Firefox has no window without tabs, and
    // `SvalTabs` files it as the workspace's tab unless it is a bare
    // `about:blank` (`isBlank` there). Without `show`, closing the selected
    // empty tab is Firefox's cue to select its neighbour, which is one of the
    // tabs just restored.
    let closed = 0;
    if (first && !onPage && (options.closeDebris ?? true)) {
      for (const tab of adapter.tabsOf(window)) {
        if (tab !== first && !adapter.nodeId(tab) && adapter.isDebris(tab)) {
          adapter.removeTab(window, tab);
          closed++;
        }
      }
    }

    return { wanted, opened, adopted, closed };
  },
};
