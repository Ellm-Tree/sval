/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_agent_sites_helpers.js */

/**
 * Whether a tab is an agent's is the tree's answer (`SvalAgentTabRegistry`):
 * the workspace above its node carries the agent's mark. The agent's tools,
 * the gate's checks on loads, downloads, file pickers and dialogs, and the
 * mark that gives pages WebMCP give it alike, at the same moment, as the
 * tree moves a tab into the agent's workspace and out of it. A tab the tree
 * does not hold yet is no one's. Its first load waits for its filing when it
 * could be an agent's, and goes on at once in the user's window.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_agent_sites_helpers.js",
  this
);

/**
 * `sval_panel_startup_helpers.js`, in a scope of its own: it declares
 * `SvalEngine` too, as `sval_agent_sites_helpers.js` does. Names reach it
 * through this file's scope object, which holds head.js's functions; its
 * `const`s are lexical, so those it uses are handed over.
 */
const startup = Object.assign(Object.create(this), { within, tempPath });
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_panel_startup_helpers.js",
  startup
);

const DOWNLOAD = ROOT + "sval_agent_download.sjs";

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * What the checks Gecko and Sval make without waiting say of `browser`'s
 * tab, read in one turn so that nothing moves between them: Gecko's
 * questions before a file picker and a download (`nsISvalAgentFiles`, which
 * `SvalAgentFiles.h` asks), the gate's own, and the mark that gives the
 * tab's pages WebMCP.
 *
 * @param {object} gate
 * @param {object} browser
 * @returns {{picker: boolean, download: boolean, gate: boolean, webmcp: boolean}}
 *   For each, whether it treats the tab as the agent's.
 */
function answersNow(gate, browser) {
  const files = Cc["@sval/agent-files;1"].getService(Ci.nsISvalAgentFiles);
  const bc = browser.browsingContext;
  return {
    picker: files.refusesFilePicker(bc),
    download: !!files.downloadDialog(bc),
    gate: gate.agentOf(browser) !== null,
    webmcp: bc.svalAgentTab,
  };
}

/**
 * @param {boolean} agents
 * @returns {object} What {@link answersNow} reads for a tab that is the
 *   agent's, or is not.
 */
const everyCheckSays = agents => ({
  picker: agents,
  download: agents,
  gate: agents,
  webmcp: agents,
});

/**
 * @param {object} tabs
 * @param {object} agent
 * @param {string} tabId
 * @returns {Promise<boolean>}
 */
async function toolsReach(tabs, agent, tabId) {
  try {
    await tabs.tabIn(agent, tabId);
    return true;
  } catch (err) {
    Assert.equal(err.code, "not_controlled", "the tools refuse it as no tab");
    return false;
  }
}

/**
 * A tab the agent opened, moved by the user into a window of their own,
 * stops being the agent's for every check at once: the tools stop reaching
 * it, the gate stops checking its loads, its downloads and file pickers are
 * Firefox's again, and its pages lose WebMCP.
 */
add_task(async function a_tab_moved_out_is_the_agents_for_no_check() {
  const { tabs, agent, gate, call, win } = await agentSetup({
    sites: { "example.com": "full", "example.org": "blocked" },
  });
  const { tab } = await call("open_tab", { url: PAGE });
  const found = await tabs.tabIn(agent, tab);
  const browser = found.tab.linkedBrowser;
  Assert.deepEqual(
    answersNow(gate, browser),
    everyCheckSays(true),
    "in its workspace, every check says it is the agent's"
  );
  Assert.ok(await toolsReach(tabs, agent, tab), "and the tools reach it");
  const stops = stopsIn(win);
  loadPastLayer(browser, ORG_PAGE);
  await refused(stops, browser, ORG_PAGE);

  const taken = gBrowser.adoptTab(found.tab, { selectTab: false });
  atTaskEnd(async () => {
    if (taken.isConnected && !taken.closing) {
      await BrowserTestUtils.removeTab(taken);
    }
  });
  await TestUtils.waitForCondition(
    () => !gate.agentOf(taken.linkedBrowser),
    "the gate lets the tab go"
  );
  Assert.deepEqual(
    answersNow(gate, taken.linkedBrowser),
    everyCheckSays(false),
    "and in the same turn, so does every other check"
  );
  Assert.ok(!(await toolsReach(tabs, agent, tab)), "the tools do not reach it");
  const loaded = BrowserTestUtils.browserLoaded(
    taken.linkedBrowser,
    false,
    ORG_PAGE
  );
  BrowserTestUtils.startLoadingURIString(taken.linkedBrowser, ORG_PAGE);
  await within(loaded, 10_000, "the user's load");
});

/**
 * A tab of the user's handed to the agent, moved into its window and filed
 * under its workspace, becomes the agent's for every check at once.
 */
add_task(async function a_tab_moved_in_is_the_agents_for_every_check() {
  const { tabs, agent, gate, call, win, ws } = await agentSetup({
    sites: { "example.com": "full", "example.org": "blocked" },
  });
  // The agent has a tab of its own, so its window is open.
  await call("open_tab", { url: PAGE });
  const userTab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE),
    10_000,
    "the user's tab's load"
  );
  atTaskEnd(() => {
    if (gBrowser.tabs.includes(userTab)) {
      BrowserTestUtils.removeTab(userTab);
    }
  });
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  Assert.deepEqual(
    answersNow(gate, userTab.linkedBrowser),
    everyCheckSays(false),
    "in the user's workspace, no check says it is the agent's"
  );

  const handed = win.gBrowser.adoptTab(userTab, { selectTab: false });
  const observer = win.SvalPanel.observer;
  await TestUtils.waitForCondition(
    () => observer.nodeIdFor(handed),
    "the handed tab arrives with its node"
  );
  await observer.refile(handed, ws);
  const browser = handed.linkedBrowser;
  Assert.deepEqual(
    answersNow(gate, browser),
    everyCheckSays(true),
    "filed under the agent's workspace, every check says it is the agent's"
  );
  Assert.ok(
    await toolsReach(tabs, agent, observer.nodeIdFor(handed)),
    "and the tools reach it"
  );
  const stops = stopsIn(win);
  loadPastLayer(browser, ORG_PAGE);
  await refused(stops, browser, ORG_PAGE);
});

/**
 * A tab whose node the tree files outside the agent's workspace, while the
 * tab is still open in the agent's window, is not the agent's for any check:
 * the tools do not reach it, its pages' dialogs are not the agent's to
 * answer, its loads are not gated, and its downloads and pickers are
 * Firefox's.
 */
add_task(async function a_tab_the_tree_files_elsewhere_is_not_the_agents() {
  const { tabs, agent, gate, call, win } = await agentSetup({
    sites: { "example.com": "full", "example.org": "blocked" },
  });
  const { tab } = await call("open_tab", { url: PAGE });
  const found = await tabs.tabIn(agent, tab);
  const browser = found.tab.linkedBrowser;
  Assert.deepEqual(answersNow(gate, browser), everyCheckSays(true));

  // The tree moves the node into the user's workspace, as a move in the
  // panel or on another device does.
  const engine = SvalPanel.engine;
  const target = moveIntoTarget(
    (await engine.tree()).nodes,
    tab,
    SvalWindowWorkspace.of(window).id
  );
  await engine.mutate({ kind: "moveNode", ...target, now: Date.now() });
  await win.SvalPanel.refresh();
  await within(
    win.SvalPanel.observer.settled(),
    10_000,
    "win.SvalPanel.observer settling"
  );
  Assert.ok(
    win.gBrowser.tabs.includes(found.tab),
    "the tab is still open in the agent's window"
  );
  Assert.deepEqual(
    answersNow(gate, browser),
    everyCheckSays(false),
    "no check says it is the agent's"
  );
  Assert.ok(!(await toolsReach(tabs, agent, tab)), "the tools do not reach it");
  const loaded = BrowserTestUtils.browserLoaded(browser, false, ORG_PAGE);
  loadPastLayer(browser, ORG_PAGE);
  await within(loaded, 10_000, "a load the agent may not make goes ahead");
});

/**
 * A tab the tree files in another of the app's workspaces, one no session
 * has acted in yet, as a restored session's are, is the agent's as much as
 * one where its tools act.
 */
add_task(
  async function a_tab_in_another_of_the_apps_workspaces_is_the_agents() {
    const { tabs, agent, gate, call, win } = await agentSetup({
      sites: { "example.com": "full" },
    });
    const { tab } = await call("open_tab", { url: PAGE });
    const found = await tabs.tabIn(agent, tab);
    const browser = found.tab.linkedBrowser;
    const engine = SvalPanel.engine;
    const other = await engine.mutate({
      kind: "addAgentWorkspace",
      name: "Another session",
      agentLabel: agent.label,
      id: crypto.randomUUID(),
      now: Date.now(),
      isolated: false,
    });
    atTaskEnd(() => removeWorkspace(other));
    await SvalAgents.store.addWorkspace(agent.agentId, other, {
      task: "Another session",
    });
    const target = moveIntoTarget((await engine.tree()).nodes, tab, other);
    await engine.mutate({ kind: "moveNode", ...target, now: Date.now() });
    await win.SvalPanel.refresh();
    await within(
      win.SvalPanel.observer.settled(),
      10_000,
      "win.SvalPanel.observer settling"
    );
    Assert.deepEqual(
      answersNow(gate, browser),
      everyCheckSays(true),
      "every check says it is the agent's"
    );
  }
);

/**
 * A tab of the agent's that a window keeps hidden, as a switch to another
 * workspace keeps a tab it could not unload, is still filed under the
 * agent's workspace, and stays the agent's as the tree changes around it.
 */
add_task(async function a_hidden_agent_tab_stays_the_agents() {
  const { tabs, agent, gate, call, win } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const shown = await tabs.tabIn(
    agent,
    (await call("open_tab", { url: PAGE2 })).tab
  );
  const { tab } = await call("open_tab", { url: PAGE });
  const found = await tabs.tabIn(agent, tab);
  await selectTab(shown.tab);
  win.gBrowser.hideTab(found.tab);
  Assert.ok(found.tab.hidden, "the tab is hidden");
  await call("open_tab", { url: PAGE2 });
  await within(
    win.SvalPanel.observer.settled(),
    10_000,
    "win.SvalPanel.observer settling"
  );
  Assert.deepEqual(
    answersNow(gate, found.tab.linkedBrowser),
    everyCheckSays(true),
    "it is still the agent's after the tree changed"
  );
});

/**
 * A tab the tree holds no node for yet is no one's, whatever window it is
 * in, and is the agent's once its window has filed it under the agent's
 * workspace.
 */
add_task(async function a_new_tab_is_no_ones_until_it_is_filed() {
  const { gate, call, win } = await agentSetup({
    sites: { "example.com": "full" },
  });
  await call("open_tab", { url: PAGE });
  const tab = win.gBrowser.addWebTab("about:blank", {
    triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({}),
    skipLoad: true,
  });
  atTaskEnd(() => {
    if (!tab.closing) {
      win.gBrowser.removeTab(tab);
    }
  });
  Assert.deepEqual(
    answersNow(gate, tab.linkedBrowser),
    { picker: true, download: true, gate: false, webmcp: false },
    "before its node exists it is no one's, and no picker or download is made"
  );
  await within(
    win.SvalPanel.observer.settled(),
    10_000,
    "win.SvalPanel.observer settling"
  );
  Assert.deepEqual(
    answersNow(gate, tab.linkedBrowser),
    everyCheckSays(true),
    "filed under the agent's workspace, it is the agent's"
  );
});

/**
 * A popup an agent's page opens is filed under the agent's workspace before
 * its first load goes, and that load is the agent's to be refused.
 */
add_task(async function a_popups_first_load_is_the_agents() {
  const { tabs, agent, gate, call } = await agentSetup({
    sites: { "example.com": "full", "example.org": "blocked" },
  });
  const { tab } = await call("open_tab", { url: PAGE });
  const { browser } = await tabs.tabIn(agent, tab);
  // Watched from before the popup opens: its first load can be refused
  // before the window has finished loading.
  const stopped = Promise.withResolvers();
  const onStop = subject => {
    const channel = subject.QueryInterface(Ci.nsIChannel);
    if (channel.URI.spec === ORG_PAGE) {
      stopped.resolve(channel.status);
    }
  };
  Services.obs.addObserver(onStop, "http-on-stop-request");
  atTaskEnd(() => Services.obs.removeObserver(onStop, "http-on-stop-request"));
  const windowOpened = BrowserTestUtils.domWindowOpenedAndLoaded();
  await SpecialPowers.spawn(browser, [ORG_PAGE], url => {
    content.document.notifyUserGestureActivation();
    content.window.open(url, "_blank", "popup,width=300,height=300");
  });
  const popupWin = await within(windowOpened, 10_000, "a window opening");
  atTaskEnd(async () => {
    if (!popupWin.closed) {
      await within(
        BrowserTestUtils.closeWindow(popupWin),
        10_000,
        "the window closing"
      );
    }
  });
  Assert.notEqual(
    await within(stopped.promise, 10_000, "the popup's first load ending"),
    Cr.NS_OK,
    "the popup's first load is refused"
  );
  const popup = popupWin.gBrowser.selectedBrowser;
  Assert.equal(
    gate.agentOf(popup)?.agentId,
    agent.agentId,
    "the popup is the agent's tab"
  );
  await blockedPage(popup);
});

/**
 * In a window with no tab observer, nothing can file a new tab, so the tree
 * cannot say whose it is, and its first load is refused. A window whose
 * profile has no workspace yet, because its shared folder is away and it
 * holds no copy of its own, is such a window (local-copy spec §4.4).
 */
add_task(async function a_window_that_cannot_file_refuses_a_first_load() {
  await agentSetup({ sites: { "example.com": "full" } });
  const profile = await startup.freshProfile({
    shared: tempPath("sval-missing"),
  });
  const win = await profile.open();
  Assert.ok(!win.SvalPanel.observer, "the window has no tab observer");
  const stopped = Promise.withResolvers();
  const onStop = subject => {
    const channel = subject.QueryInterface(Ci.nsIChannel);
    if (channel.URI.spec === PAGE2) {
      stopped.resolve(channel.status);
    }
  };
  Services.obs.addObserver(onStop, "http-on-stop-request");
  atTaskEnd(() => Services.obs.removeObserver(onStop, "http-on-stop-request"));
  const tab = BrowserTestUtils.addTab(win.gBrowser, PAGE2);
  atTaskEnd(() => {
    if (!tab.closing) {
      BrowserTestUtils.removeTab(tab);
    }
  });
  Assert.equal(
    await within(stopped.promise, 10_000, "the new tab's first load ending"),
    Cr.NS_ERROR_TAB_NOT_FILED,
    "the first load is refused"
  );
  await blockedPage(tab.linkedBrowser, "tabNotFiled");
  Assert.equal(
    await SpecialPowers.spawn(
      tab.linkedBrowser,
      [],
      () => content.document.body.dataset.reason
    ),
    "tabNotFiled",
    "about:agentblocked says why"
  );
});

/**
 * A URL typed into the window's blank startup tab loads while agent access
 * is on: the tab is filed as its first load starts, and the load goes on.
 */
add_task(async function a_url_typed_into_a_blank_tab_loads() {
  await agentSetup({ sites: { "example.com": "full" } });
  const tab = SvalPanel.observer.openUnfiledTab({ blank: true });
  atTaskEnd(() => {
    if (!tab.closing) {
      gBrowser.removeTab(tab);
    }
  });
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  Assert.ok(!SvalPanel.observer.nodeIdFor(tab), "the blank tab has no node");
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, PAGE);
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, PAGE);
  await within(loaded, 10_000, "the typed URL's load");
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  Assert.ok(SvalPanel.observer.nodeIdFor(tab), "and the tab is filed");
});

/**
 * A tab in the user's window is no agent's, so its first load never waits
 * for its filing, however long that takes: the gate's answer, read as the
 * load's request goes out, is that it need not.
 */
add_task(async function a_users_tab_loads_without_waiting_for_its_filing() {
  const { awaitsFiling } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgentTabRegistry.sys.mjs"
  );
  await agentSetup({ sites: { "example.com": "full" } });
  const url = `${PAGE}?users-tab`;
  const seen = Promise.withResolvers();
  const onRequest = subject => {
    const channel = subject.QueryInterface(Ci.nsIChannel);
    const browser = channel.loadInfo.browsingContext?.embedderElement;
    if (channel.URI.spec === url && browser) {
      seen.resolve(awaitsFiling(browser));
    }
  };
  Services.obs.addObserver(onRequest, "http-on-modify-request");
  atTaskEnd(() =>
    Services.obs.removeObserver(onRequest, "http-on-modify-request")
  );
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, url),
    10_000,
    "the tab's first load"
  );
  Assert.strictEqual(
    await within(seen.promise, 10_000, "the first load's request"),
    false,
    "the first load did not wait for the tab's filing"
  );
  Assert.equal(tab.linkedBrowser.currentURI.spec, url, "the page loaded");
  BrowserTestUtils.removeTab(tab);
});

/**
 * A window whose panel has not started shows no workspace the tree holds
 * yet, so its tab could be an agent's, and its first load waits for the
 * filing, then goes on as the user's.
 */
add_task(async function a_first_load_before_the_panel_starts_waits() {
  const { awaitsFiling } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgentTabRegistry.sys.mjs"
  );
  await agentSetup({ sites: { "example.com": "full" }, openWindow: false });
  const url = `${PAGE}?before-start`;
  const seen = Promise.withResolvers();
  const onRequest = subject => {
    const channel = subject.QueryInterface(Ci.nsIChannel);
    const bc = channel.loadInfo.browsingContext;
    if (channel.URI.spec === url && bc?.embedderElement) {
      const win = bc.embedderElement.documentGlobal;
      seen.resolve({
        started: !!SvalWindowWorkspace.of(win).id,
        waits: awaitsFiling(bc.embedderElement),
      });
    }
  };
  Services.obs.addObserver(onRequest, "http-on-modify-request");
  atTaskEnd(() =>
    Services.obs.removeObserver(onRequest, "http-on-modify-request")
  );
  const args = Cc["@mozilla.org/supports-string;1"].createInstance(
    Ci.nsISupportsString
  );
  args.data = url;
  const opened = BrowserTestUtils.waitForNewWindow({ url });
  const win = expectOpened(BrowserWindowTracker.openWindow({ args }));
  atTaskEnd(() =>
    within(BrowserTestUtils.closeWindow(win), 10_000, "the window closing")
  );
  const first = await within(seen.promise, 10_000, "the window's first load");
  Assert.deepEqual(
    first,
    { started: false, waits: true },
    "before its panel starts, the first load waits for the filing"
  );
  await within(opened, 10_000, "the page loading");
  Assert.equal(win.gBrowser.selectedBrowser.currentURI.spec, url, "it loads");
  await within(
    win.SvalPanel.observer.settled(),
    10_000,
    "win.SvalPanel.observer settling"
  );
  Assert.ok(
    win.SvalPanel.observer.nodeIdFor(win.gBrowser.selectedTab),
    "filed"
  );
});

/**
 * A Quick Peek in the agent's window is the agent's from its first load, with no
 * filing to wait for: a site the agent may visit draws, and one it may not
 * is refused.
 */
add_task(async function a_quick_peek_in_the_agents_window_is_the_agents() {
  const { SvalQuickPeek } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalQuickPeek.sys.mjs"
  );
  const { tabs, agent, gate, call, win } = await agentSetup({
    sites: { "example.com": "full", "example.org": "blocked" },
  });
  const { tab } = await call("open_tab", { url: PAGE });
  const { browser } = await tabs.tabIn(agent, tab);
  await selectTab(win.gBrowser.getTabForBrowser(browser));
  await SpecialPowers.spawn(browser, [PAGE2, ORG_PAGE], (allowed, blocked) => {
    for (const [id, href] of [
      ["allowed", allowed],
      ["blocked", blocked],
    ]) {
      const link = content.document.createElement("a");
      link.id = id;
      link.href = href;
      link.textContent = id;
      content.document.body.prepend(link, content.document.createElement("br"));
    }
  });
  const stopped = Promise.withResolvers();
  const onStop = subject => {
    const channel = subject.QueryInterface(Ci.nsIChannel);
    if (channel.URI.spec === ORG_PAGE) {
      stopped.resolve(channel.status);
    }
  };
  Services.obs.addObserver(onStop, "http-on-stop-request");
  atTaskEnd(() => Services.obs.removeObserver(onStop, "http-on-stop-request"));

  const quickPeekAt = async selector => {
    await BrowserTestUtils.synthesizeMouseAtCenter(
      selector,
      { altKey: true },
      browser
    );
    return TestUtils.waitForCondition(
      () => SvalQuickPeek.tabOf(win),
      `${selector}: a Quick Peek opens`
    );
  };
  const closeQuickPeek = async quickPeek => {
    win.document
      .getElementById(quickPeek.linkedPanel)
      .querySelector(".sval-quick-peek-close")
      .click();
    await TestUtils.waitForCondition(
      () => !SvalQuickPeek.tabOf(win) && !quickPeek.isConnected,
      "the Quick Peek closes"
    );
  };

  const allowed = await quickPeekAt("#allowed");
  await TestUtils.waitForCondition(
    () =>
      allowed.linkedBrowser.currentURI.spec === PAGE2 &&
      !allowed.hasAttribute("busy"),
    "the allowed site's page loads in the Quick Peek"
  );
  Assert.equal(
    await SpecialPowers.spawn(
      allowed.linkedBrowser,
      [],
      () => content.document.readyState
    ),
    "complete",
    "and draws"
  );
  Assert.equal(
    gate.agentOf(allowed.linkedBrowser)?.agentId,
    agent.agentId,
    "as the agent's"
  );
  const opened = BrowserTestUtils.waitForEvent(
    win.gBrowser.tabContainer,
    "TabOpen"
  );
  await SpecialPowers.spawn(allowed.linkedBrowser, [PAGE], url => {
    content.document.notifyUserGestureActivation();
    content.window.open(url);
  });
  const fromQuickPeek = (await within(opened, 10_000, "the TabOpen event"))
    .target.linkedBrowser;
  // Whose a tab is comes from the tree, which holds a new tab once the
  // window's tab observer has filed it.
  await within(
    win.SvalPanel.observer.settled(),
    10_000,
    "win.SvalPanel.observer settling"
  );
  Assert.equal(
    gate.agentOf(fromQuickPeek)?.agentId,
    agent.agentId,
    "a tab the Quick Peek's page opens is the agent's too"
  );
  await closeQuickPeek(allowed);

  const blocked = await quickPeekAt("#blocked");
  Assert.notEqual(
    await within(stopped.promise, 10_000, "the blocked site's load ending"),
    Cr.NS_OK,
    "the blocked site's load is refused"
  );
  await blockedPage(blocked.linkedBrowser);
  await closeQuickPeek(blocked);
});

/**
 * While the user holds the agent's workspace, a tab opened there is in the
 * user's control because of where the tree files it.
 */
add_task(async function a_tab_opened_in_a_held_workspace_is_the_users() {
  const { holdWorkspace, isUserInControl } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs"
  );
  const { gate, call, win, ws } = await agentSetup({
    sites: { "example.com": "full" },
  });
  await call("open_tab", { url: PAGE });
  holdWorkspace(ws, true);
  atTaskEnd(() => holdWorkspace(ws, false));
  const tab = BrowserTestUtils.addTab(win.gBrowser, PAGE);
  atTaskEnd(() => {
    if (!tab.closing) {
      BrowserTestUtils.removeTab(tab);
    }
  });
  await within(
    BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, PAGE),
    10_000,
    "the tab's load"
  );
  await within(
    win.SvalPanel.observer.settled(),
    10_000,
    "win.SvalPanel.observer settling"
  );
  Assert.ok(
    isUserInControl(tab.linkedBrowser.browsingContext.browserId),
    "the new tab is in the user's control"
  );
  Assert.equal(gate.agentOf(tab.linkedBrowser), null, "and not the agent's");
});

/**
 * Sends downloads to a fresh folder for the task, and clears what it saved.
 *
 * @returns {Promise<{dir: string, list: object}>}
 */
async function downloadFolder() {
  const dir = await makeTempDir("sval-agent-downloads");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.download.dir", dir],
      ["browser.download.folderList", 2],
      ["browser.download.useDownloadDir", true],
    ],
  });
  const list = await Downloads.getList(Downloads.ALL);
  atTaskEnd(async () => {
    for (const download of await list.getAll()) {
      await download.finalize(true).catch(() => {});
      await list.remove(download);
    }
    await IOUtils.remove(dir, { recursive: true });
    await SpecialPowers.popPrefEnv();
  });
  return { dir, list };
}

/**
 * Has the page in `browser` download `name` from the test server, as its
 * own script would.
 *
 * @param {object} browser
 * @param {string} name
 */
async function pageDownloads(browser, name) {
  const code = `location.href = ${JSON.stringify(`${DOWNLOAD}?name=${name}`)};`;
  await SpecialPowers.spawn(browser, [code], c => {
    content.eval(c);
  });
}

/**
 * A download a page starts in an agent's tab is the agent's: decided by its
 * permission, saved with no dialog, and listed for it. Once the user has
 * taken the tab, a download there is the user's, and the agent never sees
 * it.
 */
add_task(async function a_download_in_an_agents_tab_is_the_agents() {
  const { list } = await downloadFolder();
  const { tabs, agent, gate, call, store, alerts } = await agentSetup({
    sites: { "example.com": "full" },
  });
  await store.setFilePermission(
    agent.agentId,
    "downloads",
    "example.com",
    "allow"
  );
  const { tab } = await call("open_tab", { url: PAGE });
  const found = await tabs.tabIn(agent, tab);
  await pageDownloads(found.browser, "agents.txt");
  await TestUtils.waitForCondition(
    async () =>
      (await call("list_downloads", {})).downloads.some(
        d => d.file_name === "agents.txt" && d.state === "done"
      ),
    "the agent's download is listed for it, saved"
  );
  Assert.equal(alerts.opened, 0, "an allowed site's download is not asked");

  const taken = gBrowser.adoptTab(found.tab, { selectTab: false });
  atTaskEnd(async () => {
    if (taken.isConnected && !taken.closing) {
      await BrowserTestUtils.removeTab(taken);
    }
  });
  await TestUtils.waitForCondition(
    () => !gate.agentOf(taken.linkedBrowser),
    "the user has the tab"
  );
  await pageDownloads(taken.linkedBrowser, "users.txt");
  await TestUtils.waitForCondition(
    async () =>
      (await list.getAll()).some(
        d => d.succeeded && PathUtils.filename(d.target.path) === "users.txt"
      ),
    "the user's download finished"
  );
  // The user's download opens the Downloads panel in their window
  // (`browser.download.alwaysOpenPanel`), which would otherwise take the next
  // file's Escape.
  await TestUtils.waitForCondition(
    () => document.getElementById("downloadsPanel")?.state === "open",
    "the user's download shows in their Downloads panel"
  );
  const hidden = BrowserTestUtils.waitForPopupEvent(
    document.getElementById("downloadsPanel"),
    "hidden"
  );
  DownloadsPanel.hidePanel();
  await within(hidden, 10_000, "the Downloads panel closing");
  Assert.deepEqual(
    (await call("list_downloads", {})).downloads.map(d => d.file_name),
    ["agents.txt"],
    "the agent sees only its own"
  );
});

/**
 * A popup an agent's page opens holds no node until it loads a page. Until
 * then nothing is decided for it: a file picker its page asks for is
 * refused, and a download it starts waits for its filing and is then the
 * agent's.
 */
add_task(
  async function a_popup_not_yet_filed_opens_no_picker_and_downloads_as_the_agents() {
    const MockFilePicker = SpecialPowers.MockFilePicker;
    MockFilePicker.init(window.browsingContext);
    let shown = 0;
    MockFilePicker.showCallback = () => {
      shown++;
    };
    MockFilePicker.returnValue = MockFilePicker.returnCancel;
    atTaskEnd(() => MockFilePicker.cleanup());
    await downloadFolder();
    const { tabs, agent, call, store } = await agentSetup({
      sites: { "example.com": "full" },
    });
    await store.setFilePermission(
      agent.agentId,
      "downloads",
      "example.com",
      "allow"
    );
    const { tab } = await call("open_tab", { url: LINKS });
    const { browser } = await tabs.tabIn(agent, tab);
    const popupWin = await newWindowAfter(() => clickIn(browser, "#popup"));
    await within(popupWin.SvalPanel.started, 10_000, "the panel's startup");
    const popupTab = popupWin.gBrowser.selectedTab;
    const popup = popupTab.linkedBrowser;
    await within(
      popupWin.SvalPanel.observer.settled(),
      10_000,
      "popupWin.SvalPanel.observer settling"
    );
    Assert.ok(
      !popupWin.SvalPanel.observer.nodeIdFor(popupTab),
      "the blank popup has no node yet"
    );

    await SpecialPowers.spawn(popup, [], async () => {
      const input = content.document.createElement("input");
      input.type = "file";
      content.document.body.append(input);
      const cancelled = new Promise(resolve =>
        input.addEventListener("cancel", resolve, { once: true })
      );
      content.document.notifyUserGestureActivation();
      input.showPicker();
      await cancelled;
    });
    Assert.equal(shown, 0, "no file picker opened in the unfiled popup");

    await pageDownloads(popup, "popup.txt");
    await TestUtils.waitForCondition(
      async () =>
        (await call("list_downloads", {})).downloads.some(
          d => d.file_name === "popup.txt" && d.state === "done"
        ),
      "the popup's download is the agent's, decided by its permission"
    );
    Assert.ok(
      popupWin.SvalPanel.observer.nodeIdFor(popupTab),
      "the popup was filed before its download was decided"
    );
  }
);

/**
 * A long agent session on a page that keeps making and dropping frames
 * keeps no more record of where loads started than the frames it has now.
 */
/**
 * The new tab page a window preloads is in no tab and opened by no page, so
 * it is no one's: every check lets it be, and the gate keeps no record of
 * its load.
 */
add_task(async function a_preloaded_new_tab_page_is_no_ones() {
  const { gate, call } = await agentSetup({
    sites: { "example.com": "full" },
  });
  await call("open_tab", { url: PAGE });
  NewTabPagePreloading.removePreloadedBrowser(window);
  atTaskEnd(() => NewTabPagePreloading.removePreloadedBrowser(window));
  const settled = gate.loadsRecordedForTests();
  await explained(
    within(
      BrowserTestUtils.maybeCreatePreloadedBrowser(gBrowser),
      10_000,
      "the preloaded new tab page"
    ),
    () => loadState(gBrowser.preloadedBrowser)
  );
  const preloaded = gBrowser.preloadedBrowser;
  Assert.ok(preloaded, "the window preloads its new tab page");
  Assert.deepEqual(
    answersNow(gate, preloaded),
    everyCheckSays(false),
    "no check treats it as an agent's"
  );
  Assert.equal(
    gate.loadsRecordedForTests(),
    settled,
    "its load is not recorded"
  );
});

/**
 * Any other page in no tab could be an agent's, as the tree cannot say
 * whose it is: nothing is decided there, so its picker is refused and its
 * downloads are held, even in the user's own window.
 */
add_task(async function another_page_in_no_tab_waits() {
  const { gate } = await agentSetup({ sites: { "example.com": "full" } });
  const browser = document.createXULElement("browser");
  browser.setAttribute("type", "content");
  browser.setAttribute("remote", "true");
  browser.setAttribute("maychangeremoteness", "true");
  document.documentElement.append(browser);
  atTaskEnd(() => browser.remove());
  Assert.ok(browser.browsingContext, "its page is there");
  const now = answersNow(gate, browser);
  Assert.ok(now.picker, "its file picker is refused");
  Assert.ok(now.download, "its download waits");
});

add_task(async function frames_that_come_and_go_leave_no_load_record() {
  const { tabs, agent, gate, call } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: PAGE });
  const { browser } = await tabs.tabIn(agent, tab);
  const FRAMES = 6;
  const settled = gate.loadsRecordedForTests();
  for (let round = 0; round < 5; round++) {
    await SpecialPowers.spawn(browser, [PAGE2, FRAMES], async (src, count) => {
      const frames = [];
      for (let i = 0; i < count; i++) {
        const frame = content.document.createElement("iframe");
        frames.push(
          new Promise(resolve =>
            frame.addEventListener("load", resolve, { once: true })
          )
        );
        frame.src = src;
        content.document.body.append(frame);
      }
      await Promise.all(frames);
    });
    Assert.greaterOrEqual(
      gate.loadsRecordedForTests(),
      settled + FRAMES,
      "each frame's load is recorded while it is there"
    );
    await SpecialPowers.spawn(browser, [], () => {
      for (const frame of content.document.querySelectorAll("iframe")) {
        frame.remove();
      }
    });
    await TestUtils.waitForCondition(
      () => gate.loadsRecordedForTests() <= settled,
      "the frames' records go with them"
    );
  }
});
