/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The workspace panel's two context menus: the row menu, on a row of the
 * tree, and the workspace menu, on the switcher. Each is built once, shows the
 * entries that fit what it was opened on, and runs them through `run`.
 *
 * `SvalWindow` loads this as a classic script after `sval-panel.js`; it adds
 * its methods to `SvalPanel`, whose state and helpers it shares.
 */

/* import-globals-from sval-panel.js */

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

Object.assign(SvalPanel, {
  /** The row the context menu was last opened on, as a node id. */
  _contextRowId: null,

  /** The workspace the workspace menu was last opened on. */
  _workspaceMenuId: null,

  /**
   * Builds the row context menu once and parks it in `#mainPopupSet`, which
   * `browser.xhtml` already declares. A `<menupopup>` is what gives the menu
   * keyboard navigation, dismissal and platform placement for free, which is
   * why `sidebar-context-menu` and `tabContextMenu` are XUL popups too, and
   * creating it here needs no patch to that markup, only an element appended
   * to a popupset Mozilla already ships.
   *
   * One item per possible command, shown or hidden per row kind on
   * `popupshowing` (`_onContextMenuShowing`) rather than rebuilt each time,
   * as `browser/components/syncedtabs/TabListView.sys.mjs`'s
   * `adjustContextMenu` toggles `hidden` on a fixed set, for the same
   * reason: the menu's own `command` event is what runs the action, so there
   * is nothing to rebuild.
   *
   * @returns {Element} the `menupopup`.
   */
  _buildContextMenu() {
    const menu = document.createXULElement("menupopup");
    menu.id = "sval-row-context-menu";
    document.getElementById(menu.id)?.remove();
    menu.append(...this._rowMenuItems());
    menu.addEventListener("popupshowing", this);
    menu.addEventListener("command", this);
    document.getElementById("mainPopupSet").append(menu);
    return menu;
  },

  /**
   * One element per command a row's menu can offer, in the row menu's order,
   * for the row menu and the menu bar's Tab menu (`SvalMenuBar`).
   *
   * @param {object} [labels] Labels by command, over the row menu's own.
   * @returns {Element[]}
   */
  _rowMenuItems(labels = {}) {
    // An item a row's key also runs names that key (`SvalShortcuts`). A key
    // of Firefox's, given by its id alone, can be remapped, so its
    // accelerator is left to the item's accessible
    // (`XULMenuitemAccessible::KeyboardShortcut`), which reads the key as it
    // is.
    const item = (command, label, key) => {
      const el = document.createXULElement("menuitem");
      el.setAttribute("data-command", command);
      el.setAttribute("label", labels[command] ?? label);
      if (key) {
        el.setAttribute("key", key.id);
      }
      if (key?.keycode) {
        el.setAttribute("aria-keyshortcuts", this._modules.ariaShortcut(key));
      }
      return el;
    };
    const checkItem = (command, label) => {
      const el = item(command, label);
      el.setAttribute("type", "checkbox");
      return el;
    };
    const submenu = (command, label) => {
      const el = document.createXULElement("menu");
      el.setAttribute("data-command", command);
      el.setAttribute("label", labels[command] ?? label);
      el.append(document.createXULElement("menupopup"));
      return el;
    };
    const keys = this._modules.MENU_KEYS;
    const splitKey = { id: "key_addTabSplitView" };

    // Each block of like entries follows a separator, in the order
    // `SvalPanelModel.contextMenuItems` lists them.
    const separator = command => {
      const el = document.createXULElement("menuseparator");
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
      // Shown on a tab that has a label (`_syncRowMenu`).
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
      // button is (`_syncFavoriteItem`).
      item("favorite", "Add to Favorites"),
      item("copyMarkdownLink", "Copy Markdown Link"),
      // Shown where the row's page can have a style (`_syncStyleItem`).
      item("styleSite", "Colorshift This Site…", {
        id: this._modules.STYLE_KEY,
      }),
      separator("createSplitSeparator"),
      item("createSplit", "Create Split", splitKey),
      // Filled each time the menu opens, with the splits that have room.
      submenu("addToSplit", "Add to Split"),
      separator("loadSeparator"),
      item("unload", "Put to Sleep"),
      checkItem("keepLoaded", "Keep Awake"),
      // Labelled, and hidden while nothing plays, on every `popupshowing`
      // (`_syncMediaItem`).
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
  },

  /**
   * Builds the menu a right-click on the switcher opens: the commands that act
   * on the workspace this window shows, or on the switcher entry it was
   * right-clicked on.
   *
   * The workspace is not a row (spec §10.7), so it has no row menu to
   * right-click; the switcher button is what names it, and so is where its
   * context menu is. A left-click on the same button opens the list of
   * workspaces to go to, which is a different question.
   *
   * Fixed items, built once, like the row menu: the entries do not depend on
   * how many workspaces there are.
   *
   * @returns {Element} the `menupopup`.
   */
  _buildWorkspaceMenu() {
    const menu = document.createXULElement("menupopup");
    menu.id = "sval-workspace-context-menu";
    document.getElementById(menu.id)?.remove();
    // A Workspace no window shows can have one of its own, as the switcher
    // menu's entries offer; {@link _onWorkspaceMenuShowing} shows it on the
    // strip.
    const open = document.createXULElement("menuitem");
    open.setAttribute("data-open-workspace", "true");
    open.setAttribute("label", "Open in New Window");
    menu.append(
      open,
      document.createXULElement("menuseparator"),
      ...this._workspaceCommandItems(),
      ...this._stripNamesItems()
    );
    menu.addEventListener("popupshowing", this);
    menu.addEventListener("command", this);
    document.getElementById("mainPopupSet").append(menu);
    return menu;
  },

  /**
   * The strip's names controls, which the Workspace menu shows under its
   * commands when it opens on the strip ({@link _syncStripNamesItems}).
   * Each sets what Settings › Workspaces sets, "The strip shows"
   * (`SvalPanelModel.STRIP_NAMES_PREF`).
   *
   * @returns {Element[]}
   */
  _stripNamesItems() {
    const item = (names, label) => {
      const el = document.createXULElement("menuitem");
      el.setAttribute("data-strip-names", names);
      el.setAttribute("label", label);
      return el;
    };
    const separator = document.createXULElement("menuseparator");
    separator.setAttribute("data-strip-names-separator", "true");
    const show = document.createXULElement("menu");
    show.setAttribute("data-strip-names-menu", "true");
    show.setAttribute("label", "Show Workspace Names");
    const popup = document.createXULElement("menupopup");
    popup.append(
      item("all", "On Every Workspace"),
      item("current", "On the Current Workspace")
    );
    show.append(popup);
    return [
      separator,
      item("all", "Show Every Workspace's Name"),
      item("none", "Hide Workspace Names"),
      show,
    ];
  },

  /**
   * Shows the names controls that change what the strip shows now, and
   * only on the strip: names on every Workspace can be hidden; only the
   * current name can be shown on every Workspace or hidden; with none, the
   * submenu offers both ways to show them.
   *
   * @param {boolean} onStrip
   */
  _syncStripNamesItems(onStrip) {
    const menu = this._els.workspaceMenu;
    const names = this._stripNames();
    for (const el of menu.querySelectorAll(
      ":scope > [data-strip-names], :scope > [data-strip-names-separator], :scope > [data-strip-names-menu]"
    )) {
      let shown = onStrip;
      if (el.dataset.stripNames === "all") {
        shown &&= names === "current";
      } else if (el.dataset.stripNames === "none") {
        shown &&= names !== "none";
      } else if (el.hasAttribute("data-strip-names-menu")) {
        shown &&= names === "none";
      }
      el.hidden = !shown;
    }
  },

  /**
   * The entries that act on one workspace, as the workspace menu and each
   * switcher entry's submenu list them. {@link _syncWorkspaceCommands} shows
   * the ones that apply.
   *
   * @returns {Element[]}
   */
  _workspaceCommandItems() {
    const item = (command, label) => {
      const el = document.createXULElement("menuitem");
      el.setAttribute("data-command", command);
      el.setAttribute("label", label);
      return el;
    };
    return [
      // Labelled, and shown only for this device's agents, by
      // `_syncWorkspaceCommands`.
      item("stopAgent", "Stop Agent"),
      // Labelled with the agent's name, and shown with Stop, by
      // `_syncWorkspaceCommands`.
      item("agentPermissions", "Permissions…"),
      document.createXULElement("menuseparator"),
      // Labelled, and hidden while nothing plays, by
      // `_syncWorkspaceCommands`.
      item("media", "Pause Media"),
      document.createXULElement("menuseparator"),
      item("edit", "Edit…"),
      item("isolateWorkspace", "Isolate Workspace…"),
      item("shareWorkspace", "Stop isolating Workspace…"),
      document.createXULElement("menuseparator"),
      item("deleteWorkspace", "Delete Workspace…"),
    ];
  },

  /**
   * Shows the entries of {@link _workspaceCommandItems} that apply to
   * workspace `id`. "Delete workspace" is offered only where there is one to
   * delete: never in a private window, and never for the last workspace.
   *
   * @param {Element} popup The `menupopup` holding them.
   * @param {string} id A workspace id.
   */
  _syncWorkspaceCommands(popup, id) {
    const command = name => popup.querySelector(`[data-command="${name}"]`);
    // A window's one temporary workspace on a tree in memory is not the
    // user's to delete (`SvalPanelModel.contextMenuItems`).
    const remove = command("deleteWorkspace");
    remove.hidden = !!this._inMemory;
    remove.previousElementSibling.hidden = !!this._inMemory;
    // The last workspace stays: a window always shows one (spec §5.4).
    remove.toggleAttribute(
      "disabled",
      this._modules.SvalPanelModel.workspaceIds(this._nodes).length < 2
    );
    // A private window's workspace already has a jar of its own, and goes
    // with the window.
    const isolated = this._modules.SvalWorkspaceJar.isIsolated(this._nodes, id);
    command("isolateWorkspace").hidden = !!this._inMemory || isolated;
    command("shareWorkspace").hidden = !!this._inMemory || !isolated;
    // A Stop holds where its agent's session runs, so only an agent this
    // device paired is offered one (`SvalAgentControl.stopWorkspace`).
    const stop = command("stopAgent");
    const agent = this._modules.SvalAgents.store?.agentOfWorkspace(id);
    stop.hidden = !agent;
    const permissions = command("agentPermissions");
    permissions.hidden = !agent;
    permissions.nextElementSibling.hidden = !agent;
    if (agent) {
      permissions.setAttribute("label", `${agent.label} Permissions…`);
    }
    stop.setAttribute(
      "label",
      this._settings.isAgentStopped(id) ? "Resume Agent" : "Stop Agent"
    );
    const media = command("media");
    const action = this._workspaceMedia(id);
    media.hidden = !action;
    media.nextElementSibling.hidden = !action;
    media.setAttribute("label", this._mediaLabel(action));
  },

  /**
   * Every tab of workspace `id` in any window, its pins' pages in this one
   * included, as the switcher's media button stands for them (spec §10.7).
   *
   * @param {string} id A workspace id.
   * @returns {object[]} Firefox tabs.
   */
  _workspaceTabs(id) {
    const { descendantIds } = this._modules.SvalPanelModel;
    return [
      ...this._tabsOfNodes(descendantIds(this._nodes, id)),
      ...(this._pins?.pages.tabsOfWorkspace(id) ?? []),
    ];
  },

  /**
   * @param {string} id A workspace id.
   * @returns {?string} what its media button offers
   *   (`SvalFirefox.mediaActionOf`).
   */
  _workspaceMedia(id) {
    return this._modules.SvalFirefox.mediaActionOf(this._workspaceTabs(id));
  },

  /**
   * Opens the row context menu on a right-click, or on the `contextmenu`
   * event the Windows and GTK widgets make of the context-menu key and
   * Shift+F10. Those keys reach `keyCommand` first, which opens the menu
   * itself on every platform (`_openRowMenu`), so a `contextmenu` arriving
   * while the menu is up is that same key and is left alone.
   *
   * @param {Event} event A `contextmenu` event on the tree or the switcher.
   */
  _onContextMenu(event) {
    const onSwitcher =
      event.currentTarget === this._els.switcher ||
      event.currentTarget === this._els.switcherMenu;
    const menu = onSwitcher ? this._els.workspaceMenu : this._els.contextMenu;
    if (menu.state === "showing" || menu.state === "open") {
      return;
    }
    if (event.currentTarget === this._els.switcherMenu) {
      // A right-click on an entry, or inside its submenu, is for its
      // workspace; elsewhere in the list there is none to act on.
      event.preventDefault();
      const id = event.target.closest("[data-workspace-id]")?.dataset
        .workspaceId;
      if (id) {
        this._openWorkspaceMenu(event, id);
      }
      return;
    }
    if (onSwitcher) {
      this._openWorkspaceMenu(event);
      return;
    }
    const rowElement = this._rowElementAt(event.target);
    let row = rowElement ? this._rowFor(rowElement.dataset.nodeId) : null;
    // A split's own menu is its panes': the tray between them stands for the
    // active one.
    if (row?.panes) {
      row = this._activePane(row);
    }
    if (row) {
      this._openRowMenu(row, event);
    }
  },

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
  _openRowMenu(row, event) {
    this._focusRow(row.id);
    if (!this._selectionFor(row)) {
      this._clearSelection(row.id);
      this._select(row.id);
    }
    this._contextRowId = row.id;
    this._openMenu(this._els.contextMenu, this._rowElementFor(row.id), event);
  },

  /**
   * Opens the workspace menu, for the workspace this window shows or a
   * switcher entry's. Nothing opens when the document holds no workspace,
   * because every entry acts on one.
   *
   * @param {MouseEvent} [event] The `contextmenu` on the switcher or an
   *   entry; none for the context-menu key or Shift+F10 there.
   * @param {string} [id] The workspace it acts on.
   * @param {Element} [anchor] What a key opened it on.
   * @param {boolean} [onStrip] Whether it opened on the strip, which adds
   *   the names controls ({@link _stripNamesItems}).
   */
  _openWorkspaceMenu(
    event,
    id = this._currentWorkspaceId,
    anchor = this._els.switcher,
    onStrip = false
  ) {
    if (!id) {
      return;
    }
    this._workspaceMenuId = id;
    this._workspaceMenuOnStrip = onStrip;
    this._openMenu(this._els.workspaceMenu, anchor, event);
  },

  /**
   * @param {Element} menu A context `menupopup`.
   * @param {Element} anchor What a key opened it on.
   * @param {MouseEvent} [event] A `contextmenu`, which opens it at the pointer.
   */
  _openMenu(menu, anchor, event) {
    if (event) {
      menu.openPopupAtScreen(event.screenX, event.screenY, true, event);
    } else {
      menu.openPopup(anchor, { position: "after_start", isContextMenu: true });
    }
  },

  /**
   * The context-menu key and Shift+F10 on the switcher open the workspace
   * menu, for the reason `keyCommand` gives for a row.
   *
   * @param {KeyboardEvent} event `keydown` on the switcher.
   */
  _onSwitcherKeyDown(event) {
    if (this._modules.SvalPanelModel.keyCommand(event, {}) !== "contextMenu") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this._openWorkspaceMenu();
  },

  /**
   * Shows the workspace menu's entries for the workspace it opened on
   * ({@link _openWorkspaceMenu}).
   */
  _onWorkspaceMenuShowing() {
    const menu = this._els.workspaceMenu;
    const id = this._workspaceMenuId;
    this._syncWorkspaceCommands(menu, id);
    const item = this._modules.SvalPanelModel.switcherItemOf(
      this._nodes,
      id,
      this._currentWorkspaceId
    );
    // A Workspace has one window (spec §10.7). The switcher's menu offers
    // a new one in each entry's submenu, and the strip here.
    const open = menu.querySelector(":scope > [data-open-workspace]");
    open.hidden =
      !this._workspaceMenuOnStrip ||
      !!this._inMemory ||
      !item ||
      item.current ||
      this.workspacesShownElsewhere().has(id);
    open.nextElementSibling.hidden = open.hidden;
    // The column shows no names whatever the choice, so it offers no names
    // controls.
    this._syncStripNamesItems(
      this._workspaceMenuOnStrip && this._els.strip.dataset.layout !== "column"
    );
  },

  /**
   * @param {Event} event `command` from the workspace menu.
   */
  _onWorkspaceMenuCommand(event) {
    const { command, stripNames, openWorkspace } = event.target.dataset;
    if (stripNames) {
      Services.prefs.setStringPref(
        this._modules.SvalPanelModel.STRIP_NAMES_PREF,
        stripNames
      );
      return;
    }
    if (openWorkspace && this._workspaceMenuId) {
      this._openWorkspaceInNewWindow(this._workspaceMenuId);
      return;
    }
    if (command && this._workspaceMenuId) {
      this._runWorkspaceCommand(command, this._workspaceMenuId);
    }
  },

  /**
   * Runs one of {@link _workspaceCommandItems} through `run`, closing the
   * switcher first when it is open, since each opens a dialog. Each command
   * reads only the id from its row, and the workspace is not one.
   *
   * @param {string} command
   * @param {string} id A workspace id.
   */
  _runWorkspaceCommand(command, id) {
    if (command === "media") {
      this._modules.SvalFirefox.actOnMedia(this._workspaceTabs(id));
      return;
    }
    if (command === "agentPermissions") {
      const agent = this._modules.SvalAgents.store?.agentOfWorkspace(id);
      if (agent) {
        this._els.switcherMenu.hidePopup();
        window.openPreferences(
          `paneSvalAgents-agent?${new URLSearchParams({ id: agent.agentId })}`
        );
      }
      return;
    }
    if (command === "stopAgent") {
      this._modules.SvalAgentControl.stopWorkspace(
        id,
        !this._settings.isAgentStopped(id)
      );
      return;
    }
    if (
      command !== "edit" &&
      command !== "deleteWorkspace" &&
      command !== "isolateWorkspace" &&
      command !== "shareWorkspace"
    ) {
      return;
    }
    this._els.switcherMenu.hidePopup();
    this.run(command, { id });
  },

  /**
   * Shows only the commands {@link SvalPanelModel.contextMenuItems} names for
   * the row the menu was opened on.
   *
   * @param {Event} event `popupshowing` on `#sval-row-context-menu`.
   */
  _onContextMenuShowing(event) {
    if (event.target !== this._els.contextMenu) {
      return;
    }
    const row = this._rowFor(this._contextRowId);
    this._syncRowMenu(this._els.contextMenu, row, this._selectionFor(row));
    // An entry the row's list names can still be hidden here, as a pin is
    // where `canPin` refuses, and its block's separator goes with it.
    this._modules.tidySeparators(this._els.contextMenu);
  },

  /**
   * Shows the entries of a menu built from {@link _rowMenuItems} that
   * {@link SvalPanelModel.contextMenuItems} names for `row`, and fits them to
   * it, or to the selection it is one of.
   *
   * @param {Element} menu
   * @param {object|null} row
   * @param {string[]|null} [several] The selection the menu acts on.
   */
  _syncRowMenu(menu, row, several = null) {
    const shown = new Set(
      row
        ? this._modules.SvalPanelModel.contextMenuItems(row.kind, {
            temporary: !!this._inMemory,
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
        pin.hidden = !this._pins?.canPin(row.id);
      }
    }
    const clearLabel = menu.querySelector('[data-command="clearLabel"]');
    if (clearLabel && !clearLabel.hidden) {
      clearLabel.hidden = !this._nodes[row?.id]?.appearance?.label;
    }
    if (several) {
      this._syncSelectionItems(menu, several);
      return;
    }
    if (row) {
      this._syncMoveItems(menu, row);
      menu
        .querySelector('[data-command="unload"]')
        ?.toggleAttribute(
          "disabled",
          !this._tabsUnder(row).some(this._modules.canUnload)
        );
      this._syncKeepLoaded(menu, row);
      this._syncMediaItem(menu, row);
      this._syncFavoriteItem(menu, row);
      this._syncStyleItem(menu, row);
    }
    if (row?.split) {
      this._syncSplitItems(menu, row);
    } else if (row?.kind === this._modules.SvalPanelModel.TAB) {
      this._fillAddToSplit(menu, row);
    }
  },

  /**
   * Hides Style This Site where `row`'s page can have no style: a page with
   * no site, a private window's, or a row this window holds no tab for.
   *
   * @param {Element} menu
   * @param {object} row
   */
  _syncStyleItem(menu, row) {
    const item = menu.querySelector('[data-command="styleSite"]');
    if (!item || item.hidden) {
      return;
    }
    const tab = this._observer?.tabFor(row.id);
    item.hidden = !tab || !this._modules.styleScopeOf(tab.linkedBrowser);
  },

  /**
   * Checks Keep Awake when `row`'s tab is kept loaded, and disables it when
   * this window holds no tab for the row.
   *
   * @param {Element} menu
   * @param {object} row
   */
  _syncKeepLoaded(menu, row) {
    const item = menu.querySelector('[data-command="keepLoaded"]');
    if (!item) {
      return;
    }
    const tab = this._observer?.tabFor(row.id);
    item.toggleAttribute("disabled", !tab);
    item.toggleAttribute("checked", !!tab && this._modules.isKeptLoaded(tab));
  },

  /**
   * Shows the media entry while `row`'s media button does, labelled for what
   * it does ({@link _rowMedia}).
   *
   * @param {Element} menu
   * @param {object} row
   */
  _syncMediaItem(menu, row) {
    const item = menu.querySelector('[data-command="media"]');
    if (!item || item.hidden) {
      return;
    }
    const action = this._modules.SvalFirefox.mediaActionOf(
      this._tabsUnder(row)
    );
    item.hidden = !action;
    item.setAttribute("label", this._mediaLabel(action));
  },

  /**
   * Names what Add to Favorites does for `row`'s page, adding it or taking
   * it out as the favorite button does (`SvalFavorites.toggle`), and
   * disables it when this window holds no tab for the row.
   *
   * @param {Element} menu
   * @param {object} row
   */
  _syncFavoriteItem(menu, row) {
    const item = menu.querySelector('[data-command="favorite"]');
    if (!item || item.hidden) {
      return;
    }
    const tab = this._observer?.tabFor(row.id);
    const starred =
      !!tab &&
      this._modules.SvalFavorites.isCurrentFavorite(window, tab.linkedBrowser);
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
  },

  /**
   * The live tabs this window holds for `row` and every tab inside it, as
   * Unload acts on them.
   *
   * @param {object} row
   * @returns {object[]} Firefox tabs.
   */
  _tabsUnder(row) {
    const { descendantIds, TAB } = this._modules.SvalPanelModel;
    // The engine refuses a tab as a parent (`childrenByParent`), so a tab's
    // row stands for its own tab alone.
    const under =
      this._nodes[row.id]?.kind === TAB
        ? []
        : descendantIds(this._nodes, row.id, this._childrenByParent());
    return [row.id, ...under]
      .filter(id => this._nodes[id]?.kind === TAB)
      .map(id => this._observer?.tabFor(id))
      .filter(Boolean);
  },

  /**
   * Fills "Add to Split" with the splits in this window's workspace that have
   * room for `row`'s tab, each named as its row is: its name, or its pages'
   * titles.
   *
   * @param {Element} menu
   * @param {object} row A tab's row, not a pane's.
   */
  _fillAddToSplit(menu, row) {
    const { addToSplitChoices, childrenByParent, TAB } =
      this._modules.SvalPanelModel;
    const parent = menu.querySelector('[data-command="addToSplit"]');
    const popup = parent.querySelector("menupopup");
    popup.textContent = "";
    const choices = addToSplitChoices(
      this._nodes,
      row.id,
      this._currentWorkspaceId
    );
    const byParent = childrenByParent(this._nodes);
    for (const split of choices) {
      const titles = this._modules.SvalPanelModel.splitTabs(
        this._nodes,
        split,
        byParent
      ).map(
        id =>
          this._modules.SvalPanelModel.displayName(this._nodes[id]) ||
          this._untitled(TAB)
      );
      const entry = document.createXULElement("menuitem");
      entry.setAttribute("data-join-split", split);
      entry.setAttribute(
        "label",
        this._nodes[split].content?.name || titles.join(", ")
      );
      popup.append(entry);
    }
    parent.toggleAttribute("disabled", !choices.length);
  },

  /**
   * Fits a pane's split entries to its place: Add Tab to Split is disabled
   * on a full split, Move Pane Left on the first pane and Move Pane Right on
   * the last, and Close All reads Close Both when there are two (split-view
   * spec §6.3).
   *
   * @param {Element} menu
   * @param {object} pane A pane's row.
   */
  _syncSplitItems(menu, pane) {
    menu
      .querySelector('[data-command="addTabToSplit"]')
      .toggleAttribute(
        "disabled",
        !this._modules.SvalPanelModel.splitHasRoom(this._nodes, pane.split)
      );
    menu
      .querySelector('[data-command="movePaneLeft"]')
      .toggleAttribute("disabled", pane.posinset === 1);
    menu
      .querySelector('[data-command="movePaneRight"]')
      .toggleAttribute("disabled", pane.posinset === pane.setsize);
    // Close All closes the split's every tab, more than one run's when a
    // merge left it holding more than four.
    const tabs = this._modules.SvalPanelModel.splitTabs(
      this._nodes,
      pane.split
    );
    // The Tab menu has no Close All.
    const closeAll = menu.querySelector('[data-command="closeSplit"]');
    closeAll?.setAttribute(
      "label",
      tabs.length === 2 ? "Close Both" : "Close All"
    );
    closeAll?.toggleAttribute("data-both", tabs.length === 2);
  },

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
  _syncMoveItems(menu, row) {
    const { moveTarget } = this._modules.SvalPanelModel;
    // A pane's moves move its split (split-view spec §6.3).
    const id = this._movingId(row);
    for (const command of ["moveBefore", "moveAfter"]) {
      const possible = moveTarget(this._nodes, id, command);
      menu
        .querySelector(`[data-command="${command}"]`)
        .toggleAttribute("disabled", !possible);
    }
    this._fillMoveToGroup(menu, [id]);
    this._fillMoveToWorkspace(menu, [row.id]);
  },

  /**
   * Fits a menu opened on a selection to it (spec §10.5): the entries that
   * act on one row are disabled, Close is disabled unless every selected row
   * is a tab, and the moves list where the whole selection can go.
   *
   * @param {Element} menu
   * @param {string[]} several The selected rows.
   */
  _syncSelectionItems(menu, several) {
    const { SELECTION_COMMANDS, groupSelectionTarget } =
      this._modules.SvalPanelModel;
    const roots = this._selectionRoots(several);
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
      ?.toggleAttribute("disabled", !this._closesSelection(several));
    menu
      .querySelector('[data-command="groupSelection"]')
      ?.toggleAttribute("disabled", !groupSelectionTarget(this._nodes, roots));
    this._fillMoveToGroup(menu, roots);
    this._fillMoveToWorkspace(menu, roots);
  },

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
  _fillMoveToGroup(menu, ids) {
    const { moveToGroupChoices, WORKSPACE } = this._modules.SvalPanelModel;
    const parent = menu.querySelector('[data-command="moveToGroup"]');
    const popup = parent.querySelector("menupopup");
    popup.textContent = "";
    const choices = moveToGroupChoices(
      this._nodes,
      ids,
      this._currentWorkspaceId,
      { transparent: this._transparentIds() }
    );
    for (const choice of choices) {
      const entry = document.createXULElement("menuitem");
      entry.setAttribute("data-move-parent", choice.id);
      if (choice.kind === WORKSPACE) {
        entry.setAttribute("label", "No group");
      } else {
        const node = this._nodes[choice.id];
        const name = node?.content?.name || this._untitled(choice.kind);
        const emoji = node?.appearance?.emoji;
        entry.setAttribute(
          "label",
          " ".repeat(choice.depth) + (emoji ? `${emoji} ${name}` : name)
        );
        // The indent shows nesting only to the eye.
        const outer = this._nodes[node?.placement?.parent];
        if (choice.depth > 0 && outer) {
          entry.setAttribute(
            "aria-description",
            `in ${outer.content?.name || this._untitled(outer.kind)}`
          );
        }
      }
      popup.append(entry);
      if (choice.kind === WORKSPACE && choices.length > 1) {
        popup.append(document.createXULElement("menuseparator"));
      }
    }
    if (choices.length) {
      popup.append(document.createXULElement("menuseparator"));
    }
    const fresh = document.createXULElement("menuitem");
    fresh.setAttribute("data-new-group", "true");
    fresh.setAttribute("label", "New group…");
    popup.append(fresh);
  },

  /**
   * Fills "Move to workspace" with every workspace of the user's but this
   * window's, then "New workspace…" (import spec §6), then the agents'
   * workspaces after a caption of their own, grouped by app
   * ({@link _appendAgentApps}). A row moved into an agent's workspace is
   * handed to the agent, once the user has agreed (`moveToWorkspace`), so
   * those entries never mix with the user's.
   *
   * The row menu's entries also fill the menu bar's Tab menu
   * (`menuBarTabItems`), so the caption is the one the menu bar's
   * Workspaces menu draws ({@link _appendAgentsMenuCaption}).
   *
   * @param {Element} menu
   * @param {string[]} ids The rows the menu is for.
   */
  _fillMoveToWorkspace(menu, ids) {
    const parent = menu.querySelector('[data-command="moveToWorkspace"]');
    const popup = parent.querySelector("menupopup");
    popup.textContent = "";
    const others = this._switcherList().filter(
      item => !item.current && !ids.includes(item.id)
    );
    const own = others.filter(item => !item.agent);
    for (const item of own) {
      const entry = document.createXULElement("menuitem");
      entry.setAttribute("data-move-workspace", item.id);
      this._labelWorkspaceEntry(entry, item);
      popup.append(entry);
    }
    if (own.length) {
      popup.append(document.createXULElement("menuseparator"));
    }
    const fresh = document.createXULElement("menuitem");
    fresh.setAttribute("data-move-workspace", "");
    this._labelMenuEntry(fresh, "New Workspace…");
    popup.append(fresh);
    const agents = others.filter(item => item.agent);
    if (agents.length) {
      this._appendAgentsMenuCaption(popup);
    }
    this._appendAgentApps(popup, agents, item => {
      const entry = document.createXULElement("menuitem");
      entry.setAttribute("data-move-workspace", item.id);
      entry.setAttribute("data-agent", "true");
      this._labelAgentEntry(entry, item);
      return entry;
    });
  },

  /**
   * Runs the clicked menu item through the same `run` every keyboard command
   * and header button already goes through, so a menu entry is never a second
   * implementation of the action it names.
   *
   * @param {Event} event `command` from a `menuitem`.
   */
  _onContextMenuCommand(event) {
    const row = this._rowFor(this._contextRowId);
    this._runRowMenuCommand(event, row, this._selectionFor(row));
  },

  /**
   * Runs an entry of a menu built from {@link _rowMenuItems} on `row`, or on
   * the selection it is one of. A command `run` takes finds the selection
   * from `row` itself.
   *
   * @param {Event} event `command` from a `menuitem`.
   * @param {object|null} row
   * @param {string[]|null} [several] The selection the menu acts on.
   */
  _runRowMenuCommand(event, row, several = null) {
    if (!row) {
      return;
    }
    // A pane's moves move its split (split-view spec §6.3).
    const moving = several
      ? this._selectionRoots(several)
      : this._movingId(row);
    if (event.target.hasAttribute("data-move-parent")) {
      const parent = event.target.getAttribute("data-move-parent");
      this._guard("moveInto", () => this._moveInto(moving, parent, row.id));
      return;
    }
    if (event.target.hasAttribute("data-new-group")) {
      this._guard("newGroup", () => this._newGroupWith([moving].flat()));
      return;
    }
    if (event.target.hasAttribute("data-join-split")) {
      const split = event.target.getAttribute("data-join-split");
      this._guard("joinSplit", () => this._joinSplit(split, row.id));
      return;
    }
    if (event.target.hasAttribute("data-move-workspace")) {
      const workspace = event.target.getAttribute("data-move-workspace");
      this._guard("moveToWorkspace", () =>
        this.moveToWorkspace(moving, workspace)
      );
      return;
    }
    const command = event.target.dataset.command;
    if (command) {
      this.run(command, row);
    }
  },

  /**
   * Fills the menu bar's Workspaces menu after its fixed items
   * (`SvalMenuBar`): every workspace the switcher lists, this window's
   * checked, then the workspace menu's commands on this window's workspace.
   *
   * A native menu bar draws no submenu style, so agents' workspaces follow
   * {@link _appendAgentsMenuCaption}'s caption, grouped by app
   * ({@link _appendAgentApps}), and entries carry no mark.
   *
   * @param {Element} popup
   */
  fillMenuBarWorkspaces(popup) {
    if (!this.built) {
      return;
    }
    const entry = item => {
      const el = document.createXULElement("menuitem");
      el.setAttribute("type", "checkbox");
      el.setAttribute("data-workspace-id", item.id);
      if (item.current) {
        el.setAttribute("checked", "true");
      }
      return el;
    };
    const items = this._switcherList();
    for (const item of items.filter(i => !i.agent)) {
      const el = entry(item);
      this._labelWorkspaceEntry(el, item);
      popup.append(el);
    }
    const agents = items.filter(i => i.agent);
    if (agents.length) {
      this._appendAgentsMenuCaption(popup);
    }
    this._appendAgentApps(popup, agents, item => {
      const el = entry(item);
      this._labelAgentEntry(el, item);
      return el;
    });
    const commands = this._workspaceCommandItems();
    popup.append(document.createXULElement("menuseparator"), ...commands);
    this._syncWorkspaceCommands(popup, this._currentWorkspaceId);
    // With no workspace of the person's own, the agents' caption follows the
    // menu bar's own separator (`SvalMenuBar`).
    this._modules.tidySeparators(popup);
  },

  /**
   * @param {Event} event `command` in the menu bar's Workspaces menu.
   */
  runMenuBarWorkspacesCommand(event) {
    if (!this.built) {
      return;
    }
    const { workspaceId, command } = event.target.dataset;
    if (command) {
      this._runWorkspaceCommand(command, this._currentWorkspaceId);
    } else if (workspaceId && workspaceId !== this._currentWorkspaceId) {
      // The agent's window stays the agent's while it holds it, so the
      // workspace opens in a window of its own (`SvalAgentMarking`).
      this._pickWorkspace(workspaceId, !!this._agentMarking?.blocking);
    }
  },

  /**
   * The menu bar's Tab menu's entries (`SvalMenuBar`): the row menu's that
   * act on one tab, labelled as the menu bar labels its items, for
   * {@link syncMenuBarTab} to fit to the selected tab.
   *
   * @returns {Element[]}
   */
  menuBarTabItems() {
    const items = new Map(
      this._rowMenuItems(TAB_MENU_LABELS).map(el => [el.dataset.command, el])
    );
    return Object.keys(TAB_MENU_LABELS).map(command => items.get(command));
  },

  /**
   * Fits the Tab menu's entries to the selected tab: its row's, or for a
   * selected pin, which has no row (pins spec §4), Move Pin to Favorites
   * alone.
   *
   * @param {Element} menu The Tab menu's `menupopup`.
   */
  syncMenuBarTab(menu) {
    const pin = this.built ? this._pins?.selectedPin : null;
    const row = pin ? null : this._selectedTabRow();
    this._syncRowMenu(menu, row);
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
  },

  /**
   * @param {Event} event `command` in the menu bar's Tab menu.
   */
  runMenuBarTabCommand(event) {
    if (!this.built) {
      return;
    }
    const pin = this._pins?.selectedPin;
    if (pin) {
      if (event.target.dataset.command === "pin") {
        this._guard("moveToFavorites", () =>
          this._pins.moveToFavoritesGuid(pin.guid)
        );
      }
      return;
    }
    this._runRowMenuCommand(event, this._selectedTabRow());
  },

  /** @returns {object|null} the selected tab's row, while the tree shows it. */
  _selectedTabRow() {
    if (!this.built) {
      return null;
    }
    const id = this._observer?.nodeIdFor(window.gBrowser.selectedTab);
    return id ? this._rowFor(id) : null;
  },
});
