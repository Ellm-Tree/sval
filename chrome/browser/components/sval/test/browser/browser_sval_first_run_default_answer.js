/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The default browser card on "A few more things" (2026-11-09 spec §3.6):
 * No never asks the system to make Sval the default browser, whether the
 * step continues, Skip setup follows it, or Skip setup comes before it, and
 * Yes asks once, when the step continues. First run is opened here with the
 * panel's own actions, and the system's side is a stub, so no task changes
 * which browser this machine opens links in.
 */

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

const { SvalFirstRun } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFirstRun.sys.mjs"
);
const { SvalSettingsSync } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSettingsSync.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

/**
 * @param {Document} doc The dialog's document.
 * @returns {Element|undefined} the one visible step.
 */
function shownSection(doc) {
  return [...doc.querySelectorAll(".sval-fr > section")].find(
    section => !section.hidden
  );
}

/**
 * @param {Document} doc
 * @returns {string|undefined} the visible step's name.
 */
function shownStep(doc) {
  return shownSection(doc)?.dataset.step;
}

/**
 * Presses `which` on the visible step and waits for another step, once the
 * step shown has passed its own task, which a press in it is ignored in.
 *
 * @param {Document} doc
 * @param {string} which A button's class, past `sval-fr-`.
 */
async function press(doc, which) {
  const from = shownStep(doc);
  await new Promise(resolve => doc.defaultView.setTimeout(resolve, 0));
  shownSection(doc).querySelector(`.sval-fr-${which}`).click();
  await TestUtils.waitForCondition(
    () => shownStep(doc) !== from,
    `${which} from ${from}`
  );
}

/**
 * Opens first run as a device Sval is not the default on, and continues to
 * `step`.
 *
 * @param {string} step
 * @returns {Promise<{doc: Document, shown: Promise}>}
 */
async function openTo(step) {
  atTaskEnd(closeLeftoverDialog);
  const shown = SvalFirstRun.open(window, {
    actions: SvalPanel._firstRunActions(),
    facts: { importAvailable: false, isDefaultBrowser: false, earlier: {} },
  });
  await TestUtils.waitForCondition(() => gDialogBox.isOpen, "first run opens");
  await dialogShown(gDialogBox.dialog, "the dialog's load");
  const doc = gDialogBox.dialog._frame.contentDocument;
  await TestUtils.waitForCondition(
    () => shownStep(doc) === "intro",
    "the introduction"
  );
  await press(doc, "skip");
  while (shownStep(doc) !== step) {
    await press(doc, "continue");
  }
  return { doc, shown };
}

/**
 * Chooses `answer` on the default browser card as a person does, by a
 * press on the switch's words.
 *
 * @param {Document} doc
 * @param {string} answer `true` for Yes or `false` for No.
 */
function choose(doc, answer) {
  const input = shownSection(doc).querySelector(
    `input[data-setting="defaultBrowser"][value="${answer}"]`
  );
  EventUtils.synthesizeMouseAtCenter(
    input.closest("label").querySelector("span"),
    {},
    doc.defaultView
  );
  Assert.ok(input.checked, `${answer === "true" ? "Yes" : "No"} is chosen`);
}

/**
 * Presses Start browsing once the welcome shows, and waits for first run
 * to end.
 *
 * @param {Document} doc
 * @param {Promise} shown What `SvalFirstRun.open` returned.
 */
async function startBrowsing(doc, shown) {
  await TestUtils.waitForCondition(
    () => shownStep(doc) === "welcome",
    "the welcome"
  );
  const start = shownSection(doc).querySelector(".sval-fr-start");
  await TestUtils.waitForCondition(() => !start.disabled, "nothing runs");
  start.click();
  await within(shown, 10_000, "first run's end");
}

add_setup(async function () {
  keepPrefs(
    "browser.sval.adblock.level",
    "browser.sval.agents.enabled",
    "browser.sval.agents.pageTools.enabled",
    "browser.sval.passwordManager",
    "sidebar.position_start",
    "sidebar.revamp"
  );
  const search = SvalSettingsSync.searchService();
  const engine = await search.currentId();
  registerCleanupFunction(() =>
    within(search.setById(engine), 10_000, "putting back the search engine")
  );
  // Any system's own default browser stays as it is.
  const setDefault = sinon.stub(ShellService, "setDefaultBrowser").resolves();
  registerCleanupFunction(() => setDefault.restore());
});

add_task(async function no_never_asks_the_system() {
  const setDefault = ShellService.setDefaultBrowser;
  setDefault.resetHistory();
  const { doc, shown } = await openTo("more");
  Assert.ok(
    shownSection(doc).querySelector(
      'input[data-setting="defaultBrowser"][value="true"]'
    ).checked,
    "Yes is preset"
  );
  choose(doc, "false");
  await press(doc, "continue");
  await startBrowsing(doc, shown);
  Assert.equal(setDefault.callCount, 0, "No, continued, asks nothing");
});

add_task(async function no_then_skip_setup_never_asks_the_system() {
  const setDefault = ShellService.setDefaultBrowser;
  setDefault.resetHistory();
  const { doc, shown } = await openTo("more");
  choose(doc, "false");
  await press(doc, "continue");
  await TestUtils.waitForCondition(
    () => shownStep(doc) === "welcome",
    "the welcome"
  );
  await startBrowsing(doc, shown);
  Assert.equal(setDefault.callCount, 0, "No asks nothing at the flow's end");

  setDefault.resetHistory();
  const again = await openTo("more");
  choose(again.doc, "false");
  await press(again.doc, "back");
  await press(again.doc, "later");
  await startBrowsing(again.doc, again.shown);
  Assert.equal(
    setDefault.callCount,
    0,
    "No, then Skip setup from the step before, asks nothing"
  );
});

add_task(async function skip_setup_before_the_step_never_asks_the_system() {
  const setDefault = ShellService.setDefaultBrowser;
  setDefault.resetHistory();
  const { doc, shown } = await openTo("search");
  await press(doc, "later");
  await startBrowsing(doc, shown);
  Assert.equal(setDefault.callCount, 0, "Skip setup's answer is No");
});

add_task(async function yes_asks_the_system_once() {
  const setDefault = ShellService.setDefaultBrowser;
  setDefault.resetHistory();
  const { doc, shown } = await openTo("more");
  choose(doc, "true");
  await press(doc, "continue");
  Assert.equal(setDefault.callCount, 1, "Yes asks when the step continues");
  Assert.deepEqual(setDefault.firstCall.args, [false], "for this user");
  await startBrowsing(doc, shown);
  Assert.equal(setDefault.callCount, 1, "and only then");
});
