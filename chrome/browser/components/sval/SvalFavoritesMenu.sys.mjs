/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The Favorites context menu (favorites-native spec §15.2): the one place a
 * favorite or folder is managed. It is a XUL `menupopup`, so the keyboard
 * (Shift+F10, the context-menu key) and assistive technology reach it as
 * they reach every native menu.
 *
 * Firefox's `placesContext` is not used: it carries Firefox's bookmark
 * dialog, tags, the Library and container items, none of which Sval has.
 */

import * as SvalPanelModel from "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs";
import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalFavorites: "moz-src:///browser/components/sval/SvalFavorites.sys.mjs",
  FAVORITES_ROOT:
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
  ROOT_GUIDS: "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
  SvalFavoritesStore:
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
  ariaShortcut: "moz-src:///browser/components/sval/SvalShortcuts.sys.mjs",
  MENU_KEYS: "moz-src:///browser/components/sval/SvalShortcuts.sys.mjs",
  openSvalDialog: "moz-src:///browser/components/sval/SvalDialog.sys.mjs",
  PINS_ROOT: "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
  applyShowIn: "moz-src:///browser/components/sval/SvalPinsRow.sys.mjs",
  fillShowIn: "moz-src:///browser/components/sval/SvalPinsRow.sys.mjs",
  menuItem: "moz-src:///browser/components/sval/SvalPinsRow.sys.mjs",
  showInMenu: "moz-src:///browser/components/sval/SvalPinsRow.sys.mjs",
  tidySeparators: "moz-src:///browser/components/sval/SvalPinsRow.sys.mjs",
  onShowInCommand: "moz-src:///browser/components/sval/SvalPinsRow.sys.mjs",
  showInWorkspaces: "moz-src:///browser/components/sval/SvalPinsRow.sys.mjs",
});

export const FAVORITES_CONTEXT_MENU_ID = "sval-favorites-context-menu";

/** The prefs `OpenInTabsUtils.confirmOpenInTabs` reads. */
const WARN_ON_OPEN_PREF = "browser.tabs.warnOnOpen";
const MAX_OPEN_PREF = "browser.tabs.maxOpenBeforeWarn";

/**
 * Per window, what takes the last {@link SvalFavoritesMenu.attach} away. The
 * panel builds itself again when its document changes, and each build
 * attaches to a new Favorites menu.
 *
 * @type {WeakMap<Window, Function>}
 */
const detachers = new WeakMap();

/**
 * What the menu is about, for the favorite, folder or separator `guid`.
 *
 * @param {string} guid
 * @returns {{guid: string, kind: "favorite"|"folder"|"separator", root:
 *   boolean, title: string, url: string|null, item: object}|null} `item`
 *   is the store's row.
 */
function targetOfGuid(guid) {
  const row = lazy.SvalFavoritesStore.readyInstance?.get(guid) ?? null;
  if (!row) {
    return null;
  }
  return {
    guid,
    kind: row.kind,
    root: lazy.ROOT_GUIDS.includes(guid),
    title: row.name,
    url: row.url,
    item: row,
  };
}

/**
 * The items of `item`'s folder, as the panel's Favorites menu draws them.
 *
 * @param {object} item A store row.
 * @returns {object[]}
 */
function shownSiblings(item) {
  return lazy.SvalFavoritesStore.readyInstance?.children(item.parentGuid) ?? [];
}

/**
 * The item a right-click or the context-menu key landed on: a favorite, a
 * folder, a separator, or the folder whose empty area it was. Each item of
 * a Favorites menu carries its guid, and each folder's popup the folder's
 * (`SvalFavoritesView`).
 *
 * @param {Element} trigger The menu's `triggerNode`.
 * @returns {object|null} As {@link targetOfGuid} describes it.
 */
function targetOf(trigger) {
  for (let el = trigger; el; el = el.parentNode) {
    if (el.dataset?.guid) {
      return targetOfGuid(el.dataset.guid);
    }
    if (el.localName === "menupopup" && el.dataset?.folderGuid) {
      return targetOfGuid(el.dataset.folderGuid);
    }
  }
  return null;
}

/**
 * Whether `event` is the undo key Gecko's editor answers
 * (`ShortcutKeyDefinitions`' `cmd_undo`): Z with the accel key alone.
 *
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
function isUndoKey(event) {
  return (
    event.key.toLowerCase() === "z" &&
    event.getModifierState("Accel") &&
    !event.shiftKey &&
    !event.altKey
  );
}

function plural(n, one, many) {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

export const SvalFavoritesMenu = {
  /**
   * Builds the context menu in `win`'s `#mainPopupSet`, in place of one an
   * earlier build attached, and makes it the context menu of `popup` and
   * every menu inside it.
   *
   * @param {Window} win A browser window.
   * @param {Element} popup The panel's Favorites `menupopup`.
   * @returns {Element} The context menu.
   */
  attach(win, popup) {
    detachers.get(win)?.();
    const doc = win.document;
    const menu = doc.createXULElement("menupopup");
    menu.id = FAVORITES_CONTEXT_MENU_ID;
    const item = (command, label) => lazy.menuItem(doc, command, label);
    const separator = () => doc.createXULElement("menuseparator");
    // Undo names Firefox's undo key, which {@link _onKey} answers here.
    const undo = item("undo", "Undo");
    undo.setAttribute("key", "key_undo");
    undo.setAttribute(
      "aria-keyshortcuts",
      lazy.ariaShortcut({ modifiers: "accel", key: "z" })
    );
    // The home page's row is in pin order, not its favorites' order in
    // their folders, so a tile there moves along the row. Each carries the
    // row's own key for the same move (`home/favorites.js`).
    const rowMove = direction => {
      const el = item(
        direction === "left" ? "moveLeft" : "moveRight",
        direction === "left" ? "Move Left" : "Move Right"
      );
      const key =
        lazy.MENU_KEYS[direction === "left" ? "moveLeft" : "moveRight"];
      el.setAttribute("key", key.id);
      el.setAttribute("aria-keyshortcuts", lazy.ariaShortcut(key));
      return el;
    };
    // Where a pin shows (pins spec §7), for a pin in the row.
    const { menu: showIn, popup: showInPopup } = lazy.showInMenu(doc);
    const moveTo = doc.createXULElement("menu");
    moveTo.dataset.command = "moveTo";
    moveTo.setAttribute("label", "Move to");
    const moveToPopup = doc.createXULElement("menupopup");
    moveTo.append(moveToPopup);

    // Like commands sit together, each kind between separators that
    // `_showing` hides wherever a kind has nothing to show.
    menu.append(
      undo,
      separator(),
      item("open", "Open"),
      item("openWindow", "Open in New Window"),
      item("openPrivate", "Open in Private Window"),
      item("openAll", "Open All"),
      separator(),
      item("pinHome", "Pin"),
      item("pinHere", "Pin to This Workspace"),
      showIn,
      separator(),
      item("rename", "Rename…"),
      item("editAddress", "Edit Address…"),
      item("delete", "Delete"),
      separator(),
      moveTo,
      // Dragging is not the only way to put favorites in order.
      item("moveUp", "Move Up"),
      item("moveDown", "Move Down"),
      rowMove("left"),
      rowMove("right"),
      separator(),
      item("newFolder", "New Folder…"),
      item("newSeparator", "New Separator"),
      separator(),
      item("export", "Export…")
    );

    menu.addEventListener("popupshowing", event => {
      if (event.target === menu) {
        this._showing(win, menu);
      } else if (event.target === showInPopup) {
        const panel = win.SvalPanel;
        lazy.fillShowIn(
          showInPopup,
          menu._svalTarget.guid,
          panel?.nodes ? lazy.showInWorkspaces(panel.nodes, SvalPanelModel) : []
        );
      } else if (event.target === moveToPopup) {
        this._fillMoveTo(win, menu, moveToPopup).catch(err =>
          SvalLog.error(
            `favorites: could not list folders: ${SvalLog.errorName(err)}`
          )
        );
      }
    });
    showInPopup.addEventListener("popuphidden", event => {
      if (event.target === showInPopup) {
        lazy
          .applyShowIn(showInPopup)
          .catch(err =>
            SvalLog.error(
              `favorites: a pin's scope was not saved: ${SvalLog.errorName(err)}`
            )
          );
      }
    });
    menu.addEventListener("command", event => {
      if (event.target.dataset.showIn) {
        lazy.onShowInCommand(showInPopup, event.target);
        return;
      }
      const command = event.target.closest("[data-command], [data-folder]");
      if (!command) {
        return;
      }
      this._run(win, menu, command).catch(err =>
        SvalLog.error(
          `favorites: a menu command failed: ${SvalLog.errorName(err)}`
        )
      );
    });

    menu.addEventListener("popuphidden", event => {
      if (event.target === menu) {
        menu._svalTrigger = null;
        menu._svalGuid = null;
        menu._svalRow = null;
      }
    });

    doc.getElementById("mainPopupSet").append(menu);
    popup.setAttribute("context", FAVORITES_CONTEXT_MENU_ID);
    const onKey = event => this._onKey(popup, menu, event);
    win.addEventListener("keydown", onKey, true);
    win.addEventListener("keypress", onKey, true);
    detachers.set(win, () => {
      win.removeEventListener("keydown", onKey, true);
      win.removeEventListener("keypress", onKey, true);
      menu.remove();
    });
    return menu;
  },

  /**
   * Shift+F10 and the context-menu key, while the Favorites menu is open,
   * open this menu on its highlighted item. Gecko's menu keyboard handling
   * (`nsXULPopupManager::HandleKeyboardEventWithKeyCode`) has no context
   * menu key: it closes the menus on F10 and ignores the other. It listens on
   * the document, so this listener, on the window and capturing, sees the
   * key first.
   *
   * The undo key, while either menu is open, is this menu's Undo
   * (favorites-native spec §15.1). With both closed it stays the focused
   * field's or page's.
   *
   * @param {Element} popup The Favorites menu.
   * @param {Element} menu This context menu.
   * @param {KeyboardEvent} event
   */
  _onKey(popup, menu, event) {
    if (isUndoKey(event) && (popup.state === "open" || menu.state === "open")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === "keydown" && lazy.SvalFavorites.canUndo()) {
        lazy.SvalFavorites.undo().catch(err =>
          SvalLog.error(`favorites: could not undo: ${SvalLog.errorName(err)}`)
        );
      }
      return;
    }
    const wanted =
      event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
    if (!wanted || popup.state !== "open" || menu.state !== "closed") {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type !== "keydown") {
      return;
    }
    let current = popup;
    for (;;) {
      const open = Array.from(
        current.querySelectorAll(":scope > menu[open]")
      ).find(m => m.menupopup?.state === "open");
      if (!open) {
        break;
      }
      current = open.menupopup;
    }
    const anchor =
      current.querySelector(":scope > [_moz-menuactive]") ?? current;
    menu._svalTrigger = anchor;
    menu.openPopup(anchor, { position: "after_start", isContextMenu: true });
  },

  /**
   * Opens the menu on a favorite or folder at a point on the screen, for a
   * view that draws favorites outside the Favorites menu: the home page's
   * row and its folders' panels.
   *
   * @param {Window} win A browser window.
   * @param {string} guid The favorite or folder.
   * @param {object} where
   * @param {number} where.screenX In `win`'s CSS pixels.
   * @param {number} where.screenY
   * @param {object|null} [where.row] For a tile of the home page's row,
   *   `{ left, right, move(direction) }`: which ways it can move along the
   *   row, and the move.
   * @returns {boolean} Whether the menu opened.
   */
  openAt(win, guid, { screenX, screenY, row = null }) {
    const menu = win.document.getElementById(FAVORITES_CONTEXT_MENU_ID);
    if (
      !menu ||
      menu.state !== "closed" ||
      !lazy.SvalFavoritesStore.readyInstance?.get(guid)
    ) {
      return false;
    }
    menu._svalTrigger = null;
    menu._svalGuid = guid;
    menu._svalRow = row;
    menu.openPopupAtScreen(screenX, screenY, true);
    return true;
  },

  /**
   * Shows the items that apply to what the menu opened on (§3).
   *
   * @param {Window} win
   * @param {Element} menu
   */
  _showing(win, menu) {
    const target = menu._svalGuid
      ? targetOfGuid(menu._svalGuid)
      : targetOf(menu._svalTrigger ?? menu.triggerNode);
    if (target) {
      target.row = menu._svalRow ?? null;
    }
    menu._svalTarget = target;
    const kind = target?.kind;
    const movable = !!target && !target.root;
    const { SvalFavorites } = lazy;
    // A bookmarklet runs on the selected tab's page however it is opened
    // (`SvalFavorites.open`), so it has one Open, and none when it can't run.
    const bookmarklet =
      kind === "favorite" && SvalFavorites.isBookmarklet(target.url);
    const siblings = movable ? shownSiblings(target.item) : [];
    const at = siblings.findIndex(row => row.guid === target?.guid);
    const store = lazy.SvalFavoritesStore.readyInstance;
    // A pin, as the home page's tiles show one (decision 0137). Its Move to
    // Favorites is the pin menu's, offered where that menu offers it.
    const pin = movable && !!store?.isPinned(target.guid);
    const inRow = pin && target.item.parentGuid === lazy.PINS_ROOT;
    const show = {
      undo: SvalFavorites.canUndo(),
      open:
        kind === "favorite" &&
        (!bookmarklet || SvalFavorites.bookmarkletsRun()),
      openWindow: kind === "favorite" && !bookmarklet,
      openPrivate: kind === "favorite" && !bookmarklet,
      openAll: kind === "folder",
      // A bookmarklet acts on the selected tab's page, which on the home
      // page is the home page itself, so it is not offered there.
      // A favorite whose address a pin has already is not offered "Pin".
      pinHome: pin
        ? inRow
        : movable &&
          kind !== "separator" &&
          !bookmarklet &&
          !!store &&
          !(kind === "favorite" && store.pinsWithUrl(target.url).length),
      rename: movable && kind !== "separator",
      editAddress: kind === "favorite",
      // Move to lists the folders of Favorites, which hold no pins.
      moveTo: movable && !pin,
      moveUp: movable && !target.row && at > 0,
      moveDown: movable && !target.row && at >= 0 && at < siblings.length - 1,
      moveLeft: !!target?.row,
      moveRight: !!target?.row,
      delete: movable,
      newFolder: true,
      // The row draws no separator (pins-root spec §4).
      newSeparator: !pin,
      export: true,
    };
    // Another device's address that no device opens can only be deleted
    // (decision 1372).
    if (target?.item.refused) {
      for (const command of Object.keys(show)) {
        show[command] = command === "delete";
      }
    }
    for (const el of menu.querySelectorAll(":scope > [data-command]")) {
      el.hidden = !show[el.dataset.command];
    }
    // At either end of the row one way is closed: the item stays, disabled,
    // so the pair keeps its place.
    if (target?.row) {
      menu.querySelector('[data-command="moveLeft"]').disabled =
        !target.row.left;
      menu.querySelector('[data-command="moveRight"]').disabled =
        !target.row.right;
    }
    if (show.pinHome) {
      const item = menu.querySelector('[data-command="pinHome"]');
      item.setAttribute("label", pin ? "Move to Favorites" : "Pin");
      item.dataset.pinned = String(pin);
    }
    // No pins in a private window (pins spec §7), so nowhere to show one.
    menu.querySelector('[data-command="showIn"]').hidden =
      !inRow || !!win.SvalPanel?.inMemory;
    menu.querySelector('[data-command="pinHere"]').hidden =
      !show.pinHome ||
      pin ||
      !win.SvalPanel?.workspaceId ||
      !!win.SvalPanel.inMemory;
    lazy.tidySeparators(menu);
  },

  /**
   * Lists every folder the target can move into, its own folder disabled,
   * and never the target or anything inside it.
   *
   * @param {Window} win
   * @param {Element} menu
   * @param {Element} popup
   * @returns {Promise<void>}
   */
  async _fillMoveTo(win, menu, popup) {
    const target = menu._svalTarget;
    popup.replaceChildren();
    if (!target) {
      return;
    }
    const current = target.item.parentGuid;
    const folders = lazy.SvalFavorites.folders();
    let skipBelow = null;
    // The titles of the folders above the one being listed, by depth: the
    // label's indent shows nesting only to the eye.
    const above = [];
    for (const folder of folders) {
      above[folder.depth] = folder.title || "Untitled folder";
      if (skipBelow !== null) {
        if (folder.depth > skipBelow) {
          continue;
        }
        skipBelow = null;
      }
      if (folder.guid === target.guid) {
        skipBelow = folder.depth;
        continue;
      }
      const el = win.document.createXULElement("menuitem");
      el.dataset.folder = folder.guid;
      el.setAttribute(
        "label",
        `${" ".repeat(folder.depth)}${folder.title || "Untitled folder"}`
      );
      el.setAttribute("aria-label", folder.title || "Untitled folder");
      if (folder.depth > 0) {
        el.setAttribute("aria-description", `in ${above[folder.depth - 1]}`);
      }
      if (folder.guid === current) {
        el.setAttribute("disabled", "true");
      }
      popup.append(el);
    }
  },

  /**
   * @param {Window} win
   * @param {Element} menu
   * @param {Element} el The chosen item.
   * @returns {Promise<void>}
   */
  _run(win, menu, el) {
    const { SvalFavorites } = lazy;
    const target = menu._svalTarget;
    if (el.dataset.folder) {
      return SvalFavorites.move(target.guid, el.dataset.folder);
    }
    const open = (where, isPrivate = false) =>
      SvalFavorites.open(win, target.item, { where, isPrivate });
    const commands = {
      undo: () => SvalFavorites.undo(),
      open: () => open("tab"),
      openWindow: () => open("window"),
      openPrivate: () => open("window", true),
      openAll: () => this._openAll(win, target),
      pinHome: () => {
        const store = lazy.SvalFavoritesStore.readyInstance;
        if (!store?.isPinned(target.guid)) {
          return store?.pin(target.guid);
        }
        // An open pin moved here keeps its page, as a tab, as the pin's
        // own menu does (pins-root spec §6).
        const row = win.SvalPanel?.pins;
        return row
          ? row.moveToFavoritesGuid(target.guid)
          : store.moveToFavorites(target.guid);
      },
      pinHere: () =>
        lazy.SvalFavoritesStore.readyInstance?.pin(target.guid, {
          scope: [win.SvalPanel.workspaceId],
        }),
      rename: () => this._rename(win, target),
      editAddress: () => this._editAddress(win, target),
      moveUp: () => this._moveBy(target, -1),
      moveDown: () => this._moveBy(target, 1),
      moveLeft: () => target.row?.move("left"),
      moveRight: () => target.row?.move("right"),
      delete: () => this._delete(win, target),
      newFolder: () => this._newFolder(win, target),
      newSeparator: () => this._newSeparator(target),
      export: () => win.SvalPanel?.openExport(),
    };
    return Promise.resolve(commands[el.dataset.command]?.());
  },

  /**
   * Moves a favorite, folder or separator past the item drawn next to it in
   * its folder.
   *
   * @param {object} target What the menu opened on (`targetOf`).
   * @param {number} by -1 for up, 1 for down.
   * @returns {Promise<void>}
   */
  async _moveBy(target, by) {
    const { item } = target;
    const siblings = shownSiblings(item);
    const next = siblings[siblings.findIndex(r => r.guid === item.guid) + by];
    if (!next) {
      return;
    }
    // `move` takes the place to insert before, counted with the item still
    // where it is.
    await lazy.SvalFavorites.move(
      target.guid,
      item.parentGuid,
      by > 0 ? next.index + 1 : next.index
    );
  },

  /**
   * Opens every favorite directly in the folder, each a new tab in this
   * window's workspace, the first selected. It asks first when
   * `OpenInTabsUtils.confirmOpenInTabs` would, in Sval's own dialog, and
   * offers that prompt's choice to stop asking.
   *
   * @param {Window} win
   * @param {object} target What the menu opened on (`targetOf`).
   * @returns {Promise<void>}
   */
  async _openAll(win, target) {
    const urls = (
      lazy.SvalFavoritesStore.readyInstance?.favoritesIn(target.guid) ?? []
    ).map(row => row.url);
    if (!urls.length) {
      return;
    }
    if (
      Services.prefs.getBoolPref(WARN_ON_OPEN_PREF) &&
      urls.length >= Services.prefs.getIntPref(MAX_OPEN_PREF)
    ) {
      const answer = await lazy.openSvalDialog(win, {
        title: `Open ${plural(urls.length, "tab", "tabs")}?`,
        body: "Opening this many at once may slow Sval down.",
        checkbox: {
          label: "Warn me when opening multiple tabs might slow down Sval",
          checked: true,
        },
        primary: "Open tabs",
      });
      if (!answer.ok) {
        return;
      }
      if (!answer.checked) {
        Services.prefs.setBoolPref(WARN_ON_OPEN_PREF, false);
      }
    }
    urls.forEach((url, i) =>
      win.openTrustedLinkIn(url, "tab", { inBackground: i > 0 })
    );
  },

  /**
   * @param {Window} win
   * @param {object} target What the menu opened on (`targetOf`).
   * @returns {Promise<void>}
   */
  async _rename(win, target) {
    const folder = target.kind === "folder";
    let heading = folder ? "Rename folder" : "Rename favorite";
    if (lazy.SvalFavoritesStore.readyInstance?.isPinned(target.guid)) {
      heading = folder ? "Rename Pin Folder" : "Rename Pin";
    }
    const answer = await lazy.openSvalDialog(win, {
      icon: "pencil",
      title: heading,
      field: { label: "Name", value: target.title },
      primary: "Rename",
    });
    const title = answer.ok ? answer.value.trim() : "";
    if (title) {
      await lazy.SvalFavorites.rename(target.guid, title);
    }
  },

  /**
   * @param {Window} win
   * @param {object} target What the menu opened on (`targetOf`).
   * @returns {Promise<void>}
   */
  async _editAddress(win, target) {
    const { SvalFavorites } = lazy;
    const answer = await lazy.openSvalDialog(win, {
      icon: "pencil",
      title: "Edit address",
      field: {
        label: "Address",
        value: target.url,
        validate: value =>
          SvalFavorites.addressOf(value)
            ? ""
            : "That isn't an address Sval can open.",
      },
      primary: "Save",
    });
    if (answer.ok) {
      await SvalFavorites.setAddress(target.guid, answer.value);
    }
  },

  /**
   * @param {Window} win
   * @param {object} target What the menu opened on (`targetOf`).
   * @returns {Promise<void>}
   */
  async _delete(win, target) {
    if (target.kind === "folder") {
      const n =
        lazy.SvalFavoritesStore.readyInstance?.countIn(target.guid) ?? 0;
      if (n) {
        const answer = await lazy.openSvalDialog(win, {
          icon: "trash",
          tone: "danger",
          title: `Delete the “${target.title}” folder?`,
          body: `It holds ${plural(n, "favorite", "favorites")}. Undo in this menu brings them back.`,
          primary: "Delete folder",
        });
        if (!answer.ok) {
          return;
        }
      }
    }
    await lazy.SvalFavorites.delete(target.guid);
  },

  /**
   * Makes a folder inside the folder the menu opened in, or beside the item
   * it opened on: a pin folder when that is the pins row or one of its pin
   * folders.
   *
   * @param {Window} win
   * @param {object|null} target What the menu opened on (`targetOf`).
   * @returns {Promise<void>}
   */
  async _newFolder(win, target) {
    let parent = lazy.FAVORITES_ROOT;
    if (target?.kind === "folder") {
      parent = target.guid;
    } else if (target) {
      parent = target.item.parentGuid ?? parent;
    }
    const pins =
      parent === lazy.PINS_ROOT ||
      !!lazy.SvalFavoritesStore.readyInstance?.isPinned(parent);
    const answer = await lazy.openSvalDialog(win, {
      icon: "pencil",
      title: pins ? "Create Pin Folder" : "New folder",
      field: { label: "Name" },
      primary: "Create",
    });
    const title = answer.ok ? answer.value.trim() : "";
    if (title) {
      await lazy.SvalFavorites.newFolder(parent, title);
    }
  },

  /**
   * Puts a separator before the item the menu opened on, or at the end of
   * the folder whose empty area it opened in, as Firefox's own New Separator
   * does (`PlacesViewBase.insertionPoint`).
   *
   * @param {object|null} target What the menu opened on (`targetOf`).
   * @returns {Promise<void>}
   */
  async _newSeparator(target) {
    if (!target || target.root) {
      await lazy.SvalFavorites.newSeparator(
        target?.guid ?? lazy.FAVORITES_ROOT
      );
      return;
    }
    await lazy.SvalFavorites.newSeparator(
      target.item.parentGuid,
      target.item.index
    );
  },
};
