/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The panel's Undo message: after closing several tabs, deleting a group, a
 * pin or a Workspace, or unpinning a pin, a message with Undo shows at the
 * panel's foot for a few seconds. It is the element picker's toast (`SvalElementPickerChild`'s
 * `#showToast`) drawn in the chrome: the same parts, timer and keys.
 *
 * **The delete waits on the message.** What the user deleted leaves the
 * panel at once and its tabs are hidden and unloaded, but the document and
 * the Favorites store keep it until the message goes: its time runs out, the
 * user dismisses it, another delete replaces it, or the window closes or
 * Sval quits. Undo cancels the delete, so nothing has to be rebuilt, and no
 * other device hears of a delete until it is made.
 *
 * An unpin offers the same message, but is made at once, since its page
 * becomes a tab the user goes on using (`SvalPinsRow.unpin`). Its commit
 * makes nothing, and its Undo takes the unpin back.
 *
 * One delete waits at a time in a window. A Workspace waiting to be deleted
 * is left out of every window's panel, since each window lists every
 * Workspace; a tab, a group or a pin is this window's alone.
 *
 * `SvalWindow` loads this as a classic script after `sval-panel.js`; it adds
 * its methods to `SvalPanel`, whose state and helpers it shares.
 */

/* import-globals-from sval-panel.js */

Object.assign(SvalPanel, {
  /** How long the message stays, unless the pointer or focus is on it. */
  _undoMessageMs: 8000,

  /**
   * The message showing, as `{ el, timer, hovered, focused }`, or null.
   */
  _undoOffer: null,

  /**
   * The delete waiting on the message, or null: `{ undo, commit, settled }`,
   * with `tree` (`{ ids, keepContents }`) for nodes the panel leaves out of
   * its view until the delete is made ({@link _viewOf}).
   */
  _pendingDelete: null,

  /**
   * Whether a tab was hidden since {@link _showStrandedDeleteHides} last
   * looked, and the delete held then. A window's tabs can be restored
   * before the panel listens.
   */
  _tabHiddenSinceLook: true,
  _pendingAtLook: null,

  /**
   * The message's live region, always in the panel so a screen reader
   * announces what is put in it (`role="status"`, as the picker's toast).
   *
   * @param {Function} make As `_build` makes an element.
   * @returns {Element}
   */
  _buildUndoRegion(make) {
    this._watchWindowForUndo();
    return make("div", { class: "sval-undo-region", role: "status" });
  },

  /**
   * Holds a delete back behind the message: makes any delete already waiting,
   * hides this one, and shows the message.
   *
   * @param {string} text What went, in a few words.
   * @param {object} pending
   * @param {Function} pending.undo Shows again what `hide` hid. Awaited.
   * @param {Function} pending.commit Makes the delete, given
   *   `{ closing, inUnload }`. With `closing` it starts every write before it
   *   returns, and answers them as steps for the engine's
   *   `finishBeforeShutdown`: a promise, or an array of them.
   * @param {object} [pending.tree] `{ ids, keepContents }`, document nodes
   *   to leave out of the view.
   * @param {string[]} [pending.pins] Pins every window's row leaves out.
   * @param {Function} hide Takes it out of sight. Awaited.
   */
  async deferDelete(text, pending, hide) {
    await this.commitPendingDelete();
    pending.settled = false;
    this._pendingDelete = pending;
    try {
      await hide();
    } catch (err) {
      this._modules.SvalLog.error(
        `hiding a delete failed: ${this._modules.describeError(err)}`
      );
    }
    if (this._pendingDelete !== pending || pending.settled) {
      return;
    }
    if (this._els?.undoRegion) {
      this._showUndoMessage(text);
    } else {
      await this.commitPendingDelete();
    }
  },

  /**
   * Makes the delete waiting on the message, and takes the message away.
   *
   * @param {object} [options]
   * @param {boolean} [options.closing] The window is closing or Sval is
   *   quitting: every write starts before this returns, and the profile's
   *   shutdown blocker waits for them (`finishBeforeShutdown`).
   * @param {boolean} [options.inUnload] The window is unloading, too late to
   *   close its tabs, which go with it.
   * @returns {Promise<void>}
   */
  async commitPendingDelete({ closing = false, inUnload = false } = {}) {
    const pending = this._pendingDelete;
    if (!pending || pending.settled) {
      return;
    }
    pending.settled = true;
    this._removeUndoMessage();
    if (closing) {
      // The writes end after a closing window has gone, so the engine chains
      // them (`finishBeforeShutdown`).
      let steps = [];
      try {
        steps = [pending.commit({ closing, inUnload })].flat();
      } catch (err) {
        this._modules.SvalLog.error(
          `a delete held for Undo failed: ${this._modules.describeError(err)}`
        );
      }
      this._engine?.finishBeforeShutdown?.(...steps, () => {
        if (this._pendingDelete === pending) {
          this._pendingDelete = null;
        }
      });
      return;
    }
    let done;
    try {
      done = Promise.resolve(pending.commit({ closing, inUnload }));
    } catch (err) {
      done = Promise.reject(err);
    }
    done = done
      .catch(err =>
        this._modules.SvalLog.error(
          `a delete held for Undo failed: ${this._modules.describeError(err)}`
        )
      )
      .then(() => {
        if (this._pendingDelete === pending) {
          this._pendingDelete = null;
        }
      });
    await done;
    await this.refresh();
    if (pending.tree?.workspace) {
      this._refreshOtherWindows();
    }
    if (pending.pins) {
      this.renderPinsEverywhere();
    }
    this._publishSoon();
  },

  /**
   * Answers the undo key ({@link _onUndoKey}), and makes the delete waiting
   * on the message as the window closes or Sval quits, so neither loses it
   * or leaves it half made.
   *
   * `quit-application-requested` and `SSWindowClosing` both come before the
   * session store reads the window's tabs (`onQuitApplicationGranted`, and
   * `SessionStore.onClose`, which dispatches the event first), so the hidden
   * tabs close as a person's close does and none is saved as open. `unload`
   * catches a window the session store does not track; its tabs go with it.
   */
  _watchWindowForUndo() {
    if (this._windowWatchedForUndo) {
      return;
    }
    this._windowWatchedForUndo = true;
    window.addEventListener("keydown", event => this._onUndoKey(event));
    window.addEventListener("TabHide", () => {
      this._tabHiddenSinceLook = true;
    });
    const onQuit = () => this.commitPendingDelete({ closing: true });
    Services.obs.addObserver(onQuit, "quit-application-requested");
    window.addEventListener(
      "SSWindowClosing",
      () => this.commitPendingDelete({ closing: true }),
      { once: true }
    );
    window.addEventListener(
      "unload",
      () => {
        Services.obs.removeObserver(onQuit, "quit-application-requested");
        this.commitPendingDelete({ closing: true, inUnload: true });
      },
      { once: true }
    );
  },

  /**
   * The platform's undo key, Z with the accel key alone, as Gecko's editor
   * reads it (`ShortcutKeyDefinitions`' `cmd_undo`), is the message's Undo
   * while focus is in this window's chrome and nothing there would undo:
   * no command dispatcher controller takes `cmd_undo`, which a text field's
   * editor does. A page holding focus keeps the key, whether its browser
   * (`<browser>`) or an in-process page's document holds it.
   *
   * @param {KeyboardEvent} event
   */
  _onUndoKey(event) {
    const pending = this._pendingDelete;
    if (
      !pending ||
      pending.settled ||
      event.defaultPrevented ||
      event.key.toLowerCase() !== "z" ||
      !event.getModifierState("Accel") ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const { commandDispatcher } = document;
    if (
      commandDispatcher.focusedWindow !== window ||
      commandDispatcher.focusedElement?.localName === "browser" ||
      commandDispatcher.getControllerForCommand("cmd_undo")
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this._takeUndo().catch(err =>
      this._modules.SvalLog.error(
        `undoing a held delete failed: ${this._modules.describeError(err)}`
      )
    );
  },

  /**
   * Shows the message, replacing any other.
   *
   * @param {string} text What went, in a few words.
   */
  _showUndoMessage(text) {
    const region = this._els.undoRegion;
    this._removeUndoMessage();
    const make = (tag, attrs = {}) => {
      const el = this._html(tag);
      for (const [name, value] of Object.entries(attrs)) {
        el.setAttribute(name, value);
      }
      return el;
    };
    const el = make("div", { class: "sval-undo" });
    const label = make("span", { class: "sval-undo-text" });
    label.textContent = text;
    const button = make("button", {
      class: "sval-undo-button",
      "data-command": "undo",
      "aria-label": "Undo",
    });
    const buttonLabel = make("span");
    buttonLabel.textContent = "Undo";
    button.append(
      make("span", { class: "sval-undo-glyph", "aria-hidden": "true" }),
      buttonLabel
    );
    const dismiss = make("button", {
      class: "sval-undo-dismiss",
      "data-command": "dismissUndo",
      title: "Dismiss",
      "aria-label": "Dismiss",
    });
    el.append(
      make("span", { class: "sval-undo-icon", "aria-hidden": "true" }),
      label,
      button,
      dismiss
    );
    const offer = { el, timer: null, hovered: false, focused: false };
    const pause = () => this._armUndo(offer);
    // Gecko logs mouseenter and mouseleave in chrome as slower than
    // mouseover and mouseout (`EventListenerManager`, `SlowChromeEvent`).
    el.addEventListener("mouseover", () => {
      if (!offer.hovered) {
        offer.hovered = true;
        pause();
      }
    });
    el.addEventListener("mouseout", event => {
      if (!el.contains(event.relatedTarget)) {
        offer.hovered = false;
        pause();
      }
    });
    el.addEventListener("focusin", () => {
      offer.focused = true;
      pause();
    });
    el.addEventListener("focusout", event => {
      offer.focused = el.contains(event.relatedTarget);
      pause();
    });
    el.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.dismissUndo({ refocus: true });
      }
    });
    this._undoOffer = offer;
    region.append(el);
    this._armUndo(offer);
  },

  /**
   * Runs the message's timer, paused while it is hovered or focused.
   *
   * @param {object} offer The message, as {@link _undoOffer} holds it.
   */
  _armUndo(offer) {
    clearTimeout(offer.timer);
    offer.timer = null;
    if (this._undoOffer === offer && !offer.hovered && !offer.focused) {
      offer.timer = setTimeout(() => {
        if (this._undoOffer === offer) {
          this.dismissUndo();
        }
      }, this._undoMessageMs);
    }
  },

  /**
   * Takes the message element away.
   *
   * @param {object} [options]
   * @param {boolean} [options.refocus] Gives focus back to the tree, for a
   *   message that held it.
   * @returns {boolean} whether a message was showing.
   */
  _removeUndoMessage({ refocus = false } = {}) {
    const offer = this._undoOffer;
    if (!offer) {
      return false;
    }
    this._undoOffer = null;
    clearTimeout(offer.timer);
    const held = offer.el.contains(document.activeElement);
    offer.el.remove();
    if (refocus || held) {
      this._focusRow(this._focusedId ?? this._selectedId());
    }
    return true;
  },

  /**
   * Takes the message away and makes the delete it held back.
   *
   * @param {object} [options] As {@link _removeUndoMessage}.
   * @returns {boolean} whether a message was showing.
   */
  dismissUndo(options) {
    const shown = this._removeUndoMessage(options);
    this.commitPendingDelete().catch(err =>
      this._modules.SvalLog.error(
        `a delete held for Undo failed: ${this._modules.describeError(err)}`
      )
    );
    return shown;
  },

  /** The message's Undo: takes the message away and cancels the delete. */
  async _takeUndo() {
    const pending = this._pendingDelete;
    if (!pending || pending.settled) {
      return;
    }
    pending.settled = true;
    this._pendingDelete = null;
    this._removeUndoMessage({ refocus: true });
    await pending.undo();
  },

  // --------------------------------------------------------- document nodes

  /**
   * Holds back the delete of nodes in the document: several tabs, a group,
   * or a Workspace, with everything inside each.
   *
   * Their rows leave at once. Their tabs in this window are hidden and
   * unloaded, so a deleted tab plays nothing and holds no memory while the
   * message shows; the tab on screen hands over first to the tab a close
   * would land on (`_findTabToBlurTo`), or to a new home tab when they are
   * every tab the window has (`keepOneTab`). A Workspace the window shows
   * is left as a switch leaves one (`_resolveCurrentWorkspace`), and any of
   * its tabs a window kept loaded is unloaded.
   *
   * @param {string} text What went, in a few words.
   * @param {string[]} ids Node ids, all tabs or one container.
   * @param {object} [options]
   * @param {boolean} [options.keepContents] The group's contents move out
   *   to its parent when the delete is made, and show there meanwhile.
   */
  async _deferRemoval(text, ids, { keepContents = false } = {}) {
    await this.commitPendingDelete();
    await this._observer?.settled();
    const { WORKSPACE, descendantIds, rowIndexIn } =
      this._modules.SvalPanelModel;
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
      showing: workspace && present.includes(this._currentWorkspaceId),
      shownElsewhere: workspace
        ? (this.workspacesShownElsewhere().get(present[0]) ?? null)
        : null,
    };
    pending.undo = () => this._undoTreeRemoval(pending);
    pending.commit = options =>
      this._commitTreeRemoval(pending, going, options);
    await this.deferDelete(text, pending, async () => {
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
      await this.switchTo(id);
    }
    // The window that showed it, if still open, shows it again.
    const other = pending.shownElsewhere?.closed
      ? null
      : pending.shownElsewhere?.SvalPanel;
    if (other?._engine && this._treeNodes[id]) {
      await other.switchTo(id);
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
   * @param {boolean} options.closing As {@link commitPendingDelete}.
   * @param {boolean} options.inUnload As {@link commitPendingDelete}.
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

  /**
   * `nodes` without what a delete held for Undo takes, in any window: a
   * group whose contents move out stays, drawn as its contents
   * ({@link _transparentIds}).
   *
   * @param {object} nodes The document's `nodes` map.
   * @returns {object}
   */
  _viewOf(nodes) {
    const { descendantIds } = this._modules.SvalPanelModel;
    const gone = new Set();
    for (const { ids, keepContents } of this._pendingTrees()) {
      if (keepContents) {
        continue;
      }
      for (const id of ids) {
        gone.add(id);
        for (const each of descendantIds(nodes, id)) {
          gone.add(each);
        }
      }
    }
    if (!gone.size) {
      return nodes;
    }
    return Object.fromEntries(
      Object.entries(nodes).filter(([id]) => !gone.has(id))
    );
  },

  /**
   * @returns {Set<string>} the groups whose delete, held for Undo, moves
   *   their contents out.
   */
  _transparentIds() {
    const ids = new Set();
    for (const tree of this._pendingTrees()) {
      if (tree.keepContents) {
        tree.ids.forEach(id => ids.add(id));
      }
    }
    return ids;
  },

  /**
   * @returns {object[]} each normal window's delete held for Undo, as its
   *   `tree`.
   */
  _pendingTrees() {
    const trees = [];
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      const tree = win.SvalPanel?._pendingDelete?.tree;
      if (tree) {
        trees.push(tree);
      }
    }
    return trees;
  },

  /**
   * Shows the tabs a delete held for Undo hid that no delete still holds: the
   * session store brings back the hide of a window that was not closed
   * cleanly, and its delete was never made.
   *
   * A hide is stranded only by a hide since the last look, which fires
   * `TabHide` whether the session store or Sval made it
   * (`tabbrowser.restoreTabs`, `gBrowser.hideTab`), or by the delete
   * holding it ending, so the tabs are walked only after one of those.
   */
  _showStrandedDeleteHides() {
    if (
      !this._tabHiddenSinceLook &&
      this._pendingDelete === this._pendingAtLook
    ) {
      return;
    }
    this._tabHiddenSinceLook = false;
    this._pendingAtLook = this._pendingDelete;
    const { isHiddenForDelete } = this._modules.SvalFirefox;
    const held = this._pendingDelete?.tabs ?? [];
    for (const tab of window.gBrowser.tabs) {
      if (isHiddenForDelete(tab) && !held.includes(tab)) {
        window.gBrowser.showTab(tab);
      }
    }
  },

  /**
   * @returns {Set<string>} the pins whose delete waits on any normal
   *   window's Undo message.
   */
  pendingPinGuids() {
    const guids = new Set();
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      for (const guid of win.SvalPanel?._pendingDelete?.pins ?? []) {
        guids.add(guid);
      }
    }
    return guids;
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
