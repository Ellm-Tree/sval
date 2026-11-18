/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * Where and how an agent's alerts are shown (agent-control spec §5.6): in
 * the agent's own window, and never answered by a window going away.
 */

const { ask } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentAlerts.sys.mjs"
);
const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * Alerts in a window that closes settle as `no_window`: the one showing and
 * the one queued behind it. Nobody answered either, so nothing is recorded,
 * and asking again raises a fresh alert.
 */
add_task(async function alerts_in_a_window_that_closes_record_nothing() {
  const { agent, store, call, win } = await agentSetup({});
  const opts = {
    question: "Pick one.",
    choices: [{ id: "ok", label: "OK" }],
    defaultChoice: "ok",
  };
  const own = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    20_000,
    "a new window opening"
  );
  atTaskEnd(async () => {
    if (!own.closed) {
      await within(
        BrowserTestUtils.closeWindow(own),
        10_000,
        "the agent's own window closing"
      );
    }
  });
  const first = ask(own, opts);
  const second = ask(own, opts);
  await alertIn(own);
  Assert.equal(own.gDialogBox._queued.length, 1, "the second is queued");
  await within(BrowserTestUtils.closeWindow(own), 10_000, "the window closing");
  Assert.equal(await first, "no_window", "the alert showing");
  Assert.equal(await second, "no_window", "the alert queued behind it");

  const org = call("open_tab", { url: ORG_PAGE });
  await alertIn(win);
  const net = call("open_tab", { url: NET_PAGE });
  await TestUtils.waitForCondition(
    () => win.gDialogBox._queued.length === 1,
    "the second site's alert is queued"
  );
  await within(BrowserTestUtils.closeWindow(win), 10_000, "the window closing");
  for (const [site, opening] of [
    ["example.org", org],
    ["example.net", net],
  ]) {
    await Assert.rejects(
      opening,
      e => e.code === "no_window",
      `the open of ${site} says there was no window`
    );
    Assert.ok(
      !Object.hasOwn(store.policyOf(agent.agentId).sites, site),
      `nothing is recorded for ${site}`
    );
  }

  const retry = call("open_tab", { url: NET_PAGE });
  const fresh = await TestUtils.waitForCondition(() => {
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      if (
        w !== win &&
        SvalWindowWorkspace.of(w).id === agent.workspaceId &&
        w.gDialogBox?.isOpen
      ) {
        return w;
      }
    }
    return null;
  }, "a retry raises a fresh alert in a new agent window");
  await choose(await alertIn(fresh), "allow");
  Assert.equal((await retry).url, NET_PAGE);
});

/**
 * An alert about a page load asks in the agent's own window, even when the
 * load is in a popup the page opened: the page can move, resize or close
 * its popup, and with it an alert drawn there.
 */
add_task(async function a_popups_alert_asks_in_the_agents_window() {
  const { tabs, agent, gate, call, win } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: LINKS });
  const { browser } = await tabs.tabIn(agent, tab);
  const popupWin = await newWindowAfter(() =>
    BrowserTestUtils.synthesizeMouseAtCenter("#allowed-popup", {}, browser)
  );
  const popup = popupWin.gBrowser.selectedBrowser;
  await committed(popup, PAGE2);
  Assert.equal(
    SvalWindowWorkspace.of(popupWin).id,
    agent.workspaceId,
    "the popup shows the agent's workspace"
  );
  Assert.equal(gate.agentOf(popup)?.agentId, agent.agentId);
  const popupAlerts = countAlerts(popupWin);
  await SpecialPowers.spawn(popup, [NET_PAGE], url => {
    content.location = url;
  });
  const doc = await alertIn(win);
  Assert.equal(popupAlerts.opened, 0, "nothing was asked in the popup");
  await choose(doc, "deny");
});

/**
 * Allow cannot be clicked until the alert has been shown and focused for
 * Firefox's own dialog delay (`security.dialog_enable_delay`), so a click
 * meant for the page cannot land on it. The safe answer can be chosen at
 * once.
 */
add_task(async function allow_waits_out_the_dialog_delay() {
  await SpecialPowers.pushPrefEnv({
    set: [["security.dialog_enable_delay", 1000]],
  });
  const answer = ask(window, {
    question: "Pick one.",
    choices: [
      { id: "allow", label: "Allow" },
      { id: "deny", label: "Deny" },
    ],
    defaultChoice: "deny",
  });
  const doc = await alertIn(window);
  const button = id =>
    doc.querySelector(`.sval-aa-actions button[data-choice="${id}"]`);
  Assert.ok(button("allow").disabled, "Allow starts disabled");
  Assert.ok(!button("deny").disabled, "Deny does not");
  button("allow").click();
  Assert.ok(window.gDialogBox.isOpen, "a click on Allow does nothing yet");
  await TestUtils.waitForCondition(
    () => !button("allow").disabled,
    "Allow is enabled once the delay has passed"
  );
  button("allow").click();
  Assert.equal(await answer, "allow");
  await SpecialPowers.popPrefEnv();
});

/**
 * While the dialog delay keeps the grants disabled, a line says why, so a
 * click that lands on a disabled Allow is not a mystery. It goes once they
 * can be clicked.
 */
add_task(async function a_line_says_why_allow_cannot_be_clicked_yet() {
  await SpecialPowers.pushPrefEnv({
    set: [["security.dialog_enable_delay", 1000]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const answer = ask(window, {
    question: "Pick one.",
    choices: [
      { id: "allow", label: "Allow" },
      { id: "deny", label: "Deny" },
    ],
    defaultChoice: "deny",
  });
  const doc = await alertIn(window);
  const allow = doc.querySelector(
    '.sval-aa-actions button[data-choice="allow"]'
  );
  const line = doc.getElementById("sval-aa-delay");
  Assert.ok(allow.disabled, "Allow starts disabled");
  Assert.ok(BrowserTestUtils.isVisible(line), "the line shows meanwhile");
  Assert.notEqual(line.textContent, "", "and says why");
  await TestUtils.waitForCondition(() => !allow.disabled, "Allow enables");
  Assert.ok(BrowserTestUtils.isHidden(line), "and the line goes");
  await choose(doc, "deny");
  Assert.equal(await answer, "deny");
});

/**
 * A screen reader hears what the alert asks the user to decide: the alert's
 * description carries its detail and every item, what would be sent and
 * where, and, while the grants wait out the delay, why they cannot be
 * pressed. Focus is on the safe choice, inside the alert.
 */
add_task(async function a_screen_reader_hears_what_the_alert_asks() {
  await SpecialPowers.pushPrefEnv({
    set: [["security.dialog_enable_delay", 1000]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const answer = ask(window, {
    question: "Agent is about to send:",
    detail: "These go to example.com.",
    items: ["Form on example.com: name=Ada", "Upload: notes.txt"],
    choices: [
      { id: "allow", label: "Allow" },
      { id: "deny", label: "Deny" },
    ],
    defaultChoice: "deny",
  });
  const doc = await alertIn(window);
  const form = doc.querySelector(".sval-aa");
  const acc = await accessibleOf(form);
  Assert.equal(acc.name, "Agent is about to send:", "named by its question");
  const allow = doc.querySelector(
    '.sval-aa-actions button[data-choice="allow"]'
  );
  Assert.ok(allow.disabled, "Allow starts disabled");
  const delay = doc.getElementById("sval-aa-delay").textContent;
  Assert.notEqual(delay, "", "the delay has its line");
  for (const part of [
    "These go to example.com.",
    "Form on example.com: name=Ada",
    "Upload: notes.txt",
    delay,
  ]) {
    Assert.stringContains(acc.description, part, "the description says it");
  }
  Assert.ok(form.contains(doc.activeElement), "focus is in the alert");
  Assert.equal(doc.activeElement.dataset.choice, "deny", "on the safe choice");
  await TestUtils.waitForCondition(() => !allow.disabled, "Allow enables");
  await TestUtils.waitForCondition(
    () => !acc.description.includes(delay),
    "the delay leaves the description once Allow can be pressed"
  );
  Assert.stringContains(acc.description, "Upload: notes.txt");
  await choose(doc, "deny");
  Assert.equal(await answer, "deny");
});

/**
 * The delay line shows while Allow is locked: before it enables, and when a
 * blur disables it again until a refocus enables it.
 */
add_task(async function the_line_shows_while_allow_is_locked() {
  await SpecialPowers.pushPrefEnv({
    set: [["security.dialog_enable_delay", 1000]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const own = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    20_000,
    "a new window opening"
  );
  atTaskEnd(() =>
    within(
      BrowserTestUtils.closeWindow(own),
      10_000,
      "the agent's own window closing"
    )
  );
  const answer = ask(own, {
    question: "Pick one.",
    choices: [
      { id: "allow", label: "Allow" },
      { id: "deny", label: "Deny" },
    ],
    defaultChoice: "deny",
  });
  const doc = await alertIn(own);
  const allow = doc.querySelector(
    '.sval-aa-actions button[data-choice="allow"]'
  );
  const line = doc.getElementById("sval-aa-delay");
  Assert.ok(allow.disabled, "Allow starts disabled");
  Assert.ok(BrowserTestUtils.isVisible(line), "with the line showing");
  await TestUtils.waitForCondition(() => !allow.disabled, "Allow enables");
  Assert.ok(BrowserTestUtils.isHidden(line), "the line goes");

  await within(SimpleTest.promiseFocus(window), 10_000, "the window's focus");
  await TestUtils.waitForCondition(() => allow.disabled, "a blur disables");
  Assert.ok(BrowserTestUtils.isVisible(line), "the line is back");
  await within(SimpleTest.promiseFocus(own), 10_000, "the window's focus");
  await TestUtils.waitForCondition(() => !allow.disabled, "refocused");
  Assert.ok(BrowserTestUtils.isHidden(line), "the line goes again");
  await choose(doc, "deny");
  Assert.equal(await answer, "deny");
});

/** An alert whose only choice is its default has nothing to unlock. */
add_task(async function an_alert_with_nothing_to_grant_says_nothing_of_it() {
  await SpecialPowers.pushPrefEnv({
    set: [["security.dialog_enable_delay", 1000]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const answer = ask(window, {
    question: "Pick one.",
    choices: [{ id: "ok", label: "OK" }],
    defaultChoice: "ok",
  });
  const doc = await alertIn(window);
  Assert.ok(BrowserTestUtils.isHidden(doc.getElementById("sval-aa-delay")));
  await choose(doc, "ok");
  Assert.equal(await answer, "ok");
});

/**
 * A tool's own alert asks in the agent's full window too, even for a tab in
 * a popup the page opened.
 */
add_task(async function a_tools_alert_for_a_popup_asks_in_the_agents_window() {
  const { tabs, agent, call, win } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: LINKS });
  const { browser } = await tabs.tabIn(agent, tab);
  const popupWin = await newWindowAfter(() =>
    BrowserTestUtils.synthesizeMouseAtCenter("#allowed-popup", {}, browser)
  );
  const popupTab = popupWin.gBrowser.selectedTab;
  await committed(popupTab.linkedBrowser, PAGE2);
  let popupNode;
  await TestUtils.waitForCondition(async () => {
    await within(
      popupWin.SvalPanel.observer?.settled(),
      10_000,
      "popupWin.SvalPanel.observer settling"
    );
    popupNode = popupWin.SvalPanel.observer?.nodeIdFor(popupTab);
    return popupNode;
  }, "the popup's tab is filed");
  const popupAlerts = countAlerts(popupWin);
  const navigating = call("navigate_tab", { tab: popupNode, to: NET_PAGE });
  const doc = await alertIn(win);
  Assert.equal(popupAlerts.opened, 0, "nothing was asked in the popup");
  await choose(doc, "deny");
  Assert.equal((await navigating).status, 403, "Deny shows the blocked page");
});
