/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Opens the emoji picker a workspace or group's "Emoji…" command asks for.
 *
 * Gecko has no way to open the operating system's picker from chrome code.
 * On macOS it is reachable only through the native Edit menu, and on Windows
 * it is Win+., which a page cannot press. So Sval draws its own: a page,
 * `emoji-picker.xhtml`, that opens already showing the choices.
 *
 * **A window-modal dialog, `gDialogBox`.** It is drawn inside the browser
 * window, the way Firefox draws its own prompts, so it goes behind another
 * application with the window it belongs to. A popup is an operating-system
 * window of its own, and one that has taken the keyboard stays on screen over
 * whatever the user switched to.
 *
 * What counts as a match, what a tone yields and what the answer means are
 * `SvalPanelModel`'s, so they are testable without a window.
 */

const PICKER_URL = "chrome://browser/content/sval/emoji-picker.xhtml";

/**
 * The skin tone last chosen. A person who picks several emoji in a row sets it
 * once, and the dialog is a new page each time, so it is kept here.
 */
let lastTone = null;

/**
 * The emoji in `groups` that a font on this system draws. Unicode's list runs
 * ahead of the operating systems' emoji fonts, and Gecko draws a character no
 * font has as a box holding its code point (`gfxFontMissingGlyphs`), laid out
 * in the font group's first font (`gfxFontGroup::FindFontForChar`). So each
 * emoji is laid out, unseen, in Outfit, which has no emoji: one that
 * `InspectorUtils.getUsedFontFaces` reports as drawn from the font group is
 * one no font has.
 *
 * Each is judged in its default form: a skin tone adds a modifier the same
 * font draws.
 *
 * @param {Array<{name: string, emoji: Array}>} groups `EMOJI_GROUPS`.
 * @param {Document} doc A document to lay the emoji out in.
 * @returns {Array<{name: string, emoji: Array}>} the groups, each holding only
 *   the emoji it can draw, and none left empty.
 */
export function drawableEmojiGroups(groups, doc) {
  const XHTML = "http://www.w3.org/1999/xhtml";
  const probe = doc.createElementNS(XHTML, "div");
  // Transparent: `getUsedFontFaces` reports nothing for text whose
  // `visibility` hides it (`nsLayoutUtils::GetFontFacesForText`).
  probe.style.cssText =
    "position: fixed; inset-block-start: 0; opacity: 0; " +
    'font-family: "Outfit"; ' +
    "pointer-events: none; white-space: pre;";
  probe.setAttribute("aria-hidden", "true");
  const spans = new Map();
  for (const group of groups) {
    for (const entry of group.emoji) {
      const span = doc.createElementNS(XHTML, "span");
      span.textContent = entry[0];
      probe.append(span, "\n");
      spans.set(entry, span);
    }
  }
  doc.documentElement.append(probe);
  try {
    const range = doc.createRange();
    const drawable = entry => {
      range.selectNodeContents(spans.get(entry));
      const faces = InspectorUtils.getUsedFontFaces(range);
      return faces.every(face => !face.fromFontGroup);
    };
    return groups
      .map(group => ({ ...group, emoji: group.emoji.filter(drawable) }))
      .filter(group => group.emoji.length);
  } finally {
    probe.remove();
  }
}

/**
 * Asks for an emoji and waits for the answer.
 *
 * @param {Window} win The browser window to show the dialog in.
 * @param {string} initial The emoji the node has now, or "".
 * @returns {Promise<{ok: boolean, value: string}>} `ok` is false when the
 *   dialog was dismissed without choosing. A chosen emoji is `value`; "No
 *   emoji" is `ok` with an empty `value`. It is the shape
 *   `SvalPanelModel.chosenEmoji` takes.
 */
export async function chooseEmoji(win, initial = "") {
  const args = {
    initial,
    tone: lastTone,
    result: null,
    // Read by `gDialogBox.open` while the window is in a modal state; see
    // `SvalAgentAlerts.askToPair`.
    getProperty: name => name === "async",
  };
  // Only the browser window has a `gDialogBox`; elsewhere there is nowhere to
  // show one, which reads as a dismissal.
  await win.gDialogBox?.open(PICKER_URL, args);
  lastTone = args.tone ?? null;
  return args.result ?? { ok: false, value: "" };
}

/**
 * Shows the picker in `frame`, a frame of a page that is itself a dialog, as
 * first run's sheet is, over which no second dialog can open. The page reads
 * its arguments from the frame and calls back in place of closing.
 *
 * @param {Element} frame An `iframe` of a chrome document, not yet in it.
 * @param {string} initial The emoji chosen now, or "".
 * @param {Function} answer Called once with `chooseEmoji`'s answer.
 */
export function showInline(frame, initial, answer) {
  const args = {
    initial,
    tone: lastTone,
    result: null,
    answer: () => {
      lastTone = args.tone ?? null;
      answer(args.result ?? { ok: false, value: "" });
    },
  };
  frame.svalEmojiArgs = args;
  frame.setAttribute("src", PICKER_URL);
}
