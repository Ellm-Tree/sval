/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * First run (first-run spec): whether this profile needs it, the dialog's
 * steps and what each answer does, the Kagi sign-in it offers, and the joining
 * claim of a device that pairs from it.
 *
 * `SvalWindow` loads this as a classic script after `sval-panel.js`; it adds
 * its methods to `SvalPanel`, whose state and helpers it shares.
 */

/* import-globals-from sval-panel.js */

Object.assign(SvalPanel, {
  /** Whether this window's first run dialog is open (`_runFirstRun`). */
  _firstRunInFlight: false,

  /** What first run's import step chose, until the new path's end runs it. */
  _firstRunImportPlan: null,

  /**
   * The unnamed workspace the new path's end made for the import to fill,
   * offered to every run of that import while it is still empty.
   */
  _firstRunReuse: null,

  /** Whether the dialog's welcome asked for Settings › Sync and devices. */
  _firstRunOpensSync: false,

  /**
   * What first run's Workspace step holds, `{ name, color, emoji }`, which
   * the switcher shows while no workspace exists (`_renderSwitcher`), or
   * null.
   */
  _switcherPreview: null,

  /**
   * The joining claim this window's first run is making: `{ code, claimed,
   * landed, stopped }`, or null. `claimed` is what `SvalPairing.claim` found,
   * kept for the dialog's `adopt`, and never handed to the dialog.
   */
  _firstRunJoin: null,

  /**
   * How often a joining claim first run left behind looks again: the
   * settings page's five seconds, for the same reasons.
   */
  _firstRunClaimMs: 5000,

  /**
   * Whether this window's startup stopped to leave the workspace to a pending
   * pairing. The claim's end starts it again (`_keepClaiming`).
   */
  _heldByPairing: false,

  /**
   * Runs first run if this profile needs it (first-run spec §3), or waits
   * for the one another window of this process is running.
   *
   * Nothing is awaited between asking whether first run has started and
   * starting it, so two windows never both start it.
   *
   * @param {?object} ownPass This window's startup pass report; see
   *   `_firstRunWanted`.
   * @returns {Promise<string>} `ran` when this window ran it; `nested` when
   *   this window is running it already and this is a startup nested inside
   *   it, which leaves the workspace to the outer one; `skipped` otherwise.
   */
  async _maybeRunFirstRun(ownPass) {
    const { SvalFirstRun } = this._modules;
    if (!SvalFirstRun.started) {
      const wanted = this._firstRunWanted(ownPass);
      if (wanted === "existing") {
        this._settings.markFirstRunDone();
        await this._flushSettings();
      }
      if (wanted !== "run") {
        return "skipped";
      }
    }
    const { ran, nested, promise } = SvalFirstRun.runOnce(window, () =>
      this._runFirstRun()
    );
    if (nested) {
      return "nested";
    }
    await promise;
    if (!ran) {
      // What first run left, the workspace it made or the ones pairing
      // brought, is in the engine and not yet in this window's tree.
      await this.syncNow();
    }
    return ran ? "ran" : "skipped";
  },

  /**
   * Whether this profile is one first run is for, from what the first pass
   * found.
   *
   * A first run that began and never ended shows again, though the profile
   * holds a file and the workspace it left by then (first-run spec §3.3, §8).
   * Otherwise a profile with a workspace already has what first run sets up,
   * so it is recorded as done and never asked. A profile whose own file this
   * window's pass found, or with a shared folder chosen, is skipped without a
   * record: it may be a profile emptied by hand, or a second window whose pass
   * came after the one that wrote that file.
   *
   * @param {?object} ownPass This window's startup pass report, never
   *   another window's: theirs find the file this window's pass wrote.
   * @returns {string} `run`, `existing` or `skip`.
   */
  _firstRunWanted(ownPass) {
    if (!Services.prefs.getBoolPref("browser.sval.firstRun.enabled", false)) {
      return "skip";
    }
    if (this._settings.firstRunDone) {
      return "skip";
    }
    if (this._settings.firstRunStarted) {
      return "run";
    }
    if (this._modules.SvalTree.workspaceIds(this._nodes).length) {
      return "existing";
    }
    if (ownPass?.hadLocalCopy || this.sharedRootSetting()) {
      return "skip";
    }
    return "run";
  },

  /**
   * First run, from opening the dialog to the workspace it leaves.
   *
   * Nothing here may stop the panel starting: any failure is logged by name
   * and startup goes on. The workspace is made or adopted before this ends,
   * so a window waiting on it finds the workspace rather than making one of
   * its own.
   */
  async _runFirstRun() {
    const { SvalFirstRun, SvalKagi, SvalLog } = this._modules;
    let outcome = "closed";
    let answers = null;
    let kagi = null;
    this._firstRunInFlight = true;
    try {
      // An earlier answer that cannot be read shows its default instead.
      const earlier = this._settings.firstRunStarted
        ? await this._firstRunEarlierAnswers().catch(err => {
            SvalLog.warn(
              `first run's earlier answers: ${SvalLog.errorName(err)}`
            );
            return {};
          })
        : {};
      this._settings.markFirstRunStarted();
      await this._flushSettings();
      const result = await SvalFirstRun.open(window, {
        actions: this._firstRunActions(),
        facts: {
          importAvailable: await this._importAvailable(),
          isDefaultBrowser: this._isDefaultBrowser(),
          earlier,
        },
      });
      outcome = result.outcome;
      answers = result.answers ?? null;
      if (result.report) {
        this._modules.SvalFeedbackForm.open(window, {
          context: result.report,
        }).catch(err =>
          SvalLog.warn(`first run's report: ${SvalLog.errorName(err)}`)
        );
      }
      // The flow's end records it (`_endFirstRun`), and again here in case
      // that end failed part way. A dialog that went away unanswered records
      // nothing, so first run shows again at the next launch (spec §8).
      if (outcome === "done" || outcome === "later") {
        this._settings.markFirstRunDone();
        await this._flushSettings();
        // Kagi signs in by its own cookie, and the token private windows
        // need is taken from it once it is set (spec §5).
        kagi = result.kagi ?? null;
      }
      if (kagi) {
        SvalKagi.start();
      }
    } catch (err) {
      SvalLog.warn(`first run did not finish: ${SvalLog.errorName(err)}`);
    } finally {
      this._firstRunInFlight = false;
      this._closeKagiWindow();
      this._previewFirstWorkspace(null);
    }

    const join = this._firstRunJoin;
    if (join && !join.landed && (answers?.path ?? "join") === "join") {
      this._keepClaiming(join);
    }
    if (window.closed || SvalFirstRun.pairing) {
      return;
    }
    try {
      await this._adoptOrCreateWorkspace();
    } catch (err) {
      SvalLog.warn(
        `first run's workspace was not made: ${SvalLog.errorName(err)}`
      );
    }
    // Opened only once the workspace is in place: a tab opened before it
    // would be replaced along with the window's other tabs.
    if (kagi?.page && !window.closed && !SvalKagi.signedIn()) {
      try {
        this._openKagi(SvalKagi.SIGNIN_URL);
      } catch (err) {
        SvalLog.warn(`Kagi's page did not open: ${SvalLog.errorName(err)}`);
      }
    }
    if (this._firstRunOpensSync && !window.closed) {
      this._firstRunOpensSync = false;
      try {
        this.openSettingsPage();
      } catch (err) {
        SvalLog.warn(`Sync settings did not open: ${SvalLog.errorName(err)}`);
      }
    }
  },

  /**
   * The end of the flow (2026-11-09 spec §4), on the last step's Continue
   * or on Skip setup: the held steps and Skip setup's answers are applied,
   * and on the new path the first workspace is made, unnamed when an
   * imported window will fill it, with the Arc card the import brings taken
   * first so the welcome shows it. First run is recorded as done here, since
   * nothing after it asks the user anything.
   *
   * @param {object} ended
   * @param {string} ended.outcome `done`, or `later` for Skip setup.
   * @param {object} ended.answers What the dialog reports.
   * @param {string[]} ended.completed The steps continued through.
   * @returns {Promise<{importing: boolean}>} whether an import is to run.
   */
  async _endFirstRun({ outcome, answers, completed }) {
    const { SvalLog, SvalPanelModel } = this._modules;
    await this._applyHeldSteps(answers, completed);
    if (outcome === "later") {
      await this._applySetUpLater(answers, completed);
    }
    this._settings.markFirstRunDone();
    await this._flushSettings();
    if (answers?.path !== "new") {
      return { importing: false };
    }
    // A join given up for I'm new to Sval leaves the folder its step chose,
    // which this device holds no key for. A new device saves on this device
    // (2026-11-09 spec §1).
    if (
      this.sharedRootSetting() &&
      this._syncKeyState !== this._modules.SvalIdentity.SYNC_KEY_STATES.present
    ) {
      await this.chooseSharedFolder(null);
    }
    const plan = this._firstRunImportPlan ?? [];
    for (const entry of plan) {
      if (entry.harvest?.arcCard) {
        try {
          this._modules.takeArcCard(entry.harvest.arcCard);
        } catch (err) {
          SvalLog.warn(`the Arc card was not taken: ${SvalLog.errorName(err)}`);
        }
      }
    }
    const fillsWorkspace = plan.some(entry =>
      entry.windows?.some(choice => choice.import)
    );
    const made =
      !fillsWorkspace && answers.workspace
        ? SvalPanelModel.chosenContainer(true, answers.workspace)
        : null;
    const id = await this._createOwnWorkspace(made);
    this._firstRunReuse = made ? null : id;
    return { importing: !!plan.length };
  },

  /**
   * Runs `entries` of what first run's import step chose, its first run
   * offering the workspace the new path's end made, and every later one
   * while that workspace is still empty (`openImport`).
   *
   * @param {?object[]} entries What to run; the whole plan when null.
   * @param {Function} onProgress As `SvalImport.runImport` takes it.
   * @returns {Promise<object>} `runImport`'s report.
   */
  async _firstRunImport(entries, onProgress) {
    const plan = entries ?? this._firstRunImportPlan ?? [];
    const reuse = this._firstRunReuse
      ? this._emptyUnnamedWorkspace(this._firstRunReuse)
      : null;
    return this._runImport(plan, { reuseWorkspace: reuse, onProgress });
  },

  /**
   * Shows first run's Workspace step's fields on the switcher and the
   * window's tint, before the workspace exists, or puts the switcher back.
   *
   * @param {?{name: string, color: ?string, emoji: string}} fields
   */
  _previewFirstWorkspace(fields) {
    this._switcherPreview = fields;
    if (this._els?.switcher) {
      this._renderSwitcher();
    }
  },

  /**
   * What an interrupted first run had already applied, for the one that
   * shows again (first-run spec §3.3): every step but the held ones
   * (`SvalFirstRunModel.HELD_STEPS`) applies its answer on Continue, so each
   * answer is the setting it wrote. A setting still at what
   * Sval starts with was never answered, and is left out, and so is a shared
   * folder with no sync key.
   *
   * @returns {Promise<object>} the answers, by `SvalFirstRunModel` field.
   */
  async _firstRunEarlierAnswers() {
    const {
      SvalAgents,
      SvalFirstRunModel,
      SvalPasswordManager,
      SvalSettingsSync,
      LEVEL_PREF,
    } = this._modules;
    const defaults = SvalFirstRunModel.defaults();
    const earlier = {};
    // A folder this device holds no sync key for is a join that never
    // landed: nothing was set up there, so its step is asked again, and Set
    // up later leaves no workspace beside a folder it cannot read.
    const folder = this.sharedRootSetting();
    if (
      folder &&
      this._syncKeyState === this._modules.SvalIdentity.SYNC_KEY_STATES.present
    ) {
      earlier.folder = folder;
    }
    const search = await SvalSettingsSync.searchService().currentId();
    if (search && search !== defaults.search) {
      earlier.search = search;
    }
    if (Services.prefs.prefHasUserValue(LEVEL_PREF)) {
      earlier.adblock = Services.prefs.getStringPref(LEVEL_PREF);
    }
    const manager = SvalPasswordManager.current();
    if (manager !== SvalPasswordManager.NONE) {
      earlier.passwordManager = manager;
    }
    if (Services.prefs.prefHasUserValue(SvalAgents.PREF)) {
      if (!Services.prefs.getBoolPref(SvalAgents.PREF, false)) {
        earlier.agents = "off";
      } else if (
        Services.prefs.getBoolPref(SvalAgents.PAGE_TOOLS_PREF, false)
      ) {
        earlier.agents = "tools";
      } else {
        earlier.agents = "on";
      }
    }
    if (this._settings.placement !== defaults.panelSide) {
      earlier.panelSide = this._settings.placement;
    }
    return earlier;
  },

  /**
   * The effects the dialog asks of the panel (`SvalFirstRun.open`).
   *
   * @returns {object} the actions.
   */
  _firstRunActions() {
    return {
      chooseFolder: () => this._pickFolder(),
      // Only a joining device chooses a folder in first run, and it takes
      // its sync key from pairing, so none is made here.
      useFolder: path => this.chooseSharedFolder(path),
      claim: code => this._firstRunClaim(code),
      stopClaim: async () => this._firstRunStopClaim(),
      recoverKey: () => this._firstRunRecover(),
      adopt: () => this._firstRunAdopt(),
      restore: text => this.restoreFromBackup(text),
      syncedSearch: () =>
        this._modules.SvalSettingsSync.searchService().currentId(),
      searchEngines: () => this._firstRunEngines(),
      apply: (step, answers) => this._applyFirstRunStep(step, answers),
      previewWorkspace: async fields => this._previewFirstWorkspace(fields),
      movePanel: side => this.placePanel(side),
      end: ended => this._endFirstRun(ended),
      runImport: (entries, onProgress) =>
        this._firstRunImport(entries, onProgress),
      openSyncSettings: async () => {
        this._firstRunOpensSync = true;
      },
      signInToKagi: url => this._signInToKagi(url),
      kagiSignedIn: async () => this._modules.SvalKagi.signedIn(),
    };
  },

  /**
   * Applies the synced steps a new device's dialog held until the flow's
   * end (`SvalFirstRunModel.HELD_STEPS`). Only the new path holds them: a joining
   * device writes nothing of either.
   *
   * @param {?object} answers What the dialog reported.
   * @param {string[]} completed The steps continued through.
   */
  async _applyHeldSteps(answers, completed) {
    const { SvalFirstRunModel, SvalLog } = this._modules;
    if (answers?.path !== "new") {
      return;
    }
    for (const step of SvalFirstRunModel.HELD_STEPS) {
      if (!completed.includes(step)) {
        continue;
      }
      try {
        await this._applyFirstRunStep(step, answers);
      } catch (err) {
        SvalLog.warn(
          `first run: ${step} did not apply (${SvalLog.errorName(err)})`
        );
      }
    }
  },

  /**
   * Applies Skip setup's answers to every step the user did not continue
   * through (first-run spec §2): the dialog reports
   * `SvalFirstRunModel.setUpLaterAnswers` with what was continued through,
   * and what an interrupted run had applied, kept. A step whose own apply
   * was still running when the user left may land as well, so each one here
   * is safe to repeat.
   *
   * A joining device applies only what is its own: the search engine and the
   * ad-blocking level sync, and writing them here would overwrite the other
   * device's choices (spec §3.2). The password manager and agent access are
   * its own on either path.
   *
   * @param {?object} answers What the dialog reported.
   * @param {string[]} completed The steps continued through.
   */
  async _applySetUpLater(answers, completed) {
    const { SvalFirstRunModel, SvalLog } = this._modules;
    const { STEPS } = SvalFirstRunModel;
    const steps =
      answers?.path === "join"
        ? [STEPS.passwordManager, STEPS.more]
        : [STEPS.search, STEPS.privacy, STEPS.passwordManager, STEPS.more];
    for (const step of steps) {
      if (completed.includes(step)) {
        continue;
      }
      try {
        await this._applyFirstRunStep(step, answers);
      } catch (err) {
        SvalLog.warn(
          `set up later: ${step} did not apply (${SvalLog.errorName(err)})`
        );
      }
    }
  },

  /**
   * Performs one step's answer (first-run spec §3.3). Each is safe to repeat.
   *
   * @param {string} step A step of `SvalFirstRunModel.STEPS`.
   * @param {object} answers The answers as they stand.
   */
  async _applyFirstRunStep(step, answers) {
    const { STEPS } = this._modules.SvalFirstRunModel;
    switch (step) {
      case STEPS.joinFolder:
        // A joining device takes its sync key from pairing, so none is made.
        await this.chooseSharedFolder(answers.folder ?? null);
        break;
      case STEPS.search: {
        const search = this._modules.SvalSettingsSync.searchService();
        if ((await search.currentId()) !== answers.search) {
          await search.setById(answers.search);
        }
        break;
      }
      case STEPS.privacy:
        // Gecko keeps a value equal to the default unset
        // (`Pref::SetUserValue`), so a profile left at the default has
        // nothing of this device's for sync to carry.
        this._modules.SvalBlocking.setLevel(answers.adblock);
        break;
      case STEPS.import:
        // Kept until the new path's end, which makes the workspace the first
        // window fills before the import runs (`_endFirstRun`).
        this._firstRunImportPlan = answers.importPlan ?? null;
        break;
      case STEPS.passwordManager:
        // Continue with no manager chosen leaves the setting as it is.
        if (answers.passwordManager) {
          this._choosePasswordManager(answers.passwordManager);
        }
        break;
      case STEPS.more:
        await this.placePanel(answers.panelSide);
        // `SvalAgents` opens or closes its listener, and derives Gecko's WebMCP
        // switch, as these prefs change.
        Services.prefs.setBoolPref(
          this._modules.SvalAgents.PREF,
          answers.agents === "on" || answers.agents === "tools"
        );
        Services.prefs.setBoolPref(
          this._modules.SvalAgents.PAGE_TOOLS_PREF,
          answers.agents === "tools"
        );
        if (answers.defaultBrowser) {
          this._setDefaultBrowser();
        }
        break;
      case STEPS.workspace:
        // Kept in the answers: the workspace is made at the new path's end
        // (`_endFirstRun`), since no workspace exists before it (first-run
        // spec §3.4).
        break;
    }
  },

  /**
   * Records the password manager without waiting for its extension to
   * install (spec §7.3). A failed install is `SvalPasswordManager`'s notice.
   *
   * @param {string} key One of `SvalPasswordManager.choices()`.
   */
  _choosePasswordManager(key) {
    const { SvalPasswordManager, SvalLog } = this._modules;
    SvalPasswordManager.choose(key).catch(err =>
      SvalLog.warn(
        `the password manager was not set: ${SvalLog.errorName(err)}`
      )
    );
  },

  /** Retries a failed password manager install once per launch. */
  _reconcilePasswordManager() {
    const { SvalPasswordManager, SvalLog } = this._modules;
    SvalPasswordManager.reconcileAtLaunch().catch(err =>
      SvalLog.warn(
        `the password manager was not reconciled: ${SvalLog.errorName(err)}`
      )
    );
  },

  /**
   * Whether Sval is the default browser, as the preferences page asks. A
   * device that cannot be asked, or may not be changed, counts as one where it
   * is, so first run offers nothing the system will not do.
   *
   * @returns {boolean}
   */
  _isDefaultBrowser() {
    try {
      const { AppConstants, ShellService } = this._modules;
      if (
        !AppConstants.HAVE_SHELL_SERVICE ||
        !Services.policies.isAllowed("setDefaultBrowser")
      ) {
        return true;
      }
      return !!ShellService.isDefaultBrowser(false, true);
    } catch (err) {
      return true;
    }
  },

  /**
   * Asks the system to make Sval the default browser, as the preferences page
   * does. The system shows its own confirmation, and a refusal needs nothing
   * (first-run spec §8), so nothing waits for it.
   */
  _setDefaultBrowser() {
    Promise.resolve()
      .then(() => this._modules.ShellService.setDefaultBrowser(false))
      .catch(err =>
        this._modules.SvalLog.warn(
          `sval was not made the default browser: ${this._modules.SvalLog.errorName(err)}`
        )
      );
  },

  /**
   * The folder picker, as the settings page's, opened over the first-run
   * dialog.
   *
   * @returns {Promise<?{path: string}>} the folder, or null when cancelled.
   */
  async _pickFolder() {
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
      Ci.nsIFilePicker
    );
    picker.init(
      window.gDialogBox?.dialog?._frame?.browsingContext ??
        window.browsingContext,
      "Choose the folder your devices share",
      Ci.nsIFilePicker.modeGetFolder
    );
    const result = await new Promise(resolve => picker.open(resolve));
    return result === Ci.nsIFilePicker.returnOK
      ? { path: picker.file.path }
      : null;
  },

  /**
   * The engines first run offers as the default, in the order
   * `SvalSearchConfig` gives them.
   *
   * @returns {Promise<object[]>} `{ id, name, iconURL }` for each.
   */
  async _firstRunEngines() {
    const { SvalSearchConfig, SearchService } = this._modules;
    const order =
      SvalSearchConfig.SEARCH_CONFIG.find(
        record => record.recordType === "engineOrders"
      )?.orders?.[0]?.order ?? [];
    const rank = id => {
      const at = order.findIndex(entry =>
        entry.endsWith("*") ? id.startsWith(entry.slice(0, -1)) : entry === id
      );
      return at < 0 ? order.length : at;
    };
    // A site search is reached by its keyword, and searches too little of
    // the web to be the default.
    const engines = (await SearchService.getAppProvidedEngines())
      .filter(
        engine =>
          !engine.hidden && !SvalSearchConfig.SITE_SEARCHES.includes(engine.id)
      )
      .sort((a, b) => rank(a.id) - rank(b.id));
    return Promise.all(
      engines.map(async engine => ({
        id: engine.id,
        name: engine.name,
        iconURL: (await engine.getIconURL?.()) ?? "",
      }))
    );
  },

  /**
   * Looks once for the other device's offer, through the folder the joining
   * step chose. What it finds stays here for `adopt`.
   *
   * @param {string} code The normalized code.
   * @returns {Promise<{status: string}>} `SvalPairing.claim`'s status.
   */
  async _firstRunClaim(code) {
    const root = this.sharedRootSetting();
    if (!root) {
      throw new Error("sval: there is no shared folder to pair through");
    }
    if (this._firstRunJoin?.code !== code) {
      this._firstRunJoin = {
        code,
        claimed: null,
        landed: false,
        stopped: false,
      };
    }
    const join = this._firstRunJoin;
    const result = await this._modules.SvalPairing.claim(root, code);
    if (result.status === "claimed") {
      join.claimed = result;
    }
    return { status: result.status };
  },

  /**
   * Gives up the claim of a code the dialog stopped looking for, so the
   * dialog's close does not keep claiming it (`_keepClaiming`). A key found
   * in the folder (`_firstRunRecover`) is no claim of a code and stays.
   */
  _firstRunStopClaim() {
    const join = this._firstRunJoin;
    if (join && join.code !== null && !join.landed) {
      this._firstRunJoin = null;
    }
  },

  /**
   * Adopts the key the claim found.
   *
   * @returns {Promise<object>} what `adoptKey` answers.
   */
  async _firstRunAdopt() {
    const join = this._firstRunJoin;
    if (!join?.claimed) {
      throw new Error("sval: nothing has been claimed");
    }
    const { keyBytes, path } = join.claimed;
    const result = await this.adoptKey(keyBytes, path);
    if (result.outcome !== "unchanged") {
      join.landed = true;
    }
    return result;
  },

  /**
   * Opens one of Kagi's pages in a new tab of this window, and starts
   * watching for the sign-in it leads to (first-run spec §5).
   *
   * @param {string} url `SvalKagi.SIGNIN_URL` or `SvalKagi.TRIAL_URL`.
   */
  _openKagi(url) {
    const { SvalKagi } = this._modules;
    if (url !== SvalKagi.SIGNIN_URL && url !== SvalKagi.TRIAL_URL) {
      throw new Error("sval: that is not one of Kagi's pages");
    }
    SvalKagi.start();
    window.gBrowser.selectedTab = window.gBrowser.addTrustedTab(url);
  },

  /** The window opened for Kagi's sign-in, while it is open. */
  _kagiWindow: null,

  /**
   * For first run's search step: Kagi's sign-in or trial in a window of its
   * own. A tab would sit under the dialog, out of sight, and Kagi has no
   * sign-in a browser can run for the user, only its own page, which sets the
   * `kagi_session` cookie SvalKagi follows (first-run spec §5). The window
   * closes as soon as a normal window is signed in.
   *
   * Settings' Kagi card opens the same window, so a sign-in first run
   * skipped is still reachable (spec §10.8).
   *
   * @param {string} url `SvalKagi.SIGNIN_URL` or `SvalKagi.TRIAL_URL`.
   * @param {object} [options]
   * @param {Function} [options.stillAsked] Whether the page that asked still
   *   wants the window once it has opened: first run's dialog by default.
   * @returns {Promise<{signedIn: boolean}>} once signed in, or once the
   *   window closes without it.
   */
  async _signInToKagi(url, { stillAsked = () => this._firstRunInFlight } = {}) {
    const { SvalKagi } = this._modules;
    if (url !== SvalKagi.SIGNIN_URL && url !== SvalKagi.TRIAL_URL) {
      throw new Error("sval: that is not one of Kagi's pages");
    }
    SvalKagi.start();
    if (SvalKagi.signedIn()) {
      return { signedIn: true };
    }
    this._closeKagiWindow();
    const popup = await this._openKagiWindow(url);
    // The page that asked may have gone while the window started.
    if (!stillAsked()) {
      popup.close();
      return { signedIn: SvalKagi.signedIn() };
    }
    this._kagiWindow = popup;
    this._sayInKagiWindow(popup);
    return new Promise(resolve => {
      const observer = () => {
        if (SvalKagi.signedIn()) {
          finish(true);
        }
      };
      const onUnload = () => finish(SvalKagi.signedIn());
      const finish = signedIn => {
        Services.obs.removeObserver(observer, "cookie-changed");
        popup.removeEventListener("unload", onUnload);
        if (this._kagiWindow === popup) {
          this._kagiWindow = null;
        }
        if (!popup.closed) {
          popup.close();
        }
        resolve({ signedIn });
      };
      Services.obs.addObserver(observer, "cookie-changed");
      popup.addEventListener("unload", onUnload);
    });
  },

  /**
   * Opens `url` in a small normal window without the toolbar: a popup, which
   * the panel leaves to the one page it shows (`_startFromSync`). Never
   * private, so its sign-in lands in the cookie store SvalKagi reads.
   *
   * @param {string} url
   * @returns {Promise<Window>} once its page's browser exists.
   */
  _openKagiWindow(url) {
    return new Promise(resolve => {
      window.openLinkIn(url, "window", {
        triggeringPrincipal:
          Services.scriptSecurityManager.getSystemPrincipal(),
        forceNonPrivate: true,
        chromeless: true,
        width: 520,
        height: 720,
        resolveOnContentBrowserCreated: browser =>
          resolve(browser.documentGlobal),
      });
    });
  },

  /**
   * Tells the user, above Kagi's page, what the window is for and that it
   * closes by itself.
   *
   * @param {Window} popup The sign-in window.
   */
  _sayInKagiWindow(popup) {
    const box = popup.gNotificationBox;
    Promise.resolve(
      box?.appendNotification("sval-kagi-sign-in", {
        label:
          "Sign in or sign up to Kagi. This window closes by itself when " +
          "you're done.",
        priority: box.PRIORITY_INFO_MEDIUM,
      })
    ).catch(err =>
      this._modules.SvalLog.warn(
        `the Kagi window's banner was not shown: ${this._modules.SvalLog.errorName(err)}`
      )
    );
  },

  /** Closes the sign-in window, which belongs to the dialog that opened it. */
  _closeKagiWindow() {
    if (this._kagiWindow && !this._kagiWindow.closed) {
      this._kagiWindow.close();
    }
    this._kagiWindow = null;
  },

  /**
   * Keeps claiming the pairing first run began, on the settings page's clock,
   * until it lands, the code is refused, or the user starts a pairing of
   * their own (first-run spec §3.2). Then startup goes on, with the
   * workspaces pairing brought or one of this device's own.
   *
   * The claim is the process's, not this window's (§3.4 holds every window
   * for it), so a window that closes hands it to the window on top.
   *
   * @param {object} join The claim `_firstRunClaim` began.
   */
  async _keepClaiming(join) {
    const { SvalFirstRun, SvalLog, SvalPairing, SvalPairingLook } =
      this._modules;
    SvalFirstRun.pairing = join;
    // The window holding the claim times its looks and adopts what they find.
    join.panel = this;
    join.look ??= new SvalPairingLook({
      timers: {
        // The process's clock, reached through the holding window, since a
        // window's own timers stop when it closes. A stopped look's wait is
        // dropped by the look when it fires, so nothing is cleared.
        setTimeout: (fn, ms) => join.panel._modules.setTimeout(fn, ms),
        clearTimeout: () => {},
      },
    });
    join.look.pollMs = this._firstRunClaimMs;

    const ended = () => {
      join.stopped = true;
      join.look.stop();
      window.removeEventListener("unload", handOver);
      SvalFirstRun.endPairing(join);
      if (this._firstRunJoin === join) {
        this._firstRunJoin = null;
      }
    };
    // A closed window looks no more. With no normal window to take the claim
    // over it ends, the windows waiting on it go on, and a private window
    // says so: it cannot adopt a key (`adoptKey`), so the claim cannot move
    // there.
    const handOver = () => {
      if (join.stopped || join.landed) {
        ended();
        return;
      }
      const next = this._modules.BrowserWindowTracker.getTopWindow({
        private: false,
      })?.SvalPanel;
      if (next) {
        next._keepClaiming(join);
      } else {
        ended();
        this._sayPairingEnded("stopped");
      }
    };

    // The window that takes the claim over adopts what a closing one found,
    // or joins the join it started, which goes on whatever happens to its
    // window (`SvalKeyJoin`). An adoption that changed nothing looks again
    // after the same wait as a look that found nothing.
    const adopt = async claimed => {
      join.claimed = claimed;
      let adopted;
      try {
        adopted = await this.adoptKey(claimed.keyBytes, claimed.path);
      } catch (err) {
        SvalLog.warn(`first run's pairing stopped: ${SvalLog.errorName(err)}`);
        ended();
        return;
      }
      join.claimed = null;
      if (adopted.outcome !== "unchanged") {
        join.landed = true;
        ended();
        return;
      }
      if (join.panel === this && !join.stopped) {
        this._modules.setTimeout(() => {
          if (join.panel === this && !join.stopped) {
            look();
          }
        }, this._firstRunClaimMs);
      }
    };

    const look = () =>
      join.look.start(
        async () => {
          const root = this.sharedRootSetting();
          return root
            ? SvalPairing.claim(root, join.code)
            : { status: "failed", error: null };
        },
        answer => {
          // The user started a pairing of their own.
          if (join.stopped) {
            ended();
            return;
          }
          switch (answer.status) {
            case "claimed":
              adopt(answer);
              return;
            case "no-match":
              join.stopped = true;
              this._sayPairingEnded("refused");
              ended();
              return;
            case "failed":
              if (answer.error) {
                SvalLog.warn(
                  `first run's pairing stopped: ${SvalLog.errorName(answer.error)}`
                );
              }
              ended();
          }
        }
      );

    window.addEventListener("unload", handOver, { once: true });
    if (join.claimed) {
      await adopt(join.claimed);
    } else {
      look();
    }
  },

  /**
   * Says that the pairing first run left claiming ended unpaired, with the
   * way to pair again: its code was refused (first-run spec §8: a wrong code
   * is said), or no normal window was left to claim it. A bar over the page,
   * because the panel's message area is redrawn by every pass, and nothing
   * else will say it: this device then never joins.
   *
   * A closing window's bar is never seen, so the window on top says it
   * instead, a private one when no other is left. Settings pairs only through
   * a normal window, so a private window's bar names the way rather than
   * offering it.
   *
   * @param {string} why `"refused"` or `"stopped"`.
   */
  _sayPairingEnded(why) {
    if (window.closed) {
      const { BrowserWindowTracker } = this._modules;
      (
        BrowserWindowTracker.getTopWindow({ private: false }) ??
        BrowserWindowTracker.getTopWindow({ private: true })
      )?.SvalPanel?._sayPairingEnded(why);
      return;
    }
    const label =
      why === "refused"
        ? "The code from your other device didn't work, so this device " +
          "isn't syncing with it."
        : "This device stopped looking for the code from your other " +
          "device, so it isn't syncing with it.";
    const pairElsewhere = this._isPrivate
      ? "Open a normal window to enter the code again."
      : "Open one of your own windows to enter the code again.";
    const box = window.gNotificationBox;
    Promise.resolve(
      box?.appendNotification(
        `sval-pairing-${why}`,
        {
          label: this._inMemory ? `${label} ${pairElsewhere}` : label,
          priority: box.PRIORITY_WARNING_MEDIUM,
        },
        this._inMemory
          ? []
          : [
              {
                label: "Enter code again",
                callback: () => {
                  this.openSettingsPage("claim");
                },
              },
            ]
      )
    )
      .then(bar => {
        if (bar && this._inMemory) {
          bar.setAttribute(
            "data-pair-in",
            this._isPrivate ? "normal-window" : "own-window"
          );
        }
      })
      .catch(err =>
        this._modules.SvalLog.warn(
          `the end of pairing was not said: ${this._modules.SvalLog.errorName(err)}`
        )
      );
  },
});
