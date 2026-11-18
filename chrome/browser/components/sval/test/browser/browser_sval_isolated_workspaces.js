/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */

/**
 * Isolated workspaces (isolated workspaces spec): every tab of an isolated
 * workspace uses the workspace's own cookie jar, every way a tab arrives
 * there, and no other tab does. Run against the window's own panel, engine
 * and tab observer, because the jar is chosen where a tab is made and only a
 * real window makes tabs.
 */

const { SvalWorkspaceJar } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalWorkspaceJar.sys.mjs"
);

const SvalPanelModel = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);
const SvalTree = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTree.sys.mjs"
);

const PAGE_A = "https://example.com/browser/?a";
const PAGE_B = "https://example.org/browser/?b";

/** The workspace the window shows between tasks. */
let home = null;

/**
 * The window's own panel, engine and tab observer, showing a workspace of
 * this file's own between tasks, so the tabs a task counts are this file's.
 */
add_setup(async function () {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  home = await SvalPanel.engine.mutate({
    kind: "addWorkspace",
    name: "Home",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  expectWorkspaceTabs();
  Assert.ok(
    await within(
      SvalWindowWorkspace.of(window).switchTo(home),
      10_000,
      "the switch to Home"
    ),
    "the window shows this file's workspace"
  );
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "the observer filing the switch's tabs"
  );
});

/**
 * A workspace, removed with everything in it when the task ends, and the
 * window switched back home.
 *
 * @param {object} [options]
 * @param {boolean} [options.isolated]
 * @param {string[]} [options.urls] Tabs to put in it.
 * @returns {Promise<string>} its id.
 */
async function workspace({ isolated = false, urls = [] } = {}) {
  const id = await SvalPanel.engine.mutate({
    kind: "addWorkspace",
    name: "Isolated test",
    isolated,
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  for (const url of urls) {
    await SvalPanel.engine.mutate({
      kind: "addTab",
      parent: id,
      name: url,
      url,
      id: crypto.randomUUID(),
      now: Date.now(),
    });
  }
  atTaskEnd(async () => {
    await SvalWindowWorkspace.of(window).switchTo(home);
    await within(
      SvalPanel.observer.settled(),
      10_000,
      "SvalPanel.observer settling"
    );
    // A task that deleted the workspace itself has nothing left to remove.
    if ((await SvalPanel.engine.tree()).nodes?.[id]) {
      await removeWorkspace(id);
    }
    await SvalPanel.refresh();
  });
  await SvalPanel.refresh();
  return id;
}

/**
 * @param {string} id A workspace.
 * @returns {object[]} the window's tabs whose nodes are in it.
 */
function tabsOf(id) {
  const nodes = SvalPanel.nodes;
  return gBrowser.tabs.filter(tab => {
    const node = SvalPanel.observer.nodeIdFor(tab);
    return node && SvalTree.isWithin(nodes, node, id);
  });
}

/**
 * Answers the next Sval dialog in this window as the user does, with its
 * primary button or Cancel.
 *
 * @param {boolean} ok
 * @returns {Promise<{tone: string, body: string}>} the dialog's tone and the
 *   sentence under its title.
 */
async function answerDialog(ok) {
  let dialog;
  await TestUtils.waitForCondition(() => {
    dialog = gDialogBox.dialog;
    return dialog && !dialog._isClosing;
  }, "a dialog opens");
  await dialogShown(dialog, "the dialog's load");
  const doc = dialog._frame.contentDocument;
  await TestUtils.waitForCondition(
    () => doc.querySelector('[data-button="ok"]'),
    "the dialog has drawn its buttons"
  );
  const seen = {
    tone: doc.querySelector(".sval-dialog").dataset.tone,
    body: doc.getElementById("sval-dialog-body").textContent,
  };
  doc.querySelector(`[data-button="${ok ? "ok" : "cancel"}"]`).click();
  return seen;
}

/**
 * Isolates workspace `id`, or stops isolating it, from its menu's command,
 * and answers the dialog that asks first.
 *
 * @param {string} id
 * @param {boolean} isolated
 * @param {boolean} ok The answer.
 * @returns {Promise<object>} what `answerDialog` saw.
 */
async function setIsolation(id, isolated, ok) {
  const done = SvalPanel.run(isolated ? "isolateWorkspace" : "shareWorkspace", {
    id,
  });
  const seen = await answerDialog(ok);
  await within(done, 10_000, "the isolation change");
  return seen;
}

add_task(async function an_isolated_workspaces_tabs_share_a_jar_of_their_own() {
  const id = await workspace({ isolated: true, urls: [PAGE_A] });
  Assert.ok(
    await SvalWindowWorkspace.of(window).switchTo(id),
    "the window switched"
  );
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );

  const jar = gBrowser.defaultUserContextId;
  Assert.greater(jar, 0, "new tabs open in a jar other than the default");
  Assert.equal(
    ContextualIdentityService.getPrivateIdentity(`sval.workspace.${id}`)
      ?.userContextId,
    jar,
    "the jar is the workspace's own hidden identity"
  );
  Assert.ok(
    !ContextualIdentityService.getPublicIdentities().some(
      identity => identity.userContextId == jar
    ),
    "no container menu lists it"
  );

  const restored = tabsOf(id);
  Assert.equal(restored.length, 1, "the workspace's tab is restored");
  Assert.equal(restored[0].userContextId, jar, "restored in the jar");

  // An add-on with the contextualIdentities permission turns containers on
  // at startup. Firefox closes every container tab and resets its identities
  // when that pref changes (ContextualIdentityService.observe). The lock
  // keeps it from changing, so the workspace's tabs and jar stay. Observers
  // are told of the clear (Preferences::ClearUser) and run before it
  // returns, and ContextualIdentityService.observe gives up on a locked pref
  // before its first await, so nothing it does is left to run later.
  Services.prefs.setBoolPref("privacy.userContext.enabled", true);
  Assert.ok(
    !Services.prefs.getBoolPref("privacy.userContext.enabled"),
    "the add-on's write leaves containers off"
  );
  Services.prefs.clearUserPref("privacy.userContext.enabled");
  Assert.equal(tabsOf(id).length, 1, "an add-on closes none of its tabs");
  Assert.equal(
    ContextualIdentityService.getPrivateIdentity(`sval.workspace.${id}`)
      ?.userContextId,
    jar,
    "nor resets its jar"
  );

  // Cmd+T's own command, and a link opened from another app.
  BrowserCommands.openTab();
  openTrustedLinkIn(PAGE_B, "tab");
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  const opened = tabsOf(id);
  Assert.equal(opened.length, 3, "both new tabs are filed in the workspace");
  for (const tab of opened) {
    Assert.equal(tab.userContextId, jar, "every tab of it uses its jar");
  }

  Assert.ok(await SvalWindowWorkspace.of(window).switchTo(home));
  Assert.equal(
    gBrowser.defaultUserContextId,
    0,
    "a shared workspace's new tabs use the default jar"
  );
});

/**
 * A link opened from another app reaches the window through
 * `BrowserDOMWindow.openURI` with `OPEN_EXTERNAL`, the path
 * `BrowserContentHandler` takes. Its first request is what the site sees, so
 * that request already carries the workspace's jar.
 */
add_task(async function a_link_from_another_app_loads_in_the_workspaces_jar() {
  const id = await workspace({ isolated: true });
  Assert.ok(
    await SvalWindowWorkspace.of(window).switchTo(id),
    "the window switched"
  );
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  const jar = gBrowser.defaultUserContextId;
  Assert.greater(jar, 0, "the workspace has a jar of its own");

  const url = "https://example.org/browser/?external";
  let observe;
  const firstRequest = new Promise(resolve => {
    observe = subject => {
      const channel = subject.QueryInterface(Ci.nsIHttpChannel);
      if (channel.URI.spec === url) {
        resolve(channel.loadInfo.originAttributes.userContextId);
      }
    };
  });
  Services.obs.addObserver(observe, "http-on-modify-request");
  atTaskEnd(() =>
    Services.obs.removeObserver(observe, "http-on-modify-request")
  );

  window.browserDOMWindow.openURI(
    Services.io.newURI(url),
    null,
    Ci.nsIBrowserDOMWindow.OPEN_NEWTAB,
    Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL,
    Services.scriptSecurityManager.getSystemPrincipal()
  );
  Assert.equal(
    await within(firstRequest, 10_000, "the link's first request"),
    jar,
    "the first request goes out in the workspace's jar"
  );
  const filed = () =>
    tabsOf(id).filter(tab => tab.linkedBrowser.currentURI.spec === url);
  await TestUtils.waitForCondition(
    () => filed().length,
    "the tab is filed in the workspace"
  );
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  Assert.equal(filed().length, 1, "one tab for the link");
  Assert.equal(filed()[0].userContextId, jar, "in the workspace's jar");
});

add_task(
  async function a_tab_arriving_in_another_jar_reopens_in_the_workspaces() {
    const id = await workspace({ isolated: true });
    Assert.ok(await SvalWindowWorkspace.of(window).switchTo(id));
    await within(
      SvalPanel.observer.settled(),
      10_000,
      "SvalPanel.observer settling"
    );
    const jar = gBrowser.defaultUserContextId;

    // What Firefox's recently-closed list does: it names the jar the tab
    // closed in.
    gBrowser.addTrustedTab(PAGE_A, { userContextId: 0 });
    await within(
      SvalPanel.observer.settled(),
      10_000,
      "SvalPanel.observer settling"
    );
    await within(
      SvalPanel.observer.settled(),
      10_000,
      "SvalPanel.observer settling"
    );

    const tabs = tabsOf(id).filter(
      tab => SvalPanel.observer.nodeIdFor(tab) && tab.userContextId !== jar
    );
    Assert.deepEqual(
      tabs,
      [],
      "no tab of the workspace is left in another jar"
    );
    const nodes = (await SvalPanel.engine.tree()).nodes;
    Assert.ok(
      Object.values(nodes).some(
        node => node.content?.url === PAGE_A && node.placement?.parent === id
      ),
      "the tab's node survived its reopening"
    );
  }
);

add_task(
  async function isolating_and_sharing_reopen_the_tabs_and_drop_the_jar() {
    const id = await workspace({ urls: [PAGE_A, PAGE_B] });
    Assert.ok(await SvalWindowWorkspace.of(window).switchTo(id));
    await within(
      SvalPanel.observer.settled(),
      10_000,
      "SvalPanel.observer settling"
    );
    for (const tab of tabsOf(id)) {
      Assert.equal(tab.userContextId, 0, "a shared workspace's tab");
    }

    const asked = [await setIsolation(id, true, true)];
    await within(
      SvalPanel.observer.settled(),
      10_000,
      "SvalPanel.observer settling"
    );
    const jar = gBrowser.defaultUserContextId;
    Assert.greater(jar, 0);
    const isolated = tabsOf(id);
    Assert.equal(isolated.length, 2, "both tabs are still in the workspace");
    for (const tab of isolated) {
      Assert.equal(tab.userContextId, jar, "each reopened in the jar");
    }

    Assert.equal(asked[0].tone, "default");
    const pill = () => SvalPanel._els.switcher.querySelector(".sval-iso-pill");
    Assert.ok(pill(), "the switcher shows the pill");
    Assert.ok(
      SvalPanel._els.switcher.getAttribute("aria-description"),
      "and describes the workspace as isolated"
    );

    asked.push(await setIsolation(id, false, true));
    Assert.equal(asked[1].tone, "danger", "stopping deletes the jar's data");
    await within(
      SvalPanel.observer.settled(),
      10_000,
      "SvalPanel.observer settling"
    );
    await SvalPanel.refresh();
    Assert.ok(!pill(), "a shared workspace has no pill");
    Assert.ok(!SvalPanel._els.switcher.hasAttribute("aria-description"));
    Assert.equal(gBrowser.defaultUserContextId, 0);
    for (const tab of tabsOf(id)) {
      Assert.equal(tab.userContextId, 0, "each is back in the default jar");
    }
    Assert.ok(
      !ContextualIdentityService.getPrivateIdentity(`sval.workspace.${id}`),
      "the jar no workspace uses is gone, with its data"
    );
  }
);

/** The switcher's list marks an isolated workspace with the box. */
add_task(async function the_switcher_list_marks_an_isolated_workspace() {
  const shared = await workspace();
  const isolated = await workspace({ isolated: true });
  SvalPanel._fillSwitcherMenu();
  const item = id =>
    SvalPanel._els.switcherMenu.querySelector(`[data-workspace-id="${id}"]`);
  Assert.ok(
    item(isolated).getAttribute("image").endsWith("workspace-isolated.svg")
  );
  Assert.ok(item(isolated).getAttribute("tooltiptext"));
  Assert.ok(!item(shared).hasAttribute("image"));
  Assert.ok(!item(shared).hasAttribute("tooltiptext"));
});

add_task(async function a_cancelled_isolation_changes_nothing() {
  const id = await workspace({ urls: [PAGE_A] });
  await setIsolation(id, true, false);
  Assert.ok(!SvalWorkspaceJar.isIsolated(SvalPanel.nodes, id));
});

add_task(async function a_move_into_another_jar_asks_first() {
  const shared = await workspace({ urls: [PAGE_A] });
  const isolated = await workspace({ isolated: true });
  Assert.ok(await SvalWindowWorkspace.of(window).switchTo(shared));
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  const tab = Object.keys(SvalPanel.nodes).find(
    n => SvalPanel.nodes[n].placement?.parent === shared
  );

  let moving = SvalPanel.moveToWorkspace(tab, isolated);
  const asked = await answerDialog(false);
  await within(moving, 10_000, "the cancelled move");
  Assert.ok(asked.body, "the move asked, saying what it costs");
  Assert.equal(
    SvalPanel.nodes[tab].placement.parent,
    shared,
    "a cancelled move moves nothing"
  );

  moving = SvalPanel.moveToWorkspace(tab, isolated);
  await answerDialog(true);
  await within(moving, 10_000, "the move");
  await SvalPanel.refresh();
  Assert.equal(SvalPanel.nodes[tab].placement.parent, isolated, "it moved");
});

add_task(async function deleting_an_isolated_workspace_drops_its_jar() {
  const id = await workspace({ isolated: true, urls: [PAGE_A] });
  Assert.ok(await SvalWindowWorkspace.of(window).switchTo(id));
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  const name = `sval.workspace.${id}`;
  Assert.ok(ContextualIdentityService.getPrivateIdentity(name));

  await SvalWindowWorkspace.of(window).switchTo(home);
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  await removeWorkspace(id);
  await SvalPanel.refresh();
  // The redraw queues the jar pass on the observer.
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  Assert.ok(
    !ContextualIdentityService.getPrivateIdentity(name),
    "a deleted workspace's jar goes with it"
  );
});

const { SvalForgetSite } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalForgetSite.sys.mjs"
);

const SECURE_SITE = Services.io.newURI("https://example.com/");

let certForTests = null;

/**
 * One certificate for every exception this file remembers and looks up.
 * `getCerts` lists every token's certificates in no stated order
 * (`PK11_ListCerts`), so its first one can differ between calls.
 *
 * @returns {nsIX509Cert}
 */
function testCert() {
  certForTests ??= Cc["@mozilla.org/security/x509certdb;1"]
    .getService(Ci.nsIX509CertDB)
    .getCerts()[0];
  return certForTests;
}

/**
 * Has `jar` seen HSTS from example.com and accepted an exception for its
 * certificate, which a site could otherwise read back from another jar.
 * Both are removed when the task ends.
 *
 * @param {number} jar A userContextId.
 */
function rememberSiteSecurity(jar) {
  const sss = Cc["@mozilla.org/ssservice;1"].getService(
    Ci.nsISiteSecurityService
  );
  const overrides = Cc["@mozilla.org/security/certoverride;1"].getService(
    Ci.nsICertOverrideService
  );
  sss.processHeader(SECURE_SITE, "max-age=1000", { userContextId: jar });
  overrides.rememberValidityOverride(
    "example.com",
    443,
    { userContextId: jar },
    testCert(),
    false
  );
  atTaskEnd(() => {
    sss.resetState(SECURE_SITE, { userContextId: jar });
    overrides.clearValidityOverride("example.com", 443, {
      userContextId: jar,
    });
  });
}

/**
 * @param {number} jar A userContextId.
 * @returns {{hsts: boolean, certificate: boolean}} Whether `jar` takes
 *   example.com's HSTS and its certificate exception.
 */
function siteSecurityIn(jar) {
  const sss = Cc["@mozilla.org/ssservice;1"].getService(
    Ci.nsISiteSecurityService
  );
  const overrides = Cc["@mozilla.org/security/certoverride;1"].getService(
    Ci.nsICertOverrideService
  );
  return {
    hsts: sss.isSecureURI(SECURE_SITE, { userContextId: jar }),
    certificate: overrides.hasMatchingOverride(
      "example.com",
      443,
      { userContextId: jar },
      testCert(),
      {}
    ),
  };
}

const TAKEN = { hsts: true, certificate: true };
const NOT_TAKEN = { hsts: false, certificate: false };

add_task(async function a_workspaces_hsts_and_exceptions_stay_in_its_jar() {
  const a = await workspace({ isolated: true });
  const b = await workspace({ isolated: true });
  const jarA = SvalWorkspaceJar.userContextIdFor(SvalPanel.nodes, a);
  const jarB = SvalWorkspaceJar.userContextIdFor(SvalPanel.nodes, b);
  rememberSiteSecurity(jarA);
  Assert.deepEqual(siteSecurityIn(jarA), TAKEN, "the workspace takes both");
  Assert.deepEqual(siteSecurityIn(jarB), NOT_TAKEN, "another doesn't");
  Assert.deepEqual(siteSecurityIn(0), NOT_TAKEN, "nor does a shared one");
});

add_task(async function deleting_a_workspace_takes_its_jars_alone() {
  const a = await workspace({ isolated: true });
  const b = await workspace({ isolated: true });
  const jarA = SvalWorkspaceJar.userContextIdFor(SvalPanel.nodes, a);
  const jarB = SvalWorkspaceJar.userContextIdFor(SvalPanel.nodes, b);
  rememberSiteSecurity(jarA);
  rememberSiteSecurity(jarB);
  await removeWorkspace(a);
  await SvalPanel.refresh();
  // The redraw queues the jar pass on the observer.
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  Assert.ok(
    !ContextualIdentityService.getPrivateIdentity(`sval.workspace.${a}`),
    "the workspace's jar is gone"
  );
  Assert.deepEqual(siteSecurityIn(jarA), NOT_TAKEN, "with what it held");
  Assert.deepEqual(siteSecurityIn(jarB), TAKEN, "another workspace keeps its");
});

add_task(async function forget_this_site_takes_it_from_every_jar() {
  const a = await workspace({ isolated: true });
  const jarA = SvalWorkspaceJar.userContextIdFor(SvalPanel.nodes, a);
  rememberSiteSecurity(jarA);
  rememberSiteSecurity(0);
  // HSTS is cleared as one of the caches (CLEAR_ALL_CACHES).
  const { failed } = await SvalForgetSite.retry("example.com", [
    "data",
    "caches",
    "certExceptions",
  ]);
  Assert.deepEqual(failed, [], "everything was forgotten");
  Assert.deepEqual(siteSecurityIn(jarA), NOT_TAKEN, "in the workspace's jar");
  Assert.deepEqual(siteSecurityIn(0), NOT_TAKEN, "and the shared one");
});

/**
 * An empty document is one not read yet, never one with no workspace, so it
 * removes no jar and deletes no one's sign-ins.
 */
add_task(async function an_empty_document_removes_no_jar() {
  const id = await workspace({ isolated: true });
  const jar = SvalWorkspaceJar.userContextIdFor(SvalPanel.nodes, id);
  Assert.equal(SvalWorkspaceJar.prune({}), 0, "nothing is removed");
  Assert.equal(
    ContextualIdentityService.getPrivateIdentity(`sval.workspace.${id}`)
      ?.userContextId,
    jar,
    "the jar is still there"
  );
});

/**
 * A tab follows its own workspace's jar, also in a window that shows another
 * workspace, as an agent's tab can.
 */
add_task(async function a_tab_outside_the_shown_workspace_follows_its_jar() {
  const id = await workspace({ urls: [PAGE_A] });
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  const tabId = Object.keys(SvalPanel.nodes).find(
    n => SvalPanel.nodes[n].placement?.parent === id
  );
  // Shown here although the window shows home.
  const { SvalRestore } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalRestore.sys.mjs"
  );
  const tab = SvalRestore.open(window, SvalPanel.nodes[tabId], tabId, 0);
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );

  await SvalPanel.engine.mutate({
    kind: "setIsolation",
    id,
    isolated: true,
    now: Date.now(),
  });
  await SvalPanel.refresh();
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );

  const jar = SvalWorkspaceJar.userContextIdFor(SvalPanel.nodes, id);
  const now = SvalPanel.observer.tabFor(tabId);
  Assert.ok(now, "the tab is still open");
  Assert.notEqual(now, tab, "reopened");
  Assert.equal(now.userContextId, jar, "in its workspace's new jar");
  Assert.equal(
    gBrowser.defaultUserContextId,
    0,
    "the window's own is unchanged"
  );
  gBrowser.removeTab(now, { animate: false, skipSessionStore: true });
});

/**
 * A peer taking away the workspace this window shows reaches the panel
 * through the tab observer's own queue (`onTreeChanged`), and the hand-over
 * it starts reopens tabs in their jars on that queue. Both finish.
 */
add_task(async function a_peers_switch_from_the_observers_queue_finishes() {
  const { SvalRestore } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalRestore.sys.mjs"
  );
  const shown = await workspace({ isolated: true, urls: [PAGE_A] });
  const other = await workspace({ urls: [PAGE_B] });
  Assert.ok(await SvalWindowWorkspace.of(window).switchTo(shown));
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );

  // A tab of a workspace the window does not show, as an agent's can be.
  const otherTab = Object.keys(SvalPanel.nodes).find(
    n => SvalPanel.nodes[n].placement?.parent === other
  );
  const tab = SvalRestore.open(window, SvalPanel.nodes[otherTab], otherTab, 0);
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );

  // A peer's pass deletes the workspace shown here. The panel has not drawn
  // it, so the next `onTreeChanged` is what finds it gone.
  await removeWorkspace(shown);
  gBrowser.removeTab(tab, { animate: false });

  // Asserted instead of thrown, so a wait that never ends is named before
  // the task's teardown, which waits on the same queue, times the test out.
  Assert.ok(
    await within(
      SvalPanel.observer.settled(),
      10_000,
      "the observer's queue"
    ).then(
      () => true,
      () => false
    ),
    "the queue the peer's change arrived on settles"
  );
  Assert.ok(
    await within(
      SvalWindowWorkspace.of(window).handOversSettled(),
      10_000,
      "the peer's hand-over"
    ).then(
      () => true,
      () => false
    ),
    "and the hand-over it started finishes"
  );
  Assert.notEqual(
    SvalWindowWorkspace.of(window).id,
    shown,
    "the window moved off it"
  );
  Assert.equal(
    SvalPanel.nodes[SvalWindowWorkspace.of(window).id]?.kind,
    SvalTree.WORKSPACE,
    "to a workspace the document holds"
  );
});
