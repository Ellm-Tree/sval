/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_answer_dialog_helpers.js */

/**
 * The agent answers a page's `confirm` and `prompt` (agent-control spec §4.1):
 * the tool whose input raised one returns as soon as it opens, and
 * `answer_dialog` answers it through the write gate, for a dialog whose page
 * and frame are on sites the agent may act on. A dialog from a frame of a
 * Blocked or undecided site, a refused site or a frame of unknown site is the
 * user's to answer.
 *
 * `browser_sval_agent_dialog_holds_the_tab.js` covers what an open dialog
 * holds back.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);
const { setPageTimeoutForTests } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentPageParent.sys.mjs"
);

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_answer_dialog_helpers.js",
  this
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

add_task(async function a_confirm_returns_the_click_and_waits_for_the_agent() {
  // A timeout shorter than the test's own waits, so the dialog is what ends
  // the click.
  atTaskEnd(setPageTimeoutForTests(3000));
  const setup = await dialogsSetup();
  const { call, tab, browser } = setup;
  const ref = await buttonRunning(setup, CONFIRM);
  const started = Date.now();
  const clicked = await call("click_element", { tab, ref });
  Assert.less(
    Date.now() - started,
    3000,
    "the click returned before its timeout"
  );
  Assert.deepEqual(clicked.dialog, {
    type: "confirm",
    message: "Delete everything?",
  });
  Assert.strictEqual(clicked.dialog_open, true);
  Assert.equal(clicked.error, undefined, "the click itself did not fail");
  Assert.equal(clicked.writes, "none");
  Assert.equal(dialogsUp(browser), 1, "the confirm stays up");
  Assert.equal(await answerIn(browser), undefined, "and is not answered");

  const answered = await call("answer_dialog", { tab, accept: true });
  Assert.equal(answered.tab, tab);
  Assert.equal(answered.writes, "none");
  Assert.equal(answered.dialog_open, undefined, "no dialog is open now");
  Assert.equal(
    await nextAnswerIn(browser),
    "true",
    "the page got the agent's yes"
  );
  await TestUtils.waitForCondition(() => !dialogsUp(browser), "it closed");
});

add_task(async function a_confirm_can_be_cancelled() {
  const setup = await dialogsSetup();
  const ref = await buttonRunning(setup, CONFIRM);
  await setup.call("click_element", { tab: setup.tab, ref });
  await setup.call("answer_dialog", { tab: setup.tab, accept: false });
  Assert.equal(await nextAnswerIn(setup.browser), "false", "confirm said no");
});

add_task(async function a_prompt_takes_the_agents_text() {
  const setup = await dialogsSetup();
  const { call, tab, browser } = setup;
  const ref = await buttonRunning(
    setup,
    "document.body.dataset.answer = String(prompt('Your name?', 'Ada'))"
  );
  const clicked = await call("click_element", { tab, ref });
  Assert.deepEqual(clicked.dialog, { type: "prompt", message: "Your name?" });
  Assert.strictEqual(clicked.dialog_open, true);
  await call("answer_dialog", { tab, accept: true, text: "Grace" });
  Assert.equal(await nextAnswerIn(browser), "Grace");

  await call("click_element", { tab, ref });
  await call("answer_dialog", { tab, accept: true });
  Assert.equal(
    await nextAnswerIn(browser, "Grace"),
    "Ada",
    "with no text, the prompt keeps what the page put in it"
  );

  await call("click_element", { tab, ref });
  await call("answer_dialog", { tab, accept: false, text: "ignored" });
  Assert.equal(
    await nextAnswerIn(browser, "Ada"),
    "null",
    "cancelling answers null"
  );
});

add_task(async function answering_with_no_dialog_open_is_no_dialog() {
  const { call, tab } = await dialogsSetup();
  await Assert.rejects(
    call("answer_dialog", { tab, accept: true }),
    e => e.code === "no_dialog",
    "nothing to answer"
  );
});

/**
 * Accepting is what sends the delete, so the answer is an input like a
 * click: the write it sets off is held for the user.
 */
add_task(async function accepting_a_confirm_holds_the_write_it_sends() {
  const setup = await dialogsSetup({ level: "ask-before-writes" });
  const { call, win, tab } = setup;
  const ref = await buttonRunning(
    setup,
    "if (confirm('Delete it?')) fetch('https://example.com/sval-delete', {method: 'POST', body: 'x'})"
  );
  const clicked = await call("click_element", { tab, ref });
  Assert.equal(clicked.writes, "none", "nothing was sent before the answer");
  const answering = call("answer_dialog", { tab, accept: true });
  const doc = await alertIn(win);
  Assert.deepEqual(
    heldRequests(doc),
    [{ method: "POST", target: "example.com", path: "/sval-delete" }],
    "the delete the answer sent is held"
  );
  await choose(doc, "deny");
  Assert.equal((await answering).writes, "denied");
});

/**
 * "Don't allow this site to prompt you again" is never ticked, so a page that
 * asks again can still ask.
 */
add_task(async function the_silencing_checkbox_is_never_ticked() {
  // The test profile turns the offer off (testing/profiles/unittest-required/
  // user.js); a page's successive dialogs carry it in a normal profile.
  await SpecialPowers.pushPrefEnv({
    set: [["dom.successive_dialog_time_limit", 3]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const setup = await dialogsSetup();
  const { call, tab, browser } = setup;
  const ref = await buttonRunning(
    setup,
    "document.body.dataset.answer = [confirm('one'), confirm('two'), confirm('three')].join()"
  );
  await call("click_element", { tab, ref });
  let offered = 0;
  for (let i = 0; i < 3; i++) {
    await TestUtils.waitForCondition(
      () => setup.dialogs.openDialog(browser),
      `dialog ${i + 1} is up`
    );
    const { Dialog } = browser.documentGlobal.gBrowser
      .getTabDialogBox(browser)
      .getContentDialogManager().dialogs[0].frameContentWindow;
    if (!Dialog.ui.checkboxContainer.hidden) {
      offered++;
    }
    await call("answer_dialog", { tab, accept: true });
  }
  Assert.greater(offered, 0, "Firefox offered the checkbox");
  Assert.equal(
    await nextAnswerIn(browser),
    "true,true,true",
    "every dialog the page asked for opened and was answered"
  );
});

/**
 * Opens an example.org frame in `browser`'s page that raises a confirm from
 * a timer, and waits for it.
 *
 * @param {object} setup What `dialogsSetup` returned.
 * @returns {Promise<BrowsingContext>} The frame's.
 */
async function frameConfirm(setup) {
  const { browser } = setup;
  await SpecialPowers.spawn(browser, [ORG_PAGE], async src => {
    const frame = content.document.createElement("iframe");
    frame.src = src;
    const loaded = new Promise(resolve =>
      frame.addEventListener("load", resolve, { once: true })
    );
    content.document.body.append(frame);
    await loaded;
  });
  const frame = browser.browsingContext.children.at(-1);
  await SpecialPowers.spawn(frame, [], () => {
    content.setTimeout(() => {
      content.document.body.dataset.answer = String(
        content.confirm("a secret")
      );
    }, 0);
  });
  await TestUtils.waitForCondition(
    () => setup.dialogs.openDialog(browser),
    "the frame's confirm is up"
  );
  return frame;
}

/**
 * A dialog from a frame of a site the user has not decided on is the user's
 * to answer, as a Blocked frame's is: its answer resumes that site's script,
 * which the user never let the agent act on. Its words stay withheld.
 */
add_task(async function an_undecided_frames_dialog_is_the_users() {
  const setup = await dialogsSetup();
  const { raw, call, tab, browser } = setup;
  const frame = await frameConfirm(setup);
  const refused = bodyOf(await raw("get_snapshot", { tab }));
  Assert.deepEqual(refused.dialog, { type: "withheld", message: "" });
  await Assert.rejects(
    call("answer_dialog", { tab, accept: true }),
    e => e.code === "policy_denied" && /example\.org/.test(e.message),
    "the answer is refused, naming the frame's site"
  );
  Assert.equal(dialogsUp(browser), 1, "the confirm stays up for the user");
  Assert.equal(
    await SpecialPowers.spawn(
      frame,
      [],
      () => content.document.body.dataset.answer
    ),
    undefined,
    "the frame got no answer"
  );
  await setup.call("close_tab", { tab });
});

/**
 * A dialog a frame from a Blocked site raised is not the agent's to answer:
 * its answer resumes that site's script.
 */
add_task(async function a_blocked_frames_dialog_cannot_be_answered() {
  const setup = await dialogsSetup();
  const { call, store, agent, tab, browser } = setup;
  await store.setSiteLevel(agent.agentId, "example.org", "blocked");
  const frame = await frameConfirm(setup);
  await Assert.rejects(
    call("answer_dialog", { tab, accept: true }),
    e => e.code === "policy_denied",
    "the answer is refused"
  );
  Assert.equal(dialogsUp(browser), 1, "the confirm stays up for the user");
  Assert.equal(
    await SpecialPowers.spawn(
      frame,
      [],
      () => content.document.body.dataset.answer
    ),
    undefined
  );
  await setup.call("close_tab", { tab });
});

/**
 * Answering resumes the page's script, so the page's own site must be one the
 * agent may act on now, as for any other input. A site blocked while its
 * confirm is open refuses the answer, and the dialog stays for the user.
 */
add_task(async function a_dialog_on_a_refused_site_cannot_be_answered() {
  const setup = await dialogsSetup();
  const { call, store, agent, tab, browser } = setup;
  const ref = await buttonRunning(setup, CONFIRM);
  await call("click_element", { tab, ref });
  await store.setSiteLevel(agent.agentId, "example.com", "blocked");
  await Assert.rejects(
    call("answer_dialog", { tab, accept: true }),
    e => e.code === "policy_denied",
    "the answer is refused"
  );
  Assert.equal(dialogsUp(browser), 1, "the confirm stays up");
  Assert.ok(setup.dialogs.openDialog(browser), "and open for the user");
  Assert.equal(await answerIn(browser), undefined, "nobody answered it");
  await call("close_tab", { tab });
});

add_task(async function a_dialog_from_a_frame_of_unknown_site_is_refused() {
  const setup = await dialogsSetup();
  const { call, dialogs, tab, browser } = setup;
  const ref = await buttonRunning(setup, CONFIRM);
  await setup.call("click_element", { tab, ref });
  const openDialog = dialogs.openDialog;
  dialogs.openDialog = b => {
    const report = openDialog.call(dialogs, b);
    return report && { ...report, sites: [report.sites[0], undefined] };
  };
  atTaskEnd(() => (dialogs.openDialog = openDialog));
  await Assert.rejects(
    call("answer_dialog", { tab, accept: true }),
    e => e.code === "policy_denied",
    "the answer is refused"
  );
  Assert.equal(dialogsUp(browser), 1, "the confirm stays up for the user");
  dialogs.openDialog = openDialog;
  await setup.call("answer_dialog", { tab, accept: false });
});
