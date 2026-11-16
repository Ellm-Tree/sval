/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The home page's row of pinned Favorites (home-favorites spec §3, §7). The
 * page draws it; this side reads the pins from `SvalFavoritesStore`, sends the
 * row again on every change, and does what the page asks: open a favorite or
 * a folder's favorites, move a pin within the row, file a favorite in a
 * folder, open the Favorites context menu on a tile, and turn the row on or
 * off.
 *
 * **Names and addresses are never logged** (Sval `CONTRIBUTING.md` rule 10).
 */

import {
  SvalFavoritesStore,
  FAVORITES_CHANGED_TOPIC,
} from "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs";
import {
  FAVORITE_ICONS_CHANGED_TOPIC,
  SvalFavoriteIcons,
} from "moz-src:///browser/components/sval/SvalFavoriteIcons.sys.mjs";
import {
  HOME_FAVORITES_PREF,
  SvalHomePage,
} from "moz-src:///browser/components/sval/SvalHomePage.sys.mjs";
import {
  WINDOW_WORKSPACE_TOPIC,
  WORKSPACE,
} from "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs";
import {
  pinOf,
  slotsIn,
} from "moz-src:///browser/components/sval/SvalPinsModel.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalFavorites: "moz-src:///browser/components/sval/SvalFavorites.sys.mjs",
  SvalFavoritesMenu:
    "moz-src:///browser/components/sval/SvalFavoritesMenu.sys.mjs",
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

/**
 * The parent side of one home page's row.
 */
export class SvalHomeFavoritesParent extends JSWindowActorParent {
  #watching = false;

  #observer = {
    observe: (subject, topic) => {
      // Another window's workspace says nothing about this page's.
      if (topic === WINDOW_WORKSPACE_TOPIC && subject !== this.#window) {
        return;
      }
      this.#send().catch(err =>
        lazy.SvalLog.warn(
          `home favorites: could not send the row: ${lazy.SvalLog.errorName(err)}`
        )
      );
    },
  };

  didDestroy() {
    if (this.#watching) {
      this.#watching = false;
      Services.obs.removeObserver(this.#observer, FAVORITES_CHANGED_TOPIC);
      Services.obs.removeObserver(this.#observer, FAVORITE_ICONS_CHANGED_TOPIC);
      Services.obs.removeObserver(this.#observer, WINDOW_WORKSPACE_TOPIC);
      Services.prefs.removeObserver(HOME_FAVORITES_PREF, this.#observer);
    }
  }

  get #browser() {
    return this.browsingContext.top.embedderElement;
  }

  get #window() {
    return this.#browser?.documentGlobal ?? null;
  }

  receiveMessage({ name, data }) {
    // A private window's home page shows no row (home-favorites spec §2).
    if (
      !this.#browser ||
      lazy.PrivateBrowsingUtils.isBrowserPrivate(this.#browser)
    ) {
      return;
    }
    const done = this.#handle(name, data ?? {});
    Promise.resolve(done).catch(err =>
      lazy.SvalLog.warn(
        `home favorites: a request failed: ${lazy.SvalLog.errorName(err)}`
      )
    );
  }

  /**
   * What this page shows, which is all a request from it may act on: the
   * page is content, so a guid it names is trusted only when its row draws
   * it. `pins` are the row's own tiles, `folders` every folder shown, and
   * `all` everything shown, folders' contents at any depth included.
   *
   * @returns {{all: Set<string>, pins: Set<string>, folders: Set<string>}}
   */
  #shown() {
    const all = new Set();
    const pins = new Set();
    const folders = new Set();
    const store = SvalFavoritesStore.readyInstance;
    if (!store || !Services.prefs.getBoolPref(HOME_FAVORITES_PREF, true)) {
      return { all, pins, folders };
    }
    const walk = (tiles, depth) => {
      for (const tile of tiles ?? []) {
        all.add(tile.guid);
        if (tile.kind === "folder") {
          folders.add(tile.guid);
          if (depth < 32) {
            walk(tile.children, depth + 1);
          }
        }
      }
    };
    const row = this.#shownHere(store.home());
    for (const tile of row) {
      pins.add(tile.guid);
    }
    walk(row, 0);
    return { all, pins, folders };
  }

  /**
   * Whether a request names only what this page shows (`#shown`).
   *
   * @param {string} name The message.
   * @param {object} data Its data.
   * @returns {boolean}
   */
  #allowed(name, data) {
    const shown = this.#shown();
    const isShown = guid => typeof guid === "string" && shown.all.has(guid);
    const isPinOrNone = guid =>
      guid === null ||
      guid === undefined ||
      (typeof guid === "string" && shown.pins.has(guid));
    switch (name) {
      case "Open":
      case "Context":
        return isShown(data.guid);
      case "OpenAll":
        return shown.folders.has(data.guid);
      case "Move":
        return (
          shown.pins.has(data.guid) &&
          isPinOrNone(data.afterGuid) &&
          isPinOrNone(data.beforeGuid)
        );
      case "File":
        return (
          shown.pins.has(data.guid) &&
          shown.folders.has(data.folderGuid) &&
          data.guid !== data.folderGuid
        );
    }
    return true;
  }

  #handle(name, data) {
    if (!this.#allowed(name, data)) {
      return null;
    }
    switch (name) {
      case "Init":
        if (!this.#watching) {
          this.#watching = true;
          Services.obs.addObserver(this.#observer, FAVORITES_CHANGED_TOPIC);
          Services.obs.addObserver(
            this.#observer,
            FAVORITE_ICONS_CHANGED_TOPIC
          );
          Services.obs.addObserver(this.#observer, WINDOW_WORKSPACE_TOPIC);
          Services.prefs.addObserver(HOME_FAVORITES_PREF, this.#observer);
        }
        return this.#send();
      case "Open":
        return this.#open(data.guid, data.modifiers);
      case "OpenAll":
        return lazy.SvalFavoritesMenu._openAll(this.#window, {
          guid: data.guid,
        });
      case "Move":
        // A tile moved along the row is not taken back by Undo, as a pin
        // dragged along the panel's row is not.
        return SvalFavoritesStore.readyInstance?.movePin(
          data.guid,
          {
            afterGuid: data.afterGuid ?? null,
            beforeGuid: data.beforeGuid ?? null,
          },
          { undoable: false }
        );
      case "File":
        return this.#file(data.guid, data.folderGuid);
      case "Context":
        return this.#context(data);
      case "Enabled":
        Services.prefs.setBoolPref(HOME_FAVORITES_PREF, data.on === true);
        return null;
    }
    return null;
  }

  async #send() {
    const store = SvalFavoritesStore.readyInstance;
    const enabled = Services.prefs.getBoolPref(HOME_FAVORITES_PREF, true);
    const tiles =
      store && enabled ? this.#shownHere(store.home()).map(withIcon) : [];
    try {
      this.sendAsyncMessage("Row", { enabled, tiles });
    } catch {
      // The page went away while the row was read.
    }
  }

  /**
   * The pins that show in the workspace this page's tab is in, in the
   * row's order, as the panel's row filters them (pins spec §9).
   *
   * @param {object[]} tiles As `SvalFavoritesStore.home()` answers them.
   * @returns {object[]}
   */
  #shownHere(tiles) {
    const workspace = SvalHomePage.workspaceOf(this.#browser);
    if (!workspace) {
      return [];
    }
    const nodes = this.#window?.SvalPanel?.nodes ?? {};
    const workspaces = new Set(
      Object.keys(nodes).filter(id => nodes[id]?.kind === WORKSPACE)
    );
    return slotsIn(tiles, workspace.id, workspaces);
  }

  /**
   * A plain click on a pin's tile selects the pin, as the panel's row does
   * (pins spec §9), and closes this home tab when it has shown no other
   * page: it was opened only to get there.
   *
   * @param {string} guid
   * @returns {Promise<boolean>} whether a pin was selected.
   */
  async #selectPin(guid) {
    const win = this.#window;
    const row = win?.SvalPanel?.pins;
    const store = SvalFavoritesStore.readyInstance;
    if (!row || !store) {
      return false;
    }
    const pin = pinOf(this.#shownHere(store.home()), guid);
    if (!pin?.url) {
      return false;
    }
    const browser = this.#browser;
    const tab = win.gBrowser.getTabForBrowser(browser);
    const untouched = !browser.canGoBack && !browser.canGoForward;
    row.select(pin);
    if (tab && untouched && !tab.closing) {
      win.gBrowser.removeTab(tab);
    }
    return true;
  }

  /**
   * Opens a pinned favorite, or one in a pinned folder, the way the
   * Favorites menu opens one (`SvalFavorites.open`), so
   * `browser.tabs.loadBookmarksInTabs` and bookmarklets behave alike.
   *
   * @param {string} guid
   * @param {object} modifiers The click's buttons and keys.
   */
  async #open(guid, modifiers = {}) {
    const plain =
      (modifiers.button ?? 0) === 0 &&
      !modifiers.shiftKey &&
      !modifiers.ctrlKey &&
      !modifiers.metaKey &&
      !modifiers.altKey;
    if (plain && (await this.#selectPin(guid))) {
      return;
    }
    const win = this.#window;
    const favorite = SvalFavoritesStore.readyInstance?.get(guid);
    // A bookmarklet runs on the selected tab's page, which here is the
    // privileged home page itself. The row never offers one; a request for
    // one is refused.
    if (
      !win ||
      favorite?.kind !== "favorite" ||
      lazy.SvalFavorites.isBookmarklet(favorite.url)
    ) {
      return;
    }
    lazy.SvalFavorites.open(win, favorite, {
      event: {
        target: { documentGlobal: win },
        button: modifiers.button ?? 0,
        shiftKey: !!modifiers.shiftKey,
        ctrlKey: !!modifiers.ctrlKey,
        metaKey: !!modifiers.metaKey,
        altKey: !!modifiers.altKey,
      },
    });
  }

  /**
   * Opens the Favorites context menu (`SvalFavoritesMenu`) on a tile, at the
   * point the page's `contextmenu` names in device pixels, as Firefox places
   * the page's own context menu (`ContextMenuChild`, `openContextMenu`).
   *
   * A row tile's Move Left and Move Right are done by the page, as its
   * Ctrl+Shift+arrow keys do, so the row's order and its announcement come
   * from the one place that draws the row.
   *
   * @param {object} data
   * @param {string} data.guid
   * @param {number} data.screenX
   * @param {number} data.screenY
   * @param {boolean} data.row Whether the tile is in the row itself.
   * @param {boolean} data.left Whether it can move left along the row.
   * @param {boolean} data.right
   */
  async #context({ guid, screenX, screenY, row, left, right }) {
    const win = this.#window;
    const favorite =
      typeof guid === "string"
        ? SvalFavoritesStore.readyInstance?.get(guid)
        : null;
    // The row never shows a bookmarklet (`SvalFavoritesStore.home`), and one
    // opened here would run on this page.
    if (!win || !favorite || lazy.SvalFavorites.isBookmarklet(favorite.url)) {
      return;
    }
    lazy.SvalFavoritesMenu.openAt(win, guid, {
      screenX: screenX / win.devicePixelRatio,
      screenY: screenY / win.devicePixelRatio,
      row: row
        ? {
            left: left === true,
            right: right === true,
            move: direction => {
              try {
                this.sendAsyncMessage("MoveBy", { guid, direction });
              } catch {
                // The page went away while the menu was open.
              }
            },
          }
        : null,
    });
  }

  /**
   * Moves a pin or folder of pins to the end of a pinned folder (pins-root
   * spec §5), as one change the Favorites menu's Undo reverses. A folder
   * into itself or anything inside it stays where it was.
   *
   * @param {string} guid
   * @param {string} folderGuid
   */
  async #file(guid, folderGuid) {
    await SvalFavoritesStore.readyInstance?.movePin(guid, {
      parentGuid: folderGuid,
    });
  }
}

/**
 * A tile with the icon this device keeps for its favorite, and its
 * children's, for the page to show before `page-icon:`.
 *
 * @param {object} tile
 * @returns {object}
 */
function withIcon(tile) {
  return {
    ...tile,
    icon: tile.url ? SvalFavoriteIcons.iconFor(tile.url) : null,
    children: tile.children?.map(withIcon) ?? null,
  };
}
