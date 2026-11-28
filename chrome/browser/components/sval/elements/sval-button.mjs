/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import { html, ifDefined } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";

/**
 * Sval's button: a pill with a label, in one of four types. A real `<button>`
 * in the shadow root takes the focus (`delegatesFocus`), the keys and the
 * accessible role, so it behaves as a native button does. `sval-button.css`
 * draws it from the `--sval-button-*` tokens a surface sets.
 *
 * Attributes:
 * - `type`: `primary`, `secondary` (the default), `danger` or `quiet`.
 * - `size`: `default` or `small`.
 * - `disabled`: as a native button's.
 * - `held`: disabled while its own fill sweeps across it over
 *   `--sval-button-hold-time`, for a grant held through the dialog delay
 *   (`sval-dialog-hold.js`). {@link hold} starts the sweep over.
 * - `busy`: working on what a press started: a spinner before the label,
 *   `aria-busy` on the inner button, and no press reaches a listener. It
 *   stays in the tab order unless `disabled` takes it out.
 * - `aria-disabled="true"`: looks disabled and does nothing when pressed,
 *   and stays in the tab order, so a keyboard user still reaches it.
 * - `submit`: submits the form the element is in, as `type="submit"` does.
 * - `icon`: an image drawn before the label.
 * - `label`: the label, or the element's own text when it has none.
 * - `accesskey`: the key that presses it with the platform's access key
 *   modifier, set on the inner button. Where the platform underlines access
 *   keys (`ui.key.menuAccessKey`, as `moz-label` reads it), its first
 *   letter in `label` is underlined.
 *
 * `aria-expanded` and `aria-pressed` stay on the element, where code and
 * sheets read them, and the inner button carries them too. `aria-label`,
 * `aria-labelledby`, `aria-describedby`, `aria-controls` and `title` move
 * to the inner button, because ARIA's global attributes give the element an
 * accessible of its own (`MustBeAccessible` in `nsAccessibilityService.cpp`).
 * The id lists resolve in the element's own tree, through ARIA element
 * reflection, since an id inside the shadow root cannot name one outside it.
 */
export class SvalButton extends MozLitElement {
  static shadowRootOptions = {
    ...MozLitElement.shadowRootOptions,
    delegatesFocus: true,
  };

  static properties = {
    type: { type: String, reflect: true },
    size: { type: String, reflect: true },
    disabled: { type: Boolean, reflect: true },
    held: { type: Boolean, reflect: true },
    busy: { type: Boolean, reflect: true },
    submit: { type: Boolean, reflect: true },
    icon: { type: String },
    label: { type: String },
    ariaDisabledAttr: { type: String, attribute: "aria-disabled" },
    ariaExpandedAttr: { type: String, attribute: "aria-expanded" },
    ariaPressedAttr: { type: String, attribute: "aria-pressed" },
    ariaLabel: { type: String, mapped: true },
    ariaLabelledBy: {
      type: String,
      mapped: true,
      attribute: "aria-labelledby",
    },
    ariaDescribedBy: {
      type: String,
      mapped: true,
      attribute: "aria-describedby",
    },
    ariaControls: { type: String, mapped: true, attribute: "aria-controls" },
    title: { type: String, mapped: true },
    accessKey: { type: String, mapped: true },
  };

  static queries = {
    buttonEl: "button",
  };

  /**
   * The native submit button a `submit` element keeps in its own light DOM.
   * A form's implicit submission presses the form's default button
   * (`HTMLInputElement::MaybeSubmitForm`), and only a native submit button can
   * be one, so Enter in a field does what it does beside a native button:
   * presses it when enabled and nothing when disabled. A button in the shadow
   * root has no form owner. The proxy names a slot the shadow root lacks, so
   * nothing draws it, focuses it or reads it out.
   */
  #proxy = null;

  constructor() {
    super();
    this.type = "secondary";
    this.size = "default";
    this.disabled = false;
    this.held = false;
    this.busy = false;
    this.submit = false;
    // A click can reach the element without its inner button: dispatched at
    // it, or pressed on its edge outside the button. While it cannot be
    // pressed none reaches a listener, the caller's included, since this
    // capturing listener at the target runs first.
    this.addEventListener(
      "click",
      event => {
        if (this.disabled || this.held || this.#softDisabled) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      { capture: true }
    );
  }

  /**
   * Holds the button for `delay` milliseconds: disabled, with its fill
   * sweeping across it, from the start. The holder takes `held` off when
   * the hold ends.
   *
   * @param {number} delay
   */
  hold(delay) {
    this.style.setProperty("--sval-button-hold-time", `${delay}ms`);
    this.held = true;
    if (this.isConnected) {
      this.performUpdate();
    }
    // A running CSS animation starts over from its first frame.
    for (const animation of this.buttonEl?.getAnimations() ?? []) {
      animation.currentTime = 0;
    }
  }

  /** Pressable to the keyboard and pointer, but answering nothing. */
  get #softDisabled() {
    return this.ariaDisabledAttr === "true" || this.busy;
  }

  connectedCallback() {
    super.connectedCallback();
    this.#syncProxy();
  }

  /** Presses the inner button, as a click on a native button would. */
  click() {
    if (this.isConnected) {
      this.performUpdate();
    }
    this.buttonEl?.click();
  }

  /**
   * Focuses the inner button. An element created in the same task has yet to
   * draw it, and `delegatesFocus` finds nothing to focus until it has.
   *
   * @param {FocusOptions} [options]
   */
  focus(options) {
    if (this.isConnected) {
      this.performUpdate();
    }
    super.focus(options);
  }

  #syncProxy() {
    if (!this.submit) {
      this.#proxy?.remove();
      this.#proxy = null;
      return;
    }
    if (!this.#proxy) {
      this.#proxy = this.ownerDocument.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "button"
      );
      this.#proxy.type = "submit";
      this.#proxy.slot = "sval-form";
      this.#proxy.tabIndex = -1;
      // A press of the form's default button is a press of this one, so
      // listeners on the element hear it as a click.
      this.#proxy.addEventListener("click", event => {
        event.stopPropagation();
        event.preventDefault();
        this.click();
      });
    }
    this.#proxy.disabled = this.disabled || this.held || this.#softDisabled;
    if (this.#proxy.parentNode !== this) {
      this.append(this.#proxy);
    }
  }

  #onClick(event) {
    if (this.#softDisabled) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (this.#proxy) {
      // The window is the last stop of the click's path, so the form submits
      // after every listener on the way has run, and not at all when one
      // cancels the click, as a native submit button's activation behaves.
      const proxy = this.#proxy;
      this.documentGlobal.addEventListener(
        "click",
        last => {
          if (last === event && !event.defaultPrevented) {
            proxy.form?.requestSubmit(proxy);
          }
        },
        { once: true }
      );
    }
  }

  #onSlotChange() {
    // A caller that replaces the element's children, as `textContent` does,
    // takes the proxy with them.
    if (this.submit && this.#proxy?.parentNode !== this) {
      this.#syncProxy();
    }
  }

  #elementsFor(ids) {
    if (!ids) {
      return null;
    }
    const root = this.getRootNode();
    return ids
      .split(/\s+/)
      .filter(Boolean)
      .map(id => root.getElementById(id))
      .filter(Boolean);
  }

  updated(changes) {
    super.updated(changes);
    if (
      changes.has("submit") ||
      changes.has("disabled") ||
      changes.has("held") ||
      changes.has("busy") ||
      changes.has("ariaDisabledAttr")
    ) {
      this.#syncProxy();
    }
    const button = this.buttonEl;
    button.ariaLabelledByElements = this.#elementsFor(this.ariaLabelledBy);
    button.ariaDescribedByElements = this.#elementsFor(this.ariaDescribedBy);
    button.ariaControlsElements = this.#elementsFor(this.ariaControls);
  }

  /**
   * The label, with its access key's first letter underlined where the
   * platform underlines access keys.
   */
  #labelText() {
    const { label, accessKey } = this;
    const underlined =
      accessKey &&
      Services.prefs.getIntPref(
        "ui.key.menuAccessKey",
        Number(!navigator.platform.includes("Mac"))
      );
    const at = underlined
      ? label.toLowerCase().indexOf(accessKey.toLowerCase())
      : -1;
    if (at < 0) {
      return label;
    }
    return html`${label.slice(0, at)}<span class="accesskey"
        >${label.slice(at, at + accessKey.length)}</span
      >${label.slice(at + accessKey.length)}`;
  }

  render() {
    let lead = null;
    if (this.busy) {
      lead = html`<span class="spinner" aria-hidden="true"></span>`;
    } else if (this.icon) {
      lead = html`<img class="icon" src=${this.icon} role="presentation" />`;
    }
    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/sval/elements/sval-button.css"
      />
      <button
        type="button"
        ?disabled=${this.disabled || this.held}
        aria-disabled=${ifDefined(this.ariaDisabledAttr ?? undefined)}
        aria-expanded=${ifDefined(this.ariaExpandedAttr ?? undefined)}
        aria-pressed=${ifDefined(this.ariaPressedAttr ?? undefined)}
        aria-busy=${ifDefined(this.busy ? "true" : undefined)}
        aria-label=${ifDefined(this.ariaLabel ?? undefined)}
        title=${ifDefined(this.title ?? undefined)}
        accesskey=${ifDefined(this.accessKey || undefined)}
        @click=${this.#onClick}
      >
        ${lead}
        ${this.label
          ? html`<span class="label">${this.#labelText()}</span>`
          : html`<slot @slotchange=${this.#onSlotChange}></slot>`}
      </button>
    `;
  }
}

customElements.define("sval-button", SvalButton);
