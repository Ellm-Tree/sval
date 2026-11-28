/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_first_run_helpers.js */

/**
 * What the first-run scenario files share. Each scenario runs in a browser of
 * its own, on a fresh profile whose first window opens first run at startup,
 * so the dialog a file answers is the one a first launch shows. A file loads
 * sval_first_run_helpers.js, then this, with `loadSubScript`.
 */

/* exported advance, walkTo, finishFirstRun, keepFirstRunChoices, signInToKagi, signOutOfKagi, kagiNotice, firstRunSearch */

/**
 * Presses Continue on the step shown, as `press` does, for a step whose next
 * one this machine decides: the import step shows only where another browser
 * is installed, and the default browser card only where Sval is not the
 * default. On the welcome it presses Start browsing. Waits for the next
 * step, or for the dialog to close.
 *
 * Two answers are made safe first, whatever the file asked for: the import
 * step imports nothing, so no task reads this machine's own browsers, and the
 * default browser card answers No, so no task changes which browser this
 * machine opens links in.
 *
 * @param {Document} doc The dialog's document.
 */
async function advance(doc) {
  const from = shownStep(doc);
  await settled(doc);
  const section = shownSection(doc);
  if (from === STEPS.import) {
    for (const box of section.querySelectorAll("sval-checkbox")) {
      if (box.checked) {
        box.click();
      }
    }
  }
  const no = section.querySelector(
    'input[data-setting="defaultBrowser"][value="false"]'
  );
  if (no) {
    no.click();
    Assert.ok(no.checked, "No is chosen for the default browser");
    if (!no.checked) {
      throw new Error("refusing to make Sval this machine's default browser");
    }
  }
  if (from === STEPS.intro) {
    button(doc, "skip").click();
  } else if (from === STEPS.welcome) {
    const start = section.querySelector(".sval-fr-start");
    await TestUtils.waitForCondition(
      () => !start.disabled,
      "Start browsing can be pressed"
    );
    start.click();
  } else {
    button(doc, "continue").click();
  }
  await TestUtils.waitForCondition(
    () => !firstRunOpen(doc) || shownStep(doc) !== from,
    `Continue from ${from}`
  );
  if (firstRunOpen(doc)) {
    await settled(doc);
  }
}

/**
 * Continues from the step shown until `step` shows, running `at[s]` on each
 * step `s` it passes before pressing Continue there.
 *
 * @param {Document} doc The dialog's document.
 * @param {string} step The step to stop on.
 * @param {object} [at] Steps' own answers, as functions of the document.
 */
async function walkTo(doc, step, at = {}) {
  while (shownStep(doc) !== step) {
    Assert.ok(firstRunOpen(doc), `first run is still open short of ${step}`);
    await at[shownStep(doc)]?.(doc);
    await advance(doc);
  }
}

/**
 * Whether first run's dialog is the window's dialog. Another dialog can
 * take the window's dialog box as first run's goes, as the key's backup
 * does once a new device has made its key.
 *
 * @param {Document} doc The dialog's document.
 * @returns {boolean}
 */
function firstRunOpen(doc) {
  return gDialogBox.dialog?._frame?.contentDocument === doc;
}

/**
 * Continues from the step shown to the end, and waits for the panel's
 * startup, which first run was holding.
 *
 * @param {Document} doc The dialog's document.
 * @param {object} [at] As `walkTo` takes it.
 */
async function finishFirstRun(doc, at = {}) {
  while (firstRunOpen(doc)) {
    await at[shownStep(doc)]?.(doc);
    await advance(doc);
  }
  await within(SvalPanel.started, 40_000, "the panel's startup");
}

/**
 * Puts back, when the file ends, the prefs and the search engine first run's
 * steps write, so the next manifest's checks find them as the harness set
 * them.
 */
function keepFirstRunChoices() {
  keepFirstRunPrefs();
  const search = SvalSettingsSync.searchService();
  const before = search.currentId();
  registerCleanupFunction(async () => {
    await within(
      search.setById(await before),
      10_000,
      "putting back the search engine"
    );
    SvalKagi.stop();
  });
}

/**
 * Signs a normal window in to Kagi as Kagi's sign-in does, with its Secure
 * session cookie in the default jar (`isSessionCookie` in SvalKagi.sys.mjs).
 */
function signInToKagi() {
  Services.cookies.add(
    "kagi.com",
    "/",
    "kagi_session",
    "session-a",
    true,
    true,
    false,
    Date.now() + 3600 * 1000,
    {},
    Ci.nsICookie.SAMESITE_LAX,
    Ci.nsICookie.SCHEME_HTTPS
  );
}

/** Signs a normal window out of Kagi, as Kagi's sign-out does. */
function signOutOfKagi() {
  Services.cookies.remove("kagi.com", "kagi_session", "/", {});
}

/**
 * @param {Document} doc The dialog's document.
 * @returns {Element} the search step's Kagi notice.
 */
function kagiNotice(doc) {
  return doc.querySelector(
    `section[data-step="${STEPS.search}"] .sval-fr-kagi`
  );
}

/**
 * Chooses `engine` on the search step, once its engines are drawn.
 *
 * @param {Document} doc The dialog's document.
 * @param {string} engine A config engine's id.
 */
async function firstRunSearch(doc, engine) {
  await TestUtils.waitForCondition(
    () => shownSection(doc).querySelector(`input[value="${engine}"]`),
    "the engines are drawn"
  );
  pick(doc, engine);
}
