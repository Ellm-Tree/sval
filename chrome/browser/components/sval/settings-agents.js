/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The Agents pane: the agent access switch and what keeps it from
 * listening, the polite rate and site tools switches, the AI apps Sval can
 * connect itself to, the list of paired agents, and unpairing. Each agent's
 * row and permissions editor are `settings-agent-policy.js`'s.
 *
 * An agent's page, `about:preferences#svalAgents-agent?id=<id>`, holds its
 * permissions editor. It follows the site page's address handling
 * (`settings-site-page.js`): `gotoPref` hands `agent?id=…` to the category,
 * then rewrites the hash, so the page writes its address back, and follows
 * `hashchange` for the browser's Back.
 *
 * `SvalPreferences` loads this as a classic script after `settings.js`; it
 * adds its methods to `SvalSettings`.
 */

"use strict";

{
  const { counted } = window.SvalSettingsHelpers;
  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    APPROVAL_WAIT_PREF:
      "moz-src:///browser/components/sval/SvalAgentAlerts.sys.mjs",
    approvalWaitMs:
      "moz-src:///browser/components/sval/SvalAgentAlerts.sys.mjs",
    POLITE_RATE_PREF:
      "moz-src:///browser/components/sval/SvalAgentPolite.sys.mjs",
    workspaceRetentionDays:
      "moz-src:///browser/components/sval/SvalAgents.sys.mjs",
    SvalAgentClients:
      "moz-src:///browser/components/sval/SvalAgentClients.sys.mjs",
    SvalAgents: "moz-src:///browser/components/sval/SvalAgents.sys.mjs",
    SvalColor: "moz-src:///browser/components/sval/SvalColor.sys.mjs",
    SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
    politeRate: "moz-src:///browser/components/sval/SvalAgentPolite.sys.mjs",
  });
  // `SvalPanelModel.sys.mjs` exports functions rather than one object of that
  // name, so it is imported as a namespace.
  ChromeUtils.defineLazyGetter(lazy, "SvalPanelModel", () =>
    ChromeUtils.importESModule(
      "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
    )
  );

  /**
   * Why agent access is switched on with nothing listening, by
   * `SvalAgents.problem`.
   *
   * @param {string|null} problem
   * @returns {string}
   */
  /** The subcategory `gotoPref` hands over for an agent's page. */
  const AGENT_SUBCATEGORY = "agent?";

  /**
   * @param {string} hash An address's hash, with its `#`.
   * @returns {boolean} Whether it is an agent page's.
   */
  const isAgentHash = hash =>
    hash.startsWith(`#svalAgents-${AGENT_SUBCATEGORY}`);

  function agentsProblemText(problem) {
    switch (problem) {
      case null:
        return "";
      case "agents-file":
        return "Agent access couldn't start: Sval can't read its list of paired agents.";
      case "agent-directory":
        return "Agent access couldn't start: Sval can't make its agents folder private.";
      default:
        return "Agent access couldn't start.";
    }
  }

  const SvalAgentsSettings = {
    /**
     * What the agents section shows that is not in the store: the agent
     * whose page shows, its search, filter and add row, the last change
     * and its Undo, and the sites added while the page has been open, which
     * pin to the top of their agent's rules.
     */
    _agentView: {
      open: null,
      q: "",
      filt: "all",
      showAll: false,
      adding: null,
      msg: "",
      undo: null,
      listMsg: "",
      confirm: null,
      recent: new Map(),
    },

    /** What the list was last drawn from, so a redraw that changes nothing is skipped. */
    _agentsDrawn: null,

    /**
     * Finds and wires the Agents pane.
     *
     * @param {Function} byId Finds one of the page's elements by id.
     * @param {Function} followPref Observes a pref until the page goes.
     * @param {Function} followTopic Observes a topic until the page goes.
     */
    _initAgents(byId, followPref, followTopic) {
      Object.assign(this._els, {
        agentsEnabled: byId("sval-agents-enabled"),
        agentsStatus: byId("sval-agents-status"),
        agentsOff: byId("sval-agents-off"),
        agentsLoading: byId("sval-agents-loading"),
        agentsEmpty: byId("sval-agents-empty"),
        agentsMessage: byId("sval-agents-message"),
        agentsSaid: byId("sval-agents-said"),
        agentsFound: byId("sval-agents-found"),
        agentsList: byId("sval-agents-list"),
        clientsList: byId("sval-agent-clients-list"),
        clientsGnome: byId("sval-agent-clients-gnome"),
        clientsMessage: byId("sval-agent-clients-message"),
        clientsPath: byId("sval-agent-clients-path"),
        clientsJson: byId("sval-agent-clients-json"),
        clientsCopyPath: byId("sval-agent-clients-copy-path"),
        clientsCopyJson: byId("sval-agent-clients-copy-json"),
        pageToolsRow: byId("sval-page-tools-row"),
        pageToolsEnabled: byId("sval-page-tools-enabled"),
        pageToolsNote: byId("sval-page-tools-note"),
        politeRate: byId("sval-agents-polite-rate"),
        politeRateStatus: byId("sval-agents-polite-rate-status"),
        approvalWait: byId("sval-agents-wait"),
        retention: byId("sval-agents-retention"),
        unpairDialog: byId("sval-unpair-dialog"),
        unpairTitle: byId("sval-unpair-title"),
        unpairBody: byId("sval-unpair-body"),
        unpairWorkspaces: byId("sval-unpair-workspaces"),
        unpairDeleteWorkspaces: byId("sval-unpair-delete-workspaces"),
        unpairWorkspacesLabel: byId("sval-unpair-workspaces-label"),
        unpairCancel: byId("sval-unpair-cancel"),
        unpairConfirm: byId("sval-unpair-confirm"),
        agentPage: byId("sval-agent-page"),
        agentTitle: byId("sval-agent-title"),
        agentMeta: byId("sval-agent-meta"),
        agentPageSaid: byId("sval-agent-page-said"),
        agentCards: byId("sval-agent-cards"),
      });
      this._initAgentPage(byId);
      this._els.clientsCopyPath.addEventListener("click", () =>
        this._copyClientText(this._els.clientsPath)
      );
      this._els.clientsCopyJson.addEventListener("click", () =>
        this._copyClientText(this._els.clientsJson)
      );
      this._els.agentsEnabled.addEventListener("change", () =>
        this.setAgentAccess(this._els.agentsEnabled.checked)
      );
      this._els.pageToolsEnabled.addEventListener("change", () =>
        this.setPageTools(this._els.pageToolsEnabled.checked)
      );
      this._els.politeRate.addEventListener("change", () =>
        this.setPoliteRate(this._els.politeRate.value)
      );
      this._els.approvalWait.addEventListener("change", () =>
        Services.prefs.setIntPref(
          lazy.APPROVAL_WAIT_PREF,
          Number(this._els.approvalWait.value)
        )
      );
      this._els.retention.addEventListener("change", () =>
        Services.prefs.setIntPref(
          lazy.SvalAgents.WORKSPACE_RETENTION_PREF,
          Number(this._els.retention.value)
        )
      );
      this._els.unpairCancel.addEventListener("click", () =>
        this._els.unpairDialog.close()
      );
      this._els.unpairConfirm.addEventListener("click", () =>
        this.confirmUnpair()
      );
      // A click on the dialog itself, not its contents, is a click on the
      // dimmed page around it.
      this._els.unpairDialog.addEventListener("click", event => {
        if (event.target === this._els.unpairDialog) {
          this._els.unpairDialog.close();
        }
      });
      this._els.unpairDialog.addEventListener("close", () => {
        this._agentView.confirm = null;
      });
      // A pref observer rather than a read on focus: the switch is the pref, and
      // about:config can move it while this page is on screen.
      const agentsPref = () => this._describeAgents();
      followPref(lazy.SvalAgents.PREF, agentsPref);
      followPref(lazy.SvalAgents.PAGE_TOOLS_PREF, agentsPref);
      followPref(lazy.POLITE_RATE_PREF, agentsPref);
      followPref(lazy.APPROVAL_WAIT_PREF, agentsPref);
      followPref(lazy.SvalAgents.WORKSPACE_RETENTION_PREF, agentsPref);
      // And whether the listener could start, which it says once it has tried.
      followTopic(lazy.SvalAgents.STATE_TOPIC, agentsPref);
    },

    /**
     * The AI apps Sval can add itself to, each with what its entry holds and
     * the one action that changes it, and the shim's path and JSON for any
     * other app. An entry Sval wrote for an install that has moved is shown
     * as moved, and only its Connect rewrites it, as only Fix rewrites a
     * broken one: another app's settings change only when the user asks.
     */
    async _drawClients() {
      const shim = lazy.SvalAgentClients.shimPath();
      this._els.clientsPath.value = shim;
      this._els.clientsJson.value = lazy.SvalAgentClients.snippet(shim);
      this._els.clientsGnome.hidden =
        !lazy.SvalAgentClients.opensInFrontOnGnome();
      let clients;
      try {
        clients = await lazy.SvalAgentClients.list();
      } catch (err) {
        lazy.SvalLog.warn(
          `reading AI apps' settings failed: ${lazy.SvalLog.errorName(err)}`
        );
        clients = [];
      }
      const list = this._els.clientsList;
      this._keepFocus(list, () => {
        list.textContent = "";
        for (const client of clients) {
          list.append(this._clientRow(client));
        }
      });
    },

    /**
     * @param {object} client As `SvalAgentClients.list` gives it.
     * @returns {Element}
     */
    _clientRow(client) {
      const words = {
        none: "Not connected.",
        connected: "Connected.",
        changed: "This app has a Sval entry you changed. Connect replaces it.",
        moved: "This app points to a Sval that has moved. Connect updates it.",
        broken:
          "This app points to a Sval that isn't on this computer. Fix points it to this Sval.",
      };
      let note = words[client.state];
      let state = client.state;
      if (!client.available) {
        note = "Not found on this computer.";
        state = "missing";
      } else if (client.problem) {
        note =
          "Sval can't read this app's settings, so it leaves them as they are.";
        state = "unreadable";
      }
      const row = this._el(
        "div",
        { className: "sval-page-tools-row", dataset: { state } },
        this._el(
          "span",
          { className: "sval-page-tools-words" },
          this._el("span", { className: "sval-lead" }, client.label),
          this._el("span", { className: "sval-agents-note" }, note)
        )
      );
      if (client.available && !client.problem) {
        const connected = client.state === "connected";
        let word = connected ? "Disconnect" : "Connect";
        if (client.state === "broken") {
          word = "Fix";
        }
        const button = this._el(
          "button",
          {
            type: "button",
            className: connected
              ? "sval-button sval-agent-small"
              : "sval-button sval-button-primary sval-agent-small",
            ariaLabel: `${word} ${client.label}`,
            dataset: { svalKey: `client:${client.id}` },
          },
          word
        );
        button.addEventListener("click", () =>
          this._changeClient(client, connected ? "disconnect" : "connect")
        );
        row.append(button);
      }
      return row;
    },

    /**
     * Connects or disconnects one app, and says what to do next.
     *
     * @param {object} client
     * @param {"connect"|"disconnect"} action
     */
    async _changeClient(client, action) {
      const message = this._els.clientsMessage;
      try {
        await lazy.SvalAgentClients[action](client.id);
        message.dataset.said = `${action}ed`;
        message.textContent =
          action === "connect"
            ? `${client.label} is connected. ${client.restart} to use Sval.`
            : `${client.label} is disconnected. ${client.restart} to stop it from using Sval.`;
      } catch (err) {
        lazy.SvalLog.warn(
          `changing an AI app's settings failed: ${lazy.SvalLog.errorName(err)}`
        );
        message.dataset.said = "not-changed";
        message.textContent = `Sval couldn't change ${client.label}'s settings. Use the path or JSON below to add Sval by hand.`;
      }
      await this._drawClients();
    },

    /**
     * Copies a read-only field's text, or selects it when copying fails.
     *
     * @param {HTMLInputElement|HTMLTextAreaElement} field
     */
    _copyClientText(field) {
      try {
        Cc["@mozilla.org/widget/clipboardhelper;1"]
          .getService(Ci.nsIClipboardHelper)
          .copyString(field.value);
        this._els.clientsMessage.dataset.said = "copied";
        this._els.clientsMessage.textContent = "Copied.";
      } catch (err) {
        lazy.SvalLog.warn(
          `copying sval-mcp's configuration failed: ${lazy.SvalLog.errorName(err)}`
        );
        this._els.clientsMessage.dataset.said = "not-copied";
        this._els.clientsMessage.textContent =
          "Couldn't copy. The text is selected.";
        field.focus();
        field.select();
      }
    },

    /**
     * Redraws the agents section: the switch, the status line, and the
     * paired agents while a store is open.
     */
    _describeAgents() {
      const enabled = Services.prefs.getBoolPref(lazy.SvalAgents.PREF, false);
      const problem = enabled ? lazy.SvalAgents.problem : null;
      const store = enabled ? lazy.SvalAgents.store : null;
      this._els.agentsEnabled.checked = enabled;
      const pageTools = Services.prefs.getBoolPref(
        lazy.SvalAgents.PAGE_TOOLS_PREF,
        false
      );
      this._els.pageToolsEnabled.checked = pageTools;
      this._els.pageToolsEnabled.disabled = !enabled;
      this._els.pageToolsRow.classList.toggle(
        "sval-page-tools-locked",
        !enabled
      );
      if (this._els.politeRate !== document.activeElement) {
        this._els.politeRate.value = lazy.politeRate();
      }
      this._els.approvalWait.value = String(lazy.approvalWaitMs() / 1000);
      this._els.retention.value = String(lazy.workspaceRetentionDays());
      this._els.pageToolsNote.textContent = enabled
        ? ""
        : `Turn on agent access to change this. It stays ${
            pageTools ? "on" : "off"
          } until then.`;

      const agents = store?.agents() ?? [];
      const status = this._els.agentsStatus;
      status.dataset.problem = problem ?? "";
      if (problem) {
        status.dataset.state = "problem";
        status.textContent = agentsProblemText(problem);
      } else if (!enabled) {
        status.dataset.state = "off";
        status.textContent = "Off. No AI agent can connect to Sval.";
      } else {
        status.dataset.state = "on";
        let words = "On.";
        if (store) {
          words = agents.length
            ? `On. ${counted(agents.length, "agent")} paired.`
            : "On. No agents paired yet.";
        }
        status.textContent = words;
      }

      if (!store) {
        // Nothing is open to edit, so nothing stays open.
        this._leaveAgentPage();
        this._agentView = {
          ...this._agentView,
          open: null,
          adding: null,
          msg: "",
          undo: null,
          listMsg: "",
          recent: new Map(),
        };
        if (this._els.unpairDialog.open) {
          this._els.unpairDialog.close();
        }
      }
      this._els.agentsOff.hidden = enabled;
      this._els.agentsLoading.hidden = !enabled || !!store || !!problem;
      this._els.agentsEmpty.hidden = !store || !!agents.length;
      this._els.agentsMessage.textContent = store
        ? this._agentView.listMsg
        : "";
      this._drawAgents(store, agents);
    },

    /**
     * Draws one row per agent, and the page of the agent whose page shows.
     * The focused control is found again by its `data-sval-key` after the
     * redraw, so a change made from it keeps the caret where it was.
     *
     * @param {SvalAgentStore|null} store
     * @param {object[]} agents `store.agents()`.
     * @param {boolean} [force] Redraw even if nothing the list shows changed.
     */
    _drawAgents(store, agents, force = false) {
      // The page's editor is drawn afresh on each change, so the page's one
      // status line is what speaks its message.
      const view = this._agentView;
      this._say(this._els.agentPageSaid, view.open ? view.msg : "");
      const list = this._els.agentsList;
      const workspaces = this._agentWorkspaces();
      const policies = agents.map(a => store.policyOf(a.agentId));
      const drawn = JSON.stringify([
        agents,
        policies,
        workspaces,
        this._pageToolsOn(),
      ]);
      if (!force && drawn === this._agentsDrawn) {
        return;
      }
      this._agentsDrawn = drawn;

      this._keepFocus(list, () => {
        list.textContent = "";
        agents.forEach((agent, i) => {
          list.append(this._agentRow(agent, policies[i], workspaces));
        });
      });
      this._drawAgentPage(agents, policies, workspaces);
    },

    /**
     * Wires the agent page's own controls, and leaves it when the address,
     * the category or the category's button does.
     *
     * @param {Function} byId
     */
    _initAgentPage(byId) {
      byId("sval-agent-back").addEventListener("click", () =>
        this._backToAgents()
      );
      byId("sval-agent-crumb").addEventListener("click", event => {
        event.preventDefault();
        this._backToAgents();
      });
      window.addEventListener("hashchange", event => {
        if (this._agentView.open && !isAgentHash(new URL(event.newURL).hash)) {
          this._showAgentList(this._leaveAgentPage());
        }
      });
      document.addEventListener("paneshown", event => {
        if (!event.detail.subcategory?.startsWith(AGENT_SUBCATEGORY)) {
          this._leaveAgentPage();
        }
      });
      // The category's button pressed while the page shows asks for the
      // category already current, which `gotoPref` ignores.
      byId("category-svalAgents")?.addEventListener("change-view", () => {
        if (this._agentView.open) {
          this._showAgentList(this._leaveAgentPage());
        }
      });
    },

    /**
     * @param {string} agentId
     * @returns {string} The subcategory that shows the agent's page.
     */
    _agentSubcategory(agentId) {
      return `${AGENT_SUBCATEGORY}${new URLSearchParams({ id: agentId })}`;
    },

    /**
     * Shows an agent's page from inside Settings, as a new history entry.
     *
     * @param {string} agentId
     */
    showAgent(agentId) {
      if (this._agentView.open === agentId) {
        return;
      }
      const from = location.href;
      this._agentFrom = from;
      window
        .gotoPref(`svalAgents-${this._agentSubcategory(agentId)}`)
        .finally(() => {
          if (this._agentFrom === from) {
            this._agentFrom = null;
          }
        });
    },

    /**
     * Opens the page `gotoPref` was asked for, after it rewrote the hash. An
     * agent no open store lists shows the list.
     *
     * @param {string} subcategory `agent?id=…`.
     */
    _openAgentPage(subcategory) {
      const from = this._agentFrom ?? null;
      this._agentFrom = null;
      const id = subcategory.startsWith(AGENT_SUBCATEGORY)
        ? new URLSearchParams(subcategory.slice(AGENT_SUBCATEGORY.length)).get(
            "id"
          )
        : null;
      const store = lazy.SvalAgents.store;
      const agent = id && store?.agents().find(a => a.agentId === id);
      if (!agent) {
        this._showAgentList(this._leaveAgentPage());
        return;
      }
      const hash = `#svalAgents-${this._agentSubcategory(id)}`;
      if (location.hash !== hash) {
        // `gotoPref` leaves the address alone when the category is already
        // showing; then the page is a step of its own for Back.
        if (from !== null && from === location.href) {
          history.pushState(
            { ...history.state, svalAgentPage: true },
            "",
            hash
          );
        } else {
          history.replaceState(history.state, "", hash);
        }
      }
      if (this._agentView.open !== id) {
        this._agentView = {
          ...this._agentView,
          open: id,
          q: "",
          filt: "all",
          showAll: false,
          adding: null,
          msg: "",
          undo: null,
        };
      }
      const els = this._els;
      els.agentPage.hidden = false;
      els.agentPage.closest("[data-sval-pane]").dataset.sitePage = "";
      document.querySelector("title").removeAttribute("data-l10n-id");
      document.title = `${agent.label} · Settings`;
      this._redrawAgents();
      els.agentTitle.focus({ preventScroll: true });
      els.agentPage.scrollIntoView({ block: "start" });
    },

    /**
     * Hides the agent's page, if it shows, and gives the pane its cards back.
     *
     * @returns {?string} The agent the page showed.
     */
    _leaveAgentPage() {
      const els = this._els;
      const id = this._agentView.open;
      if (!els?.agentPage || !id) {
        return null;
      }
      this._agentView = {
        ...this._agentView,
        open: null,
        adding: null,
        msg: "",
        undo: null,
      };
      els.agentPage.hidden = true;
      delete els.agentPage.closest("[data-sval-pane]").dataset.sitePage;
      els.agentCards.textContent = "";
      if (isAgentHash(location.hash)) {
        history.replaceState(history.state, "", "#svalAgents");
      }
      document.l10n.setAttributes(
        document.querySelector("title"),
        "settings-page-title"
      );
      return id;
    },

    /**
     * Back, from the button or the breadcrumb: to the entry before when the
     * page made one, whose `hashchange` leaves the page; otherwise straight
     * to the list.
     */
    _backToAgents() {
      if (history.state?.svalAgentPage) {
        history.back();
        return;
      }
      this._showAgentList(this._leaveAgentPage());
    },

    /**
     * The list, with focus on the agent's link when it still lists it.
     *
     * @param {?string} agentId The agent the page showed.
     */
    _showAgentList(agentId) {
      const els = this._els;
      (
        (agentId &&
          els.agentsList.querySelector(
            `[data-agent-id="${CSS.escape(agentId)}"]`
          )) ||
        els.agentPage
          .closest("[data-sval-pane]")
          .querySelector(".sval-pane-title")
      )?.focus();
    },

    /**
     * The page of the agent whose page shows: its name, what Sval knows of
     * it, and its permissions. An agent unpaired while its page shows takes
     * the page with it.
     *
     * @param {object[]} agents
     * @param {object[]} policies
     * @param {object} workspaces From `_agentWorkspaces`.
     */
    _drawAgentPage(agents, policies, workspaces) {
      const id = this._agentView.open;
      if (!id) {
        return;
      }
      const at = agents.findIndex(a => a.agentId === id);
      if (at === -1) {
        this._showAgentList(this._leaveAgentPage());
        return;
      }
      const agent = agents[at];
      const els = this._els;
      this._setText(els.agentTitle, agent.label);
      const held = agent.workspaces.filter(w => workspaces[w.workspaceId]);
      let where = "";
      if (held.length === 1) {
        where = `Works in ${workspaces[held[0].workspaceId].name}`;
      } else if (held.length) {
        where = `Works in ${held.length} Workspaces`;
      }
      this._setText(els.agentMeta, where);
      els.agentMeta.hidden = !els.agentMeta.textContent;
      const unpair = this._el(
        "button",
        {
          type: "button",
          className: "sval-button",
          dataset: { svalKey: `page-unpair:${id}` },
        },
        `Unpair ${agent.label}`
      );
      unpair.addEventListener("click", () => this.askToUnpair(agent));
      this._keepFocus(els.agentCards, () =>
        els.agentCards.replaceChildren(
          this._el(
            "section",
            {
              className: "sval-card sval-site-card",
              ariaLabel: "Permissions",
            },
            this._agentEditor(agent, policies[at])
          ),
          this._el(
            "section",
            { className: "sval-card sval-site-card", ariaLabel: "Unpair" },
            this._el(
              "p",
              { className: "sval-agents-note" },
              "Unpairing disconnects the agent and deletes its permissions."
            ),
            unpair
          )
        )
      );
    },

    /** Redraws the list from the open store, whatever it was drawn from. */
    _redrawAgents() {
      const store = lazy.SvalAgents.store;
      this._drawAgents(store, store?.agents() ?? [], true);
    },

    /**
     * Each workspace's name and colour, by id, from the profile's panel. An
     * agent's workspace has no colour of its own (agent-control spec §6), so
     * it draws in the muted ink.
     *
     * @returns {object} `{[id]: {name, color}}`, `color` a CSS colour or null.
     */
    _agentWorkspaces() {
      const panel = this.panel;
      if (!panel) {
        return {};
      }
      const workspaces = {};
      for (const item of lazy.SvalPanelModel.switcherItems(panel.nodes, null)) {
        const color =
          item.color && !item.agent ? lazy.SvalColor.markOf(item.color) : null;
        workspaces[item.id] = {
          name: item.name || "Untitled Workspace",
          color,
        };
      }
      return workspaces;
    },

    /**
     * Asks, in the modal dialog, whether to unpair `agent`. Cancel has the
     * focus.
     *
     * @param {object} agent
     */
    askToUnpair(agent) {
      this._agentView = {
        ...this._agentView,
        adding: null,
        listMsg: "",
        confirm: agent,
      };
      this._els.agentsMessage.textContent = "";
      this._redrawAgents();
      this._els.unpairTitle.textContent = `Unpair ${agent.label}?`;
      this._els.unpairBody.textContent = `${agent.label} disconnects now, and Sval deletes its permissions. To use Sval again, it has to pair again.`;
      const workspaces = this._agentWorkspaces();
      const held = agent.workspaces.filter(w => workspaces[w.workspaceId]);
      this._els.unpairWorkspaces.hidden = !held.length;
      this._els.unpairDeleteWorkspaces.checked = true;
      this._els.unpairWorkspacesLabel.textContent =
        held.length === 1
          ? "Also delete its Workspace and the tabs in it"
          : `Also delete its ${held.length} Workspaces and the tabs in them`;
      this._els.unpairDialog.showModal();
      this._els.unpairCancel.focus();
    },

    /**
     * Unpairs the agent the dialog asked about: `SvalAgents.unpair` removes
     * its record and policy and closes its connections.
     */
    async confirmUnpair() {
      const agent = this._agentView.confirm;
      this._els.unpairDialog.close();
      if (!agent) {
        return;
      }
      const deleteWorkspaces =
        !this._els.unpairWorkspaces.hidden &&
        this._els.unpairDeleteWorkspaces.checked;
      if (await lazy.SvalAgents.unpair(agent.agentId, { deleteWorkspaces })) {
        this._agentView.listMsg = `Unpaired ${agent.label}. Its connection is closed.`;
        this._agentView.recent.delete(agent.agentId);
      }
      this._describeAgents();
    },

    /**
     * Turns agent access on or off. `SvalAgents` watches the pref, opening its
     * listener when it turns on and closing it when it turns off.
     *
     * @param {boolean} enabled
     */
    setAgentAccess(enabled) {
      Services.prefs.setBoolPref(lazy.SvalAgents.PREF, enabled);
    },

    /**
     * Lets sites offer tools to agents, or stops them. Only while agent
     * access is on (site-tools spec §6); the switch is disabled otherwise.
     *
     * @param {boolean} enabled
     */
    setPageTools(enabled) {
      if (Services.prefs.getBoolPref(lazy.SvalAgents.PREF, false)) {
        Services.prefs.setBoolPref(lazy.SvalAgents.PAGE_TOOLS_PREF, enabled);
      }
      this._describeAgents();
    },

    /**
     * Sets how many actions a second an agent that is polite may take on a
     * site (`SvalAgentPolite`). A value that is not a whole number of at
     * least one leaves the setting as it was.
     *
     * @param {string} value What the field holds.
     */
    setPoliteRate(value) {
      const rate = Number(value);
      const field = this._els.politeRate;
      const valid = Number.isInteger(rate) && rate >= 1 && rate <= 100;
      field.setAttribute("aria-invalid", String(!valid));
      // A value out of range stays in the field, with what to type instead.
      this._els.politeRateStatus.textContent = valid
        ? ""
        : "Enter a whole number from 1 to 100.";
      if (valid) {
        Services.prefs.setIntPref(lazy.POLITE_RATE_PREF, rate);
        field.value = lazy.politeRate();
      }
    },
  };

  Object.assign(window.SvalSettings, SvalAgentsSettings);
}
