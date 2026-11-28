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

import { newWorkspace } from "moz-src:///browser/components/sval/SvalShortcuts.sys.mjs";
import {
  COPY_ADDRESS_KEY,
  COPY_ADDRESS_MENU_ITEM_ID,
  MODE_KEYS,
  MODE_NAMES,
  NEW_WORKSPACE_KEY,
  PANEL_MENU_ITEM_ID,
  PANEL_TOGGLE_KEY,
  STYLE_KEY,
} from "moz-src:///browser/components/sval/SvalKeys.sys.mjs";

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
  MENU_ID_ATTR: "moz-src:///browser/components/sval/SvalMenu.sys.mjs",
  SvalMenu: "moz-src:///browser/components/sval/SvalMenu.sys.mjs",
  tidySeparators: "moz-src:///browser/components/sval/SvalMenu.sys.mjs",
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
 * New Workspace, the panel's toggle, then every workspace and the workspace
 * menu's commands (`SvalPanelSwitcher.fillMenuBar`).
 *
 * @param {Window} win
 * @param {Element} popup
 */
function mountWorkspaces(win, popup) {
  const doc = win.document;
  // New Workspace and the panel's toggle, as they stand as the menu opens.
  const fixed = () => {
    // What `SvalPanel.toggleFromKey` toggles, and when it does nothing.
    const container = doc.getElementById("sval-panel-container");
    const usable = !!container && !container.hidden;
    const shown = usable && !container.hasAttribute("sval-collapsed");
    return [
      {
        id: "newWorkspace",
        label: "New Workspace…",
        key: { id: NEW_WORKSPACE_KEY },
        disabled: !lazy.userPanel(win),
        attributes: { id: NEW_WORKSPACE_MENU_ITEM_ID },
      },
      {
        id: "panelToggle",
        label: shown ? "Hide Workspace Panel" : "Show Workspace Panel",
        key: { id: PANEL_TOGGLE_KEY },
        disabled: !usable,
        attributes: {
          id: PANEL_MENU_ITEM_ID,
          "data-panel": shown ? "shown" : "hidden",
        },
      },
    ];
  };
  lazy.SvalMenu.fill(popup, fixed());

  popup.addEventListener("popupshowing", event => {
    if (event.target !== popup) {
      return;
    }
    if (win.SvalPanel) {
      win.SvalPanel.switcher.fillMenuBar(popup, fixed());
    } else {
      lazy.SvalMenu.fill(popup, fixed());
    }
  });
  popup.addEventListener("command", event => {
    const id = event.target.getAttribute(lazy.MENU_ID_ATTR);
    if (id === "newWorkspace") {
      newWorkspace(win);
    } else if (id === "panelToggle") {
      win.SvalPanel?.toggleFromKey();
    } else {
      win.SvalPanel?.switcher.runMenuBarCommand(event);
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
  const isPrivate = lazy.PrivateBrowsingUtils.isWindowPrivate(win);
  // Kept ahead of the favorites `SvalFavoritesView` draws (`data-fixed`).
  lazy.SvalMenu.fill(popup, [
    {
      id: "favoritePage",
      label: "Add to Favorites",
      attributes: { id: FAVORITE_PAGE_MENU_ITEM_ID, "data-fixed": "" },
    },
    { type: "separator", attributes: { "data-fixed": "" } },
  ]);
  const page = popup.querySelector(`#${FAVORITE_PAGE_MENU_ITEM_ID}`);
  page.addEventListener("command", () =>
    lazy.SvalFavorites.toggle(win).catch(err =>
      lazy.SvalLog.error(
        `could not change a favorite: ${lazy.SvalLog.errorName(err)}`
      )
    )
  );

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
 * (`SvalPanelRowMenu.barItems`), then the element picker's modes and the
 * site style editor, each disabled where the selected tab does not offer
 * it, then Firefox's
 * screenshot tool, shown where its context menu item shows
 * (`ScreenshotsUtils.screenshotsEnabled`).
 *
 * @param {Window} win
 * @param {Element} popup
 */
function mountTab(win, popup) {
  const panel = win.SvalPanel;
  const modes = MODE_MENU_ITEMS.map(({ mode, id }) => ({
    id: `mode:${mode}`,
    label: `${MODE_NAMES[mode]}…`,
    key: { id: MODE_KEYS[mode] },
    data: mode,
    attributes: { id },
  }));
  lazy.SvalMenu.fill(popup, [
    {
      id: "copyAddress",
      label: "Copy Address",
      key: { id: COPY_ADDRESS_KEY },
      attributes: { id: COPY_ADDRESS_MENU_ITEM_ID },
    },
    ...panel.rowMenu.barItems(),
    "separator",
    ...modes,
    {
      id: "styleSiteEditor",
      label: lazy.SvalSiteStylePanel.STYLE_MENU_LABEL,
      key: { id: STYLE_KEY },
      attributes: { id: STYLE_MENU_ITEM_ID },
    },
    {
      id: "screenshot",
      l10n: { id: "main-context-menu-take-screenshot" },
      key: { id: "key_screenshot" },
      attributes: {
        id: SCREENSHOT_MENU_ITEM_ID,
        command: "Browser:Screenshot",
      },
    },
  ]);
  const item = id =>
    popup.querySelector(`:scope > [${lazy.MENU_ID_ATTR}="${id}"]`);

  popup.addEventListener("popupshowing", event => {
    if (event.target !== popup) {
      return;
    }
    // Hides every entry it does not name, the modes among them.
    panel.rowMenu.syncBar(popup);
    const copyAddress = item("copyAddress");
    copyAddress.hidden = false;
    copyAddress.toggleAttribute("disabled", !win.gBrowser.currentURI?.spec);
    for (const { mode } of MODE_MENU_ITEMS) {
      const el = item(`mode:${mode}`);
      el.hidden = false;
      el.toggleAttribute("disabled", !lazy.SvalSiteControls.offered(win, mode));
    }
    const style = item("styleSiteEditor");
    style.hidden = false;
    style.toggleAttribute("disabled", !lazy.SvalSiteStylePanel.offered(win));
    item("screenshot").hidden = !lazy.ScreenshotsUtils.screenshotsEnabled;
    lazy.tidySeparators(popup);
  });
  popup.addEventListener("command", event => {
    const id = event.target.getAttribute(lazy.MENU_ID_ATTR) ?? "";
    if (id === "copyAddress") {
      lazy.copyAddress(win);
    } else if (id.startsWith("mode:")) {
      lazy.SvalSiteControls.toggleMode(
        win,
        lazy.SvalMenu.dataOf(event.target),
        false
      );
    } else if (id === "styleSiteEditor") {
      lazy.SvalSiteStylePanel.open(win, { focus: true });
    } else if (id !== "screenshot") {
      panel.rowMenu.runBarCommand(event);
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
