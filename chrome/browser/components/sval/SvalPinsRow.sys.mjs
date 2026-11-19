/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The pins row at the top of the panel (pins spec §4–§8, §12), one per
 * window. It draws the pins the favorites document holds for the workspace
 * the window shows (`SvalPinsModel`), and selects, resets and closes their
 * pages through the window's `SvalPinPages`.
 *
 * Everything it knows of the pins it reads from `SvalFavoritesStore.home()`,
 * again on every change of Favorites; what it knows of a page it asks the
 * pages. It keeps nothing of either between draws but what is on screen. A
 * page closes only for a change the store names (favorites-native spec
 * §5.5), never because its pin is missing from a read.
 *
 * **Names and addresses are never logged** (Sval `CONTRIBUTING.md` rule 10).
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { SvalFirefox } from "moz-src:///browser/components/sval/SvalFirefox.sys.mjs";
import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { SvalPinPages } from "moz-src:///browser/components/sval/SvalPinPages.sys.mjs";
import { SvalScope } from "moz-src:///browser/components/sval/SvalScope.sys.mjs";
import { isPin } from "moz-src:///browser/components/sval/SvalPinTab.sys.mjs";
import {
  NARROW_PANEL_PX,
  PINS_LINES_PREF,
  PINS_QUICK_PEEK_PREF,
  guidsOf,
  layout,
  perLine,
  pinOf,
  pinsInFolder,
  scopeFor,
  slotOf,
  slotsIn,
  numberedSlot,
} from "moz-src:///browser/components/sval/SvalPinsModel.sys.mjs";
import * as SvalPanelModel from "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs";
import * as SvalTree from "moz-src:///browser/components/sval/SvalTree.sys.mjs";
import { htmlElement } from "moz-src:///browser/components/sval/SvalDom.sys.mjs";
import {
  ariaShortcut,
  keyOf,
  shortcutText,
} from "moz-src:///browser/components/sval/SvalKeys.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalWindowWorkspace:
    "moz-src:///browser/components/sval/SvalWindowWorkspace.sys.mjs",
  FAVORITES_CHANGED_TOPIC:
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
  PINS_ROOT: "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
  FAVORITE_ICONS_CHANGED_TOPIC:
    "moz-src:///browser/components/sval/SvalFavoriteIcons.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  SvalFavoriteIcons:
    "moz-src:///browser/components/sval/SvalFavoriteIcons.sys.mjs",
  SvalFavorites: "moz-src:///browser/components/sval/SvalFavorites.sys.mjs",
  LOCAL_TOOLTIP: "moz-src:///browser/components/sval/SvalFavoritesView.sys.mjs",
  refusedAddress:
    "moz-src:///browser/components/sval/SvalSyncableAddress.sys.mjs",
  SvalFavoritesMenu:
    "moz-src:///browser/components/sval/SvalFavoritesMenu.sys.mjs",
  openSvalDialog: "moz-src:///browser/components/sval/SvalDialog.sys.mjs",
  SvalFavoritesStore:
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
  SvalPins: "moz-src:///browser/components/sval/SvalPins.sys.mjs",
  SvalPanelReveal: "moz-src:///browser/components/sval/SvalPanelReveal.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/** A pin dragged along the row, or out of a pin folder's popover. */
const PIN_DRAG_TYPE = "application/x-sval-pin";

/** The name a pin folder made in the row takes (pins-root spec §5). */
const NEW_PIN_FOLDER_NAME = "Untitled pin folder";

/** How long ⌘ is held before the slots show their numbers (§12.3). */
const NUMBERS_AFTER_MS = 400;

const STYLESHEET = "chrome://browser/content/sval/sval-pins.css";

/** The windows `sval-pins.css` is loaded in, which a window takes once. */
const styled = new WeakSet();

/** The menus' ids, one of each per window. */
export const PIN_MENU_ID = "sval-pin-context-menu";
export const ROW_MENU_ID = "sval-pins-row-context-menu";
const POPOVER_ID = "sval-pins-popover";

/**
 * The workspaces "Show in" lists (§7): the user's own, in the switcher's
 * order. An agent's is never one, so a pin the user is signed in to never
 * opens where an agent acts.
 *
 * @param {object} nodes The tree's nodes, by id.
 * @returns {{id: string, name: string}[]}
 */
export function showInWorkspaces(nodes) {
  return SvalTree.workspaceIds(nodes)
    .filter(id => SvalPanelModel.agentLabelOf(nodes, id) === null)
    .map(id => ({
      id,
      name: nodes[id]?.content?.name || "Untitled Workspace",
    }));
}

/**
 * @param {Document} doc
 * @param {string} command The `data-command` a context menu runs it by.
 * @param {string} label
 * @returns {Element} a context menu's `menuitem`.
 */
export function menuItem(doc, command, label) {
  const el = doc.createXULElement("menuitem");
  el.dataset.command = command;
  el.setAttribute("label", label);
  return el;
}

/**
 * Shows a context menu's separators only between two runs of items that both
 * show something, once its items' `hidden` is set.
 *
 * @param {Element} menu A `menupopup`.
 */
export function tidySeparators(menu) {
  let before = false;
  let pending = null;
  for (const el of menu.children) {
    if (el.localName === "menuseparator") {
      el.hidden = true;
      if (before) {
        pending = el;
      }
    } else if (!el.hidden) {
      if (pending) {
        pending.hidden = false;
        pending = null;
      }
      before = true;
    }
  }
}

/**
 * A context menu's "Show in" submenu (§7), empty until `fillShowIn`.
 *
 * @param {Document} doc
 * @returns {{menu: Element, popup: Element}}
 */
export function showInMenu(doc) {
  const menu = doc.createXULElement("menu");
  menu.dataset.command = "showIn";
  menu.setAttribute("label", "Show in");
  const popup = doc.createXULElement("menupopup");
  menu.append(popup);
  return { menu, popup };
}

/**
 * Fills a "Show in" submenu (§7) for the pin `guid`: Select all, Deselect
 * all, then one checkbox per workspace, ticked where it shows. The items
 * leave the menu open while the user ticks (`closemenu="none"`).
 *
 * @param {Element} popup The submenu's `menupopup`.
 * @param {string} guid
 * @param {{id: string, name: string}[]} workspaces
 */
export function fillShowIn(popup, guid, workspaces) {
  const doc = popup.ownerDocument;
  const scope = lazy.SvalFavoritesStore.readyInstance?.pinScopeOf(guid) ?? null;
  const live = (scope ?? []).filter(id => workspaces.some(w => w.id === id));
  popup.replaceChildren();
  const item = (label, command) => {
    const el = doc.createXULElement("menuitem");
    el.setAttribute("label", label);
    el.setAttribute("closemenu", "none");
    el.dataset.showIn = command;
    return el;
  };
  popup.append(
    item("Select all", "all"),
    item("Deselect all", "none"),
    doc.createXULElement("menuseparator")
  );
  for (const { id, name } of workspaces) {
    const el = item(name, "workspace");
    el.setAttribute("type", "checkbox");
    // Ticked by `onShowInCommand`, so every way a box is chosen ticks it
    // once.
    el.setAttribute("autocheck", "false");
    el.dataset.workspace = id;
    if (!live.length || live.includes(id)) {
      el.setAttribute("checked", "true");
    }
    popup.append(el);
  }
  popup._svalShowIn = {
    guid,
    before: scope,
    workspaces: workspaces.map(w => w.id),
  };
}

/**
 * Handles a command in a "Show in" submenu: Select all and Deselect all
 * tick every box or none.
 *
 * @param {Element} popup
 * @param {Element} item The item chosen.
 */
export function onShowInCommand(popup, item) {
  const command = item.dataset.showIn;
  if (command === "workspace") {
    if (item.getAttribute("checked") === "true") {
      item.removeAttribute("checked");
    } else {
      item.setAttribute("checked", "true");
    }
  } else if (command === "all" || command === "none") {
    for (const box of popup.querySelectorAll("[data-workspace]")) {
      if (command === "all") {
        box.setAttribute("checked", "true");
      } else {
        box.removeAttribute("checked");
      }
    }
  }
}

/**
 * Writes what a "Show in" submenu holds as it closes (§7). Every box ticked
 * is every workspace; none ticked drops the change. The Favorites menu's
 * Undo puts the scope back (`SvalFavoritesStore.setPinScope`).
 *
 * @param {Element} popup
 * @returns {Promise<void>}
 */
export async function applyShowIn(popup) {
  const state = popup._svalShowIn;
  popup._svalShowIn = null;
  const store = lazy.SvalFavoritesStore.readyInstance;
  if (!state || !store) {
    return;
  }
  const ticked = [...popup.querySelectorAll("[data-workspace]")]
    .filter(box => box.getAttribute("checked") === "true")
    .map(box => box.dataset.workspace);
  const scope = scopeFor(ticked, state.workspaces);
  if (scope === undefined) {
    return;
  }
  const same = (a, b) =>
    JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  // Every workspace that exists ticked reads back as the same as before when
  // the pin was in every workspace already.
  if (same(scope, state.before) || (scope === null && !state.before)) {
    return;
  }
  await store.setPinScope(state.guid, scope);
}

/**
 * Deletes the pin or pin folder `guid` (pins-root spec §7). The
 * Favorites menu's Undo brings it back at its place in the row with its
 * scope (`SvalFavoritesStore.delete`).
 *
 * @param {string} guid
 * @returns {Promise<void>}
 */
export async function deletePin(guid) {
  await lazy.SvalFavorites.delete(guid);
}

/**
 * The caption a folder's tile, wide with one of its pins, names the folder
 * by over the pin's name, as a named split names itself over its panes.
 *
 * @param {Document} doc
 * @param {object} folder The pin folder.
 * @returns {Element}
 */
function pinFolderCaption(doc, folder) {
  const caption = htmlElement(doc, "span", {
    className: "sval-pin-folder-name",
  });
  caption.textContent = folder.name || NEW_PIN_FOLDER_NAME;
  return caption;
}

/**
 * The key held for Firefox's numbered tab keys, which pins take over: its
 * `key_selectTab1` names the modifier, `accel` on most platforms and `alt` on
 * GNOME (`NUM_SELECT_TAB_MODIFIER`, browser-sets.inc.xhtml).
 *
 * @param {Document} doc A browser window's document.
 * @returns {string} A `KeyboardEvent.key` value.
 */
function numberModifierKey(doc) {
  const modifier = doc
    .getElementById("key_selectTab1")
    ?.getAttribute("modifiers");
  if (modifier === "alt") {
    return "Alt";
  }
  return AppConstants.platform === "macosx" ? "Meta" : "Control";
}

/** One window's pins row. */
export class SvalPinsRow {
  #window;
  #panel;
  #pages;

  /** The block in the panel: the lines, then the hairline. */
  #block;
  #linesEl;
  #dropZone;
  #dropLine;

  /** `home()` as last read, and whether it has been. */
  #tiles = [];
  #loaded = false;

  /** The store the row listens to, and how to stop. */
  #store = null;
  #stopStore = null;

  /** What the last draw drew: the slots, and the laid-out lines. */
  #slots = [];
  #drawn = { lines: [], hidden: [] };

  /** Slot elements by key, kept across draws so a widening animates. */
  #els = new Map();

  #width = 0;
  #resize = null;
  #favicons = new Map();

  /** The item holding the row's roving focus, by key. */
  #focusKey = null;

  /** The pin the pointer pressed on was already selected. */
  #pressedSelected = false;

  #numbersTimer = null;
  #menu = null;
  #popover = null;
  #observer = {
    observe: (subject, topic, data) => {
      if (data === PINS_QUICK_PEEK_PREF) {
        // Each page holds the setting it was told; tell them again.
        for (const tab of this.#window.gBrowser.tabs) {
          if (SvalPinPages.pageOfTab(tab)) {
            lazy.SvalPins.tellPage(tab);
          }
        }
        return;
      }
      this.refresh();
    },
  };

  /** The pin dragged from the row. A tab's drag is the panel's (`draggedId`). */
  #drag = null;

  /** What the row listens to on anything other than its own block. */
  #listening = new SvalScope();

  /**
   * @param {Window} win A browser window.
   * @param {object} panel The window's `SvalPanel`.
   * @param {Element} block The element the panel put where the row goes.
   */
  constructor(win, panel, block) {
    this.#window = win;
    this.#panel = panel;
    this.#block = block;
    const doc = win.document;
    if (!styled.has(win)) {
      styled.add(win);
      win.windowUtils.loadSheetUsingURIString(
        STYLESHEET,
        win.windowUtils.AUTHOR_SHEET
      );
    }
    block.classList.add("sval-pins");
    block.setAttribute("role", "toolbar");
    block.setAttribute("aria-label", "Pins");
    this.#linesEl = htmlElement(doc, "div", { className: "sval-pins-lines" });
    this.#dropZone = htmlElement(doc, "div", { className: "sval-pins-drop" });
    this.#dropZone.textContent = "Drop to pin";
    this.#dropZone.setAttribute("aria-hidden", "true");
    this.#dropLine = htmlElement(doc, "div", {
      className: "sval-pins-drop-line",
    });
    this.#dropLine.hidden = true;
    const hairline = htmlElement(doc, "div", {
      className: "sval-pins-hairline",
    });
    block.append(this.#linesEl, this.#dropZone, this.#dropLine, hairline);
    block.hidden = true;

    this.#pages = SvalPinPages.for(win, {
      workspaceId: () => lazy.SvalWindowWorkspace.of(this.#window).id,
      jar: () => win.gBrowser.defaultUserContextId ?? 0,
      onChange: () => this.#pagesChanged(),
      onViewed: (workspaceId, guid) =>
        this.#panel.notePinViewed(workspaceId, guid),
    });

    for (const type of [
      "click",
      "mousedown",
      "keydown",
      "contextmenu",
      "dragstart",
      "dragend",
      "dragover",
      "dragleave",
      "drop",
    ]) {
      block.addEventListener(type, this);
    }
    // The panel's own drags show the drop zone while they last (§4). The
    // panel ends them through `dragEnded`.
    const root = block.parentNode;
    const listen = (target, type, capture = false) => {
      if (target) {
        this.#listening.listen(target, type, this, capture);
      }
    };
    listen(root, "dragstart");
    listen(win, "keydown", true);
    listen(win, "keyup", true);
    listen(win, "blur");
    listen(win, "command", true);

    this.#resize = new win.ResizeObserver(entries => {
      const width = entries.at(-1)?.contentRect?.width ?? 0;
      if (Math.round(width) !== Math.round(this.#width)) {
        this.#width = width;
        this.render();
      }
    });
    this.#resize.observe(panel.container);

    // Firefox's own pinned tabs are not used anywhere (pins spec §8.1): a
    // pin is Sval's, made from the panel's "Pin".
    const tabMenu = doc.getElementById("tabContextMenu");
    const hideFirefoxPins = () => {
      for (const id of [
        "context_pinTab",
        "context_unpinTab",
        "context_pinSelectedTabs",
        "context_unpinSelectedTabs",
      ]) {
        const item = tabMenu.querySelector(`#${id}`);
        if (item) {
          item.hidden = true;
        }
      }
    };
    if (tabMenu) {
      this.#listening.listen(tabMenu, "popupshowing", hideFirefoxPins);
    }

    this.#listening.topic(lazy.FAVORITES_CHANGED_TOPIC, this.#observer);
    this.#listening.topic(lazy.FAVORITE_ICONS_CHANGED_TOPIC, this.#observer);
    this.#listening.pref(PINS_LINES_PREF, this.#observer);
    this.#listening.pref(PINS_QUICK_PEEK_PREF, this.#observer);
    win.addEventListener("unload", () => this.stop(), { once: true });
    this.refresh();
  }

  stop() {
    this.#listening.end();
    this.#stopStore?.();
    this.#stopStore = null;
    this.#store = null;
    this.#resize?.disconnect();
  }

  /** The window's pin pages. */
  get pages() {
    return this.#pages;
  }

  /**
   * Whether this window shows pins at all (§7): never in a private window or
   * an agent's workspace.
   *
   * @returns {boolean}
   */
  get #enabled() {
    const panel = this.#panel;
    return (
      !panel.inMemory &&
      !panel.isPrivate &&
      !!lazy.SvalWindowWorkspace.of(this.#window).id &&
      !panel.agentLabel
    );
  }

  /**
   * Reads the pins again from the store's last read, and draws them.
   *
   * @returns {Promise<void>}
   */
  async refresh() {
    const store = lazy.SvalFavoritesStore.readyInstance;
    this.#listenTo(store);
    if (this.#window.closed) {
      return;
    }
    this.#tiles = store ? store.home() : [];
    this.#loaded = !!store;
    this.render();
  }

  /**
   * Listens to the store the row reads, which tests and a profile's restart
   * can replace, for the changes it names.
   *
   * @param {object|null} store
   */
  #listenTo(store) {
    if (store === this.#store) {
      return;
    }
    this.#stopStore?.();
    this.#store = store;
    this.#stopStore = store?.addChangeListener(change =>
      this.#closeForChange(change)
    );
  }

  /**
   * Closes the pages a change takes from this window (spec §5.5): those of a
   * favorite removed, here or by a pass, and those of a favorite changed so
   * that its pin no longer shows in the page's workspace, such as an unpin,
   * a "Show in" change, or a move out of a pin folder. A folder's change
   * reaches the pages of everything inside it. A page whose favorite is
   * simply missing from a read is left alone.
   *
   * @param {{changed: string[], removed: string[]}} change
   */
  #closeForChange({ changed, removed }) {
    const store = this.#store;
    if (!store || this.#window.closed || (!changed.length && !removed.length)) {
      return;
    }
    const named = new Set(removed);
    const within = guid => {
      named.add(guid);
      for (const child of store.children(guid)) {
        within(child.guid);
      }
    };
    changed.forEach(within);
    const tiles = store.home();
    const nodes = this.#panel.nodes ?? {};
    const { WORKSPACE } = SvalTree;
    const workspaces = new Set(
      Object.keys(nodes).filter(id => nodes[id]?.kind === WORKSPACE)
    );
    const removedHere = new Set(removed);
    this.#pages.closeWhere(named, (guid, workspaceId) => {
      if (removedHere.has(guid)) {
        return true;
      }
      return !slotsIn(tiles, workspaceId, workspaces)
        .flatMap(guidsOf)
        .includes(guid);
    });
  }

  /** The pins that show in this window's workspace, in the row's order. */
  get slots() {
    if (!this.#enabled) {
      return [];
    }
    const { WORKSPACE } = SvalTree;
    const nodes = this.#panel.nodes ?? {};
    const workspaces = new Set(
      Object.keys(nodes).filter(id => nodes[id]?.kind === WORKSPACE)
    );
    // A pin whose delete waits on any window's Undo message is left out
    // (`SvalPanel.pendingPinGuids`).
    const deleting = this.#panel.pendingPinGuids?.() ?? new Set();
    return slotsIn(
      this.#tiles,
      lazy.SvalWindowWorkspace.of(this.#window).id,
      workspaces
    ).filter(slot => !deleting.has(slot.guid));
  }

  /**
   * @param {string} guid
   * @returns {object|null} the pin of that guid among {@link slots}, or null
   *   when it does not show in this window's workspace.
   */
  pinOf(guid) {
    return pinOf(this.slots, guid);
  }

  /**
   * The pin selected in this window, or null.
   *
   * @returns {object|null} `{ guid, name, url }`.
   */
  get selectedPin() {
    const guid = this.#pages.selectedGuid;
    return guid ? pinOf(this.#slots, guid) : null;
  }

  #pagesChanged() {
    this.render();
    this.#panel.onPinSelectionChanged?.();
  }

  // ------------------------------------------------------------------ draw

  render() {
    const win = this.#window;
    const doc = win.document;
    const slots = this.slots;
    this.#slots = slots;
    if (this.#loaded && this.#enabled) {
      this.#pages.follow(
        slots.flatMap(slot =>
          slot.kind === "folder" ? pinsInFolder(slot) : [slot]
        )
      );
    }
    const nodes = this.#panel.nodes ?? {};
    this.#pages.tidy(
      lazy.SvalWindowWorkspace.of(this.#window).id,
      new Set(
        Object.keys(nodes).filter(id => nodes[id]?.kind === SvalTree.WORKSPACE)
      )
    );

    const dragging = !!this.#drag || !!this.#draggedTab();
    this.#block.hidden = !this.#enabled || (!slots.length && !dragging);
    this.#block.toggleAttribute("data-empty", !slots.length);
    if (this.#block.hidden || !slots.length) {
      this.#linesEl.replaceChildren();
      this.#els = new Map();
      this.#drawn = { lines: [], hidden: [] };
      return;
    }
    const width =
      this.#width || this.#panel.container.getBoundingClientRect().width;
    const narrow = width <= NARROW_PANEL_PX;
    const columns = perLine(width);
    const lines = Math.max(1, Services.prefs.getIntPref(PINS_LINES_PREF, 4));
    this.#drawn = layout(slots, { columns, lines, narrow });
    this.#block.toggleAttribute("data-narrow", narrow);

    const selectedGuid = this.#pages.selectedGuid;
    const selectedSlot = slotOf(slots, selectedGuid);
    const hiddenSelected =
      !!selectedSlot && this.#drawn.hidden.includes(selectedSlot);

    const hadFocus = this.#block.contains(doc.activeElement);
    const lineEls = [...this.#linesEl.children];
    const wanted = new Map();
    this.#drawn.lines.forEach((line, i) => {
      let lineEl = lineEls[i];
      if (!lineEl) {
        lineEl = htmlElement(doc, "div", { className: "sval-pins-line" });
        this.#linesEl.append(lineEl);
      }
      // A pin past the line limit widens nothing: "+N" looks selected.
      const wide = narrow
        ? -1
        : line.findIndex(slot => !!slot && slot === selectedSlot);
      const cols = Array.from({ length: narrow ? 1 : columns }, (_, c) =>
        c === wide ? "3fr" : "1fr"
      );
      lineEl.style.gridTemplateColumns = cols.join(" ");
      const children = line.map(slot => {
        const key = slot ? `pin:${slot.guid}` : "more";
        const el = this.#slotElement(key, slot, {
          selected: slot ? slot === selectedSlot : hiddenSelected,
          wide: !narrow && !!slot && slot === selectedSlot,
          selectedGuid,
          index: slot ? slots.indexOf(slot) : -1,
        });
        wanted.set(key, el);
        return el;
      });
      lineEl.replaceChildren(...children);
    });
    for (const extra of lineEls.slice(this.#drawn.lines.length)) {
      extra.remove();
    }
    this.#els = wanted;
    this.#paintFocus(hadFocus);
  }

  /**
   * The slot's tile, emptied and set up again as a plain pin tile. The tile
   * is kept from one draw to the next: an open popover is anchored to it,
   * and Gecko places a popup whose anchor has no frame against the whole
   * window (`nsMenuPopupFrame`).
   *
   * @param {Element} el The slot.
   * @param {string} key
   * @returns {Element}
   */
  #emptyTile(el, key) {
    const tile =
      el.querySelector(":scope > button.sval-pin") ??
      htmlElement(this.#window.document, "button");
    for (const { name } of [...tile.attributes]) {
      tile.removeAttribute(name);
    }
    tile.replaceChildren();
    el.replaceChildren(tile);
    tile.className = "sval-pin";
    tile.dataset.key = key;
    tile.type = "button";
    tile.setAttribute("tabindex", "-1");
    return tile;
  }

  /**
   * The element for one slot, kept from the last draw when it had one.
   *
   * @param {string} key
   * @param {object|null} slot A pin or a pin folder; null for "+N".
   * @param {object} state
   * @param {boolean} state.selected Whether it shows selected.
   * @param {boolean} state.wide Whether it is the selected pin's wide tile.
   * @param {string|null} state.selectedGuid The pin selected in the window.
   * @param {number} state.index Its place among the slots, or -1 for "+N".
   * @returns {Element}
   */
  #slotElement(key, slot, { selected, wide, selectedGuid, index }) {
    const doc = this.#window.document;
    let el = this.#els.get(key);
    if (!el) {
      el = htmlElement(doc, "div", { className: "sval-pin-slot" });
      el.dataset.key = key;
    }
    const tile = this.#emptyTile(el, key);
    el.toggleAttribute("data-selected", selected);
    el.toggleAttribute("data-wide", wide);
    el.toggleAttribute("data-open", this.#popover?.key === key);
    if (index >= 0 && index < 9) {
      el.dataset.number = String(index + 1);
    } else {
      delete el.dataset.number;
    }

    if (!slot) {
      const n = this.#drawn.hidden.length;
      tile.classList.add("sval-pin-more");
      tile.textContent = `+${n}`;
      tile.setAttribute("aria-label", `${n} more pins`);
      tile.setAttribute("aria-haspopup", "dialog");
      tile.title = `${n} more pins`;
      for (const attr of ["data-off", "data-unloaded", "data-folder"]) {
        el.removeAttribute(attr);
      }
      return el;
    }

    const folder = slot.kind === "folder";
    el.toggleAttribute("data-folder", folder);
    // The pin this slot shows as wide: itself, or its folder's selected pin.
    const pin = folder
      ? (pinsInFolder(slot).find(p => p.guid === selectedGuid) ?? null)
      : slot;
    const state = pin ? this.#pages.stateOf(pin.guid) : null;
    el.toggleAttribute("data-unloaded", !folder && !state?.loaded);
    el.toggleAttribute("data-off", !!state?.off);
    el.toggleAttribute("data-playing", !!state?.playing);
    el.toggleAttribute("data-muted", !!state?.muted);
    el.toggleAttribute("data-attention", !!state?.attention && !selected);

    if (folder) {
      const plate = htmlElement(doc, "span", { className: "sval-pin-plate" });
      for (const inner of pinsInFolder(slot).slice(0, 4)) {
        plate.append(this.#iconElement(inner, "sval-pin-plate-icon"));
      }
      tile.append(plate);
      tile.setAttribute("aria-haspopup", "dialog");
    } else {
      tile.append(this.#iconElement(slot, "sval-pin-icon"));
    }
    tile.draggable = true;
    const name = folder && wide && pin ? pin.name : slot.name;
    tile.title = folder && pin ? `${slot.name}: ${pin.name}` : name;
    tile.setAttribute("aria-label", name || "Untitled pin");
    if (!folder) {
      tile.setAttribute("aria-pressed", selected ? "true" : "false");
    }
    if (wide) {
      const label = htmlElement(doc, "span", { className: "sval-pin-label" });
      const nameEl = htmlElement(doc, "span", { className: "sval-pin-name" });
      const pinName = (folder ? pin?.name : slot.name) || "Untitled pin";
      // Off its saved page the tile has room for one name, and the favicon
      // already says whose page it is, so it names the page; the tooltip
      // keeps both.
      if (state?.off && state.title) {
        nameEl.textContent = state.title;
        tile.title = `${pinName} / ${state.title}`;
        tile.setAttribute("aria-description", state.title);
      } else {
        nameEl.textContent = pinName;
      }
      if (folder && pin) {
        label.append(pinFolderCaption(doc, slot));
      }
      label.append(nameEl);
      tile.append(label);
      if (state?.off && pin) {
        const refresh = htmlElement(doc, "button", {
          className: "sval-pin-refresh",
        });
        refresh.type = "button";
        refresh.dataset.key = `refresh:${pin.guid}`;
        refresh.setAttribute("tabindex", "-1");
        refresh.setAttribute(
          "aria-label",
          `Back to ${pin.name || "saved page"}`
        );
        refresh.title = `Back to ${pin.name || "saved page"}`;
        el.append(refresh);
      }
    }
    // The numbered tab key that selects the slot (`#onCommand`), as the user
    // has it.
    const numberKey =
      index >= 0 && index < 9
        ? doc.getElementById(
            index < 8 ? `key_selectTab${index + 1}` : "key_selectLastTab"
          )
        : null;
    if (numberKey?.hasAttribute("key") || numberKey?.hasAttribute("keycode")) {
      tile.title += ` (${shortcutText(keyOf(numberKey))})`;
      tile.setAttribute("aria-keyshortcuts", ariaShortcut(keyOf(numberKey)));
    }
    if (pin?.local) {
      tile.title += `\n${lazy.LOCAL_TOOLTIP}`;
    }
    if (state?.playing && !folder) {
      const audio = htmlElement(doc, "button", { className: "sval-pin-audio" });
      audio.type = "button";
      audio.dataset.key = `audio:${slot.guid}`;
      audio.setAttribute("tabindex", "-1");
      audio.setAttribute(
        "aria-label",
        state.muted ? `Unmute ${slot.name}` : `Mute ${slot.name}`
      );
      el.append(audio);
    }
    return el;
  }

  /**
   * A pin's favicon: its page's own while it has one, else the one Firefox
   * keeps for the saved address, else its first letter.
   *
   * @param {object} pin
   * @param {string} className
   * @returns {Element}
   */
  #iconElement(pin, className) {
    const doc = this.#window.document;
    const live = this.#pages.tabOf(pin.guid)?.getAttribute("image");
    const img = htmlElement(doc, "img", { className });
    img.setAttribute("alt", "");
    img.setAttribute("aria-hidden", "true");
    const cached =
      live ||
      lazy.SvalFavoriteIcons.iconFor(pin.url) ||
      this.#favicons.get(pin.url);
    if (cached) {
      img.setAttribute("src", cached);
      return img;
    }
    const letter = htmlElement(doc, "span", {
      className: `${className} sval-pin-letter`,
    });
    letter.setAttribute("aria-hidden", "true");
    letter.textContent = (pin.name || pin.url || "?")
      .trim()
      .charAt(0)
      .toUpperCase();
    this.#fetchIcon(pin.url);
    return letter;
  }

  async #fetchIcon(url) {
    if (!url || this.#favicons.has(url) || !/^https?:/i.test(url)) {
      return;
    }
    this.#favicons.set(url, null);
    try {
      const favicon = await lazy.PlacesUtils.favicons.getFaviconForPage(
        Services.io.newURI(url)
      );
      if (favicon) {
        this.#favicons.set(url, favicon.dataURI.spec);
        if (!this.#window.closed) {
          this.render();
        }
      }
    } catch {
      // No favicon kept for it: the letter stays.
    }
  }

  // ------------------------------------------------------------- selecting

  /**
   * Selects a pin's page (§5).
   *
   * @param {object} pin
   */
  select(pin) {
    if (!pin?.url) {
      return;
    }
    this.#closePopover();
    this.#pages.select(pin);
    lazy.SvalPanelReveal.dismiss(this.#window);
  }

  /**
   * ⌘1–9 (§3): the `n`th slot in this workspace. A pin folder opens its
   * popover.
   *
   * @param {number} n
   * @returns {boolean} whether a slot was there.
   */
  selectNumber(n) {
    const slot = numberedSlot(this.#slots, n);
    if (!slot) {
      return false;
    }
    if (slot.kind === "folder") {
      this.render();
      const el = this.#els.get(`pin:${slot.guid}`);
      this.#openPopover(
        el?.firstChild ?? this.#block,
        slot.name,
        pinsAndFolders(slot),
        slot
      );
    } else {
      this.select(slot);
    }
    return true;
  }

  /** @param {string} key */
  #slotByKey(key) {
    if (key === "more") {
      return null;
    }
    const guid = key.slice(key.indexOf(":") + 1);
    return this.#slots.find(slot => slot.guid === guid) ?? null;
  }

  #activate(target) {
    const key = target.dataset.key;
    if (!key) {
      return;
    }
    this.#focusKey = key;
    if (key === "more") {
      this.#openPopover(
        target,
        `${this.#drawn.hidden.length} more pins`,
        this.#drawn.hidden,
        null
      );
      return;
    }
    if (key.startsWith("refresh:")) {
      const guid = key.slice("refresh:".length);
      const pin = pinOf(this.#slots, guid);
      if (pin && this.#pressedSelected) {
        this.#pages.reset(guid, pin.url);
      }
      return;
    }
    if (key.startsWith("audio:")) {
      const tab = this.#pages.tabOf(key.slice("audio:".length));
      tab?.toggleMuteAudio();
      return;
    }
    const slot = this.#slotByKey(key);
    if (!slot) {
      return;
    }
    if (slot.kind === "folder") {
      this.#openPopover(target, slot.name, pinsAndFolders(slot), slot);
      return;
    }
    // A click on the rest of a selected pin's tile does nothing (§5).
    if (this.#pages.selectedGuid !== slot.guid) {
      this.select(slot);
    }
  }

  // ---------------------------------------------------------------- events

  handleEvent(event) {
    switch (event.type) {
      case "mousedown":
        if (event.currentTarget === this.#block) {
          // The refresh button acts only on a pin already selected when the
          // press began, so a double-click from another tab only selects.
          const slotEl = event.target.closest?.(".sval-pin-slot");
          const key = slotEl?.querySelector(".sval-pin")?.dataset.key ?? "";
          const slot = this.#slotByKey(key);
          const selected = this.#pages.selectedGuid;
          // A press that continues a double-click keeps what its first
          // press found, which is what the user saw when they began.
          if (event.detail <= 1) {
            this.#pressedSelected =
              !!slot && !!selected && guidsOf(slot).includes(selected);
          }
        }
        break;
      case "click": {
        const target = event.target.closest?.("button[data-key]");
        if (target && event.button === 0) {
          if (event.detail === 0) {
            // A key press: the selection it acts on is the one there is.
            const selected = this.#pages.selectedGuid;
            const slot = this.#slotByKey(
              target.closest(".sval-pin-slot")?.querySelector(".sval-pin")
                ?.dataset.key ?? ""
            );
            this.#pressedSelected =
              !!slot && !!selected && guidsOf(slot).includes(selected);
          }
          event.stopPropagation();
          this.#activate(target);
        }
        break;
      }
      case "contextmenu":
        this.#onContextMenu(event);
        break;
      case "keydown":
        if (event.currentTarget === this.#block) {
          this.#onRowKey(event);
        } else {
          this.#onWindowKey(event);
        }
        break;
      case "keyup":
      case "blur":
        this.#hideNumbers();
        break;
      case "command":
        this.#onCommand(event);
        break;
      case "dragstart":
        this.#onDragStart(event);
        break;
      case "dragend":
        this.dragEnded();
        break;
      case "dragover":
        this.#onDragOver(event);
        break;
      case "dragleave":
        if (!this.#block.contains(event.relatedTarget)) {
          this.#dropLine.hidden = true;
          this.#block.removeAttribute("data-drop-over");
        }
        break;
      case "drop":
        this.#onDrop(event);
        break;
    }
  }

  /**
   * ⌘1–9 select pins in place of Firefox's tabs (§3, decision 0137). Its
   * keys run as `command` events on `<key>` elements in `mainKeyset`, whose
   * own listener selects tabs (`browser-sets.js`); this captures them first.
   * A private window and an agent's workspace keep Firefox's.
   *
   * @param {Event} event
   */
  #onCommand(event) {
    const id = event.target?.id ?? "";
    const match = /^key_selectTab([1-8])$/.exec(id);
    let n = match ? Number(match[1]) : 0;
    if (id === "key_selectLastTab") {
      n = 9;
    }
    if (!n || !this.#enabled) {
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    this.render();
    this.selectNumber(n);
  }

  /**
   * ⌘ held shows the slots' numbers (§12.3).
   *
   * @param {KeyboardEvent} event
   */
  #onWindowKey(event) {
    const held = numberModifierKey(this.#window.document);
    if (event.key !== held || event.repeat) {
      if (event.key !== held) {
        this.#hideNumbers();
      }
      return;
    }
    lazy.clearTimeout(this.#numbersTimer);
    this.#numbersTimer = lazy.setTimeout(() => {
      this.#block.setAttribute("data-numbers", "true");
    }, NUMBERS_AFTER_MS);
  }

  #hideNumbers() {
    lazy.clearTimeout(this.#numbersTimer);
    this.#numbersTimer = null;
    this.#block.removeAttribute("data-numbers");
  }

  // -------------------------------------------------------------- keyboard

  /** The row's focusable items in reading order. */
  #items() {
    return [...this.#block.querySelectorAll("button[data-key]")];
  }

  #paintFocus(hadFocus) {
    const items = this.#items();
    if (!items.length) {
      return;
    }
    let current = items.find(el => el.dataset.key === this.#focusKey);
    if (!current) {
      current =
        items.find(el =>
          el.closest(".sval-pin-slot")?.hasAttribute("data-selected")
        ) ?? items[0];
      this.#focusKey = current.dataset.key;
    }
    for (const el of items) {
      el.setAttribute("tabindex", el === current ? "0" : "-1");
    }
    if (hadFocus) {
      current.focus();
    }
  }

  #focus(el) {
    if (!el) {
      return;
    }
    this.#focusKey = el.dataset.key;
    for (const item of this.#items()) {
      item.setAttribute("tabindex", item === el ? "0" : "-1");
    }
    el.focus();
  }

  /**
   * The row is one tab stop (§12.3): the arrows move between its items, Up
   * and Down by line, Down from the last line into the tab list; Enter and
   * Space press, as a button's own keys do.
   *
   * @param {KeyboardEvent} event
   */
  #onRowKey(event) {
    const items = this.#items();
    const current = event.target.closest?.("button[data-key]");
    const at = items.indexOf(current);
    if (at < 0) {
      return;
    }
    const lineOf = el => el.closest(".sval-pins-line");
    let next = null;
    switch (event.key) {
      case "ArrowRight":
        next = items[at + 1];
        break;
      case "ArrowLeft":
        next = items[at - 1];
        break;
      case "Home":
        next = items[0];
        break;
      case "End":
        next = items.at(-1);
        break;
      case "ArrowDown":
      case "ArrowUp": {
        const lines = [...this.#linesEl.children];
        const line = lines.indexOf(lineOf(current));
        const column = [...lineOf(current).children].indexOf(
          current.closest(".sval-pin-slot")
        );
        const target = lines[line + (event.key === "ArrowDown" ? 1 : -1)];
        if (!target) {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            this.#panel.focusTreeFromPins?.();
          }
          return;
        }
        const slots = [...target.children];
        next =
          slots[Math.min(column, slots.length - 1)]?.querySelector(
            "button.sval-pin"
          );
        break;
      }
      case "ContextMenu":
        event.preventDefault();
        this.#openMenuFor(current, null);
        return;
      default:
        if (event.key === "F10" && event.shiftKey) {
          event.preventDefault();
          this.#openMenuFor(current, null);
        }
        return;
    }
    if (next) {
      event.preventDefault();
      this.#focus(next);
    }
  }

  /** Focus enters the row from the panel, on its roving item. */
  focus() {
    const items = this.#items();
    const current =
      items.find(el => el.dataset.key === this.#focusKey) ?? items[0];
    this.#focus(current);
    return !!current;
  }

  // --------------------------------------------------------------- popover

  /**
   * Opens the popover of a pin folder, or of the pins past the line
   * limit (§6, §12.4), under the tile it opened from.
   *
   * @param {Element} anchor
   * @param {string} caption
   * @param {object[]} items Pins and folders, in order.
   * @param {object|null} folder The pin folder, or null for "+N".
   */
  #openPopover(anchor, caption, items, folder) {
    const doc = this.#window.document;
    let panel = doc.getElementById(POPOVER_ID);
    if (!panel) {
      panel = doc.createXULElement("panel");
      panel.id = POPOVER_ID;
      panel.className = "sval-pins-popover";
      panel.setAttribute("noautofocus", "true");
      panel.setAttribute("sval-stem-host", "");
      panel.setAttribute("role", "dialog");
      // The popover's window reaches past what it draws, over the row, so a
      // pin dragged out of it would never reach the row. It closes once the
      // drag leaves what it draws, as Firefox's bookmark menus close
      // (`places-menupopup.js`), except where closing the drag's source
      // popup ends the drag.
      panel.addEventListener("dragover", event => {
        if (
          this.#drag &&
          !event.target.closest?.(".sval-pins-popover-box") &&
          !panel.isWaylandDragSource
        ) {
          this.#closePopover();
        }
      });
      doc.getElementById("mainPopupSet").append(panel);
    }
    const key = anchor?.dataset?.key ?? null;
    const state = { anchor, key, stack: [{ caption, items, folder }] };
    this.#popover = state;
    panel.addEventListener(
      "popuphidden",
      event => {
        if (event.target !== panel) {
          return;
        }
        if (this.#popover === state) {
          this.#popover = null;
        }
        for (const el of this.#block.querySelectorAll("[data-open]")) {
          el.removeAttribute("data-open");
        }
      },
      { once: true }
    );
    this.#drawPopover(panel);
    anchor?.closest(".sval-pin-slot")?.setAttribute("data-open", "true");
    const narrow = this.#block.hasAttribute("data-narrow");
    // Beside the 48px panel's column the popover opens at the tile's end,
    // and its stem grows from that side (`SvalStem`).
    const end =
      this.#window.getComputedStyle(anchor).direction === "rtl"
        ? "left"
        : "right";
    panel.setAttribute("sval-stem-side", narrow ? end : "bottom");
    panel.openPopup(anchor, narrow ? "end_before" : "after_start", 0, 0);
    panel.addEventListener(
      "popupshown",
      () => panel.querySelector("button[data-guid]")?.focus(),
      { once: true }
    );
  }

  #closePopover() {
    this.#window.document.getElementById(POPOVER_ID)?.hidePopup();
  }

  #drawPopover(panel) {
    const doc = this.#window.document;
    const state = this.#popover;
    const level = state.stack.at(-1);
    panel.replaceChildren();
    const box = htmlElement(doc, "div", { className: "sval-pins-popover-box" });
    const head = htmlElement(doc, "div", {
      className: "sval-pins-popover-head",
    });
    if (state.stack.length > 1) {
      const back = htmlElement(doc, "button", {
        className: "sval-pins-popover-back",
      });
      back.type = "button";
      const parent = state.stack.at(-2).caption;
      back.setAttribute("aria-label", `Back to ${parent}`);
      back.addEventListener("click", () => {
        state.stack.pop();
        this.#drawPopover(panel);
        panel.querySelector("button[data-guid]")?.focus();
      });
      head.append(back);
    }
    const title = htmlElement(doc, "span", {
      className: "sval-pins-popover-title",
    });
    title.textContent = level.caption || NEW_PIN_FOLDER_NAME;
    head.append(title);
    panel.setAttribute("aria-label", level.caption || "Pins");
    const grid = htmlElement(doc, "div", {
      className: "sval-pins-popover-grid",
    });
    const selected = this.#pages.selectedGuid;
    for (const item of level.items) {
      const cell = htmlElement(doc, "div", { className: "sval-pin-slot" });
      const tile = htmlElement(doc, "button", { className: "sval-pin" });
      tile.type = "button";
      tile.dataset.guid = item.guid;
      tile.title = item.name;
      tile.setAttribute("aria-label", item.name || "Untitled pin");
      // Dragged onto the row, a pin leaves its pin folder (pins-root spec §5).
      tile.draggable = true;
      tile.addEventListener("dragstart", event => {
        event.dataTransfer.setData(PIN_DRAG_TYPE, item.guid);
        event.dataTransfer.effectAllowed = "move";
        this.#drag = { pin: item.guid, kind: item.kind };
      });
      tile.addEventListener("dragend", () => this.dragEnded());
      if (item.kind === "folder") {
        cell.setAttribute("data-folder", "true");
        const plate = htmlElement(doc, "span", { className: "sval-pin-plate" });
        for (const inner of pinsInFolder(item).slice(0, 4)) {
          plate.append(this.#iconElement(inner, "sval-pin-plate-icon"));
        }
        tile.append(plate);
        tile.addEventListener("click", () => {
          state.stack.push({
            caption: item.name,
            items: pinsAndFolders(item),
            folder: item,
          });
          this.#drawPopover(panel);
          panel.querySelector("button[data-guid]")?.focus();
        });
      } else {
        const st = this.#pages.stateOf(item.guid);
        cell.toggleAttribute("data-selected", item.guid === selected);
        cell.toggleAttribute("data-unloaded", !st?.loaded);
        cell.toggleAttribute("data-off", !!st?.off);
        tile.setAttribute(
          "aria-pressed",
          item.guid === selected ? "true" : "false"
        );
        tile.append(this.#iconElement(item, "sval-pin-icon"));
        tile.addEventListener("click", () => this.select(item));
      }
      tile.addEventListener("contextmenu", event => {
        event.preventDefault();
        this.#openMenuFor(tile, event, item);
      });
      cell.append(tile);
      grid.append(cell);
    }
    grid.addEventListener("keydown", event => {
      const tiles = [...grid.querySelectorAll("button[data-guid]")];
      const at = tiles.indexOf(event.target);
      const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 4, ArrowUp: -4 }[
        event.key
      ];
      if (at >= 0 && step) {
        event.preventDefault();
        tiles[Math.max(0, Math.min(tiles.length - 1, at + step))]?.focus();
      }
    });
    box.append(head, grid);
    panel.append(box);
  }

  // ------------------------------------------------------------------ menu

  #onContextMenu(event) {
    const target = event.target.closest?.("button[data-key]");
    event.preventDefault();
    event.stopPropagation();
    if (!target) {
      this.#openRowMenu(event);
      return;
    }
    this.#openMenuFor(target, event);
  }

  /**
   * The row's own menu, on the row outside its tiles: New Pin Folder…
   * (pins-root spec §5).
   *
   * @param {MouseEvent} event
   */
  #openRowMenu(event) {
    const doc = this.#window.document;
    let menu = doc.getElementById(ROW_MENU_ID);
    if (!menu) {
      menu = doc.createXULElement("menupopup");
      menu.id = ROW_MENU_ID;
      menu.append(menuItem(doc, "newPinFolder", "New Pin Folder…"));
      menu.addEventListener("command", () =>
        lazy.SvalFavoritesMenu._newFolder(this.#window, {
          guid: lazy.PINS_ROOT,
          kind: "folder",
        }).catch(err =>
          SvalLog.warn(
            `pins: a pin folder was not made: ${SvalLog.errorName(err)}`
          )
        )
      );
      doc.getElementById("mainPopupSet").append(menu);
    }
    if (event.screenX) {
      menu.openPopupAtScreen(event.screenX, event.screenY, true);
    } else {
      menu.openPopup(this.#block, "after_start", 0, 0, true);
    }
  }

  /**
   * @param {Element} anchor
   * @param {MouseEvent|null} event
   * @param {object} [item] A pin or folder from a popover.
   */
  #openMenuFor(anchor, event, item = null) {
    let slot = item;
    if (!slot) {
      const key =
        anchor.closest(".sval-pin-slot")?.querySelector(".sval-pin")?.dataset
          .key ?? "";
      slot = this.#slotByKey(key);
    }
    if (!slot) {
      return;
    }
    // A folder's selected pin is what its wide tile shows, so its menu is
    // that pin's.
    if (!item && slot.kind === "folder" && anchor.closest("[data-wide]")) {
      const selected = this.#pages.selectedGuid;
      slot = pinsInFolder(slot).find(p => p.guid === selected) ?? slot;
    }
    const menu = this.#ensureMenu();
    menu._svalPin = {
      pin: slot,
      top:
        this.#slots.includes(slot) ||
        this.#slots.some(s => s.guid === slot.guid),
    };
    if (event && event.screenX) {
      menu.openPopupAtScreen(event.screenX, event.screenY, true);
    } else {
      menu.openPopup(anchor, "after_start", 0, 0, true);
    }
  }

  #ensureMenu() {
    if (this.#menu?.isConnected) {
      return this.#menu;
    }
    const doc = this.#window.document;
    const menu = doc.createXULElement("menupopup");
    menu.id = PIN_MENU_ID;
    const item = (command, label) => menuItem(doc, command, label);
    const { menu: showIn, popup: showInPopup } = showInMenu(doc);
    const moveTo = doc.createXULElement("menu");
    moveTo.dataset.command = "moveToPinFolder";
    moveTo.setAttribute("label", "Move to Pin Folder");
    const moveToPopup = doc.createXULElement("menupopup");
    moveTo.append(moveToPopup);
    menu.append(
      item("reset", "Back to saved page"),
      item("saveCurrent", "Save current page as this pin"),
      doc.createXULElement("menuseparator"),
      showIn,
      moveTo,
      doc.createXULElement("menuseparator"),
      item("rename", "Rename…"),
      item("editAddress", "Edit address…"),
      doc.createXULElement("menuseparator"),
      item("moveContents", "Move Contents to Row"),
      item("moveToFavorites", "Move to Favorites"),
      item("delete", "Delete")
    );
    menu.addEventListener("popupshowing", event => {
      if (event.target === menu) {
        this.#menuShowing(menu);
      } else if (event.target === showInPopup) {
        fillShowIn(
          showInPopup,
          menu._svalPin.pin.guid,
          showInWorkspaces(this.#panel.nodes ?? {})
        );
      } else if (event.target === moveToPopup) {
        this.#fillMoveTo(moveToPopup, menu._svalPin.pin);
      }
    });
    showInPopup.addEventListener("popuphidden", event => {
      if (event.target === showInPopup) {
        applyShowIn(showInPopup).catch(err =>
          SvalLog.warn(`pins: a scope was not saved: ${SvalLog.errorName(err)}`)
        );
      }
    });
    menu.addEventListener("command", event => {
      if (event.target.dataset.showIn) {
        onShowInCommand(showInPopup, event.target);
        return;
      }
      const pin = menu._svalPin.pin;
      const folder = event.target.dataset.folder;
      const done = folder
        ? lazy.SvalFavoritesStore.readyInstance?.movePin(pin.guid, {
            parentGuid: folder,
          })
        : this.#run(event.target.dataset.command, pin);
      Promise.resolve(done).catch(err =>
        SvalLog.warn(`pins: a menu command failed: ${SvalLog.errorName(err)}`)
      );
    });
    doc.getElementById("mainPopupSet").append(menu);
    this.#menu = menu;
    return menu;
  }

  /**
   * Lists the row's pin folders in "Move to Pin Folder" (pins-root spec
   * §5), the pin's own disabled.
   *
   * @param {Element} popup
   * @param {object} pin
   */
  #fillMoveTo(popup, pin) {
    const doc = this.#window.document;
    const store = lazy.SvalFavoritesStore.readyInstance;
    const current = store?.get(pin.guid)?.parentGuid;
    popup.replaceChildren();
    for (const folder of store?.pinFolders() ?? []) {
      const el = doc.createXULElement("menuitem");
      el.dataset.folder = folder.guid;
      el.setAttribute("label", folder.name || NEW_PIN_FOLDER_NAME);
      if (folder.guid === current) {
        el.setAttribute("disabled", "true");
      }
      popup.append(el);
    }
  }

  #menuShowing(menu) {
    const { pin, top } = menu._svalPin;
    const folder = pin.kind === "folder";
    const state = folder ? null : this.#pages.stateOf(pin.guid);
    const show = {
      reset: !folder,
      saveCurrent: !folder,
      // A pin inside a pin folder goes where its folder goes (§7).
      showIn: top,
      moveToPinFolder:
        !folder && !!lazy.SvalFavoritesStore.readyInstance?.pinFolders().length,
      rename: true,
      editAddress: !folder,
      // A folder in a folder's popover has the row only beyond its parent.
      moveContents: folder && top,
      moveToFavorites: top,
      delete: true,
    };
    for (const el of menu.querySelectorAll(":scope > [data-command]")) {
      el.hidden = !show[el.dataset.command];
    }
    for (const command of ["reset", "saveCurrent"]) {
      menu
        .querySelector(`[data-command="${command}"]`)
        .toggleAttribute("disabled", !state?.off);
    }
    tidySeparators(menu);
  }

  async #run(command, pin) {
    const win = this.#window;
    const menuApi = lazy.SvalFavoritesMenu;
    const target = {
      guid: pin.guid,
      kind: pin.kind === "folder" ? "folder" : "favorite",
      title: pin.name,
      url: pin.url,
    };
    switch (command) {
      case "reset":
        this.#pages.reset(pin.guid, pin.url);
        return;
      case "saveCurrent": {
        const url = this.#pages.currentUrl(pin.guid);
        if (url) {
          await lazy.SvalFavorites.setAddress(pin.guid, url);
          this.#pages.saved(pin.guid, url);
        }
        return;
      }
      case "rename":
        await menuApi._rename(win, target);
        return;
      case "editAddress":
        await menuApi._editAddress(win, target);
        return;
      case "moveContents":
        await lazy.SvalFavoritesStore.readyInstance?.moveContentsOut(pin.guid);
        return;
      case "moveToFavorites":
        await this.moveToFavorites(pin);
        return;
      case "delete":
        await this.#deleteHeld(pin);
    }
  }

  /**
   * Deletes a pin or a pin folder once the panel's Undo message goes
   * (`SvalPanel.deferDelete`). Its tile leaves every window's row at once,
   * and its pages in this window close at once, as closing a pin's page
   * does: a page holds nothing a pin keeps.
   *
   * @param {object} pin
   */
  async #deleteHeld(pin) {
    const { guid } = pin;
    await this.#panel.deferDelete(
      `Deleted the “${pin.name}” pin`,
      {
        pins: [guid],
        undo: () => this.#panel.renderPinsEverywhere(),
        commit: () => deletePin(guid),
      },
      () => {
        for (const each of pin.kind === "folder" ? guidsOf(pin) : [guid]) {
          this.#pages.close(each);
        }
        this.#panel.renderPinsEverywhere();
      }
    );
  }

  /**
   * Moves the pin or pin folder `guid` to Favorites, as
   * {@link moveToFavorites}.
   *
   * @param {string} guid
   * @returns {Promise<void>}
   */
  moveToFavoritesGuid(guid) {
    const pin = this.#tiles.find(tile => tile.guid === guid) ?? {
      guid,
      kind: "favorite",
    };
    return this.moveToFavorites(pin);
  }

  /**
   * Moves a pin or a pin folder to the end of Favorites (pins-root spec
   * §6). An open page becomes a normal tab at the top of the tab list. The
   * move is made at once, and the panel's Undo message offers to take it
   * back ({@link #undoMoveToFavorites}), so its commit has nothing left to
   * make.
   *
   * @param {object} pin
   */
  async moveToFavorites(pin) {
    const released = [];
    for (const guid of guidsOf(pin)) {
      const was = SvalPinPages.pageOfTab(this.#pages.tabOf(guid));
      const tab = this.#pages.release(guid);
      if (tab && was) {
        released.push({ tab, was: { ...was } });
      }
    }
    let entry = null;
    try {
      entry =
        (await lazy.SvalFavoritesStore.readyInstance?.moveToFavorites(
          pin.guid
        )) ?? null;
    } finally {
      // Released, each page is a tab no node describes until it is filed.
      const observer = this.#panel.observer;
      for (const { tab } of released.toReversed()) {
        await observer?.fileTab(tab, { atTop: true });
      }
    }
    const name =
      pin.name ?? lazy.SvalFavoritesStore.readyInstance?.get(pin.guid)?.name;
    await this.#panel.deferDelete(
      `Moved “${name}” to Favorites`,
      {
        undo: () => this.#undoMoveToFavorites(pin.guid, entry, released),
        commit: () => [],
      },
      () => {}
    );
  }

  /**
   * The panel's Undo of Move to Favorites: the pin is back at its place in
   * the row with its scope, and each page the move made a tab leaves the
   * tree and is the pin's page again, as it was. A tab closed or moved to
   * another window meanwhile stays where it is.
   *
   * @param {string} guid The pin or pin folder moved.
   * @param {object|null} entry The move's Undo entry in the store.
   * @param {Array<{tab: object, was: object}>} released
   */
  async #undoMoveToFavorites(guid, entry, released) {
    const store = lazy.SvalFavoritesStore.readyInstance;
    if (entry) {
      await store?.undoChange(entry);
    }
    if (!store?.isPinned(guid)) {
      return;
    }
    await this.refresh();
    const observer = this.#panel.observer;
    for (const { tab, was } of released) {
      if (tab.closing || tab.documentGlobal !== this.#window || isPin(tab)) {
        continue;
      }
      this.#pages.take(tab, was, was);
      lazy.SvalPins.tellPage(tab);
      await observer?.unfile(tab);
    }
  }

  // ---------------------------------------------------------- drag and drop

  /**
   * Whether the tab `id` can be pinned (§8.1): a web page's tab that is no
   * split's pane, in a window that shows pins.
   *
   * @param {string} id A tab's node id.
   * @returns {boolean}
   */
  canPin(id) {
    const panel = this.#panel;
    const { isPane } = SvalPanelModel;
    const { TAB } = SvalTree;
    const node = id && panel.nodes?.[id];
    return (
      this.#enabled &&
      node?.kind === TAB &&
      !isPane(panel.nodes, id) &&
      /^(https?|file):/i.test(node.content?.url ?? "") &&
      !lazy.refusedAddress(node.content)
    );
  }

  /** The tab node the panel's drag carries, when it can be pinned. */
  #draggedTab() {
    const id = this.#panel.draggedId;
    return id && this.canPin(id) ? id : null;
  }

  #onDragStart(event) {
    if (event.currentTarget === this.#block) {
      const tile = event.target.closest?.("button.sval-pin[data-key^='pin:']");
      const slot = tile && this.#slotByKey(tile.dataset.key);
      if (!slot) {
        return;
      }
      event.stopPropagation();
      event.dataTransfer.setData(PIN_DRAG_TYPE, slot.guid);
      event.dataTransfer.effectAllowed = "move";
      this.#drag = { pin: slot.guid, kind: slot.kind };
      tile.closest(".sval-pin-slot").setAttribute("data-dragging", "true");
      return;
    }
    // A drag from the tree, which the panel's own listener on the tree has
    // recorded by the time it bubbles here.
    if (
      event.dataTransfer?.types?.includes(SvalPanelModel.NODE_DRAG_TYPE) &&
      this.#draggedTab()
    ) {
      this.render();
    }
  }

  /**
   * Ends a drag over the row: a pin's, from its tile's `dragend`, or a tab's,
   * which the panel ends from the dragged row itself (`_endDrag`), since a
   * redraw can take that row out of the panel before its `dragend`.
   */
  dragEnded() {
    for (const el of this.#linesEl.querySelectorAll("[data-dragging]")) {
      el.removeAttribute("data-dragging");
    }
    this.#drag = null;
    this.#dropLine.hidden = true;
    this.#block.removeAttribute("data-drop-over");
    this.render();
  }

  /**
   * Where a drop at the pointer lands: into a pin folder tile's middle, onto
   * a pin's middle to make a pin folder of the two (pins-root spec §5), or
   * before the slot index the gap nearest the pointer opens on.
   *
   * @param {DragEvent} event
   * @returns {{index: number, folder: object|null, onto: object|null, el:
   *   Element|null}}
   */
  #dropPlace(event) {
    const slotEls = [...this.#linesEl.querySelectorAll(".sval-pin-slot")];
    let best = {
      index: this.#slots.length,
      folder: null,
      onto: null,
      el: null,
      before: true,
    };
    const pin = this.#drag?.pin ?? null;
    // A pin folder dragged only moves along the row.
    const pinDrag = !!pin && this.#drag.kind !== "folder";
    let bestDistance = Infinity;
    for (const el of slotEls) {
      const tile = el.querySelector(".sval-pin");
      const slot = this.#slotByKey(tile?.dataset.key ?? "");
      if (!slot) {
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (event.clientY < rect.top || event.clientY > rect.bottom) {
        continue;
      }
      const index = this.#slots.indexOf(slot);
      const third = rect.width / 3;
      const middle =
        event.clientX > rect.left + third && event.clientX < rect.right - third;
      if (middle && slot.guid !== pin) {
        if (slot.kind === "folder" && (pinDrag || this.#draggedTab())) {
          return { index, folder: slot, onto: null, el, before: true };
        }
        if (slot.kind !== "folder" && pinDrag) {
          return { index, folder: null, onto: slot, el, before: true };
        }
      }
      const mid = rect.left + rect.width / 2;
      const before = event.clientX < mid;
      const distance = Math.abs(
        event.clientX - (before ? rect.left : rect.right)
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        best = {
          index: before ? index : index + 1,
          folder: null,
          onto: null,
          el,
          before,
        };
      }
    }
    return best;
  }

  #onDragOver(event) {
    const types = event.dataTransfer?.types ?? [];
    const ours = types.includes(PIN_DRAG_TYPE) && this.#drag?.pin;
    const tab =
      types.includes(SvalPanelModel.NODE_DRAG_TYPE) && this.#draggedTab();
    if (!ours && !tab) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    this.#block.setAttribute("data-drop-over", "true");
    const place = this.#dropPlace(event);
    for (const el of this.#linesEl.querySelectorAll("[data-drop-into]")) {
      el.removeAttribute("data-drop-into");
    }
    if (place.folder || place.onto) {
      place.el.setAttribute("data-drop-into", "true");
      this.#dropLine.hidden = true;
      return;
    }
    if (!place.el) {
      this.#dropLine.hidden = true;
      return;
    }
    const rect = place.el.getBoundingClientRect();
    const host = this.#block.getBoundingClientRect();
    const x = (place.before ? rect.left - 2 : rect.right + 2) - host.left - 1;
    this.#dropLine.style.insetInlineStart = `${x}px`;
    this.#dropLine.style.top = `${rect.top - host.top}px`;
    this.#dropLine.style.height = `${rect.height}px`;
    this.#dropLine.hidden = false;
  }

  async #onDrop(event) {
    const types = event.dataTransfer?.types ?? [];
    const place = this.#dropPlace(event);
    const tabId = types.includes(SvalPanelModel.NODE_DRAG_TYPE)
      ? this.#draggedTab()
      : null;
    const pinGuid = types.includes(PIN_DRAG_TYPE) ? this.#drag?.pin : null;
    if (!tabId && !pinGuid) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.#dropLine.hidden = true;
    const slots = this.#slots;
    const neighbours = (index, except) => {
      const others = slots.filter(slot => slot.guid !== except);
      const at = slots
        .slice(0, index)
        .filter(slot => slot.guid !== except).length;
      return {
        afterGuid: others[at - 1]?.guid ?? null,
        beforeGuid: others[at]?.guid ?? null,
      };
    };
    for (const el of this.#linesEl.querySelectorAll("[data-drop-into]")) {
      el.removeAttribute("data-drop-into");
    }
    try {
      if (pinGuid) {
        this.#drag = null;
        this.#closePopover();
        await this.#dropPin(pinGuid, place, neighbours(place.index, pinGuid));
        return;
      }
      await this.pinTab(
        tabId,
        place.folder
          ? { folderGuid: place.folder.guid }
          : neighbours(place.index, null)
      );
    } catch (err) {
      SvalLog.warn(`pins: a drop was not pinned: ${SvalLog.errorName(err)}`);
    } finally {
      this.render();
    }
  }

  /**
   * Drops the pin `guid`, from the row or a pin folder's popover, where
   * `place` says (pins-root spec §5): into a pin folder, onto a pin to make a
   * pin folder of the two once the Create Pin Folder dialog names it, or
   * into the row between `where`'s pins. Cancelling the dialog leaves both
   * pins as they were. A pin moved along the row is not taken back by Undo;
   * one taken out of a pin folder is.
   *
   * @param {string} guid
   * @param {object} place As {@link #dropPlace} answers it.
   * @param {{afterGuid: string|null, beforeGuid: string|null}} where
   */
  async #dropPin(guid, place, where) {
    const store = lazy.SvalFavoritesStore.readyInstance;
    if (!store) {
      return;
    }
    if (place.folder) {
      await store.movePin(guid, { parentGuid: place.folder.guid });
      return;
    }
    if (place.onto) {
      const answer = await lazy.openSvalDialog(this.#window, {
        icon: "pencil",
        title: "Create Pin Folder",
        field: { label: "Name", value: NEW_PIN_FOLDER_NAME },
        primary: "Create",
      });
      if (answer.ok) {
        await store.folderOf(
          place.onto.guid,
          guid,
          answer.value.trim() || NEW_PIN_FOLDER_NAME
        );
      }
      return;
    }
    await store.movePin(guid, where, {
      undoable: store.get(guid)?.parentGuid !== lazy.PINS_ROOT,
    });
  }

  /**
   * Pins a tab (pins-root spec §6): a pin of its address and title in the
   * row between `afterGuid` and `beforeGuid` or at its end, or at the end of
   * `folderGuid`, and no favorite. The tab leaves the tab list and becomes
   * the pin's page in this workspace, as it was.
   *
   * @param {string} id The tab's node id.
   * @param {object} [where]
   * @param {string|null} [where.folderGuid]
   * @param {string|null} [where.afterGuid]
   * @param {string|null} [where.beforeGuid]
   * @param {boolean} [where.thisWorkspace] Whether the pin shows in this
   *   workspace alone (pins spec §7), a pin in the row only.
   * @returns {Promise<string|null>} the new pin's guid.
   */
  async pinTab(
    id,
    {
      folderGuid = null,
      afterGuid = null,
      beforeGuid = null,
      thisWorkspace = false,
    } = {}
  ) {
    const panel = this.#panel;
    const store = lazy.SvalFavoritesStore.readyInstance;
    const node = panel.nodes?.[id];
    let url = node?.content?.url;
    if (!url || !this.canPin(id) || !store) {
      return null;
    }
    const observer = panel.observer;
    const tab = observer?.tabFor(id) ?? null;
    // The tab's own address: the node's follows it a moment behind. An
    // address read from the node keeps the node's mark.
    let local = node.content.local === true;
    if (tab && !tab.closing) {
      url = SvalFirefox.isLazy(tab)
        ? (SvalFirefox.lazyUrl(tab) ?? url)
        : Services.io.createExposableURI(tab.linkedBrowser.currentURI).spec;
      local = undefined;
    }
    const name = (tab?.label || node.content?.name || url).trim();
    // Undo takes the pin back; the page goes back to being a tab first, as
    // Move to Favorites leaves it, so the tab the user pinned is kept.
    let made = null;
    const beforeUndo = async () => {
      const page = made && this.#pages.release(made);
      if (page) {
        await this.#panel.observer?.fileTab(page, { atTop: true });
      }
    };
    const parentGuid = folderGuid ?? lazy.PINS_ROOT;
    // The row's slots leave out pins limited elsewhere, so the place is
    // found among the pins root's children.
    const siblings = store.children(parentGuid);
    const at = guid => siblings.findIndex(row => row.guid === guid);
    let index = null;
    if (!folderGuid && beforeGuid && at(beforeGuid) >= 0) {
      index = at(beforeGuid);
    } else if (!folderGuid && afterGuid && at(afterGuid) >= 0) {
      index = at(afterGuid) + 1;
    }
    const guid = await store.add({
      url,
      title: name,
      parentGuid,
      index,
      scope:
        !folderGuid && thisWorkspace
          ? [lazy.SvalWindowWorkspace.of(this.#window).id]
          : null,
      duplicate: true,
      beforeUndo,
      local,
    });
    // A folder another device deleted takes nothing, and the tab stays one.
    if (!guid) {
      return null;
    }
    made = guid;
    // The row holds the pin before the page is its.
    await this.refresh();
    if (tab && !tab.closing) {
      this.#pages.take(tab, { guid, url, name: name || url });
      lazy.SvalPins.tellPage(tab);
      await observer.unfile(tab);
    }
    return guid;
  }
}

/**
 * A folder's pins and subfolders, in folder order, as its popover lists
 * them (§6).
 *
 * @param {object} folder
 * @returns {object[]}
 */
function pinsAndFolders(folder) {
  return (folder.children ?? []).filter(
    child => child.kind === "folder" || !!child.url
  );
}
