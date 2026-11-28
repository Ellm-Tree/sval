/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * What every settings pane draws with: the element builder, icons, empty
 * lists, Advanced disclosures, field labels, status lines with an Undo, radio
 * groups, table cells, the redraw that keeps the keyboard's place, and the
 * site menu's choice pill (`sval-choice-pill`).
 *
 * `SvalPreferences` loads this as a classic script after `settings.js`; it
 * adds its methods to `SvalSettings`, and `settings-links.js` draws with
 * them too.
 */

"use strict";

{
  const SvalSettingsUI = {
    /**
     * @param {string} tag
     * @param {object} [props] Properties to set, and `dataset`. `role` and
     *   `aria…` names are set as attributes: `ariaLabel` as `aria-label`.
     * @param {...(Node|string)} children
     * @returns {Element}
     */
    _el(tag, props = {}, ...children) {
      const el = document.createElement(tag);
      const { dataset, ...rest } = props;
      for (const [name, value] of Object.entries(rest)) {
        if (name === "role" || name.startsWith("aria")) {
          el.setAttribute(
            name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`),
            value
          );
        } else {
          el[name] = value;
        }
      }
      Object.assign(el.dataset, dataset ?? {});
      el.append(...children);
      return el;
    },

    /**
     * What a list says while it has nothing in it, in the form every list in
     * settings shares: a title, and one line on how something gets there.
     *
     * @param {string} title
     * @param {string} note
     * @returns {Element}
     */
    _emptyState(title, note) {
      return this._el(
        "div",
        { className: "sval-empty" },
        this._el("p", { className: "sval-empty-title" }, title),
        this._el("p", { className: "sval-agents-note" }, note)
      );
    },

    /**
     * Opens every Advanced disclosure that holds `el`, so that it shows.
     *
     * @param {Element} el
     */
    _openAdvanced(el) {
      for (
        let details = el.closest("details.sval-advanced");
        details;
        details = details.parentElement.closest("details.sval-advanced")
      ) {
        details.open = true;
      }
    },

    /**
     * The visible label above an add row's field, which also names it.
     *
     * @param {HTMLInputElement} input The field, with its id set.
     * @param {string} text
     * @returns {HTMLLabelElement}
     */
    _fieldLabel(input, text) {
      return this._el(
        "label",
        { className: "sval-step-label", htmlFor: input.id },
        text
      );
    },

    /**
     * @param {string} name An icon in `icons/`.
     * @param {string} [extra] Another class.
     * @returns {Element} The icon, drawn in the element's text colour.
     */
    _glyph(name, extra = "") {
      return this._el("span", {
        className: `sval-glyph sval-glyph-${name} ${extra}`.trim(),
        ariaHidden: "true",
      });
    },

    /**
     * Writes `text` into `el` only when it differs. This page redraws after
     * every pass the poll runs, and rewriting identical text costs a paint (see
     * `SvalPanel.drawIndicator`).
     *
     * @param {Element} el
     * @param {string} text
     */
    _setText(el, text) {
      if (el.textContent !== text) {
        el.textContent = text;
      }
    },

    /**
     * Puts a done line's words, and an Undo when there is one, in a card's
     * one status line. The line is always in the page, and its contents
     * change only when the words do, so a screen reader speaks each message
     * once, however often the card redraws.
     *
     * @param {Element} line A permanent `role="status"` element.
     * @param {string} words Nothing, to empty it.
     * @param {?Function} [onUndo] What Undo does, or null for no Undo.
     * @param {string} [key] The Undo's `data-sval-key`.
     */
    _say(line, words, onUndo = null, key = "") {
      const said = JSON.stringify([words, !!onUndo]);
      if (line.dataset.said !== said) {
        line.dataset.said = said;
        line.replaceChildren();
        if (words) {
          line.append(this._el("span", {}, words));
        }
        if (words && onUndo) {
          line.append(
            this._el(
              "button",
              {
                type: "button",
                className: "sval-link",
                dataset: { svalKey: key },
              },
              "Undo"
            )
          );
        }
      }
      const undo = line.querySelector("button");
      if (undo) {
        undo.onclick = onUndo;
      }
    },

    /**
     * Redraws part of a card and keeps the keyboard's place in it. The
     * control that had focus is found again by its `data-sval-key`, with a
     * field's caret where it was. When the redraw took that control away,
     * focus goes to the first of `next` it drew that can take focus: the
     * control a change names for that case, such as its Undo or the row that
     * took the removed one's place. `next` applies too when focus had
     * already fallen to the page, since a store's notification can redraw,
     * and take the control away, before the change that caused it redraws.
     *
     * A change that removes the row it was made from passes `take`: `next`
     * then gets focus wherever focus was. Pressing a control does not always
     * focus it: VoiceOver presses without moving focus, and on macOS a click
     * leaves a button or a switch unfocused, so the press can come from a
     * row while focus is still on the page's search field.
     *
     * @param {Element} container Holds everything `draw` replaces.
     * @param {Function} draw
     * @param {?(string|string[])} [next] Keys to fall back on, in order.
     * @param {boolean} [take] Whether `next` takes focus from anywhere.
     */
    _keepFocus(container, draw, next = null, take = false) {
      const active = document.activeElement;
      const held = active && container.contains(active) ? active : null;
      const lost =
        !active ||
        active === document.body ||
        active === document.documentElement;
      const key = held?.dataset.svalKey;
      const caret =
        held?.localName === "input" && typeof held.selectionStart === "number"
          ? held.selectionStart
          : null;

      draw();

      const find = k => {
        const found =
          k && container.querySelector(`[data-sval-key="${CSS.escape(k)}"]`);
        return found && !found.disabled ? found : null;
      };
      const again = find(key);
      if (again) {
        again.focus();
        if (caret !== null) {
          again.setSelectionRange(caret, caret);
        }
        return;
      }
      if (take || lost || (held && !held.isConnected)) {
        [next ?? []].flat().map(find).find(Boolean)?.focus();
      }
    },

    /**
     * Checks the radio of `name` whose value is `value`, and none when `value`
     * matches no radio.
     *
     * @param {string} name The group's `name`.
     * @param {?string} value
     */
    _selectRadio(name, value) {
      for (const radio of document.querySelectorAll(`input[name="${name}"]`)) {
        radio.checked = radio.value === value;
      }
    },

    /**
     * Switches a group's radios on or off together, so a change in flight is
     * not followed by a second one that would finish out of order.
     *
     * @param {string} name The group's `name`.
     * @param {boolean} disabled
     */
    _disableRadios(name, disabled) {
      for (const radio of document.querySelectorAll(`input[name="${name}"]`)) {
        radio.disabled = disabled;
      }
    },

    /**
     * The visually hidden header over a table's row buttons, so every row
     * has a cell under a header.
     *
     * @returns {Element}
     */
    _actionsHeader() {
      return this._el(
        "span",
        { role: "columnheader", className: "sval-visually-hidden" },
        "Actions"
      );
    },

    /**
     * @param {?Element} button A row's action.
     * @returns {Element} the cell that holds it.
     */
    _actionCell(button) {
      return this._el(
        "span",
        { className: "sval-agent-action-cell", role: "cell" },
        ...(button ? [button] : [])
      );
    },
  };

  Object.assign(window.SvalSettings, SvalSettingsUI);

  /**
   * A choice of one among a few as the site menu draws it
   * (`SvalSiteControls.permissionRow`): a pill showing the chosen word that
   * opens a native menu of the choices, the chosen one checked. `choices`
   * are `[value, word, disabled]`, `value` is the chosen one's, `label`
   * names what is chosen, `describedby` is the id of what describes it, and
   * a pick fires `change`.
   */
  class SvalChoicePill extends HTMLElement {
    /** @type {Array<[string, string, boolean?]>} */
    #choices = [];
    #value = "";
    #button = null;

    static get observedAttributes() {
      return ["disabled", "label", "describedby"];
    }

    connectedCallback() {
      if (this.#button) {
        return;
      }
      this.#button = document.createElement("button");
      this.#button.type = "button";
      this.#button.className = "sval-choice-pill";
      this.#button.setAttribute("aria-haspopup", "menu");
      this.#button.addEventListener("click", () => this.#open());
      this.append(this.#button);
      this.#draw();
    }

    attributeChangedCallback() {
      this.#draw();
    }

    set choices(choices) {
      this.#choices = choices;
      this.#draw();
    }

    get choices() {
      return this.#choices;
    }

    set value(value) {
      this.#value = value;
      this.#draw();
    }

    get value() {
      return this.#value;
    }

    focus(options) {
      this.#button?.focus(options);
    }

    #draw() {
      if (!this.#button) {
        return;
      }
      const word =
        this.#choices.find(([value]) => value === this.#value)?.[1] ?? "";
      const chevron = document.createElement("span");
      chevron.className = "sval-glyph sval-glyph-chevron-down";
      chevron.setAttribute("aria-hidden", "true");
      this.#button.replaceChildren(word, chevron);
      this.#button.setAttribute(
        "aria-label",
        `${this.getAttribute("label")}: ${word}`
      );
      this.#button.disabled = this.hasAttribute("disabled");
      const described = this.getAttribute("describedby");
      if (described) {
        this.#button.setAttribute("aria-describedby", described);
      }
    }

    async #open() {
      const { SvalMenu } = ChromeUtils.importESModule(
        "moz-src:///browser/components/sval/SvalMenu.sys.mjs"
      );
      const value = await SvalMenu.choose(
        this.#button,
        this.#choices.map(([choice, label, disabled]) => ({
          value: choice,
          label,
          disabled: !!disabled,
        })),
        this.#value
      );
      if (value === null || value === this.#value) {
        return;
      }
      this.value = value;
      this.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  customElements.define("sval-choice-pill", SvalChoicePill);
}
