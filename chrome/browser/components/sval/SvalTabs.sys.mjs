/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The bridge from one chrome window's tab strip to the synced tree: Firefox's
 * open tabs are a view of Sval's document (spec §10.4), and this is what keeps
 * the view and the model in step while the user works.
 *
 * Firefox's own events carry everything: `TabOpen`, `TabClose`, `TabMove`,
 * `TabSelect` and `TabAttrModified` all bubble from the tab to
 * `gBrowser.tabContainer`, a tabs progress listener reports each page a tab
 * commits, and `pagetitlechanged` each title its page sets
 * (`browser/components/tabbrowser/content/tabbrowser.js`).
 *
 * **A tab's content (its url and name) is written in two places only**
 * (decision 0050): the acts Sval files, such as an open, and a page the tab
 * commits, with the title that page sets. Nothing reads a tab's address back
 * on any other event. A load refused, cancelled or still restoring, a
 * discard, a blank placeholder and a hidden page commit nothing, so they
 * write nothing, and the node keeps the page the tab is for. The tree is
 * what a launch restores from, so a node follows the pages the user goes to,
 * and never a blank page they did not.
 *
 * The link between a Firefox tab and its tree node is a node id stored on the
 * tab through `SessionStore.setCustomTabValue`, which persists across restarts
 * and across a tab being dragged to another window. That API stores strings
 * only, so the id is a bare UUID string.
 *
 * **Every screen the viewport shows is a filed tab** (spec §10.4): a web page,
 * an error page, the home page, settings, `about:addons`, `about:config`, an
 * `about:blank` the user opened. With no tab strip, the panel is the only tab
 * surface, so a tab without a node is a screen the user can see and cannot
 * reach or close. The only tabs left unfiled are blank tabs nobody asked for
 * and nobody is shown (see `isBlank`), a Quick Peek's page, which the panel draws
 * over the tab it came from (`SvalQuickPeekTab`), and a pin's page, which its icon
 * in the pins row reaches (`SvalPinTab`).
 */

import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";
import {
  MEDIA_CHANGED_EVENT,
  SvalFirefox,
} from "moz-src:///browser/components/sval/SvalFirefox.sys.mjs";
import {
  SvalLog,
  describeError,
} from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { SvalSerialQueue } from "moz-src:///browser/components/sval/SvalSerialQueue.sys.mjs";
import { SvalClock } from "moz-src:///browser/components/sval/SvalClock.sys.mjs";
import { latestNodes } from "moz-src:///browser/components/sval/SvalTreeSnapshot.sys.mjs";
import { syncableAddress } from "moz-src:///browser/components/sval/SvalSyncableAddress.sys.mjs";
import { SvalTitleHold } from "moz-src:///browser/components/sval/SvalTitleHold.sys.mjs";
import { isQuickPeek } from "moz-src:///browser/components/sval/SvalQuickPeekTab.sys.mjs";
import { isPin } from "moz-src:///browser/components/sval/SvalPinTab.sys.mjs";
import {
  moveIntoTarget,
  splitShapeOps,
} from "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs";
import {
  SPLIT,
  TAB,
  childrenByParent,
  descendantIds,
  isUntouchedWorkspace,
  isWithin,
  workspaceIds,
  workspaceOfNode,
} from "moz-src:///browser/components/sval/SvalTree.sys.mjs";
import {
  sharesOf,
  splitChanges,
  splitWrites,
  widthsOf,
} from "moz-src:///browser/components/sval/SvalSplits.sys.mjs";

/**
 * Notified as a tab's node is written into the document, with data
 * `{"id", "parent"}` as JSON: the node and the workspace or group it is
 * filed under.
 */
export const TAB_FILED_TOPIC = "sval-tab-filed";

const lazy = {};

/**
 * Where a tab filed beside the children of `parent` goes: `parent`, unless it
 * is a split, which a tab joins only by the user splitting it (split-view
 * spec §6.1), and then the split's own parent.
 *
 * @param {object} nodes The document's nodes, by id.
 * @param {string|null|undefined} parent A node id.
 * @returns {string|null|undefined}
 */
function placeBeside(nodes, parent) {
  return nodes[parent]?.kind === SPLIT
    ? (nodes[parent].placement?.parent ?? null)
    : parent;
}

/**
 * Deletes from the document each of `ids` it still holds, with everything
 * inside it, and forgets when each of those was last active. The engine's
 * `remove` takes the whole subtree in one call, so the contents it deletes
 * are the ones the document holds, not the ones `nodes` last showed. The
 * removals are one batch, with what a split they close a pane of needs to
 * stay in shape (`splitShapeOps`).
 *
 * @param {object} engine A `SvalEngine`.
 * @param {object|null} settings A `SvalLocalSettings` store, or null.
 * @param {object} nodes The document's nodes, by id, as last read.
 * @param {string[]} ids The node ids to delete, none inside another.
 */
async function removeNodes(engine, settings, nodes, ids) {
  const present = ids.filter(id => nodes[id]);
  const ops = [
    ...present.map(id => ({ kind: "remove", id })),
    ...splitShapeOps(nodes, present),
  ];
  if (ops.length) {
    await engine.mutate({ kind: "batch", ops, now: SvalClock.now() });
  }
  for (const id of ids) {
    for (const each of [id, ...descendantIds(nodes, id)]) {
      settings?.forgetLastActive(each);
    }
  }
}

ChromeUtils.defineESModuleGetters(lazy, {
  SvalWindowWorkspace:
    "moz-src:///browser/components/sval/SvalWindowWorkspace.sys.mjs",
  isPeek: "moz-src:///browser/components/sval/SvalPeek.sys.mjs",
  REOPENED_DETAIL: "moz-src:///browser/components/sval/SvalPeek.sys.mjs",
  SvalRestore: "moz-src:///browser/components/sval/SvalRestore.sys.mjs",
  SvalWebDriver: "moz-src:///browser/components/sval/SvalWebDriver.sys.mjs",
  SvalWorkspaceJar:
    "moz-src:///browser/components/sval/SvalWorkspaceJar.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  ReaderMode: "moz-src:///toolkit/components/reader/ReaderMode.sys.mjs",
  releaseAgentTab:
    "moz-src:///browser/components/sval/SvalAgentTabRegistry.sys.mjs",
  inheritUserHistory:
    "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs",
  isUserInControl:
    "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs",
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
  takeControl: "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs",
  windowForWorkspace:
    "moz-src:///browser/components/sval/SvalAgentTabs.sys.mjs",
});

/**
 * The session-store key every tab's node id is filed under. Namespaced because
 * the custom-value store is one flat map shared by every consumer in the
 * browser.
 */
const NODE_ID_KEY = "sval-node-id";

/**
 * The session-store key a closing tab's node's parent is filed under, so the
 * closed tab Firefox keeps carries where it was (spec §5.4: the recently-closed
 * list is how a closed tab comes back, and the document keeps no record).
 */
const FORMER_PARENT_KEY = "sval-former-parent";

/**
 * The session-store key a closing tab's workspace is filed under, so undo
 * close tab reopens a closed tab only into a window showing that workspace
 * (`reopenClosedTab`).
 */
const FORMER_WORKSPACE_KEY = "sval-former-workspace";

/**
 * How long a burst of tab activity is allowed to keep coalescing before a sync
 * pass runs. Every pass that changes the document publishes a file into the
 * user's cloud folder, so a burst of tabs opening must cost one file.
 */
const DEFAULT_DEBOUNCE_MS = 750;

/**
 * How long this device waits between passes when nothing local has happened.
 *
 * A poll, because nothing reachable from chrome notifies on a file appearing:
 * `IOUtils.webidl` exposes no watch call and `dom/chrome-webidl` has no
 * `FileSystemObserver`. A watcher would be late anyway, since a peer's file
 * appears locally when the provider's client fetches it (spec §6.4).
 *
 * A pass costs one directory listing plus one small read per device, so five
 * seconds is cheap. It sits clear of `DEFAULT_DEBOUNCE_MS`, so a burst of
 * local activity publishes and settles inside one interval, and it is the
 * same order as the latency the provider adds.
 */
const DEFAULT_POLL_MS = 5000;

/**
 * How long a page stays loaded in a workspace no window shows, counted from
 * when its window left the workspace: long enough that coming back from a
 * meeting finds the workspace as it was, short enough that a day's
 * abandoned workspaces give their memory back (spec §10.7).
 */
export const HIDDEN_WORKSPACE_UNLOAD_MS = 3 * 60 * 60 * 1000;

/** How often a window looks for pages hidden that long. */
const IDLE_SWEEP_MS = 10 * 60 * 1000;

/**
 * How long a page asking to stay has to say whether it may unload before it
 * is kept, as one that holds work (`SvalFirefox.pageAllowsUnload`).
 */
export const PAGE_ANSWER_MS = 10 * 1000;

/**
 * How long a tab must stay the shown tab of the window the user is in, after
 * the user selects it or clicks or types in its page, for that to count as a
 * use (idle-tab archive spec §4.1). A tab passed on the way to another counts
 * for nothing.
 */
const USE_DWELL_MS = 2500;

/**
 * The attribute marking the tab `SvalTabObserver.openUnfiledTab` opens so that
 * a window showing an empty workspace has a tab to be a window with.
 *
 * A tab carrying no node belongs to no workspace and no switch releases it, so
 * Sval takes this one back while it is still blank, or it would stay in the
 * window with no row to reach it by.
 *
 * Blankness alone would also match tabs Sval did not open, such as the
 * window's startup tab or one a harness holds, so Sval closes only what it
 * marked. A tab the user goes somewhere in is filed by the content path and
 * so stops being untagged, which keeps this from closing anything real.
 */
const SVAL_UNFILED_ATTRIBUTE = "sval-unfiled";

/**
 * Set on the destination tab of a tab moving between windows, and consumed by
 * the first reconciliation of it.
 *
 * It tells a tab the user carried into a window from a tab Firefox handed
 * back out of its recently-closed list, and `#reconcile` needs the
 * difference: only the second may reuse the node id deleted when the tab
 * closed. Reusing it for the first undoes a deletion somebody meant, under
 * this device and with a fresh timestamp, so it propagates to every peer
 * (spec §5.4).
 *
 * It is marked on the close side, from `TabClose`'s `adoptedBy`, where the
 * node id crosses: SessionStore's `TabClose` handler calls
 * `moveCustomTabValue` onto `adoptedBy`, the destination tab
 * (`swapBrowsersAndCloseOther` passes `adoptedByTab: aOurTab`). A drag out
 * goes through `replaceTabWithWindow` and `swapBrowsersAndCloseOther`, which
 * hand the tab to the new window's initial tab (`gBrowserInit`'s
 * `_tabToAdopt`) with no `TabOpen` at all. It is marked on the open side too,
 * from `TabOpen`'s `adoptedTab`, which `adoptTab` passes: a window's last tab
 * moving out closes its window with no `TabClose` (`_beginRemoveTab` returns
 * before dispatching it when `adoptedByTab` closes the window).
 *
 * Firefox's recently-closed list raises neither: `undoCloseTab` restores
 * through `addTrustedTab` with no `eventDetail`, in whatever window is asked,
 * so the distinction holds by construction.
 */
const SVAL_ADOPTED_ATTRIBUTE = "sval-adopted";

/**
 * The ids of Firefox's new-tab commands. See `watchNewTabCommand`.
 */
const NEW_TAB_COMMANDS = new Set([
  "cmd_newNavigatorTab",
  "cmd_newNavigatorTabNoEvent",
]);

/**
 * The tab events this observer listens for, all of which bubble from the tab to
 * `gBrowser.tabContainer`. `TabSplitViewActivate` is a split coming on
 * screen, raised on the container. `TabAttrModified` reports a tab's favicon and
 * whether it is loaded. `TabBrowserDiscarded` is a tab unloaded, by the user or
 * to save memory: `discardBrowser` sets `discarded` without a
 * `TabAttrModified` for it. `SSTabRestoring` is how a tab Sval restored without loading it announces that
 * it has started to load. `SSTabCustomValuesRestored`
 * (`sessionstore-tab-values-restored.patch`) is the session store saying it
 * has just set a tab's custom values from the state it restored, the moment a
 * copy first carries its original's node id. `TabHide` and `TabShow` are an
 * extension hiding a tab (`tabs.hide`) or showing it again, or a tab a switch
 * kept loaded and hid being shown.
 */
const EVENTS = [
  "TabOpen",
  "TabClose",
  "TabMove",
  "TabSelect",
  "TabAttrModified",
  "TabBrowserDiscarded",
  "TabHide",
  "TabShow",
  "SSTabRestoring",
  "SSTabCustomValuesRestored",
  "TabSplitViewActivate",
  MEDIA_CHANGED_EVENT,
];

/**
 * The address of a tab's session state's current entry, or "" when it has
 * none. A state's `index` counts entries from 1; a state without one is at
 * its last.
 *
 * @param {object|null} state
 * @returns {string}
 */
function urlOfState(state) {
  const entries = state?.entries;
  if (!Array.isArray(entries) || !entries.length) {
    return "";
  }
  const index = Number.isInteger(state.index) ? state.index : entries.length;
  return entries[index - 1]?.url ?? "";
}

/**
 * The address the session state of `tab` names, or "" when it names none.
 *
 * Only asked of a tab being opened by a restore (`openingUrl`), which is why
 * the cost of serialising the state is acceptable.
 *
 * @param {object} tab A Firefox tab.
 * @returns {string}
 */
function pendingUrl(tab) {
  try {
    return urlOfState(JSON.parse(lazy.SessionStore.getTabState(tab)));
  } catch (err) {
    // A tab whose state cannot be read is one the browser will have to answer
    // for after all; there is nothing better to say and nothing to warn about.
    return "";
  }
}

/**
 * How the observer reads and tags a real Firefox tab. Swappable as a whole so
 * the logic above it is testable without a browser window; production always
 * uses this one, and the browser-chrome test is what proves it.
 */
const chromeTabAdapter = {
  /**
   * @param {object} tab A Firefox tab.
   * @returns {string|null} the tab's node id, or null when it carries none.
   */
  nodeId(tab) {
    const stored = lazy.SessionStore.getCustomTabValue(tab, NODE_ID_KEY);
    return stored || null;
  },

  /**
   * Tags `tab` with `id`. The store holds strings only.
   *
   * @param {object} tab A Firefox tab.
   * @param {string} id The node id to tag it with.
   */
  setNodeId(tab, id) {
    lazy.SessionStore.setCustomTabValue(tab, NODE_ID_KEY, id);
  },

  /**
   * Takes `tab`'s node id off it, for a tab that stops standing for a node
   * while it stays open (`SvalTabObserver.unfile`).
   *
   * @param {object} tab A Firefox tab.
   */
  clearNodeId(tab) {
    lazy.SessionStore.deleteCustomTabValue(tab, NODE_ID_KEY);
  },

  /**
   * Another live tab, in any window, carrying the node id `tab` carries.
   *
   * The session store copies a tab's custom values wherever it copies the
   * tab's state: `duplicateTab`, which Duplicate, a copying drag and a
   * middle-click on Back all reach, and `setTabState` with another tab's state.
   * A copy therefore arrives tagged with its original's id. The id moves, and
   * is not copied, when a tab changes window (`moveCustomTabValue`), and a
   * tab being closed no longer holds it.
   *
   * @param {object} tab A Firefox tab.
   * @returns {object|null} the other tab, or null when `tab` is the only one.
   */
  copyOf(tab) {
    const id = this.nodeId(tab);
    if (!id) {
      return null;
    }
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (win.closed || lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
        continue;
      }
      for (const other of win.gBrowser?.tabs ?? []) {
        if (other === tab || other.closing) {
          continue;
        }
        let held;
        try {
          held = this.nodeId(other) === id;
        } catch (err) {
          // A tab whose id cannot be read may carry this one: the id is
          // contested, so `tab` stands for no node (`resolveNodeId`).
          held = true;
        }
        if (held) {
          return other;
        }
      }
    }
    return null;
  },

  /**
   * Answers `copyOf` for many tabs from one pass over every tab, for reads
   * between which no tab opens, closes or changes its id
   * (`SvalTabObserver.withTabLookups`).
   *
   * @returns {function(object): boolean} whether another live tab carries
   *   the id the given tab carries.
   */
  copyFinder() {
    const carriers = new Map();
    const unreadable = [];
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (win.closed || lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
        continue;
      }
      for (const other of win.gBrowser?.tabs ?? []) {
        if (other.closing) {
          continue;
        }
        let id;
        try {
          id = this.nodeId(other);
        } catch (err) {
          // Contested, as in `copyOf`.
          unreadable.push(other);
          continue;
        }
        if (id) {
          const tabs = carriers.get(id);
          if (tabs) {
            tabs.push(other);
          } else {
            carriers.set(id, [other]);
          }
        }
      }
    }
    return tab => {
      const id = this.nodeId(tab);
      if (!id) {
        return false;
      }
      const isOther = other => other !== tab;
      return !!carriers.get(id)?.some(isOther) || unreadable.some(isOther);
    };
  },

  /**
   * @param {string} id A node id.
   * @returns {boolean} Whether a tab of any normal window carries it.
   */
  isCarried(id) {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (win.closed || lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
        continue;
      }
      for (const tab of win.gBrowser?.tabs ?? []) {
        try {
          if (!tab.closing && this.nodeId(tab) === id) {
            return true;
          }
        } catch (err) {
          // Unreadable, so it may carry the id, and the node stays.
          return true;
        }
      }
    }
    return false;
  },

  /**
   * @param {object} tab A Firefox tab.
   * @returns {boolean} Whether the user is in control of its content
   *   (`SvalAgentControl.isUserInControl`).
   */
  isUserInControl(tab) {
    return lazy.isUserInControl(tab.linkedBrowser?.browserId);
  },

  /**
   * Puts `tab`'s content in the user's control, which every agent dispatch
   * checks (`SvalAgentControl.takeControl`). Synchronous. In an agent's
   * window that takes the workspace for the user (`SvalAgentMarking`).
   *
   * @param {object} tab A Firefox tab.
   */
  takeForUser(tab) {
    lazy.takeControl(tab.linkedBrowser?.browserId);
  },

  /**
   * Keeps the agent out of the user's history entries in a copy filed under
   * `id` (`SvalAgentControl.inheritUserHistory`).
   *
   * @param {object|null} original The tab copied, or null when it is gone.
   * @param {string} originalId Its node id.
   * @param {string} id The copy's node id.
   */
  inheritUserHistory(original, originalId, id) {
    lazy.inheritUserHistory(
      original?.linkedBrowser?.browserId ?? 0,
      originalId,
      id
    );
  },

  name(tab) {
    return tab.label ?? "";
  },

  /**
   * @param {object} tab A Firefox tab.
   * @returns {string|null} the address of the tab's favicon, or null when it
   *   has none yet.
   */
  icon(tab) {
    return tab.getAttribute("image") || null;
  },

  /**
   * Whether `tab` has loaded its page. A tab Sval restored lazily is `pending`
   * until the user first shows it, and one the browser unloaded to save memory
   * is `discarded`; neither has a page behind it.
   *
   * @param {object} tab A Firefox tab.
   * @returns {boolean}
   */
  isLoaded(tab) {
    return !tab.hasAttribute("pending") && !tab.hasAttribute("discarded");
  },

  /**
   * Whether `tab` is loading a page: the span tabbrowser draws its own
   * throbber for.
   *
   * @param {object} tab A Firefox tab.
   * @returns {boolean}
   */
  isBusy(tab) {
    return tab.hasAttribute("busy");
  },

  /**
   * Whether `tab` is making sound the user can hear: tabbrowser's
   * `soundplaying`.
   *
   * @param {object} tab A Firefox tab.
   * @returns {boolean}
   */
  isPlayingSound(tab) {
    return tab.soundPlaying;
  },

  /**
   * Whether `tab` is a blank tab nobody asked for: `about:blank` with no
   * history behind it. These are the only tabs that may stay unfiled, and only
   * when Sval or the window opened them (`#reconcile`), because each is
   * internal rather than a screen anyone chose:
   *
   * - **A tab whose first load has not committed.** `TabOpen` is dispatched
   *   before the load starts (`_kickOffBrowserLoad` in `tabbrowser.js`), so
   *   every new tab reads `about:blank` at first. The content path files it
   *   the moment it shows anything else.
   * - **The window's startup tab, while `SvalRestore`'s `isDebris` is about to
   *   replace it** with the workspace's own tabs.
   * - **An agent window's keeper** (`SvalAgentTabs.sys.mjs`'s `openWindowFor`
   *   and `closeTab`): the blank page that keeps the window open when the
   *   agent has no tab. Filing it would hand the agent's workspace a tab the
   *   agent never opened.
   *
   * An `about:blank` the user opens arrives through `TabOpen` as a tab they
   * asked for, and is filed. So is every other address, the home page and
   * Firefox's blank new-tab page included: each is a screen in the viewport.
   *
   * A lazy tab (`!tab.linkedPanel`, never inserted into the DOM) is read
   * through `SessionStore.getLazyTabValue`, the same store `_createLazyBrowser`
   * itself draws `currentURI` from for a lazy browser's stubbed getter.
   * `canGoBack`/`canGoForward` are not among the properties that getter stubs,
   * so reading them falls to its default case, which inserts the browser to
   * answer, which this filter must never cause. A lazy tab has never
   * been navigated, so it has no back or forward entries by construction, and
   * needs no such check.
   *
   * @param {object} tab A Firefox tab.
   * @returns {boolean}
   */
  isBlank(tab) {
    if (SvalFirefox.isLazy(tab)) {
      return (SvalFirefox.lazyUrl(tab) || "about:blank") === "about:blank";
    }
    const spec = tab.linkedBrowser?.currentURI?.spec ?? "";
    return spec === "about:blank" && SvalFirefox.hasNoHistory(tab);
  },

  /**
   * The address `tab` is being opened at, for the act that files it: the
   * address its first load is for while it is still on its first blank
   * document, the one a restore is bringing back while that restore is
   * outstanding, and otherwise the page it shows. Only an open reads it
   * (decision 0050); what the tab commits afterwards reaches its node
   * through {@link watchNavigation}.
   *
   * `addTab` keeps the address it was given as the browser's
   * `userTypedValue` until the page commits, so a first load that is
   * refused or cancelled still names the address the tab was opened at.
   * `SessionStore.isTabRestoring` is Firefox's own record of a restore it
   * was asked for (`TAB_STATE_FOR_BROWSER`), as `undoCloseTab` and
   * `duplicateTab` ask, and its session state names the address. A lazy tab
   * answers from the session store through `_createLazyBrowser`'s stubbed
   * `currentURI`, and inserts nothing.
   *
   * @param {object} tab A Firefox tab.
   * @returns {string}
   */
  openingUrl(tab) {
    const browser = tab.linkedBrowser;
    if (SvalFirefox.isLazy(tab)) {
      return browser?.currentURI?.spec ?? "";
    }
    if (SvalFirefox.isRestoring(tab)) {
      const pending = pendingUrl(tab);
      if (pending) {
        return pending;
      }
    }
    const spec = browser?.currentURI?.spec ?? "";
    return (spec === "about:blank" && browser.userTypedValue) || spec;
  },

  /**
   * The window's tabs in strip order. A Quick Peek's tab is no tab of the window's
   * work until the user keeps it, and a pin's page belongs to its pin
   * ({@link standsForNoNode}), so both are left out.
   *
   * @param {DOMWindow} window A chrome window.
   */
  tabsOf(window) {
    return Array.from(window.gBrowser.tabs).filter(
      tab => !this.standsForNoNode(tab)
    );
  },

  /**
   * Whether `tab` is among `tabsOf(window)`, answered from the tab alone:
   * a window's tabs are the tab elements under its own tab strip
   * (`allTabs` in tabs.js), so a tab in the document of `window` is one of
   * them. The document is compared because a tab's `ownerGlobal` is not the
   * same object as the window a chrome script holds.
   *
   * @param {DOMWindow} window A chrome window.
   * @param {object} tab A Firefox tab.
   * @returns {boolean}
   */
  holds(window, tab) {
    return (
      tab.isConnected &&
      tab.ownerDocument === window.document &&
      !this.standsForNoNode(tab)
    );
  },

  /**
   * Whether `tab` is one no node describes while it is what it is: a Quick Peek's
   * (`SvalQuickPeekTab`), open over another tab, or a pin's page (`SvalPinTab`),
   * which its pin reaches.
   *
   * @param {object} tab A Firefox tab.
   * @returns {boolean}
   */
  standsForNoNode(tab) {
    return isQuickPeek(tab) || isPin(tab);
  },

  /**
   * Whether the tab a `TabOpen` announces comes from outside every
   * workspace: a link from another app (`fromExternal`, which
   * `BrowserDOMWindow` sets for `OPEN_EXTERNAL`), or a Peek's page
   * moved in (`adoptedTab`, which `gBrowser.adoptTab` passes) or opened again
   * (`REOPENED_DETAIL`).
   *
   * @param {Event} event A `TabOpen`.
   * @returns {boolean}
   */
  isFromOutside(event) {
    const { fromExternal, adoptedTab } = event.detail ?? {};
    return (
      fromExternal === true ||
      event.detail?.[lazy.REOPENED_DETAIL] === true ||
      (!!adoptedTab && lazy.isPeek(adoptedTab.documentGlobal))
    );
  },

  /**
   * @param {DOMWindow} window A chrome window.
   */
  eventTargetOf(window) {
    return window.gBrowser.tabContainer;
  },

  /**
   * Calls `onCommitted(tab, url, title)` for each page a tab commits: a new
   * document, an error page, or a same-document change of address, as
   * `history.pushState` and a fragment make.
   *
   * A tabs progress listener's `onLocationChange` is the mechanism
   * (`tabbrowser.js`'s `TabProgressListener`), the one
   * `browser/components/tabnotes/TabNotesController.sys.mjs` follows a tab's
   * page by. `isTopLevel` keeps an iframe's navigation from being read as
   * the tab's own. `LOCATION_CHANGE_SESSION_STORE` marks the session store
   * setting a restoring tab's address without navigating
   * (`nsDocShell::SetCurrentURIForSessionStore`), which commits nothing, and
   * TabNotesController passes over it for the same reason. An error page for
   * an address too malformed to keep commits at `about:blank`
   * (`nsDocShell::CreateDocumentViewer`), which names no page, and tabbrowser's
   * `onLocationChange` passes over that address on an error page too. A load
   * refused or stopped before it commits raises no location change at all.
   *
   * The title is the committed page's own (`browser.contentTitle`), empty
   * until the page sets one; a later one arrives through {@link watchTitles}.
   *
   * Reader view commits as the article it shows (`ReaderMode.getOriginalUrl`),
   * as Firefox's tab engine records it, so a tab in reader view keeps an
   * address another device may open (decision 1372).
   *
   * @param {DOMWindow} window A chrome window.
   * @param {Function} onCommitted Called with the tab, the committed
   *   address, and the page's title.
   * @returns {Function} stops listening.
   */
  watchNavigation(window, onCommitted) {
    const listener = {
      onLocationChange(browser, webProgress, request, location, flags) {
        const { LOCATION_CHANGE_SESSION_STORE, LOCATION_CHANGE_ERROR_PAGE } =
          Ci.nsIWebProgressListener;
        if (
          !webProgress.isTopLevel ||
          flags & LOCATION_CHANGE_SESSION_STORE ||
          (flags & LOCATION_CHANGE_ERROR_PAGE &&
            location.spec === "about:blank")
        ) {
          return;
        }
        const tab = window.gBrowser.getTabForBrowser(browser);
        if (tab) {
          const url =
            lazy.ReaderMode.getOriginalUrl(location.spec) ?? location.spec;
          onCommitted(tab, url, browser.contentTitle);
        }
      },
    };
    window.gBrowser.addTabsProgressListener(listener);
    return () => window.gBrowser.removeTabsProgressListener(listener);
  },

  /**
   * Calls `onTitle(tab, title)` each time a tab's page sets its title.
   *
   * `pagetitlechanged` is raised on the `<browser>` for the top-level
   * document's title only (`WindowGlobalParent::RecvUpdateDocumentTitle`),
   * so it speaks for the page the tab has committed. It bubbles to
   * `gBrowser`, whose own listener labels the tab from it. That listener
   * passes over an empty title on a page of the browser's own while Fluent
   * fills the page's title in, and so does this one.
   *
   * @param {DOMWindow} window A chrome window.
   * @param {Function} onTitle Called with the tab and its page's title.
   * @returns {Function} stops listening.
   */
  watchTitles(window, onTitle) {
    const listener = event => {
      const browser = event.target;
      const tab = window.gBrowser.getTabForBrowser(browser);
      if (
        !tab ||
        (!browser.contentTitle && browser.contentPrincipal?.isSystemPrincipal)
      ) {
        return;
      }
      onTitle(tab, browser.contentTitle);
    };
    window.gBrowser.addEventListener("pagetitlechanged", listener);
    return () =>
      window.gBrowser.removeEventListener("pagetitlechanged", listener);
  },

  /**
   * Files `workspaceId` on a closing `tab` as the workspace it was in.
   *
   * @param {object} tab A Firefox tab.
   * @param {string} workspaceId
   */
  setFormerWorkspace(tab, workspaceId) {
    lazy.SessionStore.setCustomTabValue(tab, FORMER_WORKSPACE_KEY, workspaceId);
  },

  /**
   * @param {DOMWindow} window A chrome window.
   * @returns {object[]} the tabs Firefox keeps as closed in `window`, the
   *   latest first, each `{ state, title }`.
   */
  closedTabs(window) {
    return lazy.SessionStore.getClosedTabDataForWindow(window);
  },

  /**
   * Reopens `window`'s closed tab at `index` into it, in the jar it closed
   * in, with its history.
   *
   * @param {DOMWindow} window A chrome window.
   * @param {number} index Into {@link closedTabs}.
   * @returns {object} the tab.
   */
  undoClose(window, index) {
    return lazy.SessionStore.undoCloseTab(window, index, window);
  },

  /**
   * Drops `window`'s closed tab at `index`.
   *
   * @param {DOMWindow} window A chrome window.
   * @param {number} index Into {@link closedTabs}.
   */
  forgetClosed(window, index) {
    lazy.SessionStore.forgetClosedTab(window, index);
  },

  /**
   * Calls `onClosing` with each `TabClose` in `window` before the session
   * store records the closed tab. `SessionStore` listens on the tab container
   * in the capture phase (`SessionStoreInternal.onLoad`), and a capturing
   * listener on the window runs before it.
   *
   * @param {DOMWindow} window A chrome window.
   * @param {Function} onClosing Called with the `TabClose` event.
   * @returns {Function} stops listening.
   */
  watchClosing(window, onClosing) {
    window.addEventListener("TabClose", onClosing, true);
    return () => window.removeEventListener("TabClose", onClosing, true);
  },

  /**
   * @param {object} tab A Firefox tab.
   * @returns {string|null} the parent `tab`'s node had when it closed.
   */
  formerParent(tab) {
    return lazy.SessionStore.getCustomTabValue(tab, FORMER_PARENT_KEY) || null;
  },

  /**
   * Files `parent` on `tab` as where its node sat, or clears it for "".
   *
   * @param {object} tab A Firefox tab.
   * @param {string} parent A node id, or "".
   */
  setFormerParent(tab, parent) {
    if (parent) {
      lazy.SessionStore.setCustomTabValue(tab, FORMER_PARENT_KEY, parent);
    } else {
      lazy.SessionStore.deleteCustomTabValue(tab, FORMER_PARENT_KEY);
    }
  },

  /**
   * Calls `onStart` as Firefox's new-tab command begins and `onEnd` once it
   * has run, so the `TabOpen` it raises can be told from every other.
   *
   * The keyboard's ⌘T and the File menu's New Tab both run as a `command`
   * event on a `<command>` element in `mainCommandSet`, whose own listener
   * opens the tab synchronously (`browser-sets.js`'s `cmd_newNavigatorTab`
   * and `cmd_newNavigatorTabNoEvent` cases). A capturing listener on the
   * window runs before that one and a bubbling one after it, so the two
   * bracket the `TabOpen` the command dispatches.
   *
   * @param {DOMWindow} window A chrome window.
   * @param {Function} onStart
   * @param {Function} onEnd
   * @returns {Function} stops listening.
   */
  watchNewTabCommand(window, onStart, onEnd) {
    const start = event => NEW_TAB_COMMANDS.has(event.target.id) && onStart();
    const end = event => NEW_TAB_COMMANDS.has(event.target.id) && onEnd();
    window.addEventListener("command", start, true);
    window.addEventListener("command", end);
    return () => {
      window.removeEventListener("command", start, true);
      window.removeEventListener("command", end);
    };
  },

  /**
   * Makes `tab` the one the window is showing. A lazy tab's browser is
   * instantiated by this, so its page loads when the user goes to it.
   *
   * @param {DOMWindow} window A chrome window.
   * @param {object} tab A Firefox tab.
   */
  select(window, tab) {
    window.gBrowser.selectedTab = tab;
  },

  /**
   * Whether `tab` is in front of the user: its window's selected tab, or one
   * in a call or in picture-in-picture. Another device's delete never closes
   * such a tab (decision 2237).
   *
   * @param {object} tab A Firefox tab.
   * @returns {boolean}
   */
  isInFront(tab) {
    return tab.selected || SvalFirefox.isInPictureInPictureOrCall(tab);
  },

  /**
   * Opens a lazy tab for `node` in the jar `userContextId` names, for the
   * caller to close at once (`SvalTabObserver.#openToClose`).
   *
   * @param {DOMWindow} window A chrome window.
   * @param {object} node A tab node.
   * @param {string} id Its id.
   * @param {number} userContextId
   * @returns {?object} the tab, or null as `SvalRestore.open` gives it.
   */
  openToClose(window, node, id, userContextId) {
    return lazy.SvalRestore.open(window, node, id, userContextId);
  },

  /**
   * Whether `tab` is in a call, which keeps its node on this device
   * (decision 2237).
   *
   * @param {object} tab A Firefox tab.
   * @returns {boolean}
   */
  isInCall(tab) {
    return SvalFirefox.isInCall(tab);
  },

  /**
   * Closes `tab`, which raises `TabClose` and so deletes its node through the
   * one path a close already takes.
   *
   * @param {DOMWindow} window A chrome window.
   * @param {object} tab A Firefox tab.
   */
  close(window, tab) {
    window.gBrowser.removeTab(tab);
  },

  /**
   * Brings the session store's record of `tab` up to date before a
   * {@link discard} reads it (`SvalFirefox.flushState`). A lazy tab and a page
   * in the parent process are answered by `discard` without that record, so
   * they are left alone.
   *
   * @param {DOMWindow} window A chrome window.
   * @param {object} tab A Firefox tab.
   * @returns {Promise<boolean>|boolean} whether the record is up to date; a
   *   page whose process did not answer in time leaves it stale.
   */
  flushState(window, tab) {
    if (SvalFirefox.isLazy(tab) || !tab.linkedBrowser?.isRemoteBrowser) {
      return true;
    }
    return SvalFirefox.flushState(window, tab);
  },

  /**
   * Whether the page in `tab` says it may unload, waited for
   * (`SvalFirefox.pageAllowsUnload`). A lazy tab and a page in the parent
   * process hold no page to ask.
   *
   * @param {DOMWindow} window A chrome window.
   * @param {object} tab A Firefox tab.
   * @returns {Promise<boolean>|boolean}
   */
  allowsUnload(window, tab) {
    if (SvalFirefox.isLazy(tab) || !tab.linkedBrowser?.isRemoteBrowser) {
      return true;
    }
    return SvalFirefox.pageAllowsUnload(tab, PAGE_ANSWER_MS);
  },

  /**
   * Takes a tab a switch could not unload out of the window's reach while its
   * workspace is hidden (`SvalFirefox.hideForWorkspace`).
   *
   * @param {DOMWindow} window A chrome window.
   * @param {object} tab A Firefox tab, not the selected one.
   */
  hideForWorkspace(window, tab) {
    SvalFirefox.hideForWorkspace(window, tab);
  },

  /**
   * Whether `tab` is out of reach because its workspace is hidden.
   *
   * @param {object} tab A Firefox tab.
   * @returns {boolean}
   */
  isHiddenForWorkspace(tab) {
    return SvalFirefox.isHiddenForWorkspace(tab);
  },

  /**
   * Whether `tab`, out of reach because its workspace is hidden, is being
   * shown. Answers only during its `TabShow`.
   *
   * @param {object} tab A Firefox tab.
   * @returns {boolean}
   */
  isShowingFromWorkspaceHide(tab) {
    return SvalFirefox.isShowingFromWorkspaceHide(tab);
  },

  /**
   * Whether `tab` is hidden while its delete waits on the panel's Undo
   * message (`SvalFirefox.hideForDelete`).
   *
   * @param {object} tab A Firefox tab.
   * @returns {boolean}
   */
  isHiddenForDelete(tab) {
    return SvalFirefox.isHiddenForDelete(tab);
  },

  /**
   * Puts a tab {@link hideForWorkspace} hid back within the window's reach.
   *
   * @param {DOMWindow} window A chrome window.
   * @param {object} tab A Firefox tab.
   */
  showForWorkspace(window, tab) {
    SvalFirefox.showForWorkspace(window, tab);
  },

  /**
   * Releases `tab`'s content process, reporting whether it worked.
   *
   * `gBrowser.discardBrowser` resets the tab to lazy state through
   * `SessionStore.resetBrowserToLazyState` and returns false when
   * `_mayDiscardBrowser` refuses: the selected tab, a tab already closing, a
   * window already closing, a tab whose browser is not remote, a page whose
   * `beforeunload` handler asks to stay after the user has interacted with
   * it, a tab with a dialog open. **A refusal is ordinary and never fatal**:
   * the tab stays loaded, its node stays in the document, and the switch
   * completes around it.
   *
   * **A page the user has typed into is refused here** (spec §10.7): the tab
   * a switch releases comes back from its node's address alone, so what was
   * typed would be gone. The session store's form data
   * (`SvalFirefox.hasFormData`) is what answers, and the caller flushes it
   * first ({@link flushState}).
   *
   * **A video in picture-in-picture or a call is refused here** (spec
   * §10.7), as Firefox never unloads either to save memory
   * (`SvalFirefox.isInPictureInPictureOrCall`): the discard would end it.
   *
   * **A tab playing audio is not refused.** `_mayDiscardBrowser` does not
   * consult it, and `discardBrowser` clears the `soundplaying` attribute;
   * `releaseIdle` is what leaves such a tab alone.
   *
   * **A tab kept loaded is refused here, lazy or not** (spec §10.7): the
   * user asked for it (`tab.undiscardable`), and a lazy one released here
   * would come back from its node without the mark.
   *
   * An already-lazy tab is answered without calling at all. There is nothing
   * to release, and `_mayDiscardBrowser` reads `linkedBrowser` properties of
   * which only the ones `_createLazyBrowser` stubs are safe to touch;
   * anything else inserts the browser, which materialising a whole workspace
   * lazily must never provoke.
   *
   * **A page in the parent process holds no content process either**, so it
   * is answered yes without calling. `_mayDiscardBrowser` refuses any browser
   * that is not remote, and settings, `about:addons` and `about:config` all
   * load in the parent; asking would leave each of them behind in a window
   * that has moved to another workspace, out of sight with no row to reach
   * it, while its node waits in the workspace it belongs to. The selected tab
   * is still refused, as `_mayDiscardBrowser` refuses it.
   *
   * @param {DOMWindow} window A chrome window.
   * @param {object} tab A Firefox tab.
   * @returns {boolean} whether the tab holds no content process afterwards.
   */
  discard(window, tab) {
    if (tab.undiscardable) {
      return false;
    }
    if (SvalFirefox.isLazy(tab)) {
      return true;
    }
    if (!tab.selected && tab.linkedBrowser?.isRemoteBrowser === false) {
      return true;
    }
    if (SvalFirefox.mustStayLoaded(tab)) {
      return false;
    }
    return SvalFirefox.discard(window, tab);
  },

  /**
   * Whether {@link discard} would release `tab`, asked without releasing it.
   *
   * @param {DOMWindow} window A chrome window.
   * @param {object} tab A Firefox tab.
   * @returns {boolean}
   */
  mayDiscard(window, tab) {
    if (tab.undiscardable) {
      return false;
    }
    if (SvalFirefox.isLazy(tab)) {
      return true;
    }
    if (!tab.selected && tab.linkedBrowser?.isRemoteBrowser === false) {
      return true;
    }
    return (
      !SvalFirefox.mustStayLoaded(tab) && SvalFirefox.mayDiscard(window, tab)
    );
  },

  /**
   * Takes `tab` out of the window, which is what a workspace switch does to
   * the tabs of the workspace being left.
   *
   * `skipSessionStore` keeps it out of Firefox's recently-closed list, which
   * Sval keeps for tabs the user closed (spec §5.4). The tab stays in its
   * workspace, so offering to reopen it would make a second one.
   *
   * With `closeWindowWithLastTab: false`, removing the window's last tab makes
   * `_beginRemoveTab` open a blank tab where it would close the window, so no
   * switch can cost the user their window.
   *
   * @param {DOMWindow} window A chrome window.
   * @param {object} tab A Firefox tab.
   */
  release(window, tab) {
    window.gBrowser.removeTab(tab, {
      animate: false,
      skipSessionStore: true,
      closeWindowWithLastTab: false,
    });
  },

  /**
   * The `userContextId` of the jar `workspaceId`'s tabs use
   * (`SvalWorkspaceJar`, isolated workspaces spec §4).
   *
   * @param {object} nodes The document's nodes, by id.
   * @param {string} workspaceId
   * @returns {number}
   */
  jarFor(nodes, workspaceId) {
    return lazy.SvalWorkspaceJar.userContextIdFor(nodes, workspaceId);
  },

  /**
   * Removes the jars no workspace uses (`SvalWorkspaceJar.prune`).
   *
   * @param {object} nodes The document's nodes, by id.
   */
  pruneJars(nodes) {
    lazy.SvalWorkspaceJar.prune(nodes);
  },

  /**
   * Whether `tab` opens one of the browser's own pages, such as settings,
   * add-ons or downloads: an `about:` address other than the ones Firefox
   * opens a new tab or window on (`isInitialPage`), which are the home page
   * and the blank tab.
   *
   * @param {object} tab A Firefox tab.
   * @returns {boolean}
   */
  opensBrowserPage(tab) {
    const url = this.openingUrl(tab);
    return url.startsWith("about:") && !tab.documentGlobal.isInitialPage(url);
  },

  /**
   * @param {object} tab A Firefox tab.
   * @returns {number} the `userContextId` of the jar `tab` uses.
   */
  userContextId(tab) {
    return tab.userContextId ?? 0;
  },

  /**
   * @param {number} userContextId
   * @returns {boolean} whether a WebDriver client chose that jar, so its tab
   *   stays in it (`SvalWebDriver.isClientsJar`).
   */
  isClientsJar(userContextId) {
    return lazy.SvalWebDriver.isClientsJar(userContextId);
  },

  /**
   * Opens `node`'s page lazily in another jar, tagged with its id, the way a
   * workspace's tabs are restored (`SvalRestore.open`).
   *
   * @param {DOMWindow} window A chrome window.
   * @param {object} node The tab node.
   * @param {string} id The node's id.
   * @param {number} userContextId The jar to open in.
   * @returns {?object} the new tab, or null as `SvalRestore.open` gives it.
   */
  openInJar(window, node, id, userContextId) {
    return lazy.SvalRestore.open(window, node, id, userContextId);
  },

  /**
   * Opens a new tab, raising `TabOpen` so the node is filed through the one
   * path an open already takes.
   *
   * This is Firefox's own new-tab command as the keyboard reaches it:
   * `key_newNavigatorTab` runs `cmd_newNavigatorTabNoEvent`, whose handler in
   * `browser-sets.js` is `BrowserCommands.openTab()` with no arguments. So the
   * panel's button and the keyboard are the same act, and the new-tab page,
   * focus and the urlbar's state stay the browser's business.
   *
   * @param {DOMWindow} window A chrome window.
   * @param {string} [url] What to open instead of the new-tab page.
   */
  openNewTab(window, url) {
    window.BrowserCommands.openTab(url ? { url } : undefined);
  },

  /**
   * Marks `tab` as the blank tab Sval opened for the window's sake. See
   * `SVAL_UNFILED_ATTRIBUTE`.
   *
   * @param {object} tab A Firefox tab.
   */
  markUnfiled(tab) {
    tab.setAttribute(SVAL_UNFILED_ATTRIBUTE, "true");
  },

  /**
   * Whether `tab` is one Sval opened for the window's sake.
   *
   * @param {object} tab A Firefox tab.
   * @returns {boolean}
   */
  isUnfiled(tab) {
    return tab.hasAttribute?.(SVAL_UNFILED_ATTRIBUTE) === true;
  },

  /**
   * Marks `tab` as having just been handed another window's tab. See
   * `SVAL_ADOPTED_ATTRIBUTE`.
   *
   * The tab is in another window, which may not have started its own panel
   * yet: a drag out to a new window marks that window's initial tab before
   * anything of Sval's runs in it. An attribute on the element is the one
   * channel available at that moment.
   *
   * @param {object} tab A Firefox tab.
   */
  markAdopted(tab) {
    tab.setAttribute?.(SVAL_ADOPTED_ATTRIBUTE, "true");
  },

  /**
   * Whether `tab` arrived from another window, clearing the mark.
   *
   * Read-and-clear, because only the first reconciliation after the move has
   * to know, and a mark left behind would answer yes the next time the tab was
   * looked at.
   *
   * @param {object} tab A Firefox tab.
   * @returns {boolean}
   */
  takeAdopted(tab) {
    const marked = tab.hasAttribute?.(SVAL_ADOPTED_ATTRIBUTE) === true;
    if (marked) {
      tab.removeAttribute(SVAL_ADOPTED_ATTRIBUTE);
    }
    return marked;
  },

  /**
   * Tells the agent gates the user took `tab` out of an agent's workspace,
   * so none watches it, or reaches it through the page that opened it,
   * again.
   *
   * @param {object} tab A Firefox tab.
   */
  releaseFromAgent(tab) {
    lazy.releaseAgentTab(tab.linkedBrowser?.browserId);
  },

  /**
   * Asks, in `window`, whether to move the tab or group `id` from `source`
   * into `destination`, a workspace with another jar (the panel's
   * `_confirmJarCrossing`, isolated workspaces spec §6).
   *
   * @param {DOMWindow} window A chrome window.
   * @param {object} nodes The document's nodes.
   * @param {string} id
   * @param {string} destination
   * @param {string} source
   * @returns {Promise<boolean>} whether to move it. A window with no panel
   *   has nowhere to ask, which reads as Cancel.
   */
  confirmJarCrossing(window, nodes, id, destination, source) {
    return (
      window.SvalPanel?.confirmJarCrossing(
        id,
        destination,
        null,
        source,
        nodes
      ) ?? Promise.resolve(false)
    );
  },

  /**
   * Moves `tab` into the full window showing `workspaceId`, opening one if
   * there is none, as it is: `adoptTab` swaps the page across, so it loads
   * nothing.
   *
   * @param {object} tab A Firefox tab.
   * @param {string} workspaceId
   * @returns {Promise<void>}
   */
  async returnTab(tab, workspaceId) {
    const win = await lazy.windowForWorkspace(workspaceId, { open: true });
    if (!win || win.closed || tab.closing || !tab.isConnected) {
      return;
    }
    win.gBrowser.adoptTab(tab, { selectTab: true });
  },

  /**
   * The window's splits, each as its tabs (`SvalFirefox.splitsOf`).
   *
   * @param {DOMWindow} window A chrome window.
   * @returns {object[][]}
   */
  splitsOf(window) {
    return SvalFirefox.splitsOf(window);
  },

  /**
   * @param {object} tab A Firefox tab.
   * @returns {object[]|null} the tabs of the split it is in.
   */
  splitOf(tab) {
    return SvalFirefox.splitOf(tab);
  },

  /**
   * @param {DOMWindow} window A chrome window.
   * @param {object[]} tabs Its tabs, to show as one split.
   */
  showSplit(window, tabs) {
    SvalFirefox.showSplit(window, tabs);
  },

  /**
   * @param {DOMWindow} window A chrome window.
   * @param {object} tab A tab of the split to end.
   */
  endSplit(window, tab) {
    SvalFirefox.endSplit(window, tab);
  },

  /**
   * @param {object} tab A tab in a split.
   * @param {object} replacement The tab to take its place.
   */
  replaceInSplit(tab, replacement) {
    SvalFirefox.replaceInSplit(tab, replacement);
  },

  /**
   * @param {DOMWindow} window A chrome window.
   * @param {object[]} tabs A split's tabs.
   * @returns {number[]} each pane's width on screen.
   */
  paneWidths(window, tabs) {
    return SvalFirefox.paneWidths(window, tabs);
  },

  /**
   * @param {DOMWindow} window A chrome window.
   * @param {object[]} tabs A split's tabs.
   * @param {number[]|null} widths As `SvalFirefox.setPaneWidths` takes them.
   */
  setPaneWidths(window, tabs, widths) {
    if (!SvalFirefox.isDraggingSplitter(window)) {
      SvalFirefox.setPaneWidths(window, tabs, widths);
    }
  },

  /**
   * @param {DOMWindow} window A chrome window.
   * @param {Function} onReleased Called as the user lets go of a splitter.
   * @returns {Function} stops listening.
   */
  watchSplitters(window, onReleased) {
    return SvalFirefox.watchSplitters(window, onReleased);
  },

  /**
   * Calls `onUse` with the tab whose page took a click or a key press in
   * `window`. The parent dispatches such an event at the page's `<browser>`
   * before it forwards it to the page's process
   * (`EventStateManager::PostHandleEvent`), so a listener here sees presses
   * in remote pages too.
   *
   * @param {DOMWindow} window A chrome window.
   * @param {Function} onUse Called with the tab.
   * @returns {Function} stops listening.
   */
  watchUse(window, onUse) {
    const panels = window.gBrowser.tabpanels;
    const listener = event => {
      const tab =
        event.isTrusted && window.gBrowser.getTabForBrowser(event.target);
      if (tab) {
        onUse(tab);
      }
    };
    for (const type of ["mousedown", "keydown"]) {
      panels.addEventListener(type, listener, true);
    }
    return () => {
      for (const type of ["mousedown", "keydown"]) {
        panels.removeEventListener(type, listener, true);
      }
    };
  },

  /**
   * @param {DOMWindow} window A chrome window.
   * @returns {boolean} whether `window` is the window the user is in.
   */
  isActive(window) {
    return Services.focus.activeWindow === window;
  },

  /**
   * A private window's tabs are not the user's filed work and must never reach
   * a file in their cloud folder.
   *
   * @param {DOMWindow} window A chrome window.
   */
  isPrivate(window) {
    return lazy.PrivateBrowsingUtils.isWindowPrivate(window);
  },
};

/**
 * The node id an observer filed each tab under, for every window in the
 * process: the id it minted, or the one the tab carried when the document
 * held its node. The session store is the durable record and this is not a
 * second one. It names a tab already being closed, the one moment the store
 * cannot be asked, and it says which of two tabs carrying one id is the one
 * filed under it (`resolveNodeId`).
 *
 * @type {WeakMap<object, string>}
 */
const filedIds = new (class extends WeakMap {
  set(tab, id) {
    tabIdsChanged();
    return super.set(tab, id);
  }

  delete(tab) {
    tabIdsChanged();
    return super.delete(tab);
  }
})();

/**
 * Counts the changes that can move which node a tab stands for: a tab event
 * reaching an observer, a node id set on a tab or taken off it, and a tab
 * filed or unfiled. `SvalTabObserver.withTabLookups` keeps its answers only
 * while the count holds.
 */
let tabIdsVersion = 0;

function tabIdsChanged() {
  tabIdsVersion++;
}

/**
 * What tabs have committed since the last flush, by node id, for each
 * engine: the address of the page each committed last, and the title that
 * page set, as their events carried them (decision 0050). Each fact is the
 * event's own, so a flush reads no tab, and a redirect chain and a title that
 * resolves in stages cost one write between them.
 *
 * Keyed by node and shared by every window on the engine: a commit is the
 * node's, whichever window held its tab when the event came, and whichever
 * window's flush runs first writes it. A tab carried to another window
 * between its commit and its title therefore has both written together, and
 * an older commit never lands after a newer one.
 *
 * `held` marks a title a window's `SvalTitleHold` is holding back, which a
 * poll leaves where it is. Any other flush takes it with the rest, since it
 * publishes a file anyway.
 *
 * @type {WeakMap<object, Map<string, {url?: string, name?: string, held?: boolean}>>}
 */
const committedByEngine = new WeakMap();

/**
 * @param {object} engine A `SvalEngine`, or the tree a window writes to.
 * @returns {Map<string, {url?: string, name?: string}>} what its tabs have
 *   committed and not yet written (`committedByEngine`).
 */
function committedFor(engine) {
  let committed = committedByEngine.get(engine);
  if (!committed) {
    committed = new Map();
    committedByEngine.set(engine, committed);
  }
  return committed;
}

/**
 * The content writes running on each engine, from the moment a flush takes
 * its commits out of `committedByEngine` until they are in the document. A
 * closing window judges its workspace only once these are done
 * (`#dropUntouchedWorkspace`), because another window's flush may have taken
 * the closing window's commits and still be writing them.
 *
 * @type {WeakMap<object, Set<Promise<boolean>>>}
 */
const writingByEngine = new WeakMap();

/**
 * @param {object} engine A `SvalEngine`, or the tree a window writes to.
 * @returns {Set<Promise<boolean>>} its content writes in flight
 *   (`writingByEngine`).
 */
function writingFor(engine) {
  let writing = writingByEngine.get(engine);
  if (!writing) {
    writing = new Set();
    writingByEngine.set(engine, writing);
  }
  return writing;
}

/**
 * The observers attached to each engine, so a title held back from the
 * document reaches every window that may draw its node's row, and another
 * device's delete reaches every window that may hold its tab
 * (`keepTabsInFront`).
 *
 * @type {WeakMap<object, Set<SvalTabObserver>>}
 */
const observersByEngine = new WeakMap();

/**
 * The engines whose calls from the last session have been ended
 * (`#endCallsOfLastSession`), which the first window to attach does once.
 *
 * @type {WeakSet<object>}
 */
const callsEnded = new WeakSet();

/**
 * @param {object} engine A `SvalEngine`, or the tree a window writes to.
 * @returns {Set<SvalTabObserver>} its attached observers.
 */
function observersFor(engine) {
  let observers = observersByEngine.get(engine);
  if (!observers) {
    observers = new Set();
    observersByEngine.set(engine, observers);
    engine.addPeerRemovalListener?.(ids => {
      for (const observer of observers) {
        observer.keepTabsInFront(ids);
      }
    });
  }
  return observers;
}

/**
 * The node id `tab` stands for, as anything that grants or checks by node
 * reads it: the id it carries, unless that id was copied onto it from
 * another tab and the observer has not yet given it a node of its own
 * (`#keepOwnNode`). Until then the copy stands for no node, so no take, no
 * agent's grant and no lookup by node reaches it as its original.
 *
 * A tab filed under the id it carries stands for it. A tab filed under
 * another stands for none: another tab's state was restored into it. A tab
 * not filed yet stands for its id only while no other live tab carries it.
 *
 * @param {object} adapter How the tab's id is read (`chromeTabAdapter`).
 * @param {object} tab A Firefox tab.
 * @param {function(object): boolean} [copied] Whether another live tab
 *   carries the id `tab` carries (`copyOf`).
 * @returns {string|null}
 */
function resolveNodeId(adapter, tab, copied = t => !!adapter.copyOf?.(t)) {
  try {
    const id = adapter.nodeId(tab);
    if (!id) {
      return null;
    }
    const filed = filedIds.get(tab);
    if (filed) {
      return filed === id ? id : null;
    }
    return copied(tab) ? null : id;
  } catch (err) {
    return null;
  }
}

/**
 * Whether `tab` carries a node id it does not stand for (`resolveNodeId`):
 * a copy not yet given a node of its own, or a tab whose id cannot be read.
 * Whatever such a tab carries may be the user's, so a check by node treats
 * it as the user's.
 *
 * @param {object} adapter
 * @param {object} tab
 * @returns {boolean}
 */
function isUnsettled(adapter, tab) {
  try {
    return !!adapter.nodeId(tab) && !resolveNodeId(adapter, tab);
  } catch (err) {
    return true;
  }
}

/**
 * Node ids a window's observer has tagged a tab with and is still adding to
 * the document, each with its add. One map for every window in the process,
 * because a tab can leave the window adding its node before the add is done:
 * the agent gate moves a tab Firefox put in the user's window into the
 * agent's (`SvalAgentGate`'s `place`), and the user can drag one. The tab
 * carries its id into the other window, where the tree does not hold it yet.
 *
 * Until the add settles, that tab is not an orphan (`closeOrphanTabs`), and
 * not a tab whose node somebody deleted (`#reconcile`). Read as either, the
 * window it arrived in closes it or files it under a fresh id, and the add
 * then leaves a node in the first window's workspace that no tab shows. A
 * tree read in the window adding the node can also start before the tag
 * and come back after it, which is the same state.
 *
 * @type {Map<string, Promise<unknown>>}
 */
const adding = new Map();

/**
 * The node ids of tabs closed in a window while no observer watched it, by
 * window (`SvalTabs.watchWindow`).
 *
 * A window's panel restores its workspace and attaches its observer only
 * once its delayed startup is over, and the session store can have put tabs
 * in it long before: a window `undoCloseWindow` reopens holds its tabs from
 * the start. A tab the user closes there in between is closed as any other
 * is, so its node goes (spec §5.4). The restore leaves it out
 * (`SvalRestore.restore`) and the observer deletes it as it starts.
 *
 * @type {WeakMap<object, Set<string>>}
 */
const closedUnwatched = new WeakMap();

/**
 * How many observers watch each window. A test can attach a second one
 * beside the window's own.
 *
 * @type {WeakMap<object, number>}
 */
const watchers = new WeakMap();

/**
 * Watches one chrome window. Created by {@link SvalTabs.attach}.
 */
class SvalTabObserver {
  #window;
  #engine;
  #settings;
  #workspaceId;
  #adapter;
  #debounceMs;
  #pollMs;
  #newId;
  #now;
  #newTabParent;
  #syncDocument;
  /** `attach`'s `keep`, read once, by `start`. */
  #keepAtAttach;

  /**
   * Mutations run one at a time and in the order their events arrived. Two
   * concurrent `addTab` calls would each read and write the document, and the
   * engine's own serialisation orders *passes*, not the reads this file makes
   * between them.
   *
   * The panel's callbacks run on it (`#notifyChanged`, `#flushSync`), so
   * nothing they reach may wait for it: `SvalSerialQueue` says why, and reports
   * a wait that does.
   */
  #queue = new SvalSerialQueue("tab observer");

  /**
   * What this engine's tabs have committed and not yet written
   * (`committedFor`).
   *
   * @type {Map<string, {url?: string, name?: string}>}
   */
  get #committed() {
    return committedFor(this.#engine);
  }

  /**
   * The tab `#keepInJar` is replacing, while it opens the replacement. The
   * replacement arrives carrying the same id, and the session store raises
   * `SSTabCustomValuesRestored` for it inside that open, before the tab it
   * replaces has gone, so this is what tells it from a copy (`#copied`).
   * Set and cleared around that one synchronous call.
   *
   * @type {object|null}
   */
  #replacing = null;

  /**
   * What the user has done to splits through Firefox's own UI since the
   * work that writes it (`#writeSplitAct`) last ran: the tabs that moved into,
   * out of or within a split, and the tabs closed while in one, each with
   * the node id it was closed under. Read when that work runs, because one
   * act raises several events, some of them after a tab observer of
   * Firefox's has run, and the act is the state they leave.
   */
  #splitAct = { moved: new Set(), closed: new Map() };

  /** Whether `#writeSplitAct` is queued and has not yet read `#splitAct`. */
  #splitActQueued = false;

  /** How many closes `handleEvent` has queued that have not yet started. */
  #closesQueued = 0;

  /** Whether a close has removed a node that no read since has taken in. */
  #removedUnread = false;

  /** How many writes of widths the user set are queued (`#writeShares`). */
  #sharesQueued = 0;

  #stopWatchingSplitters = null;

  /**
   * Where the tab now being opened is put, when Sval is opening one because a
   * window must have one rather than because the user asked for it. Null at
   * every other moment.
   *
   * Read synchronously in `handleEvent`, the only place it can be read:
   * `openUnfiledTab` sets it, opens the tab and clears it, and `TabOpen` is
   * dispatched inside that call, as `gBrowser.addTab` runs in the same
   * synchronous turn as `URILoadingHelper`'s `openLinkIn`. The work that
   * dispatch queues runs after it is back to null, so the verdict is captured
   * at dispatch.
   *
   * It carries the tab out as well as the verdict in, because Firefox's
   * new-tab command returns nothing (`browser-commands.js`'s `openTab`) and
   * the dispatch is the one place the new tab is in hand.
   */
  #openingUnfiled = null;

  /**
   * Whether the tab now being opened is the user's own new tab (the panel's
   * New tab button, or Firefox's new-tab command from the keyboard or the
   * menu), which is filed at the top of the workspace, outside every group.
   * False at every other moment.
   *
   * Read synchronously in `handleEvent`, for the reason `#openingUnfiled`
   * gives. `newTabParent` answers for every other tab the user opens, such as
   * a link opened in a new tab, which belongs beside the page it came from.
   */
  #openingAtTop = false;

  /**
   * Tabs that have opened in this window, or were open when it attached, and
   * whose reconciliation has not finished. Until it has, a tab's id says
   * where it came from, not what this window will file it as, so the orphan
   * sweep leaves it alone (`closeOrphanTabs`).
   */
  #arriving = new WeakSet();

  /**
   * How many reads of the tree this observer has begun (`#readTree`), and
   * the latest to finish, by when it began, with its nodes: work that needs
   * a read made after it was asked for takes that one when it qualifies.
   */
  #readsBegun = 0;
  #readFinished = { begun: 0, nodes: null };

  /**
   * Copies `#claimCopy` has tagged whose filing `#settleCopy` has yet to
   * run. Their reconciliation leaves them to it.
   */
  #claimed = new WeakSet();

  /**
   * Where `adoptTab` was asked to file each tab it brought in, by node id,
   * until the tab's arrival reads it (`#takePlace`). Keyed by id because
   * Firefox's `adoptTab` makes a new tab in this window for the one it moves.
   */
  #places = new Map();

  #stopWatchingNavigation = null;

  /** Stops `watchTitles`, or null before `start`. */
  #stopWatchingTitles = null;

  /** Stops `watchClosing`, or null before `start`. */
  #stopWatchingClosing = null;
  #stopWatchingNewTabCommand = null;
  #syncTimer = null;
  #pollTimer = null;

  /** Which of this window's tabs' titles wait before they are written. */
  #titleHold;

  #useTimer = null;
  #idleTimer = null;
  #stopWatchingUse = null;
  #detached = false;

  /**
   * Tab -> when this window hid it with its workspace, in `#now`'s
   * milliseconds. See {@link releaseIdle}.
   */
  #hiddenSince = new WeakMap();

  /**
   * Tab -> its node id, for each tab in front of the user whose node another
   * device deleted, while `#putBack` gives the node back. The orphan sweep
   * leaves these alone.
   */
  #keeping = new Map();

  /** The tabs `#releaseOrHide` is hiding, while their `TabHide` runs. */
  #hidingForWorkspace = new WeakSet();

  /**
   * What ends each wait on the window that has not settled. See
   * `#fromWindow`.
   */
  #windowWaits = new Set();

  /**
   * What `nodeIdFor` and `tabFor` have answered inside `withTabLookups`, or
   * null outside it.
   *
   * @type {?{version: number, ids?: Map<object, ?string>, copied?: Function, tabs?: Map<string, object>}}
   */
  #lookups = null;

  constructor(window, options) {
    this.#window = window;
    this.#engine = options.engine;
    this.#settings = options.settings ?? null;
    this.#workspaceId = options.workspaceId;
    this.#adapter = options.adapter ?? chromeTabAdapter;
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.#pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.#titleHold = new SvalTitleHold(
      id => this.#releaseTitle(id),
      options.titleHoldMs
    );
    this.#newId = options.newId ?? (() => crypto.randomUUID());
    this.#now = options.now ?? (() => SvalClock.now());
    // Where a tab the user just opened is filed. Only the panel knows the
    // group the user is working in; with no panel, the workspace itself.
    this.#newTabParent = options.newTabParent ?? (() => this.#workspaceId);
    this.#syncDocument = options.syncDocument ?? null;
    this.#keepAtAttach = options.keep ? new Set(options.keep) : null;
    // The document Sval syncs is named separately from the workspace tabs are
    // filed under: one document holds every workspace, and every device
    // pointed at one folder must name it identically, because the engine
    // hashes this string into the path. A workspace id is minted per device,
    // so keying the pass on one leaves two devices unable to see each other.
    // An observer with no document to sync still files tabs and publishes
    // nothing; passing `sync` an absent document would fail across the wasm
    // boundary on every poll.
    this.onFlush =
      options.onFlush ??
      (options.syncDocument
        ? ({ idleWithinMs = 0 } = {}) =>
            this.#engine.sync(options.syncDocument, SvalClock.now(), {
              idleWithinMs,
            })
        : () => {});
    // What redraws the surface the user is looking at. Called after every
    // mutation this observer makes, and awaited, so a test that has waited for
    // the observer has waited for the panel too.
    this.onTreeChanged = options.onTreeChanged ?? (() => {});
    this.onTabSelected = options.onTabSelected ?? (() => {});
    this.onTabIconChanged = options.onTabIconChanged ?? (() => {});
    this.onTabLoadChanged = options.onTabLoadChanged ?? (() => {});
    this.onTabHiddenChanged = options.onTabHiddenChanged ?? (() => {});
    this.onKeptTabShown = options.onKeptTabShown ?? (() => {});
    this.onTabSoundChanged = options.onTabSoundChanged ?? (() => {});
    // A title held back from the document (`pendingName`), which the panel
    // paints into the node's row alone.
    this.onTitleHeld = options.onTitleHeld ?? (() => {});
  }

  get window() {
    return this.#window;
  }

  get engine() {
    return this.#engine;
  }

  get detached() {
    return this.#detached;
  }

  /**
   * Starts listening and reconciles the tabs that are already open.
   *
   * @returns {Promise<void>} resolves once every tab in the window is tracked,
   *   which is when a test may assert on the tree.
   */
  async start() {
    observersFor(this.#engine).add(this);
    const target = this.#adapter.eventTargetOf(this.#window);
    for (const type of EVENTS) {
      target.addEventListener(type, this);
    }
    this.#stopWatchingNavigation =
      this.#adapter.watchNavigation?.(this.#window, (tab, url, title) =>
        this.#noteCommitted(tab, url, title)
      ) ?? null;
    this.#stopWatchingTitles =
      this.#adapter.watchTitles?.(this.#window, (tab, title) =>
        this.#noteTitle(tab, title)
      ) ?? null;
    this.#stopWatchingClosing =
      this.#adapter.watchClosing?.(this.#window, event =>
        this.#noteFormerParent(event)
      ) ?? null;
    this.#stopWatchingNewTabCommand =
      this.#adapter.watchNewTabCommand?.(
        this.#window,
        () => {
          this.#openingAtTop = true;
        },
        () => {
          this.#openingAtTop = false;
        }
      ) ?? null;
    this.#stopWatchingUse =
      this.#adapter.watchUse?.(this.#window, tab => {
        const id = this.nodeIdFor(tab);
        if (id) {
          this.noteUse(id);
        }
      }) ?? null;
    this.#window.addEventListener("unload", this, { once: true });
    this.#stopWatchingSplitters =
      this.#adapter.watchSplitters?.(this.#window, () =>
        this.#splitterReleased()
      ) ?? null;

    watchers.set(this.#window, (watchers.get(this.#window) ?? 0) + 1);
    this.#scheduleIdleSweep();
    await this.#readTree();
    if (!callsEnded.has(this.#engine) && !this.#engine.isPrivate) {
      callsEnded.add(this.#engine);
      this.#queue.post(() => this.#endCallsOfLastSession());
    }

    // A tab reopened since under the same id, by Undo Close Tab, keeps it,
    // wherever it has been carried.
    const closed = closedUnwatched.get(this.#window) ?? new Set();
    closedUnwatched.delete(this.#window);
    for (const id of closed) {
      if (!this.#adapter.isCarried?.(id)) {
        this.#queue.post(() => this.#remove(id));
      }
    }

    // Every tab already open at attach predates this observer, so none of them
    // arrived through `TabOpen`. One whose node is outside `keep` is left to
    // the caller's `releaseTabsOutside`: the session can restore a window
    // with a tab whose node another window's tab carries, and reconciling it
    // would file it as a copy (`#keepOwnNode`), a new node the release then
    // keeps.
    const keep = this.#keepAtAttach;
    this.#keepAtAttach = null;
    for (const tab of this.#adapter.tabsOf(this.#window)) {
      const id = keep && this.#adapter.nodeId(tab);
      if (id && !keep.has(id)) {
        continue;
      }
      this.#reconcileArrival(tab, { restored: true, attaching: true });
    }
    await this.#queue.idle();

    this.#schedulePoll();
  }

  /**
   * Stops listening, and runs now whatever the debounce was holding.
   *
   * A window's last edits live only in the worker's document until a pass
   * publishes them, so a window that closes inside the debounce window must
   * publish on its way out. Queued work still runs first, which matters for a
   * close dispatched in the same turn as the window's `unload`.
   *
   * What the window's tabs committed is taken here, synchronously, so a
   * commit that arrives after the window has gone is no part of it.
   *
   * @param {object} [options]
   * @param {boolean} [options.dropUntouched] Whether the window's workspace is
   *   its own to delete, if nobody touched it (`#dropUntouchedWorkspace`).
   *   The panel answers, because which windows show which workspace is its
   *   to know.
   * @returns {Promise<void>} settles once that last flush is done.
   */
  detach({ dropUntouched = false } = {}) {
    if (this.#detached) {
      return this.#queue.idle();
    }
    this.#detached = true;
    watchers.set(this.#window, (watchers.get(this.#window) ?? 1) - 1);
    for (const end of this.#windowWaits) {
      end();
    }

    const target = this.#adapter.eventTargetOf(this.#window);
    for (const type of EVENTS) {
      target.removeEventListener(type, this);
    }
    this.#stopWatchingNavigation?.();
    this.#stopWatchingNavigation = null;
    this.#stopWatchingTitles?.();
    this.#stopWatchingTitles = null;
    this.#stopWatchingClosing?.();
    this.#stopWatchingClosing = null;
    this.#stopWatchingNewTabCommand?.();
    this.#stopWatchingNewTabCommand = null;
    this.#stopWatchingSplitters?.();
    this.#stopWatchingSplitters = null;
    this.#stopWatchingUse?.();
    this.#stopWatchingUse = null;
    clearTimeout(this.#useTimer);
    this.#useTimer = null;
    clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    this.#titleHold.stop();
    observersFor(this.#engine).delete(this);

    const syncPending = this.#syncTimer !== null;
    for (const timer of [this.#syncTimer, this.#pollTimer]) {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
    this.#syncTimer = null;
    this.#pollTimer = null;

    const content = this.#takeChangedContent();
    const flushed = this.#enqueue(async () => {
      await this.#flushOnDetach(content, syncPending, dropUntouched);
      await this.#flushSettings();
    });
    // Nothing awaits an `unload` handler, so during a quit the profile's
    // shutdown blocker is what keeps the process alive for this.
    this.#engine.finishBeforeShutdown(flushed);
    return flushed;
  }

  /**
   * The last flush of a detached observer.
   *
   * With a document to sync it publishes through the engine directly, and
   * only if the engine holds something unpublished: `onFlush` redraws the
   * panel, whose window is gone by now.
   *
   * @param {object[]} content What `#takeChangedContent` took at detach.
   * @param {boolean} syncPending Whether the debounce was holding a pass.
   * @param {boolean} dropUntouched See `detach`.
   */
  async #flushOnDetach(content, syncPending, dropUntouched) {
    try {
      await this.#writeContent(content);
      if (dropUntouched) {
        await this.#dropUntouchedWorkspace();
      }
      if (this.#syncDocument) {
        await this.#engine.publishPending(this.#syncDocument);
      } else if (syncPending) {
        await this.#fromWindow(this.onFlush({ idleWithinMs: 0 }));
      }
    } catch (err) {
      SvalLog.warn(`sync as the window closed failed: ${describeError(err)}`);
    }
  }

  /**
   * Deletes the workspace this closing window showed, with its one tab, if
   * nobody touched it (`isUntouchedWorkspace`, decision 0101). A window
   * opened with every workspace already open gets a new one, and closing it
   * would otherwise leave an empty workspace in the document on every device.
   *
   * Judged after every content write taken before it is in the document,
   * this window's last and any other window's flush holding this window's
   * commits (`writingByEngine`), so a tab that left the home page inside the
   * debounce keeps its workspace. The last workspace stays, as "Delete
   * workspace" keeps it, because a window with none has nothing to show.
   */
  async #dropUntouchedWorkspace() {
    await Promise.allSettled(writingFor(this.#engine));
    const nodes = (await this.#engine.tree()).nodes ?? {};
    const id = this.#workspaceId;
    if (!isUntouchedWorkspace(nodes, id) || workspaceIds(nodes).length < 2) {
      return;
    }
    await removeNodes(this.#engine, this.#settings, nodes, [id]);
    this.#settings?.saveSoon();
  }

  /**
   * Every event is read synchronously and only the resulting mutation is
   * deferred: the DOM has moved on by the time the queued work runs, and a
   * closing tab is torn down straight after its event.
   *
   * @param {Event} event
   */
  handleEvent(event) {
    tabIdsChanged();
    if (event.type === "unload") {
      this.detach();
      return;
    }

    const tab = event.target;
    // A Quick Peek's tab is filed only once it is kept, and a pin's page once it is
    // unpinned (`fileTab`).
    if (this.#adapter.standsForNoNode?.(tab)) {
      return;
    }

    switch (event.type) {
      case "TabOpen": {
        // Deferred rather than read here: a tab dragged in from another window
        // has its node id moved across by `SessionStore`'s own `TabOpen`
        // handler (`moveCustomTabValue`), which listens further up the bubble
        // path than this does. Queueing the read puts it after the
        // whole dispatch, so the id is in place and the tab is recognised
        // instead of being tagged a second time.
        //
        // Whether Sval opened this tab for the window's sake is the one thing
        // that cannot be deferred, because what says so is only set during
        // the dispatch. See `#openingUnfiled`.
        const unrequested = !!this.#openingUnfiled;
        if (unrequested) {
          this.#openingUnfiled.tab = tab;
          this.#adapter.markUnfiled?.(tab);
        }
        // Consumed by the one tab it was set for, so a command that opened
        // its tab in another window cannot hand the verdict to a later one.
        const atTop = this.#openingAtTop;
        this.#openingAtTop = false;
        const outside = this.#adapter.isFromOutside?.(event) === true;
        this.#markAdopted(event, outside);
        this.#reconcileArrival(tab, {
          restored: false,
          unrequested,
          atTop,
          outside,
        });
        this.#queueKeepInJar(tab);
        // The session store opens a split it restores with its tabs already
        // in it, and raises no `TabMove` (`MozTabSplitViewWrapper.addTabs`
        // with `isSessionRestore`). The split is the tab's act, queued after
        // its filing: a split act queued before it can hold the closes of
        // the tabs the restore replaced, whose ids the restored tabs carry
        // when the restored state was saved from them.
        if (this.#adapter.splitOf?.(tab)) {
          this.#queue.post(() => {
            if (this.#adapter.splitOf?.(tab)) {
              this.#splitAct.moved.add(tab);
              this.#queueSplitAct();
            }
          });
        }
        break;
      }

      case "TabClose": {
        // A tab dragged to another window closes here and opens there, keeping
        // its node id: the node must survive the move, so only a genuine close
        // deletes it. `adoptedBy` tells the two apart, as the extensions'
        // `ext-browser.js` reads it.
        const adopter = SvalFirefox.adoptedBy(event);
        if (adopter) {
          // And the destination tab is marked as it goes, because this is the
          // one event both of Firefox's move routes raise and the one place the
          // node id crosses. `SVAL_ADOPTED_ATTRIBUTE` carries the rest.
          this.#adapter.markAdopted?.(adopter);
          break;
        }
        // A tab Sval takes out of the window: a switch releasing the
        // workspace it leaves, a node deleted elsewhere, or a tab reopened in
        // its workspace's jar. Firefox keeps it out of the recently-closed
        // list (`release`), and its node, if it still has one, stays.
        if (SvalFirefox.skipsSessionStore(event)) {
          break;
        }
        // The last tab closing the window with it. Closing a window closes the
        // workspace's view (spec §5.4), so its node stays for the next window
        // to show, unless the detach finds the workspace untouched
        // (`#dropUntouchedWorkspace`).
        if (SvalFirefox.closesWindow(event)) {
          break;
        }
        // The node this observer filed the tab under answers first. A copy
        // closed before `#keepOwnNode` has run carries its original's id, and
        // closing the copy must not delete the original's node.
        const id =
          filedIds.get(tab) ??
          (this.#adapter.copyOf?.(tab) ? null : this.#adapter.nodeId(tab));
        // A pane closing is a change to its split, written with it.
        if (this.#adapter.splitOf?.(tab)) {
          this.#splitAct.closed.set(tab, id);
          this.#queueSplitAct();
          break;
        }
        // An untagged tab here was closed before the `TabOpen` work that would
        // tag it has run, as a burst of opens and closes does. The id is
        // resolved again inside the queue, by when reconciliation has minted
        // it; `filedIds` answers then, because the session store's copy
        // belongs to a tab being torn down.
        this.#closesQueued++;
        this.#queue.post(() => {
          this.#closesQueued--;
          const closing = id ?? filedIds.get(tab);
          // Closed, it is filed under nothing.
          filedIds.delete(tab);
          return this.#removeClosed(closing);
        });
        break;
      }

      case "TabMove": {
        // A move Sval makes to show the splits the document holds, which
        // writes nothing (split-view spec §6.1).
        if (SvalFirefox.movedBySval(event)) {
          break;
        }
        // Into a split, out of one or within one: the act is the split's,
        // and its write orders the panes, so no move is written against
        // the strip's neighbours.
        const { previousTabState: was, currentTabState: is } =
          event.detail ?? {};
        if (was?.splitViewId !== undefined || is?.splitViewId !== undefined) {
          this.#splitAct.moved.add(tab);
          this.#queueSplitAct();
          break;
        }
        const id = this.#adapter.nodeId(tab);
        if (id) {
          // Read where the node sits first. A move made outside this
          // observer, by the panel or by another window's code, leaves the
          // cache naming the parent it had before, and a reorder under that
          // parent would carry the node back there.
          this.#queue.post(async () => {
            await this.#readTree();
            // A tab closed or carried to another window since has no place
            // in this strip, and ordering it against none would send its
            // node to the end of its parent.
            if (this.#gone(tab)) {
              return;
            }
            const { before, after } = this.#neighbours(tab);
            await this.#move(id, before, after);
          });
        }
        break;
      }

      case "TabSelect": {
        const id = this.nodeIdFor(tab);
        if (id) {
          this.#markActive(id);
          this.onTabSelected(id);
        }
        break;
      }

      case "TabBrowserDiscarded": {
        const id = this.nodeIdFor(tab);
        if (id) {
          this.onTabLoadChanged(id);
        }
        break;
      }

      case "TabAttrModified":
        this.#tabAttrModified(tab, event.detail?.changed ?? []);
        break;

      case MEDIA_CHANGED_EVENT: {
        const id = this.nodeIdFor(tab);
        if (id) {
          this.onTabSoundChanged(id);
        }
        break;
      }

      case "TabHide":
      case "TabShow": {
        const id = this.nodeIdFor(tab);
        if (id) {
          // Asked here, as the tab is shown: by its `TabSelect`, Firefox has
          // forgotten who hid it.
          if (
            event.type === "TabShow" &&
            this.#adapter.isShowingFromWorkspaceHide?.(tab)
          ) {
            this.onKeptTabShown(id);
            break;
          }
          // The panel leaves out the tabs an extension hid; a tab hidden with
          // its workspace has no row here either way, and a redraw in the
          // middle of a switch would draw from the tree as it was before it.
          // `hideTab` records who hid a tab only after its `TabHide`.
          if (!this.#hidingForWorkspace.has(tab)) {
            this.onTabHiddenChanged(id);
          }
        }
        break;
      }

      case "SSTabCustomValuesRestored":
        this.#claimCopy(tab);
        break;

      case "TabSplitViewActivate":
        this.#queue.post(() => this.#showWidths());
        break;

      case "SSTabRestoring": {
        const id = this.nodeIdFor(tab);
        if (id) {
          this.onTabLoadChanged(id);
        }
        // The session store restores a duplicate after its `TabOpen`, so
        // this is the first event after the copied id is on the tab.
        if (this.#adapter.nodeId(tab)) {
          this.#queue.post(() => this.#keepOwnNode(tab));
        }
        break;
      }
    }
  }

  /**
   * Runs the work the debounce is holding, then waits for the queue to drain:
   * once it resolves, every tab event this window has seen is filed in the
   * document. A caller that needs a tab's node now, such as an agent's tab
   * just opened or closed, waits for this rather than for the debounce. Tests
   * wait for it too, so they never depend on wall-clock time.
   *
   * @returns {Promise<void>}
   */
  async settled() {
    await this.#queue.idle();
    await this.#flushSettings();
    const held = [...this.#committed.values()].some(entry => entry.held);
    if (this.#syncTimer !== null || held) {
      clearTimeout(this.#syncTimer);
      this.#syncTimer = null;
      await this.#flushSync();
    }
    await this.#queue.idle();
  }

  /**
   * Undo close tab's key (Ctrl+Shift+T): reopens the tab this window closed
   * last in the workspace it shows now. A tab closed while the window showed
   * another workspace stays closed until the window shows that one again
   * (`FORMER_WORKSPACE_KEY`). A tab closed with no workspace filed counts as
   * the shown workspace's.
   *
   * The tab opens straight into the jar of the workspace it is reopened in,
   * so it never loads in another first: when the jar it closed in is another,
   * as after the workspace was isolated or stopped being isolated, it opens
   * afresh at its address in that jar, without its history, as `#keepInJar`
   * reopens a tab, and its node comes back as any closed tab's does.
   *
   * @returns {object|null} the reopened tab, or null when the workspace has
   *   no closed tab here.
   */
  reopenClosedTab() {
    const window = this.#window;
    const closed = this.#adapter.closedTabs?.(window) ?? [];
    const index = closed.findIndex(
      ({ state }) =>
        (state?.extData?.[FORMER_WORKSPACE_KEY] || this.#workspaceId) ===
        this.#workspaceId
    );
    if (index < 0) {
      return null;
    }
    const { state, title } = closed[index];
    const nodes = latestNodes(this.#engine) ?? {};
    const jar =
      this.#engine.isPrivate || !this.#adapter.jarFor
        ? null
        : this.#adapter.jarFor(nodes, this.#workspaceId);
    const recorded = state?.userContextId ?? 0;
    if (
      jar === null ||
      jar === recorded ||
      this.#adapter.isClientsJar?.(recorded)
    ) {
      return this.#adapter.undoClose(window, index);
    }
    const url = urlOfState(state);
    const id = state?.extData?.[NODE_ID_KEY] || this.#newId();
    this.#adapter.forgetClosed(window, index);
    if (!url) {
      return null;
    }
    const tab = this.#adapter.openInJar(
      window,
      { kind: TAB, content: { url, name: title ?? "" } },
      id,
      jar
    );
    if (!tab) {
      return null;
    }
    const parent = state?.extData?.[FORMER_PARENT_KEY];
    if (parent) {
      this.#adapter.setFormerParent?.(tab, parent);
    }
    window.gBrowser.selectedTab = tab;
    return tab;
  }

  /**
   * Files on a tab the user is closing where its node sits in the tree, so
   * the closed tab Firefox keeps carries it (`FORMER_PARENT_KEY`). A tab
   * moving to another window, closing with its window, or taken out by Sval
   * is no closed tab, and Firefox records none for it.
   *
   * @param {Event} event A `TabClose` event.
   */
  #noteFormerParent(event) {
    if (
      SvalFirefox.adoptedBy(event) ||
      SvalFirefox.closesWindow(event) ||
      SvalFirefox.skipsSessionStore(event)
    ) {
      return;
    }
    const tab = event.target;
    const id =
      filedIds.get(tab) ??
      (this.#adapter.copyOf?.(tab) ? null : this.#adapter.nodeId(tab));
    const nodes = latestNodes(this.#engine);
    const parent = id ? nodes?.[id]?.placement?.parent : null;
    if (parent) {
      this.#adapter.setFormerParent?.(tab, parent);
    }
    this.#adapter.setFormerWorkspace?.(
      tab,
      (id && workspaceOfNode(nodes ?? {}, id)) || this.#workspaceId
    );
  }

  /**
   * Files `tab`'s node within `workspaceId`, at the place a node lands when
   * nobody named one (`SvalPanelModel.moveIntoTarget`), unless it is somewhere
   * within that workspace already. This is how a tab that carried its node
   * in from another window comes to belong to the workspace this window
   * shows.
   *
   * It runs on this observer's queue, so where the node sits is read and the
   * node moved in one step that no other work of this window's can split.
   *
   * @param {object} tab A Firefox tab in this window.
   * @param {string} workspaceId The workspace this window shows.
   * @returns {Promise<string|null>} `workspaceId` once the node is within it,
   *   or null when the tab has left the window or the document holds no node
   *   for it. Rejects when the move is refused.
   */
  refile(tab, workspaceId) {
    return this.#queue.run(() => this.#refile(tab, workspaceId));
  }

  /**
   * Files `tab` now, as a tab the user opened is filed, blank or not, and
   * reads the document back once the write has landed. The agent gate asks
   * this of a tab whose first load starts before the tab has a node: the
   * load waits for it (`SvalAgentGate`), so whose the tab is comes from the
   * tree before anything loads in it.
   *
   * @param {object} tab A Firefox tab in this window.
   * @returns {Promise<void>} Settles once the filing has landed or failed.
   */
  fileNow(tab) {
    return this.#queue.run(async () => {
      if (!this.#adapter.nodeId(tab)) {
        await this.#reconcile(tab, { restored: false });
      }
      await this.#readTree();
    });
  }

  /**
   * Moves `tab`, another window's, into this window at `place` in its
   * workspace: a tab row dropped on this window's panel. The move is
   * Firefox's own `gBrowser.adoptTab`, and its arrival is filed as any tab
   * carried in from another window is (`#takeArrival`), at `place` in place
   * of the default, and only once asked when it crosses into another jar.
   *
   * @param {object} tab A Firefox tab of another window.
   * @param {object} place `SvalPanelModel.dropTarget`'s `{ id, newParent,
   *   before, after }`.
   * @returns {object|null} the tab that stands for it here, or null when
   *   Firefox refused the move.
   */
  adoptTab(tab, place) {
    this.#places.set(place.id, place);
    const moved = this.#window.gBrowser.adoptTab(tab, { selectTab: true });
    if (!moved) {
      this.#places.delete(place.id);
    }
    return moved;
  }

  /**
   * The place `adoptTab` named for node `id`, taken once.
   *
   * @param {string} id
   * @returns {object|null}
   */
  #takePlace(id) {
    const place = this.#places.get(id) ?? null;
    this.#places.delete(id);
    return place;
  }

  /**
   * @param {object} tab
   * @param {string} workspaceId
   * @param {object|null} [place] Where in the workspace to file it, as
   *   `SvalPanelModel.dropTarget` names a place: `{ newParent, before,
   *   after }`. A place whose parent is no longer within the workspace is
   *   passed over for the default one.
   */
  async #refile(tab, workspaceId, place = null) {
    const id = this.#adapter.nodeId(tab);
    if (!id || this.#gone(tab)) {
      return null;
    }
    const nodes = await this.#readTree();
    if (!nodes[id]) {
      return null;
    }
    if (isWithin(nodes, id, workspaceId)) {
      return workspaceId;
    }
    const target =
      place && isWithin(nodes, place.newParent, workspaceId)
        ? { ...place, id }
        : moveIntoTarget(nodes, id, workspaceId);
    if (!target) {
      throw new Error(`${id} cannot be filed under ${workspaceId}`);
    }
    // A pane carried out of its split leaves it in shape (split-view spec
    // §5.2).
    await this.#engine.mutate({
      kind: "batch",
      ops: [{ kind: "moveNode", ...target }, ...splitShapeOps(nodes, [id])],
      now: this.#now(),
    });
    const read = await this.#readTree();
    this.#scheduleSync();
    await this.#notifyChanged(read);
    return workspaceId;
  }

  /**
   * The node id `tab` stands for, or null (`resolveNodeId`).
   *
   * @param {object} tab A Firefox tab.
   */
  nodeIdFor(tab) {
    const lookups = this.#currentLookups();
    if (!lookups) {
      return resolveNodeId(this.#adapter, tab);
    }
    lookups.ids ??= new Map();
    if (!lookups.ids.has(tab)) {
      lookups.copied ??=
        this.#adapter.copyFinder?.() ?? (t => !!this.#adapter.copyOf?.(t));
      lookups.ids.set(tab, resolveNodeId(this.#adapter, tab, lookups.copied));
    }
    return lookups.ids.get(tab);
  }

  /**
   * The live tab this window holds for `id`, or null when the node has none.
   *
   * Read from the window's tabs: a tab dragged between windows takes its node
   * id with it, so which window holds a node is not a fact this observer can
   * keep. Inside `withTabLookups` one read of them answers every call.
   *
   * @param {string} id A node id.
   * @returns {object|null} a Firefox tab.
   */
  tabFor(id) {
    if (!id) {
      return null;
    }
    const lookups = this.#currentLookups();
    if (!lookups) {
      return (
        this.#adapter
          .tabsOf(this.#window)
          .find(tab => this.nodeIdFor(tab) === id) ?? null
      );
    }
    if (!lookups.tabs) {
      const tabs = new Map();
      for (const tab of this.#adapter.tabsOf(this.#window)) {
        const tabId = this.nodeIdFor(tab);
        if (tabId && !tabs.has(tabId)) {
          tabs.set(tabId, tab);
        }
      }
      lookups.tabs = tabs;
    }
    return lookups.tabs.get(id) ?? null;
  }

  /**
   * Runs `fn`, answering its `nodeIdFor` and `tabFor` calls from one read of
   * the tabs, which a pass over every row would otherwise repeat for each
   * row against every tab. The answers are dropped whenever `tabIdsVersion`
   * moves, and `fn` must not wait: the count moves only for what observers
   * see, and `SessionStore` also sets a tab's custom values on its own
   * (`moveCustomTabValue`, `restoreTab`).
   *
   * @param {Function} fn Synchronous.
   * @returns {*} what `fn` returns.
   */
  withTabLookups(fn) {
    if (this.#lookups) {
      return fn();
    }
    this.#lookups = { version: tabIdsVersion };
    try {
      return fn();
    } finally {
      this.#lookups = null;
    }
  }

  /**
   * The answers `withTabLookups` holds, emptied if a tab has changed since
   * they were read, or null outside it.
   */
  #currentLookups() {
    if (this.#lookups && this.#lookups.version !== tabIdsVersion) {
      this.#lookups = { version: tabIdsVersion };
    }
    return this.#lookups;
  }

  /**
   * @param {object} tab A Firefox tab.
   * @param {string} id The node id to tag it with, or "" for none.
   */
  #setNodeId(tab, id) {
    this.#adapter.setNodeId(tab, id);
    tabIdsChanged();
  }

  /**
   * The favicon address of the live tab this window holds for `id`.
   *
   * @param {string} id A node id.
   * @returns {string|null} null when the node has no live tab here, or the tab
   *   has no favicon.
   */
  iconFor(id) {
    const tab = this.tabFor(id);
    return tab ? this.#adapter.icon(tab) : null;
  }

  /**
   * Whether the tab this window holds for `id` has loaded its page.
   *
   * @param {string} id A node id.
   * @returns {boolean} false when the node has no live tab here, or its tab has
   *   not loaded.
   */
  isLoaded(id) {
    const tab = this.tabFor(id);
    return !!tab && this.#adapter.isLoaded(tab);
  }

  /**
   * Whether the tab this window holds for `id` is loading a page.
   *
   * @param {string} id A node id.
   * @returns {boolean} false when the node has no live tab here.
   */
  isBusy(id) {
    const tab = this.tabFor(id);
    return !!tab && this.#adapter.isBusy(tab);
  }

  /**
   * Shows the tab `id` names, if this window has one.
   *
   * @param {string} id A node id.
   * @returns {boolean} whether a live tab was found and selected.
   */
  selectNode(id) {
    const tab = this.tabFor(id);
    if (!tab) {
      return false;
    }
    this.#adapter.select(this.#window, tab);
    return true;
  }

  /**
   * Opens a new tab in this window. The node is filed by the `TabOpen` that
   * follows: at the top of the workspace, as the keyboard's new tab is, or
   * under whatever the panel names as the place new tabs go.
   *
   * @param {object} [options]
   * @param {boolean} [options.inSelection] File it where `newTabParent` says,
   *   as a link opened in a new tab is, rather than at the top. For a command
   *   aimed at one row, such as the row's context menu.
   */
  openNewTab({ inSelection = false } = {}) {
    this.#openingAtTop = !inSelection;
    try {
      this.#adapter.openNewTab(this.#window);
    } finally {
      this.#openingAtTop = false;
    }
  }

  /**
   * Files `tab`, a tab of this window's that no node describes, as `TabOpen`
   * files a tab the user opens: where `newTabParent` says, between its
   * neighbours in the strip, in its workspace's jar. A Quick Peek's tab is filed
   * this way when the user keeps it (`SvalQuickPeek`), as `TabOpen` left it.
   *
   * @param {object} tab A Firefox tab in this window.
   * @param {object} [options]
   * @param {object} [options.beside] A tab of this window's to file it beside,
   *   under that tab's parent, whatever the panel has selected.
   * @param {boolean} [options.atTop] File it in the workspace itself, as the
   *   user's own new tab is, between its neighbours in the strip.
   * @returns {Promise<string|null>} the tab's node id once it is filed, or
   *   null when it left the window first.
   */
  fileTab(tab, { beside = null, atTop = false } = {}) {
    this.#arriving.add(tab);
    return this.#queue.run(async () => {
      try {
        await this.#reconcile(tab, { restored: false, beside, atTop });
      } finally {
        this.#arriving.delete(tab);
      }
      await this.#keepInJar(tab);
      return this.#gone(tab) ? null : this.nodeIdFor(tab);
    });
  }

  /**
   * Takes `tab`, a filed tab of this window's, out of the tree while it stays
   * open: its node is deleted and the tab carries no id, as a tab nobody
   * filed. A pin made from a tab keeps the tab as its page (pins spec §8.1),
   * and the caller marks it first (`SvalPinTab`), so nothing files it again.
   *
   * @param {object} tab A Firefox tab in this window.
   * @returns {Promise<void>} settles once the node is gone.
   */
  unfile(tab) {
    const id = filedIds.get(tab) ?? this.#adapter.nodeId(tab);
    filedIds.delete(tab);
    this.#adapter.clearNodeId?.(tab);
    tabIdsChanged();
    return this.#queue.run(() => (id ? this.#remove(id) : undefined));
  }

  /**
   * Opens the tab a window needs when the workspace it has just been given
   * holds none.
   *
   * It opens Firefox's new-tab page, which is Sval's home page, and the content
   * path files it once it shows that page, so the workspace gains it as a row
   * and the next visit finds it there rather than opening another. It is
   * marked as Sval's own until then, so `closeUnfiledTabs` can take it back if
   * the workspace is left before the page commits.
   *
   * @param {object} [options]
   * @param {boolean} [options.blank] Open `about:blank` instead, which stays
   *   unfiled (see `isBlank`). For a window whose workspace must not gain a tab
   *   nobody opened in it, such as an agent's.
   * @returns {object|null} the tab opened.
   */
  openUnfiledTab({ blank = false } = {}) {
    const opening = { tab: null };
    this.#openingUnfiled = opening;
    try {
      this.#adapter.openNewTab(this.#window, blank ? "about:blank" : undefined);
    } finally {
      this.#openingUnfiled = null;
    }
    return opening.tab;
  }

  /**
   * Takes back the blank tabs Sval opened for the window's sake, except
   * `except`, and only while they are still untagged.
   *
   * `releaseTabsOutside` skips a tab carrying no node, because such a tab
   * belongs to no workspace, so a tab Sval opened that stayed unfiled would be
   * left with no row to draw it and no tab strip to reach it. A home-page tab
   * is filed, so this leaves it to `releaseTabsOutside`.
   *
   * **Being untagged is what keeps this safe.** A tab the user went somewhere
   * in was filed by the content path the moment they did, so it has a node
   * and a row, and this leaves it alone.
   *
   * `except` is the tab the caller has just opened for the workspace being
   * arrived at, which the call clearing the last visit's tab must not take.
   *
   * @param {object} [except] A tab to leave alone.
   * @returns {number} how many tabs were closed.
   */
  closeUnfiledTabs(except = null) {
    let closed = 0;
    for (const tab of this.#adapter.tabsOf(this.#window)) {
      if (
        tab === except ||
        this.#adapter.nodeId(tab) ||
        !this.#adapter.isUnfiled?.(tab)
      ) {
        continue;
      }
      this.#adapter.release(this.#window, tab);
      closed++;
    }
    return closed;
  }

  /**
   * Closes this window's tabs for `ids`, whose nodes the caller has deleted
   * in one engine call of its own, so each `TabClose` finds its node gone and
   * deletes nothing (`#remove`). Each closes as a person's close does, so Firefox's
   * recently-closed list keeps it, and a tab handed back from there goes
   * where it was in `nodes` (`FORMER_PARENT_KEY`).
   *
   * @param {Iterable<string>} ids Node ids.
   * @param {object} nodes The document's nodes as the caller read them before
   *   the delete.
   * @returns {string[]} the ids whose tabs were closed.
   */
  closeNodes(ids, nodes) {
    const closed = [];
    for (const id of ids) {
      const tab = this.tabFor(id) ?? this.#openToClose(nodes, id);
      if (!tab) {
        continue;
      }
      const parent = nodes?.[id]?.placement?.parent;
      if (parent) {
        this.#adapter.setFormerParent?.(tab, parent);
      }
      this.#adapter.setFormerWorkspace?.(
        tab,
        workspaceOfNode(nodes ?? {}, id) ?? this.#workspaceId
      );
      this.#adapter.close(this.#window, tab);
      closed.push(id);
    }
    return closed;
  }

  /**
   * A lazy tab for tab node `id`, which this window has not opened, for
   * {@link closeNodes} to close at once. Its row is a tab the user closed,
   * and Firefox's recently-closed list keeps only a tab that was in the
   * window (`maybeSaveClosedTab`): without one, Undo Close Tab would have
   * nothing to give back for a tab that came from another device and was
   * never opened here. The tab costs a `<tab>` and no page load
   * (`SvalRestore.open`), and its arrival finds it gone (`#gone`).
   *
   * @param {object} nodes The document's nodes as they stood before the
   *   delete.
   * @param {string} id
   * @returns {?object} the tab, or null for a node with no page to reopen.
   */
  #openToClose(nodes, id) {
    const node = nodes?.[id];
    if (node?.kind !== TAB || !node.content?.url) {
      return null;
    }
    const workspace = workspaceOfNode(nodes, id) ?? this.#workspaceId;
    const jar =
      this.#engine.isPrivate || !this.#adapter.jarFor
        ? 0
        : this.#adapter.jarFor(nodes, workspace);
    return this.#adapter.openToClose?.(this.#window, node, id, jar) ?? null;
  }

  /**
   * Gives the window a blank tab when `ids` account for every visible tab it
   * has, so that closing them does not close the window.
   *
   * `removeTab` on a window's last tab closes the window
   * (`browser.tabs.closeWindowWithLastTab`), and a panel in the middle of a
   * close then has its `await`s abandoned half way: the container's removal,
   * the settings flush and the sync pass never run. A torn-off window showing
   * a workspace with one tab is the ordinary case.
   *
   * With `closeWindowWithLastTab: false`, `_beginRemoveTab` inserts a
   * replacement tab synchronously, before `TabClose`, and it arrives through
   * `TabOpen` as a tab the user opened, in the middle of the close. So the tab
   * the window needs comes from {@link openUnfiledTab}, which shows the home
   * page and is filed as one.
   *
   * @param {Iterable<string>} ids Node ids whose tabs are about to be closed.
   * @param {object} [options] As {@link openUnfiledTab}.
   * @returns {object|null} the tab opened, or null when the window keeps a
   *   tab of its own regardless.
   */
  keepOneTab(ids, options = {}) {
    const doomed = new Set();
    for (const id of ids) {
      const tab = this.tabFor(id);
      if (tab) {
        doomed.add(tab);
      }
    }
    if (!doomed.size) {
      return null;
    }
    // Firefox closes the window when its last visible tab goes
    // (`#isLastTabInWindow`), so a hidden workspace's tabs keep nothing open.
    const tabs = this.#adapter.tabsOf(this.#window);
    if (tabs.some(tab => !doomed.has(tab) && !tab.hidden)) {
      return null;
    }
    return this.openUnfiledTab(options);
  }

  /**
   * Keeps open each of this window's tabs in front of the user whose node
   * another device has just deleted (`ids`), and gives the node back
   * (decision 2237). The user is looking at the tab, or is in a call or a
   * picture-in-picture video in it, and a close made on another device must
   * not take it away. The node returns under its own id, which every peer
   * reads as news (spec §5.4), so the tab comes back on the device that
   * closed it.
   *
   * Called as the merge that deleted the nodes returns, before any read can
   * show them gone, so the orphan sweep never sees these tabs unkept. Where
   * they were is read from the tree as it stood before that merge.
   *
   * @param {string[]} ids Node ids another device deleted.
   */
  keepTabsInFront(ids) {
    if (this.#detached || this.#engine.isPrivate) {
      return;
    }
    const before = latestNodes(this.#engine) ?? {};
    for (const id of ids) {
      const tab = this.tabFor(id);
      if (!tab || this.#keeping.has(tab) || !this.#adapter.isInFront?.(tab)) {
        continue;
      }
      this.#keeping.set(tab, id);
      const parent = before[id]?.placement?.parent ?? null;
      const workspace = workspaceOfNode(before, id);
      this.#enqueue(() => this.#putBack(tab, id, parent, workspace)).finally(
        () => {
          if (this.#keeping.get(tab) === id) {
            this.#keeping.delete(tab);
          }
        }
      );
    }
  }

  /**
   * Re-adds `id`, which another device deleted, for `tab`, at `parent` when
   * the tree still holds it within the tab's workspace and at the top of
   * that workspace otherwise, as a hand-back from the recently-closed list
   * goes (`#reconcile`). A workspace the tree no longer holds is left to the
   * orphan sweep.
   *
   * The workspace is the one the node was in, read before the delete. This
   * runs on the queue, and the window may show another by then: a switch in
   * flight, or the move off a workspace the same change deleted.
   *
   * @param {object} tab
   * @param {string} id
   * @param {?string} parent Its parent before the delete.
   * @param {?string} workspace Its workspace before the delete.
   */
  async #putBack(tab, id, parent, workspace) {
    if (this.#gone(tab)) {
      return;
    }
    const nodes = await this.#readTree();
    if (id in nodes || !nodes[workspace] || this.#gone(tab)) {
      return;
    }
    const former = placeBeside(nodes, parent);
    const into =
      former && nodes[former] && isWithin(nodes, former, workspace)
        ? former
        : workspace;
    SvalLog.info(`kept tab ${id} in front of the user, deleted by a peer`);
    await this.#addTab(tab, id, into);
  }

  /**
   * Closes this window's tabs whose node the document no longer holds.
   *
   * **A window must not hold a tab for a node that is gone**, and a pass
   * that brings in another device's deletion of a node puts it there. The
   * panel is the only tab surface, so this window's tab for the node becomes
   * invisible while staying in the strip. Dragging it to another window then
   * reaches `#reconcile`'s tagged-but-missing branch, the resurrection that
   * branch's `adopted` half refuses. A tab deleted elsewhere leaves the strip
   * here as well as its row.
   *
   * The `TabClose` each removal dispatches must not be read as a close of its
   * own (`#releaseOrphans`).
   *
   * A document holding no nodes at all closes nothing: that is also what the
   * worker holds before its first pass has read the folder, and after a
   * re-key given no tree, and closing every tab on either is not worth the
   * risk for a state the user reaches by closing their last workspace.
   *
   * A tab that has arrived in this window and is not yet reconciled is left
   * alone too (`#arriving`). Its node being gone is a case `#reconcile`
   * decides: a tab dragged in from another window is filed under a new id,
   * and one Firefox hands back from its recently-closed list gets its node
   * back. Either way the user has just put it on screen, and closing it first
   * would lose it.
   *
   * A tab whose node any window's observer is still adding is left alone
   * (`adding`). `nodes` can come from a tree read that started before the tab
   * was tagged, or the tab can have arrived from the window adding it, and
   * closing the tab then would take a page that just opened, such as a
   * window a page opened, and leave a blank tab in its place.
   *
   * @param {object} nodes The document's `nodes` map.
   * @param {object} [options]
   * @param {boolean} [options.movingOn] Whether the window's tabs are being
   *   handed over to another workspace as this runs.
   * @returns {string[]} the node ids whose tabs were closed.
   */
  closeOrphanTabs(nodes, { movingOn = false } = {}) {
    if (!nodes || !Object.keys(nodes).length) {
      return [];
    }
    const orphans = [];
    for (const tab of this.#adapter.tabsOf(this.#window)) {
      const id = this.#adapter.nodeId(tab);
      // A tab filed under an id other than the one it carries has had another
      // tab's state restored into it, and is a copy `#keepOwnNode` has yet
      // to give its node back to.
      const own = filedIds.get(tab);
      if (
        id &&
        !(id in nodes) &&
        !adding.has(id) &&
        !this.#arriving.has(tab) &&
        !this.#keeping.has(tab) &&
        (!own || own === id)
      ) {
        orphans.push([id, tab]);
      }
    }
    // A window whose workspace went with its tabs is about to move to another
    // or close, and one in the middle of a hand-over is moving already. The
    // tab that keeps it open until then stays unfiled, so the move takes it
    // back (`closeUnfiledTabs`): a home page would be filed in the workspace
    // arrived at once it showed.
    return this.#releaseOrphans(orphans, {
      blank: movingOn || !(this.#workspaceId in nodes),
    });
  }

  /**
   * Takes out of the window each tab whose node the document no longer
   * holds, keeping the window open (`keepOneTab`). The `TabClose` each
   * removal dispatches is marked as a release is, because the node
   * is already gone and there is nothing for the close to delete.
   *
   * @param {Array<[string, object]>} orphans Each tab, with its node id.
   * @param {object} [options] As {@link openUnfiledTab}.
   * @returns {string[]} the node ids whose tabs were closed.
   */
  #releaseOrphans(orphans, options = {}) {
    if (!orphans.length) {
      return [];
    }
    this.keepOneTab(
      orphans.map(([id]) => id),
      options
    );
    const closed = [];
    for (const [id, tab] of orphans) {
      filedIds.delete(tab);
      // This is Sval taking a tab out of a window. `release` skips the
      // animation, which nothing can see with no tab strip, and keeps the tab
      // out of the session store, so Firefox cannot offer back a tab whose
      // node somebody deleted: a hand-back from that list is the one
      // `#reconcile` honours with a reused id.
      this.#adapter.release(this.#window, tab);
      closed.push(id);
    }
    return closed;
  }

  /**
   * Tells this observer which workspace the window shows, so a stray (a tab
   * dragged in from another window, or one Firefox hands back from its
   * recently-closed list with no remembered parent) is filed where the user
   * can see it (spec §10.7). The workspace given at attach is only the first.
   *
   * @param {string} id A workspace id.
   */
  setWorkspace(id) {
    this.#workspaceId = id;
  }

  /**
   * Hands this window's tab strip over to another workspace: every tab whose
   * node is not in `keep` leaves the window's reach, and **its node stays in
   * the document** (spec §10.7).
   *
   * A tab holding a page is hidden (`hideForWorkspace`) and keeps running,
   * so a workspace the user comes back to is as they left it;
   * {@link releaseIdle} lets it go once its workspace has been out of sight
   * for {@link HIDDEN_WORKSPACE_UNLOAD_MS}, and Firefox's `TabUnloader` may
   * discard it sooner under memory pressure. A tab holding no page has
   * nothing to keep, so it leaves the window at once.
   *
   * A hidden tab is shown again when a hand-over keeps it. A tab carrying no
   * node belongs to no workspace: a blank tab Sval or the window opened (see
   * `isBlank`). No switch takes those away, because there is no workspace
   * they would be going back to.
   *
   * The caller must have put a tab of the incoming workspace on screen first.
   * `hideTab` and `_mayDiscardBrowser` both refuse the selected tab, so
   * handing over before selecting would leave the outgoing workspace's
   * selected tab on screen in a window that has moved on.
   *
   * A move of tabs into another workspace is no switch, and its tabs go at
   * once unless what they hold keeps them (`hold: false`): the user did not
   * leave that work to come back to, and a tab handed to an agent's
   * workspace takes no history the user was told stays behind (agent-control
   * spec §5.4).
   *
   * @param {Iterable<string>} keep Node ids this window is to go on holding.
   * @param {object} [options]
   * @param {boolean} [options.hold] Whether a tab holding a page stays loaded
   *   and hidden, as a switch leaves it.
   * @returns {Promise<{released: string[], loaded: string[]}>} node ids whose
   *   tab left the window, and node ids whose tab stayed loaded.
   */
  async releaseTabsOutside(keep, { hold = true } = {}) {
    const kept = new Set(keep);
    const leaving = [];
    for (const tab of this.#adapter.tabsOf(this.#window)) {
      const id = this.#adapter.nodeId(tab);
      if (!id) {
        continue;
      }
      if (!kept.has(id)) {
        leaving.push(tab);
      } else if (this.#adapter.isHiddenForWorkspace?.(tab)) {
        this.#adapter.showForWorkspace(this.#window, tab);
        this.#hiddenSince.delete(tab);
      }
    }
    return this.#releaseOrHide(
      leaving,
      hold ? tab => this.#adapter.isLoaded(tab) : () => false
    );
  }

  /**
   * Lets go of the tabs of workspaces this window has not shown for
   * {@link HIDDEN_WORKSPACE_UNLOAD_MS}, as a switch once did: each leaves the
   * window, its node staying in the document, unless what it holds keeps it
   * loaded ({@link SvalTabs.discard}). A tab playing sound stays, as Firefox's
   * `TabUnloader` weighs one (`isPlayingMedia`): the user can hear it. A tab
   * Firefox discarded while hidden holds nothing, so it goes whatever its age.
   *
   * A tab hidden before this observer saw it, by an earlier session or
   * another observer, is timed from the first sweep that finds it.
   *
   * @param {number} [now] The time to measure against, in `#now`'s
   *   milliseconds.
   * @returns {Promise<{released: string[], loaded: string[]}>}
   */
  async releaseIdle(now = this.#now()) {
    const hidden = [];
    for (const tab of this.#adapter.tabsOf(this.#window)) {
      if (
        this.#adapter.nodeId(tab) &&
        this.#adapter.isHiddenForWorkspace?.(tab)
      ) {
        hidden.push(tab);
        if (!this.#hiddenSince.has(tab)) {
          this.#hiddenSince.set(tab, now);
        }
      }
    }
    return this.#releaseOrHide(
      hidden,
      tab =>
        this.#adapter.isLoaded(tab) &&
        (!!this.#adapter.isPlayingSound?.(tab) ||
          now - this.#hiddenSince.get(tab) < HIDDEN_WORKSPACE_UNLOAD_MS)
    );
  }

  /**
   * Takes each of `leaving` out of the window, or hides it when `stays`
   * says so or it cannot go: each that goes goes through `release`, whose
   * close Firefox keeps out of the recently-closed list, and the `TabClose`
   * handler leaves the node of such a close in place. This is the one place a
   * tab leaves a window without its node being deleted.
   *
   * A tab whose discard is refused, or whose page did not answer in time to
   * say whether it holds work, is hidden, so nothing that walks the window's
   * tabs reaches it from the workspace the window shows. A split's tabs leave
   * together or stay together, so it comes back as one (split-view spec
   * §6.2).
   *
   * @param {object[]} leaving Tabs carrying nodes outside the window's
   *   workspace.
   * @param {(tab: object) => boolean} stays Whether a tab is to stay loaded.
   * @returns {Promise<{released: string[], loaded: string[]}>}
   */
  async #releaseOrHide(leaving, stays) {
    const staying = new Set(leaving.filter(stays));
    // A page whose process does not answer may hold work nobody can see, so
    // it stays as if it held some.
    await Promise.all(
      leaving.map(async tab => {
        if (
          !staying.has(tab) &&
          ((await this.#adapter.flushState?.(this.#window, tab)) === false ||
            (await this.#adapter.allowsUnload?.(this.#window, tab)) === false)
        ) {
          staying.add(tab);
        }
      })
    );
    // A detached observer's window is no longer its to change.
    if (this.#detached) {
      return { released: [], loaded: [] };
    }
    const going = new Set(leaving);
    // Asked before any discard, so none of a split that stays is released.
    const keptSplits = new Set();
    for (const tab of this.#adapter.tabsOf(this.#window)) {
      const panes = this.#adapter.splitOf?.(tab);
      if (
        panes?.some(
          pane =>
            staying.has(pane) ||
            (going.has(pane) && !this.#adapter.mayDiscard(this.#window, pane))
        )
      ) {
        keptSplits.add(panes[0]);
      }
    }
    const released = [];
    const loaded = [];
    const now = this.#now();
    for (const tab of leaving) {
      const id = this.#adapter.nodeId(tab);
      if (
        staying.has(tab) ||
        keptSplits.has(this.#adapter.splitOf?.(tab)?.[0]) ||
        !this.#adapter.discard(this.#window, tab)
      ) {
        // The tab keeps its content process and its node, and is adopted
        // again the next time a window shows its workspace.
        if (!this.#adapter.isHiddenForWorkspace?.(tab)) {
          this.#hidingForWorkspace.add(tab);
          try {
            this.#adapter.hideForWorkspace?.(this.#window, tab);
          } finally {
            this.#hidingForWorkspace.delete(tab);
          }
        }
        if (!this.#hiddenSince.has(tab)) {
          this.#hiddenSince.set(tab, now);
        }
        loaded.push(id);
        continue;
      }
      this.#hiddenSince.delete(tab);
      this.#adapter.release(this.#window, tab);
      released.push(id);
    }
    return { released, loaded };
  }

  /** Runs {@link releaseIdle} every {@link IDLE_SWEEP_MS} until detached. */
  #scheduleIdleSweep() {
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      this.releaseIdle()
        .catch(err =>
          SvalLog.warn(
            `releasing idle hidden tabs failed: ${SvalLog.errorName(err)}`
          )
        )
        .finally(() => {
          if (!this.#detached) {
            this.#scheduleIdleSweep();
          }
        });
    }, IDLE_SWEEP_MS);
  }

  /**
   * Tells the panel what of a tab it draws has changed, none of which is part
   * of the tab's node: a favicon is drawn from the live tab, and whether it
   * is loaded or making sound is a fact about this device.
   *
   * @param {object} tab
   * @param {string[]} changed The attributes `TabAttrModified` names.
   */
  #tabAttrModified(tab, changed) {
    const icon = changed.includes("image");
    const load = changed.some(
      attr => attr === "pending" || attr === "discarded" || attr === "busy"
    );
    const sound = changed.some(
      attr => attr === "soundplaying" || attr === "muted"
    );
    if (changed.includes("sharing")) {
      this.#markCall(tab);
    }
    const id = (icon || load || sound) && this.nodeIdFor(tab);
    if (!id) {
      return;
    }
    if (icon) {
      this.onTabIconChanged(id);
    }
    if (load) {
      this.onTabLoadChanged(id);
    }
    if (sound) {
      this.onTabSoundChanged(id);
    }
  }

  /**
   * Publishes again every tab a call kept on this device when the last
   * session ended, as no call outlives its session (decision 2237). A local
   * node whose address `syncableAddress` accepts was marked for a call
   * alone: decision 1372 marks only addresses it refuses.
   */
  async #endCallsOfLastSession() {
    const nodes = await this.#readTree();
    const ops = Object.entries(nodes)
      .filter(
        ([, node]) =>
          node.content?.local === true &&
          node.content.url &&
          syncableAddress(node.content.url)
      )
      .map(([id]) => ({ kind: "setLocal", id, local: false }));
    if (!ops.length) {
      return;
    }
    await this.#engine.mutate({ kind: "batch", ops, now: this.#now() });
    this.#scheduleSync();
    await this.#notifyChanged(await this.#readTree());
  }

  /**
   * Whether the tab this window holds for `id` is in a call.
   *
   * @param {string} id A node id.
   * @returns {boolean}
   */
  #inCall(id) {
    const tab = this.tabFor(id);
    return !!tab && this.#adapter.isInCall?.(tab) === true;
  }

  /**
   * Keeps `tab`'s node on this device while it is in a call, and publishes
   * it again once the call ends (decision 2237). Firefox reports a change
   * of what a tab shares as its `sharing` attribute (`updateBrowserSharing`).
   *
   * Only an address `syncableAddress` accepts is moved either way. One it
   * refuses keeps the mark decision 1372 gave it: marking one a peer wrote
   * would let it open with this device's trust, and clearing one of this
   * device's would publish it.
   *
   * @param {object} tab
   */
  #markCall(tab) {
    const id = this.nodeIdFor(tab);
    if (!id || this.#engine.isPrivate) {
      return;
    }
    this.#enqueue(async () => {
      if (this.#gone(tab)) {
        return;
      }
      const content = (await this.#readTree())[id]?.content;
      const local = this.#adapter.isInCall?.(tab) === true;
      if (
        !content?.url ||
        !syncableAddress(content.url) ||
        (content.local === true) === local
      ) {
        return;
      }
      await this.#engine.mutate({
        kind: "setLocal",
        id,
        local,
        now: this.#now(),
      });
      this.#scheduleSync();
      await this.#notifyChanged(await this.#readTree());
    });
  }

  /**
   * Queues the reconciliation of a tab that has just arrived in this window,
   * holding it in `#arriving` until that reconciliation is done.
   *
   * @param {object} tab
   * @param {object} options As `#reconcile` takes them.
   */
  #reconcileArrival(tab, options) {
    this.#arriving.add(tab);
    this.#queue.post(async () => {
      try {
        await this.#reconcile(tab, options);
      } finally {
        this.#arriving.delete(tab);
      }
    });
  }

  /**
   * Reopens every tab in this window that is in a jar other than its
   * workspace's, as {@link #keepInJar} does for one tab. The panel calls this
   * whenever the document or the window's workspace changes: a workspace was
   * isolated or stopped being isolated, here or on another device, or a
   * hand-over adopted a tab that was already in the window.
   *
   * Work on this observer's queue that reaches here, through the panel, must
   * not wait for it, so it passes `wait: false`.
   *
   * @param {object} [options]
   * @param {boolean} [options.wait] Whether the caller waits for the work.
   * @param {object} [options.nodes] The tree the caller just drew, which
   *   saves a read; without it the work reads the engine's.
   * @returns {Promise<void>|undefined} with `wait`, settled once every tab has
   *   been looked at.
   */
  keepTabsInJar({ wait = true, nodes: drawn = null } = {}) {
    const work = async () => {
      const nodes = drawn ?? (await this.#engine.tree()).nodes ?? {};
      for (const tab of this.#adapter.tabsOf(this.#window)) {
        await this.#keepInJar(tab, nodes);
      }
      // A jar left while one of these tabs still used it can go now. Only
      // the synced document says which jars are gone: a tree in memory
      // holds none of the user's workspaces. The prune takes the latest
      // read as it runs, since `drawn` can predate a workspace isolated
      // while this work waited in the queue, whose new jar it would take for
      // a deleted one's and remove with its data. A jar is made only from a
      // read that holds its workspace isolated (`userContextIdFor`), so the
      // latest read holds every jar's workspace.
      if (!this.#engine.isMemory) {
        this.#adapter.pruneJars?.(await this.#latestTree());
      }
    };
    if (!wait) {
      this.#queue.post(work);
      return undefined;
    }
    return this.#enqueue(work);
  }

  /**
   * Queues {@link #keepInJar} for `tab`. A burst of tabs, such as a switch
   * opening a workspace's, takes one read of the tree between them.
   *
   * @param {object} tab
   */
  #queueKeepInJar(tab) {
    const since = this.#readsBegun;
    this.#queue.post(() => this.#keepInJar(tab, null, since));
  }

  /**
   * Every tab of an isolated workspace uses the workspace's jar, and no other
   * tab does (isolated workspaces spec §2). A tab can still be in another
   * jar: Firefox's recently-closed list reopens a tab in the jar it closed
   * in, a window opened from an isolated tab inherits its jar, and a
   * workspace's jar changes when it is isolated or stops being isolated.
   * Gecko cannot move a live tab between jars, so the tab is reopened at its
   * address in its workspace's jar, keeping its node, and the old one leaves
   * the window as a switch's tabs do. Its history stays behind, which is the
   * cost the spec names (§5, §6).
   *
   * A tab in a jar a WebDriver client chose stays in it
   * (`SvalWebDriver.isClientsJar`).
   *
   * The jar is the one of the workspace the tab's node is in, which need not
   * be the one the window shows: an agent's tab can sit in a window that
   * shows another workspace.
   *
   * @param {object} tab
   * @param {object} [known] The document's nodes, when the caller has read
   *   them already.
   * @param {number} [since] The `#readsBegun` of when the work was asked
   *   for. A read begun after it answers where the node was then.
   */
  async #keepInJar(tab, known = null, since = this.#readsBegun) {
    if (
      this.#engine.isPrivate ||
      !this.#adapter.jarFor ||
      !this.#adapter.userContextId
    ) {
      return;
    }
    const id = this.#adapter.nodeId(tab);
    if (!id) {
      return;
    }
    // From a read made after the work was asked for: a peer's pass may have
    // moved the node to another workspace since any earlier one.
    const nodes = known ?? (await this.#readSince(since));
    const workspace = workspaceOfNode(nodes, id);
    // A closing tab's workspace may be one just deleted, whose jar `jarFor`
    // would make again.
    if (!workspace || tab.closing) {
      return;
    }
    const jar = this.#adapter.jarFor(nodes, workspace);
    const current = this.#adapter.userContextId(tab);
    // Whether the tab is still here is asked last: it reads the window's
    // tabs, and `keepTabsInJar` asks this of every tab after each redraw.
    if (
      current === jar ||
      this.#adapter.isClientsJar?.(current) ||
      this.#gone(tab)
    ) {
      return;
    }
    // The page the tab last committed, written or still waiting for the
    // flush, reopens as any address in the tree does (`SvalRestore`), with
    // no more authority than its own origin.
    const url = this.#committed.get(id)?.url ?? nodes[id].content?.url;
    const node = {
      ...nodes[id],
      content: { ...nodes[id].content, url },
    };
    const selected = this.#window.gBrowser.selectedTab === tab;
    const split = this.#adapter.splitOf?.(tab);
    let replacement;
    // Held through the selection too: selecting the lazy replacement inserts
    // its browser, and the session store restores its values then
    // (`ssi_onTabBrowserInserted`), while the original is still open.
    this.#replacing = tab;
    try {
      replacement = this.#adapter.openInJar(this.#window, node, id, jar);
      // An address no web page may open stays where it is.
      if (!replacement) {
        return;
      }
      if (split) {
        // In the pane's place, so the split keeps every pane and Firefox does
        // not separate it as the original leaves (split-view spec §9.3). The
        // tree is unchanged: the replacement stands for the same node.
        this.#adapter.replaceInSplit(tab, replacement);
      }
      if (selected) {
        this.#window.gBrowser.selectedTab = replacement;
      }
    } finally {
      this.#replacing = null;
    }
    this.#adapter.release(this.#window, tab);
  }

  /**
   * Shows in this window the splits the document holds (split-view spec
   * §6.1, §6.2): each split's panes this window holds, two or more, side by
   * side as one Firefox split, as `SvalSplits.splitChanges` says, and each
   * Firefox split the document does not hold ended. It writes nothing. The
   * panel asks after every redraw, which follows every change that can put a
   * pane's tab into this window or a split into the document: a restore, a
   * switch, a kept tab taken in, a pass. `#keepInJar` keeps its split itself.
   *
   * Queued and not awaited, as `keepTabsInJar` is with `wait: false`: the
   * panel's redraw runs on this queue.
   */
  keepSplits() {
    this.#queue.post(() => this.#arrangeSplits());
  }

  async #arrangeSplits() {
    if (!this.#adapter.splitsOf || this.#detached) {
      return;
    }
    // Taken as this runs: a write of the user's split act may have landed
    // since the read of the redraw that asked, and that write is read back
    // on this queue before this runs (`#writeSplitOps`).
    const nodes = await this.#latestTree();
    // A user's act on a split not yet written is the act's to write, and its
    // write shows the document's splits after it.
    if (this.#detached || this.#splitActQueued) {
      return;
    }
    const splits = this.#adapter.splitsOf(this.#window);
    const ids = splits.map(tabs => tabs.map(tab => this.nodeIdFor(tab)));
    // A pane hidden while its delete waits on the panel's Undo message shows
    // in no split, so the pane left beside it shows alone.
    const present = this.#presentIds();
    for (const tab of this.#adapter.tabsOf(this.#window)) {
      if (this.#adapter.isHiddenForDelete?.(tab)) {
        present.delete(this.nodeIdFor(tab));
      }
    }
    const { end, make } = splitChanges(nodes, present, ids);
    // A split a new one takes a tab from ends too, so Firefox separates
    // nothing it leaves behind after this has stopped marking it.
    const taken = new Set(make.flat());
    ids.forEach((panes, index) => {
      if (!end.includes(index) && panes.some(id => taken.has(id))) {
        end.push(index);
      }
    });
    for (const index of end) {
      this.#adapter.endSplit(this.#window, splits[index][0]);
    }
    for (const panes of make) {
      this.#adapter.showSplit(
        this.#window,
        panes.map(id => this.tabFor(id))
      );
    }
    this.#showWidthsOf(nodes);
  }

  /** @returns {Set<string>} the node ids of the tabs this window holds. */
  #presentIds() {
    return this.withTabLookups(
      () =>
        new Set(
          this.#adapter
            .tabsOf(this.#window)
            .filter(tab => tab.closing !== true)
            .map(tab => this.nodeIdFor(tab))
            .filter(Boolean)
        )
    );
  }

  /** @returns {Array<Array<string|null>>} the window's splits, by node id. */
  #splitIds() {
    return (this.#adapter.splitsOf?.(this.#window) ?? []).map(tabs =>
      tabs.map(tab => this.nodeIdFor(tab))
    );
  }

  /**
   * Queues the write of the user's act on a split (`#splitAct`), once for
   * however many events the act raises.
   */
  #queueSplitAct() {
    if (this.#splitActQueued) {
      return;
    }
    this.#splitActQueued = true;
    this.#queue.post(() => this.#writeSplitAct());
  }

  /**
   * Writes what the user did to splits through Firefox's own UI as one batch
   * (`SvalSplits.splitWrites`), then shows the document's splits.
   */
  async #writeSplitAct() {
    const nodes = await this.#readTree();
    // A tab of the act whose filing is still queued, such as the link's tab
    // of "Open Link in Split View", has no node to write yet. The act waits
    // behind that filing, whole, so it is still one batch, rather than be
    // written without the tab and then undone by `#arrangeSplits`.
    if ([...this.#splitAct.moved].some(tab => this.#arriving.has(tab))) {
      this.#splitActQueued = false;
      this.#queueSplitAct();
      return;
    }
    // Taken after the read: Firefox separates the other pane of a split of
    // two from its tab observer, a turn after the close that left it alone.
    const { moved, closed } = this.#splitAct;
    this.#splitAct = { moved: new Set(), closed: new Map() };
    this.#splitActQueued = false;
    const closedIds = new Set();
    for (const [tab, id] of closed) {
      const closing = id ?? filedIds.get(tab);
      // Closed, it is filed under nothing.
      filedIds.delete(tab);
      if (closing) {
        closedIds.add(closing);
      }
    }
    if (this.#detached) {
      return;
    }
    const ops = splitWrites(
      nodes,
      {
        splits: this.#splitIds(),
        present: this.#presentIds(),
        moved: new Set(
          [...moved].map(tab => this.nodeIdFor(tab)).filter(Boolean)
        ),
        closed: closedIds,
      },
      this.#newId
    );
    if (ops.length) {
      await this.#writeSplitOps(ops, closedIds, nodes);
    }
    await this.#arrangeSplits();
  }

  /**
   * One batch of split writes. A pane the user closed goes with it, so a
   * refused batch, which would be a fault in `splitWrites`, still closes
   * those panes' nodes in one batch, as closing rows does (`removeNodes`).
   *
   * @param {object[]} ops
   * @param {Set<string>} closedIds
   * @param {object} nodes The tree the batch was planned on.
   */
  async #writeSplitOps(ops, closedIds, nodes) {
    try {
      await this.#engine.mutate({ kind: "batch", ops, now: this.#now() });
    } catch (err) {
      SvalLog.warn(`the tree refused a split's change: ${describeError(err)}`);
      if (closedIds.size) {
        await removeNodes(this.#engine, this.#settings, nodes, [...closedIds]);
        this.#scheduleSync();
        await this.#notifyChanged();
      }
      return;
    }
    for (const id of closedIds) {
      this.#settings?.forgetLastActive(id);
    }
    this.#scheduleSync();
    await this.#notifyChanged();
  }

  /**
   * Reads the widths the user just gave the split on screen, and writes
   * them, the whole list (split-view spec §5.2). Read now, as the splitter
   * is let go, because the panels can be resized again before the write
   * runs.
   */
  #splitterReleased() {
    const tabs = this.#adapter.splitOf?.(this.#window.gBrowser.selectedTab);
    const shares =
      tabs && sharesOf(this.#adapter.paneWidths(this.#window, tabs));
    if (shares) {
      this.#sharesQueued++;
      this.#queueShares(tabs, shares);
    }
  }

  /**
   * Queues the write of widths the user set. A split whose own act is not
   * yet written, as when the divider of a split just made is let go, has no
   * node to hold them, so the widths wait behind that act's write.
   *
   * @param {object[]} tabs The split's tabs.
   * @param {number[]} shares
   */
  #queueShares(tabs, shares) {
    this.#queue.post(async () => {
      if (this.#splitActQueued && !this.#detached) {
        this.#queueShares(tabs, shares);
        return;
      }
      try {
        await this.#writeShares(tabs, shares);
      } finally {
        this.#sharesQueued--;
      }
    });
  }

  async #writeShares(tabs, shares) {
    const nodes = await this.#readTree();
    const panes = tabs.map(tab => this.nodeIdFor(tab));
    if (this.#detached || panes.some(id => !nodes[id])) {
      return;
    }
    // Widths belong to a split node showing exactly these panes. One a merge
    // left in another shape keeps equal widths until an act reshapes it.
    const split = nodes[panes[0]].placement?.parent;
    const holds = (childrenByParent(nodes).get(split) ?? []).filter(
      id => nodes[id]?.kind === TAB
    );
    if (nodes[split]?.kind !== SPLIT || holds.join(" ") !== panes.join(" ")) {
      return;
    }
    const ops = splitWrites(
      nodes,
      {
        splits: this.#splitIds(),
        present: this.#presentIds(),
        moved: new Set(panes),
        closed: new Set(),
        shares: { panes, shares },
      },
      this.#newId
    );
    if (ops.length) {
      await this.#writeSplitOps(ops, new Set(), nodes);
    }
  }

  /**
   * Gives the split on screen the widths its node holds (split-view spec
   * §6.2), as it comes on screen.
   */
  async #showWidths() {
    const nodes = (await this.#engine.tree()).nodes ?? {};
    if (!this.#detached) {
      this.#showWidthsOf(nodes);
    }
  }

  /**
   * Gives the split on screen the widths `nodes` holds for it: its node's
   * `shares`, when they fit the panes it shows, and equal widths otherwise.
   *
   * @param {object} nodes The document's nodes.
   */
  #showWidthsOf(nodes) {
    const tabs = this.#adapter.splitOf?.(this.#window.gBrowser.selectedTab);
    if (!tabs) {
      return;
    }
    const first = nodes[this.nodeIdFor(tabs[0])];
    const split = nodes[first?.placement?.parent];
    if (split?.kind !== SPLIT) {
      return;
    }
    // Widths the user has just set and Sval has not yet written are theirs.
    if (this.#sharesQueued) {
      return;
    }
    const ids = tabs.map(tab => this.nodeIdFor(tab));
    const fits = ids.every(
      id => nodes[id]?.placement?.parent === first.placement.parent
    );
    const stored =
      fits && split.content?.shares?.length === tabs.length
        ? split.content.shares
        : tabs.map(() => 100 / tabs.length);
    const widths = this.#adapter.paneWidths(this.#window, tabs);
    // A split already showing its widths is left as it is, so a splitter at
    // the edge of its range is not set past it again.
    const shown = sharesOf(widths);
    if (shown?.every((share, i) => Math.abs(share - stored[i]) < 0.5)) {
      return;
    }
    this.#adapter.setPaneWidths(
      this.#window,
      tabs,
      widthsOf(
        fits ? split.content?.shares : null,
        tabs.length,
        widths.reduce((sum, width) => sum + width, 0)
      )
    );
  }

  /**
   * Waits for what one of the window's callbacks returned, in this module's
   * global. The queue runs here, and its waits have to outlive the window.
   *
   * The callbacks are the panel's, so a promise one returns belongs to the
   * window, and Gecko drops every job whose global is a window without an
   * active document (`CallSetup::GetActiveGlobalObjectForCall`, reached from
   * `RunJSMicroTask`). Awaiting that promise here would make such a job:
   * `PromiseResolve` meets a promise of another global and resolves through a
   * thenable job created in the realm of the window's `then`. Subscribing with
   * this module's handlers puts the reaction jobs in this module's global.
   *
   * The window's own async work stops at its next `await` once the window is
   * gone, so its promise may never settle. A wait therefore also ends when
   * the observer detaches, with no answer. One that starts after it ends a
   * microtask later: an answer the window has already given, such as
   * `newTabParent`'s, is queued ahead of that and still wins, so a tab filed
   * as its window closes keeps the parent the panel chose.
   *
   * @param {*} result What the callback returned.
   * @returns {Promise<*>} its value, or undefined once detached.
   */
  #fromWindow(result) {
    if (typeof result?.then !== "function") {
      return Promise.resolve(result);
    }
    const { promise, resolve, reject } = Promise.withResolvers();
    result.then(resolve, reject);
    const end = () => resolve(undefined);
    if (this.#detached) {
      Promise.resolve().then(end);
      return promise;
    }
    this.#windowWaits.add(end);
    return promise.finally(() => this.#windowWaits.delete(end));
  }

  /**
   * Queues `work` and hands back its end, for a caller outside the queue to
   * wait on. It never rejects: one failed tab must not stop the window's
   * remaining tabs from being tracked, and there is no user-facing recovery
   * for a rejected mutation. The tree does not gain that node until
   * something re-reconciles.
   *
   * @param {Function} work
   * @returns {Promise<void>}
   */
  #enqueue(work) {
    return this.#queue
      .run(work)
      .then(() => {})
      .catch(err => SvalLog.warn(`tab observer failed: ${describeError(err)}`));
  }

  /**
   * Makes the document hold a tab node for `tab`, tagging the tab if it is not
   * tagged already.
   *
   * @param {object} tab
   * @param {object} options
   * @param {boolean} options.restored Whether `tab` predates this observer, in
   *   which case an untagged tab is a stray rather than a tab the user just
   *   opened.
   * @param {boolean} [options.attaching] Whether `tab` was in the window when
   *   this observer attached, as opposed to restored into it since.
   * @param {boolean} [options.unrequested] Whether Sval opened `tab` because a
   *   window must have one, rather than because anyone asked for a tab.
   * @param {boolean} [options.atTop] Whether `tab` is the user's own new tab,
   *   filed at the top of the workspace. See `#openingAtTop`.
   * @param {boolean} [options.outside] Whether `tab` came from outside every
   *   workspace (`isFromOutside`), and so belongs to no group in this one.
   * @param {object} [options.beside] A tab of this window's that `tab` is
   *   filed beside, under its parent, in place of where `newTabParent` says.
   */
  async #reconcile(
    tab,
    {
      restored,
      attaching = false,
      unrequested = false,
      atTop = false,
      outside = false,
      beside = null,
    }
  ) {
    // Work queued behind a busy queue can run after the tab has left: closed,
    // or swapped into another window, whose own observer files the content
    // it carried. A node minted here would describe a tab no window holds.
    if (this.#gone(tab)) {
      return;
    }

    // Taken first, and once: only the first reconciliation after the tab
    // arrived from another window may act on that. It is read here because
    // only one of Firefox's two move routes raises an event in this window
    // (`SVAL_ADOPTED_ATTRIBUTE`).
    const adopted = this.#adapter.takeAdopted?.(tab) === true;

    const existing = this.#adapter.nodeId(tab);

    if (existing) {
      if (this.#gone(tab)) {
        return;
      }
      if (await this.#keepOwnNode(tab)) {
        return;
      }
      // A copy `#claimCopy` tagged, whose node `#settleCopy` adds.
      if (this.#claimed.has(tab)) {
        return;
      }
      // A tab from another window is checked against the document itself.
      // Its node may have been deleted by a peer since this observer last
      // read the tree, and a stale yes would leave it tagged for a node that
      // is gone, for the orphan sweep to close.
      if (await this.#hasNode(existing, { fresh: adopted })) {
        filedIds.set(tab, existing);
        const place = adopted ? this.#takePlace(existing) : null;
        if (adopted && this.#engine.isMemory) {
          // A workspace on a tree in memory holds exactly its window's tabs,
          // and goes with the window when it closes, so a tab dragged in
          // from another window on the tree joins it (private-windows spec).
          await this.#refile(tab, this.#workspaceId, place);
        } else if (adopted) {
          await this.#takeArrival(tab, existing, place);
        }
        return;
      }
      if (attaching && !adopted) {
        // Tagged, the node is gone, and the tab was open before this observer
        // attached: a window that held it while another device closed it, now
        // attaching to a document that carries the close. A tab the session
        // store restores in place later is a hand-back, as below, and never
        // reaches here (`#claimRestored`). The last action
        // wins, so the tab closes here as it would have in a window that was
        // watching (`closeOrphanTabs`), and the node stays deleted. A document
        // holding no nodes is one not read yet, never a sign that everything
        // was closed, so the tab waits for the sweep after the first pass.
        if (Object.keys(await this.#readTree()).length) {
          this.#releaseOrphans([[existing, tab]]);
        }
        return;
      }
      if (!adopted) {
        // Tagged, but the document does not hold the node, and the tab was not
        // carried in from another window: Firefox handed a closed tab back from
        // its recently-closed list. Closing deleted the node, so Sval re-adds
        // one under the same id, and the tab keeps one identity for its whole
        // life. **This is the only sanctioned way a deleted id comes back**,
        // because the user asked for that tab back.
        //
        // It goes back where it was only if that is within the workspace this
        // window shows. A tab closed before this window filed it, such as one
        // the user took from an agent's window and closed at once, was last
        // somewhere else, and putting it back there would hand it to whoever
        // works in that workspace.
        const recorded = this.#adapter.formerParent?.(tab) ?? null;
        this.#adapter.setFormerParent?.(tab, "");
        const nodes = await this.#readTree();
        // A tab joins a split only by the user splitting it (split-view
        // spec §6.1), so a pane comes back beside its split.
        const former = placeBeside(nodes, recorded);
        const parent =
          former && nodes[former] && isWithin(nodes, former, this.#workspaceId)
            ? former
            : this.#workspaceId;
        if (this.#gone(tab)) {
          return;
        }
        await this.#addTab(tab, existing, parent);
        return;
      }

      // Tagged, the node is gone, and the tab came from another window: a
      // sibling window still held a tab for a node somebody deleted, and
      // re-adding the id would undo that deletion (`SVAL_ADOPTED_ATTRIBUTE`).
      // The tab is live and the user just dragged it here, so untagging it
      // files it as a new tab with a new id, as any tab dragged in.
      filedIds.delete(tab);
      this.#setNodeId(tab, "");
    }

    // Untagged and already open when Sval started (almost always the tab the
    // window opens with), or opened by Sval because a window must have one.
    // While it is a blank page nobody asked for it is internal and gets no
    // node (see `isBlank`); the content path files it the moment it shows
    // anything. Showing anything already, it is filed now: the home page
    // reaches here only when the workspace had nothing to restore, since
    // `SvalRestore`'s `isDebris` closes it otherwise. The user's own tabs come
    // back through `SvalRestore` already tagged and never reach this branch.
    //
    // A tab the user opens *while Sval is running* is filed whatever it shows,
    // `about:blank` included: the panel is the only tab surface, so a new tab
    // that did not appear there would be a tab with nowhere to be seen.
    if ((restored || unrequested) && this.#adapter.isBlank?.(tab)) {
      return;
    }

    // A tab that arrived through `TabOpen` is one the user just opened, and
    // belongs where new tabs go: the user's own new tab at the top, anything
    // else where the panel says. A tab that was already open when Sval started
    // is a stray, and a stray belongs to the workspace itself. So does a page
    // from outside every workspace: whatever the user has selected here says
    // nothing about where it goes, so it opens at the end of the workspace's
    // own list, where the engine puts a tab at the end of the strip, and the
    // user files it from there. And so does one of the browser's own pages
    // (`opensBrowserPage`), such as settings, which says nothing of the page
    // the user was on or its group.
    //
    // The workspace *is* the catch-all: a workspace holds tabs and groups as
    // siblings in one ordered list, the way loose files sit beside folders, so
    // a tab that belongs to no group is a child of the workspace. There
    // is no "Unsorted" group and no node invented to stand in for one.
    let parent = this.#workspaceId;
    if (beside) {
      parent = await this.#parentBeside(beside);
    } else if (
      !(restored || atTop || outside || this.#adapter.opensBrowserPage?.(tab))
    ) {
      parent =
        (await this.#fromWindow(this.#newTabParent())) ?? this.#workspaceId;
    }
    // A window whose workspace the document no longer holds is about to show
    // another one or none (`SvalWindowWorkspace.resolve`). The tab `keepOneTab`
    // opens meanwhile stays unfiled: filed under the gone workspace, it would
    // carry an id with no node.
    const shown = (await this.#latestTree())[this.#workspaceId];
    if (this.#gone(tab) || !shown) {
      return;
    }
    const id = this.#newId();
    this.#setNodeId(tab, id);
    await this.#addTab(tab, id, parent);
  }

  /**
   * Gives `tab` a node of its own when the id it carries was copied from
   * another tab (`copyOf`). A node has one tab: closing a tab deletes its
   * node (spec §5.4), so a copy sharing the node would be closed with its
   * original by the orphan sweep (`closeOrphanTabs`).
   *
   * A copy this observer had already filed goes back to its own node. The
   * session store restores a duplicate's state after its `TabOpen`, so the
   * duplicate can be filed under a fresh id before the copied one lands on
   * it, and that copied id can belong to an original already closed. A tab
   * this observer filed under the id it carries is the original, whatever
   * else holds the id.
   *
   * Any other copy is a new tab beside its original: under the original's
   * parent when that is within the workspace this window shows, and under
   * the workspace itself when not, ordered by the strip as `#addTab` orders
   * every tab.
   *
   * A copy filed into an agent's workspace from a tab that was not the
   * agent's to use, the user's own or one the user holds there, is in the
   * user's control (agent-control spec §6), as anything such a tab opens is:
   * its history and form data are the user's. Any copy filed there keeps the
   * agent out of the history entries its original kept the agent out of.
   * And it is in its workspace's jar (`#keepInJar`), as any tab filed there
   * is.
   *
   * @param {object} tab A Firefox tab in this window.
   * @returns {Promise<boolean>} whether `tab` was a copy, now filed.
   */
  async #keepOwnNode(tab) {
    const id = this.#adapter.nodeId(tab);
    if (!id || this.#gone(tab)) {
      return false;
    }
    const own = filedIds.get(tab);
    if (own === id) {
      return false;
    }
    const original = this.#copied(tab);
    const revert = !!own && (await this.#hasNode(own));
    if (!revert && !original) {
      if (own) {
        // Its own node is gone, and nothing else carries the id it was
        // given: it is that node's tab now.
        filedIds.set(tab, id);
      }
      return false;
    }
    await this.#settleCopy(tab, id, original, revert ? own : null);
    return true;
  }

  /**
   * The tab `tab` was copied from (`copyOf`), or null. The replacement
   * `#keepInJar` opens takes its id on, so it is no copy (`#replacing`).
   *
   * @param {object} tab
   * @returns {object|null}
   */
  #copied(tab) {
    const original = this.#adapter.copyOf?.(tab) ?? null;
    return original && original === this.#replacing ? null : original;
  }

  /**
   * Does at once what a copy needs before anything else can run, from the
   * session store's `SSTabCustomValuesRestored`, which is dispatched as the
   * copied values land.
   *
   * A copy whose original was not the agent's to use carries the user's
   * history and form data, so its content is put in the user's control at
   * once (`#userOwnsCopy`): every agent dispatch checks, so a tool already
   * running on the tab sends it nothing more, and in an agent's workspace
   * the user does not hold, that takes the workspace for them
   * (`SvalAgentMarking`). A copy this observer had filed gets its own id
   * back. The rest is queued (`#settleCopy`), and a copy not filed yet is
   * filed by the reconciliation its `TabOpen` queued (`#keepOwnNode`). A tab
   * that is no copy and was filed under nothing is restored in place
   * (`#claimRestored`).
   *
   * @param {object} tab A Firefox tab in this window.
   */
  #claimCopy(tab) {
    let id, own, original;
    try {
      id = this.#adapter.nodeId(tab);
      own = filedIds.get(tab);
      if (!id || own === id) {
        return;
      }
      original = this.#copied(tab);
      if (!original && !own) {
        this.#claimRestored(tab, id);
        return;
      }
      if (this.#userOwnsCopy(original, id)) {
        this.#adapter.takeForUser?.(tab);
      }
    } catch (err) {
      // Whose the copy is could not be told, so it is the user's.
      SvalLog.warn(
        `a copied tab could not be claimed: ${SvalLog.errorName(err)}`
      );
      this.#adapter.takeForUser?.(tab);
      return;
    }
    // Tagged now, so the copy never stands for its original's node: its own,
    // when that is in the document or being added to it, else a new id, which
    // stands for nothing until `#settleCopy` adds its node.
    const kept = own && (this.#nodes()[own] || adding.has(own)) ? own : null;
    const copy = kept ?? this.#newId();
    this.#setNodeId(tab, copy);
    filedIds.set(tab, copy);
    this.#arriving.add(tab);
    this.#claimed.add(tab);
    this.#queue.post(async () => {
      try {
        if (!this.#gone(tab)) {
          await adding.get(copy)?.catch(() => {});
          await this.#settleCopy(tab, id, original, kept, copy);
        }
      } finally {
        this.#arriving.delete(tab);
        this.#claimed.delete(tab);
      }
    });
  }

  /**
   * Files a tab the session store has restored carrying node id `id`, which
   * no other tab carries and this observer filed it under nothing.
   *
   * A tab Firefox restores into a window is never taken out of it.
   * `undoCloseTab` restores into a tab it has just opened, whose `TabOpen`
   * reconciliation is queued already. `setBrowserState`,
   * `setWindowState` and a session restore can reuse a tab the window
   * already had, which raises no `TabOpen`, so its reconciliation is queued
   * here, and until it has run the orphan sweep leaves the tab alone
   * (`#arriving`). Either way a node the document does not hold comes back
   * under the same id, as `#reconcile` gives a closed tab back, and the tab
   * goes through `#keepInJar` as every filed tab does.
   *
   * A tab restored in place for a node the document does not hold was in no
   * workspace an agent was given, so its content is put in the user's
   * control at once (`#claimCopy` gives the reason). A tab that arrived
   * through `TabOpen` is left as it was: Sval opens those too, `SvalRestore`
   * materialising a node and `#keepInJar` reopening one, and this
   * observer's latest read of the tree can lag the document they read.
   *
   * @param {object} tab A Firefox tab in this window.
   * @param {string} id The node id it was restored with.
   */
  #claimRestored(tab, id) {
    if (this.#arriving.has(tab)) {
      return;
    }
    if (!this.#nodes()[id] && !adding.has(id)) {
      this.#adapter.takeForUser?.(tab);
    }
    this.#reconcileArrival(tab, { restored: true });
    this.#queueKeepInJar(tab);
  }

  /**
   * Whether a copy of the tab carrying `id` is the user's rather than the
   * agent's, from what is known synchronously. Only a copy made in this
   * window, of a tab within the workspace this window shows that the user
   * does not hold, can be the agent's. Anything not known is the user's.
   *
   * @param {object|null} original The tab copied, or null when it is gone.
   * @param {string} id Its node id.
   * @returns {boolean}
   */
  #userOwnsCopy(original, id) {
    if (!original || !this.#adapter.tabsOf(this.#window).includes(original)) {
      return true;
    }
    if (this.#adapter.isUserInControl?.(original) !== false) {
      return true;
    }
    return !isWithin(this.#nodes(), id, this.#workspaceId);
  }

  /**
   * The parent a tab filed beside `tab` goes under: `tab`'s own, or its
   * split's (`placeBeside`), when that is within this window's workspace,
   * and the workspace itself otherwise.
   *
   * @param {object} tab A Firefox tab in this window.
   * @returns {Promise<string>} a node id.
   */
  async #parentBeside(tab) {
    const nodes = await this.#readTree();
    const id = this.#adapter.nodeId(tab);
    const parent = placeBeside(nodes, nodes[id]?.placement?.parent);
    return isWithin(nodes, parent, this.#workspaceId)
      ? parent
      : this.#workspaceId;
  }

  /**
   * Files a copy of the tab carrying `id`: under its own node `own` when it
   * has one, else under a new node. See `#keepOwnNode`.
   *
   * @param {object} tab A Firefox tab in this window.
   * @param {string} id The node id it was copied with.
   * @param {object|null} original The tab copied, or null when it is gone.
   * @param {string|null} own The node this observer had filed it under.
   * @param {string} [minted] The new id `#claimCopy` tagged it with.
   */
  async #settleCopy(tab, id, original, own, minted = null) {
    const nodes = await this.#readTree();
    const beside = placeBeside(nodes, nodes[id]?.placement?.parent);
    const parent = isWithin(nodes, beside, this.#workspaceId)
      ? beside
      : this.#workspaceId;
    if (this.#gone(tab)) {
      return;
    }
    const copy = own ?? minted ?? this.#newId();
    // Made before the copy stands for its node (`resolveNodeId`), so nothing
    // that reads by node finds it the agent's first.
    const into = workspaceOfNode(nodes, parent) ?? parent;
    if (nodes[into]?.agent) {
      this.#adapter.inheritUserHistory?.(original, id, copy);
      if (workspaceOfNode(nodes, id) !== into) {
        this.#adapter.takeForUser?.(tab);
      }
    }
    this.#setNodeId(tab, copy);
    if (!own) {
      await this.#addTab(tab, copy, parent);
    } else if (original && nodes[copy]?.placement?.parent !== parent) {
      const { before, after } = this.#neighbours(tab, parent);
      await this.#move(copy, before, after, parent);
    }
    this.#queueKeepInJar(tab);
  }

  /**
   * Marks the tab a `TabOpen` from `adoptTab` announces as one that moved
   * between windows (`SVAL_ADOPTED_ATTRIBUTE`). A tab from a Peek is
   * left as the close side marks it: a workspace's tab Reopen Closed Tab put
   * there is Firefox handing a closed tab back, which `SvalPeek`
   * passes on to an ordinary window.
   *
   * @param {Event} event A `TabOpen`.
   * @param {boolean} outside Whether the tab came from outside every
   *   workspace (`isFromOutside`).
   */
  #markAdopted(event, outside) {
    if (event.detail?.adoptedTab && !outside) {
      this.#adapter.markAdopted?.(event.target);
    }
  }

  /**
   * Files a tab the user carried in from another workspace's window under
   * this window's workspace (spec §10.7): a tab belongs to the workspace of
   * the window it is in, so the panel there draws it and the window it left
   * stops drawing a tab it no longer holds. The move is the one Move to
   * Workspace makes, `#refile`'s `moveNode`.
   *
   * A tab from an agent's workspace (the workspace carries the agent mark,
   * agent-control spec §3.5) is also released from the agent's gate, which
   * follows such a move only while agent access is on, so the take is made
   * here, where it holds either way.
   *
   * A window that shows an agent's workspace takes an agent's tab and
   * releases nothing. A tab arrives there when an agent's gate moves its
   * content into its own window, such as one its page opened that Firefox
   * put in another agent's window. Releasing it would end the gate's watch
   * on what the tab opens. A tab of the user's arriving there stays the
   * user's: a move into an agent's workspace hands the tab to the agent only
   * once the user has agreed (agent-control spec §5.4), which a drag does not
   * ask.
   *
   * A take into another jar asks first (isolated workspaces spec §6), off
   * this observer's queue so the window's other work goes on while the
   * question is up. Until the answer the tab stays in the workspace it came
   * from, in that workspace's jar, and loads nothing new: `#keepInJar` reads
   * the node's workspace. Move moves it here and reopens it in this
   * workspace's jar; Cancel hands it back to the window showing the
   * workspace it came from, as it is (`returnTab`).
   *
   * @param {object} tab A Firefox tab that has just arrived in this window.
   * @param {string} id Its node id.
   * @param {object|null} [place] Where the drop that brought it named
   *   (`adoptTab`).
   */
  async #takeArrival(tab, id, place = null) {
    const nodes = await this.#readTree();
    if (isWithin(nodes, id, this.#workspaceId)) {
      return;
    }
    const ws = workspaceOfNode(nodes, id);
    if (!ws) {
      return;
    }
    const intoAgent = !!nodes[this.#workspaceId]?.agent;
    if (intoAgent && !nodes[ws].agent) {
      return;
    }
    if (
      !intoAgent &&
      !this.#engine.isPrivate &&
      this.#adapter.jarFor &&
      this.#adapter.confirmJarCrossing &&
      this.#adapter.jarFor(nodes, ws) !==
        this.#adapter.jarFor(nodes, this.#workspaceId)
    ) {
      this.#askToTake(tab, id, ws, nodes, place);
      return;
    }
    await this.#take(tab, id, nodes, place);
  }

  /**
   * Asks whether to take `tab` across jars, then takes it or hands it back.
   *
   * @param {object} tab
   * @param {string} id Its node id.
   * @param {string} source The workspace it came from.
   * @param {object} nodes The document's nodes, read on its arrival.
   * @param {object|null} place Where to file it (`adoptTab`).
   */
  async #askToTake(tab, id, source, nodes, place) {
    const workspaceId = this.#workspaceId;
    let ok = false;
    try {
      ok = await this.#adapter.confirmJarCrossing(
        this.#window,
        nodes,
        id,
        workspaceId,
        source
      );
    } catch (err) {
      SvalLog.warn(`taking a tab asked nothing: ${describeError(err)}`);
    }
    if (this.#gone(tab)) {
      return;
    }
    if (!ok) {
      await this.#adapter.returnTab?.(tab, source);
      return;
    }
    await this.#queue.run(async () => {
      if (this.#gone(tab) || this.#workspaceId !== workspaceId) {
        return;
      }
      await this.#take(tab, id, await this.#readTree(), place);
      await this.#keepInJar(tab);
    });
  }

  /**
   * Files `tab` under this window's workspace, and releases it from its
   * agent when it leaves an agent's workspace for the user's.
   *
   * @param {object} tab
   * @param {string} id Its node id.
   * @param {object} nodes The document's nodes, read before the take.
   * @param {object|null} [place] Where to file it (`adoptTab`).
   */
  async #take(tab, id, nodes, place = null) {
    const source = workspaceOfNode(nodes, id);
    if ((await this.#refile(tab, this.#workspaceId, place)) === null) {
      return;
    }
    if (nodes[this.#workspaceId]?.agent || !nodes[source]?.agent) {
      return;
    }
    this.#adapter.releaseFromAgent?.(tab);
    SvalLog.info(`the user took tab ${id} out of an agent's workspace`);
  }

  /**
   * Whether `tab` has left this window: closing, or not among its tabs.
   *
   * @param {object} tab A Firefox tab.
   * @returns {boolean}
   */
  #gone(tab) {
    return tab.closing === true || !this.#adapter.holds(this.#window, tab);
  }

  async #addTab(tab, id, parent) {
    filedIds.set(tab, id);
    // A tab opened at the end of the strip goes after its parent's last
    // child, which is where the engine puts a tab given no neighbours. One
    // opened in the middle, from a link say, is filed between its
    // neighbours in the same add.
    const { before, after } = this.#neighbours(tab, parent);
    // The add counts as done once it is read back, so from the moment it is
    // tagged until the latest tree holds it the node is `adding`, and no
    // window reads it as missing in between.
    const added = this.#engine
      .mutate({
        kind: "addTab",
        parent,
        name: this.#adapter.name(tab),
        url: this.#adapter.openingUrl(tab),
        id,
        ...(this.#adapter.isInCall?.(tab) ? { local: true } : {}),
        ...(after ? { before, after } : {}),
        now: this.#now(),
      })
      .then(() => this.#readTree());
    adding.set(id, added);
    Services.obs.notifyObservers(
      null,
      TAB_FILED_TOPIC,
      JSON.stringify({ id, parent })
    );
    let nodes;
    try {
      nodes = await added;
    } finally {
      if (adding.get(id) === added) {
        adding.delete(id);
      }
    }
    this.#scheduleSync();
    await this.#notifyChanged(nodes);

    // A tab opened in the foreground was selected while it was still being
    // filed, so its `TabSelect` carried no node and reported nothing. Told
    // here, after the redraw, the panel selects a row it already has.
    if (tab.selected && !this.#detached && !this.#gone(tab)) {
      this.#markActive(id);
      this.onTabSelected(id);
    }
  }

  /**
   * Closing a tab deletes its node: no closed state, no tombstone, no
   * retention (spec §5.4). Recovering a closed tab is Firefox's own
   * recently-closed list, which is local and already exists.
   *
   * The tab's node id stays in the session store, so a restored tab comes
   * back as the same node and is no stray.
   *
   * @param {string} id A node id.
   */
  async #remove(id) {
    if (await this.#removeNode(id)) {
      await this.#notifyChanged(await this.#readTree());
    }
  }

  /**
   * `#remove` for a tab the user closed. A burst of closes, as Close Other
   * Tabs makes, is written one remove at a time and read back and drawn
   * once, after the last close queued.
   *
   * @param {?string} id The node the tab was filed under, if any.
   */
  async #removeClosed(id) {
    try {
      if (id && (await this.#removeNode(id))) {
        this.#removedUnread = true;
      }
    } finally {
      // The burst's last close reads back and draws whatever the others
      // removed, even when its own remove failed.
      if (this.#removedUnread && !this.#closesQueued) {
        this.#removedUnread = false;
        await this.#notifyChanged(await this.#readTree());
      }
    }
  }

  /**
   * Deletes `id` from the document, if it holds it.
   *
   * @param {string} id A node id.
   * @returns {Promise<boolean>} whether the node was deleted.
   */
  async #removeNode(id) {
    if (!(await this.#hasNode(id))) {
      return false;
    }
    try {
      await this.#engine.mutate({ kind: "remove", id });
    } catch (err) {
      // A pass outside this observer's queue, merging a peer's delete, can
      // land after the latest read `#hasNode` answered from.
      if (err?.code === "no_such_node") {
        return false;
      }
      throw err;
    }
    this.#settings?.forgetLastActive(id);
    this.#scheduleSync();
    return true;
  }

  /**
   * Puts `id` between the two siblings the strip has it between.
   *
   * **A refusal ends the move and nothing else.** `tree::move_node` throws on
   * an absent parent, a tab as parent or a cycle. Letting the throw out would
   * take `#reconcile` with it, which is where a tab just added to the
   * document is published and drawn, so a refused reorder would cost the user
   * a tab drawn nowhere.
   *
   * @param {string} id A node id.
   * @param {string|null} before The sibling it follows.
   * @param {string|null} after The sibling it precedes.
   * @param {string} [parent] The parent to put it under; by default the one
   *   it has.
   */
  async #move(
    id,
    before,
    after,
    parent = this.#nodes()[id]?.placement?.parent ?? this.#workspaceId
  ) {
    try {
      await this.#engine.mutate({
        kind: "moveNode",
        id,
        newParent: parent,
        before,
        after,
        now: this.#now(),
      });
    } catch (err) {
      SvalLog.warn(`the tree refused to move ${id}: ${describeError(err)}`);
      return;
    }
    const read = await this.#readTree();
    this.#scheduleSync();
    await this.#notifyChanged(read);
  }

  /**
   * The tracked node ids on either side of `tab` in the strip, which is what
   * `moveNode` and `addTab` order against: `before` is the sibling the tab
   * follows and `after` the one it precedes.
   *
   * Only siblings under the same parent can bound a fractional index, so tabs
   * filed elsewhere in the tree are skipped.
   *
   * @param {object} tab A Firefox tab.
   * @param {string|null} [parent] The parent it is filed under, for a tab
   *   not filed yet.
   */
  #neighbours(
    tab,
    parent = this.#nodes()[this.#adapter.nodeId(tab)]?.placement?.parent ?? null
  ) {
    const nodes = this.#nodes();
    const tabs = this.#adapter.tabsOf(this.#window);
    const index = tabs.indexOf(tab);
    if (index < 0) {
      return { before: null, after: null };
    }

    // A pane stands for its split, which is the sibling under `parent`.
    const sibling = step => {
      for (let i = index + step; i >= 0 && i < tabs.length; i += step) {
        const id = this.#adapter.nodeId(tabs[i]);
        const own = nodes[id]?.placement?.parent;
        const at = nodes[own]?.kind === SPLIT && own !== parent ? own : id;
        if (at && nodes[at] && nodes[at].placement?.parent === parent) {
          return at;
        }
      }
      return null;
    };

    return { before: sibling(-1), after: sibling(1) };
  }

  /**
   * Records that `id` was just looked at. Device-local and never synced: when
   * a tab was last active is per-device by definition, and syncing it would
   * let one machine's idea of "recent" overwrite another's (spec §5.6).
   *
   * @param {string} id A node id.
   */
  #markActive(id) {
    if (!this.#settings) {
      return;
    }
    this.#settings.setLastActive(id, this.#now());
    this.#settings.saveSoon();
    // A selection the user made, by key or click, may be a use (§4.1). One
    // Sval makes itself, showing a workspace or restoring a window, runs
    // after an await, where Gecko is handling no input, and writes nothing.
    // Ctrl+Tab picks a tab after the input that chose it and says so
    // (`ctrlTab.selecting`).
    if (
      this.#window.windowUtils?.isHandlingUserInput ||
      this.#window.ctrlTab?.selecting
    ) {
      this.noteUse(id);
    }
  }

  /**
   * Records a use of tab `id`, which syncs as a touch (idle-tab archive spec
   * §4.1), once its tab has stayed the shown tab of the window the user is in
   * for `USE_DWELL_MS`. A later selection or press restarts the wait. The
   * engine stamps a tab at most once an hour (`mark_used`), so a press on a
   * tab already stamped writes nothing.
   *
   * @param {string} id A tab's node id.
   */
  noteUse(id) {
    if (this.#detached) {
      return;
    }
    clearTimeout(this.#useTimer);
    this.#useTimer = setTimeout(() => {
      this.#useTimer = null;
      const tab = this.#detached ? null : this.tabFor(id);
      if (!tab?.selected || !this.#adapter.isActive?.(this.#window)) {
        return;
      }
      this.#engine
        .markUsed?.(id, this.#now())
        .catch(err =>
          SvalLog.debug(`a tab's use was not recorded: ${describeError(err)}`)
        );
    }, USE_DWELL_MS);
  }

  /**
   * Records the page `tab` has committed, with its title, for the next flush
   * to write (decision 0050).
   *
   * Nothing is written here. A page load commits more than once, a redirect
   * chain and then the title arriving after the document, and each write is a
   * file landing in the user's storage, so the commit waits for the next
   * debounced flush.
   *
   * A tab with no node that commits a page is a screen now: the window's
   * startup tab with an address typed into it, or the tab Sval opened for an
   * empty workspace arriving at the home page. Attaching filed none for it
   * because it was blank and internal (see `isBlank`), and a screen without a
   * node is one the user cannot reach, so it is filed where a new tab goes.
   *
   * @param {object} tab A Firefox tab.
   * @param {string} url The address it committed.
   * @param {string} title Its page's title, empty until the page sets one.
   */
  #noteCommitted(tab, url, title) {
    if (this.#detached || this.#adapter.standsForNoNode?.(tab)) {
      return;
    }
    if (!this.#adapter.nodeId(tab)) {
      if (!this.#adapter.isBlank?.(tab)) {
        this.#queue.post(() => this.#reconcile(tab, { restored: false }));
        this.#queueKeepInJar(tab);
      }
      return;
    }
    const id = this.nodeIdFor(tab);
    if (!id) {
      return;
    }
    this.#committed.set(id, { url, name: title.trim() || undefined });
    this.#titleHold.forget(id);
    this.#scheduleSync();
  }

  /**
   * Records the title `tab`'s committed page has set, for the next flush to
   * write with the page's address. A title set soon after the last one
   * written waits for its hold to end (`SvalTitleHold`).
   *
   * @param {object} tab A Firefox tab.
   * @param {string} title The page's title.
   */
  #noteTitle(tab, title) {
    if (this.#detached || this.#adapter.standsForNoNode?.(tab)) {
      return;
    }
    const id = this.nodeIdFor(tab);
    if (!id) {
      return;
    }
    // A page with no title of its own reports an empty one as it finishes
    // parsing (`nsContentSink`), which says nothing new about its name.
    const name = title.trim();
    if (!name) {
      return;
    }
    const committed = this.#committed.get(id);
    // A commit, or a title already let through, waiting for the debounce
    // carries this one with it, and starts the hold a title let through
    // starts.
    const admitted = this.#titleHold.admit(id);
    if ((committed && !committed.held) || admitted) {
      this.#committed.set(id, { ...committed, name, held: false });
      this.#scheduleSync();
    } else {
      this.#committed.set(id, { ...committed, name, held: true });
      for (const observer of observersFor(this.#engine)) {
        observer.onTitleHeld(id);
      }
    }
  }

  /**
   * The title node `id`'s tab has set that no flush has written yet, or
   * undefined. A held title waits up to `TITLE_HOLD_MS` for its write, and
   * the panel shows it meanwhile, since what a page's title says, such as an
   * unread count, is what the user watches its row for.
   *
   * @param {string} id A node id.
   * @returns {string|undefined}
   */
  pendingName(id) {
    return this.#committed.get(id)?.name;
  }

  /**
   * Lets the title `#titleHold` held back for node `id` go out with the next
   * flush. A flush since may have taken it already.
   *
   * @param {string} id A node id.
   */
  #releaseTitle(id) {
    const committed = this.#committed.get(id);
    if (committed?.held) {
      this.#committed.set(id, { ...committed, held: false });
      this.#scheduleSync();
    }
  }

  /**
   * Writes what this window's tabs have committed into their nodes.
   *
   * Runs inside the debounced flush, before the sync pass, so one file carries
   * both the content and whatever else the burst changed.
   *
   * @param {object} [options]
   * @param {boolean} [options.keepHeld] Leave held titles for a later flush.
   * @returns {Promise<boolean>} whether any tab had committed anything.
   */
  async #writeChangedContent({ keepHeld = false } = {}) {
    const content = this.#takeChangedContent({ keepHeld });
    await this.#writeContent(content);
    return !!content.length;
  }

  /**
   * Takes what this window's tabs have committed since the last flush.
   * Synchronous, so a window about to go hands over what it holds.
   *
   * @param {object} [options]
   * @param {boolean} [options.keepHeld] Leave held titles where they are.
   * @returns {object[]} `{ id, url, name }` for each node a tab committed
   *   for, either fact absent when nothing committed it.
   */
  #takeChangedContent({ keepHeld = false } = {}) {
    const content = [];
    for (const [id, { held, ...committed }] of this.#committed) {
      if (!(keepHeld && held)) {
        content.push({ id, ...committed });
        this.#committed.delete(id);
      }
    }
    return content;
  }

  /**
   * Writes what `#takeChangedContent` took into the nodes it names.
   *
   * **The write is a read-modify-write, because the content group is the unit**
   * (`docs/host-contract.md` §3): `setContent` replaces name, url and icon
   * together, so what no commit changed is read from the node and sent back.
   * A commit with no title yet names a new page by its address until its
   * title arrives; one at the address the node already holds, as a reload
   * is, keeps the node's name, so a reload re-stamps nothing and cannot win
   * over a rename another device made meanwhile. A node already holding what
   * was committed is skipped, which is what keeps an idle device from
   * writing.
   *
   * Called in the same turn as the take, so the write is in
   * `writingByEngine` from the moment its commits leave `committedByEngine`.
   *
   * @param {object[]} content As `#takeChangedContent` takes it.
   */
  async #writeContent(content) {
    if (!content.length) {
      return;
    }
    const writing = writingFor(this.#engine);
    const write = this.#setContents(content);
    writing.add(write);
    let changed;
    try {
      changed = await write;
    } finally {
      writing.delete(write);
    }
    if (changed) {
      await this.#notifyChanged();
    }
  }

  /**
   * The mutations of `#writeContent`.
   *
   * @param {object[]} content As `#takeChangedContent` takes it.
   * @returns {Promise<boolean>} whether any node changed.
   */
  async #setContents(content) {
    const nodes = (await this.#engine.tree()).nodes ?? {};
    let changed = false;
    for (const { id, url: committedUrl, name: title } of content) {
      const node = nodes[id];
      if (!node) {
        // The node went while the page was loading: the user closed the tab,
        // or a peer deleted it.
        continue;
      }
      const held = node.content ?? {};
      const url = committedUrl ?? held.url ?? null;
      const name = title ?? (url === held.url ? (held.name ?? "") : "");
      if (url === (held.url ?? null) && name === (held.name ?? "")) {
        continue;
      }
      try {
        await this.#engine.mutate({
          kind: "setContent",
          id,
          name,
          url,
          icon: held.icon ?? null,
          ...(this.#inCall(id) ? { local: true } : {}),
          now: this.#now(),
        });
      } catch (err) {
        // A pass outside this observer's queue, merging a peer's delete, can
        // land between the read above and this write. The node it names is
        // gone, and the batch's other nodes still take their content.
        if (err?.code === "no_such_node") {
          continue;
        }
        throw err;
      }
      changed = true;
    }
    return changed;
  }

  /**
   * Tells the panel the tree moved, handing it the tree this reads once for
   * both of them. Awaited rather than fired and forgotten: the panel is the
   * only place a tab is drawn, so "the observer has finished" and "the panel
   * shows it" have to be the same moment.
   *
   * @param {object|null} [read] The tree the caller has just read back, which
   *   saves reading it again.
   */
  async #notifyChanged(read = null) {
    // A detached observer's window is closing or gone; there is no panel left
    // to redraw.
    if (this.#detached) {
      return;
    }
    try {
      const nodes = read ?? (await this.#readTree());
      await this.#fromWindow(this.onTreeChanged(nodes));
    } catch (err) {
      SvalLog.warn(
        `redrawing after tab activity failed: ${describeError(err)}`
      );
    }
  }

  /**
   * Whether the document holds `id`. A hit is answered from the latest read;
   * a miss re-reads the tree, because sync can add nodes after it. Sync can
   * delete them too, so a caller for whom a stale hit is costly asks for
   * `fresh`.
   *
   * @param {string} id A node id.
   * @param {object} [options]
   * @param {boolean} [options.fresh] Re-read the tree even on a hit.
   */
  async #hasNode(id, { fresh = false } = {}) {
    if (!fresh && this.#nodes()[id]) {
      return true;
    }
    // A tab carried in from a window still adding its node. See `adding`.
    await adding.get(id)?.catch(() => {});
    return !!(await this.#readTree())[id];
  }

  /**
   * Reads the tree from the engine, which notes it as the latest
   * (`SvalTreeSnapshot`), so `#nodes` answers from it until the next read.
   * The document is the only authority on where a node sits: a tab tagged in
   * a previous session, or a node that arrived from another device, has a
   * parent this process never chose. Each write here reads the tree back
   * before it counts as done, so the latest read holds every write this
   * observer has finished.
   *
   * @returns {Promise<object>} the document's `nodes` map, as read.
   */
  async #readTree() {
    const begun = ++this.#readsBegun;
    const nodes = (await this.#engine.tree()).nodes ?? {};
    if (begun > this.#readFinished.begun) {
      this.#readFinished = { begun, nodes };
    }
    return nodes;
  }

  /**
   * The document's nodes as a read begun after `since` (`#readsBegun`) found
   * them: the latest read to finish, when it began late enough, or a new one.
   *
   * @param {number} since
   * @returns {Promise<object>}
   */
  async #readSince(since) {
    const { begun, nodes } = this.#readFinished;
    return begun > since ? nodes : this.#readTree();
  }

  /**
   * The document's nodes as last read (`#readTree`), or none before the
   * first read.
   *
   * @returns {object}
   */
  #nodes() {
    return latestNodes(this.#engine) ?? {};
  }

  /**
   * The document's nodes as last read, or a read of them before the first.
   * Every write is read back once it lands (`SvalTreeSnapshot`), so work
   * that runs after a write's read-back takes that read instead of making
   * its own.
   *
   * @returns {Promise<object>}
   */
  async #latestTree() {
    // A burst of closes reads its removes back after its last close, so
    // work queued between them reads for itself.
    if (this.#removedUnread) {
      return this.#readTree();
    }
    return latestNodes(this.#engine) ?? (await this.#readTree());
  }

  /**
   * Restarts the debounce window. A sync pass runs once activity stops, so a
   * burst of tabs opening publishes one file. The engine's own queue
   * serialises overlapping passes but does not coalesce them, so the coalescing
   * has to happen here.
   */
  #scheduleSync() {
    if (this.#detached) {
      return;
    }
    if (this.#syncTimer !== null) {
      clearTimeout(this.#syncTimer);
    }
    this.#syncTimer = setTimeout(() => {
      this.#syncTimer = null;
      this.#queue.post(() => this.#flushSync());
    }, this.#debounceMs);
  }

  /**
   * Arranges the next pass for a device where nothing local is happening,
   * which is how a peer's change arrives at all.
   *
   * A poll runs `#flushSync`, so a poll that lands on a tab whose title has
   * just resolved publishes that content in the same file, and the engine's
   * queue stays the only thing running passes. The timer is re-armed from
   * `#flushSync`, so a burst of local activity pushes the next poll a full
   * interval out instead of adding a second pass behind it.
   *
   * `pollMs: 0` turns polling off, which is what a test asserting on the
   * debounce alone wants.
   */
  #schedulePoll() {
    if (this.#detached || !this.#pollMs) {
      return;
    }
    if (this.#pollTimer !== null) {
      clearTimeout(this.#pollTimer);
    }
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = null;
      this.#queue.post(() => this.#flushSync({ fromPoll: true }));
    }, this.#pollMs);
  }

  /**
   * Writes what changed in this window's tabs, then asks for a pass.
   *
   * A poll that found nothing to write tells `onFlush` it is idle for one poll
   * interval: the pass it asks for brings in only what a peer wrote, which a
   * pass another window has just run already did.
   *
   * @param {object} [options]
   * @param {boolean} [options.fromPoll] Whether the poll timer asked.
   */
  async #flushSync({ fromPoll = false } = {}) {
    try {
      const wrote = await this.#writeChangedContent({ keepHeld: fromPoll });
      await this.#fromWindow(
        this.onFlush({ idleWithinMs: fromPoll && !wrote ? this.#pollMs : 0 })
      );
    } catch (err) {
      SvalLog.warn(`sync after tab activity failed: ${describeError(err)}`);
    } finally {
      // Whatever the pass did, the next one is an interval from here: a failed
      // pass must still leave the device looking for its peers, and a
      // successful one must not leave two clocks running.
      this.#schedulePoll();
    }
  }

  /**
   * Writes now whatever this window's tabs left the local settings waiting
   * to write (`SvalLocalSettings` `saveSoon`), for a caller that reads the
   * file next.
   */
  async #flushSettings() {
    try {
      await this.#settings?.flushPending();
    } catch (err) {
      SvalLog.warn(
        `writing device-local tab state failed: ${describeError(err)}`
      );
    }
  }
}

export const SvalTabs = {
  /** The session-store key a tab's node id is stored under. */
  NODE_ID_KEY,

  /**
   * Starts recording the tabs closed in `window` while no observer watches
   * it (`closedUnwatched`). A tab carried to another window keeps its node,
   * and so does one closing with its window, as an observer's `TabClose`
   * has it.
   *
   * @param {DOMWindow} window A browser window.
   */
  watchWindow(window) {
    window.addEventListener("TabClose", event => {
      if (
        watchers.get(window) > 0 ||
        SvalFirefox.adoptedBy(event) ||
        SvalFirefox.closesWindow(event) ||
        chromeTabAdapter.isPrivate(window)
      ) {
        return;
      }
      // A copy stands for no node: its original's stays.
      const id = resolveNodeId(chromeTabAdapter, event.target);
      if (id) {
        let closed = closedUnwatched.get(window);
        if (!closed) {
          closed = new Set();
          closedUnwatched.set(window, closed);
        }
        closed.add(id);
      }
    });
  },

  /**
   * The node ids of the tabs closed in `window` since its observer last
   * stood down, or before it first attached (`closedUnwatched`).
   *
   * @param {DOMWindow} window A browser window.
   * @returns {Set<string>}
   */
  closedUnwatched(window) {
    return closedUnwatched.get(window) ?? new Set();
  },

  removeNodes,

  /**
   * The node id a normal window's tab stands for, or null
   * (`resolveNodeId`). What anything outside the tab observer that grants
   * or checks by node reads.
   *
   * @param {object} tab A Firefox tab.
   * @returns {string|null}
   */
  nodeIdOf(tab) {
    return resolveNodeId(chromeTabAdapter, tab);
  },

  /**
   * The workspace a window's tab is in: the workspace of the node it stands
   * for (`nodeIdOf`), or, for a tab no node describes yet, such as a copy or
   * an open Quick Peek, the workspace its window shows.
   *
   * @param {Window} win A window with a panel.
   * @param {object|null} tab A tab of that window.
   * @returns {string|null}
   */
  workspaceOfTab(win, tab) {
    const node = tab ? this.nodeIdOf(tab) : null;
    return (
      (node ? workspaceOfNode(win.SvalPanel.nodes ?? {}, node) : null) ??
      lazy.SvalWindowWorkspace.of(win).id
    );
  },

  /**
   * The address a normal window's tab is for (`chromeTabAdapter.openingUrl`),
   * whether it is lazy, restoring or loaded.
   *
   * @param {object} tab A Firefox tab.
   * @returns {string}
   */
  openingUrl(tab) {
    return chromeTabAdapter.openingUrl(tab);
  },

  /**
   * Whether a normal window's tab carries a node id it does not stand for
   * (`isUnsettled`). A check by node treats such a tab as the user's.
   *
   * @param {object} tab A Firefox tab.
   * @returns {boolean}
   */
  isUnsettled(tab) {
    return isUnsettled(chromeTabAdapter, tab);
  },

  /**
   * Mirrors one chrome window's tab strip into the synced tree.
   *
   * The engine and the workspace are passed in rather than discovered here:
   * the storage root is the user's choice (spec §6.4) and which workspace a
   * window shows is not this file's decision. Nothing is written until
   * `start()` has reconciled the tabs already open.
   *
   * @param {DOMWindow} window The chrome window to watch.
   * @param {object} options
   * @param {object} options.engine A `SvalEngine`.
   * @param {string} options.workspaceId The workspace new tabs are filed under.
   *   Must already exist in the document.
   * @param {string} [options.syncDocument] The name of the document a
   *   debounced flush syncs: the same string on every device, so never a
   *   workspace id. Required unless `onFlush` is supplied instead.
   * @param {object} [options.settings] A `SvalLocalSettings` store, which is
   *   where last-active times go. Omitted, they are not recorded.
   * @param {number} [options.debounceMs] How long activity coalesces before a
   *   sync pass.
   * @param {number} [options.pollMs] How long an idle device waits between
   *   passes, which is how a peer's change reaches this one. `0` polls never.
   * @param {object} [options.adapter] How tabs are read and tagged. Defaults
   *   to the real session-store-backed one.
   * @param {object} [options.nodeIds] For a window on a tree in memory
   *   only, and required there: `{ get(tab), set(tab, id) }`, the session's
   *   own record of which node each tab is (`SvalPrivateSession`).
   * @param {Function} [options.newId] Mints a node id. The engine mints none
   *   (host contract §3).
   * @param {Function} [options.now] Milliseconds since the epoch. The engine
   *   reads no clock.
   * @param {Function} [options.onFlush] What a debounced flush does, given
   *   `{ idleWithinMs }`: nonzero for a poll that had nothing to write (see
   *   `SvalEngine.sync`). Defaults to one sync pass for `syncDocument`.
   * @param {Function} [options.onTreeChanged] Called and awaited after every
   *   mutation this observer makes, with the document's `nodes` as read
   *   after it, which is what keeps the panel from being stale about its own
   *   window's tabs. Defaults to doing nothing.
   * @param {Function} [options.onTabSelected] Called with the node id of a tab
   *   the window just showed, however it came to be shown: a click, a
   *   shortcut, or a workspace switch. Supplied by the panel, which keeps its
   *   selection on the tab the user is viewing. Defaults to doing nothing.
   * @param {Function} [options.onTabIconChanged] Called with the node id of a
   *   tab whose favicon changed. The icon is read back with {@link iconFor};
   *   it is not stored in the document. Defaults to doing nothing.
   * @param {Function} [options.onTabLoadChanged] Called with the node id of a
   *   tab that loaded, was unloaded, or started or finished loading a page.
   *   Read back with {@link isLoaded} and {@link isBusy}.
   *   Defaults to doing nothing.
   * @param {Function} [options.onTabHiddenChanged] Called with the node id of
   *   a tab an extension hid or showed (`tab.hidden`). Defaults to doing
   *   nothing.
   * @param {Function} [options.onKeptTabShown] Called with the node id of a
   *   tab a switch kept loaded and hid (`hideForWorkspace`) as something shows
   *   it, from within its `TabShow`. Defaults to doing nothing.
   * @param {Function} [options.onTabSoundChanged] Called with the node id of
   *   a tab that started or stopped playing sound or media, or was muted or
   *   unmuted.
   *   Defaults to doing nothing.
   * @param {Function} [options.newTabParent] Returns, or resolves to, the node
   *   id a newly-opened tab is filed under (the group the user is working
   *   in), unless it is the user's own new tab, which is filed at the top.
   *   Supplied by the panel, which is what owns selection; defaults to
   *   `workspaceId`.
   * @param {Iterable<string>} [options.keep] The node ids the window goes on
   *   holding, for a caller that lets the rest go with `releaseTabsOutside`
   *   once this resolves. A tab open at attach carrying another node's id is
   *   not filed. Omitted, every tab open at attach is.
   * @returns {Promise<SvalTabObserver>} the observer, already caught up.
   */
  async attach(window, options) {
    let adapter = options.adapter ?? chromeTabAdapter;
    // A private window's tabs must never reach the profile's document, and a
    // normal window's must never be lost to a private tree that ends with the
    // session (private-windows spec). Both mistakes are refused here, whatever
    // the caller meant.
    const isPrivateTree = options.engine?.isPrivate === true;
    if (adapter.isPrivate(window)) {
      if (!isPrivateTree || options.syncDocument || !options.nodeIds) {
        throw Object.assign(
          new Error(
            "sval: a private window is tracked only in a private session"
          ),
          { code: "private_window_outside_private_session" }
        );
      }
    } else if (isPrivateTree) {
      throw Object.assign(
        new Error(
          "sval: a normal window is never tracked in a private session"
        ),
        { code: "normal_window_in_private_session" }
      );
    }
    if (options.engine?.isMemory) {
      if (options.syncDocument || !options.nodeIds) {
        throw new Error(
          "sval: a window on a tree in memory keeps its ids in memory"
        );
      }
      // SessionStore's custom tab values are never set on such a tab.
      const { nodeIds } = options;
      adapter = {
        ...adapter,
        nodeId: tab => nodeIds.get(tab),
        setNodeId: (tab, id) => nodeIds.set(tab, id),
      };
      options = { ...options, adapter };
    }
    if (isPrivateTree) {
      // Where a closing tab sat (`FORMER_PARENT_KEY`, `FORMER_WORKSPACE_KEY`)
      // is filed in the session store, and a private tab leaves nothing
      // there. Neither value is missed. A private window shows one
      // workspace, the one `reopenClosedTab` gives a closed tab with none
      // filed. A tab handed back from the recently-closed list has a new
      // `permanentKey`, so it carries no node id and is filed as a new tab.
      adapter = {
        ...adapter,
        formerParent: undefined,
        setFormerParent: undefined,
        setFormerWorkspace: undefined,
      };
      options = { ...options, adapter };
    }
    const observer = new SvalTabObserver(window, options);
    await observer.start();
    return observer;
  },
};
