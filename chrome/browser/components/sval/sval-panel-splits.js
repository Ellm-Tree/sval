/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Split view edits from the workspace panel (split-view spec §6): making a
 * split, adding a page to one, separating it, renaming it.
 *
 * `SvalWindow` loads this as a classic script after `sval-panel.js`; it adds
 * its methods to `SvalPanel`, whose state and helpers it shares.
 */

/* import-globals-from sval-panel.js */

Object.assign(SvalPanel, {
  /**
   * "Create Split" on a tab's row: shows the tab, then runs the add-split
   * command on it, which opens Firefox's picker beside it as the second pane
   * (`BrowserCommands.addTabSplitView`, split-view spec §6.3). Firefox makes
   * the split, and the window's tab observer writes it (§6.1).
   *
   * @param {object} row A tab's row.
   */
  async _openSplitPicker(row) {
    await this.activate(row);
    window.BrowserCommands.addTabSplitView();
  },

  /**
   * Separate: the split goes, and its tabs stay where it was, in order, as
   * ordinary tabs (split-view spec §5.2). The window follows the tree.
   *
   * @param {string} split A split's id.
   */
  async separate(split) {
    await this._removeSubtree(split, { keepContents: true });
  },

  /**
   * Rename Split…: sets the split's name. Unlike every other name, an empty
   * one is an answer here: it takes the name away, and the row shows its
   * pages' titles again (split-view spec §6.3).
   *
   * @param {string} split A split's id.
   */
  async _renameSplit(split) {
    const { openSvalDialog, SvalPanelModel } = this._modules;
    const current = this._nodes[split]?.content?.name ?? "";
    const answer = await openSvalDialog(window, {
      icon: "pencil",
      title: "Rename Split",
      body: "If it has no name, the Split shows its pages’ titles.",
      // An empty name gives the split back its pages' titles.
      field: { label: "Name", value: current, optional: true },
      primary: "Rename",
    });
    const name = SvalPanelModel.chosenOverName(answer.ok, answer.value);
    if (name === null || name === current) {
      return;
    }
    await this._engine.mutate({
      kind: "rename",
      id: split,
      name,
      now: this._modules.SvalClock.now(),
    });
    await this.refresh();
    this._focusRow(split);
    this._publishSoon();
  },

  /**
   * An Alt-click on a tab's row while another is viewed: the one write
   * `SvalPanelModel.altClickSplitOps` gives, after which the window shows
   * the split the tree holds (split-view spec §6.1).
   *
   * @param {object} row The clicked tab's row.
   */
  async _altClickSplit(row) {
    if (await this.splitBeside(this.selection.selectedId(), row.id)) {
      this._focusRow(row.id);
    }
  },

  /**
   * Splits tab `id` with tab `viewed`, the one the user views, in the one
   * write `SvalPanelModel.altClickSplitOps` gives: `id` joins `viewed`'s
   * split as its rightmost pane while the split has room, and the two make a
   * new split, `viewed` on the left, otherwise. The window then shows the
   * split the tree holds (split-view spec §6.1). An Alt-click on a row, and
   * a Quick Peek's "Open in Split" (`SvalQuickPeek`).
   *
   * @param {string|null} viewed A tab's id.
   * @param {string} id A tab's id.
   * @returns {Promise<boolean>} whether the split was written.
   */
  async splitBeside(viewed, id) {
    const ops = this._modules.SvalPanelModel.altClickSplitOps(
      this._nodes,
      viewed,
      id,
      () => crypto.randomUUID()
    );
    if (!ops) {
      return false;
    }
    try {
      await this._engine.mutate({
        kind: "batch",
        ops,
        now: this._modules.SvalClock.now(),
      });
    } catch (err) {
      this._logRefusal(id, err);
      await this.refresh();
      return false;
    }
    await this.refresh();
    this._publishSoon();
    return true;
  },

  /**
   * Adds tab `tab` to split `split` as its rightmost pane, in the one write
   * `SvalPanelModel.joinSplitOps` gives: "Add to Split" or a drop on the
   * split's row. The window then shows the split the tree holds (split-view
   * spec §6.1).
   *
   * @param {string} split A split's id.
   * @param {string} tab A tab's id.
   */
  async _joinSplit(split, tab) {
    const ops = this._modules.SvalPanelModel.joinSplitOps(
      this._nodes,
      split,
      tab
    );
    if (!ops) {
      return;
    }
    try {
      await this._engine.mutate({
        kind: "batch",
        ops,
        now: this._modules.SvalClock.now(),
      });
    } catch (err) {
      this._logRefusal(tab, err);
      await this.refresh();
      return;
    }
    await this.refresh();
    this._focusRow(tab);
    this._publishSoon();
  },

  /**
   * "Add Tab to Split" on a pane: shows the pane, then adds a pane showing
   * Firefox's picker to its split, as the add-split shortcut does in a split
   * (`SvalFirefox.addPickerPane`, split-view spec §6.3).
   *
   * @param {object} row A pane's row.
   */
  async _addPickerPane(row) {
    await this.activate(row);
    this._modules.SvalFirefox.addPickerPane(window);
  },
});
