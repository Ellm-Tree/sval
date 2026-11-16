/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The question Sval asks at launch when it is not the default browser and
 * Settings › General's check at launch is on: `BrowserGlue` hands it to
 * `DefaultBrowserCheck.prompt`, which asks in Sval's dialog with Firefox's
 * words for the question, and "Don't show this message again" turns the check
 * off.
 */

"use strict";

const { DefaultBrowserCheck } = ChromeUtils.importESModule(
  "moz-src:///browser/components/DefaultBrowserCheck.sys.mjs"
);

const DIALOG_URL = "chrome://browser/content/sval/sval-dialog.xhtml";
const PROMPT_PREFS = [
  "browser.shell.checkDefaultBrowser",
  "browser.shell.mostRecentDefaultPromptSeen",
  "browser.shell.userDisabledDefaultCheck",
];

registerCleanupFunction(() => {
  for (const pref of PROMPT_PREFS) {
    Services.prefs.clearUserPref(pref);
  }
});

/**
 * Asks the launch question in this window, as `BrowserGlue` does, and waits
 * for its dialog to draw its buttons.
 *
 * @returns {Promise<{answer: Promise, doc: Document}>}
 */
async function openPrompt() {
  const answer = DefaultBrowserCheck.prompt(window);
  await TestUtils.waitForCondition(() => gDialogBox.isOpen, "the prompt opens");
  await dialogShown(gDialogBox.dialog, "the prompt's load");
  let doc;
  await TestUtils.waitForCondition(() => {
    doc = gDialogBox.dialog._frame.contentDocument;
    return doc?.querySelector(".sval-dialog-actions button.primary");
  }, "the prompt has drawn its buttons");
  return { answer, doc };
}

/** The launch question's words, as Firefox's strings give them here. */
async function expectedTitle() {
  const needPin =
    (await getShellService().doesAppNeedPin()) ||
    (await getShellService().doesAppNeedStartMenuPin());
  return document.l10n.formatValue(
    needPin
      ? "default-browser-prompt-title-pin"
      : "default-browser-prompt-title-alt"
  );
}

/**
 * Nothing interrupts a launch on Sval's defaults: the check at launch is off
 * until the user turns it on in Settings.
 */
add_task(async function a_fresh_install_does_not_ask_at_launch() {
  Assert.ok(
    !Services.prefs
      .getDefaultBranch("")
      .getBoolPref("browser.shell.checkDefaultBrowser"),
    "the check at launch is off by default"
  );
});

/**
 * The launch question is Sval's dialog, with Sval's mark and its buttons in
 * Sval's order.
 */
add_task(async function the_launch_question_is_svals_dialog() {
  const { answer, doc } = await openPrompt();
  try {
    Assert.equal(doc.documentURI, DIALOG_URL, "it is Sval's dialog");
    Assert.equal(
      doc.getElementById("sval-dialog-title").textContent,
      await expectedTitle(),
      "it asks Firefox's question"
    );
    const buttons = [...doc.querySelectorAll(".sval-dialog-actions button")];
    Assert.deepEqual(
      buttons.map(b => b.classList.contains("primary")),
      [false, true],
      "Not now, then the primary answer"
    );
    const icon = doc.querySelector(".sval-dialog-icon");
    Assert.ok(
      icon.checkVisibility() && icon.dataset.icon == "sval",
      "it shows Sval's mark"
    );
  } finally {
    gDialogBox.dialog.close();
    await answer;
  }
});

/**
 * Ticking "Don't show this message again" and answering Not now turns the
 * check at launch off, as the Settings checkbox does.
 */
add_task(async function dont_show_again_turns_the_check_off() {
  Services.prefs.setBoolPref("browser.shell.checkDefaultBrowser", true);
  const { answer, doc } = await openPrompt();
  const box = doc.querySelector(".sval-dialog-check input");
  Assert.ok(box.checkVisibility(), "the prompt offers not to ask again");
  box.click();
  doc.querySelector(".sval-dialog-actions button:not(.primary)").click();
  await within(answer, 10_000, "the prompt's answer");
  Assert.ok(
    !Services.prefs.getBoolPref("browser.shell.checkDefaultBrowser"),
    "the check at launch is off"
  );
});

add_task(async function not_now_keeps_the_check() {
  Services.prefs.setBoolPref("browser.shell.checkDefaultBrowser", true);
  const { answer, doc } = await openPrompt();
  doc.querySelector(".sval-dialog-actions button:not(.primary)").click();
  await within(answer, 10_000, "the prompt's answer");
  Assert.ok(
    Services.prefs.getBoolPref("browser.shell.checkDefaultBrowser"),
    "the check at launch stays on"
  );
});

/** Escape with "Don't show this message again" ticked also turns it off. */
add_task(async function escape_keeps_dont_show_again() {
  Services.prefs.setBoolPref("browser.shell.checkDefaultBrowser", true);
  const { answer, doc } = await openPrompt();
  doc.querySelector(".sval-dialog-check input").click();
  EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
  await within(answer, 10_000, "the prompt's answer");
  Assert.ok(
    !Services.prefs.getBoolPref("browser.shell.checkDefaultBrowser"),
    "the check at launch is off"
  );
});
