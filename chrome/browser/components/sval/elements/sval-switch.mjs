/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import {
  html,
  ifDefined,
  live,
} from "chrome://global/content/vendor/lit.all.mjs";
import { SvalFormControl } from "chrome://browser/content/sval/elements/sval-form-control.mjs";

/**
 * What `sval-switch` and `sval-checkbox` share: a native checkbox in the
 * shadow root, which takes Space, the click and the accessible state.
 *
 * Attributes, besides `SvalFormControl`'s:
 * - `checked`: checked to begin with, and on a form's reset.
 * - `mixed`: some of what it stands for is on. A click clears it.
 * - `value`: what the form holds while it is checked (`on`).
 *
 * `checked` is the state, and setting it fires nothing. A user's click,
 * Space, or a click on a label of the element toggles it and fires `input`
 * and `change`, as a native checkbox does.
 */
export class SvalCheckable extends SvalFormControl {
  /** `setting-control` reads the element's state from this property. */
  static activatedProperty = "checked";

  static properties = {
    checked: { type: Boolean, attribute: false },
    mixed: { type: Boolean, reflect: true },
    value: { type: String },
  };

  static queries = {
    inputEl: "#control",
  };

  #seeded = false;

  constructor() {
    super();
    this.checked = false;
    this.mixed = false;
    this.value = "on";
  }

  /** The documents that pass their elements' own clicks on. */
  static #documents = new WeakSet();

  /**
   * A label's click reaches the element itself (`HTMLLabelElement` dispatches
   * it to its labelled control), and so does a press on the element outside
   * its checkbox. Each toggles the checkbox, as a click on a native
   * checkbox's label does. The document hears them: a click listener on the
   * element would make it a clickable box of its own to assistive
   * technology, beside its checkbox.
   *
   * @param {MouseEvent} event
   */
  static #onDocumentClick(event) {
    const el = event.composedPath()[0];
    if (el instanceof SvalCheckable && !el.isDisabled) {
      el.click();
    }
  }

  get nativeControl() {
    return this.inputEl;
  }

  /** Clicks the checkbox, as a click on a native checkbox does. */
  click() {
    if (this.isConnected) {
      this.performUpdate();
    }
    if (!this.isDisabled) {
      this.inputEl?.click();
    }
  }

  get defaultChecked() {
    return this.hasAttribute("checked");
  }

  set defaultChecked(on) {
    this.toggleAttribute("checked", on);
  }

  connectedCallback() {
    super.connectedCallback();
    const doc = this.ownerDocument;
    if (!SvalCheckable.#documents.has(doc)) {
      SvalCheckable.#documents.add(doc);
      doc.addEventListener("click", SvalCheckable.#onDocumentClick, {
        capture: true,
      });
    }
    // The `checked` attribute is the first state, unless code checked the
    // element before it first connected.
    if (!this.#seeded) {
      this.#seeded = true;
      if (this.defaultChecked) {
        this.checked = true;
      }
    }
  }

  formValue() {
    return this.checked ? this.value : null;
  }

  formResetCallback() {
    this.checked = this.defaultChecked;
    this.mixed = false;
  }

  #onChange() {
    this.checked = this.inputEl.checked;
    this.mixed = false;
    this.syncForm();
    this.commit();
  }

  /** The native checkbox's ARIA role, when it has one besides its own. */
  roleAttribute() {
    return undefined;
  }

  controlTemplate() {
    return html`<input
      id="control"
      part="control"
      type="checkbox"
      role=${ifDefined(this.roleAttribute())}
      .checked=${live(this.checked)}
      .indeterminate=${this.mixed}
      ?disabled=${this.isDisabled}
      ?required=${this.required}
      @change=${this.#onChange}
    />`;
  }
}

/**
 * Sval's switch: an on and off setting that applies as it turns, drawn by
 * `sval-switch.css` as a track with a knob from the `--sval-field-switch-*`
 * tokens. Its checkbox has the `switch` role.
 */
export class SvalSwitch extends SvalCheckable {
  static stylesheet = "chrome://browser/content/sval/elements/sval-switch.css";

  roleAttribute() {
    return "switch";
  }
}

customElements.define("sval-switch", SvalSwitch);
