/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_blocking_helpers.js */
/* import-globals-from sval_preferences_helpers.js */

// Remove from this site and Snip as keyboard commands: no key until the
// person gives one in Settings' Keyboard shortcuts pane, through Firefox's
// `CustomKeys`, and items in the Tab menu.

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_blocking_helpers.js",
  this
);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

const { MODE_KEYS, MODE_NAMES } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalShortcuts.sys.mjs"
);
const { SvalElementPicker, MODE_TOPIC } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalElementPicker.sys.mjs"
);
const { SvalSiteControls, PINS_PREF } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteControls.sys.mjs"
);
const { SvalBlocking } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
);
const { SvalBlockingLists } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlockingLists.sys.mjs"
);
const { CustomKeys } = ChromeUtils.importESModule(
  "moz-src:///browser/components/customkeys/CustomKeys.sys.mjs"
);

const SNIP_PAGE =
  "https://example.net/browser/browser/components/sval/test/browser/sval_element_snip.html";
const PICKER_PAGE =
  "https://example.net/browser/browser/components/sval/test/browser/sval_element_picker.html";

const SNIP_KEY = { modifiers: "accel,alt,shift", key: "J" };
const PICKER_KEY = { modifiers: "accel,alt,shift", key: "U" };

registerCleanupFunction(() => CustomKeys.resetAll());

/**
 * Presses the key assigned to `<key id>`, as the person would.
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
 * Fails when another `<key>` of the window has `binding`, which would run
 * in its place.
 *
 * @param {object} binding
 * @param {string} binding.modifiers
 * @param {string} binding.key
 */
function assertUnused({ modifiers, key }) {
  const sorted = text =>
    (text ?? "")
      .split(/[\s,]+/)
      .filter(Boolean)
      .sort()
      .join(",");
  const taken = [...document.querySelectorAll("key")].filter(
    el =>
      el.getAttribute("key")?.toUpperCase() === key &&
      sorted(el.getAttribute("modifiers")) === sorted(modifiers)
  );
  Assert.deepEqual(
    taken.map(el => el.id),
    [],
    `no other key is ${modifiers}+${key}`
  );
}

/**
 * Starts a mode with its key on the selected tab, and leaves it.
 *
 * @param {Element} browser
 * @param {"remove"|"snip"} mode
 */
async function keyStarts(browser, mode) {
  browser.focus();
  const started = within(
    TestUtils.topicObserved(MODE_TOPIC, (s, data) => data == mode),
    10_000,
    `the ${mode} starting`
  );
  pressKey(MODE_KEYS[mode]);
  await started;
  Assert.equal(SvalElementPicker.active(browser), mode, "on the tab");
  const ended = within(
    TestUtils.topicObserved(MODE_TOPIC, (s, data) => !data),
    10_000,
    `the ${mode} ending`
  );
  SvalElementPicker.stop(browser);
  await ended;
}

/** @returns {boolean[]} whether each Tab menu item is disabled, once shown. */
function tabMenuItemsDisabled() {
  const popup = document.getElementById("sval-tab-menu-popup");
  popup.dispatchEvent(new Event("popupshowing"));
  return Object.values(MODE_KEYS).map(id =>
    document
      .querySelector(`#sval-tab-menu-popup > menuitem[key="${id}"]`)
      .hasAttribute("disabled")
  );
}

add_setup(async function () {
  keepPrefs(
    PINS_PREF,
    "browser.sval.adblock.",
    "privacy.trackingprotection.",
    "privacy.query_stripping.",
    "browser.contentblocking.category"
  );
  await SpecialPowers.pushPrefEnv({
    set: [...CONTENT_BLOCKING_TEST_PREFS],
    clear: [
      ["browser.sval.adblock.customFrom"],
      ["browser.sval.adblock.myFilters"],
      ["browser.sval.adblock.myFiltersTrustedHere"],
    ],
  });
  await serveLists();
  registerCleanupFunction(async () => {
    SvalBlocking.setLevel("off");
    await IOUtils.remove(SvalBlockingLists.dir, {
      recursive: true,
      ignoreAbsent: true,
    });
  });
  SvalBlocking.setLevel("off");
  SvalBlocking.setListEnabled("sval-easylist", true);
  SvalBlocking.flush();
  ok(await SvalBlockingLists.update("sval-easylist"), "a list downloads");
  await listsInForce();
  isnot(SvalBlocking.level, "off", "ad blocking is on");
});

add_task(async function both_commands_are_listed_with_no_key() {
  for (const [mode, id] of Object.entries(MODE_KEYS)) {
    const key = document.getElementById(id);
    Assert.equal(key?.localName, "key", `${mode} is a key of the window`);
    Assert.ok(
      !key.hasAttribute("key") && !key.hasAttribute("keycode"),
      `${mode} starts with no key`
    );
    Assert.equal(
      document
        .querySelector(`#sval-tab-menu-popup > menuitem[key="${id}"]`)
        ?.getAttribute("label"),
      `${MODE_NAMES[mode]}…`,
      `the Tab menu offers ${mode}`
    );
  }
  const ui = await openPane(
    "svalKeyboard",
    ({ byId }) => byId("sval-keys-list")?.querySelector(".sval-keys-row"),
    "the shortcuts listed"
  );
  const rows = [
    ...ui.byId("sval-keys-list").querySelectorAll(".sval-keys-row"),
  ];
  for (const [mode, id] of Object.entries(MODE_KEYS)) {
    const title = MODE_NAMES[mode];
    const row = rows.find(r => r.dataset.id === id);
    Assert.equal(row?.querySelector("th").textContent, title, `${title} row`);
    Assert.ok(
      row.classList.contains("sval-keys-unassigned"),
      `${title} has no key`
    );
    Assert.ok(
      !row.querySelector('[data-action="change"]').hidden,
      `${title} can be given one`
    );
  }
});

add_task(async function a_key_given_to_remove_for_now_starts_the_snip() {
  Services.prefs.setStringPref(PINS_PREF, JSON.stringify(["snip"]));
  assertUnused(SNIP_KEY);
  CustomKeys.changeKey(MODE_KEYS.snip, SNIP_KEY);
  const key = document.getElementById(MODE_KEYS.snip);
  Assert.equal(key.getAttribute("key"), SNIP_KEY.key, "the key is set");

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:blank" },
    async browser => {
      browser.focus();
      pressKey(MODE_KEYS.snip);
      Assert.equal(
        SvalElementPicker.active(browser),
        null,
        "the key does nothing where Snip is not offered"
      );
    }
  );

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: SNIP_PAGE },
    async browser => {
      const button = document.getElementById("sval-snip-button");
      const shortcut = ShortcutUtils.prettifyShortcut(key);
      await within(
        TestUtils.waitForCondition(() => {
          button.dispatchEvent(new MouseEvent("mouseover"));
          return button.getAttribute("tooltiptext").includes(shortcut);
        }, "the pinned button's tooltip names the key after the name"),
        10_000,
        "the tooltip naming the key"
      );
      Assert.ok(
        button.getAttribute("aria-keyshortcuts"),
        "and its aria-keyshortcuts does too"
      );
      Assert.equal(
        button.getAttribute("aria-label"),
        MODE_NAMES.snip,
        "its name stays the command's"
      );

      await keyStarts(browser, "snip");

      CustomKeys.resetKey(MODE_KEYS.snip);
      button.dispatchEvent(new MouseEvent("mouseover"));
      Assert.equal(
        button.getAttribute("tooltiptext"),
        MODE_NAMES.snip,
        "with the key reset, the tooltip names none"
      );
      Assert.ok(!button.hasAttribute("aria-keyshortcuts"), "nor does its ARIA");
    }
  );
});

add_task(async function a_key_given_to_hide_an_element_starts_the_picker() {
  assertUnused(PICKER_KEY);
  CustomKeys.changeKey(MODE_KEYS.remove, PICKER_KEY);
  atTaskEnd(() => CustomKeys.resetKey(MODE_KEYS.remove));
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: PICKER_PAGE },
    async browser => {
      await keyStarts(browser, "remove");
    }
  );
});

add_task(async function the_tools_items_are_disabled_where_not_offered() {
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:blank" },
    async () => {
      Assert.deepEqual(
        tabMenuItemsDisabled(),
        [true, true],
        "neither mode is offered on a page with no site"
      );
    }
  );
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: PICKER_PAGE },
    async () => {
      Assert.deepEqual(
        tabMenuItemsDisabled(),
        [false, false],
        "both are offered on a website with ad blocking on"
      );
    }
  );
});
