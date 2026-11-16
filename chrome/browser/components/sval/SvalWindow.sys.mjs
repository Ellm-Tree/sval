/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Puts the workspace panel into every browser window, from Sval's own files.
 *
 * Firefox calls the window category hooks `sval.manifest` registers: one before
 * the window's first layout, which mounts the panel's container, stylesheet and
 * script, and one at the end of delayed startup, which starts it. Mounting
 * this way costs no patch against `browser.xhtml`, `browser-box.inc.xhtml` or
 * `browser-init.js`, three of the files Mozilla changes most.
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { PrivateBrowsingUtils } from "resource://gre/modules/PrivateBrowsingUtils.sys.mjs";
import { SvalEmailMenu } from "moz-src:///browser/components/sval/SvalEmailMenu.sys.mjs";
import { SvalFavorites } from "moz-src:///browser/components/sval/SvalFavorites.sys.mjs";
import { SvalFeedbackForm } from "moz-src:///browser/components/sval/SvalFeedbackForm.sys.mjs";
import { SvalFirefox } from "moz-src:///browser/components/sval/SvalFirefox.sys.mjs";
import { SvalHeader } from "moz-src:///browser/components/sval/SvalHeader.sys.mjs";
import { SvalHistorySidebar } from "moz-src:///browser/components/sval/SvalHistorySidebar.sys.mjs";
import { SvalLauncher } from "moz-src:///browser/components/sval/SvalLauncher.sys.mjs";
import { LAUNCHER_FTL } from "moz-src:///browser/components/sval/SvalLauncherTabs.sys.mjs";
import { SvalPanelReveal } from "moz-src:///browser/components/sval/SvalPanelReveal.sys.mjs";
import { SvalQuickPeek } from "moz-src:///browser/components/sval/SvalQuickPeek.sys.mjs";
import { SvalRestore } from "moz-src:///browser/components/sval/SvalRestore.sys.mjs";
import { SvalPeek } from "moz-src:///browser/components/sval/SvalPeek.sys.mjs";
import { SvalShortcuts } from "moz-src:///browser/components/sval/SvalShortcuts.sys.mjs";
import { SvalMenuBar } from "moz-src:///browser/components/sval/SvalMenuBar.sys.mjs";
import { SvalTabs } from "moz-src:///browser/components/sval/SvalTabs.sys.mjs";
import { SvalTabSwitcher } from "moz-src:///browser/components/sval/SvalTabSwitcher.sys.mjs";
import { SvalTabHoverPreview } from "moz-src:///browser/components/sval/SvalTabHoverPreview.sys.mjs";
import { SPLIT_MAX_PANES } from "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs";

const PANEL_CSS = "chrome://browser/content/sval/sval-panel.css";
/**
 * The panel's scripts. `sval-panel.js` declares `SvalPanel`, and each of the
 * others adds the methods of one part of the panel to it, so it comes first.
 */
const PANEL_SCRIPTS = [
  "chrome://browser/content/sval/sval-panel.js",
  "chrome://browser/content/sval/sval-panel-drag.js",
  "chrome://browser/content/sval/sval-panel-input.js",
  "chrome://browser/content/sval/sval-panel-menus.js",
  "chrome://browser/content/sval/sval-panel-rows.js",
  "chrome://browser/content/sval/sval-panel-refresh.js",
  "chrome://browser/content/sval/sval-panel-switcher.js",
  "chrome://browser/content/sval/sval-panel-strip.js",
  "chrome://browser/content/sval/sval-panel-appearance.js",
  "chrome://browser/content/sval/sval-panel-workspace.js",
  "chrome://browser/content/sval/sval-panel-selection.js",
  "chrome://browser/content/sval/sval-panel-edits.js",
  "chrome://browser/content/sval/sval-panel-splits.js",
  "chrome://browser/content/sval/sval-panel-start.js",
  "chrome://browser/content/sval/sval-panel-first-run.js",
  "chrome://browser/content/sval/sval-panel-layout.js",
  "chrome://browser/content/sval/sval-panel-sync.js",
  "chrome://browser/content/sval/sval-panel-folder.js",
  "chrome://browser/content/sval/sval-panel-pages.js",
  "chrome://browser/content/sval/sval-panel-undo.js",
];
const NOTIFICATION_BAR_CSS =
  "chrome://browser/content/sval/notification-bar.css";

const BOOKMARKS_TOOLBAR_PREF = "browser.toolbars.bookmarks.visibility";

/**
 * Firefox's bookmarks toolbar has no place in Sval: Favorites are reached
 * from the panel, under the workspace (import spec §6), and a second, global
 * row above the page would show the same links twice. Its pref is locked to
 * "never". The toolbar context menu and View › Toolbars list every toolbar
 * carrying `toolbarname` (`ToolbarContextMenu.onViewToolbarsPopupShowing`),
 * so taking that attribute away takes it out of both, and its keyboard
 * shortcut is disabled. Its entries in the bookmarks button's menu and the app
 * menu are hidden in `sval-panel.css`, because the app menu's is cloned from a
 * template later than this runs.
 *
 * @param {Document} doc A browser window's document.
 */
function removeBookmarksToolbar(doc) {
  // Set here, outside the branding directory: every branding file is part of
  // the Gecko key, and changing the key means compiling Gecko again.
  Services.prefs
    .getDefaultBranch("")
    .setCharPref(BOOKMARKS_TOOLBAR_PREF, "never");
  Services.prefs.lockPref(BOOKMARKS_TOOLBAR_PREF);
  doc.getElementById("PersonalToolbar")?.removeAttribute("toolbarname");
  doc
    .getElementById("viewBookmarksToolbarKb")
    ?.setAttribute("disabled", "true");
}

/**
 * Sval's default for Firefox's add-split shortcut, `key_addTabSplitView`,
 * which Firefox ships with no key: Control+Plus on macOS, Control+Shift+Plus
 * on Windows and Linux (split-view spec §8). Set before the window's first
 * layout, so it is on the element before `CustomKeys` saves the element's own
 * key as its default at the window's load, and Settings' Keyboard shortcuts
 * pane shows the platform's key as the default and resets to it
 * (`CustomKeys:GetDefaultKey`). Gecko reads a keyset's keys at its first key
 * event (`XULKeySetGlobalKeyListener::EnsureHandlers`), which comes later.
 *
 * On macOS the key matches Plus with Shift ignored
 * (`WidgetKeyboardEvent::GetShortcutKeyCandidates`), as `key_fullZoomEnlarge`
 * does for Command+Plus, so it is Control+Shift+= on a US layout and Control
 * with the Plus key on a German or Spanish one, which type Plus unshifted.
 * Zoom is Command there, and no other `<key>` in the window takes
 * Control+Plus.
 *
 * On Windows and Linux, Control+Plus is zoom. Plus is what the = key types
 * with Shift, so the press matches this key exactly and before
 * `key_fullZoomEnlarge`, which matches it only with Shift ignored; Control+=
 * and the keypad's + still zoom.
 *
 * @param {Document} doc A browser window's document.
 */
function bindSplitViewKey(doc) {
  const key = doc.getElementById("key_addTabSplitView");
  key?.setAttribute("key", "+");
  key?.setAttribute(
    "modifiers",
    AppConstants.platform === "macosx" ? "control" : "control,shift"
  );
}

/**
 * Sval's default for Firefox's private-window shortcut: Accel+Shift+N, the
 * key Chrome and Safari use (launcher spec §3). The key it takes is Reopen
 * Closed Window's, `key_undoCloseWindow`, which is cleared; Accel+Shift+T
 * still reopens a closed window, because
 * `key_restoreLastClosedTabOrWindowOrSession` reopens whichever closed last.
 * Accel+Shift+P stays a private-window key through a key of Sval's own,
 * because `key_privatebrowsing` holds one key.
 *
 * Set before the window's first layout, like {@link bindSplitViewKey}, so the
 * elements carry the keys before `CustomKeys` saves them as the defaults.
 * Both elements lose `data-l10n-id`, as `CustomKeys` removes it from a key it
 * changes: Fluent would otherwise set `key` back to Firefox's letter.
 *
 * @param {Document} doc A browser window's document.
 */
function bindPrivateWindowKey(doc) {
  const key = doc.getElementById("key_privatebrowsing");
  key?.removeAttribute("data-l10n-id");
  key?.setAttribute("key", "N");
  key?.setAttribute("modifiers", "accel,shift");
  const reopen = doc.getElementById("key_undoCloseWindow");
  reopen?.removeAttribute("data-l10n-id");
  reopen?.removeAttribute("key");

  // Firefox removes `key_privatebrowsing` where private browsing is off
  // (`gBrowserInit.onLoad`), and Accel+Shift+P goes with it.
  if (!PrivateBrowsingUtils.enabled) {
    return;
  }
  const alsoP = doc.createXULElement("key");
  alsoP.id = "sval-key-private-window-p";
  alsoP.setAttribute("command", "Tools:PrivateBrowsing");
  alsoP.setAttribute("key", "P");
  alsoP.setAttribute("modifiers", "accel,shift");
  alsoP.setAttribute("reserved", "true");
  const keyset = doc.createXULElement("keyset");
  keyset.append(alsoP);
  doc.getElementById("mainKeyset")?.after(keyset);
}

/**
 * Makes the new-window command, Accel+N and File > New Window, open the new
 * window on the next workspace down from this window's (launcher spec §3).
 * Firefox's command opens a window and leaves it to take the first workspace
 * no window shows (`SvalPanel._adoptOrCreateWorkspace`), so the command is
 * answered here, on the command element, before `mainCommandSet`'s listener.
 * A window with no panel, a Peek, keeps Firefox's. Sval turns the AI
 * window off (`browser_sval_no_ai.js`), so Firefox's branch for it never runs.
 *
 * @param {Document} doc A browser window's document.
 */
function openNewWindowOnNextWorkspace(doc) {
  const win = doc.defaultView;
  doc.getElementById("cmd_newNavigator")?.addEventListener("command", event => {
    if (!win.SvalPanel) {
      return;
    }
    event.stopImmediatePropagation();
    win.SvalPanel.openWindowOnNextWorkspace();
  });
}

/**
 * Makes the add-split command, the shortcut's, add a pane to a split the
 * selected tab is already in, as long as the split has room: a pane showing
 * the picker, as the command opens beside a tab in no split (split-view spec
 * §6.3). Firefox's command does nothing for a tab in a split
 * (`BrowserCommands.addTabSplitView`), so a tab in one is answered here, on
 * the command element, before `mainCommandSet`'s listener; a full split is
 * left as it is.
 *
 * @param {Document} doc A browser window's document.
 */
function addPaneToSplitOnCommand(doc) {
  const win = doc.defaultView;
  doc
    .getElementById("Browser:AddTabSplitView")
    ?.addEventListener("command", event => {
      const split = win.gBrowser.selectedTab?.splitview;
      if (!split) {
        return;
      }
      event.stopImmediatePropagation();
      if (split.tabs.length < SPLIT_MAX_PANES) {
        SvalFirefox.addPickerPane(win);
      }
    });
}

/**
 * Fits Firefox's split-view menu, which the address bar's split button and
 * each pane's footer open, to splits of more than two: Close reads "Close
 * Both Tabs" for two and "Close All Tabs" for more, and from a footer it
 * closes that pane alone, leaving the others split (split-view spec §6.4).
 * Firefox's own Close closes the whole split
 * (`MozTabSplitViewWrapper.close`), so the footer's is Sval's.
 *
 * @param {Document} doc A browser window's document.
 */
function fitSplitViewMenu(doc) {
  const menu = doc.getElementById("split-view-menu");
  const closeAll = menu?.querySelector('[command="splitViewCmd_closeTabs"]');
  if (!closeAll) {
    return;
  }
  const closeOne = doc.createXULElement("menuitem");
  closeOne.id = "sval-split-view-close-tab";
  doc.l10n.setAttributes(closeOne, "split-view-menuitem-close-tab");
  closeAll.after(closeOne);

  const win = doc.defaultView;
  // The pane whose footer opened the menu, or null for the address bar's
  // button, as the menu shows.
  let pane = null;
  menu.addEventListener("popupshowing", event => {
    if (event.target !== menu) {
      return;
    }
    const { anchorNode } = menu;
    const split = win.gBrowser.activeSplitView;
    pane = anchorNode?.closest("split-view-footer")
      ? (split?.tabs.find(tab =>
          doc.getElementById(tab.linkedPanel)?.contains(anchorNode)
        ) ?? null)
      : null;
    closeAll.hidden = !!pane;
    closeOne.hidden = !pane;
    doc.l10n.setAttributes(
      closeAll,
      (split?.tabs.length ?? 0) > 2
        ? "split-view-menuitem-close-all-tabs"
        : "split-view-menuitem-close-both-tabs"
    );
  });
  closeOne.addEventListener("command", () => {
    if (pane && !pane.closing) {
      win.gBrowser.removeTab(pane);
    }
  });
}

/**
 * Puts the window's notification bars across the web view pane, under the
 * header and right of the panel, with Sval's stylesheet. Firefox keeps both
 * its boxes in `#notifications-toolbar`: the tab box's deck
 * (`gBrowser.getTabNotificationDeck`) and the window's (`gNotificationBox`,
 * prepended). Both find the toolbar by id, so moving it into the tab box,
 * above the panels, moves every bar and changes nothing that shows one.
 *
 * @param {Window} win A browser window.
 */
function mountNotificationBars(win) {
  win.windowUtils.loadSheetUsingURIString(
    NOTIFICATION_BAR_CSS,
    win.windowUtils.AUTHOR_SHEET
  );
  const doc = win.document;
  const toolbar = doc.getElementById("notifications-toolbar");
  doc.getElementById("tabbrowser-tabbox")?.prepend(toolbar);
}

/**
 * Puts the workspace panel in the window's F6 cycle, which Gecko moves
 * between documents (`nsFocusManager`, `MOVEFOCUS_FORWARDDOC`): the panel is
 * part of the chrome document, whose stop is only the address bar
 * (`retargetdocumentfocus`). The panel's stop comes after the address bar's:
 * F6 from the chrome document goes to the tree, at the row its roving
 * `tabindex` keeps, and on from there as from the address bar. Shift+F6 runs
 * the other way: from the page to the tree, and from the tree to the address
 * bar. A hidden panel is no stop.
 *
 * @param {Window} win A browser window.
 */
function addPanelToF6(win) {
  const doc = win.document;
  win.addEventListener(
    "keydown",
    event => {
      if (
        event.key !== "F6" ||
        event.defaultPrevented ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey
      ) {
        return;
      }
      const panel = doc.getElementById("sval-panel-container");
      const row = panel?.querySelector('[role="tree"] [tabindex="0"]');
      if (!row?.checkVisibility({ visibilityProperty: true })) {
        return;
      }
      const focused = doc.activeElement;
      const inPanel = panel.contains(focused);
      // Focus in a page or a sidebar is on its `<browser>` here.
      const inChrome =
        !inPanel &&
        focused &&
        focused !== doc.documentElement &&
        focused.localName !== "browser";
      if (event.shiftKey && focused === win.gBrowser.selectedBrowser) {
        Services.focus.setFocus(row, Services.focus.FLAG_BYKEY);
      } else if (event.shiftKey && inPanel) {
        const urlbar = doc.getElementById(
          doc.documentElement.getAttribute("retargetdocumentfocus")
        );
        if (!urlbar) {
          return;
        }
        Services.focus.setFocus(urlbar, Services.focus.FLAG_BYKEY);
      } else if (!event.shiftKey && inChrome) {
        Services.focus.setFocus(row, Services.focus.FLAG_BYKEY);
      } else {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    },
    true
  );
}

export const SvalWindow = {
  /**
   * `browser-window-before-initial-xul-layout`: loads the panel's stylesheet,
   * adds its container as the first child of `#browser`, beside Firefox's own
   * sidebar, and loads its script into the window. Before the first layout, so
   * the window never draws without the panel's space.
   *
   * The stylesheet is an additional author sheet. Gecko loads one
   * synchronously (`Document::LoadAdditionalStyleSheet`), where a `<link>`
   * added at this point loads asynchronously in a session's first window, and
   * orders it after the document's own sheets
   * (`Document::FillStyleSetDocumentSheets`), so Sval's rules win the ties
   * they would as the last sheet in `<head>`.
   *
   * A Peek (`SvalPeek`) belongs to no workspace, so it gets
   * no panel and no tab watching, and nothing it shows reaches the tree. It
   * keeps the header, the notification bars and the window's keys.
   *
   * @param {Window} win A browser window.
   */
  mount(win) {
    const doc = win.document;
    win.windowUtils.loadSheetUsingURIString(
      PANEL_CSS,
      win.windowUtils.AUTHOR_SHEET
    );

    const quick = SvalPeek.isOpening(win);
    if (quick) {
      SvalPeek.mount(win);
    } else {
      // Before the window's first tab exists, so every tab opened after it is
      // told from the one it was created with.
      SvalRestore.watchWindow(win);

      // Before the session store can have put a tab in the window, so a tab
      // closed before the window's observer attaches still loses its node.
      SvalTabs.watchWindow(win);

      const container = doc.createXULElement("vbox");
      container.id = "sval-panel-container";
      doc.getElementById("browser").prepend(container);

      for (const url of PANEL_SCRIPTS) {
        Services.scriptloader.loadSubScript(url, win);
      }
      SvalTabHoverPreview.mount(win);
    }
    mountNotificationBars(win);

    removeBookmarksToolbar(doc);
    bindSplitViewKey(doc);
    bindPrivateWindowKey(doc);
    openNewWindowOnNextWorkspace(doc);
    addPaneToSplitOnCommand(doc);
    fitSplitViewMenu(doc);
    SvalFavorites.mount(win);
    SvalQuickPeek.mountLinkItem(win);
    SvalEmailMenu.mount(win);
    // The address bar's view words Sval's rows from the window's own
    // localization (`UrlbarView`'s `L10nCache` on `document.l10n`).
    win.MozXULElement.insertFTLIfNeeded(LAUNCHER_FTL);
    SvalHistorySidebar.mount(win);
    SvalHeader.mount(win);
    SvalLauncher.mount(win);
    SvalTabSwitcher.mount(win);
    SvalShortcuts.startWindow(win);
    SvalFeedbackForm.mountWindow(win);
    if (!quick) {
      SvalMenuBar.mount(win);
      addPanelToF6(win);
      SvalPanelReveal.mount(win);
    }
  },

  /**
   * `browser-window-load`: what a Peek does once the session store
   * tracks it.
   *
   * @param {Window} win A browser window.
   */
  load(win) {
    if (SvalPeek.isPeek(win)) {
      SvalPeek.loadWindow(win);
    }
  },

  /**
   * `browser-window-delayed-startup`: starts the panel, or a Peek's
   * own parts, once the window's delayed startup has finished, the point
   * every module it reaches for has initialised by.
   *
   * @param {Window} win A browser window.
   */
  delayedStartup(win) {
    const started = subject => {
      if (subject !== win) {
        return;
      }
      Services.obs.removeObserver(started, "browser-delayed-startup-finished");
      if (SvalPeek.isPeek(win)) {
        SvalPeek.startWindow(win);
      } else {
        win.SvalPanel.init();
      }
      SvalHeader.startWindow(win);
    };
    Services.obs.addObserver(started, "browser-delayed-startup-finished");
  },
};
