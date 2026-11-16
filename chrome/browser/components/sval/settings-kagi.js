/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The Kagi card in Search and Launcher. It shows while Kagi is the default
 * engine or private windows' engine, and while a Session Link is saved, so
 * the link can still be cleared under another engine. Signed out, it offers
 * the sign-in first run offers (`SvalPanel._signInToKagi`), since first run
 * may not be the only route to it (spec §10.8). Signed in, it says how
 * private windows sign in, and offers the Session Link field when the plan
 * lacks Privacy Pass. The link is saved and cleared through `SvalKagi`.
 *
 * `SvalPreferences` loads this as a classic script after `settings.js`; it
 * adds its methods to `SvalSettings`.
 */

"use strict";

{
  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
    SvalKagi: "moz-src:///browser/components/sval/SvalKagi.sys.mjs",
    SvalKagiPrivacyPass:
      "moz-src:///browser/components/sval/SvalKagiPrivacyPass.sys.mjs",
    SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
    SvalSecretStore:
      "moz-src:///browser/components/sval/SvalSecretStore.sys.mjs",
  });

  /** `SearchUtils.MODIFIED_TYPE`'s changes of either default engine. */
  const ENGINE_CHANGES = new Set(["engine-default", "engine-default-private"]);

  const SvalKagiSettings = {
    /** Whether Kagi is the default engine or private windows' engine. */
    _kagiIsEngine: false,

    /** Whether a Session Link is saved, as last read. */
    _kagiLinkStored: false,

    /** Whether a normal window is signed in to Kagi, as last drawn. */
    _kagiSignedIn: false,

    /**
     * Finds and wires the Kagi card, and follows the engine and the sign-in.
     *
     * @param {Function} byId Finds one of the page's elements by id.
     * @param {Function} followTopic Observes a topic until the page goes.
     */
    _initKagi(byId, followTopic) {
      Object.assign(this._els, {
        kagiCard: byId("sval-kagi-card"),
        kagiAccount: byId("sval-kagi-account"),
        kagiSignIn: byId("sval-kagi-sign-in"),
        kagiSessionLink: byId("sval-kagi-session-link"),
        kagiForm: byId("sval-kagi-form"),
        kagiLink: byId("sval-kagi-link"),
        kagiSave: byId("sval-kagi-save"),
        kagiClear: byId("sval-kagi-clear"),
        kagiStatus: byId("sval-kagi-status"),
        kagiPrivacyPass: byId("sval-kagi-privacy-pass"),
        kagiCheckAgain: byId("sval-kagi-check-again"),
      });
      this._els.kagiForm.addEventListener("submit", event => {
        event.preventDefault();
        this.saveKagiToken();
      });
      this._els.kagiCheckAgain.addEventListener("click", () =>
        this.checkKagiAgain()
      );
      this._els.kagiClear.addEventListener("click", () =>
        this.clearKagiToken()
      );
      this._els.kagiSignIn.addEventListener("click", () => this.signInToKagi());
      followTopic(
        "browser-search-engine-modified",
        (_subject, _topic, data) => {
          if (ENGINE_CHANGES.has(data)) {
            this._readKagiEngine();
          }
        }
      );
      // Kagi's sign-in and sign-out are its `kagi_session` cookie, which
      // `SvalKagi.signedIn` reads.
      followTopic("cookie-changed", () => {
        if (lazy.SvalKagi.signedIn() !== this._kagiSignedIn) {
          this._drawKagi();
        }
      });
      this._unwatchPrivacyPass = lazy.SvalKagiPrivacyPass.addListener(() => {
        if (!this._gone) {
          this._drawKagi();
        }
      });
      this._readKagiEngine();
    },

    /** Learns whether Kagi is either default engine, and redraws. */
    async _readKagiEngine() {
      try {
        await lazy.SearchService.init();
      } catch (err) {
        lazy.SvalLog.warn(
          `reading the search engine failed: ${lazy.SvalLog.errorName(err)}`
        );
        return;
      }
      if (this._gone) {
        return;
      }
      // Without a separate private engine, `defaultPrivateEngine` is the
      // default engine (`SearchService._getEngineDefault`).
      this._kagiIsEngine = [
        lazy.SearchService.defaultEngine,
        lazy.SearchService.defaultPrivateEngine,
      ].some(engine => engine?.id === lazy.SvalKagi.ENGINE_ID);
      this._drawKagi();
    },

    /**
     * Reads whether a Session Link is stored, and redraws. The words never
     * carry the token, and the field is never filled from it: the page
     * learns only that one exists.
     */
    async _describeKagi() {
      const stored = (await lazy.SvalKagi.token()) !== null;
      if (this._gone) {
        return;
      }
      this._kagiLinkStored = stored;
      this._els.kagiStatus.dataset.state = stored ? "saved" : "not-set";
      this._els.kagiStatus.textContent = stored ? "Saved." : "Not set.";
      this._drawKagi();
    },

    /**
     * Draws the card from the engine, the sign-in, the stored link and the
     * Privacy Pass stock.
     */
    _drawKagi() {
      const els = this._els;
      const signedIn = lazy.SvalKagi.signedIn();
      const linkStored = this._kagiLinkStored;
      this._kagiSignedIn = signedIn;
      els.kagiCard.hidden = !this._kagiIsEngine && !linkStored;
      els.kagiAccount.dataset.state = signedIn ? "signed-in" : "";
      els.kagiAccount.textContent = signedIn ? "Signed in to Kagi." : "";
      els.kagiAccount.hidden = !signedIn;
      els.kagiSignIn.hidden = signedIn;

      const state = lazy.SvalKagiPrivacyPass.state();
      const said = signedIn || linkStored ? this._privateLine(state) : "";
      els.kagiPrivacyPass.dataset.state = said ? state : "";
      els.kagiPrivacyPass.textContent = said;
      els.kagiPrivacyPass.hidden = !said;
      els.kagiCheckAgain.hidden = !signedIn || state !== "unsupported";
      els.kagiSessionLink.hidden =
        !linkStored &&
        !(signedIn && (state === "unsupported" || state === "unavailable"));
    },

    /**
     * Says how private windows sign in to Kagi: with Privacy Pass, with the
     * Session Link, or not yet, and why.
     *
     * @param {string} state `SvalKagiPrivacyPass.state()`.
     * @returns {string}
     */
    _privateLine(state) {
      const privacyPass = lazy.SvalKagiPrivacyPass;
      const linkStored = this._kagiLinkStored;
      switch (state) {
        case "ready": {
          const count = privacyPass.count();
          return `Private windows: signed in with Privacy Pass. ${count} ${
            count === 1 ? "search" : "searches"
          } left.`;
        }
        case "out": {
          const date = new Date(privacyPass.outUntil()).toLocaleDateString(
            undefined,
            { month: "long", day: "numeric" }
          );
          return `Private windows: you've used this month's Privacy Pass searches. They reset on ${date}.`;
        }
        case "unsupported":
          return linkStored
            ? "Your Kagi plan doesn't include Privacy Pass, so private windows use your Session Link."
            : "Your Kagi plan doesn't include Privacy Pass, so private windows are signed out.";
        case "signedOut":
          return linkStored
            ? "Private windows use your Session Link."
            : "Private windows sign in once Kagi sends Privacy Pass searches.";
      }
      return "";
    },

    /**
     * Opens Kagi's sign-in in a window of its own, as first run does. The
     * card follows the sign-in through Kagi's cookie, and once more when the
     * window closes.
     */
    async signInToKagi() {
      const panel = this.panel;
      if (!panel) {
        lazy.SvalLog.warn("Kagi's sign-in did not open: no panel is running");
        return;
      }
      this._els.kagiSignIn.disabled = true;
      this._els.kagiAccount.dataset.state = "opened";
      this._els.kagiAccount.textContent =
        "Sign in to Kagi in the window that opened.";
      this._els.kagiAccount.hidden = false;
      try {
        await panel._signInToKagi(lazy.SvalKagi.SIGNIN_URL, {
          stillAsked: () => !this._gone,
        });
      } catch (err) {
        lazy.SvalLog.warn(
          `Kagi's sign-in did not open: ${lazy.SvalLog.errorName(err)}`
        );
      }
      if (this._gone) {
        return;
      }
      this._els.kagiSignIn.disabled = false;
      this._drawKagi();
    },

    /** Asks Kagi again whether the plan includes Privacy Pass. */
    async checkKagiAgain() {
      this._els.kagiCheckAgain.disabled = true;
      try {
        await lazy.SvalKagiPrivacyPass.checkAgain();
      } catch (err) {
        lazy.SvalLog.warn(
          `checking Kagi Privacy Pass failed: ${lazy.SvalLog.errorName(err)}`
        );
      }
      this._els.kagiCheckAgain.disabled = false;
      if (!this._gone) {
        this._drawKagi();
      }
    },

    /**
     * Stores what the user typed or pasted into the field. `setToken` accepts a
     * raw token or a Session Link and refuses anything else, so this page does
     * not judge the text itself; the field is emptied on success so the token
     * does not stay on screen.
     */
    async saveKagiToken() {
      const text = this._els.kagiLink.value;
      if (!text.trim()) {
        return;
      }
      this._els.kagiSave.disabled = true;
      let refused = false;
      // Saving is the user's step, so a store refused earlier is asked again.
      lazy.SvalSecretStore.retry();
      try {
        await lazy.SvalKagi.setToken(text);
        // The header is added only while Kagi's request observer is registered,
        // and nothing else starts it when Kagi is not the engine.
        lazy.SvalKagi.start();
        this._els.kagiLink.value = "";
      } catch {
        // No detail is logged or shown beyond the fact: the input is a
        // credential, and `setToken`'s errors are written to never carry it.
        refused = true;
      }
      this._els.kagiSave.disabled = false;
      this._els.kagiLink.setAttribute("aria-invalid", String(refused));
      if (refused) {
        this._els.kagiStatus.dataset.state = "refused";
        this._els.kagiStatus.textContent =
          "That's not a Kagi Session Link. Copy it again from Kagi.";
        this._els.kagiLink.focus();
        return;
      }
      await this._describeKagi();
    },

    async clearKagiToken() {
      this._els.kagiClear.disabled = true;
      lazy.SvalSecretStore.retry();
      try {
        await lazy.SvalKagi.clearToken();
      } catch (err) {
        lazy.SvalLog.warn(
          `clearing the Kagi token failed: ${lazy.SvalLog.errorName(err)}`
        );
      }
      this._els.kagiClear.disabled = false;
      this._els.kagiLink.value = "";
      await this._describeKagi();
    },
  };

  Object.assign(window.SvalSettings, SvalKagiSettings);
}
