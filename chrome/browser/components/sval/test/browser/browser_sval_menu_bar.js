/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_pins_helpers.js */

/**
 * The menu bar's own menus (`SvalMenuBar`): Workspaces, Favorites and Tab,
 * each running the panel's commands, and the Firefox items Sval takes out.
 *
 * A menu's popup is shown here with a `popupshowing` that does not bubble:
 * the menu bar's autohide takes a real one there as the menu bar opening
 * (`AutoHideMenubar`), and macOS draws these menus natively, where a test
 * cannot open them.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_pins_helpers.js",
  this
);

const { MODE_KEYS, NEW_WORKSPACE_KEY, PANEL_MENU_ITEM_ID } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalShortcuts.sys.mjs"
  );

add_setup(pinsSetup);

/**
 * @param {string} id A popup's id.
 * @returns {Element} the popup, filled as it is about to show.
 */
function showing(id) {
  const popup = document.getElementById(id);
  popup.dispatchEvent(new Event("popupshowing"));
  return popup;
}

/**
 * @param {Element} popup
 * @returns {string[]} the entries it shows: a command's `data-command`, else
 *   an entry's id, else its label, which names a page or a workspace, and
 *   "-" for a separator.
 */
function entries(popup) {
  return Array.from(popup.children)
    .filter(el => !el.hidden)
    .map(el =>
      el.localName === "menuseparator"
        ? "-"
        : (el.dataset.command ?? (el.id || el.label))
    );
}

/** @returns {Promise<object>} a tab of the workspace, selected. */
async function aTab() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE),
    10_000,
    "a tab opening"
  );
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  return tab;
}

add_task(async function the_menus_stand_between_firefoxs() {
  const shown = Array.from(
    document.getElementById("main-menubar").children
  ).filter(el => el.localName === "menu" && !el.hidden);
  const ids = shown.map(el => el.id);
  Assert.deepEqual(
    ids.slice(0, 8),
    [
      "file-menu",
      "edit-menu",
      "view-menu",
      "sval-workspaces-menu",
      "sval-favorites-menubar",
      "history-menu",
      "sval-tab-menu",
      "tools-menu",
    ],
    "Workspaces and Favorites after View, Tab after History"
  );
  for (const id of [
    "goOfflineMenuitem",
    "pageStyleMenu",
    "menu_searchHistory",
  ]) {
    Assert.ok(!document.getElementById(id), `no ${id}`);
  }
});

// Firefox gives a build without MOZILLA_OFFICIAL, as every Sval build is
// (decision 0063), a developer restart in `gBrowserInit._delayedStartup`, so
// the check runs once that has.
add_task(function file_offers_no_developer_restart() {
  Assert.ok(
    gBrowserInit.delayedStartupFinished,
    "the window has finished starting up"
  );
  Assert.ok(
    !document.getElementById("menu_FileRestartItem"),
    "File has no developer restart"
  );
  Assert.ok(
    !document.getElementById("key_quickRestart"),
    "no shortcut restarts the browser"
  );
});

add_task(function view_sidebar_shows_only_for_an_extensions_sidebar() {
  const { onViewMenuShowing } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalHeader.sys.mjs"
  );
  const view = document.getElementById("menu_viewPopup");
  onViewMenuShowing({ target: view });
  Assert.ok(
    document.getElementById("viewSidebarMenuMenu").hidden,
    "no extension adds a sidebar"
  );
  const first = [...view.children].find(child => !child.hidden);
  Assert.notEqual(first.localName, "menuseparator", "View opens on an item");
});

// macOS takes Quit out of File and hides the line above it only by this id
// (`nsMenuBarX::AquifyMenuBar`), so File does not end on a line there.
add_task(function file_hides_the_line_above_quit_with_quit() {
  const quit = document.getElementById("menu_FileQuitItem");
  Assert.equal(
    quit.previousElementSibling.id,
    "menu_FileQuitSeparator",
    "the line above Quit"
  );
});

add_task(async function workspaces_lists_and_switches() {
  const { home, work } = pinsFixture;
  const popup = showing("sval-workspaces-menu-popup");
  const fresh = popup.firstElementChild;
  Assert.equal(fresh.id, "sval-menu-new-workspace", "New Workspace first");
  Assert.equal(fresh.getAttribute("key"), NEW_WORKSPACE_KEY, "on its key");
  Assert.ok(!fresh.hasAttribute("disabled"), "offered");
  const toggle = document.getElementById(PANEL_MENU_ITEM_ID);
  Assert.equal(toggle.parentNode, popup, "the panel's toggle is here");
  const container = document.getElementById("sval-panel-container");
  Assert.equal(
    toggle.dataset.panel,
    container.hasAttribute("sval-collapsed") ? "hidden" : "shown",
    "named for what it will do"
  );
  const entry = id => popup.querySelector(`[data-workspace-id="${id}"]`);
  const nameOf = id => SvalPanel.nodes[id].content.name;
  Assert.equal(entry(home)?.label, nameOf(home), "each workspace by name");
  Assert.equal(entry(work)?.label, nameOf(work));
  Assert.equal(entry(home).getAttribute("checked"), "true", "this window's");
  Assert.ok(!entry(work).hasAttribute("checked"));
  Assert.ok(
    entries(popup).includes("edit"),
    "with the workspace menu's commands"
  );

  atTaskEnd(async () => {
    await SvalPanel.switchTo(home);
  });
  entry(work).doCommand();
  await TestUtils.waitForCondition(
    () => SvalPanel.workspaceId === work,
    "choosing Work shows it"
  );
  showing("sval-workspaces-menu-popup");
  Assert.equal(
    entry(work).getAttribute("checked"),
    "true",
    "and checks it the next time"
  );
});

/**
 * Agents' workspaces follow the user's under a caption, in a menu for each
 * app, each entry named for its task, as the switcher lists them
 * (decision 1998).
 */
add_task(async function workspaces_groups_agents_by_app() {
  const add = async (task, app) => {
    const id = await SvalPanel.engine.mutate({
      kind: "addAgentWorkspace",
      name: task,
      agentLabel: app,
      id: crypto.randomUUID(),
      now: Date.now(),
    });
    atTaskEnd(() => removeWorkspace(id));
    return id;
  };
  const first = await add("Fix the login page", "Agent One");
  const second = await add("Compare laptop prices", "Agent One");
  const other = await add("Read the docs", "Agent Two");
  await SvalPanel.refresh();

  const popup = showing("sval-workspaces-menu-popup");
  const caption = popup.querySelector(":scope > [data-agents-caption]");
  Assert.ok(caption?.hasAttribute("disabled"), "a caption no one can choose");
  const apps = Array.from(
    popup.querySelectorAll(":scope > menu[data-agent-app]")
  );
  Assert.deepEqual(
    apps.map(el => el.dataset.agentApp),
    ["Agent One", "Agent Two"],
    "a menu for each app"
  );
  Assert.ok(
    apps.every(
      el =>
        el.compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_PRECEDING
    ),
    "under the caption"
  );
  const inApp = (app, id) =>
    app.querySelector(`:scope > menupopup > [data-workspace-id="${id}"]`);
  Assert.ok(inApp(apps[0], first) && inApp(apps[0], second), "the app's own");
  Assert.ok(inApp(apps[1], other), "and the other app's in its menu");
  Assert.ok(
    inApp(apps[0], second).label.startsWith("Compare laptop prices"),
    "each named for its task"
  );
  Assert.ok(
    !popup.querySelector(`:scope > [data-workspace-id="${first}"]`),
    "none listed outside its app"
  );
});

/** Favorites lists no pin, of this workspace or another (pins spec §8.2). */
add_task(async function favorites_lists_favorites_without_pins() {
  const { store, work } = pinsFixture;
  const pinned = await pinFavorite(PAGE, "Pinned page");
  const elsewhere = await pinFavorite(PAGE2, "Work pin");
  await store.setPinScope(elsewhere, [work]);
  await pinFavorite(LINKS_PAGE, "Plain favorite", { pin: false });
  await untilPinShows(pinned);

  const popup = showing("sval-favorites-menubar-popup");
  Assert.deepEqual(
    entries(popup),
    ["sval-menu-favorite-page", "-", "Plain favorite"],
    "the page's item, then Favorites without the pins"
  );
});

add_task(async function tab_acts_on_the_selected_tab() {
  forgetFavorites();
  const tab = await aTab();
  const popup = showing("sval-tab-menu-popup");
  Assert.deepEqual(
    entries(popup),
    [
      "sval-menu-copy-address",
      "rename",
      "pin",
      "pinHere",
      "moveBefore",
      "moveAfter",
      "moveToGroup",
      "moveToWorkspace",
      "copyMarkdownLink",
      "unload",
      "keepLoaded",
      "-",
      "createSplit",
      "addToSplit",
      "-",
      "sval-menu-element-picker",
      "sval-menu-snip",
      "sval-menu-site-style",
      "sval-menu-screenshot",
    ],
    "Copy Address, the row menu's entries for one tab, then the page's tools"
  );
  for (const id of Object.values(MODE_KEYS)) {
    Assert.ok(
      popup.querySelector(`menuitem[key="${id}"]`),
      `a mode's item names ${id}`
    );
  }

  Assert.equal(
    popup.querySelector('[data-command="pin"]').dataset.pinned,
    "false",
    "a tab is offered Pin Tab"
  );
  popup.querySelector('[data-command="pin"]').doCommand();
  await TestUtils.waitForCondition(
    () => rowGuids().length === 1 && selectedPinGuid() === rowGuids()[0],
    "Pin Tab pins it, selected"
  );
  Assert.ok(isPin(tab), "the tab is the pin's page");

  showing("sval-tab-menu-popup");
  Assert.deepEqual(
    entries(popup),
    [
      "sval-menu-copy-address",
      "pin",
      "-",
      "sval-menu-element-picker",
      "sval-menu-snip",
      "sval-menu-site-style",
      "sval-menu-screenshot",
    ],
    "a selected pin is offered Copy Address and Unpin Tab"
  );
  Assert.equal(
    popup.querySelector('[data-command="pin"]').dataset.pinned,
    "true",
    "which unpins it"
  );
  popup.querySelector('[data-command="pin"]').doCommand();
  await TestUtils.waitForCondition(
    () => !rowGuids().length,
    "Unpin Tab unpins it"
  );
});

add_task(async function tab_takes_a_screenshot() {
  const { ScreenshotsUtils, UIPhases } = ChromeUtils.importESModule(
    "moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs"
  );
  const tab = await aTab();
  const popup = showing("sval-tab-menu-popup");
  const item = popup.querySelector("#sval-menu-screenshot");
  Assert.equal(item.getAttribute("command"), "Browser:Screenshot");
  Assert.equal(item.getAttribute("key"), "key_screenshot");
  Assert.equal(
    item.getAttribute("data-l10n-id"),
    "main-context-menu-take-screenshot"
  );

  const browser = tab.linkedBrowser;
  item.doCommand();
  await within(
    TestUtils.waitForCondition(
      () => ScreenshotsUtils.getUIPhase(browser) !== UIPhases.CLOSED,
      "the screenshot tool opens"
    ),
    10_000,
    "the screenshot tool opening"
  );
  ScreenshotsUtils.exit(browser);
  await within(
    TestUtils.waitForCondition(
      () => ScreenshotsUtils.getUIPhase(browser) === UIPhases.CLOSED,
      "the screenshot tool closes"
    ),
    10_000,
    "the screenshot tool closing"
  );

  await SpecialPowers.pushPrefEnv({
    set: [["screenshots.browser.component.enabled", false]],
  });
  showing("sval-tab-menu-popup");
  Assert.ok(item.hidden, "the item hides where screenshots are turned off");
  await SpecialPowers.popPrefEnv();
});
