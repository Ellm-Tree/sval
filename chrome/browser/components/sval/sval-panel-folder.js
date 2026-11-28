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
   * @returns {Promise<object>} `{ reached, joining, message, unreachable,
   *   problem, keyStoreRefused, line }`, where `joining` marks a folder that
   *   holds another key's workspaces, chosen with no key to wait for one
   *   (key-storage spec, "Becoming a syncing device"), `message` is the settings page's sentence
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
    // that holds it (spec §6.4). The engine decides by the name, as every
    // device does, and the path is split here, where its separators are known.
    const { SvalRemoteFolder } = this._modules;
    const remote = SvalRemoteFolder.isRemoteRoot(path);
    if (path !== null) {
      const name = remote
        ? SvalRemoteFolder.remoteFilename(path)
        : PathUtils.filename(path);
      if (name !== null && (await this._engine.isTopDirName(name))) {
        const parent = remote
          ? SvalRemoteFolder.remoteParent(path)
          : PathUtils.parent(path);
        if (remote) {
          await SvalRemoteFolder.moveSignIn(path, parent);
        }
        path = parent;
      }
    }
    const { SYNC_KEY_STATES } = this._modules.SvalIdentity;
    const keyState = this.syncState.keyState;
    const keyGone =
      keyState === SYNC_KEY_STATES.missing ||
      keyState === SYNC_KEY_STATES.different;
    let found = null;
    let joining = false;
    let startFresh = false;
    if (
      mint &&
      path !== null &&
      (keyState === SYNC_KEY_STATES.none || keyGone)
    ) {
      // A folder that already holds Sval workspaces belongs to the user's other
      // devices, and a new key would put a second set beside theirs. When
      // this user's own sealed copy is there, Sval was installed here before,
      // and that key joins them with nothing asked. Otherwise the folder is
      // chosen with no key, as first run's join step chooses one, and the
      // device waits for a code or a backup. A folder that does not answer
      // is set up anyway on a device that never synced; a later pass finds
      // what it holds.
      //
      // A device whose key is gone holds no key to tell whose workspaces are
      // whose, so every directory there counts (`otherWorkspaces`). A folder
      // that answered with none holds nothing any key opens, so the device
      // starts over there with a new key, as Start over does: no code or
      // backup could apply.
      const listed = await this._engine.otherWorkspaces(path);
      const occupied = !!listed?.length;
      found = occupied ? await this._keyInFolder(path) : null;
      joining = keyState === SYNC_KEY_STATES.none && occupied && !found;
      startFresh = keyGone && listed !== null && !occupied;
    }
    if (
      !found &&
      !joining &&
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
            `Sval couldn't save a sync key on ${this._thisComputer()}. ` +
            "The sync folder didn't change.",
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
    if (!found && !startFresh && path === this.sharedRootSetting()) {
      if (path !== null && this.syncState.folderState === "unreachable") {
        return this.useFolderAgain();
      }
      return {
        reached: this.syncState.folderState !== "unreachable",
        message: null,
      };
    }
    this._settings.sharedFolder = path;
    // A sign-in is kept only for the folder in use: one kept for a folder
    // left would be a password Sval holds for nothing.
    await SvalRemoteFolder.keepOnly(remote ? path : null);
    const shared = this.sharedRootSetting();
    this._engine.setSharedRoot(shared);
    // What was known belonged to the folder just left, and the next step to
    // reach this one looks in it for another key's workspaces.
    this.syncState.leftFolder();
    this._modules.SvalFolderUpkeep.of(this._engine).lookAgain();
    await this._flushSettings();
    if (shared !== null) {
      // A folder it could not be made in is still the choice: the steps find
      // it unavailable, and the settings page offers to make it again.
      await this._engine.markSharedRoot();
    }
    if (startFresh) {
      return this._startFreshIn();
    }
    if (found) {
      const joined = await this.adoptKey(found);
      if (joined.adopted) {
        return {
          reached: true,
          joined: true,
          message:
            "Sval found your sync key from an earlier install. Your " +
            "Workspaces are syncing again.",
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
        return { reached: true, joining, message: null };
      }
      return {
        reached: false,
        unreachable: true,
        message: this._folderNotReached(),
      };
    }
    const answer = await this.syncWithFolder();
    if (shared === null || this.syncState.folderState === "reached") {
      return { reached: true, message: null };
    }
    // An engine that shares nowhere, because the key it would read the folder
    // with is lost or locked, asked the folder nothing. The indicator says
    // why sync is off.
    if (answer === "none") {
      return { reached: false, message: null };
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
      message: this._folderNotReached(this.syncState.folderProblem),
    };
  },

  /**
   * Starts sync in the chosen folder, which holds no workspaces under any
   * key, on a device whose own key is gone: a new key through the same
   * publish-then-persist adoption Start over uses (`setUpSyncAgain`), with
   * nothing to retire, and its backup offered as for a first key
   * (key-storage spec, "Becoming a syncing device").
   *
   * @returns {Promise<object>} as {@link chooseSharedFolder}.
   */
  async _startFreshIn() {
    const fresh = new Uint8Array(32);
    crypto.getRandomValues(fresh);
    const joined = await this.adoptKey(fresh);
    if (joined.adopted) {
      this._settings.backupSaved = false;
      await this._flushSettings();
      this._offerBackupLater();
      return { reached: true, startedFresh: true, message: null };
    }
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
  },

  /**
   * What a folder chosen and not reached says.
   *
   * @param {string|null} [problem] Why, as `SvalSharedFolder.folderProblem`
   *   names it, when a step said.
   * @returns {string}
   */
  _folderNotReached(problem = null) {
    return problem === "gone"
      ? "Sval can't find the folder. If the folder is on a drive, connect " +
          "the drive."
      : "Sval can't reach the folder. Sval syncs once the folder is " +
          "reachable.";
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
    // iCloud Keychain instead.
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
    // An answer of "none" asked the folder nothing, as in `chooseSharedFolder`.
    if ((await this.syncWithFolder()) === "none") {
      return { reached: false, message: null };
    }
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
          problem: this.syncState.folderProblem,
          message: this._folderNotReached(this.syncState.folderProblem),
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
      title: "Start over with a new sync key?",
      body:
        `Sval makes a new sync key for ${this._thisComputer()}. Other ` +
        "devices stop syncing until you add each device again. If " +
        `${this._thisComputer()} still has the old sync key, Sval deletes ` +
        "the old sync key's files from the sync folder.",
      primary: "Start over",
    });
    return answer.ok;
  },

  /**
   * What the words call this computer: `this Mac`, `this PC` or `this
   * computer`.
   *
   * @returns {string}
   */
  _thisComputer() {
    const { AppConstants, SvalPanelModel } = this._modules;
    return `this ${SvalPanelModel.computerNoun(AppConstants.platform)}`;
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
    const upkeep = this._modules.SvalFolderUpkeep.of(this._engine);
    const oldDirs = previous
      ? await this._engine.workspaceDirsOf(
          previous,
          await upkeep.publishedDocumentNames()
        )
      : [];
    const result = await this.adoptKey(fresh, null, {
      retiring: { settings: this._settings, dirs: oldDirs },
    });
    if (!result.adopted) {
      return { done: false, failure: result.failure };
    }
    if (!(await upkeep.removeOldKeysFiles())) {
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
        message: "The text isn't a backup key. Check the backup key.",
      };
    }
    if (!this._engine || !this.sharedRootSetting()) {
      return {
        restored: false,
        refused: "no-folder",
        message: "Choose the sync folder first.",
      };
    }
    const opens = await this._engine
      .opensWorkspacesHere(keyBytes, SvalTree.SYNC_DOCUMENT)
      .catch(() => null);
    if (opens === null) {
      return {
        restored: false,
        refused: "unreachable",
        message:
          "Sval can't reach the sync folder. Try again once the sync folder " +
          "is reachable.",
      };
    }
    if (!opens) {
      return {
        restored: false,
        refused: "mismatch",
        message:
          "The backup key doesn't match the Workspaces in the sync folder.",
      };
    }
    const result = await this.adoptKey(keyBytes);
    if (result.adopted) {
      return {
        restored: true,
        message: `Sval restored the sync key. This ${this._modules.SvalPanelModel.computerNoun(
          this._modules.AppConstants.platform
        )} is syncing again.`,
      };
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
