/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Privacy and protection's Fingerprinting and Privacy signals cards: the
 * groups and settings `SvalFingerprinting` describes, Strict, and Restore
 * with its Undo. The settings are Gecko prefs, so a change made elsewhere
 * redraws them.
 *
 * `SvalPreferences` loads this as a classic script after `settings.js`; it
 * adds its methods to `SvalSettings`.
 */

"use strict";

{
  const lazy = {};
  // `SvalFingerprinting.sys.mjs` exports functions rather than one object of that
  // name, so it is imported as a namespace.
  ChromeUtils.defineLazyGetter(lazy, "SvalFingerprinting", () =>
    ChromeUtils.importESModule(
      "moz-src:///browser/components/sval/SvalFingerprinting.sys.mjs"
    )
  );

  const SvalFingerprintingSettings = {
    /**
     * What the fingerprinting card shows that is not a pref: which groups are
     * open, and the last Restore with what its Undo puts back.
     */
    _fpView: {
      open: new Set(),
      msg: "",
      undo: null,
    },

    /**
     * Finds and wires the Fingerprinting and Privacy signals cards.
     *
     * @param {Function} byId Finds one of the page's elements by id.
     * @param {SvalScope} lifetime Ends as the page goes.
     */
    _initFingerprinting(byId, lifetime) {
      Object.assign(this._els, {
        fpStrict: byId("sval-fp-strict"),
        fpStrictStatus: byId("sval-fp-strict-status"),
        fpRestore: byId("sval-fp-restore"),
        fpMessage: byId("sval-fp-message"),
        fpGroups: byId("sval-fp-groups"),
        fpItems: byId("sval-fp-items"),
        fpAdvancedChanged: byId("sval-fp-advanced-changed"),
        signals: byId("sval-signals-list"),
        signalsAdvanced: byId("sval-signals-advanced-list"),
      });
      this._els.fpStrict.addEventListener("click", () => this.toggleStrict());
      this._els.fpRestore.addEventListener("click", () =>
        this.restoreFingerprinting()
      );
      // The fingerprinting settings are prefs, which settings sync and
      // about:config can move while this page is on screen.
      // A change from elsewhere makes the last Restore's Undo stale.
      const fingerprintingPref = () => {
        if (!this._fpWriting) {
          this._fpChanged();
        }
        this._describeFingerprinting();
      };
      for (const name of lazy.SvalFingerprinting.PREFS) {
        lifetime.pref(name, fingerprintingPref);
      }
    },

    /**
     * @param {object[]} items
     * @returns {string} Their labels, joined with "and".
     */
    _fpNames(items) {
      return items.map(i => i.label).join(" and ");
    },

    /**
     * @param {object} state `SvalFingerprinting.strictState()`.
     * @returns {string} What Strict's status line says.
     */
    _strictText(state) {
      const { on, total, onItems, offItems } = state;
      if (!on) {
        return `Off. Turn this on to use all ${total} strict items. They protect you more, and more sites may break.`;
      }
      if (on === total) {
        return `On. All ${total} strict items are on. Some sites may break.`;
      }
      const words = [`Partly on: ${on} of ${total} strict items.`];
      if (offItems.length <= 2) {
        words.push(
          `${this._fpNames(offItems)} ${offItems.length === 1 ? "is" : "are"} off.`
        );
      } else if (onItems.length <= 2) {
        words.push(
          `Only ${this._fpNames(onItems)} ${onItems.length === 1 ? "is" : "are"} on.`
        );
      }
      words.push("Turn this on to use them all.");
      return words.join(" ");
    },

    /** Redraws the fingerprinting card from the prefs. */
    _describeFingerprinting() {
      const fp = lazy.SvalFingerprinting;
      const view = this._fpView;
      const strict = fp.strictState();
      let checked = "mixed";
      if (!strict.on) {
        checked = "false";
      } else if (strict.on === strict.total) {
        checked = "true";
      }
      this._els.fpStrict.setAttribute("aria-checked", checked);
      this._els.fpStrictStatus.dataset.state = checked;
      this._els.fpStrictStatus.textContent = this._strictText(strict);
      this._els.fpRestore.disabled = fp.atDefaults();

      this._say(
        this._els.fpMessage,
        view.msg,
        view.undo ? () => this.undoFingerprinting() : null,
        "fp-undo"
      );

      this._drawFingerprintingGroups();

      // A change inside the closed Advanced would otherwise not show.
      this._setText(
        this._els.fpAdvancedChanged,
        fp.ITEMS.some(fp.isChanged) ? "Some differ from Sval's defaults" : ""
      );
    },

    /**
     * Draws the groups: each group's shown settings in the card, and in its
     * Advanced each group's switches behind a disclosure button. The focused
     * control is found again by its `data-sval-key` after the redraw, as in
     * the agents list.
     */
    _drawFingerprintingGroups() {
      const fp = lazy.SvalFingerprinting;
      const view = this._fpView;
      const { fpGroups, fpItems } = this._els;
      const active = document.activeElement;
      const key =
        fpGroups.contains(active) || fpItems.contains(active)
          ? active.dataset.svalKey
          : null;

      fpGroups.textContent = "";
      fpItems.textContent = "";
      for (const group of fp.GROUPS) {
        if (group.card) {
          continue;
        }
        if (group.shown.length) {
          fpGroups.append(
            this._el(
              "div",
              {
                className: "sval-fp-group",
                dataset: { svalGroup: group.id },
              },
              this._el("h3", {}, group.name),
              ...group.shown.map(setting => this._fpShownRow(setting))
            )
          );
        }
        if (!group.items.length) {
          continue;
        }
        const open = view.open.has(group.id);
        const on = group.items.filter(fp.isOn).length;
        const changed = group.items.filter(fp.isChanged).length;
        const toggle = this._el(
          "button",
          {
            type: "button",
            className: "sval-fp-group-toggle",
            ariaExpanded: String(open),
            dataset: { svalKey: `group:${group.id}` },
          },
          this._el("span", { className: "sval-fp-group-name" }, group.name),
          this._el(
            "span",
            { className: "sval-fp-group-summary" },
            `${on} of ${group.items.length} on${
              changed ? ` · ${changed} changed` : ""
            }`
          ),
          this._glyph("chevron-down", "sval-agent-chevron")
        );
        toggle.addEventListener("click", () => {
          if (view.open.has(group.id)) {
            view.open.delete(group.id);
          } else {
            view.open.add(group.id);
          }
          this._describeFingerprinting();
        });
        const row = this._el(
          "div",
          { className: "sval-fp-group", dataset: { svalGroup: group.id } },
          toggle
        );
        if (open) {
          const box = this._el("div", {
            className: "sval-fp-advanced",
            role: "group",
            ariaLabel: `Advanced: ${group.name}`,
          });
          for (const item of group.items) {
            box.append(this._fpItemRow(item));
          }
          row.append(box);
        }
        fpItems.append(row);
      }

      if (key) {
        const sel = `[data-sval-key="${CSS.escape(key)}"]`;
        (fpGroups.querySelector(sel) ?? fpItems.querySelector(sel))?.focus();
      }
      this._drawSignals();
    },

    /**
     * Draws the Privacy signals card: the shown settings of the group whose
     * `card` it is, and in the card's Advanced the ones it marks.
     */
    _drawSignals() {
      const { signals, signalsAdvanced } = this._els;
      const active = document.activeElement;
      const key =
        signals.contains(active) || signalsAdvanced.contains(active)
          ? active.dataset.svalKey
          : null;
      const group = lazy.SvalFingerprinting.GROUPS.find(
        g => g.card === "signals"
      );
      signals.replaceChildren(
        ...group.shown
          .filter(setting => !setting.advanced)
          .map(setting => this._fpShownRow(setting))
      );
      signalsAdvanced.replaceChildren(
        ...group.shown
          .filter(setting => setting.advanced)
          .map(setting => this._fpShownRow(setting))
      );
      if (key) {
        const sel = `[data-sval-key="${CSS.escape(key)}"]`;
        (
          signals.querySelector(sel) ?? signalsAdvanced.querySelector(sel)
        )?.focus();
      }
    },

    /**
     * @param {object} setting A shown setting: a switch, or a select.
     * @returns {Element}
     */
    _fpShownRow(setting) {
      const fp = lazy.SvalFingerprinting;
      const noteId = `sval-fp-setting-note-${setting.id}`;
      let control;
      let note = setting.note;
      if (setting.choices) {
        const value = fp.choiceOf(setting);
        note = setting.choices.find(c => c.value === value).note;
        control = this._el("select", {
          className: "sval-agent-select sval-fp-select",
          ariaLabel: setting.label,
          ariaDescribedby: noteId,
          dataset: {
            svalSetting: setting.id,
            svalKey: `setting:${setting.id}`,
          },
        });
        for (const choice of setting.choices) {
          control.append(
            this._el("option", { value: choice.value }, choice.label)
          );
        }
        control.value = value;
        control.addEventListener("change", () => {
          this._fpChanged();
          this._fpWrite(() => fp.choose(setting, control.value));
        });
      } else {
        control = this._fpSwitch(setting, "svalSetting", noteId);
      }
      return this._el(
        "div",
        { className: "sval-fp-row" },
        this._el(
          "span",
          { className: "sval-fp-words" },
          this._el("span", { className: "sval-fp-label" }, setting.label),
          this._el("span", { className: "sval-agents-note", id: noteId }, note)
        ),
        control
      );
    },

    /**
     * @param {object} item An advanced switch.
     * @returns {Element}
     */
    _fpItemRow(item) {
      const fp = lazy.SvalFingerprinting;
      const changedId = `sval-fp-item-changed-${item.id}`;
      const noteId = `sval-fp-item-note-${item.id}`;
      const described = [noteId];
      const head = this._el(
        "span",
        { className: "sval-fp-item-head" },
        this._el("span", { className: "sval-fp-label" }, item.label)
      );
      if (fp.isChanged(item)) {
        head.append(
          this._el(
            "span",
            { className: "sval-fp-changed", id: changedId },
            "Changed"
          )
        );
        described.unshift(changedId);
      }
      const note = this._el(
        "span",
        {
          className: "sval-agents-note sval-fp-note",
          id: noteId,
          dataset: { warn: String(!!item.warn) },
        },
        this._el("span", {}, item.note)
      );
      if (item.warn) {
        note.prepend(this._glyph("triangle-alert", "sval-fp-warn"));
      }
      return this._el(
        "div",
        { className: "sval-fp-item" },
        this._el("span", { className: "sval-fp-words" }, head, note),
        this._fpSwitch(item, "svalItem", described.join(" "))
      );
    },

    /**
     * @param {object} setting A switch from `SvalFingerprinting.GROUPS`.
     * @param {string} data The dataset name that carries its id.
     * @param {string} describedBy The ids of what it says about itself.
     * @returns {Element}
     */
    _fpSwitch(setting, data, describedBy) {
      const fp = lazy.SvalFingerprinting;
      const input = this._el("input", {
        type: "checkbox",
        className: "sval-switch",
        role: "switch",
        checked: fp.isOn(setting),
        ariaLabel: setting.label,
        ariaDescribedby: describedBy,
        dataset: { [data]: setting.id, svalKey: `switch:${setting.id}` },
      });
      input.addEventListener("change", () => {
        this._fpChanged();
        this._fpWrite(() =>
          fp.setSwitches(new Map([[setting, input.checked]]))
        );
      });
      return input;
    },

    /** Set while this page writes the prefs, so the observer can tell. */
    _fpWriting: false,

    /**
     * Runs `write`, which changes fingerprinting prefs on this page's behalf,
     * then redraws.
     *
     * @param {Function} write
     */
    _fpWrite(write) {
      this._fpWriting = true;
      try {
        write();
      } finally {
        this._fpWriting = false;
      }
      this._describeFingerprinting();
    },

    /** A change made here supersedes the last Restore and its Undo. */
    _fpChanged() {
      this._fpView.msg = "";
      this._fpView.undo = null;
    },

    /** Strict: every strict item on, or, when all are on, every one off. */
    toggleStrict() {
      const { on, total } = lazy.SvalFingerprinting.strictState();
      this._fpChanged();
      this._fpWrite(() => lazy.SvalFingerprinting.setStrict(on !== total));
    },

    /**
     * Every fingerprinting setting back to Sval's default, with no
     * confirmation: the status line's Undo puts back what was there.
     */
    restoreFingerprinting() {
      const fp = lazy.SvalFingerprinting;
      this._fpView.msg = "Restored Sval's defaults.";
      this._fpView.undo = fp.snapshot();
      this._fpWrite(() => fp.restoreDefaults());
    },

    undoFingerprinting() {
      const saved = this._fpView.undo;
      this._fpChanged();
      this._fpWrite(() => saved && lazy.SvalFingerprinting.restore(saved));
    },
  };

  Object.assign(window.SvalSettings, SvalFingerprintingSettings);
}
