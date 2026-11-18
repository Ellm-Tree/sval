/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * What only a real window can prove: that `SessionStore.setTabState`
 * materialises a tab from a tree node with the node id already on it, that
 * the tab loads nothing until it is selected, and that Firefox will not ask
 * about restoring a session. The ordering and matching logic is covered
 * without a window in `test/xpcshell/test_sval_restore.js`.
 */

const { SvalRestore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalRestore.sys.mjs"
);
const { SvalTabs } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTabs.sys.mjs"
);
const { TabStateFlusher } = ChromeUtils.importESModule(
  "resource:///modules/sessionstore/TabStateFlusher.sys.mjs"
);

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_panel_startup_helpers.js */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_panel_startup_helpers.js",
  this
);

/**
 * A workspace of this task's in the window's own document, shown in the
 * window by its own switch while it is still empty, plus helpers that file
 * tab nodes into it. An empty workspace's switch leaves the window on a home
 * page tab of the workspace's own (`SvalWindowWorkspace.handOver`), so a node filed
 * afterwards has no tab until a restore opens one.
 *
 * @returns {Promise<object>} `{ engine, workspace, addTab, addPeersTab }`.
 */
async function aShownWorkspace() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const { engine } = SvalPanel;
  const workspace = await engine.mutate({
    kind: "addWorkspace",
    name: "",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  expectWorkspaceTabs();
  Assert.ok(
    await within(
      SvalWindowWorkspace.of(window).switchTo(workspace),
      10_000,
      "the switch to the task's workspace"
    ),
    "the window shows the task's workspace"
  );
  // The home page tab is filed when its page commits, which can come after
  // the observer settles, so a task counting nodes counts from once it is.
  await filedAt(gBrowser.selectedTab);

  const addTab = (name, url, extra = {}) =>
    engine.mutate({
      kind: "addTab",
      parent: workspace,
      name,
      url,
      id: crypto.randomUUID(),
      now: Date.now(),
      ...extra,
    });

  // An address another device wrote reaches this one without the `local`
  // mark, which `mutate` keeps when a write states it.
  const addPeersTab = (name, url) => addTab(name, url, { local: false });

  return { engine, workspace, addTab, addPeersTab };
}

/**
 * A new window opened on an empty workspace of its own, as the switcher
 * opens one (`handWorkspaceTo`), once its observer has settled. A window on
 * a workspace with tabs lands on them and closes its startup tab
 * (`SvalRestore`'s `isDebris`); on an empty one the startup tab stays, an
 * `about:blank` under the test profile's `browser.startup.page`.
 *
 * @returns {Promise<DOMWindow>}
 */
async function aWindowOnAnEmptyWorkspace() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const workspace = await SvalPanel.engine.mutate({
    kind: "addWorkspace",
    name: "",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  const { handWorkspaceTo } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
  );
  const opening = BrowserTestUtils.waitForNewWindow();
  handWorkspaceTo(OpenBrowserWindow(), workspace);
  const win = await within(opening, 10_000, "a new window's opening");
  expectWorkspaceTabs(win);
  await within(win.SvalPanel.started, 20_000, "the window's startup");
  await within(win.SvalPanel.observer.settled(), 10_000, "observer settling");
  return win;
}

/**
 * Restores the workspace the window shows into it, as a switch's hand-over
 * does (`SvalWindowWorkspace.handOver`): on the window's own engine, with its tab
 * observer attached, and without closing empty tabs.
 *
 * @param {object} [options] More of `SvalRestore.restore`'s options.
 * @returns {Promise<object>} the restore result.
 */
async function restoreHere(options = {}) {
  const result = await SvalRestore.restore(window, {
    engine: SvalPanel.engine,
    workspaceId: SvalWindowWorkspace.of(window).id,
    closeDebris: false,
    ...options,
  });
  await within(SvalPanel.observer.settled(), 10_000, "observer settling");
  return result;
}

/**
 * The tab in this window carrying a node.
 *
 * @param {string} id The node's id.
 * @returns {object|undefined}
 */
const tabOf = id => gBrowser.tabs.find(tab => taggedId(tab) === id);

/**
 * A tree node becomes a real tab, tagged, titled, and not loaded.
 *
 * "Not loaded" matters at a hundred tabs: a restored tab has no
 * `linkedPanel`, so `_createLazyBrowser` gave it stub properties and no
 * content process exists for it. Selecting it instantiates the browser, and
 * `SessionStore` restores the history then.
 */
add_task(async function a_node_becomes_a_real_lazy_tab_already_tagged() {
  const { addTab } = await aShownWorkspace();
  const id = await addTab("Example", "https://example.com/");

  const result = await restoreHere();
  Assert.deepEqual(result.opened, [id], "one node, one tab");

  const tab = tabOf(id);
  ok(tab, "the tab carries the node's id, read back through the session store");
  ok(!tab.linkedPanel, "and it is lazy: no browser was instantiated for it");
  is(
    tab.linkedBrowser.currentURI.spec,
    "https://example.com/",
    "the lazy browser reports the node's URL"
  );
  is(
    tab.label,
    "Example",
    "and the tab is labelled from the node, not from a load"
  );

  // Selecting it is when SessionStore takes over. Waiting for the load
  // proves the lazy state was a pending restore and not a dead tab.
  const loaded = BrowserTestUtils.browserLoaded(
    tab.linkedBrowser,
    false,
    "https://example.com/"
  );
  await selectTab(tab);
  await within(loaded, 10_000, "the restored tab's load");
  ok(tab.linkedPanel, "selecting it instantiated the browser");
  is(
    taggedId(tab),
    id,
    "and the node id survived the restore, which is what the next launch matches on"
  );
});

/**
 * The tree decides what a tab shows (decision 0050). A tab restored before it
 * loaded, whose node another device has since navigated, is pointed at the
 * node's address, still lazy. A tab that has loaded its page is left on it.
 */
add_task(async function a_restored_tab_takes_its_nodes_address_until_loaded() {
  const { engine, addTab } = await aShownWorkspace();
  const waiting = await addTab("Example", "https://example.com/");
  const shown = await addTab("Example", "https://example.com/");
  await restoreHere();
  const loadedTab = tabOf(shown);
  const loaded = BrowserTestUtils.browserLoaded(
    loadedTab.linkedBrowser,
    false,
    "https://example.com/"
  );
  await selectTab(loadedTab);
  await within(loaded, 10_000, "the selected tab's load");
  await within(SvalPanel.observer.settled(), 10_000, "observer settling");

  for (const id of [waiting, shown]) {
    await engine.mutate({
      kind: "setContent",
      id,
      name: "Example Org",
      url: "https://example.org/",
      icon: null,
      now: Date.now(),
      local: false,
    });
  }
  const result = await restoreHere();
  Assert.deepEqual(
    result.adopted.filter(id => [waiting, shown].includes(id)).toSorted(),
    [waiting, shown].toSorted(),
    "both tabs are the nodes' own"
  );
  Assert.deepEqual(result.opened, [], "and none is opened twice");
  const waitingTab = tabOf(waiting);
  ok(!waitingTab.linkedPanel, "the tab that never loaded stays lazy");
  is(
    waitingTab.linkedBrowser.currentURI.spec,
    "https://example.org/",
    "and is pointed at its node's address"
  );
  is(
    loadedTab.linkedBrowser.currentURI.spec,
    "https://example.com/",
    "the loaded tab stays on the page it shows"
  );
});

/**
 * Any device can write a tab's address into the tree, so an address restores
 * with its own origin's authority and no more, and one another device wrote
 * that a web page could not open (a local file, a browser page, script, a
 * top-level data: page, a page's source) gets no tab at all. Sval's own home
 * page still restores.
 */
add_task(
  async function a_tree_address_restores_with_its_own_origins_authority() {
    const { engine, addTab, addPeersTab } = await aShownWorkspace();
    const web = await addTab("Example", "https://example.com/");
    const home = await addTab("New Tab", "about:home");
    const refused = [
      await addPeersTab("Hosts", "file:///etc/hosts"),
      await addPeersTab("Browser", "chrome://browser/content/browser.xhtml"),
      await addPeersTab("Config", "about:config"),
      await addPeersTab("Fake", "data:text/html,<h1>Sign in</h1>"),
      await addTab("Script", "javascript:alert(1)"),
      await addTab("Source", "view-source:https://example.com/"),
    ];

    const result = await restoreHere();
    Assert.deepEqual(
      result.opened.toSorted(),
      [web, home].toSorted(),
      "only the web page and the home page became tabs"
    );
    const nodes = (await engine.tree()).nodes;
    for (const id of refused) {
      ok(!tabOf(id), "an address a web page could not open has no tab");
      ok(
        !SvalRestore.opensHere(nodes[id], 0),
        "and the panel says it does not open here"
      );
    }

    const principalOf = tab =>
      E10SUtils.deserializePrincipal(
        JSON.parse(SessionStore.getTabState(tab)).entries[0]
          .triggeringPrincipal_base64
      );
    const webTab = tabOf(web);
    const principal = principalOf(webTab);
    ok(
      principal.isContentPrincipal &&
        principal.origin === "https://example.com",
      "the web page restores with its own origin's authority, no more"
    );
    const loaded = BrowserTestUtils.browserLoaded(
      webTab.linkedBrowser,
      false,
      "https://example.com/"
    );
    await selectTab(webTab);
    await within(loaded, 10_000, "the restored web page's load");

    is(
      SvalRestore.materialise(
        window,
        (await engine.tree()).nodes[refused[0]],
        refused[0]
      ),
      null,
      "going to a refused tab opens nothing either"
    );
  }
);

/**
 * An address this device wrote that may not leave it is marked `local`
 * (decision 1372), and restores on this device as the user's own tab, with
 * the system principal, whatever its scheme.
 */
add_task(async function this_devices_own_browser_page_restores() {
  const { engine, addTab } = await aShownWorkspace();
  const source = "view-source:resource://gre/modules/Troubleshoot.sys.mjs";
  const own = [
    await addTab("Source", source),
    await addTab("Config", "about:config"),
  ];
  const nodes = (await engine.tree()).nodes;
  for (const id of own) {
    ok(nodes[id].content.local, "the address is marked local");
    ok(SvalRestore.opensHere(nodes[id], 0), "and the panel says it opens");
  }

  const result = await restoreHere();
  Assert.deepEqual(
    result.opened.toSorted(),
    own.toSorted(),
    "both became tabs"
  );
  const tab = tabOf(own[0]);
  const entry = JSON.parse(SessionStore.getTabState(tab)).entries[0];
  ok(
    E10SUtils.deserializePrincipal(entry.triggeringPrincipal_base64)
      .isSystemPrincipal,
    "the page's source restores with the system principal"
  );
  const loaded = BrowserTestUtils.browserLoaded(
    tab.linkedBrowser,
    false,
    source
  );
  await selectTab(tab);
  await within(loaded, 10_000, "the restored source page's load");
});

/**
 * A restore lands on the tab it is told to show, and only that tab loads:
 * the others stay lazy, so nothing else was shown first.
 */
add_task(
  async function a_restore_shows_the_tab_it_is_given_and_loads_no_other() {
    const { addTab } = await aShownWorkspace();
    const first = await addTab("One", "https://example.com/one");
    const last = await addTab("Two", "https://example.com/two");

    await restoreHere({ show: () => last });
    is(taggedId(gBrowser.selectedTab), last, "the tab it was given is shown");
    ok(gBrowser.selectedTab.linkedPanel, "and its browser was instantiated");
    ok(!tabOf(first).linkedPanel, "the tab before it never loaded");
  }
);

/**
 * The window's observer recognises what restoration opened and files
 * nothing: without the id match, every launch and every switch would add
 * the tree to itself.
 */
add_task(async function the_observer_files_no_stray_for_a_restored_tab() {
  const { engine, addTab } = await aShownWorkspace();
  const first = await addTab("One", "https://example.com/one");
  const second = await addTab("Two", "https://example.com/two");
  const before = Object.keys((await engine.tree()).nodes).length;

  await restoreHere();

  const nodes = (await engine.tree()).nodes;
  is(
    Object.keys(nodes).length,
    before,
    "the restored tabs added no node at all"
  );
  ok(first in nodes && second in nodes, "both restored nodes are still there");
  ok(tabOf(first) && tabOf(second), "and both tabs are open under their ids");
});

/**
 * A settings tab is a tab like any other, so it comes back from the tree, and
 * comes back once: the observer files no second node for it, a second
 * restore adopts it, and opening settings brings the restored tab forward
 * rather than opening another.
 */
add_task(async function a_restored_settings_tab_comes_back_once() {
  const { engine, addTab } = await aShownWorkspace();
  const id = await addTab("Settings", "about:preferences#svalSync");
  const before = Object.keys((await engine.tree()).nodes).length;

  const result = await restoreHere();
  Assert.deepEqual(result.opened, [id], "the settings node became a tab");
  const tab = tabOf(id);
  ok(tab, "tagged with its node id");
  is(
    Object.keys((await engine.tree()).nodes).length,
    before,
    "the observer filed no second node for it"
  );

  const again = await restoreHere();
  is(again.opened.length, 0, "a second restore opens nothing");
  ok(again.adopted.includes(id), "it adopts the tab already open");

  const tabCount = gBrowser.tabs.length;
  const shown = SvalPanel.openSettingsPage();
  is(shown, tab, "opening settings brings the restored tab forward");
  is(gBrowser.tabs.length, tabCount, "and opens no other");
  await within(SvalPanel.observer.settled(), 10_000, "observer settling");
  is(
    Object.keys((await engine.tree()).nodes).length,
    before,
    "and the workspace still holds one settings tab"
  );
});

/**
 * A blank tab a window holds before its observer attaches gets no node.
 * `isBlankPageURL` is Firefox's own definition of "blank". The home page is
 * in that set but is filed regardless, which `browser_sval_home_page.js`
 * covers. A new window holds its startup tab before its panel attaches.
 */
add_task(async function a_blank_tab_open_before_attach_gets_no_node() {
  const win = await aWindowOnAnEmptyWorkspace();
  const blank = win.gBrowser.tabs[0];
  ok(
    win.isBlankPageURL(blank.linkedBrowser.currentURI.spec),
    `Firefox counts the startup tab's ${blank.linkedBrowser.currentURI.spec} as a blank page`
  );
  ok(
    !blank.linkedBrowser.canGoBack && !blank.linkedBrowser.canGoForward,
    "and it has no history behind it, which is the other half of the filter"
  );
  is(taggedId(blank), null, "it was not tagged");
});

/**
 * Every launch brings back the last session's windows, and nothing in a Sval
 * build can put a restore prompt on screen.
 *
 * Read off the default branch. The test profiles set
 * `browser.sessionstore.resume_from_crash` and `browser.startup.page` on the
 * user branch (`testing/profiles/mochitest/user.js`,
 * `testing/profiles/unittest-required/user.js`), so the effective values are
 * what this harness wants whatever Sval ships. Default prefs are what
 * `app-sval-prefs.js` writes, and what a real launch gets.
 *
 * `browser.startup.page` at 3 makes `SessionStartup.isAutomaticRestoreEnabled`
 * true, so `sessionType` is `RESUME_SESSION` after a crash as after a quit.
 * `resume_from_crash` is the only other condition that makes `sessionType`
 * `RECOVER_SESSION` (`SessionStartup.sessionType`), which is the only thing
 * `SessionStartup.willRestoreAsCrashed()` answers to and the only caller of
 * the `about:sessionrestore` branch (`SessionStore.initSession`).
 * `couldRestoreSession.count` below zero makes
 * `SessionWindowUI.maybeShowRestoreSessionInfoBar` return before it builds
 * the bar.
 */
add_task(async function every_launch_resumes_the_session_without_asking() {
  const defaults = Services.prefs.getDefaultBranch("");

  is(
    defaults.getIntPref("browser.startup.page"),
    3,
    "sval's default resumes the last session's windows on every launch"
  );
  is(
    defaults.getBoolPref("browser.sessionstore.resume_from_crash"),
    false,
    "and turns off the only route to about:sessionrestore"
  );
  is(
    defaults.getIntPref("browser.startup.couldRestoreSession.count"),
    -1,
    "and suppresses the restore-session infobar permanently, not for two launches"
  );
  is(
    defaults.getBoolPref("browser.sessionstore.restore_on_demand"),
    true,
    "a restored tab waits to be selected rather than loading at launch"
  );

  // As Firefox itself reads it, so the pref assertion above is more than a
  // comparison of two literals.
  ok(!SessionStartup.willRestoreAsCrashed(), "no launch restores as crashed");
});

/**
 * A killed session comes back from the tree.
 *
 * "Killed" is the state a kill leaves behind: the document on disk holds
 * tabs and nothing of the process survives. A fresh profile's window files a
 * tab, then the profile relaunches: its windows close, its engine stops, and
 * a new window starts on a new worker over the same folder, which starts
 * with an empty document and has only the folder to read.
 */
add_task(async function a_killed_session_comes_back_from_the_tree() {
  const profile = await freshProfile();
  const first = await profile.open();
  const { engine } = first.SvalPanel;
  const workspaceId = SvalWindowWorkspace.of(first).id;
  const id = await engine.mutate({
    kind: "addTab",
    parent: workspaceId,
    name: "Killed",
    url: "https://example.com/killed",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  Assert.ok(
    await within(first.SvalPanel.syncNow(), 10_000, "the pass before the kill"),
    "the tab reached the folder"
  );

  const win = await profile.relaunch();
  const panel = win.SvalPanel;
  Assert.notEqual(panel.engine, engine, "the relaunch has a new worker");
  Assert.equal(
    SvalWindowWorkspace.of(win).id,
    workspaceId,
    "on the same workspace"
  );
  const tab = win.gBrowser.tabs.find(candidate => taggedId(candidate) === id);
  ok(tab, "the killed session's tab came back as the same node it was");
  // The window shows the tab it lands on, so its page may still be loading
  // on the initial about:blank.
  await committed(
    tab.linkedBrowser,
    "https://example.com/killed",
    "pointing where it pointed"
  );
});

/**
 * Forgets every closed window, before the task and after it, so the window
 * the task closes is the one `undoCloseWindow(0)` reopens.
 */
function forgetClosedWindows() {
  const forget = () => {
    for (const { closedId } of SessionStore.getClosedWindowData()) {
      SessionStore.forgetClosedWindowById(closedId);
    }
  };
  forget();
  atTaskEnd(forget);
}

/**
 * Opens a window, files a page in it, closes it, and reopens it as History's
 * "Reopen closed window" does. `atLoad` runs in the reopened window as it
 * loads, which is before its panel's startup has restored or attached
 * anything (`SvalPanel._startFromSync`); it says so by answering whether the
 * window's observer was still to attach.
 *
 * @param {Function} atLoad Called with `(win, ids)`, `ids` being the node
 *   ids of the pages filed.
 * @param {string[]} urls The pages to file before the window closes.
 * @returns {Promise<object>} `{ win, ids, beforeAttach }`.
 */
async function reopenedWindow(atLoad, urls) {
  forgetClosedWindows();
  const first = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    10_000,
    "a new window's opening"
  );
  expectWorkspaceTabs(first);
  await within(first.SvalPanel.started, 20_000, "the window's startup");
  const ids = [];
  for (const url of urls) {
    const tab = await within(
      BrowserTestUtils.openNewForegroundTab(first.gBrowser, url),
      10_000,
      "a page's load"
    );
    await within(
      first.SvalPanel.observer.settled(),
      10_000,
      "observer settling"
    );
    ids.push(taggedId(tab));
  }
  ok(ids.every(Boolean), "the pages are filed");
  await within(
    BrowserTestUtils.closeWindow(first),
    10_000,
    "the window's closing"
  );
  await TestUtils.waitForCondition(
    () => SessionStore.getClosedWindowCount() == 1,
    "the session keeps the closed window"
  );

  let beforeAttach = null;
  const opening = BrowserTestUtils.domWindowOpenedAndLoaded().then(win => {
    beforeAttach = !win.SvalPanel.observer;
    atLoad(win, ids);
    return win;
  });
  SessionStore.undoCloseWindow(0);
  const win = await within(opening, 20_000, "the reopened window's opening");
  atTaskEnd(async () => {
    if (!win.closed) {
      await within(
        BrowserTestUtils.closeWindow(win),
        10_000,
        "the reopened window closing"
      );
    }
  });
  await within(win.SvalPanel.started, 20_000, "the reopened window's startup");
  await within(win.SvalPanel.observer.settled(), 10_000, "observer settling");
  ok(beforeAttach, "the window loaded before any observer watched it");
  return { win, ids };
}

/**
 * Restoring a window takes only the tab the window was created with for
 * debris (`SvalRestore.watchWindow`). A blank tab somebody opened is kept,
 * even one opened before the restore began, as a new tab in a window
 * `undoCloseWindow` has just reopened can be. That window arrives knowing its
 * workspace, so its own restore closes debris.
 */
add_task(async function a_blank_tab_opened_before_restoring_is_kept() {
  let opened = null;
  const { win, ids } = await reopenedWindow(
    reopened => {
      opened = BrowserTestUtils.addTab(reopened.gBrowser, "about:blank");
      ok(!taggedId(opened), "the blank tab opens filed under nothing");
    },
    ["https://example.com/"]
  );
  ok(win.gBrowser.tabs.includes(opened), "the tab opened is still there");
  ok(
    win.gBrowser.tabs.some(tab => taggedId(tab) === ids[0]),
    "beside the workspace's tab"
  );
});

/**
 * A tab the session store restores in place, carrying the node id of a node
 * that is gone, is filed again under that id, as a closed tab Firefox hands
 * back is. `setTabState` restores into a tab the window already had, so no
 * `TabOpen` announces it, and the orphan sweep a redraw runs must leave it
 * alone from the moment its id lands.
 */
add_task(async function a_tab_restored_in_place_for_a_gone_node_is_kept() {
  // A new window's blank startup tab is one its observer holds and never
  // filed (`a_blank_tab_open_before_attach_gets_no_node`).
  const win = await aWindowOnAnEmptyWorkspace();
  const { engine, observer } = win.SvalPanel;
  const workspace = SvalWindowWorkspace.of(win).id;
  const tab = win.gBrowser.tabs[0];
  is(taggedId(tab), null, "the blank tab is filed under nothing");

  const gone = crypto.randomUUID();
  const nodes = (await engine.tree()).nodes;
  const restored = BrowserTestUtils.waitForEvent(tab, "SSTabRestored");
  SessionStore.setTabState(
    tab,
    JSON.stringify({
      entries: [
        {
          url: "https://example.com/",
          triggeringPrincipal_base64: E10SUtils.SERIALIZED_SYSTEMPRINCIPAL,
        },
      ],
      extData: { [SvalTabs.NODE_ID_KEY]: gone },
    })
  );
  Assert.deepEqual(
    observer.closeOrphanTabs(nodes),
    [],
    "the orphan sweep leaves the tab alone as its id lands"
  );
  await within(restored, 10_000, "the tab's restore");
  await within(observer.settled(), 10_000, "observer settling");

  const after = (await engine.tree()).nodes;
  ok(win.gBrowser.tabs.includes(tab), "the tab is still open");
  is(taggedId(tab), gone, "under the id it was restored with");
  is(
    after[gone]?.placement?.parent,
    workspace,
    "filed again in the window's workspace"
  );
  Assert.deepEqual(observer.closeOrphanTabs(after), [], "and kept");
});

/**
 * A tab closed in a window no observer watches yet is closed for good: the
 * window's restore leaves it out, and the observer deletes its node as it
 * attaches. A window `undoCloseWindow` reopens holds its tabs before its
 * panel restores and attaches, so the user can close one in between.
 */
add_task(async function a_tab_closed_before_attach_stays_closed() {
  let closedThere = false;
  const { win, ids } = await reopenedWindow(
    (reopened, [closedId]) => {
      const tab = reopened.gBrowser.tabs.find(t => taggedId(t) === closedId);
      closedThere = !!tab;
      reopened.gBrowser.removeTab(tab);
    },
    ["https://example.com/closed", "https://example.com/kept"]
  );
  const [closedId, keptId] = ids;
  ok(closedThere, "the reopened window held the tab when it was closed");
  ok(
    !win.gBrowser.tabs.some(t => taggedId(t) === closedId),
    "no tab carries the closed tab's node"
  );
  const nodes = (await win.SvalPanel.engine.tree()).nodes;
  ok(!(closedId in nodes), "its node is deleted as the observer attaches");
  ok(keptId in nodes, "and the tab still open keeps its node");
});

/**
 * A restored tab asks the server for its page again on its first load, as a
 * reload does, so it shows the page as it is and not the copy the cache kept
 * from the last session. The page here is cacheable for an hour and counts
 * its requests, so a copy from the cache shows the count it had.
 */
add_task(async function a_restored_tab_fetches_its_page_again() {
  const url =
    getRootDirectory(gTestPath).replace(
      "chrome://mochitests/content",
      "https://example.com"
    ) + "sval_restore_counter.sjs";
  const count = browser =>
    SpecialPowers.spawn(browser, [], () => Number(content.document.title));

  const tab = await openPage(url);
  try {
    const before = await count(tab.linkedBrowser);
    await TabStateFlusher.flush(tab.linkedBrowser);
    const state = SessionStore.getTabState(tab);

    const restored = BrowserTestUtils.waitForEvent(tab, "SSTabRestored");
    SessionStore.setTabState(tab, state);
    await within(restored, 10_000, "the tab's restore");
    await pageReady(tab.linkedBrowser, url);

    is(
      await count(tab.linkedBrowser),
      before + 1,
      "the restored page came from the server"
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});
