/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The Sync and devices pane's Sync now and its redraw on the panel's sync
 * state; the device names, in its Devices card; and the result lines
 * (messages spec §9.6) every card of the pane writes, with what their one
 * button does.
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
    DEVICE_NAMES_TOPIC:
      "moz-src:///browser/components/sval/SvalDeviceNames.sys.mjs",
    SvalDeviceNames:
      "moz-src:///browser/components/sval/SvalDeviceNames.sys.mjs",
    SvalSyncState: "moz-src:///browser/components/sval/SvalSyncState.sys.mjs",
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

  const SvalSyncStatusSettings = {
    /**
     * `"syncing"` while a Sync now pressed here runs, else null. The page's
     * state says the rest, as the footer does.
     */
    _syncOutcome: null,

    /** The Sync card's buttons as drawn, as JSON; see `_drawSyncPage`. */
    _shownSyncActions: null,

    /**
     * Finds and wires this device's name and the other devices', and
     * redraws the page whenever the panel's sync state moves.
     *
     * @param {Function} byId Finds one of the page's elements by id.
     * @param {SvalScope} lifetime Ends as the page goes.
     */
    _initSyncStatus(byId, lifetime) {
      Object.assign(this._els, {
        deviceName: byId("sval-device-name"),
        deviceOthers: byId("sval-device-others"),
        deviceList: byId("sval-device-list"),
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
      // the page: spec §6.4 keeps the last-synced time in view.
      lifetime.topic(lazy.SvalPanelModel.SYNC_STATE_TOPIC, () =>
        this._drawSyncPage()
      );
      // A change the passes do not bring, such as a key put right in another
      // window.
      lifetime.topic(lazy.SvalSyncState.CHANGED_TOPIC, () =>
        this._drawSyncPage()
      );
      lifetime.pref(lazy.DEVICE_NAME_PREF, () => this._describeDeviceName());
      lifetime.topic(lazy.DEVICE_NAMES_TOPIC, () => this._describeDeviceName());
    },

    /**
     * Asks the panel for one sync pass.
     *
     * **The pass is the panel's, and so is what it found at the folder.** A
     * pass that came back hands the card to the panel's state, which decides
     * whether the folder's state is shown and when (messages spec §3). The
     * page says itself only that the pass is running, or that it failed.
     */
    async syncNow() {
      if (this._privateOnly) {
        return;
      }
      const panel = this.panel;
      if (!panel) {
        // Nothing in this profile holds the engine a pass needs, so the page
        // redraws rather than reporting a refusal.
        this._drawSyncPage();
        return;
      }

      this._syncOutcome = "syncing";
      this._drawSyncPage();

      let failed = false;
      try {
        // Waits for the shared folder, whatever the interval: someone pressing
        // the button asked what the folder says now.
        failed = (await panel.syncWithFolder()) === null;
      } catch (err) {
        failed = true;
        lazy.SvalLog.error(
          `a sync pass asked for in settings failed: ${lazy.describeError(err)}`
        );
      }
      this._syncOutcome = null;
      this._showStorageReport(
        failed
          ? {
              line: {
                status: "error",
                reason: "sync-failed",
                text: "Sval couldn't sync.",
                action: null,
              },
            }
          : { message: null }
      );
    },

    /**
     * This device's name, the one the user set or else the computer's, and
     * the names the other devices published.
     */
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
      const others = lazy.SvalDeviceNames.others();
      this._els.deviceOthers.hidden = !others.length;
      const shown = [...this._els.deviceList.children].map(
        item => item.textContent
      );
      if (shown.join("\n") !== others.join("\n")) {
        this._els.deviceList.replaceChildren(
          ...others.map(name => {
            const item = document.createElement("li");
            item.textContent = name;
            return item;
          })
        );
      }
    },

    /**
     * Writes a result line (messages spec §9.6) into `textEl`, and its one
     * button into `actionsEl`; with no `line`, writes `text` as a plain
     * status and clears the button.
     *
     * @param {Element} textEl A `.sval-status-line`.
     * @param {Element} actionsEl The `.sval-result-actions` after it, in
     *   the same `.sval-result`.
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
      const button = document.createElement("sval-button");
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
          this.beginOffer();
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
