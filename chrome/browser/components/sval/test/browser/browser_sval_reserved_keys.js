/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * A page that takes every key it is given cannot take Sval's commands from
 * it: each reserved key runs its command and never reaches the page, a key
 * the user gives a command stays reserved, and copy, paste, cut, undo,
 * select all, find and save still reach the page, as does the panel's
 * Control+Z on macOS. Copy Address copies the page's address and confirms it.
 */

const {
  COPY_ADDRESS_KEY,
  COPY_ADDRESS_MENU_ITEM_ID,
  MODE_KEYS,
  NEW_WORKSPACE_KEY,
  STYLE_KEY,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalShortcuts.sys.mjs"
);
const { CustomKeys } = ChromeUtils.importESModule(
  "moz-src:///browser/components/customkeys/CustomKeys.sys.mjs"
);

const TAKER = ROOT + "sval_key_taker.html";
const isMac = AppConstants.platform === "macosx";

registerCleanupFunction(() => CustomKeys.resetAll());

/**
 * The `<key>`s of Sval's commands that have a key by default, each run as a
 * `command` event on its command element, or on the key with none. The
 * panel's key is reserved on Windows and Linux alone.
 */
const RESERVED_KEY_IDS = [
  COPY_ADDRESS_KEY,
  "focusURLBar",
  ...(isMac ? [] : ["toggleSidebarKb"]),
  "key_addTabSplitView",
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(n => `key_selectTab${n}`),
  "key_selectLastTab",
];

/**
 * `EventUtils.synthesizeKey`'s arguments for the key `<key id>` is now.
 *
 * @param {Element} el A `<key>`.
 * @returns {Array} `[key, modifiers]`.
 */
function pressOf(el) {
  const modifiers = (el.getAttribute("modifiers") ?? "").split(/[\s,]+/);
  const has = name => modifiers.includes(name);
  const keycode = el.getAttribute("keycode");
  return [
    keycode ? `KEY_${keycode.replace(/^VK_/, "")}` : el.getAttribute("key"),
    {
      ctrlKey: has("control") || (has("accel") && !isMac),
      metaKey: has("meta") || (has("accel") && isMac),
      altKey: has("alt"),
      shiftKey: has("shift"),
    },
  ];
}

/**
 * @param {Element} browser
 * @returns {Promise<object[]>} the keydowns the page has heard.
 */
function heard(browser) {
  return SpecialPowers.spawn(browser, [], () =>
    Cu.cloneInto(content.wrappedJSObject.heard, {})
  );
}

/**
 * Opens the page that takes every key, with the focus in it.
 *
 * @returns {Promise<Element>} its tab.
 */
async function openTaker() {
  const tab = await openPage(TAKER);
  await focusTaker(tab.linkedBrowser);
  return tab;
}

async function focusTaker(browser) {
  browser.focus();
  await SpecialPowers.spawn(browser, [], () =>
    content.document.getElementById("taker").focus()
  );
  await TestUtils.waitForCondition(
    () => Services.focus.focusedElement === browser,
    "the page has the focus"
  );
}

/**
 * Presses `m`, which the page takes, and resolves with what the page heard
 * up to it. Key events reach the page in order, so a key pressed before it
 * that the page never heard was kept from it.
 *
 * @param {Element} browser
 * @returns {Promise<object[]>}
 */
async function heardUpToMarker(browser) {
  EventUtils.synthesizeKey("m", {});
  const isMarker = e => e.key === "m" && !e.ctrl && !e.meta && !e.alt;
  let seen = [];
  await TestUtils.waitForCondition(async () => {
    seen = await heard(browser);
    return seen.some(isMarker);
  }, "the page hears the marker");
  return seen.slice(0, seen.findIndex(isMarker));
}

/**
 * Records the `command` events the window's keys raise and stops each before
 * its handlers, so pressing a key proves it ran without running it.
 *
 * @returns {string[]} the ids of the elements each command reached.
 */
function catchCommands() {
  const caught = [];
  const listener = event => {
    if (event.target.id) {
      caught.push(event.target.id);
    }
    event.stopPropagation();
    event.preventDefault();
  };
  window.addEventListener("command", listener, true);
  atTaskEnd(() => window.removeEventListener("command", listener, true));
  return caught;
}

/**
 * @param {Element} el A `<key>`.
 * @returns {string} the element its `command` event reaches.
 */
function commandTarget(el) {
  return el.getAttribute("command") || el.id;
}

add_task(async function sval_keys_run_and_never_reach_the_page() {
  const tab = await openTaker();
  const caught = catchCommands();
  for (const id of RESERVED_KEY_IDS) {
    const el = document.getElementById(id);
    Assert.equal(el.getAttribute("reserved"), "true", `${id} is reserved`);
    const before = caught.length;
    EventUtils.synthesizeKey(...pressOf(el));
    Assert.deepEqual(
      caught.slice(before),
      [commandTarget(el)],
      `${id} runs its command`
    );
  }
  Assert.deepEqual(
    await heardUpToMarker(tab.linkedBrowser),
    [],
    "and the page heard none of them"
  );
});

/**
 * The commands with no key until the user gives one, and Copy Address given
 * another, keep the key from the page: `CustomKeys` changes the key and
 * leaves `reserved`.
 */
add_task(async function a_key_the_user_gives_stays_reserved() {
  const ids = [
    COPY_ADDRESS_KEY,
    NEW_WORKSPACE_KEY,
    ...Object.values(MODE_KEYS),
    "key_separateTabSplitView",
    STYLE_KEY,
  ];
  const letters = ["U", "J", "Y", "O", "K", "E"];
  ids.forEach((id, i) => {
    CustomKeys.changeKey(id, { modifiers: "accel,alt,shift", key: letters[i] });
    atTaskEnd(() => CustomKeys.resetKey(id));
  });
  const tab = await openTaker();
  const caught = catchCommands();
  for (const id of ids) {
    const el = document.getElementById(id);
    Assert.equal(el.getAttribute("reserved"), "true", `${id} stays reserved`);
    const before = caught.length;
    EventUtils.synthesizeKey(...pressOf(el));
    Assert.deepEqual(
      caught.slice(before),
      [commandTarget(el)],
      `${id} runs on its new key`
    );
  }
  Assert.deepEqual(
    await heardUpToMarker(tab.linkedBrowser),
    [],
    "and the page heard none of them"
  );
});

/**
 * Firefox keeps recent-tab switching from a page with no `<key>` of Sval's.
 * With two tabs Ctrl+Tab selects the other at once (`ctrlTab.onKeyDown`),
 * which shows the key reached it.
 */
add_task(async function ctrl_tab_switches_tabs_over_a_page_that_takes_it() {
  keepPrefs("browser.engagement.ctrlTab.has-used");
  const [other] = gBrowser.tabs;
  const tab = await openTaker();
  Assert.equal(gBrowser.visibleTabs.length, 2, "two tabs");
  EventUtils.synthesizeKey("KEY_Tab", { ctrlKey: true });
  await TestUtils.waitForCondition(
    () => gBrowser.selectedTab === other,
    "Ctrl+Tab selects the other tab"
  );
  await switchDone();
  await selectTab(tab);
  await focusTaker(tab.linkedBrowser);
  EventUtils.synthesizeKey("KEY_Tab", { ctrlKey: true, shiftKey: true });
  await TestUtils.waitForCondition(
    () => gBrowser.selectedTab !== tab,
    "Ctrl+Shift+Tab leaves the page too"
  );
  await switchDone();
  await selectTab(tab);
  await focusTaker(tab.linkedBrowser);
  Assert.deepEqual(
    (await heardUpToMarker(tab.linkedBrowser)).filter(e => e.code === "Tab"),
    [],
    "and the page heard neither"
  );
});

add_task(async function f6_leaves_a_page_that_takes_it() {
  const tab = await openTaker();
  EventUtils.synthesizeKey("KEY_F6", {});
  await TestUtils.waitForCondition(
    () => Services.focus.focusedElement !== tab.linkedBrowser,
    "F6 moves the focus out of the page"
  );
  Assert.ok(
    !tab.linkedBrowser.contains(Services.focus.focusedElement),
    "into the browser's own controls"
  );
  await focusTaker(tab.linkedBrowser);
  EventUtils.synthesizeKey("KEY_F6", { shiftKey: true });
  await TestUtils.waitForCondition(
    () => Services.focus.focusedElement !== tab.linkedBrowser,
    "Shift+F6 does too"
  );
  await focusTaker(tab.linkedBrowser);
  Assert.deepEqual(
    (await heardUpToMarker(tab.linkedBrowser)).filter(e => e.code === "F6"),
    [],
    "and the page never heard either"
  );
});

/**
 * Web apps answer these themselves, so the page hears each and its
 * preventDefault keeps the browser's own action from running.
 */
add_task(async function a_page_still_takes_copy_paste_and_save() {
  const tab = await openTaker();
  const keys = ["c", "v", "x", "z", "a", "f", "s"];
  for (const key of keys) {
    EventUtils.synthesizeKey(key, { accelKey: true });
  }
  const seen = await heardUpToMarker(tab.linkedBrowser);
  Assert.deepEqual(
    seen.map(e => e.key),
    keys,
    "the page hears copy, paste, cut, undo, select all, find and save"
  );
  Assert.ok(
    !gBrowser.isFindBarInitialized(tab) || gBrowser.getFindBar(tab).hidden,
    "and Find, which it took, did not open"
  );
});

/**
 * A terminal in a page suspends a job with Control+Z, so on macOS the page
 * hears the panel's key and its preventDefault keeps the panel as it is.
 */
add_task(
  { skip_if: () => !isMac },
  async function a_page_takes_the_panels_control_z() {
    const tab = await openTaker();
    const caught = catchCommands();
    const toggle = document.getElementById("toggleSidebarKb");
    Assert.ok(!toggle.hasAttribute("reserved"), "the key is not reserved");
    EventUtils.synthesizeKey(...pressOf(toggle));
    const seen = await heardUpToMarker(tab.linkedBrowser);
    Assert.deepEqual(
      seen.map(e => [e.key.toLowerCase(), e.ctrl]),
      [["z", true]],
      "the page hears Control+Z"
    );
    Assert.deepEqual(caught, [], "and the panel's command does not run");
  }
);

add_task(async function copy_address_copies_the_page_address() {
  const tab = await openTaker();
  SpecialPowers.clipboardCopyString("nothing yet");
  const shown = BrowserTestUtils.waitForEvent(
    window,
    "popupshown",
    false,
    event => event.target.id === "confirmation-hint"
  );
  EventUtils.synthesizeKey("C", { accelKey: true, shiftKey: true });
  await within(shown, 10_000, "the confirmation");
  const panel = document.getElementById("confirmation-hint");
  Assert.equal(
    panel.getAttribute("data-message-id"),
    "launcher-command-copy-address-done",
    "Sval confirms the copy"
  );
  Assert.equal(
    SpecialPowers.getClipboardData("text/plain"),
    TAKER,
    "the clipboard holds the page's address"
  );
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  panel.hidePopup();
  await within(hidden, 10_000, "the confirmation closing");
  Assert.deepEqual(
    await heardUpToMarker(tab.linkedBrowser),
    [],
    "and the page never heard the key"
  );
});

add_task(function the_tab_menu_names_copy_address() {
  const item = document.getElementById(COPY_ADDRESS_MENU_ITEM_ID);
  Assert.equal(item?.getAttribute("key"), COPY_ADDRESS_KEY, "with its key");
  Assert.ok(item.closest("#sval-tab-menu"), "in the Tab menu");
});

/** The Inspector gives Accel+Shift+C up and keeps its other key. */
add_task(function the_inspector_keeps_its_other_key() {
  const keys = [...document.querySelectorAll("#devtoolsKeyset key")];
  const accelShiftC = keys.filter(
    k =>
      k.getAttribute("key")?.toUpperCase() === "C" &&
      k.getAttribute("modifiers") === "accel,shift"
  );
  Assert.deepEqual(accelShiftC, [], "no developer tool takes Accel+Shift+C");
  if (isMac) {
    const inspector = document.getElementById("key_inspector");
    Assert.equal(inspector?.getAttribute("modifiers"), "accel,alt", "⌥⌘C");
  } else {
    const toolbox = document.getElementById("key_toggleToolbox");
    Assert.equal(
      toolbox?.getAttribute("modifiers"),
      "accel,shift",
      "Ctrl+Shift+I opens the toolbox"
    );
  }
});
