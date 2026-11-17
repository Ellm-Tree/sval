/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The Sites category's list (decision 1484): every site with a choice, in
 * `SvalSiteProtections`, a JavaScript rule of its own, a permission, an
 * extension switch or a line in My filters, each row saying what differs from the defaults, with
 * search, a filter, Add site and a reset per site. A row leads to the site's
 * own page (`settings-site-page.js`), where its choices are made.
 *
 * `SvalPreferences` loads this as a classic script after `settings.js`; it
 * adds its methods to `SvalSettings`.
 */

"use strict";

{
  const { counted } = window.SvalSettingsHelpers;
  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    MEDIA_CHOICES:
      "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs",
    MEDIA_DEFAULT_PREF:
      "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs",
    SITE_BRANCH:
      "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs",
    SvalJavascript: "moz-src:///browser/components/sval/SvalJavascript.sys.mjs",
    SvalExtensionSites:
      "moz-src:///browser/components/sval/SvalExtensionSites.sys.mjs",
    permissionsBySite:
      "moz-src:///browser/components/sval/SvalSitePermissionList.sys.mjs",
    permissionPhrase:
      "moz-src:///browser/components/sval/SvalSitePermissionList.sys.mjs",
    siteOrigins: "moz-src:///browser/components/sval/SvalSite.sys.mjs",
    STYLES_PREF: "moz-src:///browser/components/sval/SvalSiteStyles.sys.mjs",
    removeStyles: "moz-src:///browser/components/sval/SvalSiteStyles.sys.mjs",
    setStyle: "moz-src:///browser/components/sval/SvalSiteStyles.sys.mjs",
    styleAt: "moz-src:///browser/components/sval/SvalSiteStyles.sys.mjs",
    styles: "moz-src:///browser/components/sval/SvalSiteStyles.sys.mjs",
    SvalBlocking: "moz-src:///browser/components/sval/SvalBlocking.sys.mjs",
    SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
    SvalSiteProtections:
      "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs",
    appendLines: "moz-src:///browser/components/sval/SvalElementRules.sys.mjs",
    exceptionLine:
      "moz-src:///browser/components/sval/SvalElementRules.sys.mjs",
    exceptionsInFilters:
      "moz-src:///browser/components/sval/SvalElementRules.sys.mjs",
    forgetSite: "moz-src:///browser/components/sval/SvalElementRules.sys.mjs",
    linesBySite: "moz-src:///browser/components/sval/SvalElementRules.sys.mjs",
    linesForScope:
      "moz-src:///browser/components/sval/SvalElementRules.sys.mjs",
    removeSiteFromLine:
      "moz-src:///browser/components/sval/SvalElementRules.sys.mjs",
    showAgain: "moz-src:///browser/components/sval/SvalElementRules.sys.mjs",
    scopeOfHost: "moz-src:///browser/components/sval/SvalSite.sys.mjs",
    scopesInFilters:
      "moz-src:///browser/components/sval/SvalElementRules.sys.mjs",
    siteOfEntry: "moz-src:///browser/components/sval/SvalSite.sys.mjs",
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
  // `SvalFingerprinting.sys.mjs` exports functions rather than one object of that
  // name, so it is imported as a namespace.
  ChromeUtils.defineLazyGetter(lazy, "SvalFingerprinting", () =>
    ChromeUtils.importESModule(
      "moz-src:///browser/components/sval/SvalFingerprinting.sys.mjs"
    )
  );

  /** How many sites the Sites card shows before "Show N more". */
  const SITES_SHOWN = 8;

  /** The Sites card's filter. */
  const SITE_FILTERS = [
    ["all", "All sites"],
    ["off", "All protections off"],
    ["fingerprinting", "Fingerprinting protection off"],
    ["exceptions", "Fingerprinting exceptions"],
    ["hidden", "Removed elements"],
    ["js-allow", "JavaScript allowed"],
    ["js-block", "JavaScript blocked"],
    ["permissions", "With permissions"],
    ["extensions", "With extension switches"],
  ];

  /** A site's Protections choice. */
  const SITE_PROTECTIONS = [
    ["on", "All protections on"],
    ["full", "All protections on, without Mozilla's fix"],
    ["fingerprinting", "Fingerprinting protection off"],
    ["off", "All protections off"],
  ];

  const SvalSitesSettings = {
    /**
     * The Sites card's view: its search and filter, whether the add row is
     * open and what it holds, how many rows show, and the last change with
     * its Undo.
     */
    _sitesView: {
      q: "",
      filt: "all",
      showAll: false,
      adding: null,
      msg: "",
      undo: null,
    },

    /**
     * Finds and wires the Sites card.
     *
     * @param {Function} byId Finds one of the page's elements by id.
     * @param {Function} followPref Observes a pref until the page goes.
     * @param {Function} followTopic Observes a topic until the page goes.
     */
    _initSites(byId, followPref, followTopic) {
      Object.assign(this._els, {
        sitesSync: byId("sval-sites-sync"),
        sitesTools: byId("sval-sites-tools"),
        sitesBody: byId("sval-sites-body"),
        sitesStatus: byId("sval-sites-status"),
        sitesFound: byId("sval-sites-found"),
      });
      // The site choices move from the protection button, the JavaScript
      // button and from sync. These are the prefs the list reads.
      const sitesPref = () => this._describeSites();
      for (const name of [
        lazy.SITE_BRANCH,
        lazy.MEDIA_DEFAULT_PREF,
        lazy.EXTENSION_SITE_BRANCH,
        lazy.STYLES_PREF,
        ...lazy.SvalJavascript.PREFS,
      ]) {
        followPref(name, sitesPref);
      }
      followTopic(lazy.SvalSiteProtections.PRIVATE_TOPIC, sitesPref);
      // A permission a private window holds is never listed.
      followTopic("perm-changed", (subject, topic, data) => {
        if (
          data === "cleared" ||
          !subject?.QueryInterface(Ci.nsIPermission).principal.privateBrowsingId
        ) {
          sitesPref();
        }
      });
    },

    /**
     * The Sites list: one row per site with a choice, saying what differs
     * from the defaults, each leading to the site's page, where the choices
     * are made. In a private window it shows that window's choices
     * (`_siteSession`), as the protection button does there.
     *
     * @param {?(string|string[])} [next] Where focus goes when the redraw
     *   takes away the control that had it (`_keepFocus`).
     * @param {boolean} [take] As for `_keepFocus`.
     */
    _describeSites(next = null, take = false) {
      const sync = this._els.sitesSync;
      sync.textContent =
        "These are your choices for each site, including the ones you made with the protection button in the address bar. They sync to all your devices.";
      if (this._privateWindow) {
        sync.textContent =
          "These are your choices for each site in this window, including the ones you made with the protection button in the address bar. They last until you close this window and never sync.";
      } else if (this.panel && this.panel.folderState === "none") {
        sync.textContent =
          "These are your choices for each site, including the ones you made with the protection button in the address bar. Sync is off, so they stay on this device.";
      }

      const rules = this._siteRules();
      this._keepFocus(
        this._els.sitesBody.closest(".sval-card"),
        () => this._drawSites(rules),
        next,
        take
      );
    },

    /**
     * Every site and host the list shows: those with a stored choice, and
     * those with a JavaScript rule, a permission, an extension switch or
     * lines in My filters, which have no choice of `SvalSiteProtections`'
     * own. A host's site is listed too, since its row holds the host's
     * (decision 1980).
     *
     * @returns {Map<string, object>} The stored choices, by site or host.
     */
    _siteRules() {
      const rules = lazy.SvalBlocking.myFilters;
      this._sitesFilters = rules;
      const all = lazy.SvalSiteProtections.rules(this._siteSession);
      this._sitesPermissions = lazy.permissionsBySite();
      this._sitesJavascript = lazy.SvalJavascript.rules();
      this._sitesStyles = new Set(lazy.styles().map(style => style.scope));
      // A `#@#` line is a choice of the host it names alone: under a line
      // hiding the element on its site, it shows the element there again.
      this._sitesShown = new Map(
        [...lazy.exceptionsInFilters(rules)].filter(
          ([name]) => lazy.siteOfEntry(name).site !== name
        )
      );
      for (const name of [
        ...lazy.scopesInFilters(rules),
        ...this._sitesShown.keys(),
        ...lazy.SvalExtensionSites.names(),
        ...this._sitesJavascript.keys(),
        ...this._sitesStyles,
        ...this._sitesPermissions.keys(),
      ]) {
        if (!all.has(name)) {
          all.set(name, {});
        }
      }
      for (const name of [...all.keys()]) {
        const { site } = lazy.siteOfEntry(name);
        if (!site) {
          all.delete(name);
        } else if (!all.has(site)) {
          all.set(site, {});
        }
      }
      return all;
    },

    /**
     * @param {Map<string, object>} rules From `_siteRules`.
     * @returns {{sites: string[], hostsOf: Map<string, string[]>}} The
     *   sites by name, and each site's hosts by name.
     */
    _siteGroups(rules) {
      const sites = [];
      const hostsOf = new Map();
      for (const name of [...rules.keys()].sort()) {
        const { site } = lazy.siteOfEntry(name);
        if (site === name) {
          sites.push(name);
        } else {
          hostsOf.set(site, [...(hostsOf.get(site) ?? []), name]);
        }
      }
      return { sites, hostsOf };
    },

    /**
     * The Sites card: its tools, then the add row, the list and the status
     * line.
     *
     * @param {Map<string, object>} rules
     */
    _drawSites(rules) {
      const view = this._sitesView;
      const body = this._els.sitesBody;
      this._els.sitesTools.replaceChildren(this._siteTools());
      body.textContent = "";
      if (view.adding) {
        body.append(this._siteAddRow());
      }

      if (!rules.size) {
        body.append(
          this._emptyState(
            "No site choices yet",
            "Sites appear here when you make a choice for one, such as its protections, JavaScript, or a permission."
          )
        );
      } else {
        body.append(this._siteList(rules));
      }
      this._placeSiteResults(rules);

      const undo = view.undo;
      this._say(
        this._els.sitesStatus,
        view.msg,
        undo &&
          (() => {
            this._sitesView = { ...this._sitesView, msg: "", undo: null };
            this._restoreSite(undo);
            this._describeSites([`site-link:${undo.site}`, "sites-search"]);
          }),
        "sites-undo"
      );
    },

    /** @returns {Element} The search field, the filter and Add site. */
    _siteTools() {
      const view = this._sitesView;
      const search = this._el("input", {
        type: "search",
        id: "sval-sites-search",
        className: "sval-agent-search",
        placeholder: "Find a site",
        ariaLabel: "Find a site",
        spellcheck: false,
        value: view.q,
        dataset: { svalKey: "sites-search" },
      });
      search.addEventListener("input", () => {
        this._sitesView.q = search.value;
        const rules = this._siteRules();
        const list = this._els.sitesBody.querySelector(".sval-sites-list");
        list?.replaceWith(this._siteList(rules));
        this._placeSiteResults(rules);
      });
      const filter = this._el("select", {
        id: "sval-sites-filter",
        className: "sval-agent-select",
        dataset: { svalKey: "sites-filter" },
      });
      for (const [value, text] of [
        ...SITE_FILTERS,
        ...lazy.MEDIA_CHOICES.map(([choice, words]) => [
          choice,
          `Video and audio: ${words}`,
        ]),
      ]) {
        filter.append(this._el("option", { value }, text));
      }
      filter.value = view.filt;
      filter.addEventListener("change", () => {
        this._sitesView.filt = filter.value;
        this._describeSites();
      });
      const add = this._el(
        "button",
        {
          type: "button",
          className: "sval-button sval-agent-small",
          dataset: { svalKey: "add-site" },
        },
        "Add site"
      );
      add.addEventListener("click", () => {
        this._sitesView.adding = { text: "" };
        this._describeSites();
        this._els.sitesBody.querySelector(".sval-agent-add-input")?.focus();
      });
      return this._el(
        "div",
        { className: "sval-agent-tools" },
        this._el(
          "span",
          { className: "sval-agent-search-box" },
          this._glyph("search"),
          search
        ),
        this._el(
          "span",
          { className: "sval-sites-filter" },
          this._el(
            "label",
            { className: "sval-sites-filter-label", htmlFor: filter.id },
            "Show"
          ),
          filter
        ),
        add
      );
    },

    /**
     * @param {Map<string, object>} rules
     * @returns {Element} The rows that match the search and filter, by name.
     */
    _siteList(rules) {
      const view = this._sitesView;
      const q = view.q.trim().toLowerCase();
      const byFilterSite = lazy.linesBySite(lazy.SvalBlocking.myFilters);
      const { sites, hostsOf } = this._siteGroups(rules);
      // A row holds only the lines saved for its own name.
      const linesOf = name =>
        (byFilterSite.get(lazy.siteOfEntry(name).site) ?? []).filter(
          entry => entry.scope === name
        );
      const kept = site => {
        const rule = rules.get(site);
        switch (view.filt) {
          case "hidden":
            return !!linesOf(site).length;
          case "off":
          case "fingerprinting":
            return rule.protections === view.filt;
          case "exceptions":
            return (
              (!rule.protections || rule.protections === "full") &&
              !!rule.exceptions
            );
          case "ask":
          case "allow":
          case "block":
            return rule.media === view.filt;
          case "js-allow":
          case "js-block":
            return this._sitesJavascript.get(site) === view.filt.slice(3);
          case "permissions":
            return this._sitesPermissions.has(site);
          case "extensions":
            return !!this._siteSwitches(site).length;
          default:
            return true;
        }
      };
      const matching = name => (!q || name.includes(q)) && kept(name);
      // A site shows when it or one of its hosts matches, and a host under
      // its site when it matches itself.
      const hostsShown = new Map(
        sites.map(site => [site, (hostsOf.get(site) ?? []).filter(matching)])
      );
      const matches = sites.filter(
        site => matching(site) || hostsShown.get(site).length
      );
      const filtering = !!q || view.filt !== "all";
      // `_placeSiteResults` says how many sites match, of how many.
      this._siteListMatches = matches.length;
      this._siteListTotal = sites.length;
      const shown =
        filtering || view.showAll ? matches : matches.slice(0, SITES_SHOWN);

      const wrap = this._el("div", { className: "sval-sites-list" });
      // A plain list, as Firefox's own preference lists are
      // (`moz-box-group`): every row's controls are reached by Tab, and a
      // host's `aria-level` tells assistive technology it sits under its
      // site.
      const list = this._el("ul", {
        className: "sval-sites-rows",
        ariaLabel: "Your sites",
      });
      for (const site of shown) {
        const hosts = hostsOf.get(site) ?? [];
        list.append(
          this._siteRow(site, rules.get(site), linesOf(site), {
            hosts: hosts.length,
          })
        );
        for (const host of hostsShown.get(site)) {
          list.append(
            this._siteRow(host, rules.get(host), linesOf(host), { site })
          );
        }
      }
      wrap.append(list);
      if (!matches.length) {
        const clear = this._el(
          "button",
          {
            type: "button",
            className: "sval-link",
            dataset: { svalKey: "sites-clear" },
          },
          "Clear"
        );
        clear.addEventListener("click", () => {
          this._sitesView = { ...this._sitesView, q: "", filt: "all" };
          this._describeSites("sites-search");
        });
        wrap.append(
          this._el(
            "div",
            { className: "sval-agent-nomatch" },
            this._el(
              "span",
              {},
              q
                ? `No sites match "${view.q.trim()}".`
                : "No sites of this kind."
            ),
            clear
          )
        );
      }
      if (matches.length > shown.length) {
        const more = this._el(
          "button",
          {
            type: "button",
            className: "sval-link sval-agent-more",
            dataset: { svalKey: "sites-more" },
          },
          `Show ${matches.length - shown.length} more`
        );
        // The first row it shows takes its place.
        const first = matches[shown.length];
        more.addEventListener("click", () => {
          this._sitesView.showAll = true;
          this._describeSites([`site-link:${first}`, "sites-search"]);
        });
        wrap.append(more);
      }
      return wrap;
    },

    /**
     * @param {string} site
     * @param {string} key The link's `data-sval-key`.
     * @returns {Element} The site's name, leading to its page.
     */
    _siteLink(site, key) {
      const link = this._el(
        "a",
        {
          className: "sval-sites-link",
          href: `#svalSites-site?${new URLSearchParams({ host: site })}`,
          dataset: { svalKey: key },
        },
        this._el("span", { className: "sval-agent-site", title: site }, site)
      );
      link.addEventListener("click", event => {
        event.preventDefault();
        this.showSite(site);
      });
      return link;
    },

    /**
     * @param {string} host
     * @param {string} site The host's site.
     * @param {string} key The link's `data-sval-key`.
     * @returns {Element} The host's name, its site's part muted, leading to
     *   its site's page at the host's scope.
     */
    _hostLink(host, site, key) {
      const link = this._el(
        "a",
        {
          className: "sval-sites-link",
          href: `#svalSites-site?${new URLSearchParams({ host: site, scope: host })}`,
          dataset: { svalKey: key },
        },
        this._el(
          "span",
          { className: "sval-agent-site", title: host },
          host.slice(0, -site.length - 1),
          this._el("span", { className: "sval-sites-host-site" }, `.${site}`)
        )
      );
      link.addEventListener("click", event => {
        event.preventDefault();
        this.showSite(site, { scope: host });
      });
      return link;
    },

    /**
     * One site's row: its name, which leads to its page, a line saying what
     * differs from the defaults, and Reset. The rest of the row opens the
     * page too.
     *
     * A host's row sits under its site's and says only what the host
     * chose itself; its Reset takes those alone, and a site's Reset leaves
     * its hosts' choices (host-scoped rules spec §5).
     *
     * @param {string} name A site, or a host under one.
     * @param {object} rule
     * @param {Array<{line: string}>} lines The lines in My filters saved
     *   for `name` itself.
     * @param {object} where
     * @param {string} [where.site] For a host, its site.
     * @param {number} [where.hosts] For a site, how many hosts it lists.
     * @returns {Element}
     */
    _siteRow(name, rule, lines, { site = null, hosts = 0 }) {
      const isPrivate = this._privateWindow;
      const summaryId = `sval-sites-summary-${name}`;
      const shown = this._sitesShown.get(name) ?? [];
      const differences = this._siteDifferences(name, rule, lines, shown);
      const link = site
        ? this._hostLink(name, site, `site-link:${name}`)
        : this._siteLink(name, `site-link:${name}`);
      link.setAttribute("aria-describedby", summaryId);
      const own = differences.length || !hosts;
      const row = this._el(
        "li",
        {
          className: "sval-sites-row",
          ariaLevel: site ? "2" : "1",
          dataset: site ? { site: name, parent: site } : { site: name },
        },
        this._el(
          "span",
          { className: "sval-agent-words" },
          link,
          this._el(
            "span",
            {
              className: "sval-agents-note sval-sites-summary",
              id: summaryId,
              dataset: {
                differs: differences.map(([key]) => key).join(" "),
                ...(own ? {} : { own: "none" }),
              },
            },
            own
              ? differences.map(([, words]) => words).join(" · ")
              : `Choices only for addresses on ${name}`
          )
        )
      );
      // A private window's choices are its own, and the stored ones show
      // there and are not reset from it; a permission the defaults file
      // grants is no choice to reset.
      const resettable =
        !!Object.keys(rule).length ||
        (!isPrivate &&
          (this._sitesJavascript.has(name) ||
            this._sitesStyles.has(name) ||
            !!lines.length ||
            !!shown.length ||
            !!this._siteSwitches(name).length ||
            (this._sitesPermissions.get(name) ?? []).some(p => !p.isDefault)));
      const cell = this._el("span", { className: "sval-sites-reset-cell" });
      if (resettable) {
        let title = `Puts ${name} back to the defaults. Cookies and logins stay.`;
        if (site) {
          title = `Removes the choices for ${name}. Everything comes from ${site} again.`;
        } else if (hosts) {
          title = `Puts ${name} back to the defaults. Addresses on ${name} keep their choices. Cookies and logins stay.`;
        }
        const reset = this._el(
          "button",
          {
            type: "button",
            className: "sval-button sval-agent-small sval-sites-reset",
            ariaLabel: `Reset ${name}`,
            title,
            dataset: { svalKey: `remove-site:${name}` },
          },
          "Reset"
        );
        reset.addEventListener("click", () => {
          if (lines.length && !isPrivate) {
            this._askResetSite(name);
            return;
          }
          this._resetChoices(name);
        });
        cell.append(reset);
      }
      row.append(cell, this._glyph("sc-next", "sval-sites-chevron"));
      row.addEventListener("click", event => {
        if (!event.target.closest("button, a")) {
          link.click();
        }
      });
      return row;
    },

    /**
     * @param {string} site
     * @param {object} rule
     * @param {Array<{line: string}>} lines
     * @param {string[]} [shown] For a host, the selectors it shows again.
     * @returns {Array<[string, string]>} What differs from the defaults on
     *   the site, each as a key naming the setting and its value, and a
     *   phrase: protections, fingerprinting exceptions, video and audio,
     *   JavaScript, Colorshift, each permission, removed elements, each
     *   extension switch,
     *   then elements shown again. A permission held by another origin under the site names its
     *   host.
     */
    _siteDifferences(site, rule, lines, shown = []) {
      const words = [];
      const protections = new Map(SITE_PROTECTIONS).get(rule.protections);
      if (protections && rule.protections !== "on") {
        words.push([`protections:${rule.protections}`, protections]);
      }
      if (rule.exceptions?.length) {
        const chosen = lazy.SvalFingerprinting.SITE_EXCEPTIONS.filter(e =>
          rule.exceptions.includes(e.id)
        );
        words.push([
          `exceptions:${chosen.map(e => e.id).join(",")}`,
          `Fingerprinting exceptions: ${chosen.map(e => e.label).join(", ")}`,
        ]);
      }
      if (rule.insecure) {
        words.push([
          "insecure",
          "Opens without a warning when it isn't secure",
        ]);
      }
      if (rule.media) {
        const media = new Map(lazy.MEDIA_CHOICES).get(rule.media);
        words.push([
          `media:${rule.media}`,
          `Video and audio: ${media.toLowerCase()}`,
        ]);
      }
      const js = this._sitesJavascript.get(site);
      if (js) {
        words.push([
          `javascript:${js}`,
          js === "allow" ? "JavaScript allowed" : "JavaScript blocked",
        ]);
      }
      if (this._sitesStyles.has(site)) {
        words.push(["style", "Colorshift"]);
      }
      const own = new Set(
        lazy.siteOrigins(site, ["https", "http"]).map(uri => uri.prePath)
      );
      for (const perm of this._sitesPermissions.get(site) ?? []) {
        const principal = perm.principal;
        const host = own.has(principal.originNoSuffix) ? null : principal.host;
        words.push([
          `${perm.type}:${perm.capability}${host ? `@${host}` : ""}${
            perm.isDefault ? ":default" : ""
          }`,
          lazy.permissionPhrase(perm, host),
        ]);
      }
      if (lines.length) {
        words.push([
          `removed:${lines.length}`,
          counted(lines.length, "removed element"),
        ]);
      }
      for (const [id, state] of this._siteSwitches(site)) {
        const extension = WebExtensionPolicy.getByID(id)?.name ?? id;
        words.push([`extension:${id}:${state}`, `${extension} ${state}`]);
      }
      if (shown.length) {
        words.push([
          `shown:${shown.length}`,
          counted(shown.length, "element shown again"),
        ]);
      }
      return words;
    },

    /**
     * The row that adds a site: it asks for the address, read as a site
     * (`siteOfEntry`), and opens that site's page, where its choices are
     * made.
     *
     * @returns {Element}
     */
    _siteAddRow() {
      const adding = this._sitesView.adding;
      const input = this._el("input", {
        type: "text",
        className: "sval-agent-add-input",
        id: "sval-sites-add-input",
        placeholder: "ebay.co.uk",
        spellcheck: false,
        value: adding.text,
        dataset: { svalKey: "adding-site" },
      });
      const confirm = this._el(
        "button",
        {
          type: "button",
          className: "sval-button sval-button-primary sval-agent-small",
          dataset: { svalKey: "adding-site-add" },
        },
        "Add"
      );
      const cancel = this._el(
        "button",
        {
          type: "button",
          className: "sval-button sval-agent-small",
          dataset: { svalKey: "adding-site-cancel" },
        },
        "Cancel"
      );
      const preview = this._el("div", {
        className: "sval-agent-preview",
        id: "sval-sites-add-preview",
        ariaLive: "polite",
      });
      input.setAttribute("aria-describedby", preview.id);
      const reading = () =>
        lazy.siteOfEntry(this._sitesView.adding?.text ?? "");
      const scopeOf = read => lazy.scopeOfHost(read.host);
      const describe = () => {
        const read = reading();
        confirm.disabled = !read.site;
        input.setAttribute(
          "aria-invalid",
          String(read.error !== "empty" && !read.site)
        );
        let words;
        if (read.error === "empty") {
          words = "Type a site, or paste an address.";
        } else if (read.error) {
          words = "Enter a site like ebay.co.uk, or paste an address.";
        } else if (scopeOf(read).choice) {
          words = `Covers ${read.host} and every address under it. Everything else comes from ${read.site}.`;
        } else {
          words = `Covers ${read.site} and every address under it.`;
        }
        preview.textContent = words;
      };
      const add = () => {
        const read = reading();
        if (!read.site) {
          return;
        }
        this._sitesView = { ...this._sitesView, adding: null };
        this._describeSites();
        // A host with a choice of its own opens at its scope on its site's
        // page (host-scoped rules spec §5).
        const scope = scopeOf(read);
        this.showSite(read.site, scope.choice ? { scope: scope.host } : {});
      };
      const close = () => {
        this._sitesView.adding = null;
        this._describeSites("add-site", true);
      };
      input.addEventListener("input", () => {
        this._sitesView.adding = { text: input.value };
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
          className: "sval-agent-adding",
          role: "group",
          ariaLabel: "Add a site",
        },
        this._fieldLabel(input, "Site or address"),
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
     * One of a site's lines in My filters: the rule, what it does when it
     * stops a download, and Show again, which a private window leaves out.
     *
     * @param {string} site
     * @param {{line: string, kind: string, shown: string}} entry
     * @param {number} at The row's place in the list.
     * @param {Function} showAgain Takes the site out of the line.
     * @returns {Element}
     */
    _hiddenRow(site, entry, at, showAgain) {
      const words = this._el(
        "span",
        { className: "sval-sites-hidden-words-col" },
        this._el(
          "span",
          { className: "sval-sites-hidden-rule", title: entry.line },
          entry.shown
        )
      );
      if (entry.kind === "network") {
        words.append(
          this._el(
            "span",
            { className: "sval-agents-note sval-sites-hidden-sub" },
            "Stops a download"
          )
        );
      }
      const row = this._el(
        "div",
        { className: "sval-sites-hidden-row", dataset: { kind: entry.kind } },
        words
      );
      if (!this._privateWindow) {
        const show = this._el(
          "button",
          {
            type: "button",
            className: "sval-button sval-agent-small sval-sites-hidden-show",
            ariaLabel: `Show ${entry.shown} again`,
            dataset: { svalKey: `hidden-show:${site}:${at}` },
          },
          "Show again"
        );
        show.addEventListener("click", showAgain);
        row.append(show);
      }
      return row;
    },

    /**
     * @param {Function} open
     * @returns {Element} The link to My filters.
     */
    _hiddenOpenLink(open) {
      const link = this._el(
        "button",
        { type: "button", className: "sval-link sval-sites-hidden-open" },
        "Open in My filters",
        this._glyph("external-link")
      );
      link.addEventListener("click", open);
      return link;
    },

    /**
     * Takes the entry's site or host out of one of its lines in My
     * filters. The line is found again by its text, so a change made
     * elsewhere since the card drew cannot make this delete another line.
     * Focus goes to the row that takes the deleted one's place, the one
     * before it, or the disclosure.
     *
     * @param {string} site The name the row's keys carry.
     * @param {{line: string, scope: string}} entry
     * @param {number} at The row's place in the list.
     * @param {Function} redraw Redraws the list the row was in, given the
     *   keys of the rows focus may go to (`_keepFocus`).
     */
    _showAgain(site, entry, at, redraw) {
      const next = lazy.showAgain(
        lazy.SvalBlocking.myFilters,
        entry.line,
        entry.scope
      );
      if (next !== null) {
        try {
          lazy.SvalBlocking.setMyFilters(next);
        } catch (err) {
          lazy.SvalLog.warn(
            `could not show a rule again: ${lazy.SvalLog.errorName(err)}`
          );
          return;
        }
      }
      redraw([`hidden-show:${site}:${at}`, `hidden-show:${site}:${at - 1}`]);
    },

    /**
     * Shows My filters, in Privacy and protection, where the lines can be
     * edited.
     *
     * @param {string} [line] A line to select, if the field holds it.
     */
    async _openMyFilters(line) {
      await window.gotoPref("privacy");
      const field = this._els.myFiltersText;
      this._openAdvanced(field);
      field.scrollIntoView();
      field.focus();
      const start = line ? `\n${field.value}\n`.indexOf(`\n${line}\n`) : -1;
      if (start !== -1) {
        field.setSelectionRange(start, start + line.length);
      }
    },

    /**
     * Opens the confirmation for resetting a site that has lines in My
     * filters (site page design 8b); with none, resets it at once.
     *
     * @param {string} site
     */
    _askResetSite(site) {
      const els = this._els;
      const count = lazy.linesForScope(
        lazy.SvalBlocking.myFilters,
        site
      ).length;
      if (!count) {
        this._resetChoices(site);
        return;
      }
      const exceptions =
        lazy.SvalSiteProtections.rules(this._siteSession).get(site)?.exceptions
          ?.length ?? 0;
      this._blockingView.reset = site;
      els.blockingDialog.dataset.confirm = exceptions
        ? "reset-with-exceptions"
        : "reset";
      els.blockingDialog.setAttribute("role", "alertdialog");
      els.blockingDialogTile.hidden = false;
      els.blockingDialogTitle.textContent = `Reset ${site}?`;
      els.blockingDialogBody.textContent =
        (exceptions
          ? "Its choices and its fingerprinting exceptions go"
          : "Its choices go") +
        " back to the defaults, and " +
        (count === 1
          ? "its 1 removed-element rule is"
          : `its ${count} removed-element rules are`) +
        " deleted from My filters.";
      els.blockingDialogMore.replaceChildren(
        this._el(
          "p",
          { className: "sval-reset-keep" },
          this._glyph("check"),
          "Cookies, logins and site data stay. You stay signed in."
        )
      );
      els.blockingDialogMore.hidden = false;
      els.blockingDialogConfirm.textContent = `Reset and delete ${counted(count, "rule")}`;
      els.blockingDialogConfirm.dataset.tone = "danger";
      this._showBlockingDialog(els.sitesBody);
      els.blockingDialogCancel.focus();
    },

    /** Resets the site the confirmation asked about, lines and all. */
    confirmResetSite() {
      const site = this._blockingView.reset;
      this._blockingView.reset = null;
      this._els.blockingDialog.close();
      if (!site) {
        return;
      }
      const { text, removed } = this._withoutOwnLines(
        lazy.SvalBlocking.myFilters,
        site
      );
      if (removed) {
        try {
          lazy.SvalBlocking.setMyFilters(text);
        } catch (err) {
          lazy.SvalLog.warn(
            `could not delete a site's rules: ${lazy.SvalLog.errorName(err)}`
          );
          return;
        }
      }
      this._resetChoices(site, removed > 0);
    },

    /**
     * The text with `name` taken out of each line saved for it, leaving the
     * lines of the hosts under a site and of the site above a host.
     *
     * @param {string} text
     * @param {string} name A site or a host.
     * @returns {{text: string, removed: number}}
     */
    _withoutOwnLines(text, name) {
      const lines = lazy.linesForScope(text, name);
      // Newest first is last in the text first, so each edit leaves the
      // index of the next one where it was.
      for (const { index } of lines) {
        text = lazy.removeSiteFromLine(text, index, name);
      }
      return { text, removed: lines.length };
    },

    /**
     * Puts a site's or a host's choices back to the defaults: its
     * `SvalSiteProtections` choices, and, outside a private window, its
     * JavaScript rule, its Colorshift style, its permissions, its extension
     * switches and a
     * host's lines in My filters showing an element again, which are stored
     * ones. The status line offers Undo, which takes the focus.
     *
     * @param {string} site
     * @param {boolean} [deletedLines] Whether its lines went too, which
     *   Undo cannot bring back, so there is no Undo.
     */
    _resetChoices(site, deletedLines = false) {
      const before = this._siteSnapshot(site);
      lazy.SvalSiteProtections.setRule(site, null, this._siteSession);
      if (!this._privateWindow) {
        lazy.SvalJavascript.removeRule(site);
        lazy.removeStyles([site]);
        for (const perm of lazy.permissionsBySite().get(site) ?? []) {
          if (!perm.isDefault) {
            Services.perms.removePermission(perm);
          }
        }
        // Each tab of the name loads again, as after a switch on the site's
        // page, so an extension's scripts go or run there.
        if (before.switches.length) {
          lazy.SvalExtensionSites.removeAll(site);
          lazy.SvalExtensionSites.reloadSite(site);
        }
        // A host has no line hiding an element left here, since the
        // confirm took them, so `forgetSite`, which reads a host's name as
        // that name alone, takes only its `#@#` lines.
        if (before.shown.length) {
          this._writeFilters(
            lazy.forgetSite(lazy.SvalBlocking.myFilters, site).text
          );
        }
      }
      this._sitesView = {
        ...this._sitesView,
        msg: `Reset ${site}.`,
        undo: deletedLines ? null : before,
      };
      this._describeSites(["sites-undo", "sites-search"], true);
    },

    /**
     * @param {string} site
     * @returns {object} What `_restoreSite` needs to put the site's choices
     *   back as they are now.
     */
    _siteSnapshot(site) {
      const isPrivate = this._privateWindow;
      return {
        site,
        rule:
          lazy.SvalSiteProtections.rules(this._siteSession).get(site) ?? null,
        javascript: isPrivate
          ? undefined
          : (lazy.SvalJavascript.rules().get(site) ?? null),
        style: isPrivate ? null : lazy.styleAt(site),
        switches: isPrivate ? [] : this._siteSwitches(site),
        shown:
          isPrivate || lazy.siteOfEntry(site).site === site
            ? []
            : (lazy
                .exceptionsInFilters(lazy.SvalBlocking.myFilters)
                .get(site) ?? []),
        permissions: isPrivate
          ? []
          : (lazy.permissionsBySite().get(site) ?? [])
              .filter(perm => !perm.isDefault)
              .map(perm => ({
                principal: perm.principal,
                type: perm.type,
                capability: perm.capability,
                expireType: perm.expireType,
                expireTime: perm.expireTime,
              })),
      };
    },

    /**
     * @param {string} name A site or a host.
     * @returns {Array<[string, "off"|"on"]>} The extension switches saved
     *   under `name` itself, by extension id.
     */
    _siteSwitches(name) {
      const ext = lazy.SvalExtensionSites;
      return [
        ...ext.idsOffOn(name).map(id => [id, "off"]),
        ...ext.idsOnAt(name).map(id => [id, "on"]),
      ];
    },

    /**
     * Logs a switch that did not reach every process.
     *
     * @param {Promise<void>} applied From `SvalExtensionSites.setOff`.
     */
    _applySwitch(applied) {
      applied.catch(err =>
        lazy.SvalLog.warn(
          `an extension's site switch did not apply: ${lazy.SvalLog.errorName(err)}`
        )
      );
    },

    /**
     * Saves My filters, logging a write that fails.
     *
     * @param {string} text
     */
    _writeFilters(text) {
      try {
        lazy.SvalBlocking.setMyFilters(text);
      } catch (err) {
        lazy.SvalLog.warn(
          `could not save My filters: ${lazy.SvalLog.errorName(err)}`
        );
      }
    },

    /**
     * Puts back what `_siteSnapshot` read.
     *
     * @param {object} snapshot
     * @param {string} snapshot.site
     * @param {?object} snapshot.rule
     * @param {?string} [snapshot.javascript] Left out in a private window.
     * @param {?object} snapshot.style Its Colorshift style's values.
     * @param {object[]} snapshot.permissions
     * @param {string[]} snapshot.shown The selectors a host showed again.
     * @param {Array<[string, string]>} snapshot.switches From
     *   `_siteSwitches`.
     */
    _restoreSite({
      site,
      rule,
      javascript,
      style,
      permissions,
      shown,
      switches,
    }) {
      // Undo follows a Reset of this name alone, so each switch differs
      // from what the name inherits as it did, and `setOff` keeps it.
      for (const [id, state] of switches) {
        this._applySwitch(
          lazy.SvalExtensionSites.setOff(id, site, state === "off")
        );
      }
      if (switches.length) {
        lazy.SvalExtensionSites.reloadSite(site);
      }
      if (shown.length) {
        this._writeFilters(
          lazy.appendLines(
            lazy.SvalBlocking.myFilters,
            shown.map(selector => lazy.exceptionLine(site, selector))
          )
        );
      }
      lazy.SvalSiteProtections.setRule(site, rule, this._siteSession);
      if (javascript !== undefined) {
        const js = lazy.SvalJavascript;
        if (javascript) {
          js.setEnabled(site, javascript === "allow");
        } else {
          js.removeRule(site);
        }
      }
      if (style) {
        lazy.setStyle(site, style);
      }
      for (const perm of permissions) {
        Services.perms.addFromPrincipal(
          perm.principal,
          perm.type,
          perm.capability,
          perm.expireType,
          perm.expireTime
        );
      }
    },

    /**
     * A site's fingerprinting exceptions, one switch each.
     *
     * @param {string} site
     * @param {object} rule
     * @param {string} id The box's id.
     * @returns {Element}
     */
    _siteExceptions(site, rule, id) {
      const sp = lazy.SvalSiteProtections;
      const box = this._el("div", {
        id,
        className: "sval-fp-advanced sval-sites-exceptions-box",
        role: "group",
        ariaLabel: `Fingerprinting exceptions for ${site}`,
        dataset: { exceptionsFor: site },
      });
      for (const exception of lazy.SvalFingerprinting.SITE_EXCEPTIONS) {
        const noteId = `${box.id}-${exception.id}`;
        const input = this._el("input", {
          type: "checkbox",
          className: "sval-switch",
          role: "switch",
          checked: (rule.exceptions ?? []).includes(exception.id),
          ariaLabel: `${exception.label} on ${site}`,
          ariaDescribedby: noteId,
          dataset: {
            exception: exception.id,
            svalKey: `exception:${site}:${exception.id}`,
          },
        });
        input.addEventListener("change", () => {
          const ids = new Set(sp.exceptionsFor(site));
          if (input.checked) {
            ids.add(exception.id);
          } else {
            ids.delete(exception.id);
          }
          sp.setExceptions(site, [...ids]);
        });
        box.append(
          this._el(
            "div",
            { className: "sval-fp-item" },
            this._el(
              "span",
              { className: "sval-fp-words" },
              this._el("span", { className: "sval-fp-label" }, exception.label),
              this._el(
                "span",
                { className: "sval-agents-note", id: noteId },
                exception.note
              )
            ),
            input
          )
        );
      }
      return box;
    },

    /**
     * @returns {Array<[string, string, boolean]>} The protections choices,
     *   each with whether it is disabled. In a private window,
     *   fingerprinting protection can't be turned off on its own, nor
     *   Mozilla's fix overridden, as in a private window's protection button.
     */
    _siteProtectionChoices() {
      return SITE_PROTECTIONS.map(([value, text]) => [
        value,
        text,
        (value === "fingerprinting" || value === "full") && this._privateWindow,
      ]);
    },

    /**
     * Shows the Sites card, filtered to the site the protection button's
     * "Manage sites" named, if any.
     */
    showSites() {
      if (!this._els) {
        this._pending = { pane: "svalSites", section: "sites" };
        return;
      }
      const site = lazy.SvalSiteProtections.manageFilter;
      lazy.SvalSiteProtections.manageFilter = null;
      if (site) {
        this._sitesView = {
          ...this._sitesView,
          q: site,
          filt: "all",
          adding: null,
        };
      }
      this._leaveSitePage();
      window.gotoPref("svalSites");
      this._describeSites();
      document.getElementById("sval-sites").scrollIntoView();
      // The search holds the site the user came to manage.
      document.getElementById("sval-sites-search")?.focus();
    },
  };

  Object.assign(window.SvalSettings, SvalSitesSettings);
}
