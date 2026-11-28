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
    SvalDropbox: "moz-src:///browser/components/sval/SvalDropbox.sys.mjs",
    SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
    SvalRemoteFolder:
      "moz-src:///browser/components/sval/SvalRemoteFolder.sys.mjs",
    SvalSecretStore:
      "moz-src:///browser/components/sval/SvalSecretStore.sys.mjs",
    SvalSharedFolder:
      "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs",
    openSvalDialog: "moz-src:///browser/components/sval/SvalDialog.sys.mjs",
  });

  /** How long the Dropbox browser waits for a folder's listing. */
  const LISTING_MS = 20_000;
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
     * The page state `#sval-storage-status`'s line was written in. A line
     * answers an act in the state it found, so `_drawSyncPage` withdraws it
     * once the state moves on, and it never sits beside a state it
     * contradicts.
     */
    _statusState: null,

    /** The folder being chosen, while it is, for `syncPage`. */
    _working: null,

    /** Whether the key store is the profile's file, as last read. */
    _keyInProfile: false,

    /** `syncPage`'s last answer, as drawn. */
    _page: null,

    /** The control that had focus when a choice of folder started. */
    _workingFrom: null,

    /**
     * The Dropbox browser's state while its dialog is open: the refresh
     * token it lists with, and the folder it shows, `/`-separated and empty
     * for the root of the Dropbox.
     */
    _dropbox: null,

    /**
     * Finds and wires the Sync card and the Sync key card.
     *
     * @param {Function} byId Finds one of the page's elements by id.
     */
    _initStorage(byId) {
      Object.assign(this._els, {
        storageKeyring: byId("sval-storage-keyring"),
        smbKeychain: byId("sval-smb-keychain"),
        syncAdvanced: byId("sval-sync-advanced"),
        syncState: byId("sval-sync-state"),
        syncStatus: byId("sval-sync-status"),
        syncLast: byId("sval-sync-last"),
        syncButtons: byId("sval-sync-buttons"),
        locationChoices: byId("sval-location-choices"),
        locationDialog: byId("sval-location-dialog"),
        storageChange: byId("sval-storage-change"),
        backupMissing: byId("sval-backup-missing"),
        setUpAgain: byId("sval-set-up-again"),
        storageChoose: byId("sval-storage-choose"),
        storageStop: byId("sval-storage-stop"),
        stopTitle: byId("sval-stop-dialog-title"),
        stopBody: byId("sval-stop-dialog-body"),
        storageStatus: byId("sval-storage-status"),
        storageResultActions: byId("sval-storage-result-actions"),
        folderField: byId("sval-folder-field"),
        folderName: byId("sval-folder-name"),
        folderPath: byId("sval-folder-path"),
        folderReveal: byId("sval-folder-reveal"),
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
        storageDropbox: byId("sval-storage-dropbox"),
        dropboxDialog: byId("sval-dropbox-dialog"),
        dropboxUp: byId("sval-dropbox-up"),
        dropboxPlace: byId("sval-dropbox-place"),
        dropboxFolders: byId("sval-dropbox-folders"),
        dropboxStatus: byId("sval-dropbox-status"),
        dropboxKeychain: byId("sval-dropbox-keychain"),
        dropboxCancel: byId("sval-dropbox-cancel"),
        dropboxUse: byId("sval-dropbox-use"),
        storageWorking: byId("sval-storage-working"),
        storageWorkingText: byId("sval-storage-working-text"),
      });
      this._els.folderReveal.textContent = revealLabel();
      // The Keychain asks as the sign-in is saved, so the dialog says so
      // first.
      const keychainNote =
        `When macOS asks whether Sval can access ` +
        `“${lazy.SvalSecretStore.userLabel()}”, choose Always Allow.`;
      this._els.smbKeychain.message = keychainNote;
      this._els.dropboxKeychain.message = keychainNote;
      // Every control the page state offers runs through one place. The Sync
      // card holds its dialogs, so one listener there hears them too.
      for (const holder of [this._els.storageSection, this._els.syncAdvanced]) {
        holder.addEventListener("click", event => {
          const command =
            event.target.closest("[data-command]")?.dataset.command;
          if (command) {
            this.runSyncCommand(command);
          }
        });
      }
      byId("sval-location-dialog-cancel").addEventListener("click", () =>
        this._els.locationDialog.close()
      );
      this._els.dropboxUp.addEventListener("click", () => {
        const folder = this._dropbox?.folder ?? "";
        this._browseDropbox(folder.split("/").slice(0, -1).join("/"));
      });
      this._els.dropboxCancel.addEventListener("click", () =>
        this._els.dropboxDialog.close()
      );
      this._els.dropboxDialog.addEventListener("close", () => {
        this._dropbox = null;
      });
      this._els.dropboxUse.addEventListener("click", () =>
        this._useDropboxFolder()
      );
      this._els.serverCancel.addEventListener("click", () =>
        this._els.serverDialog.close()
      );
      this._els.serverForm.addEventListener("submit", event => {
        event.preventDefault();
        this._connectServerFolder();
      });
      this._els.stopCancel.addEventListener("click", () =>
        this._els.stopDialog.close()
      );
      this._els.stopConfirm.addEventListener("click", () => {
        this._els.stopDialog.close();
        this.stopSyncing();
      });
    },

    /**
     * Draws the Sync card, the Devices card's offer and the Advanced key
     * card from one `SvalPanelModel.syncPage`, which decides every word and
     * control. Nothing here decides one of its own.
     *
     * Redrawn on focus and after every pass, because the folder is the
     * profile's: a second window's page can change it, and a pass can find it
     * gone or back.
     */
    _drawSyncPage() {
      const panel = this.panel;
      const els = this._els;
      const page = lazy.SvalPanelModel.syncPage({
        indicator: panel ? panel.indicatorState() : null,
        privateOnly: this._privateOnly,
        sharedRoot: panel?.sharedRootSetting() ?? null,
        backupSaved: !!panel?.settings?.backupSaved,
        keyInProfile: this._keyInProfile,
        working: this._working,
        pairing: !!this._offer || !!this._claims?.looking,
        outcome: this._syncOutcome,
      });
      this._page = page;
      if (this._statusState !== null && this._statusState !== page.scope) {
        this._clearStorageReport();
      }
      els.storageSection.dataset.state = page.state;
      els.syncState.dataset.icon = page.icon;

      if (els.syncState.dataset.state !== page.tone) {
        els.syncState.dataset.state = page.tone;
        // A new state arrives with a small settle, unless the user asked for
        // less motion.
        if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          els.syncState.querySelector(".sval-sync-words")?.animate(
            [
              { opacity: 0, transform: "translateY(2px)" },
              { opacity: 1, transform: "none" },
            ],
            { duration: 240, easing: "cubic-bezier(0.22, 0.8, 0.24, 1)" }
          );
        }
      }
      // Unchanged text is left alone: this redraws on every pass the panel's
      // poll runs, and assigning `textContent` replaces the text node whether
      // or not the words moved, which costs a paint.
      this._setText(els.syncStatus, page.title);
      this._setText(els.syncLast, page.detail);

      els.storageWorking.hidden = page.working === null;
      this._setText(els.storageWorkingText, page.working ?? "");
      els.storageSection.toggleAttribute("aria-busy", page.working !== null);

      els.locationChoices.hidden = !page.choices;
      for (const choice of [
        ...els.locationChoices.querySelectorAll("button"),
        ...els.locationDialog.querySelectorAll("button[data-command]"),
      ]) {
        choice.disabled = page.locked;
      }
      els.folderField.hidden = !page.location;
      if (page.location) {
        this._setText(els.folderName, page.location.name);
        this._setText(els.folderPath, page.location.place);
        els.folderField.title = page.location.place;
        els.folderField.dataset.via = page.location.via;
      }
      els.folderReveal.hidden = !page.reveal;
      els.storageChange.hidden = !page.change;
      els.storageChange.disabled = page.locked;
      els.storageStop.hidden = !page.stop;
      els.storageStop.disabled = page.locked;
      if (page.stop) {
        this._setText(els.storageStop, page.stop.label);
        this._setText(els.stopTitle, page.stop.title);
        this._setText(els.stopBody, page.stop.body);
      }
      els.backupMissing.hidden = !page.backupNote;

      const actions = [page.primary, ...page.secondary].filter(Boolean);
      const actionsKey = JSON.stringify([actions, page.locked]);
      if (this._shownSyncActions !== actionsKey) {
        this._shownSyncActions = actionsKey;
        els.syncButtons.replaceChildren(
          ...actions.map((action, index) => {
            const button = document.createElement("sval-button");
            if (index === 0 && action === page.primary) {
              button.type = "primary";
            }
            button.dataset.command = action.command;
            button.textContent = action.label;
            button.disabled = !!action.disabled || page.working !== null;
            button.busy = !!action.busy;
            return button;
          })
        );
      }

      els.pairingStart.hidden = !page.addDevice;
      els.syncAdvanced.hidden = !page.advanced;
      els.storageKeyring.hidden = !page.keyringNote;
      this._describeFolder();
    },

    /**
     * Runs one of the page's controls, as `syncPage` names them.
     *
     * @param {string} command
     */
    async runSyncCommand(command) {
      const via = this._page?.location?.via;
      switch (command) {
        case "chooseLocal":
          this._els.locationDialog.close();
          return this.chooseFolder();
        case "chooseSmb":
          this._els.locationDialog.close();
          return this.chooseServerFolder();
        case "chooseDropbox":
          this._els.locationDialog.close();
          return this.chooseDropboxFolder();
        case "chooseInUse":
          return this.runSyncCommand(
            { smb: "chooseSmb", dropbox: "chooseDropbox" }[via] ?? "chooseLocal"
          );
        case "changeLocation":
          this._els.locationDialog.showModal();
          return undefined;
        case "reveal":
          return this.revealFolder();
        case "useFolderAgain":
          return this.useFolderAgain();
        case "syncNow":
          return this.syncNow();
        case "enterCode":
          return this.enterCode();
        case "restore":
          return this.askForBackup();
        case "startOver":
          return this.setUpSyncAgain();
        case "saveBackup":
          return this.saveBackup();
        case "stop":
          this._els.stopDialog.showModal();
          this._els.stopCancel.focus();
          return undefined;
      }
      // The panel's own commands, as the footer runs them.
      const panelCommand = {
        retryKey: "retrySyncKey",
        dismissOthers: "dismissOtherWorkspaces",
        checkForUpdate: "checkForUpdate",
        showCritical: "reopenCritical",
      }[command];
      if (panelCommand) {
        await this.panel?.run(panelCommand, null);
        this._drawSyncPage();
      }
      return undefined;
    },

    /**
     * Reads which store keeps the sync key, for the notes that depend on it,
     * and redraws when that changed.
     */
    async _readKeyStore() {
      const backend = await lazy.SvalSecretStore.backend().catch(() => null);
      const inProfile = backend === lazy.SvalSecretStore.BACKENDS.profile;
      // The Keychain asks as Connect saves the password, so the dialog says
      // so first, on a Mac whose secrets the system store keeps or will.
      this._els.smbKeychain.hidden =
        lazy.AppConstants.platform !== "macosx" || inProfile;
      this._els.dropboxKeychain.hidden = this._els.smbKeychain.hidden;
      if (inProfile !== this._keyInProfile) {
        this._keyInProfile = inProfile;
        this._drawSyncPage();
      }
    },

    /** Shows the sync key's backup, through the panel that owns the key. */
    async saveBackup() {
      await this.panel?.offerBackup();
      this._drawSyncPage();
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
          this._showStorageReport({
            line: {
              status: "success",
              reason: "set-up",
              text: `This ${lazy.SvalPanelModel.computerNoun(
                lazy.AppConstants.platform
              )} has a new sync key. Add each other device again.`,
              action: { label: "Add a device…", command: "offerCode" },
            },
          });
        } else if (result.failure) {
          this._showStorageReport(
            {
              line: lazy.SvalPanelModel.pairingLine(
                result,
                lazy.AppConstants.platform,
                "Setup"
              ),
            },
            () => this.setUpSyncAgain()
          );
        }
      } finally {
        this._els.setUpAgain.disabled = false;
      }
    },

    /**
     * Restore from a backup…: one dialog with the backup key's field. The
     * dialog stays up while the key is tried on the folder, and says there
     * why a key was refused; a key that restored closes it, and the Sync card
     * says so (key-storage spec, "Backup and recovery").
     */
    async askForBackup() {
      const name = this._page?.location?.name;
      if (!this.panel || !name) {
        return;
      }
      await lazy.openSvalDialog(window.browsingContext.topChromeWindow, {
        icon: "key",
        state: "restore",
        title: "Restore from a backup",
        body: `Paste the backup key. Sval checks the backup key against ${name}.`,
        field: {
          label: "Backup key",
          validate: text =>
            lazy.SvalPanelModel.fromBackupCode(text)
              ? ""
              : "A backup key has 52 letters and numbers.",
        },
        primary: "Restore",
        onButton: (id, dialog) => {
          if (id === "ok") {
            this._restoreIn(dialog);
          }
          return id === "ok";
        },
      });
    },

    /**
     * Tries the key typed in the backup dialog `dialog` on the folder.
     *
     * @param {object} dialog The dialog's handle (`openSvalDialog`'s
     *   `onButton`).
     */
    async _restoreIn(dialog) {
      const panel = this.panel;
      if (!panel) {
        return;
      }
      dialog.setButton("ok", { disabled: true });
      dialog.update({ warning: "Checking the backup key…", state: "checking" });
      const result = await panel.restoreFromBackup(dialog.value());
      if (result.restored) {
        dialog.close();
        this._showStorageReport({
          line: {
            status: "success",
            reason: "restored",
            text: result.message,
            action: null,
          },
        });
        return;
      }
      dialog.setButton("ok", { disabled: false });
      // A key tried on the folder fails with a join's line (messages spec
      // §7); one refused before that says what was typed.
      dialog.update({
        state: result.failure ?? result.refused,
        warning: result.failure
          ? lazy.SvalPanelModel.pairingLine(
              result,
              lazy.AppConstants.platform,
              "Restore"
            ).text
          : result.message,
      });
    },

    /**
     * Shows how an act on the card ended: the panel's sentence or result
     * line, in the state the page is in once it ended. `_drawSyncPage`
     * withdraws it when that state moves on.
     *
     * @param {object} report A `{ message, unreachable, line }` answer from
     *   the panel.
     * @param {Function} [retry] What the line's Try Again or Allow Access runs.
     */
    _showStorageReport(report, retry = null) {
      this._drawSyncPage();
      // A key the store refused is the card's state, and said once, there.
      if (
        report.line?.reason === "key-sealed" &&
        this._page.state === "key-sealed"
      ) {
        report = { message: null };
      }
      delete this._els.storageStatus.dataset.outcome;
      const said = !!(report.line ?? report.message);
      this._showResult(
        this._els.storageStatus,
        this._els.storageResultActions,
        report.line ?? null,
        { text: report.message ?? "", retry }
      );
      this._statusState = said ? this._page.scope : null;
      this._els.storageStatus.toggleAttribute(
        "data-unreachable",
        !!report.unreachable
      );
    },

    /** Withdraws the card's status line. */
    _clearStorageReport() {
      this._statusState = null;
      this._showResult(
        this._els.storageStatus,
        this._els.storageResultActions,
        null
      );
      this._els.storageStatus.removeAttribute("data-unreachable");
      delete this._els.storageStatus.dataset.outcome;
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
        this._drawSyncPage();
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
      this._setWorking(root);
      try {
        await lazy.SvalRemoteFolder.keepSignIn(root, { password });
      } catch (err) {
        lazy.SvalLog.warn(
          `keeping the server's password failed: ${lazy.SvalLog.errorName(err)}`
        );
        this._setWorking(null);
        this._showStorageReport({
          message:
            "Sval couldn't save the password. The sync folder didn't change.",
        });
        return;
      }
      await this._useFolder(panel, root);
    },

    /**
     * Opens the Dropbox browser at the Dropbox folder in use, signed in as it
     * is, or signs in to Dropbox first and opens it at the Dropbox's root.
     */
    async chooseDropboxFolder() {
      if (this._privateOnly || !this.panel) {
        return;
      }
      const chosen = this.panel.sharedRootSetting();
      const current = lazy.SvalRemoteFolder.parseDropboxRoot(chosen);
      const kept = current
        ? await lazy.SvalRemoteFolder.authFor(chosen).catch(() => null)
        : null;
      let token = kept?.refreshToken;
      if (!token) {
        token = await this._signInToDropbox();
        if (!token) {
          return;
        }
      }
      this._dropbox = { token, folder: current?.folder ?? "" };
      this._els.dropboxDialog.showModal();
      await this._browseDropbox(this._dropbox.folder);
    },

    /**
     * Signs in to Dropbox in a page of its own (`SvalDropbox`).
     *
     * @returns {Promise<?string>} the refresh token, or null when the user
     *   gave up or Dropbox refused.
     */
    async _signInToDropbox() {
      this._els.storageDropbox.disabled = true;
      try {
        return await lazy.SvalDropbox.signIn();
      } catch (err) {
        if (err?.name !== "SignInCancelled") {
          lazy.SvalLog.warn(
            `signing in to Dropbox failed: ${lazy.SvalLog.errorName(err)}`
          );
          this._showStorageReport({
            message: "Sval couldn't sign in to Dropbox.",
          });
        }
        return null;
      } finally {
        this._els.storageDropbox.disabled = false;
      }
    },

    /**
     * Shows the folders in `folder` of the user's Dropbox. A token Dropbox
     * no longer accepts is replaced by signing in again.
     *
     * @param {string} folder `/`-separated, empty for the Dropbox's root.
     */
    async _browseDropbox(folder) {
      const els = this._els;
      const state = this._dropbox;
      if (!state) {
        return;
      }
      state.folder = folder;
      const root = lazy.SvalRemoteFolder.dropboxRoot(folder);
      els.dropboxPlace.textContent =
        lazy.SvalRemoteFolder.remoteFolderPlace(root);
      els.dropboxUp.disabled = !folder;
      els.dropboxUse.disabled = true;
      els.dropboxFolders.replaceChildren();
      els.dropboxStatus.textContent = "Loading folders…";
      const list = () =>
        lazy.SvalSharedFolder.listFolders({
          root,
          auth: { refreshToken: state.token },
          deadline: Date.now() + LISTING_MS,
        });
      let answer = await list();
      if (answer.error === "SignInError" && this._dropbox === state) {
        const token = await this._signInToDropbox();
        if (!token) {
          els.dropboxDialog.close();
          return;
        }
        state.token = token;
        answer = await list();
      }
      // A later click, or a closed dialog, has moved on from this listing.
      if (this._dropbox !== state || state.folder !== folder) {
        return;
      }
      if (!answer.reachable) {
        els.dropboxStatus.textContent =
          answer.error === "SignInError"
            ? "Dropbox didn't accept Sval's sign-in."
            : "Sval can't reach Dropbox. Check your internet connection.";
        return;
      }
      els.dropboxStatus.textContent = answer.folders.length
        ? ""
        : "No folders inside.";
      for (const name of answer.folders) {
        const row = document.createElement("li");
        const open = document.createElement("button");
        open.type = "button";
        open.className = "sval-dropbox-folder";
        const icon = document.createElement("span");
        icon.className = "sval-icon sval-icon-folder";
        icon.setAttribute("aria-hidden", "true");
        open.append(icon, name);
        open.addEventListener("click", () =>
          this._browseDropbox(folder ? `${folder}/${name}` : name)
        );
        row.append(open);
        els.dropboxFolders.append(row);
      }
      els.dropboxUse.disabled = false;
    },

    /**
     * Keeps the Dropbox sign-in for the folder the browser shows, and has the
     * panel share through it.
     */
    async _useDropboxFolder() {
      const state = this._dropbox;
      const panel = this.panel;
      if (!state || !panel) {
        return;
      }
      const root = lazy.SvalRemoteFolder.dropboxRoot(state.folder);
      this._els.dropboxDialog.close();
      this._setWorking(root);
      try {
        await lazy.SvalRemoteFolder.keepSignIn(root, {
          refreshToken: state.token,
        });
      } catch (err) {
        lazy.SvalLog.warn(
          `keeping the Dropbox sign-in failed: ${lazy.SvalLog.errorName(err)}`
        );
        this._setWorking(null);
        this._showStorageReport({
          message:
            "Sval couldn't save the Dropbox sign-in. The sync folder didn't change.",
        });
        return;
      }
      await this._useFolder(panel, root);
    },

    /**
     * Shows that a choice of folder is taking effect, and holds the card's
     * buttons until it has: saving a sign-in may wait on the Keychain, and
     * the first pass through a remote folder reads it over the network.
     *
     * @param {?string} path The folder being chosen, or null once done.
     */
    _setWorking(path) {
      const working = path !== null;
      // Holding the buttons blurs the one that started this on some
      // platforms: focus goes back to it once they are free.
      if (working) {
        this._workingFrom ??= document.activeElement;
      }
      this._working = path;
      this._drawSyncPage();
      if (!working) {
        const from = this._workingFrom;
        this._workingFrom = null;
        const lost =
          !document.activeElement || document.activeElement === document.body;
        if (lost && from?.isConnected && !from.disabled && !from.hidden) {
          from.focus();
        }
      }
    },

    /**
     * Has the panel share through `path`, and shows what it answered.
     *
     * @param {object} panel The window's `SvalPanel`.
     * @param {string} path The folder the user chose.
     */
    async _useFolder(panel, path) {
      this._setWorking(path);
      this._showStorageReport({ message: null });

      let report;
      try {
        report = await panel.chooseSharedFolder(path, { mint: true });
      } catch (err) {
        lazy.SvalLog.warn(
          `changing the sync folder failed: ${lazy.SvalLog.errorName(err)}`
        );
        report = {
          reached: false,
          message: "Sval couldn't change the sync folder.",
        };
      }

      // What a pass said of the last folder says nothing about this one.
      this._syncOutcome = null;
      this._setWorking(null);
      // The panel's own words, verbatim. See this file's top comment.
      this._showStorageReport(report, () => this._useFolder(panel, path));
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
        this._showStorageReport({ message: "Sval couldn't open the folder." });
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
        this._drawSyncPage();
        return;
      }
      this._setWorking(panel.sharedRootSetting());
      const report = await panel.useFolderAgain();
      this._setWorking(null);
      this._showStorageReport(report);
    },

    /** Stops sharing. Every workspace stays on this device. */
    async stopSyncing() {
      if (this._privateOnly) {
        return;
      }
      const panel = this.panel;
      if (!panel) {
        this._drawSyncPage();
        return;
      }
      this._els.storageStop.disabled = true;
      const report = await panel.chooseSharedFolder(null);
      this._els.storageStop.disabled = false;
      this._syncOutcome = null;
      this._showStorageReport(report);
    },
  };

  Object.assign(window.SvalSettings, SvalStorageSettings);
}
