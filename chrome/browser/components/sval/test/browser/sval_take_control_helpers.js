/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * What the take-control test files share: an agent's tab on the input page
 * under the overlay, and the user's input as a person's reaches the window.
 * Each file loads this with `loadSubScript` into its own scope.
 */

/* exported INPUT, isUserInControl, USER_IN_CONTROL_MESSAGE, layerSetup,
            partsOf, pageState, settle, inputReaches, inputBlocked,
            takeControlOf, giveBackFrom, pressTakeControl, showTab,
            ORG_PAGE, pageActor, noLoadStarts */

const { isUserInControl, USER_IN_CONTROL_MESSAGE } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs"
);

const INPUT = ROOT + "sval_agent_input.html";

/**
 * Selects `tab` in `win`, and waits for the switch to be done and the tab's
 * page to be on screen, so what covers it can be pressed.
 *
 * @param {Window} win
 * @param {object} tab
 */
async function showTab(win, tab) {
  await selectTab(tab);
  await TestUtils.waitForCondition(
    () => tab.linkedBrowser.getBoundingClientRect().width > 0,
    "the tab is on screen"
  );
}

/**
 * An agent's tab on the input page, selected in the agent's window, with
 * that window focused.
 *
 * @param {object} [options] For `agentSetup`.
 * @returns {Promise<object>}
 */
async function layerSetup(options = {}) {
  const setup = await agentSetup({
    sites: { "example.com": "full" },
    ...options,
  });
  const { tab } = await setup.call("open_tab", { url: INPUT });
  const found = await setup.tabs.tabIn(setup.agent, tab);
  await showTab(setup.win, found.tab);
  await within(
    SimpleTest.promiseFocus(setup.win),
    10_000,
    "the window's focus"
  );
  return { ...setup, tab, tabEl: found.tab, browser: found.browser };
}

/**
 * @param {object} browser
 * @returns {{overlay: Element|null, card: Element|null, bar: Element|null}}
 *   The overlay over `browser`'s window, the card on it with Take control,
 *   and the bar with Give back above `browser`.
 */
function partsOf(browser) {
  const overlay = browser.ownerDocument.querySelector(".sval-agent-overlay");
  return {
    overlay,
    card: overlay?.querySelector(".sval-agent-card") ?? null,
    bar: browser.parentNode.parentNode.querySelector(
      ":scope > .sval-agent-bar"
    ),
  };
}

/**
 * @param {object} browser
 * @returns {Promise<{seen: string[], value: string, scrollY: number,
 *   title: string}>} What the page has heard.
 */
function pageState(browser) {
  return SpecialPowers.spawn(browser, [], () => ({
    seen: content.wrappedJSObject.seen.slice(),
    value: content.document.getElementById("field").value,
    scrollY: content.scrollY,
    title: content.document.title,
  }));
}

/**
 * Waits for what the parent sent the page, and what the page sent back, to
 * have been handled.
 *
 * The parent hands input and loads to the page over the same channel this
 * round trip takes, so they reach the page first, and the page answers only
 * once it has nothing left to run. What the page asked of the parent in
 * handling them, such as a picker or a select's popup, is on that channel
 * ahead of the answer, and the parent waits until it has nothing left to
 * run either.
 *
 * @param {object} browser
 */
async function settle(browser) {
  await within(
    SpecialPowers.spawn(
      browser,
      [],
      () => new Promise(resolve => ChromeUtils.idleDispatch(() => resolve()))
    ),
    10_000,
    "the page going idle"
  );
  await within(
    new Promise(resolve => ChromeUtils.idleDispatch(() => resolve())),
    10_000,
    "the parent going idle"
  );
}

/**
 * Runs `action`, which the layer over `browser` must refuse to turn into a
 * load, and fails if a load of the tab's page starts or goes on.
 *
 * A refused load leaves nothing to wait for: the page stays as it was, and
 * a load still waiting on the network leaves both processes idle, so
 * `settle` alone can return before a load that did get through commits.
 * So the tab's own web progress is watched from before the action. A load
 * starts in the parent within a turn of what asked for it, and its
 * `STATE_START` arrives by the time `settle` is done. A load that was
 * already under way, held for its site alert, starts nothing new, so the
 * tab must also be done loading: one that went on then commits, and the
 * caller's check of the address sees it. Only the top level's
 * notifications count, since the tab's web progress passes on its frames'.
 *
 * @param {object} browser
 * @param {Function} action
 * @param {string} why What the action is, as the failure names it.
 */
async function noLoadStarts(browser, action, why) {
  const { webProgress } = browser;
  const { STATE_START, STATE_IS_DOCUMENT } = Ci.nsIWebProgressListener;
  let started = 0;
  const listener = {
    onStateChange(progress, request, flags) {
      if (
        progress.isTopLevel &&
        flags & STATE_START &&
        flags & STATE_IS_DOCUMENT
      ) {
        started++;
      }
    },
    QueryInterface: ChromeUtils.generateQI([
      "nsIWebProgressListener",
      "nsISupportsWeakReference",
    ]),
  };
  webProgress.addProgressListener(
    listener,
    Ci.nsIWebProgress.NOTIFY_STATE_DOCUMENT
  );
  try {
    await action();
    await settle(browser);
  } finally {
    webProgress.removeProgressListener(listener);
  }
  Assert.equal(started, 0, `no load starts after ${why}`);
  await TestUtils.waitForCondition(
    () => !webProgress.isLoadingDocument,
    `no load is under way after ${why}`
  );
}

/**
 * How far the user's wheel scrolls the page, in CSS pixels. One wheel event
 * scrolls at most a page (`mousewheel.allow_scrolling_more_than_one_page`),
 * so this stays well under the shortest window a runner gives the page.
 */
const WHEEL_PX = 200;

/**
 * The user's mouse, wheel and keyboard, as a person's reach the window: the
 * user clicks the middle of the page and scrolls over it, the page tries to
 * take focus for its field, as a page may, and the user types.
 *
 * The page has handled the click before it focuses its field. The click
 * lands on the page's body, which clears the page's focus
 * (`EventStateManager::PostHandleEvent`), and the content process may run
 * input after a message sent later (`InputTaskManager` lowers input below
 * normal tasks while a refresh tick is due), so a click still queued there
 * would take the focus back off the field before the user types.
 *
 * @param {Window} win
 * @param {object} browser
 */
async function userInput(win, browser) {
  // The click lands on the page, or under the overlay on the overlay, and
  // neither is a control: the chrome's checker sees the <browser> or the
  // overlay. It lands near the page's corner, where the wheel goes, because
  // the card's controls sit at the page's centre at some window sizes.
  AccessibilityUtils.setEnv({ mustHaveAccessibleRule: false });
  await EventUtils.synthesizeMouse(browser, 50, 50, {}, win);
  AccessibilityUtils.resetEnv();
  EventUtils.synthesizeWheel(
    browser,
    50,
    50,
    { deltaY: WHEEL_PX, deltaMode: WheelEvent.DOM_DELTA_PIXEL },
    win
  );
  await settle(browser);
  await SpecialPowers.spawn(browser, [], () => {
    content.focus();
    content.document.getElementById("field").focus();
  });
  browser.focus();
  EventUtils.sendString("abc", win);
  EventUtils.synthesizeKey("KEY_PageDown", {}, win);
  await settle(browser);
}

/**
 * Asserts the user's input reached the page.
 *
 * @param {Window} win
 * @param {object} browser
 * @param {string} why
 */
async function inputReaches(win, browser, why) {
  const { scrollY } = await pageState(browser);
  await userInput(win, browser);
  // A wheel scrolls smoothly, and goes on after `settle`, so the wait is for
  // where it ends: a later `inputBlocked` reads the position the user left.
  await TestUtils.waitForCondition(async () => {
    const state = await pageState(browser);
    return (
      ["mousedown", "click", "wheel", "keydown"].every(t =>
        state.seen.includes(t)
      ) && state.scrollY >= scrollY + WHEEL_PX - 1
    );
  }, `the page hears the user's pointer, wheel and keys, and scrolls, ${why}`);
  Assert.equal(
    (await pageState(browser)).value,
    "abc",
    `the user's typing lands in the page ${why}`
  );
}

/**
 * Asserts none of the user's input reached the page.
 *
 * @param {Window} win
 * @param {object} browser
 * @param {string} why
 */
async function inputBlocked(win, browser, why) {
  const before = await pageState(browser);
  await userInput(win, browser);
  const after = await pageState(browser);
  Assert.deepEqual(after.seen, before.seen, `the page heard nothing ${why}`);
  Assert.equal(after.value, before.value, `nothing was typed ${why}`);
  Assert.equal(after.scrollY, before.scrollY, `nothing scrolled ${why}`);
  Assert.notEqual(
    win.document.activeElement,
    browser,
    `the page does not have the keyboard ${why}`
  );
}

/**
 * @param {Window} win
 * @param {object} browser
 */
async function takeControlOf(win, browser) {
  await EventUtils.synthesizeMouseAtCenter(
    partsOf(browser).card.querySelector(".sval-agent-take"),
    {},
    win
  );
  Assert.ok(isUserInControl(browser.browsingContext.browserId));
}

/**
 * @param {Window} win
 * @param {object} browser
 */
async function giveBackFrom(win, browser) {
  await EventUtils.synthesizeMouseAtCenter(
    partsOf(browser).bar.querySelector(".sval-agent-give"),
    {},
    win
  );
  Assert.ok(!isUserInControl(browser.browsingContext.browserId));
}

/**
 * Presses the Take control button over `browser`. A press of the button
 * itself, which works under an alert in the window as well.
 *
 * @param {object} browser
 */
function pressTakeControl(browser) {
  partsOf(browser).card.querySelector(".sval-agent-take").click();
  Assert.ok(isUserInControl(browser.browsingContext.browserId), "taken");
}

const { pageActor } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentPageParent.sys.mjs"
);
