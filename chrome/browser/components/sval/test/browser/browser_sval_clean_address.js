/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

// Copy Clean Address: the Address row in Site settings copies the page's
// address without the tracking parameters Firefox's strip-on-share lists
// name, keeps every other parameter, and pins a button to the address bar
// that does the same.

const { CLEAN_ADDRESS_BUTTON_ID, PINS_PREF } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteControls.sys.mjs"
);

const PAGE_PATH =
  "/browser/browser/components/sval/test/browser/sval_site_styles.html";
// `utm_source` is in the shipped list's global rule; `id` is in none.
const TRACKED = `https://example.com${PAGE_PATH}?id=7&utm_source=news`;
const CLEAN = `https://example.com${PAGE_PATH}?id=7`;

add_setup(failOnConsoleErrors);
add_setup(async function () {
  // Query stripping on load would take `utm_source` off before the copy.
  await SpecialPowers.pushPrefEnv({
    set: [
      ["privacy.query_stripping.enabled", false],
      ["privacy.query_stripping.enabled.pbmode", false],
    ],
  });
  registerCleanupFunction(() => Services.prefs.clearUserPref(PINS_PREF));
});

function byId(id) {
  return document.getElementById(id);
}

function button() {
  return byId(CLEAN_ADDRESS_BUTTON_ID);
}

/** @returns {string[]} the buttons the pref pins. */
function pinned() {
  return JSON.parse(Services.prefs.getStringPref(PINS_PREF));
}

/**
 * @param {Function} check
 * @param {string} what
 * @returns {Promise<void>} once `check` passes, bounded.
 */
function until(check, what) {
  return within(TestUtils.waitForCondition(check, what), 10_000, what);
}

function menuReady() {
  return until(
    () => !byId("sval-site-menu-button").disabled,
    "the site controls reading the page"
  );
}

async function openMenu() {
  const menu = byId("sval-site-menu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  byId("sval-site-menu-button").click();
  await within(shown, 10_000, "the site menu showing");
}

async function closeMenu() {
  const menu = byId("sval-site-menu");
  if (menu.state === "closed") {
    return;
  }
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(hidden, 10_000, "the site menu hiding");
}

/**
 * Runs `action`, and waits for the clipboard to hold `expected` and for the
 * confirmation to show.
 *
 * @param {Function} action
 * @param {string} expected
 * @returns {Promise<string>} The confirmation's message id.
 */
async function copied(action, expected) {
  const panel = () => byId("confirmation-hint");
  const shown = BrowserTestUtils.waitForEvent(
    window,
    "popupshown",
    false,
    event => event.target.id === "confirmation-hint"
  );
  await within(
    SimpleTest.promiseClipboardChange(expected, action),
    10_000,
    "the address on the clipboard"
  );
  await within(shown, 10_000, "the confirmation");
  const id = panel().getAttribute("data-message-id");
  const hidden = BrowserTestUtils.waitForPopupEvent(panel(), "hidden");
  panel().hidePopup();
  await within(hidden, 10_000, "the confirmation closing");
  return id;
}

add_task(async function the_address_row_pins_and_unpins_the_button() {
  atTaskEnd(() => Services.prefs.clearUserPref(PINS_PREF));
  await BrowserTestUtils.withNewTab(TRACKED, async () => {
    await menuReady();
    ok(button().hidden, "the button starts unpinned");
    await openMenu();
    try {
      const pin = byId("sval-site-pin-clean-address");
      is(pin.getAttribute("aria-pressed"), "false", "the pin is off");
      pin.click();
      ok(pinned().includes("clean-address"), "the pref pins the button");
      await until(() => !button().hidden, "the button showing");
      byId("sval-site-pin-clean-address").click();
      ok(!pinned().includes("clean-address"), "the pref unpins it");
      await until(() => button().hidden, "the button hiding");
    } finally {
      await closeMenu();
    }
  });
});

add_task(async function the_row_copies_the_address_without_trackers() {
  await BrowserTestUtils.withNewTab(TRACKED, async () => {
    await menuReady();
    await openMenu();
    is(
      byId("sval-site-clean-address-sub").dataset.tracked,
      "true",
      "the row says the address has some"
    );
    const id = await copied(
      () => byId("sval-site-clean-address").click(),
      CLEAN
    );
    is(id, "launcher-command-copy-clean-address-done", "Sval confirms it");
    is(byId("sval-site-menu").state, "closed", "the menu closed");
  });
});

add_task(async function the_pinned_button_copies_the_clean_address() {
  atTaskEnd(() => Services.prefs.clearUserPref(PINS_PREF));
  Services.prefs.setStringPref(
    PINS_PREF,
    JSON.stringify([...pinned(), "clean-address"])
  );
  await BrowserTestUtils.withNewTab(TRACKED, async () => {
    await menuReady();
    await until(() => !button().hidden, "the button showing");
    const id = await copied(() => button().click(), CLEAN);
    is(id, "launcher-command-copy-clean-address-done", "Sval confirms it");
  });
});

add_task(async function an_address_without_trackers_copies_as_it_is() {
  await BrowserTestUtils.withNewTab(CLEAN, async () => {
    await menuReady();
    await openMenu();
    is(
      byId("sval-site-clean-address-sub").dataset.tracked,
      "false",
      "the row says there is nothing to take out"
    );
    const id = await copied(
      () => byId("sval-site-clean-address").click(),
      CLEAN
    );
    is(id, "launcher-command-copy-address-done", "Sval says it copied it");
  });
});
