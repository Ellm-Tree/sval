/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Selection and folding in the workspace panel's tree, and going to a tab:
 * the row of the tab being viewed, the rows selected beside it, a group
 * opened or closed, a tab activated from its row or from elsewhere.
 *
 * `SvalWindow` loads this as a classic script after `sval-panel.js`; it adds
 * its methods to `SvalPanel`, whose state and helpers it shares.
 */

/* import-globals-from sval-panel.js */

Object.assign(SvalPanel, {
  /**
   * The selection and the containers above it when `_revealSelection` last
   * opened them, as one string, so a redraw can tell a selected tab that
   * moved from one whose group the user has since folded.
   */
  _revealedPath: null,

  /**
   * The rows selected beyond the tab on screen (spec §10.5), by row id: a
   * split's panes one by one. Empty while the tab on screen is the one
   * selected row. Kept in this window's memory alone.
   */
  _multiSelected: new Set(),

  /** The row a Shift-click or Shift with an arrow selects from. */
  _selectionAnchor: null,

  /**
   * Records a collapse and redraws. Collapse is device-local (spec §5.6), so
   * this never reaches the engine: it goes to `SvalLocalSettings`, saved
   * with the next write, because a collapse that does not survive a restart
   * is not one.
   * Collapsing a group above the selection still draws the selection
   * (`SvalPanelModel.rows`), and opens nothing.
   *
   * @param {string} id A node id.
   * @param {boolean} collapsed
   */
  async _setCollapsed(id, collapsed) {
    this._settings.setCollapsed(id, collapsed);
    this.render();
    this._focusRow(id);
    this._settings.saveSoon();
  },

  /**
   * Marks `id` as the node the user is working in, which is where new tabs go
   * and not only what is highlighted. Device-local (spec §5.6), and recorded
   * for the workspace this window shows.
   *
   * @param {string} id A node id.
   */
  async _select(id) {
    if (!this._workspace.id) {
      return;
    }
    this._settings.setSelection(this._workspace.id, id);
    // A row drawn only because it led to the old selection goes with it.
    const pathDrawn = this._rows.some(row => row.showsSelection);
    if (this._revealSelection({ force: true }) || pathDrawn) {
      this.render();
    } else {
      this._paintSelection();
    }
    this._settings.saveSoon();
  },

  /**
   * Repaints which rows are selected, and on a split's row which pane is
   * active, which follows the viewing.
   */
  _paintSelection() {
    for (const row of this._rows) {
      const element = this._rowElementFor(row.id);
      if (!element) {
        continue;
      }
      if (row.panes) {
        this._paintSplitState(element, row);
      } else {
        element.setAttribute(
          "aria-selected",
          this._isSelectedRow(row.id) ? "true" : "false"
        );
      }
    }
  },

  /**
   * Whether `id`'s row is drawn and announced as selected: one of the rows
   * selected, or with none selected beyond it, the tab on screen's.
   *
   * @param {string} id A row id.
   * @returns {boolean}
   */
  _isSelectedRow(id) {
    return this._multiSelected.size
      ? this._multiSelected.has(id)
      : this._isViewed(id);
  },

  /** @returns {string[]} every drawn row's id, a split's panes one by one. */
  _selectableIds() {
    return this._rows.flatMap(row => row.panes ?? [row]).map(row => row.id);
  },

  /**
   * The selection a command on `row` acts on (spec §10.5): every selected
   * row, in the order they are drawn, when `row` is one of two or more.
   *
   * @param {object|null} row
   * @returns {string[]|null} row ids, or null for a command on `row` alone.
   */
  _selectionFor(row) {
    if (this._multiSelected.size < 2 || !this._multiSelected.has(row?.id)) {
      return null;
    }
    return this._selectableIds().filter(id => this._multiSelected.has(id));
  },

  /**
   * The nodes a move of the selected rows `ids` moves: a pane's split, as one
   * row's move does ({@link _movingId}), and nothing inside another of them.
   *
   * @param {string[]} ids Row ids, in the order they are drawn.
   * @returns {string[]}
   */
  _selectionRoots(ids) {
    return this._modules.SvalPanelModel.outermostIds(
      this._nodes,
      ids.map(id => this._movingId(this._rowFor(id) ?? { id }))
    );
  },

  /**
   * The rows selected start from the tab on screen, when it has a row, as
   * Firefox's tab strip adds its selected tab to a multiselection.
   */
  _seedSelection() {
    const viewed = this._selectedId();
    if (this._isViewed(viewed) && this._selectableIds().includes(viewed)) {
      this._multiSelected.add(viewed);
    }
  },

  /**
   * Adds a row to the selection or takes it out: Accel-click, Ctrl+Space.
   *
   * @param {string} id A row id.
   */
  _toggleSelected(id) {
    if (!this._multiSelected.size) {
      this._seedSelection();
    }
    if (!this._multiSelected.delete(id)) {
      this._multiSelected.add(id);
    }
    this._selectionAnchor = id;
    this._paintSelection();
  },

  /**
   * Selects every row from the anchor to `id`: Shift-click. The anchor is
   * the row last clicked, or the tab on screen's.
   *
   * @param {string} id A row id.
   * @param {object} [options]
   * @param {boolean} [options.add] Keep what is already selected, as
   *   Accel+Shift-click does.
   */
  _selectRange(id, { add = false } = {}) {
    const ids = this._selectableIds();
    const viewed = this._selectedId();
    const anchor = ids.includes(this._selectionAnchor)
      ? this._selectionAnchor
      : viewed;
    const range = this._modules.SvalPanelModel.rangeIds(ids, anchor, id);
    if (!add) {
      this._multiSelected.clear();
    }
    for (const each of range) {
      this._multiSelected.add(each);
    }
    this._selectionAnchor = ids.includes(anchor) ? anchor : id;
    this._paintSelection();
  },

  /**
   * Moves the focus `delta` rows and selects every row from the anchor to
   * it: Shift with Up or Down. With nothing selected, the anchor is the row
   * the focus leaves.
   *
   * @param {number} delta
   */
  _extendSelection(delta) {
    if (!this._multiSelected.size || !this._selectionAnchor) {
      this._selectionAnchor = this._focusedId;
    }
    this._moveFocus(delta);
    const range = this._modules.SvalPanelModel.rangeIds(
      this._selectableIds(),
      this._selectionAnchor,
      this._focusedId
    );
    this._multiSelected = new Set(range);
    this._paintSelection();
  },

  /**
   * Leaves the tab on screen the one selected row: Escape, a click.
   *
   * @param {string|null} [anchor] Where the next Shift-click starts.
   */
  _clearSelection(anchor = this._selectionAnchor) {
    this._selectionAnchor = anchor;
    if (this._multiSelected.size) {
      this._multiSelected.clear();
      this._paintSelection();
    }
  },

  /**
   * Keeps the selection to the rows drawn (spec §10.5): a row closed, moved
   * to another workspace, folded away or left by a switch leaves it.
   */
  _pruneSelection() {
    const ids = new Set(this._selectableIds());
    for (const id of this._multiSelected) {
      if (!ids.has(id)) {
        this._multiSelected.delete(id);
      }
    }
    if (!ids.has(this._selectionAnchor)) {
      this._selectionAnchor = null;
    }
  },

  /**
   * Whether the window shows `id`'s page: it is the selection, and no pin's
   * page is selected over it. A pin's page is no row (pins spec §5), so with
   * one shown no row is.
   *
   * @param {string} id A tab's node id.
   * @returns {boolean}
   */
  _isViewed(id) {
    return this._viewedId() === id;
  },

  /**
   * The tab whose page the window shows: the selection, unless a pin's page
   * is selected over it. A collapsed group draws the path to this tab alone
   * (`SvalPanelModel.rows`), so with a pin's page on screen it draws none.
   *
   * @returns {string|null}
   */
  _viewedId() {
    return this._pins?.pages.selectedGuid ? null : this._selectedId();
  },

  /**
   * The node selected in the workspace this window shows, if it is still in
   * that workspace.
   *
   * Every window of a profile shares one settings store, and a window shows
   * only its own workspace (spec §10.7), so a node outside it has no row
   * here and is never this window's selection. A tab that cannot be
   * discarded stays in the window across a switch (`_mayDiscardBrowser`) and
   * can be selected from the tab strip while it belongs to the workspace
   * left; with it, this window has no selection.
   *
   * @returns {string|null}
   */
  _selectedId() {
    const workspace = this._workspace.id;
    const id = this._settings.selectionIn(workspace);
    return this._modules.SvalTree.isWithin(this._nodes, id, workspace)
      ? id
      : null;
  },

  /**
   * Repaints what a pin's page being selected or left changes: which row is
   * viewed, and the window's title.
   */
  onPinSelectionChanged() {
    // A pin's page leaves no tab viewed, so a path a collapsed group drew to
    // the selection goes. Leaving the page selects a tab through `_select`.
    if (
      this._pins?.pages.selectedGuid &&
      this._rows.some(row => row.showsSelection)
    ) {
      this.render();
    } else {
      this._paintSelection();
    }
    if (this._titleArgs) {
      this._applyWindowTitle(...this._titleArgs);
    }
  },

  /**
   * Records that a pin's page was just selected in `workspaceId`, for a
   * switch back or a launch to land on (pins spec §5).
   *
   * @param {string} workspaceId
   * @param {string} guid
   */
  notePinViewed(workspaceId, guid) {
    this._settings.setLastPin(workspaceId, guid, this._modules.SvalClock.now());
    this._settings.saveSoon();
  },

  /** Moves focus from the pins row into the tab list (pins spec §12.3). */
  focusTreeFromPins() {
    (
      this._rowElementFor(this._focusedId) ??
      this._rowElementFor(this._rows[0]?.id)
    )?.focus();
  },

  /**
   * Opens every container above the selection, so the tab the user is
   * viewing always has a row. Every way a tab comes to be selected reaches
   * `_select` (a row's click, `TabSelect` from the strip, Cmd+number, a
   * workspace switch's hand-over, a link, restoration, an agent), and that
   * call forces this, so a selection is never drawn hidden. Spec §5.6 starts
   * every group a device has not seen collapsed, which is the state a tab
   * arriving from sync or first run is selected into.
   *
   * A redraw after the tree changes calls it unforced, and it then acts only
   * when the selection or the chain above it differs from the last time: a
   * peer moving the selected tab into a group this device has never opened
   * reveals it, and a group the user folded over the selected tab stays
   * folded until the selection next changes.
   *
   * Collapse is device-local (spec §5.6), so nothing here reaches the engine
   * or another device. The caller redraws, and flushes the settings.
   *
   * @param {object} [options]
   * @param {boolean} [options.force] Open the chain even if it was opened
   *   for this same selection before.
   * @returns {boolean} whether any container was opened.
   */
  _revealSelection({ force = false } = {}) {
    const id = this._selectedId();
    const above = this._modules.SvalTree.ancestorIds(this._nodes, id);
    const path = [id, ...above].join(" ");
    if (!force && path === this._revealedPath) {
      return false;
    }
    this._revealedPath = path;
    let opened = false;
    for (const container of above) {
      if (this._settings.isCollapsed(container)) {
        this._settings.setCollapsed(container, false);
        opened = true;
      }
    }
    return opened;
  },

  /**
   * Goes to a tab, or folds a container. A workspace or group has no page to
   * open, so Enter on one does the thing it does have. A container is never
   * selected: the selection is the tab the user is viewing.
   *
   * **A row and a `<browser>` are one thing.** A node this window already has a
   * tab for is *shown*, not opened again: the panel is the only tab surface, so
   * two tabs for one row would be one row standing for two pages. A node with no
   * live tab (restored from another device, or one this window has not
   * materialised) gets one lazily through the same call restoration makes
   * (§10.4), which is what makes going to a row cost a page load only when the
   * user goes there.
   *
   * @param {object} row A row.
   */
  async activate(row) {
    const { TAB } = this._modules.SvalTree;
    if (row.kind !== TAB) {
      await this._setCollapsed(row.id, row.expanded);
      return;
    }
    await this._select(row.id);
    this._modules.SvalPanelReveal.dismiss(window);
    this._settings.setLastActive(row.id, this._modules.SvalClock.now());
    this._settings.saveSoon();
    // A row the user goes to may be a use (idle-tab archive spec §4.1). Its
    // tab is selected after the awaits above, where Gecko no longer handles
    // the click, so `SvalTabs` does not count the selection itself.
    this._observer?.noteUse(row.id);

    if (this._observer?.selectNode(row.id)) {
      return;
    }
    const node = this._nodes[row.id];
    if (!node?.content?.url) {
      return;
    }
    this._modules.SvalRestore.materialise(
      window,
      node,
      row.id,
      window.gBrowser.defaultUserContextId ?? 0
    );
  },

  /**
   * Goes to an open tab of any workspace, as the address bar's open-tab row
   * does (launcher spec §6): the tab is selected as a click on its row
   * selects it ({@link activate}), in the window that shows its workspace.
   *
   * A workspace another window shows is that window's (spec §10.7), so that
   * window is brought forward and selects the tab, and this one stays where
   * it is. An agent's workspace no window shows gets a window of its own:
   * the Launcher never puts the user to work in an agent's workspace
   * (launcher spec §6), as does any workspace at `newWindow`. Any other
   * workspace is switched to here, through {@link switchTo}. The tab is marked used before a switch, so the window
   * that shows the workspace selects it as it starts or is handed over
   * ({@link _mostRecentlyActive}), and no other tab of the workspace loads
   * on the way.
   *
   * Nothing here makes a node: a tab gone from the tree since its row was
   * drawn is not gone to.
   *
   * @param {string} id A tab's node id.
   * @param {object} [options]
   * @param {object|null} [options.leaving] An empty tab the row was picked
   *   in, closed once the window has gone to the tab
   *   ({@link _closeLeftTab}).
   * @param {boolean} [options.newWindow] Whether a workspace of another
   *   tab that no window shows opens in a window of its own.
   * @returns {Promise<boolean>} whether a window went to the tab.
   */
  async goToTab(id, { leaving = null, newWindow = false } = {}) {
    const leftId = leaving ? this._observer?.nodeIdFor(leaving) : null;
    const went = await this._goToTabOnce(id, newWindow);
    if (went && leaving) {
      await this._closeLeftTab(leaving, leftId);
    }
    return went;
  },

  /**
   * {@link goToTab}, without the tab it leaves.
   *
   * @param {string} id A tab's node id.
   * @param {boolean} newWindow
   * @returns {Promise<boolean>}
   */
  async _goToTabOnce(id, newWindow) {
    if (!this._engine) {
      return false;
    }
    const { agentLabelOf } = this._modules.SvalPanelModel;
    const { TAB, workspaceOfNode } = this._modules.SvalTree;
    const nodes = (await this._engine.tree()).nodes ?? {};
    if (nodes[id]?.kind !== TAB) {
      return false;
    }
    const workspace = workspaceOfNode(nodes, id);
    const row = { id, kind: TAB };
    if (workspace === this._workspace.id) {
      await this.activate(row);
      return true;
    }
    if (!workspace || this._inMemory) {
      return false;
    }
    const shownBy = this._workspace.shownElsewhere().get(workspace);
    if (shownBy) {
      shownBy.focus();
      // A window still starting selects what its start restores.
      if (this._modules.SvalWindowWorkspace.of(shownBy).id !== workspace) {
        return false;
      }
      await shownBy.SvalPanel.activate(row);
      return true;
    }
    // Before the switch, which is what lets the hand-over select it. Past
    // the checks above, the switch fails only for a workspace deleted
    // meanwhile, which takes the tab and its mark with it.
    this._settings.setLastActive(id, this._modules.SvalClock.now());
    if (newWindow || agentLabelOf(nodes, workspace) !== null) {
      return this._openWorkspaceInNewWindow(workspace) !== null;
    }
    if (!(await this.switchTo(workspace))) {
      return false;
    }
    await this.activate(row);
    return true;
  },

  /**
   * Closes the empty tab an open-tab row was picked in, as Firefox closes it
   * after a switch to a tab (`UrlbarInput.pickResult`), so ⌘T, two letters
   * and Enter leave no blank tab behind.
   *
   * A tab still in its window closes as any tab does, which removes its
   * node. A window's last tab stays: closing it would close the window, or
   * open a new blank tab in its place. A switch of workspace takes the tab
   * out of the window and leaves its node in the workspace left
   * (`SvalTabObserver.releaseTabsOutside`), so the node is removed instead.
   *
   * @param {object} tab The empty tab.
   * @param {string|null} id Its node, read before the window went anywhere.
   */
  async _closeLeftTab(tab, id) {
    const gBrowser = tab.documentGlobal?.gBrowser;
    if (gBrowser?.tabs.includes(tab)) {
      if (gBrowser.tabs.length > 1) {
        gBrowser.removeTab(tab);
      }
      return;
    }
    if (!id) {
      return;
    }
    const nodes = (await this._engine.tree()).nodes ?? {};
    await this._modules.SvalTabs.removeNodes(
      this._engine,
      this._settings,
      nodes,
      [id]
    );
    await this.refresh();
  },

  /**
   * Undo close tab's key, which Firefox's
   * `SessionWindowUI.restoreLastClosedTabOrWindowOrSession` hands to a
   * window that shows a workspace: the observer reopens that workspace's
   * last closed tab (`SvalTabs`' `reopenClosedTab`).
   *
   * @returns {boolean} whether the window took the key, so Firefox reopens
   *   nothing of its own.
   */
  reopenClosedTab() {
    if (!this._observer) {
      return false;
    }
    this._observer.reopenClosedTab();
    return true;
  },
});
