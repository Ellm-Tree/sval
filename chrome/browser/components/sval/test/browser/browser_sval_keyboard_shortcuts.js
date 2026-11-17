/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */

/**
 * Sval's keyboard shortcuts: the panel's toggle on Firefox's sidebar key, and
 * Settings' Keyboard shortcuts pane, which lists Sval's keys and Firefox's in
 * Sval's words and changes Firefox's through `CustomKeys`.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

const { SVAL_SHORTCUTS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalShortcuts.sys.mjs"
);
const {
  PANEL_TOGGLE_KEY,
  PANEL_MENU_ITEM_ID,
  NEW_WORKSPACE_KEY,
  COPY_ADDRESS_KEY,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalKeys.sys.mjs"
);
const { keyCommand } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);
const { GROUP, TAB } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTree.sys.mjs"
);

const { CustomKeys } = ChromeUtils.importESModule(
  "moz-src:///browser/components/customkeys/CustomKeys.sys.mjs"
);

const accService = Cc["@mozilla.org/accessibilityService;1"].getService(
  Ci.nsIAccessibilityService
);

registerCleanupFunction(() => CustomKeys.resetAll());

/**
 * Keys Firefox disables while the page cannot use them: Reader View's is
 * enabled only on a page Reader View can show.
 */
const PAGE_STATE_KEYS = new Set(["key_toggleReaderMode"]);

/**
 * Presses the key `<key id>` is now, as the user would.
 *
 * @param {string} id
 */
function pressKey(id) {
  const el = document.getElementById(id);
  const modifiers = el.getAttribute("modifiers") ?? "";
  const has = name => modifiers.split(/[\s,]+/).includes(name);
  const isMac = AppConstants.platform === "macosx";
  EventUtils.synthesizeKey(el.getAttribute("key"), {
    ctrlKey: has("control") || (has("accel") && !isMac),
    metaKey: has("meta") || (has("accel") && isMac),
    altKey: has("alt"),
    shiftKey: has("shift"),
  });
}

/**
 * @returns {boolean} whether the panel shows and has come to rest, its slide
 *   and the page's push done, so a click on the page lands where it aims.
 */
function panelShown() {
  const panel = document.getElementById("sval-panel-container");
  return (
    !panel.hidden &&
    !panel.hasAttribute("sval-collapsed") &&
    !panel.hasAttribute("sval-overlay")
  );
}

/**
 * @returns {nsIAccessible|null} what assistive technology has focused, read
 *   in a wait's condition, which follows the focus as `accessibleOf` cannot.
 */
function focusedAccessible() {
  const el = Services.focus.focusedElement;
  // eslint-disable-next-line sval/accessible-read
  return el ? accService.getAccessibleFor(el) : null;
}

add_task(async function the_toggle_key_hides_and_shows_the_panel() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  Assert.ok(panelShown(), "the panel shows at first");
  gBrowser.selectedBrowser.focus();

  pressKey(PANEL_TOGGLE_KEY);
  await TestUtils.waitForCondition(() => !panelShown(), "the key hides it");

  pressKey(PANEL_TOGGLE_KEY);
  await TestUtils.waitForCondition(panelShown, "and shows it again");
  const selected = taggedId(gBrowser.selectedTab);
  await TestUtils.waitForCondition(
    () => document.activeElement?.dataset?.nodeId === selected,
    "with focus on the row of the tab being viewed"
  );
  // The accessibility tree catches up with a newly shown panel on a later
  // refresh, so the row's accessible may not exist yet.
  let acc;
  await TestUtils.waitForCondition(
    () => (acc = focusedAccessible()),
    "assistive technology has the focused row"
  );
  Assert.equal(acc.role, Ci.nsIAccessibleRole.ROLE_OUTLINEITEM, "a tree item");
  const state = {};
  acc.getState(state, {});
  Assert.ok(
    state.value & Ci.nsIAccessibleStates.STATE_FOCUSED,
    "that assistive technology reports focused"
  );
  Assert.equal(
    acc.name,
    gBrowser.selectedTab.label,
    "named for the tab being viewed"
  );

  const item = document.getElementById(PANEL_MENU_ITEM_ID);
  Assert.equal(
    item?.getAttribute("key"),
    PANEL_TOGGLE_KEY,
    "the Workspaces menu offers it"
  );
  const button = document.getElementById("sval-panel-button");
  button.dispatchEvent(new MouseEvent("mouseover"));
  Assert.ok(
    button
      .getAttribute("tooltiptext")
      .includes(
        ShortcutUtils.prettifyShortcut(
          document.getElementById(PANEL_TOGGLE_KEY)
        )
      ),
    "the panel button's tooltip names the key"
  );
  Assert.ok(
    button.getAttribute("aria-keyshortcuts"),
    "and so does its aria-keyshortcuts"
  );
});

/** Each of the panel's keys the pane lists does what the pane says. */
add_task(function the_panel_keys_listed_are_the_panel_keys() {
  const rows = {
    focusNext: { kind: TAB, depth: 0 },
    focusPrevious: { kind: TAB, depth: 0 },
    focusFirst: { kind: TAB, depth: 0 },
    focusLast: { kind: TAB, depth: 0 },
    extendNext: { kind: TAB, depth: 0 },
    extendPrevious: { kind: TAB, depth: 0 },
    toggleSelected: { kind: TAB, depth: 0 },
    clearSelection: { kind: TAB, depth: 0 },
    expand: { kind: GROUP, hasChildren: true, expanded: false, depth: 0 },
    collapse: { kind: GROUP, hasChildren: true, expanded: true, depth: 0 },
    activate: { kind: TAB, depth: 0 },
    rename: { kind: TAB, depth: 0 },
    close: { kind: TAB, depth: 0 },
    moveBefore: { kind: TAB, depth: 0 },
    moveAfter: { kind: TAB, depth: 0 },
    moveIn: { kind: TAB, depth: 0 },
    moveOut: { kind: TAB, depth: 0 },
    contextMenu: { kind: TAB, depth: 0 },
    focusNextPane: { kind: TAB, depth: 0, split: true },
    focusPreviousPane: { kind: TAB, depth: 0, split: true },
    movePaneLeft: { kind: TAB, depth: 0, split: true, posinset: 2, setsize: 3 },
    movePaneRight: {
      kind: TAB,
      depth: 0,
      split: true,
      posinset: 2,
      setsize: 3,
    },
  };
  const domKey = {
    VK_DOWN: "ArrowDown",
    VK_UP: "ArrowUp",
    VK_LEFT: "ArrowLeft",
    VK_RIGHT: "ArrowRight",
    VK_HOME: "Home",
    VK_END: "End",
    VK_RETURN: "Enter",
    VK_SPACE: " ",
    VK_F2: "F2",
    VK_DELETE: "Delete",
    VK_BACK: "Backspace",
    VK_F10: "F10",
    VK_CONTEXT_MENU: "ContextMenu",
    VK_ESCAPE: "Escape",
  };
  let checked = 0;
  for (const group of SVAL_SHORTCUTS) {
    for (const entry of group.entries) {
      if (!entry.command) {
        continue;
      }
      for (const { keycode, modifiers = "" } of entry.keys) {
        const event = {
          key: domKey[keycode],
          altKey: modifiers.includes("alt"),
          shiftKey: modifiers.includes("shift"),
          ctrlKey: modifiers.includes("control"),
          metaKey: false,
        };
        // Escape is the panel's while rows are selected.
        Assert.equal(
          keyCommand(event, rows[entry.command], { selecting: true }),
          entry.command,
          `${entry.title}: ${keycode} ${modifiers}`
        );
        checked++;
      }
    }
  }
  Assert.greater(checked, 10, "the panel's keys were checked");
});

/** Waits for the pane's list and returns its rows as `{ title, shortcut, id }`. */
async function openKeyboardPane() {
  const ui = await openPane(
    "svalKeyboard",
    ({ byId }) => byId("sval-keys-list")?.querySelector(".sval-keys-row"),
    "the shortcuts listed"
  );
  const rows = () =>
    [...ui.byId("sval-keys-list").querySelectorAll(".sval-keys-row")].map(
      row => ({
        row,
        id: row.dataset.id,
        title: row.querySelector("th").textContent,
        shortcut: row.querySelector(".sval-keys-shortcut").textContent,
        group: row.closest("section").querySelector("h2").textContent,
        section: row.closest("section"),
      })
    );
  return { ui, rows };
}

add_task(async function the_pane_lists_sval_and_firefox_keys_in_sval_words() {
  const { ui, rows } = await openKeyboardPane();
  Assert.ok(
    ui.byId("category-svalKeyboard"),
    "Settings' navigation has Keyboard shortcuts"
  );
  const listed = rows();
  const toggle = listed.find(r => r.id === PANEL_TOGGLE_KEY);
  Assert.ok(toggle, "the toggle, which can be changed");
  const panelKeys = listed.filter(r => r.section === toggle.section);
  Assert.ok(
    panelKeys.some(r => r.id === NEW_WORKSPACE_KEY),
    "New workspace, which takes a key, is among the panel's keys"
  );
  Assert.ok(
    panelKeys.some(r => !r.id && r.shortcut === "F2"),
    "and so is Rename's F2"
  );
  const pinKeys = listed.filter(r => /^key_select(Tab\d|LastTab)$/.test(r.id));
  Assert.equal(pinKeys.length, 9, "the nine pin keys are listed");
  Assert.ok(
    pinKeys.every(r => r.section === pinKeys[0].section),
    "in one group of their own"
  );
  Assert.ok(
    listed
      .filter(r => r.section === pinKeys[0].section)
      .every(r => pinKeys.includes(r)),
    "which lists nothing else"
  );
  Assert.ok(
    listed.some(r => r.id === COPY_ADDRESS_KEY),
    "Copy Address, which can be changed, is listed"
  );
  Assert.ok(
    listed.some(r => r.id === "key_reload"),
    "Firefox's keys are there too"
  );
  for (const { title, group } of listed) {
    Assert.ok(
      !/bookmark|firefox|sidebar|labs|broken site|chatbot|split view/i.test(
        `${group} ${title}`
      ),
      `"${group} › ${title}" is in Sval's words`
    );
  }
  for (const { id, title } of listed) {
    if (!id) {
      continue;
    }
    const el = document.getElementById(id);
    Assert.equal(el?.localName, "key", `"${title}" is a key of the window`);
    if (!PAGE_STATE_KEYS.has(id)) {
      Assert.ok(!el.hasAttribute("disabled"), `and "${title}" is not disabled`);
    }
  }
  Assert.ok(
    !ui.page.document.getElementById("cautionMessage"),
    "no experimental banner"
  );
});

/**
 * Asserts that `toggle` is shown in the Workspace panel's group of keys.
 *
 * @param {HTMLInputElement} toggle
 */
function assertInPanelGroup(toggle) {
  Assert.ok(toggle.checkVisibility(), "the switch is shown");
  Assert.ok(
    toggle
      .closest(".sval-keys-group")
      ?.querySelector(`.sval-keys-row[data-id="${PANEL_TOGGLE_KEY}"]`),
    "in the Workspace panel's group"
  );
}

add_task(async function the_pane_switches_ctrl_tab_order() {
  const PREF = "browser.ctrlTab.sortByRecentlyUsed";
  const { ui } = await openKeyboardPane();
  const toggle = ui.byId("sval-ctrl-tab-recent");
  assertInPanelGroup(toggle);
  const key = AppConstants.platform === "macosx" ? "⌃Tab" : "Ctrl+Tab";
  for (const el of ui.page.document.querySelectorAll(".sval-ctrl-tab-key")) {
    Assert.equal(el.textContent, key, "it names the key as this platform does");
  }
  Assert.ok(toggle.checked, "Ctrl+Tab goes by use to begin with");
  toggle.click();
  registerCleanupFunction(() => Services.prefs.clearUserPref(PREF));
  Assert.ok(
    !Services.prefs.getBoolPref(PREF),
    "turning it off writes the pref"
  );
  Assert.ok(!window.ctrlTab._recentlyUsedTabs, "and Ctrl+Tab goes by place");
  Services.prefs.clearUserPref(PREF);
  await TestUtils.waitForCondition(
    () => toggle.checked,
    "the switch follows the pref"
  );
});

add_task(async function the_pane_switches_workspace_swipes() {
  const PREF = "browser.sval.panel.swipeWorkspaces";
  const { ui } = await openKeyboardPane();
  const toggle = ui.byId("sval-swipe-workspaces");
  assertInPanelGroup(toggle);
  Assert.ok(toggle.checked, "a swipe over the panel switches to begin with");
  toggle.click();
  registerCleanupFunction(() => Services.prefs.clearUserPref(PREF));
  Assert.ok(
    !Services.prefs.getBoolPref(PREF),
    "turning it off writes the pref"
  );
  Services.prefs.clearUserPref(PREF);
  await TestUtils.waitForCondition(
    () => toggle.checked,
    "the switch follows the pref"
  );
});

/**
 * The pane lists the Launcher's key, which can be changed, and where Enter
 * opens what the Launcher finds (launcher spec §8); not Alt+D, which Sval
 * does not show (spec §3).
 */
add_task(async function the_pane_lists_the_launcher() {
  const { ui, rows } = await openKeyboardPane();
  const [group, ...titles] = await ui.page.document.l10n.formatValues([
    "launcher-keys-group",
    "launcher-keys-open",
    "launcher-keys-new-tab",
    "launcher-keys-new-window",
    "launcher-keys-split",
  ]);
  const launcher = rows().filter(r => r.group === group);
  const { ShortcutUtils } = ChromeUtils.importESModule(
    "resource://gre/modules/ShortcutUtils.sys.mjs"
  );
  const enter = modifiers =>
    ShortcutUtils.getModifierString(modifiers) +
    ShortcutUtils.getKeyString("VK_RETURN");
  Assert.deepEqual(
    launcher.map(r => [r.title, r.shortcut]),
    [
      [
        titles[0],
        ShortcutUtils.prettifyShortcut(document.getElementById("focusURLBar")),
      ],
      [titles[1], enter("shift")],
      [titles[2], enter("accel,shift")],
      [titles[3], enter("alt")],
    ],
    "the Launcher's key and Enter's modifiers"
  );
  Assert.equal(launcher[0].id, "focusURLBar", "its key can be changed");
  Assert.equal(
    rows().filter(r => r.id === "focusURLBar").length,
    1,
    "listed once"
  );
  Assert.ok(!rows().some(r => r.id === "focusURLBar2"), "Alt+D is not listed");
});

/**
 * Waits for the parent's key capture to be on or off. The pane turns it on
 * and off with a message (`CustomKeys:CaptureKey` in CustomKeysParent.sys.mjs),
 * which adds or removes the actor's keydown listener on the page's browser.
 * Until it has, a key reaches the page as any key would, so Tab moves the
 * focus rather than ending the change, and a message still on its way when
 * the task closes the tab finds no browser.
 *
 * @param {object} ui The pane, as `openKeyboardPane` gives it.
 * @param {boolean} on
 */
async function captureIs(ui, on) {
  const context = ui.page.browsingContext;
  const browser = context.embedderElement;
  const actor = context.currentWindowGlobal.getActor("CustomKeys");
  await TestUtils.waitForCondition(
    () =>
      Services.els
        .getListenerInfoFor(browser)
        .some(l => l.type == "keydown" && l.listenerObject === actor) === on,
    on ? "the key capture is on" : "the key capture is off"
  );
}

add_task(async function a_key_changed_in_the_pane_is_the_key() {
  const { ui, rows } = await openKeyboardPane();
  const { row } = rows().find(r => r.id === PANEL_TOGGLE_KEY);
  row.querySelector('[data-action="change"]').click();
  const input = row.querySelector(".sval-keys-new");
  await TestUtils.waitForCondition(
    () => ui.page.document.activeElement === input,
    "the field waits for the new key"
  );
  await captureIs(ui, true);
  const key = document.getElementById(PANEL_TOGGLE_KEY);
  const change = row.querySelector('[data-action="change"]');
  const original = ShortcutUtils.prettifyShortcut(key);
  EventUtils.synthesizeKey("KEY_Tab", { shiftKey: true }, ui.page);
  await TestUtils.waitForCondition(
    () => ui.page.document.activeElement === change,
    "Shift+Tab leaves the field for Change"
  );
  await captureIs(ui, false);
  Assert.equal(
    ShortcutUtils.prettifyShortcut(key),
    original,
    "and assigns nothing"
  );
  Assert.equal(key.getAttribute("data-l10n-id"), "toggle-sidebar-shortcut");
  change.click();
  await TestUtils.waitForCondition(
    () => ui.page.document.activeElement === input,
    "the field waits again"
  );
  await captureIs(ui, true);
  const isMac = AppConstants.platform === "macosx";
  EventUtils.synthesizeKey(
    "K",
    { altKey: true, shiftKey: true, ctrlKey: !isMac, metaKey: isMac },
    ui.page
  );
  await TestUtils.waitForCondition(
    () => key.getAttribute("key") === "K",
    "the window's key is the new one"
  );
  // The pane redraws the row from the parent's answer to `ChangeKey`, which
  // arrives after the parent has set the window's key.
  await TestUtils.waitForCondition(
    () =>
      row.querySelector(".sval-keys-shortcut").textContent ===
      ShortcutUtils.prettifyShortcut(key),
    "and the pane says so"
  );
  await captureIs(ui, false);
  Assert.ok(
    !row.querySelector('[data-action="reset"]').hidden,
    "with a way back"
  );

  const before = panelShown();
  await selectTab(gBrowser.tabs[0]);
  pressKey(PANEL_TOGGLE_KEY);
  await TestUtils.waitForCondition(
    () => panelShown() !== before,
    "the new key toggles the panel"
  );
  pressKey(PANEL_TOGGLE_KEY);
  await TestUtils.waitForCondition(() => panelShown() === before, "back");

  await selectTab(ui.tab);
  row.querySelector('[data-action="reset"]').click();
  await TestUtils.waitForCondition(
    () => key.getAttribute("data-l10n-id") === "toggle-sidebar-shortcut",
    "Reset puts Firefox's key back"
  );
});

/**
 * While a key is being changed, Cancel beside the field ends the change and
 * assigns nothing. The capture takes keys alone, so the click reaches it, and
 * the field keeps the focus until the click lands.
 */
add_task(async function cancel_ends_a_change() {
  const { ui, rows } = await openKeyboardPane();
  const { row } = rows().find(r => r.id === PANEL_TOGGLE_KEY);
  const input = row.querySelector(".sval-keys-new");
  const change = row.querySelector('[data-action="change"]');
  const cancel = row.querySelector('[data-action="cancel"]');
  Assert.ok(cancel.hidden, "no Cancel until a change starts");
  change.click();
  await TestUtils.waitForCondition(
    () => ui.page.document.activeElement === input,
    "the field waits for the new key"
  );
  await captureIs(ui, true);
  Assert.ok(cancel.checkVisibility(), "Cancel shows beside the field");
  Assert.equal(
    input.nextElementSibling,
    cancel,
    "right after the field it ends"
  );
  const key = document.getElementById(PANEL_TOGGLE_KEY);
  const original = ShortcutUtils.prettifyShortcut(key);
  EventUtils.synthesizeMouseAtCenter(cancel, {}, ui.page);
  await TestUtils.waitForCondition(
    () => ui.page.document.activeElement === change,
    "Cancel puts the focus back on Change"
  );
  await captureIs(ui, false);
  Assert.ok(input.hidden, "the field is gone");
  Assert.ok(cancel.hidden, "and so is Cancel");
  Assert.ok(!change.hidden, "Change is back");
  Assert.equal(
    ShortcutUtils.prettifyShortcut(key),
    original,
    "and no key was assigned"
  );
});
