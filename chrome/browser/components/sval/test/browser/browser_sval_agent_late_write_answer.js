/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * What the user's answer about an agent's writes covers (agent-control spec
 * §5.3): Allow and Deny answer for the writes the alert lists alone, so the
 * page's next write, such as an autosave, is asked about again. "Always
 * allow" and "Always deny" set the site's level, which decides every later
 * write without an alert.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

const LATER = /button "Send later" \[(e\d+)\]/;
const FETCH = /button "Send by fetch" \[(e\d+)\]/;

/**
 * The page "Send later" was clicked on writes, once the click's window has
 * closed.
 *
 * @param {object} browser
 */
function sendLate(browser) {
  return SpecialPowers.spawn(browser, [], () =>
    content.postMessage("late", "*")
  );
}

/**
 * @param {Document} doc An alert.
 * @returns {object[]} The requests it lists (`heldRequests`).
 */
const listed = doc => heldRequests(doc);

/**
 * Sends a write from the page `browser` shows, as its own timer would.
 *
 * @param {object} browser
 * @param {string} path
 */
function pageWrites(browser, path) {
  return SpecialPowers.spawn(browser, [path], p => {
    content.fetch(`https://example.com${p}`, { method: "POST", body: "x" });
  });
}

/**
 * The agent clicks a button whose page writes after the action is done,
 * and the user is asked about it.
 *
 * @param {object} setup `writesSetup`'s result.
 * @returns {Promise<Document>} The alert.
 */
async function askedAboutALateWrite(setup) {
  const { call, win, tab, ref } = setup;
  const result = await call("click_element", { tab, ref: ref(LATER) });
  Assert.equal(result.writes, "none", "nothing was written during the click");
  await sendLate(setup.browser);
  return alertIn(win);
}

add_task(async function allow_sends_only_the_late_writes_it_lists() {
  const setup = await writesSetup();
  const { alerts, browser, win } = setup;
  const late = requestsTo("/sval-late");
  const doc = await askedAboutALateWrite(setup);
  Assert.equal(
    doc.querySelector(".sval-aa").dataset.kind,
    "late-writes",
    "the alert asks about writes sent after the agent was done"
  );
  Assert.deepEqual(listed(doc), [
    { method: "POST", target: "example.com", path: "/sval-late" },
  ]);
  await choose(doc, "allow");
  await stopped(late);
  Assert.ok(Components.isSuccessCode(late.stopped[0]), "Allow sent the write");

  const autosave = requestsTo("/sval-autosave");
  await pageWrites(browser, "/sval-autosave");
  const again = await alertIn(win);
  Assert.equal(alerts.opened, 2, "the page's next late write asks again");
  Assert.deepEqual(listed(again), [
    { method: "POST", target: "example.com", path: "/sval-autosave" },
  ]);
  Assert.deepEqual(autosave.stopped, [], "and waits for the answer");
  await choose(again, "deny");
  await stopped(autosave);
  Assert.deepEqual(autosave.stopped, [Cr.NS_ERROR_ABORT]);
});

add_task(async function deny_refuses_only_the_late_writes_it_lists() {
  const setup = await writesSetup();
  const { alerts, browser, win } = setup;
  const late = requestsTo("/sval-late");
  await choose(await askedAboutALateWrite(setup), "deny");
  await stopped(late);
  Assert.deepEqual(late.stopped, [Cr.NS_ERROR_ABORT], "Deny cancelled it");

  const autosave = requestsTo("/sval-autosave");
  await pageWrites(browser, "/sval-autosave");
  const again = await alertIn(win);
  Assert.equal(alerts.opened, 2, "the page's next late write asks again");
  await choose(again, "allow");
  await stopped(autosave);
  Assert.ok(Components.isSuccessCode(autosave.stopped[0]));
});

/**
 * A write the page sends while the user is still deciding is not part of
 * what the alert lists, so it is asked about in an alert of its own once
 * that one is answered.
 */
add_task(async function a_write_sent_while_the_alert_is_up_asks_for_itself() {
  const setup = await writesSetup();
  const { alerts, browser, win } = setup;
  const late = requestsTo("/sval-late");
  const beat = requestsTo("/sval-beat");
  const doc = await askedAboutALateWrite(setup);
  await pageWrites(browser, "/sval-beat");
  await TestUtils.waitForCondition(() => beat.started, "the page writes again");
  Assert.deepEqual(beat.stopped, [], "the write waits");
  Assert.deepEqual(
    listed(doc),
    [{ method: "POST", target: "example.com", path: "/sval-late" }],
    "outside the alert that is up"
  );
  await choose(doc, "allow");
  await stopped(late);
  Assert.ok(Components.isSuccessCode(late.stopped[0]));

  await TestUtils.waitForCondition(
    () => alerts.opened === 2,
    "the waiting write is asked about"
  );
  const next = await alertIn(win);
  Assert.deepEqual(listed(next), [
    { method: "POST", target: "example.com", path: "/sval-beat" },
  ]);
  await choose(next, "deny");
  await stopped(beat);
  Assert.deepEqual(beat.stopped, [Cr.NS_ERROR_ABORT], "the Allow before it");
});

add_task(async function allow_on_the_agents_click_sends_only_its_writes() {
  const { call, alerts, win, tab, browser, ref } = await writesSetup();
  const clicked = call("click_element", { tab, ref: ref(FETCH) });
  const doc = await alertIn(win);
  Assert.equal(
    doc.querySelector(".sval-aa").dataset.kind,
    "writes",
    "the alert asks about the writes the agent's click sent"
  );
  await choose(doc, "allow");
  Assert.equal((await clicked).writes, "allowed");

  const autosave = requestsTo("/sval-autosave");
  await pageWrites(browser, "/sval-autosave");
  const again = await alertIn(win);
  Assert.equal(alerts.opened, 2, "the page's later autosave asks");
  await choose(again, "deny");
  await stopped(autosave);
  Assert.deepEqual(autosave.stopped, [Cr.NS_ERROR_ABORT]);
});

add_task(async function always_allow_sends_the_sites_later_writes_unasked() {
  const setup = await writesSetup();
  const { alerts, browser, store, agent } = setup;
  const late = requestsTo("/sval-late");
  const doc = await askedAboutALateWrite(setup);
  const buttons = [...doc.querySelectorAll(".sval-aa-actions button")];
  Assert.deepEqual(
    buttons.map(b => b.dataset.choice),
    ["allow", "allow_always", "deny_always", "deny"]
  );
  Assert.ok(
    buttons.slice(1, 3).every(b => b.textContent.includes("example.com")),
    "the always choices name the site"
  );
  await choose(doc, "allow_always");
  await stopped(late);
  Assert.ok(Components.isSuccessCode(late.stopped[0]));
  Assert.equal(
    store.policyOf(agent.agentId).sites["example.com"],
    "full",
    "the site is Full access"
  );

  const autosave = requestsTo("/sval-autosave");
  await pageWrites(browser, "/sval-autosave");
  await stopped(autosave);
  Assert.ok(Components.isSuccessCode(autosave.stopped[0]));
  Assert.equal(alerts.opened, 1, "without another alert");
});

add_task(async function always_deny_refuses_the_sites_later_writes_unasked() {
  const setup = await writesSetup();
  const { alerts, browser, store, agent } = setup;
  const late = requestsTo("/sval-late");
  await choose(await askedAboutALateWrite(setup), "deny_always");
  await stopped(late);
  Assert.deepEqual(late.stopped, [Cr.NS_ERROR_ABORT]);
  Assert.equal(
    store.policyOf(agent.agentId).sites["example.com"],
    "read-only",
    "the site is Read only"
  );

  const autosave = requestsTo("/sval-autosave");
  await pageWrites(browser, "/sval-autosave");
  await stopped(autosave);
  Assert.deepEqual(autosave.stopped, [Cr.NS_ERROR_ABORT]);
  Assert.equal(alerts.opened, 1, "without another alert");
});
