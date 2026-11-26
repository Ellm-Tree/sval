/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A window in full screen keeps Sval's layout: the header across the top,
 * the Workspace panel and the page below it, none over another. On macOS the
 * menu bar slides over the window's top edge, and the header, the panel and
 * the page all move down by its height together. Leaving full screen puts
 * the layout back as it was. F11, and Control-Command-F on macOS, enter and
 * leave full screen, and so do the Launcher's commands.
 */

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);
const { keyOf, shortcutText } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalKeys.sys.mjs"
);

/** The menu bar's height, as Cocoa reports it while the bar is fully in. */
const MENU_BAR = 24;

function layout() {
  const rect = el => el.getBoundingClientRect();
  return {
    header: rect(gNavToolbox),
    panel: rect(document.getElementById("sval-panel-container")),
    page: rect(gBrowser.selectedBrowser),
  };
}

function assertStacked(where) {
  const { header, panel, page } = layout();
  for (const [name, r] of Object.entries({ header, panel, page })) {
    Assert.greater(r.width, 0, `${where}: the ${name} has width`);
    Assert.greater(r.height, 0, `${where}: the ${name} has height`);
  }
  Assert.lessOrEqual(
    header.bottom,
    panel.top + 0.5,
    `${where}: the panel starts below the header`
  );
  Assert.lessOrEqual(
    header.bottom,
    page.top + 0.5,
    `${where}: the page starts below the header`
  );
}

function assertSameRect(actual, expected, what) {
  for (const side of ["top", "left", "width", "height"]) {
    Assert.less(
      Math.abs(actual[side] - expected[side]),
      1,
      `${what}: ${side} is ${expected[side]}`
    );
  }
}

/**
 * @param {boolean} on Whether the window ends in full screen.
 * @param {Function} [act] What the user does to get there.
 */
async function setFullScreen(on, act = () => (window.fullScreen = on)) {
  const toggled = BrowserTestUtils.waitForEvent(window, "fullscreen");
  act();
  await within(
    toggled,
    10_000,
    `the window ${on ? "enters" : "leaves"} full screen`
  );
  await waitForCondition(
    () =>
      document.documentElement.hasAttribute("inFullscreen") == on &&
      (!on ||
        (window.outerWidth == screen.width &&
          window.outerHeight == screen.height)),
    `the window is laid out ${on ? "in" : "out of"} full screen`
  );
}

/**
 * Sends the shift Gecko's Cocoa widget sends as the menu bar moves.
 *
 * @param {number} overlap How far, in pixels, the menu bar covers the window.
 */
function menuBarIn(overlap) {
  window.dispatchEvent(
    new CustomEvent("MacFullscreenMenubarRevealUpdate", { detail: overlap })
  );
}

add_setup(function () {
  registerCleanupFunction(async () => {
    await within(
      UrlbarTestUtils.promisePopupClose(window),
      10_000,
      "the address bar closes"
    );
    gURLBar.handleRevert();
    if (window.fullScreen) {
      menuBarIn(0);
      await setFullScreen(false);
    }
  });
});

add_task(async function test_full_screen_keeps_the_layout() {
  // The menu bar shift happens on macOS alone, where the header stays in full
  // screen by default. Elsewhere FullScreen.hideNavToolbox slides the header
  // away with a transition, which these measurements would catch midway.
  await SpecialPowers.pushPrefEnv({
    set: [["browser.fullscreen.autohide", false]],
  });
  assertStacked("before full screen");
  const before = layout();
  const size = { width: window.outerWidth, height: window.outerHeight };

  await setFullScreen(true);
  assertStacked("in full screen");
  const inFull = layout();

  menuBarIn(MENU_BAR);
  assertStacked("with the menu bar in");
  const shifted = layout();
  for (const name of ["header", "panel", "page"]) {
    Assert.less(
      Math.abs(shifted[name].top - inFull[name].top - MENU_BAR),
      1,
      `the ${name} moves down by the menu bar's height`
    );
  }

  menuBarIn(0);
  const back = layout();
  for (const name of ["header", "panel", "page"]) {
    assertSameRect(
      back[name],
      inFull[name],
      `the ${name} once the menu bar goes`
    );
  }

  await setFullScreen(false);
  await waitForCondition(
    () => window.outerWidth == size.width && window.outerHeight == size.height,
    "the window is its old size"
  );
  const after = layout();
  for (const name of ["header", "panel", "page"]) {
    assertSameRect(after[name], before[name], `the ${name} after full screen`);
  }
});

add_task(async function test_full_screen_keys() {
  const keys = [
    { name: "F11", press: () => EventUtils.synthesizeKey("KEY_F11") },
  ];
  if (AppConstants.platform == "macosx") {
    keys.push({
      name: "Control-Command-F",
      press: () =>
        EventUtils.synthesizeKey("f", { ctrlKey: true, metaKey: true }),
    });
  }
  for (const { name, press } of keys) {
    await setFullScreen(true, press);
    Assert.ok(window.fullScreen, `${name} enters full screen`);
    assertStacked(`in full screen from ${name}`);
    await setFullScreen(false, press);
    Assert.ok(!window.fullScreen, `${name} leaves full screen`);
    assertStacked(`out of full screen from ${name}`);
  }
});

/**
 * The Launcher lists Enter full screen out of full screen and Exit full
 * screen in it, each with its icon and the key that does the same on this
 * platform, and Enter on the row does it.
 */
add_task(async function test_launcher_full_screen_commands() {
  const key = shortcutText(
    keyOf(document.getElementById("key_enterFullScreen"))
  );
  Assert.equal(
    key,
    AppConstants.platform == "macosx"
      ? shortcutText({ modifiers: "accel,control", key: "F" })
      : shortcutText({ keycode: "VK_F11" }),
    "the key is this platform's full screen key"
  );
  const steps = [
    {
      id: "enter-full-screen",
      icon: "full-screen",
      hidden: "exit-full-screen",
      on: true,
    },
    {
      id: "exit-full-screen",
      icon: "exit-full-screen",
      hidden: "enter-full-screen",
      on: false,
    },
  ];
  for (const { id, icon, hidden, on } of steps) {
    await within(
      UrlbarTestUtils.promiseAutocompleteResultPopup({
        window,
        value: "full screen",
      }),
      10_000,
      "the address bar's results"
    );
    const rows = [];
    for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
      rows.push({
        ...(await UrlbarTestUtils.getDetailsOfResultAt(window, i)),
        i,
      });
    }
    const row = rows.find(r => r.result.payload.commandId === id);
    Assert.ok(row, `${id} is listed`);
    Assert.ok(
      !rows.some(r => r.result.payload.commandId === hidden),
      `${hidden} is not listed`
    );
    Assert.equal(row.result.payload.icon, icon, `${id} has its icon`);
    Assert.equal(row.result.payload.shortcut, key, `${id} shows the key`);

    await setFullScreen(on, () => {
      for (
        let left = UrlbarTestUtils.getResultCount(window);
        left && UrlbarTestUtils.getSelectedRowIndex(window) !== row.i;
        left--
      ) {
        EventUtils.synthesizeKey("KEY_ArrowDown");
      }
      EventUtils.synthesizeKey("KEY_Enter");
    });
    Assert.equal(window.fullScreen, on, `${id} from the Launcher works`);
    assertStacked(`after ${id} from the Launcher`);
  }
});

/**
 * Presses Escape in the page, which has the focus as a person's click gives it.
 *
 * @param {Element} tab
 */
async function escapeInPage(tab) {
  tab.linkedBrowser.focus();
  await within(
    SpecialPowers.spawn(tab.linkedBrowser, [], () => content.focus()),
    10_000,
    "the page takes the focus"
  );
  EventUtils.synthesizeKey("KEY_Escape");
}

/**
 * Escape leaves full screen from a page that leaves the key alone, on every
 * platform.
 */
add_task(async function test_escape_leaves_full_screen() {
  if (AppConstants.platform == "macosx") {
    Assert.ok(
      !Services.prefs.getBoolPref("browser.fullscreen.exit_on_escape"),
      "Gecko's own macOS Escape handling is off"
    );
  }
  const tab = await openPage(PAGE);
  await setFullScreen(true);
  await setFullScreen(false, () => escapeInPage(tab));
  Assert.ok(!window.fullScreen, "Escape leaves full screen");
  assertStacked("after Escape");
  BrowserTestUtils.removeTab(tab);
});

/**
 * A page that answers Escape keeps it, and the window stays in full screen.
 */
add_task(async function test_a_page_that_answers_escape_keeps_it() {
  const tab = await openPage(PAGE);
  await within(
    SpecialPowers.spawn(tab.linkedBrowser, [], () => {
      content.wrappedJSObject.escapes = 0;
      content.addEventListener("keydown", e => {
        if (e.key === "Escape") {
          e.preventDefault();
          content.wrappedJSObject.escapes++;
        }
      });
    }),
    10_000,
    "the page listens for Escape"
  );
  await setFullScreen(true);
  await escapeInPage(tab);
  await waitForCondition(
    () =>
      SpecialPowers.spawn(
        tab.linkedBrowser,
        [],
        () => content.wrappedJSObject.escapes
      ).then(n => n === 1),
    "the page has Escape"
  );
  // The page's answer reached the parent before the reply event the
  // handler waits for, so a full screen change would have begun by now.
  await within(
    SpecialPowers.spawn(tab.linkedBrowser, [], () => {}),
    10_000,
    "a round trip to the page"
  );
  Assert.ok(window.fullScreen, "the window stays in full screen");
  await setFullScreen(false);
  BrowserTestUtils.removeTab(tab);
});

/**
 * Escape while the page loads stops the load and leaves full screen alone.
 */
add_task(async function test_escape_stops_a_load_first() {
  const tab = await openPage(PAGE);
  await setFullScreen(true);
  const key = crypto.randomUUID();
  atTaskEnd(() => fetch(`${ROOT}sval_agent_slow.sjs?release=${key}`));
  const stop = document.getElementById("Browser:Stop");
  BrowserTestUtils.startLoadingURIString(
    tab.linkedBrowser,
    `${ROOT}sval_agent_slow.sjs?hold=${key}`
  );
  await waitForCondition(
    () => !stop.hasAttribute("disabled"),
    "the page is loading"
  );
  tab.linkedBrowser.focus();
  EventUtils.synthesizeKey("KEY_Escape");
  await waitForCondition(
    () => stop.hasAttribute("disabled"),
    "Escape stops the load"
  );
  Assert.ok(window.fullScreen, "the window stays in full screen");
  await setFullScreen(false);
  BrowserTestUtils.removeTab(tab);
});

/**
 * Escape in the open address bar closes its list and leaves full screen
 * alone.
 */
add_task(async function test_escape_closes_the_address_bar_first() {
  await setFullScreen(true);
  await within(
    UrlbarTestUtils.promiseAutocompleteResultPopup({
      window,
      value: "full screen",
    }),
    10_000,
    "the address bar's results"
  );
  const closed = UrlbarTestUtils.promisePopupClose(window, () =>
    EventUtils.synthesizeKey("KEY_Escape")
  );
  await within(closed, 10_000, "Escape closes the address bar's list");
  Assert.ok(window.fullScreen, "the window stays in full screen");
  gURLBar.handleRevert();
  await setFullScreen(false);
});
