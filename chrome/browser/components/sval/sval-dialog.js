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
    const card = document.querySelector("sval-dialog");
    const form = card.closest("form");
    const tone = ["danger", "critical"].includes(args.tone)
      ? args.tone
      : "default";
    card.tone = tone;
    if (args.state) {
      card.state = String(args.state);
    }
    if (tone !== "default") {
      card.setAttribute("role", "alertdialog");
    }
    if (args.icon) {
      card.icon = String(args.icon);
    }
    this._text(card, args);
    // The ✕ closes the page, which answers as Escape does.
    card.closeButton = !!args.closeButton;

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
        if (args.state) {
          card.state = String(args.state);
        }
        this._text(card, args);
        this._fit();
      },
      value: () => input?.value ?? "",
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
    for (const { id, label, primary, extra } of args.buttons ?? []) {
      const button = document.createElement("sval-button");
      button.slot = extra ? "extra" : "actions";
      if (primary) {
        button.type = "primary";
        button.submit = true;
      }
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
      card.append(button);
      buttons.set(id, button);
    }
    const primary =
      [...buttons.values()].find(button => button.type === "primary") ?? null;

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
      input.error = error;
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

    card.defaultFocus = input ?? buttons.get(args.focus) ?? primary;
    card.focusDefault();
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
    // A field's `focus()` selects its text (decision 2713), and the user may
    // be typing in it, so the caret and selection are put back as they were.
    const field = focused?.localName === "sval-field" ? focused : null;
    const range = field && [
      field.selectionStart,
      field.selectionEnd,
      field.selectionDirection,
    ];
    window.resizeDialog?.();
    if (focused && focused !== document.body) {
      focused.focus();
      field?.setSelectionRange(...range);
    }
  },

  /**
   * Writes the title, body and warning from `args`, so a dialog the opener
   * updates reads as a fresh one would.
   *
   * @param {Element} card The `sval-dialog`.
   * @param {object} args
   */
  _text(card, args) {
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
      card.setAttribute(
        "aria-describedby",
        described.map(el => el.id).join(" ")
      );
    } else {
      card.removeAttribute("aria-describedby");
    }
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
    const box = wrap.querySelector("sval-checkbox");
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
