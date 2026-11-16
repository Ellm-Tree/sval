/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * The write gate (agent-control spec §5.3): a write an agent's input sets off
 * waits for the user, on the real gate, tools and page, and the answer and
 * the site's level decide whether it goes out. How long it is held, and what
 * a call waiting on it hears, is `browser_sval_agent_writes_held.js`.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

const FETCH = /button "Send by fetch" \[(e\d+)\]/;

add_task(async function deny_cancels_a_fetch_the_click_sent() {
  const { call, win, alerts, tab, ref } = await writesSetup();
  const seen = requestsTo("/sval-fetch");
  const clicked = call("click_element", { tab, ref: ref(FETCH) });
  const doc = await alertIn(win);
  Assert.equal(
    doc.querySelector(".sval-aa").dataset.kind,
    "writes",
    "the alert asks about the writes the agent's input sent"
  );
  Assert.ok(
    doc.getElementById("sval-aa-question").textContent.includes(AGENT_LABEL),
    "it names the agent"
  );
  Assert.ok(!doc.getElementById("sval-aa-detail").hidden, "it says why");
  Assert.deepEqual(heldRequests(doc), [
    { method: "POST", target: "example.com", path: "/sval-fetch" },
  ]);
  const buttons = [...doc.querySelectorAll(".sval-aa-actions button")];
  Assert.deepEqual(
    buttons.map(b => b.dataset.choice),
    ["allow", "allow_always", "deny_always", "deny"],
    "the grants stack from the top, the safe answer last"
  );
  Assert.ok(
    buttons.slice(1, 3).every(b => b.textContent.includes("example.com")),
    "the always choices name the site"
  );
  Assert.equal(
    doc.activeElement?.dataset.choice,
    "deny",
    "Deny is the default"
  );
  Assert.equal(seen.started, 1, "the request started");
  Assert.deepEqual(seen.stopped, [], "and waits for the user");
  await choose(doc, "deny");
  const result = await clicked;
  Assert.equal(result.writes, "denied");
  await stopped(seen);
  Assert.deepEqual(
    seen.stopped,
    [Cr.NS_ERROR_ABORT],
    "the request was cancelled before it reached the server"
  );
  Assert.equal(alerts.opened, 1);
});

add_task(async function allow_lets_a_form_post_through_and_the_page_moves() {
  const { call, win, tab, browser, ref } = await writesSetup();
  const seen = requestsTo("/sval-form");
  const clicked = call("click_element", {
    tab,
    ref: ref(/button "Sign in" \[(e\d+)\]/),
  });
  const doc = await alertIn(win);
  Assert.deepEqual(heldRequests(doc), [
    { method: "POST", target: "example.com", path: "/sval-form" },
  ]);
  await choose(doc, "allow");
  const result = await clicked;
  Assert.equal(result.writes, "allowed");
  await stopped(seen);
  Assert.ok(Components.isSuccessCode(seen.stopped[0]), "the post went out");
  await TestUtils.waitForCondition(
    () => browser.currentURI.filePath === "/sval-form",
    "the page moved to where the form posted"
  );
});

/**
 * Allow answers for the writes one action sent: the agent's next click on
 * the same button asks again.
 */
add_task(async function allow_covers_one_action() {
  const { call, win, alerts, tab, ref } = await writesSetup();
  const seen = requestsTo("/sval-fetch");
  const first = call("click_element", { tab, ref: ref(FETCH) });
  await choose(await alertIn(win), "allow");
  Assert.equal((await first).writes, "allowed");
  // The stops are listed in the order they come, and an allowed request can
  // still be on the network when the next one is cancelled.
  await stopped(seen, 1);
  const second = call("click_element", { tab, ref: ref(FETCH) });
  const doc = await alertIn(win);
  Assert.equal(alerts.opened, 2, "the next click's write asks again");
  await choose(doc, "deny");
  Assert.equal((await second).writes, "denied");
  await stopped(seen, 2);
  Assert.ok(Components.isSuccessCode(seen.stopped[0]));
  Assert.equal(seen.stopped[1], Cr.NS_ERROR_ABORT);
});

/**
 * "Always deny writes on this site" sets the site to Read only in the
 * policy (spec §5.3), so its writes are refused without an alert, in this
 * task or any later one.
 */
add_task(async function always_denying_a_site_makes_it_read_only() {
  const { call, store, agent, win, alerts, tab, ref } = await writesSetup();
  const seen = requestsTo("/sval-fetch");
  const first = call("click_element", { tab, ref: ref(FETCH) });
  await choose(await alertIn(win), "deny_always");
  Assert.equal((await first).writes, "denied");
  Assert.equal(
    store.policyOf(agent.agentId).sites["example.com"],
    "read-only",
    "the site is Read only in the policy"
  );
  const second = await call("click_element", { tab, ref: ref(FETCH) });
  Assert.equal(second.writes, "refused_read_only", "refused unasked");
  Assert.equal(alerts.opened, 1, "no second alert");
  await stopped(seen, 2);
  Assert.ok(seen.stopped.every(s => s === Cr.NS_ERROR_ABORT));
});

/**
 * "Always allow writes on this site" sets the site to Full access in the
 * policy (spec §5.3), so its writes are never held again, in this task or any
 * later one.
 */
add_task(async function always_allowing_a_site_makes_it_full_access() {
  const { call, store, agent, win, alerts, tab, ref } = await writesSetup();
  const seen = requestsTo("/sval-fetch");
  const first = call("click_element", { tab, ref: ref(FETCH) });
  await choose(await alertIn(win), "allow_always");
  Assert.equal((await first).writes, "allowed");
  Assert.equal(
    store.policyOf(agent.agentId).sites["example.com"],
    "full",
    "the site is Full access in the policy"
  );
  const second = await call("click_element", { tab, ref: ref(FETCH) });
  Assert.equal(second.writes, "allowed", "the next write went through unasked");
  Assert.equal(alerts.opened, 1, "no second alert");
  await stopped(seen, 2);
  Assert.ok(seen.stopped.every(s => Components.isSuccessCode(s)));
});

add_task(async function read_only_refuses_a_write_without_asking() {
  const { call, alerts, tab, ref } = await writesSetup({ level: "read-only" });
  const seen = requestsTo("/sval-fetch");
  const result = await call("click_element", { tab, ref: ref(FETCH) });
  Assert.equal(result.writes, "refused_read_only");
  await stopped(seen);
  Assert.deepEqual(seen.stopped, [Cr.NS_ERROR_ABORT]);
  Assert.equal(alerts.opened, 0, "no alert");
});

/**
 * A write from a Full-access page to a site the user blocked is refused
 * unasked, as a held one is refused whatever the user answers.
 */
add_task(async function a_full_access_page_sends_nothing_to_a_blocked_site() {
  const { call, store, agent, alerts, tab, browser } = await writesSetup({
    level: "full",
  });
  await store.setSiteLevel(agent.agentId, "example.org", "blocked");
  await SpecialPowers.spawn(browser, [], () => {
    const button = content.document.createElement("button");
    button.textContent = "Send elsewhere";
    button.setAttribute(
      "onclick",
      "fetch('https://example.org/sval-fetch', {method: 'POST', body: 'x'})"
    );
    content.document.body.prepend(button);
  });
  const { snapshot } = await call("get_snapshot", { tab });
  const ref = snapshot.match(/button "Send elsewhere" \[(e\d+)\]/)[1];
  const seen = requestsTo("/sval-fetch", "example.org");
  const result = await call("click_element", { tab, ref });
  Assert.equal(result.writes, "refused_read_only");
  await stopped(seen);
  Assert.deepEqual(seen.stopped, [Cr.NS_ERROR_ABORT]);
  Assert.equal(alerts.opened, 0, "no alert");
});

/**
 * Under a Blocked default, a site with no rule is left to the page's level:
 * a Full-access page's write to it goes out.
 */
add_task(async function a_blocked_default_leaves_an_unlisted_target_alone() {
  const { call, store, agent, alerts, tab, browser } = await writesSetup({
    level: "full",
  });
  await store.setDefault(agent.agentId, "blocked");
  await SpecialPowers.spawn(browser, [], () => {
    const button = content.document.createElement("button");
    button.textContent = "Send elsewhere";
    button.setAttribute(
      "onclick",
      "fetch('https://example.org/sval-fetch', {method: 'POST', body: 'x'})"
    );
    content.document.body.prepend(button);
  });
  const { snapshot } = await call("get_snapshot", { tab });
  const ref = snapshot.match(/button "Send elsewhere" \[(e\d+)\]/)[1];
  // The server's answer proves the write went out. The channel's status at
  // its stop cannot: the answer lacks CORS headers, and the content
  // process's cancel for that reaches the parent before or after its stop.
  const answered = TestUtils.topicObserved(
    "http-on-examine-response",
    subject => {
      const { URI } = subject.QueryInterface(Ci.nsIHttpChannel);
      return URI.host === "example.org" && URI.filePath === "/sval-fetch";
    }
  );
  const result = await call("click_element", { tab, ref });
  Assert.equal(result.writes, "allowed");
  await within(answered, 10_000, "the server's answer to the write");
  Assert.equal(alerts.opened, 0, "no alert");
});

/**
 * A page's frame opens a blank popup and writes from it. The popup holds
 * the frame's site's content, so the write is decided at that site's level,
 * not at the level a page with no site would get.
 */
add_task(async function a_blank_popup_writes_at_its_makers_level() {
  // The frame opens the popup from a message, which carries no user
  // activation.
  await SpecialPowers.pushPrefEnv({
    set: [["dom.disable_open_during_load", false]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const { call, store, agent, alerts, tab, browser } = await writesSetup({
    level: "full",
  });
  await store.setSiteLevel(agent.agentId, "example.org", "read-only");
  await SpecialPowers.spawn(browser, [ORG_PAGE], async src => {
    const doc = content.document;
    const frame = doc.createElement("iframe");
    frame.src = src;
    const loaded = new Promise(resolve =>
      frame.addEventListener("load", resolve, { once: true })
    );
    doc.body.append(frame);
    await loaded;
    const button = doc.createElement("button");
    button.textContent = "Tell the frame";
    button.setAttribute(
      "onclick",
      "document.querySelector('iframe').contentWindow.postMessage('go', '*')"
    );
    doc.body.prepend(button);
  });
  await SpecialPowers.spawn(browser.browsingContext.children[0], [], () => {
    // Page script, so the popup is the frame's own.
    const script = content.document.createElement("script");
    script.textContent = `addEventListener("message", () => {
      const w = window.open("about:blank", "_blank");
      w.fetch("https://example.com/sval-fetch", { method: "POST", body: "x" });
    });`;
    content.document.body.append(script);
  });
  const { snapshot } = await call("get_snapshot", { tab });
  const ref = snapshot.match(/button "Tell the frame" \[(e\d+)\]/)[1];
  const seen = requestsTo("/sval-fetch");
  const result = await call("click_element", { tab, ref });
  Assert.equal(result.writes, "refused_read_only");
  await stopped(seen);
  Assert.deepEqual(seen.stopped, [Cr.NS_ERROR_ABORT]);
  Assert.equal(alerts.opened, 0, "no alert");
});

/**
 * "Always" never overwrites a site blocked while the user decided, and a
 * site blocked meanwhile has its writes denied whatever the answer.
 */
add_task(async function always_never_overwrites_a_blocked_site() {
  const { call, store, agent, win, tab, ref } = await writesSetup();
  const seen = requestsTo("/sval-fetch");
  const clicked = call("click_element", { tab, ref: ref(FETCH) });
  const doc = await alertIn(win);
  await store.setSiteLevel(agent.agentId, "example.com", "blocked");
  await choose(doc, "allow_always");
  Assert.equal((await clicked).writes, "denied");
  Assert.equal(
    store.policyOf(agent.agentId).sites["example.com"],
    "blocked",
    "the site stays blocked"
  );
  await stopped(seen);
  Assert.deepEqual(seen.stopped, [Cr.NS_ERROR_ABORT]);
});
