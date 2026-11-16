/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Sval's general dialog, opened by `SvalDialog.sys.mjs`, which documents what
 * `window.arguments[0]` carries. It answers through that object's `result`:
 * `{ button, value }`, where `button` is the id of the button pressed. A
 * dialog closed any other way, Escape included, leaves `result` null, which
 * the opener reads as a cancel. The checkbox's state is kept in its
 * `checked` as it changes.
 *
 * Every string is set as text, never parsed as markup: a title can name a
 * workspace, a tab or a site, and none of those is Sval's.
 */

"use strict";

const SvalDialogPage = {
  start() {
    const args = window.arguments?.[0] ?? {};
    const form = document.querySelector(".sval-dialog");
    const tone = ["danger", "critical"].includes(args.tone)
      ? args.tone
      : "default";
    form.dataset.tone = tone;
    if (args.state) {
      form.dataset.state = String(args.state);
    }
    if (tone !== "default") {
      form.setAttribute("role", "alertdialog");
    }
    if (tone === "critical") {
      this._critical(form);
    }

    if (args.icon) {
      const icon = document.querySelector(".sval-dialog-icon");
      icon.dataset.icon = String(args.icon);
      icon.hidden = false;
    }
    this._text(form, args);
    if (args.closeButton) {
      const close = document.querySelector(".sval-dialog-close");
      close.hidden = false;
      close.addEventListener("click", () => window.close());
    }

    const input = args.field ? this._field(args.field) : null;
    if (!input && Array.isArray(args.details) && args.details.length) {
      this._details(args.details);
    }
    const check = args.checkbox ? this._checkbox(args.checkbox) : null;
    // Kept as it changes, so a dialog closed without a button, Escape
    // included, still answers with it.
    check?.addEventListener("change", () => {
      args.checked = check.checked;
    });

    const buttons = new Map();
    // What the opener may change while the dialog is up (`onOpen` in
    // `SvalDialog.sys.mjs`).
    const page = {
      update: text => {
        Object.assign(args, text);
        this._text(form, args);
        this._fit();
      },
      setButton: (id, { label, disabled }) => {
        const button = buttons.get(id);
        if (!button) {
          return;
        }
        if (label !== undefined) {
          button.textContent = String(label);
        }
        if (disabled !== undefined) {
          button.disabled = !!disabled;
        }
      },
      close: () => window.close(),
    };
    const actions = document.querySelector(".sval-dialog-actions");
    for (const { id, label, primary, extra } of args.buttons ?? []) {
      const button = document.createElement("button");
      button.className = "sval-dialog-btn";
      button.classList.toggle("primary", !!primary);
      button.classList.toggle("sval-dialog-extra", !!extra);
      button.type = primary ? "submit" : "button";
      button.dataset.button = String(id);
      button.textContent = String(label);
      if (!primary) {
        button.addEventListener("click", () => {
          if (id !== "cancel" && args.onButton?.(id, page)) {
            return;
          }
          this._finish(args, id);
        });
      }
      actions.append(button);
      buttons.set(id, button);
    }
    const primary = actions.querySelector(".primary");

    // The primary button stays enabled, so a keyboard user can reach it and
    // hear why it did not answer: pressing it with nothing in the field, or
    // with what `validate` refuses, shows the reason under the field.
    const validate = ({ submitting = false } = {}) => {
      if (!input || !primary) {
        return true;
      }
      const value = input.value.trim();
      const optional = !!args.field.optional;
      let error = value ? String(args.field.validate?.(value) ?? "") : "";
      if (!value && submitting && !optional) {
        error = `${String(args.field.label)} can\u2019t be empty.`;
      }
      this._showError(input, error);
      return (!!value || optional) && !error;
    };
    input?.addEventListener("input", () => validate());

    // Enter in the field submits, as does a click on the primary button; a
    // focused button other than the primary answers for itself.
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (!primary) {
        return;
      }
      if (validate({ submitting: true })) {
        if (args.onButton?.(primary.dataset.button, page)) {
          return;
        }
        this._finish(args, primary.dataset.button, input);
      } else {
        input.focus();
      }
    });

    const focusTarget = input ?? buttons.get(args.focus) ?? primary;
    // `SubDialog.focus` calls this when the dialog opens, in place of its own
    // move to the first focusable element.
    document.subDialogSetDefaultFocus = () => {
      focusTarget?.focus();
      input?.select();
    };
    document.subDialogSetDefaultFocus();
    args.onOpen?.(page);
  },

  /**
   * Fits the frame to what the page holds after a change while it is up.
   * `SubDialog` measures the page once, at load, and gives the page
   * `resizeDialog` to measure it again. That also fires `dialogopen`, on
   * which `gDialogBox` moves focus to the page's default, so the focus the
   * user had is put back.
   */
  _fit() {
    // Before load, `SubDialog` has yet to measure the page, and will.
    if (document.readyState !== "complete") {
      return;
    }
    const focused = document.activeElement;
    window.resizeDialog?.();
    if (focused && focused !== document.body) {
      focused.focus();
    }
  },

  /**
   * Writes the title, body and warning from `args`, so a dialog the opener
   * updates reads as a fresh one would.
   *
   * @param {Element} form
   * @param {object} args
   */
  _text(form, args) {
    const title = String(args.title ?? "");
    document.getElementById("sval-dialog-title").textContent = title;
    // `SubDialog` follows `DOMTitleChanged`, so the frame is named for it.
    document.title = title;
    const body = document.getElementById("sval-dialog-body");
    body.textContent = String(args.body ?? "");
    body.hidden = !args.body;
    const warning = document.getElementById("sval-dialog-warning");
    warning.textContent = String(args.warning ?? "");
    warning.hidden = !args.warning;
    const described = [body, warning].filter(el => !el.hidden);
    if (described.length) {
      form.setAttribute(
        "aria-describedby",
        described.map(el => el.id).join(" ")
      );
    } else {
      form.removeAttribute("aria-describedby");
    }
  },

  /**
   * The critical frame (messages spec §9.3). Its body sits under the title
   * band, and the scrim is the window's: `gDialogBox` draws it as the
   * `::backdrop` of `#window-modal-dialog`, which `sval-header.css` colours
   * for the attribute set here. `SvalDialog.sys.mjs` takes the attribute off
   * when the dialog closes.
   *
   * @param {Element} form
   */
  _critical(form) {
    const head = form.querySelector(".sval-dialog-head");
    head.after(
      document.getElementById("sval-dialog-body"),
      document.getElementById("sval-dialog-warning")
    );
    const frame = window.frameElement;
    frame?.ownerDocument
      .getElementById("window-modal-dialog")
      ?.setAttribute("data-sval-tone", "critical");
    const card = getComputedStyle(form);
    // `SubDialog.resizeHorizontally` sizes the frame from the root's inline
    // min-width when there is one, and otherwise from the content as laid out
    // in the frame's default width, which is narrower than this card.
    document.documentElement.style.minWidth = card
      .getPropertyValue("--sval-dialog-width")
      .trim();
    const { shapeDialogBox } = ChromeUtils.importESModule(
      "moz-src:///browser/components/sval/SvalDialogBox.sys.mjs"
    );
    shapeDialogBox(form, {
      shadow: card.getPropertyValue("--sval-dialog-shadow").trim(),
    });
  },

  _field({ label, value, placeholder, maxLength }) {
    const field = document.querySelector(".sval-dialog-field");
    field.querySelector(".sval-dialog-label").textContent = String(label ?? "");
    const input = field.querySelector(".sval-dialog-input");
    input.value = String(value ?? "");
    input.placeholder = String(placeholder ?? "");
    if (Number.isInteger(maxLength) && maxLength > 0) {
      input.maxLength = maxLength;
    }
    field.hidden = false;
    return input;
  },

  /**
   * Shows `error` under the field and ties it to the input as its
   * description, or clears both.
   *
   * @param {Element} input
   * @param {string} error "" for none.
   */
  _showError(input, error) {
    document.getElementById("sval-dialog-error").textContent = error;
    input.setAttribute("aria-invalid", error ? "true" : "false");
    if (error) {
      input.setAttribute("aria-describedby", "sval-dialog-error");
    } else {
      input.removeAttribute("aria-describedby");
    }
  },

  _details(details) {
    const list = document.querySelector(".sval-dialog-details");
    for (const [key, value] of details) {
      const dt = document.createElement("dt");
      dt.textContent = String(key);
      const dd = document.createElement("dd");
      dd.textContent = String(value);
      list.append(dt, dd);
    }
    list.hidden = false;
  },

  _checkbox({ label, checked }) {
    const wrap = document.querySelector(".sval-dialog-check");
    wrap.querySelector(".sval-dialog-check-label").textContent = String(
      label ?? ""
    );
    const box = wrap.querySelector("input");
    box.checked = !!checked;
    wrap.hidden = false;
    return box;
  },

  _finish(args, button, input = null) {
    args.result = { button, value: input?.value };
    window.close();
  },
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => SvalDialogPage.start(), {
    once: true,
  });
} else {
  SvalDialogPage.start();
}
