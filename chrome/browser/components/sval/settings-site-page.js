/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * A site's page in Settings › Sites (site page spec): everything Sval keeps
 * for one site, at `about:preferences#svalSites-site?host=<site>`. The host is
 * a site as `siteOfEntry` cuts one; any other host shows the Sites list
 * instead. `&scope=<host>` shows the choices of one host under the site
 * (host-scoped rules spec §5): the cards above `_siteCardWhole` follow it, and
 * the rest stay the site's.
 *
 * `gotoPref` splits the hash at its first `-`, hands `site?host=…` to the
 * Sites category's `handleSubcategory`, and then rewrites the hash to
 * `#svalSites`. The page writes its own address back after that, so a
 * reload comes back to it: a new history entry when the user came from
 * inside Settings, the same entry when the address brought them. Leaving by
 * the browser's Back is a `hashchange` that `gotoPref` ignores, since the
 * category does not change, so the page follows `hashchange` itself.
 *
 * The page's cards are drawn by the methods `SITE_CARDS` names, in order,
 * each from the stores the Sites card and the site menu write.
 *
 * `SvalPreferences` loads this as a classic script after `settings.js`; it
 * adds its methods to `SvalSettings`, whose helpers and view state it shares.
 */

"use strict";

{
  const { counted } = window.SvalSettingsHelpers;
  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    DownloadUtils: "resource://gre/modules/DownloadUtils.sys.mjs",
    OriginControls: "resource://gre/modules/ExtensionPermissions.sys.mjs",
    SvalExtensionSites:
      "moz-src:///browser/components/sval/SvalExtensionSites.sys.mjs",
    PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
    SvalForgetSite: "moz-src:///browser/components/sval/SvalForgetSite.sys.mjs",
    SvalJavascript: "moz-src:///browser/components/sval/SvalJavascript.sys.mjs",
    APPLIED_TOPIC: "moz-src:///browser/components/sval/SvalJavascript.sys.mjs",
    SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
    SvalSiteData: "moz-src:///browser/components/sval/SvalSiteData.sys.mjs",
    SvalSiteProtections:
      "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs",
    MEDIA_CHOICES:
      "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs",
    MEDIA_DEFAULT_PREF:
      "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs",
    SITE_BRANCH:
      "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs",
    BLOCKING_TOPIC: "moz-src:///browser/components/sval/SvalBlocking.sys.mjs",
    siteOfEntry: "moz-src:///browser/components/sval/SvalSite.sys.mjs",
    siteOrigins: "moz-src:///browser/components/sval/SvalSite.sys.mjs",
    siteForURI: "moz-src:///browser/components/sval/SvalSite.sys.mjs",
    SvalBlocking: "moz-src:///browser/components/sval/SvalBlocking.sys.mjs",
    linesForScope:
      "moz-src:///browser/components/sval/SvalElementRules.sys.mjs",
    scopesInFilters:
      "moz-src:///browser/components/sval/SvalElementRules.sys.mjs",
    exceptionsInFilters:
      "moz-src:///browser/components/sval/SvalElementRules.sys.mjs",
    scopeOfHost: "moz-src:///browser/components/sval/SvalSite.sys.mjs",
    SitePermissions: "resource:///modules/SitePermissions.sys.mjs",
    permissionsFor:
      "moz-src:///browser/components/sval/SvalSitePermissionList.sys.mjs",
    setPermission:
      "moz-src:///browser/components/sval/SvalSitePermissionList.sys.mjs",
    clearPermission:
      "moz-src:///browser/components/sval/SvalSitePermissionList.sys.mjs",
    permissionWords:
      "moz-src:///browser/components/sval/SvalSitePermissionList.sys.mjs",
    permissionLabel:
      "moz-src:///browser/components/sval/SvalSitePermissionList.sys.mjs",
    sitesWithPermissions:
      "moz-src:///browser/components/sval/SvalSitePermissionList.sys.mjs",
    PERMISSION_ICONS:
      "moz-src:///browser/components/sval/SvalSitePermissionList.sys.mjs",
  });
  // The module exports its branch as `SITE_BRANCH`, a name the stores
  // above export too.
  ChromeUtils.defineLazyGetter(
    lazy,
    "EXTENSION_SITE_BRANCH",
    () =>
      ChromeUtils.importESModule(
        "moz-src:///browser/components/sval/SvalExtensionSites.sys.mjs"
      ).SITE_BRANCH
  );

  const CATEGORY = "svalSites";

  /** The subcategory `gotoPref` hands over for a site's page. */
  const SUBCATEGORY = "site?";

  /**
   * The cards, top to bottom, each a method returning its card or null. Those
   * above `_siteCardWhole`'s heading follow the scope; those below it are the
   * whole site's (decision 1980).
   */
  const SITE_CARDS = [
    "_siteCardProtections",
    "_siteCardJavascript",
    "_siteCardHidden",
    "_siteCardExtensions",
    "_siteCardWhole",
    "_siteCardPermissions",
    "_siteCardData",
    "_siteCardForget",
  ];

  /** The "Choices for" select's value for Add a host. */
  const ADD_HOST = "+add-host";

  /** The topic the permission manager notifies of every change. */
  const PERM_CHANGED = "perm-changed";

  /** The JavaScript card's choices, as `SvalJavascript.rules()` holds them. */
  const JAVASCRIPT_CHOICES = [
    ["", "Default"],
    ["allow", "Allowed"],
    ["block", "Blocked"],
  ];

  /**
   * @param {string} site
   * @param {object} [options]
   * @param {string} [options.section]
   * @param {?string} [options.scope] A host under the site.
   * @returns {string} The subcategory that shows the site's page.
   */
  const subcategoryOf = (site, { section, scope } = {}) =>
    `${SUBCATEGORY}${new URLSearchParams({
      host: site,
      ...(scope ? { scope } : {}),
      ...(section ? { section } : {}),
    })}`;

  /**
   * @param {string} hash An address's hash, with its `#`.
   * @returns {boolean} Whether it is a site page's.
   */
  const isSiteHash = hash => hash.startsWith(`#${CATEGORY}-${SUBCATEGORY}`);

  /**
   * @param {string[]} words
   * @returns {string} The words as a list: "A", "A and B", "A, B, and C".
   */
  const listed = words =>
    words.length < 3
      ? words.join(" and ")
      : `${words.slice(0, -1).join(", ")}, and ${words.at(-1)}`;

  /**
   * @param {number} bytes
   * @returns {string} The size as Firefox's Manage Data dialog writes it.
   */
  const sizeOf = bytes => lazy.DownloadUtils.convertByteUnits(bytes).join(" ");

  /** What a workspace with no name reads as, as the panel draws it. */
  const UNTITLED = "Untitled Workspace";

  /** What 8a and a failed Forget call each part `SvalForgetSite` clears. */
  const FORGET_LABELS = {
    choices: "Settings for this site",
    exceptions: "Fingerprinting exceptions",
    hiddenLines: "Removed-element rules",
    favorites: "Favorites and pins",
    history: "History",
    downloads: "Downloads",
    data: "Cookies and site data",
    caches: "Caches",
    permissions: "Permissions",
    certExceptions: "Certificate exceptions",
  };

  /** The parts Forget removes from every device, through sync. */
  const SYNCED_PARTS = new Set([
    "choices",
    "exceptions",
    "hiddenLines",
    "favorites",
  ]);

  /** Why a part was not forgotten: `SvalForgetSite` puts every failure down to the disk. */
  const FORGET_REASON = "Sval couldn't write to the disk.";

  /** 8a's figure for a part still being counted. */
  const FORGET_COUNTING = "Counting…";

  /** How a failed Forget's note counts its parts. */
  const NUMBER_WORDS = [
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
  ];

  /** Why a jar did not clear: the only failure `SvalSiteData` reports. */
  const NOT_CLEARED = "Not cleared. Sval couldn't write to the disk.";

  const SvalSitePage = {
    /**
     * The page's view: the site it shows, or null; the host under it whose
     * choices it shows, or null for the site's; the Add a host field's text
     * while it is open; whether the site holds
     * anything Forget would clear (null until counted); the site whose icon
     * `icon` is; whether its fingerprinting exceptions are open; a failed
     * Forget, and whether stored data is still being read.
     */
    _sitePage: {
      site: null,
      scope: null,
      addingHost: null,
      held: null,
      icon: null,
      iconFor: null,
      exceptionsOpen: false,
      failed: null,
      loading: false,
      slow: false,
      failedJars: new Set(),
    },

    /** How long stored data reads before the card says it is slow. */
    _siteDataSlowMs: 10_000,

    /**
     * The rows whose Clear is running, by site and key, which ignore a second
     * press.
     */
    _siteDataClearing: new Set(),

    /** The timer that says stored data is slow to read, while it runs. */
    _siteDataTimer: null,

    /**
     * How long the Sites card's search waits after a keystroke before it
     * reads stored data again. Each read scans every origin's quota usage
     * (`SiteDataManager.updateSites`), so a query being typed reads once as
     * it begins and once when the typing pauses.
     */
    _siteSearchReadMs: 300,

    /** The timer for the search's next read, while one waits. */
    _siteSearchTimer: null,

    /** The reads of stored data the page asked for that have not ended. */
    _siteDataReading: 0,

    /**
     * The reads of stored data the page asked for that have ended, which
     * dates a count: one begun before the last read ended may predate its
     * answer.
     */
    _siteDataReads: 0,

    /**
     * The address the page was asked for from, by `showSite`, until the
     * request arrives; null when the address itself asked.
     */
    _siteFrom: null,

    /** A `showSite` asked for before the panes arrived, which `init` runs. */
    _pendingSite: null,

    /** Counts begun, so an earlier one answering later is dropped. */
    _siteCounts: 0,

    /** Whether a Forget or its Try again is running. */
    _siteForgetting: false,

    /**
     * The Sites card's search results in the order shown, and the query they
     * answer, so results found later go after them.
     */
    _siteResultsShown: { q: "", sites: [] },

    /**
     * Wires the page's own controls and follows what its cards read.
     *
     * @param {Function} followPref As `init`'s, removed as the page goes.
     * @param {Function} followTopic As `init`'s.
     */
    _initSitePage(followPref, followTopic) {
      const byId = id => document.getElementById(id);
      this._siteEls = {
        page: byId("sval-site-page"),
        pane: byId("sval-site-page").closest("[data-sval-pane]"),
        back: byId("sval-site-back"),
        crumbs: byId("sval-site-crumbs"),
        icon: byId("sval-site-icon"),
        title: byId("sval-site-title"),
        nothing: byId("sval-site-nothing"),
        note: byId("sval-site-note"),
        alert: byId("sval-site-alert"),
        cards: byId("sval-site-cards"),
        status: byId("sval-site-status"),
        scope: byId("sval-site-scope"),
        more: byId("sval-site-more"),
        moreMenu: byId("sval-site-more-menu"),
      };
      this._siteEls.more.addEventListener("click", event =>
        this._siteEls.moreMenu.toggle(event)
      );
      byId("sval-site-add-host").addEventListener("click", () =>
        this._openAddHost()
      );
      this._siteEls.back.addEventListener("click", () => this._backToSites());
      this._siteEls.crumbs.addEventListener("click", event => {
        if (event.target.closest("a")) {
          event.preventDefault();
          this._backToSites();
        }
      });
      // The address as it is now: `settings-pane.js` rewrites an old site
      // page's address before this runs, and the page may have opened since.
      window.addEventListener("hashchange", () => {
        if (this._sitePage.site && !isSiteHash(location.hash)) {
          const left = this._leaveSitePage();
          if (location.hash === `#${CATEGORY}`) {
            this._showSitesCard(left);
          }
        }
      });
      // Any category shown, or this one with no site, ends the page.
      document.addEventListener("paneshown", event => {
        if (!event.detail.subcategory?.startsWith(SUBCATEGORY)) {
          this._leaveSitePage();
        }
      });

      // The Sites button in the nav, pressed while the page shows,
      // asks for the category already current, which `gotoPref` ignores.
      document
        .getElementById(`category-${CATEGORY}`)
        ?.addEventListener("change-view", () => {
          if (this._sitePage.site) {
            this._showSitesCard(this._leaveSitePage());
          }
        });

      const redraw = () => this._drawSitePage();
      for (const name of [
        lazy.SITE_BRANCH,
        lazy.MEDIA_DEFAULT_PREF,
        ...lazy.SvalJavascript.PREFS,
      ]) {
        followPref(name, redraw);
      }
      followTopic(lazy.SvalSiteProtections.PRIVATE_TOPIC, redraw);
      // What the site holds is counted from the stores once they have taken
      // a change: the choices and JavaScript rules from what each module
      // applied, which libpref's observers can reach after this page's.
      const count = () => {
        if (this._sitePage.site) {
          this._countSite(this._sitePage.site);
        }
      };
      const recount = () => {
        this._drawSitePage();
        count();
      };
      followTopic(lazy.SvalSiteProtections.APPLIED_TOPIC, recount);
      followTopic(lazy.APPLIED_TOPIC, recount);
      followTopic(lazy.BLOCKING_TOPIC, recount);
      // Of the cards, only the data card reads stored data, and what the
      // site holds counts it.
      followTopic(lazy.SvalSiteData.TOPIC, () => {
        this._stopSiteDataWait();
        this._redrawSiteCard("data");
        count();
        this._redrawSiteResults();
      });
      const extensionSites = () => {
        this._redrawSiteCard("extensions");
        this._drawSiteScope();
      };
      Services.prefs.addObserver(lazy.EXTENSION_SITE_BRANCH, extensionSites);
      window.addEventListener("pagehide", () => {
        Services.prefs.removeObserver(
          lazy.EXTENSION_SITE_BRANCH,
          extensionSites
        );
        this._stopSiteDataWait();
        clearTimeout(this._siteSearchTimer);
        this._siteSearchTimer = null;
      });
      // A permission change elsewhere would close a select the person has
      // open, so only the site's own, or the whole list cleared, redraws.
      followTopic(PERM_CHANGED, (subject, topic, data) => {
        if (data === "cleared" || this._isSitePermission(subject)) {
          recount();
        }
        if (data === "cleared" || this._isSearchedPermission(subject)) {
          this._redrawSiteResults();
        }
      });
    },

    /**
     * @param {?nsISupports} subject A `perm-changed` notification's.
     * @returns {boolean} Whether it is a permission of the page's site.
     */
    _isSitePermission(subject) {
      const site = this._sitePage.site;
      if (!site || !subject) {
        return false;
      }
      const perm = subject.QueryInterface(Ci.nsIPermission);
      return lazy.siteForURI(perm.principal.URI) === site;
    },

    /**
     * @param {?nsISupports} subject A `perm-changed` notification's.
     * @returns {boolean} Whether its site matches the Sites card's search.
     */
    _isSearchedPermission(subject) {
      const q = this._sitesView.q.trim().toLowerCase();
      if (!q || !subject) {
        return false;
      }
      const perm = subject.QueryInterface(Ci.nsIPermission);
      return !!lazy.siteForURI(perm.principal.URI)?.includes(q);
    },

    /**
     * The Sites list's search results for the sites it has no row for: those
     * holding stored data whose name holds the query, after the list (site
     * page spec §3). A site holding a permission has a row. Shown only with
     * every kind of site in the filter, since the other kinds are choices
     * these sites have none of.
     *
     * @param {Map<string, object>} rules The list's sites.
     */
    _placeSiteResults(rules) {
      const body = this._els.sitesBody;
      body.querySelector(".sval-sites-results")?.remove();
      const results = this._siteResults(rules);
      const resultCount = this._siteResultsShown.sites.length;
      const nomatch = body.querySelector(".sval-agent-nomatch");
      if (nomatch) {
        nomatch.hidden = !!resultCount;
      }
      if (results) {
        body.querySelector(".sval-sites-list, .sval-empty").after(results);
      }

      // How many rows match, said only while the list is narrowed.
      const view = this._sitesView;
      let found = "";
      if (rules.size && (view.q.trim() || view.filt !== "all")) {
        found = `${this._siteListMatches} of ${counted(this._siteListTotal, "site")}`;
      }
      this._say(this._els.sitesFound, found);
    },

    /** Redraws the Sites card's search results, when a search is on. */
    _redrawSiteResults() {
      if (!this._els || !this._sitesView.q.trim()) {
        return;
      }
      this._keepFocus(
        this._els.sitesBody.closest(".sval-card"),
        () => this._placeSiteResults(this._siteRules()),
        "sites-search"
      );
    },

    /**
     * @param {Map<string, object>} rules
     * @returns {?Element} The results, or null when there are none to show.
     */
    _siteResults(rules) {
      const view = this._sitesView;
      const q = view.q.trim().toLowerCase();
      if (!q || view.filt !== "all") {
        this._siteResultsShown = { q: "", sites: [] };
        return null;
      }
      const data = lazy.SvalSiteData;
      if (this._siteResultsShown.q !== q) {
        this._readSiteDataForSearch();
      }
      const candidates = new Set(lazy.sitesWithPermissions());
      if (data.ready) {
        for (const site of data.sitesWithData()) {
          candidates.add(site);
        }
      }
      const summaries = new Map();
      for (const site of candidates) {
        if (site.includes(q) && !rules.has(site)) {
          const summary = this._siteSummary(site);
          if (summary) {
            summaries.set(site, summary);
          }
        }
      }
      const before =
        this._siteResultsShown.q === q ? this._siteResultsShown.sites : [];
      const kept = before.filter(site => summaries.has(site));
      const sites = [
        ...kept,
        ...[...summaries.keys()].filter(site => !kept.includes(site)).sort(),
      ];
      this._siteResultsShown = { q, sites };
      const searching = !data.ready;
      if (!sites.length && !searching) {
        return null;
      }

      const list = this._el(
        "ul",
        { className: "sval-sites-results-list" },
        ...sites.map(site =>
          this._el(
            "li",
            { className: "sval-sites-result" },
            this._siteLink(site, `site-result:${site}`),
            this._el(
              "span",
              { className: "sval-sites-result-sub" },
              summaries.get(site)
            )
          )
        )
      );
      const results = this._el(
        "div",
        { className: "sval-sites-results" },
        this._el(
          "h3",
          { className: "sval-sites-results-head" },
          "Only stored data"
        ),
        list
      );
      if (searching) {
        results.append(
          this._el(
            "p",
            { className: "sval-sites-results-wait", role: "status" },
            this._el("span", {
              className: "sval-site-spinner",
              ariaHidden: "true",
            }),
            "Still searching stored data…"
          )
        );
      }
      return results;
    },

    /**
     * @param {string} site
     * @returns {?string} What the site holds, in a phrase: its first
     *   permission away from its default, else its stored data once read.
     */
    _siteSummary(site) {
      const SP = lazy.SitePermissions;
      for (const row of lazy.permissionsFor(site)) {
        if (row.state === SP.getDefault(row.id)) {
          continue;
        }
        const state = SP.getCurrentStateLabel(row.state, row.id);
        if (state) {
          return `${SP.getPermissionLabel(row.id)} ${state.toLowerCase()}`;
        }
      }
      if (!lazy.SvalSiteData.ready) {
        return null;
      }
      const jars = lazy.SvalSiteData.jarsFor(site, this._siteNodes());
      if (!jars.length) {
        return null;
      }
      const total = jars.reduce((sum, jar) => sum + jar.usage, 0);
      return total ? `${sizeOf(total)} stored` : "Cookies only";
    },

    /**
     * Shows a site's page from inside Settings, as a new history entry.
     *
     * @param {string} site
     * @param {object} [options]
     * @param {"hidden"} [options.section] The card to scroll to, if the page
     *   has it.
     * @param {string} [options.scope] A host under the site, whose choices
     *   the page shows.
     */
    showSite(site, { section, scope } = {}) {
      if (!this._els) {
        this._pendingSite = () => this.showSite(site, { section, scope });
        return;
      }
      if (this._sitePage.site === site) {
        if ((scope ?? null) !== this._sitePage.scope) {
          this._setSiteScope(scope ?? null);
        }
        this._scrollSitePage(section);
        return;
      }
      const from = location.href;
      this._siteFrom = from;
      // `gotoPref` may return without handing the page over, when its
      // category or subcategory moved on while it waited for Fluent.
      window
        .gotoPref(`${CATEGORY}-${subcategoryOf(site, { section, scope })}`)
        .finally(() => {
          if (this._siteFrom === from) {
            this._siteFrom = null;
          }
        });
    },

    /**
     * Opens the page `gotoPref` was asked for, after it rewrote the hash.
     *
     * @param {string} subcategory `site?host=…`, with `&scope=…` and
     *   `&section=…`.
     */
    _openSitePage(subcategory) {
      const params = new URLSearchParams(subcategory.slice(SUBCATEGORY.length));
      const site = params.get("host") ?? "";
      const from = this._siteFrom;
      this._siteFrom = null;
      if (!site || lazy.siteOfEntry(site).site !== site) {
        this._leaveSitePage();
        this.showSites();
        return;
      }
      // A scope that is no host of the site with a choice of its own shows
      // the site's choices.
      const scope = this._hostOf(site, params.get("scope") ?? "");
      const hash = `#${CATEGORY}-${subcategoryOf(site, { scope })}`;
      if (location.hash !== hash) {
        // `gotoPref` leaves the address alone when the category is already
        // showing; then the page is a step of its own for Back.
        if (from !== null && from === location.href) {
          history.pushState({ ...history.state, svalSitePage: true }, "", hash);
        } else {
          history.replaceState(history.state, "", hash);
        }
      }
      const page = this._sitePage;
      if (page.site !== site) {
        this._sitePage = {
          ...page,
          site,
          scope,
          addingHost: null,
          held: null,
          exceptionsOpen: false,
          failed: null,
          loading: false,
          slow: false,
          failedJars: new Set(),
        };
      } else if (page.scope !== scope) {
        this._sitePage = {
          ...page,
          scope,
          addingHost: null,
          exceptionsOpen: false,
        };
      }
      const els = this._siteEls;
      els.page.hidden = false;
      els.pane.dataset.sitePage = "";
      const title = document.querySelector("title");
      title.removeAttribute("data-l10n-id");
      document.title = `${scope ?? site} · Settings`;
      this._readSiteData();
      this._countSite(site);
      this._drawSitePage();
      els.title.focus({ preventScroll: true });
      this._scrollSitePage(params.get("section"));
    },

    /**
     * @param {?string} section A card's name, or nothing for the top.
     */
    _scrollSitePage(section) {
      const card =
        section &&
        this._siteEls.cards.querySelector(
          `[data-site-card="${CSS.escape(section)}"]`
        );
      (card || this._siteEls.page).scrollIntoView({ block: "start" });
    },

    /**
     * @param {string} site
     * @param {string} text An address or a host, as typed or in `&scope=`.
     * @returns {?string} The host it names, when that is a host under `site`
     *   that can hold a choice of its own (`scopeOfHost`), or null.
     */
    _hostOf(site, text) {
      const { host } = lazy.siteOfEntry(text);
      const scope = host ? lazy.scopeOfHost(host) : null;
      return scope?.choice && scope.site === site ? scope.host : null;
    },

    /**
     * @param {string} site
     * @returns {string[]} The hosts under `site` holding a choice of their
     *   own in any store the scoped cards read, by name.
     */
    _siteHosts(site) {
      const names = new Set([
        ...lazy.SvalSiteProtections.rules(this._siteSession).keys(),
        ...lazy.SvalJavascript.rules().keys(),
        ...lazy.SvalExtensionSites.names(),
        ...lazy.scopesInFilters(lazy.SvalBlocking.myFilters),
        ...lazy.exceptionsInFilters(lazy.SvalBlocking.myFilters).keys(),
      ]);
      return [...names]
        .filter(name => name !== site && lazy.siteOfEntry(name).site === site)
        .sort();
    },

    /**
     * @param {string} name A site or a host.
     * @returns {number} How many choices are saved for `name` itself, as the
     *   scoped cards show them: each field, rule, removed element, element
     *   shown again and extension switch.
     */
    _scopeChoices(name) {
      const rule =
        lazy.SvalSiteProtections.rules(this._siteSession).get(name) ?? {};
      const ext = lazy.SvalExtensionSites;
      return (
        Number(!!rule.protections) +
        Number(!!rule.media) +
        (rule.exceptions?.length ?? 0) +
        Number(lazy.SvalJavascript.rules().has(name)) +
        lazy.linesForScope(lazy.SvalBlocking.myFilters, name).length +
        (lazy.exceptionsInFilters(lazy.SvalBlocking.myFilters).get(name)
          ?.length ?? 0) +
        ext.idsOffOn(name).length +
        ext.idsOnAt(name).length
      );
    },

    /**
     * Shows the choices of `scope`, or the site's with null, in place, and
     * keeps the scope in the address so a reload comes back to it.
     *
     * @param {?string} scope
     */
    _setSiteScope(scope) {
      const site = this._sitePage.site;
      if (!site) {
        return;
      }
      this._sitePage = {
        ...this._sitePage,
        scope,
        addingHost: null,
        exceptionsOpen: false,
      };
      history.replaceState(
        history.state,
        "",
        `#${CATEGORY}-${subcategoryOf(site, { scope })}`
      );
      document.title = `${scope ?? site} · Settings`;
      const els = this._siteEls;
      const fromBar = els.scope.contains(document.activeElement);
      this._drawSitePage();
      if (fromBar) {
        this._focusScopeSelect();
      }
    },

    /**
     * Focuses the "Choices for" select once it has drawn: a `moz-select`
     * focuses its inner select, which it has only after its first render
     * (`MozBaseInputElement.focus`).
     */
    _focusScopeSelect() {
      const select = this._siteEls.scope.querySelector("moz-select");
      if (!select) {
        return;
      }
      customElements
        .whenDefined("moz-select")
        .then(() => select.updateComplete)
        .then(() => {
          if (select.isConnected) {
            select.focus();
          }
        });
    },

    /** Opens the Add a host field, from the select or the ⋯ menu. */
    _openAddHost() {
      if (!this._sitePage.site) {
        return;
      }
      this._sitePage.addingHost = { text: "" };
      this._drawSiteScope();
      this._siteEls.scope.querySelector("input")?.focus();
    },

    /**
     * The "Choices for" select, with the hint at a host's scope and the Add
     * a host field while it is open, or nothing while the site has no host
     * with choices and none is shown; then Add a host is in the ⋯ menu.
     */
    _drawSiteScope() {
      const page = this._sitePage;
      const els = this._siteEls;
      const site = page.site;
      if (!site || !els) {
        return;
      }
      const hosts = this._siteHosts(site);
      if (page.scope && !hosts.includes(page.scope)) {
        hosts.push(page.scope);
        hosts.sort();
      }
      const shown = !!hosts.length || !!page.addingHost;
      els.more.hidden = shown;
      els.scope.hidden = !shown;
      if (!shown) {
        els.scope.replaceChildren();
        return;
      }
      const held = els.scope.querySelector("moz-select");
      const selectHadFocus = !!held && held === document.activeElement;
      this._keepFocus(els.scope, () =>
        els.scope.replaceChildren(...this._siteScopeParts(site, hosts))
      );
      if (selectHadFocus) {
        this._focusScopeSelect();
      }
    },

    /**
     * @param {string} site
     * @param {string[]} hosts The hosts the select lists.
     * @returns {Element[]} The select's row, then the Add a host field.
     */
    _siteScopeParts(site, hosts) {
      const page = this._sitePage;
      const labelled = name => {
        const n = this._scopeChoices(name);
        return n ? `${name} · ${counted(n, "choice")}` : name;
      };
      const select = document.createElement("moz-select");
      select.id = "sval-site-scope-select";
      // No `data-sval-key`: `_keepFocus` would focus it before it renders,
      // so `_drawSiteScope` puts focus back itself.
      select.className = "sval-site-scope-select";
      select.setAttribute("aria-label", "Choices for");
      const option = (value, label) => {
        const el = document.createElement("moz-option");
        el.setAttribute("value", value);
        el.setAttribute("label", label);
        return el;
      };
      const allOf = this._scopeChoices(site);
      select.append(
        option(
          site,
          allOf
            ? `All of ${site} · ${counted(allOf, "choice")}`
            : `All of ${site}`
        ),
        ...hosts.map(host => option(host, labelled(host))),
        option(ADD_HOST, "Add an address…")
      );
      const current = page.scope ?? site;
      select.value = current;
      select.addEventListener("change", () => {
        if (select.value === ADD_HOST) {
          select.value = current;
          this._openAddHost();
          return;
        }
        this._setSiteScope(select.value === site ? null : select.value);
      });

      const row = this._el(
        "div",
        { className: "sval-site-scope-row" },
        this._el(
          "span",
          { className: "sval-site-scope-label", ariaHidden: "true" },
          "Choices for"
        ),
        select
      );
      if (page.scope) {
        row.append(
          this._el(
            "span",
            { className: "sval-site-scope-hint" },
            `Everything else comes from ${site}.`
          )
        );
      }
      return page.addingHost ? [row, this._siteAddHostRow(site)] : [row];
    },

    /**
     * The Add a host field: a host under the site, which the page then
     * shows the choices of.
     *
     * @param {string} site
     * @returns {Element}
     */
    _siteAddHostRow(site) {
      const input = this._el("input", {
        type: "text",
        className: "sval-agent-add-input",
        id: "sval-site-add-host-input",
        placeholder: `app.${site}`,
        spellcheck: false,
        value: this._sitePage.addingHost.text,
        dataset: { svalKey: "site-add-host" },
      });
      const confirm = this._el(
        "button",
        {
          type: "button",
          className: "sval-button sval-button-primary sval-agent-small",
          dataset: { svalKey: "site-add-host-add" },
        },
        "Add"
      );
      const cancel = this._el(
        "button",
        {
          type: "button",
          className: "sval-button sval-agent-small",
          dataset: { svalKey: "site-add-host-cancel" },
        },
        "Cancel"
      );
      const preview = this._el("div", {
        className: "sval-agent-preview",
        id: "sval-site-add-host-preview",
        ariaLive: "polite",
      });
      input.setAttribute("aria-describedby", preview.id);
      const reading = () =>
        this._hostOf(site, this._sitePage.addingHost?.text ?? "");
      const describe = () => {
        const host = reading();
        const empty = !this._sitePage.addingHost?.text.trim();
        confirm.disabled = !host;
        input.setAttribute("aria-invalid", String(!empty && !host));
        let state = "invalid";
        if (host) {
          state = "host";
        } else if (empty) {
          state = "empty";
        }
        preview.dataset.state = state;
        if (host) {
          preview.textContent = `These choices cover ${host} and every address under it. Everything else comes from ${site}.`;
        } else if (empty) {
          preview.textContent = `Type an address on ${site}.`;
        } else {
          preview.textContent = `Enter an address on ${site} other than ${site} itself.`;
        }
      };
      const add = () => {
        const host = reading();
        if (host) {
          this._setSiteScope(host);
        }
      };
      const close = () => {
        this._sitePage.addingHost = null;
        this._drawSiteScope();
        if (this._siteEls.scope.hidden) {
          this._siteEls.more.focus();
        } else {
          this._focusScopeSelect();
        }
      };
      input.addEventListener("input", () => {
        this._sitePage.addingHost = { text: input.value };
        describe();
      });
      input.addEventListener("keydown", event => {
        if (event.key === "Enter") {
          event.preventDefault();
          add();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      });
      confirm.addEventListener("click", add);
      cancel.addEventListener("click", close);
      describe();
      return this._el(
        "div",
        {
          className: "sval-agent-adding sval-site-add-host",
          role: "group",
          ariaLabel: "Add an address",
        },
        this._fieldLabel(input, `Address on ${site}`),
        this._el(
          "div",
          { className: "sval-agent-adding-row" },
          input,
          confirm,
          cancel
        ),
        preview
      );
    },

    /**
     * The rule and heading that lead the cards covering the whole site,
     * shown while the "Choices for" select is.
     *
     * @param {string} site
     * @returns {?Element}
     */
    _siteCardWhole(site) {
      if (this._siteEls.scope.hidden) {
        return null;
      }
      return this._el(
        "div",
        {
          className: "sval-site-whole",
          dataset: { siteCard: "whole" },
        },
        this._el(
          "h2",
          { className: "sval-site-whole-title" },
          `For all of ${site}`
        ),
        this._el(
          "p",
          { className: "sval-site-whole-note" },
          `These settings cover all of ${site}.`
        )
      );
    },

    /**
     * Hides the page, if it shows, and gives the pane its cards back.
     *
     * @returns {?string} The host the page showed, or its site.
     */
    _leaveSitePage() {
      const els = this._siteEls;
      const site = this._sitePage.scope ?? this._sitePage.site;
      if (!els || !site) {
        return null;
      }
      this._sitePage = {
        ...this._sitePage,
        site: null,
        scope: null,
        addingHost: null,
        held: null,
      };
      this._stopSiteDataWait();
      els.page.hidden = true;
      delete els.pane.dataset.sitePage;
      if (isSiteHash(location.hash)) {
        history.replaceState(history.state, "", `#${CATEGORY}`);
      }
      document.l10n.setAttributes(
        document.querySelector("title"),
        "settings-page-title"
      );
      return site;
    },

    /**
     * Back, from the button or the breadcrumb: to the entry before when the
     * page made one, whose `hashchange` leaves the page; otherwise straight
     * to the Sites card.
     */
    _backToSites() {
      if (history.state?.svalSitePage) {
        history.back();
        return;
      }
      this._showSitesCard(this._leaveSitePage());
    },

    /**
     * The Sites card as it was left, in view, with focus on the site's link
     * when the card still lists it.
     *
     * @param {?string} site The site the page showed.
     */
    _showSitesCard(site) {
      this._describeSites();
      document.getElementById("sval-sites").scrollIntoView();
      (
        (site &&
          this._els.sitesBody.querySelector(
            `[data-site="${CSS.escape(site)}"] .sval-sites-link`
          )) ||
        document.getElementById("sval-sites-search")
      )?.focus();
    },

    /**
     * Counts what the site holds, for the line saying it holds nothing, the
     * Forget card, and 8a's list while it shows. Until stored data is read,
     * a site holding nothing else is not yet known to hold nothing.
     *
     * @param {string} site
     */
    async _countSite(site) {
      const ticket = ++this._siteCounts;
      const at = this._siteDataReads;
      let counts;
      try {
        counts = await lazy.SvalForgetSite.countsFor(site);
      } catch (err) {
        lazy.SvalLog.warn(
          `counting a site's holdings failed: ${lazy.SvalLog.errorName(err)}`
        );
        return;
      }
      if (ticket !== this._siteCounts || this._sitePage.site !== site) {
        return;
      }
      let held = lazy.SvalForgetSite.holdsAnything(counts);
      if (!held && counts.dataJars === null) {
        held = null;
      }
      const view = this._blockingView.forget;
      if (view?.site === site) {
        view.counts = counts;
        view.at = at;
        this._drawForgetList();
      }
      // Only what reads `held` is redrawn: a whole page's redraw would
      // close a select the person has open.
      if (held !== this._sitePage.held) {
        this._sitePage.held = held;
        this._drawSiteHead();
        this._redrawSiteCard("forget");
      }
    },

    /**
     * @returns {?object} The document's nodes, from the profile's panel, or
     *   null while no window has one started.
     */
    _siteNodes() {
      return this.panel?.nodes ?? null;
    },

    /**
     * Redraws one card of the page in place, keeping focus, or the whole
     * page when the card comes or goes.
     *
     * @param {string} name The card's `data-site-card`, after which its
     *   method in `SITE_CARDS` is named.
     */
    _redrawSiteCard(name) {
      const site = this._sitePage.site;
      if (!site || !this._siteEls) {
        return;
      }
      const cards = this._siteEls.cards;
      const old = cards.querySelector(`[data-site-card="${name}"]`);
      const card =
        this[`_siteCard${name[0].toUpperCase()}${name.slice(1)}`](site);
      if (!old || !card) {
        if (old || card) {
          this._drawSitePage();
        }
        return;
      }
      this._keepFocus(cards, () => old.replaceWith(card));
    },

    /**
     * Redraws the page, if it shows, keeping focus.
     *
     * @param {?(string|string[])} [next] As for `_keepFocus`.
     * @param {boolean} [take] As for `_keepFocus`.
     */
    _drawSitePage(next = null, take = false) {
      const site = this._sitePage.site;
      if (!site || !this._siteEls) {
        return;
      }
      this._drawSiteHead();
      this._drawSiteScope();
      const cards = this._siteEls.cards;
      this._keepFocus(
        cards,
        () =>
          cards.replaceChildren(
            ...SITE_CARDS.map(name => this[name](site)).filter(Boolean)
          ),
        next,
        take
      );
    },

    /** The icon, the name, the line under it, and the private note. */
    _drawSiteHead() {
      const page = this._sitePage;
      const els = this._siteEls;
      els.title.textContent = page.site;
      els.nothing.textContent = `Sval holds nothing for ${page.site}.`;
      els.nothing.hidden = page.held !== false;
      els.note.hidden = !this._privateWindow;
      els.alert.hidden = !page.failed;
      if (page.iconFor !== page.site) {
        page.iconFor = page.site;
        page.icon = null;
        this._findSiteIcon(page.site);
      }
      els.icon.replaceChildren(
        page.icon
          ? this._el("img", { src: page.icon, alt: "" })
          : this._glyph("globe")
      );
    },

    /**
     * Asks Places for the icon of the site's https origin, which falls back
     * to the root domain's icon (`nsIFaviconService.getFaviconForPage`).
     *
     * @param {string} site
     */
    async _findSiteIcon(site) {
      let favicon = null;
      try {
        favicon = await lazy.PlacesUtils.favicons.getFaviconForPage(
          Services.io.newURI(`https://${site}/`)
        );
      } catch (err) {
        lazy.SvalLog.warn(
          `a site's icon did not load: ${lazy.SvalLog.errorName(err)}`
        );
      }
      const page = this._sitePage;
      if (favicon && page.iconFor === site) {
        page.icon = favicon.dataURI.spec;
        this._drawSiteHead();
      }
    },

    /**
     * One row: a label, the line under it, and its control.
     *
     * @param {string} key The row's name, for ids.
     * @param {string|Element} label
     * @param {string} sub
     * @param {Element} control
     * @returns {Element}
     */
    _sitePageRow(key, label, sub, control) {
      const labelId = `sval-site-${key}-label`;
      const subId = `sval-site-${key}-sub`;
      const words =
        typeof label === "string"
          ? this._el("span", { className: "sval-site-row-label" }, label)
          : label;
      words.id = labelId;
      if (control.localName === "sval-choice-pill") {
        if (!control.hasAttribute("label")) {
          control.setAttribute("label", words.textContent);
        }
        if (sub) {
          control.setAttribute("describedby", subId);
        }
      }
      return this._el(
        "div",
        { className: "sval-site-row", dataset: { row: key } },
        this._el(
          "div",
          { className: "sval-site-row-words" },
          words,
          ...(sub
            ? [
                this._el(
                  "span",
                  { className: "sval-site-row-sub", id: subId },
                  sub
                ),
              ]
            : [])
        ),
        control
      );
    },

    /**
     * A choice as plain text, for a private window, where it can't be
     * changed.
     *
     * @param {string} key
     * @param {string} text
     * @param {string} value The choice's value, "" for the default.
     * @returns {Element}
     */
    _sitePageValue(key, text, value) {
      return this._el(
        "span",
        {
          className: "sval-site-value",
          dataset: { svalKey: `site-${key}`, value },
        },
        text
      );
    },

    /**
     * @param {string} key
     * @param {Array<[string, string]>} choices
     * @param {string} value
     * @param {Function} onChange Given the chosen value.
     * @returns {Element}
     */
    _sitePageSelect(key, choices, value, onChange) {
      const pill = this._el("sval-choice-pill", {
        choices,
        value,
        dataset: { svalKey: `site-${key}` },
      });
      if (!value) {
        pill.dataset.default = "";
      }
      pill.addEventListener("change", () => onChange(pill.value));
      return pill;
    },

    /**
     * Protections, Video and audio, and fingerprinting exceptions: the
     * stored rule of the site or the host in view, or the private window's
     * own, written through the Sites card's setters. At a host's scope a
     * field it has not set shows what it inherits, marked as a default is.
     *
     * @param {string} site
     * @returns {Element}
     */
    _siteCardProtections(site) {
      const sp = lazy.SvalSiteProtections;
      const session = this._siteSession;
      const view = this._sitePage;
      const name = view.scope ?? site;
      // The stored rules, as the Sites card reads them: `ruleFor` answers
      // from what Gecko was last given, which a pref observer can run ahead
      // of.
      const own = sp.rules(session).get(name) ?? {};
      const shown = field =>
        own[field] ??
        (view.scope ? sp.inheritedFor(name, field, session) : undefined);
      const rule = {
        protections: shown("protections"),
        media: shown("media"),
        exceptions: shown("exceptions"),
      };

      // Every protection on is what a site gets with no choice of its own,
      // so Default stands for it.
      const protections = this._sitePageSelect(
        "protections",
        [
          ["", "Default"],
          ...this._siteProtectionChoices().filter(([value]) => value !== "on"),
        ],
        rule.protections === "on" ? "" : (rule.protections ?? ""),
        value => sp.setProtections(name, value || "on", session)
      );
      if (own.protections) {
        delete protections.dataset.default;
      } else {
        protections.dataset.default = "";
      }

      const mediaWords = new Map(lazy.MEDIA_CHOICES);
      const media = this._sitePageSelect(
        "media",
        [["", "Default"], ...lazy.MEDIA_CHOICES],
        rule.media ?? "",
        value => sp.setMedia(name, value, session)
      );
      if (own.media) {
        delete media.dataset.default;
      } else {
        media.dataset.default = "";
      }
      const mediaRow = this._sitePageRow(
        "media",
        "Video and audio",
        `Default for all sites: ${mediaWords.get(sp.mediaDefault())}`,
        media
      );
      mediaRow.dataset.fallback = sp.mediaDefault();

      const card = this._el(
        "section",
        {
          className: "sval-card sval-site-card",
          ariaLabelledby: "sval-site-protections-label",
          dataset: { siteCard: "protections" },
        },
        this._sitePageRow(
          "protections",
          this._el("h2", { className: "sval-site-card-title" }, "Protections"),
          "Protections block trackers and ads, and resist fingerprinting.",
          protections
        ),
        mediaRow,
        this._sitePageRow(
          "exceptions",
          "Fingerprinting exceptions",
          "These scripts can read details of your device.",
          this._siteExceptionsPill(name, rule, !own.exceptions)
        )
      );
      if (view.exceptionsOpen) {
        card.append(this._siteExceptions(name, rule, "sval-site-exceptions"));
      }
      return card;
    },

    /**
     * The fingerprinting exceptions' disclosure, unavailable where the Sites
     * card's is.
     *
     * @param {string} site The site or host in view.
     * @param {object} rule
     * @param {boolean} inherited Whether the exceptions are not its own.
     * @returns {Element}
     */
    _siteExceptionsPill(site, rule, inherited) {
      const sp = lazy.SvalSiteProtections;
      const off =
        rule.protections === "off" || rule.protections === "fingerprinting";
      const unavailable = off || this._privateWindow || !sp.canWriteFor(site);
      const ids = rule.exceptions ?? [];
      let words = ids.length ? counted(ids.length, "exception") : "None";
      let title = "";
      let why = "";
      if (off) {
        words = "Protection is off";
        why = "protection-off";
        title =
          "Fingerprinting protection is off for this site, so it may read every value.";
      } else if (this._privateWindow) {
        words = "Not available";
        title = "Private windows can't keep fingerprinting exceptions.";
        why = "private";
      } else if (unavailable) {
        words = "Not available";
        title = sp.UNWRITABLE_NOTE;
        why = "unwritable";
      }
      if (unavailable && this._sitePage.exceptionsOpen) {
        this._sitePage.exceptionsOpen = false;
      }
      const open = this._sitePage.exceptionsOpen;
      const pill = this._el(
        "button",
        {
          type: "button",
          className: "sval-button sval-agent-small sval-site-exceptions",
          disabled: unavailable,
          title,
          ariaExpanded: String(open),
          ariaControls: "sval-site-exceptions",
          ariaLabelledby:
            "sval-site-exceptions-label sval-site-exceptions-words",
          dataset: {
            svalKey: "site-exceptions",
            none: String(!ids.length),
            why,
            ...(inherited ? { default: "" } : {}),
          },
        },
        this._el("span", { id: "sval-site-exceptions-words" }, words),
        this._glyph("sc-next")
      );
      pill.addEventListener("click", () => {
        this._sitePage.exceptionsOpen = !open;
        this._drawSitePage();
      });
      return pill;
    },

    /**
     * JavaScript, the rule the JavaScript button and the site menu's switch
     * write, for the site or the host in view. A host without a rule shows
     * what it inherits, marked as a default is. Plain text in a private
     * window.
     *
     * @param {string} site
     * @returns {Element}
     */
    _siteCardJavascript(site) {
      const js = lazy.SvalJavascript;
      const scope = this._sitePage.scope;
      const name = scope ?? site;
      const own = js.rules().get(name);
      let value = own ?? "";
      if (scope && !own) {
        value = js.inheritedFor(name) ? "allow" : "block";
      }
      const control = this._privateWindow
        ? this._sitePageValue(
            "javascript",
            new Map(JAVASCRIPT_CHOICES).get(value),
            value
          )
        : this._sitePageSelect(
            "javascript",
            JAVASCRIPT_CHOICES,
            value,
            chosen => {
              if (chosen) {
                js.setEnabled(name, chosen === "allow");
              } else {
                js.removeRule(name);
              }
            }
          );
      if (!own) {
        control.dataset.default = "";
      }
      return this._el(
        "section",
        {
          className: "sval-card sval-site-card",
          ariaLabelledby: "sval-site-javascript-label",
          dataset: { siteCard: "javascript" },
        },
        this._sitePageRow(
          "javascript",
          this._el("h2", { className: "sval-site-card-title" }, "JavaScript"),
          scope
            ? ""
            : `Default for all sites: ${js.defaultEnabled() ? "allowed" : "blocked"}`,
          control
        )
      );
    },

    /**
     * Permissions, one row per permission on one origin, written to that
     * origin alone through `SitePermissions`. Plain text in a private
     * window.
     *
     * @param {string} site
     * @returns {Element}
     */
    _siteCardPermissions(site) {
      const [home] = lazy.siteOrigins(site, ["https"]);
      return this._el(
        "section",
        {
          className: "sval-card sval-site-card",
          ariaLabelledby: "sval-site-permissions-label",
          dataset: { siteCard: "permissions" },
        },
        this._siteCardHead(
          "permissions",
          "Permissions",
          "These apply in every Workspace."
        ),
        ...lazy
          .permissionsFor(site)
          .map(row =>
            this._sitePermissionRow(row, row.origin !== home?.prePath)
          )
      );
    },

    /**
     * A card's heading, with the line under it or a count beside it.
     *
     * @param {string} key
     * @param {string} title
     * @param {string} [sub]
     * @param {string} [count]
     * @returns {Element}
     */
    _siteCardHead(key, title, sub = "", count = "") {
      const heading = this._el(
        "h2",
        { className: "sval-site-card-title", id: `sval-site-${key}-label` },
        title
      );
      if (count) {
        heading.append(
          " ",
          this._el("span", { className: "sval-site-card-count" }, count)
        );
      }
      return this._el(
        "div",
        { className: "sval-site-card-head" },
        heading,
        ...(sub
          ? [this._el("span", { className: "sval-site-row-sub" }, sub)]
          : [])
      );
    },

    /**
     * One permission on one origin. Default is the site holding no choice of
     * the user's: the default for every site, or the defaults file's grant
     * for this origin, which removing the user's choice restores
     * (`PermissionManager::AddInternal`). A choice equal to the default is
     * still kept, so it holds when the default changes
     * (`SitePermissions.setForPrincipal`).
     *
     * @param {object} row From `permissionsFor`.
     * @param {boolean} elsewhere Whether the origin is other than the
     *   site's https address, so the row names it.
     * @returns {Element}
     */
    _sitePermissionRow(row, elsewhere) {
      const SP = lazy.SitePermissions;
      const cookie = row.id === "cookie";
      const label = lazy.permissionLabel(row.id);
      const stored = Services.perms.getPermissionObject(
        row.principal,
        row.id,
        true
      );
      const held = !!stored && !stored.isDefault;
      const host = row.origin.startsWith("https://")
        ? row.origin.slice("https://".length)
        : row.origin;
      const name = elsewhere ? `${label} for ${host}` : label;
      const key = `perm:${row.origin}:${row.id}`;

      const words = cookie
        ? new Map([
            [SP.ALLOW, "Allow"],
            [SP.ALLOW_COOKIES_FOR_SESSION, "Allow for the session"],
            [SP.BLOCK, "Block"],
          ])
        : lazy.permissionWords();
      const byDefault = row.isDefault ? row.state : SP.getDefault(row.id);
      const choices = [
        ["", `Default (${words.get(byDefault) ?? words.get(SP.UNKNOWN)})`],
        ...SP.getAvailableStates(row.id)
          .filter(state => state !== SP.UNKNOWN && words.has(state))
          .map(state => [String(state), words.get(state)]),
      ];
      let value = held ? String(row.state) : "";
      if (!choices.some(([choice]) => choice === value)) {
        value = "";
      }

      let control;
      if (this._privateWindow) {
        control = this._sitePageValue(key, new Map(choices).get(value), value);
      } else {
        control = this._sitePageSelect(key, choices, value, chosen => {
          if (chosen) {
            lazy.setPermission(row, Number(chosen));
          } else {
            lazy.clearPermission(row);
          }
        });
      }

      const shown = this._el(
        "span",
        { className: "sval-site-row-label sval-site-perm-name" },
        this._glyph(
          lazy.PERMISSION_ICONS[row.id] ??
            (cookie ? "sc-cookie" : "sc-storage"),
          "sval-site-perm-icon"
        ),
        label
      );
      if (elsewhere) {
        shown.append(
          this._el(
            "span",
            { className: "sval-site-host", title: row.origin },
            host
          )
        );
      }
      let sub = "";
      if (row.isDefault) {
        sub = "Sval grants this by default";
      } else if (cookie) {
        sub = "An exception to your cookie setting";
      }
      const line = this._sitePageRow(key, shown, sub, control);
      line.dataset.byDefault = String(byDefault);
      line.querySelector("sval-choice-pill")?.setAttribute("label", name);
      return line;
    },

    /**
     * Every extension that can reach the site, with its switch for the site
     * (`SvalExtensionSites`), or null where none can. A switch is saved and
     * synced, so a private window shows it as plain text.
     *
     * @param {string} site
     * @returns {?Element}
     */
    _siteCardExtensions(site) {
      const scope = this._sitePage.scope;
      const name = scope ?? site;
      const uri = Services.io.newURI(`https://${name}/`);
      const policies = WebExtensionPolicy.getActiveExtensions()
        .filter(
          // The extensions Settings › Extensions lists: not hidden.
          policy =>
            policy.extension?.type === "extension" &&
            !policy.extension.isHidden &&
            !lazy.OriginControls._getStateInternal(policy, { uri }).noAccess
        )
        .sort((a, b) => a.name.localeCompare(b.name));
      if (!policies.length) {
        return null;
      }
      const card = this._el(
        "section",
        {
          className: "sval-card sval-site-card",
          ariaLabelledby: "sval-site-extensions-label",
          dataset: { siteCard: "extensions" },
        },
        this._siteCardHead("extensions", "Extensions")
      );
      for (const policy of policies) {
        const key = `extension-${card.children.length}`;
        if (this._privateWindow) {
          const off = lazy.SvalExtensionSites.isOff(policy.id, name);
          const row = this._sitePageRow(
            key,
            policy.name,
            "",
            this._sitePageValue(key, off ? "Off" : "On", off ? "off" : "on")
          );
          row.dataset.extensionId = policy.id;
          card.append(row);
          continue;
        }
        const input = this._el("input", {
          type: "checkbox",
          className: "sval-switch",
          role: "switch",
          checked: !lazy.SvalExtensionSites.isOff(policy.id, name),
        });
        input.setAttribute("aria-labelledby", `sval-site-${key}-label`);
        input.addEventListener("change", () =>
          lazy.SvalExtensionSites.setOff(policy.id, name, !input.checked)
            .then(() => lazy.SvalExtensionSites.reloadSite(name))
            .catch(err =>
              lazy.SvalLog.warn(
                `an extension's site switch did not apply: ${lazy.SvalLog.errorName(err)}`
              )
            )
        );
        const row = this._sitePageRow(key, policy.name, "", input);
        row.dataset.extensionId = policy.id;
        if (
          scope &&
          lazy.SvalExtensionSites.ruleFor(policy.id, name) === undefined
        ) {
          row.dataset.default = "";
        }
        card.append(row);
      }
      return card;
    },

    /**
     * Removed elements: every line of My filters saved for the site or the
     * host in view, newest first, as the Sites card lists them. At a host's
     * scope a line under it says how many of the site's own apply there too.
     *
     * @param {string} site
     * @returns {Element}
     */
    _siteCardHidden(site) {
      const scope = this._sitePage.scope;
      const text = lazy.SvalBlocking.myFilters;
      const lines = lazy.linesForScope(text, scope ?? site);
      const inherited = scope ? lazy.linesForScope(text, site).length : 0;
      const foot = inherited
        ? [
            this._el(
              "p",
              { className: "sval-site-hidden-foot" },
              `${counted(inherited, "rule")} for all of ${site} also apply here.`
            ),
          ]
        : [];
      const card = this._el(
        "section",
        {
          className: "sval-card sval-site-card",
          ariaLabelledby: "sval-site-hidden-label",
          dataset: { siteCard: "hidden" },
        },
        this._siteCardHead("hidden", "Removed elements")
      );
      if (!lines.length) {
        card.append(
          this._emptyState(
            "Nothing removed yet",
            "Parts of this site you remove with Remove from this site appear here."
          ),
          ...foot
        );
        return card;
      }
      const list = this._el("div", { className: "sval-site-hidden-list" });
      lines.forEach((entry, at) =>
        list.append(
          this._hiddenRow(site, entry, at, () =>
            this._showAgain(site, entry, at, next => {
              this._drawSitePage(next, true);
              if (!this._siteEls.cards.contains(document.activeElement)) {
                this._siteEls.title.focus({ preventScroll: true });
              }
            })
          )
        )
      );
      card.append(list, ...foot);
      if (!this._privateWindow) {
        card.append(
          this._hiddenOpenLink(() => {
            this._leaveSitePage();
            this._openMyFilters(lines[0].line);
          })
        );
      }
      return card;
    },

    /**
     * Reads stored data again, and, while no read has answered yet, starts
     * the timer after which the card says the read is slow. Until it ends,
     * the page draws the last answer, and 8a waits for this one.
     */
    _readSiteData() {
      const data = lazy.SvalSiteData;
      this._siteDataReading++;
      // A read rejects only once Gecko can make no quota manager actor
      // (`QuotaManagerService::EnsureBackgroundActor`), as it shuts down, so
      // the page keeps its last answer.
      data
        .update()
        .catch(err =>
          lazy.SvalLog.warn(
            `reading stored site data failed: ${lazy.SvalLog.errorName(err)}`
          )
        )
        .then(() => this._siteDataRead());
      if (data.ready || this._siteDataTimer !== null) {
        return;
      }
      this._sitePage.slow = false;
      this._siteDataTimer = setTimeout(() => {
        this._siteDataTimer = null;
        this._sitePage.slow = true;
        this._redrawSiteCard("data");
      }, this._siteDataSlowMs);
    },

    /**
     * Reads stored data for the Sites card's search: at once for a query
     * just begun, and otherwise once the typing pauses.
     */
    _readSiteDataForSearch() {
      clearTimeout(this._siteSearchTimer);
      this._siteSearchTimer = null;
      if (!this._siteResultsShown.q) {
        this._readSiteData();
        return;
      }
      this._siteSearchTimer = setTimeout(() => {
        this._siteSearchTimer = null;
        this._readSiteData();
      }, this._siteSearchReadMs);
    },

    /**
     * Ends a read `_readSiteData` began. 8a counts again, since it waits for
     * the read; the read has redrawn the rest already, through
     * `SvalSiteData.TOPIC`.
     */
    _siteDataRead() {
      this._siteDataReading--;
      this._siteDataReads++;
      const site = this._sitePage.site;
      if (site && this._blockingView.forget?.site === site) {
        this._countSite(site);
      }
    },

    /** Stops the slow-read timer, if it runs. */
    _stopSiteDataWait() {
      clearTimeout(this._siteDataTimer);
      this._siteDataTimer = null;
    },

    /**
     * Cookies and site data: a row per jar holding the site's data, as
     * `SvalSiteData.jarsFor` lists them, each cleared on its own, and Clear
     * everywhere. Read-only in a private window.
     *
     * @param {string} site
     * @returns {Element}
     */
    _siteCardData(site) {
      const data = lazy.SvalSiteData;
      const ready = data.ready;
      const rows = ready ? data.jarsFor(site, this._siteNodes()) : [];
      const total = rows.reduce((sum, row) => sum + row.usage, 0);
      const live = !this._privateWindow;

      const head = this._el(
        "div",
        { className: "sval-site-data-head" },
        this._siteCardHead(
          "data",
          "Cookies and site data",
          "",
          total ? sizeOf(total) : ""
        )
      );
      if (live && (!ready || rows.length)) {
        const everywhere = this._el(
          "button",
          {
            type: "button",
            className: "sval-button sval-agent-small sval-site-data-everywhere",
            dataset: { svalKey: "site-data-everywhere" },
          },
          "Clear everywhere"
        );
        if (!ready) {
          everywhere.setAttribute("aria-disabled", "true");
        }
        everywhere.addEventListener("click", () => {
          if (lazy.SvalSiteData.ready) {
            this._askClearEverywhere(site);
          }
        });
        head.append(everywhere);
      }

      const card = this._el(
        "section",
        {
          className: "sval-card sval-site-card",
          ariaLabelledby: "sval-site-data-label",
          dataset: { siteCard: "data" },
        },
        head
      );
      if (!ready) {
        card.setAttribute("aria-busy", "true");
        card.append(
          this._el(
            "p",
            {
              className: "sval-site-data-status",
              role: "status",
              dataset: { state: this._sitePage.slow ? "slow" : "reading" },
            },
            this._el("span", {
              className: "sval-site-spinner",
              ariaHidden: "true",
            }),
            this._sitePage.slow
              ? "Stored data is taking a while to read."
              : "Still reading stored data. Workspaces and sizes appear here when it's done."
          ),
          ...Array.from({ length: 3 }, () =>
            this._el("div", {
              className: "sval-site-skeleton",
              ariaHidden: "true",
            })
          )
        );
      } else if (!rows.length) {
        card.append(
          this._emptyState(
            "No cookies or site data",
            "What this site stores on this device appears here."
          )
        );
      } else {
        rows.forEach((row, at) =>
          card.append(this._siteDataRow(site, row, rows, at))
        );
      }

      if (live) {
        const link = (words, open) => {
          const button = this._el(
            "button",
            { type: "button", className: "sval-link" },
            words
          );
          button.addEventListener("click", open);
          return button;
        };
        // Opened as the Privacy pane opens them (`siteDataSettings` and
        // `cookieExceptions` in `preferences/config/privacy.mjs`).
        card.append(
          this._el(
            "p",
            { className: "sval-site-data-foot" },
            this._el("span", {}, "For all sites:"),
            link("Manage data…", () =>
              window.gSubDialog.open(
                "chrome://browser/content/preferences/dialogs/siteDataSettings.xhtml"
              )
            ),
            link("Manage exceptions…", () =>
              window.gSubDialog.open(
                "chrome://browser/content/preferences/dialogs/permissions.xhtml",
                {},
                {
                  blockVisible: true,
                  sessionVisible: true,
                  allowVisible: true,
                  prefilledHost: "",
                  permissionType: "cookie",
                }
              )
            )
          )
        );
      }
      return card;
    },

    /**
     * @param {object} row From `jarsFor`.
     * @returns {string} The row's key, the same across reads.
     */
    _siteDataKey(row) {
      return row.kind === "isolated" ? `isolated:${row.workspaceId}` : row.kind;
    },

    /**
     * @param {object} row From `jarsFor`.
     * @returns {string} Where the row's data is, for 8c's sentence.
     */
    _siteDataPlace(row) {
      if (row.kind === "shared") {
        return "your shared Workspaces";
      }
      return row.kind === "isolated"
        ? row.name || UNTITLED
        : "a removed Workspace";
    },

    /**
     * One jar's row: where the data is, its size, and Clear, or the reason
     * its last clear failed and Try again.
     *
     * @param {string} site
     * @param {object} row From `jarsFor`.
     * @param {object[]} rows Every row, for where focus goes after a clear.
     * @param {number} at The row's place in `rows`.
     * @returns {Element}
     */
    _siteDataRow(site, row, rows, at) {
      const key = this._siteDataKey(row);
      const clearKey = k => `site-data-clear:${k}`;
      const failed = row.userContextIds.some(id =>
        this._sitePage.failedJars.has(id)
      );

      let name;
      let label;
      let sub = "";
      if (row.kind === "shared") {
        name = "Shared Workspaces";
        label = name;
        const names = row.sharedNames.map(n => n || UNTITLED);
        sub =
          names.length > 3
            ? `${names.slice(0, 3).join(", ")}, and ${names.length - 3} more`
            : listed(names);
      } else if (row.kind === "isolated") {
        name = row.name || UNTITLED;
        label = this._el(
          "span",
          { className: "sval-site-row-label sval-site-data-name" },
          name,
          this._el("span", { className: "sval-iso-pill" }, "Isolated")
        );
      } else {
        name = "Removed Workspace";
        label = name;
        sub = "Its Workspace was deleted";
      }
      if (failed) {
        sub = this._el(
          "span",
          { className: "sval-site-data-failed" },
          this._glyph("sc-alert"),
          NOT_CLEARED
        );
      }

      const control = this._el(
        "div",
        { className: "sval-site-data-controls" },
        this._el(
          "span",
          {
            className: "sval-site-data-size",
            dataset: { usage: String(row.usage) },
          },
          // A jar with cookies and no stored data has no size to show.
          row.usage ? sizeOf(row.usage) : "Cookies only"
        )
      );
      if (!this._privateWindow) {
        const clear = this._el(
          "button",
          {
            type: "button",
            className: "sval-button sval-agent-small sval-site-data-clear",
            ariaLabel: `${failed ? "Try clearing again" : "Clear"}: ${name}`,
            dataset: { svalKey: clearKey(key) },
          },
          failed ? "Try again" : "Clear"
        );
        // Focus goes to the row taking this one's place, the one before it,
        // or Clear everywhere.
        const next = [
          ...[rows[at + 1], rows[at - 1]]
            .filter(Boolean)
            .map(other => clearKey(this._siteDataKey(other))),
          "site-data-everywhere",
        ];
        clear.addEventListener("click", () =>
          this._clearSiteJar(site, row, clearKey(key), next)
        );
        control.append(clear);
      }

      const line = this._sitePageRow(`data-${key}`, label, sub, control);
      line.classList.add("sval-site-data-row");
      line.dataset.jar = row.kind;
      line.dataset.failed = String(failed);
      return line;
    },

    /**
     * Clears one row's jars for the site. A jar that did not clear keeps
     * its row, which says so.
     *
     * @param {string} site
     * @param {object} row From `jarsFor`.
     * @param {string} own The row's button's key.
     * @param {string[]} next Where focus goes once the row is gone.
     */
    async _clearSiteJar(site, row, own, next) {
      const running = `${site} ${own}`;
      if (this._siteDataClearing.has(running)) {
        return;
      }
      this._siteDataClearing.add(running);
      let failed;
      try {
        ({ failed } = await lazy.SvalSiteData.clearJars(
          site,
          row.userContextIds
        ));
      } catch (err) {
        lazy.SvalLog.warn(
          `clearing a site's jar failed: ${lazy.SvalLog.errorName(err)}`
        );
        failed = row.userContextIds;
      } finally {
        this._siteDataClearing.delete(running);
      }
      if (this._sitePage.site !== site) {
        return;
      }
      const marks = this._sitePage.failedJars;
      for (const id of row.userContextIds) {
        marks.delete(id);
      }
      for (const id of failed) {
        marks.add(id);
      }
      this._afterSiteDataClear(failed.length ? [own, ...next] : next);
    },

    /**
     * Redraws after a clear, with focus on `next`, or on the page's name
     * when the card has nothing left to take it.
     *
     * @param {string[]} next
     */
    _afterSiteDataClear(next) {
      this._drawSitePage(next, true);
      if (!this._siteEls.cards.contains(document.activeElement)) {
        this._siteEls.title.focus({ preventScroll: true });
      }
    },

    /**
     * Opens 8c, the confirm for clearing the site's data in every jar.
     *
     * @param {string} site
     */
    _askClearEverywhere(site) {
      const els = this._els;
      const rows = lazy.SvalSiteData.jarsFor(site, this._siteNodes());
      const total = rows.reduce((sum, row) => sum + row.usage, 0);
      const places =
        rows.length > 3
          ? `${rows.length} Workspaces`
          : listed(rows.map(row => this._siteDataPlace(row)));
      this._blockingView.clearEverywhere = site;
      els.blockingDialog.setAttribute("role", "alertdialog");
      els.blockingDialog.dataset.confirm = "clear-everywhere";
      els.blockingDialogTile.replaceChildren(this._glyph("sc-cookie"));
      els.blockingDialogTile.hidden = false;
      els.blockingDialogTitle.textContent = `Clear ${site} everywhere?`;
      els.blockingDialogBody.textContent =
        `This signs you out of ${site} in every Workspace.` +
        (rows.length
          ? ` It deletes ${total ? `${sizeOf(total)} of ` : ""}cookies and site data from ${places}.`
          : "");
      els.blockingDialogConfirm.textContent = "Clear and sign out";
      els.blockingDialogConfirm.dataset.tone = "danger";
      this._showBlockingDialog(this._siteEls.page);
      els.blockingDialogCancel.focus();
    },

    /**
     * Clears the site the confirm asked about in every jar. When part of it
     * fails, the rows still holding data after the read say so.
     */
    async confirmClearEverywhere() {
      const site = this._blockingView.clearEverywhere;
      this._blockingView.clearEverywhere = null;
      this._els.blockingDialog.close();
      if (!site) {
        return;
      }
      let failed;
      try {
        ({ failed } = await lazy.SvalSiteData.clearEverywhere(site));
      } catch (err) {
        lazy.SvalLog.warn(
          `clearing a site everywhere failed: ${lazy.SvalLog.errorName(err)}`
        );
        failed = true;
      }
      if (this._sitePage.site !== site) {
        return;
      }
      const marks = this._sitePage.failedJars;
      marks.clear();
      if (failed) {
        for (const row of lazy.SvalSiteData.jarsFor(site, this._siteNodes())) {
          for (const id of row.userContextIds) {
            marks.add(id);
          }
        }
      }
      this._afterSiteDataClear(["site-data-everywhere"]);
    },

    /**
     * Forget this site: what it does, and Forget…, which opens 8a. Dimmed
     * when the site holds nothing; absent in a private window, whose state
     * Forget never touches.
     *
     * @param {string} site
     * @returns {?Element}
     */
    _siteCardForget(site) {
      if (this._privateWindow) {
        return null;
      }
      const none = this._sitePage.held === false;
      const button = this._el(
        "button",
        {
          type: "button",
          className: "sval-button sval-site-forget",
          disabled: none,
          dataset: { svalKey: "site-forget" },
        },
        this._glyph("trash-2"),
        "Forget…"
      );
      // A Forget still running would drop the next one.
      if (this._siteForgetting) {
        button.setAttribute("aria-disabled", "true");
      }
      button.addEventListener("click", () => {
        if (!this._siteForgetting) {
          this._askForgetSite(site);
        }
      });
      return this._el(
        "section",
        {
          className: `sval-card sval-site-card${none ? " sval-site-forget-none" : ""}`,
          ariaLabelledby: "sval-site-forget-label",
          dataset: { siteCard: "forget" },
        },
        this._sitePageRow(
          "forget",
          this._el(
            "h2",
            { className: "sval-site-card-title" },
            "Forget this site"
          ),
          none
            ? "Nothing to forget."
            : `Clears everything Sval keeps for ${site}, in every Workspace.`,
          button
        )
      );
    },

    /**
     * @param {string} part From `SvalForgetSite.PARTS`.
     * @param {object} counts From `countsFor`.
     * @param {boolean} [waiting] Whether stored data is still being read.
     * @returns {?string} The part's figure in 8a: null for a part holding
     *   nothing, "" for Caches, which have no size of their own and are
     *   listed when the site stores data.
     */
    _forgetFigure(part, counts, waiting = false) {
      const n = counts[part];
      switch (part) {
        case "history":
          return n ? counted(n, "visit") : null;
        case "data":
          if (waiting || counts.dataJars === null) {
            return FORGET_COUNTING;
          }
          if (!counts.dataJars) {
            return null;
          }
          // A jar with cookies and no stored data has no size to show.
          return counts.dataBytes ? sizeOf(counts.dataBytes) : "Cookies only";
        case "caches":
          if (waiting || counts.dataBytes === null) {
            return FORGET_COUNTING;
          }
          return counts.dataBytes ? "" : null;
        default:
          return n ? String(n) : null;
      }
    },

    /**
     * Opens 8a, the confirm for forgetting the site, once its parts are
     * counted.
     *
     * @param {string} site
     */
    async _askForgetSite(site) {
      this._readSiteData();
      const at = this._siteDataReads;
      let counts;
      try {
        counts = await lazy.SvalForgetSite.countsFor(site);
      } catch (err) {
        lazy.SvalLog.warn(
          `counting a site to forget failed: ${lazy.SvalLog.errorName(err)}`
        );
        return;
      }
      const els = this._els;
      if (this._sitePage.site !== site || els.blockingDialog.open) {
        return;
      }
      this._blockingView.forget = { site, counts, at };
      els.blockingDialog.setAttribute("role", "alertdialog");
      els.blockingDialog.dataset.confirm = "forget";
      els.blockingDialogTile.replaceChildren(this._glyph("trash-2"));
      els.blockingDialogTile.hidden = false;
      els.blockingDialogTitle.textContent = `Forget ${site}?`;
      els.blockingDialogBody.textContent = "In every Workspace, this clears:";
      els.blockingDialogConfirm.textContent = `Forget ${site}`;
      els.blockingDialogConfirm.dataset.tone = "danger";
      this._drawForgetList();
      els.blockingDialogMore.hidden = false;
      this._showBlockingDialog(this._siteEls.page);
      els.blockingDialogCancel.focus();
      // A read that ended while this count ran found no 8a to count for.
      if (at !== this._siteDataReads) {
        this._countSite(site);
      }
    },

    /**
     * @param {object} view The confirm's, from `_blockingView.forget`.
     * @returns {boolean} Whether 8a's data figures wait for a read: one not
     *   yet answered, one the page asked for still running, or one that
     *   ended after the count began.
     */
    _forgetWaiting(view) {
      return (
        view.counts.dataJars === null ||
        this._siteDataReading > 0 ||
        view.at !== this._siteDataReads
      );
    },

    /**
     * 8a's list, in its two groups, and its foot line; the confirm waits
     * while stored data is still being counted, so Forget never runs on
     * figures it does not have. Drawn in place, so focus in the dialog
     * stays where it is.
     */
    _drawForgetList() {
      const view = this._blockingView.forget;
      const { counts } = view;
      const waiting = this._forgetWaiting(view);
      const groups = [
        ["every", "On every device", []],
        ["this", "On this device", []],
      ];
      for (const part of lazy.SvalForgetSite.PARTS) {
        const figure = this._forgetFigure(part, counts, waiting);
        if (figure === null) {
          continue;
        }
        groups[SYNCED_PARTS.has(part) ? 0 : 1][2].push(
          this._el(
            "li",
            { className: "sval-forget-row", dataset: { part } },
            this._el(
              "span",
              { className: "sval-forget-part" },
              FORGET_LABELS[part]
            ),
            this._el(
              "span",
              {
                className: "sval-forget-count",
                dataset: { counting: String(figure === FORGET_COUNTING) },
              },
              figure
            )
          )
        );
      }
      // Forget takes the choices of the site's hosts with its own
      // (`SvalForgetSite`), which the synced parts count, and names them.
      const hosts = this._siteHosts(view.site);
      if (hosts.length) {
        groups[0][2].push(
          this._el(
            "li",
            {
              className: "sval-forget-row",
              dataset: { part: "hosts" },
              title: hosts.join(", "),
            },
            this._el(
              "span",
              { className: "sval-forget-part" },
              `Choices for addresses on ${view.site}`
            ),
            this._el(
              "span",
              { className: "sval-forget-count" },
              counted(hosts.length, "host")
            )
          )
        );
      }
      const well = this._el("div", { className: "sval-forget-well" });
      for (const [device, head, rows] of groups) {
        if (rows.length) {
          well.append(
            this._el(
              "div",
              { className: "sval-forget-group", dataset: { device } },
              this._el("p", { className: "sval-forget-subhead" }, head),
              this._el("ul", { className: "sval-forget-rows" }, ...rows)
            )
          );
        }
      }
      this._els.blockingDialogMore.replaceChildren(
        well,
        this._el(
          "p",
          { className: "sval-forget-foot" },
          "Sval removes the synced parts from your other devices too. You can't undo this."
        )
      );
      const confirm = this._els.blockingDialogConfirm;
      if (waiting) {
        confirm.setAttribute("aria-disabled", "true");
      } else {
        confirm.removeAttribute("aria-disabled");
      }
    },

    /**
     * Forgets the site 8a asked about, once every count is in.
     */
    async confirmForgetSite() {
      const view = this._blockingView.forget;
      if (!view || this._forgetWaiting(view)) {
        return;
      }
      this._blockingView.forget = null;
      this._els.blockingDialog.close();
      await this._runForget(view.site, view.counts, lazy.SvalForgetSite.PARTS);
    },

    /**
     * Forgets the named parts of the site. What failed goes in the note
     * above the cards, which offers to try those again; when nothing
     * failed, the page says the site is forgotten and focus goes to its
     * name.
     *
     * @param {string} site
     * @param {object} counts From `countsFor`, for the note's figures.
     * @param {string[]} parts
     */
    async _runForget(site, counts, parts) {
      if (this._siteForgetting) {
        return;
      }
      this._siteForgetting = true;
      this._drawSitePage();
      let failed;
      try {
        ({ failed } = await lazy.SvalForgetSite.retry(site, parts));
      } catch (err) {
        lazy.SvalLog.warn(
          `forgetting a site failed: ${lazy.SvalLog.errorName(err)}`
        );
        failed = parts.map(part => ({ part, reason: "disk" }));
      } finally {
        this._siteForgetting = false;
      }
      if (this._sitePage.site !== site) {
        return;
      }
      this._sitePage.failed = failed.length ? { failed, counts } : null;
      this._drawForgetAlert();
      this._countSite(site);
      this._drawSitePage();
      const els = this._siteEls;
      if (failed.length) {
        els.alert.querySelector("button").focus();
        return;
      }
      els.title.focus({ preventScroll: true });
      // Emptied first, in a task of its own, so the same words are read
      // again after a second Forget.
      els.status.textContent = "";
      setTimeout(() => {
        els.status.textContent = `${site} forgotten`;
      });
    },

    /** The note above the cards naming each part a Forget left. */
    _drawForgetAlert() {
      const page = this._sitePage;
      const els = this._siteEls;
      els.alert.hidden = !page.failed;
      if (!page.failed) {
        els.alert.replaceChildren();
        return;
      }
      const { failed, counts } = page.failed;
      const n = failed.length;
      const title =
        n === 1
          ? `One part of ${page.site} wasn't forgotten`
          : `${NUMBER_WORDS[n - 1] ?? n} parts of ${page.site} weren't forgotten`;
      const again = this._el(
        "button",
        { type: "button", className: "sval-button sval-agent-small" },
        "Try again"
      );
      const site = page.site;
      again.addEventListener("click", () =>
        this._runForget(
          site,
          counts,
          failed.map(({ part }) => part)
        )
      );
      els.alert.replaceChildren(
        this._glyph("sc-alert"),
        this._el(
          "div",
          { className: "sval-site-alert-words" },
          this._el("p", { className: "sval-site-alert-title" }, title),
          this._el(
            "ul",
            { className: "sval-site-alert-lines" },
            ...failed.map(({ part }) => {
              const figure = this._forgetFigure(part, counts);
              return this._el(
                "li",
                { className: "sval-site-alert-line", dataset: { part } },
                this._el("span", {}, FORGET_LABELS[part]),
                ...(figure ? [this._el("span", {}, figure)] : []),
                this._el(
                  "span",
                  { className: "sval-site-alert-reason" },
                  FORGET_REASON
                )
              );
            })
          )
        ),
        again
      );
    },
  };

  Object.assign(window.SvalSettings, SvalSitePage);
}
