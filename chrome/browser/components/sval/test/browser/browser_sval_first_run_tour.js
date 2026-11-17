/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A new user's first run, every screen of it, on a fresh profile (first-run
 * spec §3, §7; 2026-11-09 spec §2, §3): the introduction's welcome and
 * frames move by Next, Back, the dots and the arrow keys; each step after it fills the
 * progress bar to its place, names its radio groups by their headings and
 * puts focus on the choice made; the keyboard moves through it; and the
 * welcome shows the user's card with the Launcher's key, then leaves one
 * workspace and every answer applied.
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

const { SvalPasswordManager } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPasswordManager.sys.mjs"
);
const { shortcutCaps, shortcutText, keyOf } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalKeys.sys.mjs"
);

const { ROLE_RADIOBUTTON } = Ci.nsIAccessibleRole;

/**
 * @param {string} step
 * @returns {string|undefined} the radio `step` starts on, as the model
 *   presets it.
 */
function presetOf(step) {
  const defaults = SvalFirstRunModel.defaults();
  return {
    [STEPS.question]: defaults.path,
    [STEPS.search]: defaults.search,
    [STEPS.privacy]: defaults.adblock,
    [STEPS.passwordManager]: undefined,
  }[step];
}

/**
 * The checks every step after the introduction passes as it shows: the
 * dialog named by its heading, the progress bar at its place in the path,
 * its three buttons, and, for a step that is one choice, a group its
 * heading names with the default chosen and focused.
 *
 * @param {Document} doc
 * @param {string} step
 * @param {object} answers The answers the path is taken with.
 * @param {object} facts
 */
async function checkStep(doc, step, answers, facts) {
  const section = shownSection(doc);
  const heading = section.querySelector("h1");
  const dialog = await accessibleOf(doc);
  await TestUtils.waitForCondition(
    () => dialog.name === heading.textContent,
    `${step}: the dialog is named by the step it shows`
  );
  const bar = section.querySelector('[role="progressbar"]');
  Assert.equal(
    Number(bar.getAttribute("aria-valuenow")),
    shareOf(step, answers, facts),
    `${step}: the bar fills to its place`
  );
  Assert.ok(bar.getAttribute("aria-label"), `${step}: the bar is named`);
  for (const which of ["back", "later", "continue"]) {
    Assert.ok(
      BrowserTestUtils.isVisible(button(doc, which)),
      `${step} has ${which}`
    );
  }
  if (presetOf(step) === undefined && step !== STEPS.passwordManager) {
    return;
  }
  const group = section.querySelector('[role="radiogroup"]');
  Assert.equal(
    group.getAttribute("aria-labelledby"),
    heading.id,
    `${step}'s group is named by its heading`
  );
  Assert.equal(
    group.querySelector("input:checked")?.value,
    presetOf(step),
    `${step} shows its default`
  );
  Assert.ok(
    doc.activeElement.matches('input[type="radio"]') &&
      group.contains(doc.activeElement) &&
      (doc.activeElement.checked || !group.querySelector("input:checked")),
    `${step}: focus is on the choice made, or the first with none made`
  );
}

add_task(async function a_new_user_continues_through_every_screen() {
  keepFirstRunPrefs();
  const doc = await firstRunShown();
  const win = doc.defaultView;
  const facts = await realFacts();
  const answers = { ...SvalFirstRunModel.defaults(), importPlan: [] };

  // The introduction.
  const intro = shownSection(doc);
  const next = intro.querySelector(".sval-fr-next");
  const dots = [...intro.querySelectorAll(".sval-fr-dot")];
  const frame = () => Number(intro.dataset.frame);
  Assert.equal(doc.activeElement, next, "Next has focus");
  Assert.equal(dots.length, 4, "Sval's welcome, then three frames");
  Assert.ok(
    !intro.querySelector('[role="progressbar"]'),
    "the introduction has its dots, not the bar"
  );
  Assert.equal(dots[0].getAttribute("aria-current"), "step");
  const mark = intro.querySelector(".sval-fr-mark");
  await TestUtils.waitForCondition(
    () => mark.complete && mark.naturalWidth > 0 && !mark.closest("[hidden]"),
    "the welcome shows Sval's mark"
  );
  Assert.ok(
    BrowserTestUtils.isHidden(intro.querySelector(".sval-fr-intro-back")),
    "the welcome has no Back"
  );
  Assert.ok(
    BrowserTestUtils.isVisible(intro.querySelector(".sval-fr-skip")),
    "and has Skip"
  );
  Assert.ok(!intro.querySelector(".sval-fr-later"), "but no Skip setup");
  await settled(doc);
  EventUtils.synthesizeKey("KEY_Enter", {}, win);
  Assert.equal(frame(), 1, "Enter on the welcome is Next");
  Assert.ok(BrowserTestUtils.isHidden(mark), "and the mark goes with it");
  EventUtils.synthesizeKey("KEY_ArrowRight", {}, win);
  Assert.equal(frame(), 2, "the right arrow moves on a frame");
  Assert.equal(dots[2].getAttribute("aria-current"), "step");
  Assert.equal(
    intro.querySelectorAll('[aria-current="step"]').length,
    1,
    "one dot is current"
  );
  const heading = intro.querySelector("h1");
  const caps = [...heading.querySelectorAll("kbd")].map(kbd => kbd.textContent);
  Assert.deepEqual(
    caps,
    shortcutCaps(keyOf(document.getElementById("focusURLBar"))),
    "the Launcher's frame shows the window's own key, as caps"
  );
  EventUtils.synthesizeKey("KEY_ArrowLeft", {}, win);
  Assert.equal(frame(), 1, "the left arrow moves back");
  dots[3].click();
  Assert.equal(frame(), 3, "a dot goes to its frame");
  Assert.ok(next.hasAttribute("data-last"), "the last frame's Next starts");
  intro.querySelector(".sval-fr-intro-back").click();
  Assert.equal(frame(), 2, "Back goes back a frame");
  next.focus();
  next.click();
  // A held Enter takes one step: its repeats arrive in the press's task.
  intro.querySelector("h1").focus();
  EventUtils.synthesizeKey("KEY_Enter", { repeat: 3 }, win);
  await TestUtils.waitForCondition(
    () => shownStep(doc) === STEPS.question,
    "Enter on the last frame goes to the question"
  );
  await settled(doc);
  Assert.equal(shownStep(doc), STEPS.question, "and a held Enter one step");

  // The question, while the import, if any, is still to be answered.
  await checkStep(doc, STEPS.question, SvalFirstRunModel.defaults(), facts);
  // Two quick presses of Continue take one step.
  await settled(doc);
  button(doc, "continue").click();
  button(doc, "continue").click();
  const path = pathOf(answers, facts);
  const second = path[path.indexOf(STEPS.question) + 1];
  await TestUtils.waitForCondition(
    () => shownStep(doc) === second,
    "the first press continues"
  );
  await settled(doc);
  Assert.equal(shownStep(doc), second, "and the second, too soon, not");
  if (second === STEPS.import) {
    await checkStep(doc, STEPS.import, SvalFirstRunModel.defaults(), facts);
    await continueTo(doc, STEPS.workspace);
  }

  // Your first Workspace.
  await checkStep(doc, STEPS.workspace, answers, facts);
  const name = shownSection(doc).querySelector(".sval-nw-name");
  Assert.equal(doc.activeElement, name, "the name has focus");
  const named = name.value;
  await continueTo(doc, STEPS.search);

  // Search: the engines the panel offers, in its order.
  await checkStep(doc, STEPS.search, answers, facts);
  const engines = await SvalPanel._firstRunEngines();
  const rows = [...shownSection(doc).querySelectorAll(".sval-fr-option")];
  Assert.deepEqual(
    rows.map(row => row.querySelector("input").value),
    engines.map(engine => engine.id),
    "search lists the panel's engines in its order, one per line"
  );
  for (const row of rows) {
    Assert.ok(row.querySelector("img"), "each with its icon");
    const acc = await accessibleOf(row.querySelector("input"));
    Assert.equal(acc.role, ROLE_RADIOBUTTON);
    Assert.equal(
      acc.name,
      row.querySelector(".sval-fr-option-label").textContent,
      "named by its label"
    );
    Assert.equal(
      acc.description,
      row.querySelector(".sval-fr-option-detail").textContent,
      `${acc.name}: described by its detail`
    );
  }
  // The keyboard: arrows move the choice, Enter on a choice continues, and
  // Enter on a focused button presses that button.
  EventUtils.synthesizeKey("KEY_ArrowDown", {}, win);
  Assert.ok(
    doc.activeElement.matches(`input[value="${engines[1].id}"]:checked`),
    "arrows move the choice"
  );
  EventUtils.synthesizeKey("KEY_ArrowUp", {}, win);
  await settled(doc);
  EventUtils.synthesizeKey("KEY_Enter", {}, win);
  await TestUtils.waitForCondition(
    () => shownStep(doc) === STEPS.privacy,
    "Enter on a choice is Continue"
  );
  await settled(doc);
  button(doc, "back").focus();
  EventUtils.synthesizeKey("KEY_Enter", {}, win);
  await TestUtils.waitForCondition(
    () => shownStep(doc) === STEPS.search,
    "Enter on a focused button presses that button"
  );
  Assert.ok(
    doc.activeElement.matches('input[type="radio"]:checked'),
    "Back lands on the choice made"
  );
  await settled(doc);
  await continueTo(doc, STEPS.privacy);

  // Blocking, and each choice named by its label alone.
  await checkStep(doc, STEPS.privacy, answers, facts);
  for (const row of shownSection(doc).querySelectorAll(".sval-fr-option")) {
    const acc = await accessibleOf(row.querySelector("input"));
    Assert.equal(
      acc.name,
      row.querySelector(".sval-fr-option-label").textContent,
      "named by its label"
    );
  }
  await continueTo(doc, STEPS.passwordManager);

  // The password manager: every manager, none chosen, and Continue with none
  // chosen installs nothing.
  await checkStep(doc, STEPS.passwordManager, answers, facts);
  Assert.deepEqual(
    [...shownSection(doc).querySelectorAll('input[type="radio"]')].map(
      radio => radio.value
    ),
    SvalPasswordManager.choices(),
    "every manager, then None of these"
  );
  Assert.equal(
    shownSection(doc).querySelector("input:checked"),
    null,
    "nothing is preset"
  );
  await continueTo(doc, STEPS.more);

  // A few more things: a two-way group per card, named by its title.
  await checkStep(doc, STEPS.more, answers, facts);
  const more = shownSection(doc);
  const groups = [...more.querySelectorAll('[role="radiogroup"]')];
  Assert.equal(
    groups.length,
    facts.isDefaultBrowser ? 2 : 3,
    "the default browser card shows only where Sval is not the default"
  );
  for (const group of groups) {
    Assert.equal(
      group.querySelectorAll('input[type="radio"]').length,
      2,
      "each card is a two-way choice"
    );
    Assert.ok(
      doc.getElementById(group.getAttribute("aria-labelledby")),
      "named by the card's title"
    );
  }
  Assert.ok(
    doc.activeElement.matches('input[type="radio"]:checked') &&
      groups[0].contains(doc.activeElement),
    "focus is on the first card's choice"
  );
  Assert.ok(
    BrowserTestUtils.isHidden(more.querySelector(".sval-fr-check")),
    "sites' tools wait for AI assistants to be on"
  );
  declineDefaultBrowser(doc);
  await press(doc, "continue", STEPS.welcome);

  // The welcome.
  const welcome = shownSection(doc);
  Assert.ok(
    !welcome.querySelector('[role="progressbar"]'),
    "the welcome shows no progress"
  );
  await TestUtils.waitForCondition(
    () => welcome.querySelector(".sval-mcard svg"),
    "the welcome shows the user's card"
  );
  Assert.equal(welcome.dataset.card, "new", "a new user's card");
  const card = JSON.parse(Services.prefs.getStringPref("browser.sval.card"));
  Assert.ok(
    welcome
      .querySelector("h1")
      .textContent.toLowerCase()
      .includes(card.title.toLowerCase()),
    "greeting the user by the card's title"
  );
  const tip = welcome.querySelector(".sval-fr-tip");
  await TestUtils.waitForCondition(
    () => tip.querySelector("kbd"),
    "the line's words"
  );
  Assert.equal(
    tip.querySelector("kbd").textContent,
    shortcutText(keyOf(document.getElementById("focusURLBar"))),
    "the Launcher's key as the window has it"
  );
  const start = welcome.querySelector(".sval-fr-start");
  await TestUtils.waitForCondition(
    () => doc.activeElement === start,
    "Start browsing has focus"
  );
  await startBrowsing(doc);

  await within(SvalPanel.started, 40_000, "the panel's startup");
  const workspaces = await workspacesInEngine();
  Assert.equal(workspaces.length, 1, "exactly one workspace");
  Assert.equal(
    SvalPanel.nodes[workspaces[0]].content.name,
    named,
    "named as the Workspace step showed it"
  );
  Assert.equal(
    await SvalSettingsSync.searchService().currentId(),
    answers.search,
    "the search engine kept is the one shown"
  );
  Assert.equal(
    Services.prefs.getStringPref(LEVEL_PREF),
    answers.adblock,
    "and the ad blocking level"
  );
  Assert.ok(SvalPanel.settings.firstRunDone, "first run is done");
});
