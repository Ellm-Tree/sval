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
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  describeError: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  heldWhileClosing: "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
  pendingHandOffs: "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
});

/** Each window's workspace. */
const windows = new WeakMap();

/**
 * Which workspace a window shows (spec §10.7), what the session store
 * remembers of it, and which workspaces the other windows show.
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
}
