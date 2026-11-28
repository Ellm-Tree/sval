/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A grant held through the dialog delay (`sval-dialog-hold.js`) is a held
 * `sval-button`: while its fill sweeps across it, and while it is disabled
 * with its window behind another, no press of any kind answers the alert,
 * and the accessibility API reports it unavailable. Once the hold ends, one
 * press grants once. Enter never pairs an agent while Pair is disabled.
 */

const { ask, askToPair } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentAlerts.sys.mjs"
);

add_setup(async function the_window_is_ready() {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  registerCleanupFunction(closeLeftoverDialog);
});

/**
 * Whether `promise` has settled, without waiting for it.
 *
 * @param {Promise} promise
 * @returns {Promise<boolean>}
 */
async function settledYet(promise) {
  const pending = Symbol("pending");
  return (await Promise.race([promise.then(() => true), pending])) !== pending;
}

/**
 * Presses `el`, a grant in the alert `doc`, every way a click can reach it:
 * at its centre and on its edge, `click()`, a click dispatched at it, and
 * Enter and Space sent to the alert.
 *
 * @param {Document} doc
 * @param {Element} el
 */
function pressEveryWay(doc, el) {
  const view = doc.defaultView;
  // The presses land on a control the accessibility API reports as
  // disabled, and on the element's edge, which has no accessible of its own:
  // both are the states under test.
  AccessibilityUtils.setEnv({
    mustBeEnabled: false,
    mustHaveAccessibleRule: false,
  });
  const rect = el.getBoundingClientRect();
  EventUtils.synthesizeMouseAtCenter(el, {}, view);
  EventUtils.synthesizeMouse(el, 1, rect.height / 2, {}, view);
  el.click();
  el.dispatchEvent(new view.MouseEvent("click", { bubbles: true }));
  EventUtils.synthesizeKey("KEY_Enter", {}, view);
  EventUtils.synthesizeKey(" ", {}, view);
  AccessibilityUtils.resetEnv();
}

add_task(async function a_held_grant_answers_nothing_until_the_hold_ends() {
  await SpecialPowers.pushPrefEnv({
    set: [["security.dialog_enable_delay", 1500]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const answer = ask(window, {
    question: "Allow the agent to fill in this form?",
    choices: [
      { id: "deny", label: "Deny" },
      { id: "allow", label: "Allow" },
    ],
    defaultChoice: "deny",
  });
  const { doc } = await openedSvalDialog();
  const allow = doc.querySelector('sval-dialog [data-choice="allow"]');
  await TestUtils.waitForCondition(() => allow.held, "Allow is held");
  const inner = allow.shadowRoot.querySelector("button");
  const state = {};
  (await accessibleOf(inner)).getState(state, {});
  Assert.ok(
    state.value & Ci.nsIAccessibleStates.STATE_UNAVAILABLE,
    "the accessibility API reports the held grant unavailable"
  );
  Assert.ok(
    inner.getAnimations().length ||
      doc.defaultView.matchMedia("(prefers-reduced-motion: reduce)").matches,
    "its fill sweeps across it"
  );

  pressEveryWay(doc, allow);
  Assert.ok(allow.held, "the presses all landed during the hold");
  Assert.ok(!(await settledYet(answer)), "none answers the alert");
  Assert.ok(gDialogBox.isOpen, "and the alert stays");

  await TestUtils.waitForCondition(() => !allow.disabled, "Allow enables");
  Assert.ok(!allow.held, "and is no longer held");
  allow.disabled = true;
  await allow.updateComplete;
  pressEveryWay(doc, allow);
  Assert.ok(
    !(await settledYet(answer)),
    "nothing answers it while it is disabled either"
  );
  allow.disabled = false;
  await allow.updateComplete;

  let clicks = 0;
  allow.addEventListener("click", () => clicks++);
  EventUtils.synthesizeMouseAtCenter(allow, {}, doc.defaultView);
  Assert.equal(await within(answer, 10_000, "the answer"), "allow");
  Assert.equal(clicks, 1, "one press grants once");
});

add_task(async function enter_never_pairs_while_pair_is_disabled() {
  await SpecialPowers.pushPrefEnv({
    set: [["security.dialog_enable_delay", 1500]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const answer = askToPair("Test Agent");
  const { doc, dialog } = await openedSvalDialog();
  const allow = doc.querySelector(".sval-ap-allow");
  Assert.ok(allow.disabled, "Pair starts disabled");
  Assert.equal(
    doc.activeElement,
    dialog,
    "the alert itself has the focus while Pair cannot take it"
  );
  const form = dialog.closest("form");
  form.requestSubmit();
  EventUtils.synthesizeKey("KEY_Enter", {}, doc.defaultView);
  pressEveryWay(doc, allow);
  Assert.ok(!(await settledYet(answer)), "nothing pairs while it is disabled");
  await TestUtils.waitForCondition(
    () => !allow.disabled && doc.activeElement === allow,
    "Pair enables and takes the focus"
  );
  EventUtils.synthesizeKey("KEY_Enter", {}, doc.defaultView);
  Assert.deepEqual(
    await within(answer, 10_000, "the pairing alert's answer"),
    { action: "allow", isolated: false },
    "then Enter pairs"
  );
});
