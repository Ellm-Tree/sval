/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Each of Sval's dialog pages on `sval-dialog`, driven as a person drives
 * it: it opens on its card, asks its question, and each answer, Escape and
 * Enter do what they say. The backup of the sync key, the card dialog, the
 * emoji picker and the export page.
 */

const { SvalBackupKey } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBackupKey.sys.mjs"
);
const { openCardDialog } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalCardArt.sys.mjs"
);
const { readCard } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalCard.sys.mjs"
);
const { chooseEmoji } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEmojiPicker.sys.mjs"
);
const MockFilePicker = SpecialPowers.MockFilePicker;

add_setup(async () => {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  MockFilePicker.init(window.browsingContext);
  registerCleanupFunction(() => MockFilePicker.cleanup());
  registerCleanupFunction(closeLeftoverDialog);
});

/**
 * @param {Promise} answer
 * @param {string} what
 * @returns {Promise<*>} The dialog's answer, once it has closed.
 */
async function closedWith(answer, what) {
  const result = await within(answer, 10_000, what);
  await TestUtils.waitForCondition(
    () => !gDialogBox.isOpen,
    `${what}: the dialog closes`
  );
  return result;
}

/** Each picker the file picker is asked for is cancelled. */
function cancelPickers() {
  const asked = { count: 0 };
  MockFilePicker.showCallback = () => {
    asked.count++;
  };
  MockFilePicker.returnValue = MockFilePicker.returnCancel;
  atTaskEnd(() => (MockFilePicker.showCallback = null));
  return asked;
}

const KEY = Uint8Array.from({ length: 32 }, (_, i) => (i * 7) & 255);

/** Opens the backup of the sync key. */
function showBackup() {
  return SvalBackupKey.show(window, {
    keyBytes: KEY,
    fingerprint: "0123456789abcdef0123",
    sharedRoot: PathUtils.join(PathUtils.tempDir, "sval-sync-folder"),
  });
}

add_task(async function the_backup_offers_the_key_and_done() {
  const asked = cancelPickers();
  let shown = showBackup();
  let { doc, dialog } = await openedSvalDialog();
  Assert.equal(dialog.icon, "key", "the card wears the key tile");
  Assert.ok(
    doc.querySelector(".sval-backup-code").textContent,
    "it shows the key"
  );
  Assert.equal(
    doc.activeElement,
    doc.querySelector('[data-button="ok"]'),
    "Done has the focus"
  );
  await pressDialogButton(doc, "save");
  await TestUtils.waitForCondition(() => asked.count === 1, "Save asks where");
  Assert.ok(gDialogBox.isOpen, "a cancelled save keeps the backup open");
  await pressDialogButton(doc, "ok");
  Assert.equal(
    await closedWith(shown, "Done"),
    false,
    "Done closes it, nothing saved"
  );

  shown = showBackup();
  ({ doc } = await openedSvalDialog());
  EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
  Assert.equal(await closedWith(shown, "Escape"), false, "Escape closes it");

  shown = showBackup();
  ({ doc } = await openedSvalDialog());
  EventUtils.synthesizeKey("KEY_Enter", {}, doc.defaultView);
  Assert.equal(await closedWith(shown, "Enter"), false, "Enter presses Done");
});

add_task(async function the_card_dialog_shows_the_card_and_done() {
  Assert.ok(readCard(), "the profile has a card");
  let closed = openCardDialog(window);
  let { doc, dialog } = await openedSvalDialog();
  await TestUtils.waitForCondition(
    () => doc.querySelector(".sval-mcard svg"),
    "the card shows"
  );
  Assert.ok(
    doc.getElementById("sval-card-dialog-title").textContent,
    "under its name"
  );
  Assert.greaterOrEqual(
    Math.round(dialog.getBoundingClientRect().width),
    620,
    "on a card wide enough for the card beside its facts"
  );
  await pressDialogButton(doc, "ok");
  await closedWith(closed, "Done");

  closed = openCardDialog(window);
  ({ doc } = await openedSvalDialog());
  EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
  await closedWith(closed, "Escape");

  closed = openCardDialog(window);
  ({ doc } = await openedSvalDialog());
  await TestUtils.waitForCondition(
    () => doc.activeElement === doc.querySelector('[data-button="ok"]'),
    "Done has the focus"
  );
  EventUtils.synthesizeKey("KEY_Enter", {}, doc.defaultView);
  await closedWith(closed, "Enter");
});

add_task(async function the_emoji_picker_answers_each_way() {
  let answer = chooseEmoji(window, "🍕");
  let { doc, dialog } = await openedSvalDialog();
  Assert.equal(dialog.getAttribute("role"), "dialog", "a dialog");
  const search = doc.querySelector(".sval-emoji-search");
  Assert.equal(doc.activeElement, search, "the search has the focus");
  await pressDialogButton(doc, "none");
  Assert.deepEqual(
    await closedWith(answer, "No emoji"),
    { ok: true, value: "" },
    "No emoji takes the emoji off"
  );

  answer = chooseEmoji(window, "🍕");
  ({ doc } = await openedSvalDialog());
  await pressDialogButton(doc, "cancel");
  Assert.equal(
    (await closedWith(answer, "Cancel")).ok,
    false,
    "Cancel changes nothing"
  );

  answer = chooseEmoji(window, "");
  ({ doc } = await openedSvalDialog());
  Assert.ok(
    !doc.querySelector('[data-button="none"]').checkVisibility(),
    "a node with no emoji is offered no No emoji"
  );
  EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
  Assert.equal((await closedWith(answer, "Escape")).ok, false, "Escape too");

  answer = chooseEmoji(window, "");
  ({ doc } = await openedSvalDialog());
  EventUtils.sendString("pizza", doc.defaultView);
  EventUtils.synthesizeKey("KEY_Enter", {}, doc.defaultView);
  Assert.deepEqual(
    await closedWith(answer, "Enter"),
    { ok: true, value: "🍕" },
    "Enter in the search takes the first match"
  );
});

add_task(async function the_export_page_exports_or_cancels() {
  const asked = cancelPickers();
  let done = SvalPanel.openExport();
  let { doc } = await openedSvalDialog();
  Assert.ok(
    doc.querySelectorAll(".sval-ex-target").length,
    "it asks which browser"
  );
  await pressDialogButton(doc, "ok");
  await TestUtils.waitForCondition(
    () => asked.count === 1,
    "Export asks where"
  );
  Assert.ok(gDialogBox.isOpen, "a cancelled save keeps the page open");
  await pressDialogButton(doc, "cancel");
  await closedWith(done, "Cancel");

  done = SvalPanel.openExport();
  ({ doc } = await openedSvalDialog());
  EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
  await closedWith(done, "Escape");

  done = SvalPanel.openExport();
  ({ doc } = await openedSvalDialog());
  doc.querySelector('[data-button="ok"]').focus();
  EventUtils.synthesizeKey("KEY_Enter", {}, doc.defaultView);
  await TestUtils.waitForCondition(
    () => asked.count === 2,
    "Enter on Export asks where"
  );
  await pressDialogButton(doc, "cancel");
  await closedWith(done, "Cancel");
});
