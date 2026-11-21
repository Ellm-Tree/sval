/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Settings' Links pane (link routing spec §7): the Peek's idle close
 * time, the words under its switch and the Quick Peek's, and the routing rules
 * (`SvalLinkRules`), which the user adds, edits, reorders and deletes here
 * and nowhere else. The two switches are bound to their prefs by
 * `SvalSettings._bindPrefSwitches`, as every switch that is one pref is.
 *
 * The workspaces a rule may name are the ones a Peek offers
 * (`SvalPeek.destinationChoices`), read from the profile's panel each
 * time the pane draws, so a workspace deleted or renamed elsewhere shows as
 * such when the page is next looked at. Which rule a rule above always
 * matches first is worked out as it draws, so the marks follow every
 * reorder and edit; no rule is ever removed for one.
 *
 * `SvalPreferences` loads this as a classic script into the preferences page;
 * `settings-pane.js` calls `init` once the panes' markup is in place. It
 * draws with `SvalSettings`' own helpers, so its rows, add row and status
 * line behave as the Sites list's do.
 */

"use strict";

{
  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    QUICK_PEEK_CLICK_PREF:
      "moz-src:///browser/components/sval/SvalQuickPeek.sys.mjs",
    QUICK_PEEK_PREF: "moz-src:///browser/components/sval/SvalQuickPeek.sys.mjs",
    clickText: "moz-src:///browser/components/sval/SvalKeys.sys.mjs",
    quickPeekClick: "moz-src:///browser/components/sval/SvalQuickPeek.sys.mjs",
    SvalColor: "moz-src:///browser/components/sval/SvalColor.sys.mjs",
    SvalLinkRules: "moz-src:///browser/components/sval/SvalLinkRules.sys.mjs",
    SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
    SvalPeek: "moz-src:///browser/components/sval/SvalPeek.sys.mjs",
    SvalScope: "moz-src:///browser/components/sval/SvalScope.sys.mjs",
    workspaceTitle: "moz-src:///browser/components/sval/SvalPeek.sys.mjs",
  });

  const ISOLATED_TEXT =
    "Isolated: sites here can't see sign-ins from other Workspaces";

  /** @returns {object} the page's `SvalSettings`, whose helpers draw here. */
  const ui = () => window.SvalSettings;

  const SvalLinksSettings = {
    /**
     * The rules card's view: the rule being added or edited, as typed, the
     * last change's words with its Undo, and the row being dragged.
     */
    _view: {
      adding: null,
      editing: null,
      msg: "",
      undo: null,
      drag: null,
    },

    _els: null,

    /** True while this page writes the rules, which redraws on its own. */
    _writing: false,

    init() {
      const byId = id => document.getElementById(id);
      this._els = {
        peekNote: byId("sval-peek-note"),
        idleRow: byId("sval-peek-idle-row"),
        idle: byId("sval-peek-idle"),
        idleNote: byId("sval-peek-idle-note"),
        quickPeekLabel: byId("sval-quick-peek-label"),
        quickPeekNote: byId("sval-quick-peek-note"),
        add: byId("sval-link-rules-add"),
        sync: byId("sval-link-rules-sync"),
        body: byId("sval-link-rules-body"),
        status: byId("sval-link-rules-status"),
      };
      const peek = lazy.SvalPeek;
      this._els.idle.addEventListener("change", () =>
        Services.prefs.setIntPref(peek.IDLE_PREF, Number(this._els.idle.value))
      );
      this._els.add.addEventListener("click", () => {
        this._view = {
          ...this._view,
          adding: {
            kind: lazy.SvalLinkRules.SITE,
            text: "",
            workspace: this._choices()[0]?.id ?? "",
          },
          editing: null,
          msg: "",
          undo: null,
        };
        this.drawRules();
        this._els.body.querySelector(".sval-agent-add-input")?.focus();
      });

      const lifetime = lazy.SvalScope.forWindow(window);
      const switches = () => this.drawSwitches();
      lifetime.pref(peek.ENABLED_PREF, switches);
      lifetime.pref(peek.IDLE_PREF, switches);
      lifetime.pref(lazy.QUICK_PEEK_PREF, switches);
      lifetime.pref(lazy.QUICK_PEEK_CLICK_PREF, switches);
      // A sync can move the rules while the page is on screen. A change made
      // here redraws once it is written, with focus where it belongs.
      lifetime.pref(lazy.SvalLinkRules.RULES_PREF, () => {
        if (!this._writing) {
          this.drawRules();
        }
      });
      // Workspaces are deleted and renamed in a browser window, so coming
      // back to this one is when they may have changed.
      window.addEventListener("focus", () => this.drawRules());
      this.drawSwitches();
      this.drawRules();
    },

    /** The words under each switch, the idle time, and the Quick Peek's click. */
    drawSwitches() {
      const peek = lazy.SvalPeek;
      const els = this._els;
      const peekOn = Services.prefs.getBoolPref(peek.ENABLED_PREF, true);
      els.peekNote.textContent = peekOn
        ? "A Peek opens in a small window over the app and isn't part of any Workspace. To keep the page, open it in a Workspace."
        : "Links from other apps open as a new tab in the frontmost window.";
      const minutes = Services.prefs.getIntPref(peek.IDLE_PREF, 360);
      els.idle.value = String(minutes);
      els.idle.disabled = !peekOn;
      els.idleRow.classList.toggle("sval-links-off", !peekOn);
      els.idleNote.textContent = minutes
        ? "Sval closes a Peek you haven't used for this long. Its page stays in History."
        : "Peeks stay until you close them. They still close when Sval quits.";
      const click = lazy.clickText(lazy.quickPeekClick());
      els.quickPeekLabel.textContent = `Open a link in a Quick Peek with ${click}`;
      els.quickPeekNote.textContent = Services.prefs.getBoolPref(
        lazy.QUICK_PEEK_PREF,
        true
      )
        ? "The link opens over the current tab, with the tab's sign-ins. To use another click, go to Settings › Keyboard shortcuts."
        : `When this switch is off, ${click} works the way it does without Sval.`;
    },

    /**
     * @returns {object[]} the workspaces a rule may name, from the profile's
     *   panel, as a Peek offers them.
     */
    _choices() {
      const nodes = ui().panel?.nodes;
      return nodes ? lazy.SvalPeek.destinationChoices(nodes) : [];
    },

    /**
     * Redraws the rules card, keeping the keyboard's place in it.
     *
     * @param {?(string|string[])} [next] Where focus goes when the redraw
     *   takes away the control that had it (`SvalSettings._keepFocus`).
     * @param {boolean} [take] As for `SvalSettings._keepFocus`.
     */
    drawRules(next = null, take = false) {
      if (this._view.drag !== null) {
        return;
      }
      ui()._keepFocus(
        this._els.body.closest(".sval-card"),
        () => this._drawRules(),
        next,
        take
      );
    },

    _drawRules() {
      const view = this._view;
      const els = this._els;
      const rules = lazy.SvalLinkRules.rules();
      const choices = this._choices();
      const byId = new Map(choices.map(choice => [choice.id, choice]));
      els.add.disabled = !!view.adding;
      els.sync.textContent =
        ui().panel?.syncState.folderState === "none"
          ? "Sync is off, so rules stay on this device."
          : "Rules sync to all your devices.";

      // The rule being edited is found by what it is, since a sync or a
      // reorder can move it; one that is gone takes its form with it.
      if (
        view.editing &&
        !rules.some(rule => this._key("edit", rule) === view.editing.key)
      ) {
        view.editing = null;
      }

      const body = els.body;
      body.textContent = "";
      if (view.adding) {
        body.append(this._form(rules, byId, view.adding, rules.length, true));
      }
      if (!rules.length && !view.adding) {
        body.append(this._empty());
      }
      if (rules.length) {
        body.append(this._table(rules, byId));
      }

      const undo = view.undo;
      ui()._say(
        els.status,
        view.msg,
        undo &&
          (() => {
            const list = lazy.SvalLinkRules.rules();
            list.splice(Math.min(undo.at, list.length), 0, undo.rule);
            this._view = { ...this._view, msg: "", undo: null };
            this._write(list, [this._key("edit", undo.rule), "add-rule"]);
          }),
        "rule-undo"
      );
    },

    /**
     * Saves the rules and redraws, with focus on the first of `next`.
     *
     * @param {object[]} list
     * @param {?(string|string[])} next
     */
    _write(list, next) {
      this._writing = true;
      try {
        lazy.SvalLinkRules.setRules(list);
      } catch (err) {
        lazy.SvalLog.warn(
          `could not save the link rules: ${lazy.SvalLog.errorName(err)}`
        );
      } finally {
        this._writing = false;
      }
      this.drawRules(next, true);
    },

    /**
     * A key for a rule's control that follows the rule as it moves.
     *
     * @param {string} what
     * @param {object} rule
     * @returns {string}
     */
    _key(what, rule) {
      return `${what}:${rule.kind}:${rule.value}`;
    },

    /** @returns {Element} Settings' empty block, for rules. */
    _empty() {
      return ui()._emptyState(
        "No rules yet",
        "Add one to dock a site's links from other apps in a Workspace."
      );
    },

    /**
     * A workspace's tile, as the Peek draws it: its icon, or the
     * workspace glyph, on its colour, read from a browser window, where the
     * colours are defined.
     *
     * @param {object} choice From `destinationChoices`.
     * @returns {Element}
     */
    _tile(choice) {
      const tile = ui()._el("span", {
        className: "sval-links-tile",
        ariaHidden: "true",
      });
      if (choice.mark) {
        tile.style.setProperty("--sval-tile-mark", `url("${choice.mark}")`);
      } else if (choice.emoji) {
        tile.textContent = choice.emoji;
      }
      if (choice.color) {
        tile.style.setProperty(
          "--sval-links-tile",
          lazy.SvalColor.markOf(choice.color)
        );
      }
      return tile;
    },

    /**
     * The rules, in order, one row each: its place, what it matches, its
     * workspace, and what to do with it.
     *
     * @param {object[]} rules
     * @param {Map<string, object>} byId The workspaces a rule may name.
     * @returns {Element}
     */
    _table(rules, byId) {
      const el = (...args) => ui()._el(...args);
      const table = el("div", {
        className: "sval-agent-table sval-links-table",
        role: "table",
        ariaLabel: "Rules, in order",
      });
      table.append(
        el(
          "div",
          { className: "sval-links-rule sval-agent-rule-head", role: "row" },
          el("span"),
          el("span", { role: "columnheader" }, "#"),
          el("span", { role: "columnheader" }, "Match"),
          el("span"),
          el("span", { role: "columnheader" }, "Opens in"),
          el("span")
        )
      );
      const ids = new Set(byId.keys());
      const rows = [];
      rules.forEach((rule, at) => {
        if (this._key("edit", rule) === this._view.editing?.key) {
          table.append(
            el(
              "div",
              { role: "row" },
              el(
                "div",
                { role: "cell" },
                this._form(rules, byId, this._view.editing, at, false)
              )
            )
          );
          rows.push(null);
          return;
        }
        const row = this._row(rules, at, byId, ids, rows);
        rows.push(row);
        table.append(row);
      });
      return table;
    },

    /**
     * One rule's row.
     *
     * @param {object[]} rules
     * @param {number} at
     * @param {Map<string, object>} byId
     * @param {Set<string>} ids
     * @param {Element[]} rows The rows above, for the mark to light the rule
     *   that wins.
     * @returns {Element}
     */
    _row(rules, at, byId, ids, rows) {
      const lr = lazy.SvalLinkRules;
      const el = (...args) => ui()._el(...args);
      const rule = rules[at];
      const n = at + 1;
      const choice = byId.get(rule.workspace);
      const by = choice ? lr.coveredBy(rules, at, ids) : -1;

      const row = el("div", {
        className: "sval-links-rule",
        role: "row",
        draggable: true,
      });
      row.classList.toggle("sval-links-covered", by >= 0);

      const grip = el(
        "button",
        {
          type: "button",
          className: "sval-links-grip",
          ariaLabel: `Move rule ${n}, ${rule.value}`,
          title: "Drag to reorder, or focus and press Up or Down",
          dataset: { svalKey: this._key("grip", rule) },
        },
        ui()._glyph("grip-vertical")
      );
      grip.addEventListener("keydown", event => {
        const step = { ArrowUp: -1, ArrowDown: 1 }[event.key];
        const to = step ? at + step : -1;
        if (to < 0 || to >= rules.length) {
          return;
        }
        event.preventDefault();
        this._move(at, to, this._key("grip", rule));
      });

      const value = el("span", { className: "sval-agent-site" }, rule.value);
      value.title = rule.value;
      const what = el(
        "span",
        { className: "sval-links-value", role: "cell" },
        value
      );
      if (by >= 0) {
        const mark = el(
          "span",
          { className: "sval-links-mark" },
          ui()._glyph("triangle-alert"),
          el(
            "span",
            {},
            el("strong", {}, "This rule never applies."),
            ` Rule ${by + 1}, ${lr.describe(rules[by])}, always matches first.`
          )
        );
        mark.addEventListener("mouseover", () =>
          rows[by]?.classList.add("sval-links-wins")
        );
        mark.addEventListener("mouseout", () =>
          rows[by]?.classList.remove("sval-links-wins")
        );
        what.append(mark);
      }

      const where = el("span", {
        className: "sval-links-workspace",
        role: "cell",
        dataset: { workspace: choice?.id ?? "" },
      });
      if (choice) {
        where.append(
          this._tile(choice),
          el(
            "span",
            { className: "sval-links-workspace-name" },
            lazy.workspaceTitle(choice.name)
          )
        );
        if (choice.isolated) {
          where.append(
            el("span", {
              className: "sval-links-isolated",
              title: ISOLATED_TEXT,
            })
          );
        }
      } else {
        const peekOn = Services.prefs.getBoolPref(
          lazy.SvalPeek.ENABLED_PREF,
          true
        );
        where.classList.add("sval-links-none");
        where.append(
          el("span", { className: "sval-links-tile-none", ariaHidden: "true" }),
          el(
            "span",
            { className: "sval-fp-words" },
            el("span", { className: "sval-links-none-title" }, "No Workspace"),
            el(
              "span",
              { className: "sval-agents-note" },
              `Its Workspace was deleted. Choose another, or links open ${
                peekOn ? "in a Peek" : "as a new tab in the frontmost window"
              }.`
            )
          )
        );
      }

      const edit = el(
        "button",
        {
          type: "button",
          className: "sval-agent-remove",
          ariaLabel: `Edit rule ${n}`,
          title: "Edit rule",
          dataset: { svalKey: this._key("edit", rule) },
        },
        ui()._glyph("pencil")
      );
      edit.addEventListener("click", () => {
        this._view = {
          ...this._view,
          editing: {
            key: this._key("edit", rule),
            kind: rule.kind,
            text: rule.value,
            workspace: choice ? rule.workspace : "",
          },
          adding: null,
          msg: "",
          undo: null,
        };
        this.drawRules();
        this._els.body.querySelector(".sval-agent-add-input")?.focus();
      });
      const remove = el(
        "button",
        {
          type: "button",
          className: "sval-agent-remove",
          ariaLabel: `Delete rule ${n}`,
          title: "Delete rule",
          dataset: { svalKey: this._key("remove", rule) },
        },
        ui()._glyph("x")
      );
      remove.addEventListener("click", () => {
        const list = lr.rules();
        list.splice(at, 1);
        this._view = {
          ...this._view,
          editing: null,
          msg: `Rule ${n}, ${lr.describe(rule)}, deleted.`,
          undo: { rule, at },
        };
        this._write(list, "rule-undo");
      });

      row.append(
        el("span", { role: "cell" }, grip),
        el("span", { className: "sval-links-number", role: "cell" }, String(n)),
        el(
          "span",
          { className: "sval-links-kind", role: "cell" },
          rule.kind === lr.SITE ? "Site" : "Address contains"
        ),
        what,
        where,
        el(
          "span",
          { className: "sval-links-actions", role: "cell" },
          edit,
          remove
        )
      );
      this._dragging(row, rule);
      return row;
    },

    /**
     * Moves the rule at `from` to `to`, as one write.
     *
     * @param {number} from
     * @param {number} to Its place once moved.
     * @param {string} [focus] The key that takes focus after.
     */
    _move(from, to, focus = null) {
      const list = lazy.SvalLinkRules.rules();
      const [rule] = list.splice(from, 1);
      list.splice(to, 0, rule);
      this._view = { ...this._view, msg: "", undo: null };
      this._write(list, focus ?? this._key("grip", rule));
    },

    /**
     * Lets a row be dragged by its grip, or anywhere on it, to a new place:
     * a line shows where it lands, and the row dragged fades. Rules are found
     * by what they are when the row lands, since a sync can move them while
     * the row is in flight.
     *
     * @param {Element} row
     * @param {object} rule The row's rule.
     */
    _dragging(row, rule) {
      const key = this._key("grip", rule);
      const clear = () => {
        for (const each of this._els.body.querySelectorAll(
          ".sval-links-drop-before, .sval-links-drop-after"
        )) {
          each.classList.remove(
            "sval-links-drop-before",
            "sval-links-drop-after"
          );
        }
      };
      const after = event => {
        const box = row.getBoundingClientRect();
        return event.clientY > box.top + box.height / 2;
      };
      row.addEventListener("dragstart", event => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", rule.value);
        this._view.drag = key;
        row.classList.add("sval-links-dragged");
      });
      row.addEventListener("dragover", event => {
        if (this._view.drag === null) {
          return;
        }
        event.preventDefault();
        clear();
        row.classList.add(
          after(event) ? "sval-links-drop-after" : "sval-links-drop-before"
        );
      });
      row.addEventListener("drop", event => {
        const dragged = this._view.drag;
        if (dragged === null) {
          return;
        }
        event.preventDefault();
        this._view.drag = null;
        clear();
        const list = lazy.SvalLinkRules.rules();
        const from = list.findIndex(
          each => this._key("grip", each) === dragged
        );
        const over = list.findIndex(each => this._key("grip", each) === key);
        if (from < 0 || over < 0) {
          this.drawRules();
          return;
        }
        const to = over + (after(event) ? 1 : 0);
        // The place it lands, counted once it has left its own.
        const place = Math.min(to > from ? to - 1 : to, list.length - 1);
        if (place !== from) {
          this._move(from, place);
        } else {
          this.drawRules();
        }
      });
      row.addEventListener("dragend", () => {
        if (this._view.drag !== null) {
          this._view.drag = null;
          this.drawRules();
        }
      });
    },

    /**
     * The row that adds a rule, or edits one in its place: what it matches,
     * the workspace, and a line saying what it will do or why it cannot be
     * saved, with a warning when another rule would always win over it or
     * it would always win over one below.
     *
     * @param {object[]} rules
     * @param {Map<string, object>} byId
     * @param {object} draft `{ kind, text, workspace }`, as typed.
     * @param {number} at Where the rule is or will be.
     * @param {boolean} isAdd
     * @returns {Element}
     */
    _form(rules, byId, draft, at, isAdd) {
      const lr = lazy.SvalLinkRules;
      const el = (...args) => ui()._el(...args);
      const which = isAdd ? "adding" : "editing";
      const prefix = isAdd ? "add-rule" : "edit-rule";

      const kind = el("select", {
        className: "sval-agent-select",
        ariaLabel: "Match by",
        dataset: { svalKey: `${prefix}-kind` },
      });
      kind.append(
        el("option", { value: lr.SITE }, "Site"),
        el("option", { value: lr.CONTAINS }, "Address contains")
      );
      kind.value = draft.kind;
      const input = el("input", {
        type: "text",
        className: "sval-agent-add-input",
        spellcheck: false,
        value: draft.text,
        dataset: { svalKey: `${prefix}-text` },
      });
      const workspace = el("select", {
        className: "sval-agent-select sval-links-workspace-select",
        ariaLabel: "Workspace",
        dataset: { svalKey: `${prefix}-workspace` },
      });
      if (!draft.workspace) {
        workspace.append(
          el(
            "option",
            { value: "", disabled: true, selected: true },
            "Choose a Workspace"
          )
        );
      }
      for (const choice of byId.values()) {
        workspace.append(
          el(
            "option",
            { value: choice.id },
            `${lazy.workspaceTitle(choice.name)}${
              choice.isolated ? " (isolated)" : ""
            }`
          )
        );
      }
      workspace.value = draft.workspace;
      const save = el(
        "button",
        {
          type: "button",
          className: "sval-button sval-button-primary sval-agent-small",
          dataset: { svalKey: `${prefix}-save` },
        },
        isAdd ? "Add" : "Save"
      );
      const cancel = el(
        "button",
        {
          type: "button",
          className: "sval-button sval-agent-small",
          dataset: { svalKey: `${prefix}-cancel` },
        },
        "Cancel"
      );
      const preview = el("div", {
        className: "sval-agent-preview",
        ariaLive: "polite",
      });
      const warning = el("div", { className: "sval-links-warning" });
      const ids = new Set(byId.keys());

      let saving = null;
      const describe = () => {
        const site = kind.value === lr.SITE;
        input.placeholder = site
          ? "Site, like notion.so"
          : "Part of an address, like github.com/acme";
        input.setAttribute("aria-label", site ? "Site" : "Address contains");
        const text = input.value.trim();
        const value = lr.ruleValue(kind.value, text);
        const others = rules.filter((_, i) => isAdd || i !== at);
        saving = null;
        warning.textContent = "";
        preview.dataset.tone = "quiet";
        input.setAttribute("aria-invalid", "false");
        if (!text) {
          preview.textContent = site
            ? "Type a site, like notion.so, or paste an address."
            : "Type part of an address, like github.com/acme.";
        } else if (!value) {
          preview.textContent = site
            ? "Enter a site like notion.so, or paste an address."
            : "Use at least 3 characters, with no spaces.";
          preview.dataset.tone = "problem";
          input.setAttribute("aria-invalid", "true");
        } else if (
          others.some(rule => rule.kind === kind.value && rule.value === value)
        ) {
          const same = rules.findIndex(
            (rule, i) =>
              (isAdd || i !== at) &&
              rule.kind === kind.value &&
              rule.value === value
          );
          preview.textContent = `Rule ${same + 1} is already for ${lr.describe(
            rules[same]
          )}.`;
          preview.dataset.tone = "problem";
        } else if (!byId.has(workspace.value)) {
          preview.textContent = "Choose a Workspace.";
        } else {
          const choice = byId.get(workspace.value);
          saving = { kind: kind.value, value, workspace: workspace.value };
          preview.dataset.tone = "";
          preview.textContent = `${
            site
              ? `Links from other apps to ${value} and its subdomains`
              : `Links from other apps whose address contains "${value}"`
          } dock in ${lazy.workspaceTitle(choice.name)}${
            choice.isolated ? ", which is isolated." : "."
          }`;
          const above = rules
            .slice(0, at)
            .findIndex(
              rule =>
                ids.has(rule.workspace) && lr.alwaysMatchesFirst(rule, saving)
            );
          const below = [];
          rules.forEach((rule, i) => {
            if (
              i >= at &&
              (isAdd || i !== at) &&
              lr.alwaysMatchesFirst(saving, rule) &&
              lr.coveredBy(rules, i, ids) < 0
            ) {
              below.push(i + 1);
            }
          });
          const parts = [];
          if (above >= 0) {
            parts.push(
              `Rule ${above + 1}, ${lr.describe(
                rules[above]
              )}, always matches first, so this rule would never apply. You can still save it, then drag it above rule ${
                above + 1
              }.`
            );
          }
          if (below.length) {
            parts.push(
              `${
                below.length === 1
                  ? `Rule ${below[0]}`
                  : `Rules ${below.join(" and ")}`
              } would never apply after this.`
            );
          }
          if (parts.length) {
            warning.append(
              ui()._glyph("triangle-alert"),
              el("span", {}, parts.join(" "))
            );
          }
        }
        save.disabled = !saving;
        this._view[which] = {
          ...this._view[which],
          kind: kind.value,
          text: input.value,
          workspace: workspace.value,
        };
      };
      const done = () => {
        if (!saving) {
          return;
        }
        const list = lr.rules();
        const place = isAdd
          ? list.length
          : list.findIndex(rule => this._key("edit", rule) === draft.key);
        if (place < 0) {
          this._view = { ...this._view, [which]: null };
          this.drawRules("add-rule", true);
          return;
        }
        list[place] = saving;
        this._view = {
          ...this._view,
          [which]: null,
          msg: isAdd
            ? `Added rule ${list.length}.`
            : `Rule ${place + 1} saved.`,
          undo: null,
        };
        this._write(list, [this._key("edit", saving), "add-rule"]);
      };
      const stop = () => {
        this._view = { ...this._view, [which]: null };
        this.drawRules(isAdd ? "add-rule" : this._key("edit", rules[at]), true);
      };
      for (const control of [kind, input, workspace]) {
        control.addEventListener(
          control === input ? "input" : "change",
          describe
        );
      }
      for (const control of [kind, input, workspace]) {
        control.addEventListener("keydown", event => {
          if (event.key === "Enter" && control === input) {
            event.preventDefault();
            done();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            stop();
          }
        });
      }
      save.addEventListener("click", done);
      cancel.addEventListener("click", stop);
      describe();
      return el(
        "div",
        {
          className: "sval-agent-adding sval-links-adding",
          role: "group",
          ariaLabel: isAdd ? "Add a rule" : `Edit rule ${at + 1}`,
          dataset: { form: which },
        },
        el(
          "div",
          { className: "sval-agent-adding-row" },
          kind,
          input,
          ui()._glyph("forward", "sval-links-arrow"),
          workspace,
          save,
          cancel
        ),
        preview,
        warning
      );
    },
  };

  window.SvalLinksSettings = SvalLinksSettings;
}
