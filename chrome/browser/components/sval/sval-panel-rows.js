/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Drawing the workspace panel's tree: a row for each visible node, a split's
 * row and its panes, tab icons, and the words a row is read and shown by. A row
 * is rebuilt only when what it draws has changed.
 *
 * `SvalWindow` loads this as a classic script after `sval-panel.js`; it adds
 * its methods to `SvalPanel`, whose state and helpers it shares.
 */

/* import-globals-from sval-panel.js */

{
  /**
   * How long a tab's row takes to fade in as the tab opens and out as it
   * closes. Matches the `sval-row-opening` and `sval-row-leaving` animations in
   * `sval-panel.css`, and is how long a closed row is kept for its fade.
   */
  const ROW_FADE_MS = 150;

  /**
   * The page a pane waiting for a pick shows: Firefox's split-view picker
   * (`opentabs-splitview.mjs`, split-view spec §5.1).
   */
  const PICKER_URL = "about:opentabs";

  /**
   * What a row says of a tab Sval will not open on this device
   * (`SvalRestore.opensHere`), in its tooltip and its description.
   */
  const UNOPENABLE_TEXT = "Can't open on this device";

  Object.assign(SvalPanel, {
    /**
     * What the last render drew from, so the next one can tell a tab that
     * opened or closed from one that was only scrolled, folded or redrawn:
     * the workspace shown and the id of every tab node in the document.
     */
    _drawnFrom: null,

    /** When each tab's row started fading in, by node id. */
    _openingRows: new Map(),

    /**
     * Rows of tabs that have closed, kept while they fade out: each with its
     * element, the id of the drawn row it follows (null for the top), and when
     * it started.
     */
    _leavingRows: [],

    /**
     * Each drawn row's element and the {@link _rowSignature} it was built from,
     * by node id.
     */
    _rowEls: new Map(),

    /**
     * Draws every row the collapse state says is visible.
     *
     * A row is rebuilt only when what it draws has changed ({@link _rowSignature})
     * and moved only when its place has, so a title changing in one tab touches
     * one row, and every other row keeps its element, its focus and any animation
     * it is part way through. Spec §10.4 wants this list virtualised, so
     * `aria-setsize` and `aria-posinset` are computed from the document rather
     * than from the rows drawn, and stay the full set size when only part of the
     * set is on screen.
     */
    render() {
      this._withTabLookups(() => this._drawRows());
      // A tab that closes or leaves can take the media the footer shows.
      this._paintMediaBar();
    },

    /**
     * The children of each node of `_nodes` (`SvalTree.childrenByParent`)
     * while a {@link _withTabLookups} pass runs, built on its first use in the
     * pass and dropped when the pass ends. `nodes` is the map it indexes,
     * and it is built again for any other `_nodes`.
     *
     * @type {?{nodes: ?object, byParent: ?Map<string|null, string[]>}}
     */
    _treeIndex: null,

    /**
     * Runs `fn` with the observer answering which tab each node has from one
     * read of the tabs (`SvalTabObserver.withTabLookups`), and the tree's
     * children from one index of it ({@link _childrenByParent}), for a pass
     * that asks them of many rows.
     *
     * @param {Function} fn Synchronous.
     */
    _withTabLookups(fn) {
      const outer = this._treeIndex;
      this._treeIndex ??= { nodes: null, byParent: null };
      try {
        if (this._observer) {
          this._observer.withTabLookups(fn);
        } else {
          fn();
        }
      } finally {
        if (!outer) {
          this._treeIndex = null;
        }
      }
    },

    /**
     * `SvalTree.childrenByParent(this._nodes)`, built once per
     * {@link _withTabLookups} pass and afresh outside one.
     *
     * @returns {Map<string|null, string[]>}
     */
    _childrenByParent() {
      const { childrenByParent } = this._modules.SvalTree;
      const index = this._treeIndex;
      if (!index) {
        return childrenByParent(this._nodes);
      }
      if (index.nodes !== this._nodes) {
        index.nodes = this._nodes;
        index.byParent = childrenByParent(this._nodes);
      }
      return index.byParent;
    },

    /**
     * The body of {@link render}.
     */
    _drawRows() {
      const { rows } = this._modules.SvalPanelModel;
      const tree = this._els.tree;

      this._renderSwitcher();
      const drawn = this._rows;
      this._rows = rows(this._nodes, {
        isCollapsed: id => this._settings.isCollapsed(id),
        root: this._workspace.id,
        selected: this.selection.viewedId(),
        hidden: this._hiddenTabIds(),
        transparent: this.undo.transparentIds(),
        pendingName: id => this._observer?.pendingName(id),
      });

      this._blockEnds = this._modules.SvalPanelModel.blockEnds(this._rows);
      this.selection.prune();

      const hadFocus = tree.contains(document.activeElement);
      const drawsId = id => !!this._rowFor(id);
      const selected = this.selection.selectedId();
      if (!hadFocus && drawsId(selected)) {
        // The tree is entered on the tab being viewed (the ARIA tree pattern),
        // so Tab into the panel after Ctrl+Tab lands where the user is.
        this._focusedId = selected;
      } else if (this._focusedId && !drawsId(this._focusedId)) {
        // A focused row that leaves (closed, moved away, or gone in a peer's
        // change) hands focus to the row that takes its place, so a keyboard user
        // is not sent back to the top of the tree.
        const index = this._modules.SvalPanelModel.rowIndexIn(
          drawn,
          this._focusedId
        );
        this._focusedId =
          index >= 0
            ? (this._rows[Math.min(index, this._rows.length - 1)]?.id ?? null)
            : null;
      }
      if (!this._focusedId && this._rows.length) {
        this._focusedId = this._rows[0].id;
      }
      // A split's row is entered on one of its panes.
      this._focusedId = this._focusIdFor(this._focusedId);

      const now = this._noteRowMotion(drawn);
      const drawnEls = new Map();
      const wanted = [{ element: this._els.topEdge }];
      const wantLeaving = after => {
        for (const leaving of this._leavingRows) {
          if (leaving.after === after) {
            wanted.push({ element: leaving.element, since: leaving.since });
          }
        }
      };
      wantLeaving(null);
      for (const row of this._rows) {
        const signature = this._rowSignature(row);
        const kept = this._rowEls.get(row.id);
        let element;
        if (kept?.signature === signature) {
          element = kept.element;
          if (row.panes) {
            this._paintPanesText(row, element);
          } else {
            if (kept.name !== row.name || kept.url !== row.url) {
              this._paintRowText(element.querySelector(".sval-row-name"), row);
            }
            const icon = element.querySelector(".sval-row-icon");
            if (icon && kept.url !== row.url) {
              this.fillTabIcon(icon, row.id, row.url);
            }
          }
        } else {
          element = this._rowElement(row);
        }
        drawnEls.set(row.id, {
          element,
          signature,
          name: row.name,
          url: row.url,
        });
        for (const pane of row.panes ?? []) {
          drawnEls.set(pane.id, {
            element: element.querySelector(
              `.sval-split-pane[data-node-id="${CSS.escape(pane.id)}"]`
            ),
            name: pane.name,
            url: pane.url,
          });
        }
        this._paintRowState(element, row);
        const since = this._openingRows.get(row.id);
        element.classList.toggle("sval-row-opening", since !== undefined);
        if (since === undefined) {
          element.style.removeProperty("animation-delay");
        }
        wanted.push({ element, since });
        wantLeaving(row.id);
      }
      wanted.push(
        { element: this._els.dropLine },
        { element: this._els.dropMark },
        { element: this._els.dropBar },
        { element: this._els.bottomEdge }
      );
      this._rowEls = drawnEls;

      // An element is inserted only where it is not already in place. Inserting
      // restarts its CSS animation, so one in the middle of a fade is resumed
      // where it had reached by a negative delay.
      const keep = new Set(wanted.map(({ element }) => element));
      let next = tree.firstChild;
      for (const { element, since } of wanted) {
        while (next && !keep.has(next)) {
          const gone = next;
          next = next.nextSibling;
          gone.remove();
        }
        if (element === next) {
          next = next.nextSibling;
          continue;
        }
        if (since !== undefined) {
          element.style.animationDelay = `${since - now}ms`;
        }
        tree.insertBefore(element, next);
      }
      while (next) {
        const gone = next;
        next = next.nextSibling;
        gone.remove();
      }
      this._leavingRows = this._leavingRows.filter(
        leaving => leaving.element.isConnected
      );
      this._paintDragState();
      const onRow = document.activeElement?.closest?.(
        ".sval-row[data-node-id]"
      );
      if (hadFocus && !(onRow && tree.contains(onRow))) {
        // A focused row that was rebuilt or left took the focus with it, to the
        // document or to a row fading out. Putting it on the row that holds the
        // roving focus is what keeps keyboard-only use from falling out of the
        // panel on every mutation.
        this._rowElementFor(this._focusedId)?.focus();
      }
      // The pins that show follow the workspace and its document.
      this._pins?.render();
      this.drawIndicator();
    },

    /**
     * Everything {@link _rowElement} draws a row from but its name and address,
     * as one string, so a row whose string has not changed keeps its element.
     * State that changes
     * without the document changing (selection, the roving focus, a tab
     * loading, who controls an agent's tab) and the row's place among its
     * siblings are left out and painted on every row by {@link _paintRowState}
     * instead.
     *
     * @param {object} row A row from `SvalPanelModel.rows`.
     * @returns {string}
     */
    _rowSignature(row) {
      const ends = this._blockEnds?.get(row.id);
      // A row's name and address change on their own as its page loads and
      // retitles itself, which an open mail or chat tab does all day, so they
      // are painted into the kept row ({@link _paintRowText}). Its place among
      // its siblings changes for every sibling opened or closed, so that is
      // painted too ({@link _paintRowState}); rebuilding for it would rebuild
      // every row of a workspace on each new tab.
      // A split's panes are painted the same way, all but whether one is
      // waiting for a pick, which is drawn differently.
      const panes = row.panes?.map(pane => [pane.id, pane.url === PICKER_URL]);
      return JSON.stringify([
        {
          ...row,
          name: row.panes ? row.name : null,
          url: null,
          setsize: null,
          posinset: null,
          panes,
        },
        ends ? [...ends].sort() : null,
        !!this._agentLabel,
        row.tint ? this._blockSurfaceKey() : null,
      ]);
    },

    /**
     * Writes a row's name, and its address in the tooltip.
     *
     * @param {Element} name The row's `.sval-row-name`.
     * @param {object} row A row from `SvalPanelModel.rows`.
     */
    _paintRowText(name, row) {
      name.textContent = row.name || this._untitled(row.kind, row.url);
      if (row.url) {
        const why =
          row.kind === this._modules.SvalTree.TAB &&
          !this._observer?.isLoaded(row.id) &&
          !this._opensHere(row.id)
            ? `\n${UNOPENABLE_TEXT}`
            : "";
        name.setAttribute("title", `${row.name}\n${row.url}${why}`);
      } else {
        name.removeAttribute("title");
      }
    },

    /**
     * Paints the state of a row that changes without the row itself changing:
     * its place among its siblings, and what changes without the document
     * changing at all.
     *
     * @param {Element} el A `.sval-row`.
     * @param {object} row A row from `SvalPanelModel.rows`.
     */
    _paintRowState(el, row) {
      el.setAttribute("aria-setsize", String(row.setsize));
      el.setAttribute("aria-posinset", String(row.posinset));
      if (row.panes) {
        this._paintSplitState(el, row);
        return;
      }
      el.setAttribute(
        "aria-selected",
        this.selection.has(row.id) ? "true" : "false"
      );
      el.setAttribute("tabindex", row.id === this._focusedId ? "0" : "-1");
      this._paintRowSound(el, row);
      if (row.kind === this._modules.SvalTree.TAB) {
        this._setTabLoaded(el, row.id, row);
      } else {
        this._describeRow(el, row);
      }
    },

    /**
     * What a row's media button offers (`SvalFirefox.mediaActionOf`): for its
     * tab, or for a collapsed group, whose tabs are out of sight, for every
     * tab in it.
     *
     * @param {object} row A row from `SvalPanelModel.rows`.
     * @returns {?string}
     */
    _rowMedia(row) {
      const { TAB, GROUP } = this._modules.SvalTree;
      if (row.kind !== TAB && !(row.kind === GROUP && !row.expanded)) {
        return null;
      }
      return this._modules.SvalFirefox.mediaActionOf(this._tabsUnder(row));
    },

    /**
     * The label of the media button and its menu entries for `action`.
     *
     * @param {?string} action As `SvalFirefox.mediaActionOf` answers.
     * @returns {string}
     */
    _mediaLabel(action) {
      return (
        {
          pause: "Pause Media",
          mute: "Mute",
          play: "Play Media",
          unmute: "Unmute",
        }[action] ?? "Pause Media"
      );
    },

    /**
     * The media button's tooltip for `tabs`: what a press does, named for
     * what it acts on (`SvalFirefox.mediaTargetsOf`), on one line for one
     * tab and one line each, three at most, for several.
     *
     * @param {object[]} tabs Firefox tabs.
     * @returns {string}
     */
    _mediaTooltip(tabs) {
      const { SvalFirefox } = this._modules;
      const { action, targets } = SvalFirefox.mediaTargetsOf(tabs);
      const names = targets.map(({ tab }) => SvalFirefox.mediaNameOf(tab));
      if (names.length === 1) {
        const verb = {
          pause: "Pause",
          play: "Play",
          mute: "Mute",
          unmute: "Unmute",
        }[action];
        return `${verb} ${names[0]}`;
      }
      const shown = names.slice(0, 3);
      if (names.length > shown.length) {
        shown.push(`and ${names.length - shown.length} more`);
      }
      return [this._mediaLabel(action), ...shown].join("\n");
    },

    /**
     * Shows or hides a row's media button ({@link _rowMedia}).
     *
     * @param {Element} el A `.sval-row`.
     * @param {object} row A row from `SvalPanelModel.rows`.
     */
    _paintRowSound(el, row) {
      const button = el.querySelector(":scope > .sval-row-audio");
      if (!button) {
        return;
      }
      const action = this._rowMedia(row);
      if (action) {
        el.setAttribute("data-media", action);
        button.title = this._mediaTooltip(this._tabsUnder(row));
      } else {
        el.removeAttribute("data-media");
        button.removeAttribute("title");
      }
    },

    /**
     * The tab the footer's media controls act on
     * (`SvalFirefox.nowPlayingOf`), from every tab of this window, pins' and
     * hidden workspaces' included.
     *
     * @returns {?object}
     */
    _nowPlaying() {
      return this._modules.SvalFirefox.nowPlayingOf(
        Array.from(window.gBrowser.tabs)
      );
    },

    /**
     * Draws the footer's media controls for {@link _nowPlaying}, or hides
     * them while no tab has media.
     */
    _paintMediaBar() {
      const bar = this._els?.mediaBar;
      if (!bar) {
        return;
      }
      const { SvalFirefox } = this._modules;
      const tab = this._nowPlaying();
      bar.hidden = !tab;
      if (!tab) {
        return;
      }
      const [previous, back, toggle, forward, next] = bar.children;
      const action = SvalFirefox.mediaActionOf([tab]);
      bar.setAttribute("data-media", action);
      toggle.title = this._mediaTooltip([tab]);
      toggle.setAttribute("aria-label", action === "pause" ? "Pause" : "Play");
      for (const [button, label] of [
        [previous, "Previous Track"],
        [back, "Back 10 Seconds"],
        [forward, "Forward 10 Seconds"],
        [next, "Next Track"],
      ]) {
        button.title = label;
        button.setAttribute("aria-label", label);
      }
      // A page that has no tracks has no use for their buttons.
      previous.hidden = !SvalFirefox.hasTrack(tab, "previous");
      next.hidden = !SvalFirefox.hasTrack(tab, "next");
    },

    /**
     * Runs one of the footer's media controls on {@link _nowPlaying}.
     *
     * @param {string} command One of the footer's media commands.
     */
    _runMediaBar(command) {
      const tab = this._nowPlaying();
      if (!tab) {
        return;
      }
      const { SvalFirefox } = this._modules;
      switch (command) {
        case "mediaToggle":
          SvalFirefox.actOnMedia([tab]);
          break;
        case "mediaPrevious":
          SvalFirefox.track(tab, "previous");
          break;
        case "mediaNext":
          SvalFirefox.track(tab, "next");
          break;
        default:
          SvalFirefox.seek(tab, command === "mediaBack" ? "back" : "forward");
      }
    },

    /**
     * Paints every drawn row's media button, and the switcher's, after a
     * tab started or stopped playing sound or was muted or unmuted.
     */
    _paintSound() {
      this._withTabLookups(() => {
        for (const row of this._rows ?? []) {
          const el = this._rowElementFor(row.id);
          if (el) {
            this._paintRowSound(el, row);
          }
        }
        this._paintSwitcherSound();
        this._paintMediaBar();
      });
    },

    /**
     * Says in a row's `aria-description` what the row shows only to the eye.
     * A tab: that it is not loaded here (the muted row), and whose it is in an
     * agent's workspace (the robot). A group: that it is one, which its folder
     * or colour block shows, its colour, how many tabs it holds while collapsed
     * (the count), and that the tab drawn under it while collapsed is only the
     * selection.
     *
     * @param {Element} el A `.sval-row`.
     * @param {object} row A row from `SvalPanelModel.rows`.
     */
    _describeRow(el, row) {
      const { TAB, GROUP } = this._modules.SvalTree;
      const parts = [];
      if (row.kind === TAB) {
        if (el.hasAttribute("data-unopenable")) {
          parts.push(UNOPENABLE_TEXT);
        } else if (el.getAttribute("data-loaded") === "false") {
          parts.push("not loaded");
        }
        if (this._agentLabel) {
          parts.push(
            this._modules.SvalAgentControl.isWorkspaceHeld(this._workspace.id)
              ? "you control this Workspace"
              : `controlled by ${this._agentLabel}`
          );
        }
      } else if (row.kind === GROUP) {
        parts.push("group");
        if (row.color) {
          parts.push(
            this._modules.SvalColor.colorName(row.color).toLowerCase()
          );
        }
        if (row.hasChildren && !row.expanded) {
          parts.push(row.count === 1 ? "1 tab" : `${row.count} tabs`);
        }
        if (row.showsSelection) {
          parts.push("showing only the selected tab");
        }
      }
      if (parts.length) {
        el.setAttribute("aria-description", parts.join(", "));
      } else {
        el.removeAttribute("aria-description");
      }
    },

    /**
     * Works out which tabs' rows fade in and which fade out in the render about
     * to happen, by comparing the document with the one the last render drew.
     *
     * Only within one workspace: a switch or the first render draws every row
     * at once, and fading each in would read as every tab having just opened.
     * Never under `prefers-reduced-motion`, where a closed row goes at once.
     * A row kept for its fade is out of the tree's semantics (no node id, no
     * focus, inert and hidden from assistive technology), so it is never
     * mistaken for a tab that is still open, and a close takes effect the
     * moment it happens whatever the eye is shown.
     *
     * @param {object[]} drawn The rows the last render drew.
     * @returns {number} the time this render is drawn at, on `performance.now`.
     */
    _noteRowMotion(drawn) {
      const now = performance.now();
      const { TAB } = this._modules.SvalTree;
      const tabs = new Set(
        Object.keys(this._nodes).filter(id => this._nodes[id].kind === TAB)
      );
      const before = this._drawnFrom;
      this._drawnFrom = { workspace: this._workspace.id, tabs };

      for (const [id, since] of this._openingRows) {
        if (now - since >= ROW_FADE_MS) {
          this._openingRows.delete(id);
        }
      }
      if (
        before?.workspace !== this._workspace.id ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        return now;
      }

      for (const row of this._rows) {
        if (row.kind === TAB && !before.tabs.has(row.id)) {
          this._openingRows.set(row.id, now);
        }
      }

      const stillDrawn = new Set(this._rows.map(row => row.id));
      let after = null;
      for (const row of drawn) {
        if (stillDrawn.has(row.id)) {
          after = row.id;
          continue;
        }
        const element = this._rowElementFor(row.id);
        if (row.kind !== TAB || tabs.has(row.id) || !element) {
          continue;
        }
        element.removeAttribute("data-node-id");
        element.removeAttribute("role");
        element.removeAttribute("tabindex");
        element.removeAttribute("draggable");
        element.setAttribute("aria-hidden", "true");
        element.inert = true;
        element.classList.remove("sval-row-opening");
        element.classList.add("sval-row-leaving");
        const leaving = { element, after, since: now };
        this._leavingRows.push(leaving);
        setTimeout(() => {
          element.remove();
          this._leavingRows = this._leavingRows.filter(l => l !== leaving);
        }, ROW_FADE_MS);
      }
      return now;
    },

    /**
     * One row.
     *
     * The row itself is the `treeitem` and holds the tree's focus through a
     * roving `tabindex`, so `document.activeElement` is the row the user is on
     * and the focus ring is the platform's own rather than something drawn here.
     * The controls inside a row are `tabindex="-1"` and each has an entry in the
     * keyboard map: spec §10.5 forbids a mouse-only action, while three tab
     * stops per row would make the tree unusable by keyboard for the opposite
     * reason.
     *
     * @param {object} row A row from `SvalPanelModel.rows`.
     * @returns {Element}
     */
    _rowElement(row) {
      if (row.panes) {
        return this._splitRowElement(row);
      }
      const el = this._html("div");
      el.className = "sval-row";
      el.id = `sval-row-${row.id}`;
      el.setAttribute("role", "treeitem");
      el.setAttribute("aria-level", String(row.depth + 1));
      // The keys that act on the row itself (`SvalPanelModel.keyCommand`); its
      // menu, on Shift+F10, names the rest.
      const { MENU_KEYS: keys, ariaShortcut } = this._modules;
      el.setAttribute(
        "aria-keyshortcuts",
        [keys.rename, keys.delete, { keycode: "VK_F10", modifiers: "shift" }]
          .map(ariaShortcut)
          .join(" ")
      );
      el.setAttribute("data-node-id", row.id);
      el.setAttribute("data-kind", row.kind);
      el.style.setProperty("--sval-row-depth", String(row.depth));
      if (row.hasChildren) {
        el.setAttribute("aria-expanded", row.expanded ? "true" : "false");
      }
      // A collapsed group with the selection drawn under it is not a closed
      // block: the stylesheet leaves its bottom edge to the row under it.
      el.toggleAttribute("data-sval-shows-selection", row.showsSelection);
      this._markBlocks(el, row);
      // A workspace is not a row (spec §10.7), but one in a broken chain can be
      // drawn as one; it has no siblings here to be dragged among.
      if (row.kind !== this._modules.SvalTree.WORKSPACE) {
        el.setAttribute("draggable", "true");
      }

      const twisty = this._html("button");
      twisty.className = "sval-twisty";
      twisty.setAttribute("tabindex", "-1");
      // The row's own `aria-expanded` already announces this state, and Left and
      // Right already change it, so announcing the button too would read the
      // same fact twice.
      twisty.setAttribute("aria-hidden", "true");
      twisty.setAttribute("data-command", "toggle");
      twisty.hidden = !row.hasChildren;
      el.append(twisty);

      // Before the name, and only when there is one: spec §10.7 shows the emoji
      // wherever the place is named, and an empty element in its slot would
      // indent every nameless row differently from its siblings.
      if (row.emoji) {
        el.append(this._emojiElement(row.emoji, "sval-row-emoji"));
      } else if (row.kind === this._modules.SvalTree.GROUP) {
        // A group with no emoji of its own still has to read as a container, so
        // it takes a folder in the slot an emoji would fill.
        const folder = this._html("span");
        folder.className = "sval-row-folder";
        folder.setAttribute("aria-hidden", "true");
        el.append(folder);
      }
      this.applyAccent(el, row.tint);
      // `data-sval-fill` is what the stylesheet fills on: the row that carries the
      // colour is the group's header, and the rows under it wear a derivative.
      if (row.tint) {
        el.setAttribute("data-sval-fill", row.color ? "own" : "inherited");
      }

      // Every tab row has the slot, filled or not, so names start at the same
      // place whether or not a favicon has arrived or the tab is live here.
      if (row.kind === this._modules.SvalTree.TAB) {
        el.append(this._tabIconElement(row.id, row.url));
        // Every tab in an agent's workspace is the agent's, a tab the user
        // handed over included, so every one wears the robot (spec §6).
        if (this._agentLabel) {
          const robot = this._html("span");
          robot.className = "sval-row-agent sval-agent-glyph";
          robot.setAttribute("aria-hidden", "true");
          el.append(robot);
        }
      }

      const name = this._html("span");
      name.className = "sval-row-name";
      this._paintRowText(name, row);
      el.append(name);

      // Shown while what the row stands for plays sound, or holds media it
      // paused or muted (spec §10.7). Its menu's entry is the keyboard's way
      // to the same command.
      if (
        row.kind === this._modules.SvalTree.TAB ||
        row.kind === this._modules.SvalTree.GROUP
      ) {
        const audio = this._html("button");
        audio.className = "sval-row-audio";
        audio.setAttribute("tabindex", "-1");
        audio.setAttribute("aria-hidden", "true");
        audio.setAttribute("data-command", "media");
        el.append(audio);
      }

      // Shown by the stylesheet only while the group is collapsed, when its
      // children are out of sight and this is the only sign of what it holds.
      if (row.hasChildren && row.kind !== this._modules.SvalTree.TAB) {
        const count = this._html("span");
        count.className = "sval-row-count";
        // A bare number in the row's name; the description says "12 tabs".
        count.setAttribute("aria-hidden", "true");
        count.textContent = String(row.count);
        el.append(count);
      }

      // Only a tab closes. A group toggles, and is deleted from its menu
      // (spec §5.4).
      if (row.kind === this._modules.SvalTree.TAB) {
        const close = this._html("button");
        close.className = "sval-row-close";
        close.setAttribute("tabindex", "-1");
        close.setAttribute("aria-hidden", "true");
        close.setAttribute("data-command", "close");
        // The row's own key, which the tree answers and never remaps.
        close.title = `Close tab (${this._modules.shortcutText(
          this._modules.MENU_KEYS.delete
        )})`;
        el.append(close);
      }

      return el;
    },

    /**
     * A split's row (split-view spec §6.3): the split glyph in the twisty's
     * slot, the split's name when it has one, and a tray holding each pane as
     * a tile, in pane order. The row is a `treeitem` that is always expanded,
     * and its tray is the `group` of its panes' `treeitem`s, which take the
     * tree's roving focus as tab rows do, so a pane is focused, selected and
     * acted on as its tab. Which tiles show their titles is the stylesheet's,
     * from the tray's width.
     *
     * @param {object} row A split row from `SvalPanelModel.rows`.
     * @returns {Element}
     */
    _splitRowElement(row) {
      const el = this._html("div");
      el.className = "sval-row";
      el.id = `sval-row-${row.id}`;
      el.setAttribute("role", "treeitem");
      el.setAttribute("aria-level", String(row.depth + 1));
      el.setAttribute("aria-expanded", "true");
      el.setAttribute("data-node-id", row.id);
      el.setAttribute("data-kind", row.kind);
      el.setAttribute("draggable", "true");
      el.setAttribute("tabindex", "-1");
      el.style.setProperty("--sval-row-depth", String(row.depth));
      el.toggleAttribute("data-sval-named", !!row.name);
      if (row.name) {
        el.setAttribute("title", row.name);
      }
      this._markBlocks(el, row);
      this.applyAccent(el, row.tint);
      if (row.tint) {
        el.setAttribute("data-sval-fill", "inherited");
      }

      const glyph = this._html("span");
      glyph.className = "sval-split-glyph";
      glyph.setAttribute("aria-hidden", "true");
      el.append(glyph);

      const body = this._html("div");
      body.className = "sval-split-body";
      if (row.name) {
        const caption = this._html("span");
        caption.className = "sval-split-name";
        // The row's own label carries the name.
        caption.setAttribute("aria-hidden", "true");
        caption.textContent = row.name;
        body.append(caption);
      }
      const tray = this._html("div");
      tray.className = "sval-split-tray";
      tray.setAttribute("role", "group");
      tray.setAttribute("data-panes", String(row.panes.length));
      for (const pane of row.panes) {
        tray.append(this._paneElement(pane));
      }
      body.append(tray);
      el.append(body);
      this._paintPanesText(row, el);
      return el;
    },

    /**
     * One pane's tile in a split's tray: its favicon, or the picker's empty
     * slot, then its title.
     *
     * @param {object} pane A pane's row, from a split row's `panes`.
     * @returns {Element}
     */
    _paneElement(pane) {
      const cell = this._html("div");
      cell.className = "sval-split-pane";
      cell.id = `sval-row-${pane.id}`;
      cell.setAttribute("role", "treeitem");
      cell.setAttribute("aria-level", String(pane.depth + 1));
      cell.setAttribute("aria-posinset", String(pane.posinset));
      cell.setAttribute("aria-setsize", String(pane.setsize));
      cell.setAttribute("data-node-id", pane.id);
      cell.setAttribute("data-kind", pane.kind);
      cell.setAttribute("draggable", "true");
      cell.setAttribute("tabindex", "-1");
      const picker = pane.url === PICKER_URL;
      cell.toggleAttribute("data-sval-picker", picker);
      if (picker) {
        const slot = this._html("span");
        slot.className = "sval-split-pick";
        slot.setAttribute("aria-hidden", "true");
        cell.append(slot);
      } else {
        cell.append(this._tabIconElement(pane.id, pane.url));
      }
      const title = this._html("span");
      title.className = "sval-split-title";
      cell.append(title);
      return cell;
    },

    /**
     * Writes each pane's title, its tooltip and favicon where they changed
     * since the last draw, and the row's accessible name, which is the split's
     * name or else its pages' titles.
     *
     * @param {object} row A split row.
     * @param {Element} el Its `.sval-row`.
     */
    _paintPanesText(row, el) {
      const titles = [];
      for (const pane of row.panes) {
        const kept = this._rowEls.get(pane.id);
        const cell = el.querySelector(
          `.sval-split-pane[data-node-id="${CSS.escape(pane.id)}"]`
        );
        const picker = pane.url === PICKER_URL;
        const text = picker
          ? "Choose a page"
          : pane.name || this._untitled(pane.kind, pane.url);
        titles.push(text);
        if (
          kept?.element === cell &&
          kept.name === pane.name &&
          kept.url === pane.url
        ) {
          continue;
        }
        cell.querySelector(".sval-split-title").textContent = text;
        // Its name whether or not the stylesheet shows the title.
        cell.setAttribute("aria-label", text);
        if (picker) {
          cell.setAttribute("title", "New pane: choose a page");
        } else if (pane.url) {
          cell.setAttribute("title", `${text}\n${pane.url}`);
        } else {
          cell.setAttribute("title", text);
        }
        const icon = cell.querySelector(".sval-row-icon");
        if (icon && (kept?.element !== cell || kept.url !== pane.url)) {
          this.fillTabIcon(icon, pane.id, pane.url);
        }
      }
      el.setAttribute(
        "aria-label",
        row.name || `Split View: ${titles.join(", ")}`
      );
    },

    /**
     * Paints what changes on a split's row without the row changing: which
     * pane is selected, which is active (the one most recently viewed, whose
     * title stays shown however narrow the tray), which holds the roving
     * focus, and which are loaded.
     *
     * @param {Element} el A split's `.sval-row`.
     * @param {object} row A split row.
     */
    _paintSplitState(el, row) {
      const active = this._activePane(row);
      let viewed = false;
      for (const pane of row.panes) {
        const cell = el.querySelector(
          `.sval-split-pane[data-node-id="${CSS.escape(pane.id)}"]`
        );
        if (!cell) {
          continue;
        }
        const selected = this.selection.has(pane.id);
        viewed ||= selected;
        cell.setAttribute("aria-selected", selected ? "true" : "false");
        cell.setAttribute("tabindex", pane.id === this._focusedId ? "0" : "-1");
        cell.toggleAttribute("data-sval-active", pane === active);
        this._setTabLoaded(cell, pane.id, pane);
      }
      el.toggleAttribute("data-sval-viewed", viewed);
    },

    /**
     * The pane of a split row that stays expanded: the one whose tab was
     * viewed last (`tab.lastAccessed`), the selected tab before any.
     * A pane with no tab in this window was not viewed here.
     *
     * @param {object} row A split row.
     * @returns {object} one of its panes.
     */
    _activePane(row) {
      let active = row.panes[0];
      let last = -1;
      for (const pane of row.panes) {
        const tab = this._observer?.tabFor(pane.id);
        // The selected tab's is the moment it is read, which can tie with the
        // moment the tab before it was left.
        const at = tab?.selected ? Infinity : (tab?.lastAccessed ?? 0);
        if (at > last) {
          active = pane;
          last = at;
        }
      }
      return active;
    },

    /**
     * The id that takes the tree's focus for `id`: a split's row is entered
     * on its active pane, and anything else on itself.
     *
     * @param {string|null} id A row id.
     * @returns {string|null}
     */
    _focusIdFor(id) {
      const row = id ? this._rows.find(each => each.id === id) : null;
      return row?.panes ? this._activePane(row).id : id;
    },

    /**
     * The row element an event happened in: a split's pane, which is a row of
     * its own to every handler, or else the row.
     *
     * @param {EventTarget} target
     * @returns {Element|null}
     */
    _rowElementAt(target) {
      return target?.closest?.(".sval-split-pane, .sval-row") ?? null;
    },

    /**
     * The node a move of `row` moves: a pane's split, including a pane drawn
     * as an ordinary row because the rest of its run is hidden, or else the
     * row's own node (split-view spec §6.3).
     *
     * @param {object} row A row or a pane's row.
     * @returns {string}
     */
    _movingId(row) {
      return row.split ?? row.inSplit ?? row.id;
    },

    /**
     * Tells the stylesheet where a row sits in its coloured blocks.
     *
     * The outermost block is the row's own background, so its last row only needs
     * `data-sval-group-end`. Every block inside it is a card drawn by a
     * `.sval-row-surface` span on each row it covers, which is what lets the
     * outer colour run unbroken around a group nested in it.
     *
     * @param {Element} el The row.
     * @param {object} row A row from `SvalPanelModel.rows`.
     */
    _markBlocks(el, row) {
      const ends = this._blockEnds?.get(row.id);
      const [outermost, ...inner] = row.chain;
      if (outermost && ends?.has(outermost.id)) {
        el.setAttribute("data-sval-group-end", "");
      }
      if (!inner.length) {
        return;
      }
      el.setAttribute("data-sval-nested", "");
      el.style.setProperty("--sval-base-depth", String(outermost.depth));
      this.applyAccent(el, outermost.color, "--sval-base");
      const rail = this._html("span");
      rail.className = "sval-row-base-rail";
      rail.setAttribute("aria-hidden", "true");
      // The rail starts at the outer group's first child and nowhere else.
      if (row.firstShown && row.depth === outermost.depth + 1) {
        rail.setAttribute("data-start", "");
      }
      el.append(rail);
      inner.forEach((block, index) => {
        const surface = this._html("span");
        surface.className = "sval-row-surface";
        surface.setAttribute("aria-hidden", "true");
        surface.style.setProperty("--sval-s-level", String(index + 1));
        surface.style.setProperty("--sval-s-depth", String(block.depth));
        this.applyAccent(surface, block.color);
        if (block.id === row.id) {
          surface.setAttribute("data-start", "");
          el.setAttribute("data-sval-nested-start", "");
        }
        if (ends?.has(block.id)) {
          surface.setAttribute("data-end", "");
          el.setAttribute("data-sval-nested-end", "");
        }
        if (index === inner.length - 1) {
          surface.setAttribute("data-inner", "");
        }
        el.append(surface);
      });
    },

    /**
     * The favicon slot of a tab row.
     *
     * @param {string} id The tab's node id.
     * @param {string|null} url The node's address.
     * @returns {Element}
     */
    _tabIconElement(id, url) {
      const img = this._html("img");
      img.className = "sval-row-icon";
      img.setAttribute("alt", "");
      img.setAttribute("aria-hidden", "true");
      this.fillTabIcon(img, id, url);
      return img;
    },

    /**
     * Fills an icon slot: from the live tab when this window has one with a
     * favicon, otherwise from the icon this device keeps for the address
     * (`SvalFavoriteIcons`), otherwise from the favicon Firefox has cached for
     * it.
     *
     * **The kept icons are what a restored tab has.** Sval restores tabs lazily
     * (`SvalRestore`), so a tab nobody has opened this session carries no favicon
     * of its own, and neither does a tab that lives only on another device.
     * Places keeps an icon only while the page's history lasts. Both lookups
     * are local: the favicon service reads the profile's own database and makes
     * no request.
     *
     * @param {Element} img A `.sval-row-icon`.
     * @param {string} id The tab's node id.
     * @param {string|null} url The node's address.
     */
    async fillTabIcon(img, id, url) {
      const live = this._observer?.iconFor(id) ?? null;
      if (live) {
        img.setAttribute("src", live);
        return;
      }
      img.removeAttribute("src");
      if (!url || !/^https?:/i.test(url)) {
        return;
      }
      const kept = this._modules.SvalFavoriteIcons.iconFor(url);
      if (kept) {
        img.setAttribute("src", kept);
        return;
      }
      try {
        const { PlacesUtils } = this._modules;
        const favicon = await PlacesUtils.favicons.getFaviconForPage(
          Services.io.newURI(url)
        );
        // The slot may have been filled by a live icon, or the row rebuilt,
        // while the lookup was out.
        if (favicon && img.isConnected && !img.hasAttribute("src")) {
          img.setAttribute("src", favicon.dataURI.spec);
        }
      } catch (err) {
        // No cached favicon, or an address the service refuses: the slot stays
        // empty.
      }
    },

    /**
     * Fills the icon slot of every drawn tab row whose address has just had its
     * favicon stored (`favicon-changed`).
     *
     * @param {PlacesFavicon[]} events
     */
    _onFaviconsChanged(events) {
      const urls = new Set(events.map(event => event.url));
      this._withTabLookups(() => {
        for (const [id, { element }] of this._rowEls) {
          const url = this._nodes?.[id]?.content?.url;
          const img =
            url && urls.has(url) && element.querySelector(".sval-row-icon");
          if (img) {
            this.fillTabIcon(img, id, url);
          }
        }
      });
    },

    /**
     * Fills the icon slot of every drawn tab row that has none, once the icons
     * this device keeps have been read or changed.
     */
    _fillEmptyTabIcons() {
      const empty = this._els?.tree?.querySelectorAll(
        ".sval-row-icon:not([src])"
      );
      this._withTabLookups(() => {
        for (const img of empty ?? []) {
          const id = img
            .closest("[data-node-id]")
            ?.getAttribute("data-node-id");
          if (id) {
            this.fillTabIcon(img, id, this._nodes?.[id]?.content?.url ?? null);
          }
        }
      });
    },

    /**
     * Marks a tab row as loaded or not, and as loading a page or not. A tab
     * Sval restored without loading, or one that lives on another device, is
     * drawn muted until it loads here.
     *
     * @param {Element} el A tab's `.sval-row`.
     * @param {string} id The tab's node id.
     * @param {object|null} [row] Its row from `SvalPanelModel.rows`.
     */
    _setTabLoaded(el, id, row = this._rowFor(id)) {
      el.setAttribute(
        "data-loaded",
        this._observer?.isLoaded(id) ? "true" : "false"
      );
      el.toggleAttribute("data-busy", !!this._observer?.isBusy(id));
      el.toggleAttribute(
        "data-unopenable",
        el.getAttribute("data-loaded") === "false" && !this._opensHere(id)
      );
      if (row) {
        this._describeRow(el, row);
      }
    },

    /**
     * Whether going to a tab's row opens its tab on this device
     * (`SvalRestore.opensHere`), in the jar `activate` opens it in.
     *
     * @param {string} id A tab's node id.
     * @returns {boolean}
     */
    _opensHere(id) {
      const node = this._nodes?.[id];
      const url = node?.content?.url;
      if (!url) {
        return true;
      }
      return this._modules.SvalRestore.opensHere(
        node,
        window.gBrowser.defaultUserContextId ?? 0
      );
    },

    /**
     * The node ids of this window's tabs an extension hid (`tabs.hide`), which
     * Firefox's tab strip leaves out and so does the panel. A tab Sval hides
     * while its workspace is hidden (`SvalFirefox.hideForWorkspace`) is drawn
     * whenever its workspace is, before the hand-over shows the tab again.
     *
     * @returns {Set<string>}
     */
    _hiddenTabIds() {
      const { isHiddenForWorkspace } = this._modules.SvalFirefox;
      const ids = new Set();
      for (const tab of window.gBrowser.tabs) {
        const id =
          tab.hidden &&
          !isHiddenForWorkspace(tab) &&
          this._observer?.nodeIdFor(tab);
        if (id) {
          ids.add(id);
        }
      }
      return ids;
    },

    /**
     * Updates one tab row's loaded state in place.
     *
     * @param {string} id The tab's node id.
     */
    _paintTabLoaded(id) {
      const el = this._rowElementFor(id);
      if (el) {
        this._setTabLoaded(el, id);
      }
    },

    /**
     * Updates one tab row's favicon in place.
     *
     * @param {string} id The tab's node id.
     */
    _paintTabIcon(id) {
      const img = this._rowElementFor(id)?.querySelector(".sval-row-icon");
      if (img) {
        this.fillTabIcon(img, id, this._nodes[id]?.content?.url ?? null);
      }
    },

    /**
     * Paints the title a tab's page has set, which its node does not hold
     * yet (`SvalTabObserver.pendingName`), into the row already drawn for it,
     * as a redraw from the document would. Nothing else in the panel changes.
     *
     * @param {string} id A tab's node id.
     */
    _paintTabName(id) {
      const name = this._observer?.pendingName(id);
      const kept = this._rowEls.get(id);
      // A labelled tab shows its label whatever title its page sets.
      if (name === undefined || !kept || this._nodes[id]?.appearance?.label) {
        return;
      }
      for (const row of this._rows) {
        const pane = row.panes?.find(p => p.id === id);
        if (pane) {
          pane.name = name;
          this._paintPanesText(row, this._rowEls.get(row.id).element);
        } else if (row.id === id && !row.panes) {
          row.name = name;
          this._paintRowText(kept.element.querySelector(".sval-row-name"), row);
        } else {
          continue;
        }
        kept.name = name;
        return;
      }
    },

    /**
     * What an empty name reads as, per kind. A node with no name still has to be
     * reachable and announceable, and an empty row announces as nothing.
     *
     * **A tab falls back to its address.** `SvalTabs` takes a name from
     * `tab.label ?? ""`, so a tab filed before its title has arrived has none,
     * and a row reading "Untitled tab" says nothing about which page it is
     * while the address Sval already holds says that.
     * A workspace and a group have no second identity, so theirs stay.
     *
     * @param {string} kind A `NodeKind`.
     * @param {string|null} [url] The tab's address, for the tab case.
     * @returns {string}
     */
    _untitled(kind, url = null) {
      const { WORKSPACE, GROUP } = this._modules.SvalTree;
      if (kind === WORKSPACE) {
        return "Untitled Workspace";
      }
      return kind === GROUP ? "Untitled group" : this.tabPlaceholder(url);
    },

    /**
     * How a nameless tab reads: its host, its whole address, or "New tab".
     *
     * The host is the shortest thing that identifies the page, and `www.` is
     * dropped because it distinguishes nothing. An address with no host
     * (`file:`, `data:`, an `about:` page that is not a blank one) has no
     * shorter form, so the address itself is drawn. "New tab" is kept for a
     * page that is one: `isBlankPageURL` is Firefox's own answer to
     * that question (`browser/base/content/utilityOverlay.js`), so Sval and the
     * browser agree on which addresses are blank.
     *
     * @param {string|null} url The tab's address.
     * @returns {string}
     */
    tabPlaceholder(url) {
      if (!url || window.isBlankPageURL(url)) {
        return "New tab";
      }
      let host = "";
      try {
        host = Services.io.newURI(url).displayHost;
      } catch {
        // Either a scheme that carries no host, whose getter throws rather than
        // answering empty, or an address the IO service will not parse at all.
        // Both leave the address itself as the most specific thing to say.
      }
      return host ? host.replace(/^www\./, "") : url;
    },

    /**
     * What a row's kind is called when a sentence has to name it: the rename
     * prompt asks about this workspace, this group or this tab rather than
     * about "this".
     *
     * @param {string} kind A `NodeKind`.
     * @returns {string}
     */
    _kindNoun(kind) {
      const { WORKSPACE, GROUP } = this._modules.SvalTree;
      if (kind === WORKSPACE) {
        return "Workspace";
      }
      return kind === GROUP ? "group" : "tab";
    },

    /**
     * @param {string} id A node id.
     * @returns {Element|null} that row's element.
     */
    _rowElementFor(id) {
      return (id && this._rowEls.get(id)?.element) || null;
    },

    /**
     * @param {string} id A node id.
     * @returns {object|null} that row, or null if it is not drawn.
     */
    _rowFor(id) {
      for (const row of this._rows) {
        if (row.id === id) {
          return row;
        }
        const pane = row.panes?.find(each => each.id === id);
        if (pane) {
          return pane;
        }
      }
      return null;
    },
  });
}
