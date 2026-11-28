/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import { html, nothing } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";

/**
 * The flags of a `ValidityState`, which `ElementInternals.setValidity`
 * takes by name.
 */
const VALIDITY_FLAGS = [
  "valueMissing",
  "typeMismatch",
  "patternMismatch",
  "tooLong",
  "tooShort",
  "rangeUnderflow",
  "rangeOverflow",
  "stepMismatch",
  "badInput",
  "customError",
];

/**
 * The input types a form counts as single-line text fields when it decides
 * whether Enter submits it with no submit button
 * (`nsIFormControl::IsSingleLineTextControl`).
 */
const SINGLE_LINE_TYPES = new Set([
  "text",
  "email",
  "search",
  "tel",
  "url",
  "number",
  "month",
  "week",
  "password",
]);

/**
 * What Sval's form elements share: each is form-associated and wraps one
 * native control in its shadow root, which takes the focus
 * (`delegatesFocus`), the keys and the accessible role.
 *
 * A form-associated host is labelable (`HTMLElement::IsLabelable`), so a
 * `<label for>` naming the host, or a label around it, focuses it and
 * clicks it. The native control has no label of its own in the shadow root,
 * so it takes the host's labels as its `aria-labelledby`. `aria-label`,
 * `aria-labelledby`, `aria-describedby` and `aria-invalid` move to the
 * native control, because an ARIA attribute gives the host an accessible of
 * its own (`MustBeAccessible` in `nsAccessibilityService.cpp`); the id
 * lists resolve in the host's tree, as `sval-button`'s do.
 *
 * Attributes every one takes:
 * - `name`, `disabled`, `required`: as a native control's. A disabled
 *   fieldset disables it too.
 * - `error`: text drawn under the control, which marks it invalid and
 *   describes it to assistive technology. It does not block a submit, so a
 *   form can be sent again after the error a submit brought.
 * - `label`, `description`: a label and a line under it, drawn by the
 *   element itself, for a container that renders the element alone, as
 *   Firefox's `setting-control` does.
 *
 * A subclass renders its control with `controlTemplate()`, names it with
 * `get nativeControl()`, and calls `commit()` once a user's change is
 * complete.
 */
export class SvalFormControl extends MozLitElement {
  static formAssociated = true;

  static shadowRootOptions = {
    ...MozLitElement.shadowRootOptions,
    delegatesFocus: true,
  };

  static properties = {
    name: { type: String, reflect: true },
    disabled: { type: Boolean, reflect: true },
    required: { type: Boolean, reflect: true },
    error: { type: String },
    label: { type: String },
    description: { type: String },
    labelsChanged: { type: Number, state: true },
    // `MozLitElement` names a mapped property's attribute itself, from the
    // property's name: `ariaLabelledBy` maps `aria-labelledby`.
    ariaLabel: { type: String, mapped: true },
    ariaLabelledBy: { type: String, mapped: true },
    ariaDescribedBy: { type: String, mapped: true },
    ariaInvalid: { type: String, mapped: true },
  };

  /** The sheet a subclass draws its control with. */
  static stylesheet = "";

  #internals;

  constructor() {
    super();
    this.#internals = this.attachInternals();
    this.disabled = false;
    this.required = false;
    this.error = "";
    this.labelsChanged = 0;
  }

  /**
   * The native control in the shadow root. `control` itself is left to
   * Firefox's `setting-control`, which names itself as the control of the
   * element it draws (`SettingControl.getCommonPropertyMapping`).
   *
   * @returns {HTMLElement}
   */
  get nativeControl() {
    return null;
  }

  get form() {
    return this.#internals.form;
  }

  get labels() {
    return this.#internals.labels;
  }

  get validity() {
    return this.#internals.validity;
  }

  get validationMessage() {
    return this.#internals.validationMessage;
  }

  get willValidate() {
    return this.#internals.willValidate;
  }

  checkValidity() {
    return this.#internals.checkValidity();
  }

  reportValidity() {
    return this.#internals.reportValidity();
  }

  /**
   * Whether the element or a disabled fieldset around it disables it, as a
   * fieldset disables every control outside its first legend. The element's
   * own `:disabled` state follows its attribute only once
   * `formDisabledCallback` has run, after the render that removed it.
   */
  get isDisabled() {
    if (this.disabled) {
      return true;
    }
    const fieldset = this.parentElement?.closest("fieldset:disabled");
    return (
      !!fieldset && !fieldset.querySelector(":scope > legend")?.contains(this)
    );
  }

  connectedCallback() {
    super.connectedCallback();
    // A label made around the element moves it, so its labels are read again
    // each time it connects.
    this.labelsChanged++;
  }

  formDisabledCallback() {
    // A fieldset's disabled state reaches the element only through this.
    this.requestUpdate();
  }

  /**
   * Focuses the native control. An element created in the same task has yet
   * to draw it, and has no frame for `delegatesFocus` to find a focusable
   * control in, so the native control takes the focus itself, which lays
   * it out first (`nsFocusManager::FlushAndCheckIfFocusable`).
   *
   * @param {FocusOptions} [options]
   */
  focus(options) {
    if (this.isConnected) {
      this.performUpdate();
    }
    if (this.nativeControl) {
      this.nativeControl.focus(options);
    } else {
      super.focus(options);
    }
  }

  /**
   * Draws a value or state code set at once, so the form reads its value and
   * validity in the same task, as a native control's: a `requestSubmit()`
   * straight after sees them.
   */
  drawNow() {
    if (this.hasUpdated && this.isConnected) {
      this.performUpdate();
    }
  }

  #drawing = false;

  /**
   * A value set while the element draws, as `willUpdate` sets a default,
   * is left to the draw under way, which Lit has it join or follows with
   * another.
   */
  performUpdate() {
    if (this.#drawing) {
      return;
    }
    this.#drawing = true;
    try {
      super.performUpdate();
    } finally {
      this.#drawing = false;
    }
  }

  /** Re-reads the labels that name the element, as `label` moves it. */
  refreshLabels() {
    this.labelsChanged++;
  }

  /** The value `ElementInternals.setFormValue` takes. */
  formValue() {
    return null;
  }

  /**
   * Hands the form the element's value and the native control's validity.
   * The native control is the anchor the form's validation message points
   * at.
   */
  syncForm() {
    const control = this.nativeControl;
    this.#internals.setFormValue(this.formValue());
    if (!control || control.validity.valid) {
      this.#internals.setValidity({});
      return;
    }
    const flags = {};
    for (const flag of VALIDITY_FLAGS) {
      if (control.validity[flag]) {
        flags[flag] = true;
      }
    }
    this.#internals.setValidity(flags, control.validationMessage, control);
  }

  /** Fires `change` from the element once a user's change is complete. */
  commit() {
    this.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /**
   * Submits the element's form as Enter in a native field does
   * (`HTMLInputElement::MaybeSubmitForm`): through a click of the form's
   * first submit button, which does nothing while that button is disabled,
   * or, with no submit button, by submitting the form when it holds exactly
   * one single-line field (`HTMLFormElement::ImplicitSubmissionIsDisabled`).
   */
  implicitSubmit() {
    const form = this.form;
    if (!form) {
      return;
    }
    const elements = [...form.elements];
    const submit = elements.find(el =>
      el.localName === "button"
        ? el.type === "submit"
        : el.localName === "input" &&
          (el.type === "submit" || el.type === "image")
    );
    if (submit) {
      submit.click();
      return;
    }
    const fields = elements.filter(el =>
      el instanceof SvalFormControl
        ? el.isSingleLine
        : el.localName === "input" && SINGLE_LINE_TYPES.has(el.type)
    );
    if (fields.length === 1) {
      form.requestSubmit();
    }
  }

  /** Whether a form counts the element among its single-line fields. */
  get isSingleLine() {
    return false;
  }

  /**
   * Enter, from a key no input method is composing, submits the form as it
   * does from a native control. A listener in the system group runs after
   * every page listener, so one that cancels the key keeps the form.
   *
   * @param {KeyboardEvent} event
   */
  handleEnter(event) {
    if (
      event.key !== "Enter" ||
      event.isComposing ||
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      this.isDisabled
    ) {
      return;
    }
    this.beforeImplicitSubmit();
    this.implicitSubmit();
  }

  /** Runs before Enter submits, as a native field commits its value. */
  beforeImplicitSubmit() {}

  firstUpdated() {
    super.firstUpdated();
    this.nativeControl.addEventListener(
      "keypress",
      event => this.handleEnter(event),
      {
        mozSystemGroup: true,
      }
    );
  }

  #elementsFor(ids) {
    if (!ids) {
      return null;
    }
    // Ids resolve in the element's own tree, which it has once connected;
    // `connectedCallback` draws it again then.
    const root = this.getRootNode();
    if (!root.getElementById) {
      return null;
    }
    return ids
      .split(/\s+/)
      .filter(Boolean)
      .map(id => root.getElementById(id))
      .filter(Boolean);
  }

  updated(changes) {
    super.updated(changes);
    const control = this.nativeControl;
    const named =
      this.#elementsFor(this.ariaLabelledBy) ??
      (this.label ? [] : [...this.#internals.labels]);
    control.ariaLabelledByElements = named.length ? named : null;
    control.ariaLabel = this.ariaLabel ?? null;
    const described = [
      ...(this.#elementsFor(this.ariaDescribedBy) ?? []),
      this.renderRoot.getElementById("description"),
      this.error ? this.renderRoot.getElementById("error") : null,
    ].filter(Boolean);
    control.ariaDescribedByElements = described.length ? described : null;
    control.ariaInvalid = this.error ? "true" : (this.ariaInvalid ?? null);
    this.syncForm();
  }

  /** The control's own markup, drawn after the label and before the error. */
  controlTemplate() {
    return nothing;
  }

  labelTemplate() {
    if (this.label) {
      this.#internals.states.add("labelled");
    } else {
      this.#internals.states.delete("labelled");
      return nothing;
    }
    return html`<span class="words">
      <label id="label" part="label" for="control">${this.label}</label>
      ${this.description
        ? html`<span id="description" part="description"
            >${this.description}</span
          >`
        : nothing}
    </span>`;
  }

  render() {
    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/sval/elements/sval-form-control.css"
      />
      <link rel="stylesheet" href=${this.constructor.stylesheet} />
      <span class="row">${this.labelTemplate()}${this.controlTemplate()}</span>
      <span id="error" part="error" aria-live="polite"
        >${this.error || nothing}</span
      >
    `;
  }
}
