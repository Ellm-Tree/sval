/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * How long the write gate holds a write (agent-control spec §5.3): a write
 * the input's page sends however late, after a slow read, after a failed
 * input, and after agent access is switched off.
 */

const { QUIET_MS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentWrites.sys.mjs"
);
const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

const FETCH = /button "Send by fetch" \[(e\d+)\]/;

/**
 * A write a page delays past the quiet window is the agent's all the same,
 * however late it is sent (spec §5.3): it is held, the user is asked about
 * it, and it waits for their answer. Until then, another input in the tab
 * is not performed, and Deny cancels the write, so it never goes out
 * unasked.
 */
add_task(async function a_write_the_page_delays_past_the_window_is_held() {
  const { call, raw, alerts, win, tab, browser, ref } = await writesSetup();
  const seen = requestsTo("/sval-late");
  const result = await call("click_element", {
    tab,
    ref: ref(/button "Send later" \[(e\d+)\]/),
  });
  Assert.equal(result.writes, "none", "nothing was written during the click");
  Assert.equal(seen.started, 0, "the page has not written yet");
  // The click's window has closed, and the page writes.
  await SpecialPowers.spawn(browser, [], () =>
    content.postMessage("late", "*")
  );
  const doc = await alertIn(win);
  Assert.equal(alerts.opened, 1, "the delayed write is asked about");
  Assert.deepEqual(heldRequests(doc), [
    { method: "POST", target: "example.com", path: "/sval-late" },
  ]);
  Assert.equal(seen.stopped.length, 0, "and waits for the answer");
  const again = await raw("click_element", { tab, ref: ref(FETCH) });
  Assert.equal(
    JSON.parse(again.content[0].text).error,
    "awaiting_approval",
    "another input waits for the answer too"
  );
  await choose(doc, "deny");
  await stopped(seen);
  Assert.deepEqual(seen.stopped, [Cr.NS_ERROR_ABORT], "Deny cancelled it");
});

/**
 * An input that fails partway still reports the writes it set off: here the
 * page writes on the first key and takes focus away, so typing stops with
 * `not_focusable`.
 */
add_task(async function a_failed_type_still_reports_its_writes() {
  const { raw, win, tab, browser, ref } = await writesSetup();
  const seen = requestsTo("/sval-keyed");
  await SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    const email = doc.getElementById("email");
    email.addEventListener(
      "keydown",
      () => {
        content.fetch("https://example.com/sval-keyed", {
          method: "POST",
          body: "k",
        });
        doc.getElementById("pw").focus();
      },
      { once: true }
    );
  });
  const typed = raw("type_text", {
    tab,
    ref: ref(/textbox "Email" \[(e\d+)\]/),
    text: "abc",
  });
  const doc = await alertIn(win);
  Assert.deepEqual(heldRequests(doc), [
    { method: "POST", target: "example.com", path: "/sval-keyed" },
  ]);
  await choose(doc, "deny");
  const result = await typed;
  Assert.strictEqual(result.isError, true);
  const body = JSON.parse(result.content[0].text);
  Assert.equal(body.error, "not_focusable");
  Assert.ok(body.message.startsWith("not_focusable: "), body.message);
  Assert.equal(body.tab, tab);
  Assert.equal(body.writes, "denied", "the failure still says what was sent");
  Assert.equal(body.held, 1);
  await stopped(seen);
  Assert.deepEqual(seen.stopped, [Cr.NS_ERROR_ABORT]);
});

/**
 * The window waits for the network to go quiet, not only for requests to
 * stop starting: a handler that awaits a slow read and then writes is held.
 */
add_task(async function a_write_after_a_slow_read_is_still_held() {
  const { call, win, tab, browser, ref } = await writesSetup();
  const seen = requestsTo("/sval-fetch");
  const slow = ROOT + "sval_agent_slow.sjs";
  const key = crypto.randomUUID();
  const reads = requestsTo(new URL(slow).pathname);
  await SpecialPowers.spawn(browser, [slow, key], (url, held) => {
    const button = content.document.getElementById("fetch");
    button.onclick = null;
    button.addEventListener("click", async () => {
      await content.fetch(`${url}?hold=${held}`);
      content.fetch("https://example.com/sval-fetch", {
        method: "POST",
        body: "x",
      });
    });
  });
  const clicked = call("click_element", { tab, ref: ref(FETCH) });
  await TestUtils.waitForCondition(() => reads.started, "the read started");
  // The read outlasts the quiet time the window would close after if it
  // waited only for requests to stop starting.
  await timePassed(performance.now(), 3 * QUIET_MS, "the read outlasts quiet");
  await fetch(`${slow}?release=${key}`);
  const doc = await alertIn(win);
  Assert.deepEqual(heldRequests(doc), [
    { method: "POST", target: "example.com", path: "/sval-fetch" },
  ]);
  await choose(doc, "deny");
  Assert.equal((await clicked).writes, "denied");
  await stopped(seen);
  Assert.deepEqual(seen.stopped, [Cr.NS_ERROR_ABORT]);
});

/**
 * Agent access switched off mid-action fails closed: a write the action's
 * page sends afterwards is cancelled.
 */
add_task(async function a_write_after_access_is_switched_off_is_cancelled() {
  const { call, alerts, tab, browser, ref } = await writesSetup({
    level: "full",
  });
  const seen = requestsTo("/sval-closed");
  // The page writes once a read it awaits comes back, which the test
  // releases after switching access off.
  const slow = ROOT + "sval_agent_slow.sjs";
  const key = crypto.randomUUID();
  const reads = requestsTo(new URL(slow).pathname);
  await SpecialPowers.spawn(browser, [slow, key], (url, held) => {
    const button = content.document.getElementById("fetch");
    button.onclick = null;
    button.addEventListener("click", async () => {
      await content.fetch(`${url}?hold=${held}`).catch(() => {});
      content.fetch("https://example.com/sval-closed", {
        method: "POST",
        body: "x",
      });
    });
  });
  const clicked = call("click_element", { tab, ref: ref(FETCH) });
  await TestUtils.waitForCondition(() => reads.started, "the click landed");
  await agentAccessOff();
  await fetch(`${slow}?release=${key}`);
  // Access going off closes the agent's connection, with no reply.
  await Assert.rejects(clicked, e => e.name === "AgentConnectionClosed");
  await stopped(seen);
  Assert.deepEqual(
    seen.stopped,
    [Cr.NS_ERROR_ABORT],
    "the write was cancelled"
  );
  Assert.equal(alerts.opened, 0);
});
