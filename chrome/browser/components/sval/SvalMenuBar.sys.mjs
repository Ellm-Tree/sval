/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The menu bar's Workspaces, Favorites and Tab menus, which
 * `sval-menu-bar.patch` declares hidden. A window with the panel shows and
 * fills them. What an entry lists and runs is the panel's: the switcher's
 * workspaces and commands, the Favorites menu's view, and the row menu's
 * entries for the selected tab, so no entry is a second implementation of
 * the action it names.
 *
 * Entries take the `hidden` attribute, because macOS draws the menu bar
 * natively and reads only that (`nsMenuUtilsX::NodeIsHiddenOrCollapsed`).
 * The Favorites menu here has no context menu: `SvalFavoritesMenu` keeps one
 * per window, on the panel's Favorites menu, and a native menu bar shows
 * none.
 */

import {
  COPY_ADDRESS_KEY,
  COPY_ADDRESS_MENU_ITEM_ID,
  MODE_KEYS,
  MODE_NAMES,
  NEW_WORKSPACE_KEY,
  PANEL_MENU_ITEM_ID,
  PANEL_TOGGLE_KEY,
  STYLE_KEY,
  newWorkspace,
} from "moz-src:///browser/components/sval/SvalShortcuts.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  FAVORITES_ROOT:
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  copyAddress: "moz-src:///browser/components/sval/SvalTabActions.sys.mjs",
  ScreenshotsUtils:
    "moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs",
  SvalFavorites: "moz-src:///browser/components/sval/SvalFavorites.sys.mjs",
  SvalFavoritesView:
    "moz-src:///browser/components/sval/SvalFavoritesView.sys.mjs",
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  SvalSiteControls:
    "moz-src:///browser/components/sval/SvalSiteControls.sys.mjs",
  SvalSiteStylePanel:
    "moz-src:///browser/components/sval/SvalSiteStylePanel.sys.mjs",
  userPanel: "moz-src:///browser/components/sval/SvalLauncherCommands.sys.mjs",
});

export const WORKSPACES_MENU_ID = "sval-workspaces-menu";
const FAVORITES_MENU_ID = "sval-favorites-menubar";
const TAB_MENU_ID = "sval-tab-menu";

/** The Workspaces menu's New Workspace item. */
export const NEW_WORKSPACE_MENU_ITEM_ID = "sval-menu-new-workspace";

/** The Favorites menu's item that adds or removes the page. */
export const FAVORITE_PAGE_MENU_ITEM_ID = "sval-menu-favorite-page";

/** The Tab menu's items for the element picker's modes. */
export const MODE_MENU_ITEMS = [
  { mode: "remove", id: "sval-menu-element-picker" },
  { mode: "snip", id: "sval-menu-snip" },
];

/** The Tab menu's item that opens the site style editor. */
export const STYLE_MENU_ITEM_ID = "sval-menu-site-style";

/** The Tab menu's item that opens Firefox's screenshot tool. */
export const SCREENSHOT_MENU_ITEM_ID = "sval-menu-screenshot";

/**
 * @param {Document} doc
 * @param {string} label
 * @param {string} [key] The `<key>` it names.
 * @returns {Element}
 */
function menuItem(doc, label, key) {
  const el = doc.createXULElement("menuitem");
  el.setAttribute("label", label);
  if (key) {
    el.setAttribute("key", key);
  }
  return el;
}

/**
 * New Workspace, the panel's toggle, then every workspace and the workspace
 * menu's commands (`SvalPanel.fillMenuBarWorkspaces`).
 *
 * @param {Window} win
 * @param {Element} popup
 */
function mountWorkspaces(win, popup) {
  const doc = win.document;
  const fresh = menuItem(doc, "New Workspace…", NEW_WORKSPACE_KEY);
  fresh.id = NEW_WORKSPACE_MENU_ITEM_ID;
  fresh.addEventListener("command", () => newWorkspace(win));
  const toggle = menuItem(doc, "Show Workspace Panel", PANEL_TOGGLE_KEY);
  toggle.id = PANEL_MENU_ITEM_ID;
  toggle.addEventListener("command", () => win.SvalPanel?.toggleFromKey());
  const fixedEnd = doc.createXULElement("menuseparator");
  popup.append(fresh, toggle, fixedEnd);

  popup.addEventListener("popupshowing", event => {
    if (event.target !== popup) {
      return;
    }
    fresh.toggleAttribute("disabled", !lazy.userPanel(win));
    // What `SvalPanel.toggleFromKey` toggles, and when it does nothing.
    const container = doc.getElementById("sval-panel-container");
    const usable = !!container && !container.hidden;
    toggle.toggleAttribute("disabled", !usable);
    const shown = usable && !container.hasAttribute("sval-collapsed");
    toggle.setAttribute(
      "label",
      shown ? "Hide Workspace Panel" : "Show Workspace Panel"
    );
    toggle.dataset.panel = shown ? "shown" : "hidden";
    while (fixedEnd.nextSibling) {
      fixedEnd.nextSibling.remove();
    }
    win.SvalPanel?.fillMenuBarWorkspaces(popup);
    fixedEnd.hidden = !fixedEnd.nextSibling;
  });
  popup.addEventListener("command", event => {
    if (event.target !== fresh && event.target !== toggle) {
      win.SvalPanel?.runMenuBarWorkspacesCommand(event);
    }
  });
}

/**
 * Add to Favorites, then Favorites as the panel's Favorites menu draws
 * them (`SvalFavoritesView`), without the pins.
 *
 * @param {Window} win
 * @param {Element} popup
 */
function mountFavorites(win, popup) {
  const doc = win.document;
  const isPrivate = lazy.PrivateBrowsingUtils.isWindowPrivate(win);
  const page = menuItem(doc, "Add to Favorites");
  page.id = FAVORITE_PAGE_MENU_ITEM_ID;
  page.setAttribute("data-fixed", "");
  page.addEventListener("command", () =>
    lazy.SvalFavorites.toggle(win).catch(err =>
      lazy.SvalLog.error(
        `could not change a favorite: ${lazy.SvalLog.errorName(err)}`
      )
    )
  );
  const fixedEnd = doc.createXULElement("menuseparator");
  fixedEnd.setAttribute("data-fixed", "");
  popup.append(page, fixedEnd);

  popup.addEventListener("popupshowing", event => {
    if (event.target !== popup) {
      return;
    }
    // As the favorite button reads (`SvalFavorites.startWindow`): the key
    // only adds, so only adding names it.
    const starred = lazy.SvalFavorites.isCurrentFavorite(win);
    page.setAttribute(
      "label",
      starred ? "Remove from Favorites" : "Add to Favorites"
    );
    if (starred) {
      page.removeAttribute("key");
    } else {
      page.setAttribute("key", "addBookmarkAsKb");
    }
    page.toggleAttribute("disabled", isPrivate);
  });

  new lazy.SvalFavoritesView(popup, lazy.FAVORITES_ROOT, {
    onPick: (row, event) => lazy.SvalFavorites.open(win, row, { event }),
    // A native menu bar takes no drag.
    dragAndDrop: false,
  });
}

/**
 * Copy Address, which copies the selected page's address whether or not a
 * row stands for it, so it shows for a pin's page too, then the row menu's
 * entries for the selected tab
 * (`SvalPanel.menuBarTabItems`), then the element picker's modes and the
 * site style editor, each disabled where the selected tab does not offer
 * it, then Firefox's
 * screenshot tool, shown where its context menu item shows
 * (`ScreenshotsUtils.screenshotsEnabled`).
 *
 * @param {Window} win
 * @param {Element} popup
 */
function mountTab(win, popup) {
  const doc = win.document;
  const panel = win.SvalPanel;
  const copyAddress = menuItem(doc, "Copy Address", COPY_ADDRESS_KEY);
  copyAddress.id = COPY_ADDRESS_MENU_ITEM_ID;
  copyAddress.addEventListener("command", () => lazy.copyAddress(win));
  const items = panel.menuBarTabItems();
  const modesStart = doc.createXULElement("menuseparator");
  const modes = MODE_MENU_ITEMS.map(({ mode, id }) => {
    const el = menuItem(doc, `${MODE_NAMES[mode]}…`, MODE_KEYS[mode]);
    el.id = id;
    el.addEventListener("command", () =>
      lazy.SvalSiteControls.toggleMode(win, mode, false)
    );
    return el;
  });
  const style = menuItem(
    doc,
    lazy.SvalSiteStylePanel.STYLE_MENU_LABEL,
    STYLE_KEY
  );
  style.id = STYLE_MENU_ITEM_ID;
  style.addEventListener("command", () =>
    lazy.SvalSiteStylePanel.open(win, { focus: true })
  );
  const screenshot = doc.createXULElement("menuitem");
  screenshot.id = SCREENSHOT_MENU_ITEM_ID;
  screenshot.setAttribute("command", "Browser:Screenshot");
  screenshot.setAttribute("key", "key_screenshot");
  doc.l10n.setAttributes(screenshot, "main-context-menu-take-screenshot");
  popup.append(copyAddress, ...items, modesStart, ...modes, style, screenshot);

  popup.addEventListener("popupshowing", event => {
    if (event.target !== popup) {
      return;
    }
    // Hides every entry it does not name, the modes among them.
    panel.syncMenuBarTab(popup);
    copyAddress.hidden = false;
    copyAddress.toggleAttribute("disabled", !win.gBrowser.currentURI?.spec);
    MODE_MENU_ITEMS.forEach(({ mode }, i) => {
      modes[i].hidden = false;
      modes[i].toggleAttribute(
        "disabled",
        !lazy.SvalSiteControls.offered(win, mode)
      );
    });
    style.hidden = false;
    style.toggleAttribute("disabled", !lazy.SvalSiteStylePanel.offered(win));
    screenshot.hidden = !lazy.ScreenshotsUtils.screenshotsEnabled;
    modesStart.hidden = !items.some(el => !el.hidden);
  });
  popup.addEventListener("command", event => {
    if (
      !modes.includes(event.target) &&
      event.target !== style &&
      event.target !== screenshot &&
      event.target !== copyAddress
    ) {
      panel.runMenuBarTabCommand(event);
    }
  });
}

export const SvalMenuBar = {
  /**
   * Shows and fills the three menus in a window with the panel, before its
   * first layout.
   *
   * @param {Window} win A browser window, after the panel's scripts load.
   */
  mount(win) {
    const doc = win.document;
    const menus = [WORKSPACES_MENU_ID, FAVORITES_MENU_ID, TAB_MENU_ID].map(id =>
      doc.getElementById(id)
    );
    if (!win.SvalPanel || menus.some(menu => !menu)) {
      return;
    }
    // The patch gives each menu its popup as `<id>-popup`.
    const popup = id => doc.getElementById(`${id}-popup`);
    mountWorkspaces(win, popup(WORKSPACES_MENU_ID));
    mountFavorites(win, popup(FAVORITES_MENU_ID));
    mountTab(win, popup(TAB_MENU_ID));
    for (const menu of menus) {
      menu.hidden = false;
    }
  },
};
