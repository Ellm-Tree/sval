/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Sval's dialog for a workspace or group: a name, a colour and an emoji,
 * opened by `SvalNewWorkspace.sys.mjs`, which passes the title and the submit
 * button's label. Creating one and editing one are the same dialog.
 *
 * It answers through `window.arguments[0].result`, which the opener reads once
 * the dialog has closed: `{ action, name, color, transparency, emoji, isolated,
 * autoArchive, lookError }` where `action` is `create`, `pickEmoji` or
 * `cancel`; `create` is the submit button, whatever its label says. A dialog
 * closed any other way leaves `result` null, which the opener reads as a
 * cancel.
 *
 * An opener that passes `save(fields)` has the submit button wait for it with
 * Save disabled. It answers `{ ok: true }` and the dialog closes, or
 * `{ ok: false, field: "look" }` and the dialog stays open with the colour and
 * emoji as chosen, saying so under the picker, for Save to try again. A
 * `save` that throws leaves the dialog open the same way, with a general line
 * in the same place.
 *
 * The fields are `SvalWorkspaceForm`'s (`workspace-form.js`). A classic
 * script in a chrome document, like `emoji-picker.js`, so the modules come
 * through `ChromeUtils`.
 */

/* import-globals-from workspace-form.js */

"use strict";

const { SvalLog } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLog.sys.mjs"
);
const { pickerTiming } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalColorPicker.sys.mjs"
);

const SvalNewWorkspace = {
  /**
   * What the opener passed in: `{ title, purpose, submitLabel, tintsWindow,
   * blockSurface, name, color, transparency, emoji, isolated, focus,
   * preview, result }`. `preview(fields, done)`, for a workspace the window
   * shows, puts each colour on the window while the dialog is open. `purpose` is
   * what the dialog is for: `new-workspace`, `new-group`, `edit-workspace`
   * or `edit-group`, set on the form as `data-purpose`. `isolated` is absent
   * for a group and for an edit, which offer no choice of jar (isolated
   * workspaces spec §5). `autoArchive`, for an edit of a workspace whose
   * tabs can be archived, is `{ choices: [{ value, label }], value }`: the
   * workspace's own choice, "" following the global one (idle-tab archive
   * spec §5). `focus` is `emoji` when the dialog reopens from the picker, so
   * focus returns to the button that opened it. `save` is the opener's write
   * of the fields, and `lookError` is true when the dialog reopens from the
   * picker with the colour and emoji not saved.
   */
  _args: null,

  /** @type {boolean} Whether `save` is running, so a second submit waits. */
  _saving: false,

  /** @type {boolean} Whether the line under the picker says the look was refused. */
  _lookFailed: false,

  start() {
    this._args = window.arguments?.[0] ?? {};
    const title = document.getElementById("sval-nw-title");
    title.after(...SvalWorkspaceForm.fields(document));
    this._els = {
      form: document.querySelector(".sval-nw"),
      lookError: document.getElementById("sval-nw-look-error"),
      create: document.querySelector(".sval-nw-create"),
      cancel: document.querySelector(".sval-nw-cancel"),
      isolated: document.querySelector(".sval-nw-isolated"),
      archive: document.querySelector(".sval-nw-archive"),
      archiveChoice: document.querySelector(".sval-nw-archive-choice"),
    };
    if (this._args.autoArchive) {
      const { choices, value } = this._args.autoArchive;
      for (const choice of choices) {
        const option = document.createElement("option");
        option.value = choice.value;
        option.textContent = choice.label;
        this._els.archiveChoice.append(option);
      }
      this._els.archiveChoice.value = value;
      this._els.archive.hidden = false;
    }
    if (typeof this._args.isolated === "boolean") {
      this._els.isolated.hidden = false;
      this._els.isolated.querySelector("input").checked = this._args.isolated;
    }
    if (this._args.purpose) {
      this._els.form.dataset.purpose = this._args.purpose;
    }
    if (this._args.title) {
      // `SubDialog` follows `DOMTitleChanged`, so the frame's title follows.
      document.title = this._args.title;
      document.getElementById("sval-nw-title").textContent = this._args.title;
    }
    if (this._args.submitLabel) {
      this._els.create.textContent = this._args.submitLabel;
    }
    this._form = new SvalWorkspaceForm(this._els.form, {
      tintsWindow: this._args.tintsWindow,
      blockSurface: this._args.blockSurface ?? null,
      name: this._args.name ?? "",
      color: this._args.color ?? null,
      transparency: this._args.transparency ?? 0,
      emoji: this._args.emoji ?? "",
      onChange: (field, done = true) => {
        if (field === "color") {
          // The refusal was of the look chosen before.
          this._showSaveError(null);
          pickerTiming.time("dialog", () => this._syncTint());
          pickerTiming.time("window", () =>
            this._args.preview?.(this._fields(), done)
          );
          // The window first: a dialog's flush flushes the window it sits
          // in too.
          pickerTiming.flush(
            "window style and layout",
            window.browsingContext.topChromeWindow.document
          );
          pickerTiming.flush("dialog style and layout", document);
        }
      },
      onPickEmoji: () => this._finish("pickEmoji"),
    });
    this._syncTint();
    this._showSaveError(this._args.lookError ? "look" : null);

    this._els.form.addEventListener("submit", event => {
      event.preventDefault();
      this._submit();
    });
    this._els.cancel.addEventListener("click", () => this._finish("cancel"));
    const focusTarget =
      this._args.focus === "emoji" ? this._form.els.emoji : this._form.els.name;
    // `SubDialog.focus` calls this when the dialog opens, in place of its own
    // move to the first field it finds.
    document.subDialogSetDefaultFocus = () => focusTarget.focus();
    document.subDialogSetDefaultFocus();
  },

  /**
   * Paints the card in what the choice will look like: for a workspace the
   * window it will get, opaque, with the colours drawn on it, as
   * `sval-dialog-frame.js` paints a dialog over a tinted window; for a group
   * its block on the window under the dialog, or the window's own colour
   * with none chosen.
   */
  _syncTint() {
    if (this._args.tintsWindow) {
      window.svalPaintDialogTint(this._form.color, {
        transparency: this._form.transparency,
      });
      return;
    }
    window.svalPaintDialogTint(undefined, {
      group: this._form.color,
      on: this._args.blockSurface,
    });
  },

  /**
   * Says under the picker that the changes were not saved, or clears it. The
   * line is an alert, so a screen reader reads it when it appears.
   *
   * @param {"look"|"other"|null} failure `look` for a refused colour or
   *   emoji, `other` for any other failure of `save`, null for none.
   */
  _showSaveError(failure) {
    this._lookFailed = failure === "look";
    this._els.lookError.dataset.failure = failure ?? "";
    this._els.lookError.textContent =
      {
        look: "Couldn't save the color or emoji.",
        other: "Couldn't save your changes.",
      }[failure] ?? "";
  },

  /**
   * @returns {object} What the dialog holds, as the opener reads it.
   */
  _fields() {
    return {
      name: this._form.name,
      color: this._form.color,
      transparency: this._form.transparency,
      emoji: this._form.emoji,
      isolated: this._els.isolated.hidden
        ? undefined
        : this._els.isolated.querySelector("input").checked,
      autoArchive: this._els.archive.hidden
        ? undefined
        : this._els.archiveChoice.value,
    };
  },

  /**
   * Answers and closes the dialog.
   *
   * @param {string} action `create`, `pickEmoji` or `cancel`.
   */
  _finish(action) {
    this._args.result = {
      action,
      ...this._fields(),
      lookError: this._lookFailed,
    };
    window.close();
  },

  /**
   * The submit button. A blank name is refused here. Otherwise the opener's
   * `save` runs first when it passed one, and the dialog closes only on
   * success.
   */
  async _submit() {
    if (this._saving) {
      return;
    }
    // Create stays enabled, so a keyboard user can reach it and hear why it
    // did not answer.
    if (!this._form.checkName()) {
      return;
    }
    if (!this._args.save) {
      this._finish("create");
      return;
    }
    const { create } = this._els;
    this._saving = true;
    create.disabled = true;
    this._showSaveError(null);
    let outcome;
    try {
      outcome = await this._args.save(this._fields());
    } catch (err) {
      // Anything but a refused look, such as a failed rename.
      SvalLog.warn(`new workspace: the save failed: ${SvalLog.errorName(err)}`);
      outcome = { ok: false, field: "other" };
    }
    this._saving = false;
    create.disabled = false;
    if (outcome?.ok) {
      this._finish("create");
      return;
    }
    this._showSaveError(outcome?.field === "other" ? "other" : "look");
    // Disabling the focused button dropped focus; Save is where a retry is.
    create.focus();
  },
};

// Not `defer`: a chrome page served as XHTML runs its scripts as the parser
// reaches them, so this script runs before the body exists.
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", () => SvalNewWorkspace.start(), {
    once: true,
  });
} else {
  SvalNewWorkspace.start();
}
