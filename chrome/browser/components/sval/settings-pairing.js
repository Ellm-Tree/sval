/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The Sync and devices pane's two ends of getting a sync key onto a second
 * device (spec §6.7): Add a device, in the Devices card, on a device that is
 * syncing, and Enter code, a dialog the Sync card opens on a device whose
 * state asks for a key.
 *
 * **Nothing about a key is decided here.** The offering side hands
 * `SvalPairing.offer` this device's key and shows what comes back; the
 * claiming side hands what `SvalPairing.claim` returns to `SvalPanel.adoptKey`
 * and renders `SvalPanelModel.pairingLine` of its answer, the line first run
 * shows too (messages spec §7).
 *
 * `SvalPreferences` loads this as a classic script after `settings.js`; it
 * adds its methods to `SvalSettings`.
 */

"use strict";

{
  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
    CLAIM_POLL_MS: "moz-src:///browser/components/sval/SvalPairing.sys.mjs",
    SvalFirstRun: "moz-src:///browser/components/sval/SvalFirstRun.sys.mjs",
    SvalIdentity: "moz-src:///browser/components/sval/SvalIdentity.sys.mjs",
    SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
    SvalPairing: "moz-src:///browser/components/sval/SvalPairing.sys.mjs",
    SvalPairingLook: "moz-src:///browser/components/sval/SvalPairing.sys.mjs",
    describeError: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
    folderProblem:
      "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs",
    openSvalDialog: "moz-src:///browser/components/sval/SvalDialog.sys.mjs",
  });
  // `SvalPanelModel.sys.mjs` exports functions rather than one object of that
  // name, so it is imported as a namespace.
  ChromeUtils.defineLazyGetter(lazy, "SvalPanelModel", () =>
    ChromeUtils.importESModule(
      "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
    )
  );

  /** The countdown reads in seconds, so it ticks in seconds. */
  const SVAL_COUNTDOWN_TICK_MS = 1000;

  /**
   * What the offering page says when the folder did not take the offer, by the
   * helper's reason.
   *
   * @param {string|undefined} reason `SvalSharedFolder`'s reason.
   * @returns {string}
   */
  function offerFailureText(reason) {
    return lazy.folderProblem(reason) === "gone"
      ? "Sval can't find the sync folder."
      : "Sval can't reach the sync folder.";
  }

  const SvalPairingSettings = {
    /** The live offer, `{ code, path, expiresAt }`, or null. */
    _offer: null,

    /** The countdown's `setInterval` handle, or null. */
    _countdown: null,

    /**
     * The claiming side's look for its code, a `SvalPairingLook`, made by
     * `init`. A test shortens its `pollMs`.
     */
    _claims: null,

    /** The Enter code dialog's answer while the dialog is up, or null. */
    _codeDialog: null,

    /** Countdown ticks since the offer was made. See `_offerCheckTicks`. */
    _ticks: 0,

    /** Whether a `_checkStillOffered` is waiting for the folder. */
    _checking: false,

    /**
     * How many countdown ticks pass between the offering page asking whether
     * its own offer is still in the folder.
     *
     * The other device deletes the file when it adopts the key, and nothing
     * tells this one. Without this check the page goes on showing a live code
     * and "type it on your other device within the hour" for the rest of the
     * hour, which is false from the moment pairing succeeds.
     *
     * As often as a claim looks, for the same reason: it is one `exists`
     * against a folder this device is already syncing with. Set by `init`.
     */
    _offerCheckTicks: 0,

    /**
     * `SVAL_COUNTDOWN_TICK_MS`, and the ticks above, read through the page so
     * a test can shorten them. A test that waits on these clocks otherwise
     * sits out real seconds per wait.
     */
    _countdownTickMs: SVAL_COUNTDOWN_TICK_MS,

    /**
     * `init`'s sweep of stale pairing offers, kept so a test can wait for it
     * to finish with the shared folder before its own first request.
     */
    _sweep: Promise.resolve(),

    /**
     * Finds and wires the Your devices card and its flow.
     *
     * @param {Function} byId Finds one of the page's elements by id.
     */
    _initPairing(byId) {
      this._claims = new lazy.SvalPairingLook();
      this._offerCheckTicks = lazy.CLAIM_POLL_MS / SVAL_COUNTDOWN_TICK_MS;
      Object.assign(this._els, {
        devices: byId("sval-devices"),
        pairingStart: byId("sval-pairing-start"),
        pairingOpen: byId("sval-pairing-open"),
        offerSteps: byId("sval-path-offer-steps"),
        offerFolder: byId("sval-offer-folder"),
        offerWhere: byId("sval-offer-where"),
        offerLive: byId("sval-offer-live"),
        offerCode: byId("sval-offer-code"),
        offerCopy: byId("sval-offer-copy"),
        offerCountdown: byId("sval-offer-countdown"),
        offerWithdraw: byId("sval-offer-withdraw"),
        offerStatus: byId("sval-offer-status"),
      });
      // Add a device… shows the code at once: the one thing the other device
      // needs from this one.
      this._els.pairingOpen.addEventListener("click", () => {
        this.choosePath("offer");
        this.beginOffer();
      });
      this._els.offerCopy.addEventListener("click", () => this._copyCode());
      // Cancel code takes the code back and closes Add a device: nothing is
      // left to show.
      this._els.offerWithdraw.addEventListener("click", async () => {
        await this.withdrawOffer("");
        this.choosePath("");
      });
    },

    /**
     * Anyone opening this page may be about to look at the pairing folder, so
     * it is the natural moment to clear the offers a device left behind by
     * closing before it could withdraw its own (spec §6.7).
     */
    _sweepOffers() {
      const root = this._sharedRoot();
      if (root) {
        this._sweep = lazy.SvalPairing.sweep(root).catch(err =>
          lazy.SvalLog.warn(
            `sweeping stale pairing offers failed: ${lazy.describeError(err)}`
          )
        );
      }
    },

    /**
     * The folder the user shares through, but only when it is somewhere another
     * device could see.
     *
     * @returns {string|null} the shared folder, or null.
     */
    _sharedRoot() {
      return this.panel?.sharedRootSetting() ?? null;
    },

    /** Names the sync folder where Add a device says what both devices need. */
    _describeFolder() {
      const root = this._sharedRoot();
      const named = root ? lazy.SvalPanelModel.friendlyFolderName(root) : "";
      this._setText(
        this._els.offerFolder,
        root
          ? `Sval shows a code for the new device. Both devices must sync ` +
              `with ${named}.`
          : ""
      );
      this._setText(
        this._els.offerWhere,
        "On the new device, go to Settings › Sync and devices › Enter code…, " +
          "then type the code."
      );
      this._els.offerFolder.title = root ?? "";
    },

    /**
     * The shared folder, or null, with the page redrawn for it: the folder
     * is chosen in the panel or another window while this page is open.
     *
     * @returns {string|null} the shared folder, or null.
     */
    _requireSharedRoot() {
      this._drawSyncPage();
      return this._sharedRoot();
    },

    /**
     * Shows Add a device's code in the Devices card, or takes it away. A
     * live code stays where it is, so nothing in flight is hidden from the
     * person who asked for it: Cancel code is the way out.
     *
     * @param {string} path `"offer"`, or `""` for none.
     */
    choosePath(path) {
      if (!this._els) {
        return;
      }
      const current = this._els.devices.dataset.path;
      if (current !== path && this._offer) {
        return;
      }
      this._els.devices.dataset.path = path;
      this._els.pairingOpen.setAttribute(
        "aria-expanded",
        String(path === "offer")
      );
      this._els.offerSteps.hidden = path !== "offer";
      this._showOfferStep();
      if (path === "" && current === "offer") {
        this._els.pairingOpen.focus();
      }
    },

    /** Shows the code once it is live. */
    _showOfferStep() {
      this._els.offerLive.hidden = !this._offer;
    },

    /**
     * Enter code…: joins with this user's own key when Sval left a sealed
     * copy of the key in the folder (key-storage spec, "Installing again"),
     * and otherwise asks for a code in one dialog. The dialog stays up while
     * Sval looks for the code, and says there why a code didn't work; a code
     * that joined closes it, and the Sync card says so.
     */
    async enterCode() {
      if (this._privateOnly || this._codeDialog) {
        return;
      }
      const found = await this.panel?.joinWithKeyInFolder().catch(() => null);
      if (found?.adopted) {
        this._claimLanded({
          status: "success",
          reason: "found-key",
          text: "Sval found your sync key in the sync folder.",
          action: null,
        });
        return;
      }
      const root = this._requireSharedRoot();
      if (!root) {
        return;
      }
      const named = lazy.SvalPanelModel.friendlyFolderName(root);
      const opened = lazy.openSvalDialog(
        window.browsingContext.topChromeWindow,
        {
          icon: "key",
          state: "enter-code",
          title: "Enter code",
          body:
            "On a device that is currently syncing to this location, go to " +
            "Settings › Sync and devices › Add a device. Both devices must " +
            `sync with ${named}.`,
          field: {
            label: "Code",
            placeholder: "XXXX-XXXX-XXXX",
            validate: text =>
              lazy.SvalPanelModel.normalizeCode(text)
                ? ""
                : "A code has 12 letters and numbers, like K7Q4-8MTZ-3RJW.",
          },
          primary: "Enter code",
          onButton: (id, dialog) => {
            if (id === "ok") {
              this._claimIn(dialog, root);
            }
            return id === "ok";
          },
        }
      );
      this._codeDialog = opened;
      try {
        await opened;
      } finally {
        this._codeDialog = null;
        // A dialog closed while Sval was still looking stops the look.
        this._claims.stop();
        this._drawSyncPage();
      }
    },

    async beginOffer() {
      if (this._privateOnly) {
        return;
      }
      const root = this._requireSharedRoot();
      if (!root) {
        return;
      }

      this._els.pairingOpen.disabled = true;
      this._els.offerStatus.textContent = "Making the code…";
      this._els.offerStatus.dataset.said = "making";
      // Add a device shows only on a device whose key works; one that went
      // since the page drew it is redrawn, which withdraws the flow.
      const sync = await lazy.SvalIdentity.syncKey().catch(() => null);
      if (sync?.state !== lazy.SvalIdentity.SYNC_KEY_STATES.present) {
        this._els.pairingOpen.disabled = false;
        this.choosePath("");
        this._drawSyncPage();
        return;
      }
      // A pairing the user starts here replaces the one first run left
      // claiming (first-run spec §3.2).
      lazy.SvalFirstRun.stopPairing();

      let offer;
      try {
        offer = await lazy.SvalPairing.offer(root, sync.bytes, Date.now());
      } catch (err) {
        this._els.pairingOpen.disabled = false;
        this.choosePath("");
        const problem = lazy.folderProblem(err?.reason);
        this._els.offerStatus.dataset.said = `folder-${problem}`;
        this._els.offerStatus.textContent = offerFailureText(err?.reason);
        return;
      }
      this._els.pairingOpen.disabled = false;

      if (this._gone) {
        // The tab closed while Argon2 ran. Nothing is on screen to withdraw
        // from, so withdraw here.
        await lazy.SvalPairing.withdraw(offer.path).catch(() => {});
        return;
      }

      this.choosePath("offer");
      this._offer = offer;
      this._ticks = 0;
      this._els.offerCode.value = offer.code;
      this._showOfferStep();
      this._armWithdrawal(offer);
      this._tick();
      this._countdown = setInterval(() => this._tick(), this._countdownTickMs);
      // One announcement for the one thing that happened, rather than letting
      // the countdown say it once a second.
      this._els.offerStatus.dataset.said = "ready";
      this._els.offerStatus.textContent = "The code works for an hour.";
      this._els.offerCode.focus();
      this._els.offerCode.select();
    },

    /**
     * Makes sure the offer does not outlive the page.
     *
     * Two listeners, because they cover different endings and one of them
     * cannot be trusted alone. `pagehide` fires for a navigation away, but the
     * document is being torn down while its asynchronous delete is in flight;
     * the tab's own `TabClose` runs on the chrome window, which outlives the
     * tab, so that is the one that reliably finishes. Closing the tab fires
     * `TabClose` first and `pagehide` after it.
     *
     * Only the first to fire withdraws, and only an offer that may still be in
     * the folder: one the other device used, or this page withdrew, is gone.
     * A second withdrawal at once would only queue behind the first. So a
     * withdrawal still running is waited for, and tried again only if it
     * fails: one that failed leaves the offer in the folder. The wait runs in
     * `SvalPairing`, which outlives this page.
     *
     * A tab moved to another window fires `TabClose` too. The page goes on in
     * that window, offer and all, so that is not an ending.
     *
     * `SvalPairing.sweep` is the backstop for the ending neither covers, a
     * browser that was killed, and it is why the offer expires at all.
     *
     * @param {object} offer The offer these listeners are about.
     */
    _armWithdrawal(offer) {
      let fired = false;
      const withdraw = event => {
        if (event?.detail?.adoptedBy || fired || offer.gone) {
          return;
        }
        fired = true;
        if (this._offer === offer) {
          this._offer = null;
          this._stopCountdown();
        }
        const withdrawn = offer.withdrawal
          ? lazy.SvalPairing.withdrawUnlessDone(offer.withdrawal, offer.path)
          : this._withdraw(offer);
        withdrawn.catch(err =>
          // Debug: `SvalPairing.sweep` is the backstop, and the offer expires
          // within the hour either way.
          lazy.SvalLog.debug(
            `withdrawing a pairing offer failed: ${lazy.describeError(err)}`
          )
        );
      };

      const tab = this._ownTab();
      if (tab) {
        tab.addEventListener("TabClose", withdraw, { once: true });
      }
      window.addEventListener("pagehide", withdraw, { once: true });
    },

    /**
     * Withdraws `offer`, recording on it what the close listeners need:
     * `withdrawal`, the request itself, while it runs, and `gone` once it
     * succeeded.
     *
     * @param {object} offer What `SvalPairing.offer` returned.
     * @returns {Promise<void>} rejects as `SvalPairing.withdraw` does.
     */
    async _withdraw(offer) {
      const withdrawal = lazy.SvalPairing.withdraw(offer.path);
      offer.withdrawal = withdrawal;
      try {
        await withdrawal;
        offer.gone = true;
      } finally {
        if (offer.withdrawal === withdrawal) {
          offer.withdrawal = null;
        }
      }
    },

    /**
     * @returns {Element|null} the `<tab>` this page is loaded in.
     */
    _ownTab() {
      const chromeWindow = window.browsingContext?.topChromeWindow;
      const browser = window.docShell?.chromeEventHandler;
      if (!chromeWindow?.gBrowser || !browser) {
        return null;
      }
      return chromeWindow.gBrowser.getTabForBrowser(browser);
    },

    /**
     * Redraws the countdown, and ends the offer when it reaches zero.
     *
     * Expiry is judged against this device's own wall clock, as the claiming
     * device judges it against its own: there is no clock they share.
     */
    _tick() {
      if (!this._offer) {
        return;
      }
      const remaining = this._offer.expiresAt - Date.now();
      if (remaining <= 0) {
        this.withdrawOffer(
          "The code expired. For a new code, select Add a device… again.",
          "expired"
        );
        return;
      }
      const seconds = Math.ceil(remaining / 1000);
      const minutes = Math.floor(seconds / 60);
      this._els.offerCountdown.textContent = `Expires in ${minutes}:${String(seconds % 60).padStart(2, "0")}`;

      this._ticks++;
      if (this._ticks % this._offerCheckTicks === 0) {
        this._checkStillOffered(this._offer);
      }
    },

    /**
     * Notices that the other device has taken the offer.
     *
     * The adopting device deletes the file once it has stored the key, so the
     * file being gone is the only signal this page gets that pairing worked.
     * The file is also gone when *this* page withdrew it, which is why the
     * offer is compared by identity: `withdrawOffer` clears `_offer` first, so
     * a check already in flight finds nothing to report.
     *
     * @param {object} offer The offer this check is about.
     */
    async _checkStillOffered(offer) {
      // `stillOffered` can wait its turn at the helper, so a check is not
      // started while the last one is still waiting.
      if (this._checking) {
        return;
      }
      this._checking = true;
      let there;
      try {
        there = await lazy.SvalPairing.stillOffered(offer.path);
      } finally {
        this._checking = false;
      }
      // Null is a folder that did not answer, which is not evidence that the
      // code was used. The page then keeps counting down: it never says "used"
      // for a folder it could not read.
      if (there === false) {
        offer.gone = true;
      }
      if (there !== false || this._offer !== offer) {
        return;
      }

      this._stopCountdown();
      this._offer = null;
      this._els.offerCode.value = "";
      this._els.offerCountdown.textContent = "";
      this.choosePath("");
      this._els.offerStatus.dataset.said = "used";
      this._els.offerStatus.textContent = "The new device used the code.";
    },

    _stopCountdown() {
      if (this._countdown !== null) {
        clearInterval(this._countdown);
        this._countdown = null;
      }
    },

    /**
     * Takes the offer out of the folder and puts the page back to where it was
     * before there was one.
     *
     * @param {string} message What the status line says afterwards.
     * @param {string} [said] The status line's `data-said`, naming it.
     */
    async withdrawOffer(message, said = "") {
      this._stopCountdown();
      const offer = this._offer;
      this._offer = null;

      this._els.offerCode.value = "";
      this._els.offerCountdown.textContent = "";
      this.choosePath("");
      this._els.offerStatus.dataset.said = said;
      this._els.offerStatus.textContent = message;

      if (offer) {
        try {
          await this._withdraw(offer);
        } catch (err) {
          this._els.offerStatus.dataset.said = "not-withdrawn";
          this._els.offerStatus.textContent =
            "Sval couldn't cancel the code. The code expires within the hour.";
        }
      }
    },

    _copyCode() {
      const code = this._els.offerCode.value;
      if (!code) {
        return;
      }
      try {
        Cc["@mozilla.org/widget/clipboardhelper;1"]
          .getService(Ci.nsIClipboardHelper)
          .copyString(code);
      } catch (err) {
        lazy.SvalLog.warn(
          `copying the pairing code failed: ${lazy.SvalLog.errorName(err)}`
        );
        this._els.offerStatus.dataset.said = "not-copied";
        this._els.offerStatus.textContent =
          "Sval couldn't copy the code. The code is selected.";
        this._els.offerCode.focus();
        this._els.offerCode.select();
        return;
      }
      this._els.offerStatus.dataset.said = "copied";
      this._els.offerStatus.textContent = "Sval copied the code.";
    },

    /**
     * Looks for the code typed in the Enter code dialog `dialog`, until it
     * arrives or the dialog closes.
     *
     * @param {object} dialog The dialog's handle (`openSvalDialog`'s
     *   `onButton`).
     * @param {string} root The shared folder.
     */
    _claimIn(dialog, root) {
      const code = lazy.SvalPanelModel.normalizeCode(dialog.value());
      if (!code || this._claims.looking) {
        return;
      }
      lazy.SvalFirstRun.stopPairing();
      delete this._els.storageSection.dataset.joinOutcome;
      dialog.setButton("ok", { disabled: true });
      dialog.update({ state: "looking", warning: "Looking for the code…" });
      this._claims.start(
        () => lazy.SvalPairing.claim(root, code),
        answer => this._answered(answer, dialog)
      );
    },

    /**
     * Says what the look for the code found.
     *
     * **`waiting` is never rendered as a failure.** It means nothing claimable
     * has arrived (an empty folder, an expired offer, a file that is not a
     * pairing file), and the user's code may be good. Telling them it did not
     * work would send them back for a new code over a channel spec §6.4
     * measures in tens of minutes. Only `no-match`, a live offer this code
     * does not open, says the code is wrong.
     *
     * @param {object} answer A `SvalPairingLook` answer.
     * @param {object} dialog The Enter code dialog's handle.
     */
    _answered(answer, dialog) {
      switch (answer.status) {
        case "claimed":
          this._adopt(answer, dialog);
          return;
        case "no-match":
          this._stopLooking(
            dialog,
            "no-match",
            "The code didn't work. Check the code, or get a new code."
          );
          return;
        case "failed":
          lazy.SvalLog.warn(
            `claiming a pairing offer failed: ${lazy.SvalLog.errorName(answer.error)}`
          );
          this._stopLooking(
            dialog,
            "unreadable",
            "Sval can't read the sync folder."
          );
          return;
      }
      const named = lazy.SvalPanelModel.friendlyFolderName(
        this._sharedRoot() ?? ""
      );
      // A folder that does not answer is said as the sync indicator says it
      // (decision 0032), and the look goes on, so the dialog moves on once
      // the folder is back.
      if (
        lazy.SvalPanelModel.showsFolderNotice({
          problem: answer.problem ?? null,
          failures: answer.failures ?? 0,
        })
      ) {
        const gone = answer.problem === "gone";
        dialog.update({
          state: gone ? "folder-missing" : "folder-unreachable",
          warning: gone
            ? `Sval can't find ${named}. If ${named} is on a drive, ` +
              "connect the drive."
            : `Sval can't reach ${named}. Sval keeps looking for the code ` +
              `until ${named} is reachable.`,
        });
        return;
      }
      dialog.update({
        state: "waiting",
        warning:
          `Sval hasn't found the code in ${named} yet. The code can take a ` +
          `few minutes to reach ${named}.`,
      });
    },

    /**
     * Ends a look for a code with what the Enter code dialog says, and gives
     * back its button.
     *
     * @param {object} dialog The dialog's handle.
     * @param {string} state What the dialog says, as its `data-state`.
     * @param {string} warning The sentence that says it.
     */
    _stopLooking(dialog, state, warning) {
      this._claims.stop();
      dialog.setButton("ok", { disabled: false });
      dialog.update({ state, warning });
    },

    /**
     * Hands a claimed key to the panel and says how it went (messages spec
     * §7).
     *
     * @param {object} claimed `SvalPairing.claim`'s `"claimed"` result.
     * @param {object} dialog The Enter code dialog's handle.
     */
    async _adopt(claimed, dialog) {
      // A join that never reached `SvalKeyJoin` has no failure of its own,
      // so it is told as `pairingLine`'s default, with the report that holds
      // what stopped it.
      const unforeseen = lazy.SvalPanelModel.pairingLine(
        { adopted: false },
        lazy.AppConstants.platform
      );
      const panel = await this._startedPanel();
      if (!panel) {
        // No window of this profile is running Sval: it stopped between the
        // code being typed and the offer turning up, which the claim loop can
        // wait minutes for.
        this._stopLooking(dialog, unforeseen.reason, unforeseen.text);
        return;
      }

      dialog.update({ state: "joining", warning: "Joining…" });

      let result;
      try {
        result = await panel.adoptKey(claimed.keyBytes, claimed.path);
      } catch (err) {
        // `_adoptKey` answers with an outcome rather than throwing, so this is
        // the unforeseen case. The detail goes to the log.
        lazy.SvalLog.error(`adopting a key threw: ${lazy.describeError(err)}`);
        this._stopLooking(dialog, unforeseen.reason, unforeseen.text);
        return;
      }

      const line = lazy.SvalPanelModel.pairingLine(
        result,
        lazy.AppConstants.platform
      );
      if (result.adopted) {
        dialog.close();
        this._claimLanded(line, result.outcome);
        return;
      }
      // The same code tries again with Enter code: a join that did not
      // finish leaves the offer in the folder. Which half of the join
      // happened is the card's `data-join-outcome`, for a reader that tells
      // them apart without the words.
      this._els.storageSection.dataset.joinOutcome = result.outcome;
      this._stopLooking(dialog, line.reason, line.text);
    },

    /**
     * Ends Enter code once this device has the key: the Sync card says so,
     * whose state the key just changed.
     *
     * @param {object} line A result line.
     * @param {string} [outcome] The join's, as `SvalPanel.adoptKey` names it.
     */
    _claimLanded(line, outcome = "adopted") {
      this._showStorageReport({ line });
      this._els.storageStatus.dataset.outcome = outcome;
    },
  };

  Object.assign(window.SvalSettings, SvalPairingSettings);
}
