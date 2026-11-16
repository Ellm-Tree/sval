/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * A WebDriver client opens a window in Sval the way it does in Firefox
 * (docs/webdriver-bidi.md). BiDi's `browsingContext.create` and classic
 * `WebDriver:NewWindow` both open it through the remote agent's
 * `WindowManager.openBrowserWindow`, so a BiDi session here covers both.
 */

const { RemoteAgent: RemoteAgentModule } = ChromeUtils.importESModule(
  "chrome://remote/content/components/RemoteAgent.sys.mjs"
);
const { WebDriverBiDi } = ChromeUtils.importESModule(
  "chrome://remote/content/webdriver-bidi/WebDriverBiDi.sys.mjs"
);
const { NavigableManager } = ChromeUtils.importESModule(
  "chrome://remote/content/shared/NavigableManager.sys.mjs"
);
const { UserContextManager } = ChromeUtils.importESModule(
  "chrome://remote/content/shared/UserContextManager.sys.mjs"
);
const { TabManager } = ChromeUtils.importESModule(
  "chrome://remote/content/shared/TabManager.sys.mjs"
);
const { windowManager } = ChromeUtils.importESModule(
  "chrome://remote/content/shared/WindowManager.sys.mjs"
);
const { SvalWorkspaceJar } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalWorkspaceJar.sys.mjs"
);
const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { TabStateFlusher } = ChromeUtils.importESModule(
  "resource:///modules/sessionstore/TabStateFlusher.sys.mjs"
);
const { SvalLocalSettings } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLocalSettings.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
});

/**
 * The window is an ordinary Sval window: its panel starts, it shows a
 * workspace of its own (spec §10.7), and nothing marks it as an agent's,
 * because WebDriver runs outside Sval's agent controls.
 */
add_task(async function a_bidi_client_opens_a_window() {
  // An HTTP session runs BiDi's commands all the same. A BiDi one waits for
  // the remote agent's own startup, and the harness does not start the agent.
  const bidi = new WebDriverBiDi(RemoteAgentModule);
  await bidi.createSession({}, new Set(["http"]));
  atTaskEnd(() => bidi.deleteSession());

  let context;
  const win = await newWindowAfter(async () => {
    ({ context } = await within(
      bidi.session.execute("browsingContext", "create", { type: "window" }),
      30_000,
      "browsingContext.create"
    ));
  });

  Assert.equal(
    NavigableManager.getBrowserById(context),
    win.gBrowser.selectedBrowser,
    "the new context is the new window's tab"
  );
  Assert.ok(
    !win.document.documentElement.hasAttribute("data-sval-agent"),
    "the window is not marked as an agent's"
  );
  Assert.ok(win.SvalPanel.workspaceId, "the window shows a workspace");
  Assert.notEqual(
    win.SvalPanel.workspaceId,
    SvalPanel.workspaceId,
    "a workspace no other window shows"
  );

  const closed = BrowserTestUtils.domWindowClosed(win);
  await within(
    bidi.session.execute("browsingContext", "close", { context }),
    10_000,
    "browsingContext.close"
  );
  await within(closed, 10_000, "the window closing");
});

/**
 * A BiDi session that ends with the task.
 *
 * @returns {Promise<Function>} Runs one command: module, name, parameters.
 */
async function bidiSession() {
  const bidi = new WebDriverBiDi(RemoteAgentModule);
  await bidi.createSession({}, new Set(["http"]));
  atTaskEnd(() => bidi.deleteSession());
  return (module, command, params) =>
    within(
      bidi.session.execute(module, command, params),
      30_000,
      `${module}.${command}`
    );
}

/**
 * @param {object} browser
 * @returns {number} The cookie jar its page uses.
 */
function jarOf(browser) {
  return browser.browsingContext.originAttributes.userContextId;
}

/**
 * Waits for `win`'s tab observer to have filed every tab and moved any that
 * is in the wrong jar (`SvalTabs`' `#keepInJar`).
 *
 * @param {Window} win
 */
async function settled(win) {
  await within(win.SvalPanel.observer.settled(), 10_000, "the tabs settling");
}

/**
 * Asserts that `win` shows a workspace of its own named "WebDriver",
 * isolated, whose jar is `jar`, and that the jar is neither the default nor
 * the jar of the workspace the user's window shows.
 *
 * @param {Window} win
 * @param {number} jar
 */
function assertWebDriverJar(win, jar) {
  const workspaceId = win.SvalPanel.workspaceId;
  const node = win.SvalPanel.nodes[workspaceId];
  Assert.notEqual(jar, 0, "the tab is not in the default jar");
  Assert.notEqual(
    jar,
    gBrowser.defaultUserContextId ?? 0,
    "nor in the jar of the user's workspace"
  );
  Assert.notEqual(
    workspaceId,
    SvalPanel.workspaceId,
    "the window shows a workspace the user's window does not"
  );
  Assert.equal(node?.content?.name, "WebDriver", "named WebDriver");
  Assert.ok(
    SvalWorkspaceJar.isIsolated(win.SvalPanel.nodes, workspaceId),
    "the workspace is isolated"
  );
  Assert.equal(
    SvalWorkspaceJar.identityOf(jar)?.workspaceId,
    workspaceId,
    "the jar is that workspace's own"
  );
}

/**
 * A window BiDi opens on the default user context, as every client does that
 * names none, gets a workspace of its own with its own jar, so the client
 * never shares the user's cookies. A tab opened in that window on the
 * default user context follows the window's jar.
 */
add_task(async function a_bidi_window_has_a_jar_of_its_own() {
  const run = await bidiSession();
  let context;
  const win = await newWindowAfter(async () => {
    ({ context } = await run("browsingContext", "create", { type: "window" }));
  });
  const browser = NavigableManager.getBrowserById(context);
  const jar = jarOf(browser);
  assertWebDriverJar(win, jar);

  // At once, as a client does, before the window's panel has settled.
  const { context: tabContext } = await run("browsingContext", "create", {
    type: "tab",
    referenceContext: context,
    userContext: "default",
  });
  const tabBrowser = NavigableManager.getBrowserById(tabContext);
  Assert.equal(tabBrowser?.documentGlobal, win, "the tab opens in the window");
  Assert.equal(jarOf(tabBrowser), jar, "in the window's jar");

  await settled(win);
  Assert.equal(
    NavigableManager.getBrowserById(context),
    browser,
    "the window's tab stays the client's"
  );
  Assert.equal(
    NavigableManager.getBrowserById(tabContext),
    tabBrowser,
    "and so does the tab"
  );
});

add_task(async function an_explicit_default_gets_a_jar_of_its_own() {
  const run = await bidiSession();
  let context;
  const win = await newWindowAfter(async () => {
    ({ context } = await run("browsingContext", "create", {
      type: "window",
      userContext: "default",
    }));
  });
  assertWebDriverJar(win, jarOf(NavigableManager.getBrowserById(context)));
});

/**
 * Only a user context the client made over BiDi is kept as named. Another
 * identity's jar, which BiDi knows by an id too, and an id nothing has, give
 * way to the window's own jar.
 */
add_task(async function a_jar_the_client_did_not_make_gives_way() {
  const run = await bidiSession();
  const other = ContextualIdentityService.create("sval-test-other");
  atTaskEnd(() => ContextualIdentityService.remove(other.userContextId));
  const otherId = UserContextManager.getIdByInternalId(other.userContextId);
  Assert.ok(otherId, "BiDi knows the other identity");

  let context;
  const win = await newWindowAfter(async () => {
    ({ context } = await run("browsingContext", "create", {
      type: "window",
      userContext: otherId,
    }));
  });
  const jar = jarOf(NavigableManager.getBrowserById(context));
  assertWebDriverJar(win, jar);

  const { context: tabContext } = await run("browsingContext", "create", {
    type: "tab",
    referenceContext: context,
    userContext: otherId,
  });
  Assert.equal(
    jarOf(NavigableManager.getBrowserById(tabContext)),
    jar,
    "a tab naming it opens in the window's jar"
  );

  // A tab that reaches that jar some other way is moved to the window's.
  win.gBrowser.addTrustedTab("about:blank", {
    userContextId: other.userContextId,
  });
  await settled(win);
  await settled(win);
  Assert.deepEqual(
    win.gBrowser.tabs
      .filter(tab => tab.userContextId === other.userContextId)
      .map(tab => tab.userContextId),
    [],
    "no tab is left in the other jar"
  );

  await Assert.rejects(
    run("browsingContext", "create", {
      type: "window",
      userContext: "no-such-context",
    }),
    /User Context with id no-such-context was not found/,
    "BiDi refuses a user context nothing has"
  );
  let opened;
  await newWindowAfter(async () => {
    opened = await within(
      windowManager.openBrowserWindow({
        focus: true,
        userContextId: "no-such-context",
      }),
      30_000,
      "openBrowserWindow"
    );
  });
  assertWebDriverJar(opened, jarOf(opened.gBrowser.selectedBrowser));
});

/**
 * WebDriver classic's NewWindow names no user context, and gets the same.
 */
add_task(async function a_classic_window_has_a_jar_of_its_own() {
  let opened;
  const win = await newWindowAfter(async () => {
    opened = await within(
      windowManager.openBrowserWindow({ focus: true }),
      30_000,
      "openBrowserWindow"
    );
  });
  Assert.equal(opened, win, "the window WebDriver opened");
  assertWebDriverJar(win, jarOf(win.gBrowser.selectedBrowser));
});

/**
 * A user context the client made (`browser.createUserContext`) is already
 * apart from the user's default jar, so a window and a tab opened on it stay
 * in it.
 */
add_task(async function a_user_context_the_client_made_is_kept() {
  const run = await bidiSession();
  const { userContext } = await run("browser", "createUserContext", {});
  atTaskEnd(() =>
    run("browser", "removeUserContext", { userContext }).catch(() => {})
  );
  const internal = UserContextManager.getInternalIdById(userContext);
  Assert.greater(internal, 0, "the client's user context has a jar");

  let context;
  const win = await newWindowAfter(async () => {
    ({ context } = await run("browsingContext", "create", {
      type: "window",
      userContext,
    }));
  });
  const browser = NavigableManager.getBrowserById(context);
  Assert.equal(jarOf(browser), internal, "the window's tab is in it");

  const { context: tabContext } = await run("browsingContext", "create", {
    type: "tab",
    referenceContext: context,
    userContext,
  });
  const tabBrowser = NavigableManager.getBrowserById(tabContext);
  Assert.equal(jarOf(tabBrowser), internal, "so is a tab opened in it");

  await settled(win);
  Assert.equal(
    NavigableManager.getBrowserById(context),
    browser,
    "the window's tab stays the client's"
  );
  Assert.equal(
    NavigableManager.getBrowserById(tabContext),
    tabBrowser,
    "and so does the tab"
  );
});

/**
 * A private window WebDriver opens is in private browsing's own jar, and no
 * workspace is made for it.
 */
add_task(async function a_private_window_stays_private() {
  const engine = SvalEngine.sharedInstance;
  const before = Object.keys((await engine.tree()).nodes ?? {}).length;
  const win = await newWindowAfter(async () => {
    await within(
      windowManager.openBrowserWindow({ focus: true, isPrivate: true }),
      30_000,
      "openBrowserWindow"
    );
  });
  Assert.ok(PrivateBrowsingUtils.isWindowPrivate(win), "the window is private");
  const { originAttributes } = win.gBrowser.selectedBrowser.browsingContext;
  Assert.equal(originAttributes.privateBrowsingId, 1, "its tab is private");
  const { SvalPrivateJars } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalPrivateJars.sys.mjs"
  );
  Assert.ok(
    SvalPrivateJars.isPrivateJar(originAttributes.userContextId),
    "in a private window's jar of its own"
  );
  Assert.equal(
    SvalWorkspaceJar.identityOf(originAttributes.userContextId),
    null,
    "in no workspace's jar"
  );
  Assert.equal(
    Object.keys((await engine.tree()).nodes ?? {}).length,
    before,
    "and no workspace was made for it"
  );
});

/**
 * A tab a client opens in one of the user's windows goes to a window of
 * WebDriver's, with its own jar, never into the user's workspace. A second
 * one goes to the same window.
 */
add_task(async function a_tab_in_the_users_window_goes_to_webdriver() {
  const run = await bidiSession();
  const userTabs = gBrowser.tabs.length;
  const referenceContext = NavigableManager.getIdForBrowser(
    gBrowser.selectedBrowser
  );
  let context;
  const win = await newWindowAfter(async () => {
    ({ context } = await run("browsingContext", "create", {
      type: "tab",
      referenceContext,
    }));
  });
  const browser = NavigableManager.getBrowserById(context);
  Assert.equal(browser.documentGlobal, win, "the tab opens in a new window");
  Assert.deepEqual(
    win.gBrowser.tabs.map(tab => tab.linkedBrowser),
    [browser],
    "as that window's only tab"
  );
  assertWebDriverJar(win, jarOf(browser));
  Assert.equal(gBrowser.tabs.length, userTabs, "none opens in the user's");

  const { context: second } = await run("browsingContext", "create", {
    type: "tab",
    referenceContext,
  });
  const secondBrowser = NavigableManager.getBrowserById(second);
  Assert.equal(secondBrowser.documentGlobal, win, "the next goes there too");
  Assert.equal(jarOf(secondBrowser), jarOf(browser), "in the same jar");

  // Classic NewWindow's tab, opened in the user's window.
  const classic = await within(
    TabManager.addTab({ window }),
    30_000,
    "TabManager.addTab"
  );
  Assert.equal(
    TabManager.getWindowForTab(classic),
    win,
    "a classic tab goes there too"
  );
  Assert.equal(gBrowser.tabs.length, userTabs, "and none opens in the user's");
  Assert.equal(win.gBrowser.tabs.length, 3, "and no blank one stays");

  await settled(win);
  Assert.equal(
    NavigableManager.getBrowserById(context),
    browser,
    "the tab stays the client's"
  );
});

/**
 * With "Let WebDriver use your Workspaces' cookies" on, a tab a client opens in
 * one of the user's windows stays there, in that workspace's jar.
 */
add_task(async function the_switch_lets_a_tab_use_the_users_workspace() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.sval.webdriver.useWorkspaceCookies", true]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const run = await bidiSession();
  const { context } = await run("browsingContext", "create", {
    type: "tab",
    referenceContext: NavigableManager.getIdForBrowser(
      gBrowser.selectedBrowser
    ),
    background: true,
  });
  const browser = NavigableManager.getBrowserById(context);
  atTaskEnd(() => gBrowser.removeTab(gBrowser.getTabForBrowser(browser)));
  Assert.equal(browser.documentGlobal, window, "the tab opens in that window");
  Assert.equal(
    jarOf(browser),
    gBrowser.defaultUserContextId ?? 0,
    "in its workspace's jar"
  );
});

const { SvalWebDriver } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalWebDriver.sys.mjs"
);

/**
 * Opens a tab over BiDi from the user's window, which opens a WebDriver
 * window for it.
 *
 * @param {Function} run
 * @returns {Promise<Window>}
 */
function routedTab(run) {
  const referenceContext = NavigableManager.getIdForBrowser(
    gBrowser.selectedBrowser
  );
  return newWindowAfter(() =>
    run("browsingContext", "create", { type: "tab", referenceContext })
  );
}

/**
 * What a WebDriver window holds never reaches the user's synced document:
 * neither its workspace nor a page it loads.
 */
add_task(async function a_webdriver_window_never_reaches_the_document() {
  const run = await bidiSession();
  const win = await routedTab(run);
  const workspaceId = win.SvalPanel.workspaceId;
  const url = `https://example.com/?webdriver=${crypto.randomUUID()}`;
  const loaded = BrowserTestUtils.browserLoaded(
    win.gBrowser.selectedBrowser,
    false,
    url
  );
  BrowserTestUtils.startLoadingURIString(win.gBrowser.selectedBrowser, url);
  await within(loaded, 10_000, "the page loading");
  await settled(win);
  const ownTab = Object.values(win.SvalPanel.nodes).find(
    node => node.content?.url === url
  );
  Assert.ok(ownTab, "the window's own tree holds the page");

  const nodes = (await SvalEngine.sharedInstance.tree()).nodes ?? {};
  Assert.ok(!nodes[workspaceId], "the document has no WebDriver workspace");
  Assert.ok(
    !Object.values(nodes).some(node => node.content?.url === url),
    "nor the page"
  );
});

/**
 * Opens a window, and gives it `record`, a window of a saved session, as
 * Restore Previous Session does to the window it restores into.
 *
 * @param {object} record
 */
async function restoreInto(record) {
  const win = await newWindowAfter(() => {
    OpenBrowserWindow();
  });
  await within(win.SvalPanel.started, 10_000, "its panel starting");
  SessionStore.setWindowState(win, JSON.stringify({ windows: [record] }), true);
  await settled(win);
}

/**
 * A WebDriver window is in no session Sval could restore: not the one a quit
 * or a crash leaves, which a restart or Restore Previous Session reopens, nor
 * the recently closed windows. Whatever is restored, none of its tabs reaches
 * the synced document.
 */
add_task(async function a_restored_webdriver_window_never_files_a_tab() {
  const run = await bidiSession();
  const win = await routedTab(run);
  const url = `https://example.com/?webdriver=${crypto.randomUUID()}`;
  const loaded = BrowserTestUtils.browserLoaded(
    win.gBrowser.selectedBrowser,
    false,
    url
  );
  BrowserTestUtils.startLoadingURIString(win.gBrowser.selectedBrowser, url);
  await within(loaded, 10_000, "the page loading");
  await settled(win);
  // What the session store holds of the tab is in its window's state.
  await within(TabStateFlusher.flushWindow(win), 10_000, "the session flush");
  const holds = record => JSON.stringify(record).includes(url);

  const saved = JSON.parse(SessionStore.getBrowserState()).windows.filter(
    holds
  );
  await within(BrowserTestUtils.closeWindow(win), 10_000, "the window closing");
  const closed = SessionStore.getClosedWindowData().filter(holds);

  for (const record of saved) {
    await restoreInto(record);
  }
  for (let i = 0; i < closed.length; i++) {
    const index = SessionStore.getClosedWindowData().findIndex(holds);
    const reopened = await newWindowAfter(() => {
      SessionStore.undoCloseWindow(index);
    });
    await TestUtils.waitForCondition(
      () => reopened.closed || reopened.SvalPanel.observer,
      "the reopened window starts or closes"
    );
    if (!reopened.closed) {
      await settled(reopened);
    }
  }
  const nodes = (await SvalEngine.sharedInstance.tree()).nodes ?? {};
  Assert.ok(
    !Object.values(nodes).some(node => node.content?.url === url),
    "no restored tab reaches the document"
  );
  Assert.deepEqual(
    [saved.length, closed.length],
    [0, 0],
    "and no session holds the window"
  );
});

/**
 * A WebDriver workspace lives while its window is open: closing it removes
 * the workspace and its jar, and leaves another WebDriver window's.
 */
add_task(async function closing_a_window_removes_its_workspace() {
  const run = await bidiSession();
  const first = await routedTab(run);
  let context;
  const second = await newWindowAfter(async () => {
    ({ context } = await run("browsingContext", "create", { type: "window" }));
  });
  const firstId = first.SvalPanel.workspaceId;
  const secondId = second.SvalPanel.workspaceId;
  const jarName = id => `sval.workspace.${id}`;
  Assert.ok(
    ContextualIdentityService.getPrivateIdentity(jarName(firstId)),
    "the first window has a jar"
  );

  await within(
    BrowserTestUtils.closeWindow(first),
    10_000,
    "the first window closing"
  );
  await TestUtils.waitForCondition(
    async () => !(await second.SvalPanel.engine.tree()).nodes[firstId],
    "its workspace goes"
  );
  await TestUtils.waitForCondition(
    () => !ContextualIdentityService.getPrivateIdentity(jarName(firstId)),
    "and its jar"
  );
  Assert.ok(
    (await second.SvalPanel.engine.tree()).nodes[secondId],
    "the other window keeps its workspace"
  );
  Assert.ok(
    ContextualIdentityService.getPrivateIdentity(jarName(secondId)),
    "and its jar"
  );

  const closed = BrowserTestUtils.domWindowClosed(second);
  await run("browsingContext", "close", { context });
  await within(closed, 10_000, "the second window closing");
  await TestUtils.waitForCondition(
    () => !ContextualIdentityService.getPrivateIdentity(jarName(secondId)),
    "the last window's jar goes too"
  );
});

/**
 * A profile whose settings record WebDriver workspaces in the synced
 * document has them deleted, and the record goes from the file.
 */
add_task(async function a_recorded_webdriver_workspace_is_deleted() {
  const engine = SvalEngine.sharedInstance;
  const left = await engine.mutate({
    kind: "addWorkspace",
    name: "WebDriver",
    isolated: true,
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  const tab = await engine.mutate({
    kind: "addTab",
    parent: left,
    name: "t",
    url: "https://example.com/",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  const path = tempPath("sval-webdriver-left", ".json");
  await IOUtils.writeJSON(path, { webDriverWorkspaces: [left] });
  const store = await SvalLocalSettings.open(path);

  await within(
    SvalWebDriver.deleteLeftWorkspaces(store, engine),
    10_000,
    "deleting the recorded workspaces"
  );
  const nodes = (await engine.tree()).nodes ?? {};
  Assert.ok(!nodes[left], "the recorded workspace is deleted");
  Assert.ok(!nodes[tab], "with its tab");
  Assert.ok(nodes[SvalPanel.workspaceId], "the user's stays");
  Assert.ok(
    !("webDriverWorkspaces" in (await IOUtils.readJSON(path))),
    "and the record is gone from the file"
  );
});

/**
 * Two tabs a client opens at once from the user's window go to one WebDriver
 * window: the second waits for the first's window.
 */
add_task(async function tabs_routed_at_once_share_one_window() {
  const run = await bidiSession();
  const referenceContext = NavigableManager.getIdForBrowser(
    gBrowser.selectedBrowser
  );
  const windows = () => [...Services.wm.getEnumerator("navigator:browser")];
  const before = windows().length;
  let contexts;
  const win = await newWindowAfter(async () => {
    contexts = await Promise.all([
      run("browsingContext", "create", { type: "tab", referenceContext }),
      run("browsingContext", "create", { type: "tab", referenceContext }),
    ]);
  });
  Assert.equal(windows().length, before + 1, "one window opens");
  const browsers = contexts.map(({ context }) =>
    NavigableManager.getBrowserById(context)
  );
  for (const browser of browsers) {
    Assert.equal(browser.documentGlobal, win, "each tab is in it");
  }
  Assert.equal(win.gBrowser.tabs.length, 2, "as its only tabs");
});

/**
 * A tab a client opens from the user's window while its window command is
 * still opening a WebDriver window goes to that window.
 */
add_task(async function a_tab_routed_as_a_window_opens_goes_there() {
  const run = await bidiSession();
  const referenceContext = NavigableManager.getIdForBrowser(
    gBrowser.selectedBrowser
  );
  const windows = () => [...Services.wm.getEnumerator("navigator:browser")];
  const before = windows().length;
  let opened;
  const win = await newWindowAfter(async () => {
    opened = await Promise.all([
      run("browsingContext", "create", { type: "window" }),
      run("browsingContext", "create", { type: "tab", referenceContext }),
    ]);
  });
  Assert.equal(windows().length, before + 1, "one window opens");
  const [windowTab, routed] = opened.map(({ context }) =>
    NavigableManager.getBrowserById(context)
  );
  Assert.equal(windowTab.documentGlobal, win, "the window's own tab");
  Assert.equal(routed.documentGlobal, win, "and the routed tab are in it");
});

/**
 * A window that never starts fails its own command, is closed, and holds
 * back no later one.
 */
add_task(async function a_window_that_never_starts_fails_alone() {
  const { windowStartMs } = SvalWebDriver;
  SvalWebDriver.windowStartMs = 500;
  atTaskEnd(() => (SvalWebDriver.windowStartMs = windowStartMs));
  let stuck;
  const closed = new Promise(resolve => {
    const observer = subject => {
      if (subject === stuck) {
        Services.obs.removeObserver(observer, "domwindowclosed");
        resolve();
      }
    };
    Services.obs.addObserver(observer, "domwindowclosed");
  });
  await Assert.rejects(
    within(
      SvalWebDriver.openWindow(
        { isPrivate: false, userContextId: null },
        () => {
          stuck = Services.ww.openWindow(
            null,
            AppConstants.BROWSER_CHROME_URL,
            "_blank",
            "chrome,all,dialog=no",
            null
          );
          return new Promise(() => {});
        }
      ),
      10_000,
      "the stuck window's command"
    ),
    /did not start/,
    "its command fails"
  );
  await within(closed, 10_000, "the stuck window closing");
  SvalWebDriver.windowStartMs = windowStartMs;

  const run = await bidiSession();
  const win = await routedTab(run);
  Assert.ok(
    SvalWorkspaceJar.isIsolated(win.SvalPanel.nodes, win.SvalPanel.workspaceId),
    "and a later command opens its window"
  );
});
