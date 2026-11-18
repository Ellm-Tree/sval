/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * The panel's two menus, the Workspace menu (the switcher, spec §10.7) and
 * the Favorites menu (import spec §6): drawn alike, by Gecko, on every
 * platform (`sval-panel.css`, menus), and usable from the keyboard and by a
 * screen reader (spec §10.5).
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);

const accService = Cc["@mozilla.org/accessibilityService;1"].getService(
  Ci.nsIAccessibilityService
);

/**
 * Adds two workspaces to the window's document, "Work" and "Writing", which
 * share a first letter, and shows the first.
 *
 * @returns {Promise<string[]>} the workspaces' ids, in order.
 */
async function twoWorkspaces() {
  const { ids } = await withSwitcherPanel({ names: ["Work", "Writing"] });
  return ids.workspaces;
}

/**
 * Opens `popup` from the keyboard: focuses `button` and presses `key` on it.
 *
 * @param {Element} button
 * @param {Element} popup
 * @param {string} key
 */
async function openWithKey(button, popup, key) {
  await within(SimpleTest.promiseFocus(window), 10_000, "the window's focus");
  button.focus();
  const shown = BrowserTestUtils.waitForPopupEvent(popup, "shown");
  EventUtils.synthesizeKey(key, {}, window);
  await within(shown, 10_000, `${key} opening the menu`);
  Assert.equal(button.getAttribute("aria-expanded"), "true", "expanded");
}

/**
 * Presses Escape on the open `popup`, and checks focus is back on `button`.
 *
 * @param {Element} button
 * @param {Element} popup
 */
async function escapeFrom(button, popup) {
  const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  await within(hidden, 10_000, "Escape closing the menu");
  Assert.equal(document.activeElement, button, "focus is on the button");
  Assert.equal(button.getAttribute("aria-expanded"), "false", "collapsed");
}

/**
 * @param {Element} popup
 * @returns {Element|undefined} the item the keyboard is on.
 */
function active(popup) {
  return Array.from(popup.children).find(el =>
    el.hasAttribute("_moz-menuactive")
  );
}

/**
 * Presses `key` and waits for the keyboard to land on an item.
 *
 * @param {Element} popup
 * @param {string} key
 * @returns {Promise<Element>}
 */
async function press(popup, key) {
  const before = active(popup);
  EventUtils.synthesizeKey(key, {}, window);
  let now;
  await TestUtils.waitForCondition(
    () => (now = active(popup)) && now !== before,
    `${key} moving in the menu`
  );
  return now;
}

/**
 * @param {nsIAccessible} acc
 * @param {number} state An `nsIAccessibleStates` flag.
 * @returns {boolean}
 */
function has(acc, state) {
  const s = {};
  acc.getState(s, {});
  return !!(s.value & state);
}

/**
 * @param {nsIAccessible} acc
 * @returns {nsIAccessible[]} its descendants, depth first.
 */
function descendants(acc) {
  const all = [];
  for (let child = acc.firstChild; child; child = child.nextSibling) {
    all.push(child, ...descendants(child));
  }
  return all;
}

/** The roles a menu's keyboard can land on. */
const ITEM_ROLES = new Set([
  Ci.nsIAccessibleRole.ROLE_MENUITEM,
  Ci.nsIAccessibleRole.ROLE_RADIO_MENU_ITEM,
  Ci.nsIAccessibleRole.ROLE_CHECK_MENU_ITEM,
  Ci.nsIAccessibleRole.ROLE_PARENT_MENUITEM,
]);

/**
 * Checks a menu is exposed as one: a menu popup, nothing in it focusable but
 * its items, and its button saying it opens one.
 *
 * @param {Element} button
 * @param {Element} popup An open `menupopup`.
 * @returns {Promise<nsIAccessible[]>} its items.
 */
async function checkExposed(button, popup) {
  const buttonAcc = await accessibleOf(button);
  Assert.equal(buttonAcc.role, Ci.nsIAccessibleRole.ROLE_PUSHBUTTON);
  Assert.ok(
    has(buttonAcc, Ci.nsIAccessibleStates.STATE_HASPOPUP),
    "the button says it opens a menu"
  );
  Assert.ok(
    has(buttonAcc, Ci.nsIAccessibleStates.STATE_EXPANDED),
    "and that it is open"
  );
  Assert.ok(!popup.hasAttribute("aria-hidden"), "the menu is not hidden");
  const menuAcc = await accessibleOf(popup);
  Assert.equal(menuAcc.role, Ci.nsIAccessibleRole.ROLE_MENUPOPUP, "a menu");
  const focusable = descendants(menuAcc).filter(a =>
    has(a, Ci.nsIAccessibleStates.STATE_FOCUSABLE)
  );
  Assert.ok(focusable.length, "the menu has items");
  for (const acc of focusable) {
    Assert.ok(
      ITEM_ROLES.has(acc.role),
      `${acc.name} is a menu item, the one thing a menu focuses`
    );
    Assert.ok(acc.name, "and has a name");
  }
  return focusable;
}

add_task(async function both_menus_are_drawn_by_sval_before_they_open() {
  await twoWorkspaces();
  // Gecko marks a popup `nonnative` itself when it falls back from a native
  // menu (`nsXULPopupManager::ShowPopupAtAnchorAsNativeMenu`), so this is
  // asked before either menu has opened.
  for (const popup of [
    SvalPanel._els.switcherMenu,
    SvalPanel._els.favoritesMenu,
  ]) {
    Assert.equal(popup.state, "closed");
    Assert.ok(popup.hasAttribute("nonnative"), "Gecko draws it");
    Assert.ok(popup.classList.contains("toolbar-menupopup"), "as a panel menu");
  }
});

add_task(async function the_workspace_menu_works_from_the_keyboard() {
  const [work, writing] = await twoWorkspaces();
  // A third that starts as Writing does, for type-ahead to move between.
  const web = await SvalPanel.engine.mutate({
    kind: "addWorkspace",
    name: "Web",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  leftWhenTheTaskEnds([web]);
  await SvalPanel.refresh();
  await TestUtils.waitForCondition(
    () => SvalWindowWorkspace.of(window).id === work,
    "the window showing the first workspace"
  );
  const button = SvalPanel._els.switcher;
  const popup = SvalPanel._els.switcherMenu;

  await openWithKey(button, popup, "KEY_Enter");
  // The profile's own workspace is listed too, in its place.
  const entries = switcherEntries(popup).map(item => item.dataset.workspaceId);
  Assert.deepEqual(
    entries.filter(id => [work, writing, web].includes(id)),
    [work, writing, web],
    "the entries are every workspace, the shown one in its place"
  );

  info("the arrow keys, Home and End");
  const first = await press(popup, "KEY_ArrowDown");
  Assert.equal(
    first.dataset.workspaceId,
    entries[0],
    "Down lands on the first"
  );
  const second = await press(popup, "KEY_ArrowDown");
  Assert.equal(second.dataset.workspaceId, entries[1], "and then the second");
  const last = await press(popup, "KEY_End");
  Assert.ok(
    last.hasAttribute("data-sval-new-workspace"),
    "End lands on New workspace…"
  );

  info("Right enters an entry's submenu and Left leaves it");
  const home = await press(popup, "KEY_Home");
  Assert.equal(home, first, "Home lands on the first");
  const submenu = first.menupopup;
  const opened = BrowserTestUtils.waitForPopupEvent(submenu, "shown");
  EventUtils.synthesizeKey("KEY_ArrowRight", {}, window);
  await within(opened, 10_000, "the submenu opening");
  const inside = await TestUtils.waitForCondition(
    () => active(submenu),
    "the keyboard in the submenu"
  );
  Assert.equal(
    inside.dataset.openWorkspaceId,
    entries[0],
    "on Open in New Window"
  );
  const closed = BrowserTestUtils.waitForPopupEvent(submenu, "hidden");
  EventUtils.synthesizeKey("KEY_ArrowLeft", {}, window);
  await within(closed, 10_000, "the submenu closing");
  Assert.equal(active(popup), first, "back on the parent");
  Assert.ok(
    !Array.from(popup.children).some(
      el => el.localName === "menucaption" && el.hasAttribute("_moz-menuactive")
    ),
    "a heading is never landed on"
  );

  info("the workspace the window shows is listed in its place, as current");
  const items = await checkExposed(button, popup);
  const byName = name => items.find(a => a.name === name);
  Assert.equal(
    byName("Work")?.attributes.getStringProperty("current"),
    "true",
    "it is announced as the current one"
  );
  for (const name of ["Work", "Writing", "Web"]) {
    Assert.equal(
      byName(name)?.role,
      Ci.nsIAccessibleRole.ROLE_PARENT_MENUITEM,
      `${name} is a place to go, with a submenu`
    );
  }
  Assert.equal(
    byName("New Workspace…")?.role,
    Ci.nsIAccessibleRole.ROLE_MENUITEM
  );

  info("type-ahead: a first letter two entries share moves to the next");
  for (let i = 0; i < entries.indexOf(writing); i++) {
    await press(popup, "KEY_ArrowDown");
  }
  Assert.equal(active(popup).dataset.workspaceId, writing, "from Writing");
  const typed = await press(popup, "w");
  Assert.equal(typed.dataset.workspaceId, web, "W moves on to Web");
  Assert.equal(popup.state, "open", "and only moves there");

  info("Enter chooses the entry the keyboard is on, Shift+Enter in a window");
  let hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
  EventUtils.synthesizeKey("KEY_Enter", {}, window);
  await within(hidden, 10_000, "Enter closing the menu");
  await TestUtils.waitForCondition(
    () => SvalWindowWorkspace.of(window).id === web,
    "Enter switching the window to Web"
  );
  await within(
    SvalWindowWorkspace.of(window).switchesSettled(),
    10_000,
    "the switch to Web finishing"
  );

  await openWithKey(button, popup, "KEY_Enter");
  let on = await press(popup, "KEY_ArrowDown");
  while (on.dataset.workspaceId !== writing) {
    Assert.ok(on.dataset.workspaceId, "the keyboard is still on an entry");
    on = await press(popup, "KEY_ArrowDown");
  }
  const opening = BrowserTestUtils.domWindowOpenedAndLoaded();
  hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
  EventUtils.synthesizeKey("KEY_Enter", { shiftKey: true }, window);
  await within(hidden, 10_000, "Shift+Enter closing the menu");
  const win = await within(opening, 20_000, "Writing's window opening");
  await within(win.SvalPanel.started, 20_000, "its panel starting");
  Assert.equal(
    SvalWindowWorkspace.of(win).id,
    writing,
    "Shift+Enter opened Writing in a window of its own"
  );
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    web,
    "and this window stayed on Web"
  );
  await within(BrowserTestUtils.closeWindow(win), 10_000, "its window closing");

  info("Space opens it too, and Escape closes it");
  await openWithKey(button, popup, " ");
  await escapeFrom(button, popup);
});

/**
 * A workspace whose label leads with its emoji is reached by typing its
 * name's first letter, and its label is still the emoji then the name.
 */
add_task(async function type_ahead_reaches_a_workspace_named_after_an_emoji() {
  const [work] = await twoWorkspaces();
  const engine = SvalPanel.engine;
  const notes = await engine.mutate({
    kind: "addWorkspace",
    name: "Notes",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  leftWhenTheTaskEnds([notes]);
  await engine.mutate({
    kind: "setAppearance",
    id: notes,
    color: null,
    emoji: "\u{1F984}",
    now: Date.now(),
  });
  await SvalPanel.refresh();
  await TestUtils.waitForCondition(
    () => SvalWindowWorkspace.of(window).id === work,
    "the window showing the first workspace"
  );
  const button = SvalPanel._els.switcher;
  const popup = SvalPanel._els.switcherMenu;

  await openWithKey(button, popup, "KEY_Enter");
  const entry = popup.querySelector(`[data-workspace-id="${notes}"]`);
  Assert.equal(
    entry.getAttribute("label"),
    "\u{1F984} Notes",
    "the label leads with the emoji"
  );
  Assert.equal(
    (await accessibleOf(entry)).name,
    "\u{1F984} Notes",
    "and is announced so"
  );

  info("N is shared with New workspace…, so it moves without choosing");
  const typed = await press(popup, "n");
  Assert.equal(typed, entry, "N finds the emoji's workspace");
  Assert.equal(popup.state, "open", "and only moves there");
  const next = await press(popup, "n");
  Assert.ok(
    next.hasAttribute("data-sval-new-workspace"),
    "N again moves on to New workspace…"
  );

  await escapeFrom(button, popup);
});

/**
 * An agent's workspace says so to a screen reader as well as by its robot:
 * its app's entry is named by the agent and described as an agent's, and so
 * is the workspace's entry in it. An isolated one says both.
 */
add_task(async function an_agent_workspace_is_described_as_one() {
  const [, writing] = await twoWorkspaces();
  const engine = SvalPanel.engine;
  const agent = await engine.mutate({
    kind: "addAgentWorkspace",
    name: "Test Agent",
    agentLabel: "Test Agent",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  leftWhenTheTaskEnds([agent]);
  await SvalPanel.refresh();
  const button = SvalPanel._els.switcher;
  const popup = SvalPanel._els.switcherMenu;

  const describe = async () => {
    await openWithKey(button, popup, "KEY_Enter");
    const app = popup.querySelector("menu[data-agent-app]");
    const appAcc = await accessibleOf(app);
    const apps = app.querySelector("menupopup");
    const shown = BrowserTestUtils.waitForPopupEvent(apps, "shown");
    app.openMenu(true);
    await within(shown, 10_000, "the app's submenu showing");
    const agentAcc = await accessibleOf(
      apps.querySelector(`[data-workspace-id="${agent}"]`)
    );
    const own = await accessibleOf(
      popup.querySelector(`[data-workspace-id="${writing}"]`)
    );
    const found = {
      name: appAcc.name,
      app: appAcc.description,
      description: agentAcc.description,
      own: own.description,
    };
    const hidden = BrowserTestUtils.waitForPopupEvent(apps, "hidden");
    app.openMenu(false);
    await within(hidden, 10_000, "the app's submenu closing");
    await escapeFrom(button, popup);
    return found;
  };

  const plain = await describe();
  Assert.equal(plain.name, "Test Agent", "the app is named by its agent");
  Assert.ok(plain.app, "and described as an agent's");
  Assert.equal(plain.description, plain.app, "as is its workspace");
  Assert.equal(plain.own, "", "the user's own are not");

  for (const id of [agent, writing]) {
    await engine.mutate({
      kind: "setIsolation",
      id,
      isolated: true,
      now: Date.now(),
    });
  }
  await SvalPanel.refresh();
  const isolated = await describe();
  Assert.ok(isolated.own, "an isolated one of the user's says so");
  Assert.ok(
    isolated.description.startsWith(plain.description) &&
      isolated.description.endsWith(isolated.own),
    "an isolated agent's says it is both"
  );
});

add_task(async function the_favorites_menu_works_from_the_keyboard() {
  await twoWorkspaces();
  const { store } = await favoritesFixture();
  await store.insertTree([
    ...["Alpha", "Apple"].map(title => ({
      title,
      url: `https://example.com/${title}`,
    })),
    {
      title: "Folder",
      children: [{ title: "Inside", url: "https://example.com/inside" }],
    },
  ]);
  const button = SvalPanel._els.favorites;
  const popup = SvalPanel._els.favoritesMenu;

  await openWithKey(button, popup, "KEY_Enter");
  await TestUtils.waitForCondition(
    () => popup.querySelector("menuitem[label='Apple']"),
    "the favorites drawn"
  );

  const first = await press(popup, "KEY_ArrowDown");
  Assert.equal(first.getAttribute("label"), "Alpha", "Down lands on the first");
  const last = await press(popup, "KEY_End");
  Assert.equal(last.localName, "menu", "End lands on the last folder");
  const top = await press(popup, "KEY_Home");
  Assert.equal(top, first, "Home on the first");
  const typed = await press(popup, "a");
  Assert.equal(typed.getAttribute("label"), "Apple", "A finds the next A");
  Assert.equal(popup.state, "open", "and only moves there");

  const items = await checkExposed(button, popup);
  Assert.equal(
    items.find(a => a.name === "Apple")?.role,
    Ci.nsIAccessibleRole.ROLE_MENUITEM,
    "a favorite is a menu item named for it"
  );
  Assert.equal(
    items.find(a => a.name === "Folder")?.role,
    Ci.nsIAccessibleRole.ROLE_PARENT_MENUITEM,
    "a folder is a submenu"
  );

  info("Shift+F10 opens the item's context menu, and Escape only that");
  const context = document.getElementById("sval-favorites-context-menu");
  const contextShown = BrowserTestUtils.waitForPopupEvent(context, "shown");
  EventUtils.synthesizeKey("KEY_F10", { shiftKey: true }, window);
  await within(contextShown, 10_000, "the context menu showing");
  Assert.equal(
    context._svalTrigger,
    typed,
    "about the item the keyboard is on"
  );
  const contextHidden = BrowserTestUtils.waitForPopupEvent(context, "hidden");
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  await within(contextHidden, 10_000, "Escape closing the context menu");
  Assert.equal(popup.state, "open", "the Favorites menu stays open");

  await escapeFrom(button, popup);
});

/**
 * A press on the button the Favorites menu grew from closes the menu. The
 * menu's window reaches over the button's foot, so on macOS such a press
 * reaches the menu itself; a press on the menu's items leaves it open. The
 * Workspace menu opens over its button, which it covers.
 */
add_task(async function a_press_on_its_button_closes_the_favorites_menu() {
  await twoWorkspaces();
  const button = SvalPanel._els.favorites;
  const popup = SvalPanel._els.favoritesMenu;
  const shown = BrowserTestUtils.waitForPopupEvent(popup, "shown");
  button.click();
  await within(shown, 10_000, "the menu opening");
  const rect = button.getBoundingClientRect();
  const pressAt = (x, y) =>
    popup.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        button: 0,
        screenX: window.mozInnerScreenX + x,
        screenY: window.mozInnerScreenY + y,
      })
    );

  pressAt(rect.left + rect.width / 2, rect.bottom + rect.height);
  Assert.equal(popup.state, "open", "a press on an item keeps it");

  const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
  pressAt(rect.left + rect.width / 2, rect.bottom - 2);
  await within(hidden, 10_000, "the press on the button closing it");
});
