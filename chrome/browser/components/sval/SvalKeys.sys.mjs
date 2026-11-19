/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The ids of Sval's `<key>` elements and the menu items that name them, and
 * how a key reads: in a menu or a tooltip, as keycaps, and to assistive
 * technology. `SvalShortcuts` puts the keys in a window and runs them.
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { ShortcutUtils } from "resource://gre/modules/ShortcutUtils.sys.mjs";

/** Firefox's sidebar toggle, which shows and hides Sval's panel. */
export const PANEL_TOGGLE_KEY = "toggleSidebarKb";

/** Firefox's key for Open Location, which opens the Launcher (`SvalLauncher`). */
export const LAUNCHER_KEY = "focusURLBar";

/**
 * Whether a sideways scroll over the panel moves the window to the next or
 * previous workspace (`SvalPanelSwitcher`). Settings' Keyboard
 * shortcuts pane holds its switch.
 */
export const SWIPE_WORKSPACES_PREF = "browser.sval.panel.swipeWorkspaces";

/** The Workspaces menu's item for the panel toggle (`SvalMenuBar`). */
export const PANEL_MENU_ITEM_ID = "sval-menu-workspaces-panel";

/**
 * New workspace's `<key>`, which has no key until the user gives it one, as
 * the element picker's modes' keys have none ({@link MODE_KEYS}).
 */
export const NEW_WORKSPACE_KEY = "sval-key-new-workspace";

/** Copy Address's `<key>`, Accel+Shift+C, the key Arc gives it. */
export const COPY_ADDRESS_KEY = "sval-key-copy-address";

/** The Tab menu's item for Copy Address (`SvalMenuBar`). */
export const COPY_ADDRESS_MENU_ITEM_ID = "sval-menu-copy-address";

/**
 * New Peek's `<key>`, Accel+Alt+N, the key Arc gives its Little Arc window.
 * On Windows, where a keyboard layout types a character with Ctrl+Alt+N,
 * Gecko reads the keys as AltGr (`NativeKey::InitWithKeyOrChar`), so the
 * character is typed and the command does not run.
 */
export const NEW_PEEK_KEY = "sval-key-new-peek";

/** The File menu's item for New Peek, after New Private Window. */
export const NEW_PEEK_MENU_ITEM_ID = "sval-menu-new-peek";

const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

/**
 * The widget keys a menu item also runs, as `<key>` attributes. The ids are
 * what the menu items' `key` attributes name.
 */
export const MENU_KEYS = {
  rename: { id: "sval-key-rename", keycode: "VK_F2" },
  delete: { id: "sval-key-delete", keycode: "VK_DELETE" },
  moveUp: { id: "sval-key-move-up", keycode: "VK_UP", modifiers: "alt" },
  moveDown: { id: "sval-key-move-down", keycode: "VK_DOWN", modifiers: "alt" },
  moveLeft: {
    id: "sval-key-move-left",
    keycode: "VK_LEFT",
    modifiers: "control,shift",
  },
  moveRight: {
    id: "sval-key-move-right",
    keycode: "VK_RIGHT",
    modifiers: "control,shift",
  },
  movePaneLeft: {
    id: "sval-key-move-pane-left",
    keycode: "VK_LEFT",
    modifiers: "alt",
  },
  movePaneRight: {
    id: "sval-key-move-pane-right",
    keycode: "VK_RIGHT",
    modifiers: "alt",
  },
  // Removes the home page's selected search result (`SvalHomeSearchParent`),
  // as it removes the address bar's (`UrlbarController#dismissSelectedResult`).
  dismiss: { id: "sval-key-dismiss", keycode: "VK_DELETE", modifiers: "shift" },
};

/** The element picker's modes' `<key>` ids, by mode. */
export const MODE_KEYS = {
  remove: "sval-key-element-picker",
  snip: "sval-key-snip",
};

/**
 * The site style editor's `<key>` (`SvalSiteStylePanel`), which has no key
 * until the user gives it one, as the element picker's modes' keys have none.
 */
export const STYLE_KEY = "sval-key-site-style";

/**
 * The site style editor's name, which the site menu, the shortcuts pane and
 * the editor itself use. A menu item that opens it adds "…".
 */
export const STYLE_NAME = "Colorshift this site";

/**
 * The element picker's modes' names, by mode, which their buttons, the site
 * menu, the Tab menu and the shortcuts pane all use. A menu item that
 * starts a mode adds "…", since the mode waits for a choice in the page.
 */
export const MODE_NAMES = {
  remove: "Remove from this site",
  snip: "Snip",
};

/**
 * Names for keys `ShortcutUtils` has no string for (`keys.properties`).
 */
const KEY_NAMES = {
  VK_SPACE: "Space",
  VK_CONTEXT_MENU: "Menu key",
};

/** The DOM `key` value of each keycode Sval's keys use, for ARIA. */
const ARIA_KEYS = {
  VK_UP: "ArrowUp",
  VK_DOWN: "ArrowDown",
  VK_LEFT: "ArrowLeft",
  VK_RIGHT: "ArrowRight",
  VK_DELETE: "Delete",
  VK_BACK: "Backspace",
  VK_RETURN: "Enter",
  VK_ESCAPE: "Escape",
  VK_TAB: "Tab",
  VK_SPACE: "Space",
  VK_HOME: "Home",
  VK_END: "End",
  VK_CONTEXT_MENU: "ContextMenu",
};

/**
 * A key as `ShortcutUtils` draws it on this platform: "⌥Up Arrow" on macOS,
 * "Alt+Up Arrow" elsewhere.
 *
 * @param {object} key A `<key>`'s attributes.
 * @param {string} [key.modifiers]
 * @param {string} [key.keycode]
 * @param {string} [key.key]
 * @returns {string}
 */
export function shortcutText({ modifiers, keycode, key }) {
  return (
    ShortcutUtils.getModifierString(modifiers ?? "") +
    (KEY_NAMES[keycode] ?? ShortcutUtils.getKeyString(keycode, key))
  );
}

/**
 * A key as {@link shortcutText} spells it, one key cap per key pressed:
 * ["⌘", "L"] on macOS, ["Ctrl", "L"] elsewhere.
 *
 * @param {object} key A `<key>`'s attributes.
 * @param {string} [key.modifiers]
 * @param {string} [key.keycode]
 * @param {string} [key.key]
 * @returns {string[]}
 */
export function shortcutCaps({ modifiers, keycode, key }) {
  const held = ShortcutUtils.getModifierString(modifiers ?? "");
  // macOS spells each modifier as one glyph and joins none; the others
  // join their words with "+".
  const caps =
    AppConstants.platform === "macosx"
      ? [...held]
      : held.split("+").filter(Boolean);
  caps.push(KEY_NAMES[keycode] ?? ShortcutUtils.getKeyString(keycode, key));
  return caps;
}

/**
 * A click with modifiers as this platform spells one: "⌥-click" on macOS,
 * "Alt+click" elsewhere, the modifiers in `ShortcutUtils`' order.
 *
 * @param {string} modifiers As a `<key>`'s `modifiers`.
 * @returns {string}
 */
export function clickText(modifiers) {
  const held = ShortcutUtils.getModifierString(modifiers);
  return AppConstants.platform === "macosx" ? `${held}-click` : `${held}click`;
}

/** The key glyphs the design draws on macOS, which spells the rest. */
const MAC_KEYS = Object.freeze({
  VK_RETURN: "↵",
  VK_BACK: "⌫",
  VK_DELETE: "⌦",
});

/**
 * A key cap's text: macOS's glyphs ("⌘⇧↵"), or the words joined with "+"
 * ("Ctrl+Shift+Enter"), as `ShortcutUtils` spells a key.
 *
 * @param {string} keycode A `VK_` code.
 * @param {string} [modifiers] As a `<key>`'s `modifiers`.
 * @returns {string}
 */
export function keycap(keycode, modifiers = "") {
  const glyph = AppConstants.platform === "macosx" && MAC_KEYS[keycode];
  return (
    ShortcutUtils.getModifierString(modifiers) +
    (glyph || ShortcutUtils.getKeyString(keycode))
  );
}

/**
 * A key in `aria-keyshortcuts`' syntax: modifiers and the DOM key value,
 * joined by "+" ("Alt+ArrowUp", "Control+Z").
 *
 * @param {object} key A `<key>`'s attributes.
 * @param {string} [key.modifiers]
 * @param {string} [key.keycode]
 * @param {string} [key.key]
 * @returns {string}
 */
export function ariaShortcut({ modifiers, keycode, key }) {
  const accel = AppConstants.platform === "macosx" ? "Meta" : "Control";
  const names = {
    accel,
    control: "Control",
    ctrl: "Control",
    alt: "Alt",
    shift: "Shift",
    meta: "Meta",
  };
  const parts = (modifiers ?? "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(m => names[m]);
  const order = ["Control", "Alt", "Shift", "Meta"];
  parts.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  parts.push(
    key
      ? key.toUpperCase()
      : (ARIA_KEYS[keycode] ?? keycode.replace(/^VK_/, ""))
  );
  return parts.join("+");
}

/**
 * The attributes a `<key>` element carries now, which `CustomKeys` changes
 * when the user remaps it.
 *
 * @param {Element} el
 * @returns {object} `{ modifiers, keycode, key }`.
 */
export function keyOf(el) {
  return {
    modifiers: el.getAttribute("modifiers") ?? "",
    keycode: el.getAttribute("keycode") ?? "",
    key: el.getAttribute("key") ?? "",
  };
}

/**
 * Names the panel toggle's key on `button`, as it is now: the user may
 * have remapped it in settings since the window opened.
 *
 * @param {Element} button The header's panel toggle.
 */
export function describePanelToggle(button) {
  describeKey(button, PANEL_TOGGLE_KEY, "Show or hide Workspaces");
}

/**
 * Names a `<key>` on the button that runs its command, by the key assigned
 * to it: after `label` in the tooltip, and in `aria-keyshortcuts`. A key with
 * nothing assigned leaves the label alone. A XUL button's tooltip is its
 * `tooltiptext`, an HTML one's its `title`.
 *
 * @param {Element} button
 * @param {string} keyId
 * @param {string} label
 * @param {Document} [keys] The document holding the `<key>`: a sidebar's
 *   button runs a key of its browser window's.
 */
export function describeKey(button, keyId, label, keys = button.ownerDocument) {
  const tooltip = button.namespaceURI === XUL_NS ? "tooltiptext" : "title";
  const key = keys.getElementById(keyId);
  const assigned =
    key && (key.hasAttribute("key") || key.hasAttribute("keycode"));
  if (!assigned) {
    button.setAttribute(tooltip, label);
    button.removeAttribute("aria-keyshortcuts");
    return;
  }
  button.setAttribute(
    tooltip,
    `${label} (${ShortcutUtils.prettifyShortcut(key)})`
  );
  button.setAttribute("aria-keyshortcuts", ariaShortcut(keyOf(key)));
}

/**
 * {@link describeKey}, and again each time the pointer or the
 * focus reaches the button: Settings › Keyboard can remap the key while
 * the window is open, and tells no one (`CustomKeys.changeKey`).
 *
 * @param {Element} button
 * @param {string} keyId
 * @param {string} label
 * @param {Document} [keys] As {@link describeKey} takes it.
 */
export function keepKeyDescribed(
  button,
  keyId,
  label,
  keys = button.ownerDocument
) {
  const describe = () => describeKey(button, keyId, label, keys);
  describe();
  for (const type of ["mouseover", "focus"]) {
    button.addEventListener(type, describe);
  }
}
