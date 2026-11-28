/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * `sval-dialog` (`elements/sval-dialog.mjs`), as Sval's general dialog
 * (`SvalDialog.sys.mjs`) draws it in a browser window's modal box: what
 * each slot holds and where, the tones, the ✕, Escape, Enter, the default
 * focus, focus kept inside the dialog, and what the accessibility API reads.
 */

const { openSvalDialog } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalDialog.sys.mjs"
);

registerCleanupFunction(closeLeftoverDialog);

/**
 * Opens the general dialog with `options` and waits for it to show.
 *
 * @param {object} options `openSvalDialog`'s.
 * @returns {Promise<{answer: Promise<object>, doc: Document,
 *   dialog: Element}>}
 */
async function opened(options) {
  const answer = openSvalDialog(window, {
    title: "Rename this Workspace?",
    primary: "Rename",
    ...options,
  });
  const { doc, dialog } = await openedSvalDialog();
  return { answer, doc, dialog };
}

/**
 * @param {Promise<object>} answer
 * @returns {Promise<object>} The dialog's answer, once it has closed.
 */
async function answerOf(answer) {
  const result = await within(answer, 10_000, "the dialog's answer");
  await TestUtils.waitForCondition(
    () => !gDialogBox.isOpen,
    "the dialog closes"
  );
  return result;
}

/**
 * @param {Element} dialog
 * @param {string} name A part of the card's shadow root.
 * @returns {Element}
 */
function part(dialog, name) {
  return dialog.shadowRoot.querySelector(`[part~="${name}"]`);
}

add_task(async function each_slot_draws_in_its_place() {
  const { answer, doc, dialog } = await opened({
    icon: "pencil",
    body: "Its tabs stay where they are.",
    warning: "This can't be undone.",
    extra: "Keep tabs",
  });
  const title = doc.getElementById("sval-dialog-title");
  const body = doc.getElementById("sval-dialog-body");
  const warning = doc.getElementById("sval-dialog-warning");
  Assert.equal(title.assignedSlot?.name, "title", "the title is slotted");
  Assert.equal(body.assignedSlot?.name, "body", "the body is slotted");
  Assert.equal(warning.assignedSlot?.name, "warning", "the warning too");
  Assert.ok(
    part(dialog, "head").contains(title.assignedSlot),
    "all three in the head row"
  );
  const icon = part(dialog, "icon");
  Assert.ok(icon.checkVisibility(), "the icon tile shows");
  Assert.equal(icon.dataset.icon, "pencil", "with the icon asked for");

  const buttons = [...dialog.querySelectorAll("sval-button")];
  Assert.deepEqual(
    buttons.map(b => [b.dataset.button, b.slot]),
    [
      ["extra", "extra"],
      ["cancel", "actions"],
      ["ok", "actions"],
    ],
    "the answers, the third set apart and the primary last"
  );
  const actions = part(dialog, "actions");
  for (const button of buttons) {
    Assert.ok(
      actions.contains(button.assignedSlot),
      `${button.dataset.button} sits in the row of answers`
    );
  }
  const [extra, cancel, ok] = buttons.map(b => b.getBoundingClientRect());
  Assert.less(extra.right, cancel.left, "the third answer at the start");
  Assert.less(cancel.right, ok.left, "the primary at the end");
  Assert.greater(
    cancel.left - extra.right,
    ok.left - cancel.right,
    "with room between it and the others"
  );
  Assert.lessOrEqual(
    title.getBoundingClientRect().bottom,
    actions.getBoundingClientRect().top,
    "the answers under the title"
  );

  await pressDialogButton(doc, "extra");
  Assert.deepEqual(await answerOf(answer), { ok: false, extra: true });
});

add_task(async function a_dialog_without_an_icon_or_answers_draws_neither() {
  const { answer, doc, dialog } = await opened({ secondary: null });
  Assert.ok(!part(dialog, "icon").checkVisibility(), "no icon tile");
  Assert.ok(part(dialog, "actions").checkVisibility(), "the one answer shows");
  await pressDialogButton(doc, "ok");
  Assert.deepEqual(await answerOf(answer), { ok: true });
});

add_task(async function danger_reddens_the_primary_and_focuses_cancel() {
  const { answer, doc, dialog } = await opened({
    tone: "danger",
    icon: "trash",
    title: "Delete this Workspace?",
    primary: "Delete",
  });
  Assert.equal(dialog.tone, "danger", "the card takes the tone");
  Assert.equal(
    dialog.getAttribute("role"),
    "alertdialog",
    "and is an alert dialog"
  );
  const cancel = doc.querySelector('[data-button="cancel"]');
  Assert.equal(doc.activeElement, cancel, "Cancel has the focus");
  const view = doc.defaultView;
  const ok = doc.querySelector('[data-button="ok"]');
  const fill = InspectorUtils.colorToRGBA(
    view.getComputedStyle(ok.shadowRoot.querySelector("button")).backgroundColor
  );
  const danger = InspectorUtils.colorToRGBA(
    view
      .getComputedStyle(doc.documentElement)
      .getPropertyValue("--sval-dialog-danger")
      .trim()
  );
  Assert.deepEqual(
    [fill.r, fill.g, fill.b],
    [danger.r, danger.g, danger.b],
    "in the palette's danger red"
  );
  EventUtils.synthesizeKey("KEY_Enter", {}, view);
  Assert.deepEqual(
    await answerOf(answer),
    { ok: false },
    "a stray Enter answers Cancel"
  );
});

add_task(async function critical_draws_a_red_scrim_and_stays_solid() {
  const { answer, doc, dialog } = await opened({
    tone: "critical",
    icon: "critical",
    title: "Sval can't save your Workspaces",
    body: "Your changes are kept on this computer until it can.",
    warning: "Closing Sval now loses them.",
    closeButton: true,
  });
  const scrim = document.getElementById("window-modal-dialog");
  Assert.equal(scrim.dataset.svalTone, "critical", "the scrim is critical");
  Assert.ok(
    getComputedStyle(scrim, "::backdrop").backgroundImage.startsWith(
      "radial-gradient(circle at 50% 40%, rgba(120, 10, 20"
    ),
    "and red"
  );
  const view = doc.defaultView;
  const card = InspectorUtils.colorToRGBA(
    view.getComputedStyle(dialog).backgroundColor
  );
  Assert.equal(card.a, 1, "the card is solid");
  const box = view.frameElement.closest(".dialogBox");
  Assert.equal(
    InspectorUtils.colorToRGBA(getComputedStyle(box).backgroundColor).a,
    1,
    "and so is the box round it"
  );
  Assert.equal(
    getComputedStyle(box).backdropFilter,
    "none",
    "which blurs nothing behind it"
  );
  const head = part(dialog, "head");
  const band = InspectorUtils.colorToRGBA(
    view.getComputedStyle(head).backgroundColor
  );
  Assert.greater(band.r, band.g + band.b, "the title sits in a red band");
  const body = doc.getElementById("sval-dialog-body");
  Assert.ok(!head.contains(body.assignedSlot), "with the body under the band");
  Assert.greaterOrEqual(
    body.getBoundingClientRect().top,
    head.getBoundingClientRect().bottom,
    "below it"
  );
  await pressDialogButton(doc, "ok");
  await answerOf(answer);
  Assert.ok(!scrim.hasAttribute("data-sval-tone"), "the scrim is put back");
});

add_task(async function the_close_button_dismisses_unless_cancelled() {
  const { answer, doc, dialog } = await opened({ closeButton: true });
  const close = dialog.shadowRoot.querySelector(".close");
  Assert.ok(close.checkVisibility(), "the ✕ shows");
  const accessible = await accessibleOf(close);
  Assert.equal(accessible.name, "Close", "named Close");
  let heard = 0;
  const keep = event => {
    heard++;
    event.preventDefault();
  };
  dialog.addEventListener("sval-dialog-dismiss", keep);
  close.click();
  Assert.equal(heard, 1, "the ✕ fires sval-dialog-dismiss");
  Assert.ok(gDialogBox.isOpen, "and a page that cancels it keeps the dialog");
  dialog.removeEventListener("sval-dialog-dismiss", keep);
  close.click();
  Assert.deepEqual(
    await answerOf(answer),
    { ok: false },
    "uncancelled, it closes the dialog as Escape does"
  );
  Assert.ok(!doc.defaultView, "and the page goes with it");
});

add_task(async function escape_closes_unless_the_page_prevents_it() {
  const { answer, doc } = await opened({});
  const view = doc.defaultView;
  const hold = event => event.preventDefault();
  view.addEventListener("keydown", hold);
  EventUtils.synthesizeKey("KEY_Escape", {}, view);
  Assert.ok(gDialogBox.isOpen, "a page that prevents Escape stays");
  view.removeEventListener("keydown", hold);
  EventUtils.synthesizeKey("KEY_Escape", {}, view);
  Assert.deepEqual(await answerOf(answer), { ok: false }, "Escape cancels");
});

add_task(async function enter_submits_through_the_primary_answer() {
  let page = null;
  const { answer, doc } = await opened({
    field: { label: "Name", value: "Reading" },
    onOpen: p => (page = p),
  });
  const input = doc.getElementById("sval-dialog-input");
  Assert.equal(doc.activeElement, input, "the field has the focus");
  Assert.equal(
    input.selectionEnd - input.selectionStart,
    input.value.length,
    "with its text selected"
  );
  page.setButton("ok", { disabled: true });
  await doc.querySelector('[data-button="ok"]').updateComplete;
  EventUtils.synthesizeKey("KEY_Enter", {}, doc.defaultView);
  Assert.ok(gDialogBox.isOpen, "Enter does nothing while it is disabled");
  page.setButton("ok", { disabled: false });
  await doc.querySelector('[data-button="ok"]').updateComplete;
  EventUtils.sendString("!", doc.defaultView);
  EventUtils.synthesizeKey("KEY_Enter", {}, doc.defaultView);
  Assert.deepEqual(
    await answerOf(answer),
    { ok: true, value: "!" },
    "Enter answers the primary, with the field"
  );
});

add_task(async function the_default_focus_follows_the_dialog() {
  let { answer, doc } = await opened({});
  Assert.equal(
    doc.activeElement,
    doc.querySelector('[data-button="ok"]'),
    "the primary, in the default tone"
  );
  EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
  await answerOf(answer);

  ({ answer, doc } = await opened({ focus: "cancel" }));
  Assert.equal(
    doc.activeElement,
    doc.querySelector('[data-button="cancel"]'),
    "Cancel, where the opener asks"
  );
  EventUtils.synthesizeKey("KEY_Enter", {}, doc.defaultView);
  Assert.deepEqual(await answerOf(answer), { ok: false });
});

add_task(async function tab_keeps_the_focus_inside_the_dialog() {
  const { answer, doc } = await opened({
    closeButton: true,
    checkbox: { label: "Don't ask again" },
  });
  const modal = document.getElementById("window-modal-dialog");
  const inside = () => {
    const focused = Services.focus.focusedElement;
    return (
      focused?.ownerDocument === doc ||
      (focused && modal.contains(focused)) ||
      Services.focus.focusedWindow === doc.defaultView
    );
  };
  const seen = new Set();
  for (let i = 0; i < 8; i++) {
    EventUtils.synthesizeKey("KEY_Tab", {}, doc.defaultView);
    Assert.ok(inside(), `Tab ${i + 1} stays in the dialog`);
    seen.add(doc.activeElement);
  }
  for (let i = 0; i < 8; i++) {
    EventUtils.synthesizeKey("KEY_Tab", { shiftKey: true }, doc.defaultView);
    Assert.ok(inside(), `Shift+Tab ${i + 1} stays in the dialog`);
  }
  Assert.greaterOrEqual(seen.size, 3, "and goes round its controls");
  EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
  Assert.deepEqual(await answerOf(answer), { ok: false, checked: false });
});

add_task(async function the_accessibility_api_reads_the_question() {
  let { answer, doc, dialog } = await opened({
    body: "Its tabs stay where they are.",
  });
  let accessible = await accessibleOf(dialog);
  Assert.equal(accessible.role, Ci.nsIAccessibleRole.ROLE_DIALOG, "a dialog");
  Assert.equal(
    accessible.name,
    "Rename this Workspace?",
    "named for its title"
  );
  Assert.equal(
    accessible.description,
    "Its tabs stay where they are.",
    "described by its body"
  );
  EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
  await answerOf(answer);

  ({ answer, doc, dialog } = await opened({
    tone: "danger",
    body: "Its tabs close.",
    warning: "This can't be undone.",
  }));
  accessible = await accessibleOf(dialog);
  Assert.equal(
    accessible.attributes.getStringProperty("xml-roles"),
    "alertdialog",
    "an alert dialog in a danger tone"
  );
  Assert.equal(
    accessible.description,
    "Its tabs close. This can't be undone.",
    "described by its body and its warning"
  );
  EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
  await answerOf(answer);
});
