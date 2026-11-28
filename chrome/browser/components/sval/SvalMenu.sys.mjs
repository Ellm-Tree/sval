/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Sval's menus: XUL `menupopup`s built from plain item data, in the
 * document's own popupset, styled by `sval-menu.css`.
 *
 * They stay in the light DOM. Gecko's drawn menus inside a shadow root open
 * no submenu on a click and do not hide on `hidePopup()`, and the window's
 * listeners and sheets (`SvalStem`, `sval-menu.css`) do not reach into one.
 *
 * An item is `"separator"` or an object:
 * - `id`: what `onCommand`, {@link SvalMenu.item} and the tests know it by
 *   (`data-sval-menu-id`);
 * - `label`, or `l10n: { id, args }` for a Fluent string;
 * - `key`: a `<key>` it names, as `MENU_KEYS` gives one: its `id` becomes the
 *   item's `key`, and a key that spells its keys (`key` or `keycode`) also
 *   gives `aria-keyshortcuts`. A key given by id alone can be remapped, so
 *   its accessible reads the key element as it is
 *   (`XULMenuitemAccessible::KeyboardShortcut`);
 * - `acceltext`, `icon`, `disabled`, `hidden`, `type` (`"checkbox"`,
 *   `"radio"` or `"separator"`), `checked`, `autocheck`, `closemenu`,
 *   `className`, `attributes` (more attributes, such as `aria-label`);
 * - `data`: anything, handed to `onCommand` with the id;
 * - `items`, or `fill: popup => items`, for a submenu, and `onHidden: popup
 *   => void` for when that submenu hides; `popupClassName` and
 *   `popupAttributes` for the submenu's popup.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ariaShortcut: "moz-src:///browser/components/sval/SvalKeys.sys.mjs",
});

export const MENU_CSS = "chrome://browser/content/sval/sval-menu.css";

/** The attribute an item's id is in, and every popup SvalMenu builds. */
export const MENU_ID_ATTR = "data-sval-menu-id";
const MENU_ATTR = "sval-menu";

/** @type {WeakMap<Element, *>} Each item element's `data`. */
const itemData = new WeakMap();

/** @type {WeakMap<Element, object>} Each submenu popup's item. */
const submenus = new WeakMap();

/** @type {WeakSet<Window>} Windows `sval-menu.css` is loaded in. */
const sheeted = new WeakSet();

/**
 * Shows a menu's separators only between two runs of items that both show
 * something, once its items' `hidden` is set.
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
 * The popupset a document's menus go in: a browser window's
 * `#mainPopupSet`, or one at the end of the body of an HTML chrome
 * document, made the first time.
 *
 * @param {Document} doc
 * @returns {Element}
 */
function popupSetOf(doc) {
  const main = doc.getElementById("mainPopupSet");
  if (main) {
    return main;
  }
  const body = doc.body ?? doc.documentElement;
  let set = body.querySelector(":scope > popupset");
  if (!set) {
    set = doc.createXULElement("popupset");
    body.append(set);
  }
  return set;
}

/**
 * Attributes Gecko sets on an item while its menu is open, which an item
 * drawn again keeps (`nsXULPopupManager`, `nsMenuPopupFrame`).
 */
const LIVE_ATTRS = new Set(["open", "_moz-menuactive", "menuactive"]);

/**
 * @param {object|string} item
 * @returns {string} the element `item` is drawn as.
 */
function tagOf(item) {
  if (item === "separator" || item.type === "separator") {
    return "menuseparator";
  }
  if (item.type === "caption") {
    return "menucaption";
  }
  return item.items || item.fill ? "menu" : "menuitem";
}

/**
 * Makes `el` show `item` alone: what an item drawn before set on it goes,
 * apart from Gecko's live state and a Fluent string it keeps.
 *
 * @param {Element} el
 * @param {object|string} item
 */
function clearFor(el, item) {
  const keepL10n =
    !!item.l10n &&
    el.getAttribute("data-l10n-id") === item.l10n.id &&
    JSON.stringify(el.ownerDocument.l10n.getAttributes(el).args ?? null) ===
      JSON.stringify(item.l10n.args ?? null);
  for (const { name } of [...el.attributes]) {
    if (
      LIVE_ATTRS.has(name) ||
      (keepL10n &&
        (name === "data-l10n-id" ||
          name === "data-l10n-args" ||
          name === "label"))
    ) {
      continue;
    }
    el.removeAttribute(name);
  }
}

/**
 * Draws `item` on `el`, an element of its kind, new or drawn before.
 *
 * @param {Element} el
 * @param {object|string} item
 * @param {?string} look The look of the menu it goes in (`MENU_ATTR`).
 */
function drawItem(el, item, look) {
  const doc = el.ownerDocument;
  clearFor(el, item);
  if (el.localName === "menuseparator") {
    if (item.id) {
      el.setAttribute(MENU_ID_ATTR, item.id);
    }
    for (const [name, value] of Object.entries(item.attributes ?? {})) {
      el.setAttribute(name, value);
    }
    el.hidden = !!item.hidden;
    return;
  }
  const submenu = el.localName === "menu";
  const caption = el.localName === "menucaption";
  if (item.id) {
    el.setAttribute(MENU_ID_ATTR, item.id);
  }
  if (item.l10n) {
    if (!el.hasAttribute("data-l10n-id")) {
      doc.l10n.setAttributes(el, item.l10n.id, item.l10n.args);
    }
  } else if (item.label != null) {
    el.setAttribute("label", item.label);
  }
  if (item.key?.id) {
    el.setAttribute("key", item.key.id);
  }
  if (item.key?.key || item.key?.keycode) {
    el.setAttribute("aria-keyshortcuts", lazy.ariaShortcut(item.key));
  }
  if (item.acceltext) {
    el.setAttribute("acceltext", item.acceltext);
  }
  if (item.icon) {
    el.setAttribute("image", item.icon);
    el.classList.add(submenu ? "menu-iconic" : "menuitem-iconic");
  }
  if (item.className) {
    el.classList.add(...item.className.split(/\s+/).filter(Boolean));
  }
  if (item.type && !caption) {
    el.setAttribute("type", item.type);
  }
  if (item.checked) {
    el.setAttribute("checked", "true");
  }
  if (item.autocheck === false) {
    el.setAttribute("autocheck", "false");
  }
  if (item.closemenu) {
    el.setAttribute("closemenu", item.closemenu);
  }
  if (item.disabled) {
    el.setAttribute("disabled", "true");
  }
  for (const [name, value] of Object.entries(item.attributes ?? {})) {
    if (value != null) {
      el.setAttribute(name, value);
    }
  }
  el.hidden = !!item.hidden;
  if (item.data !== undefined) {
    itemData.set(el, item.data);
  } else {
    itemData.delete(el);
  }
  if (submenu) {
    let popup = el.querySelector(":scope > menupopup");
    if (!popup) {
      popup = popupElement(doc, look);
      el.append(popup);
    }
    if (item.popupClassName) {
      popup.classList.add(...item.popupClassName.split(/\s+/).filter(Boolean));
    }
    for (const [name, value] of Object.entries(item.popupAttributes ?? {})) {
      popup.setAttribute(name, value);
    }
    submenus.set(popup, item);
    if (item.items) {
      render(popup, item.items);
    }
  }
}

/**
 * @param {Document} doc
 * @param {?string} [look] `"panel"` for a panel's look, the plain menu's
 *   for `""`, or the look of a menu SvalMenu does not style for null.
 * @returns {Element} an empty `menupopup`.
 */
function popupElement(doc, look = "") {
  const popup = doc.createXULElement("menupopup");
  if (look !== null) {
    popup.setAttribute(MENU_ATTR, look);
  }
  // A menu with a panel's look is never handed to a native menu, which
  // would draw none of it (`nsXULPopupManager`'s native menu path).
  if (look === "panel") {
    popup.setAttribute("nonnative", "");
  }
  return popup;
}

/**
 * The items of `els` already in `popup` that can stay where they are while
 * the rest move around them: the longest run whose order in the popup is
 * the order of `els`, and of those, one holding an open submenu where one
 * does.
 *
 * @param {Element[]} els A menu's items, in the order they are drawn in.
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

/**
 * Puts `items` in `popup` in place of what it held, separators tidied. An
 * item drawn before keeps its element, found by its id and kind, so an
 * open submenu stays open and the keyboard's place stays on its item: a
 * moved element leaves the document, and its open submenu loses its frame
 * (`nsXULPopupManager::PopupDestroyed`). So only the items out of order
 * move, around the longest run already in order. The elements a menu marks
 * `data-fixed` stay ahead of the items.
 *
 * @param {Element} popup
 * @param {Array<object|string>} items
 */
function render(popup, items) {
  const doc = popup.ownerDocument;
  const look = popup.getAttribute(MENU_ATTR);
  const kept = new Map();
  for (const el of [...popup.children]) {
    if (el.hasAttribute("data-fixed")) {
      continue;
    }
    const id = el.getAttribute(MENU_ID_ATTR);
    const key = id === null ? null : `${el.localName} ${id}`;
    if (key && !kept.has(key)) {
      kept.set(key, el);
    } else {
      el.remove();
    }
  }
  const els = (items ?? []).filter(Boolean).map(item => {
    const tag = tagOf(item);
    const key = item.id == null ? null : `${tag} ${item.id}`;
    let el = key && kept.get(key);
    if (el) {
      kept.delete(key);
    } else {
      el = doc.createXULElement(tag);
    }
    drawItem(el, item, look);
    return el;
  });
  for (const el of kept.values()) {
    el.remove();
  }
  const stay = inOrder(els, popup);
  for (let i = els.length - 1; i >= 0; i--) {
    if (!stay.has(els[i])) {
      popup.insertBefore(els[i], i + 1 < els.length ? els[i + 1] : null);
    }
  }
  tidySeparators(popup);
}

/** @type {WeakSet<Element>} Root popups whose submenus are filled. */
const wired = new WeakSet();

/**
 * Fills each submenu of `popup` with `fill` as it shows, at any depth, and
 * tells its `onHidden` as it hides.
 *
 * @param {Element} popup
 */
function wireSubmenus(popup) {
  // A submenu filled again on its own is already filled from its menu,
  // whose listeners hear its events and its own submenus' as they bubble.
  for (
    let el = popup;
    el;
    el = el.parentElement?.closest("menupopup") ?? null
  ) {
    if (wired.has(el)) {
      return;
    }
  }
  wired.add(popup);
  popup.addEventListener("popupshowing", event => {
    const sub = event.target !== popup && submenus.get(event.target);
    if (sub?.fill) {
      render(event.target, sub.fill(event.target));
    }
  });
  popup.addEventListener("popuphidden", event => {
    if (event.target !== popup) {
      submenus.get(event.target)?.onHidden?.(event.target);
    }
  });
}

/**
 * Sets SvalStem's attributes on `popup` (`SvalStem.sys.mjs`'s header).
 *
 * @param {Element} popup
 * @param {{side?: string, hang?: boolean}} stem
 */
function setStem(popup, { side, hang } = {}) {
  popup.setAttribute("sval-stem-host", "");
  if (side) {
    popup.setAttribute("sval-stem-side", side);
  }
  popup.toggleAttribute("sval-stem-hang", !!hang);
}

export const SvalMenu = {
  /**
   * Loads `sval-menu.css` in `win`, once.
   *
   * @param {Window} win
   */
  loadSheet(win) {
    if (sheeted.has(win)) {
      return;
    }
    sheeted.add(win);
    win.windowUtils.loadSheetUsingURIString(
      MENU_CSS,
      win.windowUtils.AUTHOR_SHEET
    );
  },

  /**
   * Builds a menu in `doc`'s popupset.
   *
   * `build` runs on each `popupshowing` of the menu itself and gives its
   * items afresh; a submenu's `fill` runs on that submenu's. `onShowing`
   * runs after `build`, and the separators are tidied after both.
   *
   * @param {Document} doc
   * @param {object} options
   * @param {string} [options.name] The popup's id, in place of any element
   *   holding it.
   * @param {Array<object|string>} [options.items]
   * @param {(handle: object) => Array<object|string>} [options.build]
   * @param {(id: string, data: *, event: Event) => void} [options.onCommand]
   * @param {(event: Event, handle: object) => void} [options.onShowing]
   * @param {(event: Event, handle: object) => void} [options.onHidden]
   * @param {{side?: string, hang?: boolean}} [options.stem]
   * @param {string} [options.className]
   * @param {boolean} [options.transient] Removes the menu once it hides.
   * @param {"panel"} [options.look] A panel's look, as the Workspace and
   *   Favorites menus wear, in place of a menu's (`sval-menu.css`).
   * @returns {{popup: Element, openAt: Function, openFrom: Function,
   *   close: Function, item: Function}}
   */
  create(
    doc,
    {
      name,
      items,
      build,
      onCommand,
      onShowing,
      onHidden,
      stem,
      className,
      transient = false,
      look = "",
    } = {}
  ) {
    this.loadSheet(doc.defaultView);
    const popup = popupElement(doc, look);
    if (name) {
      doc.getElementById(name)?.remove();
      popup.id = name;
    }
    if (className) {
      popup.className = className;
    }
    if (stem) {
      setStem(popup, stem);
    }
    const handle = {
      popup,
      /**
       * Opens as a context menu: at the pointer for a mouse event, and
       * under `anchor` for a key, which gives no point on the screen.
       *
       * @param {MouseEvent|KeyboardEvent|null} event
       * @param {Element} anchor
       */
      openAt(event, anchor) {
        if (event?.screenX) {
          popup.openPopupAtScreen(event.screenX, event.screenY, true, event);
        } else {
          popup.openPopup(anchor, {
            position: "after_start",
            isContextMenu: true,
          });
        }
      },
      /**
       * Opens it from `anchor`, at the one distance from it every menu
       * keeps.
       *
       * @param {Element} anchor
       * @param {string} [position] An `openPopup` position.
       */
      openFrom(anchor, position = "after_start") {
        popup.openPopup(anchor, position);
      },
      /**
       * Opens it with its corner at a point on the screen, with no button.
       *
       * @param {number} screenX In CSS pixels.
       * @param {number} screenY
       */
      openAtScreen(screenX, screenY) {
        popup.openPopupAtScreen(screenX, screenY, false);
      },
      close() {
        popup.hidePopup();
      },
      /**
       * @param {string} id
       * @returns {Element|null} the item `id`, at any depth.
       */
      item(id) {
        return popup.querySelector(`[${MENU_ID_ATTR}="${CSS.escape(id)}"]`);
      },
    };
    if (items) {
      render(popup, items);
    }
    wireSubmenus(popup);
    popup.addEventListener("popupshowing", event => {
      if (event.target === popup) {
        if (build) {
          render(popup, build(handle));
        }
        onShowing?.(event, handle);
        tidySeparators(popup);
      }
    });
    popup.addEventListener("popuphidden", event => {
      if (event.target !== popup) {
        return;
      }
      onHidden?.(event, handle);
      if (transient) {
        popup.remove();
      }
    });
    if (onCommand) {
      popup.addEventListener("command", event => {
        const el = event.target.closest?.(`[${MENU_ID_ATTR}]`);
        if (el && popup.contains(el)) {
          onCommand(el.getAttribute(MENU_ID_ATTR), itemData.get(el), event);
        }
      });
    }
    popupSetOf(doc).append(popup);
    return handle;
  },

  /**
   * Opens a one-time menu of choices under `anchor`, each a radio item with
   * `current`'s checked, and gives the value chosen, or null once it closes
   * with none.
   *
   * @param {Element} anchor
   * @param {Array<{value: *, id?: string, label?: string, l10n?: object,
   *   disabled?: boolean}>} choices Each choice's id is its value as a
   *   string unless it names one.
   * @param {*} current
   * @param {object} [options]
   * @param {string} [options.name] The popup's id.
   * @param {string} [options.position] An `openPopup` position.
   * @returns {Promise<*>}
   */
  choose(anchor, choices, current, { name, position = "after_end" } = {}) {
    // A choice resolves as its command runs, before the menu hides, as a
    // menu item's command listener would run.
    return new Promise(resolve => {
      const handle = this.create(anchor.ownerDocument, {
        name,
        transient: true,
        items: choices.map(choice => ({
          ...choice,
          id: choice.id ?? String(choice.value),
          type: "radio",
          checked: choice.value === current,
          data: choice.value,
        })),
        onCommand: (id, value) => resolve(value),
        onHidden: () => resolve(null),
      });
      handle.openFrom(anchor, position);
    });
  },

  /**
   * Puts `items` in a menu Sval does not build, such as one of Firefox's or
   * one a controller of its own drives, and styles it as Sval's.
   *
   * An item filled before keeps its element (`render`), so a menu filled
   * again while open stays as the person left it.
   *
   * @param {Element} popup A `menupopup`.
   * @param {Array<object|string>} items
   * @param {object} [options]
   * @param {?"panel"} [options.look] As `create` takes it, or null to leave
   *   the menu, and the submenus it makes, in the look it has.
   */
  fill(popup, items, { look = "" } = {}) {
    if (look !== null) {
      this.loadSheet(popup.documentGlobal);
      popup.setAttribute(MENU_ATTR, look);
    }
    if (look === "panel") {
      popup.setAttribute("nonnative", "");
    }
    wireSubmenus(popup);
    render(popup, items);
  },

  /**
   * @param {Element} el An item element SvalMenu built.
   * @returns {*} the `data` it was built with.
   */
  dataOf(el) {
    return itemData.get(el);
  },
};
