/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Opens the dialog a workspace or group is made and edited in: a name, a
 * colour and an emoji in one place. A workspace and a group are the two places
 * a person names and wears a colour and emoji (spec §10.7), so both are made
 * and edited through the one dialog, titled for what it does.
 *
 * A window-modal dialog (`gDialogBox`), for the reasons `SvalEmojiPicker`
 * gives. `gDialogBox` queues a dialog opened while another is showing until
 * that one closes, so this dialog cannot open the emoji picker from inside
 * itself. It answers `pickEmoji` instead, and the caller opens the picker and
 * then opens this dialog again with what the user had entered.
 */

import { openSvalDialogPage } from "moz-src:///browser/components/sval/SvalDialog.sys.mjs";

const DIALOG_URL = "chrome://browser/content/sval/new-workspace.xhtml";

/**
 * Asks what a workspace or group should be and waits for the answer.
 *
 * @param {Window} win The browser window to show the dialog in.
 * @param {{title: string, submitLabel: string, tintsWindow: boolean,
 *   name: string, color: string|null, emoji: string, isolated?: boolean,
 *   focus?: "emoji"}}
 *   state The dialog's title, its submit button's label, whether the colour
 *   tints the window as a workspace's does, and what the fields start with.
 *   `isolated` offers the Isolated checkbox, for a new workspace only.
 *   `autoArchive`, `{ choices, value }`, offers a workspace's own choice for
 *   archiving idle tabs, for an edit.
 *   `focus: "emoji"` starts on the Emoji button, for the dialog shown again
 *   after the picker.
 *   `save(fields)` writes the fields while Save waits, and answers
 *   `{ ok: true }` or `{ ok: false, field: "look" }`. A refused look keeps the
 *   dialog open with the colour and emoji as chosen, for Save to try again.
 *   `lookError` shows that refusal again, for the dialog shown after the
 *   picker.
 * @returns {Promise<{action: string, name?: string, color?: string|null,
 *   emoji?: string, isolated?: boolean, autoArchive?: string,
 *   lookError?: boolean}>} `action` is `create`, `pickEmoji` or `cancel`. The
 *   fields come back with `create` and `pickEmoji`. Only `create` is an
 *   accepted dialog, whatever the submit button says.
 */
export async function askNewContainer(win, state) {
  const args = {
    ...state,
    // A group's swatches are its block on the window under the dialog.
    blockSurface: win.SvalPanel?.windowBlockSurface() ?? null,
    result: null,
  };
  // A window with no modal box has nowhere to show one, which reads as a
  // dismissal.
  await openSvalDialogPage(win, DIALOG_URL, args);
  return args.result ?? { action: "cancel" };
}
