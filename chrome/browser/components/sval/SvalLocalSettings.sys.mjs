/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The state spec §5.6 says never syncs, such as panel placement and width,
 * which groups are collapsed, the storage root and each workspace's
 * selection. It
 * describes this device: a laptop and an ultrawide want different panel
 * placements, and the storage root cannot sync through the thing it
 * configures. A damaged file is handled as `_load` says.
 */

import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import {
  SvalSaver,
  readJSONOrSetAside,
} from "moz-src:///browser/components/sval/SvalJSONFile.sys.mjs";

const VALID_PLACEMENTS = new Set(["left", "right"]);
const DEFAULT_PLACEMENT = "left";

/**
 * How long `saveSoon` waits before it writes. Every change in that time
 * goes in the one write, so switching tabs quickly writes the file once.
 */
const SAVE_DELAY_MS = 750;

/**
 * @param {Array} values
 * @returns {string[]} the strings among `values`.
 */
function stringsOf(values) {
  return values.filter(value => typeof value === "string");
}

/** Every store `open` has made, so `forgetCachedValues` can write theirs. */
const openStores = new Set();

/** One profile's device-local settings, read from and written to one file. */
class SvalLocalSettingsStore {
  /**
   * @param {string} path Where this store reads from and writes to.
   */
  constructor(path) {
    this.path = path;
    this._placement = DEFAULT_PLACEMENT;
    // CSS pixels, or null for the stylesheet's own.
    this._panelWidth = null;
    // Null means the user has chosen nothing, and the getter answers with
    // the profile directory. Keeping null lets an unconfigured profile follow
    // its own directory if it moves, and keeps `flush` from writing a path
    // the user never picked.
    this._sharedFolder = null;
    // The synced keys this profile has seeded (settings-sync spec §4.2), by
    // name, so a key a later build adds is seeded too. Once a key is seeded,
    // the pref observer writes every change to it, so it is never seeded
    // again.
    this._seededSettings = new Set();
    // Whether first run has begun and whether it has ended on this profile
    // (first-run spec §3.3). Begun and not ended is a first run interrupted by
    // a crash or a closed window, which shows again at the next launch
    // although the profile then holds a file of its own.
    this._firstRunStarted = false;
    this._firstRunDone = false;
    // Spec §5.6: a device syncing for the first time starts with every group
    // collapsed. Storing only the expanded ids makes that true by
    // construction: an id this store has never seen reads as collapsed.
    this._expanded = new Set();
    // Spec §5.6: when a tab was last active is device-local. It is keyed by
    // node id because it has to outlive a tab that is closed and reopened,
    // and because the tree is the model (spec §10.4).
    this._lastActive = new Map();
    // Which node the user is working in, and so where new tabs are filed,
    // by the workspace it is in. Device-local (spec §5.6): syncing it would
    // drag a laptop's focus onto a desktop mid-session, and file a tab opened
    // here into a group chosen there. Kept per workspace because every window
    // of the profile shares this store and each shows its own workspace
    // (spec §10.7): one selection for all of them would hand one window a
    // node it does not draw.
    this._selections = new Map();
    // The pin looked at last in each workspace, `{ guid, when }`, beside
    // `_lastActive`: a pin is no node, and its page is left out of Firefox's
    // session (`SvalPinTab`), so this is all a launch has of it.
    this._lastPins = new Map();
    // The agent workspaces the user has taken control of, by node id
    // (agent-control spec §6). Kept here, and not with the tabs in Firefox's
    // session, because the take has to outlive every tab's browser: a
    // discard replaces it, and after a restart `SvalRestore` makes the tabs
    // again from the tree, with nothing of Firefox's session.
    this._userHeld = new Set();
    // The agent workspaces whose agent the user has stopped, by node id
    // (agent-control spec §6). Kept with the takes, for the same reason: a
    // Stop holds until the user presses Resume, across a restart.
    this._agentStopped = new Set();
    // Directories of another sync key's workspaces in the shared folder that
    // the user dismissed, so the panel does not raise them again (key-storage
    // spec, "A second key can arrive later").
    this._dismissedOtherWorkspaces = new Set();
    // Whether the user saved or printed a backup of the current sync key, so
    // Settings stops saying no backup was saved.
    this._backupSaved = false;
    // When a shared step last reached the shared folder, `{ folder, at }`,
    // so a launch says when this device last synced before a step answers.
    // It names the folder it is about, so a time from a folder since left is
    // never shown for another.
    this._lastSync = null;
    // Directories under the shared folder's `sval/ws/` that a replaced sync
    // key could read and that are not all removed yet (key-storage spec,
    // "Starting over with a new sync key").
    this._oldKeyDirs = [];
    // The agent tabs whose history holds pages the user opened while holding
    // them, by node id. Which entries those are is known only to the tab's
    // content; once that is gone, after a discard or a restart, the agent may
    // step only into history it made itself (`SvalAgentControl.isUserEntry`).
    this._userHistory = new Set();
    // Workspaces in the synced document that WebDriver made on this device,
    // which `SvalWebDriver.deleteLeftWorkspaces` deletes. Read from the file
    // and never added to.
    this._leftWebDriverWorkspaces = [];
    this._saver = new SvalSaver({
      what: "device-local settings",
      write: () => this.#write(),
      delayMs: SAVE_DELAY_MS,
    });
  }

  /** @returns {string[]} See `_leftWebDriverWorkspaces`. */
  get leftWebDriverWorkspaces() {
    return [...this._leftWebDriverWorkspaces];
  }

  /** Drops the record once its workspaces are gone. */
  forgetLeftWebDriverWorkspaces() {
    this._leftWebDriverWorkspaces = [];
  }

  /**
   * @param {string} id A tab's node id.
   * @returns {boolean} Whether the tab's history holds pages the user opened
   *   while holding it.
   */
  hasUserHistory(id) {
    return this._userHistory.has(id);
  }

  /**
   * @param {string} id A tab's node id.
   * @param {boolean} has
   */
  setUserHistory(id, has) {
    if (has) {
      this._userHistory.add(id);
    } else {
      this._userHistory.delete(id);
    }
  }

  /** @returns {string[]} The node ids takes are kept under. */
  userHeldIds() {
    return [...this._userHeld];
  }

  /**
   * @param {string} id An agent's workspace node id.
   * @returns {boolean} Whether the user has taken control of that workspace.
   */
  isUserHeld(id) {
    return this._userHeld.has(id);
  }

  /**
   * @param {string} id An agent's workspace node id.
   * @param {boolean} held
   */
  setUserHeld(id, held) {
    if (held) {
      this._userHeld.add(id);
    } else {
      this._userHeld.delete(id);
    }
  }

  /** @returns {string[]} The node ids Stops are kept under. */
  agentStoppedIds() {
    return [...this._agentStopped];
  }

  /**
   * @param {string} id An agent's workspace node id.
   * @returns {boolean} Whether the user has stopped the agent working there.
   */
  isAgentStopped(id) {
    return this._agentStopped.has(id);
  }

  /**
   * @param {string} id An agent's workspace node id.
   * @param {boolean} stopped
   */
  setAgentStopped(id, stopped) {
    if (stopped) {
      this._agentStopped.add(id);
    } else {
      this._agentStopped.delete(id);
    }
  }

  /** @returns {string[]} A replaced key's directories still to remove. */
  get oldKeyDirs() {
    return [...this._oldKeyDirs];
  }

  set oldKeyDirs(dirs) {
    this._oldKeyDirs = stringsOf(dirs);
  }

  /** @returns {boolean} Whether a backup of the current sync key was saved. */
  get backupSaved() {
    return this._backupSaved;
  }

  set backupSaved(value) {
    this._backupSaved = value === true;
  }

  /**
   * When a shared step last reached the shared folder chosen now, in
   * milliseconds since the epoch, or null when none has.
   *
   * @returns {number|null}
   */
  get lastSynced() {
    return this._lastSync && this._lastSync.folder === this._sharedFolder
      ? this._lastSync.at
      : null;
  }

  /**
   * Records `at` as the last sync with the shared folder chosen now, or with
   * null forgets it.
   *
   * @param {number|null} at Milliseconds since the epoch, or null.
   */
  set lastSynced(at) {
    this._lastSync =
      Number.isFinite(at) && this._sharedFolder !== null
        ? { folder: this._sharedFolder, at }
        : null;
  }

  /**
   * @param {string} name A directory under the shared folder's `sval/ws/`.
   * @returns {boolean} Whether the user dismissed it.
   */
  isDismissedOtherWorkspace(name) {
    return this._dismissedOtherWorkspaces.has(name);
  }

  /** @param {string} name A directory under the shared folder's `sval/ws/`. */
  dismissOtherWorkspace(name) {
    this._dismissedOtherWorkspaces.add(name);
  }

  /**
   * Drops every take, Stop and user-history mark whose node id is not in
   * `keep`.
   *
   * @param {Set<string>} keep
   * @returns {boolean} Whether anything was dropped.
   */
  forgetAgentTabsOtherThan(keep) {
    let dropped = false;
    for (const set of [this._userHeld, this._agentStopped, this._userHistory]) {
      for (const id of set) {
        if (!keep.has(id)) {
          set.delete(id);
          dropped = true;
        }
      }
    }
    return dropped;
  }

  /**
   * @param {string|null} workspaceId
   * @returns {string|null} The node id last selected in that workspace, or
   *   null when nothing is.
   */
  selectionIn(workspaceId) {
    return this._selections.get(workspaceId) ?? null;
  }

  /**
   * @param {string} workspaceId The workspace `id` was selected in.
   * @param {string|null} id A node id, or null to select nothing there.
   */
  setSelection(workspaceId, id) {
    if (typeof workspaceId !== "string") {
      throw new TypeError("sval: a selection needs the workspace it is in");
    }
    if (id !== null && typeof id !== "string") {
      throw new TypeError(
        `sval: selection must be a node id or null, got ${JSON.stringify(id)}`
      );
    }
    if (id === null) {
      this._selections.delete(workspaceId);
    } else {
      this._selections.set(workspaceId, id);
    }
  }

  /**
   * @param {string|null} workspaceId
   * @returns {{guid: string, when: number}|null} The pin this device looked
   *   at last in that workspace, and when.
   */
  lastPin(workspaceId) {
    return this._lastPins.get(workspaceId) ?? null;
  }

  /**
   * @param {string} workspaceId The workspace the pin's page was shown in.
   * @param {string} guid The pin's guid.
   * @param {number} when Milliseconds since the epoch.
   */
  setLastPin(workspaceId, guid, when) {
    if (typeof workspaceId !== "string" || typeof guid !== "string") {
      throw new TypeError("sval: a last pin needs its workspace and guid");
    }
    if (!Number.isFinite(when)) {
      throw new Error(
        `sval: lastPin must be a finite timestamp, got ${JSON.stringify(when)}`
      );
    }
    this._lastPins.set(workspaceId, { guid, when });
  }

  get placement() {
    return this._placement;
  }

  set placement(value) {
    if (!VALID_PLACEMENTS.has(value)) {
      throw new RangeError(
        `sval: panel placement must be "left" or "right", got ${JSON.stringify(value)}`
      );
    }
    this._placement = value;
  }

  get panelWidth() {
    return this._panelWidth;
  }

  set panelWidth(value) {
    if (value !== null && !(Number.isFinite(value) && value > 0)) {
      throw new RangeError(
        `sval: panel width must be a positive number or null, got ${JSON.stringify(value)}`
      );
    }
    this._panelWidth = value;
  }

  /**
   * The shared folder this device exchanges files through with its other
   * devices, or null when the user has chosen none.
   *
   * This device's own copy always lives in the profile (local-copy spec §4.1,
   * `SvalLocalSettings.localRoot`). A chosen folder is where devices meet, and
   * Sval treats it as volatile: it may be missing at any moment.
   *
   * @returns {string|null} an absolute path, or null.
   */
  get sharedFolder() {
    return this._sharedFolder;
  }

  set sharedFolder(value) {
    if (value !== null && typeof value !== "string") {
      throw new Error(
        `sval: sharedFolder must be a string path or null, got ${JSON.stringify(value)}`
      );
    }
    this._sharedFolder = value;
  }

  /**
   * @param {string} key A synced setting's key.
   * @returns {boolean} Whether this profile has seeded `key`.
   */
  isSettingSeeded(key) {
    return this._seededSettings.has(key);
  }

  /**
   * Records that `keys` are seeded. The caller flushes.
   *
   * @param {string[]} keys
   */
  markSettingsSeeded(keys) {
    for (const key of keys) {
      this._seededSettings.add(key);
    }
  }

  /** @returns {boolean} Whether first run has begun on this profile. */
  get firstRunStarted() {
    return this._firstRunStarted;
  }

  /** Records that first run has begun. The caller flushes. */
  markFirstRunStarted() {
    this._firstRunStarted = true;
  }

  /**
   * @returns {boolean} Whether first run has ended on this profile, or was
   *   found not to be needed. It never shows again once this is true.
   */
  get firstRunDone() {
    return this._firstRunDone;
  }

  /** Records that first run has ended. The caller flushes. */
  markFirstRunDone() {
    this._firstRunDone = true;
  }

  /**
   * @param {string} id A node id from the synced tree.
   * @returns {boolean} Whether `id` should render collapsed. True for any id
   *   this store has never recorded as expanded.
   */
  isCollapsed(id) {
    return !this._expanded.has(id);
  }

  /**
   * @param {string} id A node id from the synced tree.
   * @param {boolean} collapsed
   */
  setCollapsed(id, collapsed) {
    if (collapsed) {
      this._expanded.delete(id);
    } else {
      this._expanded.add(id);
    }
  }

  /**
   * @param {string} id A node id from the synced tree.
   * @returns {number|null} When this device last looked at `id`, in
   *   milliseconds since the epoch, or null if it never has.
   */
  lastActive(id) {
    return this._lastActive.get(id) ?? null;
  }

  /**
   * @returns {object} When this device last looked at each node it has,
   *   `{ id: ms }`, as the sweep takes it (idle-tab archive spec §4.2).
   */
  lastActiveTimes() {
    return Object.fromEntries(this._lastActive);
  }

  /**
   * @param {string} id A node id from the synced tree.
   * @param {number} when Milliseconds since the epoch.
   */
  setLastActive(id, when) {
    if (!Number.isFinite(when)) {
      throw new Error(
        `sval: lastActive must be a finite timestamp, got ${JSON.stringify(when)}`
      );
    }
    this._lastActive.set(id, when);
  }

  /**
   * Drops `id`'s last-active time. Called when the node goes, so this file
   * does not grow forever with ids nothing refers to.
   *
   * @param {string} id A node id from the synced tree.
   */
  forgetLastActive(id) {
    this._lastActive.delete(id);
  }

  /**
   * Writes the current state soon, in one write with every other change made
   * before it goes. A setter's caller calls this; a step a crash must not
   * undo, such as first run ending, awaits {@link flush} instead. Whatever is
   * still waiting at quit is written by the profile's shutdown blocker.
   */
  saveSoon() {
    this._saver.saveSoon();
  }

  /**
   * Writes what a {@link saveSoon} is waiting to write, or waits for a
   * write it has started. Settles once the file holds every change made
   * before the call.
   *
   * @returns {Promise<void>}
   */
  flushPending() {
    return this._saver.flushPending();
  }

  /**
   * Writes the current state at once, taking the place of any write
   * {@link saveSoon} is waiting to make.
   *
   * @returns {Promise<void>}
   */
  flush() {
    return this._saver.flush();
  }

  /**
   * `tmpPath` makes the write atomic, so a crash mid-write leaves the
   * previous file intact.
   */
  async #write() {
    await IOUtils.writeJSON(
      this.path,
      {
        placement: this._placement,
        panelWidth: this._panelWidth,
        sharedFolder: this._sharedFolder,
        seededSettings: Array.from(this._seededSettings),
        firstRunStarted: this._firstRunStarted,
        firstRunDone: this._firstRunDone,
        expanded: Array.from(this._expanded),
        lastActive: Object.fromEntries(this._lastActive),
        selections: Object.fromEntries(this._selections),
        lastPins: Object.fromEntries(this._lastPins),
        userHeld: Array.from(this._userHeld),
        agentStopped: Array.from(this._agentStopped),
        userHistory: Array.from(this._userHistory),
        dismissedOtherWorkspaces: Array.from(this._dismissedOtherWorkspaces),
        backupSaved: this._backupSaved,
        lastSync: this._lastSync ?? undefined,
        oldKeyDirs: this._oldKeyDirs,
        // Kept until its workspaces are deleted, and then gone from the file.
        webDriverWorkspaces: this._leftWebDriverWorkspaces.length
          ? this._leftWebDriverWorkspaces
          : undefined,
      },
      { tmpPath: `${this.path}.tmp` }
    );
  }
}

export const SvalLocalSettings = {
  /**
   * This device's own location, where its copy lives whatever shared folder
   * it uses (local-copy spec §4.1): the profile
   * directory itself, so documents land at
   * `<profile>/sval/ws/<hashed>/<device>.json`. The `sval/` segment is the
   * engine's: `store.rs`'s `sync_prefix` returns `sval/ws/<hashed>`, so a root
   * the user already keeps things in does not scatter Sval's files among
   * theirs.
   *
   * Resolved on each call, because a value cached at module load would
   * describe whichever profile the module was imported in.
   *
   * @returns {string} an absolute path. Nothing below it need exist yet: the
   *   worker creates the directories on the first pass that publishes.
   */
  localRoot() {
    return PathUtils.profileDir;
  },

  /**
   * The profile's own settings file, which every window and service of the
   * profile shares. Resolved on each call, as `localRoot` is.
   *
   * @returns {string}
   */
  profilePath() {
    return PathUtils.join(PathUtils.profileDir, "sval-local-settings.json");
  },

  /**
   * The profile's settings store (`profilePath`).
   *
   * @returns {Promise<SvalLocalSettingsStore>}
   */
  openProfile() {
    return this.open(this.profilePath());
  },

  /**
   * The panel's side and width a settings file holds, read as a store reads
   * them: a value out of range is the default.
   *
   * @param {object|null} stored The file's parsed contents.
   * @returns {{placement: string, panelWidth: number|null}}
   */
  layoutOf(stored) {
    const placement = stored?.placement;
    const width = stored?.panelWidth;
    return {
      placement: VALID_PLACEMENTS.has(placement)
        ? placement
        : DEFAULT_PLACEMENT,
      panelWidth: Number.isFinite(width) && width > 0 ? width : null,
    };
  },

  /**
   * One load promise per path, so overlapping `open()` calls share one
   * store. Two stores for one file would each write their own copy, and the
   * last write would discard the other's change.
   */
  _openPromises: new Map(),

  /**
   * @param {string} path The settings file's path.
   * @returns {Promise<SvalLocalSettingsStore>} The same instance for every
   *   concurrent or repeated call with this path, until `forgetCachedValues`.
   */
  open(path) {
    if (!this._openPromises.has(path)) {
      const promise = this._load(path).catch(err => {
        this._openPromises.delete(path);
        throw err;
      });
      this._openPromises.set(path, promise);
    }
    return this._openPromises.get(path);
  },

  /**
   * Drops every cached store, so the next `open()` reads its file again. For
   * tests that need to observe what a restart, or a change made outside this
   * process, would see. It drops the stores open windows hold too, so a
   * window opened after it gets a second store for the profile's file: a
   * browser test, whose windows outlive it, has no use for it, since a path
   * of its own is fresh to `open()`.
   *
   * A restart writes what is waiting first (the shutdown blocker), and so
   * does this. Each write reaches IOUtils before this returns, and IOUtils
   * runs its operations in the order they arrive, so a file read or removed
   * after this sees the write.
   */
  forgetCachedValues() {
    for (const store of openStores) {
      if (store._saver.isPending) {
        store
          .flush()
          .catch(err =>
            SvalLog.warn(
              `writing device-local settings failed: ${SvalLog.errorName(err)}`
            )
          );
      }
    }
    openStores.clear();
    this._openPromises.clear();
  },

  /**
   * Reads `path` into a fresh store.
   *
   * These are preferences. `SvalIdentity` refuses to load a damaged file,
   * because a second identity beside an unreadable first would orphan
   * published data. A damaged settings file costs at most a re-collapsed tree
   * or a panel on the wrong side, so this starts over with defaults.
   * `readJSONOrSetAside` logs why and moves the damaged file aside as
   * `<name>.corrupt`, so the next `flush()` cannot destroy what it held.
   *
   * @param {string} path
   * @returns {Promise<SvalLocalSettingsStore>}
   */
  async _load(path) {
    const stored = await readJSONOrSetAside(path, "the local settings file");
    const store = new SvalLocalSettingsStore(path);
    openStores.add(store);
    if (stored && typeof stored === "object") {
      const { placement, panelWidth } = this.layoutOf(stored);
      store._placement = placement;
      store._panelWidth = panelWidth;
      if (typeof stored.sharedFolder === "string") {
        store._sharedFolder = stored.sharedFolder;
      }
      if (Array.isArray(stored.seededSettings)) {
        store._seededSettings = new Set(stringsOf(stored.seededSettings));
      }
      store._firstRunStarted = stored.firstRunStarted === true;
      store._firstRunDone = stored.firstRunDone === true;
      if (Array.isArray(stored.expanded)) {
        store._expanded = new Set(stringsOf(stored.expanded));
      }
      // A file's single `selection` names no workspace, so it is not read:
      // each window selects the tab it shows once its tabs are observed.
      if (stored.selections && typeof stored.selections === "object") {
        store._selections = new Map(
          Object.entries(stored.selections).filter(
            ([, id]) => typeof id === "string"
          )
        );
      }
      if (stored.lastPins && typeof stored.lastPins === "object") {
        store._lastPins = new Map(
          Object.entries(stored.lastPins).filter(
            ([, pin]) =>
              typeof pin?.guid === "string" && Number.isFinite(pin?.when)
          )
        );
      }
      if (Array.isArray(stored.userHistory)) {
        store._userHistory = new Set(stringsOf(stored.userHistory));
      }
      store._backupSaved = stored.backupSaved === true;
      if (
        typeof stored.lastSync?.folder === "string" &&
        Number.isFinite(stored.lastSync.at)
      ) {
        store._lastSync = {
          folder: stored.lastSync.folder,
          at: stored.lastSync.at,
        };
      }
      if (Array.isArray(stored.oldKeyDirs)) {
        store.oldKeyDirs = stored.oldKeyDirs;
      }
      if (Array.isArray(stored.dismissedOtherWorkspaces)) {
        store._dismissedOtherWorkspaces = new Set(
          stringsOf(stored.dismissedOtherWorkspaces)
        );
      }
      if (Array.isArray(stored.webDriverWorkspaces)) {
        store._leftWebDriverWorkspaces = stringsOf(stored.webDriverWorkspaces);
      }
      if (Array.isArray(stored.userHeld)) {
        store._userHeld = new Set(stringsOf(stored.userHeld));
      }
      if (Array.isArray(stored.agentStopped)) {
        store._agentStopped = new Set(stringsOf(stored.agentStopped));
      }
      if (stored.lastActive && typeof stored.lastActive === "object") {
        store._lastActive = new Map(
          Object.entries(stored.lastActive).filter(([, when]) =>
            Number.isFinite(when)
          )
        );
      }
    }
    return store;
  },
};
