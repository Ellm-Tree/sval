/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Dragging rows in the workspace panel's tree: what a drop at the pointer
 * would do, the marks that show it, and the write when it lands.
 *
 * The visual language follows Atlassian's drag-and-drop design guidelines,
 * NN/g's article on drag and drop, and Firefox's own tab strip: the dragged
 * row stays in place, dimmed; a line with a dot at its start marks a drop
 * between rows, indented to the depth the node will land at; a solid
 * outline marks a group the node will join. A tab's or split's middle fades
 * the row under its two drops, New group and the split, side by side, the
 * one under the pointer filled. Every route ends in the same `_applyMove` or
 * `_merge` a key or the menu uses.
 *
 * `SvalWindow` loads this as a classic script after `sval-panel.js`; it adds
 * its methods to `SvalPanel`, whose state and helpers it shares.
 */

/* import-globals-from sval-panel.js */

{
  const { NODE_DRAG_TYPE, SPLIT_MAX_PANES } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
  );

  /**
   * Below this width of a row's drop target the row has no split zone: its
   * middle makes a group, and splitting goes through the menu (panel-drag
   * handoff). Its mark is then the New group half alone, across the target.
   */
  const SPLIT_ZONE_MIN_ROW_PX = 120;

  /**
   * What a drop zone's mark says, drawn on the row and spoken through the
   * panel's live region while the pointer is in it.
   */
  const DROP_LABELS = {
    newGroup: "New group",
    split: "Create Split",
    join: "Join Split",
    merge: "Merge Splits",
    full: `${SPLIT_MAX_PANES} pages max`,
  };

  /**
   * How close to the tree's top or bottom edge a drag scrolls it, and by how
   * much each `dragover`, which Gecko keeps firing while the pointer rests.
   */
  const AUTOSCROLL_EDGE_PX = 24;
  const AUTOSCROLL_STEP_PX = 8;

  Object.assign(SvalPanel, {
    /**
     * The drag in progress from this window's tree, or null. `id` is the node
     * being dragged, and `carried`, when it is one of a selection, every node
     * the drag moves; `over`, `intent` and `plan` are what a drop now would
     * do, from `SvalPanelModel.dropIntent` and `dropTarget`, `dropTargets` or
     * `mergeTarget`.
     *
     * A tab row dragged in from another window's tree is held here too while
     * it is over this one, with `from` naming that window
     * ({@link _arrivingDrag}). A drag from anywhere else leaves this null,
     * which is how it is refused.
     */
    _drag: null,

    /**
     * A merge waiting on its name prompt, so both rows keep their outline while
     * the user decides.
     */
    _pendingMerge: null,

    /**
     * Starts a drag. A split's tile carries that one page: out of the split, or
     * along it to another place among its pages. The rest of the split's row,
     * its icon first, carries the whole split. A selected row carries every
     * selected row (spec §10.5).
     *
     * @param {DragEvent} event `dragstart` on a row or a tile.
     */
    _onDragStart(event) {
      const element = event.target.closest?.(
        '.sval-split-pane[draggable="true"], .sval-row[draggable="true"]'
      );
      const row = element ? this._rowFor(element.dataset.nodeId) : null;
      if (!row) {
        return;
      }
      const id = row.panes ? row.split : row.id;
      const image = this._dragImageFor(row, element);
      if (image) {
        event.dataTransfer.setDragImage(image, 12, image.offsetHeight / 2);
        window.requestAnimationFrame(() => image.remove());
      }
      event.dataTransfer.setData(NODE_DRAG_TYPE, id);
      event.dataTransfer.effectAllowed = "move";
      // On the row itself rather than the tree: a sync can redraw the tree
      // mid-drag, and `dragend` is dispatched to the element the drag began on,
      // which by then is no longer inside it.
      element.addEventListener("dragend", this, { once: true });
      const several = this._selectionFor(row);
      this._drag = {
        id,
        row: row.id,
        rows: several ?? [row.id],
        carried: several ? this._selectionRoots(several) : null,
        dimmed: false,
        over: null,
        intent: null,
      };
      // Dimmed on the next frame, because the drag image is taken from the row
      // after this handler returns and a dimmed row would make a dimmed image.
      const drag = this._drag;
      window.requestAnimationFrame(() => {
        if (this._drag === drag) {
          drag.dimmed = true;
          this._paintDragState();
        }
      });
    },

    /**
     * The tab row this window's drag carries, for another window's tree to
     * take: one tab, outside every split and selection. Null for any other
     * drag, which no other window takes.
     *
     * @returns {string|null} its node id.
     */
    draggedTab() {
      const drag = this._drag;
      if (!drag || drag.from || drag.carried) {
        return null;
      }
      const { dragKind } = this._modules.SvalPanelModel;
      return dragKind(this._nodes, drag.id) === "tab" ? drag.id : null;
    },

    /**
     * The drag state for a tab row dragged over this tree from another
     * window's (`draggedTab`), or null for a drag no window here started.
     * It lands as a dragged selection of one does ({@link
     * SvalPanelModel.dropIntent}): beside a row or into a group.
     *
     * @param {DragEvent} event A `dragover` carrying {@link NODE_DRAG_TYPE}.
     * @returns {object|null}
     */
    _arrivingDrag(event) {
      const id = event.dataTransfer.mozGetDataAt(NODE_DRAG_TYPE, 0);
      if (!id || !this._nodes[id]) {
        return null;
      }
      for (const win of Services.wm.getEnumerator("navigator:browser")) {
        if (win !== window && win.SvalPanel?.draggedTab?.() === id) {
          return {
            id,
            from: win,
            row: null,
            rows: [],
            carried: [id],
            dimmed: false,
            over: null,
            intent: null,
          };
        }
      }
      return null;
    },

    /**
     * The image a drag shows, for the two drags whose image is not the row
     * they start on: a page leaving its split looks like the tab row it
     * becomes, and a group shows its header alone with how many tabs it holds.
     * Built off screen, because a drag image is a snapshot of a laid-out node.
     *
     * @param {object} row The row or pane dragged.
     * @param {Element} element What the drag started on.
     * @returns {Element|null} the node to snapshot, or null for the row itself.
     */
    _dragImageFor(row, element) {
      const { descendantTabCount } = this._modules.SvalPanelModel;
      const { GROUP, TAB } = this._modules.SvalTree;
      const pane = row.kind === TAB && row.split && !row.panes;
      if (!pane && row.kind !== GROUP) {
        return null;
      }
      const image = element.cloneNode(true);
      image.removeAttribute("id");
      image.classList.add("sval-drag-image");
      if (pane) {
        image.classList.add("sval-row");
        image.dataset.kind = "tab";
      } else {
        const count = descendantTabCount(this._nodes, row.id);
        const note = document.createElement("span");
        note.className = "sval-drag-count";
        note.textContent = count === 1 ? "1 tab" : `${count} tabs`;
        image.append(note);
      }
      this._els.tree.append(image);
      return image;
    },

    /**
     * Works out what a drop at the pointer would do, and draws it.
     *
     * Calling `preventDefault` is what allows a drop at all, so a place the
     * node cannot go simply does not call it: the platform then shows its own
     * no-drop cursor and no drop event fires.
     *
     * @param {DragEvent} event `dragover` on the tree.
     */
    _onDragOver(event) {
      if (!event.dataTransfer?.types.includes(NODE_DRAG_TYPE)) {
        return;
      }
      this._drag ??= this._arrivingDrag(event);
      const drag = this._drag;
      if (!drag) {
        return;
      }
      this._autoScroll(event);
      const element = event.target.closest?.(".sval-row");
      const over = element ? this._rowFor(element.dataset.nodeId) : null;
      let intent = null;
      let halves = null;
      if (over) {
        const at = this._pointerOn(element, over, event);
        intent = this._modules.SvalPanelModel.dropIntent(
          this._nodes,
          drag.id,
          over,
          at,
          drag.carried
        );
        halves = this._dropHalves(drag.id, over, at, intent);
      } else {
        // The empty space under the last row is the end of the workspace. The
        // tree's own padding above the first row is not: nothing is drawn
        // there that a drop could be beside.
        const last = this._rowElementFor(this._rows.at(-1)?.id);
        if (
          event.target === this._els.tree &&
          (!last || event.clientY > last.getBoundingClientRect().bottom)
        ) {
          intent = { kind: "end" };
        }
      }
      const plan = intent
        ? this._dropPlan(drag.id, over, intent, drag.carried)
        : null;
      drag.over = over?.id ?? null;
      drag.intent =
        plan || intent?.kind === "refused" || halves ? intent : null;
      drag.halves = halves;
      drag.plan = plan;
      this._paintDragState();
      if (plan) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }
    },

    /**
     * The part of `element` a drop on it is aimed at, in client px: the row
     * past the indent of the groups it is in, and inside the card of the
     * innermost coloured group it is in. A row's box spans the panel's width
     * under every indent and the outer groups' colour, so the drop marks and
     * the middle's two zones are drawn and measured on this box alone, which
     * keeps a half under the pointer exactly where the pointer picks it.
     *
     * The indent ends where the row's padding, less one gap, says: the
     * column of the parent's twisty, which its rail runs down.
     *
     * @param {Element} element A row.
     * @returns {object} `{ left, right, top, bottom }`.
     */
    _dropTargetRect(element) {
      const style = window.getComputedStyle(element);
      const indent = Math.max(
        0,
        parseFloat(style.paddingInlineStart) - parseFloat(style.columnGap)
      );
      const rect = element.getBoundingClientRect();
      const box = {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      };
      if (style.direction === "rtl") {
        box.right -= indent;
      } else {
        box.left += indent;
      }
      const card = element
        .querySelector(":scope > .sval-row-surface[data-inner]")
        ?.getBoundingClientRect();
      if (card) {
        box.left = Math.max(box.left, card.left);
        box.right = Math.min(box.right, card.right);
        box.top = Math.max(box.top, card.top);
        box.bottom = Math.min(box.bottom, card.bottom);
      }
      return box;
    },

    /**
     * Where the pointer is on `element`, as {@link SvalPanelModel.dropIntent}
     * asks: from the drop target's inline start ({@link _dropTargetRect}) and
     * the row's top, the target's width and the row's height, and, on a
     * split's row, the gap between tiles it is nearest: the first tile whose
     * centre is past it, across the tray, or down it when the tiles stack.
     *
     * @param {Element} element The row under the pointer.
     * @param {object} over Its row.
     * @param {DragEvent} event
     * @returns {object} `{ x, y, w, h, slot, narrow }`.
     */
    _pointerOn(element, over, event) {
      const rect = element.getBoundingClientRect();
      const target = this._dropTargetRect(element);
      const width = target.right - target.left;
      const rtl = window.getComputedStyle(element).direction === "rtl";
      let slot = null;
      if (over.panes) {
        const tiles = [...element.querySelectorAll(".sval-split-pane")].map(
          tile => tile.getBoundingClientRect()
        );
        const stacked = tiles.length > 1 && tiles[1].top >= tiles[0].bottom;
        const before = tile => {
          if (stacked) {
            return event.clientY < tile.top + tile.height / 2;
          }
          const centre = tile.left + tile.width / 2;
          return rtl ? event.clientX > centre : event.clientX < centre;
        };
        const past = tiles.findIndex(before);
        slot = past < 0 ? tiles.length : past;
      }
      return {
        x: rtl ? target.right - event.clientX : event.clientX - target.left,
        y: event.clientY - rect.top,
        w: width,
        h: rect.height,
        slot,
        narrow: width < SPLIT_ZONE_MIN_ROW_PX,
      };
    },

    /**
     * Both drops of a tab's or split's middle, for its mark: New group in the
     * inline-start half and the split in the inline-end half, each asked of
     * `dropIntent` and `_dropPlan` at its own half, so the mark shows what
     * either half would write wherever in the middle the pointer is.
     *
     * @param {string} id The dragged node.
     * @param {object} over The row under the pointer.
     * @param {object} at {@link _pointerOn}'s answer.
     * @param {object} intent `dropIntent`'s answer at the pointer.
     * @returns {object|null} `{ active, group, split, splits }`: the half
     *   under the pointer ("group" or "split"), whether New group writes, the
     *   split half's kind (split, join, merge, full, or null with no split
     *   zone) and whether it writes. Null outside a middle, or when neither
     *   half writes anything.
     */
    _dropHalves(id, over, at, intent) {
      const middle = ["newGroup", "split", "join", "merge"];
      if (!middle.includes(intent.kind) && !intent.full) {
        return null;
      }
      const { dropIntent } = this._modules.SvalPanelModel;
      const nodes = this._nodes;
      const groupIntent = dropIntent(nodes, id, over, { ...at, x: 0 });
      const group = !!this._dropPlan(id, over, groupIntent);
      let split = null;
      let splits = false;
      if (!at.narrow) {
        const splitIntent = dropIntent(nodes, id, over, { ...at, x: at.w - 1 });
        split = splitIntent.full ? "full" : splitIntent.kind;
        splits = !!this._dropPlan(id, over, splitIntent);
      }
      if (!group && !splits) {
        return null;
      }
      return {
        active: intent.kind === "newGroup" ? "group" : "split",
        group,
        split,
        splits,
      };
    },

    /**
     * What a drop of `id` with `intent` writes, before it is let go: the same
     * targets a key or a menu entry writes, so a drop is never a second
     * implementation of one. Null for a drop that writes nothing it could.
     *
     * @param {string} id The dragged node.
     * @param {object|null} over The row under the pointer.
     * @param {object} intent {@link SvalPanelModel.dropIntent}'s answer.
     * @param {string[]|null} [carried] A dragged selection's nodes.
     * @returns {object|null} `{ noop }`, `{ move }`, `{ merge }` or `{ ops }`.
     */
    _dropPlan(id, over, intent, carried = null) {
      const {
        dropTarget,
        dropTargets,
        joinSplitOps,
        mergeSplitsOps,
        mergeTarget,
        reorderPaneTarget,
        splitTogetherOps,
      } = this._modules.SvalPanelModel;
      const nodes = this._nodes;
      const overId = over?.split ?? over?.id ?? null;
      if (carried && intent.kind !== "noop" && intent.kind !== "refused") {
        const moves = dropTargets(
          nodes,
          carried,
          overId,
          intent.kind,
          this._currentWorkspaceId
        );
        return moves && { move: moves };
      }
      switch (intent.kind) {
        case "noop":
          return { noop: true };
        case "newGroup": {
          const merge = mergeTarget(nodes, id, overId);
          return merge && { merge };
        }
        case "split": {
          const ops = splitTogetherOps(nodes, overId, id, () =>
            crypto.randomUUID()
          );
          return ops && { ops, flash: [overId, id] };
        }
        case "join": {
          const ops = joinSplitOps(nodes, overId, id);
          return ops && { ops, flash: [id] };
        }
        case "merge": {
          const ops = mergeSplitsOps(nodes, overId, id);
          return ops && { ops, flash: [overId] };
        }
        case "reorder": {
          const move = reorderPaneTarget(nodes, id, intent.slot);
          return move && { move };
        }
        case "refused":
          return null;
        default: {
          const move = dropTarget(
            nodes,
            id,
            overId,
            intent.kind,
            this._currentWorkspaceId
          );
          return move && { move };
        }
      }
    },

    /**
     * Scrolls the tree while a drag rests near its top or bottom edge, so a
     * long workspace can be dragged across without letting go.
     *
     * @param {DragEvent} event
     */
    _autoScroll(event) {
      const tree = this._els.tree;
      const rect = tree.getBoundingClientRect();
      const edge = Math.min(AUTOSCROLL_EDGE_PX, rect.height / 4);
      if (event.clientY < rect.top + edge) {
        tree.scrollTop -= AUTOSCROLL_STEP_PX;
      } else if (event.clientY > rect.bottom - edge) {
        tree.scrollTop += AUTOSCROLL_STEP_PX;
      }
    },

    /**
     * Clears the drop marks once the pointer has left the tree. A `dragleave`
     * also fires moving from one row to the next, and `relatedTarget` is what
     * tells the two apart.
     *
     * @param {DragEvent} event `dragleave` on the tree.
     */
    _onDragLeave(event) {
      const drag = this._drag;
      if (!drag || this._els.tree.contains(event.relatedTarget)) {
        return;
      }
      drag.over = null;
      drag.intent = null;
      drag.plan = null;
      // No `dragend` reaches this window for a drag another one started.
      if (drag.from) {
        this._drag = null;
      }
      this._paintDragState();
    },

    /** @param {DragEvent} event `drop` on the tree. */
    _onDrop(event) {
      const drag = this._drag;
      if (!drag?.plan || !event.dataTransfer?.types.includes(NODE_DRAG_TYPE)) {
        return;
      }
      event.preventDefault();
      const { plan, id } = drag;
      const into = drag.intent?.kind === "into" ? drag.over : null;
      this._endDrag();
      if (drag.from) {
        this._guard("adopt", () => this._adoptDropped(drag.from, plan.move[0]));
      } else if (plan.merge) {
        this._guard("merge", () => this._merge(plan.merge));
      } else if (plan.ops) {
        this._guard("drop", () => this._writeDrop(id, plan));
      } else if (plan.move) {
        this._guard("move", async () => {
          const moved = await this._applyMove(plan.move, { flash: !into });
          if (moved && into) {
            this._flashRow(into, "sval-row-landed-into");
          }
        });
      }
    },

    /**
     * Moves the tab dropped from window `from` into this window at `move`
     * (`SvalTabs`' `adoptTab`).
     *
     * @param {Window} from The window the drag started in.
     * @param {object} move `{ id, newParent, before, after }`.
     */
    _adoptDropped(from, move) {
      const tab = from.SvalPanel?.observer?.tabFor(move.id);
      if (tab && this._observer) {
        this._observer.adoptTab(tab, move);
      }
    },

    /**
     * Writes a drop that combines into a split, as one batch, then flashes
     * what arrived: both tiles of a new split, the joined tile, a merge's
     * incoming tiles.
     *
     * @param {string} id The dropped node.
     * @param {object} plan `_dropPlan`'s `{ ops, flash }`.
     */
    async _writeDrop(id, plan) {
      try {
        await this._engine.mutate({
          kind: "batch",
          ops: plan.ops,
          now: this._modules.SvalClock.now(),
        });
      } catch (err) {
        this._logRefusal(id, err);
        await this.refresh();
        return;
      }
      await this.refresh();
      const { splitPanes } = this._modules.SvalPanelModel;
      const { SPLIT } = this._modules.SvalTree;
      const tiles = new Set();
      for (const flashed of plan.flash) {
        if (this._nodes[flashed]?.kind === SPLIT) {
          for (const run of splitPanes(this._nodes, flashed)) {
            run.forEach(tab => tiles.add(tab));
          }
        } else {
          tiles.add(flashed);
        }
      }
      for (const tile of tiles) {
        this._flashRow(tile, "sval-row-landed-split");
      }
      this._focusRow(id);
      this._publishSoon();
    },

    /**
     * Ends a drag, dropped or not. Escape, a drop outside the tree and a drop
     * the tree refused all arrive here through `dragend`, with nothing written.
     */
    _endDrag() {
      const drag = this._drag;
      if (!drag) {
        return;
      }
      this._drag = null;
      this._paintDragState();
      this._pins?.dragEnded();
      if (!drag.from) {
        for (const win of Services.wm.getEnumerator("navigator:browser")) {
          win.SvalPanel?.dragEndedIn?.(window);
        }
      }
    },

    /**
     * Ends the drag this tree holds from window `from`, once that window's
     * drag has ended, which can happen over this tree: the drag's `dragend`
     * goes to the element it started on, in `from`.
     *
     * @param {Window} from
     */
    dragEndedIn(from) {
      if (this._drag?.from === from) {
        this._endDrag();
      }
    },

    /**
     * Draws the drag in progress, or a merge waiting on its name, onto the
     * rows: the dragged row and everything it carries dimmed, then the mark
     * of what a drop would do: a line for a place in the list, an outline on
     * a collapsed group it goes into, a middle's two halves over the row, and
     * a bar between tiles for a page reordered in its split.
     *
     * Redrawn wholesale from `_drag` each time, and from `render`, which
     * replaces every row, so no rule here depends on what was drawn before.
     */
    _paintDragState() {
      const tree = this._els?.tree;
      if (!tree) {
        return;
      }
      for (const element of tree.querySelectorAll(
        ".sval-row-dragging, .sval-drop-into, .sval-drop-merge"
      )) {
        element.classList.remove(
          "sval-row-dragging",
          "sval-drop-into",
          "sval-drop-merge"
        );
      }
      for (const outline of tree.querySelectorAll(".sval-drop-outline")) {
        outline.remove();
      }
      const { dropLine, dropMark, dropBar } = this._els;
      dropLine.hidden = true;
      dropMark.hidden = true;
      dropBar.hidden = true;
      let said = "";

      const merge = this._pendingMerge;
      if (merge) {
        for (const id of merge.members ?? [merge.id, merge.target]) {
          this._outlineDropTarget(this._rowElementFor(id), "sval-drop-merge");
        }
        this._say(said);
        return;
      }

      const drag = this._drag;
      for (const dragged of drag?.dimmed ? drag.rows : []) {
        // A pane is dimmed on its own.
        this._rowElementFor(dragged)?.classList.add("sval-row-dragging");
        const start = this._rows.findIndex(row => row.id === dragged);
        for (let i = start; start >= 0 && i < this._rows.length; i++) {
          if (i > start && this._rows[i].depth <= this._rows[start].depth) {
            break;
          }
          this._rowElementFor(this._rows[i].id)?.classList.add(
            "sval-row-dragging"
          );
        }
      }
      const kind = drag?.intent?.kind;
      const overElement = this._rowElementFor(drag?.over);
      const overRow = this._rowFor(drag?.over);
      switch (kind) {
        case "into":
          this._outlineDropTarget(overElement, "sval-drop-into");
          break;
        case "newGroup":
        case "split":
        case "join":
        case "merge":
        case "refused":
          if (drag.halves) {
            said = this._showDropMark(overElement, drag.halves);
          }
          break;
        case "reorder":
          this._showDropBar(overElement, drag.intent.slot);
          break;
        case "end": {
          const last = this._rowElementFor(this._rows.at(-1)?.id);
          this._showDropLine(last ? last.offsetTop + last.offsetHeight : 0, 0);
          break;
        }
        case "before":
        case "after":
        case "firstChild": {
          if (!overElement || !overRow) {
            break;
          }
          const top = overElement.offsetTop;
          const bottom = top + overElement.offsetHeight;
          this._showDropLine(
            kind === "before" ? top : bottom,
            overRow.depth + (kind === "firstChild" ? 1 : 0)
          );
          break;
        }
        default:
          break;
      }
      this._say(said);
    },

    /**
     * Marks `element` with `state` and outlines its drop target
     * ({@link _dropTargetRect}): a span in the row, under its content and
     * over its coloured cards, so the outline is drawn on the target alone
     * and the row's text stays on top.
     *
     * @param {Element|null} element The row.
     * @param {string} state `sval-drop-into` for a group the drop goes into,
     *   or `sval-drop-merge` for a row of a new group waiting on its name.
     */
    _outlineDropTarget(element, state) {
      if (!element) {
        return;
      }
      element.classList.add(state);
      const row = element.getBoundingClientRect();
      const target = this._dropTargetRect(element);
      const outline = this._html("span");
      outline.className = "sval-drop-outline";
      outline.setAttribute("aria-hidden", "true");
      this._inkDropMark(outline, element);
      outline.style.left = `${target.left - row.left}px`;
      outline.style.top = `${target.top - row.top}px`;
      outline.style.width = `${target.right - target.left}px`;
      outline.style.height = `${target.bottom - target.top}px`;
      element.append(outline);
    },

    /**
     * Draws a middle drop's mark over `element`: a cover in the panel's
     * colour that fades the row, and on it the two halves, New group and the
     * split, the one under the pointer filled. A half that would write
     * nothing is drawn faint. The mark covers the row's drop target
     * ({@link _dropTargetRect}), whose halves are the zones `_pointerOn`
     * measures.
     *
     * @param {Element|null} element The row.
     * @param {object} halves {@link _dropHalves}'s answer.
     * @returns {string} what the half under the pointer says, when its drop
     *   writes or a full split is why it can't; else empty.
     */
    _showDropMark(element, halves) {
      if (!element) {
        return "";
      }
      const mark = this._els.dropMark;
      const [groupHalf, splitHalf] = mark.children;
      const splitLabel = halves.split ? DROP_LABELS[halves.split] : "";
      groupHalf.querySelector(".sval-drop-label").textContent =
        DROP_LABELS.newGroup;
      splitHalf.querySelector(".sval-drop-label").textContent = splitLabel;
      splitHalf.hidden = !halves.split;
      groupHalf.dataset.kind = "newGroup";
      splitHalf.dataset.kind = halves.split ?? "";
      groupHalf.toggleAttribute("data-active", halves.active === "group");
      splitHalf.toggleAttribute("data-active", halves.active === "split");
      groupHalf.toggleAttribute("data-faint", !halves.group);
      splitHalf.toggleAttribute("data-faint", !halves.splits);
      const onGroup = halves.active === "group";
      mark.dataset.kind = onGroup ? "newGroup" : halves.split;
      this._inkDropMark(mark, element);
      const tree = this._els.tree;
      const origin = tree.getBoundingClientRect();
      const target = this._dropTargetRect(element);
      mark.style.top = `${target.top - origin.top + tree.scrollTop}px`;
      mark.style.left = `${target.left - origin.left}px`;
      mark.style.width = `${target.right - target.left}px`;
      mark.style.height = `${target.bottom - target.top}px`;
      mark.hidden = false;
      const writes = onGroup ? halves.group : halves.splits;
      if (writes || (!onGroup && halves.split === "full")) {
        return onGroup ? DROP_LABELS.newGroup : splitLabel;
      }
      return "";
    },

    /**
     * Draws the bar in the gap `slot` of a split's tray, where an Alt-dragged
     * page would land.
     *
     * @param {Element|null} element The split's row.
     * @param {number} slot 0 to the number of tiles.
     */
    _showDropBar(element, slot) {
      const tiles = [...(element?.querySelectorAll(".sval-split-pane") ?? [])];
      if (!tiles.length) {
        return;
      }
      const treeRect = this._els.tree.getBoundingClientRect();
      const scroll = this._els.tree.scrollTop;
      const first = tiles[0].getBoundingClientRect();
      const stacked =
        tiles.length > 1 &&
        tiles[1].getBoundingClientRect().top >= first.bottom;
      const before = tiles[slot - 1]?.getBoundingClientRect();
      const after = tiles[slot]?.getBoundingClientRect();
      const bar = this._els.dropBar;
      this._inkDropMark(bar, element);
      bar.dataset.stacked = String(stacked);
      // The gap's middle, or just past the end tile for the tray's two ends.
      const gap = (end, start) => {
        if (before && after) {
          return (before[end] + after[start]) / 2;
        }
        return before ? before[end] + 1 : after[start] - 1;
      };
      if (stacked) {
        const y = gap("bottom", "top");
        bar.style.top = `${y - treeRect.top + scroll}px`;
        bar.style.left = `${first.left - treeRect.left - 2}px`;
        bar.style.width = `${first.width + 4}px`;
        bar.style.height = "";
      } else {
        const x = gap("right", "left");
        bar.style.left = `${x - treeRect.left}px`;
        bar.style.top = `${first.top - treeRect.top + scroll - 2}px`;
        bar.style.height = `${first.height + 4}px`;
        bar.style.width = "";
      }
      bar.hidden = false;
    },

    /**
     * Draws `mark` in the colour of the row it is for: the innermost coloured
     * group's ink inside one, its card's in a group nested in another colour,
     * and the accent elsewhere.
     *
     * @param {Element} mark The drop mark, outline or bar.
     * @param {Element} element The row.
     */
    _inkDropMark(mark, element) {
      const card = element.querySelector(
        ":scope > .sval-row-surface[data-inner]"
      );
      let ink = "";
      if (card) {
        ink = window.getComputedStyle(card).getPropertyValue("--sval-s-ink");
      } else if (element.hasAttribute("data-sval-fill")) {
        ink = window.getComputedStyle(element).getPropertyValue("--sval-ink");
      }
      ink = ink.trim();
      if (ink) {
        mark.style.setProperty("--sval-drop-c", ink);
      } else {
        mark.style.removeProperty("--sval-drop-c");
      }
    },

    /**
     * Says what a drop would do through the live region, once per change.
     *
     * @param {string} text
     */
    _say(text) {
      const region = this._els.dropAnnounce;
      if (region.textContent !== text) {
        region.textContent = text;
      }
    },

    /**
     * @param {number} y Where the line goes, in the tree's own coordinates.
     * @param {number} depth The depth the node will land at, which is what the
     *   line is indented to.
     */
    _showDropLine(y, depth) {
      const line = this._els.dropLine;
      line.style.top = `${y}px`;
      line.style.setProperty("--sval-drop-depth", String(depth));
      line.hidden = false;
    },

    /**
     * Flashes a row that has just landed or been made, so the eye can find it:
     * a drop or a merge can put it some distance from where it was picked up.
     * The animation is CSS's and is not run under `prefers-reduced-motion`.
     *
     * @param {string} id A node id.
     * @param {string} [kind] The animation's class: `sval-row-landed` for a
     *   move, `sval-row-new` for a group just made.
     */
    _flashRow(id, kind = "sval-row-landed") {
      const element = this._rowElementFor(id);
      if (!element) {
        return;
      }
      element.classList.add(kind);
      element.addEventListener(
        "animationend",
        () => element.classList.remove(kind),
        { once: true }
      );
    },
  });
}
