/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Sval's general dialog: one question with an icon, a title and a one-line
 * body, at most one of a text field or a well of details, an optional
 * checkbox, and the buttons, the primary last. Every decision Sval's own chrome
 * asks for goes through it, so every one looks the same (`sval-dialog.css`).
 * The page's own prompts (`alert`, `confirm`, authentication) are Firefox's
 * and stay so.
 *
 * A window-modal dialog (`gDialogBox`), like `SvalNewWorkspace`: drawn inside
 * the window it is about, so it goes where that window goes, and queued
 * behind any dialog already showing there.
 */

const DIALOG_URL = "chrome://browser/content/sval/sval-dialog.xhtml";

/**
 * Asks one question in `win` and waits for the answer.
 *
 * @param {Window} win The browser window to ask in.
 * @param {object} options
 * @param {string} [options.icon] `pencil`, `trash`, `agent`, `key`, `sval`
 *   or `critical`.
 * @param {"default"|"danger"|"critical"} [options.tone] A danger dialog's
 *   primary is red and Cancel has focus, so a stray Enter does nothing it
 *   cannot undo. A critical dialog is the frame of messages spec §9.3, for a
 *   fault that loses the user's work.
 * @param {string} [options.state] Which case of its question the dialog
 *   asks, as the page's `data-state`, for a reader that tells cases apart
 *   without reading their wording.
 * @param {"ok"|"cancel"} [options.focus] The button that has focus, for a
 *   question whose safe answer is Cancel in any tone. Without it, the tone
 *   decides.
 * @param {string} options.title A question or a verb phrase.
 * @param {string} [options.body] One sentence saying what happens.
 * @param {string} [options.warning] A sentence under the body, in the
 *   tone's warning ink, saying what the user loses.
 * @param {boolean} [options.closeButton] A ✕ in the corner, which answers as
 *   Escape does.
 * @param {{label: string, value?: string, placeholder?: string,
 *   maxLength?: number, optional?: boolean,
 *   validate?: (value: string) => string}} [options.field]
 *   A text field. `validate` gets the trimmed value and returns "" when it is
 *   good, or a short reason shown under the field. The primary button
 *   answers only once the field holds a value `validate` accepts, or is
 *   empty when the field is `optional`; pressed before then, it shows the
 *   reason instead.
 * @param {Array<[string, string]>} [options.details] Key and value rows,
 *   shown when there is no field.
 * @param {{label: string, checked?: boolean}} [options.checkbox]
 * @param {string} options.primary The primary button's label: a verb.
 * @param {string|null} [options.secondary] The cancelling button's label,
 *   or null for none.
 * @param {string} [options.extra] A third answer's label, set apart at the
 *   start of the row.
 * @param {(page: object) => void} [options.onOpen] Called once the dialog
 *   shows, with the page's handle: `update({ title, body, warning, state })`,
 *   `setButton(id, { label, disabled })`, `value()` for the field's untrimmed
 *   value, and `close()`, so the opener can change a dialog that is still up
 *   and act on its field in place.
 * @param {(id: string, page: object) => boolean} [options.onButton] Called
 *   for a press of `ok` or `extra` before it answers. Returning true keeps
 *   the dialog up, for a button that acts in place.
 * @returns {Promise<{ok: boolean, extra?: boolean, value?: string,
 *   checked?: boolean}>} `ok` for the primary button, with the field's
 *   untrimmed value when there is one. `extra` for the third answer.
 *   Anything else, Escape included, and a window with no dialog box, is
 *   `{ok: false}`. Every answer, Escape included, carries the checkbox's
 *   state when there is one, because a "Don't ask again" holds whatever the
 *   answer.
 */
export async function openSvalDialog(
  win,
  {
    icon,
    tone = "default",
    state,
    focus = tone === "danger" ? "cancel" : "ok",
    title,
    body,
    warning,
    closeButton = false,
    field,
    details,
    checkbox,
    primary,
    secondary = "Cancel",
    extra,
    onOpen,
    onButton,
  }
) {
  const buttons = [];
  if (extra) {
    buttons.push({ id: "extra", label: extra, extra: true });
  }
  if (secondary !== null) {
    buttons.push({ id: "cancel", label: secondary });
  }
  buttons.push({ id: "ok", label: primary, primary: true });
  const args = {
    icon,
    tone,
    state,
    title,
    body,
    warning,
    closeButton,
    field,
    details,
    checkbox,
    onOpen,
    onButton,
    checked: !!checkbox?.checked,
    buttons,
    focus,
    result: null,
    // Read by `gDialogBox.open` while the window is in a modal state; see
    // `SvalAgentAlerts.askToPair`.
    getProperty: name => name === "async",
  };
  // Only a browser window has a `gDialogBox`; elsewhere there is nowhere to
  // ask, which reads as a cancel.
  await win?.gDialogBox?.open(DIALOG_URL, args);
  // Set by the critical frame (`sval-dialog.js`) to colour the window's
  // scrim, which outlives the dialog.
  win?.document
    ?.getElementById("window-modal-dialog")
    ?.removeAttribute("data-sval-tone");
  const checked = checkbox ? { checked: !!args.checked } : {};
  switch (args.result?.button) {
    case "ok":
      return {
        ok: true,
        ...(field ? { value: args.result.value } : {}),
        ...checked,
      };
    case "extra":
      return { ok: false, extra: true, ...checked };
    default:
      return { ok: false, ...checked };
  }
}
