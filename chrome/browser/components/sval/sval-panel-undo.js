/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Deleting document nodes behind the panel's Undo message
 * (`SvalPanelUndo`): several tabs, a group or a Workspace leave the panel at
 * once, their tabs hidden and unloaded, and the delete is made when the
 * message goes.
 *
 * `SvalWindow` loads this as a classic script after `sval-panel.js`; it adds
 * its methods to `SvalPanel`, whose state and helpers it shares.
 */

/* import-globals-from sval-panel.js */

Object.assign(SvalPanel, {
  /**
   * The message's live region, always in the panel so a screen reader
   * announces what is put in it (`role="status"`, as the picker's toast).
   *
   * @param {Function} make As `_build` makes an element.
   * @returns {Element}
   */
  _buildUndoRegion(make) {
    this.undo.watch();
    return make("div", { class: "sval-undo-region", role: "status" });
  },

  /**
   * Holds back the delete of nodes in the document: several tabs, a group,
   * or a Workspace, with everything inside each.
   *
   * Their rows leave at once. Their tabs in this window are hidden and
   * unloaded, so a deleted tab plays nothing and holds no memory while the
   * message shows; the tab on screen hands over first to the tab a close
   * would land on (`_findTabToBlurTo`), or to a new home tab when they are
   * every tab the window has (`keepOneTab`). A Workspace the window shows
   * is left as a switch leaves one (`SvalWindowWorkspace.resolve`), and any of
   * its tabs a window kept loaded is unloaded.
   *
   * @param {string} text What went, in a few words.
   * @param {string[]} ids Node ids, all tabs or one container.
   * @param {object} [options]
   * @param {boolean} [options.keepContents] The group's contents move out
   *   to its parent when the delete is made, and show there meanwhile.
   */
  async _deferRemoval(text, ids, { keepContents = false } = {}) {
    await this.undo.commit();
    await this._observer?.settled();
    const { rowIndexIn } = this._modules.SvalPanelModel;
    const { WORKSPACE, descendantIds } = this._modules.SvalTree;
    const present = ids.filter(id => this._nodes[id]);
    if (!present.length) {
      return;
    }
    const workspace = this._nodes[present[0]].kind === WORKSPACE;
    const going = keepContents
      ? present
      : [
          ...present.flatMap(each => descendantIds(this._nodes, each)),
          ...present,
        ];
    const index = rowIndexIn(this._rows, present[0]);
    const pending = {
      tree: { ids: present, keepContents, workspace },
      tabs: [],
      home: null,
      selected: null,
      showing: workspace && present.includes(this._workspace.id),
      shownElsewhere: workspace
        ? (this._workspace.shownElsewhere().get(present[0]) ?? null)
        : null,
    };
    pending.undo = () => this._undoTreeRemoval(pending);
    pending.commit = options =>
      this._commitTreeRemoval(pending, going, options);
    await this.undo.defer(text, pending, async () => {
      if (!workspace && !keepContents) {
        Object.assign(pending, this._hideTabsForDelete(going));
      }
      await this.refresh();
      if (index >= 0 && !workspace) {
        const landing = this._rows[Math.min(index, this._rows.length - 1)];
        this._focusRow(landing?.id);
      }
      if (workspace) {
        this._refreshOtherWindows();
      }
      const tabs = workspace ? this._tabsOfNodes(going) : pending.tabs;
      await Promise.all(
        tabs.map(tab =>
          this._modules.SvalFirefox.unloadForDelete(tab.documentGlobal, tab)
        )
      );
      // A tab sharing the camera, microphone or screen refuses the hide
      // until the unload has stopped it.
      if (!pending.settled) {
        for (const tab of pending.tabs) {
          if (!tab.closing && !tab.hidden) {
            this._modules.SvalFirefox.hideForDelete(window, tab);
          }
        }
      }
    });
  },

  /**
   * Hides this window's tabs for `ids`, handing the tab on screen over
   * first, since `hideTab` declines the selected tab.
   *
   * @param {string[]} ids Node ids.
   * @returns {{tabs: object[], home: object|null, selected: object|null}}
   *   the tabs hidden, the home tab opened for the window's sake, and the
   *   tab that was on screen when it was among them.
   */
  _hideTabsForDelete(ids) {
    const { gBrowser } = window;
    const tabs = ids.map(id => this._observer?.tabFor(id)).filter(Boolean);
    if (!tabs.length) {
      return { tabs, home: null, selected: null };
    }
    const selected = tabs.includes(gBrowser.selectedTab)
      ? gBrowser.selectedTab
      : null;
    let home = this._observer.keepOneTab(ids);
    if (selected && gBrowser.selectedTab === selected) {
      let next = gBrowser._findTabToBlurTo(selected, [...tabs]);
      if (!next) {
        home = this._observer.openUnfiledTab();
        next = home;
      }
      if (next && gBrowser.selectedTab !== next) {
        gBrowser.selectedTab = next;
      }
    }
    for (const tab of tabs) {
      this._modules.SvalFirefox.hideForDelete(window, tab);
    }
    return { tabs, home, selected };
  },

  /**
   * Every normal window's tabs for `ids`, such as the tabs a switch kept
   * loaded for a Workspace (`hideForWorkspace`).
   *
   * @param {string[]} ids Node ids.
   * @returns {object[]}
   */
  _tabsOfNodes(ids) {
    const wanted = new Set(ids);
    const tabs = [];
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      for (const tab of win.gBrowser?.tabs ?? []) {
        if (wanted.has(this._modules.SvalTabs.nodeIdOf(tab))) {
          tabs.push(tab);
        }
      }
    }
    return tabs;
  },

  /**
   * Undo of a held-back delete of nodes: their rows and tabs show again where
   * they were, each tab loading when it is next selected. The tab that was
   * on screen is selected again, and a home tab opened for the window's sake
   * closes if nobody used it (`tab.isEmpty`). A Workspace this window or
   * another showed is shown there again.
   *
   * @param {object} pending What {@link _deferRemoval} held back.
   */
  async _undoTreeRemoval(pending) {
    const { gBrowser } = window;
    const { isHiddenForDelete } = this._modules.SvalFirefox;
    for (const tab of pending.tabs) {
      if (!tab.closing && isHiddenForDelete(tab)) {
        gBrowser.showTab(tab);
      }
    }
    await this.refresh();
    if (pending.tree.workspace) {
      this._refreshOtherWindows();
    }
    if (pending.selected && !pending.selected.closing) {
      gBrowser.selectedTab = pending.selected;
    }
    const { home } = pending;
    if (home && !home.closing && home.isEmpty) {
      gBrowser.removeTab(home);
    }
    const [id] = pending.tree.ids;
    if (pending.showing && this._treeNodes[id]) {
      await this._workspace.switchTo(id);
    }
    // The window that showed it, if still open, shows it again.
    const other = pending.shownElsewhere?.closed
      ? null
      : pending.shownElsewhere;
    if (other?.SvalPanel?._engine && this._treeNodes[id]) {
      await this._modules.SvalWindowWorkspace.of(other).switchTo(id);
    }
  },

  /**
   * Makes a held-back delete of nodes. The engine deletes them as an
   * immediate delete does (`SvalTabs.removeNodes`, or
   * `removeKeepingChildren` for a group whose contents move out), and each
   * hidden tab is shown and closed as a person's close is, so Firefox's
   * recently-closed list keeps it unhidden (`SvalTabObserver.closeNodes`).
   * An agent paired with a deleted Workspace is no longer paired, unless the
   * user lets it connect without asking (agent-control spec §5.1).
   *
   * @param {object} pending What {@link _deferRemoval} held back.
   * @param {string[]} going The nodes whose tabs close.
   * @param {object} options
   * @param {boolean} options.closing As `SvalPanelUndo.commit`.
   * @param {boolean} options.inUnload As `SvalPanelUndo.commit`.
   * @returns {Promise<void>|Array<Promise|Function>} the delete, or with
   *   `closing` its steps (`finishBeforeShutdown`).
   */
  _commitTreeRemoval(pending, going, { closing, inUnload }) {
    // The delete's posted write, then what follows it.
    const remove = nodes => {
      const { ids, keepContents } = pending.tree;
      if (keepContents) {
        const [id] = ids;
        if (!nodes[id]) {
          return [];
        }
        return [
          this._engine.mutate({ kind: "removeKeepingChildren", id }),
          () => this._settings.forgetLastActive(id),
        ];
      }
      return [
        this._modules.SvalTabs.removeNodes(
          this._engine,
          this._settings,
          nodes,
          ids
        ),
      ];
    };
    const closeTabs = nodes => {
      const { isHiddenForDelete } = this._modules.SvalFirefox;
      for (const tab of pending.tabs) {
        if (!tab.closing && isHiddenForDelete(tab)) {
          window.gBrowser.showTab(tab);
        }
      }
      if (!pending.tree.keepContents) {
        this._observer?.closeNodes(going, nodes);
      }
    };
    const after = () => {
      this._settings.saveSoon();
      if (pending.tree.workspace) {
        return this._modules.SvalAgents.store?.workspaceDeleted(
          pending.tree.ids[0]
        );
      }
      return undefined;
    };
    if (closing) {
      const nodes = this._treeNodes;
      // Posted before the closes, so each close's own delete finds its node
      // gone (`SvalTabObserver.#remove` reads the document first).
      const removed = remove(nodes);
      if (!inUnload) {
        closeTabs(nodes);
      }
      return [...removed, after];
    }
    return (async () => {
      await this._observer?.settled();
      const nodes = (await this._engine.tree()).nodes ?? {};
      const [removed, then] = remove(nodes);
      await removed;
      then?.();
      closeTabs(nodes);
      await after();
    })();
  },

  /** Redraws every normal window's pins row. */
  renderPinsEverywhere() {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      win.SvalPanel?._pins?.render();
    }
  },

  /** Redraws every other normal window's panel. */
  _refreshOtherWindows() {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (win !== window && win.SvalPanel?._engine) {
        win.SvalPanel.refresh().catch(err =>
          this._modules.SvalLog.error(
            `redrawing another window failed: ${this._modules.describeError(err)}`
          )
        );
      }
    }
  },
});
