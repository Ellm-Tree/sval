/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Sync passes and the footer's sync indicator (spec §3): running a pass,
 * hearing every window's passes through the engine, what the shared folder
 * last answered, the sync key's state, and save failures.
 *
 * `SvalWindow` loads this as a classic script after `sval-panel.js`; it adds
 * its methods to `SvalPanel`, whose state and helpers it shares.
 */

/* import-globals-from sval-panel.js */

Object.assign(SvalPanel, {
  /**
   * The pass a window drawn from the engine's tree runs once drawn
   * (`_drawFromEngine`), or null for a window whose startup ran its pass.
   */
  _passAfterDrawing: null,

  /** What `SvalIdentity.syncKey()` last answered: one of `SYNC_KEY_STATES`. */
  _syncKeyState: null,

  /** Hears every window's sync key state; see `_setSyncKeyState`. */
  _syncKeyObserver: null,

  /**
   * The state the sync indicator is drawn from, as JSON, or null before it is
   * drawn; see `drawIndicator`.
   */
  _shownIndicator: null,

  /** The indicator's actions as drawn, as JSON; see `drawIndicator`. */
  _shownIndicatorActions: null,

  /**
   * Hears what the profile's engine does for every window: shared steps,
   * passes and failed passes. A method so a test can attach a window to a
   * fixture's engine as `_start` attaches it to the profile's.
   */
  _listenToEngine() {
    // Made before this window's listeners are added, so the state has taken
    // a report by the time they run.
    this._modules.SvalSyncState.of(this._engine);
    // Background shared steps finish after the pass that started them, so
    // their outcome arrives here rather than as that pass's report.
    // Adopting a key runs `_start` again, so the earlier listener goes first.
    this._forgetSharedListener?.();
    this._forgetSharedListener = this._engine.addSharedListener(report =>
      this._onSharedStep(report)
    );
    // Every window's pass is every window's news: they share one document, and
    // a window whose idle poll found another window's pass just behind it runs
    // none of its own.
    this._forgetPassListener?.();
    this._forgetPassListener = this._engine.addPassListener(
      (report, origin) => {
        if (origin !== this) {
          this._onPass();
        }
      }
    );
    // A pass that failed to save this device's copy is every window's news
    // too: the window that ran it may not be the one the user is looking at
    // (messages spec §4).
    this._forgetFailureListener?.();
    this._forgetFailureListener = this._engine.addFailureListener(
      (err, origin) => {
        if (origin !== this) {
          this._saveFailed(err);
          this._drawSyncState();
        }
      }
    );
    window.addEventListener(
      "unload",
      () => {
        this._forgetSharedListener?.();
        this._forgetPassListener?.();
        this._forgetFailureListener?.();
      },
      { once: true }
    );
  },

  /**
   * A pass saved this device's copy, so a save failure the critical dialog
   * reports is over.
   */
  _savedAgain() {
    const { SvalCritical } = this._modules;
    if (SvalCritical.current(window)?.kind === "save") {
      SvalCritical.clear(window);
    }
  },

  /**
   * A pass could not save this device's copy. The dialog waits until saves
   * have failed for `SvalPanelModel.SAVE_FAILING_MS`, and a pass that
   * succeeds in that time cancels it.
   *
   * @param {Error} err What the pass rejected with.
   */
  _saveFailed(err) {
    if (
      this._modules.SvalPanelModel.saveFailureDue(
        this.syncState.saveFailingSince,
        Date.now()
      )
    ) {
      this._modules.SvalCritical.show(window, {
        kind: "save",
        cause: this._localCause(err),
        retry: () => this.syncNow(),
      });
    }
  },

  /** The footer's critical indicator brings its dialog back (spec §3). */
  _reopenCritical() {
    this._modules.SvalCritical.reopen(window);
  },

  /**
   * This device's own location: the profile (local-copy spec §4.1).
   *
   * @returns {string}
   */
  _localRoot() {
    return this._modules.SvalLocalSettings.localRoot();
  },

  /**
   * The shared folder the user chose, or null for none. A folder that is this
   * device's own location is none: the engine shares nowhere then, so there is
   * no other folder to wait for or to report on.
   *
   * @returns {string|null}
   */
  sharedRootSetting() {
    const chosen = this._settings.sharedFolder;
    if (chosen === null) {
      return null;
    }
    // Spelled by hand: `PathUtils.normalize` needs the path to exist, and the
    // chosen folder may be away.
    const spell = path => {
      const bare = path.replace(/[\\/]+$/, "");
      return this._modules.AppConstants.platform === "win"
        ? bare.toLowerCase()
        : bare;
    };
    return spell(chosen) === spell(this._localRoot()) ? null : chosen;
  },

  /**
   * Runs one sync pass and shows what it produced. Spec §6.4 requires a manual
   * pass and a last-synced time in v1 regardless of provider latency, and with
   * folder latency they matter more. The control that asks for a pass is
   * Sval's settings page's (spec §10.8), because the panel is a tab surface;
   * the state a pass leaves is the panel's indicator's (messages spec §3),
   * because a person must see it without going looking.
   *
   * A pass is also how the document is read off disk in the first place (the
   * worker starts with an empty one), so this runs at startup too, against the
   * profile directory when the user has chosen nothing else.
   *
   * The shared folder is not waited for: a due shared step starts in the
   * background and reports through `_onSharedStep`.
   *
   * @returns {Promise<?object>} the pass's report, or null when no pass ran
   *   and completed. `_start` reads this: a device that could not read the
   *   folder must not decide the folder holds no workspace and create one,
   *   and first run asks only on what this window's own pass found.
   */
  async syncNow() {
    return this._runPass({ interactive: true, shared: "background" });
  },

  /**
   * Asks the profile's engine to publish an edit made in this window soon,
   * joined with whatever else asks in the meantime (`SvalEngine.requestPass`).
   * A window on a tree in memory publishes nothing.
   */
  _publishSoon() {
    if (this._engine && !this._inMemory) {
      this._engine.requestPass();
    }
  },

  /**
   * The pass nobody asked for: the one the observer's clock runs when this
   * device has been idle, which is the only way a peer's change arrives.
   *
   * It redraws only when the document moved, so an idle window is as
   * still as it looks.
   *
   * The shared folder is not waited for: a due shared step starts in the
   * background and reports through `_onSharedStep`.
   *
   * @param {object} [options]
   * @param {number} [options.idleWithinMs] See `SvalEngine.sync`: nonzero for a
   *   poll that had nothing of this window's to publish.
   * @returns {Promise<boolean>} whether a pass ran and completed.
   */
  async _syncInBackground({ idleWithinMs = 0 } = {}) {
    return this._syncPass({
      interactive: false,
      shared: "background",
      idleWithinMs,
    });
  },

  /**
   * `_syncInBackground`, for a pass Sval runs on its own rather than for
   * something done in this window: the tab observer's debounce and poll.
   * `browser.sval.sync.background.enabled` off runs none of them, nor the
   * passes `SvalEngine.requestPass` is asked for, so the document, and the
   * windows drawn from it, move only when someone acts.
   *
   * @param {object} [options] See `_syncInBackground`.
   * @returns {Promise<boolean>} whether a pass ran and completed.
   */
  async _passOnItsOwn(options) {
    if (
      !Services.prefs.getBoolPref("browser.sval.sync.background.enabled", true)
    ) {
      return false;
    }
    return this._syncInBackground(options);
  },

  /**
   * A pass that waits for a shared step, whatever the interval: for the
   * places that must know what the folder said before they go on.
   *
   * @returns {Promise<string|null>} what the folder said: the report's
   *   `shared` ("reached", "unreachable", "too-large", "unknown", or "none"
   *   with no shared folder), or null when the pass itself failed. Callers that need the
   *   folder's answer require "reached". A step that reaches the folder has
   *   merged it into the document by the time this returns.
   */
  async syncWithFolder() {
    const report = await this._runPass({ interactive: true, shared: "wait" });
    if (!report) {
      return null;
    }
    return report.shared;
  },

  /**
   * What a background shared step found, when it finishes.
   *
   * @param {object} report A shared step's report (`sharedRan` is true).
   */
  _onSharedStep(report) {
    if (report.shared === "reached") {
      if (this._sweepPending) {
        this._sweepPending = false;
        this._sweepPairingOffers();
      }
      this._afterReachingFolder(report);
    }
    this._drawSyncState();
    this._refreshIfChanged().catch(err =>
      this._modules.SvalLog.warn(
        `could not redraw after a shared step: ${this._modules.describeError(err)}`
      )
    );
  },

  /**
   * A pass this window did not ask for: another window's, or the settings
   * page's. They share this profile's one document, so what it brought in is
   * drawn here as if this window had run it.
   */
  _onPass() {
    this._savedAgain();
    this._drawSyncState();
    this._refreshIfChanged().catch(err =>
      this._modules.SvalLog.warn(
        `could not redraw after another window's pass: ${this._modules.describeError(err)}`
      )
    );
  },

  /**
   * One sync pass, and what the panel shows for it.
   *
   * @param {object} options
   * @param {boolean} options.interactive Whether a person is waiting on this
   *   pass, which decides whether the rows are rebuilt unconditionally.
   * @param {string} options.shared How the pass treats the shared folder:
   *   "wait", "background" or "skip" (see `SvalEngine.sync`).
   * @param {number} [options.idleWithinMs] See `SvalEngine.sync`.
   * @returns {Promise<boolean>} whether a pass ran and completed.
   */
  async _syncPass({ interactive, shared, idleWithinMs = 0 }) {
    return (
      (await this._runPass({ interactive, shared, idleWithinMs })) !== null
    );
  },

  /**
   * `_syncPass`, answering with the pass's report.
   *
   * @param {object} options
   * @param {boolean} options.interactive See `_syncPass`.
   * @param {string} options.shared See `_syncPass`.
   * @param {number} [options.idleWithinMs] See `_syncPass`.
   * @returns {Promise<object|null>} the report, or null when the pass failed.
   *   An idle poll the engine skipped answers the last pass this window drew,
   *   which `_onPass` has already shown.
   */
  async _runPass({ interactive, shared, idleWithinMs = 0 }) {
    if (!this._engine || this._inMemory) {
      return null;
    }
    try {
      let report;
      try {
        report = await this._engine.sync(
          this._modules.SvalTree.SYNC_DOCUMENT,
          this._modules.SvalClock.now(),
          { shared, idleWithinMs, origin: this }
        );
      } catch (err) {
        // Only the pass's profile step saves this device's copy; a redraw
        // that fails below, or the pass's shared step, says nothing about
        // the profile. The engine's failure listener hears the same.
        if (!this._engine.failedInSharedStep(err)) {
          this._saveFailed(err);
        }
        throw err;
      }
      if (!report) {
        return this.syncState.lastPass;
      }
      this._savedAgain();
      if (interactive) {
        await this.refresh();
      } else {
        await this._refreshIfChanged();
      }
      return report;
    } catch (err) {
      // Only the profile can fail a pass. An unreachable shared folder is a
      // state, which `syncState` holds (local-copy spec §4.6). The engine's
      // wording is for the log (spec §10.7).
      this._modules.SvalLog.error(
        `a sync pass failed: ${this._modules.describeError(err)}`
      );
      return null;
    } finally {
      this._drawSyncState();
    }
  },

  /**
   * Records what the sync key's state is, in every window of this profile:
   * they share one engine, so a key this window put right is put right for
   * all of them, and each redraws its line.
   *
   * @param {string} state One of `SvalIdentity.SYNC_KEY_STATES`.
   */
  _setSyncKeyState(state) {
    Services.obs.notifyObservers(
      null,
      this._modules.SvalIdentity.SYNC_KEY_STATE_TOPIC,
      state
    );
  },

  /**
   * Takes a state another window, or this one, recorded.
   *
   * @param {string} state One of `SvalIdentity.SYNC_KEY_STATES`.
   */
  _onSyncKeyState(state) {
    if (state === this._syncKeyState) {
      return;
    }
    this._syncKeyState = state;
    this.drawIndicator();
  },

  /**
   * Reads the sync key again, for the indicator's Allow Access. Reading
   * is what lets the operating system show its own unlock prompt, when it has
   * one. A key that reads starts the shared passes without a restart.
   */
  async _retrySyncKey() {
    const { SvalIdentity, SvalLog, SvalSecretStore, describeError } =
      this._modules;
    SvalSecretStore.retry();
    let sync;
    try {
      sync = this._engine
        ? await SvalIdentity.useStoredSyncKey(this._engine)
        : await SvalIdentity.syncKey();
    } catch (err) {
      SvalLog.warn(`could not read the sync key: ${describeError(err)}`);
      return;
    }
    this._setSyncKeyState(sync.state);
    if (sync.state === SvalIdentity.SYNC_KEY_STATES.present && this._engine) {
      await this.syncNow();
      return;
    }
    if (sync.reason) {
      SvalLog.warn(`still not syncing: ${sync.reason}`);
    }
    this.drawIndicator();
  },

  /**
   * Redraws the sync indicator and tells whoever else shows sync state.
   *
   * Every pass comes through here (the one a person asked for and the one the
   * poll ran), so this raises `SvalPanelModel.SYNC_STATE_TOPIC` rather than
   * `syncNow`. The settings page shows the same last-synced time the
   * indicator does (spec §10.8), and would go stale while its reader watched
   * it if it redrew only for its own passes.
   */
  _drawSyncState() {
    this.drawIndicator();
    Services.obs.notifyObservers(
      window,
      this._modules.SvalPanelModel.SYNC_STATE_TOPIC
    );
  },

  /**
   * What `SvalPanelModel.syncIndicator` draws this window's indicator from.
   *
   * @returns {object}
   */
  indicatorState() {
    const { AppConstants, SvalPanelModel } = this._modules;
    const shared = this._inMemory ? null : this.sharedRootSetting();
    const sync = this.syncState;
    let kind = "normal";
    if (this._inMemory) {
      kind = this._isPrivate ? "private" : "automated";
    }
    return {
      window: kind,
      sharing: shared !== null,
      // A shared step has answered this launch, or the engine shares nowhere
      // because this device holds no sync key, and so has no step to wait on.
      firstPassDone:
        sync.folderState !== "none" || sync.lastPass?.shared === "none",
      folder: { problem: sync.folderProblem, since: sync.unreachableSince },
      lastSynced: sync.lastSynced,
      keyState: this._syncKeyState,
      platform: AppConstants.platform,
      // Only what was found in the folder now chosen: a list from a folder
      // since left says nothing about this one.
      unpairedDevice:
        shared !== null &&
        this._otherWorkspacesIn === shared &&
        !!this._otherWorkspaces.length,
      newerSchema: !!sync.lastPass?.schemaTooNew?.length,
      harmedByClock: [...new Set(sync.lastPass?.harmedByClock ?? [])].map(
        device => this._modules.SvalDeviceNames.nameOf(device)
      ),
      hasReading: this._modules.SvalClock.hasReading,
      critical: this._modules.SvalCritical.current(window),
      now: Date.now(),
      formatTime: SvalPanelModel.shortTime,
    };
  },

  /**
   * The sync state this window's indicator shows, which Settings › Sync reads
   * too, so its readout says what the footer does.
   *
   * @returns {object|null} `SvalPanelModel.syncIndicator`'s answer.
   */
  syncIndicator() {
    return this._modules.SvalPanelModel.syncIndicator(this.indicatorState());
  },

  /**
   * Draws the footer's sync indicator (spec §3) from `syncIndicator`.
   *
   * **A state already on screen touches no element.** The poll runs every
   * five seconds, and each write to the DOM dirties the frame and asks for a
   * paint whether or not anything changed.
   */
  drawIndicator() {
    if (!this._els?.syncRow) {
      return;
    }
    const state = this.syncIndicator();
    const key = JSON.stringify(state);
    if (key === this._shownIndicator) {
      return;
    }
    this._shownIndicator = key;
    const { syncRow, indicator, syncLabel, syncDetail, syncActions } =
      this._els;
    if (syncRow.hidden === !!state) {
      syncRow.hidden = !state;
    }
    if (!state) {
      return;
    }
    // Each part is written only when it differs, so a state whose tooltip
    // alone moved (the synced time) leaves the rest as it is.
    const set = (name, value) => {
      if (indicator.getAttribute(name) !== value) {
        indicator.setAttribute(name, value);
      }
    };
    set("data-state", state.state);
    set("data-severity", state.severity);
    set("data-icon", state.icon);
    set("title", state.tooltip);
    // A dismissed critical dialog has no actions: the indicator itself is
    // the way back to it (spec §3).
    set(
      "data-command",
      state.severity === "critical" ? "reopenCritical" : "openSyncSettings"
    );
    if (syncLabel.textContent !== state.label) {
      syncLabel.textContent = state.label;
    }
    const detail = state.detailShown ? state.detail : "";
    if (syncDetail.textContent !== detail) {
      syncDetail.textContent = detail;
    }
    if (syncDetail.hidden === !!detail) {
      syncDetail.hidden = !detail;
    }
    const actionsKey = JSON.stringify([state.actions, state.dismissible]);
    if (this._shownIndicatorActions === actionsKey) {
      return;
    }
    this._shownIndicatorActions = actionsKey;
    const buttons = state.actions.map((action, index) => {
      const button = this._html("button");
      button.setAttribute("data-command", action.command);
      // `syncIndicator` puts the action that dismisses a state last.
      if (state.dismissible && index === state.actions.length - 1) {
        button.className = "sval-sync-dismiss";
        button.setAttribute("aria-label", "Dismiss");
        button.title = "Dismiss";
      } else {
        button.className = "sval-sync-action";
        button.textContent = action.label;
      }
      return button;
    });
    syncActions.replaceChildren(...buttons);
  },

  async _flushSettings() {
    try {
      await this._settings.flush();
    } catch (err) {
      this._modules.SvalLog.warn(
        `writing device-local panel state failed: ${this._modules.describeError(err)}`
      );
    }
  },
});
