/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ARCHIVE_DOCUMENT: "moz-src:///browser/components/sval/SvalArchive.sys.mjs",
  FAVORITES_DOCUMENT:
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
  HISTORY_INDEX: "moz-src:///browser/components/sval/SvalHistorySync.sys.mjs",
  SvalIdentity: "moz-src:///browser/components/sval/SvalIdentity.sys.mjs",
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  SvalPairing: "moz-src:///browser/components/sval/SvalPairing.sys.mjs",
  SvalSecretStore: "moz-src:///browser/components/sval/SvalSecretStore.sys.mjs",
  SvalSettingsRegistry:
    "moz-src:///browser/components/sval/SvalSettingsRegistry.sys.mjs",
  SvalSyncState: "moz-src:///browser/components/sval/SvalSyncState.sys.mjs",
  describeError: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
});

/** Each engine's upkeep. */
const upkeeps = new WeakMap();

/**
 * What a profile does in its shared folder besides syncing, after each
 * step that reaches it: clearing stale pairing offers once a launch, looking
 * for another sync key's workspaces, leaving this device's sealed copy of
 * the key, and removing what a replaced key could read.
 *
 * One per engine. Every window of a profile hears the engine's steps, and
 * the folder is looked at once for all of them.
 */
export class SvalFolderUpkeep {
  /** How often the folder is looked at for another key's workspaces. */
  static OTHER_WORKSPACES_CHECK_MS = 10 * 60 * 1000;

  #engine;

  /** The profile's `SvalLocalSettings` store; see {@link startFor}. */
  #settings;

  /**
   * Whether this launch still owes the shared folder its sweep of stale
   * pairing offers; see {@link #sweepPairingOffers}.
   */
  #sweepPending = true;

  /** When the shared folder was last looked at, or null. */
  #otherWorkspacesCheckedAt = null;

  /**
   * The folder this device's sealed key copy was written into, and the
   * fingerprint of that key, or null.
   */
  #keyCopyPublished = null;

  /** The removal of a replaced key's directories in flight, or null. */
  #removingOldKeyDirs = null;

  /**
   * Starts `engine`'s upkeep, or gives the one running its settings.
   *
   * @param {SvalEngine} engine The profile's engine.
   * @param {object} settings The profile's `SvalLocalSettings` store, which
   *   holds what the user dismissed and the directories still to remove.
   * @returns {SvalFolderUpkeep}
   */
  static startFor(engine, settings) {
    let upkeep = upkeeps.get(engine);
    if (!upkeep) {
      upkeep = new SvalFolderUpkeep(engine);
      upkeeps.set(engine, upkeep);
    }
    upkeep.#settings = settings;
    return upkeep;
  }

  /**
   * @param {SvalEngine} engine
   * @returns {SvalFolderUpkeep|null} `engine`'s upkeep, or null when none
   *   was started.
   */
  static of(engine) {
    return upkeeps.get(engine) ?? null;
  }

  constructor(engine) {
    this.#engine = engine;
    engine.addSharedListener(report => {
      if (report.shared === "reached") {
        this.#afterReachingFolder(report);
      }
    });
  }

  /**
   * @param {object} report The step's report.
   */
  #afterReachingFolder(report) {
    if (this.#sweepPending) {
      this.#sweepPending = false;
      this.#sweepPairingOffers();
    }
    this.#lookForOtherWorkspaces(report);
    this.#publishKeyCopy();
    if (this.#settings.oldKeyDirs.length) {
      this.removeOldKeysFiles();
    }
  }

  /**
   * Clears an abandoned pairing offer out of the shared folder.
   *
   * Spec §6.7 bounds an offer at an hour and says any device that sees a
   * stale one may remove it, because the device that made it may have been
   * closed before it could withdraw its own. The settings page sweeps too,
   * but only someone who opens it sweeps there, and nobody opens a settings
   * page to clean up after a device they have already stopped using.
   *
   * **Once a launch, on its first step to reach the folder.** A sweep is a
   * directory listing plus a read per file; on the five-second poll that is
   * a cost paid every five seconds for an hour-long window.
   */
  #sweepPairingOffers() {
    lazy.SvalPairing.sweep(this.#engine.sharedRoot).catch(err =>
      lazy.SvalLog.warn(
        `sweeping stale pairing offers failed: ${lazy.describeError(err)}`
      )
    );
  }

  /**
   * Has the next step that reaches the folder look for another key's
   * workspaces whenever the last look was: the profile chose another folder.
   */
  lookAgain() {
    this.#otherWorkspacesCheckedAt = null;
  }

  /**
   * Looks in the shared folder for another sync key's workspaces, at most
   * once per {@link OTHER_WORKSPACES_CHECK_MS}: two devices set up as new
   * before either's files reached the other each made a key, and providers
   * take up to half an hour to deliver (spec §6.4). One found and not
   * dismissed puts the indicator in its unpaired-device state.
   *
   * Only after a step that read this key's history index from the folder:
   * before that, the index lists none of the weeks a peer published, and
   * their directories would read as another key's. A device that joins in
   * first run reaches the folder before history has begun.
   *
   * @param {object} report The step's report.
   */
  async #lookForOtherWorkspaces(report) {
    const state = lazy.SvalSyncState.of(this.#engine);
    const now = Date.now();
    if (
      state.keyState !== lazy.SvalIdentity.SYNC_KEY_STATES.present ||
      !report.sharedRead.includes(lazy.HISTORY_INDEX) ||
      (this.#otherWorkspacesCheckedAt !== null &&
        now - this.#otherWorkspacesCheckedAt <
          SvalFolderUpkeep.OTHER_WORKSPACES_CHECK_MS)
    ) {
      return;
    }
    this.#otherWorkspacesCheckedAt = now;
    const folder = this.#engine.sharedRoot;
    // A peer publishes weeks this device has never held, and the index is
    // the only place their names are found (history-sync spec §2).
    const weeks = await this.#engine.shards(lazy.HISTORY_INDEX).catch(err => {
      lazy.SvalLog.warn(
        `could not read the history index: ${lazy.describeError(err)}`
      );
      return [];
    });
    const names = await this.#engine
      .otherWorkspaces(undefined, this.#documentNames(weeks))
      .catch(() => null);
    if (!names) {
      // The folder did not answer: try next step.
      this.#otherWorkspacesCheckedAt = null;
      return;
    }
    state.setOtherWorkspaces(
      names.filter(name => !this.#settings.isDismissedOtherWorkspace(name)),
      folder
    );
  }

  /** The unpaired-device indicator's dismiss button. */
  dismissOtherWorkspaces() {
    const state = lazy.SvalSyncState.of(this.#engine);
    for (const name of state.otherWorkspaces) {
      this.#settings.dismissOtherWorkspace(name);
    }
    this.#settings.saveSoon();
    state.setOtherWorkspaces([], state.otherWorkspacesIn);
  }

  /**
   * Every document a device on this sync key publishes besides the tree,
   * which the engine names for itself: the ones every device runs, and each
   * week of history.
   *
   * @param {object[]} weeks The history index's weeks (`SvalEngine.shards`).
   * @returns {string[]}
   */
  #documentNames(weeks) {
    return [
      lazy.ARCHIVE_DOCUMENT,
      lazy.FAVORITES_DOCUMENT,
      lazy.SvalSettingsRegistry.SETTINGS_DOCUMENT,
      lazy.HISTORY_INDEX,
      ...weeks.map(week => week.name),
    ];
  }

  /**
   * Every document this profile's syncs publish besides the tree, whether
   * or not one is loaded: a launch whose Favorites, history or archive have
   * not started yet holds none of theirs, and a history week is let go of
   * once it is past. The history index lists every week (history-sync spec
   * §2).
   *
   * @returns {Promise<string[]>}
   */
  async publishedDocumentNames() {
    return this.#documentNames(await this.#engine.shards(lazy.HISTORY_INDEX));
  }

  /**
   * Writes this device's sealed copy of the sync key into the folder, once
   * per key and folder per session, so Sval installed again for this user
   * finds it in whichever folder it is pointed at.
   * Nothing is written on a machine whose secrets live in the profile: it
   * has no system secret to seal with.
   */
  async #publishKeyCopy() {
    const keyBytes = this.#engine.syncKey;
    if (!keyBytes) {
      return;
    }
    const copy = {
      root: this.#engine.sharedRoot,
      fingerprint: await lazy.SvalIdentity.fingerprintOf(keyBytes),
    };
    const published = this.#keyCopyPublished;
    if (
      published?.root === copy.root &&
      published.fingerprint === copy.fingerprint
    ) {
      return;
    }
    this.#keyCopyPublished = copy;
    try {
      const sealed = await lazy.SvalSecretStore.wrap(keyBytes);
      if (!sealed || !(await this.#engine.publishKeyCopy(sealed, copy.root))) {
        this.#keyCopyPublished = sealed ? null : copy;
      }
    } catch (err) {
      this.#keyCopyPublished = null;
      lazy.SvalLog.warn(
        `the sealed key copy was not written: ${lazy.SvalLog.errorName(err)}`
      );
    }
  }

  /**
   * Removes the directories a replaced sync key could read, and keeps
   * trying on later steps, across restarts, until they are gone: setting up
   * sync again is what shuts a lost device out, so its files must not
   * quietly stay. Only the directories' names are kept, never the key.
   *
   * @returns {Promise<boolean>} whether everything is gone.
   */
  async removeOldKeysFiles() {
    // One removal at a time, and anything recorded while it ran is kept: a
    // second Set Up Sync Again can add directories mid-removal.
    this.#removingOldKeyDirs ??= (async () => {
      const settings = this.#settings;
      const dirs = settings.oldKeyDirs;
      if (!dirs.length) {
        return;
      }
      const left = await this.#engine.removeWorkspaceDirs(dirs);
      const added = settings.oldKeyDirs.filter(dir => !dirs.includes(dir));
      settings.oldKeyDirs = [...left, ...added];
      await settings
        .flush()
        .catch(err =>
          lazy.SvalLog.warn(
            `writing device-local panel state failed: ${lazy.describeError(err)}`
          )
        );
    })().finally(() => {
      this.#removingOldKeyDirs = null;
    });
    await this.#removingOldKeyDirs;
    return !this.#settings.oldKeyDirs.length;
  }
}
