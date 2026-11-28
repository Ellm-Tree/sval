/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The Workspaces each extension is available in, and the Workspaces its
 * pinned button shows in (extension Workspaces spec §1, §2). Each scope is a
 * synced pref per extension holding a JSON list of Workspace ids. No pref is
 * every Workspace. A Workspace the tree no longer holds counts for nothing,
 * and a scope left with none is every Workspace, as a pin's "Show in" is
 * (`showsIn`).
 */

import { CustomizableUI } from "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SvalWindowWorkspace:
    "moz-src:///browser/components/sval/SvalWindowWorkspace.sys.mjs",
  homeOf: "moz-src:///browser/components/sval/SvalAgentTabRegistry.sys.mjs",
  isPeek: "moz-src:///browser/components/sval/SvalPeek.sys.mjs",
  latestNodes: "moz-src:///browser/components/sval/SvalTreeSnapshot.sys.mjs",
  showInWorkspaces: "moz-src:///browser/components/sval/SvalPinsRow.sys.mjs",
  appearanceOf: "moz-src:///browser/components/sval/SvalTree.sys.mjs",
  workspaceIds: "moz-src:///browser/components/sval/SvalTree.sys.mjs",
});

export const AVAILABLE_BRANCH = "browser.sval.extensions.workspaces.";
export const PIN_BRANCH = "browser.sval.extensions.pinWorkspaces.";

/** Notified with a browser window as it shows another Workspace. */
export const WORKSPACE_SHOWN_TOPIC = "sval-window-workspace-shown";

let started = false;

/** Marks a Workspace's entry in a policy's `blockedSites`. */
export const WORKSPACE_MARK = "%";

/**
 * @param {string} pref
 * @returns {string[]|null} The ids the pref holds, or null for no pref or a
 *   value that is not a list of strings.
 */
function readList(pref) {
  try {
    const ids = JSON.parse(Services.prefs.getStringPref(pref, ""));
    if (Array.isArray(ids) && ids.every(id => typeof id === "string")) {
      return ids;
    }
  } catch {}
  return null;
}

/**
 * @param {string} pref
 * @param {string[]|null} ids Null or empty clears the pref.
 */
function writeList(pref, ids) {
  if (ids?.length) {
    Services.prefs.setStringPref(pref, JSON.stringify([...new Set(ids)]));
  } else {
    Services.prefs.clearUserPref(pref);
  }
}

/**
 * @param {string} widgetId
 * @returns {string|null} The id of the extension whose toolbar button
 *   `widgetId` is.
 */
function extensionOfWidget(widgetId) {
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  for (const policy of WebExtensionPolicy.getActiveExtensions()) {
    if (
      win?.gUnifiedExtensions?.browserActionFor(policy)?.widget?.id === widgetId
    ) {
      return policy.id;
    }
  }
  return null;
}

/**
 * @returns {object|null} The nodes of the latest tree a normal browser
 *   window's engine handed out, or null before any has.
 */
function userNodes() {
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      continue;
    }
    const engine = win.SvalPanel?.engine;
    const nodes = engine && !win.SvalPanel.inMemory && lazy.latestNodes(engine);
    if (nodes) {
      return nodes;
    }
  }
  return null;
}

/**
 * @param {string[]|null} scope
 * @returns {string[]|null} `scope` without the Workspaces the tree no longer
 *   holds, null for every Workspace. Before any tree is read, the scope as
 *   saved.
 */
function live(scope) {
  if (!scope?.length) {
    return null;
  }
  const nodes = userNodes();
  if (!nodes) {
    return scope;
  }
  const held = new Set(lazy.workspaceIds(nodes));
  const kept = scope.filter(id => held.has(id));
  return kept.length ? kept : null;
}

export const SvalExtensionWorkspaces = {
  /**
   * The Workspace a tab is in (spec §1.3): the one the tree files it under,
   * or for a tab the tree does not hold yet, the one its window shows. A
   * Peek shows none.
   *
   * @param {object} browser A tab's `<browser>`.
   * @returns {string|null}
   */
  workspaceOf(browser) {
    const win = browser?.documentGlobal;
    if (!win || lazy.isPeek(win)) {
      return null;
    }
    return lazy.homeOf(browser) ?? lazy.SvalWindowWorkspace.of(win).id ?? null;
  },

  /**
   * @returns {{id: string, name: string, emoji: ?string}[]} The Workspaces
   *   a scope offers:
   *   the user's own, in the switcher's order (`showInWorkspaces`). None
   *   before any tree is read.
   */
  offered() {
    const nodes = userNodes();
    return nodes
      ? lazy.showInWorkspaces(nodes).map(each => ({
          ...each,
          emoji: lazy.appearanceOf(nodes, each.id).emoji,
        }))
      : [];
  },

  /**
   * @param {Window} win A browser window.
   * @returns {string|null} The Workspace it shows; none for a Peek.
   */
  workspaceOfWindow(win) {
    return lazy.isPeek(win)
      ? null
      : (lazy.SvalWindowWorkspace.of(win).id ?? null);
  },

  /**
   * @param {string} id
   * @param {Window} win
   * @returns {boolean} Whether the extension is available in the Workspace
   *   `win` shows, so its button, its row of the extensions menu, its
   *   context menu items and its shortcuts work there (spec §1.5).
   */
  availableInWindow(id, win) {
    return this.isAvailableIn(id, this.workspaceOfWindow(win));
  },

  /**
   * Hides each extension's toolbar button in `win` that its scope or its
   * pin's scope leaves out of the Workspace `win` shows (spec §1.5, §2.4).
   * The placement stays CustomizableUI's, the same in every window, so the
   * button is hidden by an attribute of Sval's that CustomizableUI never
   * touches.
   *
   * @param {Window} win
   */
  applyToWindow(win) {
    const extensions = win.gUnifiedExtensions;
    if (!extensions) {
      return;
    }
    const ws = this.workspaceOfWindow(win);
    for (const policy of WebExtensionPolicy.getActiveExtensions()) {
      const widgetId = extensions.browserActionFor(policy)?.widget?.id;
      const node =
        widgetId && CustomizableUI.getWidget(widgetId)?.forWindow(win)?.node;
      if (!node) {
        continue;
      }
      const area = CustomizableUI.getPlacementOfWidget(widgetId)?.area;
      const pinned = !!area && area !== CustomizableUI.AREA_ADDONS;
      const shows = pinned
        ? this.pinShowsIn(policy.id, ws)
        : this.isAvailableIn(policy.id, ws);
      node.toggleAttribute("sval-workspace-hidden", !shows);
    }
  },

  /**
   * Applies the scopes to every browser window's toolbar. A window still
   * building its toolbars is left to `WORKSPACE_SHOWN_TOPIC`: making its
   * button reads the window's selected tab (`updateButton` in
   * ext-browserAction.js), and `BrowserWindowTracker` tracks a window only
   * once its tabbrowser exists.
   */
  applyToAll() {
    for (const win of lazy.BrowserWindowTracker.orderedWindows) {
      this.applyToWindow(win);
    }
  },

  /**
   * Keeps every window's toolbar as the scopes have it: as a scope changes,
   * as a window shows another Workspace, and as a button is made or moved.
   * Idempotent.
   */
  start() {
    if (started) {
      return;
    }
    started = true;
    const all = () => this.applyToAll();
    Services.prefs.addObserver(AVAILABLE_BRANCH, all);
    Services.prefs.addObserver(PIN_BRANCH, all);
    Services.obs.addObserver(
      win => this.applyToWindow(win),
      WORKSPACE_SHOWN_TOPIC
    );
    CustomizableUI.addListener({
      onWidgetAfterCreation: all,
      onWidgetAdded: (widgetId, area) => {
        // An unpinned button keeps no scope, so pinning it again puts it in
        // every Workspace (spec §2.3).
        if (area === CustomizableUI.AREA_ADDONS) {
          const id = extensionOfWidget(widgetId);
          if (id) {
            this.setPinScope(id, null);
          }
        }
        all();
      },
      onWidgetRemoved: all,
    });
    all();
  },

  /**
   * @param {string} id An extension's id.
   * @returns {string[]|null} The Workspaces it is available in, null for
   *   every Workspace.
   */
  availableIn(id) {
    return live(readList(AVAILABLE_BRANCH + id));
  },

  /**
   * @param {string} id
   * @param {string|null} workspaceId The Workspace a tab or window is in,
   *   null for none.
   * @returns {boolean}
   */
  isAvailableIn(id, workspaceId) {
    const scope = this.availableIn(id);
    return !scope || scope.includes(workspaceId);
  },

  /**
   * @param {string} id
   * @param {string[]|null} scope Null for every Workspace.
   */
  setAvailableIn(id, scope) {
    writeList(AVAILABLE_BRANCH + id, scope);
  },

  /**
   * @param {string} id
   * @returns {string[]} The entries the extension's policy holds for its
   *   scope (`blockedSites`): one per Workspace it is available in, none
   *   for every Workspace. Gecko refuses it in a tab whose Workspace has no
   *   entry when there is one.
   */
  policyEntries(id) {
    return (this.availableIn(id) ?? []).map(ws => WORKSPACE_MARK + ws);
  },

  /**
   * @param {string} id
   * @returns {string[]|null} The Workspaces its pinned button shows in, null
   *   for every Workspace it is available in.
   */
  pinScope(id) {
    return live(readList(PIN_BRANCH + id));
  },

  /**
   * @param {string} id
   * @param {string[]|null} scope Null for every Workspace.
   */
  setPinScope(id, scope) {
    writeList(PIN_BRANCH + id, scope);
  },

  /**
   * @param {string} id
   * @param {string|null} workspaceId
   * @returns {boolean} Whether the extension's button, where pinned, shows in
   *   a window showing `workspaceId`.
   */
  pinShowsIn(id, workspaceId) {
    if (!this.isAvailableIn(id, workspaceId)) {
      return false;
    }
    const scope = this.pinScope(id);
    return !scope || scope.includes(workspaceId);
  },
};
