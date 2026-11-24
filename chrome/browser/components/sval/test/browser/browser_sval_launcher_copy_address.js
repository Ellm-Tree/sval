/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * The floating Launcher's copy buttons: while the field holds the page's
 * address, a pill set at its end copies it whole or without its tracking
 * parameters, and closes the float with focus on the page. It hides once
 * the field holds anything else, and on a page with no address.
 */

const { COPY_ADDRESS_BUTTON_ID, COPY_CLEAN_ADDRESS_BUTTON_ID } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalLauncher.sys.mjs"
  );

const PAGE_PATH =
  "/browser/browser/components/sval/test/browser/sval_site_styles.html";
// `utm_source` is in the shipped list's global rule; `id` is in none.
const TRACKED = `https://example.com${PAGE_PATH}?id=7&utm_source=news`;
const CLEAN = `https://example.com${PAGE_PATH}?id=7`;

add_setup(failOnConsoleErrors);

add_setup(async function () {
  registerCleanupFunction(() => gURLBar.handleRevert());
});

function byId(id) {
  return document.getElementById(id);
}

function floating() {
  return gURLBar.hasAttribute("sval-launcher-floating");
}

/**
 * @param {Function} check
 * @param {string} what
 * @returns {Promise<void>} once `check` passes, bounded.
 */
function until(check, what) {
  return within(TestUtils.waitForCondition(check, what), 10_000, what);
}

/** Whether both copy buttons show. */
function copiesShow() {
  return [COPY_ADDRESS_BUTTON_ID, COPY_CLEAN_ADDRESS_BUTTON_ID].every(id =>
    byId(id)?.checkVisibility()
  );
}

/**
 * Runs `task` in a new tab showing `TRACKED`, reached by a link within the
 * site. Firefox strips a load's tracking parameters only when the load is
 * cross-site or the system's own
 * (`nsDocShellLoadState::MaybeStripTrackingQueryParams`).
 *
 * @param {Function} task
 * @returns {Promise<void>}
 */
function withTrackedTab(task) {
  return BrowserTestUtils.withNewTab(CLEAN, async browser => {
    await pageReady(browser, CLEAN);
    browser.loadURI(Services.io.newURI(TRACKED), {
      triggeringPrincipal:
        Services.scriptSecurityManager.createContentPrincipal(
          Services.io.newURI(CLEAN),
          {}
        ),
    });
    await pageReady(browser, TRACKED);
    await task(browser);
  });
}

/** Floats the Launcher with its key over the selected tab. */
async function floatIt() {
  await within(SimpleTest.promiseFocus(window), 10_000, "the window's focus");
  gBrowser.selectedBrowser.focus();
  EventUtils.synthesizeKey("l", { accelKey: true });
  await until(() => floating() && gURLBar.focused, "the Launcher floating");
}

/** Closes the float, if it is open, and waits for its fade. */
async function closeIt() {
  if (floating()) {
    EventUtils.synthesizeKey("KEY_Escape");
  }
  await until(() => !floating(), "the address bar back in the toolbar");
}

/**
 * Clicks a copy button, and waits for the clipboard to hold `expected`, the
 * confirmation to show and the float to close.
 *
 * @param {string} id The button's id.
 * @param {string} expected
 * @returns {Promise<string>} The confirmation's message id.
 */
async function copyWith(id, expected) {
  const panel = () => byId("confirmation-hint");
  const shown = BrowserTestUtils.waitForEvent(
    window,
    "popupshown",
    false,
    event => event.target.id === "confirmation-hint"
  );
  await within(
    SimpleTest.promiseClipboardChange(expected, () =>
      EventUtils.synthesizeMouseAtCenter(byId(id), {})
    ),
    10_000,
    "the address on the clipboard"
  );
  await within(shown, 10_000, "the confirmation");
  const message = panel().getAttribute("data-message-id");
  const hidden = BrowserTestUtils.waitForPopupEvent(panel(), "hidden");
  panel().hidePopup();
  await within(hidden, 10_000, "the confirmation closing");
  await until(() => !floating(), "the float closing");
  Assert.equal(
    document.activeElement,
    gBrowser.selectedBrowser,
    "focus is on the page"
  );
  return message;
}

add_task(async function the_buttons_copy_the_address_whole_or_clean() {
  await withTrackedTab(async () => {
    await floatIt();
    await until(copiesShow, "the copy buttons showing");
    is(
      await copyWith(COPY_ADDRESS_BUTTON_ID, TRACKED),
      "launcher-command-copy-address-done",
      "Copy Address copies the address as it is"
    );

    await floatIt();
    await until(copiesShow, "the copy buttons showing again");
    is(
      await copyWith(COPY_CLEAN_ADDRESS_BUTTON_ID, CLEAN),
      "launcher-command-copy-clean-address-done",
      "Copy Clean Address takes the tracking parameters out"
    );
  });
});

add_task(async function typing_hides_the_buttons() {
  await withTrackedTab(async () => {
    await floatIt();
    await until(copiesShow, "the copy buttons showing");
    EventUtils.sendString("weather");
    await until(() => !copiesShow(), "the copy buttons hiding");
    await closeIt();
  });
});

add_task(async function a_page_without_an_address_has_no_buttons() {
  await BrowserTestUtils.withNewTab("about:blank", async () => {
    await floatIt();
    ok(!copiesShow(), "the empty field shows no copy buttons");
    await closeIt();
  });
});
