/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The Workspace panel's row menu: the context menu of a row of the tree,
 * whose entries also fill the menu bar's Tab menu (`SvalMenuBar`). It is
 * built once, shows the entries that fit what it was opened on, and runs
 * them through the panel's `run`, as a key does.
 *
 * The panel makes one of these for its window.
 */

import {
  MENU_KEYS,
  STYLE_KEY,
  ariaShortcut,
} from "moz-src:///browser/components/sval/SvalKeys.sys.mjs";
import {
  SELECTION_COMMANDS,
  addToSplitChoices,
  contextMenuItems,
  groupSelectionTarget,
  moveTarget,
  moveToGroupChoices,
  splitHasRoom,
  splitTabs,
} from "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs";
import {
  TAB,
  WORKSPACE,
  childrenByParent,
  displayName,
} from "moz-src:///browser/components/sval/SvalTree.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalFavorites: "moz-src:///browser/components/sval/SvalFavorites.sys.mjs",
  SvalFirefox: "moz-src:///browser/components/sval/SvalFirefox.sys.mjs",
  canUnload: "moz-src:///browser/components/sval/SvalTabActions.sys.mjs",
  isKeptLoaded: "moz-src:///browser/components/sval/SvalTabActions.sys.mjs",
  styleScopeOf: "moz-src:///browser/components/sval/SvalSiteStylePanel.sys.mjs",
  tidySeparators: "moz-src:///browser/components/sval/SvalPinsRow.sys.mjs",
});

/**
 * The menu bar's Tab menu's entries, in its order, by the row menu's command,
 * each with its menu bar label.
 */
const TAB_MENU_LABELS = {
  rename: "Rename Tab…",
  clearLabel: "Remove Tab Name",
  pin: "Pin Tab",
  pinHere: "Pin Tab to This Workspace",
  moveBefore: "Move Tab Up",
  moveAfter: "Move Tab Down",
  moveToGroup: "Move to Group",
  moveToWorkspace: "Move to Workspace",
  copyMarkdownLink: "Copy Markdown Link",
  unload: "Put Tab to Sleep",
  keepLoaded: "Keep Tab Awake",
  splitSeparator: "",
  createSplit: "Create Split",
  addToSplit: "Add to Split",
  addTabToSplit: "Add Tab to Split",
  separate: "Separate",
  movePaneLeft: "Move Pane Left",
  movePaneRight: "Move Pane Right",
  renameSplit: "Rename Split…",
};

/**
 * Opens a context `menupopup`.
 *
 * @param {Element} menu
 * @param {Element} anchor What a key opened it on.
 * @param {MouseEvent} [event] A `contextmenu`, which opens it at the pointer.
 */
export function openContextMenu(menu, anchor, event) {
  if (event) {
    menu.openPopupAtScreen(event.screenX, event.screenY, true, event);
  } else {
    menu.openPopup(anchor, { position: "after_start", isContextMenu: true });
  }
}

/**
 * What the row menu reads of its panel, and asks of it.
 *
 * @typedef {object} PanelView
 * @property {object} nodes The document's `nodes` map as the panel draws it.
 * @property {object} workspace The window's `SvalWindowWorkspace`.
 * @property {object} selection The window's `SvalPanelSelection`.
 * @property {object|null} pins The window's pins row.
 * @property {object|null} observer The window's `SvalTabObserver`.
 * @property {boolean} inMemory Whether the window's tree is in memory.
 * @property {boolean} built Whether the panel's frame is built.
 * @property {(id: string) => object|null} rowFor A drawn row.
 * @property {(id: string) => Element|null} rowElementFor A drawn row's element.
 * @property {(id: string) => void} focusRow Focuses a row.
 * @property {(row: object) => string} movingId The node a move of a row moves.
 * @property {(row: object) => object[]} tabsUnder The window's tabs for a
 *   row and what is inside it.
 * @property {(action: string|null) => string} mediaLabel What a media
 *   action is called.
 * @property {(kind: string) => string} untitled What a node with no name
 *   is called.
 * @property {(ids: string[]) => boolean} closesSelection Whether Close
 *   closes a selection.
 * @property {() => Set<string>} transparentIds Groups drawn as their
 *   contents.
 * @property {(popup: Element, ids: string[]) => void} fillMoveToWorkspace
 *   Fills a popup with the Workspaces rows can move to.
 * @property {(what: string, action: Function) => Promise} guard Runs a
 *   command, as a key's runs.
 * @property {(command: string, row: object) => void} run Runs a row's
 *   command.
 * @property {Function} moveInto Moves nodes into a group.
 * @property {Function} newGroupWith Makes a group of nodes.
 * @property {Function} joinSplit Adds a tab to a split.
 * @property {Function} moveToWorkspace Moves nodes to a Workspace.
 */

/** One window's row menu. */
export class SvalPanelRowMenu {
  #window;

  /** @type {PanelView} */
  #view;

  /** The row menu's `menupopup`, once built. */
  #menu = null;

  /** The row the menu was last opened on, as a node id. */
  #rowId = null;

  /**
   * @param {Window} win The panel's chrome window.
   * @param {PanelView} view
   */
  constructor(win, view) {
    this.#window = win;
    this.#view = view;
  }

  /** The row the menu was last opened on, as a node id. */
  get rowId() {
    return this.#rowId;
  }

  /**
   * Builds the row context menu once and parks it in `#mainPopupSet`, which
   * `browser.xhtml` already declares. A `<menupopup>` is what gives the menu
   * keyboard navigation, dismissal and platform placement for free, which is
   * why `sidebar-context-menu` and `tabContextMenu` are XUL popups too, and
   * creating it here needs no patch to that markup, only an element appended
   * to a popupset Mozilla already ships.
   *
   * One item per possible command, shown or hidden per row kind on
   * `popupshowing` (`#onShowing`) rather than rebuilt each time,
   * as `browser/components/syncedtabs/TabListView.sys.mjs`'s
   * `adjustContextMenu` toggles `hidden` on a fixed set, for the same
   * reason: the menu's own `command` event is what runs the action, so there
   * is nothing to rebuild.
   *
   * @returns {Element} the `menupopup`.
   */
  build() {
    const menu = this.#window.document.createXULElement("menupopup");
    menu.id = "sval-row-context-menu";
    this.#window.document.getElementById(menu.id)?.remove();
    menu.append(...this.#items());
    menu.addEventListener("popupshowing", event => this.#onShowing(event));
    menu.addEventListener("command", event => this.#onCommand(event));
    this.#menu = menu;
    this.#window.document.getElementById("mainPopupSet").append(menu);
    return menu;
  }

  /**
   * One element per command a row's menu can offer, in the row menu's order,
   * for the row menu and the menu bar's Tab menu (`SvalMenuBar`).
   *
   * @param {object} [labels] Labels by command, over the row menu's own.
   * @returns {Element[]}
   */
  #items(labels = {}) {
    // An item a row's key also runs names that key (`SvalShortcuts`). A key
    // of Firefox's, given by its id alone, can be remapped, so its
    // accelerator is left to the item's accessible
    // (`XULMenuitemAccessible::KeyboardShortcut`), which reads the key as it
    // is.
    const item = (command, label, key) => {
      const el = this.#window.document.createXULElement("menuitem");
      el.setAttribute("data-command", command);
      el.setAttribute("label", labels[command] ?? label);
      if (key) {
        el.setAttribute("key", key.id);
      }
      if (key?.keycode) {
        el.setAttribute("aria-keyshortcuts", ariaShortcut(key));
      }
      return el;
    };
    const checkItem = (command, label) => {
      const el = item(command, label);
      el.setAttribute("type", "checkbox");
      return el;
    };
    const submenu = (command, label) => {
      const el = this.#window.document.createXULElement("menu");
      el.setAttribute("data-command", command);
      el.setAttribute("label", labels[command] ?? label);
      el.append(this.#window.document.createXULElement("menupopup"));
      return el;
    };
    const keys = MENU_KEYS;
    const splitKey = { id: "key_addTabSplitView" };

    // Each block of like entries follows a separator, in the order
    // `SvalPanelModel.contextMenuItems` lists them.
    const separator = command => {
      const el = this.#window.document.createXULElement("menuseparator");
      el.setAttribute("data-command", command);
      return el;
    };

    return [
      // Accel+T opens a new tab too, at the top of the Workspace
      // (`SvalTabs`), as the header's New tab button names it.
      item("addTab", "New tab", { id: "key_newNavigatorTab" }),
      item("addGroup", "New group"),
      separator("nameSeparator"),
      item("rename", "Rename", keys.rename),
      // Shown on a tab that has a label (`sync`).
      item("clearLabel", "Remove Name"),
      item("edit", "Edit…"),
      separator("moveSeparator"),
      item("moveBefore", "Move up", keys.moveUp),
      item("moveAfter", "Move down", keys.moveDown),
      // "Move to group" is a submenu filled on every `popupshowing`, because
      // which groups it lists depends on the row and on a document another
      // device may have changed since the last time it opened.
      submenu("moveToGroup", "Move to group"),
      item("groupSelection", "New group with selection"),
      // "Move to workspace" is filled the same way, because the workspaces it
      // lists change whenever a peer adds or removes one.
      submenu("moveToWorkspace", "Move to Workspace"),
      separator("keepSeparator"),
      // Firefox's "Pin Tab", which is a pin of Sval's (pins spec §8.1).
      item("pin", "Pin"),
      item("pinHere", "Pin to This Workspace"),
      // Labelled for the row's page on every `popupshowing`, as the favorite
      // button is (`#syncFavorite`).
      item("favorite", "Add to Favorites"),
      item("copyMarkdownLink", "Copy Markdown Link"),
      // Shown where the row's page can have a style (`#syncStyle`).
      item("styleSite", "Colorshift This Site…", {
        id: STYLE_KEY,
      }),
      separator("createSplitSeparator"),
      item("createSplit", "Create Split", splitKey),
      // Filled each time the menu opens, with the splits that have room.
      submenu("addToSplit", "Add to Split"),
      separator("loadSeparator"),
      item("unload", "Put to Sleep"),
      checkItem("keepLoaded", "Keep Awake"),
      // Labelled, and hidden while nothing plays, on every `popupshowing`
      // (`#syncMedia`).
      item("media", "Pause Media"),
      separator("closeSeparator"),
      item("close", "Close", keys.delete),
      item("deleteGroup", "Delete group…", keys.delete),
      item("deleteWorkspace", "Delete Workspace…"),
      separator("splitSeparator"),
      item("addTabToSplit", "Add Tab to Split", splitKey),
      item("separate", "Separate", { id: "key_separateTabSplitView" }),
      item("movePaneLeft", "Move Pane Left", keys.movePaneLeft),
      item("movePaneRight", "Move Pane Right", keys.movePaneRight),
      item("renameSplit", "Rename Split…"),
      separator("closeSplitSeparator"),
      item("closeSplit", "Close All"),
    ];
  }

  /**
   * Opens the row context menu for `row`: at the pointer for a mouse
   * `contextmenu`, and under the row for a key, as `SvalFavoritesMenu._onKey`
   * opens the Favorites menu's.
   *
   * The row is selected before the menu opens, as
   * `TabListView.handleContextMenu`'s `onSelectRow` does, so "New group" below
   * files inside the row the menu is for rather than whatever the tree's
   * selection happened to be already. A row of a selection keeps the
   * selection, and the menu acts on all of it (spec §10.5); any other row
   * clears it.
   *
   * @param {object} row A row from `SvalPanelModel.rows`.
   * @param {MouseEvent} [event] The `contextmenu`, when there is one.
   */
  open(row, event) {
    this.#view.focusRow(row.id);
    if (!this.#view.selection.around(row)) {
      this.#view.selection.clear(row.id);
      this.#view.selection.select(row.id);
    }
    this.#rowId = row.id;
    openContextMenu(this.#menu, this.#view.rowElementFor(row.id), event);
  }

  /**
   * Shows only the commands {@link SvalPanelModel.contextMenuItems} names for
   * the row the menu was opened on.
   *
   * @param {Event} event `popupshowing` on `#sval-row-context-menu`.
   */
  #onShowing(event) {
    if (event.target !== this.#menu) {
      return;
    }
    const row = this.#view.rowFor(this.#rowId);
    this.sync(this.#menu, row, this.#view.selection.around(row));
    // An entry the row's list names can still be hidden here, as a pin is
    // where `canPin` refuses, and its block's separator goes with it.
    lazy.tidySeparators(this.#menu);
  }

  /**
   * Shows the entries of a menu built from `#items` that
   * {@link SvalPanelModel.contextMenuItems} names for `row`, and fits them to
   * it, or to the selection it is one of.
   *
   * @param {Element} menu
   * @param {object|null} row
   * @param {string[]|null} [several] The selection the menu acts on.
   */
  sync(menu, row, several = null) {
    const shown = new Set(
      row
        ? contextMenuItems(row.kind, {
            temporary: !!this.#view.inMemory,
            pane: !!row.split,
            several: !!several,
          })
        : []
    );
    for (const child of menu.children) {
      child.hidden = !shown.has(child.dataset.command);
      child.removeAttribute("disabled");
    }
    // An agent's workspace shows no pins (pins spec §7), and a pin is a web
    // page's.
    for (const command of ["pin", "pinHere"]) {
      const pin = menu.querySelector(`[data-command="${command}"]`);
      if (pin && !pin.hidden && row) {
        pin.hidden = !this.#view.pins?.canPin(row.id);
      }
    }
    const clearLabel = menu.querySelector('[data-command="clearLabel"]');
    if (clearLabel && !clearLabel.hidden) {
      clearLabel.hidden = !this.#view.nodes[row?.id]?.appearance?.label;
    }
    if (several) {
      this.#syncSelection(menu, several);
      return;
    }
    if (row) {
      this.#syncMoves(menu, row);
      menu
        .querySelector('[data-command="unload"]')
        ?.toggleAttribute(
          "disabled",
          !this.#view.tabsUnder(row).some(lazy.canUnload)
        );
      this.#syncKeepLoaded(menu, row);
      this.#syncMedia(menu, row);
      this.#syncFavorite(menu, row);
      this.#syncStyle(menu, row);
    }
    if (row?.split) {
      this.#syncSplit(menu, row);
    } else if (row?.kind === TAB) {
      this.#fillAddToSplit(menu, row);
    }
  }

  /**
   * Hides Style This Site where `row`'s page can have no style: a page with
   * no site, a private window's, or a row this window holds no tab for.
   *
   * @param {Element} menu
   * @param {object} row
   */
  #syncStyle(menu, row) {
    const item = menu.querySelector('[data-command="styleSite"]');
    if (!item || item.hidden) {
      return;
    }
    const tab = this.#view.observer?.tabFor(row.id);
    item.hidden = !tab || !lazy.styleScopeOf(tab.linkedBrowser);
  }

  /**
   * Checks Keep Awake when `row`'s tab is kept loaded, and disables it when
   * this window holds no tab for the row.
   *
   * @param {Element} menu
   * @param {object} row
   */
  #syncKeepLoaded(menu, row) {
    const item = menu.querySelector('[data-command="keepLoaded"]');
    if (!item) {
      return;
    }
    const tab = this.#view.observer?.tabFor(row.id);
    item.toggleAttribute("disabled", !tab);
    item.toggleAttribute("checked", !!tab && lazy.isKeptLoaded(tab));
  }

  /**
   * Shows the media entry while `row`'s media button does, labelled for what
   * it does ({@link _rowMedia}).
   *
   * @param {Element} menu
   * @param {object} row
   */
  #syncMedia(menu, row) {
    const item = menu.querySelector('[data-command="media"]');
    if (!item || item.hidden) {
      return;
    }
    const action = lazy.SvalFirefox.mediaActionOf(this.#view.tabsUnder(row));
    item.hidden = !action;
    item.setAttribute("label", this.#view.mediaLabel(action));
  }

  /**
   * Names what Add to Favorites does for `row`'s page, adding it or taking
   * it out as the favorite button does (`SvalFavorites.toggle`), and
   * disables it when this window holds no tab for the row.
   *
   * @param {Element} menu
   * @param {object} row
   */
  #syncFavorite(menu, row) {
    const item = menu.querySelector('[data-command="favorite"]');
    if (!item || item.hidden) {
      return;
    }
    const tab = this.#view.observer?.tabFor(row.id);
    const starred =
      !!tab &&
      lazy.SvalFavorites.isCurrentFavorite(this.#window, tab.linkedBrowser);
    item.toggleAttribute("disabled", !tab);
    item.setAttribute(
      "label",
      starred ? "Remove from Favorites" : "Add to Favorites"
    );
    item.dataset.favorite = String(starred);
    // Accel+D adds the shown tab's page and never removes one
    // (`SvalFavorites.addPage`). A menu names the key of the command on
    // whichever tab it was opened for, so adding names it on every row.
    if (!starred) {
      item.setAttribute("key", "addBookmarkAsKb");
    } else {
      item.removeAttribute("key");
    }
  }

  /**
   * Fills "Add to Split" with the splits in this window's workspace that have
   * room for `row`'s tab, each named as its row is: its name, or its pages'
   * titles.
   *
   * @param {Element} menu
   * @param {object} row A tab's row, not a pane's.
   */
  #fillAddToSplit(menu, row) {
    const parent = menu.querySelector('[data-command="addToSplit"]');
    const popup = parent.querySelector("menupopup");
    popup.textContent = "";
    const choices = addToSplitChoices(
      this.#view.nodes,
      row.id,
      this.#view.workspace.id
    );
    const byParent = childrenByParent(this.#view.nodes);
    for (const split of choices) {
      const titles = splitTabs(this.#view.nodes, split, byParent).map(
        id => displayName(this.#view.nodes[id]) || this.#view.untitled(TAB)
      );
      const entry = this.#window.document.createXULElement("menuitem");
      entry.setAttribute("data-join-split", split);
      entry.setAttribute(
        "label",
        this.#view.nodes[split].content?.name || titles.join(", ")
      );
      popup.append(entry);
    }
    parent.toggleAttribute("disabled", !choices.length);
  }

  /**
   * Fits a pane's split entries to its place: Add Tab to Split is disabled
   * on a full split, Move Pane Left on the first pane and Move Pane Right on
   * the last, and Close All reads Close Both when there are two (split-view
   * spec §6.3).
   *
   * @param {Element} menu
   * @param {object} pane A pane's row.
   */
  #syncSplit(menu, pane) {
    menu
      .querySelector('[data-command="addTabToSplit"]')
      .toggleAttribute("disabled", !splitHasRoom(this.#view.nodes, pane.split));
    menu
      .querySelector('[data-command="movePaneLeft"]')
      .toggleAttribute("disabled", pane.posinset === 1);
    menu
      .querySelector('[data-command="movePaneRight"]')
      .toggleAttribute("disabled", pane.posinset === pane.setsize);
    // Close All closes the split's every tab, more than one run's when a
    // merge left it holding more than four.
    const tabs = splitTabs(this.#view.nodes, pane.split);
    // The Tab menu has no Close All.
    const closeAll = menu.querySelector('[data-command="closeSplit"]');
    closeAll?.setAttribute(
      "label",
      tabs.length === 2 ? "Close Both" : "Close All"
    );
    closeAll?.toggleAttribute("data-both", tabs.length === 2);
  }

  /**
   * Disables the moves `row` has nowhere to make, and fills "Move to group"
   * and "Move to Workspace" with the places it can go.
   *
   * Asked of the same model functions the keyboard and a drop use, so the
   * menu never offers a move one of those would refuse.
   *
   * @param {Element} menu
   * @param {object} row The row the menu was opened on.
   */
  #syncMoves(menu, row) {
    // A pane's moves move its split (split-view spec §6.3).
    const id = this.#view.movingId(row);
    for (const command of ["moveBefore", "moveAfter"]) {
      const possible = moveTarget(this.#view.nodes, id, command);
      menu
        .querySelector(`[data-command="${command}"]`)
        .toggleAttribute("disabled", !possible);
    }
    this.#fillMoveToGroup(menu, [id]);
    this.#fillMoveToWorkspace(menu, [row.id]);
  }

  /**
   * Fits a menu opened on a selection to it (spec §10.5): the entries that
   * act on one row are disabled, Close is disabled unless every selected row
   * is a tab, and the moves list where the whole selection can go.
   *
   * @param {Element} menu
   * @param {string[]} several The selected rows.
   */
  #syncSelection(menu, several) {
    const roots = this.#view.selection.roots(several);
    for (const child of menu.children) {
      if (
        child.localName !== "menuseparator" &&
        !SELECTION_COMMANDS.has(child.dataset.command)
      ) {
        child.setAttribute("disabled", "true");
      }
    }
    menu
      .querySelector('[data-command="close"]')
      ?.toggleAttribute("disabled", !this.#view.closesSelection(several));
    menu
      .querySelector('[data-command="groupSelection"]')
      ?.toggleAttribute(
        "disabled",
        !groupSelectionTarget(this.#view.nodes, roots)
      );
    this.#fillMoveToGroup(menu, roots);
    this.#fillMoveToWorkspace(menu, roots);
  }

  /**
   * Fills "Move to group" with the places `ids` can go, then "New group…",
   * which makes a group in the first one's place and moves them all into it.
   *
   * The submenu's entries are indented by depth with em spaces. A native
   * `NSMenu` draws labels and nothing else, so indentation in the label is the
   * one way to show nesting there, and an em space survives where leading
   * ordinary spaces may be trimmed.
   *
   * @param {Element} menu
   * @param {string[]} ids The nodes a move moves.
   */
  #fillMoveToGroup(menu, ids) {
    const parent = menu.querySelector('[data-command="moveToGroup"]');
    const popup = parent.querySelector("menupopup");
    popup.textContent = "";
    const choices = moveToGroupChoices(
      this.#view.nodes,
      ids,
      this.#view.workspace.id,
      {
        transparent: this.#view.transparentIds(),
      }
    );
    for (const choice of choices) {
      const entry = this.#window.document.createXULElement("menuitem");
      entry.setAttribute("data-move-parent", choice.id);
      if (choice.kind === WORKSPACE) {
        entry.setAttribute("label", "No group");
      } else {
        const node = this.#view.nodes[choice.id];
        const name = node?.content?.name || this.#view.untitled(choice.kind);
        const emoji = node?.appearance?.emoji;
        entry.setAttribute(
          "label",
          " ".repeat(choice.depth) + (emoji ? `${emoji} ${name}` : name)
        );
        // The indent shows nesting only to the eye.
        const outer = this.#view.nodes[node?.placement?.parent];
        if (choice.depth > 0 && outer) {
          entry.setAttribute(
            "aria-description",
            `in ${outer.content?.name || this.#view.untitled(outer.kind)}`
          );
        }
      }
      popup.append(entry);
      if (choice.kind === WORKSPACE && choices.length > 1) {
        popup.append(this.#window.document.createXULElement("menuseparator"));
      }
    }
    if (choices.length) {
      popup.append(this.#window.document.createXULElement("menuseparator"));
    }
    const fresh = this.#window.document.createXULElement("menuitem");
    fresh.setAttribute("data-new-group", "true");
    fresh.setAttribute("label", "New group…");
    popup.append(fresh);
  }

  /**
   * Runs the clicked menu item through the same `run` every keyboard command
   * and header button already goes through, so a menu entry is never a second
   * implementation of the action it names.
   *
   * @param {Event} event `command` from a `menuitem`.
   */
  #onCommand(event) {
    const row = this.#view.rowFor(this.#rowId);
    this.#run(event, row, this.#view.selection.around(row));
  }

  /**
   * Runs an entry of a menu built from `#items` on `row`, or on
   * the selection it is one of. A command `run` takes finds the selection
   * from `row` itself.
   *
   * @param {Event} event `command` from a `menuitem`.
   * @param {object|null} row
   * @param {string[]|null} [several] The selection the menu acts on.
   */
  #run(event, row, several = null) {
    if (!row) {
      return;
    }
    // A pane's moves move its split (split-view spec §6.3).
    const moving = several
      ? this.#view.selection.roots(several)
      : this.#view.movingId(row);
    if (event.target.hasAttribute("data-move-parent")) {
      const parent = event.target.getAttribute("data-move-parent");
      this.#view.guard("moveInto", () =>
        this.#view.moveInto(moving, parent, row.id)
      );
      return;
    }
    if (event.target.hasAttribute("data-new-group")) {
      this.#view.guard("newGroup", () =>
        this.#view.newGroupWith([moving].flat())
      );
      return;
    }
    if (event.target.hasAttribute("data-join-split")) {
      const split = event.target.getAttribute("data-join-split");
      this.#view.guard("joinSplit", () => this.#view.joinSplit(split, row.id));
      return;
    }
    if (event.target.hasAttribute("data-move-workspace")) {
      const workspace = event.target.getAttribute("data-move-workspace");
      this.#view.guard("moveToWorkspace", () =>
        this.#view.moveToWorkspace(moving, workspace)
      );
      return;
    }
    const command = event.target.dataset.command;
    if (command) {
      this.#view.run(command, row);
    }
  }

  /**
   * The menu bar's Tab menu's entries (`SvalMenuBar`): the row menu's that
   * act on one tab, labelled as the menu bar labels its items, for
   * `syncBar` to fit to the selected tab.
   *
   * @returns {Element[]}
   */
  barItems() {
    const items = new Map(
      this.#items(TAB_MENU_LABELS).map(el => [el.dataset.command, el])
    );
    return Object.keys(TAB_MENU_LABELS).map(command => items.get(command));
  }

  /**
   * Fits the Tab menu's entries to the selected tab: its row's, or for a
   * selected pin, which has no row (pins spec §4), Move Pin to Favorites
   * alone.
   *
   * @param {Element} menu The Tab menu's `menupopup`.
   */
  syncBar(menu) {
    const pin = this.#view.built ? this.#view.pins?.selectedPin : null;
    const row = pin ? null : this.#selectedTabRow();
    this.sync(menu, row);
    const pinItem = menu.querySelector('[data-command="pin"]');
    pinItem.setAttribute(
      "label",
      pin ? "Move Pin to Favorites" : TAB_MENU_LABELS.pin
    );
    pinItem.dataset.pinned = String(!!pin);
    if (pin) {
      pinItem.hidden = false;
      menu.querySelector('[data-command="pinHere"]').hidden = true;
    }
    // A tab's row offers Create Split and a pane's the split's entries
    // (`SvalPanelModel.contextMenuItems`), so a row always has a block here.
    menu.querySelector('[data-command="splitSeparator"]').hidden = !row;
  }

  /**
   * @param {Event} event `command` in the menu bar's Tab menu.
   */
  runBarCommand(event) {
    if (!this.#view.built) {
      return;
    }
    const pin = this.#view.pins?.selectedPin;
    if (pin) {
      if (event.target.dataset.command === "pin") {
        this.#view.guard("moveToFavorites", () =>
          this.#view.pins.moveToFavoritesGuid(pin.guid)
        );
      }
      return;
    }
    this.#run(event, this.#selectedTabRow());
  }

  /** @returns {object|null} the selected tab's row, while the tree shows it. */
  #selectedTabRow() {
    if (!this.#view.built) {
      return null;
    }
    const id = this.#view.observer?.nodeIdFor(
      this.#window.gBrowser.selectedTab
    );
    return id ? this.#view.rowFor(id) : null;
  }

  /**
   * Fills "Move to Workspace" with the Workspaces `ids` can go to, as the
   * panel lists them.
   *
   * @param {Element} menu
   * @param {string[]} ids The rows the menu is for.
   */
  #fillMoveToWorkspace(menu, ids) {
    const popup = menu.querySelector(
      '[data-command="moveToWorkspace"] menupopup'
    );
    popup.textContent = "";
    this.#view.fillMoveToWorkspace(popup, ids);
  }
}
