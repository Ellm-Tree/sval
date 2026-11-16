/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A first run whose code waits for a device that never offers it (first-run
 * spec §3.2). Waiting is not a failure: the code step keeps looking every
 * five seconds, and after thirty says what the other device must also use,
 * naming the folder. Cancel stands in Continue's place while it waits; it
 * stops looking and hands the code back to be changed.
 *
 * This is the one test that waits out the code step's thirty seconds.
 */
/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_first_run_helpers.js */
/* import-globals-from sval_first_run_dialog_helpers.js */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_first_run_helpers.js",
  this
);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_first_run_dialog_helpers.js",
  this
);

/**
 * @param {Document} doc The dialog's document.
 * @returns {string} what the visible step's status line says, by its
 *   `data-said`.
 */
function saidOf(doc) {
  return shownSection(doc).querySelector(".sval-fr-status").dataset.said ?? "";
}

/**
 * @param {Document} doc The dialog's document.
 * @returns {string} what the code step's join line says, by its `data-said`.
 */
function joinSaidOf(doc) {
  return shownSection(doc).querySelector(".sval-fr-join").dataset.said ?? "";
}

/**
 * A shared folder holding `sval/`, as a device that shares writes it.
 *
 * @param {string} label
 * @returns {Promise<string>}
 */
async function sharedFolder(label) {
  const folder = await makeTempDir(`sval-fr-${label}`);
  await IOUtils.makeDirectory(PathUtils.join(folder, "sval"));
  return folder;
}

add_task(
  async function waiting_names_the_folder_and_cancel_gives_the_code_back() {
    keepFirstRunPrefs();
    MockFilePicker.init(window.browsingContext);
    registerCleanupFunction(() => MockFilePicker.cleanup());
    const folder = await sharedFolder("join-waiting");

    const doc = await firstRunShown();
    await choosePath(doc, "join", STEPS.joinFolder);
    Assert.ok(
      button(doc, "continue").disabled,
      "a joining device needs a folder"
    );
    chooseFolderWith(folder);
    shownSection(doc).querySelector(".sval-fr-choose-folder").click();
    await TestUtils.waitForCondition(
      () => !button(doc, "continue").disabled,
      "a reachable folder allows Continue"
    );
    await settled(doc);
    await press(doc, "continue", STEPS.joinCode);
    typeCode(doc, CODE.toLowerCase());
    await submitCode(doc);

    const section = shownSection(doc);
    Assert.equal(joinSaidOf(doc), "waiting", "it waits");
    const code = section.querySelector(".sval-fr-code");
    Assert.ok(code.disabled, "the code is kept as typed while it is tried");
    Assert.ok(button(doc, "continue").disabled, "Continue waits for pairing");
    const note = section.querySelector(".sval-fr-note");
    Assert.equal(note.textContent, "", "no note at first");
    // The note's timer (`FIRST_RUN_NOTE_AFTER_MS` in first-run.js) runs from
    // the submit, and showing the note is one redraw after it.
    await TestUtils.waitForCondition(
      () => note.textContent.includes(folder),
      "the note shows at thirty seconds, naming the folder",
      1000,
      35
    );
    Assert.equal(joinSaidOf(doc), "waiting", "still waiting, never failing");

    const cancel = button(doc, "cancel");
    Assert.ok(!cancel.hidden && !cancel.disabled, "Cancel shows while waiting");
    Assert.ok(button(doc, "continue").hidden, "in Continue's place");
    cancel.focus();
    cancel.click();
    Assert.equal(shownStep(doc), STEPS.joinCode, "the code step stays");
    Assert.equal(section.dataset.join, "idle", "and stops waiting");
    Assert.ok(!code.disabled, "the code can be changed");
    Assert.equal(code.value, CODE, "and is kept, grouped as it was typed");
    Assert.equal(doc.activeElement, code, "with focus in it");
    Assert.ok(cancel.hidden, "Cancel goes");
    Assert.ok(
      !button(doc, "continue").hidden && !button(doc, "continue").disabled,
      "and Continue comes back"
    );
    Assert.ok(!button(doc, "back").disabled, "beside Back");

    await endWith(doc, "later");
    await within(SvalPanel.started, 40_000, "the panel's startup");
    Assert.equal(
      (await SvalIdentity.syncKey()).state,
      SvalIdentity.SYNC_KEY_STATES.none,
      "no key was adopted"
    );
  }
);
