/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Keys and the pointer on the workspace panel's tree: which command a key,
 * click or double-click means, the one place every command runs through, and
 * where the tree's focus goes.
 *
 * `SvalWindow` loads this as a classic script after `sval-panel.js`; it adds
 * its methods to `SvalPanel`, whose state and helpers it shares.
 */

/* import-globals-from sval-panel.js */

Object.assign(SvalPanel, {
  /** What type-ahead has collected since the last pause, and when. */
  _typed: "",
  _typedAt: 0,

  _onKeyDown(event) {
    const { keyCommand } = this._modules.SvalPanelModel;
    // The row the event came from, not the one this object last recorded: the
    // DOM is the authority on where focus is, and anything that moved it (a
    // click, a `focus()` from elsewhere, the browser restoring focus to the
    // panel) would otherwise send the keystroke to the wrong row.
    const element = this._rowElementAt(event.target);
    if (element && element.dataset.nodeId !== this._focusedId) {
      this._focusRow(element.dataset.nodeId);
    }
    const row = this._rowFor(this._focusedId);
    const command = keyCommand(event, row, {
      selecting: this.selection.several,
    });
    if (!command) {
      if (event.key === "Escape" && this.dismissUndo()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (this._typeAhead(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    // Only once a command is recognised: an unhandled key must still reach the
    // browser, which is what keeps window shortcuts working while the panel
    // has focus.
    event.preventDefault();
    event.stopPropagation();
    this.run(command, row);
  },

  /**
   * Moves focus to the row whose label starts with what was typed (the ARIA
   * tree pattern; see `SvalPanelModel.typeAheadIndex`). Keys typed closer
   * together than `ui.menu.incremental_search.timeout`, the pause Firefox's
   * own menus and trees use, spell one prefix.
   *
   * @param {KeyboardEvent} event A key no command claimed.
   * @returns {boolean} whether the key was a character type-ahead took.
   */
  _typeAhead(event) {
    const { key, altKey, ctrlKey, metaKey } = event;
    if (altKey || ctrlKey || metaKey || [...key].length !== 1) {
      return false;
    }
    const now = Date.now();
    const pause = Services.prefs.getIntPref(
      "ui.menu.incremental_search.timeout",
      1000
    );
    this._typed = now - this._typedAt > pause ? key : this._typed + key;
    this._typedAt = now;
    // A split's panes are matched one by one, so typing either finds it.
    const targets = this._rows.flatMap(row => row.panes ?? [row]);
    const labels = targets.map(
      row => row.name || this._untitled(row.kind, row.url)
    );
    const from = targets.findIndex(row => row.id === this._focusedId);
    const index = this._modules.SvalPanelModel.typeAheadIndex(
      labels,
      from,
      this._typed
    );
    if (index !== -1) {
      this._focusRow(targets[index].id);
    }
    return true;
  },

  /**
   * Runs one command. Every entry is reachable both from
   * `SvalPanelModel.keyCommand` and from a button, and both paths come through
   * here, so nothing can end up reachable one way only (spec §10.5).
   *
   * A command that fails is logged, and the panel redraws from the engine's
   * tree, which shows what did and did not happen. The user is told nothing:
   * an engine failure is not theirs to act on (spec §10.7). Its callers are
   * event handlers that cannot await it, so an error left to propagate would
   * reach nobody.
   *
   * @param {string} command
   * @param {object|null} row The row the command applies to.
   * @returns {Promise<void>}
   */
  run(command, row) {
    return this._guard(command, () => this._dispatch(command, row));
  },

  /**
   * Runs `action` with {@link run}'s handling of a failure, for an event
   * handler's action that is no command.
   *
   * @param {string} what Names the action in the log line.
   * @param {Function} action Returns what the action returns, or a promise of
   *   it.
   * @returns {Promise<*>} the action's result, or undefined if it failed.
   */
  async _guard(what, action) {
    try {
      return await action();
    } catch (err) {
      this._modules.SvalLog.error(
        `${what} failed: ${this._modules.describeError(err)}`
      );
      await this.refresh().catch(redraw =>
        this._modules.SvalLog.error(
          `could not redraw after ${what} failed: ${this._modules.describeError(redraw)}`
        )
      );
      return undefined;
    }
  },

  /**
   * The command switch behind {@link run}.
   *
   * @param {string} command
   * @param {object|null} row The row the command applies to.
   * @returns {Promise<void>|void}
   */
  _dispatch(command, row) {
    const onRow = {
      pin: () => this._pins?.pinTab(row.id, { thisWorkspace: false }),
      pinHere: () => this._pins?.pinTab(row.id, { thisWorkspace: true }),
      favorite: () => this._toggleFavorite(row),
      copyMarkdownLink: () => this._copyMarkdownLink(row),
      styleSite: () => this._styleSite(row),
      unload: () => this._modules.unloadTabs(window, this._tabsUnder(row)),
      keepLoaded: () => this._toggleKeepLoaded(row),
      clearLabel: () => this.setTabLabel(row.id, null),
      media: () => {
        this._modules.SvalFirefox.actOnMedia(this._tabsUnder(row));
      },
    }[command];
    if (onRow) {
      return onRow();
    }
    const selecting = {
      extendNext: () => this._extendSelection(1),
      extendPrevious: () => this._extendSelection(-1),
      toggleSelected: () => this.selection.toggle(row.id),
      clearSelection: () => this.selection.clear(),
    }[command];
    if (selecting) {
      return selecting();
    }
    // The panel's own controls, which act on no row: the Undo message's and
    // the footer's media controls.
    const offRow = {
      undo: () => this._takeUndo(),
      dismissUndo: () => this.dismissUndo({ refocus: true }),
      mediaPrevious: () => this._runMediaBar(command),
      mediaBack: () => this._runMediaBar(command),
      mediaToggle: () => this._runMediaBar(command),
      mediaForward: () => this._runMediaBar(command),
      mediaNext: () => this._runMediaBar(command),
    }[command];
    if (offRow) {
      return offRow();
    }
    switch (command) {
      case "focusNext":
        return this._moveFocus(1);
      case "focusPrevious":
        return this._moveFocus(-1);
      case "focusFirst":
        return this._focusRow(this._rows[0]?.id);
      case "focusLast":
        return this._focusRow(this._rows[this._rows.length - 1]?.id);
      case "focusParent":
        return this._focusRow(this._nodes[row.id]?.placement?.parent);
      case "focusNextPane":
        return this._focusPane(row, 1);
      case "focusPreviousPane":
        return this._focusPane(row, -1);
      case "expand":
        return this._setCollapsed(row.id, false);
      case "collapse":
        return this._setCollapsed(row.id, true);
      case "toggle":
        return this._setCollapsed(row.id, row.expanded);
      case "activate":
        this.selection.clear(row.id);
        return this.activate(row);
      case "rename":
        return this._rename(row);
      case "edit":
        return this.edit(row);
      case "contextMenu":
        return this._openRowMenu(row);
      case "close":
        return this._closeRows(row);
      case "groupSelection":
        return this._groupSelection(row);
      case "createSplit":
        return this._openSplitPicker(row);
      case "addTabToSplit":
        return this._addPickerPane(row);
      case "separate":
        return this.separate(row.split);
      case "movePaneLeft":
        return this._move(row.id, "moveBefore");
      case "movePaneRight":
        return this._move(row.id, "moveAfter");
      case "renameSplit":
        return this._renameSplit(row.split);
      case "closeSplit":
        return this._close(row.split);
      case "altClickSplit":
        return this._altClickSplit(row);
      case "deleteGroup":
        return this._deleteGroup(row.id);
      case "deleteWorkspace":
        return this._deleteWorkspace(row.id);
      case "isolateWorkspace":
        return this._setIsolation(row.id, true);
      case "shareWorkspace":
        return this._setIsolation(row.id, false);
      case "moveBefore":
      case "moveAfter":
      case "moveIn":
      case "moveOut":
        // A pane's moves move its split (split-view spec §6.3).
        return this._move(this._movingId(row), command, row.id);
      case "addTab":
        return this._addTab(row);
      case "addWorkspace":
        return this.addWorkspace();
      case "addGroup":
        return this._addGroup();
      case "switchWorkspace":
        return this._openSwitcher();
      case "openFavorites":
        return this.openFavorites();
      case "openStorageSettings":
      case "chooseSharedFolder":
        return this.openSettingsPage("storage");
      case "openSyncSettings":
        return this.openSettingsPage("top");
      case "reopenCritical":
        return this._reopenCritical();
      case "toggleFeedback":
        return this._modules.SvalFeedbackForm.toggle(window);
      case "checkForUpdate":
        return window.openAboutDialog();
      case "retrySyncKey":
        return this._retrySyncKey();
      case "pairAgain":
        return this.openSettingsPage("claim");
      case "dismissOtherWorkspaces":
        return this._modules.SvalFolderUpkeep.of(
          this._engine
        ).dismissOtherWorkspaces();
      default:
        return undefined;
    }
  },

  /**
   * Copies the page of `row`'s tab as a Markdown link.
   *
   * @param {object} row A tab's row.
   */
  _copyMarkdownLink(row) {
    const tab = this._observer?.tabFor(row.id);
    if (tab) {
      this._modules.copyMarkdownLink(tab);
    }
  },

  /**
   * Opens the site style editor for `row`'s page. The editor styles the
   * selected tab's page, at the site controls, so the tab is selected
   * first.
   *
   * @param {object} row A tab's row.
   */
  _styleSite(row) {
    const tab = this._observer?.tabFor(row.id);
    if (!tab) {
      return;
    }
    window.gBrowser.selectedTab = tab;
    this._modules.SvalSiteStylePanel.open(window, { focus: true });
  },

  /**
   * Makes the page of `row`'s tab a favorite, or takes it out of Favorites,
   * as the favorite button does for the selected tab.
   *
   * @param {object} row A tab's row.
   * @returns {Promise<void>|undefined}
   */
  _toggleFavorite(row) {
    const tab = this._observer?.tabFor(row.id);
    return tab
      ? this._modules.SvalFavorites.toggle(window, tab.linkedBrowser)
      : undefined;
  },

  /**
   * Keeps `row`'s tab loaded, or lets it unload again.
   *
   * @param {object} row A tab's row.
   */
  _toggleKeepLoaded(row) {
    const tab = this._observer?.tabFor(row.id);
    if (tab) {
      this._modules.setKeptLoaded(tab, !this._modules.isKeptLoaded(tab));
    }
  },

  _onClick(event) {
    const button = event.target.closest?.("[data-command]");
    const rowElement = this._rowElementAt(event.target);
    const row = rowElement ? this._rowFor(rowElement.dataset.nodeId) : null;
    const { SPLIT, TAB } = this._modules.SvalTree;

    if (row) {
      this._focusRow(row.id);
    }
    if (button) {
      event.preventDefault();
      this.run(button.dataset.command, row);
      return;
    }
    // The tray between a split's tiles is no pane.
    if (!row || row.kind === SPLIT) {
      return;
    }
    // Accel-click and Shift-click select without showing anything (spec
    // §10.5), as `MozTabbrowserTab.on_mousedown` reads the same modifiers.
    const accel = event.getModifierState("Accel");
    if (event.shiftKey) {
      this.selection.selectTo(row.id, { add: accel });
      return;
    }
    if (accel) {
      this.selection.toggle(row.id);
      return;
    }
    // Alt-click on a second tab splits it with the one being viewed, as
    // Firefox's tab strip does (split-view spec §6.3).
    if (event.altKey && row.kind === TAB) {
      if (row.id !== this.selection.selectedId()) {
        this.run("altClickSplit", row);
      }
      return;
    }
    this.selection.clear(row.id);
    // A tab's page loads on click (spec §10.4). A group has no page, so a click
    // only folds or unfolds it. Selection stays on the tab the user is viewing.
    if (row.kind === TAB) {
      this.run("activate", row);
    } else {
      this.run("toggle", row);
    }
  },

  /**
   * Double-click renames when it lands on a row's label, and activates
   * anywhere else on the row.
   *
   * Renaming needs a pointer affordance of its own: spec §10.5 requires
   * everything reachable by mouse to be reachable by keyboard, which says
   * nothing about the reverse, and F2 alone leaves a mouse user unable to
   * rename at all. The label is the target because it is the thing being
   * renamed. A tab's page is already showing by then, because the first click
   * of the pair opened it.
   *
   * @param {Event} event A `dblclick` on the tree.
   */
  _onDoubleClick(event) {
    const rowElement = this._rowElementAt(event.target);
    const row = rowElement ? this._rowFor(rowElement.dataset.nodeId) : null;
    // Two quick selecting clicks are two clicks.
    if (!row || event.shiftKey || event.getModifierState("Accel")) {
      return;
    }
    if (event.target.closest?.(".sval-row-name, .sval-split-title")) {
      this._focusRow(row.id);
      this.run("rename", row);
      return;
    }
    // Two clicks have already folded and unfolded a group, so a third toggle
    // here would leave it flipped.
    if (row.kind === this._modules.SvalTree.TAB) {
      this.run("activate", row);
    }
  },

  /**
   * Moves the focus `delta` rows and selects every row from the selection's
   * anchor to it: Shift with Up or Down.
   *
   * @param {number} delta
   */
  _extendSelection(delta) {
    const from = this._focusedId;
    this._moveFocus(delta);
    this.selection.extend(from, this._focusedId);
  },

  /**
   * Moves the tree's focus `delta` rows, stopping at either end rather than
   * wrapping: a tree that wraps makes "am I at the bottom?" unanswerable
   * without counting.
   *
   * @param {number} delta
   */
  _moveFocus(delta) {
    if (!this._rows.length) {
      return;
    }
    const index = this._modules.SvalPanelModel.rowIndexIn(
      this._rows,
      this._focusedId
    );
    const from = index < 0 ? 0 : index;
    const next = Math.min(this._rows.length - 1, Math.max(0, from + delta));
    this._focusRow(this._rows[next].id);
  },

  /**
   * Moves the tree's focus `delta` panes along a split's row, stopping at
   * either end, as {@link _moveFocus} stops at the tree's.
   *
   * @param {object} pane The focused pane's row.
   * @param {number} delta
   */
  _focusPane(pane, delta) {
    const panes = this._rowFor(pane.splitRow)?.panes ?? [];
    const next = panes[panes.indexOf(pane) + delta];
    if (next) {
      this._focusRow(next.id);
    }
  },

  /**
   * Puts DOM focus on one row and takes it off whichever had it.
   *
   * @param {string} [id] A node id. A missing or undrawn id is ignored, which
   *   is what makes Left at the top of the tree a no-op rather than a throw.
   */
  _focusRow(id) {
    id = this._focusIdFor(id);
    const element = this._rowElementFor(id);
    if (!element) {
      return;
    }
    this._rowElementFor(this._focusedId)?.setAttribute("tabindex", "-1");
    this._focusedId = id;
    element.setAttribute("tabindex", "0");
    element.focus();
  },
});
