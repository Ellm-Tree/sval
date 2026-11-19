/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * How an agent's workspace is marked (agent-control spec §6): a user looking
 * at any Sval window can tell, at a glance and without reading, whether an
 * agent works in it.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

const { isPolite, POLITE_RATE_PREF, setPolite } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentPolite.sys.mjs"
);

const ROBOT = "chrome://browser/content/sval/agent-robot.svg";

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * Waits for `win`'s panel to draw the row of node `id`.
 *
 * @param {Window} win
 * @param {string} id
 * @returns {Promise<Element>}
 */
async function rowIn(win, id) {
  await within(
    win.SvalPanel.observer.settled(),
    10_000,
    "win.SvalPanel.observer settling"
  );
  let row;
  await TestUtils.waitForCondition(
    () => (row = win.SvalPanel._rowElementFor(id)),
    "the row is drawn"
  );
  return row;
}

/**
 * The switcher, its list, the window's title and every tab row of an
 * agent's workspace wear the robot face, a tab the user handed over
 * included. None of the user's own do.
 */
add_task(async function an_agent_workspace_wears_the_robot_face() {
  const { win, call, raw, ws } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: PAGE });

  const tile = win.SvalPanel._els.switcher.querySelector(
    ".sval-switcher-emoji"
  );
  Assert.ok(tile.classList.contains("sval-agent-glyph"), "the switcher's tile");
  Assert.equal(
    tile.textContent,
    "",
    "and no emoji, which is how the user marks a place"
  );
  // Every session of an app carries the app's name, so the window is named
  // for the session's task.
  const task = "Compare laptop prices";
  const { isError } = await raw("set_task", { task });
  Assert.ok(!isError, "the agent sets its task");
  let preface;
  await TestUtils.waitForCondition(() => {
    preface = win.document.documentElement.getAttribute("titlepreface");
    return preface.includes(task);
  }, "the window's title names the task");
  Assert.ok(preface.startsWith("🤖"), "after the robot");
  Assert.equal(
    win.SvalPanel._els.switcher.querySelector(".sval-switcher-name")
      .textContent,
    task,
    "as the switcher does"
  );
  await TestUtils.waitForCondition(
    () => win.document.title.startsWith(preface),
    "and the title shows it"
  );

  const row = await rowIn(win, tab);
  const robot = row.querySelector(".sval-row-agent");
  Assert.ok(robot, "the agent's tab row wears the robot");

  // The user hands one of their tabs to the agent: it moves into the agent's
  // window and is filed under the agent's workspace.
  const userTab = BrowserTestUtils.addTab(gBrowser, PAGE2);
  atTaskEnd(() => {
    if (gBrowser.tabs.includes(userTab)) {
      BrowserTestUtils.removeTab(userTab);
    }
  });
  await within(
    BrowserTestUtils.browserLoaded(userTab.linkedBrowser, false, PAGE2),
    10_000,
    "the tab's load"
  );
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  const handed = win.gBrowser.adoptTab(userTab, { selectTab: false });
  await TestUtils.waitForCondition(
    () => win.SvalPanel.observer.nodeIdFor(handed),
    "the handed tab arrives with its node"
  );
  // Filed under the agent's workspace, as a hand-over files it.
  await win.SvalPanel.observer.refile(handed, ws);
  const handedRow = await rowIn(win, win.SvalPanel.observer.nodeIdFor(handed));
  Assert.ok(
    handedRow.querySelector(".sval-row-agent"),
    "a tab handed to the agent wears the robot too"
  );

  win.SvalPanel.switcher.fill();
  const listed = win.SvalPanel._els.switcherMenu.querySelectorAll(
    `[data-workspace-id="${ws}"]`
  );
  Assert.deepEqual(
    Array.from(listed, el => el.getAttribute("aria-current")),
    ["true"],
    "its own switcher lists it once, in its place, as the current one"
  );

  // The user's own window.
  Assert.ok(
    !SvalPanel._els.switcher.querySelector(".sval-agent-glyph"),
    "the user's switcher does not wear it"
  );
  const userPreface = document.documentElement.getAttribute("titlepreface");
  Assert.ok(userPreface, "the user's window always has a preface");
  Assert.ok(!userPreface.startsWith("🤖"), "and it is not the robot");
  Assert.ok(
    !document.querySelector(".sval-row-agent"),
    "nor do the user's tab rows"
  );
  SvalPanel.switcher.fill();
  const app = SvalPanel._els.switcherMenu.querySelector("menu[data-agent-app]");
  Assert.equal(
    app.getAttribute("image"),
    ROBOT,
    "the user's list marks the agent's app"
  );
  Assert.equal(app.getAttribute("label"), "Test Agent", "named by its agent");
  const entry = app.querySelector(`[data-workspace-id="${ws}"]`);
  Assert.ok(entry, "and lists the agent's workspace in it");
  Assert.ok(entry.getAttribute("label").startsWith(task), "named for its task");
  Assert.ok(
    Array.from(
      SvalPanel._els.switcherMenu.querySelectorAll("[data-workspace-id]")
    ).every(item => !item.hasAttribute("image")),
    "and no workspace entry wears it"
  );
});

/**
 * An agent's window carries `data-sval-agent`, which Sval's stylesheets key
 * the agent's look on. The user's window does not.
 */
add_task(async function an_agent_window_is_marked() {
  const { win } = await agentSetup();
  Assert.ok(
    win.document.documentElement.hasAttribute("data-sval-agent"),
    "the agent's window is marked"
  );
  Assert.ok(
    !document.documentElement.hasAttribute("data-sval-agent"),
    "the user's is not"
  );
});

/**
 * @param {nsIAccessible} acc
 * @returns {nsIAccessible[]} `acc`'s descendants, depth first.
 */
function descendants(acc) {
  const all = [];
  for (let child = acc.firstChild; child; child = child.nextSibling) {
    all.push(child, ...descendants(child));
  }
  return all;
}

/**
 * Screen readers hear what the marking shows (spec §6): the agent's window
 * is named after the agent and its panel and every tab in it are
 * "controlled by" the agent, the overlay is announced with its button and the
 * bar with its own, and the page under the overlay is out of reach.
 */
add_task(async function screen_readers_hear_who_controls_the_window() {
  const { win, call, tabs, agent } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: PAGE });
  const { browser, tab: tabEl } = await tabs.tabIn(agent, tab);
  await selectTab(tabEl);

  const doc = await accessibleOf(win.document);
  Assert.ok(
    doc.name.startsWith("🤖") && doc.name.includes("Test Agent"),
    "the window is named after the agent"
  );
  const panel = await accessibleOf(win.SvalPanel._els.tree);
  Assert.ok(
    panel.description.includes("Test Agent"),
    "and its panel says the agent controls it"
  );
  Assert.ok(
    !(await accessibleOf(SvalPanel._els.tree)).description?.includes(
      "Test Agent"
    ),
    "the user's does not"
  );
  const row = await accessibleOf(await rowIn(win, tab));
  Assert.ok(row.description.includes("Test Agent"), "and so is its tab");

  const switcher = await accessibleOf(win.SvalPanel._els.switcher);
  Assert.ok(
    switcher.name.includes("Test Agent"),
    "the switcher says whose workspace it is"
  );

  const container = browser.parentNode.parentNode;
  const cardNode = win.document.querySelector(".sval-agent-card");
  const card = await accessibleOf(cardNode);
  Assert.equal(card.role, Ci.nsIAccessibleRole.ROLE_DIALOG, "the overlay");
  Assert.equal(
    card.name,
    cardNode.querySelector(".sval-agent-text").textContent,
    "named by its line"
  );
  Assert.ok(card.name.includes("Test Agent"), "which names the agent");
  const take = descendants(card).find(
    a => a.role === Ci.nsIAccessibleRole.ROLE_PUSHBUTTON
  );
  Assert.equal(
    take?.DOMNode,
    cardNode.querySelector(".sval-agent-take"),
    "it holds Take control"
  );
  Assert.ok(take.name, "which has a name");
  Assert.equal(card.description, take.name, "and is described by it");
  const service = Cc["@mozilla.org/accessibilityService;1"].getService(
    Ci.nsIAccessibilityService
  );
  Assert.equal(
    // A browser with no accessible is what is checked.
    // eslint-disable-next-line sval/accessible-read
    service.getAccessibleFor(browser),
    null,
    "nothing of the page is exposed"
  );

  cardNode.querySelector(".sval-agent-take").click();
  await TestUtils.waitForCondition(async () => {
    const description = (await accessibleOf(await rowIn(win, tab))).description;
    return !!description && !description.includes("Test Agent");
  }, "the row says the user has the workspace");
  const barNode = container.querySelector(":scope > .sval-agent-bar");
  const bar = await accessibleOf(barNode);
  Assert.equal(
    bar.name,
    barNode.querySelector(".sval-agent-text").textContent,
    "the bar is named by its line"
  );
  const give = descendants(bar).find(
    a => a.role === Ci.nsIAccessibleRole.ROLE_PUSHBUTTON
  );
  Assert.equal(
    give?.DOMNode,
    barNode.querySelector(".sval-agent-give"),
    "is announced with its own button"
  );
  Assert.ok(give.name.includes("Test Agent"), "which names the agent");
  const status = win.document.querySelector(".sval-agent-announcer");
  Assert.equal(status.getAttribute("role"), "status");
  Assert.equal(status.dataset.state, "user", "and the change is announced");
  Assert.ok(!browser.hasAttribute("aria-hidden"), "the page is in reach");
  container.querySelector(".sval-agent-give").click();
  Assert.equal(status.dataset.state, "agent", "as is the give back");
  await TestUtils.waitForCondition(
    async () =>
      (await accessibleOf(await rowIn(win, tab))).description?.includes(
        "Test Agent"
      ),
    "and the agent again once it is given back"
  );
});

/**
 * A window opened for an agent's workspace that the document does not hold
 * ends up on the user's, and keeps none of the agent's marking.
 */
add_task(async function a_window_that_ends_up_the_users_is_not_marked() {
  const { handWorkspaceTo } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
  );
  const args = Cc["@mozilla.org/supports-string;1"].createInstance(
    Ci.nsISupportsString
  );
  args.data = "about:blank";
  const started = TestUtils.topicObserved("browser-delayed-startup-finished");
  const win = BrowserWindowTracker.openWindow({ args });
  atTaskEnd(() =>
    within(BrowserTestUtils.closeWindow(win), 10_000, "the test window closing")
  );
  handWorkspaceTo(win, crypto.randomUUID(), { agent: true });
  await within(started, 10_000, "the window's delayed startup");
  await within(win.SvalPanel.started, 10_000, "the panel's startup");
  Assert.ok(
    !win.document.documentElement.hasAttribute("data-sval-agent"),
    "the user's window wears no agent marking"
  );
});

/**
 * The overlay carries Be polite, ticked until the user unticks it there, by
 * mouse or keyboard. Another window of the same agent follows the tick, and
 * the line says the rate the user set in Settings.
 */
add_task(async function the_overlay_carries_be_polite_for_the_user() {
  const { win, call, agent } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { agentId } = agent;
  atTaskEnd(() => setPolite(agentId, true));
  await call("open_tab", { url: PAGE });
  const card = win.document.querySelector(".sval-agent-card");
  const tick = card.querySelector(".sval-agent-polite input");
  const line = () => card.querySelector(".sval-agent-polite-text").textContent;
  const rate = () => card.querySelector(".sval-agent-polite").dataset.rate;

  Assert.ok(tick.checked, "ticked by default");
  Assert.equal(rate(), "1", "the line says the rate Settings sets");
  Assert.equal(
    tick.labels[0].textContent,
    line(),
    "and the line is the tick's label"
  );

  tick.click();
  Assert.ok(!isPolite(agentId), "unticking it lifts the limit");
  tick.click();
  Assert.ok(isPolite(agentId), "ticking it holds the agent again");

  // The agent's window opens behind the user's; the user brings it to the
  // front to use its keyboard.
  await within(
    SimpleTest.promiseFocus(win),
    10_000,
    "the agent window's focus"
  );
  tick.focus();
  EventUtils.synthesizeKey(" ", {}, win);
  Assert.ok(!isPolite(agentId), "Space on the tick unticks it");
  setPolite(agentId, true);
  Assert.ok(tick.checked, "a change made in another window shows here");

  // Another agent's workspace under the same name is another agent.
  const other = (await agentSetup({ openWindow: false })).agent;
  setPolite(other.agentId, false);
  Assert.ok(tick.checked, "its choice is not this agent's");
  Assert.ok(isPolite(agentId));

  await SpecialPowers.pushPrefEnv({ set: [[POLITE_RATE_PREF, 3]] });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  Assert.equal(rate(), "3", "and follows it");

  setPolite(agentId, false);
  await SvalAgents.unpair(agentId);
  Assert.ok(isPolite(agentId), "unpairing clears the user's choice");
});
