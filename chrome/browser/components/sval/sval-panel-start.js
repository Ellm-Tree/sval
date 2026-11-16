/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Bringing the workspace panel up: on the profile's engine, with its sync
 * pass, restore and tab observer in order, or on a tree in memory for a
 * private or automated window, and trying again after a failed pass.
 *
 * `SvalWindow` loads this as a classic script after `sval-panel.js`; it adds
 * its methods to `SvalPanel`, whose state and helpers it shares.
 */

/* import-globals-from sval-panel.js */

Object.assign(SvalPanel, {
  /**
   * How long a device whose startup pass failed waits before its first retry.
   *
   * The same five seconds as `SvalTabs`' `DEFAULT_POLL_MS`, and for the same
   * reason: this is the clock a device runs when nothing local is happening,
   * and until the first pass succeeds it is the only clock there is.
   */
  _startRetryMs: 5000,

  /**
   * The longest a retry waits.
   *
   * **The wait doubles up to this and then holds**, because the two cases the
   * retry has to serve want opposite things. A cloud folder that needs a
   * minute to deliver a file is why the retry exists, and it wants the first
   * tries close together; a path that is permanently wrong, such as a folder
   * deleted or a volume never mounted, is served just as well by a try a
   * minute, and five seconds forever costs a disk hit every five seconds for
   * the life of the session. A minute's ceiling keeps the device looking
   * indefinitely, so a folder that comes back is still noticed without anyone
   * pressing anything.
   */
  _startRetryMaxMs: 60000,

  /** What the next retry will wait, in milliseconds. Doubles on each failure. */
  _startRetryWaitMs: null,

  /** The pending startup retry's timer, or null. */
  _startRetryTimer: null,

  /**
   * Says that startup did not finish, in the critical dialog (messages spec
   * §4). A sync key that cannot be read never gets here: the panel starts
   * without syncing and its indicator says so. Nothing tries startup again
   * after a throw (`_scheduleStartRetry` is for a failed pass), so the dialog
   * offers a restart.
   *
   * @param {Error} err What `_start` threw.
   */
  _startFailed(err) {
    this._modules.SvalLog.error(
      `the panel failed to start: ${this._modules.describeError(err)}`
    );
    this._modules.SvalCritical.show(window, {
      kind: "open",
      cause: this._localCause(err),
    });
    this.drawIndicator();
  },

  /**
   * Why this device's own copy failed (messages spec §4), from the error's
   * name and the free space on the profile's volume.
   *
   * @param {Error} err A failed pass's or startup's error.
   * @returns {string|null} A `SvalPanelModel.localCause`.
   */
  _localCause(err) {
    let free = Infinity;
    try {
      free = Services.dirsvc.get("ProfD", Ci.nsIFile).diskSpaceAvailable;
    } catch {
      // A volume that cannot say leaves the error's name to decide.
    }
    return this._modules.SvalPanelModel.localCause(err?.code ?? null, free);
  },

  /**
   * Starts the panel on a tree in memory: in a private window
   * (private-windows spec), or one a WebDriver client opened
   * (`SvalWebDriver`).
   *
   * The window shows one temporary workspace of its own tabs, on the
   * session's tree and settings, which hold everything in memory and cannot
   * write. Nothing of the profile's saved, synced state starts here: no
   * engine, no identity, no restore, no sync, no agents, no settings sync, no
   * push, and no record of which workspace the window shows. The tab strip
   * is hidden without persisting, so xulStore is not written either.
   *
   * @param {object} session `SvalPrivateSession`, or what
   *   `SvalWebDriver.sessionFor` answers.
   * @param {object} options
   * @param {boolean} options.isPrivate Whether the window is private.
   */
  async _startInMemory(session, { isPrivate }) {
    this._inMemory = true;
    this._isPrivate = isPrivate;
    this._hideTabStrip({ persist: false });
    // The same browser as any other window: the region and the hidden
    // entry points say nothing about what is browsed here.
    this._applyRegion();
    this._hideMozillaEntryPoints();
    const container = document.getElementById("sval-panel-container");
    if (!container) {
      throw new Error("panel container missing");
    }
    if (window.closed) {
      return;
    }
    // Registered before the session is joined, so a window that closes while
    // it starts still gives its workspace back.
    let forgetChanges = () => {};
    window.addEventListener(
      "unload",
      () => {
        // The observer's last flush settles first, so nothing it still has
        // queued lands after the workspace has gone. `detach` never rejects.
        // The session waits for it: this window's own callbacks stop running
        // once its document has gone, which the flush can outlast.
        const flushed = this._observer?.detach();
        forgetChanges();
        session
          .releaseWindow(window, { after: flushed })
          .catch(err =>
            this._modules.SvalLog.warn(
              `could not drop an in-memory window's workspace: ${this._modules.describeError(err)}`
            )
          );
      },
      { once: true }
    );
    // The profile's side and width are read only by the window that starts a session,
    // while the session's worker loads.
    const joined = await session.forWindow(window, {
      layout: () => this._profileLayout(),
    });
    if (window.closed) {
      return;
    }
    this._engine = joined.tree;
    this._settings = joined.settings;
    this._memoryNodeIds = joined.nodeIds;
    this._build(container);
    // Another window's change, such as a tab dragged out of this one, is
    // drawn here as it happens.
    forgetChanges = joined.tree.addChangeListener(() =>
      this._refreshIfChanged().catch(err =>
        this._modules.SvalLog.warn(
          `could not redraw after an in-memory change: ${this._modules.describeError(err)}`
        )
      )
    );
    this._applyPlacementOnceSidebarStarts();
    this._hideSwitcher();
    this.drawIndicator();
    // A profile whose windows are all private never reaches `_start`, and
    // private windows are where Kagi's header matters. Once per process.
    this._modules.SvalKagi.watchSearch(
      this._modules.SvalSettingsSync.searchService()
    );
    this._currentWorkspaceId = joined.workspaceId;
    this._modules.SvalDownloadWorkspaces.workspaceShown(window);
    await this._attachTabs();
    await this.refresh();
  },

  /**
   * Which side the profile's panel is on and how wide it is, read without
   * writing: the private path never opens `SvalLocalSettings`, which moves a
   * damaged file aside.
   *
   * @returns {Promise<{placement: string, panelWidth: number|null}>}
   */
  async _profileLayout() {
    let stored = null;
    try {
      stored = await IOUtils.readJSON(
        this._modules.SvalLocalSettings.profilePath()
      );
    } catch {}
    return this._modules.SvalLocalSettings.layoutOf(stored);
  },

  /**
   * Takes the switcher out of an in-memory window: it is where a saved
   * workspace is made, and this window's are never saved.
   */
  _hideSwitcher() {
    const { switcher } = this._els;
    switcher.hidden = true;
    // The bar holds the switcher and nothing else, and an empty bar would
    // still take a row of the panel.
    switcher.parentElement.hidden = true;
  },

  /**
   * Brings the panel up.
   *
   * **Only first run asks anything, and only on a fresh profile** (first-run
   * spec §3), from `_startFromSync`. Nothing else needs asking: there is one
   * storage location and it has a default (spec §6.4), so the document exists,
   * persists and is found without a decision from anyone.
   *
   * **The order is sync, adopt, restore, attach, and each step needs the one
   * before it.** The sync pass runs before anything is created, so a device
   * pointed at a folder a peer has already published to adopts that peer's
   * workspace instead of minting one of its own; creating first would leave
   * two devices holding two workspaces in one tree. Restore
   * runs before the observer attaches, so every tab it opens is already tagged
   * and the observer files no strays.
   */
  async _start() {
    // Every start decides first run afresh, and the sync key may change
    // before it does.
    this._modules.SvalEngine.pastFirstRun = false;
    // A window Sval opened for a workspace (spec §10.7) is told which one
    // through `SvalPanelModel.handWorkspaceTo`, and this is where that becomes
    // the window's own record of what it shows. First, before the sync pass
    // that can fail and return: a torn-off window whose pass failed still has
    // to be on the workspace it was torn off for when the pass next succeeds.
    // Nothing downstream needs a path of its own after this: a torn-off window
    // is a window that remembers a workspace, as one the session brought back
    // is.
    // A window opened for an agent wears the agent's band and hue from the
    // start; the rest of its marking needs the tree (`_applyAgentMarking`),
    // which also takes this away from a window that ends up the user's.
    if (this._modules.SvalPanelModel.isHandedToAgent(window)) {
      document.documentElement.setAttribute("data-sval-agent", "");
    }
    const handed = this._modules.SvalPanelModel.takeHandedWorkspace(window);
    if (handed) {
      this._rememberWorkspace(handed);
    }

    // **Read here, before anything else in this method can write it.** What
    // this window remembered on the way in is what tells a window Sval put on a
    // workspace (torn off, or brought back by the session with what it was
    // showing) from an ordinary new window, which remembers nothing. The sync
    // pass below redraws on its way out, a redraw resolves the workspace
    // through `_showWorkspace`, and `_showWorkspace` records it: read any later
    // and every window looks like one that remembered something.
    const remembered = this._rememberedWorkspaceId();
    this._madeWorkspaceId = this._madeWorkspaceRecord();

    // The footer is always on: it carries the feedback button as well as
    // the sync indicator, which `drawIndicator` shows or hides.
    this._els.footer.hidden = false;
    this._els.tree.hidden = false;
    this._els.header.hidden = false;

    const { SvalEngine, SvalIdentity } = this._modules;
    // The sync key is read before the first pass: a device with a shared
    // folder waits for that folder before it makes a first workspace, and it
    // can only wait for a folder it holds the key to. A key that cannot be
    // read starts the panel without sharing, and the panel says why.
    const [deviceId, localKey, sync] = await Promise.all([
      SvalIdentity.deviceId(),
      SvalIdentity.localKey(),
      SvalIdentity.syncKey(),
    ]);
    this._syncKeyState = sync.state;
    if (!this._syncKeyObserver) {
      this._syncKeyObserver = (subject, topic, state) =>
        this._onSyncKeyState(state);
      Services.obs.addObserver(
        this._syncKeyObserver,
        SvalIdentity.SYNC_KEY_STATE_TOPIC
      );
    }
    if (sync.reason) {
      this._modules.SvalLog.warn(`not syncing: ${sync.reason}`);
    }
    // Shared with every other window of this profile, because one profile is
    // one device and one device is one document. `SvalEngine.forProfile` carries
    // what a second engine for one device costs.
    this._engine = SvalEngine.forProfile({
      root: this._localRoot(),
      sharedRoot: this.sharedRootSetting(),
      localKey,
      syncKey: sync.bytes,
      deviceId,
    });
    this._listenToEngine();

    // Housekeeping, not a sync step: an abandoned pairing offer sits in the
    // shared folder until some device notices it is stale, and spec §6.7 bounds
    // that window at an hour. Startup is where it belongs: it happens on every
    // launch whether or not anyone opens settings, and it costs one directory
    // listing per launch rather than one per poll. It waits for the first
    // shared step that reaches the folder (`_onSharedStep`).
    this._sweepPending = true;

    // Agent access (agent-control spec §3.2). One listener per process, so
    // every window calls this and the first one starts it. Each window redraws
    // when an agent's workspace is added; `SvalAgents` runs the one pass that
    // publishes it, which every window draws through `_onPass`. Adopting a key
    // runs `_start` again, so the window's earlier listener goes first.
    const { AppConstants, askToPair, SvalAgents } = this._modules;
    SvalAgents.start({
      profileDir: PathUtils.profileDir,
      engine: this._engine,
      askToPair,
      version: AppConstants.MOZ_APP_VERSION_DISPLAY,
    });
    this._forgetAgentListener?.();
    this._forgetAgentListener = SvalAgents.addChangeListener(() =>
      this.refresh()
    );
    // An agent's tab rows say who has the workspace (agent-control spec §6).
    const { SvalAgentControl } = this._modules;
    this._forgetControlListener?.();
    const onControl = () => {
      if (this._agentLabel) {
        this.render();
      }
    };
    Services.obs.addObserver(onControl, SvalAgentControl.CONTROL_TOPIC);
    // Another device's agent workspace is labelled with that device's name.
    const { DEVICE_NAMES_TOPIC } = this._modules;
    Services.obs.addObserver(onControl, DEVICE_NAMES_TOPIC);
    this._forgetControlListener = () => {
      Services.obs.removeObserver(onControl, SvalAgentControl.CONTROL_TOPIC);
      Services.obs.removeObserver(onControl, DEVICE_NAMES_TOPIC);
    };

    // Before the first pass: a seed that lands after this device's first
    // publication is read by its peers as a deletion (settings-sync spec §2).
    // The documents are independent (spec §6), so settings sync that cannot
    // start costs the settings and never the tabs.
    try {
      await this._startSettingsSync(this._engine);
    } catch (err) {
      this._modules.SvalLog.warn(
        `settings sync did not start, and tab sync goes on: ${this._modules.SvalLog.errorName(err)}`
      );
    }
    // Not awaited: Favorites are the profile's from its engine's start, first
    // run included, so an import there lands in them (favorites-native spec
    // §5.1). Whatever writes them waits until they are read, and Favorites
    // that cannot start cost nothing else.
    this._startFavorites(this._engine).catch(err =>
      this._modules.SvalLog.warn(
        `favorites did not start, and tab sync goes on: ${this._modules.SvalLog.errorName(err)}`
      )
    );
    // Not awaited, for the same reasons: history begins past first run, and
    // history that cannot sync costs nothing else. Device names go through
    // the settings document, so they start once settings sync has.
    this._startHistorySync(this._engine).catch(err =>
      this._modules.SvalLog.warn(
        `history sync did not start, and tab sync goes on: ${this._modules.SvalLog.errorName(err)}`
      )
    );
    // Not awaited either: the archive begins past first run, and its sweep
    // waits for a pass (idle-tab archive spec §7.1).
    this._modules.SvalArchive.startFor(this._engine).catch(err =>
      this._modules.SvalLog.warn(
        `the archive did not start: ${this._modules.SvalLog.errorName(err)}`
      )
    );
    this._modules.SvalDeviceNames.startFor(this._engine).catch(err =>
      this._modules.SvalLog.warn(
        `device names did not start: ${this._modules.SvalLog.errorName(err)}`
      )
    );

    // Private windows sign in to Kagi whenever it is the engine, on every
    // launch (first-run spec §5). Once per process; nothing here waits on it.
    this._modules.SvalKagi.watchSearch(
      this._modules.SvalSettingsSync.searchService()
    );

    await this._startFromSync(remembered);
  },

  /**
   * Selects the pin a launch lands on once Favorites can say whether it
   * still shows in this workspace. A selection the user made meanwhile
   * stands.
   *
   * @param {string} guid
   * @param {object} landed The tab selected as the window's tabs were
   *   restored.
   */
  async _landOnPin(guid, landed) {
    try {
      await this._startFavorites(this._engine);
    } catch {
      // `_start` warned of this failure as it started Favorites.
      return;
    }
    await this._pins?.refresh();
    if (window.closed || window.gBrowser.selectedTab !== landed) {
      return;
    }
    const pin = this._pins?.pinOf(guid);
    if (pin) {
      this._pins.select(pin);
    }
  },

  /**
   * Starts the profile's Favorites over `engine`, once for the process as
   * settings sync is (`SvalFavoritesStore.startFor`).
   *
   * @param {SvalEngine} engine This profile's engine.
   */
  async _startFavorites(engine) {
    await this._modules.SvalFavoritesStore.startFor(engine);
  },

  /**
   * Starts history sync for `engine`, once for the process (history-sync
   * spec §4.1), as Favorites start.
   *
   * @param {SvalEngine} engine This profile's engine.
   */
  async _startHistorySync(engine) {
    await this._modules.SvalHistorySync.startFor(engine);
  },

  /**
   * Starts settings sync for `engine`. There is one instance for the process
   * (settings-sync spec §4.2), so every window calls this and the module
   * answers with the one that is running.
   *
   * @param {SvalEngine} engine This profile's engine.
   */
  async _startSettingsSync(engine) {
    const { SvalLog, SvalSettingsSync, ensureCard } = this._modules;
    // The user's card is made before settings sync starts, so sync takes it
    // as a value this device already held: written to the document only
    // where no other device's card is there, which is applied in its place
    // (settings-sync spec §4.2).
    try {
      await ensureCard();
    } catch (err) {
      SvalLog.warn(`the card could not be made: ${SvalLog.errorName(err)}`);
    }
    // The panel's own store, which also says whether first run is under way.
    await SvalSettingsSync.startFor(engine, { settings: this._settings });
  },

  /**
   * Everything after the engine exists: the pass that reads the document off
   * disk, and the workspace, restore and observer that depend on it.
   *
   * Separate from `_start` because **a failed pass has to be tried again
   * without the window being reopened.** Polling belongs to the tab observer,
   * and the observer only attaches once a pass has succeeded, so a device
   * whose first pass failed has no clock of its own at all, and a cloud folder
   * that has not finished downloading or a file briefly held open by another
   * process would leave it out of sync for the whole session with nothing on
   * screen to say so.
   *
   * @param {string|null} remembered The workspace this window arrived knowing
   *   about, read before anything could overwrite it. Carried across retries
   *   because a torn-off window whose first pass failed is still that window.
   * @returns {Promise<void>}
   */
  async _startFromSync(remembered) {
    const { SvalRestore } = this._modules;

    // The pass reads this device's copy out of the profile first (local-copy
    // spec §4.4), so a device with one draws its workspaces whether or not the
    // shared folder answers. It leaves the shared folder alone: what to ask of
    // the folder depends on what this pass finds in the document.
    let sharedFolder = this.sharedRootSetting();
    let synced;
    // This window's own pass, for first run's gate: `_lastPass` also takes
    // other windows' reports, and a second window's pass finds the file this
    // one's wrote.
    let ownPass = null;
    // A later window of the session draws what the engine holds and runs its
    // pass once it is drawn, because every window waits on its turn in the one
    // worker and a pass reads every document the profile syncs.
    const drawn = await this._drawFromEngine();
    if (drawn) {
      synced = true;
    } else if (sharedFolder) {
      synced = await this._syncPass({ interactive: true, shared: "skip" });
    } else {
      ownPass = await this.syncNow();
      synced = !!ownPass;
    }
    if (!synced) {
      // The pass failed, so this device cannot know whether the folder already
      // holds a workspace: an own file that exists but cannot be read yet is
      // ordinary in the cloud folders spec §6.4 is designed for. Creating one on
      // that ignorance is how two devices end up with two. `syncNow` has
      // already said what went wrong.
      this._scheduleStartRetry(remembered);
      return;
    }

    // First run asks here: after the pass, which says whether this profile is
    // new, and before anything can create a workspace (first-run spec §3.4).
    // It can choose a shared folder, so the folder is read again after it.
    if ((await this._maybeRunFirstRun(ownPass)) === "nested") {
      return;
    }
    this._modules.SvalEngine.pastFirstRun = true;
    sharedFolder = this.sharedRootSetting();
    this._reconcilePasswordManager();

    // A joining device whose pairing has not landed makes no workspace of its
    // own: pairing would publish it into the other device's document
    // (first-run spec §3.4). The claim that lands starts this again. It holds
    // before the folder wait below, because nothing the folder answers is used
    // while the claim is pending.
    if (
      this._modules.SvalFirstRun.pairing &&
      !this._modules.SvalPanelModel.workspaceIds(this._nodes).length
    ) {
      if (!this._heldByPairing) {
        this._heldByPairing = true;
        this._modules.SvalFirstRun.afterPairing(() => {
          this._heldByPairing = false;
          if (!window.closed) {
            this._startFromSync(this._rememberedWorkspaceId()).catch(err =>
              this._modules.SvalLog.warn(
                `startup after pairing failed: ${this._modules.SvalLog.errorName(err)}`
              )
            );
          }
        });
      }
      return;
    }

    if (sharedFolder) {
      const { SvalPanelModel } = this._modules;
      // A document with no workspace in it, pointed at a shared folder, cannot
      // know whether that folder holds one until it has answered (local-copy
      // spec §4.4). The profile file alone does not say: the first pass writes
      // it even for an empty document, so a second window, or a relaunch before
      // the folder answered, finds one. Creating a workspace on that ignorance
      // is how two devices end up with two, so it waits for the folder, and
      // waits as a failed pass does, silently, when it does not answer.
      // A device that holds no usable sync key cannot read the folder at all,
      // so there is nothing to wait for: it starts on its own workspaces, and
      // the panel says why it is not syncing.
      const canRead =
        this._syncKeyState ===
        this._modules.SvalIdentity.SYNC_KEY_STATES.present;
      if (canRead && !SvalPanelModel.workspaceIds(this._nodes).length) {
        if ((await this.syncWithFolder()) !== "reached") {
          this._scheduleStartRetry(remembered);
          return;
        }
      } else if (!drawn) {
        // The profile copy is enough to draw from. The folder gets its turn in
        // the background.
        await this._syncInBackground();
      }
    }
    // The folder answered, so the next failure is a new one and starts the
    // wait over. A device that reads its folder every launch but one must not
    // carry a minute's patience into the launch after it.
    this._startRetryWaitMs = null;

    // A window closed meanwhile, such as one closed over first run's dialog,
    // shows nothing, so it makes no workspace: the engine outlives it.
    if (window.closed) {
      return;
    }
    // Through the funnel like every other change of workspace, so the window's
    // record of what it shows is written even if everything after this fails.
    await this._showWorkspace(await this._adoptOrCreateWorkspace());
    // A launch lands where this device left the workspace, as a switch back
    // to it does (`_handOverWindow`): on the tab looked at last, or on a pin
    // looked at after it. The pin is chosen here, before selecting the tab
    // marks that tab as looked at.
    let pinGuid = null;
    const show = ids => {
      const target = this._mostRecentlyActive(ids);
      pinGuid = this._lastPinAfter(target);
      return target;
    };
    const restored = await SvalRestore.restoreOnce(window, {
      engine: this._engine,
      workspaceId: this._currentWorkspaceId,
      show,
    });
    let wanted = restored?.wanted ?? null;
    // Once a session, as the tree is first restored: the settings would
    // otherwise keep a mark for every agent tab ever closed.
    if (
      restored &&
      this._modules.SvalAgentControl.forgetGoneTabs(this._nodes)
    ) {
      this._settings.saveSoon();
    }
    // A popup (`toolbar.visible` false, as `BrowserDOMWindow` tells them
    // apart) shows the one page that opened it, such as an agent's sign-in
    // window, which `SvalAgentGate` hands the agent's workspace. Restoring the
    // workspace into it would bury that page among the workspace's tabs and
    // close it as an empty tab before it had loaded.
    if (
      !restored &&
      remembered &&
      remembered === this._currentWorkspaceId &&
      window.toolbar.visible
    ) {
      // `restoreOnce` belongs to the first window of a session, so that the
      // second window a user opens does not open the tree's tabs all over
      // again. A window that arrived already knowing its workspace is not that
      // window: it was opened *for* that workspace, and a torn-off window with
      // none of its workspace's tabs in it is a window showing nothing. It
      // therefore restores on its own behalf, which duplicates nothing:
      // `restore` matches by the node id a tab already carries, and no other
      // window shows this workspace (§10.7). It lands where this device left
      // the workspace, as a launch and a switch do.
      ({ wanted } = await SvalRestore.restore(window, {
        engine: this._engine,
        workspaceId: this._currentWorkspaceId,
        show,
      }));
    } else if (!restored && window.toolbar.visible) {
      // Any other new window lands on the workspace it took as a switch to it
      // does (decision 1997): on the tab this device last looked at there,
      // with the tabs another window kept loaded for it among the
      // workspace's own. Its startup tab goes once there is one of those to
      // show, and stays as the workspace's tab when the workspace has none.
      // A window holding only the tabs opened in it would also close with
      // the last of them, putting the user in another window's workspace
      // while this one still had tabs. A window that opened with a tab of the
      // tree already in it, one dragged out of another window
      // (`replaceTabWithWindow`), keeps that tab on screen.
      const startupTab = !this._modules.SvalTabs.nodeIdOf(
        window.gBrowser.selectedTab
      );
      ({ wanted } = await SvalRestore.restore(window, {
        engine: this._engine,
        workspaceId: this._currentWorkspaceId,
        show: startupTab ? show : undefined,
      }));
    }
    // User Timing marks are how a launch's milestones are timed: the Gecko
    // profiler shows them, and scripts/perf.sh reads them from the window.
    performance.mark("sval-tabs-restored");
    // A window that remembers a workspace holds the tabs the session brought
    // back for it, and lets go below of those its workspace does not hold.
    // Those are left unfiled until then, because one can carry the node of a
    // tab another window shows, which filing would copy.
    await this._attachTabs({ keep: remembered ? wanted : null });
    // A window that remembered a workspace it could not have, such as the
    // second of two windows a session saved on one workspace, was given
    // another one while nothing mirrored its strip, so the hand-over skipped
    // it. The session brought back the remembered workspace's tabs into this
    // window, and no row here draws them. The hand-over runs now that the
    // observer is attached: it materialises the adopted workspace and
    // releases the rest, which nobody left here to come back to.
    if (remembered && remembered !== this._currentWorkspaceId) {
      await this._handOverWindow(this._currentWorkspaceId, { hold: false });
    } else if (remembered && wanted && !window.closed) {
      // A window the session brought back on its own workspace can hold tabs
      // the tree has since moved to another workspace. They go as a move's
      // do, and the window showing that workspace, now or later, opens them.
      await this._observer?.releaseTabsOutside(wanted, { hold: false });
    }
    const landed = window.gBrowser.selectedTab;
    await this.refresh();
    if (pinGuid) {
      await this._landOnPin(pinGuid, landed);
    }
    performance.mark("sval-panel-ready");
    if (drawn) {
      // `_runPass` reports its own failure, and the observer's poll is the
      // clock from here. Kept, so that a test which gives the window another
      // engine can let this pass finish first.
      this._passAfterDrawing = this._syncInBackground();
    }
  },

  /**
   * Draws this window from the tree the profile's engine already holds, when
   * a pass has read the document off disk and it has a workspace to show.
   * A tree with none goes through the pass, which first run, pairing and the
   * shared folder's wait decide on.
   *
   * @returns {Promise<boolean>} whether the window was drawn.
   */
  async _drawFromEngine() {
    const { SvalPanelModel } = this._modules;
    if (!this._engine.hasRead(SvalPanelModel.SYNC_DOCUMENT)) {
      return false;
    }
    const nodes = (await this._engine.tree()).nodes ?? {};
    if (!SvalPanelModel.workspaceIds(nodes).length) {
      return false;
    }
    await this.refresh(nodes);
    return true;
  },

  /**
   * Arranges another go at startup for a device whose pass failed.
   *
   * **A transient failure must not be permanent.** The folders spec §6.4 is
   * designed for hand a device a directory that is not there yet, a file still
   * downloading, and a file another process has open for a moment; every one of
   * those reads as a failed pass and every one of them clears by itself. What
   * must not happen is no further pass for the rest of the session, because
   * the only clock that runs passes belongs to an observer that never
   * attached.
   *
   * Nothing is scheduled once the observer exists: from then on the observer's
   * poll is the clock, and two clocks would mean two passes where one would do.
   *
   * **The wait doubles to `_startRetryMaxMs` and holds there.** A folder that
   * is merely slow is served by the early tries; a folder that will never
   * answer is served by one try a minute, and the device goes on watching for
   * it indefinitely either way. See `_startRetryMaxMs`.
   *
   * @param {string|null} remembered Passed through to `_startFromSync`.
   */
  _scheduleStartRetry(remembered) {
    if (this._observer || this._startRetryTimer !== null) {
      return;
    }
    const wait = this._startRetryWaitMs ?? this._startRetryMs;
    this._startRetryWaitMs = Math.min(wait * 2, this._startRetryMaxMs);
    // The backoff is otherwise invisible: a device that has stopped trying and
    // one trying once a minute look the same.
    this._modules.SvalLog.debug(
      `retrying startup in ${wait}ms, then ${this._startRetryWaitMs}ms`
    );
    this._startRetryTimer = window.setTimeout(() => {
      this._startRetryTimer = null;
      this._startFromSync(remembered).catch(err =>
        this._modules.SvalLog.debug(
          `retrying startup failed: ${this._modules.describeError(err)}`
        )
      );
    }, wait);
  },

  /**
   * Starts mirroring this window's tab strip into the tree.
   *
   * Separate from `_start` because a window can acquire its workspace later
   * (a device whose sync pass failed gets one when the folder becomes readable,
   * or the user presses "New workspace"), at which point the tabs already open
   * have to start being tracked without the window being reopened.
   *
   * @param {object} [options]
   * @param {?string[]} [options.keep] As `SvalTabs.attach` takes it, for a
   *   caller that lets the rest go once this resolves.
   * @returns {Promise<void>}
   */
  async _attachTabs({ keep = null } = {}) {
    if (this._observer || !this._currentWorkspaceId) {
      return;
    }
    const { SvalTabs, SvalPanelModel } = this._modules;
    if (this._inMemory) {
      // No sync document, no flush and no poll: nothing here is ever written.
      // The debounce coalesces a burst of activity into one published file,
      // and nothing here is published, so a page's address and title reach
      // its row as they arrive.
      this._observer = await SvalTabs.attach(window, {
        engine: this._engine,
        workspaceId: this._currentWorkspaceId,
        nodeIds: this._memoryNodeIds,
        settings: this._settings,
        debounceMs: 0,
        pollMs: 0,
        onFlush: () => {},
        newTabParent: () => this._newTabParent(),
        onTreeChanged: nodes => this.refresh(nodes),
        onTabSelected: id => this._select(id),
        onTabIconChanged: id => this._paintTabIcon(id),
        onTabLoadChanged: id => this._paintTabLoaded(id),
        onTitleHeld: id => this._paintTabName(id),
        onTabHiddenChanged: () => this.render(),
        onTabSoundChanged: () => this._paintSound(),
      });
      const shown = this._observer.nodeIdFor(window.gBrowser.selectedTab);
      if (shown) {
        await this._select(shown);
      }
      return;
    }
    this._observer = await SvalTabs.attach(window, {
      engine: this._engine,
      workspaceId: this._currentWorkspaceId,
      keep,
      syncDocument: SvalPanelModel.SYNC_DOCUMENT,
      settings: this._settings,
      // There is always a root, so a burst of tab activity always ends in a
      // write. That write is what makes the tabs come back next launch, which is
      // why it is the same call whether or not the root is a shared folder.
      //
      // The observer's clock is also the poll: the same flush runs when
      // nothing local has happened, which is how a peer's change reaches this
      // window. It goes through `_passOnItsOwn` rather than straight to
      // the engine so that what a poll brings in is drawn: a change nobody
      // here made is the one the user has not been told about.
      onFlush: ({ idleWithinMs = 0 } = {}) =>
        this._passOnItsOwn({ idleWithinMs }),
      // Selection belongs to the panel, so where a new tab is filed is asked
      // of the panel per tab rather than fixed at attach time.
      newTabParent: () => this._newTabParent(),
      // What keeps the panel from being stale about its own window: a tab
      // opened, closed or dragged in the browser changes the tree, and the tree
      // is what the rows are drawn from.
      onTreeChanged: nodes => this.refresh(nodes),
      // The selection is the tab the user is viewing, so it follows the
      // browser's own tab selection rather than only the panel's clicks: a
      // workspace switch shows a tab without anyone clicking its row.
      onTabSelected: id => this._select(id),
      // A favicon arrives after the page does, and redrawing every row for it
      // would take focus from whichever one the user is on.
      onTabIconChanged: id => this._paintTabIcon(id),
      onTabLoadChanged: id => this._paintTabLoaded(id),
      onTitleHeld: id => this._paintTabName(id),
      // A tab an extension hid has no row, as in Firefox's tab strip, and
      // comes back when it is shown.
      onTabHiddenChanged: () => this.render(),
      onKeptTabShown: id => this._onKeptTabShown(id),
      onTabSoundChanged: () => this._paintSound(),
    });
    // A tab restored at launch was selected before the observer existed, so no
    // `TabSelect` will report it. Read what the window shows now.
    const shown = this._observer.nodeIdFor(window.gBrowser.selectedTab);
    if (shown) {
      await this._select(shown);
    }
    // A window opened from an isolated tab carries that tab's jar into a
    // window that may show another workspace, and no `TabOpen` reached the
    // observer for it.
    await this._observer.keepTabsInJar?.();
  },
});
