/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Which workspace this window shows (spec §10.7): the one it remembers,
 * adopts or makes, switching to another, handing the window's tabs over when
 * the workspace changes, and where in it a tab opened from inside it goes.
 *
 * `SvalWindow` loads this as a classic script after `sval-panel.js`; it adds
 * its methods to `SvalPanel`, whose state and helpers it shares.
 */

/* import-globals-from sval-panel.js */

Object.assign(SvalPanel, {
  /**
   * Serialises `switchTo` against itself, so two entries pressed in quick
   * succession switch one after the other rather than interleaving. A
   * `SvalSerialQueue`, made on first use.
   */
  _switching: null,

  /**
   * Serialises {@link _handOverWindow} against itself.
   *
   * `_switching` is not enough: `_showWorkspace` is also reached from
   * `_resolveCurrentWorkspace`, by way of `refresh` (the tab observer's
   * `onTreeChanged`) and `_refreshIfChanged` on the poll, and neither route
   * passes through `_switching`. So a peer taking away the workspace this
   * window was showing can start a hand-over while one is in flight, and two
   * hand-overs with different ideas of what to keep would leave the window
   * holding the wrong workspace's tabs. No node is at risk either way,
   * because every release is marked; what is at risk is what the window is
   * showing.
   *
   * A `SvalSerialQueue`, made on first use. The tab observer's queue reaches
   * it through `refresh`, so a hand-over waits for nothing on that queue.
   */
  _handingOver: null,

  /**
   * The workspace this window files things under: the one already in the
   * document if there is one, otherwise a new one with no name.
   *
   * **Adoption is tried first, and it is what makes a second device work at
   * all.** `_start` syncs before calling this when a folder is configured, so
   * `this._nodes` is the merged tree rather than this device's empty one: a
   * device pointed at a folder a peer has published to joins that peer's
   * workspace and creates nothing. Which workspace is a question this window
   * may already have an answer to, so `SvalPanelModel.currentWorkspace`
   * decides: what this window last showed if the document still holds it,
   * otherwise the first in sibling order, which is the same one on every
   * device because sibling order is the shared fractional index. Never one
   * another window shows (spec §10.7).
   *
   * With no workspace left for this window (none anywhere, or every one
   * shown by a window of its own, as when the user opens a new window), one
   * is created **with an empty name**. A
   * workspace has to exist for this window to have anywhere to put a tab, and
   * it cannot wait on an answer, so the only open question is what it is
   * called, and it is not called anything yet. A name
   * travels to every device its owner has and stays in their data
   * permanently, so the document carries only names its owner typed; a
   * nameless row draws the placeholder `_untitled` supplies, which is a label
   * in this window and not a value anywhere. F2, or Rename in the row's
   * context menu, is what turns that placeholder into a name.
   *
   * The id is minted here and the timestamp read here, because the engine
   * does neither (host contract §3).
   *
   * @returns {Promise<string>} a workspace id present in the document.
   */
  async _adoptOrCreateWorkspace() {
    if (this._inMemory) {
      return this._currentWorkspaceId;
    }
    const { currentWorkspace } = this._modules.SvalPanelModel;
    const adopted = currentWorkspace(
      this._nodes,
      this._rememberedWorkspaceId(),
      this._takenElsewhere()
    );
    if (adopted) {
      return adopted;
    }

    return this._createOwnWorkspace(null);
  },

  /**
   * Creates the workspace this window files things under, with the name,
   * colour and emoji `made` gives it, or with no name (see
   * {@link _adoptOrCreateWorkspace}). The workspace and its look are one
   * batch, so it reaches other devices whole.
   *
   * @param {?{name: string, color: ?string, emoji: ?string}} made What
   *   `SvalPanelModel.chosenContainer` returned, or null.
   * @returns {Promise<string>} the workspace's id.
   */
  async _createOwnWorkspace(made) {
    const id = crypto.randomUUID();
    await this._engine.mutate({
      kind: "batch",
      ops: [
        { kind: "addWorkspace", name: made?.name ?? "", id },
        ...(made ? this._chosenAppearanceOps(id, made) : []),
      ],
      now: this._modules.SvalClock.now(),
    });
    // Claimed before the first wait, so that no window starting meanwhile
    // takes it (`workspacesShownElsewhere` reads the claim) before
    // `_showWorkspace` shows it here.
    this._rememberWorkspace(id);
    this._recordMadeWorkspace(id);
    this._settings.setCollapsed(id, false);
    this._settings.saveSoon();
    await this.refresh();
    await this.syncNow();
    return id;
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
   * {@link _selectedId} answers with.
   *
   * @returns {Promise<string>} a node id that exists and can hold a tab.
   */
  async _newTabParent() {
    const { isPane } = this._modules.SvalPanelModel;
    const { WORKSPACE, GROUP } = this._modules.SvalTree;
    const current = this._currentWorkspaceId;
    const selected = this._selectedId();
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
   * The workspace this window last showed, as the session store holds it.
   *
   * Per window and persisted across a restart, which is what §10.7 asks of a
   * torn-off window, and what `SvalLocalSettings` cannot give, being per
   * profile and unable to tell two windows apart.
   *
   * A window the session store is not tracking throws rather than answering
   * (`SessionStore.sys.mjs`'s `getCustomWindowValue`), which is a window that
   * has nothing remembered: the same case as a brand new one.
   *
   * @returns {string|null} a node id, or null when nothing is remembered.
   */
  _rememberedWorkspaceId() {
    const { SessionStore } = this._modules;
    const { CURRENT_WORKSPACE_KEY } = this._modules.SvalPanelModel;
    try {
      return (
        SessionStore.getCustomWindowValue(window, CURRENT_WORKSPACE_KEY) || null
      );
    } catch (err) {
      this._modules.SvalLog.warn(
        `could not read which workspace this window shows: ${this._modules.describeError(err)}`
      );
      return null;
    }
  },

  /**
   * The workspace this window created for itself, as the session store holds
   * it ({@link _recordMadeWorkspace}). Read as {@link _rememberedWorkspaceId}
   * is, and for the same reason: it survives a restart.
   *
   * @returns {string|null} a node id, or null when this window made none.
   */
  _madeWorkspaceRecord() {
    const { SessionStore } = this._modules;
    const { MADE_WORKSPACE_KEY } = this._modules.SvalPanelModel;
    try {
      return (
        SessionStore.getCustomWindowValue(window, MADE_WORKSPACE_KEY) || null
      );
    } catch (err) {
      this._modules.SvalLog.warn(
        `could not read which workspace this window made: ${this._modules.describeError(err)}`
      );
      return null;
    }
  },

  /**
   * Records `id` as the workspace this window created for itself, in
   * `_madeWorkspaceId` and in the session store.
   *
   * @param {string} id
   */
  _recordMadeWorkspace(id) {
    this._madeWorkspaceId = id;
    const { SessionStore } = this._modules;
    const { MADE_WORKSPACE_KEY } = this._modules.SvalPanelModel;
    try {
      SessionStore.setCustomWindowValue(window, MADE_WORKSPACE_KEY, id);
    } catch (err) {
      this._modules.SvalLog.warn(
        `could not record which workspace this window made: ${this._modules.describeError(err)}`
      );
    }
  },

  /**
   * Records the workspace this window shows. Device-local and per window
   * (spec §5.6, §10.7). It never reaches the engine, because a window's
   * attention is a fact about a machine and syncing it would drag one
   * device's onto another's.
   *
   * @param {string|null} id A workspace id, or null to remember nothing.
   */
  _rememberWorkspace(id) {
    if (this._inMemory) {
      return;
    }
    const { SessionStore } = this._modules;
    const { CURRENT_WORKSPACE_KEY } = this._modules.SvalPanelModel;
    try {
      // The store holds strings only, so "nothing remembered" is the empty
      // string rather than a deletion: `getCustomWindowValue` already reads an
      // absent key as `""`, so the two are the same state and one path sets it.
      SessionStore.setCustomWindowValue(
        window,
        CURRENT_WORKSPACE_KEY,
        id ?? ""
      );
    } catch (err) {
      this._modules.SvalLog.warn(
        `could not record which workspace this window shows: ${this._modules.describeError(err)}`
      );
    }
  },

  /**
   * Keeps `_currentWorkspaceId` naming a workspace that exists.
   *
   * Run wherever the document changes (`refresh` and `_refreshIfChanged`),
   * so it is checked against every document the panel ever draws rather than
   * only at startup, and it goes through {@link _showWorkspace} like every
   * other change of workspace. Two things follow from asking
   * `SvalPanelModel.currentWorkspace` each time:
   *
   *  - **A workspace closed on another device does not leave this window
   *    empty.** Its id stops being in the document, so the first workspace in
   *    sibling order is shown instead: the panel always has rows and always
   *    has a way out.
   *  - **A workspace arriving from a peer does not yank the user to it.** The
   *    remembered id still exists, so it still wins; a new root changes the
   *    switcher's list and nothing else.
   *
   * A workspace another window shows is never the answer (spec §10.7). When
   * the workspace this window showed is gone and every other one has a window
   * of its own, this window has nothing left to show, so it closes. Its closing
   * deletes nothing, because what it showed is gone already, and another
   * window is open, the one showing each remaining workspace.
   */
  async _resolveCurrentWorkspace() {
    const { currentWorkspace } = this._modules.SvalPanelModel;
    const { workspaceIds } = this._modules.SvalTree;
    const remembered =
      this._currentWorkspaceId ?? this._rememberedWorkspaceId();
    const id = currentWorkspace(
      this._nodes,
      remembered,
      this._takenElsewhere()
    );
    if (
      id === null &&
      this._currentWorkspaceId &&
      workspaceIds(this._nodes).length
    ) {
      this._modules.SvalLog.info(
        "every workspace has a window of its own, so this window closes"
      );
      // Marked first, so that no other window, resolving at the same moment,
      // counts this one as still showing anything and closes as well.
      this._closing = true;
      window.close();
      return false;
    }
    return this._showWorkspace(id);
  },

  /**
   * The workspaces other windows show, each with the window showing it.
   *
   * A workspace has one window (spec §10.7). Every other full, non-private
   * browser window counts: by what its panel shows, or, before its panel has
   * started, by what it was handed (`SvalPanelModel.handWorkspaceTo`) or what
   * the session remembers for it, so a window still starting keeps its claim
   * against one that starts first.
   *
   * A popup a page opened neither counts nor is held to the rule. It shows the
   * page that opened it and closes with it (`_startFromSync`), and an agent's
   * sign-in popup is handed the agent's workspace on purpose (`SvalAgentGate`).
   * A private window has its own temporary workspace, which no other window
   * can show.
   *
   * @returns {Map<string, Window>} workspace id to the window showing it.
   */
  workspacesShownElsewhere() {
    const shown = new Map();
    if (this._inMemory || !window.toolbar.visible) {
      return shown;
    }
    const { PrivateBrowsingUtils, SessionStore } = this._modules;
    const { CURRENT_WORKSPACE_KEY, pendingHandOffs } =
      this._modules.SvalPanelModel;
    const counts = win =>
      win !== window &&
      !win.closed &&
      !win.SvalPanel?._closing &&
      win.toolbar?.visible &&
      !PrivateBrowsingUtils.isWindowPrivate(win);
    for (const [win, id] of pendingHandOffs()) {
      if (counts(win)) {
        shown.set(id, win);
      }
    }
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (!counts(win)) {
        continue;
      }
      let id = win.SvalPanel?._currentWorkspaceId ?? null;
      if (!id) {
        try {
          id = SessionStore.getCustomWindowValue(win, CURRENT_WORKSPACE_KEY);
        } catch {
          // Not tracked by the session store yet: it remembers nothing.
        }
      }
      if (id && !shown.has(id)) {
        shown.set(id, win);
      }
    }
    return shown;
  },

  /**
   * The workspaces this window may not take: those {@link
   * workspacesShownElsewhere} names, and those a closed window may still
   * delete (`SvalPanelModel.holdWhileClosing`).
   *
   * @returns {Set<string>} workspace ids.
   */
  _takenElsewhere() {
    const taken = this._modules.SvalPanelModel.heldWhileClosing();
    for (const id of this.workspacesShownElsewhere().keys()) {
      taken.add(id);
    }
    return taken;
  },

  /**
   * The new-window command: opens a window on the next workspace down from
   * this window's (`SvalPanelModel.currentWorkspace`'s `after`), wrapping at
   * the bottom. When none is left, the window is handed nothing and takes the
   * path every other new window takes, which makes a nameless workspace
   * (`_adoptOrCreateWorkspace`).
   *
   * The workspace is chosen here and handed over, and not left for the new
   * window to choose, because a hand-off is what keeps every other window from
   * taking it first (`workspacesShownElsewhere`). Only this command carries
   * the workspace this window shows; a restored, torn-off or agent's window
   * does not.
   */
  openWindowOnNextWorkspace() {
    const { currentWorkspace, handWorkspaceTo } = this._modules.SvalPanelModel;
    const next = this._inMemory
      ? null
      : currentWorkspace(
          this._nodes,
          null,
          this._takenElsewhere(),
          this._currentWorkspaceId
        );
    const opened = window.OpenBrowserWindow();
    if (next) {
      handWorkspaceTo(opened, next);
    }
  },

  /**
   * **The one place a window changes which workspace it shows**, and so the
   * one place anything that must follow a switch is hung: the window is told
   * what it shows, the window's record of it is written, and the tab observer
   * is told where to file a stray, and the window's tabs are handed over to
   * the workspace it now shows ({@link _handOverWindow}, spec §10.7).
   *
   * Every route in comes through it: the switcher (`switchTo`), startup
   * (`_start`), creating a workspace (`addWorkspace`), and a peer's pass
   * taking away the workspace this window was showing
   * (`_resolveCurrentWorkspace`). That last one is the reason this exists as a
   * function of its own: it changes what is drawn without any user action, and
   * anything hung only on the switcher's path would be skipped by it.
   *
   * It does not redraw. Its callers do, because every one of them is already
   * about to for reasons of its own, and redrawing twice moves the focus ring
   * twice.
   *
   * **A workspace has one window** (spec §10.7), and this is where that holds
   * whichever route asked: a workspace another window shows is not taken
   * here, and that window is brought forward instead.
   *
   * @param {string|null} id A workspace id, or null when the document holds no
   *   workspace at all.
   * @returns {Promise<boolean>} whether the window changed workspace.
   */
  async _showWorkspace(id) {
    if (id === this._currentWorkspaceId || this._inMemory) {
      return false;
    }
    const left = this._currentWorkspaceId;
    const shownBy = id && this.workspacesShownElsewhere().get(id);
    if (shownBy) {
      shownBy.focus();
      return false;
    }
    this._currentWorkspaceId = id;
    this._modules.SvalDownloadWorkspaces.workspaceShown(window);
    this._rememberWorkspace(id);
    // Before the hand-over, so the tabs it opens and every tab opened after
    // it are in the jar of the workspace now shown.
    this._setJar();
    // The observer files strays and restored tabs under the workspace it was
    // attached with, so it has to learn about a switch or a tab dragged into
    // this window (or handed back by Firefox's recently-closed list) would
    // land in the workspace the user just left. After a peer deletes the
    // workspace this window was showing, that parent does not even exist any
    // more.
    if (id) {
      this._observer?.setWorkspace(id);
    }
    // The row that had focus belongs to the workspace being left, so it is
    // not in the new row list; `render` puts focus on the first row of what
    // it draws rather than leaving the tree with no tab stop at all.
    this._focusedId = null;
    await this._handOverWindow(id);
    // The pins of the workspace left stay loaded as its tabs do, and unload
    // with them once it has been out of sight long enough (pins spec §5).
    if (left) {
      this._pins?.pages.park(left);
    }
    return true;
  },

  /**
   * Gives this window's tab strip to the workspace it now shows (spec §10.7).
   *
   * The incoming workspace's tabs are materialised lazily, with the same
   * `addTrustedTab` with `createLazyBrowser` then `setTabState` a launch
   * already uses (§10.4), which is why this calls `SvalRestore.restore` rather
   * than keeping a second copy of it. The outgoing workspace's tabs are then
   * hidden, loaded, until `SvalTabObserver.releaseIdle` or Firefox's
   * `TabUnloader` lets them go.
   *
   * **Nothing here deletes a node, and the order is part of why.**
   * Materialise, then show one of the incoming tabs, then release: releasing
   * first would leave the window with nothing of the new workspace on screen,
   * and `hideTab` refuses the selected tab, so the outgoing tab the user was
   * looking at would have stayed on screen in a window that had moved on.
   * `SvalTabObserver.releaseTabsOutside` carries the rest of the reasoning.
   *
   * **A failure here never fails the switch.** The panel has already moved,
   * and every tab still in the window still carries its node, so the worst
   * outcome is a window holding more tabs than it should, which is invisible
   * in a browser with no tab strip, and nothing is lost. Rejecting instead would
   * leave the switch half-applied with nothing to finish it.
   *
   * @param {string|null} id The workspace this window now shows.
   * @param {object} [options]
   * @param {boolean} [options.hold] Whether the outgoing tabs stay loaded,
   *   as they do when the user switches (`releaseTabsOutside`).
   * @returns {Promise<void>}
   */
  async _handOverWindow(id, { hold = true } = {}) {
    this._handingOver ??= new this._modules.SvalSerialQueue("hand-over");
    return this._handingOver.run(() => this._handOverWindowOnce(id, hold));
  },

  /**
   * One hand-over, with {@link _handOverWindow} holding the door.
   *
   * @param {string|null} id The workspace this window now shows.
   * @param {boolean} hold As {@link _handOverWindow} takes it.
   * @returns {Promise<void>}
   */
  async _handOverWindowOnce(id, hold) {
    const observer = this._observer;
    if (id !== this._currentWorkspaceId) {
      // Queued behind a hand-over for somewhere else, and the window has since
      // moved on. Materialising a workspace the window has already left would
      // fill it with tabs it is not showing, and the hand-over that overtook
      // this one has already done the right thing.
      return;
    }
    if (!observer || !id || !this._engine) {
      // Nothing is mirroring this window's strip yet. At startup that is the
      // ordinary case: `_start` picks a workspace through this funnel and
      // restores it straight after, and materialising here as well would open
      // every tab twice.
      return;
    }
    // A window closed meanwhile has no strip to hand over.
    if (window.closed) {
      return;
    }

    try {
      const { wanted } = await this._modules.SvalRestore.restore(window, {
        engine: this._engine,
        workspaceId: id,
        // The window's own blank startup tab is not a switch's business: it
        // carries no node, so it belongs to no workspace, and the release
        // below leaves it where it is for the same reason.
        closeDebris: false,
      });
      if (window.closed) {
        return;
      }

      const keep = new Set(wanted);
      const target = this._mostRecentlyActive(wanted);
      // A pin's page is a tab of the window that no release takes away, so
      // it is on screen as a tab would be.
      const guid = this._lastPinAfter(target);
      const pin = guid ? this._pins.pinOf(guid) : null;
      const onPin = !!pin;
      // Something of this workspace has to be on screen before anything is
      // taken away, and it has to be chosen first for two reasons:
      // `hideTab` refuses the selected tab, so an outgoing tab still
      // selected would stay on screen; and removing a window's last
      // tab makes Firefox insert a replacement of its own, synchronously and
      // before `TabClose` (`tabbrowser.js`'s `_beginRemoveTab`), which would
      // arrive as a tab the user opened, filed wherever new tabs go, in the
      // middle of the hand-over.
      //
      // An empty workspace gets a tab because a window with no tab at all is
      // not a state Firefox has. It shows the home page and is filed as one
      // (`openUnfiledTab` holds the reasoning), so it is the
      // workspace's own tab from then on. Nothing is added to `keep` for it,
      // because it carries no node until its `TabOpen` is reconciled, which is
      // after the release below, and the release passes over an untagged tab.
      const blank = target || onPin ? null : observer.openUnfiledTab();
      if (onPin) {
        this._pins.select(pin);
      } else if (target) {
        // Selecting is also what loads it. A materialised tab stays lazy until
        // it is looked at, so a switch costs one page load rather than a
        // workspace's worth.
        observer.selectNode(target);
      }
      // A tab Sval opened for an earlier visit that never became the
      // workspace's own. It carries no node, so the release below would never
      // take it away, and it would be left behind unreachable, with no row to
      // draw it and no tab strip to find it in.
      observer.closeUnfiledTabs(blank);
      await observer.releaseTabsOutside(keep, { hold });
      // A tab adopted rather than opened kept whatever jar it was in. Queued
      // and not awaited, as in `_keepJar`: a peer's switch reaches this from
      // the observer's own queue (`onTreeChanged`), and a hand-over that
      // waited for that queue would wait for itself.
      observer.keepTabsInJar?.({ wait: false });
      observer.keepSplits?.();
      // The counterpart to the error below. A window showing the wrong tabs
      // after a switch is the hardest thing in Sval to reason about from the
      // outside, and these three numbers are what the reasoning needs.
      this._modules.SvalLog.debug(
        `handed this window to ${id}: ${wanted.length} tabs wanted, ` +
          `${blank ? "one blank opened, " : ""}everything else released`
      );
    } catch (err) {
      // The switch itself must not fail, because the panel has already moved
      // and every tab still carries its node, but a hand-over that throws is a
      // bug, and
      // a bug belongs in the console rather than narrated to someone who cannot
      // act on it (spec §10.7). This line is the whole record of it, which is
      // why `sval_switcher_helpers.js`'s `assertNoHandOverFailure` reads the
      // console for it and fails the suite on one.
      this._modules.SvalLog.error(
        `handing the window to a workspace failed: ${this._modules.describeError(err)}`
      );
    }
  },

  /**
   * The guid of the pin this device looked at in the window's workspace
   * after `tabId`, the tab it would otherwise land on, or null. That pin is
   * where this device left the workspace (pins spec §5), if it still shows
   * there.
   *
   * @param {string|null} tabId
   * @returns {string|null}
   */
  _lastPinAfter(tabId) {
    const last = this._pins
      ? this._settings.lastPin(this._currentWorkspaceId)
      : null;
    if (!last) {
      return null;
    }
    const tabWhen = (tabId && this._settings.lastActive(tabId)) ?? -Infinity;
    return last.when > tabWhen ? last.guid : null;
  },

  /**
   * Which of `ids` this device looked at most recently, or the first of them.
   *
   * When a tab was last active is device-local (spec §5.6), which is what
   * this question wants: switching back to a workspace lands where this
   * machine left it, and another machine's idea of where it was is not an
   * answer to it. The fallback is sibling order: the order the panel draws,
   * and the same order on every device.
   *
   * @param {string[]} ids Node ids in the order the panel draws them.
   * @returns {string|null}
   */
  _mostRecentlyActive(ids) {
    let best = null;
    let bestWhen = -Infinity;
    for (const id of ids) {
      const when = this._settings.lastActive(id) ?? -Infinity;
      if (when > bestWhen) {
        best = id;
        bestWhen = when;
      }
    }
    return best ?? ids[0] ?? null;
  },

  /**
   * Goes to `id`'s workspace because the user asked to: the switcher's own
   * action.
   *
   * Serialised against itself. A person can press two entries faster than a
   * switch completes, and two interleaved switches would each do half of
   * {@link _showWorkspace}'s work in the other's order.
   *
   * @param {string} id A workspace id.
   * @returns {Promise<boolean>} whether the window changed workspace.
   */
  async switchTo(id) {
    if (this._inMemory) {
      return null;
    }
    this._switching ??= new this._modules.SvalSerialQueue("workspace switch");
    return this._switching.run(() => this._switchToOnce(id));
  },

  /**
   * One switch, with {@link switchTo} holding the door.
   *
   * @param {string} id A workspace id.
   * @returns {Promise<boolean>} whether the window changed workspace.
   */
  async _switchToOnce(id) {
    const { closedWindowsDecided } = this._modules.SvalPanelModel;
    const { WORKSPACE } = this._modules.SvalTree;
    // A workspace a closed window may still delete is taken elsewhere
    // (`_takenElsewhere`), so the next `_resolveCurrentWorkspace` would move
    // this window off it again. The switch goes once that window has decided,
    // to the workspace if it is kept.
    await closedWindowsDecided(id);
    // The document as it is now: a workspace a pass brought in since the
    // last redraw is one to go to.
    const nodes = (await this._engine.tree()).nodes ?? {};
    if (nodes[id]?.kind !== WORKSPACE) {
      // A workspace another device closed between the menu being built and an
      // entry being pressed. A no-op and a redraw: the entry disappears, which
      // is the answer (spec §10.7). The window is already on a workspace that
      // exists, because the pass that took this one away moved it there.
      await this.refresh(nodes);
      return false;
    }
    const root = document.documentElement;
    // Nobody sees a hidden window fade, and its animations tick on a
    // throttled refresh driver (`InactiveRefreshDriverTimer`), which would
    // hold the switch.
    const fade =
      !document.hidden &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Before the switch sets the new tint, so that `sval-panel.css` blends
    // to it. Any other change of tint, as from the colour picker, is drawn
    // at once.
    root.toggleAttribute("data-sval-switching", fade);
    try {
      if (!(await this._showWorkspace(id))) {
        return false;
      }
      // From the document as the hand-over leaves it: `_nodes` is the tree of
      // the window's last redraw, which can predate the workspace's own nodes.
      await this.refresh();
      if (fade) {
        // The switch ends once the window shows the workspace as it stays:
        // whoever awaits it reads the tint blended in. The fade outlasts the
        // blend, which starts with the refresh.
        await Promise.allSettled(
          this._fadeInWorkspace().map(animation => animation.finished)
        );
      }
      return true;
    } finally {
      root.removeAttribute("data-sval-switching");
    }
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

  /**
   * Keeps this window on the one workspace it shows when something other than
   * Sval shows a tab a switch kept loaded and hid
   * (`SvalFirefox.hideForWorkspace`): a notification, a switch-to-tab result
   * or an extension selecting it, or an extension's `tabs.show`.
   *
   * A kept tab belongs to a workspace no window shows, because the window
   * that starts showing a workspace takes its kept tabs
   * (`SvalRestore.takeKept`). So a tab being selected takes this window to its
   * workspace through the switcher's own switch, and a tab shown without
   * being selected is hidden again. A tab of the workspace this window shows
   * is being shown by a hand-over, and is left to it, as is a selection a
   * later switch has replaced.
   *
   * The workspace is read from the document as it is now, inside the switch's
   * queue: a tab filed since the last redraw is where the document says.
   * Queued behind any switch, and so after the `TabShow` it is called from:
   * `showTab` forgets who hid the tab once that event is dispatched, and
   * would forget a hide made within it.
   *
   * @param {string} id The node id of the tab being shown.
   */
  _onKeptTabShown(id) {
    const tab = this._observer?.tabFor(id);
    if (!tab) {
      return;
    }
    const selected = tab === window.gBrowser.selectedTab;
    this._switching ??= new this._modules.SvalSerialQueue("workspace switch");
    this._switching
      .run(async () => {
        const nodes = (await this._engine.tree()).nodes ?? {};
        const workspace = this._modules.SvalTree.workspaceOfNode(nodes, id);
        if (!workspace || workspace === this._currentWorkspaceId) {
          return;
        }
        // A switch's own hand-over selects a kept tab of the workspace it
        // goes to, and a switch queued behind it has since selected another
        // tab: the window follows a selection only while it still stands.
        if (selected) {
          if (tab === window.gBrowser.selectedTab) {
            await this._switchToOnce(workspace);
          }
        } else if (
          !tab.closing &&
          !tab.hidden &&
          tab !== window.gBrowser.selectedTab
        ) {
          this._modules.SvalFirefox.hideForWorkspace(window, tab);
        }
      })
      .catch(err => {
        this._modules.SvalLog.error(
          `following a kept tab failed: ${this._modules.describeError(err)}`
        );
      });
  },
});
