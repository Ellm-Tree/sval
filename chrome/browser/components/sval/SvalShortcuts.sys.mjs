/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Sval's keyboard shortcuts: the key that shows and hides the workspace
 * panel, the keys the panel's tree and the favorites answer, and how
 * Firefox's own list (`CustomKeysParent.getKeys`) reads in Sval. Settings'
 * Keyboard shortcuts pane draws them all, and the menus that offer a command
 * a key also runs name the key beside it.
 *
 * The panel's toggle is Firefox's sidebar toggle, `toggleSidebarKb`: Sval's
 * panel stands where Firefox's sidebar launcher would, and Firefox runs that
 * key only with `sidebar.revamp`, which Sval turns off. It stays a `<key>` of
 * Firefox's, so `CustomKeys` remaps it as it does Firefox's others.
 *
 * The tree's keys and the favorites' are the widgets' own (`keyCommand` in
 * `SvalPanelModel`, `home/favorites.js`), shown and never remapped. The ones a
 * menu item runs too are also `<key internal="true">` elements: Gecko runs
 * no command for an internal key (`XULKeySetGlobalKeyListener::
 * IsExecutableElement`), and a menu item naming it draws its accelerator, on
 * a macOS native menu too, and exposes it to assistive technology
 * (`XULMenuitemAccessible::KeyboardShortcut`).
 *
 * Copy Address is a key of Sval's own, which the Tab menu names
 * (`SvalMenuBar`). New Peek is another, which the File menu names.
 *
 * The element picker's two modes and New workspace are commands with no key
 * until the user gives one. Each is a `<key>` with no `key` or `keycode`, as
 * `CustomKeys` leaves a key it clears, named by a menu bar item
 * (`SvalMenuBar`), because `CustomKeysParent.getKeys` lists the keys menu bar
 * items name.
 *
 * Sval's commands are `reserved="true"`, here and in
 * `sval-reserved-keys.patch`: Gecko runs the command and never hands the key
 * to the page (`GlobalKeyListener::IsReservedKey`), so a site cannot take it.
 * Copy, paste, cut, undo, select all, find and save stay a page's to take,
 * since web apps answer them themselves, and so does the panel's Control+Z on
 * macOS, which a terminal in a page needs. A key the user gives a command stays
 * reserved, because `CustomKeys` rewrites only the key and its modifiers.
 */

import { ShortcutUtils } from "resource://gre/modules/ShortcutUtils.sys.mjs";
import {
  COPY_ADDRESS_KEY,
  LAUNCHER_KEY,
  MENU_KEYS,
  MODE_KEYS,
  MODE_NAMES,
  NEW_PEEK_KEY,
  NEW_PEEK_MENU_ITEM_ID,
  NEW_WORKSPACE_KEY,
  PANEL_TOGGLE_KEY,
  STYLE_KEY,
  STYLE_NAME,
  clickText,
  shortcutText,
} from "moz-src:///browser/components/sval/SvalKeys.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  QUICK_PEEK_CLICKS: "moz-src:///browser/components/sval/SvalQuickPeek.sys.mjs",
  QUICK_PEEK_PREF: "moz-src:///browser/components/sval/SvalQuickPeek.sys.mjs",
  quickPeekClick: "moz-src:///browser/components/sval/SvalQuickPeek.sys.mjs",
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  copyAddress: "moz-src:///browser/components/sval/SvalTabActions.sys.mjs",
  SvalPeek: "moz-src:///browser/components/sval/SvalPeek.sys.mjs",
  SvalSiteControls:
    "moz-src:///browser/components/sval/SvalSiteControls.sys.mjs",
  SvalSiteStylePanel:
    "moz-src:///browser/components/sval/SvalSiteStylePanel.sys.mjs",
  userPanel: "moz-src:///browser/components/sval/SvalLauncherCommands.sys.mjs",
});

/** The File menu's item for the Launcher, after New Peek. */
const LAUNCHER_MENU_ITEM_ID = "sval-menu-launcher";

const KEYSET_ID = "sval-shortcut-keys";

/**
 * F6 and Shift+F6, which a page would otherwise receive first and could keep
 * from moving the focus. Each is a `<key reserved="true">` with no command of
 * its own (`internal`): Gecko keeps it from the page
 * (`GlobalKeyListener::IsReservedKey`) and leaves it to its document
 * navigation (`EventStateManager::PostHandleKeyboardEvent`) and to
 * `SvalWindow`'s step through the panel.
 */
const F6_KEYS = [
  { keycode: "VK_F6" },
  { keycode: "VK_F6", modifiers: "shift" },
];

/**
 * The click that opens a link in a Quick Peek, as {@link clickText} spells it, or
 * "" while Quick Peek is off.
 *
 * @returns {string}
 */
export function quickPeekClickText() {
  return Services.prefs.getBoolPref(lazy.QUICK_PEEK_PREF, true)
    ? clickText(lazy.quickPeekClick())
    : "";
}

/**
 * The keys the panel's tree and the favorites answer, grouped as the pane
 * shows them. An entry's `keys` are shown joined by "or". `command` is the
 * one `SvalPanelModel.keyCommand` answers for each of those keys, which the
 * tests hold the entry to. `keyId` names a `<key>` the entry is, which the
 * pane lets the user remap. `quickPeekClick` marks the click that opens a link in
 * a Quick Peek, which the pane changes among `SvalQuickPeek.QUICK_PEEK_CLICKS` and turns off
 * (`settings-keyboard.js`). A title that starts with `launcher-` is the id
 * of its words in `sval/launcher.ftl`, which the pane translates
 * (`settings-keyboard.js`).
 */
/**
 * The group of the Workspace panel's keys, which the pane also gives the
 * switches for Ctrl+Tab's order and for swiping between workspaces
 * (`settings-keyboard.js`).
 */
export const PANEL_GROUP = "Workspace panel";

export const SVAL_SHORTCUTS = [
  {
    // The Launcher's key and where Enter opens what it finds (launcher spec
    // §3, §8).
    title: "launcher-keys-group",
    entries: [
      { keyId: LAUNCHER_KEY, title: "launcher-keys-open" },
      {
        title: "launcher-keys-new-tab",
        keys: [{ keycode: "VK_RETURN", modifiers: "shift" }],
      },
      {
        title: "launcher-keys-new-window",
        keys: [{ keycode: "VK_RETURN", modifiers: "accel,shift" }],
      },
      {
        title: "launcher-keys-split",
        keys: [{ keycode: "VK_RETURN", modifiers: "alt" }],
      },
    ],
  },
  {
    title: PANEL_GROUP,
    entries: [
      { keyId: PANEL_TOGGLE_KEY, title: "Show or hide the Workspace panel" },
      { keyId: NEW_WORKSPACE_KEY, title: "New Workspace" },
      {
        title: "Move between the address bar, the Workspace panel and the page",
        keys: [{ keycode: "VK_F6" }, { keycode: "VK_F6", modifiers: "shift" }],
      },
      {
        title: "Next row",
        keys: [{ keycode: "VK_DOWN" }],
        command: "focusNext",
      },
      {
        title: "Previous row",
        keys: [{ keycode: "VK_UP" }],
        command: "focusPrevious",
      },
      {
        title: "First row",
        keys: [{ keycode: "VK_HOME" }],
        command: "focusFirst",
      },
      {
        title: "Last row",
        keys: [{ keycode: "VK_END" }],
        command: "focusLast",
      },
      {
        title: "Extend the selection down",
        keys: [{ keycode: "VK_DOWN", modifiers: "shift" }],
        command: "extendNext",
      },
      {
        title: "Extend the selection up",
        keys: [{ keycode: "VK_UP", modifiers: "shift" }],
        command: "extendPrevious",
      },
      {
        title: "Select or deselect the row",
        keys: [{ keycode: "VK_SPACE", modifiers: "control" }],
        command: "toggleSelected",
      },
      {
        title: "Clear the selection",
        keys: [{ keycode: "VK_ESCAPE" }],
        command: "clearSelection",
      },
      {
        title: "Go to a row by its name",
        text: "Type its first letters",
      },
      {
        title: "Open a group",
        keys: [{ keycode: "VK_RIGHT" }],
        command: "expand",
      },
      {
        title: "Close a group, or go to the row's group",
        keys: [{ keycode: "VK_LEFT" }],
        command: "collapse",
      },
      {
        title: "Show the tab, or open or close the group",
        keys: [{ keycode: "VK_RETURN" }, { keycode: "VK_SPACE" }],
        command: "activate",
      },
      {
        title: "Rename",
        keys: [MENU_KEYS.rename],
        command: "rename",
      },
      {
        title: "Close the tab, or delete the group",
        keys: [MENU_KEYS.delete, { keycode: "VK_BACK" }],
        command: "close",
      },
      {
        title: "Move up",
        keys: [MENU_KEYS.moveUp],
        command: "moveBefore",
      },
      {
        title: "Move down",
        keys: [MENU_KEYS.moveDown],
        command: "moveAfter",
      },
      {
        title: "Move into the group above",
        keys: [{ keycode: "VK_RIGHT", modifiers: "alt" }],
        command: "moveIn",
      },
      {
        title: "Move out of its group",
        keys: [{ keycode: "VK_LEFT", modifiers: "alt" }],
        command: "moveOut",
      },
      {
        title: "Next pane in a Split",
        keys: [{ keycode: "VK_RIGHT" }],
        command: "focusNextPane",
      },
      {
        title: "Previous pane in a Split",
        keys: [{ keycode: "VK_LEFT" }],
        command: "focusPreviousPane",
      },
      {
        title: "Move the pane left in its Split",
        keys: [{ keycode: "VK_LEFT", modifiers: "alt" }],
        command: "movePaneLeft",
      },
      {
        title: "Move the pane right in its Split",
        keys: [{ keycode: "VK_RIGHT", modifiers: "alt" }],
        command: "movePaneRight",
      },
      {
        title: "Open the row's menu",
        keys: [
          { keycode: "VK_F10", modifiers: "shift" },
          { keycode: "VK_CONTEXT_MENU" },
        ],
        command: "contextMenu",
      },
      {
        title: "Widen or narrow the Workspace panel, on its edge",
        keys: [{ keycode: "VK_LEFT" }, { keycode: "VK_RIGHT" }],
      },
    ],
  },
  {
    title: "Favorites",
    entries: [
      {
        title: "Open a favorite's menu, in the Favorites menu",
        keys: [
          { keycode: "VK_F10", modifiers: "shift" },
          { keycode: "VK_CONTEXT_MENU" },
        ],
      },
      {
        title: "Move between favorites on the home page",
        text: "Arrow keys",
      },
      {
        title: "Move a favorite left on the home page",
        keys: [MENU_KEYS.moveLeft],
      },
      {
        title: "Move a favorite right on the home page",
        keys: [MENU_KEYS.moveRight],
      },
    ],
  },
  {
    // Firefox's tab-number keys select pins, the ninth's included
    // (`SvalPinsRow`), outside a private window and an agent's workspace.
    title: "Pins",
    entries: [
      ...[1, 2, 3, 4, 5, 6, 7, 8].map(n => ({
        keyId: `key_selectTab${n}`,
        title: `Go to pin ${n}`,
      })),
      { keyId: "key_selectLastTab", title: "Go to pin 9" },
    ],
  },
  {
    title: "Links",
    entries: [{ quickPeekClick: true, title: "Open a link in a Quick Peek" }],
  },
];

/**
 * Firefox's shortcuts that do nothing in Sval, or open what Sval does not
 * have, by `<key>` id. Each is still a key of Firefox's; the pane leaves it
 * out.
 */
export const DROPPED_KEYS = new Set([
  // Firefox's sidebar toggle is the panel's, in the panel's group.
  PANEL_TOGGLE_KEY,
  // Open Location is the Launcher's key, in the Launcher's group.
  LAUNCHER_KEY,
  // The bookmarks sidebar, the bookmarks toolbar and bookmarking every tab:
  // Sval turns them off (`SvalFavorites`).
  "viewBookmarksSidebarKb",
  "viewBookmarksToolbarKb",
  "bookmarkAllTabsKb",
  // Firefox's list of all tabs, which opens from the tab strip Sval hides;
  // the panel lists every tab.
  "key_showAllTabs",
  // Full screen's other half: the same key, which Firefox enables while the
  // window is full screen and lists apart. "Full screen" is the key.
  "key_exitFullScreen",
  // Open Location's second key on Windows and Linux, which opens the
  // Launcher too and which Sval does not show (launcher spec §3).
  "focusURLBar2",
  // The panel's widget keys, which the Tab menu's items name: they are
  // shown with the panel's group and never remapped.
  ...Object.values(MENU_KEYS).map(key => key.id),
]);

/**
 * The labels `sval-menu-bar.patch` gives the menu bar's own menus. Their keys
 * are each named where another group already lists it, or by a pin's name in
 * the Favorites menu, so the pane takes from these menus only what no other
 * group has.
 */
export const SVAL_MENU_TITLES = new Set(["Workspaces", "Favorites", "Tab"]);

/**
 * Firefox's shortcuts that Sval names otherwise, by `<key>` id, and the group
 * each goes in when it is not where Firefox puts it. Favorites are Sval's
 * name for bookmarks, and Sval's History sidebar is where Firefox's history
 * commands go (`SvalFavorites._replaceLibrary`). The add-split key adds a
 * pane to a split the tab is in (`SvalWindow`). The element picker's modes
 * are titled without their Tab menu items' "…".
 */
export const RENAMED_KEYS = {
  addBookmarkAsKb: {
    title: "Add the page to Favorites",
    group: "Favorites",
  },
  manBookmarkKb: { title: "Show Favorites", group: "Favorites" },
  key_gotoHistory: { title: "Show or hide history", group: "History" },
  showAllHistoryKb: { title: "Show history" },
  key_enterFullScreen: { title: "Full screen" },
  key_toggleReaderMode: { title: "Reader View" },
  key_search: { title: "Search the web" },
  key_search2: { title: "Search the web" },
  key_addTabSplitView: { title: "Split the tab, or add a pane to its Split" },
  key_separateTabSplitView: { title: "Separate the Split" },
  [MODE_KEYS.remove]: { title: MODE_NAMES.remove },
  [MODE_KEYS.snip]: { title: MODE_NAMES.snip },
  [STYLE_KEY]: { title: STYLE_NAME },
  [COPY_ADDRESS_KEY]: { title: "Copy the page’s address" },
};

/**
 * The pane's groups: Sval's first, then Firefox's in Sval's words without the
 * keys Sval drops. Each key is listed once, in the first group that has it,
 * since several menus name the same key.
 *
 * @param {object} firefox `CustomKeysParent.getKeys`' answer, its titles
 *   already translated: `{ category: { keyId: { title, shortcut,
 *   isCustomized } } }`.
 * @param {Document} chromeDoc The browser window's document, whose `<key>`s
 *   Sval's remappable entries are.
 * @returns {object[]} `[{ title, entries: [{ id, title, shortcut,
 *   isCustomized, remappable, quickPeekClick }] }]`.
 */
export function arrange(firefox, chromeDoc) {
  const groups = new Map();
  const groupFor = title => {
    if (!groups.has(title)) {
      groups.set(title, { title, entries: [] });
    }
    return groups.get(title);
  };
  const remappable = new Map();
  const placed = new Set();
  for (const keys of Object.values(firefox)) {
    for (const [id, data] of Object.entries(keys)) {
      remappable.set(id, data);
    }
  }
  for (const group of SVAL_SHORTCUTS) {
    const into = groupFor(group.title);
    for (const entry of group.entries) {
      if (entry.quickPeekClick) {
        const shortcut = quickPeekClickText();
        into.entries.push({
          title: entry.title,
          shortcut,
          isCustomized: shortcut !== clickText(lazy.QUICK_PEEK_CLICKS[0]),
          remappable: false,
          quickPeekClick: true,
        });
        continue;
      }
      if (entry.keyId) {
        const el = chromeDoc.getElementById(entry.keyId);
        placed.add(entry.keyId);
        into.entries.push({
          id: entry.keyId,
          title: entry.title,
          shortcut: el ? ShortcutUtils.prettifyShortcut(el) : "",
          isCustomized: !!remappable.get(entry.keyId)?.isCustomized,
          remappable: true,
        });
        continue;
      }
      into.entries.push({
        title: entry.title,
        shortcut: entry.text ?? entry.keys.map(shortcutText).join(" or "),
        remappable: false,
      });
    }
  }
  const categories = Object.entries(firefox).sort(
    ([a], [b]) => SVAL_MENU_TITLES.has(a) - SVAL_MENU_TITLES.has(b)
  );
  for (const [category, keys] of categories) {
    for (const [id, data] of Object.entries(keys)) {
      if (DROPPED_KEYS.has(id) || placed.has(id)) {
        continue;
      }
      placed.add(id);
      const renamed = RENAMED_KEYS[id];
      const into = groupFor(renamed?.group ?? category);
      into.entries.push({
        id,
        title: renamed?.title ?? data.title,
        shortcut: data.shortcut,
        isCustomized: data.isCustomized,
        remappable: true,
      });
    }
  }
  return [...groups.values()].filter(group => group.entries.length);
}

/**
 * Opens New workspace's dialog (`SvalPanel.addWorkspace`) in a window with
 * workspaces, as the Launcher's command does (`userPanel`).
 *
 * @param {Window} win
 */
export function newWorkspace(win) {
  lazy
    .userPanel(win)
    ?.addWorkspace()
    .catch(err =>
      lazy.SvalLog.error(
        `could not add a workspace: ${lazy.SvalLog.errorName(err)}`
      )
    );
}

/**
 * The File menu's items for New Peek, after New Private Window, and for the
 * Launcher, on Open Location's key, which Firefox's own File menu item for it
 * leaves hidden in a browser window (`menu_openLocation`). Each names its key
 * as the user has it.
 *
 * @param {Window} win
 */
function addFileItems(win) {
  const doc = win.document;
  const anchor = doc.getElementById("menu_newPrivateWindow");
  if (!anchor) {
    return;
  }
  const peek = doc.createXULElement("menuitem");
  peek.id = NEW_PEEK_MENU_ITEM_ID;
  peek.setAttribute("label", "New Peek Window");
  peek.setAttribute("key", NEW_PEEK_KEY);
  peek.addEventListener("command", () => lazy.SvalPeek.openEmpty(win));
  anchor.after(peek);
  const launcher = doc.createXULElement("menuitem");
  launcher.id = LAUNCHER_MENU_ITEM_ID;
  launcher.setAttribute("label", "Launcher…");
  launcher.setAttribute("key", LAUNCHER_KEY);
  launcher.setAttribute("command", "Browser:OpenLocation");
  peek.after(doc.createXULElement("menuseparator"), launcher);
}

/**
 * @param {string} id A `<key>` id.
 * @returns {?string} the element picker's mode the key runs.
 */
function modeOfKey(id) {
  return Object.keys(MODE_KEYS).find(mode => MODE_KEYS[mode] === id) ?? null;
}

export const SvalShortcuts = {
  /**
   * Puts Sval's keys in `win`: the internal keys its menus name, the panel
   * toggle on Firefox's sidebar key, the element picker's modes' keys and
   * New workspace's, and the File menu's New Peek and Launcher items.
   *
   * @param {Window} win A browser window.
   */
  startWindow(win) {
    const doc = win.document;
    const mainKeyset = doc.getElementById("mainKeyset");
    if (!mainKeyset || doc.getElementById(KEYSET_ID)) {
      return;
    }
    const keyset = doc.createXULElement("keyset");
    keyset.id = KEYSET_ID;
    for (const { id, keycode, modifiers } of Object.values(MENU_KEYS)) {
      const key = doc.createXULElement("key");
      key.id = id;
      key.setAttribute("keycode", keycode);
      if (modifiers) {
        key.setAttribute("modifiers", modifiers);
      }
      key.setAttribute("internal", "true");
      keyset.append(key);
    }
    for (const id of [
      ...Object.values(MODE_KEYS),
      NEW_WORKSPACE_KEY,
      STYLE_KEY,
    ]) {
      const key = doc.createXULElement("key");
      key.id = id;
      key.setAttribute("reserved", "true");
      keyset.append(key);
    }
    const copyAddress = doc.createXULElement("key");
    copyAddress.id = COPY_ADDRESS_KEY;
    copyAddress.setAttribute("key", "C");
    copyAddress.setAttribute("modifiers", "accel,shift");
    copyAddress.setAttribute("reserved", "true");
    keyset.append(copyAddress);
    const newPeek = doc.createXULElement("key");
    newPeek.id = NEW_PEEK_KEY;
    newPeek.setAttribute("key", "N");
    newPeek.setAttribute("modifiers", "accel,alt");
    newPeek.setAttribute("reserved", "true");
    keyset.append(newPeek);
    for (const { keycode, modifiers } of F6_KEYS) {
      const key = doc.createXULElement("key");
      key.setAttribute("keycode", keycode);
      if (modifiers) {
        key.setAttribute("modifiers", modifiers);
      }
      key.setAttribute("internal", "true");
      key.setAttribute("reserved", "true");
      keyset.append(key);
    }
    keyset.addEventListener("command", event => {
      if (event.target.id === NEW_WORKSPACE_KEY) {
        newWorkspace(win);
        return;
      }
      if (event.target.id === COPY_ADDRESS_KEY) {
        lazy.copyAddress(win);
        return;
      }
      if (event.target.id === NEW_PEEK_KEY) {
        lazy.SvalPeek.openEmpty(win);
        return;
      }
      if (event.target.id === STYLE_KEY) {
        lazy.SvalSiteStylePanel.open(win, { focus: true });
        return;
      }
      const mode = modeOfKey(event.target.id);
      if (mode) {
        lazy.SvalSiteControls.toggleMode(win, mode, false);
      }
    });
    mainKeyset.after(keyset);

    // `browser-sets.js` runs `mainKeyset`'s keys from a `command` listener
    // on the keyset, and for this key only under `sidebar.revamp`.
    mainKeyset.addEventListener("command", event => {
      if (event.target.id === PANEL_TOGGLE_KEY) {
        win.SvalPanel?.toggleFromKey();
      }
    });

    addFileItems(win);
  },
};
