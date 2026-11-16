/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * An Allow on a page's late writes releases each one only as the policy
 * stands when it is given (agent-control spec §5.3).
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

const LATER = /button "Send later" \[(e\d+)\]/;

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
 * Sends a write from the page `browser` shows to any address, as its own
 * timer would.
 *
 * @param {object} browser
 * @param {string} url
 */
function pageWritesTo(browser, url) {
  return SpecialPowers.spawn(browser, [url], u => {
    content.fetch(u, { method: "POST", body: "x", mode: "no-cors" });
  });
}

/**
 * Records how the requests to `url` ended.
 *
 * @param {string} url
 * @returns {{started: number, stopped: number[]}}
 */
function requestsToUrl(url) {
  const seen = { started: 0, stopped: [] };
  const observer = {
    observe(subject, topic) {
      const channel = subject.QueryInterface(Ci.nsIHttpChannel);
      if (channel.URI.spec !== url) {
        return;
      }
      if (topic === "http-on-modify-request") {
        seen.started++;
      } else {
        seen.stopped.push(channel.status);
      }
    },
  };
  Services.obs.addObserver(observer, "http-on-modify-request");
  Services.obs.addObserver(observer, "http-on-stop-request");
  atTaskEnd(() => {
    Services.obs.removeObserver(observer, "http-on-modify-request");
    Services.obs.removeObserver(observer, "http-on-stop-request");
  });
  return seen;
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

/**
 * @param {Document} doc An alert.
 * @returns {object[]} The requests it lists (`heldRequests`).
 */
const listed = doc => heldRequests(doc);

/**
 * A write to a site the user blocked while the alert was up is cancelled,
 * whatever the answer.
 */
add_task(async function allow_refuses_a_target_blocked_meanwhile() {
  const setup = await writesSetup();
  const { call, store, agent, win, tab, browser } = setup;
  await call("scroll_page", { tab, direction: "down" });
  const cross = "https://example.org/sval-cross";
  const toOrg = requestsToUrl(cross);
  await pageWritesTo(browser, cross);
  const doc = await alertIn(win);
  Assert.deepEqual(listed(doc), [
    { method: "POST", target: "example.org", path: "/sval-cross" },
  ]);
  await store.setSiteLevel(agent.agentId, "example.org", "blocked");
  await choose(doc, "allow");
  await TestUtils.waitForCondition(() => toOrg.stopped.length, "it ends");
  Assert.ok(
    toOrg.stopped.every(status => status === Cr.NS_ERROR_ABORT),
    "it was cancelled"
  );
});

/**
 * "Always deny" never loosens a block: a site blocked while the alert was up
 * stays Blocked.
 */
add_task(async function always_deny_keeps_a_block_set_meanwhile() {
  const setup = await writesSetup();
  const { store, agent } = setup;
  const late = requestsTo("/sval-late");
  const doc = await askedAboutALateWrite(setup);
  await store.setSiteLevel(agent.agentId, "example.com", "blocked");
  await choose(doc, "deny_always");
  await stopped(late);
  Assert.equal(store.policyOf(agent.agentId).sites["example.com"], "blocked");
});

add_task(async function allow_refuses_a_page_made_read_only_meanwhile() {
  const setup = await writesSetup();
  const { store, agent } = setup;
  const late = requestsTo("/sval-late");
  const doc = await askedAboutALateWrite(setup);
  await store.setSiteLevel(agent.agentId, "example.com", "read-only");
  await choose(doc, "allow");
  await stopped(late);
  Assert.deepEqual(late.stopped, [Cr.NS_ERROR_ABORT]);
});
