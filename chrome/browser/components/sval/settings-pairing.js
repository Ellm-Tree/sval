/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The Sync and devices pane's Your devices card and the flow it opens: the
 * question that chooses which device shows the code, and both ends of getting
 * this device's key onto a second one (spec §6.7).
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
   * The flow's precondition, for both of its paths: the key travels through
   * the folder the two devices share, so a device still on its own profile
   * directory has nowhere to put an offer and nowhere to find one.
   */
  const SVAL_NEEDS_SHARED_FOLDER = "Choose a sync folder first.";

  /**
   * Why no code is shown on a device whose sync key cannot be used: there is
   * nothing to hand on, and the panel already says why it is not syncing.
   */
  const SVAL_NO_SYNC_KEY =
    "This device isn't syncing right now, so it can't give another device a code.";

  /**
   * What the offering page says when the folder did not take the offer, by the
   * helper's reason.
   *
   * @param {string|undefined} reason `SvalSharedFolder`'s reason.
   * @returns {string}
   */
  function offerFailureText(reason) {
    return lazy.folderProblem(reason) === "gone"
      ? "Can't find your sync folder."
      : "Can't reach your sync folder.";
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
        needsFolder: byId("sval-pairing-needs-folder"),
        folder: byId("sval-folder"),
        goSync: byId("sval-pairing-go-sync"),
        pairingStart: byId("sval-pairing-start"),
        pairingOpen: byId("sval-pairing-open"),
        chooser: byId("sval-pairing-choose"),
        chooseBack: byId("sval-choose-back"),
        choices: byId("sval-pairing-choices"),
        pathOffer: byId("sval-path-offer"),
        pathClaim: byId("sval-path-claim"),
        offerSteps: byId("sval-path-offer-steps"),
        offerBack: byId("sval-offer-back"),
        offerProgress: byId("sval-offer-progress"),
        offerFolder: byId("sval-offer-folder"),
        offerStart: byId("sval-offer-start"),
        offerLive: byId("sval-offer-live"),
        offerCode: byId("sval-offer-code"),
        offerCopy: byId("sval-offer-copy"),
        offerCountdown: byId("sval-offer-countdown"),
        offerWithdraw: byId("sval-offer-withdraw"),
        offerStatus: byId("sval-offer-status"),
        claimSteps: byId("sval-path-claim-steps"),
        claimBack: byId("sval-claim-back"),
        claimProgress: byId("sval-claim-progress"),
        claimFolder: byId("sval-claim-folder"),
        claimNext: byId("sval-claim-next"),
        claimForm: byId("sval-claim-form"),
        claimCode: byId("sval-claim-code"),
        claimSubmit: byId("sval-claim-submit"),
        claimStop: byId("sval-claim-stop"),
        claimStatus: byId("sval-claim-status"),
        claimActions: byId("sval-claim-actions"),
      });
      lazy.SvalPanelModel.groupCodeField(this._els.claimCode);
      this._els.goSync.addEventListener("click", () =>
        this.focusSection("storage")
      );
      this._els.pairingOpen.addEventListener("click", () =>
        this.choosePath(this._els.devices.dataset.path ? "" : "choose")
      );
      this._els.chooseBack.addEventListener("click", () => this.choosePath(""));
      this._els.pathOffer.addEventListener("click", () =>
        this.choosePath("offer")
      );
      this._els.pathClaim.addEventListener("click", () =>
        this.choosePath("claim")
      );
      this._els.offerBack.addEventListener("click", () =>
        this.choosePath("choose")
      );
      this._els.claimBack.addEventListener("click", () =>
        this.choosePath("choose")
      );
      this._els.claimNext.addEventListener("click", () => this.claimNext());
      this._els.offerStart.addEventListener("click", () => this.beginOffer());
      this._els.offerCopy.addEventListener("click", () => this._copyCode());
      // No message: the step is back where it started with the button
      // returned, and that is the whole of what happened.
      this._els.offerWithdraw.addEventListener("click", () =>
        this.withdrawOffer("")
      );
      this._els.claimForm.addEventListener("submit", event => {
        event.preventDefault();
        this.beginClaim();
      });
      this._els.claimStop.addEventListener("click", () =>
        this._stopLooking("Stopped.", "stopped")
      );
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

    /**
     * Shows the flow's precondition when it is not met, and names the folder
     * in each path's folder step when it is.
     */
    _describeFolder() {
      const root = this._sharedRoot();
      this._els.needsFolder.hidden = !!root;
      this._els.pairingStart.hidden = !root;
      this._setText(this._els.folder, root ? "" : SVAL_NEEDS_SHARED_FOLDER);
      const named = root ? lazy.SvalPanelModel.friendlyFolderName(root) : "";
      this._setText(this._els.offerFolder, root ? `Sync folder: ${named}` : "");
      this._setText(
        this._els.claimFolder,
        root ? `Both devices need the same sync folder: ${named}` : ""
      );
      this._els.offerFolder.title = root ?? "";
      this._els.claimFolder.title = root ?? "";
      for (const id of ["choices", "offerSteps", "claimSteps"]) {
        this._els[id].classList.toggle("sval-unmet", !root);
      }
    },

    /**
     * The shared folder, or null with the reason already on screen.
     *
     * @returns {string|null} the shared folder, or null.
     */
    _requireSharedRoot() {
      // Redrawn here rather than only at init: the folder is chosen in the
      // panel or the Sync pane while this one is on screen.
      this._describeFolder();
      return this._sharedRoot();
    },

    /**
     * Shows one path of the device flow, at one step, the question that
     * chooses between them, or neither.
     *
     * A path with a live code or a claim still looking stays where it is, so
     * nothing in flight is hidden from the person who started it.
     *
     * @param {string} path `"offer"`, `"claim"`, `"choose"` for the question,
     *   or `""` for the Your devices card alone.
     * @param {number} [step] Which step of the path to show.
     */
    choosePath(path, step = 1) {
      if (!this._els) {
        return;
      }
      const current = this._els.devices.dataset.path;
      if (current !== path && (this._offer || this._claims.looking)) {
        return;
      }
      const onPath = name => name === "offer" || name === "claim";
      this._els.devices.dataset.path = path;
      this._els.pairingOpen.setAttribute("aria-expanded", String(path !== ""));
      this._els.chooser.hidden = path !== "choose";
      this._els.offerSteps.hidden = path !== "offer";
      this._els.claimSteps.hidden = path !== "claim";
      if (path === "claim") {
        this._showStep(this._els.claimSteps, step, this._els.claimProgress);
        if (step === 2 && current === "claim") {
          this._els.claimCode.focus();
        }
      } else if (path === "offer") {
        this._showStep(
          this._els.offerSteps,
          this._offer ? 2 : 1,
          this._els.offerProgress
        );
      }
      if (onPath(current) && path !== current) {
        this._els.offerStatus.textContent = "";
        this._els.offerStatus.dataset.said = "";
        this._claimSays("");
      }
      if (path === "" && current) {
        this._els.pairingOpen.focus();
      } else if (path === "choose" && onPath(current)) {
        (current === "offer"
          ? this._els.pathOffer
          : this._els.pathClaim
        ).focus();
      } else if (path === "choose" && !current) {
        this._els.pathOffer.focus();
      } else if (onPath(path) && !onPath(current)) {
        (path === "offer" ? this._els.offerStart : this._els.claimNext).focus();
      }
    },

    /**
     * Shows step `step` of the steps in `container` and hides the others.
     *
     * @param {Element} container
     * @param {number} step
     * @param {Element} progress Where "Step 1 of 2" goes.
     */
    _showStep(container, step, progress) {
      const steps = container.querySelectorAll(".sval-step");
      for (const el of steps) {
        el.hidden = Number(el.dataset.step) !== step;
      }
      this._setText(progress, `Step ${step} of ${steps.length}`);
    },

    /**
     * The claim's Next: joins with this user's own key when Sval left a
     * sealed copy of it in the folder, and otherwise asks for a code.
     */
    async claimNext() {
      const result = await this.panel?.joinWithKeyInFolder().catch(() => null);
      if (result?.adopted) {
        this._claimSays(
          "Sval found your sync key in your sync folder.",
          "found-key"
        );
        return;
      }
      this.choosePath("claim", 2);
    },

    /** Shows the offer path's step for whether a code is live. */
    _showOfferStep() {
      this._showStep(
        this._els.offerSteps,
        this._offer ? 2 : 1,
        this._els.offerProgress
      );
      // Back is withheld while a code is live: going back would hide a code
      // that is still in the folder. "Cancel code" is the way out.
      this._els.offerBack.hidden = !!this._offer;
    },

    async beginOffer() {
      if (this._privateOnly) {
        return;
      }
      const root = this._requireSharedRoot();
      if (!root) {
        return;
      }

      this._els.offerStart.disabled = true;
      this._els.offerStatus.textContent = "";
      this._els.offerStatus.dataset.said = "";
      const sync = await lazy.SvalIdentity.syncKey().catch(() => null);
      if (sync?.state !== lazy.SvalIdentity.SYNC_KEY_STATES.present) {
        this._els.offerStart.disabled = false;
        this._els.offerStatus.dataset.said = "no-sync-key";
        this._els.offerStatus.textContent = SVAL_NO_SYNC_KEY;
        return;
      }
      // A pairing the user starts here replaces the one first run left
      // claiming (first-run spec §3.2).
      lazy.SvalFirstRun.stopPairing();

      let offer;
      try {
        offer = await lazy.SvalPairing.offer(root, sync.bytes, Date.now());
      } catch (err) {
        this._els.offerStart.disabled = false;
        const problem = lazy.folderProblem(err?.reason);
        this._els.offerStatus.dataset.said = `folder-${problem}`;
        this._els.offerStatus.textContent = offerFailureText(err?.reason);
        return;
      }

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
      this._els.offerStatus.textContent =
        "Your code is ready. It works for an hour.";
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
        this.withdrawOffer("That code expired. Show a new one.", "expired");
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
      this._els.offerStart.disabled = false;
      this._showOfferStep();
      this._els.offerStatus.dataset.said = "used";
      this._els.offerStatus.textContent =
        "Code used. Your devices are syncing.";
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
      this._els.offerStart.disabled = false;
      this._showOfferStep();
      this._els.offerStatus.dataset.said = said;
      this._els.offerStatus.textContent = message;

      if (offer) {
        try {
          await this._withdraw(offer);
        } catch (err) {
          this._els.offerStatus.dataset.said = "not-withdrawn";
          this._els.offerStatus.textContent =
            "Couldn't remove the code. It expires within the hour.";
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
          "Couldn't copy. The code is selected.";
        this._els.offerCode.focus();
        this._els.offerCode.select();
        return;
      }
      this._els.offerStatus.dataset.said = "copied";
      this._els.offerStatus.textContent = "Copied.";
    },

    beginClaim() {
      if (this._claims.looking || this._privateOnly) {
        return;
      }

      const code = lazy.SvalPanelModel.normalizeCode(this._els.claimCode.value);
      this._els.claimCode.setAttribute("aria-invalid", String(!code));
      if (!code) {
        this._claimSays("A code looks like K7Q4-8MTZ-3RJW.", "malformed");
        this._els.claimCode.focus();
        return;
      }

      const root = this._requireSharedRoot();
      if (!root) {
        return;
      }

      lazy.SvalFirstRun.stopPairing();
      this.choosePath("claim", 2);
      this._els.claimSubmit.disabled = true;
      this._els.claimStop.hidden = false;
      // Back is withheld while Sval is looking, so a claim in flight is never
      // hidden. "Stop" is the way out.
      this._els.claimBack.hidden = true;
      this._claimSays("Looking for the code…", "looking");
      this._claims.start(
        () => lazy.SvalPairing.claim(root, code),
        answer => this._answered(answer)
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
     */
    _answered(answer) {
      switch (answer.status) {
        case "claimed":
          this._els.claimStop.hidden = true;
          this._adopt(answer);
          return;
        case "no-match":
          this._els.claimCode.setAttribute("aria-invalid", "true");
          this._stopLooking(
            "That code didn't work. Check it, or show a new one on the other " +
              "device.",
            "no-match"
          );
          return;
        case "failed":
          lazy.SvalLog.warn(
            `claiming a pairing offer failed: ${lazy.SvalLog.errorName(answer.error)}`
          );
          this._stopLooking("Can't read your sync folder.", "unreadable");
          return;
      }
      this._claimSays(
        "No code yet. Check that both devices use the same folder. The code " +
          "can take a few minutes to arrive.",
        "waiting"
      );
    },

    /**
     * @param {string|object} message What the status line says: a plain
     *   sentence, or a `pairingLine`.
     * @param {string} [said] The plain sentence's name, as `_claimSays`.
     */
    _stopLooking(message, said = "") {
      this._claims.stop();
      this._els.claimSubmit.disabled = false;
      this._els.claimStop.hidden = true;
      this._els.claimBack.hidden = false;
      if (typeof message === "string") {
        this._claimSays(message, said);
      } else {
        this._showResult(
          this._els.claimStatus,
          this._els.claimActions,
          message,
          {
            retry: () => this.beginClaim(),
          }
        );
        this._els.claimStatus.dataset.said = message.reason;
      }
    },

    /**
     * Writes a plain sentence on the claim's status line, taking down any
     * result line's glyph and button.
     *
     * @param {string} text
     * @param {string} [said] What the sentence says, set on the line as
     *   `data-said`.
     */
    _claimSays(text, said = "") {
      this._showResult(this._els.claimStatus, this._els.claimActions, null, {
        text,
      });
      this._els.claimStatus.dataset.said = said;
    },

    /**
     * Hands a claimed key to the panel and says how it went (messages spec
     * §7).
     *
     * @param {object} claimed `SvalPairing.claim`'s `"claimed"` result.
     */
    async _adopt(claimed) {
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
        this._stopLooking(unforeseen);
        return;
      }

      this._claimSays("Joining…", "joining");

      let result;
      try {
        result = await panel.adoptKey(claimed.keyBytes, claimed.path);
      } catch (err) {
        // `_adoptKey` answers with an outcome rather than throwing, so this is
        // the unforeseen case. The detail goes to the log.
        lazy.SvalLog.error(`adopting a key threw: ${lazy.describeError(err)}`);
        this._stopLooking(unforeseen);
        return;
      }

      this._els.claimSubmit.disabled = false;
      this._els.claimBack.hidden = false;
      const line = lazy.SvalPanelModel.pairingLine(
        result,
        lazy.AppConstants.platform
      );
      this._showResult(this._els.claimStatus, this._els.claimActions, line, {
        retry: () => this.beginClaim(),
      });
      this._els.claimStatus.dataset.outcome = result.outcome;
      this._els.claimStatus.dataset.said = line.reason;
      if (result.adopted) {
        this._els.claimCode.value = "";
      }
    },
  };

  Object.assign(window.SvalSettings, SvalPairingSettings);
}
