/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_agent_on_helpers.js */

/**
 * The jar a window's tabs use follows the workspace the window shows
 * (isolated workspaces spec §4): a window that starts on an isolated
 * workspace, and a window that goes between an isolated and a shared one.
 * `browser_sval_isolated_workspaces.js` covers one window on one isolated
 * workspace. A tab in the wrong jar is signed in as someone else, or signed
 * in where the workspace was isolated to keep it signed out.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_agent_on_helpers.js",
  this
);

add_setup(failOnConsoleErrors);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  expectWorkspaceTabs();
});

/**
 * @param {string} title
 * @returns {{url: string, title: string}} a page for `workspaceWith`.
 */
function page(title) {
  return { url: titledRed(title), title };
}

/**
 * @param {string} id An isolated workspace.
 * @returns {number} the jar Sval keeps for it, as Firefox's own container
 *   service holds it.
 */
function jarOf(id) {
  return ContextualIdentityService.getPrivateIdentity(`sval.workspace.${id}`)
    ?.userContextId;
}

/**
 * @param {Window} win
 * @param {string} id A tab's node.
 * @returns {object|undefined} the tab `win` has on show for it.
 */
function shownTab(win, id) {
  return win.gBrowser.visibleTabs.find(tab => taggedId(tab) === id);
}

/**
 * @param {Window} win
 * @returns {Promise<object>} a tab the New Tab command opened in `win`, once
 *   the window has filed it.
 */
async function newTabIn(win) {
  const tab = await newTabCommand(win);
  await nodeOfTab(tab);
  return tab;
}

/**
 * Opens `target` in a new tab from a link in the page `win` shows.
 *
 * @param {Window} win
 * @param {string} target
 * @returns {Promise<object>} the tab, once the window has filed it.
 */
async function linkedTabIn(win, target) {
  const browser = win.gBrowser.selectedBrowser;
  await SpecialPowers.spawn(browser, [target], url => {
    const link = content.document.createElement("a");
    link.id = "new";
    link.href = url;
    link.target = "_blank";
    link.textContent = "new";
    link.style = "display:block;font-size:40px;color:white";
    content.document.body.prepend(link);
  });
  const opening = BrowserTestUtils.waitForNewTab(win.gBrowser, target, true);
  await BrowserTestUtils.synthesizeMouseAtCenter("#new", {}, browser);
  const tab = await within(opening, 10_000, "the link's new tab");
  await nodeOfTab(tab);
  return tab;
}

/**
 * Asserts that `win`, started on the isolated `workspace`, has its restored
 * tab in the workspace's jar and opens a new tab and a link's tab there.
 *
 * @param {Window} win
 * @param {{id: string, tabs: string[]}} workspace
 */
async function assertStartedInItsJar(win, workspace) {
  const jar = jarOf(workspace.id);
  Assert.greater(jar, 0, "the workspace has a jar of its own");
  Assert.equal(switcherNameIn(win), "Signed in apart", "the window is on it");
  await selectedShows(win, titledRed("Kept apart"), "the workspace's page");
  Assert.equal(
    shownTab(win, workspace.tabs[0])?.userContextId,
    jar,
    "the tab the window opened for the workspace is in its jar"
  );

  const linked = await linkedTabIn(win, titledRed("Linked"));
  Assert.equal(linked.userContextId, jar, "a link's new tab is in the jar");
  const fresh = await newTabIn(win);
  Assert.equal(fresh.userContextId, jar, "and so is a new tab");
  Assert.ok(
    rowIn(win, taggedId(linked)) && rowIn(win, taggedId(fresh)),
    "both drawn in the workspace's rows"
  );
}

add_task(async function a_window_torn_off_for_an_isolated_workspace_uses_it() {
  const apart = await workspaceWith("Signed in apart", {
    isolated: true,
    pages: [page("Kept apart")],
  });
  const win = await tearOffVia(window, apart.id);
  await assertStartedInItsJar(win, apart);
});

/**
 * The New Window command's window takes the next workspace down, here the
 * isolated one, with nothing but the command to say which.
 */
add_task(async function a_new_window_on_an_isolated_workspace_uses_its_jar() {
  const apart = await workspaceWith("Signed in apart", {
    isolated: true,
    pages: [page("Kept apart")],
  });
  const win = await newWindowCommand(window);
  await assertStartedInItsJar(win, apart);
});

/**
 * A window carries one jar for the tabs it opens, set from the workspace it
 * shows, so each switch has to change it both ways.
 */
add_task(async function the_jar_follows_the_window_between_workspaces() {
  const apart = await workspaceWith("Signed in apart", {
    isolated: true,
    pages: [page("Kept apart")],
  });
  const shared = await workspaceWith("Shared", { pages: [page("Common")] });

  await switchVia(window, apart.id);
  const jar = jarOf(apart.id);
  Assert.greater(jar, 0, "the isolated workspace has a jar of its own");
  Assert.equal(
    shownTab(window, apart.tabs[0])?.userContextId,
    jar,
    "its tab is in the jar"
  );
  Assert.equal(
    (await newTabIn(window)).userContextId,
    jar,
    "and so is a new tab there"
  );

  await switchVia(window, shared.id);
  await selectedShows(window, titledRed("Common"), "the shared page");
  Assert.equal(
    shownTab(window, shared.tabs[0])?.userContextId,
    0,
    "the shared workspace's tab is in the default jar"
  );
  Assert.equal(
    (await newTabIn(window)).userContextId,
    0,
    "and so is a new tab there"
  );
  Assert.equal(
    (await linkedTabIn(window, titledRed("Linked"))).userContextId,
    0,
    "and a link's new tab"
  );

  await switchVia(window, apart.id);
  Assert.equal(
    (await newTabIn(window)).userContextId,
    jar,
    "back on the isolated workspace, a new tab is in its jar again"
  );
  Assert.ok(
    shownTabIdsIn(window).every(
      id => shownTab(window, id).userContextId === jar
    ),
    "as is every tab on show there"
  );
});

/**
 * A popup takes its opener's workspace, so a sign-in popup
 * from an isolated workspace keeps the jar it inherited and its opener. On
 * any other workspace its tab would be reopened in that one's jar, with no
 * opener to answer to.
 */
add_task(async function a_popup_from_an_isolated_workspace_stays_in_its_jar() {
  const apart = await workspaceWith("Signed in apart", {
    isolated: true,
    pages: [page("Kept apart")],
  });
  await workspaceWith("Shared", { pages: [page("Common")] });
  Assert.notEqual(
    SvalPanel._modules.SvalPanelModel.currentWorkspace(SvalPanel.nodes, null),
    apart.id,
    "a window that adopts a workspace would take another one"
  );
  await switchVia(window, apart.id);
  await selectedShows(window, titledRed("Kept apart"), "the workspace's page");
  const jar = jarOf(apart.id);
  const target = titledRed("Signing in");

  const popupWin = await newWindowAfter(() =>
    SpecialPowers.spawn(window.gBrowser.selectedBrowser, [target], url => {
      content.document.notifyUserGestureActivation();
      content.window.open(url, "_blank", "popup,width=300,height=300");
    })
  );
  atTaskEnd(async () => {
    if (!popupWin.closed) {
      await within(
        BrowserTestUtils.closeWindow(popupWin),
        10_000,
        "the popup closing"
      );
    }
  });
  Assert.ok(!popupWin.toolbar.visible, "the page opened a popup");
  Assert.equal(
    popupWin.SvalPanel._workspace.id,
    apart.id,
    "the popup shows its opener's workspace"
  );
  const popup = popupWin.gBrowser.selectedBrowser;
  await shows(popup, target, "the popup's page");
  await within(
    popupWin.SvalPanel.observer.settled(),
    10_000,
    "the popup's observer settling"
  );
  Assert.equal(
    popupWin.gBrowser.selectedTab.userContextId,
    jar,
    "the popup's tab stays in the workspace's jar"
  );
  Assert.ok(
    await SpecialPowers.spawn(
      popupWin.gBrowser.selectedBrowser,
      [],
      () => !!content.opener
    ),
    "the popup's page still has its opener"
  );
});
