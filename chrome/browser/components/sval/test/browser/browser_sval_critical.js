/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_panel_helpers.js */
/* import-globals-from sval_feedback_helpers.js */

/**
 * The critical dialog (messages spec §4): this device's own copy cannot be
 * saved or opened. It waits out a minute of failed saves, closes when a pass
 * succeeds, hands itself to the footer when dismissed, and offers the
 * feedback form in its place.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_panel_helpers.js",
  this
);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_feedback_helpers.js",
  this
);

const { SvalTestDeny } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestDeny.sys.mjs"
);
const { SvalSecretStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSecretStore.sys.mjs"
);
const { SvalCritical } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalCritical.sys.mjs"
);

const { LOCAL_CAUSE_TEXT } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);
const { REPORT_SENT_LABEL, SEND_REPORT_LABEL } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFeedbackForm.sys.mjs"
);

/**
 * Asserts that `win` is in the critical state of `kind`, and that `doc`, its
 * dialog, shows that state's title.
 *
 * @param {Document} doc
 * @param {Window} win
 * @param {"save"|"open"} kind
 * @param {string} what
 */
function assertCritical(doc, win, kind, what) {
  const state = SvalCritical.current(win);
  Assert.equal(state?.kind, kind, what);
  Assert.equal(
    doc.getElementById("sval-dialog-title").textContent,
    state.title,
    "under the state's title"
  );
}

/**
 * Asserts that `doc`'s body says the cause `cause`.
 *
 * @param {Document} doc
 * @param {Window} win
 * @param {string} cause From `SvalPanelModel.localCause`.
 */
function assertCause(doc, win, cause) {
  Assert.equal(SvalCritical.current(win).cause, cause, "with the cause");
  Assert.equal(
    doc.getElementById("sval-dialog-body").textContent,
    LOCAL_CAUSE_TEXT[cause],
    "said in the body"
  );
}

/**
 * The window's own panel on a fresh workspace, whose passes save this
 * device's copy until `fail()` takes the write of the copy's directory away
 * (`SvalTestDeny`) and runs a pass, which fails. When the task ends the
 * directory is given back and a pass saves, which ends any save failure as a
 * recovery does, and the dialog is closed.
 *
 * @returns {Promise<object>} `{ fail, succeed }`.
 */
async function panelWithFailingSaves() {
  const { engine, ids } = await withFreshPanel();
  const saved = await SvalPanel.syncNow();
  Assert.ok(saved?.wrote, "a first pass saves the fixture");
  const dir = PathUtils.parent(
    PathUtils.join(engine.root, ...saved.wrote.split("/"))
  );
  const succeed = () => SvalTestDeny.allow(dir);
  atTaskEnd(async () => {
    await succeed();
    Assert.ok(await SvalPanel.syncNow(), "a pass saves again");
    await closeLeftoverDialog();
  });
  return {
    async fail() {
      // A change, so the pass has a copy to write.
      await engine.mutate({
        kind: "rename",
        id: ids.workspace,
        name: `Work ${crypto.randomUUID()}`,
        now: Date.now(),
      });
      await SvalTestDeny.write(dir);
      Assert.equal(await SvalPanel.syncNow(), null, "the pass fails to save");
    },
    succeed,
  };
}

/**
 * Shows the dialog as `SvalPanel._saveFailed` does once saves have failed
 * for a minute (`SvalPanelModel.saveFailureDue`, whose minute
 * `test_sval_panel_model.js` checks), for a task about the dialog itself.
 * Its cause is the one a directory that refuses a new file gives.
 *
 * @param {Window} [win]
 */
function sayTheSaveFailed(win = window) {
  SvalCritical.show(win, {
    kind: "save",
    cause: "denied",
    retry: () => win.SvalPanel.syncNow(),
  });
}

/**
 * Waits for the critical dialog to draw in `win`.
 *
 * @param {Window} [win]
 * @returns {Promise<Document>}
 */
async function criticalDialog(win = window) {
  const box = win.gDialogBox;
  await TestUtils.waitForCondition(() => box.isOpen, "a dialog opens");
  await dialogShown(box.dialog, "the dialog's load");
  let doc;
  await TestUtils.waitForCondition(() => {
    doc = box.dialog?._frame.contentDocument;
    return doc?.querySelector(
      '.sval-dialog[data-tone="critical"] .sval-dialog-actions button.primary'
    );
  }, "the critical dialog has drawn its buttons");
  return doc;
}

/** Waits for the window's dialog to close. */
async function dialogClosed() {
  await TestUtils.waitForCondition(
    () => !gDialogBox.isOpen,
    "the dialog closes"
  );
}

/**
 * The dialog's buttons by id.
 *
 * @param {Document} doc
 * @returns {object}
 */
function buttonsOf(doc) {
  return Object.fromEntries(
    [...doc.querySelectorAll(".sval-dialog-actions button")].map(button => [
      button.dataset.button,
      button,
    ])
  );
}

/**
 * Spec §4: saves that fail say nothing at first. Once the minute is up
 * (`saveFailureDue`) the dialog says so, with the cause the error's name
 * gives.
 */
add_task(async function a_save_failure_says_nothing_at_first() {
  const panel = await panelWithFailingSaves();
  await panel.fail();
  Assert.notEqual(SvalPanel._saveFailingSince, null, "the save failed");
  await panel.fail();
  Assert.ok(!gDialogBox.isOpen, "no dialog yet");
  Assert.equal(SvalCritical.current(window), null, "and no critical state");

  sayTheSaveFailed();
  const doc = await criticalDialog();
  assertCritical(doc, window, "save", "the dialog says saves are failing");
  assertCause(doc, window, "denied");
  const warning = doc.getElementById("sval-dialog-warning");
  Assert.ok(!warning.hidden, "and what the user loses");
  Assert.equal(
    document.getElementById("window-modal-dialog").dataset.svalTone,
    "critical",
    "over the critical scrim"
  );
  const buttons = buttonsOf(doc);
  Assert.ok(
    BrowserTestUtils.isVisible(buttons.ok) && buttons.ok.textContent,
    "Try Again is offered"
  );
  Assert.ok(
    BrowserTestUtils.isVisible(doc.querySelector(".sval-dialog-close")),
    "with a ✕"
  );

  await panel.fail();
  Assert.equal(
    gDialogBox.dialog?._frame.contentDocument,
    doc,
    "a later failure keeps the one dialog"
  );
});

/** Spec §4: a pass that succeeds closes the dialog and ends the state. */
add_task(async function a_recovering_pass_closes_it() {
  const panel = await panelWithFailingSaves();
  await panel.fail();
  sayTheSaveFailed();
  await criticalDialog();

  await panel.succeed();
  Assert.ok(await SvalPanel.syncNow(), "a pass saves");
  await dialogClosed();
  Assert.equal(SvalCritical.current(window), null, "the state is over");
  await TestUtils.waitForCondition(
    () =>
      !document
        .getElementById("window-modal-dialog")
        .hasAttribute("data-sval-tone"),
    "the window's scrim is its own again"
  );
  // On a device that shares nowhere, a critical state is the one thing the
  // sync row shows (`SvalPanelModel.syncIndicator`), so the row hides once it
  // ends and keeps the attributes it last drew.
  const { syncRow, indicator } = SvalPanel._els;
  Assert.ok(
    syncRow.hidden || indicator.dataset.severity !== "critical",
    "and the footer no longer shows it"
  );

  await panel.fail();
  Assert.ok(!gDialogBox.isOpen, "a new failure waits its own minute");
});

/**
 * Spec §3 and §4: Escape hands the state to the footer, whose indicator
 * shows the dialog's title and brings the dialog back.
 */
add_task(async function dismissing_hands_it_to_the_footer() {
  const panel = await panelWithFailingSaves();
  await panel.fail();
  sayTheSaveFailed();
  const doc = await criticalDialog();

  EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
  await dialogClosed();
  const { indicator, syncLabel } = SvalPanel._els;
  Assert.equal(indicator.dataset.severity, "critical", "the footer has it");
  Assert.equal(
    syncLabel.textContent,
    SvalCritical.current(window).title,
    "under the dialog's title"
  );
  Assert.equal(indicator.dataset.command, "reopenCritical", "to reopen");

  await panel.fail();
  Assert.ok(!gDialogBox.isOpen, "a later failure does not reopen it");

  indicator.click();
  const again = await criticalDialog();
  assertCritical(again, window, "save", "clicking the indicator reopens it");
});

/**
 * Feedback spec §2: Send Report… closes the dialog and opens the feedback
 * form in its place, with the dialog's title as its context. Closing the
 * form leaves the state in the footer, and the dialog it reopens offers the
 * report as before.
 */
add_task(async function send_report_opens_the_form_in_its_place() {
  await appDataInTemp();
  atTaskEnd(() => discardFeedbackDraft());
  const panel = await panelWithFailingSaves();
  await panel.fail();
  sayTheSaveFailed();
  const doc = await criticalDialog();
  const { extra } = buttonsOf(doc);
  Assert.equal(
    extra.textContent,
    SEND_REPORT_LABEL,
    "the button opens the form"
  );

  extra.click();
  await dialogClosed();
  const form = await feedbackShown();
  Assert.ok(
    formParts(form).context.textContent.startsWith(
      SvalCritical.current(window).title
    ),
    "the form has the dialog's title as its context"
  );

  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  Assert.ok(form.hidden, "Esc closes the form");
  const { indicator, syncLabel } = SvalPanel._els;
  Assert.equal(indicator.dataset.severity, "critical", "the footer has it");
  Assert.equal(
    syncLabel.textContent,
    SvalCritical.current(window).title,
    "under the dialog's title"
  );

  indicator.click();
  const again = await criticalDialog();
  const reopened = buttonsOf(again).extra;
  Assert.equal(reopened.textContent, SEND_REPORT_LABEL, "a form closed unsent");
  Assert.ok(!reopened.disabled, "leaves the button as it was");
});

/**
 * Feedback spec §2: once the form it opened has sent, the dialog's button
 * says so and is done.
 */
add_task(async function a_sent_report_says_so_on_the_dialog() {
  await appDataInTemp();
  await feedbackServer();
  atTaskEnd(() => discardFeedbackDraft());
  const panel = await panelWithFailingSaves();
  await panel.fail();
  sayTheSaveFailed();
  const doc = await criticalDialog();
  buttonsOf(doc).extra.click();
  await dialogClosed();
  const form = await feedbackShown();
  const parts = formParts(form);
  parts.message.focus();
  EventUtils.sendString("My changes stopped saving.", window);
  parts.send.click();
  await TestUtils.waitForCondition(
    () => form.dataset.state === "sent",
    "the report is sent"
  );
  parts.close.click();

  SvalPanel._els.indicator.click();
  const again = await criticalDialog();
  const { extra } = buttonsOf(again);
  Assert.equal(
    extra.textContent,
    REPORT_SENT_LABEL,
    "the button says it's sent"
  );
  Assert.ok(extra.disabled, "and is done");
});

/**
 * Spec §4: a pass whose shared step throws saved this device's copy before
 * it, so it is no failed save. The step throws
 * when it cannot save what it merged from another device of this key into
 * this device's copy, as a copy's directory that refuses a new file makes
 * it.
 */
add_task(async function a_failed_shared_step_is_not_a_failed_save() {
  const { engine } = await withFreshPanel();
  const saved = await SvalPanel.syncNow();
  Assert.ok(saved?.wrote, "a pass saves this device's copy");
  const dir = PathUtils.parent(
    PathUtils.join(engine.root, ...saved.wrote.split("/"))
  );
  const shared = await makeTempDir("sval-critical-shared");
  await shareFolder(shared);
  Assert.equal(
    await SvalPanel.syncWithFolder(),
    "reached",
    "the folder answers"
  );

  // Another device of this key publishes a change for this one to merge.
  const peer = new SvalEngine({
    root: await makeTempDir("sval-critical-peer"),
    sharedRoot: shared,
    keyBytes: await SvalSecretStore.read("sync key"),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  atTaskEnd(() => stopEngine(peer));
  await peer.sync(SvalTree.SYNC_DOCUMENT, Date.now(), { shared: "wait" });
  await peer.mutate({
    kind: "addWorkspace",
    name: "Theirs",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  await peer.sync(SvalTree.SYNC_DOCUMENT, Date.now(), { shared: "wait" });

  // Only the shared step may have something to save. A change of this
  // device's own still unsaved would make the pass's profile step fail to
  // save it, which is a failed save, so each is saved first.
  await within(SvalPanel.observer.settled(), 10_000, "the window settling");
  const profileOnly = () =>
    SvalPanel.engine.sync(SvalTree.SYNC_DOCUMENT, undefined, {
      shared: "skip",
    });
  await profileOnly();
  Assert.equal(
    (await profileOnly())?.wrote ?? null,
    null,
    "the profile holds every change of this device's"
  );

  await SvalTestDeny.write(dir);
  atTaskEnd(async () => {
    await SvalTestDeny.allow(dir);
    await within(SvalPanel.syncNow(), 30_000, "a pass that saves again");
  });
  Assert.equal(
    await SvalPanel.syncWithFolder(),
    null,
    "the pass failed in its shared step"
  );
  Assert.equal(SvalPanel._saveFailingSince, null, "no save failed");
  Assert.equal(SvalCritical.current(window), null, "and nothing is critical");
  Assert.ok(!gDialogBox.isOpen, "so no dialog opens");
});

/**
 * Spec §4: the window that ran a failing pass may not be the one the user
 * is in. Every window on the engine hears the failure, and every window
 * hears the pass that saves again.
 */
add_task(async function every_window_hears_a_failed_save() {
  const panel = await panelWithFailingSaves();
  const other = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    20_000,
    "the other window"
  );
  await within(other.SvalPanel.started, 10_000, "the other window's panel");
  // A window drawn from the engine's tree runs a pass once drawn, which
  // would save before the task's failure.
  await within(
    other.SvalPanel._passAfterDrawing ?? Promise.resolve(),
    10_000,
    "the other window's first pass"
  );
  expectWorkspaceTabs(other);
  atTaskEnd(() =>
    within(BrowserTestUtils.closeWindow(other), 20_000, "the window closing")
  );

  await panel.fail();
  Assert.notEqual(
    SvalPanel._saveFailingSince,
    null,
    "this window's save failed"
  );
  // Each window measures how long saving has failed on its own clock
  // (`SvalPanel._listenToEngine`).
  Assert.notEqual(
    other.SvalPanel._saveFailingSince,
    null,
    "the other window heard the failure"
  );

  await panel.succeed();
  Assert.ok(await SvalPanel.syncNow(), "a pass saves");
  Assert.equal(
    other.SvalPanel._saveFailingSince,
    null,
    "and the other window heard that too"
  );
});

/**
 * Spec §4: a startup that throws opens the second dialog, which offers a
 * restart. The test does not press it.
 */
add_task(async function startup_failure_offers_restart() {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  // A window's startup reads this device's identity before anything else
  // (`SvalPanel._start`), and an identity file that exists and cannot be
  // read is refused (`SvalIdentity._readIdentity`). The values are read
  // again once forgotten, as a launch reads them.
  const identity = PathUtils.join(PathUtils.profileDir, "sval-identity.json");
  Assert.ok(await IOUtils.exists(identity), "this device has an identity");
  SvalIdentity.forgetCachedValues();
  await SvalTestDeny.read(identity);
  const allow = async () => {
    await SvalTestDeny.allow(identity);
    SvalIdentity.forgetCachedValues();
  };
  atTaskEnd(allow);
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    20_000,
    "a window opening"
  );
  atTaskEnd(async () => {
    SvalCritical.clear(win);
    await within(BrowserTestUtils.closeWindow(win), 20_000, "it closing");
  });
  await within(win.SvalPanel.started, 10_000, "the window's startup");
  await allow();

  const doc = await criticalDialog(win);
  assertCritical(doc, win, "open", "it says the workspaces could not open");
  Assert.equal(
    doc.getElementById("sval-dialog-body").hidden,
    !SvalCritical.current(win).cause,
    "with the cause the error names, if any"
  );
  Assert.ok(
    doc.getElementById("sval-dialog-warning").hidden,
    "and it warns of nothing else"
  );
  const { ok, extra } = buttonsOf(doc);
  const restart = ok.textContent;
  Assert.ok(BrowserTestUtils.isVisible(ok) && restart, "Restart is offered");
  Assert.equal(extra.textContent, SEND_REPORT_LABEL, "beside the report");
  Assert.equal(
    win.SvalPanel._els.indicator.dataset.severity,
    "critical",
    "and the footer shows it"
  );

  SvalCritical.show(win, { kind: "save", cause: null });
  assertCritical(
    doc,
    win,
    "save",
    "a state that changes kind retitles the open dialog"
  );
  Assert.ok(
    ok.textContent && ok.textContent != restart,
    "and relabels its button"
  );
});
