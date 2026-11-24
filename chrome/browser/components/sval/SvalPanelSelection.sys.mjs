/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The selection in a window's Workspace panel: the tab the user is working
 * in, the rows selected beside it (spec §10.5), and which rows are drawn as
 * selected.
 *
 * The panel makes one for its window and hands it what a selection reads of
 * the panel (`PanelView`). Everything else here is the selection's own.
 */

import {
  outermostIds,
  rangeIds,
} from "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs";
import {
  ancestorIds,
  isWithin,
} from "moz-src:///browser/components/sval/SvalTree.sys.mjs";

/**
 * What the selection reads of its panel, and asks of it.
 *
 * @typedef {object} PanelView
 * @property {object} nodes The document's `nodes` map as the panel draws it.
 * @property {object[]} rows The rows drawn.
 * @property {object} settings The window's `SvalLocalSettings` store.
 * @property {object} workspace The window's `SvalWindowWorkspace`.
 * @property {boolean} pinShown Whether a pin's page is selected over the tabs.
 * @property {(id: string) => Element|null} rowElementFor A drawn row's element.
 * @property {(id: string) => string} movingId The node a move of a row moves.
 * @property {(element: Element, row: object) => void} paintSplit Repaints a
 *   split's row.
 * @property {() => void} render Redraws the rows.
 */

/** One window's selection in its Workspace panel. */
export class SvalPanelSelection {
  /** @type {PanelView} */
  #view;

  /**
   * The rows selected beyond the tab on screen (spec §10.5), by row id: a
   * split's panes one by one. Empty while the tab on screen is the one
   * selected row. Kept in this window's memory alone.
   */
  #several = new Set();

  /** The row a Shift-click or Shift with an arrow selects from. */
  #anchor = null;

  /**
   * The selection and the containers above it when `reveal` last looked, as
   * one string per workspace this window has shown, so a redraw can tell a
   * selected tab that moved from one whose group the user has since folded.
   * Kept per workspace because a switch changes the chain without anything
   * moving: a switch back to a workspace whose group the user folded over
   * its selected tab keeps the fold.
   */
  #revealedPaths = new Map();

  /** @param {PanelView} view */
  constructor(view) {
    this.#view = view;
  }

  // ------------------------------------------------- the tab worked in

  /**
   * The node selected in the workspace this window shows, if it is still in
   * that workspace.
   *
   * Every window of a profile shares one settings store, and a window shows
   * only its own workspace (spec §10.7), so a node outside it has no row
   * here and is never this window's selection. A tab that cannot be
   * discarded stays in the window across a switch and can be selected from
   * the tab strip while it belongs to the workspace left; with it, this
   * window has no selection.
   *
   * @returns {string|null}
   */
  selectedId() {
    const { nodes, settings, workspace } = this.#view;
    const id = settings.selectionIn(workspace.id);
    return isWithin(nodes, id, workspace.id) ? id : null;
  }

  /**
   * The tab whose page the window shows: the selection, unless a pin's page
   * is selected over it. A pin's page is no row (pins spec §5), so with one
   * shown no row is viewed, and a collapsed group draws no path to one
   * (`SvalPanelModel.rows`).
   *
   * @returns {string|null}
   */
  viewedId() {
    return this.#view.pinShown ? null : this.selectedId();
  }

  /**
   * Marks `id` as the node the user is working in, which is where new tabs go
   * and not only what is highlighted. Device-local (spec §5.6), and recorded
   * for the workspace this window shows.
   *
   * @param {string} id A node id.
   */
  async select(id) {
    const { rows, settings, workspace } = this.#view;
    if (!workspace.id) {
      return;
    }
    // The tab already selected is selected again whenever its tabs come back
    // (a switch back to its workspace, a launch), and that is no new
    // selection: a group the user folded over it stays folded.
    const changed = settings.selectionIn(workspace.id) !== id;
    settings.setSelection(workspace.id, id);
    // A row drawn only because it led to the old selection goes with it.
    const pathDrawn = rows.some(row => row.showsSelection);
    // Leaving a pin's page for the selected tab changes no selection, and
    // the rows drawn while the page showed have no path to that tab.
    const viewed = this.viewedId();
    const unshown = viewed !== null && !rows.some(row => row.id === viewed);
    if (this.reveal({ force: changed }) || pathDrawn || unshown) {
      this.#view.render();
    } else {
      this.paint();
    }
    settings.saveSoon();
  }

  /**
   * Opens every container above the selection, so the tab the user is
   * viewing always has a row. Every way a tab comes to be selected reaches
   * `select` (a row's click, `TabSelect` from the strip, Cmd+number, a
   * workspace switch's hand-over, a link, restoration, an agent), and that
   * call forces this when the selection changes. Spec §5.6 starts every
   * group a device has not seen collapsed, which is the state a tab arriving
   * from sync or first run is selected into.
   *
   * Otherwise it acts only when the chain above the selection differs from
   * the last time this window looked at its workspace: a peer moving the
   * selected tab into a group this device has never opened reveals it, and
   * a group the user folded over the selected tab stays folded until the
   * selection next changes. A workspace this window has not looked at yet
   * is recorded as it stands. A collapsed group still draws the path to
   * the selection (`SvalPanelModel.rows`), so a fold never hides it.
   *
   * Collapse is device-local (spec §5.6), so nothing here reaches the engine
   * or another device. The caller redraws, and flushes the settings.
   *
   * @param {object} [options]
   * @param {boolean} [options.force] Open the chain even if it was opened
   *   for this same selection before.
   * @returns {boolean} whether any container was opened.
   */
  reveal({ force = false } = {}) {
    const { nodes, settings, workspace } = this.#view;
    const id = this.selectedId();
    const above = ancestorIds(nodes, id);
    const path = [id, ...above].join(" ");
    const last = this.#revealedPaths.get(workspace.id);
    this.#revealedPaths.set(workspace.id, path);
    if (!force && (last === undefined || path === last)) {
      return false;
    }
    let opened = false;
    for (const container of above) {
      if (settings.isCollapsed(container)) {
        settings.setCollapsed(container, false);
        opened = true;
      }
    }
    return opened;
  }

  // ------------------------------------------------ the rows selected

  /** Whether rows are selected beyond the tab on screen. */
  get several() {
    return this.#several.size > 0;
  }

  /**
   * Whether `id`'s row is drawn and announced as selected: one of the rows
   * selected, or with none selected beyond it, the tab on screen's.
   *
   * @param {string} id A row id.
   * @returns {boolean}
   */
  has(id) {
    return this.#several.size ? this.#several.has(id) : this.viewedId() === id;
  }

  /**
   * The selection a command on `row` acts on (spec §10.5): every selected
   * row, in the order they are drawn, when `row` is one of two or more.
   *
   * @param {object|null} row
   * @returns {string[]|null} row ids, or null for a command on `row` alone.
   */
  around(row) {
    if (this.#several.size < 2 || !this.#several.has(row?.id)) {
      return null;
    }
    return this.#rowIds().filter(id => this.#several.has(id));
  }

  /**
   * The nodes a move of the selected rows `ids` moves: a pane's split, as one
   * row's move does, and nothing inside another of them.
   *
   * @param {string[]} ids Row ids, in the order they are drawn.
   * @returns {string[]}
   */
  roots(ids) {
    return outermostIds(
      this.#view.nodes,
      ids.map(id => this.#view.movingId(id))
    );
  }

  /**
   * Adds a row to the selection or takes it out: Accel-click, Ctrl+Space.
   * The rows selected start from the tab on screen, when it has a row, as
   * Firefox's tab strip adds its selected tab to a multiselection.
   *
   * @param {string} id A row id.
   */
  toggle(id) {
    if (!this.#several.size) {
      const viewed = this.viewedId();
      if (viewed && this.#rowIds().includes(viewed)) {
        this.#several.add(viewed);
      }
    }
    if (!this.#several.delete(id)) {
      this.#several.add(id);
    }
    this.#anchor = id;
    this.paint();
  }

  /**
   * Selects every row from the anchor to `id`: Shift-click. The anchor is
   * the row last clicked, or the tab on screen's.
   *
   * @param {string} id A row id.
   * @param {object} [options]
   * @param {boolean} [options.add] Keep what is already selected, as
   *   Accel+Shift-click does.
   */
  selectTo(id, { add = false } = {}) {
    const ids = this.#rowIds();
    const anchor = ids.includes(this.#anchor)
      ? this.#anchor
      : this.selectedId();
    if (!add) {
      this.#several.clear();
    }
    for (const each of rangeIds(ids, anchor, id)) {
      this.#several.add(each);
    }
    this.#anchor = ids.includes(anchor) ? anchor : id;
    this.paint();
  }

  /**
   * Selects every row from the anchor to `to`, the row the focus moved to:
   * Shift with Up or Down. With nothing selected, the anchor is `from`, the
   * row the focus left.
   *
   * @param {string} from A row id.
   * @param {string} to A row id.
   */
  extend(from, to) {
    if (!this.#several.size || !this.#anchor) {
      this.#anchor = from;
    }
    this.#several = new Set(rangeIds(this.#rowIds(), this.#anchor, to));
    this.paint();
  }

  /**
   * Leaves the tab on screen the one selected row: Escape, a click.
   *
   * @param {string|null} [anchor] Where the next Shift-click starts.
   */
  clear(anchor = this.#anchor) {
    this.#anchor = anchor;
    if (this.#several.size) {
      this.#several.clear();
      this.paint();
    }
  }

  /**
   * Keeps the selection to the rows drawn (spec §10.5): a row closed, moved
   * to another workspace, folded away or left by a switch leaves it.
   */
  prune() {
    const ids = new Set(this.#rowIds());
    for (const id of this.#several) {
      if (!ids.has(id)) {
        this.#several.delete(id);
      }
    }
    if (!ids.has(this.#anchor)) {
      this.#anchor = null;
    }
  }

  /**
   * Repaints which rows are selected, and on a split's row which pane is
   * active, which follows the viewing.
   */
  paint() {
    for (const row of this.#view.rows) {
      const element = this.#view.rowElementFor(row.id);
      if (!element) {
        continue;
      }
      if (row.panes) {
        this.#view.paintSplit(element, row);
      } else {
        element.setAttribute(
          "aria-selected",
          this.has(row.id) ? "true" : "false"
        );
      }
    }
  }

  /** @returns {string[]} every drawn row's id, a split's panes one by one. */
  #rowIds() {
    return this.#view.rows
      .flatMap(row => row.panes ?? [row])
      .map(row => row.id);
  }
}
