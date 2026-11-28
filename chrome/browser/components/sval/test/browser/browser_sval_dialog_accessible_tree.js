/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * With accessibility on, as it is for anyone running a screen reader, a
 * dialog that has closed leaves nothing in the window's accessible tree.
 * Closing a dialog can shut its frame's accessible down before its document,
 * and the window's document then went on listing that document after it had
 * gone (patches/a11y-hanging-child-document.patch). A window listing one that
 * had not finished loading stayed busy, and its refresh driver ticked on
 * every frame while accessibility stayed on.
 */

const { openSvalDialog } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalDialog.sys.mjs"
);

/**
 * Opens a dialog in this window and answers it once it has drawn, as soon as
 * a user or an agent can.
 */
async function answerADialog() {
  const answer = openSvalDialog(window, { title: "Probe", primary: "OK" });
  await TestUtils.waitForCondition(() => gDialogBox.isOpen, "dialog opens");
  let button;
  await TestUtils.waitForCondition(
    () =>
      (button = gDialogBox.dialog._frame.contentDocument?.querySelector(
        'sval-dialog sval-button[type="primary"]'
      )),
    "the dialog has drawn its buttons"
  );
  button.click();
  Assert.ok((await within(answer, 10_000, "the dialog's answer")).ok);
}

add_task(async function closed_dialogs_leave_no_document_in_the_tree() {
  let accService = Cc["@mozilla.org/accessibilityService;1"].getService(
    Ci.nsIAccessibilityService
  );
  registerCleanupFunction(() => {
    accService = null;
    Cu.forceGC();
  });
  const tree = (await accessibleOf(document)).QueryInterface(
    Ci.nsIAccessibleDocument
  );
  const before = tree.childDocumentCount;
  // Not every close shuts the frame's accessible down before its document,
  // so the task closes many.
  for (let i = 0; i < 20; i++) {
    await answerADialog();
    await TestUtils.waitForCondition(
      () => tree.childDocumentCount === before,
      `the window lists no document of dialog ${i}`
    );
  }
  // The window's document drops its busy state on a later refresh than the
  // one that removes the dialog's document, and a hanging child keeps it
  // busy until accessibility shuts down.
  await TestUtils.waitForCondition(() => {
    const state = {};
    tree.QueryInterface(Ci.nsIAccessible).getState(state, {});
    return !(state.value & Ci.nsIAccessibleStates.STATE_BUSY);
  }, "the window is not busy");
  ok(accService, "accessibility was on");
});
