/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * Keep Awake, from a tab's menu and the Launcher: the tab carries Firefox's
 * `undiscardable` mark, which its memory unloader honours, and the unload of
 * a Workspace hidden for `HIDDEN_WORKSPACE_UNLOAD_MS` leaves it loaded (spec
 * §10.7).
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);

const { liveExemptions } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalArchive.sys.mjs"
);
const { TabStateFlusher } = ChromeUtils.importESModule(
  "resource:///modules/sessionstore/TabStateFlusher.sys.mjs"
);
const { COMMANDS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLauncherCommands.sys.mjs"
);
const { HIDDEN_WORKSPACE_UNLOAD_MS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTabs.sys.mjs"
);
const { SvalClock } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalClock.sys.mjs"
);

/**
 * The sweep as it runs once the hidden Workspace's time is up.
 *
 * @param {object} observer A `SvalTabObserver`.
 * @returns {Promise<object>}
 */
function sweepPastTheTime(observer) {
  return observer.releaseIdle(SvalClock.now() + HIDDEN_WORKSPACE_UNLOAD_MS);
}

/**
 * @param {string} id A tab's node id.
 * @returns {Element} the row menu's Keep Awake item, fitted to the row.
 */
function keepLoadedItem(id) {
  const menu = SvalPanel._els.contextMenu;
  SvalPanel.rowMenu.sync(menu, SvalPanel._rowFor(id));
  return menu.querySelector('[data-command="keepLoaded"]');
}

add_task(async function a_kept_tab_outlasts_the_idle_unload() {
  const { ids, observer } = await withSwitcherTabs();
  const [first, second] = ids.workspaces;
  const id = ids.tabs[0];
  const tab = observer.tabFor(id);
  await untilRestored(tab);
  // Gecko's menus check an item that carries `checked` at any value.
  Assert.ok(
    !keepLoadedItem(id).hasAttribute("checked"),
    "a tab starts unchecked"
  );

  await SvalPanel.run("keepLoaded", SvalPanel._rowFor(id));
  Assert.ok(tab.undiscardable, "Keep Awake marks the tab");
  Assert.ok(
    keepLoadedItem(id).hasAttribute("checked"),
    "and its menu shows it checked"
  );
  Assert.ok(
    (await liveExemptions()).includes(id),
    "the idle-tab archive skips it"
  );
  await TabStateFlusher.flush(tab.linkedBrowser);
  Assert.equal(
    JSON.parse(SessionStore.getTabState(tab)).attributes?.undiscardable,
    "",
    "session restore keeps the mark"
  );

  Assert.ok(
    await SvalWindowWorkspace.of(window).switchTo(second),
    "the window switched away"
  );
  await sweepPastTheTime(observer);
  Assert.ok(
    gBrowser.tabs.includes(tab) && tab.linkedPanel,
    "the kept tab is still loaded"
  );
  Assert.ok(
    await SvalWindowWorkspace.of(window).switchTo(first),
    "and switched back"
  );
  Assert.equal(observer.tabFor(id), tab, "the same tab is back");

  await SvalPanel.run("keepLoaded", SvalPanel._rowFor(id));
  Assert.ok(!tab.undiscardable, "a second Keep Awake clears the mark");
  Assert.ok(
    !keepLoadedItem(id).hasAttribute("checked"),
    "and its menu shows it unchecked"
  );
  Assert.ok(
    await SvalWindowWorkspace.of(window).switchTo(second),
    "the window switched away"
  );
  await sweepPastTheTime(observer);
  Assert.ok(
    !gBrowser.tabs.includes(tab) || !tab.linkedPanel,
    "the idle unload releases the tab"
  );
  Assert.ok(
    await SvalWindowWorkspace.of(window).switchTo(first),
    "and switched back"
  );
});

add_task(async function the_launcher_keeps_the_selected_tab_loaded() {
  const tab = gBrowser.selectedTab;
  const byId = id => COMMANDS.find(c => c.id === id);
  Assert.ok(byId("keep-tab-loaded").available(window), "it offers to keep");
  Assert.ok(!byId("let-tab-unload").available(window), "not to let go");

  byId("keep-tab-loaded").run(window);
  atTaskEnd(() => (tab.undiscardable = false));
  Assert.ok(tab.undiscardable, "the selected tab is kept loaded");
  Assert.ok(!byId("keep-tab-loaded").available(window), "now not to keep");
  Assert.ok(byId("let-tab-unload").available(window), "but to let go");

  byId("let-tab-unload").run(window);
  Assert.ok(!tab.undiscardable, "and letting go clears the mark");
});
