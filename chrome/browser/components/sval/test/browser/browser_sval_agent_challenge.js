/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * A page asking for human verification stops the agent and hands the tab to
 * the user (agent-control spec §6). Every page here is a local fixture
 * (`sval_agent_challenge.sjs`), and the widget origin is pointed at
 * example.org, so no test reaches a real vendor.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);
const { isUserInControl } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs"
);
const { ORIGINS_PREF, resetForTests, WIDGET_GRACE_MS } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgentChallenge.sys.mjs"
  );
const { CHALLENGE_TEXT } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentMarking.sys.mjs"
);

const FIXTURE = ROOT + "sval_agent_challenge.sjs";

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
  await SpecialPowers.pushPrefEnv({
    set: [[ORIGINS_PREF, "test=https://example.org"]],
  });
  registerCleanupFunction(() => {
    Services.cookies.removeAll();
    resetForTests();
  });
});

/**
 * @returns {Promise<object>} An agent that may use both test hosts.
 */
function challengeSetup() {
  // A check another task completed is not completed for this one.
  Services.cookies.removeAll();
  return agentSetup({
    sites: { "example.com": "full", "example.org": "full" },
  });
}

/**
 * Opens `mode`'s page and expects it to be refused as a check.
 *
 * @param {object} setup
 * @param {Function} setup.call
 * @param {string} mode
 * @returns {Promise<object>} The error's details: tab, kind and vendor.
 */
async function openChallenge({ call }, mode) {
  let details;
  await Assert.rejects(
    call("open_tab", { url: `${FIXTURE}?${mode}` }),
    e => {
      details = e.details;
      return e.code === "human_verification_required";
    },
    `${mode} is a human-verification check`
  );
  Assert.ok(details.tab, "the error names the tab");
  Assert.ok(
    details.url?.includes("sval_agent_challenge.sjs"),
    "and the page the agent may read"
  );
  return details;
}

/**
 * @param {object} setup
 * @param {object} setup.tabs
 * @param {object} setup.agent
 * @param {string} tab
 * @returns {Promise<object>} The tab's `list_tabs` entry.
 */
async function listed({ tabs, agent }, tab) {
  return (await tabs.listTabsFor(agent)).find(t => t.tab === tab);
}

add_task(async function each_interstitial_is_reported_at_once() {
  const setup = await challengeSetup();
  for (const [mode, vendor] of [
    ["cf", "cloudflare"],
    ["cfdom", "cloudflare"],
    ["aws", "aws"],
    ["px", "perimeterx"],
  ]) {
    const details = await openChallenge(setup, mode);
    Assert.equal(details.kind, "interstitial", mode);
    Assert.equal(details.vendor, vendor, mode);
  }
});

add_task(async function a_widget_opened_as_a_page_is_refused() {
  const setup = await challengeSetup();
  let details;
  await Assert.rejects(
    setup.call("open_tab", {
      url: `${FIXTURE.replace("https://example.com", "https://example.org")}?frame`,
    }),
    e => {
      details = e.details;
      return e.code === "human_verification_required";
    }
  );
  Assert.deepEqual([details.kind, details.vendor], ["interstitial", "test"]);
});

add_task(async function silent_and_hidden_checks_are_not_reported() {
  const { call } = await challengeSetup();
  for (const mode of ["awschallenge", "negatives", "selfclearing"]) {
    const { tab } = await call("open_tab", { url: `${FIXTURE}?${mode}` });
    Assert.ok(tab, `${mode} opens`);
    const { snapshot } = await call("get_snapshot", { tab });
    Assert.ok(snapshot.includes("Go"), `${mode} can be read`);
  }
});

add_task(async function a_visible_widget_counts_after_the_grace() {
  const setup = await challengeSetup();
  const started = ChromeUtils.now();
  const details = await openChallenge(setup, "widget");
  Assert.greaterOrEqual(
    ChromeUtils.now() - started,
    WIDGET_GRACE_MS,
    "a widget counts only once it has stayed"
  );
  Assert.deepEqual([details.kind, details.vendor], ["widget", "test"]);
  const again = ChromeUtils.now();
  await Assert.rejects(
    setup.call("get_snapshot", { tab: details.tab }),
    e => e.code === "human_verification_required"
  );
  Assert.less(
    ChromeUtils.now() - again,
    WIDGET_GRACE_MS,
    "and at once from then on"
  );
});

/**
 * The whole handoff: the check stops the agent, the user is told, takes
 * control, completes it and gives the tab back, and the agent goes on.
 */
add_task(async function the_user_completes_the_check_and_gives_the_tab_back() {
  const setup = await challengeSetup();
  const { call, raw, win } = setup;
  const { tab } = await openChallenge(setup, "cf");
  const { tab: tabEl, browser } = await setup.tabs.tabIn(setup.agent, tab);
  await selectTab(tabEl);

  // The agent can neither act nor read, and can see what the user will.
  for (const [name, args] of [
    ["click_element", { tab, ref: "e1" }],
    ["type_text", { tab, ref: "e1", text: "x" }],
    ["press_keys", { tab, keys: ["Enter"] }],
    ["get_snapshot", { tab }],
    ["get_page_source", { tab }],
    ["get_page_text", { tab }],
  ]) {
    await Assert.rejects(
      call(name, args),
      e => e.code === "human_verification_required" && e.details.tab === tab,
      `${name} is refused`
    );
  }
  const shot = await raw("get_screenshot", { tab });
  Assert.equal(shot.content[0].type, "image", "a screenshot still works");
  Assert.equal((await listed(setup, tab)).human_verification, true);

  // The user is told on the card.
  const card = win.document.querySelector(".sval-agent-card");
  const line = card.querySelector(".sval-agent-challenge");
  await TestUtils.waitForCondition(() => !line.hidden, "the card says so");
  Assert.equal(line.textContent, CHALLENGE_TEXT);
  Assert.ok(card.getAttribute("aria-describedby").includes(line.id));

  // The user takes control, and their tab is theirs.
  card.querySelector(".sval-agent-take").click();
  const id = browser.browsingContext.browserId;
  Assert.ok(isUserInControl(id));
  await Assert.rejects(
    call("click_element", { tab, ref: "e1" }),
    e => e.code === "user_in_control",
    "the user's control wins over the check"
  );
  Assert.equal((await listed(setup, tab)).user_in_control, true);

  // They complete it, and the page loads clean.
  const loaded = BrowserTestUtils.browserLoaded(browser);
  await SpecialPowers.spawn(browser, [], () =>
    content.document.getElementById("solve").click()
  );
  await within(loaded, 10_000, "the tab's load");

  const bar = browser.parentNode.parentNode.querySelector(
    ":scope > .sval-agent-bar"
  );
  bar.querySelector(".sval-agent-give").click();
  Assert.ok(!isUserInControl(id), "the tab is the agent's again");
  await TestUtils.waitForCondition(
    () => line.hidden,
    "the card no longer asks"
  );
  const entry = await listed(setup, tab);
  Assert.ok(!entry.human_verification && !entry.user_in_control);
  const { snapshot } = await call("get_snapshot", { tab });
  Assert.ok(snapshot.includes("Go"), "the agent reads the page");
});

add_task(async function a_check_still_showing_is_refused_after_give_back() {
  const setup = await challengeSetup();
  const { call, win } = setup;
  const { tab } = await openChallenge(setup, "aws");
  const { tab: tabEl, browser } = await setup.tabs.tabIn(setup.agent, tab);
  await selectTab(tabEl);
  const card = win.document.querySelector(".sval-agent-card");
  card.querySelector(".sval-agent-take").click();
  browser.parentNode.parentNode
    .querySelector(":scope > .sval-agent-bar .sval-agent-give")
    .click();
  await Assert.rejects(
    call("click_element", { tab, ref: "e1" }),
    e => e.code === "human_verification_required"
  );
  Assert.equal((await listed(setup, tab)).human_verification, true);
  Assert.ok(!card.querySelector(".sval-agent-challenge").hidden);

  // Moving the tab on is the agent's to do.
  const moved = await call("navigate_tab", { tab, to: PAGE });
  Assert.equal(moved.tab, tab);
  Assert.ok(!(await listed(setup, tab)).human_verification);
});
