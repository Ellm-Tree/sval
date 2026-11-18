/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Sval's workspace panel: the part that needs a chrome window.
 *
 * This file is added to the tree whole, with no patch, so it costs nothing on
 * the annual ESR rebase (spec §8.5). Everything that can be decided without a
 * document (which rows the tree produces, each row's ARIA numbers, what a
 * keystroke means, how a sync report is worded) lives in
 * `SvalPanelModel.sys.mjs`, so that half is testable under xpcshell. What is
 * left here is elements, attributes, focus, and the calls into the engine.
 *
 * This file declares `SvalPanel` and the state its parts share. A part with a
 * job of its own is a script beside it, `sval-panel-<job>.js`, which
 * `SvalWindow` loads after this one and which adds its methods to
 * `SvalPanel`.
 *
 * A workspace exists from the end of the first launch's first run (first-run
 * spec §3.4), and from the first launch of any profile that skips it. First
 * run asks before the workspace exists because a joining device's workspaces
 * come from pairing; every answer it asks for has a default, and Skip setup
 * leaves it from any screen, so the browser is never long without somewhere
 * to put a tab.
 *
 * Where those workspaces are kept is an ordinary setting with a default (spec
 * §6.4): the profile directory until the user points it somewhere else.
 * Pointing it at a folder their other devices can also see is the whole of
 * turning sync on: there is no second store, no separate local path and no
 * switch, and Sval then keeps the two in step on its own.
 */

var SvalPanel = {
  _initialized: false,

  /**
   * Resolves when `init` has finished, whether it succeeded or not. A test
   * that needs the window's own panel out of its way has to know when startup
   * is done, and polling for a side effect of startup cannot tell "not yet"
   * from "never".
   */
  _started: Promise.withResolvers(),

  /** The panel's own elements, filled in by `_build`. */
  _els: null,

  /** A `SvalLocalSettings` store for this profile. */
  _settings: null,

  /**
   * A `SvalEngine`, or null before the panel has started. One exists with or
   * without a storage folder; only a sync pass needs the folder.
   */
  _engine: null,

  /** The `SvalTabObserver` watching this window, or null. */
  _observer: null,

  /** This window's pins row (`SvalPinsRow`), or null in a private window. */
  _pins: null,

  /**
   * The workspace **this window shows** (spec §10.7): the rows drawn are its
   * children, the switcher names it, and new tabs and groups are filed under
   * it. Null only while the document holds no workspace at all.
   *
   * It is device-local and per window, never in the synced document (spec
   * §5.6), and remembered through
   * `SessionStore.setCustomWindowValue(window, SvalPanelModel
   * .CURRENT_WORKSPACE_KEY, id)`, which is per window and survives a restart.
   *
   * The document Sval syncs is `SvalTree.SYNC_DOCUMENT`, one document
   * holding every workspace.
   */
  _currentWorkspaceId: null,

  /**
   * The workspace {@link _adoptOrCreateWorkspace} created for this window,
   * the one workspace its close may delete (decision 0101). A workspace the
   * user made, or one this window was handed, is theirs whatever it holds.
   * Kept in the session store under `SvalPanelModel.MADE_WORKSPACE_KEY`, so a
   * window the session brings back knows it too.
   */
  _madeWorkspaceId: null,

  /**
   * The document's `nodes` map as last read, without what waits on an Undo
   * message (`_viewOf`), and the rows drawn from it.
   */
  _nodes: {},
  _rows: [],

  /** The document's `nodes` map as last read, whole. */
  _treeNodes: {},

  /** The row the tree's focus sits on, as a node id. */
  _focusedId: null,

  /** Removes this window's agent-workspace listener, or null. */
  _forgetAgentListener: null,

  /**
   * The label of the agent whose workspace this window shows, or null when it
   * shows one of the user's (agent-control spec §6). Set by
   * {@link _renderSwitcher}, before the rows are drawn from it.
   */
  _agentLabel: null,

  /** The layer over this window's tabs while it shows an agent's workspace. */
  _agentMarking: null,

  /** Stops redrawing this window's rows when an agent tab changes hands. */
  _forgetControlListener: null,

  // ------------------------------------------------------------ the surface
  //
  // What modules outside the panel read of it. Each answers from the state
  // the panel's own parts keep, which only those parts write. The methods
  // they call are the parts' members without an underscore.

  /** Whether `init` has run in this window. */
  get initialized() {
    return this._initialized;
  },

  /** Resolves when `init` has finished, whether it succeeded or not. */
  get started() {
    return this._started.promise;
  },

  /** Whether the panel's frame is built, which a popup's never is. */
  get built() {
    return !!this._els;
  },

  /** `#sval-panel-container`, once the frame is built. */
  get container() {
    return this._els?.container;
  },

  /** The workspace this window shows, or null. */
  get workspaceId() {
    return this._currentWorkspaceId;
  },

  /** The document's `nodes` map as last read. */
  get nodes() {
    return this._nodes;
  },

  /** The window's engine, or the in-memory tree of a private window. */
  get engine() {
    return this._engine;
  },

  /** The `SvalTabObserver` watching this window, or null. */
  get observer() {
    return this._observer;
  },

  /** The window's `SvalLocalSettings` store. */
  get settings() {
    return this._settings;
  },

  /** This window's pins row, or null. */
  get pins() {
    return this._pins;
  },

  /** Whether the window's tree is in memory: a private or automated window. */
  get inMemory() {
    return this._inMemory;
  },

  /** Whether the window is private. */
  get isPrivate() {
    return this._isPrivate;
  },

  /** The id of the node a drag from this window's tree carries, if any. */
  get draggedId() {
    return this._drag?.from ? undefined : this._drag?.id;
  },

  /** The label of the agent whose workspace this window shows, or null. */
  get agentLabel() {
    return this._agentLabel;
  },

  /** The layer over this window's tabs while it shows an agent's workspace. */
  get agentMarking() {
    return this._agentMarking;
  },

  /**
   * What the passes of this window's engine have found, which every window
   * on that engine reads. A window with no engine, or on a tree in memory,
   * reads the state of an engine nothing has passed on.
   *
   * @returns {SvalSyncState}
   */
  get syncState() {
    const { SvalSyncState } = this._modules;
    return this._engine && !this._inMemory
      ? SvalSyncState.of(this._engine)
      : SvalSyncState.none;
  },

  async init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    // A private window, and a window a WebDriver client opened, get Sval's
    // panel like any other, on a tree that cannot be written anywhere
    // (private-windows spec, `SvalWebDriver`). Neither reaches `_start`.
    const isPrivate = window.PrivateBrowsingUtils.isWindowPrivate(window);
    const session = isPrivate
      ? this._modules.SvalPrivateSession
      : this._modules.SvalWebDriver.sessionFor(window);
    if (session) {
      try {
        await this._startInMemory(session, { isPrivate });
      } catch (err) {
        this._modules.SvalLog.error(
          `the in-memory panel could not start: ${this._modules.describeError(err)}`
        );
        this._showTabStripAfterFailure();
      } finally {
        this._started.resolve();
      }
      return;
    }

    // `_start` reads the profile's keys before it can make the engine, and the
    // worker's start does not need them, so it runs alongside those reads.
    this._modules.SvalEngine.prestart();
    this._hideTabStrip();
    this._applyRegion();
    this._hideMozillaEntryPoints();
    this._startPush();
    // A colour resolves to a value of each theme's own (yellow's tint), so
    // the home page hears a change of theme as it hears a recolour.
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", () =>
        Services.obs.notifyObservers(
          window,
          this._modules.SvalPanelModel.WINDOW_WORKSPACE_TOPIC
        )
      );

    const container = document.getElementById("sval-panel-container");
    if (!container) {
      this._modules.SvalLog.error(
        "panel container missing — the mount point patch did not apply"
      );
      this._started.resolve();
      return;
    }

    try {
      this._settings = await this._modules.SvalLocalSettings.openProfile();
      // Before anything can take or read an agent tab: agent access starts
      // in `_start`, and the layer is drawn on the first render.
      this._modules.SvalAgentControl.useSettings(this._settings);
      this._build(container);
      this._applyPlacementOnceSidebarStarts();
      await this._start();
      if (this._engine) {
        this._modules.SvalWebDriver.deleteLeftWorkspaces(
          this._settings,
          this._engine
        );
      }
    } catch (err) {
      this._startFailed(err);
    } finally {
      this._started.resolve();
    }
  },

  /**
   * Takes the region from the operating system (spec §10.9). A failure here
   * costs region-gated features, never the panel.
   */
  _applyRegion() {
    try {
      this._modules.SvalRegion.applyFromOperatingSystem();
    } catch (err) {
      this._modules.SvalLog.error(
        `could not take the region from the operating system: ${this._modules.describeError(err)}`
      );
    }
  },

  /**
   * Web Push connects only while some site may notify (spec §10.9). A failure
   * here leaves the connection off, which costs notifications, never the panel.
   */
  _startPush() {
    try {
      this._modules.SvalPush.start();
    } catch (err) {
      this._modules.SvalLog.error(
        `could not start the push connection gate: ${this._modules.describeError(err)}`
      );
    }
  },

  /**
   * Menu items that lead to Mozilla's services and have no switch of their own
   * (spec §10.9). `hidden` rather than CSS, because the macOS menu bar is
   * native and ignores stylesheets.
   */
  _hideMozillaEntryPoints() {
    for (const id of ["helpSwitchDevice", "feedbackPage"]) {
      const item = document.getElementById(id);
      if (item) {
        item.hidden = true;
      }
    }
  },

  /**
   * Takes Firefox's tab strip out of this window
   * (`SvalFirefox.hideTabStrip`).
   *
   * @param {object} [options]
   * @param {boolean} [options.persist] Whether the collapse is written to
   *   xulStore for later windows. A private window's is not.
   */
  _hideTabStrip({ persist = true } = {}) {
    this._modules.SvalFirefox.hideTabStrip(window, { persist });
  },

  /**
   * Puts Firefox's tab strip back in a private window whose panel failed to
   * start, so the window still shows its tabs. Not persisted, so Sval's other
   * windows keep theirs hidden.
   */
  _showTabStripAfterFailure() {
    this._modules.SvalFirefox.showTabStrip(window);
    document
      .getElementById("sval-panel-container")
      ?.toggleAttribute("hidden", true);
  },

  /**
   * Shows or hides the panel in this window: the header's panel toggle
   * (`SvalHeader`), which `sval-header.css` draws as on while the panel shows.
   * The panel slides over the page (`slide`).
   */
  toggleVisible() {
    const container = document.getElementById("sval-panel-container");
    if (!container) {
      return;
    }
    this._modules.slide(container, container.hasAttribute("sval-collapsed"));
  },

  /**
   * The panel toggle's key and its Workspaces menu item (`SvalMenuBar`):
   * shows the panel with focus on the row of the tab being viewed, which
   * always has one (`_revealSelection`), or hides it. Focus in the panel as
   * it hides goes to the page, so it is not left in a panel out of sight.
   */
  toggleFromKey() {
    const container = document.getElementById("sval-panel-container");
    if (!container || container.hidden) {
      return;
    }
    const show = container.hasAttribute("sval-collapsed");
    if (!show && container.contains(document.activeElement)) {
      window.gBrowser.selectedBrowser.focus();
    }
    this.toggleVisible();
    if (show) {
      this._focusRow(this._selectedId());
    }
  },

  /**
   * The modules this file reaches for. A lazy getter rather than top-level
   * imports because `sval-panel.js` is a classic script in the chrome window,
   * which has no static `import`; lazy so a window that never reaches the
   * panel does not pull in the engine's chrome-side module.
   */
  get _modules() {
    if (!this.__modules) {
      this.__modules = {};
      ChromeUtils.defineESModuleGetters(this.__modules, {
        shadeScrollEdges: "moz-src:///browser/components/sval/SvalDom.sys.mjs",
        askNewContainer:
          "moz-src:///browser/components/sval/SvalNewWorkspace.sys.mjs",
        AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
        openSvalDialog: "moz-src:///browser/components/sval/SvalDialog.sys.mjs",
        AgentWindowMarking:
          "moz-src:///browser/components/sval/SvalAgentMarking.sys.mjs",
        SvalAgents: "moz-src:///browser/components/sval/SvalAgents.sys.mjs",
        agentBrandOf:
          "moz-src:///browser/components/sval/SvalAgentBrands.sys.mjs",
        brandURL: "moz-src:///browser/components/sval/SvalAgentBrands.sys.mjs",
        modelBrandOf:
          "moz-src:///browser/components/sval/SvalAgentBrands.sys.mjs",
        chooseEmoji:
          "moz-src:///browser/components/sval/SvalEmojiPicker.sys.mjs",
        drawableEmojiGroups:
          "moz-src:///browser/components/sval/SvalEmojiPicker.sys.mjs",
        EMOJI_GROUPS:
          "moz-src:///browser/components/sval/SvalEmojiData.sys.mjs",
        SvalBlocking: "moz-src:///browser/components/sval/SvalBlocking.sys.mjs",
        SvalCritical: "moz-src:///browser/components/sval/SvalCritical.sys.mjs",
        SvalFeedbackForm:
          "moz-src:///browser/components/sval/SvalFeedbackForm.sys.mjs",
        LEVEL_PREF: "moz-src:///browser/components/sval/SvalBlocking.sys.mjs",
        SvalEngine: "moz-src:///browser/components/sval/SvalEngine.sys.mjs",
        TOP_DIR: "moz-src:///browser/components/sval/SvalEngine.sys.mjs",
        SvalFavorites:
          "moz-src:///browser/components/sval/SvalFavorites.sys.mjs",
        SvalFavoriteIcons:
          "moz-src:///browser/components/sval/SvalFavoriteIcons.sys.mjs",
        FAVORITE_ICONS_CHANGED_TOPIC:
          "moz-src:///browser/components/sval/SvalFavoriteIcons.sys.mjs",
        SvalFavoritesStore:
          "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
        FAVORITES_ROOT:
          "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
        SvalFavoritesMenu:
          "moz-src:///browser/components/sval/SvalFavoritesMenu.sys.mjs",
        SvalFavoritesView:
          "moz-src:///browser/components/sval/SvalFavoritesView.sys.mjs",
        canUnload: "moz-src:///browser/components/sval/SvalTabActions.sys.mjs",
        isKeptLoaded:
          "moz-src:///browser/components/sval/SvalTabActions.sys.mjs",
        setKeptLoaded:
          "moz-src:///browser/components/sval/SvalTabActions.sys.mjs",
        copyMarkdownLink:
          "moz-src:///browser/components/sval/SvalTabActions.sys.mjs",
        SvalSiteStylePanel:
          "moz-src:///browser/components/sval/SvalSiteStylePanel.sys.mjs",
        styleScopeOf:
          "moz-src:///browser/components/sval/SvalSiteStylePanel.sys.mjs",
        STYLE_KEY: "moz-src:///browser/components/sval/SvalKeys.sys.mjs",
        unloadTabs: "moz-src:///browser/components/sval/SvalTabActions.sys.mjs",
        ARCHIVE_TIMES: "moz-src:///browser/components/sval/SvalArchive.sys.mjs",
        AUTO_ARCHIVE_PREF:
          "moz-src:///browser/components/sval/SvalArchive.sys.mjs",
        NEVER: "moz-src:///browser/components/sval/SvalArchive.sys.mjs",
        choiceLabel: "moz-src:///browser/components/sval/SvalArchive.sys.mjs",
        SvalClock: "moz-src:///browser/components/sval/SvalClock.sys.mjs",
        SvalColor: "moz-src:///browser/components/sval/SvalColor.sys.mjs",
        SvalDeviceNames:
          "moz-src:///browser/components/sval/SvalDeviceNames.sys.mjs",
        SvalDownloadWorkspaces:
          "moz-src:///browser/components/sval/SvalDownloadWorkspaces.sys.mjs",
        DEVICE_NAMES_TOPIC:
          "moz-src:///browser/components/sval/SvalDeviceNames.sys.mjs",
        SvalFirefox: "moz-src:///browser/components/sval/SvalFirefox.sys.mjs",
        slide: "moz-src:///browser/components/sval/SvalHeader.sys.mjs",
        SvalPanelReveal:
          "moz-src:///browser/components/sval/SvalPanelReveal.sys.mjs",
        SvalFirstRun: "moz-src:///browser/components/sval/SvalFirstRun.sys.mjs",
        SvalFirstRunModel:
          "moz-src:///browser/components/sval/SvalFirstRunModel.sys.mjs",
        SvalIdentity: "moz-src:///browser/components/sval/SvalIdentity.sys.mjs",
        SvalSecretStore:
          "moz-src:///browser/components/sval/SvalSecretStore.sys.mjs",
        SvalSerialQueue:
          "moz-src:///browser/components/sval/SvalSerialQueue.sys.mjs",
        SvalBackupKey:
          "moz-src:///browser/components/sval/SvalBackupKey.sys.mjs",
        SvalICloudKeychain:
          "moz-src:///browser/components/sval/SvalICloudKeychain.sys.mjs",
        SvalHomePage: "moz-src:///browser/components/sval/SvalHomePage.sys.mjs",
        SvalKagi: "moz-src:///browser/components/sval/SvalKagi.sys.mjs",
        SvalPasswordManager:
          "moz-src:///browser/components/sval/SvalPasswordManager.sys.mjs",
        SvalPinsRow: "moz-src:///browser/components/sval/SvalPinsRow.sys.mjs",
        SvalFolderUpkeep:
          "moz-src:///browser/components/sval/SvalFolderUpkeep.sys.mjs",
        SvalScope: "moz-src:///browser/components/sval/SvalScope.sys.mjs",
        SvalSession: "moz-src:///browser/components/sval/SvalSession.sys.mjs",
        SvalSyncState:
          "moz-src:///browser/components/sval/SvalSyncState.sys.mjs",
        tidySeparators:
          "moz-src:///browser/components/sval/SvalPinsRow.sys.mjs",
        SvalLocalSettings:
          "moz-src:///browser/components/sval/SvalLocalSettings.sys.mjs",
        SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
        MENU_KEYS: "moz-src:///browser/components/sval/SvalKeys.sys.mjs",
        NEW_WORKSPACE_KEY:
          "moz-src:///browser/components/sval/SvalKeys.sys.mjs",
        SWIPE_WORKSPACES_PREF:
          "moz-src:///browser/components/sval/SvalKeys.sys.mjs",
        dropSide:
          "moz-src:///browser/components/sval/SvalFavoritesView.sys.mjs",
        showDropLine:
          "moz-src:///browser/components/sval/SvalFavoritesView.sys.mjs",
        keepKeyDescribed: "moz-src:///browser/components/sval/SvalKeys.sys.mjs",
        ariaShortcut: "moz-src:///browser/components/sval/SvalKeys.sys.mjs",
        shortcutText: "moz-src:///browser/components/sval/SvalKeys.sys.mjs",
        clickText: "moz-src:///browser/components/sval/SvalKeys.sys.mjs",
        describeError: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
        SvalKeyJoin: "moz-src:///browser/components/sval/SvalKeyJoin.sys.mjs",
        SvalPairing: "moz-src:///browser/components/sval/SvalPairing.sys.mjs",
        SvalPairingLook:
          "moz-src:///browser/components/sval/SvalPairing.sys.mjs",
        SvalPreferences:
          "moz-src:///browser/components/sval/SvalPreferences.sys.mjs",
        SvalPrivateSession:
          "moz-src:///browser/components/sval/SvalPrivateSession.sys.mjs",
        SvalPush: "moz-src:///browser/components/sval/SvalPush.sys.mjs",
        SvalRegion: "moz-src:///browser/components/sval/SvalRegion.sys.mjs",
        SvalRestore: "moz-src:///browser/components/sval/SvalRestore.sys.mjs",
        SvalSearchConfig:
          "moz-src:///browser/components/sval/SvalSearchConfig.sys.mjs",
        SvalSettingsSync:
          "moz-src:///browser/components/sval/SvalSettingsSync.sys.mjs",
        SvalTabs: "moz-src:///browser/components/sval/SvalTabs.sys.mjs",
        takeArcCard: "moz-src:///browser/components/sval/SvalCard.sys.mjs",
        latestNodes:
          "moz-src:///browser/components/sval/SvalTreeSnapshot.sys.mjs",
        SvalWebDriver:
          "moz-src:///browser/components/sval/SvalWebDriver.sys.mjs",
        SvalWorkspaceJar:
          "moz-src:///browser/components/sval/SvalWorkspaceJar.sys.mjs",
        BrowserWindowTracker:
          "resource:///modules/BrowserWindowTracker.sys.mjs",
        PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
        PrivateBrowsingUtils:
          "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
        SearchService:
          "moz-src:///toolkit/components/search/SearchService.sys.mjs",
        SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
        setTimeout: "resource://gre/modules/Timer.sys.mjs",
        ShellService:
          "moz-src:///browser/components/shell/ShellService.sys.mjs",
      });
      // `defineESModuleGetters` resolves each entry to the *export of that
      // name*, and `SvalPanelModel.sys.mjs` exports a set of functions rather
      // than one object of that name, so it is imported as a namespace
      // instead. Still lazily, for the same reason as the others.
      ChromeUtils.defineLazyGetter(this.__modules, "SvalPanelModel", () =>
        ChromeUtils.importESModule(
          "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
        )
      );
      ChromeUtils.defineLazyGetter(this.__modules, "SvalTree", () =>
        ChromeUtils.importESModule(
          "moz-src:///browser/components/sval/SvalTree.sys.mjs"
        )
      );
      ChromeUtils.defineLazyGetter(this.__modules, "SvalAgentControl", () =>
        ChromeUtils.importESModule(
          "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs"
        )
      );
    }
    return this.__modules;
  },

  // ---------------------------------------------------------------- structure

  /**
   * Builds the panel's frame once. Rows are rebuilt on every render; this is
   * not.
   *
   * The elements are HTML inside the XUL `vbox` the mount point provides,
   * because ARIA tree semantics are what spec §10.5 requires and a XUL
   * `richlistbox` announces as a list. It also keeps roving `tabindex`
   * ordinary: every XUL element carries `-moz-user-focus: ignore` from
   * `toolkit/content/xul.css`, which HTML children do not inherit.
   *
   * @param {Element} container `#sval-panel-container`.
   */
  _build(container) {
    const make = (tag, attrs = {}) => {
      const el = this._html(tag);
      for (const [name, value] of Object.entries(attrs)) {
        el.setAttribute(name, value);
      }
      return el;
    };

    this.dismissUndo();
    container.textContent = "";

    const root = make("div", { class: "sval-panel" });

    // A window shows one workspace and the switcher is how the user goes to
    // another (spec §10.7). It sits above the tree because it names what the
    // tree is: the rows below it are this workspace's children and nothing
    // else, so a person who cannot see which workspace they are in cannot
    // read the panel at all.
    //
    // `aria-haspopup="menu"` and a `<menupopup>` rather than a `<select>`:
    // the list has to be able to carry each workspace's colour and emoji
    // (§10.7), which a native dropdown cannot, and a XUL popup brings
    // keyboard navigation, dismissal and platform placement with it.
    const switcher = make("button", {
      class: "sval-switcher",
      "data-command": "switchWorkspace",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
    });
    const switcherBar = make("div", { class: "sval-switcher-bar" });
    // The strip of Workspaces stands in for the button when Settings ›
    // Workspaces picks it (`_applySwitcherKind`).
    const strip = this._buildStrip();
    switcherBar.append(switcher, strip);
    root.append(switcherBar);

    // Favorites sit directly under the workspace as a place of their own: a
    // favorite opens from any workspace (import spec §2), so it belongs to
    // none. A private window's panel has no Favorites, because nothing it
    // does may be kept.
    const favorites = make("button", {
      class: "sval-favorites",
      "data-command": "openFavorites",
      "aria-haspopup": "menu",
      "aria-expanded": "false",
    });
    const favoritesLabel = make("span", { class: "sval-label" });
    favoritesLabel.textContent = "Favorites";
    favorites.append(favoritesLabel);
    const favoritesBar = make("div", { class: "sval-favorites-bar" });
    favoritesBar.append(favorites);
    favoritesBar.hidden = this._inMemory;
    root.append(favoritesBar);

    // The pins sit under the workspace, which decides which of them show
    // (pins spec §4), and above the tabs. `SvalPinsRow` fills it.
    const pins = make("div");
    pins.hidden = true;
    root.append(pins);

    const header = make("div", { class: "sval-panel-header sval-edge-above" });
    const addTab = make("button", {
      class: "sval-newtab",
      "data-command": "addTab",
    });
    const addTabLabel = make("span", { class: "sval-label" });
    addTabLabel.textContent = "New tab";
    addTab.append(addTabLabel);
    this._modules.keepKeyDescribed(addTab, "key_newNavigatorTab", "New tab");
    // "New workspace" is not here: a workspace is made where workspaces are
    // chosen, the switcher (`_fillSwitcherMenu`).
    // Named in its tooltip as New tab is, which is all the 48px panel shows
    // of either name.
    const addGroup = make("button", {
      class: "sval-newtab is-folder",
      "data-command": "addGroup",
      title: "New group",
    });
    const addGroupLabel = make("span", { class: "sval-label" });
    addGroupLabel.textContent = "New group";
    addGroup.append(addGroupLabel);
    // New tab first: with Firefox's strip gone the panel is the only tab
    // surface, so the commonest act a tab surface has needs the first place in
    // it rather than only a keyboard shortcut.
    header.append(addTab, addGroup);

    // `aria-label` rather than a visible heading: the tree *is* the panel, and
    // a heading above it would cost every user a row of chrome to say so.
    // `_renderSwitcher` names it for the workspace it shows.
    // Several rows can be selected at once (spec §10.5).
    const tree = make("div", {
      class: "sval-tree",
      role: "tree",
      "aria-multiselectable": "true",
    });

    // Marks at the tree's two ends. While one is out of view, rows lie past
    // that edge, and the part across it casts a shadow over them.
    const topEdge = make("div", {
      class: "sval-tree-edge",
      "aria-hidden": "true",
    });
    const bottomEdge = make("div", {
      class: "sval-tree-edge",
      "aria-hidden": "true",
    });

    const footer = make("div", { class: "sval-panel-footer sval-edge-below" });
    // The sync indicator (spec §3) and the buttons its state asks for.
    // `drawIndicator` fills it, and hides the row with no folder chosen.
    const syncRow = make("div", { class: "sval-sync-row" });
    syncRow.hidden = true;
    const indicator = make("button", { class: "sval-sync-indicator" });
    // A polite status region, so a state that needs a label is announced
    // when it appears; `drawIndicator` leaves an unchanged one alone, so it
    // is said once.
    const syncLabel = make("span", {
      class: "sval-sync-label",
      role: "status",
      "aria-live": "polite",
    });
    indicator.append(
      make("span", { class: "sval-sync-icon", "aria-hidden": "true" }),
      syncLabel
    );
    // The detail a state shows under its label (`detailShown`).
    const syncDetail = make("p", { class: "sval-sync-detail" });
    syncDetail.hidden = true;
    const syncActions = make("span", { class: "sval-sync-actions" });
    syncRow.append(indicator, syncDetail, syncActions);
    // Send Feedback (feedback spec §2), across from the indicator and on its
    // own when no folder is chosen.
    const feedback = make("button", {
      class: "sval-feedback-button",
      "data-command": "toggleFeedback",
      title: "Send Feedback",
      "aria-label": "Send Feedback",
    });
    // The window's now-playing controls (spec §10.7), in the footer's
    // middle, drawn by `_paintMediaBar` and hidden while nothing has media.
    const mediaBar = make("div", {
      class: "sval-media-bar",
      role: "group",
      "aria-label": "Media",
    });
    mediaBar.hidden = true;
    for (const command of [
      "mediaPrevious",
      "mediaBack",
      "mediaToggle",
      "mediaForward",
      "mediaNext",
    ]) {
      mediaBar.append(
        make("button", { class: "sval-media-control", "data-command": command })
      );
    }
    footer.append(syncRow, mediaBar, feedback);

    const undoRegion = this._buildUndoRegion(make);
    root.append(header, tree, undoRegion, footer);
    container.append(root, this._buildResizer(container));

    // One marker for every between-rows drop, moved rather than re-made, and
    // kept after the last row by each render.
    const dropLine = make("div", {
      class: "sval-drop-line",
      "aria-hidden": "true",
    });
    dropLine.hidden = true;
    // The two halves a drop in a row's middle draws over the row, New group
    // then the split, and the bar a page reordered in its split draws between
    // tiles. Overlays, like the line, so no row moves under the pointer.
    const dropMark = make("div", {
      class: "sval-drop-mark",
      "aria-hidden": "true",
    });
    for (const half of ["group", "split"]) {
      const element = make("div", {
        class: "sval-drop-half",
        "data-half": half,
      });
      element.append(
        make("span", { class: "sval-drop-icon" }),
        make("span", { class: "sval-drop-label" })
      );
      dropMark.append(element);
    }
    dropMark.hidden = true;
    const dropBar = make("div", {
      class: "sval-drop-bar",
      "aria-hidden": "true",
    });
    dropBar.hidden = true;
    const dropAnnounce = make("div", {
      class: "sval-visually-hidden",
      "aria-live": "polite",
    });
    root.append(dropAnnounce);

    // A fresh footer has no indicator drawn, whatever the last one showed.
    this._shownIndicator = null;
    this._shownIndicatorActions = null;
    this._rowEls = new Map();
    this._els = {
      container,
      root,
      switcher,
      strip,
      favorites,
      favoritesBar,
      header,
      tree,
      topEdge,
      bottomEdge,
      dropLine,
      dropMark,
      dropBar,
      dropAnnounce,
      footer,
      mediaBar,
      undoRegion,
      syncRow,
      indicator,
      syncLabel,
      syncDetail,
      syncActions,
      pins,
    };
    this._applyPanelWidth();

    this._edgeObserver?.disconnect();
    this._edgeObserver = this._modules.shadeScrollEdges(tree, {
      topMarker: topEdge,
      bottomMarker: bottomEdge,
      top: header,
      bottom: footer,
    });

    tree.addEventListener("keydown", this);
    root.addEventListener("click", this);
    // Not passive: a gesture locked sideways holds the tree still
    // (`_onPanelWheel`).
    root.addEventListener("wheel", this, { passive: false });
    tree.addEventListener("dblclick", this);
    tree.addEventListener("contextmenu", this);
    switcher.addEventListener("contextmenu", this);
    switcher.addEventListener("keydown", this);
    for (const type of ["dragstart", "dragover", "dragleave", "drop"]) {
      tree.addEventListener(type, this);
    }
    window.addEventListener("unload", this, { once: true });

    // A row outlives renders, so a favicon cached after its row was built
    // reaches it here rather than through the next redraw.
    // What this build of the panel listens to, ended by the next build and
    // by the window going.
    this._listening?.end();
    const listening = this._modules.SvalScope.forWindow(window);
    this._listening = listening;
    const onFavicons = events => this._onFaviconsChanged(events);
    PlacesObservers.addListener(["favicon-changed"], onFavicons);
    listening.add(() =>
      PlacesObservers.removeListener(["favicon-changed"], onFavicons)
    );
    listening.topic(this._modules.SvalSyncState.CHANGED_TOPIC, () =>
      this.drawIndicator()
    );
    listening.topic(this._modules.FAVORITE_ICONS_CHANGED_TOPIC, () =>
      this._fillEmptyTabIcons()
    );

    // A private window shows no pins (pins spec §7).
    this._pins?.stop();
    this._pins = this._inMemory
      ? null
      : new this._modules.SvalPinsRow(window, this, pins);

    // The menus are parked in `#mainPopupSet`, outside the container this
    // empties, so each builder removes the one an earlier build parked: a
    // window keeps one of each, and an id names one element.
    this._els.contextMenu = this._buildContextMenu();
    this._els.workspaceMenu = this._buildWorkspaceMenu();
    this._els.switcherMenu = this._buildSwitcherMenu();
    this._els.favoritesMenu = this._buildFavoritesMenu(favoritesBar);

    // Settings › Workspaces picks the switcher and what the strip shows, and
    // every window follows as the choice is made.
    const { SWITCHER_PREF, STRIP_NAMES_PREF } = this._modules.SvalPanelModel;
    listening.pref(SWITCHER_PREF, () => this._applySwitcherKind());
    listening.pref(STRIP_NAMES_PREF, () => this._renderStrip());
    this._applySwitcherKind();
  },

  /**
   * @param {string} tag An HTML tag name.
   * @returns {Element} An HTML element.
   */
  _html(tag) {
    return document.createElementNS("http://www.w3.org/1999/xhtml", tag);
  },

  // ------------------------------------------------------------------- events

  handleEvent(event) {
    switch (event.type) {
      case "unload":
        // A workspace is this window's own to delete, if nobody touched it,
        // when this window created it and no other window shows it. A window
        // on a tree in memory writes nothing, and a popup shows its opener's
        // workspace (§10.7).
        if (this._observer) {
          const dropUntouched =
            !this._inMemory &&
            window.toolbar.visible &&
            this._currentWorkspaceId === this._madeWorkspaceId &&
            !this.workspacesShownElsewhere().has(this._currentWorkspaceId);
          const flushed = this._observer.detach({ dropUntouched });
          if (dropUntouched && this._currentWorkspaceId) {
            this._modules.SvalPanelModel.holdWhileClosing(
              this._currentWorkspaceId,
              flushed
            );
          }
        }
        if (this._startRetryTimer !== null) {
          window.clearTimeout(this._startRetryTimer);
          this._startRetryTimer = null;
        }
        this._forgetAgentListener?.();
        this._forgetControlListener?.();
        this._agentMarking?.destroy();
        break;
      case "keydown":
        if (event.currentTarget === window) {
          this._onSwitcherMenuKeyDown(event);
        } else if (event.currentTarget === this._els.switcher) {
          this._onSwitcherKeyDown(event);
        } else {
          this._onKeyDown(event);
        }
        break;
      case "mouseup":
        this._onSwitcherMouseUp(event);
        break;
      case "click":
        this._onClick(event);
        break;
      case "wheel":
        this._onPanelWheel(event);
        break;
      case "dblclick":
        this._onDoubleClick(event);
        break;
      case "contextmenu":
        this._onContextMenu(event);
        break;
      case "dragstart":
        this._onDragStart(event);
        break;
      case "dragover":
        this._onDragOver(event);
        break;
      case "dragleave":
        this._onDragLeave(event);
        break;
      case "drop":
        this._onDrop(event);
        break;
      case "dragend":
        this._endDrag();
        break;
      case "popupshowing":
        // Two popups, one listener object: the row menu and the switcher are
        // told apart by which of them the event came from, so neither ends up
        // reacting to the other's.
        if (event.target === this._els.switcherMenu) {
          this._onSwitcherShowing(event);
        } else if (event.target === this._els.workspaceMenu) {
          this._onWorkspaceMenuShowing();
        } else {
          this._onContextMenuShowing(event);
        }
        break;
      case "popuphidden":
        if (event.target === this._els.switcherMenu) {
          (this._switcherOpener ?? this._els.switcher).setAttribute(
            "aria-expanded",
            "false"
          );
          this._switcherOpener = null;
          this._els.switcherMenu.removeAttribute("sval-keys");
        }
        break;
      case "command":
        // `contains`, not a parent check: each switcher entry's submenu puts
        // "Open in New Window" one level down, and a parent check would send
        // its `command` to the row menu's handler.
        if (this._els.switcherMenu.contains(event.target)) {
          this._onSwitcherCommand(event);
        } else if (this._els.workspaceMenu.contains(event.target)) {
          this._onWorkspaceMenuCommand(event);
        } else {
          this._onContextMenuCommand(event);
        }
        break;
    }
  },
};
