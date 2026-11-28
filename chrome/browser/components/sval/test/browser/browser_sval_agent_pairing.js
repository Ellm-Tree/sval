/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */

/**
 * The Pair/Deny alert an agent's pairing request raises, and the workspace
 * pairing creates. The alert is a page in the window's modal dialog
 * (`gDialogBox`), so the tests reach its document through the dialog's frame,
 * as `browser_sval_new_workspace.js` does.
 */

const { askToPair } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentAlerts.sys.mjs"
);

add_setup(async function the_window_is_ready() {
  await within(SvalPanel.started, 10_000, "the panel's startup");
});

/**
 * Waits for the pairing alert that is open to draw, and closes it when the
 * task ends if a failure left it open.
 *
 * Every task waits for an alert's answer before it asks again, and that
 * answer settles only once `gDialogBox` has let go of the alert. So the
 * dialog open now is the one just asked for.
 *
 * @returns {Promise<Document>} the alert's document.
 */
async function dialogDocument() {
  atTaskEnd(closeLeftoverDialog);
  await TestUtils.waitForCondition(() => gDialogBox.isOpen, "the alert opens");
  const dialog = gDialogBox.dialog;
  await dialogShown(dialog, "the alert's load");
  let doc;
  await TestUtils.waitForCondition(() => {
    doc = dialog._frame.contentDocument;
    return doc?.querySelector(".sval-ap-allow");
  }, "the pairing alert has drawn");
  return doc;
}

/**
 * @param {Promise<object>} answer What `askToPair` returned.
 * @returns {Promise<object>} its answer, once the alert has closed.
 */
function answerOf(answer) {
  return within(answer, 10_000, "the pairing alert's answer");
}

/** The alert names the agent, and Pair answers allow. */
add_task(async function allow_answers_allow() {
  const answer = askToPair("Test Agent");
  const doc = await dialogDocument();
  Assert.ok(
    doc.getElementById("sval-ap-question").textContent.includes("Test Agent")
  );
  Assert.ok(doc.getElementById("sval-ap-facts").hidden, "no facts, no list");
  Assert.ok(
    !doc.querySelector("#sval-ap-facts [data-again]"),
    "a first pairing is not said to keep anything"
  );
  await pair(doc);
  Assert.deepEqual(await answerOf(answer), {
    action: "allow",
    isolated: false,
  });
});

/**
 * The alert says which kind of workspace the agent asked for, and a box
 * overrides it. The "Isolated" pill shows whenever the answer isolates, and
 * the answer decides the kind.
 */
add_task(async function the_user_decides_whether_the_workspace_is_isolated() {
  let answer = askToPair("Test Agent", [], true);
  let doc = await dialogDocument();
  const pill = () =>
    doc.querySelector(".sval-ap-request .sval-dialog-iso-pill");
  const override = () => doc.querySelector(".sval-ap-override input");
  Assert.equal(
    doc.getElementById("sval-ap-request").dataset.asked,
    "isolated",
    "the alert says the agent asks for an isolated workspace"
  );
  Assert.ok(!override().checked, "the agent's request stands at first");
  Assert.ok(!pill().hidden, "the pill says the answer isolates");
  await pair(doc);
  Assert.deepEqual(await answerOf(answer), { action: "allow", isolated: true });

  answer = askToPair("Test Agent", [], true);
  doc = await dialogDocument();
  override().click();
  Assert.ok(pill().hidden, "letting it use sign-ins hides the pill");
  await pair(doc);
  Assert.deepEqual(await answerOf(answer), {
    action: "allow",
    isolated: false,
  });

  answer = askToPair("Test Agent", [], false);
  doc = await dialogDocument();
  Assert.equal(
    doc.getElementById("sval-ap-request").dataset.asked,
    "shared",
    "the alert says the agent asks for a shared workspace"
  );
  Assert.ok(pill().hidden);
  override().click();
  Assert.ok(!pill().hidden, "isolating it shows the pill");
  await pair(doc);
  Assert.deepEqual(
    await answerOf(answer),
    { action: "allow", isolated: true },
    "the user's answer wins over the agent's request"
  );
});

/**
 * Ticking the box hides the pill, and the request line rewraps shorter. The
 * frame and its box follow the card, so nothing is clipped and no band is
 * left under it.
 */
add_task(async function the_alert_follows_its_card_as_it_resizes() {
  const answer = askToPair(
    "An agent with a name long enough to wrap the request line",
    [],
    true
  );
  const doc = await dialogDocument();
  const dialog = gDialogBox.dialog;
  const card = doc.querySelector("sval-dialog");
  const cardHeight = () => Math.ceil(card.getBoundingClientRect().height);
  const fits = () =>
    cardHeight() === dialog._frame.clientHeight &&
    dialog._box.getBoundingClientRect().height -
      dialog._frame.getBoundingClientRect().height ===
      gap;
  await TestUtils.waitForCondition(
    () => cardHeight() === dialog._frame.clientHeight,
    "the frame fits the card"
  );
  const gap =
    dialog._box.getBoundingClientRect().height -
    dialog._frame.getBoundingClientRect().height;
  const before = cardHeight();
  doc.querySelector(".sval-ap-override input").click();
  await TestUtils.waitForCondition(
    () => cardHeight() < before && fits(),
    "the frame and box shrink with the card"
  );
  doc.querySelector(".sval-ap-override input").click();
  await TestUtils.waitForCondition(
    () => cardHeight() === before && fits(),
    "the frame and box grow with the card"
  );
  doc.querySelector(".sval-ap-deny").click();
  Assert.deepEqual(await answerOf(answer), { action: "deny" });
});

/**
 * Pairing grants an agent the user's signed-in sessions, so Pair waits out
 * Firefox's dialog delay as Sval's other agent alerts do, and a click meant
 * for something else cannot land on it. Deny can be chosen at once. Pair is
 * marked held meanwhile, which sweeps its fill across it.
 */
add_task(async function allow_waits_out_the_dialog_delay() {
  await SpecialPowers.pushPrefEnv({
    set: [["security.dialog_enable_delay", 1000]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const answer = askToPair("Test Agent");
  const doc = await dialogDocument();
  const allow = doc.querySelector(".sval-ap-allow");
  Assert.ok(allow.disabled, "Pair starts disabled");
  Assert.ok(!doc.querySelector(".sval-ap-deny").disabled, "Deny does not");
  await TestUtils.waitForCondition(
    () => allow.held,
    "Pair is held once the alert is in front"
  );
  allow.click();
  Assert.ok(gDialogBox.isOpen, "a click on Pair does nothing yet");
  await TestUtils.waitForCondition(() => !allow.disabled, "Pair enables");
  Assert.ok(!allow.held, "and no longer held");
  allow.click();
  Assert.deepEqual(await answerOf(answer), {
    action: "allow",
    isolated: false,
  });
});

/**
 * Beside the name the agent gave, the alert lists what Sval knows of it, so
 * the user can tell which agent asks.
 */
add_task(async function the_alert_lists_what_sval_knows_of_the_agent() {
  const facts = ["Client: claude-code", "Launched in: /work/sval"];
  const answer = askToPair("sval-0a", facts);
  const doc = await dialogDocument();
  Assert.ok(
    doc.getElementById("sval-ap-question").textContent.includes("sval-0a"),
    "the alert names the agent"
  );
  const list = doc.getElementById("sval-ap-facts");
  Assert.ok(BrowserTestUtils.isVisible(list));
  Assert.deepEqual(
    [...list.children].map(li => li.textContent),
    facts
  );
  doc.querySelector(".sval-ap-deny").click();
  Assert.deepEqual(await answerOf(answer), { action: "deny" });
});

add_task(async function deny_answers_deny() {
  const answer = askToPair("Test Agent");
  const doc = await dialogDocument();
  doc.querySelector(".sval-ap-deny").click();
  Assert.deepEqual(await answerOf(answer), { action: "deny" });
});

/**
 * Pair is the default button, styled as the primary one, and has focus once the
 * alert is in front. Deny is the secondary button.
 */
add_task(async function pair_is_the_focused_primary_button() {
  const answer = askToPair("Test Agent");
  const doc = await dialogDocument();
  const allow = doc.querySelector(".sval-ap-allow");
  const deny = doc.querySelector(".sval-ap-deny");
  await TestUtils.waitForCondition(
    () => !allow.disabled && doc.activeElement === allow,
    "Pair is enabled and focused"
  );
  Assert.equal(allow.type, "primary", "Pair is the primary button");
  Assert.equal(deny.type, "secondary", "Deny is not");
  Assert.ok(allow.submit, "Pair is the form's default button");
  Assert.ok(!deny.submit, "Deny is not");
  deny.click();
  Assert.deepEqual(await answerOf(answer), { action: "deny" });
});

/**
 * Enter pairs once Pair is focused and enabled. `EnableDelayHelper` cancels
 * every keydown while its timer runs, and every focus of the dialog restarts
 * it, even at no delay, so an Enter can be swallowed; Enter is pressed until
 * the dialog answers.
 */
add_task(async function enter_on_the_focused_pair_allows() {
  const answer = askToPair("Test Agent");
  const doc = await dialogDocument();
  const allow = doc.querySelector(".sval-ap-allow");
  await TestUtils.waitForCondition(
    () => doc.activeElement === allow,
    "Pair is focused"
  );
  await TestUtils.waitForCondition(() => {
    if (!gDialogBox.isOpen) {
      return true;
    }
    EventUtils.synthesizeKey("KEY_Enter", {}, doc.defaultView);
    return false;
  }, "Enter answers the dialog");
  Assert.deepEqual(await answerOf(answer), {
    action: "allow",
    isolated: false,
  });
});

/**
 * Pair takes focus only once it can be pressed, so an Enter held down as the
 * alert opens never lands on it: Pair is disabled, and the alert itself holds
 * focus, so a screen reader reads the alert: what pairing gives, who asks,
 * and the workspace it asked for.
 */
add_task(async function enter_during_the_delay_does_not_pair() {
  await SpecialPowers.pushPrefEnv({
    set: [["security.dialog_enable_delay", 1000]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const answer = askToPair("Test Agent", ["Client: claude-code"]);
  const doc = await dialogDocument();
  const allow = doc.querySelector(".sval-ap-allow");
  const form = doc.querySelector(".sval-ap");
  Assert.ok(allow.disabled, "Pair starts disabled");
  await TestUtils.waitForCondition(
    () => doc.activeElement === form,
    "the alert holds focus"
  );
  const acc = await accessibleOf(form);
  const states = {};
  acc.getState(states, {});
  Assert.ok(
    states.value & Ci.nsIAccessibleStates.STATE_FOCUSED,
    "a screen reader is on the alert"
  );
  Assert.equal(
    acc.name,
    doc.getElementById("sval-ap-question").textContent,
    "named by its question"
  );
  Assert.ok(acc.name.includes("Test Agent"), "which names the agent");
  const text = id =>
    doc.getElementById(id).textContent.replace(/\s+/g, " ").trim();
  for (const part of [
    text("sval-ap-detail"),
    "Client: claude-code",
    text("sval-ap-request"),
  ]) {
    Assert.stringContains(acc.description, part, "the description says it");
  }
  EventUtils.synthesizeKey("KEY_Enter", {}, doc.defaultView);
  Assert.ok(gDialogBox.isOpen, "Enter does not pair during the delay");
  await TestUtils.waitForCondition(
    () => !allow.disabled && doc.activeElement === allow,
    "Pair enables and takes focus"
  );
  allow.click();
  Assert.deepEqual(await answerOf(answer), {
    action: "allow",
    isolated: false,
  });
});

/** Escape closes the dialog without an answer, which is a deny. */
add_task(async function escape_denies() {
  const answer = askToPair("Test Agent");
  const doc = await dialogDocument();
  await TestUtils.waitForCondition(() => doc.hasFocus(), "the alert in front");
  EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
  Assert.deepEqual(await answerOf(answer), { action: "deny" });
});

/**
 * A window in a modal state, such as one showing a tab-modal prompt, still
 * shows the alert. `gDialogBox.open` asks its args whether the caller is
 * async there, and a caller that cannot answer gets a TypeError and no alert.
 */
add_task(async function the_alert_shows_while_the_window_is_in_a_modal_state() {
  window.windowUtils.enterModalState();
  let answer;
  let opened;
  try {
    answer = askToPair("Test Agent");
    // `gDialogBox.open` decides synchronously, before its first await.
    opened = gDialogBox.isOpen;
  } finally {
    window.windowUtils.leaveModalState();
  }
  if (!opened) {
    await answerOf(answer).catch(err =>
      Assert.ok(false, `askToPair threw ${err}`)
    );
  }
  Assert.ok(opened, "the alert opened");
  const doc = await dialogDocument();
  doc.querySelector(".sval-ap-deny").click();
  Assert.deepEqual(await answerOf(answer), { action: "deny" });
});

/**
 * The alert opens in a window that may be behind another app, so it asks
 * for the user's attention as it opens.
 */
add_task(async function the_alert_asks_for_the_users_attention() {
  const { BrowserWindowTracker } = ChromeUtils.importESModule(
    "resource:///modules/BrowserWindowTracker.sys.mjs"
  );
  const win = BrowserWindowTracker.getTopWindow();
  const { getAttention } = win;
  let asked = 0;
  win.getAttention = () => asked++;
  let answer;
  try {
    answer = askToPair("Test Agent");
    const doc = await dialogDocument();
    Assert.equal(asked, 1, "the user's attention was asked for");
    doc.querySelector(".sval-ap-deny").click();
  } finally {
    win.getAttention = getAttention;
  }
  Assert.deepEqual(await answerOf(answer), { action: "deny" });
});

/** The engine op pairing uses adds a workspace that carries the agent mark. */
add_task(async function a_paired_agents_workspace_carries_the_mark() {
  const engine = SvalPanel.engine;
  const id = await engine.mutate({
    kind: "addAgentWorkspace",
    name: "Test Agent",
    agentLabel: "Test Agent",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  const node = (await engine.tree()).nodes[id];
  Assert.equal(node.kind, "workspace");
  Assert.equal(node.agent.label, "Test Agent");
  Assert.ok(/^[0-9a-f]{32}$/.test(node.agent.device));
  await engine.mutate({ kind: "remove", id });
});

/** An app with a pairing on record is told to keep what that one had. */
add_task(async function pairing_again_says_what_is_kept() {
  const answer = askToPair("Test Agent", ["Task: A task"], false, true);
  const doc = await dialogDocument();
  const list = doc.getElementById("sval-ap-facts");
  Assert.ok(!list.hidden, "the list shows");
  Assert.ok(
    list.firstElementChild.dataset.again,
    "and starts with what the app keeps"
  );
  Assert.equal(list.children.length, 2, "ahead of the other facts");
  doc.querySelector(".sval-ap-deny").click();
  Assert.deepEqual(await answerOf(answer), { action: "deny" });
});
