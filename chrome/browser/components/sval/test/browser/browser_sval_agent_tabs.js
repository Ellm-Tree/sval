/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_take_control_helpers.js */

/**
 * An agent's tabs (agent-control spec §5.4): they open in a window showing the
 * agent's own workspace, are filed under it, and load with a null principal.
 */

const { createAgentTabs } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentTabs.sys.mjs"
);

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_take_control_helpers.js",
  this
);

/**
 * `tabs.navigate`, bounded well inside the file's time limit, so a load that
 * never ends fails naming its target.
 *
 * @param {object} tabs What `createAgentTabs` made.
 * @param {object} browser A `<browser>`.
 * @param {string} target As `navigate` takes it.
 * @returns {Promise<object>} What `navigate` answered.
 */
function navigateWithin(tabs, browser, target) {
  return within(
    tabs.navigate(browser, target),
    10_000,
    `the navigation to ${target}`
  );
}

/**
 * The user takes control of the agent's tab, loads `url` in it, and gives
 * it back.
 *
 * @param {object} browser
 * @param {string} url
 */
async function userLoads(browser, url) {
  pressTakeControl(browser);
  const loaded = BrowserTestUtils.browserLoaded(browser, false, url);
  BrowserTestUtils.startLoadingURIString(browser, url);
  await within(loaded, 10_000, `${url} loading`);
  partsOf(browser).bar.querySelector(".sval-agent-give").click();
  Assert.ok(
    !isUserInControl(browser.browsingContext.browserId),
    "the tab is given back"
  );
}

/** The levels every agent here has: full access to the test pages' site. */
const SITES = { "example.com": "full" };

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel starting");
});

add_task(
  async function opening_a_tab_opens_the_agents_window_and_files_the_tab_under_its_workspace() {
    const { ws, tabs, agent } = await agentSetup({
      sites: SITES,
      openWindow: false,
    });
    const opened = await tabs.openTab(agent, PAGE);
    Assert.equal(opened.url, PAGE);
    const win = await tabs.windowFor(ws, { open: false });
    Assert.ok(win && win !== window, "a window of its own");
    Assert.deepEqual(
      (await tabs.listTabs(ws)).map(t => t.tab),
      [opened.tab]
    );
  }
);

/**
 * An isolated workspace's agent tab opens in the workspace's own jar
 * (isolated workspaces spec §4), whatever jar the window would give a new
 * tab, and loads there.
 */
add_task(async function an_isolated_workspaces_tab_opens_in_its_jar() {
  const { SvalWorkspaceJar } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalWorkspaceJar.sys.mjs"
  );
  const { ws, tabs, agent } = await agentSetup({
    sites: SITES,
    openWindow: false,
    isolated: true,
  });
  const jar = SvalWorkspaceJar.userContextIdFor(
    (await SvalPanel.engine.tree()).nodes,
    ws
  );
  Assert.greater(jar, 0, "the workspace has a jar of its own");
  const win = await tabs.windowFor(ws, { open: true });
  await within(win.SvalPanel.started, 10_000, "the panel starting");
  // The default jar, as a window showing another workspace would give.
  win.gBrowser.defaultUserContextId = 0;
  const opened = [];
  const onOpen = event => opened.push(event.target.userContextId);
  win.gBrowser.tabContainer.addEventListener("TabOpen", onOpen);
  let tab;
  try {
    ({ tab } = await tabs.openTab(agent, PAGE));
  } finally {
    win.gBrowser.tabContainer.removeEventListener("TabOpen", onOpen);
  }
  Assert.equal(opened[0], jar, "the tab opened in the workspace's jar");
  const { browser } = await tabs.tabIn(agent, tab);
  Assert.equal(
    browser.contentPrincipal.originAttributes.userContextId,
    jar,
    "the page loaded in it"
  );
});

add_task(async function navigate_back_forward_reload_and_close() {
  const { ws, tabs, agent } = await agentSetup({
    sites: SITES,
    openWindow: false,
  });
  const { tab } = await tabs.openTab(agent, PAGE);
  const { browser } = await tabs.tabIn(agent, tab);
  Assert.equal((await tabs.navigate(browser, PAGE2)).url, PAGE2);
  Assert.equal((await tabs.navigate(browser, "back")).url, PAGE);
  Assert.equal((await tabs.navigate(browser, "forward")).url, PAGE2);
  Assert.equal((await tabs.navigate(browser, "reload")).url, PAGE2);
  await tabs.closeTab(ws, tab);
  await TestUtils.waitForCondition(
    async () => (await tabs.listTabs(ws)).length === 0,
    "node deleted on close"
  );
});

add_task(async function a_tab_outside_the_workspace_is_not_controlled() {
  const { tabs, agent } = await agentSetup({
    sites: SITES,
    openWindow: false,
  });
  const userTab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE),
    15_000,
    "the user's tab opening and loading"
  );
  await within(
    SvalPanel.observer?.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  const userNode = SvalPanel.observer?.nodeIdFor(userTab);
  await Assert.rejects(
    tabs.tabIn(agent, userNode ?? "nope"),
    e => e.code === "not_controlled"
  );
  await Assert.rejects(
    tabs.tabIn(agent, "no-such-node"),
    e => e.code === "not_controlled"
  );
  BrowserTestUtils.removeTab(userTab);
});

/**
 * The session-history entry `offset` steps from the current one. Its
 * triggering principal is what a later back, forward or reload replays.
 *
 * @param {object} browser A `<browser>`.
 * @param {number} [offset]
 * @returns {nsISHEntry}
 */
function entryAt(browser, offset = 0) {
  const history = browser.browsingContext.sessionHistory;
  return history.getEntryAtIndex(history.index + offset);
}

add_task(async function agent_loads_never_carry_the_system_principal() {
  const { tabs, agent } = await agentSetup({
    sites: SITES,
    openWindow: false,
  });
  const { tab } = await tabs.openTab(agent, PAGE);
  const { browser } = await tabs.tabIn(agent, tab);
  Assert.ok(
    entryAt(browser).triggeringPrincipal.isNullPrincipal,
    "open_tab's load has a null triggering principal"
  );
  await tabs.navigate(browser, PAGE2);
  Assert.ok(
    entryAt(browser).triggeringPrincipal.isNullPrincipal,
    "navigate's load has a null triggering principal"
  );
  const principal = browser.contentPrincipal;
  Assert.ok(!principal.isSystemPrincipal);
  Assert.equal(principal.origin, "https://example.com");
});

add_task(async function the_agents_window_opens_blank_whatever_the_home_page() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.startup.page", 1],
      ["browser.startup.homepage", "https://example.com/"],
    ],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const { ws, tabs, agent } = await agentSetup({
    sites: SITES,
    openWindow: false,
  });
  const opened = await tabs.openTab(agent, PAGE);
  const win = await tabs.windowFor(ws);
  const observer = win.SvalPanel.observer;
  const others = [...win.gBrowser.tabs].filter(
    t => observer.nodeIdFor(t) !== opened.tab
  );
  Assert.greater(others.length, 0, "the window keeps its startup tab");
  for (const other of others) {
    await TestUtils.waitForCondition(
      () => !other.linkedBrowser.webProgress?.isLoadingDocument,
      "the startup tab has finished loading"
    );
    await within(observer.settled(), 10_000, "observer settling");
    Assert.equal(other.linkedBrowser.currentURI.spec, "about:blank");
    Assert.equal(observer.nodeIdFor(other), null, "and is filed nowhere");
  }
  Assert.deepEqual(
    (await tabs.listTabs(ws)).map(t => t.tab),
    [opened.tab]
  );
});

add_task(
  async function a_restored_tab_loads_afresh_and_never_replays_its_entry() {
    const { ws, tabs, agent } = await agentSetup({
      sites: SITES,
      openWindow: false,
    });
    const { tab } = await tabs.openTab(agent, PAGE);
    const first = await tabs.windowFor(ws);
    await within(
      first.SvalPanel.observer.settled(),
      10_000,
      "first.SvalPanel.observer settling"
    );
    await within(
      BrowserTestUtils.closeWindow(first),
      10_000,
      "the first window closing"
    );
    Assert.deepEqual(
      (await tabs.listTabs(ws)).map(t => [t.tab, t.url]),
      [[tab, PAGE]],
      "closing the window keeps the node"
    );

    const win = await tabs.windowFor(ws, { open: true });
    const restored = win.SvalPanel.observer.tabFor(tab);
    Assert.ok(restored, "the new window brings the tab back");
    await TestUtils.waitForCondition(
      () => !SessionStore.isTabRestoring(restored),
      "session store has restored the selected tab"
    );
    Assert.ok(
      !entryAt(restored.linkedBrowser).triggeringPrincipal.isNullPrincipal,
      "from its restored entry, with the user's authority"
    );

    const { browser } = await tabs.tabIn(agent, tab);
    Assert.equal(browser.currentURI.spec, PAGE);
    Assert.ok(
      !entryAt(browser).triggeringPrincipal.isNullPrincipal,
      "a page that has finished loading is left as it is"
    );
    await Assert.rejects(
      tabs.navigate(browser, "back"),
      e => e.code === "no_history"
    );
    Assert.equal((await tabs.navigate(browser, "reload")).url, PAGE);
    Assert.ok(
      entryAt(browser).triggeringPrincipal.isNullPrincipal,
      "reload never replays the restored entry; it loads afresh"
    );
    await Assert.rejects(
      tabs.navigate(browser, "back"),
      e => e.code === "no_history",
      "and back never returns to it"
    );
    Assert.equal((await tabs.navigate(browser, PAGE2)).url, PAGE2);
    Assert.equal((await tabs.navigate(browser, "back")).url, PAGE);

    Assert.equal(win.gBrowser.tabs.length, 1, "the agent's tab is the last");
    await tabs.closeTab(ws, tab);
    Assert.ok(!win.closed, "closing it leaves the window open");
    Assert.deepEqual(await tabs.listTabs(ws), [], "and deletes its node");
  }
);

add_task(async function a_discarded_tab_is_given_a_browser_and_loaded_afresh() {
  const { ws, tabs, agent } = await agentSetup({
    sites: SITES,
    openWindow: false,
  });
  const first = await tabs.openTab(agent, PAGE);
  await tabs.openTab(agent, PAGE2);
  const win = await tabs.windowFor(ws);
  const tab = win.SvalPanel.observer.tabFor(first.tab);
  Assert.ok(win.gBrowser.discardBrowser(tab, true), "discarded");
  Assert.ok(!tab.linkedPanel, "with no browser left");

  const { browser } = await tabs.tabIn(agent, first.tab);
  Assert.ok(browser.browsingContext, "it has a browser again");
  Assert.equal(browser.currentURI.spec, PAGE);
  Assert.ok(
    entryAt(browser).triggeringPrincipal.isNullPrincipal,
    "loaded afresh"
  );
  Assert.equal((await tabs.navigate(browser, PAGE2)).url, PAGE2);
});

/**
 * An agent replays only a history entry its own load made, whose triggering
 * principal is a null principal. An entry a link in the page made carries the
 * page's own authority, which an agent's load never has, so a reload loads it
 * afresh, and back onto it is refused with its address for the agent to open.
 */
add_task(async function only_an_agents_own_entry_is_replayed() {
  const { tabs, agent } = await agentSetup({
    sites: SITES,
    openWindow: false,
  });
  const { tab } = await tabs.openTab(agent, PAGE);
  const { browser } = await tabs.tabIn(agent, tab);
  const made = entryAt(browser).ID;
  Assert.equal((await navigateWithin(tabs, browser, "reload")).url, PAGE);
  Assert.equal(entryAt(browser).ID, made, "the agent's own entry is replayed");

  // A same-site link in the page, followed.
  const follow = async url => {
    const linked = BrowserTestUtils.browserLoaded(browser, false, url);
    await SpecialPowers.spawn(browser, [url], u => {
      const link = content.document.createElement("a");
      link.href = u;
      content.document.body.append(link);
      link.click();
    });
    await within(linked, 10_000, "the linked page loading");
  };
  await follow(PAGE2);
  Assert.ok(
    entryAt(browser).triggeringPrincipal.isContentPrincipal,
    "the link's entry carries the page's authority"
  );
  Assert.equal((await navigateWithin(tabs, browser, "reload")).url, PAGE2);
  Assert.ok(
    entryAt(browser).triggeringPrincipal.isNullPrincipal,
    "a reload loads it afresh with a null principal"
  );

  // Back onto a link's entry is refused with its address to open instead.
  const third = PAGE + "?third";
  await follow(third);
  await navigateWithin(tabs, browser, PAGE2 + "?agent");
  await Assert.rejects(
    navigateWithin(tabs, browser, "back"),
    e => e.code === "no_history" && e.details?.url === third,
    "back onto a link's entry names its address"
  );
  Assert.equal((await navigateWithin(tabs, browser, third)).url, third);
  Assert.ok(
    entryAt(browser).triggeringPrincipal.isNullPrincipal,
    "opening that address is the agent's own load"
  );
});

add_task(async function history_never_returns_to_a_page_an_agent_cannot_open() {
  const { tabs, agent } = await agentSetup({
    sites: SITES,
    openWindow: false,
  });
  const { tab } = await tabs.openTab(agent, PAGE);
  const { browser } = await tabs.tabIn(agent, tab);
  // The user goes somewhere agents may not, in the agent's tab.
  await userLoads(browser, "about:license");
  await Assert.rejects(
    tabs.tabIn(agent, tab),
    e => e.code === "unsupported_url",
    "a tab showing a page agents may not open is not handed over"
  );
  Assert.equal((await tabs.navigate(browser, PAGE2)).url, PAGE2);
  await Assert.rejects(
    tabs.navigate(browser, "back"),
    e => e.code === "no_history"
  );
  Assert.equal(browser.currentURI.spec, PAGE2, "nothing was loaded");
});

/**
 * A history entry a form posted is never sent again for an agent: a reload
 * loads its address afresh, and back or forward will not go to it. A post
 * replayed from history would send the write outside the write gate.
 */
add_task(async function history_never_replays_a_post() {
  const { tabs, agent } = await agentSetup({
    sites: SITES,
    openWindow: false,
  });
  const form = ROOT + "sval_agent_post.sjs";
  const { tab } = await tabs.openTab(agent, form + "?reset");
  const { browser } = await tabs.tabIn(agent, tab);
  const posted = BrowserTestUtils.browserLoaded(browser, false, form);
  await SpecialPowers.spawn(browser, [], () =>
    content.document.getElementById("f").submit()
  );
  await within(posted, 10_000, "the first post's load");
  Assert.equal(browser.contentTitle, "POST 1", "the form posted once");
  Assert.ok(entryAt(browser).hasPostData, "its entry carries the post");

  const reloaded = await navigateWithin(tabs, browser, "reload");
  Assert.equal(reloaded.url, form);
  Assert.equal(reloaded.title, "GET 1", "reload loaded the address afresh");
  Assert.ok(!entryAt(browser).hasPostData);

  const postedAgain = BrowserTestUtils.browserLoaded(browser, false, form);
  await SpecialPowers.spawn(browser, [], () =>
    content.document.getElementById("f").submit()
  );
  await within(postedAgain, 10_000, "the second post's load");
  Assert.equal(browser.contentTitle, "POST 2");
  await navigateWithin(tabs, browser, PAGE2);
  await Assert.rejects(
    navigateWithin(tabs, browser, "back"),
    e => e.code === "no_history" && e.details?.url === form,
    "back will not go to a posted entry, and names its address to open"
  );
  Assert.equal(browser.currentURI.spec, PAGE2, "nothing was loaded");
});

/**
 * The post a frame sent is held by the frame's own entry, under the page's,
 * and a history load would send it again too. Neither back nor reload
 * replays it.
 */
add_task(async function history_never_replays_a_frames_post() {
  const { tabs, agent } = await agentSetup({
    sites: SITES,
    openWindow: false,
  });
  const form = ROOT + "sval_agent_post.sjs";
  const framed = form + "?frame";
  const { tab } = await tabs.openTab(agent, form + "?reset");
  const { browser } = await tabs.tabIn(agent, tab);
  const frameTitle = () =>
    SpecialPowers.spawn(browser.browsingContext.children[0], [], () =>
      content.document.readyState === "complete" ? content.document.title : ""
    );
  const postInFrame = async title => {
    await TestUtils.waitForCondition(
      async () => (await frameTitle()).startsWith("GET"),
      "the frame has its form"
    );
    await SpecialPowers.spawn(browser.browsingContext.children[0], [], () =>
      content.document.getElementById("f").submit()
    );
    await TestUtils.waitForCondition(
      async () => (await frameTitle().catch(() => "")) === title,
      `the frame posted: ${title}`
    );
  };
  const childPosted = entry => {
    for (let i = 0; i < entry.childCount; i++) {
      const child = entry.GetChildAt(i);
      if (child && (child.hasPostData || childPosted(child))) {
        return true;
      }
    }
    return false;
  };

  await navigateWithin(tabs, browser, framed);
  await postInFrame("POST 1");
  Assert.ok(childPosted(entryAt(browser)), "the frame's entry holds the post");
  await navigateWithin(tabs, browser, PAGE2);
  await Assert.rejects(
    navigateWithin(tabs, browser, "back"),
    e => e.code === "no_history",
    "back will not go to a page whose frame posted"
  );
  Assert.equal(browser.currentURI.spec, PAGE2, "nothing was loaded");

  await navigateWithin(tabs, browser, framed);
  await postInFrame("POST 2");
  const reloaded = await navigateWithin(tabs, browser, "reload");
  Assert.equal(reloaded.url, framed);
  await TestUtils.waitForCondition(
    async () => (await frameTitle().catch(() => "")) === "GET 2",
    "reload loaded the frame afresh"
  );
  Assert.ok(!childPosted(entryAt(browser)), "and holds no post");
});

add_task(async function a_view_source_tab_can_be_closed_and_nothing_else() {
  const { ws, tabs, agent } = await agentSetup({
    sites: SITES,
    openWindow: false,
  });
  const { tab } = await tabs.openTab(agent, PAGE);
  const { browser } = await tabs.tabIn(agent, tab);
  await userLoads(browser, "view-source:" + PAGE);
  await Assert.rejects(
    tabs.tabIn(agent, tab),
    e => e.code === "unsupported_url"
  );
  await tabs.closeTab(ws, tab);
  Assert.deepEqual(await tabs.listTabs(ws), []);
});

add_task(async function unsupported_urls_are_refused_before_any_window_opens() {
  const { ws, tabs, agent } = await agentSetup({
    sites: SITES,
    openWindow: false,
  });
  await Assert.rejects(
    tabs.openTab(agent, "file:///etc/hosts"),
    e => e.code === "unsupported_url"
  );
  Assert.equal(await tabs.windowFor(ws, { open: false }), null);
});

add_task(async function back_with_nothing_behind_is_no_history() {
  const { tabs, agent } = await agentSetup({
    sites: SITES,
    openWindow: false,
  });
  const opened = await tabs.openTab(agent, "about:blank");
  Assert.equal(opened.url, "about:blank");
  const { browser } = await tabs.tabIn(agent, opened.tab);
  await Assert.rejects(
    tabs.navigate(browser, "back"),
    e => e.code === "no_history"
  );
  await Assert.rejects(
    tabs.navigate(browser, "file:///etc/hosts"),
    e => e.code === "unsupported_url"
  );
});

add_task(function the_tabs_need_a_gate() {
  Assert.throws(
    () => createAgentTabs({ engine: SvalPanel.engine }),
    /gate/,
    "no gate is refused, never assumed"
  );
});
