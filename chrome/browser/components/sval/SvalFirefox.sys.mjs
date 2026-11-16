/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The private parts of Firefox's tab code that Sval relies on, each named once.
 *
 * None of these is a public API. They are internals of `tabbrowser.js` and
 * `SessionStore.sys.mjs`, and an ESR rebase may rename or reshape any of them.
 * Reaching them only through here means a rebase that breaks one fails its
 * own test in `browser_sval_firefox.js` and is fixed in this one file.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
  TabStateCache: "resource:///modules/sessionstore/TabStateCache.sys.mjs",
  raceTimeout: "moz-src:///browser/components/sval/SvalTimeout.sys.mjs",
  webrtcUI: "resource:///modules/webrtcUI.sys.mjs",
});

/**
 * What `gBrowser.hideTab` records as having hidden a tab Sval keeps loaded
 * while its workspace is hidden. An extension that hides a tab is recorded
 * there by its id (`tabs.hide` in `ext-tabs.js`), which this cannot be.
 */
const HIDDEN_BY_WORKSPACE = "sval-workspace";

/**
 * What `gBrowser.hideTab` records as having hidden a tab whose node the
 * panel is about to delete, while its Undo message shows.
 */
const HIDDEN_BY_PENDING_DELETE = "sval-pending-delete";

/**
 * What Sval's own moves of a tab into or out of a split pass Firefox as their
 * metrics (`TabMetricsContext`), which the `TabMove` each raises carries as
 * `detail.telemetrySource`. It is how a move Sval made to show the tree's
 * splits is told from the user's, as a removal Sval made is told by its
 * `skipSessionStore`.
 */
const MOVED_BY_SVAL = Object.freeze({
  isUserTriggered: false,
  telemetrySource: "sval",
});

/**
 * The event a tab dispatches when its media changes: it started, paused or
 * stopped playing, as its page's `MediaController` reports.
 */
export const MEDIA_CHANGED_EVENT = "SvalMediaChanged";

/**
 * The tabs whose media the last press of a media button paused, which a
 * press of play brings back before any other paused media.
 */
const pausedBySval = new WeakSet();

/** `MediaController` -> the tab showing its page, for its events. */
const controllerTabs = new WeakMap();

/**
 * `MediaController` -> when it was last heard, in `Date.now()`
 * milliseconds, which picks the media the footer's controls act on.
 */
const lastHeard = new WeakMap();

/** How far the footer's back and forward seek. */
const SKIP_SECONDS = 10;

/**
 * The page's `MediaController` for `tab` (`browsingContext.mediaController`,
 * as the media keys use), watched so that each change of its playback
 * reaches the tab as {@link MEDIA_CHANGED_EVENT} at once. A new page can
 * bring a new controller, so it is looked up each time.
 *
 * @param {object} tab A Firefox tab.
 * @returns {?object}
 */
function controllerOf(tab) {
  const controller = tab.linkedBrowser?.browsingContext?.mediaController;
  if (!controller) {
    return null;
  }
  if (!controllerTabs.has(controller)) {
    const changed = () => {
      if (controller.isAudible) {
        lastHeard.set(controller, Date.now());
      }
      const owner = controllerTabs.get(controller);
      if (owner?.isConnected && !owner.closing) {
        owner.dispatchEvent(
          new owner.documentGlobal.CustomEvent(MEDIA_CHANGED_EVENT, {
            bubbles: true,
          })
        );
      }
    };
    for (const type of [
      "activated",
      "deactivated",
      "audiblechange",
      "playbackstatechange",
      "metadatachange",
      "supportedkeyschange",
    ]) {
      controller.addEventListener(type, changed);
    }
  }
  controllerTabs.set(controller, tab);
  if (controller.isAudible && !lastHeard.has(controller)) {
    lastHeard.set(controller, Date.now());
  }
  return controller;
}

/**
 * What one tab's media button offers: "pause" while its page's controlled
 * media is audible, "play" while that media is paused, "unmute" while the
 * tab is muted, "mute" while it makes sound no controller holds, such as Web
 * Audio, and null otherwise.
 *
 * Audible is read rather than `isPlaying`: `MediaStatusManager` takes a page's
 * declared Media Session state over what its media does
 * (`UpdateActualPlaybackState`), and a page can go on declaring "playing" for
 * seconds after its video paused. `isAudible` follows the media itself.
 *
 * @param {object} tab A Firefox tab.
 * @returns {"pause"|"play"|"mute"|"unmute"|null}
 */
function mediaOfTab(tab) {
  const controller = controllerOf(tab);
  if (controller?.isActive) {
    return controller.isAudible ? "pause" : "play";
  }
  if (tab.muted) {
    return "unmute";
  }
  return tab.soundPlaying ? "mute" : null;
}

/**
 * Whether {@link SvalFirefox.hideForWorkspace} is what last hid `tab`.
 *
 * @param {object} tab A Firefox tab.
 * @returns {boolean}
 */
function hiddenByWorkspace(tab) {
  return (
    lazy.SessionStore.getCustomTabValue(tab, "hiddenBy") === HIDDEN_BY_WORKSPACE
  );
}

/**
 * The root attribute of a window whose tabs Sval's panel shows, which
 * `TabBarVisibility.update` reads to keep the tab strip collapsed
 * ({@link SvalFirefox.hideTabStrip}).
 */
const TAB_STRIP_HIDDEN_ATTRIBUTE = "svaltabstriphidden";

export const SvalFirefox = {
  /**
   * Whether `tab` has never had its browser inserted. `_createLazyBrowser`
   * (`tabbrowser.js`) makes such a tab with no `linkedPanel` and a browser
   * whose properties are stubs; reading any property it does not stub inserts
   * the browser and starts a content process.
   *
   * @param {object} tab A Firefox tab.
   * @returns {boolean}
   */
  isLazy(tab) {
    return !tab.linkedPanel;
  },

  /**
   * The address a lazy tab is for, from the session store's lazy-tab state,
   * which is what `_createLazyBrowser`'s stubbed `currentURI` reads too.
   *
   * @param {object} tab A lazy tab.
   * @returns {string|null} the address, or null when the store holds none.
   */
  lazyUrl(tab) {
    return lazy.SessionStore.getLazyTabValue(tab, "url") || null;
  },

  /**
   * Whether an inserted tab is still restoring its session state. Its browser
   * reads `about:blank` then, whatever the tab is for.
   *
   * @param {object} tab A Firefox tab.
   * @returns {boolean}
   */
  isRestoring(tab) {
    return !!tab.linkedPanel && lazy.SessionStore.isTabRestoring(tab);
  },

  /**
   * Whether an inserted tab can go neither back nor forward. Never ask this of
   * a lazy tab: `canGoBack` is not one of the properties `_createLazyBrowser`
   * stubs, so reading it inserts the browser.
   *
   * @param {object} tab An inserted tab.
   * @returns {boolean}
   */
  hasNoHistory(tab) {
    const browser = tab.linkedBrowser;
    return !browser.canGoBack && !browser.canGoForward;
  },

  /**
   * Brings the session store's copy of an inserted tab's state up to date
   * (`gBrowser.prepareDiscardBrowser`), which is the step Firefox takes before
   * it unloads tabs (`explicitUnloadTabs`). The page reports what was typed
   * into it on a timer (`browser.sessionstore.interval`), so without this
   * {@link hasFormData} can answer from before the user's last keystrokes.
   *
   * The page's process answers, so a process stuck in a script would hold the
   * caller for as long as it is stuck: `TabStateFlusher.flush` has no bound
   * and resolves early only when the process crashes. The wait is bounded by
   * `dom.beforeunload_timeout_ms`, which is how long Firefox itself waits for
   * a page's process to say whether it may be unloaded (`permitUnload` in
   * `browser-custom-element.mjs`).
   *
   * @param {DOMWindow} window The tab's window.
   * @param {object} tab An inserted tab.
   * @returns {Promise<boolean>} whether the state was brought up to date in
   *   time.
   */
  async flushState(window, tab) {
    const flushed = await lazy.raceTimeout(
      window.gBrowser.prepareDiscardBrowser(tab).then(() => true),
      Services.prefs.getIntPref("dom.beforeunload_timeout_ms")
    );
    return flushed === true;
  },

  /**
   * Whether the page in an inserted tab says it may unload, asked as
   * `_mayDiscardBrowser` asks (`permitUnload("dontUnload")`) and waited for.
   * `MozBrowser.permitUnload` allows the unload once
   * `dom.beforeunload_timeout_ms` passes with no answer, so a page asking to
   * stay whose process answers late, as a background tab's may, would be
   * discarded with the work it asked to keep. Asked with no timeout of the
   * window global's own (`WindowGlobalParent::PermitUnload`), and a page
   * that has not answered within `waitMs` is answered no.
   *
   * @param {object} tab An inserted tab.
   * @param {number} waitMs How long to wait for the page.
   * @returns {Promise<boolean>}
   */
  async pageAllowsUnload(tab, waitMs) {
    const browser = tab.linkedBrowser;
    const global = browser?.browsingContext?.currentWindowGlobal;
    if (!browser?.isRemoteBrowser || !browser.hasBeforeUnload || !global) {
      return true;
    }
    try {
      const answer = await lazy.raceTimeout(
        global.permitUnload("dontUnload", 0),
        waitMs
      );
      return answer === true;
    } catch {
      return false;
    }
  },

  /**
   * Whether the user has typed into the page an inserted tab shows: the form
   * data the session store holds for it. The page collects that on each
   * `input` event (`SessionStoreChangeListener`), from every field that no
   * longer holds its default (`SessionStoreUtils::CollectFormData`), and the
   * store drops it when none does (`TabState.copyFromCache`). Read from
   * `TabStateCache` rather than `SessionStore.getTabState`, whose copy is
   * filtered by `browser.sessionstore.privacy_level` for what may be written
   * to disk.
   *
   * @param {object} tab An inserted tab.
   * @returns {boolean}
   */
  hasFormData(tab) {
    return !!lazy.TabStateCache.get(tab.linkedBrowser.permanentKey)?.formdata;
  },

  /**
   * Releases an inserted tab's content process and keeps the tab, even if it
   * is playing audio, unless the page would lose work by it
   * (`gBrowser.discardBrowser`, unforced). `_mayDiscardBrowser` then asks
   * `permitUnload("dontUnload")`, which refuses when the page's
   * `beforeunload` handler asks to stay after the user has interacted with it
   * (`dom.require_user_interaction_for_beforeunload`), and refuses while a
   * dialog is open in the tab.
   *
   * A tab already asking its page whether it may unload, as when the page's
   * `beforeunload` dialog is up for a close or a navigation, is refused too:
   * `permitUnload` throws for a second ask while one is running
   * (`MozBrowser.asyncPermitUnload`), and the first ask decides the page.
   *
   * @param {DOMWindow} window The tab's window.
   * @param {object} tab An inserted tab.
   * @returns {boolean} whether it was discarded.
   */
  discard(window, tab) {
    try {
      return window.gBrowser.discardBrowser(tab, false);
    } catch {
      return false;
    }
  },

  /**
   * Whether {@link discard} would release `tab`, asked without releasing it
   * (`gBrowser._mayDiscardBrowser`, which `discardBrowser` asks first).
   *
   * @param {DOMWindow} window The tab's window.
   * @param {object} tab An inserted tab.
   * @returns {boolean}
   */
  mayDiscard(window, tab) {
    try {
      return window.gBrowser._mayDiscardBrowser(tab, false);
    } catch {
      return false;
    }
  },

  /**
   * Inserts a lazy tab's browser (`gBrowser._insertBrowser`), which starts its
   * content process and hands the tab to session store to restore.
   *
   * @param {DOMWindow} window The tab's window.
   * @param {object} tab A lazy tab.
   */
  insertBrowser(window, tab) {
    window.gBrowser._insertBrowser(tab);
  },

  /**
   * Whether a key event must first go to the page in a remote browser, which
   * may consume it (`gBrowser._maybeRequestReplyFromRemoteContent`). When it
   * returns true the event comes back as a reply if the page leaves it, so
   * the caller acts only on that reply.
   *
   * @param {DOMWindow} window The event's window.
   * @param {KeyboardEvent} event
   * @returns {boolean}
   */
  awaitsPageReply(window, event) {
    return window.gBrowser._maybeRequestReplyFromRemoteContent(event);
  },

  /**
   * Whether an inserted tab is showing a video in picture-in-picture or is in
   * a call, the two kinds of tab Firefox never unloads to save memory
   * (`usingPictureInPicture` and `usingWebRTC` in `TabUnloader.sys.mjs`, which
   * this asks the same way). `discardBrowser` would end either:
   * `resetBrowserSharing` stops the camera and microphone, and the video's
   * window closes with its page.
   *
   * @param {object} tab An inserted tab.
   * @returns {boolean}
   */
  isInPictureInPictureOrCall(tab) {
    return !!tab.pictureinpicture || this.isInCall(tab);
  },

  /**
   * Whether `tab` is in a call: sharing the camera, the microphone or the
   * screen, or holding a peer connection open, as `usingWebRTC` in
   * `TabUnloader.sys.mjs` asks. A lazy tab has no page to be in one.
   *
   * @param {object} tab A Firefox tab.
   * @returns {boolean}
   */
  isInCall(tab) {
    if (this.isLazy(tab)) {
      return false;
    }
    const browser = tab.linkedBrowser;
    return (
      lazy.webrtcUI.browserHasStreams(browser) ||
      !!browser.browsingContext?.currentWindowGlobal?.hasActivePeerConnections()
    );
  },

  /**
   * Whether discarding an inserted tab would lose what it holds: what the
   * user typed ({@link hasFormData}, flushed first by the caller), or a
   * picture-in-picture video or a call ({@link isInPictureInPictureOrCall}).
   * Spec §10.7 keeps such a tab loaded, and so does Keep Awake
   * (`tab.undiscardable`).
   *
   * @param {object} tab An inserted tab.
   * @returns {boolean}
   */
  mustStayLoaded(tab) {
    return (
      tab.undiscardable ||
      this.hasFormData(tab) ||
      this.isInPictureInPictureOrCall(tab)
    );
  },

  /**
   * What the media button standing for `tabs` offers (spec §10.7), the same
   * for one tab as for a group or a workspace: "pause" while any of their
   * media is audible, then "play" while any is paused, then "mute" for sound
   * with nothing to pause, then "unmute".
   *
   * @param {object[]} tabs Firefox tabs.
   * @returns {"pause"|"play"|"mute"|"unmute"|null}
   */
  mediaActionOf(tabs) {
    const states = new Set(tabs.map(mediaOfTab));
    return ["pause", "play", "mute", "unmute"].find(s => states.has(s)) ?? null;
  },

  /**
   * The tabs a press of the media button for `tabs` acts on, each with the
   * state it is in. A pause quiets every tab making sound: its media is
   * paused, and sound with nothing to pause is muted. A play plays what the
   * last pause stopped, or every paused tab when it stopped none of them.
   *
   * @param {object[]} tabs Firefox tabs.
   * @returns {{action: ?string, targets: {tab: object, state: string}[]}}
   */
  mediaTargetsOf(tabs) {
    const action = this.mediaActionOf(tabs);
    const all = tabs.map(tab => ({ tab, state: mediaOfTab(tab) }));
    if (action === "play") {
      const paused = all.filter(({ state }) => state === "play");
      const ours = paused.filter(({ tab }) => pausedBySval.has(tab));
      return { action, targets: ours.length ? ours : paused };
    }
    const acted = action === "pause" ? ["pause", "mute"] : [action];
    return {
      action,
      targets: all.filter(({ state }) => acted.includes(state)),
    };
  },

  /**
   * What a tab plays, for the media button to name: its page's Media Session
   * title and artist, or the title Gecko gives media without one (the
   * page's, `MediaStatusManager::GetDefaultTitle`), or the tab's label for
   * sound no controller holds.
   *
   * @param {object} tab A Firefox tab.
   * @returns {string}
   */
  mediaNameOf(tab) {
    const controller = controllerOf(tab);
    if (controller?.isActive) {
      try {
        const { title, artist } = controller.getMetadata();
        if (title) {
          return artist ? `${title} by ${artist}` : title;
        }
      } catch {}
    }
    return tab.label;
  },

  /**
   * The tab whose media the footer's controls act on: of `tabs` whose page
   * holds media it has played with sound, one that is audible, or else the
   * one heard last. A page counts as holding media (`isActive`) before it
   * plays any, as a video site's does as it loads, so one never heard is
   * passed over, and so is a tab that is closing.
   *
   * @param {object[]} tabs Firefox tabs.
   * @returns {?object}
   */
  nowPlayingOf(tabs) {
    let best = null;
    let bestKey = null;
    for (const tab of tabs) {
      if (tab.closing) {
        continue;
      }
      const controller = controllerOf(tab);
      if (
        !controller?.isActive ||
        !(controller.isAudible || lastHeard.has(controller))
      ) {
        continue;
      }
      const key = [
        controller.isAudible ? 1 : 0,
        lastHeard.get(controller) ?? 0,
      ];
      if (
        !bestKey ||
        key[0] > bestKey[0] ||
        (key[0] === bestKey[0] && key[1] > bestKey[1])
      ) {
        best = tab;
        bestKey = key;
      }
    }
    return best;
  },

  /**
   * Whether the page in `tab` offers the previous or next track
   * (`supportedKeys`), as a playlist does.
   *
   * @param {object} tab A tab {@link nowPlayingOf} chose.
   * @param {"previous"|"next"} which
   * @returns {boolean}
   */
  hasTrack(tab, which) {
    const key = which === "previous" ? "previoustrack" : "nexttrack";
    return !!controllerOf(tab)?.supportedKeys.includes(key);
  },

  /**
   * Plays the previous or next track in `tab`.
   *
   * @param {object} tab A tab {@link nowPlayingOf} chose.
   * @param {"previous"|"next"} which
   */
  track(tab, which) {
    const controller = controllerOf(tab);
    if (which === "previous") {
      controller?.prevTrack();
    } else {
      controller?.nextTrack();
    }
  },

  /**
   * Seeks `tab`'s media {@link SKIP_SECONDS} back or forward, which Gecko
   * does for any media the page has no handler of its own for.
   *
   * @param {object} tab A tab {@link nowPlayingOf} chose.
   * @param {"back"|"forward"} direction
   */
  seek(tab, direction) {
    const controller = controllerOf(tab);
    if (direction === "back") {
      controller?.seekBackward(SKIP_SECONDS);
    } else {
      controller?.seekForward(SKIP_SECONDS);
    }
  },

  /**
   * Does what {@link mediaActionOf} offers for `tabs`, to the tabs
   * {@link mediaTargetsOf} names.
   *
   * @param {object[]} tabs Firefox tabs.
   */
  actOnMedia(tabs) {
    const { action, targets } = this.mediaTargetsOf(tabs);
    for (const { tab, state } of targets) {
      if (state === "pause") {
        pausedBySval.add(tab);
        controllerOf(tab).pause();
      } else if (state === "play") {
        pausedBySval.delete(tab);
        controllerOf(tab).play();
      } else if (state === "mute" || (action === "unmute" && tab.muted)) {
        tab.toggleMuteAudio();
      }
    }
  },

  /**
   * Takes a tab Sval keeps loaded while its workspace is hidden out of
   * everything that walks the window's tabs (`gBrowser.hideTab`), so it is
   * reached only from its own workspace. `hideTab` declines a tab that is
   * sharing the camera, the microphone or the screen, which stays where the
   * user can find it.
   *
   * @param {DOMWindow} window The tab's window.
   * @param {object} tab A Firefox tab, not the selected one.
   */
  hideForWorkspace(window, tab) {
    window.gBrowser.hideTab(tab, HIDDEN_BY_WORKSPACE);
  },

  /**
   * Whether `tab` is hidden by {@link hideForWorkspace}, rather than by an
   * extension or not at all.
   *
   * @param {object} tab A Firefox tab.
   * @returns {boolean}
   */
  isHiddenForWorkspace(tab) {
    return tab.hidden && hiddenByWorkspace(tab);
  },

  /**
   * Whether `tab`, hidden by {@link hideForWorkspace}, is being shown. Only
   * answers while its `TabShow` is dispatched: `showTab` forgets who hid a
   * tab after dispatching that event.
   *
   * @param {object} tab A Firefox tab.
   * @returns {boolean}
   */
  isShowingFromWorkspaceHide(tab) {
    return !tab.hidden && hiddenByWorkspace(tab);
  },

  /**
   * Takes a tab whose node is about to be deleted out of everything that
   * walks the window's tabs (`gBrowser.hideTab`), recorded apart from a
   * workspace's hide. `hideTab` declines the selected tab and a tab sharing
   * the camera, the microphone or the screen.
   *
   * @param {DOMWindow} window The tab's window.
   * @param {object} tab A Firefox tab.
   */
  hideForDelete(window, tab) {
    window.gBrowser.hideTab(tab, HIDDEN_BY_PENDING_DELETE);
  },

  /**
   * Whether `tab` is hidden by {@link hideForDelete}.
   *
   * @param {object} tab A Firefox tab.
   * @returns {boolean}
   */
  isHiddenForDelete(tab) {
    return (
      tab.hidden &&
      lazy.SessionStore.getCustomTabValue(tab, "hiddenBy") ===
        HIDDEN_BY_PENDING_DELETE
    );
  },

  /**
   * Releases the content process of a tab whose node is about to be deleted,
   * keeping the tab and its session history, so Undo can show it again
   * (`gBrowser.discardBrowser`, forced). The user has asked for the tab to
   * go, so nothing the page holds keeps it loaded: forcing skips the page's
   * `beforeunload` prompt and closes its dialogs, and the discard stops its
   * audio, its picture-in-picture video and its camera, microphone or screen
   * sharing (`resetBrowserSharing`). The session store's record is brought up
   * to date first ({@link flushState}), so text typed into the page comes
   * back with it.
   *
   * A lazy tab and a page in the parent process hold no content process, and
   * `_mayDiscardBrowser` refuses the selected tab, so each is left as it is.
   *
   * @param {DOMWindow} window The tab's window.
   * @param {object} tab A Firefox tab.
   * @returns {Promise<void>}
   */
  async unloadForDelete(window, tab) {
    if (this.isLazy(tab) || !tab.linkedBrowser?.isRemoteBrowser) {
      return;
    }
    await this.flushState(window, tab);
    if (tab.closing) {
      return;
    }
    try {
      window.gBrowser.discardBrowser(tab, true);
    } catch {}
  },

  /**
   * Moves a tab {@link hideForWorkspace} hid in another window into `window`,
   * page and all, as dragging a tab between windows does
   * (`gBrowser.adoptTab`). The tab arrives shown, and nothing hid it there.
   *
   * `swapBrowsersAndCloseOther` refuses a move between a private and a normal
   * window, between Fission and non-Fission windows, or between a remote and
   * a parent-process browser. None reaches here: only a normal window's tabs
   * carry the node id a kept tab is found by, every Sval window is opened
   * alike, and `adoptTab` makes the new tab with the old one's remote type.
   *
   * @param {DOMWindow} window The window to move it into.
   * @param {object} tab A tab of another window.
   */
  adoptKept(window, tab) {
    const moved = window.gBrowser.adoptTab(tab);
    lazy.SessionStore.deleteCustomTabValue(moved, "hiddenBy");
  },

  /**
   * Puts a tab {@link hideForWorkspace} hid back among the window's tabs.
   * Selecting it does the same (`updateCurrentBrowser`).
   *
   * @param {DOMWindow} window The tab's window.
   * @param {object} tab A Firefox tab.
   */
  showForWorkspace(window, tab) {
    window.gBrowser.showTab(tab);
  },

  /**
   * The window's splits, each as its tabs in pane order, in strip order
   * (`gBrowser.splitViews`). A tab closing is no longer one of them, and a
   * split Firefox has emptied and not yet removed (`MozTabSplitViewWrapper`'s
   * tab observer removes it) is none.
   *
   * @param {DOMWindow} window A chrome window.
   * @returns {object[][]}
   */
  splitsOf(window) {
    return window.gBrowser.splitViews
      .map(split => split.tabs.filter(tab => !tab.closing))
      .filter(tabs => tabs.length);
  },

  /**
   * The tabs of the split `tab` is in, in pane order.
   *
   * @param {object} tab A Firefox tab.
   * @returns {object[]|null} null when it is in none.
   */
  splitOf(tab) {
    return tab.splitview?.tabs ?? null;
  },

  /**
   * Shows `tabs` side by side as one split, where the first of them is
   * (`gBrowser.addTabSplitView`).
   *
   * @param {DOMWindow} window The tabs' window.
   * @param {object[]} tabs In pane order.
   */
  showSplit(window, tabs) {
    window.gBrowser.addTabSplitView(tabs, {
      insertBefore: tabs[0],
      metricsContext: MOVED_BY_SVAL,
    });
  },

  /**
   * Adds a pane showing Firefox's picker, `about:opentabs`, to the split the
   * selected tab is in, as its rightmost pane, and shows it: what Firefox's
   * add-split command does for a tab in no split (`BrowserCommands
   * .addTabSplitView`), for one already in a split. The pick then replaces it
   * as any picker's does (`MozTabSplitViewWrapper.replaceTab`), and the
   * window's tab observer writes the new pane as the user's act on the
   * split. The caller decides whether the split has room.
   *
   * @param {DOMWindow} window A browser window.
   * @returns {boolean} whether a pane was added: false when the selected tab
   *   is in no split.
   */
  addPickerPane(window) {
    const { gBrowser } = window;
    const split = gBrowser.selectedTab?.splitview;
    if (!split) {
      return false;
    }
    const picker = gBrowser.addTrustedTab("about:opentabs");
    split.addTabs([picker]);
    gBrowser.selectedTab = picker;
    return true;
  },

  /**
   * Takes every tab out of the split `tab` is in, leaving them in its place
   * in order, as the split's own `unsplitTabs` does, and leaves the split's
   * removal to the split. `unsplitTabs` also closes a pane showing the
   * picker, which is a tab with a node, so it is not called.
   *
   * @param {DOMWindow} window The tab's window.
   * @param {object} tab A tab in a split.
   */
  endSplit(window, tab) {
    const split = tab.splitview;
    if (!split) {
      return;
    }
    const { gBrowser } = window;
    for (const pane of split.tabs.toReversed()) {
      gBrowser.handleTabMove(
        pane,
        () =>
          gBrowser.tabContainer.insertBefore(pane, split.nextElementSibling),
        MOVED_BY_SVAL
      );
    }
  },

  /**
   * Puts `replacement` where `tab` is in its split, beside it, as the
   * picker's `replaceTab` does without closing `tab`
   * (`MozTabSplitViewWrapper.addTabs` with `indexOfReplacedTab`). Closing
   * `tab` afterwards leaves the split holding as many panes as before.
   *
   * @param {object} tab A tab in a split.
   * @param {object} replacement A tab of the same window, in no split.
   */
  replaceInSplit(tab, replacement) {
    const split = tab.splitview;
    split?.addTabs([replacement], {
      indexOfReplacedTab: split.tabs.indexOf(tab),
      metricsContext: MOVED_BY_SVAL,
    });
  },

  /**
   * Each of `tabs`' panel width on screen, in pane order, or 0 for a panel
   * not laid out.
   *
   * @param {DOMWindow} window The tabs' window.
   * @param {object[]} tabs A split's tabs.
   * @returns {number[]}
   */
  paneWidths(window, tabs) {
    return tabs.map(
      tab =>
        window.document.getElementById(tab.linkedPanel)?.getBoundingClientRect()
          .width ?? 0
    );
  },

  /**
   * Gives every panel of `tabs` but the last the width in `widths`, the way
   * Firefox's splitter sizes the panel before it (the panel's `width`
   * attribute and style, which `.split-view-panel[width]` reads), and lets
   * the last fill the rest. No widths gives every panel an equal share.
   *
   * @param {DOMWindow} window The tabs' window.
   * @param {object[]} tabs A split's tabs, in pane order.
   * @param {number[]|null} widths Pixels for each panel but the last.
   */
  setPaneWidths(window, tabs, widths) {
    tabs.forEach((tab, index) => {
      const panel = window.document.getElementById(tab.linkedPanel);
      const width = widths?.[index];
      if (!panel) {
        return;
      }
      if (width > 0) {
        panel.setAttribute("width", width);
        panel.style.setProperty("width", `${width}px`);
      } else {
        panel.removeAttribute("width");
        panel.style.removeProperty("width");
      }
    });
  },

  /**
   * Whether the user is dragging one of the window's splitters.
   *
   * @param {DOMWindow} window A chrome window.
   * @returns {boolean}
   */
  isDraggingSplitter(window) {
    return !!window.gBrowser.tabpanels.querySelector(
      ".split-view-splitter[state='dragging']"
    );
  },

  /**
   * Calls `onReleased` whenever the user lets go of a splitter between two
   * panes, or moves one from the keyboard: the splitter's `command`, which
   * `nsSplitterFrame` fires after a drag and after each key.
   *
   * @param {DOMWindow} window A chrome window.
   * @param {Function} onReleased
   * @returns {Function} stops listening.
   */
  watchSplitters(window, onReleased) {
    const { tabpanels } = window.gBrowser;
    const listener = event => {
      if (event.target.classList?.contains("split-view-splitter")) {
        onReleased();
      }
    };
    tabpanels.addEventListener("command", listener);
    return () => tabpanels.removeEventListener("command", listener);
  },

  /**
   * The tab in another window a `TabClose` hands its tab to, when the tab is
   * moving rather than closing (`detail.adoptedBy`, which
   * `ext-browser.js` reads the same way).
   *
   * @param {Event} event A `TabClose` event.
   * @returns {object|null}
   */
  adoptedBy(event) {
    return event.detail?.adoptedBy ?? null;
  },

  /**
   * Whether a `TabMove` is one Sval made into or out of a split
   * (`MOVED_BY_SVAL`), which `#handleTabMove` passes on in the event.
   *
   * @param {Event} event A `TabMove` event.
   * @returns {boolean}
   */
  movedBySval(event) {
    return event.detail?.telemetrySource === MOVED_BY_SVAL.telemetrySource;
  },

  /**
   * Whether a `TabClose` is a removal Firefox keeps out of the
   * recently-closed list: `removeTab`'s `skipSessionStore`, which
   * `_beginRemoveTab` passes on in the event and `SessionStore`'s own
   * `TabClose` handler reads the same way.
   *
   * @param {Event} event A `TabClose` event.
   * @returns {boolean}
   */
  skipsSessionStore(event) {
    return event.detail?.skipSessionStore === true;
  },

  /**
   * Whether a `TabClose` is the window's last tab taking the window with it,
   * under `browser.tabs.closeWindowWithLastTab`.
   *
   * Cmd/Ctrl+W on the only tab usually raises no `TabClose` at all:
   * `removeTab` asks `_beginRemoveTab` for its fast path, which closes the
   * window and returns first. The fast path is skipped while other tabs are
   * still animating closed, and then the last tab's `TabClose` is raised with
   * the window closing behind it. `_beginRemoveTab` leaves that decision on
   * the tab as `_endRemoveArgs[0]` before dispatching, for `_endRemoveTab` to
   * act on (`swapBrowsersAndCloseOther` reads it the same way). A last tab
   * closed with the window kept open (`closeWindowWithLastTab: false`) reads
   * false, because a blank tab replaces it and the window stays.
   *
   * @param {Event} event A `TabClose` event.
   * @returns {boolean}
   */
  closesWindow(event) {
    return event.target?._endRemoveArgs?.[0] === true;
  },

  /**
   * Takes Firefox's tab strip out of `win`.
   *
   * The window-level `setToolbarVisibility` (`browser.js`) persists the
   * collapse through `Services.xulStore.persist`, which
   * `XULPersist::ApplyPersistentAttributes` replays on every later window, so
   * on the second launch the strip is collapsed before this runs and never
   * flashes. It acts on this window only, where
   * `CustomizableUI.setToolbarVisibility` would act on every open one: a
   * private window keeps its strip (`SvalPanel.init`).
   *
   * The elements stay in the DOM because gBrowser's `<tab>` children are its
   * records of open browsers, and `tabbrowser.js` binds `tabContainer`
   * unconditionally.
   *
   * **That call alone does not hold.** `TabBarVisibility.update`
   * (`tabbrowser.js`) assigns `TabsToolbar.collapsed` on every tab open and
   * close, and for an ordinary window it decides the strip should show, so it
   * keeps the strip collapsed in a window whose root has
   * {@link TAB_STRIP_HIDDEN_ATTRIBUTE}. The launch test opens and closes a
   * tab, so a rename of that hook upstream fails it. The conditions under
   * which `update` hides the strip for Firefox (`sidebar.verticalTabs`,
   * `taskbartab`) each change more of the window than the strip.
   *
   * With a custom titlebar the strip also carries the window's own buttons
   * (close, minimise, zoom on macOS) in its `.titlebar-buttonbox-container`.
   * The nav-bar holds a second copy, which `browser-shared.css` shows only
   * when `#navigator-toolbox` has `tabs-hidden`, and the nav-bar only acts as
   * the titlebar when it has the `browser-titlebar` class. `update` sets both
   * for a window with the attribute, as for one whose strip it hides itself.
   *
   * @param {Window} win A browser window.
   * @param {object} [options]
   * @param {boolean} [options.persist] Whether the collapse is written to
   *   xulStore for later windows. A private window's is not.
   */
  hideTabStrip(win, { persist = true } = {}) {
    const doc = win.document;
    const toolbar = doc.getElementById("TabsToolbar");
    if (toolbar) {
      win.setToolbarVisibility(toolbar, false, persist);
    }
    doc.documentElement.setAttribute(TAB_STRIP_HIDDEN_ATTRIBUTE, "true");
    win.TabBarVisibility.update(true);
  },

  /**
   * Puts Firefox's tab strip back in `win`, for this window only: the
   * collapse other windows replay from xulStore stays.
   *
   * @param {Window} win A browser window.
   */
  showTabStrip(win) {
    const doc = win.document;
    doc.documentElement.removeAttribute(TAB_STRIP_HIDDEN_ATTRIBUTE);
    const toolbar = doc.getElementById("TabsToolbar");
    if (toolbar) {
      win.setToolbarVisibility(toolbar, true, false);
    }
    win.TabBarVisibility.update(true);
  },

  /**
   * Takes back the address bar's claim on a new tab's focus, and gives focus
   * to the tab's page instead.
   *
   * `openLinkIn` opens a new-tab page with `focusUrlBar`
   * (`URILoadingHelper.sys.mjs`), which `addTab` records as the browser's
   * `urlbarFocused` state (`UrlbarInput.getBrowserState`). The tab switch then
   * reads that state in `_adjustFocusAfterTabSwitch` and focuses the address
   * bar; with it cleared, the same switch leaves focus in the page. Focusing
   * the browser as well covers a switch that has already happened.
   *
   * @param {DOMWindow} window The browser's window.
   * @param {object} browser A `<browser>`.
   * @returns {boolean} whether the address bar had claimed focus.
   */
  focusPageNotUrlbar(window, browser) {
    const state = window.gURLBar.getBrowserState(browser);
    if (!state.urlbarFocused) {
      return false;
    }
    state.urlbarFocused = false;
    if (browser === window.gBrowser.selectedBrowser) {
      browser.focus();
    }
    return true;
  },
};
