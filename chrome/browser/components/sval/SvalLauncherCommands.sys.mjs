/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Sval's commands as rows of the address bar (launcher spec §4, §6).
 *
 * Firefox's quick actions draw one row of buttons with no key and no
 * sub-list (`UrlbarProviderGlobalActions`), so they cannot be the spec's
 * rows, and `browser.urlbar.suggest.quickactions` is off. The provider here
 * yields one row per command whose name or synonyms the text matches, each
 * showing its key as it is now, read from its `<key>`. A command runs what
 * already does it: the panel's own methods, Firefox's commands, and for the
 * quick actions Sval keeps, the quick action's own `onPick`.
 *
 * A command that picks something ("Move this tab to…", "Split with…") keeps
 * the address bar open: Enter on it clears the field, puts the command as a
 * chip at the field's start and lists the choices, which only this provider
 * answers while it shows (`launcher-enter.patch`'s query context). Back is
 * the chip's button, Backspace in the empty field, or Escape; Escape at the
 * first list closes the address bar.
 *
 * A row is checked again when picked: a command that no longer applies, such
 * as Move to Favorites after the pin went, does nothing.
 *
 * **No query, title, address or workspace name is ever logged**: a
 * diagnostic never says what the user is browsing.
 */

import {
  UrlbarProvider,
  UrlbarUtils,
} from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";
import {
  fold,
  onBoundary,
} from "moz-src:///browser/components/sval/SvalFavoritesProvider.sys.mjs";
import {
  agentLabelOf,
  isPane,
} from "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs";
import {
  TAB,
  WORKSPACE,
  childrenByParent,
  displayName,
} from "moz-src:///browser/components/sval/SvalTree.sys.mjs";
import {
  COPY_ADDRESS_KEY,
  NEW_PEEK_KEY,
  NEW_WORKSPACE_KEY,
  PANEL_TOGGLE_KEY,
  STYLE_KEY,
  ariaShortcut,
  keyOf,
  shortcutText,
} from "moz-src:///browser/components/sval/SvalKeys.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalWindowWorkspace:
    "moz-src:///browser/components/sval/SvalWindowWorkspace.sys.mjs",
  copyAddress: "moz-src:///browser/components/sval/SvalTabActions.sys.mjs",
  copyMarkdownLink: "moz-src:///browser/components/sval/SvalTabActions.sys.mjs",
  canUnload: "moz-src:///browser/components/sval/SvalTabActions.sys.mjs",
  unloadTabs: "moz-src:///browser/components/sval/SvalTabActions.sys.mjs",
  isKeptLoaded: "moz-src:///browser/components/sval/SvalTabActions.sys.mjs",
  setKeptLoaded: "moz-src:///browser/components/sval/SvalTabActions.sys.mjs",
  ActionsProviderQuickActions:
    "moz-src:///browser/components/urlbar/ActionsProviderQuickActions.sys.mjs",
  LAUNCHER_PREFS:
    "moz-src:///browser/components/sval/SvalLauncherPrefs.sys.mjs",
  launcherLimit: "moz-src:///browser/components/sval/SvalLauncherPrefs.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  ProvidersManager:
    "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
  QuickActionsLoaderDefault:
    "moz-src:///browser/components/urlbar/QuickActionsLoaderDefault.sys.mjs",
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
  SvalArchive: "moz-src:///browser/components/sval/SvalArchive.sys.mjs",
  SvalFavorites: "moz-src:///browser/components/sval/SvalFavorites.sys.mjs",
  SvalJavascript: "moz-src:///browser/components/sval/SvalJavascript.sys.mjs",
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  SvalProtectionButton:
    "moz-src:///browser/components/sval/SvalProtectionButton.sys.mjs",
  SvalPeek: "moz-src:///browser/components/sval/SvalPeek.sys.mjs",
  SvalSiteControls:
    "moz-src:///browser/components/sval/SvalSiteControls.sys.mjs",
  SvalSiteStylePanel:
    "moz-src:///browser/components/sval/SvalSiteStylePanel.sys.mjs",
  UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
  UrlbarTokenizer:
    "moz-src:///browser/components/urlbar/UrlbarTokenizer.sys.mjs",
  describeError: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  isWorkspaceHeld:
    "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs",
  scopeForURI: "moz-src:///browser/components/sval/SvalSite.sys.mjs",
  mediaOf: "moz-src:///browser/components/sval/SvalSiteControls.sys.mjs",
  stateOf: "moz-src:///browser/components/sval/SvalProtectionButton.sys.mjs",
});

ChromeUtils.defineLazyGetter(
  lazy,
  "l10n",
  () => new Localization(["branding/brand.ftl", "sval/launcher.ftl"])
);

/** The Commands section's group, which the address bar's layout names. */
export const COMMANDS_GROUP = "sval-commands";

const PROVIDER_NAME = "SvalLauncherCommands";

/** The view's dynamic type of the rows here, which names their classes. */
const DYNAMIC_TYPE = "svalCommand";

/** The choice that makes a workspace, last in a list of workspaces. */
const NEW_WORKSPACE = "new-workspace";

// ------------------------------------------------------------ the window

/**
 * The panel of a window with workspaces: a private window has none (private
 * windows spec §2), and its panel holds a tree of its own.
 *
 * @param {Window} win
 * @returns {object|null}
 */
export function userPanel(win) {
  const panel = win.SvalPanel;
  return panel?.engine && !panel.inMemory && lazy.SvalWindowWorkspace.of(win).id
    ? panel
    : null;
}

/**
 * @param {Window} win
 * @returns {string|null} The tree node of the tab the window shows.
 */
function selectedNode(win) {
  return win.SvalPanel?.observer?.nodeIdFor(win.gBrowser.selectedTab) ?? null;
}

/**
 * @param {Window} win
 * @returns {string|null} The agent's workspace the window shows, if it is
 *   one.
 */
function agentWorkspace(win) {
  const panel = userPanel(win);
  const id = panel && lazy.SvalWindowWorkspace.of(win).id;
  return id && agentLabelOf(panel.nodes, id) ? id : null;
}

/**
 * The split the window's tab is a pane of.
 *
 * @param {Window} win
 * @returns {string|null}
 */
function selectedSplit(win) {
  const nodes = win.SvalPanel?.nodes ?? {};
  const id = selectedNode(win);
  return id && isPane(nodes, id) ? nodes[id].placement.parent : null;
}

/**
 * The split the window's tab is in, as Firefox shows it.
 *
 * @param {Window} win
 * @returns {object|null} The tab's `MozTabSplitViewWrapper`.
 */
function shownSplit(win) {
  return win.gBrowser.selectedTab?.splitview ?? null;
}

/**
 * @param {Window} win
 * @param {string} id A `<command>` id.
 */
function doCommand(win, id) {
  win.document.getElementById(id)?.doCommand();
}

/**
 * The JavaScript setting of the window's page, at its host's scope, where
 * the site menu opens (host-scoped rules spec §4), or null where it cannot
 * change.
 *
 * @param {Window} win
 * @returns {{host: string, on: boolean}|null}
 */
function javascriptOf(win) {
  const browser = win.gBrowser.selectedBrowser;
  if (lazy.PrivateBrowsingUtils.isBrowserPrivate(browser)) {
    return null;
  }
  const host = lazy.scopeForURI(browser.currentURI)?.host;
  return host ? { host, on: lazy.SvalJavascript.enabledFor(host) } : null;
}

/**
 * Sets the window's page's JavaScript at its host's scope.
 *
 * @param {Window} win
 * @param {boolean} on
 */
function setJavascript(win, on) {
  const js = javascriptOf(win);
  if (!js || js.on === on) {
    return;
  }
  lazy.SvalJavascript.setEnabled(js.host, on);
  win.gBrowser.selectedBrowser.reload();
  lazy.SvalSiteControls.forWindow(win)?.update();
}

/**
 * Firefox's quick action `key` (`QuickActionsLoaderDefault`), once loaded.
 *
 * @param {string} key
 * @returns {object|undefined}
 */
function quickAction(key) {
  return lazy.ActionsProviderQuickActions.getAction(key);
}

/**
 * A command that is one of Firefox's quick actions: shown where the quick
 * action is, and run by its own `onPick`, as `pickAction` runs it.
 *
 * @param {string} id
 * @param {string} key The quick action's key.
 * @param {string|null} keyId
 * @param {object} [options]
 * @param {boolean} [options.ordinary] Whether it opens a page of the
 *   browser's own ({@link ordinaryWindowFor}).
 * @returns {object} A {@link COMMANDS} entry.
 */
function firefoxAction(id, key, keyId = null, { ordinary = false } = {}) {
  return {
    id,
    l10nId: `launcher-command-${id}`,
    synonymsL10nId: `launcher-command-${id}-synonyms`,
    keyId,
    available: () => {
      const action = quickAction(key);
      return !!action && (action.isVisible?.() ?? true);
    },
    run: async win => {
      const target = ordinary ? await ordinaryWindowFor(win) : win;
      await lazy.QuickActionsLoaderDefault.ensureLoaded();
      const options = await quickAction(key)?.onPick(
        {},
        { browserWindow: target }
      );
      if (options?.focusContent) {
        target.gBrowser.selectedBrowser.focus();
      }
    },
  };
}

/**
 * The Settings panes, by their address and their name in the nav
 * (`settings-pane.js`' `NAV_ORDER`). Agents is reached through Agent access
 * settings, one of the agent commands.
 */
const SETTINGS_PANES = [
  { id: "general", pane: "paneSync" },
  { id: "workspaces", pane: "paneHome" },
  { id: "links", pane: "paneSvalLinks" },
  { id: "sync", pane: "paneSvalSync" },
  { id: "appearance", pane: "paneAppearance" },
  { id: "search", pane: "paneSearch" },
  { id: "privacy", pane: "panePrivacy" },
  { id: "sites", pane: "paneSvalSites" },
  { id: "keyboard", pane: "paneSvalKeyboard" },
];

/**
 * The window a command that opens one of Sval's own pages or its sidebar
 * acts in from `win`. A Peek has no sidebar, and its new tab goes on
 * to a Peek of its own (`SvalPeek.startWindow`), so from one
 * these open in the user's ordinary window instead.
 *
 * @param {Window} win
 * @returns {Promise<Window>}
 */
async function ordinaryWindowFor(win) {
  return lazy.SvalPeek.isPeek(win) ? lazy.SvalPeek.ordinaryWindow() : win;
}

// ------------------------------------------------------------ the commands

/**
 * Every command, in the order the Commands section lists matches (launcher
 * spec §4). Each entry:
 *
 * - `id`, and `l10nId`/`synonymsL10nId`, its name and the other words it is
 *   found by, comma-separated, in `launcher.ftl`.
 * - `keyId`, the `<key>` that runs it too, or null.
 * - `available(win)`, whether it applies now; a command that does not is
 *   not listed, and picked from a stale list it does nothing.
 * - `run(win, choice, text, keys)`, which calls what already does it.
 *   `keys.shift` is whether the row was picked with Shift.
 * - `shiftWindow`, for a command listed once per workspace whose Shift opens
 *   that workspace in a new window, as Shift does in the workspace switcher.
 * - `choices(win, text)`, for a command that picks: `[{id, label, current,
 *   color}]`, `color` a workspace's colour token.
 * - `each(win)`, for a command listed once per item: `[{id, label}]`, run
 *   with the item as its choice.
 *
 * @type {object[]}
 */
export const COMMANDS = [
  // Workspaces.
  {
    id: "go-to-workspace",
    l10nId: "launcher-command-go-to-workspace",
    synonymsL10nId: "launcher-command-go-to-workspace-synonyms",
    keyId: null,
    available: win => !!userPanel(win),
    // The user's own workspaces other than this one; another window's comes
    // forward (`SvalWindowWorkspace.show`).
    each: win =>
      userPanel(win)
        .switcherList()
        .filter(item => !item.agent && !item.current)
        .map(item => ({
          id: item.id,
          label: win.SvalPanel.workspaceName(item),
        })),
    shiftWindow: true,
    run: (win, choice, _text, { shift }) =>
      win.SvalPanel.pickWorkspace(choice.id, shift),
  },
  {
    id: "new-workspace",
    l10nId: "launcher-command-new-workspace",
    synonymsL10nId: "launcher-command-new-workspace-synonyms",
    keyId: NEW_WORKSPACE_KEY,
    available: win => !!userPanel(win),
    run: win => win.SvalPanel.addWorkspace(),
  },
  {
    id: "rename-workspace",
    l10nId: "launcher-command-rename-workspace",
    synonymsL10nId: "launcher-command-rename-workspace-synonyms",
    keyId: null,
    available: win => !!userPanel(win) && !agentWorkspace(win),
    // Today's Edit workspace sheet (launcher spec §3).
    run: win => win.SvalPanel.edit({ id: lazy.SvalWindowWorkspace.of(win).id }),
  },
  {
    id: "move-tab",
    l10nId: "launcher-command-move-tab",
    synonymsL10nId: "launcher-command-move-tab-synonyms",
    keyId: null,
    chooseL10nId: "launcher-choose-workspace",
    headingL10nId: "launcher-section-workspaces",
    // Not in an agent's window, as Rename is not: the agent's tabs stay
    // where the agent works.
    available: win =>
      !!userPanel(win) && !agentWorkspace(win) && !!selectedNode(win),
    // The user's workspaces, this one shown but not offered, then a new one
    // named with what was typed (launcher design, "A command that picks").
    choices: win => [
      ...userPanel(win)
        .switcherList()
        .filter(item => !item.agent)
        .map(item => ({
          id: item.id,
          label: win.SvalPanel.workspaceName(item),
          current: item.current,
          color: item.color,
        })),
      { id: NEW_WORKSPACE, label: "", isNew: true },
    ],
    run: (win, choice, text) => {
      const id = selectedNode(win);
      return choice.isNew
        ? win.SvalPanel.moveToWorkspace(id, "", { name: text })
        : win.SvalPanel.moveToWorkspace(id, choice.id);
    },
  },

  // This tab.
  {
    id: "rename-tab",
    l10nId: "launcher-command-rename-tab",
    synonymsL10nId: "launcher-command-rename-tab-synonyms",
    keyId: null,
    // Not in an agent's window, as Move is not.
    available: win =>
      !!userPanel(win) && !agentWorkspace(win) && !!selectedNode(win),
    run: win => win.SvalPanel.renameTab(selectedNode(win)),
  },
  {
    id: "remove-tab-name",
    l10nId: "launcher-command-remove-tab-name",
    synonymsL10nId: "launcher-command-remove-tab-name-synonyms",
    keyId: null,
    available: win =>
      !!userPanel(win) &&
      !agentWorkspace(win) &&
      !!win.SvalPanel.nodes[selectedNode(win)]?.appearance?.label,
    run: win => win.SvalPanel.setTabLabel(selectedNode(win), null),
  },
  {
    id: "pin",
    l10nId: "launcher-command-pin",
    synonymsL10nId: "launcher-command-pin-synonyms",
    keyId: null,
    available: win => !!win.SvalPanel?.pins?.canPin(selectedNode(win)),
    run: win => win.SvalPanel.pins.pinTab(selectedNode(win)),
  },
  {
    id: "pinHere",
    l10nId: "launcher-command-pin-here",
    synonymsL10nId: "launcher-command-pin-here-synonyms",
    keyId: null,
    available: win => !!win.SvalPanel?.pins?.canPin(selectedNode(win)),
    run: win =>
      win.SvalPanel.pins.pinTab(selectedNode(win), { thisWorkspace: true }),
  },
  {
    id: "unpin",
    l10nId: "launcher-command-unpin",
    synonymsL10nId: "launcher-command-unpin-synonyms",
    keyId: null,
    available: win => !!win.SvalPanel?.pins?.selectedPin,
    run: win =>
      win.SvalPanel.pins.moveToFavoritesGuid(
        win.SvalPanel.pins.selectedPin.guid
      ),
  },
  {
    id: "add-favorite",
    l10nId: "launcher-command-add-favorite",
    synonymsL10nId: "launcher-command-add-favorite-synonyms",
    keyId: "addBookmarkAsKb",
    available: win => !lazy.PrivateBrowsingUtils.isWindowPrivate(win),
    run: win => lazy.SvalFavorites.addPage(win),
  },
  {
    id: "copy-address",
    l10nId: "launcher-command-copy-address",
    synonymsL10nId: "launcher-command-copy-address-synonyms",
    keyId: COPY_ADDRESS_KEY,
    available: win => !!win.gBrowser.currentURI?.spec,
    run: win => lazy.copyAddress(win),
  },
  {
    id: "copy-markdown-link",
    l10nId: "launcher-command-copy-markdown-link",
    synonymsL10nId: "launcher-command-copy-markdown-link-synonyms",
    keyId: null,
    available: win => !!win.gBrowser.currentURI?.spec,
    run: win => lazy.copyMarkdownLink(win.gBrowser.selectedTab),
  },
  {
    id: "unload-tab",
    l10nId: "launcher-command-unload-tab",
    synonymsL10nId: "launcher-command-unload-tab-synonyms",
    keyId: null,
    // A Peek's one tab is always selected, which unloading must
    // leave for another tab, and which Firefox's memory unloader never
    // takes (`TabUnloader`), so neither unloading nor keeping it applies.
    available: win =>
      !lazy.SvalPeek.isPeek(win) && lazy.canUnload(win.gBrowser.selectedTab),
    run: win => lazy.unloadTabs(win, [win.gBrowser.selectedTab]),
  },
  {
    id: "keep-tab-loaded",
    l10nId: "launcher-command-keep-tab-loaded",
    synonymsL10nId: "launcher-command-keep-tab-loaded-synonyms",
    keyId: null,
    available: win =>
      !lazy.SvalPeek.isPeek(win) &&
      !lazy.isKeptLoaded(win.gBrowser.selectedTab),
    run: win => lazy.setKeptLoaded(win.gBrowser.selectedTab, true),
  },
  {
    id: "let-tab-unload",
    l10nId: "launcher-command-let-tab-unload",
    synonymsL10nId: "launcher-command-let-tab-unload-synonyms",
    keyId: null,
    available: win =>
      !lazy.SvalPeek.isPeek(win) && lazy.isKeptLoaded(win.gBrowser.selectedTab),
    run: win => lazy.setKeptLoaded(win.gBrowser.selectedTab, false),
  },
  {
    id: "duplicate",
    l10nId: "launcher-command-duplicate",
    synonymsL10nId: "launcher-command-duplicate-synonyms",
    keyId: null,
    available: () => true,
    // The tab menu's Duplicate Tab (`context_duplicateTab`).
    run: win => win.duplicateTabIn(win.gBrowser.selectedTab, "tab"),
  },
  {
    id: "archive",
    l10nId: "launcher-command-archive",
    synonymsL10nId: "launcher-command-archive-synonyms",
    keyId: null,
    // What the sweep could archive (idle-tab archive spec §4.3): a tab at a
    // workspace's top level, or a pane of a split there, in the user's own
    // workspace. The engine refuses the rest.
    available: win => {
      const panel = userPanel(win);
      const id = selectedNode(win);
      if (
        !panel ||
        !id ||
        agentWorkspace(win) ||
        !lazy.SvalArchive.instance?.ready
      ) {
        return false;
      }
      const nodes = panel.nodes;
      const parent = nodes[id]?.placement?.parent;
      const holder = isPane(nodes, id)
        ? nodes[parent]?.placement?.parent
        : parent;
      return nodes[holder]?.kind === WORKSPACE;
    },
    run: win => lazy.SvalArchive.instance.archiveNow(selectedNode(win)),
  },
  {
    id: "reopen-tab",
    l10nId: "launcher-command-reopen-tab",
    synonymsL10nId: "launcher-command-reopen-tab-synonyms",
    // The key spec §3 calls Reopen closed tab.
    keyId: "key_restoreLastClosedTabOrWindowOrSession",
    available: () => lazy.SessionStore.getClosedTabCount() > 0,
    run: win => doCommand(win, "History:UndoCloseTab"),
  },
  {
    id: "mute",
    l10nId: "launcher-command-mute",
    synonymsL10nId: "launcher-command-mute-synonyms",
    keyId: "key_toggleMute",
    available: win => !win.gBrowser.selectedTab.muted,
    run: win => doCommand(win, "cmd_toggleMute"),
  },
  {
    id: "unmute",
    l10nId: "launcher-command-unmute",
    synonymsL10nId: "launcher-command-unmute-synonyms",
    keyId: "key_toggleMute",
    available: win => !!win.gBrowser.selectedTab.muted,
    run: win => doCommand(win, "cmd_toggleMute"),
  },
  {
    id: "reader-view",
    l10nId: "launcher-command-reader-view",
    synonymsL10nId: "launcher-command-reader-view-synonyms",
    keyId: "key_toggleReaderMode",
    // Where the reader view button shows (`AboutReaderParent`).
    available: win => {
      const browser = win.gBrowser.selectedBrowser;
      return (
        browser.isArticle || browser.currentURI.spec.startsWith("about:reader")
      );
    },
    run: win => doCommand(win, "View:ReaderView"),
  },

  // Split.
  {
    id: "split-with",
    l10nId: "launcher-command-split-with",
    synonymsL10nId: "launcher-command-split-with-synonyms",
    keyId: null,
    chooseL10nId: "launcher-choose-tab",
    headingL10nId: "launcher-section-tabs-to-split",
    available: win => !!userPanel(win) && !!selectedNode(win),
    // The tabs of this workspace a split can take beside this one, as an
    // Alt-click on a row makes it (`_splitBeside`).
    choices: win => {
      const panel = win.SvalPanel;
      const nodes = panel.nodes;
      const selected = selectedNode(win);
      const byParent = childrenByParent(nodes);
      const out = [];
      const walk = parent => {
        for (const id of byParent.get(parent) ?? []) {
          if (nodes[id]?.kind === TAB) {
            if (id !== selected && !isPane(nodes, id)) {
              out.push({
                id,
                label: displayName(nodes[id]) || nodes[id].content?.url || "",
              });
            }
          } else {
            walk(id);
          }
        }
      };
      walk(lazy.SvalWindowWorkspace.of(win).id);
      return out;
    },
    run: (win, choice) =>
      win.SvalPanel.splitBeside(selectedNode(win), choice.id),
  },
  {
    id: "close-split",
    l10nId: "launcher-command-close-split",
    synonymsL10nId: "launcher-command-close-split-synonyms",
    keyId: null,
    available: win => !!selectedSplit(win),
    run: win => win.SvalPanel.separate(selectedSplit(win)),
  },
  {
    id: "swap-panes",
    l10nId: "launcher-command-swap-panes",
    synonymsL10nId: "launcher-command-swap-panes-synonyms",
    keyId: null,
    // Firefox's Reverse swaps the first two panes only (split-view spec
    // §4.3).
    available: win => shownSplit(win)?.tabs.length === 2,
    run: win => doCommand(win, "splitViewCmd_reverseTabs"),
  },

  // Panel.
  {
    id: "toggle-panel",
    l10nId: "launcher-command-toggle-panel",
    synonymsL10nId: "launcher-command-toggle-panel-synonyms",
    keyId: PANEL_TOGGLE_KEY,
    available: win => !!win.SvalPanel,
    run: win => win.SvalPanel.toggleFromKey(),
  },

  // This site.
  {
    id: "site-privacy",
    l10nId: "launcher-command-site-privacy",
    synonymsL10nId: "launcher-command-site-privacy-synonyms",
    keyId: null,
    available: win =>
      !!lazy.SvalProtectionButton.forWindow(win) && !!lazy.stateOf(win),
    run: win => lazy.SvalProtectionButton.forWindow(win)?.open({ focus: true }),
  },
  {
    id: "site-settings",
    l10nId: "launcher-command-site-settings",
    synonymsL10nId: "launcher-command-site-settings-synonyms",
    keyId: null,
    // Where the menu opens (`SiteControls.openMenu`): a page with a site.
    available: win =>
      !!lazy.SvalSiteControls.forWindow(win) && !!lazy.mediaOf(win),
    run: win => lazy.SvalSiteControls.openMenu(win, { focus: true }),
  },
  {
    id: "style-site",
    l10nId: "launcher-command-style-site",
    synonymsL10nId: "launcher-command-style-site-synonyms",
    keyId: STYLE_KEY,
    // Where the editor opens: a page with a site, outside private windows.
    available: win =>
      !!lazy.SvalSiteControls.forWindow(win) &&
      lazy.SvalSiteStylePanel.offered(win),
    run: win => lazy.SvalSiteStylePanel.open(win, { focus: true }),
  },
  {
    id: "clear-site-data",
    l10nId: "launcher-command-clear-site-data",
    synonymsL10nId: "launcher-command-clear-site-data-synonyms",
    keyId: null,
    // Where the site menu offers it, and through its own confirmation.
    available: win =>
      !!lazy.SvalSiteControls.forWindow(win) && !!lazy.mediaOf(win),
    run: win =>
      lazy.SvalSiteControls.openMenu(win, { focus: true, confirmClear: true }),
  },
  {
    id: "block-javascript",
    l10nId: "launcher-command-block-javascript",
    synonymsL10nId: "launcher-command-javascript-synonyms",
    keyId: null,
    available: win => javascriptOf(win)?.on === true,
    run: win => setJavascript(win, false),
  },
  {
    id: "allow-javascript",
    l10nId: "launcher-command-allow-javascript",
    synonymsL10nId: "launcher-command-javascript-synonyms",
    keyId: null,
    available: win => javascriptOf(win)?.on === false,
    run: win => setJavascript(win, true),
  },

  // Agents. Give back is the bar's button (`AgentWindowMarking`), in an
  // agent's window the user has taken; while the agent holds the window,
  // its overlay keeps the user from the address bar, so there is no Take
  // control here.
  {
    id: "give-back",
    l10nId: "launcher-command-give-back",
    synonymsL10nId: "launcher-command-give-back-synonyms",
    keyId: null,
    available: win => {
      const id = agentWorkspace(win);
      return !!id && lazy.isWorkspaceHeld(id);
    },
    run: win => win.SvalPanel.agentMarking?.giveBack(),
  },
  {
    id: "agent-settings",
    l10nId: "launcher-command-agent-settings",
    synonymsL10nId: "launcher-command-agent-settings-synonyms",
    keyId: null,
    available: win => !!userPanel(win),
    run: win => win.openPreferences("paneSvalAgents"),
  },

  // Settings.
  ...SETTINGS_PANES.map(({ id, pane }) => ({
    id: `settings-${id}`,
    l10nId: `launcher-command-settings-${id}`,
    synonymsL10nId: "launcher-command-settings-synonyms",
    keyId: null,
    available: () => true,
    run: async win => (await ordinaryWindowFor(win)).openPreferences(pane),
  })),

  // Firefox's quick actions, less Firefox View, Themes, Labs and Help
  // (launcher spec §4).
  firefoxAction("downloads", "downloads", "key_openDownloads", {
    ordinary: true,
  }),
  firefoxAction("extensions", "extensions", "key_openAddons", {
    ordinary: true,
  }),
  firefoxAction("logins", "logins", null, { ordinary: true }),
  {
    id: "new-peek",
    l10nId: "launcher-command-new-peek",
    synonymsL10nId: "launcher-command-new-peek-synonyms",
    keyId: NEW_PEEK_KEY,
    available: () => true,
    run: win => lazy.SvalPeek.openEmpty(win),
  },
  firefoxAction("private-window", "private", "key_privatebrowsing"),
  firefoxAction("print", "print", "printKb"),
  firefoxAction("save-pdf", "savepdf"),
  firefoxAction("screenshot", "screenshot", "key_screenshot"),
  firefoxAction("translate", "translate"),
  firefoxAction("refresh", "refresh"),
  firefoxAction("clear-history", "clear", "key_sanitize"),
  firefoxAction("restart", "restart"),
  firefoxAction("inspect", "inspect", "key_inspector"),
  firefoxAction("view-source", "viewsource", "key_viewSource"),
  firefoxAction("color-picker", "colorpicker"),
  {
    id: "history",
    l10nId: "launcher-command-history",
    synonymsL10nId: "launcher-command-history-synonyms",
    keyId: "key_gotoHistory",
    available: () => true,
    // Sval's History sidebar, where the History menu's items go
    // (`SvalFavorites._replaceLibrary`).
    run: async win =>
      (await ordinaryWindowFor(win)).SidebarController.show(
        "viewHistorySidebar"
      ),
  },
];

const byId = new Map(COMMANDS.map(command => [command.id, command]));

/**
 * A command's key as it is now, which the user may have changed in
 * Settings › Keyboard (`CustomKeys` rewrites the `<key>`).
 *
 * @param {Window} win
 * @param {string|null} keyId
 * @returns {{shortcut: string, ariaShortcut: string}|null} null for a
 *   command with no key, or one the user cleared.
 */
export function keyFor(win, keyId) {
  const el = keyId && win.document.getElementById(keyId);
  if (!el || !(el.getAttribute("key") || el.getAttribute("keycode"))) {
    return null;
  }
  const key = keyOf(el);
  return { shortcut: shortcutText(key), ariaShortcut: ariaShortcut(key) };
}

// ------------------------------------------------------------ matching

/**
 * The words typed, without a restriction character, folded.
 *
 * @param {object} queryContext
 * @returns {string[]}
 */
function wordsOf(queryContext) {
  return (queryContext.tokens ?? [])
    .filter(t => !lazy.UrlbarTokenizer.isRestrictionToken(t))
    .flatMap(t => fold(t.value).split(/\s+/))
    .filter(Boolean);
}

/**
 * Whether every word typed starts a word of `texts`, as the address bar
 * matches history (`onBoundary`).
 *
 * @param {string[]} words Folded.
 * @param {string[]} texts
 * @returns {boolean}
 */
function matches(words, texts) {
  return words.every(word => texts.some(text => onBoundary(word, text)));
}

/**
 * Each command's name and synonyms, read for one query.
 *
 * @param {object[]} commands
 * @returns {Promise<Map<string, {name: string, synonyms: string}>>}
 */
async function wordingOf(commands) {
  // A command listed once per item is named per item, in `commandRows`.
  const ids = commands.flatMap(c =>
    c.each ? [c.synonymsL10nId] : [c.l10nId, c.synonymsL10nId]
  );
  const values = await lazy.l10n.formatValues(ids.map(id => ({ id })));
  const wording = new Map();
  let at = 0;
  for (const command of commands) {
    const name = command.each ? "" : values[at++];
    wording.set(command.id, { name, synonyms: values[at++] ?? "" });
  }
  return wording;
}

/**
 * The rows a query lists in the Commands section: every available command
 * whose name or synonyms match, in {@link COMMANDS}' order, up to the
 * section's limit.
 *
 * @param {Window} win
 * @param {string[]} words
 * @returns {Promise<object[]>} `[{command, title, choice}]`.
 */
async function commandRows(win, words) {
  if (!words.length) {
    return [];
  }
  await lazy.QuickActionsLoaderDefault.ensureLoaded();
  const live = COMMANDS.filter(command => command.available(win));
  const wording = await wordingOf(live);
  const rows = [];
  for (const command of live) {
    const { name, synonyms } = wording.get(command.id);
    if (command.each) {
      const items = command.each(win);
      const titles = await lazy.l10n.formatValues(
        items.map(item => ({ id: command.l10nId, args: { name: item.label } }))
      );
      items.forEach((item, i) => {
        if (matches(words, [titles[i], synonyms])) {
          rows.push({ command, title: titles[i], choice: item });
        }
      });
      continue;
    }
    if (matches(words, [name, synonyms])) {
      rows.push({ command, title: name, choice: null });
    }
  }
  return rows.slice(0, lazy.launcherLimit(lazy.LAUNCHER_PREFS.limitCommands));
}

/**
 * The rows of a command's choices that match what was typed, with a new
 * workspace last, named with it.
 *
 * @param {Window} win
 * @param {object} command
 * @param {string[]} words
 * @param {string} text What was typed, as typed.
 * @returns {Promise<object[]>} `[{command, title, choice}]`.
 */
async function choiceRows(win, command, words, text) {
  const rows = [];
  for (const choice of command.choices(win)) {
    if (choice.isNew) {
      const title = await lazy.l10n.formatValue(
        text
          ? "launcher-choice-new-workspace-named"
          : "launcher-choice-new-workspace",
        { name: text }
      );
      rows.push({ command, title, choice });
    } else if (matches(words, [choice.label])) {
      rows.push({ command, title: choice.label, choice });
    }
  }
  return rows;
}

// ------------------------------------------------------------ picking

/**
 * The command a field is picking for, by its input: the address bar's
 * `UrlbarInput`, with the chip and key handler {@link enter} gave it, or a
 * field that draws its own choices ({@link SvalLauncherCommands.choose}),
 * with the command alone.
 *
 * @type {WeakMap<object, {command: object, previous?: string,
 *   placeholder?: object, chip?: Element, onKey?: Function,
 *   onComposition?: Function, composing?: boolean}>}
 */
const picking = new WeakMap();

const COMPOSITION_EVENTS = ["compositionstart", "compositionend"];

/**
 * The command whose row Back selects again, by input, until the results
 * that hold it arrive.
 *
 * @type {WeakMap<object, string>}
 */
const reselect = new WeakMap();

/** The inputs whose controller this module listens to. */
const heard = new WeakSet();

/**
 * Listens to the address bar's view once per input: a closed view leaves
 * the choices, a choice list selects its first choice, and Back selects the
 * command it came from.
 *
 * @param {object} input The window's `UrlbarInput`.
 */
function hear(input) {
  if (heard.has(input)) {
    return;
  }
  heard.add(input);
  // The controller ends a query it cancels as it ends one that ran
  // (`UrlbarController.cancelQuery`), and the view keeps its rows.
  const cancelled = new WeakSet();
  input.controller.addListener({
    // A Back whose list never came leaves nothing to select in the next.
    onViewClose: () => {
      leave(input);
      reselect.delete(input);
    },
    onQueryCancelled: queryContext => cancelled.add(queryContext),
    // A new list of choices starts with none selected, as typing leaves the
    // address bar's own list with its row Enter takes.
    onQueryStarted: () => {
      if (picking.has(input) && input.view.isOpen) {
        input.view.clearSelection();
      }
    },
    // Once the view has dropped the rows of the query before, so its rows
    // are this query's results.
    onQueryFinished: queryContext => {
      const { view } = input;
      if (cancelled.has(queryContext) || !view.isOpen) {
        return;
      }
      const commandId = reselect.get(input);
      reselect.delete(input);
      if (picking.has(input)) {
        if (!view.selectedElement) {
          view.selectBy(1, { userPressedTab: true });
        }
        return;
      }
      const at = commandId
        ? queryContext.results.findIndex(
            r =>
              r.providerName === PROVIDER_NAME &&
              r.payload.commandId === commandId
          )
        : -1;
      if (at >= 0) {
        view.selectedRowIndex = at;
      }
    },
  });
}

/**
 * Shows a command's choices in the address bar: the field empties, the
 * command shows as a chip with a Back button at the field's start, and the
 * query lists only the choices.
 *
 * @param {object} input
 * @param {object} command
 * @param {string} title The command's name, as its row showed it.
 */
function enter(input, command, title) {
  hear(input);
  leave(input);
  const doc = input.document;
  const chip = doc.createElement("div");
  chip.id = "sval-launcher-chip";
  const back = doc.createElement("button");
  back.id = "sval-launcher-chip-back";
  back.tabIndex = -1;
  doc.l10n.setAttributes(back, "launcher-chip-back");
  // The field keeps the focus, so typing goes on filtering.
  back.addEventListener("mousedown", event => event.preventDefault());
  back.addEventListener("click", () => goBack(input));
  const label = doc.createElement("span");
  label.id = "sval-launcher-chip-label";
  label.textContent = title;
  chip.append(back, label);
  input.querySelector(".urlbar-input-box")?.before(chip);

  const onKey = event => {
    // A key pressed while an input method composes text belongs to the
    // composition: Enter confirms the text, Escape and Backspace edit it.
    // UI Events marks such a keydown with `isComposing` or keyCode 229.
    if (event.isComposing || event.keyCode === 229) {
      return;
    }
    const { view } = input;
    if (event.key === "Backspace" && !input.value) {
      goBack(input);
    } else if (event.key === "Escape") {
      // A step back to the first list; Escape there closes (launcher spec
      // §4).
      goBack(input);
    } else if (
      (event.key === "ArrowDown" || event.key === "ArrowUp") &&
      view.isOpen &&
      !event.altKey
    ) {
      // By element, as Tab moves, so the arrows pass over the workspace the
      // tab is in, which cannot be chosen: by row, as the arrows move
      // (`UrlbarView.selectBy`), a row with nothing to select clears the
      // selection and the next arrow lands on it again.
      input.controller.userSelectionBehavior = "arrow";
      view.selectBy(1, {
        reverse: event.key === "ArrowUp",
        userPressedTab: true,
      });
    } else if (event.key === "Enter") {
      // The choices have no row Enter takes by itself, and a row selected
      // before the list for the text typed came in has the address bar
      // search for the text (`UrlbarInput.handleNavigation`). Enter picks
      // once the list is in: the row selected then, or the first choice.
      input.lastQueryContextPromise
        .then(() => {
          if (picking.has(input) && view.isOpen) {
            if (!view.selectedElement) {
              view.selectBy(1, { userPressedTab: true });
            }
            if (view.selectedElement) {
              input.pickElement(view.selectedElement, event);
            }
          }
        })
        .catch(err =>
          lazy.SvalLog.error(
            `picking a choice failed: ${lazy.describeError(err)}`
          )
        );
    } else {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  input.inputField.addEventListener("keydown", onKey, true);

  // `UrlbarInput._on_compositionstart` closes the view, which would end the
  // choices, and `_on_input` runs no query until the composition ends. Kept
  // from it, the composing text is typing to the address bar, so the choices
  // stay open and filter as it changes; an input method's own picker can
  // cover them, as `keepPanelOpenDuringImeComposition` allows for the whole
  // address bar.
  const onComposition = event => {
    const state = picking.get(input);
    if (state) {
      state.composing = event.type === "compositionstart";
    }
    event.stopImmediatePropagation();
  };
  for (const type of COMPOSITION_EVENTS) {
    input.inputField.addEventListener(type, onComposition, true);
  }

  picking.set(input, {
    command,
    previous: input.value,
    placeholder: doc.l10n.getAttributes(input.inputField),
    chip,
    onKey,
    onComposition,
    composing: false,
  });
  doc.l10n.setAttributes(input.inputField, command.chooseL10nId);
  input.value = "";
  input.startQuery({ allowAutofill: false });
}

/**
 * Leaves a command's choices, if the address bar shows them.
 *
 * @param {object} input
 * @returns {object|null} What was left.
 */
function leave(input) {
  const state = picking.get(input);
  if (!state) {
    return null;
  }
  picking.delete(input);
  state.chip.remove();
  input.inputField.removeEventListener("keydown", state.onKey, true);
  for (const type of COMPOSITION_EVENTS) {
    input.inputField.removeEventListener(type, state.onComposition, true);
  }
  if (state.composing) {
    // The address bar never saw this composition start, and its
    // `_on_compositionend` throws on an end without one.
    input.inputField.addEventListener(
      "compositionend",
      event => event.stopImmediatePropagation(),
      { capture: true, once: true }
    );
  }
  const { id, args } = state.placeholder;
  if (id) {
    input.document.l10n.setAttributes(input.inputField, id, args);
  }
  return state;
}

/**
 * Back: the first list again, with the query typed before and the command's
 * row selected.
 *
 * @param {object} input
 */
function goBack(input) {
  const state = leave(input);
  if (state) {
    reselect.set(input, state.command.id);
    input.search(state.previous);
  }
}

// ------------------------------------------------------------ rows

/**
 * A row for a command or a choice.
 *
 * @param {object} queryContext
 * @param {object} row From {@link commandRows} or {@link choiceRows}.
 * @param {object} options
 * @param {Window} options.win
 * @param {boolean} options.inChoices
 * @returns {UrlbarResult}
 */
function resultFor(queryContext, row, { win, inChoices }) {
  const { command, title, choice } = row;
  const key = inChoices ? null : keyFor(win, command.keyId);
  const tokens = (queryContext.tokens ?? []).filter(
    t => !lazy.UrlbarTokenizer.isRestrictionToken(t)
  );
  return new lazy.UrlbarResult({
    type: UrlbarUtils.RESULT_TYPE.DYNAMIC,
    source: UrlbarUtils.RESULT_SOURCE.OTHER_LOCAL,
    group: COMMANDS_GROUP,
    rowLabel: {
      id: inChoices ? command.headingL10nId : "launcher-section-commands",
    },
    payload: {
      dynamicType: DYNAMIC_TYPE,
      commandId: command.id,
      choiceId: choice?.id ?? null,
      choiceText: choice?.isNew ? queryContext.searchString.trim() : null,
      inChoices,
      picks: !inChoices && !!command.choices,
      current: !!choice?.current,
      isNew: !!choice?.isNew,
      // A workspace's colour, its swatch's (`SvalLauncherRows`).
      color: choice?.color ?? null,
      title,
      highlights: UrlbarUtils.getTokenMatches(
        tokens,
        title,
        UrlbarUtils.HIGHLIGHT.TYPED
      ),
      shortcut: key?.shortcut ?? null,
      ariaShortcut: key?.ariaShortcut ?? null,
      shiftWindow: !!command.shiftWindow && !!choice,
      // What the field keeps while the row is selected (`UrlbarInput`'s
      // value for a dynamic result).
      input: queryContext.searchString,
    },
  });
}

/** The commands and choices that match a query, in the Commands section. */
export class SvalLauncherCommandsProvider extends UrlbarProvider {
  /** @type {WeakMap<object, object[]>} rows by query context. */
  #rows = new WeakMap();

  get name() {
    return PROVIDER_NAME;
  }

  get type() {
    return UrlbarUtils.PROVIDER_TYPE.PROFILE;
  }

  async isActive(queryContext, controller) {
    const win = controller?.browserWindow;
    const input = controller?.input;
    if (!win || queryContext.sapName !== "urlbar" || queryContext.searchMode) {
      return false;
    }
    const words = wordsOf(queryContext);
    const state = input && picking.get(input);
    const rows = state
      ? await choiceRows(
          win,
          state.command,
          words,
          queryContext.searchString.trim()
        )
      : await commandRows(win, words);
    this.#rows.set(
      queryContext,
      rows.map(row => resultFor(queryContext, row, { win, inChoices: !!state }))
    );
    return !!rows.length;
  }

  async startQuery(queryContext, addCallback) {
    for (const result of this.#rows.get(queryContext) ?? []) {
      addCallback(this, result);
    }
  }

  getViewTemplate(result) {
    const disabled = result.payload.current;
    return {
      name: "inner",
      attributes: {
        selectable: !disabled,
        ...(result.payload.isNew ? { "sval-new": "" } : {}),
      },
      children: [
        {
          name: "icon",
          tag: "img",
          classList: ["urlbarView-favicon"],
          attributes: { alt: "", "aria-hidden": "true" },
        },
        { name: "title", tag: "span", classList: ["urlbarView-title"] },
        { name: "tag", tag: "span", attributes: { hidden: !disabled } },
        {
          name: "shortcut",
          tag: "span",
          attributes: {
            "aria-hidden": "true",
            hidden: !result.payload.shortcut,
          },
        },
      ],
    };
  }

  getViewUpdate(result) {
    const { payload } = result;
    return {
      // The view takes `role="option"` from a row that cannot be selected
      // (`#setRowSelectable`); the current workspace stays an option, one a
      // screen reader hears as unavailable.
      inner: {
        attributes: {
          role: "option",
          "aria-disabled": payload.current ? "true" : null,
          "aria-keyshortcuts": payload.ariaShortcut,
        },
      },
      title: { textContent: payload.title, highlights: payload.highlights },
      tag: payload.current ? { l10n: { id: "launcher-choice-current" } } : null,
      shortcut: payload.shortcut ? { textContent: payload.shortcut } : null,
    };
  }

  onEngagement(queryContext, controller, details) {
    const { payload } = details.result;
    SvalLauncherCommands.run(controller.browserWindow, payload, {
      shift: !!details.event?.shiftKey,
    }).catch(err =>
      lazy.SvalLog.error(`a command failed: ${lazy.describeError(err)}`)
    );
  }
}

/** The provider of the command rows, as a result's `providerName`. */
export const COMMANDS_PROVIDER = PROVIDER_NAME;

export const SvalLauncherCommands = {
  /**
   * The providers a query of `input` is limited to: this one while the
   * field shows a command's choices, every one otherwise.
   *
   * @param {object} input A `UrlbarInput`, or the input of a field that
   *   draws its own rows.
   * @returns {string[]|null}
   */
  providersFor(input) {
    return picking.has(input) ? [PROVIDER_NAME] : null;
  },

  /**
   * Picks a row of a command that picks, which keeps the address bar open
   * on its choices, before `UrlbarInput.pickResult` closes the view. Every
   * other row of this provider is picked as a dynamic result is, and runs
   * from {@link SvalLauncherCommandsProvider#onEngagement}.
   *
   * @param {object} input A `UrlbarInput`.
   * @param {UrlbarResult} result
   * @returns {boolean} Whether the pick was handled here.
   */
  pickInPlace(input, result) {
    const { payload } = result;
    if (result.providerName !== PROVIDER_NAME || !payload.picks) {
      return false;
    }
    const command = byId.get(payload.commandId);
    if (!command?.available(input.window)) {
      input.view.close();
      input.handleRevert();
      return true;
    }
    enter(input, command, payload.title);
    return true;
  },

  /**
   * Lists the choices of a command that picks in a field that draws its own
   * rows, as the home page's field does (`SvalHomeSearchParent`): until
   * {@link SvalLauncherCommands.stopChoosing}, the queries of its input ask
   * only this provider, which answers with the choices. The field shows the
   * chip and steps back itself.
   *
   * @param {object} input The input of the field's `UrlbarController`.
   * @param {UrlbarResult} result The row picked.
   * @returns {object|null} The command, or null for a row of no command
   *   that picks, or of one that no longer applies.
   */
  choose(input, result) {
    const { payload } = result;
    if (result.providerName !== PROVIDER_NAME || !payload.picks) {
      return null;
    }
    const command = byId.get(payload.commandId);
    if (!command?.available(input.window)) {
      return null;
    }
    picking.set(input, { command });
    return command;
  },

  /**
   * Ends {@link SvalLauncherCommands.choose}'s choices.
   *
   * @param {object} input
   */
  stopChoosing(input) {
    picking.delete(input);
  },

  /**
   * Runs the command a row carries, if it still applies, with the choice it
   * carries, if that is still one.
   *
   * @param {Window} win
   * @param {object} payload A row's payload.
   * @param {object} [keys]
   * @param {boolean} [keys.shift] Whether the row was picked with Shift.
   * @returns {Promise<void>}
   */
  async run(win, payload, { shift = false } = {}) {
    const command = byId.get(payload.commandId);
    if (!command?.available(win)) {
      return;
    }
    let choice = null;
    if (payload.choiceId) {
      const offered = (command.choices ?? command.each)(win);
      choice = offered.find(c => c.id === payload.choiceId && !c.current);
      if (!choice) {
        return;
      }
    }
    await command.run(win, choice, payload.choiceText ?? "", { shift });
  },

  /** Registers the provider, once for the process. */
  register() {
    const manager = lazy.ProvidersManager.getInstanceForSap("urlbar");
    if (!manager.getProvider(PROVIDER_NAME)) {
      manager.registerProvider(new SvalLauncherCommandsProvider());
    }
  },
};
