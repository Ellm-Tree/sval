/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The shared folder and the sync key it is read with: choosing a folder,
 * another key's workspaces found in it, adopting a key from pairing or a
 * backup, setting up sync again, and stale pairing offers.
 *
 * `SvalWindow` loads this as a classic script after `sval-panel.js`; it adds
 * its methods to `SvalPanel`, whose state and helpers it shares.
 */

/* import-globals-from sval-panel.js */

Object.assign(SvalPanel, {
  /**
   * Another sync key's directories in the shared folder that are not
   * dismissed; see `_lookForOtherWorkspaces`.
   */
  _otherWorkspaces: [],

  /** The folder `_otherWorkspaces` was found in, or null. */
  _otherWorkspacesIn: null,

  /**
   * The folder this device's sealed key copy was written into, and the
   * fingerprint of that key, or null.
   */
  _keyCopyPublished: null,

  /** The removal of a replaced key's directories in flight, or null. */
  _removingOldKeyDirs: null,

  /** When the shared folder was last looked at for them, or null. */
  _otherWorkspacesCheckedAt: null,

  /** How often it is looked at: ten minutes. A test shortens it. */
  _otherWorkspacesCheckMs: 10 * 60 * 1000,

  /**
   * Whether this launch still owes the shared folder its sweep of stale
   * pairing offers; see `_sweepPairingOffers`.
   */
  _sweepPending: false,

  /**
   * Clears an abandoned pairing offer out of the shared folder.
   *
   * Spec §6.7 bounds an offer at an hour and says any device that sees a stale
   * one may remove it, because the device that made it may have been closed
   * before it could withdraw its own. The settings page sweeps too, but only
   * someone who opens it sweeps there, and nobody opens a settings page to
   * clean up after a device they have already stopped using.
   *
   * **Startup, not the sync pass.** A sweep is a directory listing plus a read
   * per file; on the five-second poll that is a cost paid every five seconds
   * for an hour-long window. Once a launch is often enough for an expiry
   * measured in an hour.
   *
   * Only when the folder is shared: this device's own location holds no offer
   * and none is looked for there.
   */
  _sweepPairingOffers() {
    const root = this.sharedRootSetting();
    if (!root) {
      return Promise.resolve();
    }
    return this._modules.SvalPairing.sweep(root).catch(err =>
      this._modules.SvalLog.warn(
        `sweeping stale pairing offers failed: ${this._modules.describeError(err)}`
      )
    );
  },

  /**
   * What a step that reached the shared folder is followed by: looking for
   * another key's workspaces, leaving this device's sealed key copy, and
   * removing what a replaced key could read.
   *
   * @param {object} report The step's report.
   */
  _afterReachingFolder(report) {
    this._lookForOtherWorkspaces(report);
    this._publishKeyCopy();
    if (this._settings.oldKeyDirs.length) {
      this._removeOldKeysFiles();
    }
  },

  /**
   * Makes `path` the folder this device exchanges files through, or stops
   * sharing when it is null (local-copy spec §4.5).
   *
   * Nothing moves. This device's copy stays in the profile, and the next pass
   * that reaches `path` publishes there: an empty folder receives this
   * device's file and one that holds Sval files is merged with it. A folder Sval
   * cannot reach yet is still the user's choice, so it is kept and the words
   * say what will happen.
   *
   * Choosing the folder is what makes `sval/` in it (`markSharedRoot`), so
   * choosing again the folder already chosen makes it again when Sval cannot
   * find it there.
   *
   * The engine is handed `sharedRootSetting()` rather than `path`, so a folder
   * that is this device's own location shares nowhere.
   *
   * **Setting up to share makes the sync key** when `mint` is set and this
   * device has none (key-storage spec, "Becoming a syncing device"). It is
   * made before the folder is recorded, so a device never names a folder it
   * holds no key for. A device with a key it cannot use keeps it: that key
   * comes back by pairing, and a new one would split the user's workspaces.
   *
   * @param {string|null} path An absolute path, or null for none: the
   *   storage folder, or the `TOP_DIR` folder inside it.
   * @param {object} [options]
   * @param {boolean} [options.mint] Whether this is a device setting up to
   *   share on its own, rather than joining another's.
   * @returns {Promise<object>} `{ reached, message, unreachable, problem,
   *   keyStoreRefused, line }`, where `message` is the settings page's sentence
   *   when there is something to say, `unreachable` marks one that says the
   *   folder cannot be reached, `keyStoreRefused` one where the system store
   *   would not answer when the sync key was being made, and `line`, a
   *   `SvalPanelModel.pairingLine`, is set when joining the key found in the
   *   folder failed, so the page can offer its button, with that join's
   *   `failure` and `problem` beside it. `problem` names why a folder was not
   *   reached, as `SvalSharedFolder.folderProblem` does.
   */
  async chooseSharedFolder(path, { mint = false } = {}) {
    if (!this._engine) {
      return {
        reached: false,
        message: "Sval isn't ready yet. The folder didn't change.",
      };
    }
    // A user who picks the folder Sval keeps its files in means the folder
    // that holds it (spec §6.4). Every Sval file lives under `TOP_DIR`, so
    // a folder of that name the user made fills with Sval's files either way.
    if (path !== null && PathUtils.filename(path) === this._modules.TOP_DIR) {
      path = PathUtils.parent(path);
    }
    let found = null;
    if (
      mint &&
      path !== null &&
      this.syncState.keyState ===
        this._modules.SvalIdentity.SYNC_KEY_STATES.none
    ) {
      // A folder that already holds Sval workspaces belongs to the user's other
      // devices, and a new key would put a second set beside theirs. When
      // this user's own sealed copy is there, Sval was installed here before,
      // and that key joins them with nothing asked. Otherwise the user is
      // told how to join. A folder that does not answer is set up anyway; a
      // later pass finds them.
      const occupied = (await this._engine.otherWorkspaces(path))?.length;
      found = occupied ? await this._keyInFolder(path) : null;
      if (occupied && !found) {
        return {
          reached: false,
          otherWorkspaces: true,
          message:
            "This folder already has Sval Workspaces. To sync with them, " +
            'choose "Sync with another device" in Settings, then type the ' +
            "code that a device using them shows.",
        };
      }
    }
    if (
      !found &&
      mint &&
      path !== null &&
      this.syncState.keyState ===
        this._modules.SvalIdentity.SYNC_KEY_STATES.none
    ) {
      try {
        this._engine.useSyncKey(await this._modules.SvalIdentity.mintSyncKey());
      } catch (err) {
        this._modules.SvalLog.error(
          `could not make a sync key: ${this._modules.describeError(err)}`
        );
        // A store that will not answer is one the user may have refused, as
        // macOS's Keychain prompt allows. Choosing again asks it again
        // (`SvalSecretStore._firstFile`).
        return {
          reached: false,
          keyStoreRefused:
            err instanceof this._modules.SvalSecretStore.UnreadableError,
          message:
            "Sval couldn't save a sync key on this device, so the folder " +
            "didn't change.",
        };
      }
      this.syncState.setKeyState(
        this._modules.SvalIdentity.SYNC_KEY_STATES.present
      );
      this._settings.backupSaved = false;
      this._offerBackupLater();
    }
    // A key found in the folder is joined even when the folder is the one
    // already chosen, so Try Again after a failed join tries the join again.
    if (!found && path === this.sharedRootSetting()) {
      if (path !== null && this.syncState.folderState === "unreachable") {
        return this.useFolderAgain();
      }
      return {
        reached: this.syncState.folderState !== "unreachable",
        message: null,
      };
    }
    this._settings.sharedFolder = path;
    const shared = this.sharedRootSetting();
    this._engine.setSharedRoot(shared);
    // What was known belonged to the folder just left, and the next step to
    // reach this one looks in it for another key's workspaces.
    this.syncState.leftFolder();
    this._otherWorkspacesCheckedAt = null;
    await this._flushSettings();
    if (shared !== null) {
      // A folder it could not be made in is still the choice: the steps find
      // it unavailable, and the settings page offers to make it again.
      await this._engine.markSharedRoot();
    }
    if (found) {
      const joined = await this.adoptKey(found);
      if (joined.adopted) {
        return {
          reached: true,
          joined: true,
          message:
            "Sval found your sync key in this folder, from when it was " +
            "installed here before, and is syncing your Workspaces.",
        };
      }
      // Choosing a folder sets sync up on this device, so a join that fails
      // here is told as Set Up Sync Again's is (messages spec §7).
      const line = this._modules.SvalPanelModel.pairingLine(
        joined,
        this._modules.AppConstants.platform,
        "Setup"
      );
      return {
        reached: false,
        message: line.text,
        line,
        failure: joined.failure,
        problem: joined.problem,
      };
    }
    // A device with no sync key runs no shared step, so no pass can find the
    // folder reached. A joining device needs only to read it: its key, or the
    // other device's offer, arrives there.
    if (
      shared !== null &&
      this.syncState.keyState ===
        this._modules.SvalIdentity.SYNC_KEY_STATES.none
    ) {
      if ((await this._engine.otherWorkspaces(shared)) !== null) {
        return { reached: true, message: null };
      }
      return {
        reached: false,
        unreachable: true,
        message: "Can't reach this folder yet. Sval syncs when it's back.",
      };
    }
    await this.syncWithFolder();
    if (shared === null || this.syncState.folderState === "reached") {
      return { reached: true, message: null };
    }
    if (this.syncState.folderState === "too-large") {
      return {
        reached: false,
        unreachable: true,
        problem: this.syncState.folderProblem,
        message: this._modules.SvalPanelModel.SYNC_FILES_TOO_LARGE,
      };
    }
    return {
      reached: false,
      unreachable: true,
      problem: this.syncState.folderProblem,
      message: "Can't reach this folder yet. Sval syncs when it's back.",
    };
  },

  /**
   * This user's sync key, from a sealed copy Sval left in `root` when it was
   * installed here before, or null (key-storage spec, "Installing again").
   *
   * A copy counts only when this user's system secret opens it and the key
   * inside names the workspaces in `root`: another machine's copy does not
   * open, and a stale one opens nothing there. The key this device already
   * syncs with is not one found: its own copy, which a step that reached the
   * folder can have left there a moment before, would otherwise answer a
   * device looking for the workspaces of another.
   *
   * @param {string} root The folder.
   * @returns {Promise<Uint8Array|null>}
   */
  async _keyInFolder(root) {
    const { SvalICloudKeychain, SvalTree, SvalSecretStore } = this._modules;
    const copies = (await this._engine.keyCopies(root).catch(() => null)) ?? [];
    const candidates = [];
    for (const sealed of copies) {
      candidates.push(await SvalSecretStore.unwrap(sealed));
    }
    // A new Mac, or this one with its system store wiped, finds the key in
    // iCloud Keychain instead (decision 0084).
    candidates.push(SvalICloudKeychain.read());
    const held = this._engine.syncKey;
    const isHeld = keyBytes =>
      held?.length === keyBytes.length &&
      held.every((byte, i) => byte === keyBytes[i]);
    for (const keyBytes of candidates) {
      if (
        keyBytes?.length === 32 &&
        !isHeld(keyBytes) &&
        (await this._engine
          .opensWorkspacesHere(keyBytes, SvalTree.SYNC_DOCUMENT, root)
          .catch(() => false))
      ) {
        return keyBytes;
      }
    }
    return null;
  },

  /**
   * For first run's join step: a key found in the chosen folder, held for
   * `_firstRunAdopt` as a claimed code's would be, so a reinstall
   * joins without a code or another device.
   *
   * @returns {Promise<object>} `{ found }`.
   */
  async _firstRunRecover() {
    const root = this.sharedRootSetting();
    const keyBytes = root ? await this._keyInFolder(root) : null;
    if (!keyBytes) {
      return { found: false };
    }
    this._firstRunJoin = {
      code: null,
      claimed: { keyBytes, path: null },
      landed: false,
      stopped: false,
    };
    return { found: true };
  },

  /**
   * For Settings' "Sync with another device": joins with a key
   * found in the chosen folder, or answers null so the page asks for a code.
   *
   * @returns {Promise<object|null>} what `adoptKey` answered, or null.
   */
  async joinWithKeyInFolder() {
    const root = this.sharedRootSetting();
    const keyBytes = root ? await this._keyInFolder(root) : null;
    return keyBytes ? this.adoptKey(keyBytes) : null;
  },

  /**
   * Writes this device's sealed copy of the sync key into the folder, once
   * per key and folder per session, so Sval installed again for this user
   * finds it in whichever folder it is pointed at.
   * Nothing is written on a machine whose secrets live in the profile: it has
   * no system secret to seal with.
   */
  async _publishKeyCopy() {
    const { SvalIdentity, SvalLog, SvalSecretStore } = this._modules;
    const keyBytes = this._engine?.syncKey;
    if (!keyBytes) {
      return;
    }
    const copy = {
      root: this.sharedRootSetting(),
      fingerprint: await SvalIdentity.fingerprintOf(keyBytes),
    };
    const published = this._keyCopyPublished;
    if (
      published?.root === copy.root &&
      published.fingerprint === copy.fingerprint
    ) {
      return;
    }
    this._keyCopyPublished = copy;
    try {
      const sealed = await SvalSecretStore.wrap(keyBytes);
      if (!sealed || !(await this._engine.publishKeyCopy(sealed, copy.root))) {
        this._keyCopyPublished = sealed ? null : copy;
      }
    } catch (err) {
      this._keyCopyPublished = null;
      SvalLog.warn(
        `the sealed key copy was not written: ${SvalLog.errorName(err)}`
      );
    }
  },

  /**
   * Makes `sval/` in the chosen folder again and syncs with it. The settings
   * page's answer to a folder Sval cannot find its files in: one that was
   * deleted, a share that is back but empty (local-copy spec §4.6), or a
   * folder that never held `sval/`. Sval never does this unasked, because it
   * cannot tell those from an unmounted share.
   *
   * @returns {Promise<object>} `{ reached, message }`.
   */
  async useFolderAgain() {
    const path = this.sharedRootSetting();
    if (!this._engine || !path) {
      return { reached: false, message: null };
    }
    await this._engine.markSharedRoot();
    await this.syncWithFolder();
    if (this.syncState.folderState === "too-large") {
      return {
        reached: false,
        unreachable: true,
        problem: this.syncState.folderProblem,
        message: this._modules.SvalPanelModel.SYNC_FILES_TOO_LARGE,
      };
    }
    return this.syncState.folderState === "reached"
      ? { reached: true, message: null }
      : {
          reached: false,
          unreachable: true,
          message: "Still can't reach this folder.",
        };
  },

  /**
   * Joins `keyBytes`, a key `SvalPairing.claim` recovered from the folder,
   * carrying this device's workspaces into the document it names
   * (`SvalKeyJoin`, spec §6.7): publish, then persist, then move the profile
   * onto it. Until the last step the profile's engine stays on its own key,
   * so nothing here has to be undone when a join fails.
   *
   * @param {Uint8Array} keyBytes The 32-byte key from the other device.
   * @param {string} [offerPath] The claimed offer, deleted once the key is
   *   stored. Omitted when there is no offer to withdraw.
   * @param {object} [options]
   * @param {object} [options.retiring] Set Up Sync Again's record of the old
   *   key's directories; see `SvalKeyJoin.join`.
   * @returns {Promise<object>} `{ adopted, outcome, failure, problem,
   *   message }`. `failure` and `problem` are `SvalKeyJoin.join`'s, `failure`
   *   `"own-unreadable"` for a panel with no engine, and `message` is
   *   `SvalPanelModel.pairingLine`'s text.
   *   `outcome` is one of:
   *   - `"adopted"`: done; the key is stored, the profile is on it, and the
   *     offer is withdrawn.
   *   - `"unchanged"`: it did not work. The same code still works.
   *   - `"published"`: the workspaces reached the other document and the key
   *     did not save. This device stays on its own key, and the same code
   *     tries again.
   */
  async adoptKey(keyBytes, offerPath = null, { retiring = null } = {}) {
    if (this._inMemory) {
      throw Object.assign(
        new Error("sval: a window on a tree in memory does not pair"),
        { code: "memory_tree" }
      );
    }
    // Waiting, not refusing (spec §6.7). Someone who typed a code while this
    // window was still starting asked a question Sval can answer a moment
    // later. `_started` resolves whether startup succeeded or not, so a
    // startup that failed falls through to the check below rather than
    // hanging here. Except from inside first run, which is part of startup:
    // it runs after the first pass, with the engine up, and `_started` waits
    // for it.
    if (!this._firstRunInFlight) {
      await this._started.promise;
    }
    if (!this._engine) {
      return this._adoptionResult({
        outcome: "unchanged",
        failure: "own-unreadable",
        reason: "the panel has no engine, so there was nothing to join",
      });
    }
    const joined = await this._modules.SvalKeyJoin.join(
      this._engine,
      keyBytes,
      {
        offerPath,
        retiring,
      }
    );
    if (joined.report) {
      // Every window hears the join's pass through its pass listener; this
      // one has also drawn it by the time it answers.
      await this.refresh().catch(err =>
        this._modules.SvalLog.warn(
          `could not redraw after joining: ${this._modules.describeError(err)}`
        )
      );
    }
    return this._adoptionResult(joined);
  },

  /**
   * Logs how a pairing ended and returns what `adoptKey` resolves to. The
   * line a person reads is the caller's to show, in Settings or first run
   * (messages spec §7).
   *
   * @param {object} joined `SvalKeyJoin.join`'s answer.
   * @param {string} joined.outcome One of the outcomes `adoptKey` names.
   * @param {string} [joined.failure] What stopped a join that did not finish.
   * @param {string} [joined.problem] Why the folder was not reached, for a
   *   `"folder"` failure.
   * @param {string} [joined.reason] The same, for the log alone.
   */
  _adoptionResult({ outcome, failure = null, problem = null, reason = null }) {
    // A reason only ever accompanies a failure, so the reason is what decides
    // the level: an adoption that did not finish is an operation the user
    // asked for and did not get, while one that did is lifecycle. Both are
    // logged, because a key adoption is the one act that changes which
    // document this device belongs to.
    if (reason) {
      this._modules.SvalLog.error(`pairing ended as ${outcome}: ${reason}`);
    } else {
      this._modules.SvalLog.info(`pairing ended as ${outcome}`);
    }
    const adopted = outcome === "adopted";
    const shown = { adopted, failure: adopted ? null : failure };
    const { text } = this._modules.SvalPanelModel.pairingLine(
      shown,
      this._modules.AppConstants.platform
    );
    return {
      adopted,
      outcome,
      failure: shown.failure,
      problem: adopted ? null : problem,
      message: text,
    };
  },

  /**
   * Looks in the shared folder for another sync key's workspaces, at most
   * once per {@link _otherWorkspacesCheckMs}: two devices set up as new
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
  async _lookForOtherWorkspaces(report) {
    const { HISTORY_INDEX, SvalIdentity } = this._modules;
    const now = Date.now();
    if (
      this.syncState.keyState !== SvalIdentity.SYNC_KEY_STATES.present ||
      !report.sharedRead.includes(HISTORY_INDEX) ||
      (this._otherWorkspacesCheckedAt !== null &&
        now - this._otherWorkspacesCheckedAt < this._otherWorkspacesCheckMs)
    ) {
      return;
    }
    this._otherWorkspacesCheckedAt = now;
    const folder = this.sharedRootSetting();
    const names = this._engine
      ? await this._engine
          .otherWorkspaces(undefined, await this._documentsOfThisKey())
          .catch(() => null)
      : null;
    if (!names) {
      // The folder did not answer: try next step.
      this._otherWorkspacesCheckedAt = null;
      return;
    }
    const shown = names.filter(
      name => !this._settings.isDismissedOtherWorkspace(name)
    );
    if (
      folder === this._otherWorkspacesIn &&
      shown.join() === this._otherWorkspaces.join()
    ) {
      return;
    }
    this._otherWorkspaces = shown;
    this._otherWorkspacesIn = folder;
    this.drawIndicator();
  },

  /**
   * Every document a device on this sync key publishes besides the tree,
   * which the engine names for itself: the ones every device runs, and each
   * week the history index lists. A peer publishes weeks this device has
   * never held, and the index is the only place their names are found
   * (history-sync spec §2).
   *
   * @returns {Promise<string[]>}
   */
  async _documentsOfThisKey() {
    const {
      ARCHIVE_DOCUMENT,
      FAVORITES_DOCUMENT,
      HISTORY_INDEX,
      SvalSettingsRegistry,
    } = this._modules;
    const weeks = await this._engine.shards(HISTORY_INDEX).catch(err => {
      this._modules.SvalLog.warn(
        `could not read the history index: ${this._modules.describeError(err)}`
      );
      return [];
    });
    return [
      ARCHIVE_DOCUMENT,
      FAVORITES_DOCUMENT,
      SvalSettingsRegistry.SETTINGS_DOCUMENT,
      HISTORY_INDEX,
      ...weeks.map(week => week.name),
    ];
  },

  /** The unpaired-device indicator's dismiss button. */
  async _dismissOtherWorkspaces() {
    for (const name of this._otherWorkspaces) {
      this._settings.dismissOtherWorkspace(name);
    }
    this._otherWorkspaces = [];
    this._settings.saveSoon();
    this.drawIndicator();
  },

  /**
   * Offers the backup of the sync key once the current step has returned, so
   * the dialog never holds up the settings page or first run that made the
   * key.
   */
  _offerBackupLater() {
    Services.tm.dispatchToMainThread(() =>
      this.offerBackup().catch(err =>
        this._modules.SvalLog.warn(
          `the backup was not offered: ${this._modules.SvalLog.errorName(err)}`
        )
      )
    );
  },

  /**
   * Shows the backup of the sync key (key-storage spec, "Backup and
   * recovery"), and records it as saved when the user saves or prints it.
   *
   * @returns {Promise<boolean>} whether it was saved.
   */
  async offerBackup() {
    const { SvalBackupKey, SvalIdentity } = this._modules;
    const sync = await SvalIdentity.syncKey();
    if (sync.state !== SvalIdentity.SYNC_KEY_STATES.present) {
      return false;
    }
    const saved = await SvalBackupKey.show(window, {
      keyBytes: sync.bytes,
      fingerprint: await SvalIdentity.fingerprintOf(sync.bytes),
      sharedRoot: this.sharedRootSetting(),
    });
    if (saved) {
      this._settings.backupSaved = true;
      await this._flushSettings();
    }
    return saved;
  },

  /**
   * Asks before setting up sync again.
   *
   * @returns {Promise<boolean>}
   */
  async _confirmSetUpSyncAgain() {
    const answer = await this._modules.openSvalDialog(window, {
      icon: "key",
      tone: "danger",
      title: "Set up sync again with a new sync key?",
      body:
        "Sval makes a new sync key and publishes this device's Workspaces " +
        "under it. Your other devices stop syncing until you give each one " +
        "a new code. Sval removes the old files from your sync folder, so the " +
        "old key can't read them anymore.",
      primary: "Set up sync again",
    });
    return answer.ok;
  },

  /**
   * Sets up sync again with a new sync key (key-storage spec, "Starting over
   * with a new sync key"): the recovery while any device survives, and the
   * only way to shut out a lost one.
   *
   * The new key goes through the same publish-then-persist adoption pairing
   * uses, so a failure leaves the old key and the folder as they were. Only
   * once the new key is stored is the old key's directory removed. A device
   * that no longer has the old key cannot name that directory, and later
   * passes offer it as another device's workspaces, which can be dismissed.
   * Old files left behind go unmentioned (messages spec §7): later steps keep
   * removing them.
   *
   * @returns {Promise<object>} `{ done, failure }`. `failure` is null when it
   *   was done or the user declined, and otherwise a `SvalKeyJoin.join`
   *   failure for `SvalPanelModel.pairingLine`.
   */
  async setUpSyncAgain() {
    if (!this.sharedRootSetting()) {
      return { done: false, failure: "no-folder" };
    }
    if (this._inMemory || !this._engine) {
      return { done: false, failure: "own-unreadable" };
    }
    if (!(await this._confirmSetUpSyncAgain())) {
      return { done: false, failure: null };
    }
    const previous = this._engine.syncKey;
    const fresh = new Uint8Array(32);
    crypto.getRandomValues(fresh);
    // Recorded by the join once the new key is stored, in the same step as
    // the swap, so the list never names the directories of a key this device
    // is still on.
    const oldDirs = previous
      ? await this._engine.workspaceDirsOf(
          previous,
          await this._publishedDocumentNames()
        )
      : [];
    const result = await this.adoptKey(fresh, null, {
      retiring: { settings: this._settings, dirs: oldDirs },
    });
    if (!result.adopted) {
      return { done: false, failure: result.failure };
    }
    if (!(await this._removeOldKeysFiles())) {
      this._modules.SvalLog.warn(
        "the old sync key's files were not all removed"
      );
    }
    this._settings.backupSaved = false;
    await this._flushSettings();
    this._offerBackupLater();
    return { done: true, failure: null };
  },

  /**
   * Every document this profile's syncs publish besides the tree, whether or
   * not one is loaded: a launch whose Favorites, history or archive have not
   * started yet holds none of theirs, and a history week is let go of once it
   * is past. The history index lists every week (history-sync spec §2).
   *
   * @returns {Promise<string[]>}
   */
  async _publishedDocumentNames() {
    const {
      ARCHIVE_DOCUMENT,
      FAVORITES_DOCUMENT,
      HISTORY_INDEX,
      SvalSettingsRegistry,
    } = this._modules;
    const weeks = await this._engine.shards(HISTORY_INDEX);
    return [
      SvalSettingsRegistry.SETTINGS_DOCUMENT,
      FAVORITES_DOCUMENT,
      ARCHIVE_DOCUMENT,
      HISTORY_INDEX,
      ...weeks.map(week => week.name),
    ];
  },

  /**
   * Removes the directories a replaced sync key could read, and keeps trying
   * on later steps, across restarts, until they are gone: setting up sync
   * again is what shuts a lost device out, so its files must not quietly
   * stay. Only the directories' names are kept, never the key.
   *
   * @returns {Promise<boolean>} whether everything is gone.
   */
  async _removeOldKeysFiles() {
    // One removal at a time, and anything recorded while it ran is kept: a
    // second Set Up Sync Again can add directories mid-removal.
    this._removingOldKeyDirs ??= (async () => {
      const dirs = this._settings.oldKeyDirs;
      if (!dirs.length || !this._engine) {
        return;
      }
      const left = await this._engine.removeWorkspaceDirs(dirs);
      const added = this._settings.oldKeyDirs.filter(
        dir => !dirs.includes(dir)
      );
      this._settings.oldKeyDirs = [...left, ...added];
      await this._flushSettings();
    })().finally(() => {
      this._removingOldKeyDirs = null;
    });
    await this._removingOldKeyDirs;
    return !this._settings.oldKeyDirs.length;
  },

  /**
   * Takes the sync key back from a typed backup, after checking that it opens
   * the workspaces in this device's folder.
   *
   * @param {string} text What was typed.
   * @returns {Promise<object>} `{ restored, message, failure, problem,
   *   refused }`. `failure` and `problem` are set as `adoptKey`'s when the key
   *   fitted the folder and the join failed, and `message` is then
   *   `SvalPanelModel.pairingLine`'s "Restore failed:" line. `refused` names why the key was not tried: `not-a-key`,
   *   `no-folder`, `unreachable` or `mismatch`.
   */
  async restoreFromBackup(text) {
    const { SvalPanelModel, SvalTree } = this._modules;
    const keyBytes = SvalPanelModel.fromBackupCode(text);
    if (!keyBytes) {
      return {
        restored: false,
        refused: "not-a-key",
        message: "That isn't a sync key backup. Check what you typed.",
      };
    }
    if (!this._engine || !this.sharedRootSetting()) {
      return {
        restored: false,
        refused: "no-folder",
        message: "Choose your sync folder first.",
      };
    }
    const opens = await this._engine
      .opensWorkspacesHere(keyBytes, SvalTree.SYNC_DOCUMENT)
      .catch(() => null);
    if (opens === null) {
      return {
        restored: false,
        refused: "unreachable",
        message: "Can't reach your sync folder. Try again when it's back.",
      };
    }
    if (!opens) {
      return {
        restored: false,
        refused: "mismatch",
        message: "That key doesn't match the Workspaces in this folder.",
      };
    }
    const result = await this.adoptKey(keyBytes);
    if (result.adopted) {
      return { restored: true, message: "Done. Both devices are synced." };
    }
    const line = SvalPanelModel.pairingLine(
      result,
      this._modules.AppConstants.platform,
      "Restore"
    );
    return {
      restored: false,
      failure: result.failure,
      problem: result.problem,
      message: line.text,
    };
  },
});
