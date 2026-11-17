/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * A paired agent's row in the Agents pane, which leads to its page, and the
 * permissions editor that page holds (agent-control spec §5.2): the default level, the site rules with their
 * file, app and upload columns, site tools (site-tools spec §4.1) and
 * remembered tools, and the add row. Every change is a call to the
 * agent store through `_changePolicy`, with an Undo where one is offered.
 *
 * `SvalPreferences` loads this as a classic script after `settings.js`; it
 * adds its methods to `SvalSettings`.
 */

"use strict";

{
  const { counted } = window.SvalSettingsHelpers;
  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    SvalAgents: "moz-src:///browser/components/sval/SvalAgents.sys.mjs",
    SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
    appsOf: "moz-src:///browser/components/sval/SvalAgentPolicy.sys.mjs",
    defaultOf: "moz-src:///browser/components/sval/SvalAgentPolicy.sys.mjs",
    filePermissionOf:
      "moz-src:///browser/components/sval/SvalAgentPolicy.sys.mjs",
    levelFor: "moz-src:///browser/components/sval/SvalAgentPolicy.sys.mjs",
    PAGE_TOOL_SITE_ANSWERS:
      "moz-src:///browser/components/sval/SvalAgentPageTools.sys.mjs",
    pageToolsSettingOf:
      "moz-src:///browser/components/sval/SvalAgentPageTools.sys.mjs",
    scopeOfHost: "moz-src:///browser/components/sval/SvalSite.sys.mjs",
    siteOfEntry: "moz-src:///browser/components/sval/SvalSite.sys.mjs",
    uploadFoldersOf:
      "moz-src:///browser/components/sval/SvalAgentPolicy.sys.mjs",
  });

  /*
   * A rule's row shows and sets the rule saved under its own name, a site or
   * a host under its site (decision 1980). The policy's lookups walk from a
   * host to its site (`mostSpecificRule`), so the row reads its own entries
   * directly: what a host follows from its site is shown on the site's row.
   */

  /**
   * @param {object|null} policy
   * @param {"downloads"|"uploads"|"console"} kind
   * @param {string} name
   * @returns {"allow"|"deny"|null} The rule's own answer for `kind`.
   */
  const ownFilePermission = (policy, kind, name) =>
    lazy.filePermissionOf(kind, policy?.[kind]?.[name]);

  /**
   * @param {object|null} policy
   * @param {string} name
   * @returns {Array<{path: string, subfolders: boolean}>} The rule's own
   *   upload folders.
   */
  const ownUploadFolders = (policy, name) =>
    lazy.uploadFoldersOf(policy?.uploads?.[name]) ?? [];

  /**
   * @param {object|null} policy
   * @param {string} name
   * @returns {"allow"|"deny"|null} The rule's own answer about site tools.
   */
  const ownToolSite = (policy, name) => {
    const answer = policy?.pageToolSites?.[name];
    return lazy.PAGE_TOOL_SITE_ANSWERS.includes(answer) ? answer : null;
  };

  /**
   * @param {string} name A rule's name.
   * @returns {string} The site it is under: itself for a site.
   */
  const siteOfRule = name => lazy.scopeOfHost(name)?.site ?? name;

  /**
   * What each default and level is called, and what it does, in the order
   * the editor offers them (agent-control spec §5.2). `"ask"` is a default
   * only; the rest are levels a site rule can hold too.
   */
  const AGENT_LEVELS = {
    ask: {
      label: "Ask on first visit",
      what: "Sval asks you the first time the agent opens a site. Your answer becomes a site rule.",
    },
    blocked: { label: "Blocked", what: "The agent can't open the site." },
    "read-only": {
      label: "Read only",
      what: "The agent reads pages. It never clicks, types, or submits.",
    },
    "ask-before-writes": {
      label: "Ask before writes",
      what: "The agent reads freely. Sval asks you before it clicks, types, or submits.",
    },
    full: {
      label: "Full",
      what: "The agent clicks, types, and submits on its own, without asking.",
    },
  };

  /**
   * What each setting for an agent's site tools is called, and what it does
   * (site-tools spec §4.1, layer B).
   */
  const AGENT_PAGE_TOOLS = {
    off: {
      label: "Off",
      what: "This agent never sees any site's tools. Sval keeps its per-site settings and remembered tools.",
    },
    ask: {
      label: "Ask",
      what: "Sval asks you before every tool call this agent makes.",
    },
    on: {
      label: "On",
      what: "Tool calls follow the site's access level. Remembered tools run without asking.",
    },
  };

  /** A site rule's file and console columns, by the policy map each sets. */
  const AGENT_FILE_COLUMNS = [
    { kind: "downloads", label: "Downloads" },
    { kind: "uploads", label: "Uploads" },
    { kind: "console", label: "Console" },
  ];

  /** The policy maps a site rule's file, console and app columns set. */
  const AGENT_FILE_AND_APP_MAPS = ["downloads", "uploads", "console", "apps"];

  /** What an app scheme's answer reads as in Settings. */
  const APP_ANSWERS = [
    ["allow", "Allow"],
    ["", "Ask"],
    ["deny", "Deny"],
  ];

  /** How many site rules show before "Show N more", with no search. */
  const AGENT_RULES_SHOWN = 8;

  const SvalAgentPolicySettings = {
    /**
     * @param {string} agentId
     * @returns {string} The id of the agent's permissions editor.
     */
    _editorId(agentId) {
      return `sval-agent-editor-${agentId}`;
    },

    /**
     * @param {object} agent `store.agents()`'s entry.
     * @param {object|null} policy
     * @param {object} workspaces From `_agentWorkspaces`.
     * @returns {Element}
     */
    _agentRow(agent, policy, workspaces) {
      const rules = this._ruleSites(policy).length;
      const tools = this._pageToolsOn()
        ? ` · Site tools: ${
            AGENT_PAGE_TOOLS[lazy.pageToolsSettingOf(policy)].label
          }`
        : "";

      const meta = this._el("span", {
        className: "sval-agent-meta",
        dataset: {
          level: lazy.defaultOf(policy),
          rules,
          pageTools: tools && lazy.pageToolsSettingOf(policy),
        },
      });
      const held = agent.workspaces.filter(w => workspaces[w.workspaceId]);
      if (held.length) {
        meta.append(
          this._el(
            "span",
            { className: "sval-agent-ws" },
            counted(held.length, "Workspace")
          )
        );
      }
      meta.append(
        this._el(
          "span",
          {},
          `Other sites: ${AGENT_LEVELS[lazy.defaultOf(policy)].label} · ${
            rules ? counted(rules, "site rule") : "no site rules"
          }${tools}`
        )
      );

      const open = this._el(
        "a",
        {
          className: "sval-agent-open",
          href: `#svalAgents-${this._agentSubcategory(agent.agentId)}`,
          ariaLabel: `Permissions for ${agent.label}`,
          dataset: { svalKey: `open:${agent.agentId}`, agentId: agent.agentId },
        },
        "Permissions",
        this._glyph("sc-next")
      );
      open.addEventListener("click", event => {
        event.preventDefault();
        this.showAgent(agent.agentId);
      });

      const unpair = this._el(
        "button",
        {
          type: "button",
          className: "sval-agent-unpair",
          ariaLabel: `Unpair ${agent.label}`,
          dataset: { svalKey: `unpair:${agent.agentId}` },
        },
        "Unpair"
      );
      unpair.addEventListener("click", () => this.askToUnpair(agent));

      const row = this._el(
        "div",
        { className: "sval-agent" },
        this._el(
          "div",
          { className: "sval-agent-head" },
          this._el(
            "span",
            { className: "sval-agent-tile" },
            this._glyph("laptop")
          ),
          this._el(
            "span",
            { className: "sval-agent-words" },
            this._el("span", { className: "sval-agent-label" }, agent.label),
            meta
          ),
          open,
          unpair
        )
      );
      return row;
    },

    /**
     * Whether sites may offer tools to agents (site-tools spec §4.1, layer
     * A). While they may not, the editor shows no tools controls.
     *
     * @returns {boolean}
     */
    _pageToolsOn() {
      return Services.prefs.getBoolPref(lazy.SvalAgents.PAGE_TOOLS_PREF, false);
    },

    /**
     * Whether the editor shows `policy`'s per-site tools: only where a tool
     * could reach the agent, so not while layer A or the agent's own setting
     * is off. What it hides is kept.
     *
     * @param {object|null} policy
     * @returns {boolean}
     */
    _showsSiteTools(policy) {
      return this._pageToolsOn() && lazy.pageToolsSettingOf(policy) !== "off";
    },

    /**
     * @param {object|null} policy
     * @returns {string[]} Every site the policy has a rule for that the
     *   editor shows: a level, a download or an upload permission, or a
     *   setting for its tools while those show.
     */
    _ruleSites(policy) {
      const maps = ["sites", ...AGENT_FILE_AND_APP_MAPS];
      if (this._showsSiteTools(policy)) {
        maps.push("pageToolSites");
      }
      const keys = new Set();
      for (const map of maps) {
        for (const site of Object.keys(policy?.[map] ?? {})) {
          keys.add(site);
        }
      }
      return [...keys];
    },

    /**
     * The open agent's permissions: its default, then its site rules.
     *
     * @param {object} agent
     * @param {object} policy
     * @returns {Element}
     */
    _agentEditor(agent, policy) {
      const view = this._agentView;
      const id = agent.agentId;
      const current = lazy.defaultOf(policy);

      const choices = this._el("div", { className: "sval-agent-defaults" });
      for (const [value, { label }] of Object.entries(AGENT_LEVELS)) {
        const radio = this._el("input", {
          type: "radio",
          name: `sval-agent-default-${id}`,
          value,
          checked: value === current,
          dataset: { svalKey: `default:${id}:${value}` },
        });
        radio.addEventListener("change", () =>
          this._changePolicy(store => store.setDefault(id, value))
        );
        choices.append(
          this._el(
            "label",
            { className: "sval-agent-default" },
            radio,
            this._el("span", {
              className: "sval-level-dot",
              dataset: { level: value },
            }),
            this._el("span", {}, label)
          )
        );
      }
      const { label, what } = AGENT_LEVELS[current];
      let unasked = " Sites with no rule get this without asking.";
      if (current !== "blocked") {
        unasked =
          " Sites with no rule get this without asking, except a service on this computer or a device on your local network, which Sval asks about first.";
      }
      const noteId = `sval-agent-default-note-${id}`;
      const defaults = this._el(
        "fieldset",
        { className: "sval-agent-fieldset", ariaDescribedby: noteId },
        this._el("legend", {}, "Default for sites with no rule"),
        choices,
        this._el(
          "p",
          { className: "sval-agents-note", id: noteId },
          `${label}: ${what}${current === "ask" ? "" : unasked}`
        )
      );

      // A filter on allowed tools means nothing while the tools are hidden.
      if (view.filt === "tools" && !this._showsSiteTools(policy)) {
        view.filt = "all";
      }
      const sites = this._ruleSites(policy);
      const add = this._el(
        "button",
        {
          type: "button",
          className: "sval-agent-add",
          disabled: !!view.adding,
          dataset: { svalKey: `add:${id}` },
        },
        this._glyph("plus"),
        "Add site"
      );
      add.addEventListener("click", () => {
        this._agentView = {
          ...this._agentView,
          adding: {
            text: "",
            level: current === "ask" ? "ask-before-writes" : current,
          },
          msg: "",
          undo: null,
        };
        this._redrawAgents();
        this._els.agentCards.querySelector(".sval-agent-adding input")?.focus();
      });

      const rules = this._el(
        "div",
        { className: "sval-agent-rules" },
        this._el(
          "div",
          { className: "sval-agent-rules-head" },
          this._el("h3", {}, "Site rules"),
          this._el(
            "span",
            { className: "sval-agents-note" },
            sites.length ? String(sites.length) : ""
          ),
          add
        )
      );
      if (view.adding) {
        rules.append(this._addRow(id, policy, sites));
      }
      if (sites.length) {
        rules.append(this._ruleTools(id, policy));
        const table = this._el("div", { className: "sval-agent-table-wrap" });
        this._fillRules(table, id, policy);
        rules.append(table);
      } else if (!view.adding) {
        rules.append(
          this._emptyState(
            "No site rules yet",
            "Your answers to Sval's prompts appear here as rules."
          )
        );
      }
      if (view.msg) {
        const line = this._el(
          "p",
          { className: "sval-agents-done", dataset: { said: view.said } },
          this._el("span", {}, view.msg)
        );
        if (view.undo) {
          const undo = this._el(
            "button",
            {
              type: "button",
              className: "sval-link",
              dataset: { svalKey: `undo:${id}` },
            },
            "Undo"
          );
          undo.addEventListener("click", () => this._undoRemove(id));
          line.append(undo);
        }
        rules.append(line);
      }

      return this._el(
        "div",
        { className: "sval-agent-editor", id: this._editorId(id) },
        defaults,
        this._pageToolsOn()
          ? this._agentPageTools(id, policy)
          : this._pageToolsHint(id),
        rules
      );
    },

    /**
     * The agent's own setting for sites' tools: Off, Ask or On.
     *
     * @param {string} id The agent's id.
     * @param {object} policy
     * @returns {Element}
     */
    _agentPageTools(id, policy) {
      const current = lazy.pageToolsSettingOf(policy);
      const choices = this._el("div", {
        className: "sval-agent-defaults sval-agent-page-tools",
        role: "radiogroup",
        ariaLabel: "Site tools for this agent",
      });
      for (const [value, { label }] of Object.entries(AGENT_PAGE_TOOLS)) {
        const radio = this._el("input", {
          type: "radio",
          name: `sval-agent-page-tools-${id}`,
          value,
          checked: value === current,
          dataset: { svalKey: `page-tools:${id}:${value}` },
        });
        radio.addEventListener("change", () =>
          this._changePolicy(store => store.setPageTools(id, value))
        );
        choices.append(
          this._el(
            "label",
            { className: "sval-agent-default" },
            radio,
            this._el("span", {}, label)
          )
        );
      }
      const { label, what } = AGENT_PAGE_TOOLS[current];
      return this._el(
        "fieldset",
        { className: "sval-agent-fieldset" },
        this._el("legend", {}, "Site tools"),
        choices,
        this._el("p", { className: "sval-agents-note" }, `${label}: ${what}`)
      );
    },

    /**
     * The line that stands for the agent's tools setting while sites can't
     * offer tools, with a way to the switch that lets them.
     *
     * @param {string} id The agent's id.
     * @returns {Element}
     */
    _pageToolsHint(id) {
      const go = this._el(
        "button",
        {
          type: "button",
          className: "sval-link",
          dataset: { svalKey: `go-tools:${id}` },
        },
        "Go to the switch"
      );
      // The switch is in the category's own cards, which the agent's page
      // hides.
      go.addEventListener("click", () => {
        this._leaveAgentPage();
        this._els.pageToolsEnabled.focus();
      });
      return this._el(
        "div",
        { className: "sval-page-tools-hint" },
        this._el(
          "span",
          { className: "sval-page-tools-hint-title" },
          "Site tools"
        ),
        this._el(
          "span",
          {},
          "Site tools are off for every agent while sites can't offer tools."
        ),
        go
      );
    },

    /**
     * The search field and the filter over an agent's rules. Typing redraws
     * only the rules, so the field keeps its caret.
     *
     * @param {string} id The agent's id.
     * @param {object} policy
     * @returns {Element}
     */
    _ruleTools(id, policy) {
      const view = this._agentView;
      const search = this._el("input", {
        type: "search",
        className: "sval-agent-search",
        placeholder: "Find a site",
        ariaLabel: "Find a site rule",
        spellcheck: false,
        value: view.q,
        dataset: { svalKey: `q:${id}` },
      });
      search.addEventListener("input", () => {
        this._agentView.q = search.value;
        this._fillRules(
          search
            .closest(".sval-agent-rules")
            .querySelector(".sval-agent-table-wrap"),
          id,
          policy
        );
      });
      const filter = this._el("select", {
        className: "sval-agent-select",
        ariaLabel: "Show rules",
        dataset: { svalKey: `filt:${id}` },
      });
      for (const [value, text] of [
        ["all", "All rules"],
        ...Object.entries(AGENT_LEVELS)
          .filter(([level]) => level !== "ask")
          .map(([level, { label }]) => [level, label]),
        ["files", "With a file, console, or app rule"],
        ...(this._showsSiteTools(policy)
          ? [["tools", "Site tools allowed"]]
          : []),
      ]) {
        filter.append(this._el("option", { value }, text));
      }
      filter.value = view.filt;
      filter.addEventListener("change", () => {
        this._agentView.filt = filter.value;
        this._redrawAgents();
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
        filter
      );
    },

    /**
     * Fills `wrap` with the rules that match the search and filter: the
     * sites added since the page opened first, then the rest in order, and
     * only the first few with neither a search nor a filter.
     *
     * @param {Element} wrap
     * @param {string} id The agent's id.
     * @param {object} policy
     */
    _fillRules(wrap, id, policy) {
      const view = this._agentView;
      const sites = this._ruleSites(policy);
      const recent = (view.recent.get(id) ?? []).filter(s => sites.includes(s));
      // A host's rule is listed under its site's, when the site has one.
      const under = name => {
        const site = siteOfRule(name);
        return site !== name && sites.includes(site) ? site : null;
      };
      const ordered = [
        ...recent.filter(s => !under(s)),
        ...sites.filter(s => !recent.includes(s) && !under(s)).sort(),
      ].flatMap(site => [site, ...sites.filter(s => under(s) === site).sort()]);
      const q = view.q.trim().toLowerCase();
      const has = (map, site) => Object.hasOwn(policy[map] ?? {}, site);
      const kept = site => {
        switch (view.filt) {
          case "all":
            return true;
          case "files":
            return AGENT_FILE_AND_APP_MAPS.some(map => has(map, site));
          case "tools":
            return ownToolSite(policy, site) === "allow";
          default:
            return policy.sites?.[site] === view.filt;
        }
      };
      const matches = ordered.filter(
        site => (!q || site.includes(q)) && kept(site)
      );
      const tools = this._showsSiteTools(policy);
      const filtering = !!q || view.filt !== "all";
      let found = "";
      if (filtering) {
        found = matches.length
          ? `${counted(matches.length, "rule")} found.`
          : `No rules match${q ? ` "${view.q.trim()}"` : ""}.`;
      }
      this._say(this._els.agentsFound, found);
      const shown =
        filtering || view.showAll
          ? matches
          : matches.slice(0, AGENT_RULES_SHOWN);

      wrap.textContent = "";
      const table = this._el("div", {
        className: "sval-agent-table",
        role: "table",
        ariaLabel: "Site rules",
      });
      table.classList.toggle("sval-agent-table-tools", tools);
      table.append(
        this._el(
          "div",
          { className: "sval-agent-rule sval-agent-rule-head", role: "row" },
          ...[
            "Site",
            "Access",
            "Downloads",
            "Uploads",
            "Console",
            "Apps",
            ...(tools ? ["Site tools"] : []),
          ].map(text => this._el("span", { role: "columnheader" }, text)),
          this._actionsHeader()
        )
      );
      for (const [index, site] of shown.entries()) {
        const parent = under(site);
        table.append(
          this._ruleRow(
            id,
            policy,
            site,
            recent.includes(site),
            !!parent && shown.slice(0, index).includes(parent)
          )
        );
        if (ownUploadFolders(policy, site).length) {
          table.append(this._uploadFolders(id, policy, site));
        }
        const apps = lazy.appsOf(policy.apps?.[site]);
        if (apps && apps !== "deny") {
          table.append(this._siteApps(id, site, apps));
        }
        if (tools && ownToolSite(policy, site) === "allow") {
          table.append(this._rememberedTools(id, policy, site));
        }
      }
      wrap.append(table);

      if (!matches.length) {
        const clear = this._el(
          "button",
          {
            type: "button",
            className: "sval-link",
            dataset: { svalKey: `clear:${id}` },
          },
          "Clear"
        );
        clear.addEventListener("click", () => {
          this._agentView = { ...this._agentView, q: "", filt: "all" };
          this._redrawAgents();
        });
        wrap.append(
          this._el(
            "div",
            { className: "sval-agent-nomatch" },
            this._el(
              "span",
              {},
              q
                ? `No rules match "${view.q.trim()}".`
                : "No rules of this kind."
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
            dataset: { svalKey: `more:${id}` },
          },
          `Show ${matches.length - shown.length} more`
        );
        more.addEventListener("click", () => {
          this._agentView.showAll = true;
          this._redrawAgents();
        });
        wrap.append(more);
      }
    },

    /**
     * One site's rule: its level and its file permissions.
     *
     * @param {string} id The agent's id.
     * @param {object} policy
     * @param {string} site
     * @param {boolean} isNew Whether the site was added since the page opened.
     * @param {boolean} [nested] Whether the row is a host's, listed under
     *   its site's row.
     * @returns {Element}
     */
    _ruleRow(id, policy, site, isNew, nested = false) {
      const level = policy.sites?.[site] ?? "";
      const files = AGENT_FILE_AND_APP_MAPS.filter(kind =>
        Object.hasOwn(policy[kind] ?? {}, site)
      );

      const access = this._el("select", {
        className: "sval-agent-select",
        ariaLabel: `Access for ${site}`,
        dataset: { svalKey: `level:${id}:${site}` },
      });
      access.append(this._el("option", { value: "" }, "Default"));
      for (const [value, { label }] of Object.entries(AGENT_LEVELS)) {
        if (value !== "ask") {
          access.append(this._el("option", { value }, label));
        }
      }
      access.value = level;
      // A site-tools setting keeps the site's row while it shows, so Default
      // never takes it with the level.
      const toolsSetting =
        this._showsSiteTools(policy) && ownToolSite(policy, site);
      access.addEventListener("change", () => {
        const value = access.value;
        if (!value && !files.length && !toolsSetting) {
          this.removeRule(id, policy, site);
          return;
        }
        this._changePolicy(store =>
          value
            ? store.setSiteLevel(id, site, value)
            : store.removeSiteLevel(id, site)
        );
      });

      // A host under its site's row is named by its own labels, then its
      // site's, muted.
      const parentSite = siteOfRule(site);
      const name = nested
        ? this._el(
            "span",
            { className: "sval-agent-site", title: site },
            site.slice(0, -parentSite.length - 1),
            this._el(
              "span",
              { className: "sval-agent-site-parent" },
              `.${parentSite}`
            )
          )
        : this._el("span", { className: "sval-agent-site", title: site }, site);
      const siteCell = this._el(
        "span",
        { className: "sval-agent-site-cell", role: "cell" },
        name
      );
      if (isNew) {
        siteCell.append(
          this._el("span", { className: "sval-agent-new" }, "Just added")
        );
      }

      const remove = this._el(
        "button",
        {
          type: "button",
          className: "sval-agent-remove",
          ariaLabel: `Remove rule for ${site}`,
          title: "Remove rule",
          dataset: { svalKey: `remove:${id}:${site}` },
        },
        this._glyph("x")
      );
      remove.addEventListener("click", () => this.removeRule(id, policy, site));

      return this._el(
        "div",
        {
          className: `sval-agent-rule${isNew ? " sval-agent-rule-new" : ""}`,
          role: "row",
          dataset: nested ? { host: site } : {},
        },
        siteCell,
        this._el(
          "span",
          { className: "sval-agent-access", role: "cell" },
          this._el("span", {
            className: "sval-level-dot",
            dataset: { level: level || "none" },
          }),
          access
        ),
        ...AGENT_FILE_COLUMNS.map(({ kind, label }) =>
          this._fileSelect(id, policy, site, kind, label)
        ),
        this._appsSelect(id, policy, site),
        ...(this._showsSiteTools(policy)
          ? [this._toolSiteSelect(id, policy, site)]
          : []),
        this._actionCell(remove)
      );
    },

    /**
     * Whether a site may offer its tools to the agent: Ask, Allowed or
     * Blocked (site-tools spec §4.1, layer C). A site whose access is Blocked,
     * by its rule or the agent's default, never loads, so its tools setting
     * has nothing to act on and can't be changed.
     *
     * @param {string} id The agent's id.
     * @param {object} policy
     * @param {string} site
     * @returns {Element}
     */
    _toolSiteSelect(id, policy, site) {
      const value = ownToolSite(policy, site) ?? "";
      const blocked = lazy.levelFor(policy, site).level === "blocked";
      const select = this._el("select", {
        className: "sval-agent-select sval-agent-tool-site",
        role: "cell",
        ariaLabel: `Site tools on ${site}`,
        disabled: blocked,
        title: blocked
          ? `${site} is Blocked, so it never loads and can't offer tools.`
          : "",
        dataset: { svalKey: `page-tool-site:${id}:${site}`, value },
      });
      for (const [option, text] of [
        ["", "Ask"],
        ["allow", "Allowed"],
        ["deny", "Blocked"],
      ]) {
        select.append(this._el("option", { value: option }, text));
      }
      select.value = value;
      select.addEventListener("change", () => {
        const next = select.value;
        const others =
          Object.hasOwn(policy.sites ?? {}, site) ||
          AGENT_FILE_AND_APP_MAPS.some(kind =>
            Object.hasOwn(policy[kind] ?? {}, site)
          );
        // Blocked and Ask both forget the site's remembered tools.
        const forgot =
          next === "allow" ? 0 : this._grantsOn(policy, site).length;
        if (!next && !others && !forgot) {
          this.removeRule(id, policy, site);
          return;
        }
        let msg = "";
        let said = "";
        if (forgot && next === "deny") {
          msg = `Blocked tools on ${site}. Forgot ${counted(forgot, "remembered tool")}.`;
          said = "blocked-tools";
        } else if (forgot) {
          msg = `Forgot ${counted(forgot, "remembered tool")} on ${site}.`;
          said = "forgot-tools";
        }
        this._agentView = {
          ...this._agentView,
          msg,
          said,
          undo: null,
        };
        this._changePolicy(
          store =>
            next
              ? store.setPageToolSite(id, site, next)
              : store.removePageToolSite(id, site),
          { keepMessage: true }
        );
      });
      return select;
    },

    /**
     * @param {object} policy
     * @param {string} site
     * @returns {string[]} The names of the tools remembered on `site`. A name
     *   is the page's own text.
     */
    _grantsOn(policy, site) {
      const grants = policy.pageToolGrants?.[site];
      return grants && typeof grants === "object" ? Object.keys(grants) : [];
    },

    /**
     * The tools remembered on an allowed site, each with Remove. A name comes
     * from the page, so it is only ever text, and `dir="auto"` lets a
     * right-to-left name read in its own direction.
     *
     * @param {string} id The agent's id.
     * @param {object} policy
     * @param {string} site
     * @returns {Element}
     */
    _rememberedTools(id, policy, site) {
      const names = this._grantsOn(policy, site);
      const box = this._el(
        "div",
        {
          className: "sval-agent-remembered",
          role: "group",
          ariaLabel: `Remembered tools on ${site}`,
        },
        this._el(
          "span",
          { className: "sval-agent-remembered-title" },
          names.length
            ? `Remembered tools · ${names.length}`
            : "Remembered tools"
        )
      );
      if (!names.length) {
        box.append(
          this._el(
            "span",
            { className: "sval-agents-note" },
            "None yet. Sval remembers a tool when you choose Always allow in its prompt. The prompt appears while this agent's Site tools setting is On."
          )
        );
        return box;
      }
      // Under Ask every call asks (site-tools spec §4.3).
      if (lazy.pageToolsSettingOf(policy) === "ask") {
        box.append(
          this._el(
            "span",
            { className: "sval-agents-note" },
            "Sval uses these only while this agent's Site tools setting is On."
          )
        );
      }
      const list = this._el("div", {
        className: "sval-agent-chips",
        role: "list",
      });
      for (const name of names) {
        const remove = this._el(
          "button",
          {
            type: "button",
            className: "sval-agent-chip-remove",
            ariaLabel: `Remove ${name} from ${site}`,
            title: "Remove",
            dataset: { svalKey: `revoke:${id}:${site}:${name}` },
          },
          this._glyph("x")
        );
        remove.addEventListener("click", () => {
          this._agentView = {
            ...this._agentView,
            msg: `Forgot ${name} on ${site}. Sval asks next time.`,
            said: "forgot-tool",
            undo: null,
          };
          this._changePolicy(store => store.revokePageTool(id, site, name), {
            keepMessage: true,
          });
        });
        list.append(
          this._el(
            "span",
            { className: "sval-agent-chip", role: "listitem" },
            this._el(
              "span",
              { className: "sval-agent-chip-name", dir: "auto", title: name },
              name
            ),
            remove
          )
        );
      }
      box.append(list);
      return box;
    },

    /**
     * A site's download, upload or console permission: Ask, Allow or Deny.
     *
     * @param {string} id The agent's id.
     * @param {object} policy
     * @param {string} site
     * @param {"downloads"|"uploads"|"console"} kind
     * @param {string} label The column's name.
     * @returns {Element}
     */
    _fileSelect(id, policy, site, kind, label) {
      const value = ownFilePermission(policy, kind, site) ?? "";
      const folders = kind === "uploads" ? ownUploadFolders(policy, site) : [];
      const select = this._el("select", {
        className: "sval-agent-select sval-agent-file",
        role: "cell",
        ariaLabel: `${label} on ${site}`,
        title: folders.map(f => f.path).join("\n"),
        dataset: { svalKey: `${kind}:${id}:${site}`, value },
      });
      // Uploads are allowed only from the folders of files the user saw in
      // an upload alert (agent-control spec §5.2), so Allow is offered here
      // only to show such a grant.
      const options =
        kind !== "uploads"
          ? [
              ["", "Ask"],
              ["allow", "Allow"],
              ["deny", "Deny"],
            ]
          : [
              ["", "Ask"],
              ...(folders.length
                ? [["allow", `Allow from ${counted(folders.length, "folder")}`]]
                : []),
              ["deny", "Deny"],
            ];
      for (const [option, text] of options) {
        select.append(this._el("option", { value: option }, text));
      }
      select.value = value;
      select.addEventListener("change", () => {
        const next = select.value;
        this._changePolicy(store =>
          next
            ? store.setFilePermission(id, kind, site, next)
            : store.removeFilePermission(id, kind, site)
        );
      });
      return select;
    },

    /**
     * A site's apps: Ask about each scheme, Deny every app, or the schemes
     * the site has asked to open, each with its own answer, listed under the
     * row (`_siteApps`). A scheme is listed only once the site asked for it
     * (agent-control spec §5.2).
     *
     * @param {string} id The agent's id.
     * @param {object} policy
     * @param {string} site
     * @returns {Element}
     */
    _appsSelect(id, policy, site) {
      const apps = lazy.appsOf(policy.apps?.[site]);
      const schemes = apps && apps !== "deny" ? Object.keys(apps) : [];
      let value = schemes.length ? "schemes" : "";
      if (apps === "deny") {
        value = "deny";
      }
      const select = this._el("select", {
        className: "sval-agent-select sval-agent-file",
        role: "cell",
        ariaLabel: `Apps on ${site}`,
        title: schemes.join("\n"),
        dataset: { svalKey: `apps:${id}:${site}`, value },
      });
      for (const [option, text] of [
        ["", "Ask"],
        ...(schemes.length
          ? [["schemes", counted(schemes.length, "app")]]
          : []),
        ["deny", "Deny"],
      ]) {
        select.append(this._el("option", { value: option }, text));
      }
      select.value = value;
      select.addEventListener("change", () => {
        const next = select.value;
        this._changePolicy(store => store.setApps(id, site, next || null));
      });
      return select;
    },

    /**
     * The schemes a site has asked to open in other applications, each with
     * Allow, Ask, which forgets it so Sval asks again, or Deny. A scheme is
     * the site's own text, so it is only ever text.
     *
     * @param {string} id The agent's id.
     * @param {string} site
     * @param {{[scheme: string]: string}} apps
     * @returns {Element}
     */
    _siteApps(id, site, apps) {
      const schemes = Object.keys(apps).sort();
      const list = this._el("div", {
        className: "sval-agent-chips",
        role: "list",
      });
      for (const scheme of schemes) {
        const select = this._el("select", {
          className: "sval-agent-select sval-agent-file sval-agent-chip-select",
          ariaLabel: `${scheme} links from ${site}`,
          dataset: {
            svalKey: `app:${id}:${site}:${scheme}`,
            value: apps[scheme],
          },
        });
        for (const [option, text] of APP_ANSWERS) {
          select.append(this._el("option", { value: option }, text));
        }
        select.value = apps[scheme];
        select.addEventListener("change", () => {
          const next = select.value;
          this._changePolicy(store =>
            next
              ? store.setAppPermission(id, site, scheme, next)
              : store.removeAppPermission(id, site, scheme)
          );
        });
        list.append(
          this._el(
            "span",
            { className: "sval-agent-chip", role: "listitem" },
            this._el(
              "span",
              { className: "sval-agent-chip-name", title: scheme },
              scheme
            ),
            select
          )
        );
      }
      return this._el(
        "div",
        {
          className: "sval-agent-remembered",
          role: "group",
          ariaLabel: `Apps on ${site}`,
        },
        this._el(
          "span",
          { className: "sval-agent-remembered-title" },
          `Apps · ${schemes.length}`
        ),
        list
      );
    },

    /**
     * The folders a site's uploads are allowed from, each with its scope.
     * Settings narrows a folder or removes it, and never widens one: only an
     * upload alert, which showed the files, does that (decision 0129).
     *
     * @param {string} id The agent's id.
     * @param {object} policy
     * @param {string} site
     * @returns {Element}
     */
    _uploadFolders(id, policy, site) {
      const folders = ownUploadFolders(policy, site);
      const list = this._el("div", {
        className: "sval-agent-chips",
        role: "list",
      });
      for (const { path, subfolders } of folders) {
        const remove = this._el(
          "button",
          {
            type: "button",
            className: "sval-agent-chip-remove",
            ariaLabel: `Remove ${path} from ${site}`,
            title: "Remove",
            dataset: { svalKey: `folder-remove:${id}:${site}:${path}` },
          },
          this._glyph("x")
        );
        remove.addEventListener("click", () =>
          this._changePolicy(store =>
            store.changeUploadFolder(id, site, path, "remove")
          )
        );
        const chip = this._el(
          "span",
          {
            className: "sval-agent-chip",
            role: "listitem",
            dataset: { subfolders },
          },
          this._el(
            "span",
            { className: "sval-agent-chip-name", dir: "auto", title: path },
            path
          ),
          this._el(
            "span",
            { className: "sval-agents-note sval-agent-chip-note" },
            subfolders ? "and folders inside" : "this folder only"
          )
        );
        if (subfolders) {
          const narrow = this._el(
            "button",
            {
              type: "button",
              className: "sval-link sval-agent-chip-action",
              ariaLabel: `Allow only files directly in ${path}`,
              dataset: { svalKey: `folder-narrow:${id}:${site}:${path}` },
            },
            "This folder only"
          );
          narrow.addEventListener("click", () =>
            this._changePolicy(store =>
              store.changeUploadFolder(id, site, path, "narrow")
            )
          );
          chip.append(narrow);
        }
        chip.append(remove);
        list.append(chip);
      }
      return this._el(
        "div",
        {
          className: "sval-agent-remembered",
          role: "group",
          ariaLabel: `Upload folders on ${site}`,
        },
        this._el(
          "span",
          { className: "sval-agent-remembered-title" },
          `Upload folders · ${folders.length}`
        ),
        list
      );
    },

    /**
     * The row that adds a site rule: what the user types is read as a site
     * (`siteOfEntry`), and the line under it says what the rule will cover.
     * A host that offers a choice of scope (`scopeOfHost`) shows a select of
     * the host and its whole site, starting at the host (host-scoped rules
     * spec §3). Typing redraws only that line, the select and the Add
     * button.
     *
     * @param {string} id The agent's id.
     * @param {object} policy
     * @param {string[]} sites The sites the policy has a rule for.
     * @returns {Element}
     */
    _addRow(id, policy, sites) {
      const adding = this._agentView.adding;
      const input = this._el("input", {
        type: "text",
        className: "sval-agent-add-input",
        id: `sval-agent-add-input-${id}`,
        placeholder: "ebay.co.uk",
        spellcheck: false,
        value: adding.text,
        dataset: { svalKey: `adding:${id}` },
      });
      const level = this._el("select", {
        className: "sval-agent-select",
        ariaLabel: "Level for the new site",
        dataset: { svalKey: `adding-level:${id}` },
      });
      for (const [value, { label }] of Object.entries(AGENT_LEVELS)) {
        if (value !== "ask") {
          level.append(this._el("option", { value }, label));
        }
      }
      level.value = adding.level;
      const scopeSelect = this._el("select", {
        className: "sval-agent-select sval-agent-add-scope",
        ariaLabel: "Applies to",
        dataset: { svalKey: `adding-scope:${id}` },
      });
      const confirm = this._el(
        "button",
        {
          type: "button",
          className: "sval-button sval-button-primary sval-agent-small",
          dataset: { svalKey: `adding-add:${id}` },
        },
        "Add"
      );
      const cancel = this._el(
        "button",
        {
          type: "button",
          className: "sval-button sval-agent-small",
          dataset: { svalKey: `adding-cancel:${id}` },
        },
        "Cancel"
      );
      const preview = this._el("div", {
        className: "sval-agent-preview",
        id: `sval-agent-add-preview-${id}`,
        ariaLive: "polite",
      });
      input.setAttribute("aria-describedby", preview.id);

      // The name the rule is saved under: the host, or its site where the
      // host offers no choice or the select picks the site.
      const reading = () => {
        const read = lazy.siteOfEntry(this._agentView.adding?.text ?? "");
        const scope = read.host ? lazy.scopeOfHost(read.host) : null;
        const choice = !!scope?.choice;
        const name =
          choice && this._agentView.adding?.scope !== "site"
            ? scope.host
            : (read.site ?? null);
        const exists = !!name && sites.includes(name);
        return { read, scope, choice, name, exists, can: !!name && !exists };
      };
      const describe = () => {
        const { read, scope, choice, name, exists, can } = reading();
        scopeSelect.hidden = !choice;
        if (choice) {
          scopeSelect.replaceChildren(
            this._el("option", { value: "host" }, scope.host),
            this._el("option", { value: "site" }, `All of ${scope.site}`)
          );
          scopeSelect.value =
            this._agentView.adding?.scope === "site" ? "site" : "host";
        }
        confirm.disabled = !can;
        input.setAttribute(
          "aria-invalid",
          String(read.error !== "empty" && !can)
        );
        preview.textContent = "";
        preview.dataset.tone =
          read.error && read.error !== "empty" ? "problem" : "";
        preview.dataset.site = name ?? "";
        let words;
        if (read.error === "empty") {
          preview.dataset.tone = "quiet";
          preview.dataset.reading = "empty";
          words = "Type a site, or paste an address from the agent's tab.";
        } else if (read.error) {
          preview.dataset.reading = "invalid";
          words = "Enter a site like ebay.co.uk, or paste an address.";
        } else if (exists) {
          preview.dataset.reading = "exists";
          const held = policy.sites?.[name];
          words = `${name} already has a rule${
            held ? `: ${AGENT_LEVELS[held].label}.` : "."
          }`;
        } else if (name !== read.site) {
          preview.dataset.reading = "host";
          words = `The rule covers ${name} and every address under it.`;
        } else if (read.suffix) {
          preview.dataset.reading = "suffix";
          words = `The rule covers only ${read.site}. Each site under it, like example.${read.site}, has its own rules.`;
        } else {
          preview.dataset.reading = "site";
          const part =
            read.host !== read.site
              ? `${read.host} is part of ${read.site}. `
              : "";
          // A name with subdomains has a `www.` example; an address or a
          // single label has none.
          const example =
            read.site.includes(".") && !/^[\d.]+$/.test(read.site)
              ? `, like www.${read.site}`
              : "";
          words = `${part}The rule covers ${read.site} and every address under it${example}${
            choice ? `, unless an address has its own rule` : ""
          }.`;
        }
        preview.append(this._el("span", {}, words));
        if (exists) {
          const show = this._el(
            "button",
            {
              type: "button",
              className: "sval-link",
              dataset: { svalKey: `show:${id}` },
            },
            "Show it"
          );
          show.addEventListener("click", () => {
            this._agentView = {
              ...this._agentView,
              adding: null,
              q: name,
              filt: "all",
            };
            this._redrawAgents();
          });
          preview.append(show);
        }
      };
      const add = () => {
        const { name, can } = reading();
        if (!can) {
          return;
        }
        const chosen = level.value;
        const recent = this._agentView.recent;
        recent.set(id, [
          name,
          ...(recent.get(id) ?? []).filter(s => s !== name),
        ]);
        this._agentView = {
          ...this._agentView,
          adding: null,
          q: "",
          filt: "all",
          msg: `Added ${name}.`,
          said: "added",
          undo: null,
        };
        this._changePolicy(store => store.setSiteLevel(id, name, chosen), {
          keepMessage: true,
        });
      };
      const close = () => {
        this._agentView = { ...this._agentView, adding: null };
        this._redrawAgents();
      };

      input.addEventListener("input", () => {
        this._agentView.adding = {
          ...this._agentView.adding,
          text: input.value,
        };
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
      level.addEventListener("change", () => {
        this._agentView.adding = {
          ...this._agentView.adding,
          level: level.value,
        };
      });
      scopeSelect.addEventListener("change", () => {
        this._agentView.adding = {
          ...this._agentView.adding,
          scope: scopeSelect.value,
        };
        describe();
      });
      confirm.addEventListener("click", add);
      cancel.addEventListener("click", close);
      describe();

      return this._el(
        "div",
        {
          className: "sval-agent-adding",
          role: "group",
          ariaLabel: "Add a site rule",
        },
        this._fieldLabel(input, "Site or address"),
        this._el(
          "div",
          { className: "sval-agent-adding-row" },
          input,
          scopeSelect,
          level,
          confirm,
          cancel
        ),
        preview
      );
    },

    /**
     * Makes one change through the open store. The store tells `STATE_TOPIC`
     * once the change is written, and that redraws the list. With no store,
     * access has been turned off since the list was drawn, and nothing is
     * changed.
     *
     * @param {(store: SvalAgentStore) => Promise} change
     * @param {object} [options]
     * @param {boolean} [options.keepMessage] Keep the message the caller set.
     */
    async _changePolicy(change, { keepMessage = false } = {}) {
      const store = lazy.SvalAgents.store;
      if (!store) {
        return;
      }
      if (!keepMessage) {
        this._agentView = { ...this._agentView, msg: "", undo: null };
      }
      try {
        await change(store);
      } catch (err) {
        lazy.SvalLog.warn(
          `changing an agent's policy failed: ${lazy.SvalLog.errorName(err)}`
        );
        this._agentView = {
          ...this._agentView,
          msg: "Sval couldn't save that change.",
          said: "not-saved",
          undo: null,
        };
      }
      this._redrawAgents();
    },

    /**
     * Removes everything the editor shows for `site`, so it follows the
     * default, and offers Undo. While its tools are hidden, its tools setting
     * and remembered tools are kept, as everything hidden is.
     *
     * @param {string} id
     * @param {object} policy The policy as drawn.
     * @param {string} site
     */
    removeRule(id, policy, site) {
      const tools = this._showsSiteTools(policy);
      const undo = {
        site,
        level: policy.sites?.[site],
        downloads: policy.downloads?.[site],
        uploads: policy.uploads?.[site],
        console: policy.console?.[site],
        apps: policy.apps?.[site],
        toolSite: tools ? ownToolSite(policy, site) : null,
        grants: tools ? { ...policy.pageToolGrants?.[site] } : {},
      };
      const recent = this._agentView.recent;
      recent.set(
        id,
        (recent.get(id) ?? []).filter(s => s !== site)
      );
      const parent = siteOfRule(site);
      this._agentView = {
        ...this._agentView,
        msg:
          parent !== site && this._ruleSites(policy).includes(parent)
            ? `Removed the rule for ${site}. The rule for ${parent} applies there now.`
            : `Removed the rule for ${site}. The default applies there now.`,
        said: "removed",
        undo,
      };
      this._changePolicy(
        store => store.removeSite(id, site, { keepTools: !tools }),
        { keepMessage: true }
      );
    },

    /**
     * Puts back the rule the last removal took, all of it or none of it
     * (`SvalAgentStore.restoreSite`).
     *
     * @param {string} id The agent's id.
     */
    _undoRemove(id) {
      const { undo } = this._agentView;
      if (!undo) {
        return;
      }
      this._changePolicy(store => store.restoreSite(id, undo.site, undo));
    },
  };

  Object.assign(window.SvalSettings, SvalAgentPolicySettings);
}
