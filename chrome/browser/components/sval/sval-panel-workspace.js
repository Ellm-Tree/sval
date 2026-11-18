/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * What the panel does for the workspace its window shows
 * (`SvalWindowWorkspace`, spec §10.7): what it lends that class, where in
 * the workspace a tab opened from inside it goes, and the fade of a switch.
 *
 * `SvalWindow` loads this as a classic script after `sval-panel.js`; it adds
 * its methods to `SvalPanel`, whose state and helpers it shares.
 */

/* import-globals-from sval-panel.js */

Object.assign(SvalPanel, {
  /**
   * Lends the window's `SvalWindowWorkspace` the panel's data and the things
   * only a view does (`SvalWindowWorkspace.attach`). The data is read each
   * time it is wanted: a start replaces the engine, the settings and the
   * observer.
   */
  _attachWorkspace() {
    const panel = this;
    this._workspace.attach({
      get engine() {
        return panel._engine;
      },
      get settings() {
        return panel._settings;
      },
      get observer() {
        return panel._observer;
      },
      get pins() {
        return panel._pins;
      },
      get nodes() {
        return panel._nodes;
      },
      redraw: nodes => this.refresh(nodes),
      sync: () => this.syncNow(),
      shown: () => {
        this._setJar();
        // The row that had focus belongs to the workspace being left, so it
        // is not in the new row list; `render` puts focus on the first row
        // of what it draws rather than leaving the tree with no tab stop.
        this._focusedId = null;
      },
      fadeIn: () => this._fadeInWorkspace(),
    });
  },

  /**
   * Where a tab opened from inside the user's work goes (a link opened in a
   * new tab, or a row's own New tab): the selected node if it can hold
   * children, that node's parent if the selection is itself a tab, the
   * split's parent if that tab is in a split, which a tab joins only by the
   * user splitting it (split-view spec §6.1), and the workspace this window
   * shows otherwise. The user's own new tab, from the
   * header's button or the keyboard, is not asked: it opens at the top of the
   * workspace (`SvalTabs`' `openNewTab`).
   *
   * Resolved against the tree on every call rather than cached, because a
   * selection can name a node another device deleted between two tabs opening.
   *
   * Only inside the workspace this window shows, which is all
   * `SvalPanelSelection.selectedId` answers with.
   *
   * @returns {Promise<string>} a node id that exists and can hold a tab.
   */
  async _newTabParent() {
    const { isPane } = this._modules.SvalPanelModel;
    const { WORKSPACE, GROUP } = this._modules.SvalTree;
    const current = this._workspace.id;
    const selected = this.selection.selectedId();
    const node = selected ? this._nodes[selected] : null;
    if (node && (node.kind === WORKSPACE || node.kind === GROUP)) {
      return selected;
    }
    let parent = node?.placement?.parent;
    if (isPane(this._nodes, selected)) {
      parent = this._nodes[parent].placement?.parent;
    }
    if (parent && this._nodes[parent]) {
      return parent;
    }
    return current;
  },

  /**
   * Fades the panel and the page in over the window's new tint, so a switch
   * does not jump. A view transition would cross-fade, but Gecko paints none
   * of its snapshots in the browser window's own document.
   *
   * The panel's rows fade, and the container holding them and the resize
   * edge does not: opacity makes an element a stacking context, and the
   * edge's `z-index`, which lifts it over `#tabbrowser-tabbox`, would then
   * count only inside the container, leaving the page over the edge.
   *
   * @returns {Animation[]}
   */
  _fadeInWorkspace() {
    return [
      document.querySelector("#sval-panel-container > .sval-panel"),
      window.gBrowser.tabbox,
    ].map(el =>
      el.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 150,
        easing: "ease-out",
      })
    );
  },
});
