/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_agent_sites_helpers.js */

/**
 * Site policy (agent-control spec §5.2), asked of the user: the generic alert,
 * what Allow and Deny record, a level Sval does not know, one alert at a
 * time per page, and the window an alert asks in.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_agent_sites_helpers.js",
  this
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/** The generic alert: text set as text, the default focused, Escape. */
add_task(async function the_alert_shows_outside_text_as_text() {
  const answer = ask(window, {
    question: "<b>Agent</b> wants to open <i>example.org</i>.",
    detail: "<img src=x>",
    items: ["<u>one</u>", "two"],
    choices: [
      { id: "allow", label: "Allow" },
      { id: "deny", label: "Deny" },
    ],
    defaultChoice: "deny",
  });
  const doc = await alertIn(window);
  const question = doc.getElementById("sval-aa-question");
  Assert.equal(
    question.textContent,
    "<b>Agent</b> wants to open <i>example.org</i>."
  );
  Assert.equal(question.children.length, 0, "no markup was parsed");
  Assert.equal(doc.getElementById("sval-aa-detail").textContent, "<img src=x>");
  Assert.equal(doc.querySelectorAll("img").length, 0);
  const items = [...doc.querySelectorAll("#sval-aa-items > li")];
  Assert.deepEqual(
    items.map(li => li.textContent),
    ["<u>one</u>", "two"]
  );
  Assert.equal(doc.querySelectorAll("u").length, 0);
  const buttons = [...doc.querySelectorAll("sval-dialog [data-choice]")];
  Assert.deepEqual(
    buttons.map(b => [b.dataset.choice, b.textContent]),
    [
      ["deny", "Deny"],
      ["allow", "Allow"],
    ],
    "the safe answer first, the grant last"
  );
  await TestUtils.waitForCondition(
    () => doc.activeElement?.dataset.choice === "deny",
    "the default choice has focus"
  );
  EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
  Assert.equal(await answer, "deny", "a dismissed alert is the default");
});

add_task(async function the_alert_answers_the_choice_made() {
  const answer = ask(window, {
    question: "Pick one.",
    choices: [
      { id: "allow", label: "Allow" },
      { id: "deny", label: "Deny" },
    ],
    defaultChoice: "deny",
  });
  const doc = await alertIn(window);
  Assert.ok(
    doc.getElementById("sval-aa-detail").hidden,
    "no detail, none shown"
  );
  Assert.ok(doc.getElementById("sval-aa-items").hidden, "no items, none shown");
  await choose(doc, "allow");
  Assert.equal(await answer, "allow");
});

add_task(async function the_alert_with_no_window_says_so() {
  const opts = {
    question: "Pick one.",
    choices: [{ id: "ok", label: "OK" }],
    defaultChoice: "ok",
  };
  Assert.equal(await ask(null, opts), "no_window");
});

/** Allow opens the site and records it, so the next open asks nothing. */
add_task(async function a_new_site_is_asked_about_once() {
  const { agent, store, call, win, alerts } = await agentSetup();
  const opening = call("open_tab", { url: PAGE });
  const doc = await alertIn(win);
  Assert.equal(doc.querySelector(".sval-aa").dataset.kind, "site");
  Assert.ok(
    doc.getElementById("sval-aa-question").textContent.includes("example.com"),
    "the alert names the site"
  );
  await choose(doc, "allow");
  const opened = await opening;
  Assert.equal(opened.url, PAGE);
  Assert.equal(
    store.policyOf(agent.agentId).sites["example.com"],
    "ask-before-writes",
    "Allow records the site at the default level"
  );
  const again = await call("open_tab", { url: PAGE2 });
  Assert.equal(again.url, PAGE2);
  Assert.equal(alerts.opened, 1, "the second open asked nothing");
});

add_task(async function a_denied_site_stays_blocked() {
  const { agent, store, call, win, alerts } = await agentSetup();
  const opening = call("open_tab", { url: PAGE });
  await choose(await alertIn(win), "deny");
  Assert.equal((await opening).status, 403, "Deny refuses the load");
  Assert.equal(store.policyOf(agent.agentId).sites["example.com"], "blocked");
  Assert.equal((await call("open_tab", { url: PAGE2 })).status, 403);
  Assert.equal(alerts.opened, 1, "the refusal asked nothing");
});

/**
 * A page cannot bury the user in alerts: while one of its loads waits for an
 * answer, its other loads to new sites are refused without asking. The
 * answer to that one alert is recorded for the site it named, though the page
 * has moved on from the load that asked.
 */
add_task(async function a_page_raises_one_alert_at_a_time() {
  const { tabs, agent, store, call, win, alerts } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: LINKS });
  const { browser } = await tabs.tabIn(agent, tab);
  // One load asks first, so every load of the flood meets a page already
  // waiting on an alert. Which flood loads reach the gate is timing: one
  // superseded first never does, and the last is never superseded, so it
  // must be refused, not held, for the tab to settle.
  await clickIn(browser, "#new");
  await alertIn(win);
  await SpecialPowers.spawn(browser, [], () =>
    content.document.getElementById("flood").click()
  );
  await TestUtils.waitForCondition(
    () => browser.contentTitle === "flooded",
    "the page tried every site"
  );
  // Each load supersedes the one before it, and the last is refused, so the
  // tab settling is what says all of them are done.
  await TestUtils.waitForCondition(
    () => !browser.webProgress.isLoadingDocument,
    "the page's loads have all ended"
  );
  Assert.equal(alerts.opened, 1, "one alert for eleven new sites");
  const doc = await alertIn(win);
  // The alert is the first load's, the page's link to a new site.
  const named = "example.net";
  Assert.ok(
    doc.getElementById("sval-aa-question").textContent.includes(named),
    "the alert names the site the page asked for first"
  );
  await choose(doc, "allow");
  await TestUtils.waitForCondition(
    () => !win.gDialogBox.isOpen,
    "the alert closed"
  );
  await TestUtils.waitForCondition(
    () => store.policyOf(agent.agentId).sites[named],
    "the answer is recorded"
  );
  Assert.deepEqual(
    Object.keys(store.policyOf(agent.agentId).sites).sort(),
    [named, "example.com"].sort(),
    "the one site the user was asked about is recorded, and no other"
  );
  Assert.equal(browser.currentURI.spec, LINKS);
});

/**
 * One grant per site (spec §5.2). The user's Allow stands when the agent
 * moves the tab on before they answer, which ends the page's load that
 * asked, so the page's next load of that site asks nothing.
 */
add_task(async function an_allow_stands_after_the_load_that_asked_ends() {
  const { tabs, agent, store, call, win, alerts } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: LINKS });
  const { browser } = await tabs.tabIn(agent, tab);
  await clickIn(browser, "#new");
  const doc = await alertIn(win);
  // The agent's navigation stops the load in flight, the one held for the
  // alert (`SvalAgentTabs.navigate`).
  await call("navigate_tab", { tab, to: LINKS });
  Assert.ok(win.gDialogBox.isOpen, "the alert is still up");
  await choose(doc, "allow");
  await TestUtils.waitForCondition(
    () => store.policyOf(agent.agentId).sites["example.net"],
    "the answer is recorded"
  );
  Assert.equal(
    store.policyOf(agent.agentId).sites["example.net"],
    "ask-before-writes",
    "Allow records the site at the default level"
  );
  const loaded = BrowserTestUtils.browserLoaded(browser, false, NET_PAGE);
  await clickIn(browser, "#new");
  await within(loaded, 10_000, "the page's second load of the site");
  Assert.equal(alerts.opened, 1, "the site was asked about once");
});

/**
 * A page's load and the agent's calls asking about one site at once wait on
 * one alert, and its one answer serves them all.
 */
add_task(async function one_site_asked_at_once_raises_one_alert() {
  const { tabs, agent, call, win, alerts } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: LINKS });
  const { browser } = await tabs.tabIn(agent, tab);
  const loaded = BrowserTestUtils.browserLoaded(browser, false, NET_PAGE);
  await clickIn(browser, "#new");
  const doc = await alertIn(win);
  const opening = [
    call("open_tab", { url: NET_PAGE }),
    call("open_tab", { url: `${NET_PAGE}?again` }),
  ];
  await choose(doc, "allow");
  const opened = await Promise.all(opening);
  Assert.deepEqual(
    opened.map(o => o.url),
    [NET_PAGE, `${NET_PAGE}?again`]
  );
  await within(loaded, 10_000, "the page's load of the site");
  Assert.equal(alerts.opened, 1, "one alert for one site");
});

/**
 * A link that would open a window under `browser.link.open_newwindow` 2
 * opens a tab in the agent's window, and asks about its new site there: no
 * window opens, and the user's window is never asked. Sval locks the pref at
 * 3, and a page asks for the same featureless window while the user holds
 * Shift (`nsWindowWatcher::IsWindowOpenLocationModified`), which an agent's
 * click cannot, so the pref stands in for it here.
 */
add_task(async function a_new_tabs_alert_asks_in_the_agents_window() {
  Services.prefs.unlockPref("browser.link.open_newwindow");
  await SpecialPowers.pushPrefEnv({
    set: [["browser.link.open_newwindow", 2]],
  });
  atTaskEnd(async () => {
    await SpecialPowers.popPrefEnv();
    Services.prefs.lockPref("browser.link.open_newwindow");
  });
  const { agent, gate, call, win, alerts } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const userAlerts = countAlerts(window);
  const { tab } = await call("open_tab", { url: LINKS });
  const ref = await refFor(
    call,
    tab,
    /link "New site in a new tab" \[(e\d+)\]/
  );
  const inAgents = tabsOpenedIn(win);
  const before = new Set(Services.wm.getEnumerator("navigator:browser"));
  // The new tab's load is the click's, and it waits on the alert, so the
  // click's action window stays open until the alert is answered.
  const clicked = call("click_element", { tab, ref });
  const doc = await alertIn(win);
  Assert.equal(alerts.opened, 1, "one alert, in the agent's window");
  await choose(doc, "allow");
  await clicked;
  let opened;
  await TestUtils.waitForCondition(() => {
    opened = inAgents.find(
      b => b.browserId && gate.agentOf(b)?.agentId === agent.agentId
    );
    return opened?.currentURI.spec === NET_PAGE;
  }, "the allowed load went on in the agent's window");
  Assert.ok(
    [...Services.wm.getEnumerator("navigator:browser")].every(w =>
      before.has(w)
    ),
    "no window opened"
  );
  Assert.equal(userAlerts.opened, 0, "the user's window was not asked");
});
