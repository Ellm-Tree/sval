/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Draws Favorites as XUL menus from the favorites document
 * (favorites-native spec §5.3): the panel's Favorites menu, and the popup
 * Settings' "Use Favorite…" opens. Each folder is a `menu` filled from
 * `SvalFavoritesStore.children` as it first opens, and every one drawn is
 * drawn again on each change to Favorites, its items kept where they are so
 * the keyboard and an open submenu stay put.
 *
 * Items wear the classes Firefox's bookmarks menus give theirs
 * (`PlacesViewBase._createDOMNodeForPlacesNode`), so they are drawn alike,
 * and carry `data-guid`, which the context menu reads
 * (`SvalFavoritesMenu`). Keyboard, type-ahead and screen readers come with
 * XUL menus.
 *
 * Drag and drop takes what Firefox's `places-popup` takes
 * (`PlacesControllerDragHelper`, `PlacesUIUtils.SUPPORTED_FLAVORS`): an item
 * of the menu itself, reordered or moved into a folder as one document
 * move, and a link, a tab or text that is an address, added as a favorite
 * where it is dropped. A dragged favorite carries its address, so dropping
 * it on a page or another app works as dropping a link does.
 *
 * **Names and addresses are never logged** (Sval `CONTRIBUTING.md` rule 10).
 */

import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  FAVORITE_ICONS_CHANGED_TOPIC:
    "moz-src:///browser/components/sval/SvalFavoriteIcons.sys.mjs",
  FAVORITES_CHANGED_TOPIC:
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
  PlacesUIUtils: "moz-src:///browser/components/places/PlacesUIUtils.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  SvalFavoriteIcons:
    "moz-src:///browser/components/sval/SvalFavoriteIcons.sys.mjs",
  SvalFavorites: "moz-src:///browser/components/sval/SvalFavorites.sys.mjs",
  SvalFavoritesStore:
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
  tidySeparators: "moz-src:///browser/components/sval/SvalPinsRow.sys.mjs",
});

/** An item of a Favorites menu being dragged, by guid. */
export const FAVORITE_DRAG_TYPE = "application/x-sval-favorite";

/** A browser tab being dragged (`PlacesUIUtils`' `TAB_DROP_TYPE`). */
const TAB_DROP_TYPE = "application/x-moz-tabbrowser-tab";

/**
 * Which side of `el` a drop at `clientY` lands on: before it over its top
 * half, after it over the rest, as `places-popup`'s `_getDropPoint` puts an
 * item it is not dropped into. The switcher reorders workspaces by the same
 * rule (`SvalPanel._onSwitcherDrag`), and the strip of them by its halves
 * along the row, given `clientX`.
 *
 * @param {Element} el
 * @param {number} clientY
 * @param {?number} [clientX] For an item in a row, where the drop is along it.
 * @returns {string} `"before"` or `"after"`.
 */
export function dropSide(el, clientY, clientX = null) {
  const { x, y, width, height } = el.getBoundingClientRect();
  if (clientX !== null) {
    return clientX - x <= width / 2 ? "before" : "after";
  }
  return clientY - y <= height / 2 ? "before" : "after";
}

/**
 * Draws the drop line on `el`'s `side`, as `places-popup` draws its
 * indicator between items, and takes it off `previous` when the line moves.
 * `sval-panel.css` draws the line from `data-drop`.
 *
 * @param {?Element} previous The element the line was on.
 * @param {?Element} el
 * @param {?string} [side] `"before"` or `"after"`.
 * @returns {?Element} `el`, the element the line is on now.
 */
export function showDropLine(previous, el, side = null) {
  if (previous && previous !== el) {
    previous.removeAttribute("data-drop");
  }
  el?.setAttribute("data-drop", side);
  return el;
}

/** How long a folder is dragged over before it opens, as `places-popup`'s. */
const HOVER_OPEN_MS = 350;

/** How a favorite's tooltip ends when its address stays on this device. */
export const LOCAL_TOOLTIP = "Only on this device";

/**
 * The label Firefox's bookmarks menus give an item
 * (`PlacesUIUtils.getBestTitle`): its name, or for an unnamed favorite its
 * host and file.
 *
 * @param {object} row
 * @returns {string}
 */
export function labelOf(row) {
  return lazy.PlacesUIUtils.getBestTitle({
    type:
      row.kind === "favorite"
        ? Ci.nsINavHistoryResultNode.RESULT_TYPE_URI
        : Ci.nsINavHistoryResultNode.RESULT_TYPE_FOLDER,
    uri: row.url,
    title: row.name,
  });
}

/**
 * The icon a favorite shows: the one this device keeps for it, else the one
 * history has for its address.
 *
 * @param {string|null} url
 * @returns {string|null}
 */
export function iconOf(url) {
  if (!url || URL.parse(url)?.protocol === "javascript:") {
    return null;
  }
  return (
    lazy.SvalFavoriteIcons.iconFor(url) ??
    `page-icon:${ChromeUtils.encodeURIForSrcset(url)}`
  );
}

/**
 * The addresses a drop brings that is not of a menu item, each `{ uri,
 * title }`, as `PlacesControllerDragHelper.onDrop` reads them: a link, a
 * tab, or text holding an address. Anything else brings none.
 *
 * @param {DataTransfer} dt
 * @returns {Array<{uri: string, title: string}>}
 */
function linksIn(dt) {
  const { PlacesUtils } = lazy;
  const flavors = [
    PlacesUtils.TYPE_X_MOZ_URL,
    TAB_DROP_TYPE,
    PlacesUtils.TYPE_PLAINTEXT,
  ];
  const links = [];
  const seen = new Set();
  for (let i = 0; i < dt.mozItemCount; i++) {
    const types = Array.from(dt.mozTypesAt(i));
    const flavor = flavors.find(f => types.includes(f));
    if (!flavor) {
      continue;
    }
    const data = dt.mozGetDataAt(flavor, i);
    if (flavor === TAB_DROP_TYPE) {
      if (XULElement.isInstance(data) && data.localName === "tab") {
        links.push({
          uri: data.linkedBrowser?.currentURI?.spec ?? "",
          title: data.label,
        });
      }
      continue;
    }
    if (flavor === PlacesUtils.TYPE_PLAINTEXT) {
      // `PlacesUtils.unwrapNodes` reports each line that is no address to the
      // console, so text is read here: one address a line, as it reads it.
      for (const line of String(data).split("\n")) {
        const uri = line.trim();
        const url = uri.startsWith("#") ? null : URL.parse(uri);
        if (url && url.protocol !== "place:" && !seen.has(uri)) {
          seen.add(uri);
          links.push({ uri, title: uri });
        }
      }
      continue;
    }
    try {
      for (const node of PlacesUtils.unwrapNodes(data, flavor).validNodes) {
        if (!seen.has(node.uri)) {
          seen.add(node.uri);
          links.push({ uri: node.uri, title: node.title ?? "" });
        }
      }
    } catch {
      // Text that is no address brings nothing.
    }
  }
  return links.filter(link => URL.parse(link.uri));
}

/**
 * Whether the drag holds something a Favorites menu takes.
 *
 * @param {DataTransfer} dt
 * @returns {boolean}
 */
function acceptable(dt) {
  const { PlacesUtils } = lazy;
  const types = Array.from(dt.types);
  return [
    FAVORITE_DRAG_TYPE,
    PlacesUtils.TYPE_X_MOZ_URL,
    TAB_DROP_TYPE,
    PlacesUtils.TYPE_PLAINTEXT,
  ].some(type => types.includes(type));
}

/**
 * The items of `els` already in `popup` that can stay where they are while
 * the rest move around them: the longest run whose order in the popup is
 * the order of `els`, and of those, one holding an open folder where one
 * does.
 *
 * @param {Element[]} els A folder's items, in the document's order.
 * @param {Element} popup
 * @returns {Set<Element>}
 */
function inOrder(els, popup) {
  const children = [...popup.children];
  const placed = els
    .map(el => ({ el, at: children.indexOf(el) }))
    .filter(({ at }) => at >= 0);
  const weight = ({ el }) => (el.open ? placed.length + 1 : 1);
  // Each item's best run ending in it, and the item before it in that run.
  const best = [];
  const prev = [];
  let end = -1;
  for (let i = 0; i < placed.length; i++) {
    best[i] = weight(placed[i]);
    prev[i] = -1;
    for (let j = 0; j < i; j++) {
      if (
        placed[j].at < placed[i].at &&
        best[j] + weight(placed[i]) > best[i]
      ) {
        best[i] = best[j] + weight(placed[i]);
        prev[i] = j;
      }
    }
    if (end < 0 || best[i] > best[end]) {
      end = i;
    }
  }
  const stay = new Set();
  for (let i = end; i >= 0; i = prev[i]) {
    stay.add(placed[i].el);
  }
  return stay;
}

/** One menu tree of Favorites, from a folder down. */
export class SvalFavoritesView {
  #root;
  #win;
  #onPick;
  #folderPickLabel;
  #dragAndDrop;
  #then;
  #observer;

  /** The item a drop line is drawn on, and the folder hovered to open. */
  #dropOn = null;
  #hover = { folder: null, timer: null };

  /**
   * @param {Element} popup The `menupopup` the folder fills, in its document.
   * @param {string} folderGuid The folder it shows.
   * @param {object} options
   * @param {Function} options.onPick `(row, event)` for a favorite
   *   chosen, or with `folderPickLabel`, a folder chosen.
   * @param {string|null} [options.folderPickLabel] Labels an item at the end
   *   of each folder that picks the folder itself.
   * @param {boolean} [options.dragAndDrop]
   * @param {object|null} [options.then] `{ guid, heading }`: a second
   *   folder whose items follow the first's in the top popup, under a
   *   heading.
   */
  constructor(
    popup,
    folderGuid,
    { onPick, folderPickLabel = null, dragAndDrop = true, then = null }
  ) {
    this.#root = popup;
    this.#onPick = onPick;
    this.#folderPickLabel = folderPickLabel;
    this.#dragAndDrop = dragAndDrop;
    this.#then = then;
    popup.dataset.folderGuid = folderGuid;
    popup.addEventListener("popupshowing", this);
    popup.addEventListener("command", this);
    popup.addEventListener("DOMMenuItemActive", this);
    popup.addEventListener("DOMMenuItemInactive", this);
    if (dragAndDrop) {
      for (const type of [
        "dragstart",
        "dragover",
        "dragleave",
        "drop",
        "dragend",
      ]) {
        popup.addEventListener(type, this);
      }
    }
    this.#observer = { observe: () => this.#redrawOpen() };
    // Icons are read after Favorites, and change as pages show them.
    for (const topic of this.#topics) {
      Services.obs.addObserver(this.#observer, topic);
    }
    this.#win = popup.documentGlobal;
    this.#win.addEventListener("unload", () => this.destroy(), {
      once: true,
    });
  }

  get #topics() {
    return [lazy.FAVORITES_CHANGED_TOPIC, lazy.FAVORITE_ICONS_CHANGED_TOPIC];
  }

  /** Stops following Favorites. */
  destroy() {
    if (!this.#observer) {
      return;
    }
    for (const topic of this.#topics) {
      try {
        Services.obs.removeObserver(this.#observer, topic);
      } catch {
        // Already removed.
      }
    }
    this.#observer = null;
    this.#clearHover();
  }

  handleEvent(event) {
    switch (event.type) {
      case "popupshowing":
        if (event.target.dataset.folderGuid) {
          this.#fill(event.target);
        }
        break;
      case "command":
        this.#onCommand(event);
        break;
      case "DOMMenuItemActive":
      case "DOMMenuItemInactive":
        // The address shows where a link's would, as `places-popup` shows it.
        this.#win.XULBrowserWindow?.setOverLink(
          event.type === "DOMMenuItemActive"
            ? (event.target.dataset.url ?? "")
            : ""
        );
        break;
      case "dragstart":
        this.#onDragStart(event);
        break;
      case "dragover":
        this.#onDragOver(event);
        break;
      case "dragleave":
        if (!event.relatedTarget || !this.#root.contains(event.relatedTarget)) {
          this.#showDrop(null);
        }
        break;
      case "drop":
        this.#onDrop(event);
        break;
      case "dragend":
        this.#showDrop(null);
        this.#clearHover();
        break;
    }
  }

  // ------------------------------------------------------------------ draw

  #redrawOpen() {
    if (!this.#root.isConnected) {
      this.destroy();
      return;
    }
    const popups = [
      this.#root,
      ...this.#root.querySelectorAll("menupopup[data-folder-guid]"),
    ];
    // Every folder drawn once is kept current, open or not, as Firefox's
    // bookmarks menus follow Places; one never opened is drawn as it opens.
    for (const popup of popups) {
      if (popup.hasAttribute("data-drawn")) {
        this.#fill(popup);
      }
    }
  }

  /**
   * Draws a folder's popup from the document, keeping the items it already
   * has for the same favorites.
   *
   * @param {Element} popup
   */
  #fill(popup) {
    const doc = popup.ownerDocument;
    const guid = popup.dataset.folderGuid;
    popup.setAttribute("data-drawn", "");
    const store = lazy.SvalFavoritesStore.readyInstance;
    const rows = store?.children(guid) ?? [];
    const kept = new Map();
    // Items the menu puts ahead of the favorites (`data-fixed`), as the menu
    // bar's Favorites menu does (`SvalMenuBar`), stay at its top.
    for (const el of [...popup.children]) {
      if (el.dataset.guid) {
        kept.set(el.dataset.guid, el);
      } else if (!el.hasAttribute("data-fixed")) {
        el.remove();
      }
    }
    const els = [];
    const place = row => {
      let el = kept.get(row.guid);
      kept.delete(row.guid);
      if (!el || el.dataset.kind !== row.kind) {
        el?.remove();
        el = this.#make(doc, row);
      }
      this.#update(el, row);
      els.push(el);
    };
    rows.forEach(place);
    const then =
      this.#then && popup === this.#root
        ? (store?.children(this.#then.guid) ?? [])
        : [];
    if (then.length) {
      // A `menucaption`, a menu's own heading, which the arrow keys pass
      // over.
      const caption = doc.createXULElement("menucaption");
      caption.setAttribute("label", this.#then.heading);
      els.push(doc.createXULElement("menuseparator"), caption);
      then.forEach(place);
    }
    for (const el of kept.values()) {
      el.remove();
    }
    // Moving an item takes it out of the document, and an open folder's
    // submenu loses its frame (`nsXULPopupManager::PopupDestroyed`). So
    // only the items out of order move, around the longest run already in
    // order, the one holding an open folder where one does.
    const stay = inOrder(els, popup);
    for (let i = els.length - 1; i >= 0; i--) {
      if (!stay.has(els[i])) {
        popup.insertBefore(els[i], i + 1 < els.length ? els[i + 1] : null);
      }
    }
    if (!els.length) {
      // What Firefox's bookmarks menus show for an empty folder
      // (`PlacesViewBase._setEmptyPopupStatus`).
      const empty = doc.createXULElement("menuitem");
      empty.setAttribute("disabled", "true");
      empty.className = "bookmark-item";
      doc.l10n.setAttributes(empty, "places-empty-bookmarks-folder");
      popup.append(empty);
    }
    if (this.#folderPickLabel) {
      const pick = doc.createXULElement("menuitem");
      pick.dataset.pickFolder = guid;
      pick.setAttribute("label", this.#folderPickLabel);
      pick.disabled =
        !lazy.SvalFavoritesStore.readyInstance?.favoritesIn(guid).length;
      popup.append(doc.createXULElement("menuseparator"), pick);
    }
    // A separator the person put between favorites can end up beside
    // another or at an end, with the pins left out or a folder emptied.
    lazy.tidySeparators(popup);
  }

  #make(doc, row) {
    let el;
    if (row.kind === "separator") {
      el = doc.createXULElement("menuseparator");
    } else if (row.kind === "folder") {
      el = doc.createXULElement("menu");
      el.setAttribute("container", "true");
      el.className = "menu-iconic bookmark-item";
      const popup = doc.createXULElement("menupopup");
      popup.setAttribute("nonnative", "");
      popup.dataset.folderGuid = row.guid;
      el.append(popup);
    } else {
      el = doc.createXULElement("menuitem");
      el.className = "menuitem-iconic bookmark-item menuitem-with-favicon";
    }
    el.dataset.guid = row.guid;
    el.dataset.kind = row.kind;
    return el;
  }

  #update(el, row) {
    if (row.kind === "separator") {
      return;
    }
    el.setAttribute("label", labelOf(row));
    if (row.kind === "favorite") {
      el.dataset.url = row.url ?? "";
      el.setAttribute(
        "scheme",
        lazy.PlacesUIUtils.guessUrlSchemeForUI(row.url ?? "")
      );
      const icon = iconOf(row.url);
      if (icon) {
        el.setAttribute("image", icon);
      } else {
        el.removeAttribute("image");
      }
      // Another device's address that no device opens is drawn so it can be
      // deleted, and does nothing else (decision 1372).
      el.toggleAttribute("disabled", row.refused);
      if (row.local) {
        el.setAttribute("tooltiptext", `${labelOf(row)}\n${LOCAL_TOOLTIP}`);
      } else {
        el.removeAttribute("tooltiptext");
      }
    }
    if (this.#dragAndDrop && !row.refused) {
      el.setAttribute("draggable", "true");
    } else {
      el.removeAttribute("draggable");
    }
  }

  #onCommand(event) {
    const el = event.target;
    const store = lazy.SvalFavoritesStore.readyInstance;
    if (!store) {
      return;
    }
    if (el.dataset.pickFolder) {
      const row = store.get(el.dataset.pickFolder);
      if (row) {
        this.#onPick(row, event);
      }
      return;
    }
    const row = el.dataset.guid ? store.get(el.dataset.guid) : null;
    if (row?.kind === "favorite" && !row.refused) {
      this.#onPick(row, event);
    }
  }

  // ---------------------------------------------------------- drag and drop

  #onDragStart(event) {
    const el = event.target;
    const row = el.dataset?.guid
      ? lazy.SvalFavoritesStore.readyInstance?.get(el.dataset.guid)
      : null;
    if (!row || row.refused) {
      return;
    }
    const dt = event.dataTransfer;
    dt.mozSetDataAt(FAVORITE_DRAG_TYPE, row.guid, 0);
    if (row.kind === "favorite" && row.url) {
      dt.mozSetDataAt(
        lazy.PlacesUtils.TYPE_X_MOZ_URL,
        `${row.url}\n${row.name}`,
        0
      );
      dt.mozSetDataAt("text/uri-list", row.url, 0);
      dt.mozSetDataAt(lazy.PlacesUtils.TYPE_PLAINTEXT, row.url, 0);
    }
    event.stopPropagation();
  }

  /**
   * Where a drop at `event` goes, as `places-popup`'s `_getDropPoint` puts
   * it: over a folder's top fifth, before it; its middle, into it; else
   * before or after the item by its halves. Over the popup's empty area or
   * anything else, at the end of the folder. The index is the document's.
   *
   * @param {DragEvent} event
   * @returns {{parentGuid: string, index: number|undefined, el:
   *   Element|null, side: string|null, folder: Element|null}|null}
   */
  #dropPoint(event) {
    let el = event.target;
    const popup = el.closest?.("menupopup[data-folder-guid]");
    if (!popup || !this.#root.contains(popup)) {
      return null;
    }
    const parentGuid = popup.dataset.folderGuid;
    if (el === popup || el.parentNode !== popup || !el.dataset.guid) {
      return {
        parentGuid,
        index: undefined,
        el: null,
        side: null,
        folder: null,
      };
    }
    const row = lazy.SvalFavoritesStore.readyInstance?.get(el.dataset.guid);
    if (!row) {
      return null;
    }
    if (row.kind === "folder") {
      const { y, height } = el.getBoundingClientRect();
      const offset = event.clientY - y;
      if (offset < height * 0.2) {
        return {
          parentGuid,
          index: row.index,
          el,
          side: "before",
          folder: null,
        };
      }
      if (offset < height * 0.8) {
        return {
          parentGuid: row.guid,
          index: undefined,
          el: null,
          side: null,
          folder: el,
        };
      }
    } else if (dropSide(el, event.clientY) === "before") {
      return { parentGuid, index: row.index, el, side: "before", folder: null };
    }
    return {
      parentGuid,
      index: row.index + 1,
      el,
      side: "after",
      folder: null,
    };
  }

  /**
   * Whether the dragged item may go into `parentGuid`: never into itself or
   * anything inside it.
   *
   * @param {DataTransfer} dt
   * @param {string} parentGuid
   * @returns {boolean}
   */
  #canDrop(dt, parentGuid) {
    if (!acceptable(dt)) {
      return false;
    }
    const dragged = dt.types.includes(FAVORITE_DRAG_TYPE)
      ? dt.mozGetDataAt(FAVORITE_DRAG_TYPE, 0)
      : null;
    return (
      !dragged ||
      !lazy.SvalFavoritesStore.readyInstance?.isWithin(parentGuid, dragged)
    );
  }

  #onDragOver(event) {
    event.stopPropagation();
    const point = this.#dropPoint(event);
    if (!point || !this.#canDrop(event.dataTransfer, point.parentGuid)) {
      this.#showDrop(null);
      return;
    }
    event.preventDefault();
    this.#showDrop(point.el, point.side);
    if (point.folder !== this.#hover.folder) {
      this.#clearHover();
      if (point.folder) {
        const folder = point.folder;
        this.#hover.folder = folder;
        folder.setAttribute("_moz-menuactive", "true");
        this.#hover.timer = this.#win.setTimeout(() => {
          this.#hover.timer = null;
          folder.menupopup?.openPopup();
        }, HOVER_OPEN_MS);
      }
    }
  }

  #onDrop(event) {
    event.stopPropagation();
    const dt = event.dataTransfer;
    const point = this.#dropPoint(event);
    this.#showDrop(null);
    this.#clearHover();
    const store = lazy.SvalFavoritesStore.readyInstance;
    if (!point || !store || !this.#canDrop(dt, point.parentGuid)) {
      return;
    }
    event.preventDefault();
    const done = dt.types.includes(FAVORITE_DRAG_TYPE)
      ? store.move(
          dt.mozGetDataAt(FAVORITE_DRAG_TYPE, 0),
          point.parentGuid,
          point.index
        )
      : this.#addLinks(store, linksIn(dt), point);
    done.catch(err =>
      SvalLog.warn(`favorites: a drop was not saved: ${SvalLog.errorName(err)}`)
    );
  }

  async #addLinks(store, links, { parentGuid, index }) {
    // A bookmarklet from outside is asked about first, as Firefox's bookmark
    // dialog would show its address, and a drop holding one is added whole
    // or not at all.
    if (
      links.some(({ uri }) => lazy.SvalFavorites.isBookmarklet(uri)) &&
      !(await lazy.SvalFavorites.confirmBookmarklet(this.#win))
    ) {
      return;
    }
    // A dropped link is a favorite of its own, as a bookmark dropped on
    // Firefox's menus is, whether or not its address is one already, and a
    // drop of several is one change.
    await store.addAll(
      links.map(({ uri, title }) => ({ url: uri, title: title || uri })),
      { parentGuid, index }
    );
  }

  /**
   * Draws the drop line on `el`'s `side`, `before` or `after`, as
   * `places-popup` draws its indicator between items.
   *
   * @param {Element|null} el
   * @param {string|null} [side]
   */
  #showDrop(el, side = null) {
    this.#dropOn = showDropLine(this.#dropOn, el, side);
  }

  #clearHover() {
    const { folder, timer } = this.#hover;
    if (timer) {
      this.#win?.clearTimeout(timer);
    }
    if (folder && !folder.hasAttribute("open")) {
      folder.removeAttribute("_moz-menuactive");
    }
    this.#hover = { folder: null, timer: null };
  }
}
