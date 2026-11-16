/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * A call that waits for the user's answer about its writes (agent-control
 * spec §5.3): what it hears, what another input on the tab gets meanwhile,
 * what ends the wait, and the write a call that stopped waiting leaves
 * held.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

const FETCH = /button "Send by fetch" \[(e\d+)\]/;

/**
 * An action whose call carries a progress token waits for the answer about
 * its writes, the write held meanwhile, and hears Allow the moment it is
 * given.
 */
add_task(async function a_waiting_click_hears_the_answer_about_its_writes() {
  const { callWithProgress, win, tab, ref } = await writesSetup();
  const seen = requestsTo("/sval-fetch");
  const clicked = callWithProgress("click_element", { tab, ref: ref(FETCH) });
  const flag = settledFlag(clicked.result);
  const doc = await alertIn(win);
  await TestUtils.waitForCondition(
    () => clicked.progress.length,
    "the call reports progress"
  );
  Assert.ok(!flag.settled, "and is still waiting");
  Assert.equal(seen.started, 1);
  Assert.deepEqual(seen.stopped, [], "the write is held");
  await choose(doc, "allow");
  Assert.equal((await clicked.result).writes, "allowed");
  await stopped(seen);
  Assert.ok(Components.isSuccessCode(seen.stopped[0]), "the write went out");
});

/**
 * While one call waits for the answer about its writes, another input on
 * the same tab is refused at once with awaiting_approval, and is not
 * performed: it would send the same write again. No second alert opens,
 * Allow sends the write once, and then the tab acts again, a new write
 * asking again (spec §5.6).
 */
add_task(async function a_second_input_while_one_waits_is_refused_at_once() {
  const { callWithProgress, raw, win, alerts, tab, browser, ref } =
    await writesSetup();
  const seen = requestsTo("/sval-fetch");
  await SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    doc.body.dataset.clicks = "0";
    doc.getElementById("fetch").addEventListener("click", () => {
      doc.body.dataset.clicks = String(Number(doc.body.dataset.clicks) + 1);
    });
  });
  const first = callWithProgress("click_element", { tab, ref: ref(FETCH) });
  const flag = settledFlag(first.result);
  const doc = await alertIn(win);
  const again = await raw("click_element", { tab, ref: ref(FETCH) });
  Assert.strictEqual(again.isError, true);
  const body = JSON.parse(again.content[0].text);
  Assert.equal(body.error, "awaiting_approval", "refused at once");
  Assert.equal(body.writes, "awaiting_approval");
  Assert.equal(body.held, 1, "naming the write still held");
  Assert.ok(!flag.settled, "while the first call still waits");
  Assert.equal(
    await SpecialPowers.spawn(
      browser,
      [],
      () => content.document.body.dataset.clicks
    ),
    "1",
    "the second click was not performed"
  );
  await choose(doc, "allow");
  Assert.equal((await first.result).writes, "allowed");
  Assert.equal(alerts.opened, 1);
  await stopped(seen);
  Assert.equal(seen.started, 1, "one write");
  Assert.ok(Components.isSuccessCode(seen.stopped[0]), "Allow sent it");

  const third = callWithProgress("click_element", { tab, ref: ref(FETCH) });
  await choose(await alertIn(win), "deny");
  Assert.equal((await third.result).writes, "denied");
  Assert.equal(alerts.opened, 2, "a new write asks again");
});

add_task(async function access_going_off_ends_a_wait_about_writes() {
  const { callWithProgress, win, tab, ref } = await writesSetup();
  const clicked = callWithProgress("click_element", { tab, ref: ref(FETCH) });
  const flag = settledFlag(clicked.result);
  await alertIn(win);
  await TestUtils.waitForCondition(
    () => clicked.progress.length,
    "the call waits"
  );
  Assert.ok(!flag.settled);
  await agentAccessOff();
  await TestUtils.waitForCondition(
    () => flag.settled,
    "access going off ends the wait"
  );
  if (win.gDialogBox.isOpen) {
    await choose(await alertIn(win), "deny");
  }
});

/**
 * A call that stops waiting, as one the agent cancels does, leaves its
 * write held and the alert up, and a later Allow lets the write go.
 */
add_task(async function a_call_that_stops_waiting_leaves_the_write_held() {
  const { callWithProgress, win, tab, ref } = await writesSetup();
  const seen = requestsTo("/sval-fetch");
  const clicked = callWithProgress("click_element", { tab, ref: ref(FETCH) });
  const doc = await alertIn(win);
  await clicked.cancel();
  Assert.ok(win.gDialogBox.isOpen, "the alert stays up");
  Assert.equal(seen.started, 1);
  Assert.deepEqual(seen.stopped, [], "the write is still held");
  await choose(doc, "allow");
  await stopped(seen);
  Assert.ok(
    Components.isSuccessCode(seen.stopped[0]),
    "a later Allow lets it go"
  );
});
