/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The Sync and devices pane's sync readout, in its Sync card: the state,
 * Sync now and the sync indicator's actions; this device's name, in its Your
 * devices card; and the result lines (messages spec §9.6) every card of the pane
 * writes, with what their one button does.
 *
 * `SvalPreferences` loads this as a classic script after `settings.js`; it
 * adds its methods to `SvalSettings`.
 */

"use strict";

{
  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    DEVICE_NAME_PREF:
      "moz-src:///browser/components/sval/SvalDeviceNames.sys.mjs",
    SvalFeedbackForm:
      "moz-src:///browser/components/sval/SvalFeedbackForm.sys.mjs",
    SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
    computerName: "moz-src:///browser/components/sval/SvalDeviceNames.sys.mjs",
    describeError: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  });
  // `SvalPanelModel.sys.mjs` exports functions rather than one object of that
  // name, so it is imported as a namespace.
  ChromeUtils.defineLazyGetter(lazy, "SvalPanelModel", () =>
    ChromeUtils.importESModule(
      "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
    )
  );

  /** The indicator severities the readout draws as a problem. */
  const PROBLEM_SEVERITIES = new Set([
    "critical",
    "error",
    "warning",
    "offline",
  ]);

  const SvalSyncStatusSettings = {
    /**
     * What the last "Sync now" pressed here came back with: null before one,
     * `"syncing"` while it runs, then `"done"` when the pass came back or
     * `"failed"`. The readout shows it until the panel's own state moves on.
     */
    _syncOutcome: null,

    /**
     * The panel's `_lastPass` when `_syncOutcome` was settled. The panel's
     * signal fires on every redraw of its last-synced line, which includes
     * each redraw of its rows and each poll the engine skipped; only a pass
     * that came back since says anything newer than the outcome does.
     */
    _syncOutcomePass: null,

    /** The readout's buttons as drawn, as JSON; see `_describeSync`. */
    _shownSyncActions: null,

    /**
     * Finds and wires the sync readout and this device's name.
     *
     * @param {Function} byId Finds one of the page's elements by id.
     * @param {Function} followPref Observes a pref until the page goes.
     * @param {Function} followTopic Observes a topic until the page goes.
     */
    _initSyncStatus(byId, followPref, followTopic) {
      Object.assign(this._els, {
        syncState: byId("sval-sync-state"),
        syncNow: byId("sval-sync-now"),
        syncLast: byId("sval-sync-last"),
        syncStatus: byId("sval-sync-status"),
        syncActions: byId("sval-sync-actions"),
        deviceName: byId("sval-device-name"),
      });
      this._els.syncNow.addEventListener("click", () => this.syncNow());
      this._els.syncActions.addEventListener("click", event => {
        const command = event.target.closest("button")?.dataset.command;
        if (command) {
          this.runSyncAction(command);
        }
      });
      // A name equal to the computer's is stored as none, so it follows the
      // computer's if that changes.
      this._els.deviceName.addEventListener("change", () => {
        const name = this._els.deviceName.value.replace(/\s+/g, " ").trim();
        Services.prefs.setStringPref(
          lazy.DEVICE_NAME_PREF,
          name === lazy.computerName() ? "" : name
        );
        this._describeDeviceName();
      });
      // The panel's own signal, so a pass this page did not ask for still moves
      // the readout: spec §6.4 keeps the last-synced time in view, and §10.8
      // shows it beside the button.
      followTopic(lazy.SvalPanelModel.SYNC_STATE_TOPIC, () => {
        // A pass that came back is newer news than how the last one asked for
        // here ended. A tab's title changing redraws the panel too, and that
        // is no news about the folder.
        if (
          this._syncOutcome !== "syncing" &&
          this.panel?.lastPass !== this._syncOutcomePass
        ) {
          this._syncOutcome = null;
        }
        this._describeSync();
        this._describeStorage();
      });
      followPref(lazy.DEVICE_NAME_PREF, () => this._describeDeviceName());
    },

    /**
     * The sync readout: one state, a short reason when there is a problem, and
     * the detail sentence and buttons of the panel's sync indicator (messages
     * spec §3), which the indicator's click leads here to read.
     *
     * **The panel's state, from the panel's own clock.**
     * `SvalPanel.syncIndicator` is what the footer draws, so the two never
     * disagree. A pass asked for
     * here says how it ended until the next pass comes back. Redrawn on focus
     * and after a pass, when the panel redraws its indicator: neither ticks,
     * because a pass is what changes the answer.
     */
    _describeSync() {
      const panel = this.panel;
      let state = "idle";
      let label = "";
      let detail = "";
      let actions = [];
      if (panel) {
        const shown = panel.syncIndicator();
        detail = shown?.detail ?? "";
        actions = shown?.actions ?? [];
        if (this._syncOutcome === "syncing") {
          state = "syncing";
          label = "Syncing…";
        } else if (this._syncOutcome === "failed") {
          state = "problem";
          label = "Couldn't sync";
        } else if (!shown) {
          state = "local";
          label = lazy.SvalPanelModel.ON_THIS_DEVICE_ONLY;
        } else if (shown.severity === "off") {
          state = "local";
        } else if (PROBLEM_SEVERITIES.has(shown.severity)) {
          state = "problem";
          label = shown.label;
        } else {
          state = panel.lastSynced === null ? "waiting" : "synced";
        }
      }
      if (this._els.syncState.dataset.state !== state) {
        this._els.syncState.dataset.state = state;
        // A new state arrives with a small settle, unless the user asked for
        // less motion.
        if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          this._els.syncState.querySelector(".sval-sync-words")?.animate(
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
      // or not the words moved, which costs a paint. See
      // `SvalPanel.drawIndicator`.
      this._els.syncState.dataset.outcome = this._syncOutcome ?? "";
      this._setText(this._els.syncStatus, label);
      this._setText(this._els.syncLast, detail);
      const actionsKey = JSON.stringify(actions);
      if (this._shownSyncActions !== actionsKey) {
        this._shownSyncActions = actionsKey;
        this._els.syncActions.replaceChildren(
          ...actions.map(action => {
            const button = document.createElement("button");
            button.className = "sval-button";
            button.dataset.command = action.command;
            // The footer draws its dismiss action as a bare ✕; here it is
            // a button among buttons, so it says what it does.
            button.textContent =
              action.command === "dismissOtherWorkspaces"
                ? "Dismiss"
                : action.label;
            return button;
          })
        );
      }
    },

    /**
     * Runs one of the sync indicator's actions through the panel's own
     * command, as the footer's button would, and redraws the readout. The
     * panel's Choose Folder opens this page at the folder; here, where the
     * folder already is, it opens the picker, as a result line's does.
     *
     * @param {string} command
     */
    async runSyncAction(command) {
      if (command === "chooseSharedFolder") {
        await this._runResultAction(command, null, null);
      } else {
        await this.panel?.run(command, null);
      }
      this._describeSync();
    },

    /**
     * Asks the panel for one sync pass.
     *
     * **The pass is the panel's, and so is what it found at the folder.** A
     * pass that came back hands the readout to the panel's indicator, which
     * decides whether the folder's state is shown and when (messages spec
     * §3). The readout says itself only that the pass is running or that it
     * failed.
     */
    async syncNow() {
      if (this._privateOnly) {
        return;
      }
      const panel = this.panel;
      if (!panel) {
        // Nothing in this profile holds the engine a pass needs, so the page
        // redraws rather than reporting a refusal.
        this._describeStorage();
        return;
      }

      this._els.syncNow.disabled = true;
      this._syncOutcome = "syncing";
      this._describeSync();

      let shared = null;
      let outcome;
      try {
        // Waits for the shared folder, whatever the interval: someone pressing
        // the button asked what the folder says now.
        shared = await panel.syncWithFolder();
        outcome = shared === null ? "failed" : "done";
      } catch (err) {
        outcome = "failed";
        lazy.SvalLog.error(
          `a sync pass asked for in settings failed: ${lazy.describeError(err)}`
        );
      }
      this._els.syncNow.disabled = false;
      this._syncOutcome = outcome;
      this._syncOutcomePass = panel.lastPass;
      this._describeSync();
    },

    /** This device's name: the one the user set, else the computer's. */
    _describeDeviceName() {
      const computer = lazy.computerName();
      this._els.deviceName.placeholder = computer;
      if (
        this._els.deviceName.ownerDocument.activeElement !==
        this._els.deviceName
      ) {
        this._els.deviceName.value =
          Services.prefs.getStringPref(lazy.DEVICE_NAME_PREF, "") || computer;
      }
    },

    /**
     * Writes a result line (messages spec §9.6) into `textEl`, and its one
     * button into `actionsEl`; with no `line`, writes `text` as a plain
     * status and clears the button.
     *
     * @param {Element} textEl A `.sval-status-line`.
     * @param {Element} actionsEl The `.sval-result-actions` after it.
     * @param {object|null} line `{ status, reason, text, action }`, as
     *   `SvalPanelModel.pairingLine` answers.
     * @param {object} [options]
     * @param {string} [options.text] The plain status, when `line` is null.
     * @param {Function} [options.retry] What the line's Try Again or Allow
     *   Access runs: the act whose result the line is.
     */
    _showResult(textEl, actionsEl, line, { text = "", retry = null } = {}) {
      textEl.textContent = line ? line.text : text;
      if (line) {
        textEl.dataset.status = line.status;
      } else {
        delete textEl.dataset.status;
      }
      textEl.dataset.reason = line?.reason ?? "";
      const action = line?.action;
      if (!action) {
        actionsEl.replaceChildren();
        return;
      }
      const button = document.createElement("button");
      button.className = "sval-button";
      button.dataset.command = action.command;
      button.textContent = action.label;
      button.addEventListener("click", () =>
        this._runResultAction(action.command, button, retry, line.text)
      );
      actionsEl.replaceChildren(button);
    },

    /**
     * Acts on a result line's button.
     *
     * @param {string} command One of `pairingLine`'s commands, or
     *   `"offerCode"`.
     * @param {Element} button The button pressed.
     * @param {Function|null} retry What `"tryAgain"` runs.
     * @param {string} text The line the button is on.
     */
    async _runResultAction(command, button, retry, text) {
      switch (command) {
        case "tryAgain":
          retry?.();
          return;
        case "chooseSharedFolder":
          this.focusSection("storage");
          this.chooseFolder();
          return;
        case "offerCode":
          this.choosePath("offer");
          this.focusSection("offer");
          return;
        case "sendReport":
          await this._sendReport(button, text);
      }
    },

    /**
     * Send Report…: the feedback form, with the failure and the sync
     * indicator's state as its context (feedback spec §2).
     *
     * @param {Element} button
     * @param {string} text The failure's line.
     */
    async _sendReport(button, text) {
      const shown = this.panel?.syncIndicator();
      const state = shown
        ? [shown.severity, shown.label].filter(Boolean).join(", ")
        : lazy.SvalPanelModel.ON_THIS_DEVICE_ONLY;
      await lazy.SvalFeedbackForm.report(
        button,
        window.browsingContext.topChromeWindow,
        `${text} Sync: ${state}.`
      );
    },
  };

  Object.assign(window.SvalSettings, SvalSyncStatusSettings);
}
