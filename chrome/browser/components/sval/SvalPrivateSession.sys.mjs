/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Everything Sval holds for windows whose tabs are never written anywhere:
 * private windows (private-windows spec), and the windows a WebDriver client
 * opens (`SvalWebDriver`).
 *
 * Such a window shows Sval's panel like any other, with one temporary
 * workspace of its own tabs. Nothing about those tabs may be written
 * anywhere, so the window is given objects that cannot write:
 *
 * - a tree in `SvalPrivate.worker.mjs`, which has no file, network or sync
 *   code in reach, in place of the profile's `SvalEngine`;
 * - settings held in memory, in place of `SvalLocalSettings`;
 * - tab-to-node ids held in memory, in place of SessionStore's custom tab
 *   values.
 *
 * This module imports only what is below and `test_sval_private.js` fails if
 * that changes. Every window of one kind shares one tree, so a tab dragged
 * between two WebDriver windows keeps its node; a private window's tabs
 * never leave it, each private window being a browsing session of its own
 * (`SvalPrivateJars`). When the last one closes, the tree is freed and the
 * session starts empty next time.
 */

import { SvalWorkerClient } from "moz-src:///browser/components/sval/SvalWorkerClient.sys.mjs";
import { noteTree } from "moz-src:///browser/components/sval/SvalTreeSnapshot.sys.mjs";

const WORKER_URL = "chrome://browser/content/sval/SvalPrivate.worker.mjs";

/** A private window's one workspace. The panel shows it without a name. */
const WORKSPACE_NAME = "Private";

/**
 * A tree in memory, with the part of `SvalEngine`'s surface the panel and
 * `SvalTabs` use. It has no `sync`, no shared folder, no key and no
 * listeners: a caller reaching for one fails at once.
 */
class SvalMemoryTree extends SvalWorkerClient {
  #deviceId;
  #isPrivate;
  #listeners = new Set();

  /**
   * @param {object} options
   * @param {boolean} options.isPrivate Whether private windows run on it.
   */
  constructor({ isPrivate }) {
    super(WORKER_URL);
    // Stamped into the tree's fact groups, which the engine requires.
    // It names this session only, and is never stored.
    this.#deviceId = crypto.getRandomValues(new Uint8Array(16));
    this.#isPrivate = isPrivate;
  }

  /** Whether private windows run on it, which `SvalTabs` checks. */
  get isPrivate() {
    return this.#isPrivate;
  }

  /** Always true: what the panel and `SvalTabs` branch on. */
  get isMemory() {
    return true;
  }

  /**
   * The tree, as `SvalEngine.tree()`, noted as this tree's latest for readers
   * that must answer at once (`SvalTreeSnapshot`), as `SvalEngine.tree()` notes
   * its own.
   *
   * @returns {Promise<object>}
   */
  async tree() {
    const json = await this.post("tree");
    const tree = JSON.parse(json);
    noteTree(this, json, tree.nodes ?? {});
    return tree;
  }

  /**
   * @param {object} op As `SvalEngine.mutate` takes.
   * @returns {Promise<string|null>} the affected node's id.
   */
  async mutate(op) {
    const id = await this.post("mutate", [{ ...op, deviceId: this.#deviceId }]);
    for (const listener of this.#listeners) {
      listener();
    }
    return id;
  }

  /**
   * Calls `listener` after every change, whichever window made it. The
   * profile's windows hear each other through sync passes; these windows
   * have none, and a tab dragged between two of them changes what both draw.
   *
   * @param {Function} listener
   * @returns {Function} what stops it.
   */
  addChangeListener(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Nothing is ever published. */
  async publishPending() {}

  /** Nothing waits for these windows at shutdown. */
  finishBeforeShutdown() {}

  /**
   * Removes a workspace and everything in it, in one step in the worker, so
   * no other window's change can land between reading what is in it
   * and removing it: a tab dragged out of a closing window keeps its node.
   *
   * @param {string} id A workspace id.
   */
  async removeWorkspace(id) {
    await this.post("removeWorkspace", [id]);
    for (const listener of this.#listeners) {
      listener();
    }
  }

  /** Frees the tree in the worker. */
  reset() {
    return this.post("reset");
  }
}

/**
 * The device-local state of a window on a tree in memory, with every method
 * of `SvalLocalSettings`' store. It holds collapse, selection and last-active
 * times in memory, and `flush` writes nothing. Such a window has no storage,
 * so the storage setters refuse.
 */
class SvalMemorySettings {
  #placement;
  #panelWidth = null;
  #expanded = new Set();
  #lastActive = new Map();
  // By workspace, as `SvalLocalSettings` keeps it: each private window shows
  // a workspace of its own and shares these settings.
  #selections = new Map();
  #userHistory = new Set();
  #userHeld = new Set();
  #agentStopped = new Set();

  /** @param {string} placement Which side the panel goes, as the profile has it. */
  constructor(placement) {
    this.#placement = placement;
  }

  get path() {
    return null;
  }

  selectionIn(workspaceId) {
    return this.#selections.get(workspaceId) ?? null;
  }

  setSelection(workspaceId, id) {
    if (typeof workspaceId !== "string") {
      throw new TypeError("sval: a selection needs the workspace it is in");
    }
    if (id !== null && typeof id !== "string") {
      throw new TypeError("sval: selection must be a node id or null");
    }
    if (id === null) {
      this.#selections.delete(workspaceId);
    } else {
      this.#selections.set(workspaceId, id);
    }
  }

  get placement() {
    return this.#placement;
  }

  set placement(value) {
    this.#placement = value;
  }

  get panelWidth() {
    return this.#panelWidth;
  }

  set panelWidth(value) {
    this.#panelWidth = value;
  }

  get sharedFolder() {
    return null;
  }

  set sharedFolder(value) {
    throw new Error("sval: this window has no storage");
  }

  isSettingSeeded() {
    return true;
  }

  markSettingsSeeded() {}

  // First run never runs from these windows, because nothing answered
  // there would be kept (first-run spec §3.3), so here it has always ended.
  get firstRunStarted() {
    return true;
  }

  markFirstRunStarted() {}

  get firstRunDone() {
    return true;
  }

  markFirstRunDone() {}

  isCollapsed(id) {
    return !this.#expanded.has(id);
  }

  setCollapsed(id, collapsed) {
    if (collapsed) {
      this.#expanded.delete(id);
    } else {
      this.#expanded.add(id);
    }
  }

  lastActive(id) {
    return this.#lastActive.get(id) ?? null;
  }

  setLastActive(id, when) {
    this.#lastActive.set(id, when);
  }

  forgetLastActive(id) {
    this.#lastActive.delete(id);
  }

  // A private window shows no pins (pins spec §7), so nothing is recorded.
  lastPin() {
    return null;
  }

  setLastPin() {}

  lastActiveTimes() {
    return Object.fromEntries(this.#lastActive);
  }

  // An agent never has a tab in these windows, so these stay empty; they
  // answer from memory so that a caller holding settings never reaches disk.
  hasUserHistory(id) {
    return this.#userHistory.has(id);
  }

  setUserHistory(id, has) {
    if (has) {
      this.#userHistory.add(id);
    } else {
      this.#userHistory.delete(id);
    }
  }

  userHeldIds() {
    return [...this.#userHeld];
  }

  isUserHeld(id) {
    return this.#userHeld.has(id);
  }

  setUserHeld(id, held) {
    if (held) {
      this.#userHeld.add(id);
    } else {
      this.#userHeld.delete(id);
    }
  }

  agentStoppedIds() {
    return [...this.#agentStopped];
  }

  isAgentStopped(id) {
    return this.#agentStopped.has(id);
  }

  setAgentStopped(id, stopped) {
    if (stopped) {
      this.#agentStopped.add(id);
    } else {
      this.#agentStopped.delete(id);
    }
  }

  get oldKeyDirs() {
    return [];
  }

  set oldKeyDirs(dirs) {}

  get backupSaved() {
    return false;
  }

  set backupSaved(value) {}

  /** A store with no sync folder has never synced with one. */
  get lastSynced() {
    return null;
  }

  set lastSynced(at) {}

  isDismissedOtherWorkspace() {
    return false;
  }

  dismissOtherWorkspace() {}

  // The profile's own record, which `SvalWebDriver.deleteLeftWorkspaces`
  // reads from the profile's store alone.
  get leftWebDriverWorkspaces() {
    return [];
  }

  forgetLeftWebDriverWorkspaces() {}

  forgetAgentTabsOtherThan(keep) {
    let dropped = false;
    for (const set of [this.#userHeld, this.#agentStopped, this.#userHistory]) {
      for (const id of set) {
        if (!keep.has(id)) {
          set.delete(id);
          dropped = true;
        }
      }
    }
    return dropped;
  }

  /** Writes nothing: this state ends with the session. */
  async flush() {}

  /** Writes nothing, as `flush`. */
  saveSoon() {}

  /** Writes nothing, as `flush`. */
  async flushPending() {}
}

/**
 * A tree held in memory, with the settings and tab-to-node ids of the windows
 * that run on it. Each window shows one workspace of its own, and the window
 * closing removes it. When the last window closes, the tree is freed and the
 * next window starts an empty one.
 */
export class SvalMemorySession {
  #isPrivate;
  #workspace;
  #onPrivateBrowsingEnded;
  /** The live session, or null when no window runs on it. */
  #live = null;

  /**
   * @param {object} options
   * @param {boolean} options.isPrivate Whether its windows are private ones.
   *   Private browsing's own end also ends the session.
   * @param {object} options.workspace What `addWorkspace` makes for each
   *   window: `{ name, isolated }`.
   */
  constructor({ isPrivate, workspace }) {
    this.#isPrivate = isPrivate;
    this.#workspace = workspace;
    this.#onPrivateBrowsingEnded = () => this.end();
  }

  #start() {
    if (this.#isPrivate) {
      Services.obs.addObserver(
        this.#onPrivateBrowsingEnded,
        "last-pb-context-exited"
      );
    }
    return {
      tree: new SvalMemoryTree({ isPrivate: this.#isPrivate }),
      settings: new SvalMemorySettings("left"),
      // The profile's panel side, read by the first window that joins.
      placed: null,
      // Keyed by the tab's `permanentKey`, which tabbrowser moves onto the
      // new tab when one is dragged to another window (`_swapBrowserDocShells`)
      // and which SessionStore keys its own records on for the same reason.
      // The tab element itself does not survive the move.
      nodeIds: new WeakMap(),
      // Each window, or a reservation for one, to its workspace's id.
      windows: new Map(),
    };
  }

  /**
   * Makes a workspace for a window that does not exist yet. The session
   * lives while the reservation does.
   *
   * @returns {{key: object, tree: object, workspaceId: Promise<string>}} The
   *   key {@link bind} or {@link releaseWindow} takes, and the workspace.
   */
  reserve() {
    this.#live ??= this.#start();
    const key = {};
    const workspaceId = this.#live.tree.mutate({
      kind: "addWorkspace",
      ...this.#workspace,
    });
    this.#live.windows.set(key, workspaceId);
    return { key, tree: this.#live.tree, workspaceId };
  }

  /**
   * Gives `win` the workspace reserved under `key`.
   *
   * @param {object} key From {@link reserve}.
   * @param {DOMWindow} win
   */
  bind(key, win) {
    const pending = this.#live?.windows.get(key);
    if (!pending) {
      throw new Error("sval: no workspace is reserved for this window");
    }
    this.#live.windows.delete(key);
    this.#live.windows.set(win, pending);
  }

  /**
   * @param {DOMWindow} win
   * @returns {boolean} Whether `win` runs on this session.
   */
  has(win) {
    return !!this.#live?.windows.has(win);
  }

  /**
   * The session a window joins, and the workspace it shows.
   *
   * @param {DOMWindow} win A chrome window.
   * @param {object} [options]
   * @param {Function} [options.layout] Answers the profile's panel side and
   *   width as `{ placement, panelWidth }`, or a promise of it. Called only
   *   by the first window that joins.
   * @returns {Promise<object>} `{ tree, settings, workspaceId, nodeIds }`,
   *   where `nodeIds` is what `SvalTabs` reads and writes tab ids through.
   */
  async forWindow(
    win,
    { layout = () => ({ placement: "left", panelWidth: null }) } = {}
  ) {
    this.#live ??= this.#start();
    const current = this.#live;
    // Registered before anything is awaited, so the last other window
    // closing meanwhile does not end the session this one is joining.
    if (!current.windows.has(win)) {
      current.windows.set(
        win,
        current.tree.mutate({ kind: "addWorkspace", ...this.#workspace })
      );
    }
    current.placed ??= Promise.resolve(layout()).then(
      ({ placement, panelWidth }) => {
        current.settings.placement = placement;
        current.settings.panelWidth = panelWidth;
      }
    );
    const [workspaceId] = await Promise.all([
      current.windows.get(win),
      current.placed,
    ]);
    return {
      tree: current.tree,
      settings: current.settings,
      workspaceId,
      nodeIds: {
        get(tab) {
          const key = tab.permanentKey;
          return (key && current.nodeIds.get(key)) ?? null;
        },
        set(tab, id) {
          if (tab.permanentKey) {
            current.nodeIds.set(tab.permanentKey, id);
          }
        },
      },
    };
  }

  /**
   * Drops a closed window's workspace and everything in it. The last one
   * frees the tree.
   *
   * @param {DOMWindow|object} win A window, or a key from {@link reserve}.
   * @param {object} [options]
   * @param {Promise} [options.after] What must settle first, such as the
   *   closing window's last flush. It is awaited here because Gecko drops a
   *   promise callback whose window has no active document
   *   (`CallSetup::GetActiveGlobalObjectForCall`), so a closed window's own
   *   `then` may never run.
   * @returns {Promise<string|null>} the workspace dropped, or null when
   *   `win` had none.
   */
  async releaseWindow(win, { after } = {}) {
    await after;
    const current = this.#live;
    const pending = current?.windows.get(win);
    if (!pending) {
      return null;
    }
    current.windows.delete(win);
    const workspaceId = await pending.catch(() => null);
    if (!current.windows.size) {
      if (this.#live === current) {
        await this.end();
      }
    } else if (workspaceId) {
      await current.tree.removeWorkspace(workspaceId);
    }
    return workspaceId;
  }

  /**
   * Ends the session: the tree, the settings and every id are dropped.
   */
  async end() {
    const current = this.#live;
    this.#live = null;
    if (!current) {
      return;
    }
    if (this.#isPrivate) {
      Services.obs.removeObserver(
        this.#onPrivateBrowsingEnded,
        "last-pb-context-exited"
      );
    }
    current.windows.clear();
    await current.tree.reset().catch(() => {});
    current.tree.terminate();
  }

  /** Whether a session is live. For tests. */
  get isLive() {
    return this.#live !== null;
  }
}

/**
 * Every private window's tree, each window with a workspace of its own.
 * Firefox's own end of private browsing ends it too, as a backstop for
 * `releaseWindow`.
 */
export const SvalPrivateSession = new SvalMemorySession({
  isPrivate: true,
  workspace: { name: WORKSPACE_NAME },
});
