/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Open tabs in the address bar, from every workspace (launcher spec §5, §6).
 *
 * An inactive workspace is data only (spec §10.4): its tabs are nodes of the
 * tree, not Firefox tabs, so `UrlbarProviderPlaces`' open pages and
 * `switchToTabHavingURI` cannot see them. `SvalLauncherTabs`, a provider on
 * the address bar's providers manager, lists the tree's tabs instead, read
 * from the window's tree at query time, as switch-to-tab rows carrying the
 * node: the tabs that match in the Open tabs section; with nothing typed,
 * the most recently used tabs, under Recent tabs, in place of Firefox's top
 * sites; and in the Tabs search mode or after `%`, every tab.
 *
 * An open tab is never the row Enter takes: what was typed is searched for,
 * or visited when it is an address, as Firefox's address bar does (launcher
 * spec §3). When a tab matches strongly, Open tabs moves up to follow that
 * row (`SvalLauncherSections` places its group).
 *
 * Picking a row goes through the panel's own select (`SvalPanel.goToTab`,
 * called from `launcher-enter.patch`), which changes workspace in the one
 * place a window does (decision 0079). Firefox's own switch-to-tab rows for
 * a page the tree holds as a tab are dropped (`launcher-tab-rows.patch`), so
 * a tab shows once. A pin's page is no tab of the tree: where `SvalFavorites`
 * lists the pin, its pin's row stands for the page (`SvalLauncherSections`),
 * and elsewhere, as in the Tabs search mode, Firefox's row for it stays.
 *
 * The rows follow the address bar's Open tabs setting
 * (`browser.urlbar.suggest.openpage`), which is what puts
 * `RESULT_SOURCE.TABS` among a query's sources.
 *
 * **No query, title, address or workspace name is ever logged** (Sval
 * `CONTRIBUTING.md` rule 10).
 */

import {
  UrlbarProvider,
  UrlbarUtils,
} from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";
import {
  fold,
  matchableUrl,
  onBoundary,
} from "moz-src:///browser/components/sval/SvalFavoritesProvider.sys.mjs";
import {
  TAB,
  agentLabelOf,
  appearanceOf,
  displayName,
  workspaceOfNode,
} from "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs";
import { colorOf } from "moz-src:///browser/components/sval/SvalColor.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LAUNCHER_PREFS:
    "moz-src:///browser/components/sval/SvalLauncherPrefs.sys.mjs",
  launcherLimit: "moz-src:///browser/components/sval/SvalLauncherPrefs.sys.mjs",
  SvalPeek: "moz-src:///browser/components/sval/SvalPeek.sys.mjs",
  ProvidersManager:
    "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
  UrlbarProviderTopSites:
    "moz-src:///browser/components/urlbar/UrlbarProviderTopSites.sys.mjs",
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  describeError: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
  UrlbarTokenizer:
    "moz-src:///browser/components/urlbar/UrlbarTokenizer.sys.mjs",
  latestNodes: "moz-src:///browser/components/sval/SvalTreeSnapshot.sys.mjs",
  refusedAddress:
    "moz-src:///browser/components/sval/SvalSyncableAddress.sys.mjs",
});

/** The Open tabs section's group, which the address bar's layout names. */
export const TABS_GROUP = "sval-tabs";

/** The group of the Open tabs rows when one matches strongly. */
export const TABS_TOP_GROUP = "sval-tabs-top";

/** The group of the tabs listed while nothing is typed. */
export const RECENT_TABS_GROUP = "sval-recent-tabs";

/** How many tabs the empty address bar lists (the Launcher's design). */
export const RECENT_TABS = 6;

/** The Fluent file of the Launcher's strings, as `sval/<file>.ftl`. */
export const LAUNCHER_FTL = "sval/launcher.ftl";

/**
 * The tabs a window may list: every tab node with an address, or only those
 * of the window's own workspace. A tab another device wrote at an address no
 * device opens (`refusedAddress`) is never listed.
 *
 * @param {object} nodes
 * @param {object} options
 * @param {string|null} options.currentWorkspaceId
 * @param {boolean} options.onlyCurrent
 * @param {string|null} options.exclude
 * @returns {object[]} `{ nodeId, workspaceId, title, url }`
 */
function candidates(nodes, { currentWorkspaceId, onlyCurrent, exclude }) {
  const out = [];
  for (const [id, n] of Object.entries(nodes)) {
    const url = n?.content?.url;
    if (
      n?.kind !== TAB ||
      !url ||
      id === exclude ||
      lazy.refusedAddress(n.content)
    ) {
      continue;
    }
    const workspaceId = workspaceOfNode(nodes, id);
    if (!workspaceId || (onlyCurrent && workspaceId !== currentWorkspaceId)) {
      continue;
    }
    out.push({ nodeId: id, workspaceId, title: displayName(n), url });
  }
  return out;
}

/**
 * The tree's open tabs that match what was typed (launcher spec §5).
 *
 * Every word typed has to start a word of the tab's title or address, as the
 * address bar matches history (`onBoundary`). Archived tabs are not open: the
 * Archive is a list of its own. The window's own workspace comes first, then
 * the most recently used.
 *
 * @param {object} nodes The tree's `nodes`.
 * @param {string} text What was typed.
 * @param {object} options
 * @param {string|null} options.currentWorkspaceId The workspace the window
 *   shows.
 * @param {(id: string) => number|null} options.lastActive When this device
 *   last looked at a node (`SvalLocalSettings.lastActive`).
 * @param {number} [options.limit] How many to answer at most.
 * @param {boolean} [options.onlyCurrent] Only the window's own workspace's
 *   tabs, as in a private window (launcher spec §6).
 * @param {string|null} [options.exclude] The tab the window shows.
 * @returns {Array<{nodeId: string, workspaceId: string, title: string,
 *   url: string, strong: boolean}>} `strong` when the text starts a word of
 *   the title, or starts the host.
 */
export function matchTabs(
  nodes,
  text,
  {
    currentWorkspaceId,
    lastActive,
    limit = Infinity,
    onlyCurrent = false,
    exclude = null,
  }
) {
  const words = fold(text).split(/\s+/).filter(Boolean);
  if (!words.length) {
    return [];
  }
  const whole = words.join(" ");
  const found = [];
  for (const tab of candidates(nodes, {
    currentWorkspaceId,
    onlyCurrent,
    exclude,
  })) {
    const address = matchableUrl(tab.url);
    if (!words.every(w => onBoundary(w, tab.title) || onBoundary(w, address))) {
      continue;
    }
    const host = (URL.parse(tab.url)?.host ?? "").toLowerCase();
    const strong =
      onBoundary(whole, tab.title) ||
      host.startsWith(whole) ||
      host.replace(/^www\./, "").startsWith(whole);
    found.push({ ...tab, strong });
  }
  return ranked(found, { currentWorkspaceId, lastActive }).slice(0, limit);
}

/**
 * The most recently used tabs, for the address bar with nothing typed
 * (launcher spec §5), as a ⌃Tab list orders them, across workspaces.
 *
 * @param {object} nodes The tree's `nodes`.
 * @param {object} options
 * @param {(id: string) => number|null} options.lastActive
 * @param {number} [options.limit]
 * @param {string|null} [options.currentWorkspaceId]
 * @param {boolean} [options.onlyCurrent]
 * @param {string|null} [options.exclude]
 * @returns {Array<{nodeId: string, workspaceId: string, title: string,
 *   url: string, strong: boolean}>} `strong` is always false.
 */
export function recentTabs(
  nodes,
  {
    lastActive,
    limit = Infinity,
    currentWorkspaceId = null,
    onlyCurrent = false,
    exclude = null,
  }
) {
  const tabs = candidates(nodes, { currentWorkspaceId, onlyCurrent, exclude });
  return ranked(
    tabs.map(tab => ({ ...tab, strong: false })),
    { currentWorkspaceId: null, lastActive }
  ).slice(0, limit);
}

/**
 * `tabs` with the window's workspace first, then by use, newest first; a
 * stable sort, so ties keep the tree's order.
 *
 * @param {object[]} tabs
 * @param {object} options
 * @param {string|null} options.currentWorkspaceId
 * @param {(id: string) => number|null} options.lastActive
 * @returns {object[]}
 */
function ranked(tabs, { currentWorkspaceId, lastActive }) {
  const when = new Map(tabs.map(t => [t.nodeId, lastActive(t.nodeId) ?? -1]));
  return tabs.sort(
    (a, b) =>
      (b.workspaceId === currentWorkspaceId) -
        (a.workspaceId === currentWorkspaceId) ||
      when.get(b.nodeId) - when.get(a.nodeId)
  );
}

/**
 * What one query found, by its context, which the provider and the muxer
 * read. Made once per query from the tree as it is then, and dropped with
 * the context.
 *
 * @type {WeakMap<object, {query: object, rows: object[], strong: boolean,
 *   currentWorkspaceId: string|null, recent: boolean, pages: Set<string>}>}
 */
const found = new WeakMap();

/**
 * Reads the window's tree for a query, or answers what was already read for
 * it.
 *
 * @param {object} queryContext
 * @param {object} query The manager's query (`queryInstance`).
 * @param {Window|null} win The browser window the query is for.
 * @returns {object|null} null when the window has no tree to list.
 */
function lookUp(queryContext, query, win) {
  const known = found.get(queryContext);
  if (known?.query === query) {
    return known;
  }
  // A Peek has no panel, and its tab rows go to the ordinary
  // window's tabs (`SvalLauncherTabs.pick`).
  const host =
    win && lazy.SvalPeek.isPeek(win) ? lazy.SvalPeek.openOrdinaryWindow() : win;
  const panel = host?.SvalPanel;
  const nodes = panel?.engine ? lazy.latestNodes(panel.engine) : null;
  if (
    !nodes ||
    !queryContext.sources?.includes(UrlbarUtils.RESULT_SOURCE.TABS)
  ) {
    found.delete(queryContext);
    return null;
  }
  const options = {
    currentWorkspaceId: panel.workspaceId,
    lastActive: id => panel.settings.lastActive(id),
    onlyCurrent: !!panel.inMemory,
    exclude: panel.observer?.nodeIdFor(host.gBrowser.selectedTab) ?? null,
  };
  const limit = lazy.launcherLimit(lazy.LAUNCHER_PREFS.limitTabs);
  // Without `%` or another restriction character, which is no part of a
  // tab's title.
  const text = (queryContext.tokens ?? [])
    .filter(t => !lazy.UrlbarTokenizer.isRestrictionToken(t))
    .map(t => t.value)
    .join(" ");
  const all = text ? matchTabs(nodes, text, options) : [];
  const devices = panel.devices?.() ?? null;
  // A private window's tabs are its own, in no workspace of the user's.
  const workspaceOfRow = workspaceId => {
    if (panel.inMemory) {
      return { workspaceName: null, agent: false, color: null, emoji: null };
    }
    const agent = agentLabelOf(nodes, workspaceId, devices);
    const appearance = appearanceOf(nodes, workspaceId);
    return {
      workspaceName: panel.workspaceName({
        agent,
        name: nodes[workspaceId]?.content?.name ?? "",
      }),
      agent: !!agent,
      // An agent's workspace wears the agent's look, never a colour of its
      // own (`SvalPanel.workspaceColor`).
      color: agent ? null : colorOf(appearance.color, "workspace"),
      emoji: agent ? null : appearance.emoji,
    };
  };
  const inMode = !!queryContext.searchMode || !!queryContext.restrictSource;
  // Nothing typed in a mode of its own, such as the Tabs search mode, asks
  // for every tab.
  const recent = !text && !inMode;
  const strong = !inMode && all.some(row => row.strong);
  let rows;
  if (text) {
    // A strong match leads, so the limit never cuts it off.
    rows = [
      ...all.filter(row => row.strong),
      ...all.filter(row => !row.strong),
    ].slice(0, limit);
  } else {
    rows = recentTabs(nodes, {
      ...options,
      limit: recent ? RECENT_TABS : Infinity,
    });
  }
  const pages = new Set();
  for (const n of Object.values(nodes)) {
    if (n?.kind === TAB && n.content?.url) {
      pages.add(n.content.url);
    }
  }
  const entry = {
    query,
    rows: rows.map(row => ({ ...row, ...workspaceOfRow(row.workspaceId) })),
    strong,
    currentWorkspaceId: options.currentWorkspaceId,
    recent,
    pages,
  };
  found.set(queryContext, entry);
  return entry;
}

/**
 * A switch-to-tab result for one of the tree's tabs.
 *
 * @param {object} queryContext
 * @param {object} row A {@link lookUp} row.
 * @param {object} extra What the result adds (`group`, `rowLabel`).
 * @returns {UrlbarResult}
 */
function resultFor(queryContext, row, extra) {
  const { TABS, OTHER_LOCAL } = UrlbarUtils.RESULT_SOURCE;
  const here = found.get(queryContext)?.currentWorkspaceId ?? null;
  return new lazy.UrlbarResult({
    type: UrlbarUtils.RESULT_TYPE.TAB_SWITCH,
    // A query restricted to open tabs (`%`, the Tabs search mode) accepts
    // only that source (`Query.add`'s `acceptableSources`).
    source: queryContext.restrictSource === TABS ? TABS : OTHER_LOCAL,
    payload: {
      url: row.url,
      title: row.title || row.url,
      icon: UrlbarUtils.getIconForUrl(row.url),
      svalNodeId: row.nodeId,
      svalWorkspaceName: row.workspaceName,
      svalWorkspaceColor: row.color ?? "",
      svalWorkspaceEmoji: row.emoji ?? "",
      svalAgent: row.agent,
      svalHere: row.workspaceId === here,
    },
    highlights: {
      url: UrlbarUtils.HIGHLIGHT.TYPED,
      title: UrlbarUtils.HIGHLIGHT.TYPED,
    },
    ...extra,
  });
}

/** The tree's tabs that match a query, in the Open tabs section. */
export class SvalLauncherTabsProvider extends UrlbarProvider {
  get name() {
    return "SvalLauncherTabs";
  }

  get type() {
    return UrlbarUtils.PROVIDER_TYPE.PROFILE;
  }

  async isActive(queryContext, controller) {
    const entry = lookUp(
      queryContext,
      this.queryInstance,
      controller?.browserWindow ?? null
    );
    return !!entry?.rows.length;
  }

  /**
   * With nothing typed, above the top sites and the other rows Firefox lists
   * then (`UrlbarProviderTopSites.PRIORITY`), so the list is the recent tabs
   * alone (launcher spec §5): the manager queries only the active providers
   * of the highest priority.
   *
   * @param {object} queryContext
   * @returns {number}
   */
  getPriority(queryContext) {
    return found.get(queryContext)?.recent
      ? lazy.UrlbarProviderTopSites.PRIORITY + 1
      : 0;
  }

  async startQuery(queryContext, addCallback) {
    const entry = found.get(queryContext);
    for (const row of entry?.rows ?? []) {
      addCallback(
        this,
        resultFor(
          queryContext,
          row,
          entry.recent
            ? {
                group: RECENT_TABS_GROUP,
                rowLabel: { id: "launcher-section-recent-tabs" },
              }
            : {
                group: entry.strong ? TABS_TOP_GROUP : TABS_GROUP,
                rowLabel: { id: "launcher-section-tabs" },
              }
        )
      );
    }
  }
}

export const SvalLauncherTabs = {
  /**
   * Whether the muxer drops a result of another provider: Firefox's
   * switch-to-tab row for a page the window's tree holds as a tab, which
   * Sval's own row stands for (launcher spec §6).
   *
   * @param {UrlbarResult} result
   * @param {object} queryContext
   * @returns {boolean}
   */
  replaces(result, queryContext) {
    return (
      result.type === UrlbarUtils.RESULT_TYPE.TAB_SWITCH &&
      !result.payload.svalNodeId &&
      !!found.get(queryContext)?.pages.has(result.payload.url)
    );
  },

  /**
   * Goes to the tab a row carries, and closes the empty tab it was picked
   * from, as `UrlbarInput.pickResult` closes one after a switch to a tab.
   * From a Peek, the ordinary window goes to it.
   *
   * @param {Window} win
   * @param {UrlbarResult} result A row of this provider.
   * @param {object} from The tab the row was picked in.
   * @param {object} [options]
   * @param {boolean} [options.newWindow] Whether a workspace no window
   *   shows opens in a window of its own (`SvalPanel.goToTab`).
   */
  pick(win, result, from, { newWindow = false } = {}) {
    const inPeek = lazy.SvalPeek.isPeek(win);
    const leaving =
      !inPeek && from && !from.splitview && from.isEmpty ? from : null;
    (async () => {
      const host = inPeek ? await lazy.SvalPeek.ordinaryWindow() : win;
      await host.SvalPanel.goToTab(result.payload.svalNodeId, {
        leaving,
        newWindow,
      });
    })().catch(err =>
      lazy.SvalLog.error(
        `going to an open tab failed: ${lazy.describeError(err)}`
      )
    );
  },

  /**
   * Registers the provider on the address bar's providers manager, once
   * for the process, before any window queries it.
   */
  register() {
    const manager = lazy.ProvidersManager.getInstanceForSap("urlbar");
    const provider = new SvalLauncherTabsProvider();
    if (!manager.getProvider(provider.name)) {
      manager.registerProvider(provider);
    }
  },
};
