/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Sval's settings (spec §10.8), as categories of `about:preferences`.
 * `settings-pane.js` puts the panes into the page and calls `init` once they
 * are there. This file is the page itself: the profile's panel every pane
 * calls, `init`, which finds and wires each pane through that pane's own
 * `_init…`, and the routing to a pane and a section. Each pane's code is in a
 * `settings-*.js` file of its own, which adds its methods to `SvalSettings`;
 * `settings-ui.js` holds what they all draw with.
 *
 * The search engine has no control here: Firefox's Search category sets the
 * same default engine first run sets.
 *
 * **Nothing here owns an engine, and nothing may acquire one.** The panel owns
 * it, one per profile: two engines for one device would undo each other's
 * deletions. Anything that touches the document is a call into the panel
 * whose words come back for this page to render.
 *
 * **The panel it calls is the profile's** (spec §10.8). The engine, the
 * storage setting and the key are all per profile, so any window running Sval
 * answers for them, and which window holds this tab is something neither the
 * user chose nor session restore preserves.
 *
 * `SvalPreferences` loads this as a classic script into the preferences page,
 * whose own scripts declare globals such as `lazy`. Everything here is
 * therefore inside one block, and only `window.SvalSettings` leaves it.
 */

"use strict";

{
  const { paneName, profileWindows } = window.SvalSettingsHelpers;

  /**
   * Release candidates: on, the updater reads the beta feed, which carries
   * every candidate and every release (update-release-candidates.patch).
   */
  const RELEASE_CANDIDATES_PREF = "browser.sval.update.releaseCandidates";

  const lazy = {};

  ChromeUtils.defineESModuleGetters(lazy, {
    WEBDRIVER_COOKIES_PREF:
      "moz-src:///browser/components/sval/SvalWebDriver.sys.mjs",
    SvalPrivateJars:
      "moz-src:///browser/components/sval/SvalPrivateJars.sys.mjs",
    SvalScope: "moz-src:///browser/components/sval/SvalScope.sys.mjs",
    SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
    PAGE_RULES_PREF: "moz-src:///browser/components/sval/SvalPageRules.sys.mjs",
    BREACH_WARNINGS_PREF:
      "moz-src:///browser/components/sval/SvalProtectionButton.sys.mjs",
    HOME_FAVORITES_PREF:
      "moz-src:///browser/components/sval/SvalHomePage.sys.mjs",
    REVEAL_PREF: "moz-src:///browser/components/sval/SvalPanelReveal.sys.mjs",
    QUICK_PEEK_PREF: "moz-src:///browser/components/sval/SvalQuickPeek.sys.mjs",
    HOVER_PREVIEW_PREF:
      "moz-src:///browser/components/sval/SvalTabHoverPreview.sys.mjs",
    PINS_QUICK_PEEK_PREF:
      "moz-src:///browser/components/sval/SvalPinsModel.sys.mjs",
    SWIPE_WORKSPACES_PREF:
      "moz-src:///browser/components/sval/SvalKeys.sys.mjs",
    SvalPeek: "moz-src:///browser/components/sval/SvalPeek.sys.mjs",
    BOOKMARKLETS_PREF:
      "moz-src:///browser/components/sval/SvalFavorites.sys.mjs",
    PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  });

  /**
   * Where each named section lives: its pane, and what showing it means. A
   * call that names none lands on the Sync and devices pane's title.
   */
  const SECTIONS = {
    storage: "svalSync",
    offer: "svalSync",
    claim: "svalSync",
    change: "svalSync",
    choose: "svalSync",
    top: "svalSync",
  };

  var SvalSettings = {
    /** Set once the page is going away, so no loop outlives it. */
    _gone: false,

    /**
     * The pane and section `preferences.js` asked for before the panes'
     * markup had arrived, applied by `init`.
     */
    _pending: null,

    /** A `focusSection` asked for before the panes arrived. */
    _pendingSection: null,

    /** Whether a pane has been shown yet; the first one takes focus. */
    _shownOnce: false,

    /**
     * Logs through Sval's own logger, for `settings-pane.js`.
     *
     * @param {string} line
     */
    log(line) {
      lazy.SvalLog.warn(line);
    },

    /**
     * Sval's panel, in whichever of this profile's windows is running one.
     *
     * It owns the engine, the storage setting and adoption, all per profile,
     * so this page wants *a* panel: a tab session restore puts back into a
     * window whose panel never started, or has gone, is still a tab in a
     * profile where Sval is running.
     *
     * A panel is an answer only once it holds `_settings`, the point in
     * `init` past which everything this page reads exists, so one still
     * starting is skipped; this is re-read on every call, so the page picks up
     * a panel that starts later.
     *
     * @returns {object|null} a started `SvalPanel`, or null if no window of this
     *   profile has one.
     */
    get panel() {
      for (const win of profileWindows()) {
        if (win.SvalPanel?.settings) {
          return win.SvalPanel;
        }
      }
      return null;
    },

    /**
     * The profile's panel, waiting for one that is still starting.
     *
     * Waiting rather than refusing (spec §6.7): a code typed into a window
     * whose panel has not finished starting is not a state the user caused or
     * can act on, and the panel is moments away. `_started` resolves whether
     * startup succeeded or failed, so this returns null only when no window of
     * this profile is running Sval.
     *
     * @returns {Promise<object|null>} a started `SvalPanel`, or null.
     */
    async _startedPanel() {
      if (this.panel) {
        return this.panel;
      }
      await Promise.all(
        profileWindows()
          .map(win => win.SvalPanel?.started)
          .filter(Boolean)
      );
      return this.panel;
    },

    /**
     * Whether every window is private ("Always use private browsing mode"). Sval
     * then holds nothing on disk (private-windows spec), so storage, syncing and
     * pairing have nothing to act on, and pairing must not create a key.
     */
    get _privateOnly() {
      return lazy.PrivateBrowsingUtils.permanentPrivateBrowsing;
    },

    /**
     * Whether this page is open in a private window. A site choice made
     * there is the window's alone or is not offered, since nothing a private
     * window does may be kept (private-windows spec).
     */
    get _privateWindow() {
      return lazy.PrivateBrowsingUtils.isContentWindowPrivate(window);
    },

    /**
     * Whose site choices this page shows and edits: in a private window,
     * that window's, each being a session of its own (`SvalPrivateJars`);
     * otherwise the stored ones, null.
     *
     * @returns {number|null}
     */
    get _siteSession() {
      return lazy.SvalPrivateJars.sessionOf(
        window.browsingContext.originAttributes
      );
    },

    /**
     * Turns off storage, syncing and pairing, which have nothing to act on.
     * The Sync card's state says why (`SvalPanelModel.syncPage`).
     */
    _showPrivateOnly() {
      const section = document.querySelector('[data-sval-pane="svalSync"]');
      if (!section) {
        return;
      }
      // Disabled rather than `inert`, which would hide the card's state from
      // a screen reader too.
      for (const control of section.querySelectorAll(
        "button, sval-button, input"
      )) {
        control.disabled = true;
      }
    },

    init() {
      const byId = id => document.getElementById(id);
      // Ended as the page goes, so no observer outlives the document it
      // writes into.
      const lifetime = new lazy.SvalScope();

      this._els = {
        heading: byId("sval-settings-heading"),
      };
      this._initStorage(byId);
      this._initSyncStatus(byId, lifetime);
      this._initPairing(byId);
      this._initBlocking(byId, lifetime);
      this._initPasswords(byId);
      this._initAppearance(byId, lifetime);
      this._initKagi(byId, lifetime);
      this._initAgents(byId, lifetime);
      this._initFingerprinting(byId, lifetime);
      this._initSites(byId, lifetime);
      this._initTracking(byId, lifetime);
      this._initAdvanced(byId, lifetime);
      this._bindPrefSwitches();
      this._initSitePage(lifetime);

      if (this._privateOnly) {
        this._showPrivateOnly();
      }

      // Coming back to the tab is the moment the folder may have changed under
      // the page, and the answers kept outside prefs with it. Everything else
      // here redraws from the pref or topic observer its pane's init adds.
      window.addEventListener("focus", () => this._describeFolderState());

      // Nothing this page starts may outlive it: a claim that is still waiting
      // holds a timer, and a listener writing into a document that has gone
      // away is an error on every pass, forever.
      window.addEventListener("pagehide", () => {
        this._gone = true;
        this._claims.stop();
        this._stopCountdown();
        this._unwatchPrivacyPass?.();
        lifetime.end();
      });

      this._describeAll();
      this.choosePath(this._els.devices.dataset.path || "");
      this._sweepOffers();

      if (this._pending) {
        const { pane, section } = this._pending;
        this._pending = null;
        this.showPane(pane, section);
      }
      if (this._pendingSection) {
        const section = this._pendingSection;
        this._pendingSection = null;
        this.focusSection(section);
      }
      if (this._pendingSite) {
        const show = this._pendingSite;
        this._pendingSite = null;
        show();
      }
    },

    /** Redraws everything that reads state Sval keeps elsewhere. */
    _describeAll() {
      this._describeFolderState();
      this._describeAgents();
      this._drawClients();
      this._describeBlocking();
      this._describeTracking();
      this._describeFingerprinting();
      this._describeSites();
      this._describeAddressPins();
      this._describeDisplay();
      this._describeDeviceName();
    },

    /**
     * Redraws what no observer follows: the folder, which can change on disk
     * under the page, the sync readout beside it, and the answers kept in the
     * secret store and the panel.
     */
    _describeFolderState() {
      this._drawSyncPage();
      this._readKeyStore();
      this._describeAnswers();
    },

    /**
     * Binds each switch that is one boolean pref to it through Firefox's
     * preferences page, as its own checkboxes are: the switch shows the
     * pref's value, follows it when about:config or sync moves it, and
     * writes it when pressed (`Preferences`, `Preference.setElementValue`).
     * The pref's default is the one Sval ships, read from the default branch.
     * An `inverted` switch is on while its pref is false.
     */
    _bindPrefSwitches() {
      const { Preferences } = window;
      for (const [id, pref, inverted = false] of [
        ["sval-home-favorites", lazy.HOME_FAVORITES_PREF],
        ["sval-panel-reveal", lazy.REVEAL_PREF],
        ["sval-release-candidates", RELEASE_CANDIDATES_PREF],
        ["sval-bookmarklets", lazy.BOOKMARKLETS_PREF],
        ["sval-page-rules", lazy.PAGE_RULES_PREF],
        ["sval-breach-warnings", lazy.BREACH_WARNINGS_PREF],
        [
          "sval-private-notifications",
          "dom.webnotifications.privateBrowsing.enabled",
        ],
        ["sval-private-delete-downloads", "browser.download.deletePrivate"],
        ["sval-peek", lazy.SvalPeek.ENABLED_PREF],
        ["sval-quick-peek", lazy.QUICK_PEEK_PREF],
        ["sval-pins-quick-peek", lazy.PINS_QUICK_PEEK_PREF],
        ["sval-switch-to-new-tabs", "browser.tabs.loadInBackground", true],
        ["sval-ctrl-tab-recent", "browser.ctrlTab.sortByRecentlyUsed"],
        ["sval-hover-preview", lazy.HOVER_PREVIEW_PREF],
        ["sval-swipe-workspaces", lazy.SWIPE_WORKSPACES_PREF],
        ["sval-webdriver-cookies", lazy.WEBDRIVER_COOKIES_PREF],
      ]) {
        document.getElementById(id).setAttribute("preference", pref);
        (
          Preferences.get(pref) ??
          Preferences.add({ id: pref, type: "bool", inverted })
        ).updateElements();
      }
      // The Downloads panel of a private window asks this once, until the
      // user has answered here or there (`PrivateDownloadsSubview.choose`).
      document
        .getElementById("sval-private-delete-downloads")
        .addEventListener("change", () =>
          Services.prefs.setBoolPref(
            "browser.download.deletePrivate.chosen",
            true
          )
        );
    },

    /**
     * `preferences.js` showed one of Sval's panes, with the section the URL's
     * hash named after a dash (`#svalSync-offer`), if any. The first pane the
     * page shows takes focus on its title, so opening settings lands on the
     * page rather than in a control; a named section puts the caret where it
     * names.
     *
     * @param {string} pane A friendly pane name, such as `svalSync`, or
     *   `privacy` for Sval's sections there.
     * @param {?string} section `"offer"`, `"claim"`, `"storage"`, `"change"`
     *   or `"choose"` (which run the Sync card's Change… or Choose folder…),
     *   `"top"`,
     *   `"sites"`, `"tracking"`, `"secureDns"`, a site's page
     *   (`site?host=…`), an extension's (`extension?id=…`), an agent's
     *   (`agent?id=…`) or nothing.
     * @returns {boolean} true, so `preferences.js` does not spotlight a
     *   subcategory Sval does not mark.
     */
    showPane(pane, section) {
      if (!this._els) {
        this._pending = { pane, section };
        return true;
      }
      const first = !this._shownOnce;
      this._shownOnce = true;
      if (pane === "svalSites" && section?.startsWith("site?")) {
        this._openSitePage(section);
      } else if (pane === "svalExtensions" && section) {
        window.SvalExtensionsSettings.showSubcategory(section);
      } else if (pane === "svalAgents" && section) {
        this._openAgentPage(section);
      } else if (section === "sites") {
        this.showSites();
      } else if (section === "tracking") {
        const card = document.getElementById("sval-tracking-more");
        this._openAdvanced(card);
        card.scrollIntoView();
      } else if (section === "secureDns") {
        this.showSecureDns().catch(err =>
          lazy.SvalLog.warn(
            `showing Secure DNS failed: ${lazy.SvalLog.errorName(err)}`
          )
        );
      } else if (section === "offer" && this._page?.addDevice) {
        this._els.pairingOpen.focus();
      } else if (
        section === "claim" &&
        this._page?.primary?.command === "enterCode"
      ) {
        this.runSyncCommand("enterCode");
      } else if (section === "change" && this._page?.location) {
        // The footer's Change… and Choose another folder… do what the Sync
        // card's do, in every state with a folder chosen.
        this.runSyncCommand("changeLocation");
      } else if (
        section === "choose" &&
        this._page?.primary?.command === "chooseInUse"
      ) {
        this.runSyncCommand("chooseInUse");
      } else if (
        section === "storage" ||
        section === "offer" ||
        section === "claim" ||
        section === "change" ||
        section === "choose"
      ) {
        // The state's own way forward, else the folder's.
        (
          this._els.syncButtons.querySelector("sval-button") ??
          (this._els.storageChange.hidden
            ? this._els.storageChoose
            : this._els.storageChange)
        ).focus();
      } else if (section === "top" || first) {
        document
          .querySelector(`[data-sval-pane="${pane}"] .sval-pane-title`)
          ?.focus();
      }
      return true;
    },

    /**
     * Shows the pane that holds `which` and puts the caret there. The panel
     * calls this on a settings tab that is already open.
     *
     * @param {string} [which] `"claim"`, `"offer"`, `"storage"`, or anything
     *   else, or nothing, for the Sync pane's title.
     */
    focusSection(which) {
      const section = which in SECTIONS ? which : "top";
      // `SvalPreferences` loads this script before the page's own, so a tab can
      // be asked for a section before `init_all` has made `gotoPref` usable.
      // The panes arrive after it, so until they do the request waits.
      if (!this._els) {
        this._pendingSection = section;
        return;
      }
      window.gotoPref(`${paneName(SECTIONS[section])}-${section}`);
    },

    /** Redraws the controls here that hold first run's answers. */
    _describeAnswers() {
      this._describePasswordManager();
      this._describePanelSide();
      this._describeKagi().catch(err =>
        lazy.SvalLog.warn(
          `reading the Kagi token failed: ${lazy.SvalLog.errorName(err)}`
        )
      );
    },

    /**
     * Shows the Secure DNS card with the caret on its choice, where the
     * protection button's panel sends the user.
     */
    async showSecureDns() {
      const group = document.querySelector(
        `setting-group[groupid="${window.SvalSecureDnsSettings.GROUP_ID}"]`
      );
      if (!group) {
        return;
      }
      // Firefox's setting-group draws its controls after it is configured.
      await group.updateComplete;
      group.scrollIntoView();
      group
        .querySelector("#setting-control-svalSecureDnsChoice moz-radio-group")
        ?.focus();
    },
  };

  window.SvalSettings = SvalSettings;
}
