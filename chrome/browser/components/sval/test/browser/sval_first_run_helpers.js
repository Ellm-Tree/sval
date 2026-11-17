/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * What the first-run files share: the steps of the real dialog a fresh
 * profile's first window opens at startup, and how a task presses through
 * them. Each file loads this with `loadSubScript` into its own scope.
 */

/* exported SvalEngine, SvalFirstRun, SvalFirstRunModel, SvalIdentity, SvalKagi, SvalLocalSettings, SvalPairing, SvalSettingsSync, SvalSharedFolder, SvalPanelModel, STEPS, SYNC_DOCUMENT, FIRST_RUN_PREF, LEVEL_PREF, shownSection, shownStep, button, press, settled, pick, typeCode, toQuestion, choosePath, joinUpToWaiting, submitCode, CODE, workspacesInEngine, firstRunShown, endWith, startBrowsing, closeTheBackup, keepFirstRunPrefs */

const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { SvalFirstRun } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFirstRun.sys.mjs"
);
const { SvalFirstRunModel } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFirstRunModel.sys.mjs"
);
const { SvalIdentity } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalIdentity.sys.mjs"
);
const { SvalKagi } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalKagi.sys.mjs"
);
const { SvalLocalSettings } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLocalSettings.sys.mjs"
);
const { SvalPairing } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPairing.sys.mjs"
);
const { SvalSettingsSync } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSettingsSync.sys.mjs"
);
const { SvalSharedFolder } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
);
const SvalPanelModel = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);
const SvalTree = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTree.sys.mjs"
);

const { STEPS } = SvalFirstRunModel;
const { SYNC_DOCUMENT } = SvalTree;
const FIRST_RUN_PREF = "browser.sval.firstRun.enabled";
const LEVEL_PREF = "browser.sval.adblock.level";

/**
 * @param {Document} doc The dialog's document.
 * @returns {Element|null} the one visible step.
 */
function shownSection(doc) {
  const shown = [...doc.querySelectorAll("main > section")].filter(
    section => !section.hidden
  );
  return shown.length === 1 ? shown[0] : null;
}

/**
 * @param {Document} doc The dialog's document.
 * @returns {string|null} the visible step's name.
 */
function shownStep(doc) {
  return doc?.querySelector?.("main") ? shownSection(doc)?.dataset.step : null;
}

/**
 * @param {Document} doc The dialog's document.
 * @param {string} which `continue`, `back` or `later`.
 * @returns {Element} that button on the visible step.
 */
function button(doc, which) {
  return shownSection(doc).querySelector(`.sval-fr-${which}`);
}

/**
 * Presses a button on the visible step and waits for `step` to show, and for
 * the task after it, in which the page takes the next press.
 *
 * @param {Document} doc The dialog's document.
 * @param {string} which `continue` or `back`.
 * @param {string} step The step expected next.
 */
async function press(doc, which, step) {
  const from = shownStep(doc);
  // However the step was reached, it takes the press only once its own
  // task has passed (`settled`).
  await settled(doc);
  button(doc, which).click();
  await TestUtils.waitForCondition(
    () => shownStep(doc) === step,
    `${which} from ${from} shows ${step}`,
    100,
    100
  );
  await settled(doc);
}

/**
 * Waits for the task after a step change, after which the step just shown
 * takes Continue: the page ignores a Continue in the same task.
 *
 * @param {Document} doc The dialog's document.
 */
async function settled(doc) {
  await new Promise(resolve => doc.defaultView.setTimeout(resolve, 0));
}

/**
 * @param {Document} doc The dialog's document.
 * @param {string} value The value of a radio on the visible step.
 */
function pick(doc, value) {
  shownSection(doc)
    .querySelector(`input[type="radio"][value="${value}"]`)
    .click();
}

/**
 * @param {Document} doc The dialog's document.
 * @param {string} text What is typed into the code field.
 */
function typeCode(doc, text) {
  const field = shownSection(doc).querySelector(".sval-fr-code");
  field.value = text;
  field.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
}

/**
 * Leaves the introduction for the question by its Skip.
 *
 * @param {Document} doc The dialog's document.
 */
async function toQuestion(doc) {
  await press(doc, "skip", STEPS.question);
}

/**
 * Answers the question with `path` and continues to the path's first step.
 *
 * @param {Document} doc The dialog's document.
 * @param {string} path `new` or `join`.
 * @param {string} step The step expected next.
 */
async function choosePath(doc, path, step) {
  if (shownStep(doc) === STEPS.intro) {
    await toQuestion(doc);
  }
  pick(doc, path);
  await press(doc, "continue", step);
}

/**
 * Takes the join path from the introduction until the code step waits for
 * the other device with `code`.
 *
 * @param {Document} doc The dialog's document.
 * @param {string} code What is typed as the other device's code.
 * @param {Function} [atStep] Called with the folder step, once its folder is
 *   reached, and with the code step, for a file's own checks there.
 */
async function joinUpToWaiting(doc, code, atStep = () => {}) {
  await choosePath(doc, "join", STEPS.joinFolder);
  shownSection(doc).querySelector(".sval-fr-choose-folder").click();
  await TestUtils.waitForCondition(
    () => !button(doc, "continue").disabled,
    "the shared folder is reached",
    100,
    200
  );
  await atStep(STEPS.joinFolder);
  await press(doc, "continue", STEPS.joinCode);
  await atStep(STEPS.joinCode);
  typeCode(doc, code);
  await submitCode(doc);
}

/**
 * Presses Continue on the code step, which stays shown while it waits for
 * the other device, and waits for the join to start.
 *
 * @param {Document} doc The dialog's document.
 */
async function submitCode(doc) {
  const section = shownSection(doc);
  // A look that found no match shows the code step again, which takes
  // Continue only once that showing's own task has passed (`settled`).
  await settled(doc);
  button(doc, "continue").click();
  await TestUtils.waitForCondition(
    () => section.dataset.join && section.dataset.join !== "idle",
    "the code step waits for the other device",
    100,
    100
  );
  await settled(doc);
}

const CODE = "K7Q4-8MTZ-3RJW";

/**
 * @param {object} [panel] A window's panel.
 * @returns {Promise<string[]>} the workspaces in the panel's engine.
 */
async function workspacesInEngine(panel = SvalPanel) {
  return SvalTree.workspaceIds((await panel.engine.tree()).nodes);
}

/**
 * Waits for first run's dialog in `win` and for its introduction.
 *
 * @param {Window} [win] The window it opens in.
 * @returns {Promise<Document>} the dialog's document.
 */
async function firstRunShown(win = window) {
  await TestUtils.waitForCondition(
    () => win.gDialogBox.isOpen,
    "first run opens"
  );
  await dialogShown(win.gDialogBox.dialog, "the first-run dialog's load");
  let doc;
  await TestUtils.waitForCondition(() => {
    doc = win.gDialogBox.dialog._frame.contentDocument;
    return shownStep(doc) === STEPS.intro;
  }, "the introduction is drawn");
  // The dialog opened at startup, and the harness then focuses the tab
  // before the file runs (`Tester.nextTest`'s `waitForFocus` in
  // testing/mochitest/browser-test.js), where a key would reach the
  // window's dialog box and close it. The dialog is given focus back as its
  // own opening gives it (`SubDialog.focus`).
  win.gDialogBox.dialog.focus(true);
  return doc;
}

/**
 * Presses Start browsing on the welcome, once the import under it has
 * ended, and waits for the dialog to go.
 *
 * @param {Document} doc The dialog's document.
 * @param {Window} [win] The window it is shown in.
 */
async function startBrowsing(doc, win = window) {
  await TestUtils.waitForCondition(
    () => shownStep(doc) === STEPS.welcome,
    "the welcome shows"
  );
  const start = shownSection(doc).querySelector(".sval-fr-start");
  await TestUtils.waitForCondition(
    () => !start.disabled,
    "Start browsing can be pressed"
  );
  await settled(doc);
  start.click();
  // Another dialog can take the window's dialog box as first run's goes,
  // as the key's backup does once a new device has made its key.
  await TestUtils.waitForCondition(
    () => win.gDialogBox.dialog?._frame?.contentDocument !== doc,
    "Start browsing ends first run"
  );
}

/**
 * Presses a button that ends the questions, `continue` on the last step or
 * `later`, and then Start browsing on the welcome when one shows, and waits
 * for the dialog to go.
 *
 * @param {Document} doc The dialog's document.
 * @param {string} which `continue` or `later`.
 * @param {Window} [win] The window it is shown in.
 */
async function endWith(doc, which, win = window) {
  await settled(doc);
  // Yes there asks the system to make Sval the default browser, which on a
  // developer's machine changes their own default or shows the system's
  // prompt on their screen. browser_sval_first_run_default_browser.js is
  // the one file that answers Yes.
  const no = shownSection(doc).querySelector(
    'input[data-setting="defaultBrowser"][value="false"]'
  );
  if (which === "continue" && no) {
    no.click();
    Assert.ok(no.checked, "No is chosen for the default browser");
  }
  button(doc, which).click();
  await TestUtils.waitForCondition(
    () =>
      win.gDialogBox.dialog?._frame?.contentDocument !== doc ||
      shownStep(doc) === STEPS.welcome,
    `${which} ends the questions`
  );
  if (win.gDialogBox.dialog?._frame?.contentDocument === doc) {
    await startBrowsing(doc, win);
  }
}

/**
 * Closes the sync key's backup, which Sval offers once a new device has made
 * its key (`SvalPanel._offerBackupLater`) and which holds the window until it
 * is answered, as its Done does.
 *
 * @param {Window} [win] The window it is shown in.
 */
async function closeTheBackup(win = window) {
  let dialog;
  let done;
  await TestUtils.waitForCondition(() => {
    dialog = win.gDialogBox.dialog;
    done = dialog?._frame?.contentDocument?.querySelector(".sval-backup-done");
    return done && !dialog._isClosing;
  }, "the key's backup is offered");
  await dialogShown(dialog, "the backup's load");
  await TestUtils.waitForCondition(() => !done.disabled, "Done can be pressed");
  done.click();
  await TestUtils.waitForCondition(
    () => win.gDialogBox.dialog !== dialog,
    "the backup closes"
  );
}

/**
 * Puts back, when the file ends, the prefs first run's steps write: the
 * ad-blocking level, agent access and sites' tools, the password manager,
 * the panel's side (`placePanel` moves the sidebar to match) and the default
 * browser check. Mozilla's end-of-file check fails a file on any of them
 * left changed (`checkPreferencesAfterTest`).
 */
function keepFirstRunPrefs() {
  keepPrefs(
    LEVEL_PREF,
    "browser.sval.agents.enabled",
    "browser.sval.agents.pageTools.enabled",
    "browser.sval.passwordManager",
    "browser.shell.checkDefaultBrowser",
    "sidebar.position_start",
    "sidebar.revamp"
  );
}
