/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The Sync and devices pane's Sync card and its Advanced Sync key card (spec
 * §10.8): choosing, revealing, reusing and leaving the folder, and backing
 * up, restoring and replacing the sync key. Every change is the panel's
 * (`chooseSharedFolder`, `useFolderAgain`, `setUpSyncAgain`,
 * `restoreFromBackup`), and the report it answers with is shown word for
 * word: which folders are involved is known there and nowhere else.
 *
 * `SvalPreferences` loads this as a classic script after `settings.js`; it
 * adds its methods to `SvalSettings`.
 */

"use strict";

{
  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
    FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
    SvalIdentity: "moz-src:///browser/components/sval/SvalIdentity.sys.mjs",
    SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
    SvalRemoteFolder:
      "moz-src:///browser/components/sval/SvalRemoteFolder.sys.mjs",
    SvalSecretStore:
      "moz-src:///browser/components/sval/SvalSecretStore.sys.mjs",
  });
  // `SvalPanelModel.sys.mjs` exports functions rather than one object of that
  // name, so it is imported as a namespace.
  ChromeUtils.defineLazyGetter(lazy, "SvalPanelModel", () =>
    ChromeUtils.importESModule(
      "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
    )
  );

  /**
   * What the system file manager is called, for the button that reveals the
   * sync folder in it.
   *
   * @returns {string}
   */
  function revealLabel() {
    switch (lazy.AppConstants.platform) {
      case "macosx":
        return "Show in Finder";
      case "win":
        return "Show in File Explorer";
      default:
        return "Show in Files";
    }
  }

  const SvalStorageSettings = {
    /**
     * The folder the sentence in `#sval-storage-status` is about, when that
     * sentence reports a folder Sval could not reach; otherwise null.
     * `_describeStorage` withdraws it once that folder answers or another is
     * chosen, so it never sits beside a line saying the workspaces sync.
     */
    _statusFolder: null,

    /**
     * Finds and wires the Sync card and the Sync key card.
     *
     * @param {Function} byId Finds one of the page's elements by id.
     */
    _initStorage(byId) {
      Object.assign(this._els, {
        storageText: byId("sval-storage-text"),
        storageKeyring: byId("sval-storage-keyring"),
        smbKeychain: byId("sval-smb-keychain"),
        syncAdvanced: byId("sval-sync-advanced"),
        syncRow: byId("sval-sync-row"),
        keyActions: byId("sval-key-actions"),
        keyStatus: byId("sval-key-status"),
        backupMissing: byId("sval-backup-missing"),
        backupSave: byId("sval-backup-save"),
        setUpAgain: byId("sval-set-up-again"),
        keyResultActions: byId("sval-key-result-actions"),
        restoreForm: byId("sval-restore-form"),
        restoreCode: byId("sval-restore-code"),
        storageChoose: byId("sval-storage-choose"),
        storageReuse: byId("sval-storage-reuse"),
        storageStop: byId("sval-storage-stop"),
        storageStatus: byId("sval-storage-status"),
        storageResultActions: byId("sval-storage-result-actions"),
        folderField: byId("sval-folder-field"),
        folderName: byId("sval-folder-name"),
        folderPath: byId("sval-folder-path"),
        folderReveal: byId("sval-folder-reveal"),
        storageSmb: byId("sval-storage-smb"),
        stopDialog: byId("sval-stop-dialog"),
        stopCancel: byId("sval-stop-dialog-cancel"),
        stopConfirm: byId("sval-stop-dialog-confirm"),
        storageSection: byId("sval-storage"),
        serverDialog: byId("sval-server-dialog"),
        serverForm: byId("sval-server-form"),
        serverHost: byId("sval-server-host"),
        serverShare: byId("sval-server-share"),
        serverFolder: byId("sval-server-folder"),
        serverUser: byId("sval-server-user"),
        serverPassword: byId("sval-server-password"),
        serverCancel: byId("sval-server-cancel"),
      });
      this._els.folderReveal.textContent = revealLabel();
      this._els.smbKeychain.message =
        `If your Mac asks whether Sval can access ` +
        `"${lazy.SvalSecretStore.userLabel()}" after you select Connect, ` +
        `choose Always Allow.`;
      this._els.storageChoose.addEventListener("click", () =>
        this.chooseFolder()
      );
      this._els.storageSmb.addEventListener("click", () =>
        this.chooseServerFolder()
      );
      this._els.serverCancel.addEventListener("click", () =>
        this._els.serverDialog.close()
      );
      this._els.serverForm.addEventListener("submit", event => {
        event.preventDefault();
        this._connectServerFolder();
      });
      this._els.folderReveal.addEventListener("click", () =>
        this.revealFolder()
      );
      this._els.storageReuse.addEventListener("click", () =>
        this.useFolderAgain()
      );
      this._els.storageStop.addEventListener("click", () => {
        this._els.stopDialog.showModal();
        this._els.stopCancel.focus();
      });
      this._els.stopCancel.addEventListener("click", () =>
        this._els.stopDialog.close()
      );
      this._els.stopConfirm.addEventListener("click", () => {
        this._els.stopDialog.close();
        this.stopSyncing();
      });
      this._els.backupSave.addEventListener("click", () => this.saveBackup());
      this._els.setUpAgain.addEventListener("click", () =>
        this.setUpSyncAgain()
      );
      this._els.restoreForm.addEventListener("submit", event => {
        event.preventDefault();
        this.restoreFromBackup();
      });
    },

    /**
     * Shows the sync folder, if any, and labels the buttons that change it.
     *
     * This device's copy always lives in the profile (local-copy spec §4.1), so
     * this never says nothing is saved. Syncing is the folder being shared, so
     * there is no switch for it.
     *
     * Redrawn on focus and after every pass, because the folder is the
     * profile's: a second window's page can change it, and a pass can find it
     * gone or back.
     */
    _describeStorage() {
      this._describeKeyring();
      const panel = this.panel;
      const settings = panel?.settings;
      if (!settings) {
        // No window of this profile is running Sval yet. That passes: a
        // panel starts with its window, and this page is in one. The controls
        // are withheld until then, so none is offered only to fail.
        this._els.storageChoose.hidden = true;
        this._els.storageSmb.hidden = true;
        this._els.storageReuse.hidden = true;
        this._els.storageStop.hidden = true;
        this._els.folderReveal.hidden = true;
        this._els.folderField.hidden = true;
        this._els.syncRow.hidden = true;
        this._setText(this._els.storageText, "");
        this._showStorageReport({ message: null });
        this._statusFolder = null;
        return;
      }
      // Un-hidden here rather than only in the markup, because this method is
      // re-entered on every window `focus`: a page that found no panel once and
      // finds one now has to offer the control again.
      this._els.storageChoose.hidden = false;
      this._els.storageSmb.hidden = false;
      const chosen = panel.sharedRootSetting();
      const unreachable =
        chosen && panel.syncState.folderState === "unreachable";
      this._els.storageReuse.hidden = !unreachable;
      this._els.storageStop.hidden = !chosen;
      const remote = lazy.SvalRemoteFolder.isRemoteRoot(chosen);
      // A remote folder is on no disk of this computer's to show.
      this._els.folderReveal.hidden = !chosen || unreachable || remote;
      this._els.folderField.hidden = !chosen;
      this._els.syncRow.hidden = !chosen;
      this._els.folderField.classList.toggle("sval-unreachable", !!unreachable);
      if (
        this._statusFolder !== null &&
        (chosen !== this._statusFolder ||
          panel.syncState.folderState === "reached")
      ) {
        this._showStorageReport({ message: null });
      }
      if (!chosen) {
        this._setText(
          this._els.storageText,
          "Sval saves your Workspaces on this device only. To sync them, " +
            "choose a folder your devices share or connect to an SMB server."
        );
        this._setText(this._els.storageChoose, "Choose folder…");
        this._setText(this._els.storageSmb, "Connect to SMB server…");
        this._els.storageChoose.dataset.tone = "primary";
        delete this._els.storageSection.dataset.via;
        return;
      }
      delete this._els.storageChoose.dataset.tone;
      this._setText(
        this._els.folderName,
        lazy.SvalPanelModel.friendlyFolderName(chosen)
      );
      const place = remote
        ? lazy.SvalRemoteFolder.remoteFolderPlace(chosen)
        : chosen;
      this._setText(this._els.folderPath, place);
      this._els.folderField.title = place;
      // An SMB folder and a folder on this computer are two ways to sync, so
      // each has its own button: the one in use changes it, and the other
      // switches to the other way.
      this._els.storageSection.dataset.via = remote ? "smb" : "folder";
      if (remote) {
        this._setText(this._els.storageSmb, "Edit connection…");
        this._setText(this._els.storageChoose, "Choose folder…");
        this._setText(
          this._els.storageText,
          unreachable
            ? "Sval can't reach this SMB server. Your Workspaces are still on this device."
            : "Sval syncs your Workspaces through a folder on this SMB server."
        );
        return;
      }
      this._setText(this._els.storageSmb, "Connect to SMB server…");
      if (unreachable) {
        this._setText(
          this._els.storageText,
          "Sval can't find its files in this folder. Your Workspaces are still on this device."
        );
        this._setText(this._els.storageChoose, "Choose another…");
        return;
      }
      this._setText(this._els.storageText, "");
      this._setText(this._els.storageChoose, "Change…");
    },

    /**
     * Says when the sync key is kept in the profile, which is a machine with
     * no keyring.
     */
    async _describeKeyring() {
      const backend = await lazy.SvalSecretStore.backend().catch(() => null);
      this._els.storageKeyring.hidden =
        backend !== lazy.SvalSecretStore.BACKENDS.profile;
      const panel = this.panel;
      const syncs =
        !!panel?.sharedRootSetting?.() &&
        panel.syncState.keyState === lazy.SvalIdentity.SYNC_KEY_STATES.present;
      this._els.syncAdvanced.hidden = !panel?.sharedRootSetting?.();
      this._els.keyActions.hidden = !syncs;
      // The Keychain asks as Connect saves the password, so the dialog says
      // so first, on a Mac whose secrets the system store keeps or will.
      this._els.smbKeychain.hidden =
        lazy.AppConstants.platform !== "macosx" ||
        backend === lazy.SvalSecretStore.BACKENDS.profile;
      this._els.backupMissing.hidden = !syncs || !!panel.settings?.backupSaved;
    },

    /** Shows the sync key's backup, through the panel that owns the key. */
    async saveBackup() {
      await this.panel?.offerBackup();
      this._describeKeyring();
    },

    /**
     * Sets up sync again with a new sync key, and says how it went (messages
     * spec §7). A user who declined the confirmation is told nothing.
     */
    async setUpSyncAgain() {
      const panel = this.panel;
      if (!panel) {
        return;
      }
      this._els.setUpAgain.disabled = true;
      try {
        const result = await panel.setUpSyncAgain();
        if (result.done) {
          this._showResult(this._els.keyStatus, this._els.keyResultActions, {
            status: "success",
            reason: "set-up",
            text:
              "Sync is set up on this device. Give your other devices a " +
              "code to sync with it.",
            action: { label: "Show Code…", command: "offerCode" },
          });
        } else if (result.failure) {
          this._showResult(
            this._els.keyStatus,
            this._els.keyResultActions,
            lazy.SvalPanelModel.pairingLine(
              result,
              lazy.AppConstants.platform,
              "Setup"
            ),
            { retry: () => this.setUpSyncAgain() }
          );
        }
      } finally {
        this._els.setUpAgain.disabled = false;
        this._describeKeyring();
      }
    },

    /**
     * Writes a plain sentence on the sync key's status line.
     *
     * @param {string} text
     */
    _keySays(text) {
      this._showResult(this._els.keyStatus, this._els.keyResultActions, null, {
        text,
      });
    },

    /** Takes the sync key back from the typed backup. */
    async restoreFromBackup() {
      const panel = this.panel;
      if (!panel) {
        return;
      }
      this._keySays("Checking the key…");
      const result = await panel.restoreFromBackup(this._els.restoreCode.value);
      if (result.restored || result.failure) {
        // The key was tried on the folder, so this is a result line (messages
        // spec §7); the sentences before that are about what was typed.
        this._showResult(
          this._els.keyStatus,
          this._els.keyResultActions,
          result.restored
            ? { status: "success", text: result.message, action: null }
            : lazy.SvalPanelModel.pairingLine(
                result,
                lazy.AppConstants.platform,
                "Restore"
              ),
          { retry: () => this.restoreFromBackup() }
        );
      } else {
        this._keySays(result.message ?? "");
      }
      this._els.restoreCode.setAttribute(
        "aria-invalid",
        String(!result.restored && !!result.message)
      );
      if (result.restored) {
        this._els.restoreCode.value = "";
      }
    },

    /**
     * Shows the panel's sentence about a folder change, and remembers which
     * folder it is about when it says that folder cannot be reached or is too
     * large to sync, so `_describeStorage` can withdraw it when the folder
     * syncs.
     *
     * @param {object} report A `{ message, unreachable, line }` answer from
     *   the panel.
     * @param {Function} [retry] What the line's Try Again or Allow Access runs.
     */
    _showStorageReport(report, retry = null) {
      this._showResult(
        this._els.storageStatus,
        this._els.storageResultActions,
        report.line ?? null,
        { text: report.message ?? "", retry }
      );
      this._statusFolder = report.unreachable
        ? (this.panel?.sharedRootSetting() ?? null)
        : null;
      this._els.storageStatus.toggleAttribute(
        "data-unreachable",
        !!report.unreachable
      );
    },

    /**
     * Asks the user for the folder Sval syncs through, then has the panel share
     * through it.
     *
     * A folder on this computer, through `nsIFilePicker` in `modeGetFolder`,
     * the same call
     * `toolkit/content/widgets/moz-input-folder/moz-input-folder.mjs` and the
     * profile migrators make.
     *
     * `SvalPanel.chooseSharedFolder` makes the change and reports it, and the
     * report is rendered word for word: which two folders are involved is known
     * there and nowhere else.
     */
    async chooseFolder() {
      if (this._privateOnly) {
        return;
      }
      const panel = this.panel;
      if (!panel) {
        this._describeStorage();
        return;
      }

      const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
        Ci.nsIFilePicker
      );
      picker.init(
        window.browsingContext,
        "Choose a sync folder",
        Ci.nsIFilePicker.modeGetFolder
      );
      const current = panel.sharedRootSetting();
      if (current) {
        try {
          picker.displayDirectory = new lazy.FileUtils.File(current);
        } catch {
          // A path the platform cannot represent opens the picker where it
          // would open anyway.
        }
      }
      const result = await new Promise(resolve => picker.open(resolve));
      if (result !== Ci.nsIFilePicker.returnOK) {
        return;
      }
      await this._useFolder(panel, picker.file.path);
    },

    /**
     * Asks where a folder on an SMB server is, and the sign-in for it, filled
     * in with the folder in use when it is one.
     */
    chooseServerFolder() {
      if (this._privateOnly) {
        return;
      }
      const els = this._els;
      const current = lazy.SvalRemoteFolder.parseSmbRoot(
        this.panel?.sharedRootSetting() ?? null
      );
      let server = current?.host ?? "";
      if (current && current.port !== 445) {
        server += `:${current.port}`;
      }
      els.serverHost.value = server;
      els.serverShare.value = current?.share ?? "";
      els.serverFolder.value = current?.folder ?? "";
      els.serverUser.value = current?.username ?? "";
      els.serverPassword.value = "";
      els.serverDialog.showModal();
      (current ? els.serverPassword : els.serverHost).focus();
    },

    /**
     * Keeps the password the server dialog was given, and has the panel
     * share through the folder it names.
     */
    async _connectServerFolder() {
      const els = this._els;
      const panel = this.panel;
      const root = lazy.SvalRemoteFolder.smbRoot({
        server: els.serverHost.value,
        share: els.serverShare.value,
        folder: els.serverFolder.value,
        username: els.serverUser.value,
      });
      if (!root || !panel) {
        els.serverHost.focus();
        return;
      }
      const password = els.serverPassword.value;
      els.serverPassword.value = "";
      els.serverDialog.close();
      try {
        await lazy.SvalRemoteFolder.keepPassword(root, password);
      } catch (err) {
        lazy.SvalLog.warn(
          `keeping the server's password failed: ${lazy.SvalLog.errorName(err)}`
        );
        this._showStorageReport({
          message:
            "Sval couldn't save the password, so your sync folder didn't change.",
        });
        return;
      }
      await this._useFolder(panel, root);
    },

    /**
     * Has the panel share through `path`, and shows what it answered.
     *
     * @param {object} panel The window's `SvalPanel`.
     * @param {string} path The folder the user chose.
     */
    async _useFolder(panel, path) {
      this._els.storageChoose.disabled = true;
      this._showStorageReport({ message: null });

      let report;
      try {
        report = await panel.chooseSharedFolder(path, { mint: true });
      } catch (err) {
        lazy.SvalLog.warn(
          `changing the sync folder failed: ${lazy.SvalLog.errorName(err)}`
        );
        report = { reached: false, message: "Couldn't change the folder." };
      }

      this._els.storageChoose.disabled = false;
      // The panel's own words, verbatim. See this file's top comment.
      this._showStorageReport(report, () => this._useFolder(panel, path));
      // What a pass said of the last folder says nothing about this one.
      this._syncOutcome = null;
      this._describeStorage();
      this._describeSync();
      // Syncing with another device needs this same folder.
      this._describeFolder();
    },

    /**
     * Shows the sync folder in the system file manager. `nsIFile.reveal` is
     * what the downloads panel's "Show in Finder" calls.
     */
    revealFolder() {
      const path = this.panel?.sharedRootSetting();
      if (!path) {
        return;
      }
      try {
        this._reveal(path);
      } catch (err) {
        lazy.SvalLog.warn(
          `revealing the sync folder failed: ${lazy.SvalLog.errorName(err)}`
        );
        this._showStorageReport({ message: "Couldn't open the folder." });
      }
    },

    /**
     * @param {string} path
     */
    _reveal(path) {
      new lazy.FileUtils.File(path).reveal();
    },

    /** Asks the panel to publish into the chosen folder again. */
    async useFolderAgain() {
      if (this._privateOnly) {
        return;
      }
      const panel = this.panel;
      if (!panel) {
        this._describeStorage();
        return;
      }
      this._els.storageReuse.disabled = true;
      const report = await panel.useFolderAgain();
      this._els.storageReuse.disabled = false;
      this._showStorageReport(report);
      this._describeStorage();
      this._describeSync();
      this._describeFolder();
    },

    /** Stops sharing. Every workspace stays on this device. */
    async stopSyncing() {
      if (this._privateOnly) {
        return;
      }
      const panel = this.panel;
      if (!panel) {
        this._describeStorage();
        return;
      }
      this._els.storageStop.disabled = true;
      const report = await panel.chooseSharedFolder(null);
      this._els.storageStop.disabled = false;
      this._showStorageReport(report);
      this._syncOutcome = null;
      this._describeStorage();
      this._describeSync();
      this._describeFolder();
    },
  };

  Object.assign(window.SvalSettings, SvalStorageSettings);
}
