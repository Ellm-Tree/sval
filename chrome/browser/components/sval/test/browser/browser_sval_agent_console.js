/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * `get_console_messages` (agent-control spec §4.5): an agent reads a site's
 * console only once the user allows that site for that agent, and then only
 * what the tab's own page wrote.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

const CONSOLE_PAGE = ROOT + "sval_agent_console.html";

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * An agent's tab on the console page, tagged `tag`.
 *
 * @param {object} [options] For `agentSetup`.
 * @param {string} [tag]
 * @returns {Promise<object>}
 */
async function consoleSetup(options, tag = "a") {
  const setup = await agentSetup({
    sites: { "example.com": "full", "example.org": "full" },
    ...options,
  });
  const { tab } = await setup.call("open_tab", {
    url: `${CONSOLE_PAGE}?${tag}`,
  });
  const { browser } = await setup.tabs.tabIn(setup.agent, tab);
  return { ...setup, tab, browser };
}

/**
 * Reads the tab's console until it holds `count` messages, as the page's
 * timer throws after its load.
 *
 * @param {Function} call
 * @param {string} tab
 * @param {number} count
 * @returns {Promise<object>} The last answer.
 */
async function messagesOnceThere(call, tab, count) {
  let read;
  await TestUtils.waitForCondition(async () => {
    read = await call("get_console_messages", { tab });
    return read.messages.length >= count;
  }, `the page's ${count} messages`);
  return read;
}

add_task(async function a_denied_site_gives_no_messages() {
  const { call, win, alerts, store, agent, tab } = await consoleSetup();
  const asking = call("get_console_messages", { tab });
  const doc = await alertIn(win);
  Assert.equal(doc.querySelector(".sval-aa").dataset.kind, "console");
  Assert.equal(
    doc.activeElement?.dataset.choice,
    "deny",
    "Deny is the default"
  );
  await choose(doc, "deny");
  await Assert.rejects(
    asking,
    e => e.code === "console_denied" && !("messages" in (e.details ?? {})),
    "a denied site answers console_denied and no messages"
  );
  Assert.equal(store.policyOf(agent.agentId).console["example.com"], "deny");
  await Assert.rejects(
    call("get_console_messages", { tab }),
    e => e.code === "console_denied",
    "and goes on refusing"
  );
  Assert.equal(alerts.opened, 1, "without asking again");
});

add_task(async function an_allowed_site_gives_the_pages_messages() {
  const { call, win, alerts, store, agent, tab } = await consoleSetup();
  const asking = call("get_console_messages", { tab });
  await choose(await alertIn(win), "allow");
  await asking;
  Assert.equal(store.policyOf(agent.agentId).console["example.com"], "allow");

  const read = await messagesOnceThere(call, tab, 5);
  Assert.equal(alerts.opened, 1, "an allowed site is not asked about again");
  Assert.equal(read.url, `${CONSOLE_PAGE}?a`);
  const seen = read.messages.map(m => `${m.kind}:${m.level}`);
  Assert.deepEqual(
    seen.slice(0, 3),
    ["console:log", "console:warn", "console:error"],
    "the page's console calls come first, in order"
  );
  Assert.deepEqual(
    seen.slice(3).sort(),
    ["uncaught_exception:error", "unhandled_rejection:error"],
    "then its uncaught exception and unhandled rejection"
  );
  Assert.equal(read.messages[0].text, "log from a 7", "a format is filled");
  for (const message of read.messages) {
    Assert.ok(message.url?.startsWith(CONSOLE_PAGE), "each names its source");
    Assert.ok(Number.isFinite(message.time), "and when");
  }
  const times = read.messages.map(m => m.time);
  Assert.deepEqual(
    times,
    [...times].sort((a, b) => a - b),
    "oldest to newest"
  );
  Assert.ok(!read.more);

  // Another site is decided on its own.
  const other = await call("open_tab", {
    url: `${CONSOLE_PAGE.replace("://example.com/", "://example.org/")}?b`,
  });
  const otherAsking = call("get_console_messages", { tab: other.tab });
  await choose(await alertIn(win), "deny");
  await Assert.rejects(otherAsking, e => e.code === "console_denied");
  Assert.equal(alerts.opened, 2, "a grant is per site");
});

/**
 * A call that stops waiting, as one the agent cancels does, leaves the alert
 * up with nothing decided, and an Allow given then is kept for the site.
 */
add_task(async function a_late_allow_is_kept_for_the_site() {
  const { call, callWithProgress, win, store, agent, tab } =
    await consoleSetup();
  const asking = callWithProgress("get_console_messages", { tab });
  const doc = await alertIn(win);
  await asking.cancel();
  Assert.ok(win.gDialogBox.isOpen, "the alert stays up");
  Assert.ok(
    !Object.hasOwn(store.policyOf(agent.agentId).console, "example.com"),
    "nothing is decided yet"
  );
  await choose(doc, "allow");
  await TestUtils.waitForCondition(
    () => store.policyOf(agent.agentId).console["example.com"] === "allow",
    "the late Allow is kept for the site"
  );
  const read = await messagesOnceThere(call, tab, 5);
  Assert.equal(read.tab, tab, "the retry reads the console");
});

add_task(async function another_tabs_messages_never_appear() {
  const { call, win, tab, store, agent } = await consoleSetup();
  await store.setFilePermission(
    agent.agentId,
    "console",
    "example.com",
    "allow"
  );
  const second = await call("open_tab", { url: `${CONSOLE_PAGE}?b` });
  await messagesOnceThere(call, second.tab, 5);
  const read = await messagesOnceThere(call, tab, 5);
  Assert.ok(
    read.messages.every(m => !m.text.includes(" b")),
    "the first tab holds none of the second tab's messages"
  );
  Assert.ok(!win.gDialogBox.isOpen, "an allowed site raises no alert");
});

add_task(async function a_cursor_reads_only_what_came_since() {
  const { call, tab, browser, store, agent } = await consoleSetup();
  await store.setFilePermission(
    agent.agentId,
    "console",
    "example.com",
    "allow"
  );
  const first = await messagesOnceThere(call, tab, 5);
  const none = await call("get_console_messages", {
    tab,
    cursor: first.cursor,
  });
  Assert.deepEqual(none.messages, [], "nothing new yet");
  await SpecialPowers.spawn(browser, [], () => {
    content.postMessage("later one", "*");
    content.postMessage("later two", "*");
  });
  let since;
  await TestUtils.waitForCondition(async () => {
    since = await call("get_console_messages", {
      tab,
      cursor: none.cursor,
      max_messages: 1,
    });
    return since.messages.length;
  }, "the page logs again");
  Assert.deepEqual(
    since.messages.map(m => m.text),
    ["later one"],
    "only what was logged since, up to the limit"
  );
  let rest;
  await TestUtils.waitForCondition(async () => {
    rest = await call("get_console_messages", { tab, cursor: since.cursor });
    return rest.messages.length;
  }, "the second line");
  Assert.deepEqual(
    rest.messages.map(m => m.text),
    ["later two"],
    "the next call carries on from the cursor"
  );
});

add_task(async function a_grant_is_the_agents_own() {
  const { gate, store, agent } = await consoleSetup();
  await store.setFilePermission(
    agent.agentId,
    "console",
    "example.com",
    "allow"
  );
  const other = await agentSetup({ openWindow: false });
  Assert.ok(gate.consoleAllowed(agent, "example.com"));
  Assert.ok(
    !gate.consoleAllowed(other.agent, "example.com"),
    "another agent has no grant for the site"
  );
});
