/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import {
  html,
  ifDefined,
  live,
  nothing,
} from "chrome://global/content/vendor/lit.all.mjs";
import { SvalFormControl } from "chrome://browser/content/sval/elements/sval-form-control.mjs";

/**
 * Sval's text field: a native `<input>`, or a `<textarea>` under
 * `multiline`, in the shadow root, drawn by `sval-field.css` from the
 * `--sval-field-*` tokens a surface sets.
 *
 * Attributes, besides `SvalFormControl`'s:
 * - `type`: `text` (the default), `search`, `password`, `number`, `url` or
 *   `email`, the native field's.
 * - `multiline`: a textarea, `rows` tall.
 * - `size`: `default`, a pill; `code`, a code in a monospace face, centred;
 *   or `compact`, the smaller square-cornered field of Settings' lists.
 * - `mono`: the text in the monospace face.
 * - `autoselect`: any focus selects the text, a click's included, for a
 *   field whose text is there to be copied.
 * - `value` (the reset value), `placeholder`, `readonly`, `autocomplete`,
 *   `spellcheck`, `inputmode`, `maxlength`, `min`, `max`, `step`: as a
 *   native field's.
 *
 * `focus()` selects the text (decision 2713): code focuses a field when a
 * dialog or an action opens it, and typing then replaces the old text. A
 * click or Tab focuses the native field itself, as on any field.
 *
 * A search draws a magnifier and a clear button of its own in place of the
 * user agent's. Escape empties a search, as a native one does
 * (`dom.forms.search.esc`).
 *
 * `value` is the text, and setting it fires nothing, as on a native field.
 * Typing fires `input`, which crosses the shadow root as a native field's
 * does, and `change` once the edit is committed: on Enter or as the field
 * loses focus. `select()`, `setSelectionRange()`, `selectionStart` and
 * `selectionEnd` act on the native field.
 */
export class SvalField extends SvalFormControl {
  static stylesheet = "chrome://browser/content/sval/elements/sval-field.css";

  static properties = {
    type: { type: String, reflect: true },
    multiline: { type: Boolean, reflect: true },
    size: { type: String, reflect: true },
    mono: { type: Boolean, reflect: true },
    autoselect: { type: Boolean, reflect: true },
    value: { type: String, attribute: false, noAccessor: true },
    placeholder: { type: String },
    readOnly: { type: Boolean, reflect: true, attribute: "readonly" },
    autocomplete: { type: String },
    spellcheck: { type: String },
    inputMode: { type: String, attribute: "inputmode" },
    maxLength: { type: Number, attribute: "maxlength" },
    min: { type: String },
    max: { type: String },
    step: { type: String },
    rows: { type: Number },
  };

  static queries = {
    inputEl: "#control",
  };

  /**
   * What the native field compares on Enter and on leaving to decide whether
   * to fire `change` (`HTMLInputElement::FireChangeEventIfNeeded`): its
   * value as of focus or the last `change`, and whether the user has edited
   * it since. A value set from code is no edit.
   */
  #focusValue = "";
  #edited = false;
  /** Whether the native field's next `change` repeats one Enter fired. */
  #echo = false;
  #seeded = false;
  #selectOnRelease = false;

  constructor() {
    super();
    this.type = "text";
    this.multiline = false;
    this.size = "default";
    this.mono = false;
    this.autoselect = false;
    this.readOnly = false;
    this.value = "";
  }

  get nativeControl() {
    return this.inputEl;
  }

  #value = "";

  /** The text, a string whatever code sets, as on a native field. */
  get value() {
    return this.#value;
  }

  set value(value) {
    const old = this.#value;
    this.#value = String(value ?? "");
    this.requestUpdate("value", old);
    this.drawNow();
  }

  get defaultValue() {
    return this.getAttribute("value") ?? "";
  }

  set defaultValue(value) {
    this.setAttribute("value", value);
  }

  connectedCallback() {
    super.connectedCallback();
    // The `value` attribute is the first value, unless code set one before
    // the element first connected.
    if (!this.#seeded) {
      this.#seeded = true;
      if (this.value === "" && this.hasAttribute("value")) {
        this.value = this.defaultValue;
      }
    }
  }

  /**
   * Focuses the field with its text selected (decision 2713).
   *
   * @param {FocusOptions} [options]
   */
  focus(options) {
    super.focus(options);
    if (this.shadowRoot?.activeElement === this.inputEl) {
      this.inputEl.select();
    }
  }

  get isSingleLine() {
    return !this.multiline;
  }

  formValue() {
    return this.value;
  }

  formResetCallback() {
    this.value = this.defaultValue;
  }

  get selectionStart() {
    return this.#drawn()?.selectionStart ?? null;
  }

  set selectionStart(at) {
    this.#drawn().selectionStart = at;
  }

  get selectionEnd() {
    return this.#drawn()?.selectionEnd ?? null;
  }

  set selectionEnd(at) {
    this.#drawn().selectionEnd = at;
  }

  get selectionDirection() {
    return this.#drawn()?.selectionDirection ?? null;
  }

  select() {
    this.#drawn()?.select();
  }

  setSelectionRange(start, end, direction) {
    this.#drawn()?.setSelectionRange(start, end, direction);
  }

  /** The native field, drawn with the element's latest state. */
  #drawn() {
    if (this.isConnected) {
      this.performUpdate();
    }
    return this.inputEl;
  }

  #onInput() {
    this.#edited = true;
    this.value = this.inputEl.value;
    this.syncForm();
  }

  #onChange() {
    if (this.#echo) {
      this.#echo = false;
      return;
    }
    this.#committed();
  }

  #committed() {
    this.#focusValue = this.inputEl.value;
    this.#edited = false;
    this.value = this.inputEl.value;
    this.commit();
  }

  beforeImplicitSubmit() {
    // A native field commits its value before Enter submits the form, and
    // only once a user's edit has changed it. The native field's own
    // `change` for the same Enter follows, after every listener has run, and
    // `#onChange` lets it pass.
    if (this.#edited && this.inputEl.value !== this.#focusValue) {
      this.#echo = true;
      this.#committed();
    }
  }

  handleEnter(event) {
    if (!this.multiline) {
      super.handleEnter(event);
    }
  }

  #onFocus() {
    this.#focusValue = this.inputEl.value;
    this.#edited = false;
    if (this.autoselect) {
      this.inputEl.select();
    }
  }

  #onMouseDown() {
    this.#selectOnRelease =
      this.autoselect && this.shadowRoot.activeElement !== this.inputEl;
  }

  #onMouseUp() {
    // The press that focused an `autoselect` field puts the caret where it
    // landed, after focus selected the text, so its release selects again.
    if (this.#selectOnRelease) {
      this.inputEl.select();
    }
    this.#selectOnRelease = false;
  }

  #onClearDown(event) {
    // The press keeps the focus in the field.
    event.preventDefault();
  }

  #onClear() {
    const field = this.inputEl;
    field.focus();
    field.value = "";
    // As typing does: the element hears the native field's `input`, which
    // crosses the shadow root.
    field.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "deleteContentBackward",
      })
    );
  }

  controlTemplate() {
    const search = this.type === "search" && !this.multiline;
    return html`<span class="box"
      >${search
        ? html`<span class="magnifier" aria-hidden="true"></span>`
        : nothing}${this.#fieldTemplate()}${search
        ? html`<button
            id="clear"
            part="clear"
            type="button"
            tabindex="-1"
            aria-label="Clear search"
            title="Clear search"
            ?hidden=${!this.value || this.isDisabled || this.readOnly}
            @mousedown=${this.#onClearDown}
            @click=${this.#onClear}
          ></button>`
        : nothing}</span
    >`;
  }

  #fieldTemplate() {
    if (this.multiline) {
      return html`<textarea
        id="control"
        part="control"
        .value=${live(this.value)}
        ?disabled=${this.isDisabled}
        ?readonly=${this.readOnly}
        ?required=${this.required}
        rows=${ifDefined(this.rows ?? undefined)}
        placeholder=${ifDefined(this.placeholder ?? undefined)}
        autocomplete=${ifDefined(this.autocomplete ?? undefined)}
        spellcheck=${ifDefined(this.spellcheck ?? undefined)}
        inputmode=${ifDefined(this.inputMode ?? undefined)}
        maxlength=${ifDefined(this.maxLength ?? undefined)}
        @input=${this.#onInput}
        @change=${this.#onChange}
        @focus=${this.#onFocus}
        @mousedown=${this.#onMouseDown}
        @mouseup=${this.#onMouseUp}
      ></textarea>`;
    }
    return html`<input
      id="control"
      part="control"
      type=${this.type || "text"}
      .value=${live(this.value)}
      ?disabled=${this.isDisabled}
      ?readonly=${this.readOnly}
      ?required=${this.required}
      placeholder=${ifDefined(this.placeholder ?? undefined)}
      autocomplete=${ifDefined(this.autocomplete ?? undefined)}
      spellcheck=${ifDefined(this.spellcheck ?? undefined)}
      inputmode=${ifDefined(this.inputMode ?? undefined)}
      maxlength=${ifDefined(this.maxLength ?? undefined)}
      min=${ifDefined(this.min ?? undefined)}
      max=${ifDefined(this.max ?? undefined)}
      step=${ifDefined(this.step ?? undefined)}
      @input=${this.#onInput}
      @change=${this.#onChange}
      @focus=${this.#onFocus}
      @mousedown=${this.#onMouseDown}
      @mouseup=${this.#onMouseUp}
    />`;
  }
}

customElements.define("sval-field", SvalField);
