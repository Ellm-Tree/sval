/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Following the document: each time it changes, read it, bring this window
 * in step with it (tabs whose nodes are gone, kept tabs, workspace jars,
 * splits), and redraw.
 *
 * `SvalWindow` loads this as a classic script after `sval-panel.js`; it adds
 * its methods to `SvalPanel`, whose state and helpers it shares.
 */

/* import-globals-from sval-panel.js */

Object.assign(SvalPanel, {
  /** `{ nodes, json }`: `_nodes` serialised once, for `_refreshIfChanged`. */
  _drawnJson: null,

  /**
   * Redraws only if the document is not what is already on screen.
   *
   * For the passes a person did not ask for. Rows are rebuilt wholesale, which
   * moves focus back onto its row afterwards, so redrawing every few seconds
   * for a document that has not changed would be a visible cost paid for
   * nothing. The comparison is the nodes as canonical JSON, which is what the
   * rows are a function of together with this device's collapse state, and a
   * collapse change never comes from a pass. The drawn nodes' JSON is kept
   * beside them, so each comparison serialises only the new read.
   *
   * @returns {Promise<boolean>} whether anything was redrawn.
   */
  async _refreshIfChanged() {
    const tree = await this._engine.tree();
    const nodes = tree.nodes ?? {};
    const json = JSON.stringify(nodes);
    if (this._drawnJson?.nodes !== this._nodes) {
      this._drawnJson = {
        nodes: this._nodes,
        json: JSON.stringify(this._nodes),
      };
    }
    if (json === this._drawnJson.json) {
      return false;
    }
    this._drawnJson = { nodes, json };
    await this.refresh(nodes);
    return true;
  },

  /**
   * Makes new tabs in this window open in the jar of the workspace it shows
   * (isolated workspaces spec §4, `workspace-jar-for-new-tabs.patch`).
   *
   * @returns {boolean} whether the jar changed.
   */
  _setJar() {
    if (this._isPrivate) {
      return false;
    }
    const jar = this._modules.SvalWorkspaceJar.userContextIdFor(
      this._nodes,
      this._workspace.id
    );
    if ((window.gBrowser.defaultUserContextId ?? 0) === jar) {
      return false;
    }
    window.gBrowser.defaultUserContextId = jar;
    return true;
  },

  /**
   * Follows each workspace's jar after the document changed: when one was
   * isolated or stopped being isolated, here or on another device, every tab
   * of it in this window reopens in the new jar (spec §5), and then the jars
   * no workspace uses any more go (`SvalTabObserver.keepTabsInJar`).
   *
   * @returns {Promise<void>}
   */
  async _keepJar() {
    if (this._isPrivate) {
      return;
    }
    this._setJar();
    // Every tab, every time: a jar can change for a workspace this window
    // does not show, and one of its tabs (an agent's) can be here. Queued and
    // not awaited, because the observer's own queue is what calls `refresh`
    // (`onTreeChanged`), and awaiting the queue from inside it never ends.
    this._observer?.keepTabsInJar?.({ wait: false, nodes: this._nodes });
  },

  /**
   * Shows in this window the splits the document holds, after anything that
   * can have changed them or put a pane's tab here (split-view spec §6.1,
   * `SvalTabObserver.keepSplits`). Queued and not awaited, as in `_keepJar`.
   */
  keepSplits() {
    this._observer?.keepSplits?.();
  },

  /**
   * Redraws from `nodes`, the tree the tab observer read after its change,
   * or from a fresh read of the engine's tree.
   *
   * @param {object} [nodes] The document's `nodes` map.
   */
  async refresh(nodes) {
    this._treeNodes = nodes ?? (await this._engine.tree()).nodes ?? {};
    // A closed window takes no workspace and keeps no tab. The session store
    // drops its record of a window once it is closing
    // (`SessionStoreInternal.onClose`), and recording a workspace for it
    // then throws.
    if (window.closed) {
      return;
    }
    // Without what waits on an Undo message, so every row, count and menu
    // treats it as gone (`_viewOf`).
    this._nodes = this._viewOf(this._treeNodes);
    this._showStrandedDeleteHides();
    this._dropOrphanTabs();
    // Before drawing: a pass can have taken away the workspace this window
    // was showing, and `render` draws whatever workspace the window shows.
    await this._resolveCurrentWorkspace();
    this._keepKeptTabsWithTheirWindows();
    await this._keepJar();
    this.keepSplits();
    const revealed = this._revealSelection();
    this.render();
    if (revealed) {
      this._settings.saveSoon();
    }
  },

  /**
   * Keeps every kept tab in a workspace no window shows (spec §10.7), after
   * the document changed: a peer's pass or a refile can put a kept tab's
   * node in a workspace a window shows, and that window takes it. Hung on
   * every redraw, as {@link _dropOrphanTabs} is. This window takes its own
   * workspace's kept tabs, and a window showing a workspace this window
   * keeps a tab of is told to take it.
   */
  _keepKeptTabsWithTheirWindows() {
    if (this._inMemory) {
      return;
    }
    // Queued and not waited for (`SvalSerialQueue.post`): a redraw can run
    // inside a switch's task, which the queue cannot get past to answer.
    if (window.toolbar.visible) {
      this._switching ??= new this._modules.SvalSerialQueue("workspace switch");
      this._switching.post(() => this._takeKeptTabsNow());
    }
    const { isHiddenForWorkspace } = this._modules.SvalFirefox;
    if (window.gBrowser.tabs.some(tab => isHiddenForWorkspace(tab))) {
      for (const other of this._workspace.shownElsewhere().values()) {
        other.SvalPanel?.takeKeptTabs();
      }
    }
  },

  /**
   * Takes into this window the tabs other windows keep loaded for the
   * workspace it shows (`SvalRestore.takeKept`), in the switch's queue, so
   * the workspace it takes for is the one it shows once any switch is over.
   *
   * @returns {Promise<void>}
   */
  takeKeptTabs() {
    if (this._inMemory || !window.toolbar.visible) {
      return Promise.resolve();
    }
    this._switching ??= new this._modules.SvalSerialQueue("workspace switch");
    return this._switching
      .run(() => this._takeKeptTabsNow())
      .catch(err => {
        this._modules.SvalLog.error(
          `taking kept tabs failed: ${this._modules.describeError(err)}`
        );
      });
  },

  /** {@link takeKeptTabs}'s work, for a caller in the switch's queue. */
  async _takeKeptTabsNow() {
    if (!this._engine || window.closed || this._workspace.closing) {
      return;
    }
    // The latest read: every change that can bring a kept tab here is
    // read back and redrawn, and each redraw asks again.
    const nodes =
      this._modules.latestNodes(this._engine) ??
      (await this._engine.tree()).nodes ??
      {};
    // A window closed while the tree was read has no tab strip left:
    // tabbrowser fails to make a tab in it (`aWindow.docShell` is null).
    if (window.closed) {
      return;
    }
    const id = this._workspace.id;
    if (id) {
      this._modules.SvalRestore.takeKept(window, {
        nodes,
        workspaceId: id,
      });
      // A kept split's tabs come one at a time, and Firefox separates
      // what each leaves behind.
      this.keepSplits();
    }
  },

  /**
   * Takes out of this window any tab whose node the document no longer holds.
   *
   * Hung on every redraw, because the redraw is the one thing that happens
   * whenever the document has changed: a pass, this window's own mutation, or
   * another window's. A node another device deletes leaves this window holding
   * an undrawn tab for it, and an undrawn tab is invisible in a browser whose
   * only tab surface is this panel.
   * `SvalTabObserver.closeOrphanTabs` carries the rest of the reasoning and the
   * one state it refuses to act on.
   */
  _dropOrphanTabs() {
    if (!this._observer) {
      return;
    }
    this._observer.closeOrphanTabs(this._treeNodes);
  },
});
