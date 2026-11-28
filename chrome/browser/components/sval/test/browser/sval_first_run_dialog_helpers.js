/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_first_run_helpers.js */

/**
 * What the first-run scenarios share. Each runs on a fresh profile whose first
 * window opens first run at startup, with the panel's own actions behind the
 * dialog: the path a step leads to is the model's for this machine's facts,
 * which are what the panel told the dialog. Each file loads this with
 * `loadSubScript` into its own scope, after sval_first_run_helpers.js.
 */

/* exported realFacts, pathOf, shareOf, shown, continueTo, untickImports, walkToEnd, continueUntil, finishFirstRun, declineDefaultBrowser, chooseFolderWith, MockFilePicker */

const { findAll } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImportSources.sys.mjs"
);

const MockFilePicker = SpecialPowers.MockFilePicker;

/**
 * What the panel told the dialog about this machine (`_runFirstRun`): whether
 * another browser is here to import from, and whether Sval is already the
 * default browser. Both are read as the panel reads them.
 *
 * @returns {Promise<{importAvailable: boolean, isDefaultBrowser: boolean}>}
 */
async function realFacts() {
  return {
    importAvailable: !!(await findAll()).length,
    isDefaultBrowser: SvalPanel._isDefaultBrowser(),
  };
}

/**
 * The steps the dialog shows on the path `answers` and `facts` make, from
 * the question to the last step answered, in the model's order.
 *
 * @param {object} answers
 * @param {object} facts
 * @returns {string[]}
 */
function pathOf(answers, facts) {
  const steps = [];
  let step = SvalFirstRunModel.next(STEPS.intro, answers, facts);
  while (step !== STEPS.welcome) {
    steps.push(step);
    step = SvalFirstRunModel.next(step, answers, facts);
  }
  return steps;
}

/**
 * @param {string} step
 * @param {object} answers
 * @param {object} facts
 * @returns {number} the percentage the progress bar should say on `step`.
 */
function shareOf(step, answers, facts) {
  return Math.round(SvalFirstRunModel.progress(step, answers, facts) * 100);
}

/**
 * @param {Document} doc The dialog's document.
 * @returns {number} the percentage the visible step's progress bar says.
 */
function shown(doc) {
  return Number(
    shownSection(doc)
      .querySelector('[role="progressbar"]')
      .getAttribute("aria-valuenow")
  );
}

/**
 * Unticks every browser the import step found, so Continue imports nothing
 * of this machine's own browsers.
 *
 * @param {Document} doc The dialog's document.
 */
async function untickImports(doc) {
  const section = shownSection(doc);
  await TestUtils.waitForCondition(
    () => !button(doc, "continue").disabled,
    "the import step has read the browsers"
  );
  for (const box of section.querySelectorAll(".sval-im-source sval-checkbox")) {
    if (box.checked) {
      box.click();
    }
  }
}

/**
 * Chooses No on "A few more things"' default browser card, where it shows,
 * and checks it is chosen, so no Continue there makes Sval this machine's
 * default browser.
 *
 * @param {Document} doc The dialog's document.
 */
function declineDefaultBrowser(doc) {
  const no = shownSection(doc).querySelector(
    'input[data-setting="defaultBrowser"][value="false"]'
  );
  if (!no) {
    return;
  }
  no.click();
  Assert.ok(no.checked, "No is chosen for the default browser");
}

/**
 * Presses Continue on the visible step and waits for `step`. Continue never
 * makes Sval this machine's default browser or imports this machine's own
 * browsers: No is chosen for the default browser and every browser
 * unticked first.
 *
 * @param {Document} doc The dialog's document.
 * @param {string} step The step expected next.
 */
async function continueTo(doc, step) {
  const from = shownStep(doc);
  if (from === STEPS.more) {
    declineDefaultBrowser(doc);
  }
  if (from === STEPS.import) {
    await untickImports(doc);
  }
  await press(doc, "continue", step);
}

/**
 * Continues from the visible step, whatever this machine's facts make the
 * path, until `step` shows, with the answers `continueTo` makes safe.
 *
 * @param {Document} doc The dialog's document.
 * @param {string} step The step to stop on.
 */
async function continueUntil(doc, step) {
  while (shownStep(doc) !== step) {
    const from = shownStep(doc);
    if (from === STEPS.more) {
      declineDefaultBrowser(doc);
    }
    if (from === STEPS.import) {
      await untickImports(doc);
    }
    await settled(doc);
    button(doc, from === STEPS.intro ? "skip" : "continue").click();
    await TestUtils.waitForCondition(
      () => shownStep(doc) !== from,
      `Continue from ${from}`
    );
    await settled(doc);
  }
}

/**
 * Continues from the visible step through `path` to its last step, calling
 * `atStep` on each.
 *
 * @param {Document} doc The dialog's document.
 * @param {string[]} path The steps still to come.
 * @param {Function} [atStep] Called with each step once it shows.
 */
async function walkToEnd(doc, path, atStep = async () => {}) {
  for (const step of path) {
    await continueTo(doc, step);
    await atStep(step);
  }
}

/**
 * Presses Continue on the last step, then Start browsing on the welcome,
 * and waits for the dialog to go, with No chosen first for the default
 * browser, so first run never makes Sval this machine's default browser.
 *
 * @param {Document} doc The dialog's document.
 */
async function finishFirstRun(doc) {
  await endWith(doc, "continue");
}

/**
 * Makes the native folder picker answer with `path` once, as a person
 * choosing that folder does.
 *
 * @param {string} path
 */
function chooseFolderWith(path) {
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  MockFilePicker.setFiles([file]);
  MockFilePicker.returnValue = MockFilePicker.returnOK;
}
