/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import { html, repeat } from "chrome://global/content/vendor/lit.all.mjs";
import { SvalFormControl } from "chrome://browser/content/sval/elements/sval-form-control.mjs";

/**
 * Sval's select: a native `<select>` in the shadow root, drawn by
 * `sval-select.css` from the `--sval-field-*` tokens a surface sets.
 *
 * Its choices are `options`, a list of `[value, label, disabled]`, or the
 * `<option>` elements in it. Those are never slotted, since a native select
 * draws only its own children: the element copies them into the shadow
 * root's select and copies them again whenever one is added, removed or
 * relabelled. An `<option selected>` is the reset value.
 *
 * `value` is the chosen option's value, reflected to `data-value`, so a
 * sheet tells choices apart with `[data-value="…"]`. Setting it fires
 * nothing; a user's pick fires `input` and `change`, as a native select's.
 * A value no option has shows as no choice, as on a native select.
 */
export class SvalSelect extends SvalFormControl {
  static stylesheet = "chrome://browser/content/sval/elements/sval-select.css";

  static properties = {
    value: {
      type: String,
      reflect: true,
      attribute: "data-value",
      noAccessor: true,
    },
    options: { type: Array, attribute: false },
    childOptions: { type: Array, state: true },
  };

  static queries = {
    selectEl: "#control",
  };

  #observer = null;

  constructor() {
    super();
    this.options = null;
    this.childOptions = [];
  }

  get nativeControl() {
    return this.selectEl;
  }

  #value = undefined;

  /** The chosen value, a string whatever code sets, as on a native select. */
  get value() {
    return this.#value;
  }

  set value(value) {
    const old = this.#value;
    this.#value = value == null ? undefined : String(value);
    this.requestUpdate("value", old);
    this.drawNow();
  }

  connectedCallback() {
    super.connectedCallback();
    this.#observer ??= new MutationObserver(() => this.#readChildren());
    this.#observer.observe(this, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["value", "label", "disabled", "selected", "hidden"],
    });
    this.#readChildren();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#observer?.disconnect();
  }

  /** The `<option>` elements in the element, as `[value, label, disabled]`. */
  #readChildren() {
    const read = [...this.querySelectorAll("option")]
      .filter(option => !option.hidden)
      .map(option => [
        option.value,
        option.label,
        option.disabled,
        // An option outside a select keeps its own selectedness, from its
        // `selected` attribute or property.
        option.selected,
      ]);
    this.childOptions = read;
    if (this.value === undefined && !this.options) {
      this.value = this.#defaultChoice() ?? undefined;
    }
  }

  /** The choices the select offers, from `options` or the children. */
  get choices() {
    return (this.options ?? this.childOptions).map(
      ([value, label, disabled]) => [String(value), label, !!disabled]
    );
  }

  /** The `<option selected>`, else the first enabled choice. */
  #defaultChoice() {
    const marked = this.childOptions.find(option => option[3]);
    if (marked) {
      return marked[0];
    }
    return this.choices.find(([, , disabled]) => !disabled)?.[0] ?? null;
  }

  willUpdate(changes) {
    super.willUpdate(changes);
    if (
      (changes.has("options") || changes.has("childOptions")) &&
      this.value === undefined
    ) {
      this.value = this.#defaultChoice() ?? undefined;
    }
  }

  /** The chosen option's index among the choices, or -1. */
  get selectedIndex() {
    return this.choices.findIndex(([value]) => value === this.value);
  }

  set selectedIndex(index) {
    this.value = this.choices[index]?.[0];
  }

  /** The chosen choice's label, or "". */
  get selectedLabel() {
    return this.choices[this.selectedIndex]?.[1] ?? "";
  }

  formValue() {
    return this.selectedIndex === -1 ? null : this.value;
  }

  /** Enter on a native select submits nothing. */
  handleEnter() {}

  formResetCallback() {
    this.value = this.#defaultChoice() ?? undefined;
  }

  #onChange() {
    this.value = this.selectEl.value;
    this.syncForm();
    this.commit();
  }

  updated(changes) {
    super.updated(changes);
    // The select's own value follows its options, which draw after it.
    const select = this.selectEl;
    const index = this.selectedIndex;
    if (select.selectedIndex !== index) {
      select.selectedIndex = index;
    }
  }

  controlTemplate() {
    return html`<select
      id="control"
      part="control"
      ?disabled=${this.isDisabled}
      ?required=${this.required}
      @change=${this.#onChange}
    >
      ${repeat(
        this.choices,
        ([value]) => value,
        ([value, label, disabled]) =>
          html`<option
            .value=${value}
            .textContent=${label}
            ?disabled=${disabled}
            ?selected=${value === this.value}
          ></option>`
      )}
    </select>`;
  }
}

customElements.define("sval-select", SvalSelect);
