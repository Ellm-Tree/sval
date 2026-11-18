/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Folding in the workspace panel's tree, and going to a tab: a group opened
 * or closed, a tab activated from its row or from elsewhere, and what a
 * pin's page being shown changes in the tree.
 *
 * `SvalWindow` loads this as a classic script after `sval-panel.js`; it adds
 * its methods to `SvalPanel`, whose state and helpers it shares.
 */

/* import-globals-from sval-panel.js */

Object.assign(SvalPanel, {
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
   * Repaints what a pin's page being selected or left changes: which row is
   * viewed, and the window's title.
   */
  onPinSelectionChanged() {
    // A pin's page leaves no tab viewed, so a path a collapsed group drew to
    // the selection goes. Leaving the page selects a tab through
    // `SvalPanelSelection.select`.
    if (
      this._pins?.pages.selectedGuid &&
      this._rows.some(row => row.showsSelection)
    ) {
      this.render();
    } else {
      this.selection.paint();
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
    await this.selection.select(row.id);
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
   * workspace is switched to here, through `SvalWindowWorkspace.switchTo`. The tab is marked used before a switch, so the window
   * that shows the workspace selects it as it starts or is handed over
   * (`SvalWindowWorkspace.mostRecentlyActive`), and no other tab of the workspace loads
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
    if (!(await this._workspace.switchTo(workspace))) {
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
