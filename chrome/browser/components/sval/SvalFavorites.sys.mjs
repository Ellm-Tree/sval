/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Favorites: the bookmark library under the one name Sval gives it (import
 * spec §6), and every way into it a window offers.
 *
 * The engine's favorites document is the only store
 * (`SvalFavoritesStore`, favorites-native spec §3.1). What Sval replaces is
 * Firefox's bookmark UI around Places: the address bar's star and its edit
 * panel, the bookmarks menus, sidebar and shortcuts. Each is either pointed
 * at a favorite here or taken away, so "favorite" is the only name a person
 * meets, and nothing reads Places' empty bookmark roots.
 *
 * A favorite is managed from the panel's Favorites menu (favorites-native
 * spec §15.2), and nothing in a window opens Firefox's Library (§15.4).
 */

import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  CustomizableUI:
    "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
  E10SUtils: "resource://gre/modules/E10SUtils.sys.mjs",
  importableUrl: "moz-src:///browser/components/sval/SvalImportModel.sys.mjs",
  openSvalDialog: "moz-src:///browser/components/sval/SvalDialog.sys.mjs",
  FAVORITES_CHANGED_TOPIC:
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
  PlacesUIUtils: "moz-src:///browser/components/places/PlacesUIUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SvalFavoriteIcons:
    "moz-src:///browser/components/sval/SvalFavoriteIcons.sys.mjs",
  SvalFavoritesStore:
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
  describeKey: "moz-src:///browser/components/sval/SvalKeys.sys.mjs",
  isBookmarklet:
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
});

export const FAVORITE_BUTTON_ID = "sval-favorite-button";

/** The context menu item that adds a link, standing in for Firefox's. */
export const FAVORITE_LINK_ITEM_ID = "sval-context-favorite-link";

/**
 * Whether a bookmarklet, a favorite whose address is `javascript:`, runs
 * when it is opened. Off, opening one does nothing.
 */
export const BOOKMARKLETS_PREF = "browser.sval.favorites.bookmarklets";

/**
 * Firefox's bookmark entry points that have no favorite counterpart, hidden.
 * The `hidden` attribute, because macOS draws the menu bar natively and reads
 * only that. The bookmarks menu goes whole: Favorites are in the panel, and
 * the menu's own items manage bookmarks in the Library, search them, show
 * the toolbar Sval removes or bookmark every tab. The page's "Bookmark Page"
 * item is the header's button and its shortcut, and "Bookmark Link…" has
 * Sval's own item beside it. The sidebar's bookmarks entries open Firefox's
 * bookmark tree beside the panel's.
 *
 * Firefox shows some of these again as their menu opens (`nsContextMenu`'s
 * `showItem`) or makes them late (`SidebarController`), so they are hidden
 * again on every `popupshowing`.
 */
const HIDDEN_ITEMS = [
  "bookmarksMenu",
  "context-bookmarkpage",
  "context-bookmarklink",
  "menu_bookmarksSidebar",
  "sidebar-switcher-bookmarks",
  // Sending a page to another device needs a Firefox Account, which Sval does
  // not have (favorites-native spec §15.4).
  "context-sendpagetodevice",
  "context-sendlinktodevice",
];

/**
 * Items of Firefox's Places context menu, as the History sidebar draws it,
 * that make or manage a bookmark through Firefox's own dialogs or the
 * Library. The page menu's "Add Link to Favorites" and the header's button
 * are Sval's ways to make a favorite.
 */
const HIDDEN_PLACES_ITEMS = [
  "placesContext_createBookmark",
  "placesContext_new:bookmark",
  "placesContext_new:folder",
  "placesContext_new:separator",
  "placesContext_showAllBookmarks",
];

/**
 * Shortcuts that open Firefox's bookmark UI and nothing of Sval's: the
 * bookmarks sidebar and the dialog that bookmarks every tab. A workspace is
 * already the saved set of its tabs (import spec §2). The Library's bookmarks
 * shortcut stays, because {@link SvalFavorites._replaceLibrary} sends it to
 * the Favorites menu.
 */
const DISABLED_KEYS = ["viewBookmarksSidebarKb", "bookmarkAllTabsKb"];
const DISABLED_COMMANDS = ["Browser:BookmarkAllTabs"];

/**
 * The notice each way into Favorites shows when it adds or removes a page,
 * as Firefox confirms a bookmark (`StarUI.showConfirmation`): Fluent ids of
 * {@link HINT_FTL}.
 */
const HINTS = {
  added: "sval-favorites-hint-added",
  removed: "sval-favorites-hint-removed",
  already: "sval-favorites-hint-already",
};
const HINT_FTL = "sval/favorites.ftl";

ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization([HINT_FTL]));

/**
 * Shows `messageId` in Firefox's `ConfirmationHint` on the favorite button,
 * or, in a window without one, on the panel toggle `ConfirmationHint.show`
 * falls back to.
 *
 * @param {Window} win A browser window.
 * @param {string} messageId One of {@link HINTS}.
 */
function showHint(win, messageId) {
  if (win.closed) {
    return;
  }
  win.MozXULElement.insertFTLIfNeeded(HINT_FTL);
  // The overflow button while the favorite button is in its panel.
  win.ConfirmationHint.show(
    win.document.getElementById(FAVORITE_BUTTON_ID) &&
      lazy.CustomizableUI.getWidget(FAVORITE_BUTTON_ID).forWindow(win).anchor,
    messageId
  );
}

/** Commands that open Firefox's import wizard; Sval's import page answers them. */
const IMPORT_COMMANDS = [
  "cmd_file_importFromAnotherBrowser",
  "cmd_help_importFromAnotherBrowser",
];

/**
 * The address a browser's page is saved under, as Firefox's own
 * `PlacesCommandHook.bookmarkPage` reads it: the exposable URI, so a
 * `view-source:` or wyciwyg wrapper is never what a favorite holds. An
 * unloaded tab's lazy browser answers `currentURI` with the address its tab
 * will load (`tabbrowser._createLazyBrowser`).
 *
 * @param {Element} browser A tab's browser.
 * @returns {URL}
 */
function pageOf(browser) {
  return URL.fromURI(Services.io.createExposableURI(browser.currentURI));
}

/**
 * The profile's Favorites for a change, waiting until they are read.
 *
 * @returns {Promise<object>}
 */
async function writable() {
  const store = lazy.SvalFavoritesStore.instance;
  if (!store) {
    throw new Error("sval: Favorites have not started");
  }
  await store.whenReady();
  return store;
}

/**
 * A favorite as `PlacesUIUtils` opens one: a URI result node's shape, which
 * `PlacesUtils.nodeIsBookmark` and `PlacesUIUtils.isURILike` accept for any
 * object with a `bookmarkGuid` and a `uri` (favorites-native spec §3).
 *
 * @param {{guid: string, url: string, name?: string}} favorite
 * @returns {object}
 */
function nodeOf(favorite) {
  return {
    type: Ci.nsINavHistoryResultNode.RESULT_TYPE_URI,
    uri: favorite.url,
    title: favorite.name ?? "",
    bookmarkGuid: favorite.guid,
  };
}

export const SvalFavorites = {
  /**
   * Saves `url` as a favorite at the end of Favorites, which the Favorites
   * menu lists. A URL that is already a favorite is left as it is.
   *
   * @param {string|URL} url
   * @param {string} [title]
   * @returns {Promise<string|null>} the new favorite's guid.
   */
  async add(url, title) {
    return (await writable()).add({ url, title });
  },

  /**
   * Takes `url` out of Favorites wherever it is filed, as one change.
   *
   * @param {string|URL} url
   * @returns {Promise<void>}
   */
  async remove(url) {
    await (await writable()).removeUrl(url);
  },

  /**
   * The Favorites context menu's changes (favorites-native spec §15.2). Each
   * is one change, which {@link undo} takes back.
   *
   * @param {string} guid A favorite or folder.
   * @param {string} title
   * @returns {Promise<void>}
   */
  async rename(guid, title) {
    await (await writable()).rename(guid, title);
  },

  /**
   * @param {string} guid A favorite.
   * @param {string} address What the user typed; see {@link addressOf}.
   * @returns {Promise<void>}
   */
  async setAddress(guid, address) {
    const url = this.addressOf(address);
    if (!url) {
      throw new Error("sval: not an address a favorite can hold");
    }
    await (await writable()).setAddress(guid, url);
  },

  /**
   * Moves `guid` into the folder `parentGuid`, at its end unless `index`
   * says where (`SvalFavoritesStore.move`).
   *
   * @param {string} guid
   * @param {string} parentGuid
   * @param {number} [index]
   * @returns {Promise<void>}
   */
  async move(guid, parentGuid, index) {
    await (await writable()).move(guid, parentGuid, index);
  },

  /**
   * Deletes a favorite or pin, or a folder with everything in it.
   *
   * @param {string} guid
   * @returns {Promise<void>}
   */
  async delete(guid) {
    await (await writable()).delete(guid);
  },

  /**
   * Makes a folder at the end of `parentGuid`.
   *
   * @param {string} parentGuid
   * @param {string} title
   * @returns {Promise<string>}
   */
  async newFolder(parentGuid, title) {
    return (await writable()).newFolder(parentGuid, title);
  },

  /**
   * Puts a separator in `parentGuid` at `index`, or at its end.
   *
   * @param {string} parentGuid
   * @param {number} [index]
   * @returns {Promise<string>}
   */
  async newSeparator(parentGuid, index) {
    return (await writable()).newSeparator(parentGuid, index);
  },

  /** @returns {boolean} Whether there is a change to undo. */
  canUndo() {
    return !!lazy.SvalFavoritesStore.readyInstance?.canUndo();
  },

  /**
   * Undoes the latest change to Favorites or their pins made on this device.
   *
   * @returns {Promise<void>}
   */
  async undo() {
    await (await writable()).undo();
  },

  /**
   * The address a favorite is saved under for what the user typed, fixed up
   * as the address bar fixes it up (`nsIURIFixup`), or null when that is not
   * an address import would carry either (`SvalImportModel.importableUrl`).
   *
   * @param {string} text
   * @returns {string|null}
   */
  addressOf(text) {
    let uri;
    try {
      uri = Services.uriFixup.getFixupURIInfo(
        text.trim(),
        Ci.nsIURIFixup.FIXUP_FLAG_NONE
      ).preferredURI;
    } catch {
      return null;
    }
    return uri && lazy.importableUrl(uri.spec) ? uri.spec : null;
  },

  /**
   * Every folder a favorite can be moved into, in menu order
   * (`SvalFavoritesStore.folders`).
   *
   * @returns {Array<{guid: string, title: string, depth: number}>}
   */
  folders() {
    return lazy.SvalFavoritesStore.readyInstance?.folders() ?? [];
  },

  /**
   * @param {string|null} url
   * @returns {boolean} whether `url` is a bookmarklet's
   *   (`SvalFavoritesStore`'s `isBookmarklet`).
   */
  isBookmarklet(url) {
    return lazy.isBookmarklet(url);
  },

  /**
   * Asks before a bookmarklet from a page becomes a favorite, with Cancel
   * focused. The page chose the script, and the link's text need not say
   * what it does.
   *
   * @param {Window} win The browser window to ask in.
   * @returns {Promise<boolean>} whether to add it.
   */
  async confirmBookmarklet(win) {
    const [title, primary] = await lazy.l10n.formatValues([
      "sval-favorites-bookmarklet-question",
      "sval-favorites-bookmarklet-add",
    ]);
    const answer = await lazy.openSvalDialog(win, {
      title,
      primary,
      focus: "cancel",
    });
    return answer.ok;
  },

  /** @returns {boolean} Whether bookmarklets run ({@link BOOKMARKLETS_PREF}). */
  bookmarkletsRun() {
    return Services.prefs.getBoolPref(BOOKMARKLETS_PREF, true);
  },

  /**
   * Opens a favorite: the one way the Favorites menu, its context menu and
   * the home page's row do. A page opens where `event`'s modifiers and
   * `browser.tabs.loadBookmarksInTabs` put it
   * (`PlacesUIUtils.openNodeWithEvent`), or else where `where` says. A
   * bookmarklet acts on the page in the selected tab wherever it was asked
   * to open, because a new tab or window has no page for it to act on.
   *
   * The tab it opens in is handed to `SvalFavoriteIcons`, which keeps the
   * icon the page settles on, after any redirect, as the favorite's.
   *
   * A favorite whose address another device wrote and no device opens
   * (the store's `refused`, decision 1372) opens nothing, whoever asks.
   *
   * A bookmarklet runs only on a page in a web or file content process.
   * `PlacesUIUtils.openNodeIn` triggers it with the system principal, so
   * `JSURLInputStream::EvaluateScript` skips the page's CSP and the script
   * runs as the page. On the home page that reaches the home page's actors,
   * and on an extension's page the extension's privileges.
   *
   * @param {Window} win A browser window.
   * @param {{guid: string, url: string, name?: string}} favorite
   * @param {object} [how]
   * @param {Event} [how.event] The click or command that asked.
   * @param {string} [how.where] `tab` or `window`, without an event.
   * @param {boolean} [how.isPrivate] Whether a new window is private.
   */
  open(win, favorite, { event, where = "tab", isPrivate = false } = {}) {
    if (lazy.SvalFavoritesStore.readyInstance?.get(favorite.guid)?.refused) {
      return;
    }
    const node = nodeOf(favorite);
    if (this.isBookmarklet(node.uri)) {
      const { remoteType } = win.gBrowser.selectedBrowser;
      if (
        this.bookmarkletsRun() &&
        remoteType &&
        (lazy.E10SUtils.isWebRemoteType(remoteType) ||
          remoteType === lazy.E10SUtils.FILE_REMOTE_TYPE)
      ) {
        lazy.PlacesUIUtils.openNodeIn(node, "current", { ownerWindow: win });
      }
      return;
    }
    const opened = lazy.SvalFavoriteIcons.watchOpen(win, node.uri);
    try {
      if (event) {
        lazy.PlacesUIUtils.openNodeWithEvent(node, event);
      } else {
        lazy.PlacesUIUtils.openNodeIn(
          node,
          where,
          { ownerWindow: win },
          isPrivate
        );
      }
    } finally {
      opened.done();
    }
  },

  /**
   * The favorite button: makes the window's current page a favorite, or
   * takes it out of Favorites when it is one, as the document says, and
   * says which it did. Nothing in a private window, whose panel has no
   * Favorites to file it under.
   *
   * @param {Window} win A browser window.
   * @param {Element} [browser] The tab's browser whose page it is, for a
   *   tab's menu; the selected tab's by default.
   * @returns {Promise<void>}
   */
  async toggle(win, browser = win.gBrowser.selectedBrowser) {
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      return;
    }
    const url = pageOf(browser);
    const store = await writable();
    if (store.isFavorite(url)) {
      await store.removeUrl(url);
      showHint(win, HINTS.removed);
    } else {
      await this.addPage(win, browser);
    }
  },

  /**
   * Whether the window's current page is a favorite, which the favorite
   * button shows.
   *
   * @param {Window} win A browser window.
   * @param {Element} [browser] As {@link toggle} takes it.
   * @returns {boolean}
   */
  isCurrentFavorite(win, browser = win.gBrowser.selectedBrowser) {
    try {
      return !!lazy.SvalFavoritesStore.readyInstance?.isFavorite(
        pageOf(browser)
      );
    } catch {
      // A page with no address of its own, such as one still loading.
      return false;
    }
  },

  /**
   * The bookmark shortcut: makes the window's current page a favorite and
   * says so, or says it is one already. It never removes one, as Firefox's
   * shortcut opens a bookmarked page's edit panel
   * (`PlacesCommandHook.bookmarkPage`). Nothing in a private window.
   *
   * @param {Window} win A browser window.
   * @param {Element} [browser] As {@link toggle} takes it.
   * @returns {Promise<void>}
   */
  async addPage(win, browser = win.gBrowser.selectedBrowser) {
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      return;
    }
    const url = pageOf(browser);
    const guid = await (
      await writable()
    ).add({
      url,
      title: browser.contentTitle || url.href,
    });
    showHint(win, guid ? HINTS.added : HINTS.already);
  },

  /**
   * `browser-window-before-initial-xul-layout`: takes Firefox's bookmark entry
   * points out of the window and points the rest at Favorites.
   *
   * The bookmark shortcut's command and the import commands are answered by a
   * listener on the command element itself, which runs before the
   * `mainCommandSet` listener Firefox delegates every command to
   * (`browser-sets.js`) and stops the event reaching it.
   *
   * @param {Window} win A browser window.
   */
  mount(win) {
    const doc = win.document;
    this._mountLinkItem(win);
    const hide = () => {
      for (const id of HIDDEN_ITEMS) {
        doc.getElementById(id)?.setAttribute("hidden", "true");
      }
    };
    hide();
    win.addEventListener("popupshowing", event => {
      hide();
      // Firefox placed the menu's separators for the items it showed
      // (`nsContextMenu.showHideSeparators`), before this ran.
      event.target.showHideSeparators?.();
    });
    for (const id of [...DISABLED_KEYS, ...DISABLED_COMMANDS]) {
      doc.getElementById(id)?.setAttribute("disabled", "true");
    }
    doc
      .getElementById("Browser:AddBookmarkAs")
      ?.addEventListener("command", event => {
        event.stopPropagation();
        this.addPage(win).catch(err =>
          SvalLog.error(
            `could not change a favorite: ${SvalLog.errorName(err)}`
          )
        );
      });
    for (const id of IMPORT_COMMANDS) {
      doc.getElementById(id)?.addEventListener("command", event => {
        event.stopPropagation();
        win.SvalPanel?.openImport().catch(err =>
          SvalLog.error(`could not open import: ${SvalLog.errorName(err)}`)
        );
      });
    }
    this._replaceLibrary(win);
    win.addEventListener("SidebarShown", () => this._hidePlacesItems(win));
  },

  /**
   * Every way Firefox has into its Library window goes through
   * `PlacesCommandHook.showPlacesOrganizer`: the downloads panel's "Show all
   * downloads", history's "Show All History", and the bookmark commands. Sval
   * has no Library (decision 0099), so each goes where Sval keeps that thing:
   * history to the History sidebar, downloads to `about:downloads`, and
   * bookmarks to the panel's Favorites menu.
   *
   * @param {Window} win A browser window.
   */
  _replaceLibrary(win) {
    win.PlacesCommandHook.showPlacesOrganizer = item => {
      switch (item) {
        case "History":
          win.SidebarController.show("viewHistorySidebar");
          return;
        case "Downloads":
          win.openTrustedLinkIn("about:downloads", "tab", {
            inBackground: false,
          });
          return;
      }
      // A window without the panel (a popup) has no Favorites to show.
      if (win.SvalPanel?.built) {
        win.SvalPanel.openFavorites();
      }
    };
  },

  /**
   * Hides {@link HIDDEN_PLACES_ITEMS} in the sidebar's own document, which
   * carries its own copy of the Places context menu.
   *
   * @param {Window} win A browser window.
   */
  _hidePlacesItems(win) {
    const doc = win.SidebarController.browser?.contentDocument;
    const menu = doc?.getElementById("placesContext");
    if (!menu || menu._svalHidden) {
      return;
    }
    menu._svalHidden = true;
    // `ignore-item` keeps `PlacesController.buildContextMenu` from showing
    // them again, and leaves them out when it decides which separators show.
    for (const id of HIDDEN_PLACES_ITEMS) {
      const item = doc.getElementById(id);
      item?.setAttribute("ignore-item", "true");
      item?.setAttribute("hidden", "true");
    }
  },

  /**
   * "Add Link to Favorites" in the page's context menu, in place of Firefox's
   * "Bookmark Link…", which opens Firefox's bookmark dialog. It shows exactly
   * when Firefox's would: `nsContextMenu` still decides that, on the item
   * `mount` then hides, and this one takes the answer first. The listener is
   * on the window, so it runs after Firefox's own on the menu, and is added
   * before `mount`'s, which hides Firefox's item.
   *
   * @param {Window} win A browser window.
   */
  _mountLinkItem(win) {
    const doc = win.document;
    const firefoxItem = doc.getElementById("context-bookmarklink");
    if (!firefoxItem) {
      return;
    }
    const item = doc.createXULElement("menuitem");
    item.id = FAVORITE_LINK_ITEM_ID;
    item.setAttribute("label", "Add Link to Favorites");
    item.hidden = true;
    firefoxItem.after(item);
    item.addEventListener("command", async () => {
      const { linkURL, linkTextStr } = win.gContextMenu ?? {};
      if (!linkURL) {
        return;
      }
      if (
        this.isBookmarklet(linkURL) &&
        !(await this.confirmBookmarklet(win))
      ) {
        return;
      }
      this.add(linkURL, linkTextStr).then(
        guid => showHint(win, guid ? HINTS.added : HINTS.already),
        err =>
          SvalLog.error(`could not add a favorite: ${SvalLog.errorName(err)}`)
      );
    });
    win.addEventListener("popupshowing", event => {
      if (event.target.id === "contentAreaContextMenu") {
        item.hidden =
          firefoxItem.hidden || lazy.PrivateBrowsingUtils.isWindowPrivate(win);
        // Firefox placed the menu's separators for the items it showed
        // (`nsContextMenu.showHideSeparators`), before this ran.
        event.target.showHideSeparators?.();
      }
    });
  },

  /**
   * After the window's delayed startup: the favorite button says whether the
   * current page is a favorite, as the document holds it, again on every tab
   * selection, location change and change to Favorites, and the icons the
   * window's tabs show for favorites are kept (`SvalFavoriteIcons`).
   *
   * @param {Window} win A browser window.
   */
  startWindow(win) {
    const doc = win.document;
    lazy.SvalFavoriteIcons.watchWindow(win);
    const update = () => {
      const button = doc.getElementById(FAVORITE_BUTTON_ID);
      if (!button || win.closed) {
        return;
      }
      const starred = this.isCurrentFavorite(win);
      button.toggleAttribute("starred", starred);
      // The name stays put while `aria-pressed` says whether it is one; the
      // tooltip, the button's description, says what a press does.
      button.setAttribute("aria-pressed", String(starred));
      // The bookmark shortcut only adds (`addPage`), so only adding names it.
      if (starred) {
        button.setAttribute("tooltiptext", "Remove from Favorites");
        button.removeAttribute("aria-keyshortcuts");
      } else {
        lazy.describeKey(button, "addBookmarkAsKb", "Add to Favorites");
      }
    };
    const observer = { observe: update };
    const progress = {
      onLocationChange: webProgress => {
        if (webProgress.isTopLevel) {
          update();
        }
      },
      QueryInterface: ChromeUtils.generateQI([
        "nsIWebProgressListener",
        "nsISupportsWeakReference",
      ]),
    };
    Services.obs.addObserver(observer, lazy.FAVORITES_CHANGED_TOPIC);
    win.gBrowser.addProgressListener(progress);
    win.gBrowser.tabContainer.addEventListener("TabSelect", update);
    // Settings › Keyboard can remap the key while the window is open.
    for (const type of ["mouseover", "focus"]) {
      doc.getElementById(FAVORITE_BUTTON_ID)?.addEventListener(type, update);
    }
    win.addEventListener(
      "unload",
      () => {
        Services.obs.removeObserver(observer, lazy.FAVORITES_CHANGED_TOPIC);
        win.gBrowser.removeProgressListener(progress);
      },
      { once: true }
    );
    update();
  },
};
