/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Settings › Home's "Use Favorite…" (favorites-native spec §4): the button
 * opens the Favorites menu as a popup at the button, drawn by the same
 * `SvalFavoritesView` as the panel's, with the pins after it. A favorite sets the home page; a
 * folder sets each favorite in it, as Firefox's own picker
 * (`selectBookmark.xhtml`) did, which reads Places. The button's setting
 * hands its press here, from its `onUserClick`.
 *
 * `SvalPreferences` loads this as a classic script into the preferences page.
 */

"use strict";

{
  const BUTTON_ID = "customHomepageReplaceWithBookmarksButton";
  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    FAVORITES_ROOT:
      "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
    PINS_ROOT: "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
    HomePage: "resource:///modules/HomePage.sys.mjs",
    SvalFavoritesStore:
      "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
    SvalFavoritesView:
      "moz-src:///browser/components/sval/SvalFavoritesView.sys.mjs",
    SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  });

  let popup = null;

  /**
   * Sets the home page to `row`: a favorite's address, or every favorite
   * directly in a folder.
   *
   * @param {object} row
   */
  function use(row) {
    const store = lazy.SvalFavoritesStore.instance;
    const urls =
      row.kind === "folder"
        ? (store?.favoritesIn(row.guid) ?? []).map(child => child.url)
        : [row.url];
    if (urls.length) {
      // The pref holds several pages joined with "|", as Firefox writes it.
      lazy.HomePage.set(urls.join("|")).catch(err =>
        lazy.SvalLog.warn(
          `the home page was not set: ${lazy.SvalLog.errorName(err)}`
        )
      );
    }
  }

  function menu() {
    if (!popup) {
      // Firefox's empty-folder item is worded there.
      document.l10n.addResourceIds(["browser/places.ftl"]);
      popup = document.createXULElement("menupopup");
      popup.id = "sval-use-favorite-menu";
      popup.setAttribute("nonnative", "");
      let set = document.querySelector("popupset");
      if (!set) {
        set = document.createXULElement("popupset");
        document.body.append(set);
      }
      set.append(popup);
      new lazy.SvalFavoritesView(popup, lazy.FAVORITES_ROOT, {
        onPick: use,
        folderPickLabel: "Use All in This Folder",
        dragAndDrop: false,
        // A pin's address is one to pick too (pins-root spec §6).
        then: { guid: lazy.PINS_ROOT, heading: "Pins" },
      });
    }
    return popup;
  }

  window.SvalFavoritesSettings = {
    /**
     * Opens the Favorites menu at the button a press of "Use Favorite…" was
     * made on.
     *
     * @param {MouseEvent} event The press.
     */
    pick(event) {
      const button =
        event.composedPath().find(el => el.id === BUTTON_ID) ?? event.target;
      menu().openPopup(button, "after_start");
    },
  };
}
