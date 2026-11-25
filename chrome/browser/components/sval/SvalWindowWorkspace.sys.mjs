/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  CURRENT_WORKSPACE_KEY:
    "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
  MADE_WORKSPACE_KEY:
    "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
  SvalClock: "moz-src:///browser/components/sval/SvalClock.sys.mjs",
  SvalDownloadWorkspaces:
    "moz-src:///browser/components/sval/SvalDownloadWorkspaces.sys.mjs",
  SvalFirefox: "moz-src:///browser/components/sval/SvalFirefox.sys.mjs",
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  SvalRestore: "moz-src:///browser/components/sval/SvalRestore.sys.mjs",
  SvalSerialQueue: "moz-src:///browser/components/sval/SvalSerialQueue.sys.mjs",
  WORKSPACE: "moz-src:///browser/components/sval/SvalTree.sys.mjs",
  closedWindowsDecided:
    "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
  currentWorkspace: "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
  describeError: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  handWorkspaceTo: "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
  latestNodes: "moz-src:///browser/components/sval/SvalTreeSnapshot.sys.mjs",
  heldWhileClosing: "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
  pendingHandOffs: "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
  workspaceIds: "moz-src:///browser/components/sval/SvalTree.sys.mjs",
  workspaceOfNode: "moz-src:///browser/components/sval/SvalTree.sys.mjs",
});

/** Each window's workspace. */
const windows = new WeakMap();

/**
 * Which workspace a window shows (spec §10.7): the one it remembers, adopts
 * or makes, switching to another, handing the window's tabs over when the
 * workspace changes, what the session store remembers of it, and which
 * workspaces the other windows show.
 *
 * One per window, whether or not its panel has started: a window that shows
 * nothing yet answers null.
 */
export class SvalWindowWorkspace {
  #win;

  /** The workspace the window shows; see {@link id}. */
  #id = null;

  /** The workspace the window made for itself; see {@link madeId}. */
  #madeId = null;

  /** What the window's panel lends; see {@link attach}. */
  #host = null;

  /**
   * Serialises {@link switchTo} against itself, so two entries pressed in
   * quick succession switch one after the other, and with it everything else
   * that reads which workspace the window shows once a switch is over. A
   * `SvalSerialQueue`, made on first use.
   */
  #switching = null;

  /**
   * Serialises {@link handOver} against itself.
   *
   * `#switching` is not enough: {@link show} is also reached from
   * {@link resolve}, by way of the panel's redraw (the tab observer's
   * `onTreeChanged`, and the poll), and neither route passes through
   * `#switching`. So a peer taking away the workspace this window was showing
   * can start a hand-over while one is in flight, and two hand-overs with
   * different ideas of what to keep would leave the window holding the wrong
   * workspace's tabs. No node is at risk either way, because every release is
   * marked; what is at risk is what the window is showing.
   *
   * A `SvalSerialQueue`, made on first use. The tab observer's queue reaches
   * it through the redraw, so a hand-over waits for nothing on that queue.
   */
  #handingOver = null;

  /** How many hand-overs are queued or running; see {@link handingOver}. */
  #handOvers = 0;

  /**
   * Whether the window is on a tree in memory: a private window, or one a
   * WebDriver client opened. It has one temporary workspace no other window
   * can show, and nothing of it is recorded.
   */
  inMemory = false;

  /**
   * Whether the window is closing because every workspace has a window of
   * its own. Set before the close, so that no other window resolving at the
   * same moment counts this one as still showing anything.
   */
  closing = false;

  /**
   * @param {Window} win A chrome window.
   * @returns {SvalWindowWorkspace} `win`'s workspace.
   */
  static of(win) {
    let workspace = windows.get(win);
    if (!workspace) {
      workspace = new SvalWindowWorkspace(win);
      windows.set(win, workspace);
    }
    return workspace;
  }

  constructor(win) {
    this.#win = win;
  }

  /**
   * Takes what the window's panel lends: its data, read each time it is
   * wanted because the panel's start replaces it, and the three things only
   * a view can do.
   *
   * @param {object} host
   * @param {?SvalEngine} host.engine The profile's engine.
   * @param {object} host.settings The profile's `SvalLocalSettings` store.
   * @param {?SvalTabObserver} host.observer The window's tab observer.
   * @param {?SvalPinsRow} host.pins The window's pins row.
   * @param {object} host.nodes The document's nodes as the panel last drew
   *   them.
   * @param {(nodes?: object) => Promise<void>} host.redraw Redraws the panel,
   *   from `nodes` or from the engine's tree.
   * @param {() => Promise<*>} host.sync Runs a sync pass.
   * @param {() => void} host.shown Called as the window starts showing
   *   another workspace, before its tabs are handed over.
   * @param {() => Animation[]} host.fadeIn Fades the window in over the tint
   *   of the workspace switched to.
   */
  attach(host) {
    this.#host = host;
  }

  /** @returns {SvalSerialQueue} the switch's queue. */
  get #switchQueue() {
    this.#switching ??= new lazy.SvalSerialQueue("workspace switch");
    return this.#switching;
  }

  /**
   * @returns {Promise<void>} settles once no switch, and nothing else queued
   *   behind one, is under way.
   */
  switchesSettled() {
    return this.#switching?.idle() ?? Promise.resolve();
  }

  /**
   * @returns {Promise<void>} settles once no hand-over is under way.
   */
  handOversSettled() {
    return this.#handingOver?.idle() ?? Promise.resolve();
  }

  /**
   * The workspace the window shows: the rows drawn are its children, the
   * switcher names it, and new tabs and groups are filed under it. Null
   * while the window has not started, or the document holds no workspace.
   *
   * Device-local and per window (spec §5.6). It never reaches the engine,
   * because a window's attention is a fact about a machine and syncing it
   * would drag one device's onto another's.
   *
   * @returns {string|null}
   */
  get id() {
    return this.#id;
  }

  /**
   * The workspace the window created for itself, the one workspace its
   * close may delete (decision 0101). A workspace the user made, or one the
   * window was handed, is theirs whatever it holds.
   *
   * @returns {string|null}
   */
  get madeId() {
    return this.#madeId;
  }

  /**
   * Records `id` as the workspace the window shows, here and in the session
   * store.
   *
   * @param {string|null} id A workspace id, or null when the document holds
   *   no workspace at all.
   */
  setShown(id) {
    this.#id = id;
    this.remember(id);
    Services.obs.notifyObservers(this.#win, "sval-window-workspace-shown");
  }

  /**
   * The workspace the window last showed, as the session store holds it.
   *
   * Per window and persisted across a restart, which is what §10.7 asks of a
   * torn-off window, and what `SvalLocalSettings` cannot give, being per
   * profile and unable to tell two windows apart.
   *
   * A window the session store is not tracking throws
   * (`SessionStore.sys.mjs`'s `getCustomWindowValue`), which is a window that
   * has nothing remembered: the same case as a brand new one.
   *
   * @returns {string|null} a node id, or null when nothing is remembered.
   */
  remembered() {
    return this.#read(
      lazy.CURRENT_WORKSPACE_KEY,
      "could not read which workspace this window shows"
    );
  }

  /**
   * Writes the session store's record of the workspace the window shows.
   * Apart from {@link setShown}, a window claims a workspace this way before
   * it shows it, so that no window starting meanwhile takes it
   * ({@link shownElsewhere}).
   *
   * @param {string|null} id A workspace id, or null to remember nothing.
   */
  remember(id) {
    if (this.inMemory) {
      return;
    }
    // The store holds strings only, and `getCustomWindowValue` reads an
    // absent key as `""`, so the empty string is "nothing remembered".
    this.#write(
      lazy.CURRENT_WORKSPACE_KEY,
      id ?? "",
      "could not record which workspace this window shows"
    );
  }

  /**
   * Reads the workspace the window made for itself back from the session
   * store, which is how a window the session brings back knows it.
   */
  restoreMade() {
    this.#madeId = this.#read(
      lazy.MADE_WORKSPACE_KEY,
      "could not read which workspace this window made"
    );
  }

  /**
   * Records `id` as the workspace the window created for itself, here and
   * in the session store.
   *
   * @param {string} id
   */
  recordMade(id) {
    this.#madeId = id;
    this.#write(
      lazy.MADE_WORKSPACE_KEY,
      id,
      "could not record which workspace this window made"
    );
  }

  /**
   * @param {string} key One of the window's session-store keys.
   * @param {string} failure What to log when the store does not answer.
   * @returns {string|null}
   */
  #read(key, failure) {
    try {
      return lazy.SessionStore.getCustomWindowValue(this.#win, key) || null;
    } catch (err) {
      lazy.SvalLog.warn(`${failure}: ${lazy.describeError(err)}`);
      return null;
    }
  }

  /**
   * @param {string} key One of the window's session-store keys.
   * @param {string} value
   * @param {string} failure What to log when the store refuses.
   */
  #write(key, value, failure) {
    try {
      lazy.SessionStore.setCustomWindowValue(this.#win, key, value);
    } catch (err) {
      lazy.SvalLog.warn(`${failure}: ${lazy.describeError(err)}`);
    }
  }

  /**
   * The workspaces other windows show, each with the window showing it.
   *
   * A workspace has one window (spec §10.7). Every other full, non-private
   * browser window counts: by what it shows, or, before its panel has
   * started, by what it was handed (`SvalPanelModel.handWorkspaceTo`) or what
   * the session remembers for it, so a window still starting keeps its claim
   * against one that starts first.
   *
   * A popup a page opened neither counts nor is held to the rule. It shows
   * the page that opened it and closes with it, and an agent's sign-in popup
   * is handed the agent's workspace on purpose (`SvalAgentGate`). A private
   * window has its own temporary workspace, which no other window can show.
   *
   * @returns {Map<string, Window>} workspace id to the window showing it.
   */
  shownElsewhere() {
    const shown = new Map();
    if (this.inMemory || !this.#win.toolbar.visible) {
      return shown;
    }
    const counts = win =>
      win !== this.#win &&
      !win.closed &&
      !SvalWindowWorkspace.of(win).closing &&
      win.toolbar?.visible &&
      !lazy.PrivateBrowsingUtils.isWindowPrivate(win);
    for (const [win, id] of lazy.pendingHandOffs()) {
      if (counts(win)) {
        shown.set(id, win);
      }
    }
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (!counts(win)) {
        continue;
      }
      let id = SvalWindowWorkspace.of(win).id;
      if (!id) {
        try {
          id = lazy.SessionStore.getCustomWindowValue(
            win,
            lazy.CURRENT_WORKSPACE_KEY
          );
        } catch {
          // Not tracked by the session store yet: it remembers nothing.
        }
      }
      if (id && !shown.has(id)) {
        shown.set(id, win);
      }
    }
    return shown;
  }

  /**
   * The workspaces the window may not take: those {@link shownElsewhere}
   * names, and those a closed window may still delete
   * (`SvalPanelModel.holdWhileClosing`).
   *
   * @returns {Set<string>} workspace ids.
   */
  takenElsewhere() {
    const taken = lazy.heldWhileClosing();
    for (const id of this.shownElsewhere().keys()) {
      taken.add(id);
    }
    return taken;
  }

  /**
   * The workspace this window files things under: the one already in the
   * document if there is one, otherwise a new one with no name.
   *
   * **Adoption is tried first, and it is what makes a second device work at
   * all.** The panel's start syncs before calling this when a folder is
   * configured, so the nodes are the merged tree: a device pointed at a
   * folder a peer has published to joins that peer's workspace and creates
   * nothing. `SvalPanelModel.currentWorkspace` decides which: what this
   * window last showed if the document still holds it, otherwise the first
   * in sibling order, which is the same one on every device because sibling
   * order is the shared fractional index. Never one another window shows
   * (spec §10.7).
   *
   * With no workspace left for this window (none anywhere, or every one
   * shown by a window of its own, as when the user opens a new window), one
   * is created **with an empty name**. A workspace has to exist for this
   * window to have anywhere to put a tab, and it cannot wait on an answer. A
   * name travels to every device its owner has and stays in their data
   * permanently, so the document carries only names its owner typed; a
   * nameless row draws a placeholder, which is a label in this window and
   * not a value anywhere.
   *
   * @returns {Promise<string>} a workspace id present in the document.
   */
  async adoptOrCreate() {
    if (this.inMemory) {
      return this.#id;
    }
    const adopted = lazy.currentWorkspace(
      this.#host.nodes,
      this.remembered(),
      this.takenElsewhere()
    );
    return adopted ?? this.createOwn(null);
  }

  /**
   * Creates the workspace this window files things under, with the name
   * `made` gives it, or with no name (see {@link adoptOrCreate}). The
   * workspace and its look are one batch, so it reaches other devices whole.
   *
   * The id is minted here and the timestamp read here, because the engine
   * does neither (host contract §3).
   *
   * @param {?{name: string}} made What the user chose, or null.
   * @param {(id: string) => object[]} [lookOps] The operations that give
   *   the workspace the look the user chose.
   * @returns {Promise<string>} the workspace's id.
   */
  async createOwn(made, lookOps = () => []) {
    const { engine, settings } = this.#host;
    const id = this.#win.crypto.randomUUID();
    await engine.mutate({
      kind: "batch",
      ops: [
        { kind: "addWorkspace", name: made?.name ?? "", id },
        ...lookOps(id),
      ],
      now: lazy.SvalClock.now(),
    });
    // Claimed before the first wait, so that no window starting meanwhile
    // takes it ({@link shownElsewhere} reads the claim) before {@link show}
    // shows it here.
    this.remember(id);
    this.recordMade(id);
    settings.setCollapsed(id, false);
    settings.saveSoon();
    await this.#host.redraw();
    await this.#host.sync();
    return id;
  }

  /**
   * Keeps the window on a workspace that exists.
   *
   * Run wherever the document changes (each redraw of the panel), so it is
   * checked against every document the panel ever draws rather than only at
   * startup, and it goes through {@link show} like every other change of
   * workspace. Two things follow from asking
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
   *
   * @returns {Promise<boolean>} whether the window changed workspace.
   */
  async resolve() {
    const { nodes } = this.#host;
    const id = lazy.currentWorkspace(
      nodes,
      this.#id ?? this.remembered(),
      this.takenElsewhere()
    );
    if (id === null && this.#id && lazy.workspaceIds(nodes).length) {
      lazy.SvalLog.info(
        "every workspace has a window of its own, so this window closes"
      );
      // Marked first; see {@link closing}.
      this.closing = true;
      this.#win.close();
      return false;
    }
    return this.show(id);
  }

  /**
   * The new-window command: opens a window on the next workspace down from
   * this window's (`SvalPanelModel.currentWorkspace`'s `after`), wrapping at
   * the bottom. When none is left, the window is handed nothing and takes the
   * path every other new window takes, which makes a nameless workspace
   * ({@link adoptOrCreate}).
   *
   * The workspace is chosen here and handed over, and not left for the new
   * window to choose, because a hand-off is what keeps every other window from
   * taking it first ({@link shownElsewhere}). Only this command carries the
   * workspace this window shows; a restored, torn-off or agent's window does
   * not.
   */
  openWindowOnNext() {
    const next = this.inMemory
      ? null
      : lazy.currentWorkspace(
          this.#host.nodes,
          null,
          this.takenElsewhere(),
          this.#id
        );
    const opened = this.#win.OpenBrowserWindow();
    if (next) {
      lazy.handWorkspaceTo(opened, next);
    }
  }

  /**
   * **The one place a window changes which workspace it shows**, and so the
   * one place anything that must follow a switch is hung: the window is told
   * what it shows, its record of it is written, the tab observer is told
   * where to file a stray, and the window's tabs are handed over to the
   * workspace it now shows ({@link handOver}, spec §10.7).
   *
   * Every route in comes through it: the switcher ({@link switchTo}), the
   * panel's start, creating a workspace, and a peer's pass taking away the
   * workspace this window was showing ({@link resolve}). That last one is the
   * reason this exists as a function of its own: it changes what is drawn
   * without any user action, and anything hung only on the switcher's path
   * would be skipped by it.
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
  async show(id) {
    if (id === this.#id || this.inMemory) {
      return false;
    }
    const left = this.#id;
    const shownBy = id && this.shownElsewhere().get(id);
    if (shownBy) {
      shownBy.focus();
      return false;
    }
    this.setShown(id);
    lazy.SvalDownloadWorkspaces.workspaceShown(this.#win);
    // Before the hand-over, so the tabs it opens and every tab opened after
    // it are in the jar of the workspace the window shows.
    this.#host.shown();
    // The observer files strays and restored tabs under the workspace it was
    // attached with, so it has to learn about a switch or a tab dragged into
    // this window (or handed back by Firefox's recently-closed list) would
    // land in the workspace the user just left. After a peer deletes the
    // workspace this window was showing, that parent is not in the document.
    if (id) {
      this.#host.observer?.setWorkspace(id);
    }
    await this.handOver(id);
    // The pins of the workspace left stay loaded as its tabs do, and unload
    // with them once it has been out of sight long enough (pins spec §5).
    if (left) {
      this.#host.pins?.pages.park(left);
    }
    return true;
  }

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
  handOver(id, { hold = true } = {}) {
    this.#handingOver ??= new lazy.SvalSerialQueue("hand-over");
    this.#handOvers++;
    return this.#handingOver
      .run(() => this.#handOverOnce(id, hold))
      .finally(() => this.#handOvers--);
  }

  /**
   * Whether the window's tabs are being handed over to the workspace it
   * shows. Until that ends, the tab on screen can be one of the workspace
   * left, and the hand-over is what puts one of the workspace's own there.
   *
   * @returns {boolean}
   */
  get handingOver() {
    return this.#handOvers > 0;
  }

  /**
   * One hand-over, with {@link handOver} holding the door.
   *
   * @param {string|null} id The workspace this window now shows.
   * @param {boolean} hold As {@link handOver} takes it.
   * @returns {Promise<void>}
   */
  async #handOverOnce(id, hold) {
    const win = this.#win;
    const { observer, engine, pins } = this.#host;
    if (id !== this.#id) {
      // Queued behind a hand-over for somewhere else, and the window has since
      // moved on. Materialising a workspace the window has already left would
      // fill it with tabs it is not showing, and the hand-over that overtook
      // this one has already done the right thing.
      return;
    }
    if (!observer || !id || !engine) {
      // Nothing is mirroring this window's strip yet. At startup that is the
      // ordinary case: the panel's start picks a workspace through
      // {@link show} and restores it straight after, and materialising here
      // as well would open every tab twice.
      return;
    }
    // A window closed meanwhile has no strip to hand over.
    if (win.closed) {
      return;
    }

    try {
      const { wanted } = await lazy.SvalRestore.restore(win, {
        engine,
        workspaceId: id,
        lastActive: tabId => this.#host.settings.lastActive(tabId),
        // The window's own blank startup tab is not a switch's business: it
        // carries no node, so it belongs to no workspace, and the release
        // below leaves it where it is for the same reason.
        closeDebris: false,
      });
      if (win.closed) {
        return;
      }

      const keep = new Set(wanted);
      const target = this.mostRecentlyActive(wanted);
      // A pin's page is a tab of the window that no release takes away, so
      // it is on screen as a tab would be.
      const guid = this.lastPinAfter(target);
      const pin = guid ? pins.pinOf(guid) : null;
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
        pins.select(pin);
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
      // and not awaited: a peer's switch reaches this from the observer's own
      // queue (`onTreeChanged`), and a hand-over that waited for that queue
      // would wait for itself.
      observer.keepTabsInJar?.({ wait: false });
      observer.keepSplits?.();
      // The counterpart to the error below. A window showing the wrong tabs
      // after a switch is the hardest thing in Sval to reason about from the
      // outside, and these three numbers are what the reasoning needs.
      lazy.SvalLog.debug(
        `handed this window to ${id}: ${wanted.length} tabs wanted, ` +
          `${blank ? "one blank opened, " : ""}everything else released`
      );
    } catch (err) {
      // The switch itself must not fail, because the panel has already moved
      // and every tab still carries its node, but a hand-over that throws is a
      // bug, and a bug belongs in the console rather than narrated to someone
      // who cannot act on it (spec §10.7). This line is the whole record of
      // it, which is why `sval_switcher_helpers.js`'s
      // `assertNoHandOverFailure` reads the console for it and fails the
      // suite on one.
      lazy.SvalLog.error(
        `handing the window to a workspace failed: ${lazy.describeError(err)}`
      );
    }
  }

  /**
   * The guid of the pin this device looked at in the window's workspace
   * after `tabId`, the tab it would otherwise land on, or null. That pin is
   * where this device left the workspace (pins spec §5), if it still shows
   * there.
   *
   * @param {string|null} tabId
   * @returns {string|null}
   */
  lastPinAfter(tabId) {
    const { pins, settings } = this.#host;
    const last = pins ? settings.lastPin(this.#id) : null;
    if (!last) {
      return null;
    }
    const tabWhen = (tabId && settings.lastActive(tabId)) ?? -Infinity;
    return last.when > tabWhen ? last.guid : null;
  }

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
  mostRecentlyActive(ids) {
    const { settings } = this.#host;
    let best = null;
    let bestWhen = -Infinity;
    for (const id of ids) {
      const when = settings.lastActive(id) ?? -Infinity;
      if (when > bestWhen) {
        best = id;
        bestWhen = when;
      }
    }
    return best ?? ids[0] ?? null;
  }

  /**
   * Goes to `id`'s workspace because the user asked to: the switcher's own
   * action.
   *
   * Serialised against itself. A person can press two entries faster than a
   * switch completes, and two interleaved switches would each do half of
   * {@link show}'s work in the other's order.
   *
   * @param {string} id A workspace id.
   * @returns {Promise<boolean|null>} whether the window changed workspace;
   *   null for a window on a tree in memory, which has one workspace.
   */
  async switchTo(id) {
    if (this.inMemory) {
      return null;
    }
    return this.#switchQueue.run(() => this.#switchToOnce(id));
  }

  /**
   * One switch, with {@link switchTo} holding the door.
   *
   * @param {string} id A workspace id.
   * @returns {Promise<boolean>} whether the window changed workspace.
   */
  async #switchToOnce(id) {
    const { document } = this.#win;
    // A workspace a closed window may still delete is taken elsewhere
    // ({@link takenElsewhere}), so the next {@link resolve} would move this
    // window off it again. The switch goes once that window has decided, to
    // the workspace if it is kept.
    await lazy.closedWindowsDecided(id);
    // The document as it is now: a workspace a pass brought in since the
    // last redraw is one to go to.
    const nodes = (await this.#host.engine.tree()).nodes ?? {};
    if (nodes[id]?.kind !== lazy.WORKSPACE) {
      // A workspace another device closed between the menu being built and an
      // entry being pressed. A no-op and a redraw: the entry disappears, which
      // is the answer (spec §10.7). The window is already on a workspace that
      // exists, because the pass that took this one away moved it there.
      await this.#host.redraw(nodes);
      return false;
    }
    const root = document.documentElement;
    // Nobody sees a hidden window fade, and its animations tick on a
    // throttled refresh driver (`InactiveRefreshDriverTimer`), which would
    // hold the switch.
    const fade =
      !document.hidden &&
      !this.#win.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Before the switch sets the new tint, so that `sval-panel.css` blends
    // to it. Any other change of tint, as from the colour picker, is drawn
    // at once.
    root.toggleAttribute("data-sval-switching", fade);
    try {
      if (!(await this.show(id))) {
        return false;
      }
      // From the document as the hand-over leaves it: the panel's nodes are
      // the tree of its last redraw, which can predate the workspace's own.
      await this.#host.redraw();
      if (fade) {
        // The switch ends once the window shows the workspace as it stays:
        // whoever awaits it reads the tint blended in. The fade outlasts the
        // blend, which starts with the redraw. A window closed mid-fade has no
        // pres shell, and its timeline never ticks again
        // (`DocumentTimeline::WillRefresh`), so its animations are cancelled
        // as it unloads, or at once if it already has, or the switch would
        // hold its queue for good.
        const animations = this.#host.fadeIn();
        const stop = () => animations.forEach(animation => animation.cancel());
        this.#win.addEventListener("unload", stop, { once: true });
        if (this.#win.closed) {
          stop();
        }
        try {
          await Promise.allSettled(
            animations.map(animation => animation.finished)
          );
        } finally {
          this.#win.removeEventListener("unload", stop);
        }
      }
      return true;
    } finally {
      root.removeAttribute("data-sval-switching");
    }
  }

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
  keptTabShown(id) {
    const win = this.#win;
    const tab = this.#host.observer?.tabFor(id);
    if (!tab) {
      return;
    }
    const selected = tab === win.gBrowser.selectedTab;
    this.#switchQueue
      .run(async () => {
        const nodes = (await this.#host.engine.tree()).nodes ?? {};
        const workspace = lazy.workspaceOfNode(nodes, id);
        if (!workspace || workspace === this.#id) {
          return;
        }
        // A switch's own hand-over selects a kept tab of the workspace it
        // goes to, and a switch queued behind it has since selected another
        // tab: the window follows a selection only while it still stands.
        if (selected) {
          if (tab === win.gBrowser.selectedTab) {
            await this.#switchToOnce(workspace);
          }
        } else if (
          !tab.closing &&
          !tab.hidden &&
          tab !== win.gBrowser.selectedTab
        ) {
          lazy.SvalFirefox.hideForWorkspace(win, tab);
        }
      })
      .catch(err => {
        lazy.SvalLog.error(
          `following a kept tab failed: ${lazy.describeError(err)}`
        );
      });
  }

  /**
   * Takes into this window the tabs other windows keep loaded for the
   * workspace it shows (`SvalRestore.takeKept`), in the switch's queue, so
   * the workspace it takes for is the one it shows once any switch is over.
   *
   * @returns {Promise<void>}
   */
  takeKeptTabs() {
    if (this.inMemory || !this.#win.toolbar.visible) {
      return Promise.resolve();
    }
    return this.#switchQueue
      .run(() => this.#takeKeptTabsNow())
      .catch(err => {
        lazy.SvalLog.error(
          `taking kept tabs failed: ${lazy.describeError(err)}`
        );
      });
  }

  /**
   * {@link takeKeptTabs} for a caller that may be inside a switch: queued and
   * not waited for (`SvalSerialQueue.post`), because the panel's redraw can
   * run inside a switch's task, which the queue cannot get past to answer.
   */
  takeKeptTabsLater() {
    if (this.inMemory || !this.#win.toolbar.visible) {
      return;
    }
    this.#switchQueue.post(() => this.#takeKeptTabsNow());
  }

  /** {@link takeKeptTabs}'s work, inside the switch's queue. */
  async #takeKeptTabsNow() {
    const win = this.#win;
    const { engine } = this.#host;
    if (!engine || win.closed || this.closing) {
      return;
    }
    // The latest read: every change that can bring a kept tab here is
    // read back and redrawn, and each redraw asks again.
    const nodes = lazy.latestNodes(engine) ?? (await engine.tree()).nodes ?? {};
    // A window closed while the tree was read has no tab strip left:
    // tabbrowser fails to make a tab in it (`aWindow.docShell` is null).
    if (win.closed) {
      return;
    }
    const id = this.#id;
    if (id) {
      lazy.SvalRestore.takeKept(win, { nodes, workspaceId: id });
      // A kept split's tabs come one at a time, and Firefox separates
      // what each leaves behind.
      this.#host.observer?.keepSplits?.();
    }
  }
}
