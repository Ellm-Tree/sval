/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import { html, nothing } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  fitFrame: "moz-src:///browser/components/sval/SvalDialogBox.sys.mjs",
});

/**
 * @param {HTMLLinkElement|null} link
 * @returns {Promise<void>} settled once `link`'s sheet has loaded or failed.
 */
function sheetLoaded(link) {
  if (!link || link.sheet) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    link.addEventListener("load", resolve, { once: true });
    link.addEventListener("error", resolve, { once: true });
  });
}

/**
 * Sval's dialog card. The element is the card: its shadow root draws the
 * surface, the head row (an icon tile, the title, body and warning, and a
 * ✕), and the row of answers. `sval-dialog.css` beside this module draws it
 * from the `--sval-dialog-*` tokens a page sets, with the colour roles
 * (`sval-roles.css`) as their fallbacks.
 *
 * Everything a dialog asks stays in the light DOM: its `<form>`, around the
 * element, so that fields and `sval-button submit` find their form; every
 * field; the role and the ids `aria-labelledby` and `aria-describedby`
 * name, on the element or on the native `<dialog>` that holds it.
 *
 * Slots: `title`, `body`, `warning` (under the body, in the warning ink),
 * the default slot for the dialog's content, `actions` for its answers,
 * the primary last, and `extra` for a third answer set apart at the row's
 * start.
 *
 * Attributes:
 * - `icon`: the head's tile, one of `pencil`, `trash`, `cookie`, `agent`,
 *   `key`, `sval` or `critical`.
 * - `tone`: `default`, `danger` (a red primary, and Cancel takes the focus)
 *   or `critical` (messages spec §9.3: a red title band, a red scrim, and
 *   always solid).
 * - `state`: which case of its question the dialog asks, for a reader that
 *   tells cases apart without reading their wording.
 * - `close-button`: a ✕ that fires `sval-dialog-dismiss`, cancelable. Left
 *   uncancelled, the dialog closes as Escape closes it.
 * - `stacked`: the answers one per line, for too many or too long for a row.
 * - `solid`: never frosted, for a card drawn in a palette of its own rather
 *   than the window's (`SvalDialogBox`).
 * - `frosted`: set by `SvalDialogBox` while the box frosts the card, or by
 *   the Send Feedback form while its shape does (`SvalFeedbackForm`); the
 *   card is then clear.
 * - `fitted`: set once `SubDialog` has measured the page and sized the
 *   modal box to it, so a page can then hold the card to the box's height,
 *   which the frame has not got before.
 *
 * Parts: `head`, `copy` (the title, body and warning), `icon` and
 * `actions`, for a page that lays its content out edge to edge, holds the
 * card to its box, or prints it.
 *
 * The width is `--sval-dialog-width`. In a browser window's modal box
 * (`gDialogBox`) the element fits the box to itself (`fitFrame`) before
 * `SubDialog` measures the page, and gives the box the window's palette.
 *
 * `defaultFocus` is the control that takes the focus when the dialog opens.
 * Without one, it is the first `[autofocus]` in the dialog, then Cancel
 * (`data-button="cancel"`) in a danger dialog, then the primary answer.
 */
export class SvalDialog extends MozLitElement {
  static properties = {
    icon: { type: String, reflect: true },
    tone: { type: String, reflect: true },
    state: { type: String, reflect: true },
    closeButton: { type: Boolean, reflect: true, attribute: "close-button" },
    stacked: { type: Boolean, reflect: true },
    hasHead: { type: Boolean, state: true },
    hasActions: { type: Boolean, state: true },
  };

  static queries = {
    sheet: "link",
  };

  /**
   * The control that takes the focus when the dialog opens, or a function
   * that names it then, for a dialog whose default moves.
   *
   * @type {Element|(() => Element|null)|null}
   */
  defaultFocus = null;

  /**
   * What the card waits for after the page's load before it fits the box,
   * for a page that draws its content later, such as the import page's
   * browsers. Set before `load`.
   *
   * @type {Promise|null}
   */
  pending = null;

  /** The element given `autofocus` for a native `<dialog>`'s focusing. */
  #autofocused = null;

  constructor() {
    super();
    this.tone = "default";
    this.closeButton = false;
    this.stacked = false;
    this.hasHead = false;
    this.hasActions = false;
  }

  /** Whether the element is the card of a page `gDialogBox` shows. */
  get inFrame() {
    return !!this.documentGlobal.frameElement?.closest(".dialogBox");
  }

  connectedCallback() {
    super.connectedCallback();
    const doc = this.ownerDocument;
    if (!this.inFrame) {
      return;
    }
    // The box draws the card's shadow (`SvalDialogBox`), round its edge.
    this.toggleAttribute("framed", true);
    // `SubDialog._onLoad` waits for this before it measures the page, so the
    // frame is measured once the card has drawn with its sheet and the page's
    // own script has filled it.
    doc.mozSubdialogReady = this.#fit();
    // `SubDialog.focus` calls this when the dialog opens, in place of its own
    // move to the first focusable element. A page that names its own focus
    // keeps it.
    doc.subDialogSetDefaultFocus ??= () => this.focusDefault();
  }

  async #fit() {
    await this.updateComplete;
    await sheetLoaded(this.sheet);
    const win = this.documentGlobal;
    if (this.ownerDocument.readyState !== "complete") {
      await new Promise(resolve =>
        win.addEventListener("load", resolve, { once: true })
      );
    }
    await this.pending;
    // Each element in the card draws with a sheet of its own in its shadow
    // root, which the page's load does not wait for. Measured before those
    // apply, the card is smaller than it draws, and a box sized to the page
    // once (`SubDialog`'s `limitheight` for a page's prompt) stays too small
    // for it.
    const parts = [...this.querySelectorAll("*")].filter(
      el => el.shadowRoot && el.updateComplete
    );
    await Promise.all(parts.map(el => el.updateComplete));
    await Promise.all(
      parts.map(el => sheetLoaded(el.shadowRoot.querySelector("link")))
    );
    // `SubDialog.resizeHorizontally` sizes the frame from the root's inline
    // min-width when it has one, and otherwise from the page as laid out in
    // the frame's default width, which is narrower than some cards.
    this.ownerDocument.documentElement.style.minWidth = `${Math.ceil(
      this.getBoundingClientRect().width
    )}px`;
    // `SubDialog.resizeDialog` measures the page and then announces the
    // dialog open on its overlay.
    win.frameElement
      .closest(".dialogOverlay")
      ?.addEventListener(
        "dialogopen",
        () => this.toggleAttribute("fitted", true),
        { once: true }
      );
    lazy.fitFrame(this.ownerDocument);
  }

  /** The control that takes the focus when the dialog opens. */
  get focusTarget() {
    const chosen =
      typeof this.defaultFocus === "function"
        ? this.defaultFocus()
        : this.defaultFocus;
    if (chosen?.isConnected) {
      return chosen;
    }
    const auto = this.querySelector("[autofocus]");
    if (auto && auto !== this.#autofocused) {
      return auto;
    }
    const answers = [...this.querySelectorAll(":scope > [slot='actions']")];
    if (this.tone === "danger") {
      const cancel = answers.find(a => a.dataset.button === "cancel");
      if (cancel) {
        return cancel;
      }
    }
    return (
      answers.find(a => a.getAttribute("type") === "primary") ??
      answers.at(-1) ??
      null
    );
  }

  /**
   * Moves the focus to {@link focusTarget}, or where that cannot take it,
   * such as a primary answer still disabled, to the first control in the
   * dialog, as `SubDialog.focus` does for a page with no default.
   */
  focusDefault() {
    const target = this.focusTarget;
    if (!target || target.disabled || target.hidden) {
      Services.focus.moveFocus(
        this.documentGlobal,
        null,
        Services.focus.MOVEFOCUS_FIRST,
        Services.focus.FLAG_NOSHOWRING
      );
      return;
    }
    target.focus();
    if (target?.localName === "input") {
      target.select();
    }
  }

  #dismiss() {
    const event = new CustomEvent("sval-dialog-dismiss", {
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    if (!this.dispatchEvent(event)) {
      return;
    }
    const native = this.closest("dialog");
    if (native) {
      native.requestClose();
    } else if (this.inFrame) {
      this.documentGlobal.close();
    }
  }

  #onSlotChange() {
    const slotted = slot =>
      !!this.querySelector(`:scope > [slot='${slot}']:not([hidden])`);
    this.hasHead =
      !!this.icon ||
      this.closeButton ||
      ["title", "body", "warning"].some(slotted);
    this.hasActions = slotted("actions") || slotted("extra");
  }

  willUpdate(changes) {
    if (changes.has("icon") || changes.has("closeButton")) {
      this.#onSlotChange();
    }
  }

  updated(changes) {
    super.updated(changes);
    if (changes.has("tone") && this.inFrame) {
      // The critical frame's scrim is the window's: `gDialogBox` draws it as
      // the `::backdrop` of `#window-modal-dialog`, which `sval-header.css`
      // colours for this attribute. `openSvalDialogPage` takes it off when
      // the dialog closes, since the scrim outlives the page.
      const scrim =
        this.documentGlobal.frameElement.ownerDocument.getElementById(
          "window-modal-dialog"
        );
      if (this.tone === "critical") {
        scrim?.setAttribute("data-sval-tone", "critical");
      } else if (changes.get("tone") === "critical") {
        scrim?.removeAttribute("data-sval-tone");
      }
    }
    this.#markAutofocus();
  }

  /**
   * In a native `<dialog>`, `showModal` focuses the first `[autofocus]` in
   * it (the dialog focusing steps), so the default focus is marked so.
   */
  #markAutofocus() {
    if (!this.closest("dialog")) {
      return;
    }
    this.#autofocused?.removeAttribute("autofocus");
    this.#autofocused = null;
    const target = this.focusTarget;
    if (target && !target.hasAttribute("autofocus")) {
      target.setAttribute("autofocus", "");
      this.#autofocused = target;
    }
  }

  render() {
    const critical = this.tone === "critical";
    const words = html`
      <slot name="body" @slotchange=${this.#onSlotChange}></slot>
      <slot name="warning" @slotchange=${this.#onSlotChange}></slot>
    `;
    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/sval/elements/sval-dialog.css"
      />
      <div class="head" part="head" ?hidden=${!this.hasHead}>
        <span
          class="icon"
          part="icon"
          data-icon=${this.icon ?? nothing}
          aria-hidden="true"
          ?hidden=${!this.icon}
        ></span>
        <div class="copy" part="copy">
          <slot name="title" @slotchange=${this.#onSlotChange}></slot>
          ${critical ? nothing : words}
        </div>
        ${this.closeButton
          ? html`<button
              class="close"
              type="button"
              aria-label="Close"
              title="Close"
              @click=${this.#dismiss}
            ></button>`
          : nothing}
      </div>
      ${critical ? html`<div class="words">${words}</div>` : nothing}
      <slot @slotchange=${this.#onSlotChange}></slot>
      <div class="actions" part="actions" ?hidden=${!this.hasActions}>
        <slot name="extra" @slotchange=${this.#onSlotChange}></slot>
        <slot name="actions" @slotchange=${this.#onSlotChange}></slot>
      </div>
    `;
  }
}

customElements.define("sval-dialog", SvalDialog);
