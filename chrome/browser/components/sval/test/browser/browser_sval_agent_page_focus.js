/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_take_control_helpers.js */

/**
 * The tab the agent works in is, to its page, the focused tab of a focused
 * window, and the tab it leaves is a backgrounded one (agent-control spec
 * §4.1). Neither moves the user's focus, in the agent's window or in their
 * own, and the page hears the same whichever window the user is in.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_take_control_helpers.js",
  this
);

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

const FOCUS_PAGE = ROOT + "sval_agent_focus.html";

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * @param {object} browser
 * @returns {Promise<object>} What the page has heard, and what it reads of
 *   its own focus now.
 */
function pageFocus(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    const focused = doc.querySelector(":focus");
    return {
      heard: content.wrappedJSObject.heard.slice(),
      hasFocus: doc.hasFocus(),
      visibility: doc.visibilityState,
      active: doc.activeElement?.id || null,
      focused: focused?.id || null,
      focusVisible: doc.querySelector(":focus-visible")?.id || null,
      within: doc.querySelector("form").matches(":focus-within"),
      error: !doc.getElementById("name-error").hidden,
    };
  });
}

/**
 * @param {string[]} heard
 * @returns {string[]} The focus events of `heard`.
 */
function focusOnly(heard) {
  return heard.filter(e => !e.startsWith("visibilitychange"));
}

/**
 * Waits until `browser`'s page has heard `count` events in all, and gives
 * what it has heard since `from`.
 *
 * @param {object} browser
 * @param {number} from
 * @param {number} count
 * @param {string} what
 * @returns {Promise<object>}
 */
async function heardUntil(browser, from, count, what) {
  let state;
  await untilPage(
    browser,
    s => (state = s).heard.length >= count,
    `${what}, from event ${from}`
  );
  return { ...state, heard: state.heard.slice(from) };
}

/**
 * Waits until what `browser`'s page reads of its focus meets `test`, and
 * says what it read last when it never does.
 *
 * @param {object} browser
 * @param {Function} test
 * @param {string} what
 * @returns {Promise<object>} What the page read.
 */
async function untilPage(browser, test, what) {
  let state;
  try {
    await TestUtils.waitForCondition(async () => {
      state = await pageFocus(browser);
      return test(state);
    }, what);
  } catch (err) {
    info(`${what}: the page read ${JSON.stringify(state)}`);
    throw err;
  }
  return state;
}

/**
 * The user's focus, wherever it is: the window the system has active and
 * what holds the keyboard in it.
 *
 * @returns {{win: Window, element: Element}}
 */
function usersFocus() {
  const win = Services.focus.activeWindow;
  return { win, element: win.document.activeElement };
}

/**
 * The agent opens the form, leaves its first field empty for the second,
 * types there, opens another tab and acts in it, then comes back to the
 * form.
 *
 * @param {object} setup
 * @param {Window} userWin The window the user is in throughout.
 */
async function worksThroughTwoTabs(setup, userWin) {
  const { call, tabs, agent, win } = setup;
  const before = usersFocus();
  Assert.equal(before.win, userWin, "the user is where the test put them");
  const moves = [];
  // A tab switch blurs and refocuses what has focus in the window's chrome
  // (`Tabbrowser._adjustFocusBeforeTabSwitch`, then the overlay's card
  // taking it back): focus never goes anywhere else.
  const record = event => {
    if (event.target !== before.element) {
      moves.push(`${event.type} ${event.target.localName}`);
    }
  };
  for (const w of new Set([win, userWin])) {
    w.addEventListener("focus", record, true);
    w.addEventListener("blur", record, true);
    atTaskEnd(() => {
      w.removeEventListener("focus", record, true);
      w.removeEventListener("blur", record, true);
    });
  }

  const { tab } = await call("open_tab", { url: FOCUS_PAGE });
  const { browser } = await tabs.tabIn(agent, tab);
  let state = await pageFocus(browser);
  Assert.ok(state.hasFocus, "the agent's new tab has focus");
  Assert.equal(state.visibility, "visible", "and is visible");

  const name = await refFor(call, tab, /textbox "Name" \[(e\d+)\]/);
  const email = await refFor(call, tab, /textbox "Email" \[(e\d+)\]/);
  let seen = state.heard.length;
  await call("click_element", { tab, ref: name });
  state = await heardUntil(browser, seen, seen + 2, "the click's focus");
  Assert.deepEqual(state.heard, ["focus name", "focusin name"]);
  Assert.equal(state.focused, "name", "the field matches :focus");
  Assert.equal(state.focusVisible, "name", "and :focus-visible, as a field");
  Assert.ok(state.within, "the form matches :focus-within");
  Assert.ok(state.hasFocus, "the page still has focus");

  seen += 2;
  await call("type_text", { tab, ref: email, text: "a@example.com" });
  state = await heardUntil(browser, seen, seen + 4, "the move to Email");
  Assert.deepEqual(state.heard, [
    "blur name",
    "focusout name",
    "focus email",
    "focusin email",
  ]);
  Assert.ok(state.error, "the empty field's blur validation ran");
  Assert.equal(state.focused, "email");
  seen += 4;

  const { tab: other } = await call("open_tab", { url: FOCUS_PAGE });
  const { browser: otherBrowser } = await tabs.tabIn(agent, other);
  state = await heardUntil(browser, seen, seen + 5, "the form's tab leaving");
  Assert.deepEqual(
    focusOnly(state.heard),
    ["blur email", "focusout email", "blur document", "blur window"],
    "the tab the agent left hears blur, as a backgrounded tab does"
  );
  Assert.ok(state.heard.includes("visibilitychange hidden"), "and goes hidden");
  Assert.ok(!state.hasFocus, "and has no focus");
  Assert.equal(state.focused, null, "nothing in it matches :focus");
  Assert.equal(state.active, "email", "its focused field is remembered");
  seen += state.heard.length;

  const otherName = await refFor(call, other, /textbox "Name" \[(e\d+)\]/);
  await call("click_element", { tab: other, ref: otherName });
  const otherState = await pageFocus(otherBrowser);
  Assert.ok(otherState.hasFocus, "the second tab has focus");
  Assert.equal(otherState.focused, "name");

  // Acting in the form again brings its tab back.
  await call("type_text", { tab, ref: email, text: "b@example.com" });
  Assert.equal(
    win.gBrowser.selectedBrowser,
    browser,
    "acting in a tab selects it"
  );
  state = await heardUntil(
    browser,
    seen,
    seen + 5,
    "the form's tab coming back"
  );
  Assert.deepEqual(
    focusOnly(state.heard),
    ["focus document", "focus window", "focus email", "focusin email"],
    "the tab the agent comes back to hears focus"
  );
  Assert.ok(state.hasFocus);
  Assert.equal(state.visibility, "visible");
  const left = await pageFocus(otherBrowser);
  Assert.ok(!left.hasFocus, "the second tab has lost focus");

  // The switch's blur leaves the window's chrome with nothing focused until
  // the card takes the focus back on `TabSwitchDone`, which can come after
  // the page has heard its focus.
  await switchDone(win);
  Assert.deepEqual(moves, [], "no focus moved in the user's windows");
  const after = usersFocus();
  Assert.equal(after.win, before.win, "the user's window kept focus");
  Assert.equal(after.element, before.element, "and so did their element");
}

add_task(async function the_agents_tab_has_focus_while_the_user_watches() {
  const setup = await agentSetup({ sites: { "example.com": "full" } });
  // The agent's window opens with its first tab.
  await setup.call("open_tab", { url: FOCUS_PAGE });
  await within(
    SimpleTest.promiseFocus(setup.win),
    10_000,
    "the window's focus"
  );
  await worksThroughTwoTabs(setup, setup.win);
});

add_task(async function the_agents_tab_has_focus_while_the_user_is_elsewhere() {
  const setup = await agentSetup({ sites: { "example.com": "full" } });
  await setup.call("open_tab", { url: FOCUS_PAGE });
  await within(SimpleTest.promiseFocus(window), 10_000, "the window's focus");
  await worksThroughTwoTabs(setup, window);
});

/**
 * Take control hands the page to the user's own focus, and Give back hands
 * the agent's emulated focus back to it.
 */
add_task(async function control_changing_hands_moves_the_pages_focus() {
  const setup = await agentSetup({ sites: { "example.com": "full" } });
  const { call, tabs, agent, win } = setup;
  const { tab } = await call("open_tab", { url: FOCUS_PAGE });
  const { browser } = await tabs.tabIn(agent, tab);
  await within(SimpleTest.promiseFocus(win), 10_000, "the window's focus");
  const name = await refFor(call, tab, /textbox "Name" \[(e\d+)\]/);
  await call("click_element", { tab, ref: name });
  let state = await pageFocus(browser);
  Assert.equal(state.focused, "name", "the agent's click focused the field");

  await takeControlOf(win, browser);
  Assert.ok(
    !browser.browsingContext.svalFocusEmulated,
    "the user's tab has only the focus the user gives it"
  );

  await giveBackFrom(win, browser);
  Assert.ok(browser.browsingContext.svalFocusEmulated, "the agent's has more");
  await untilPage(
    browser,
    s => s.hasFocus && s.focused === "name",
    "the page has focus again once the agent has it back"
  );
  Assert.notEqual(
    win.document.activeElement,
    browser,
    "while the keyboard stays in the window's chrome"
  );
});

/**
 * While the user holds the workspace, an agent's call on another of its
 * tabs is refused, and the tab the user is looking at stays shown.
 */
add_task(async function a_refused_call_leaves_the_users_tab_shown() {
  const setup = await agentSetup({ sites: { "example.com": "full" } });
  const { call, tabs, agent, win } = setup;
  const { tab: first } = await call("open_tab", { url: FOCUS_PAGE });
  const { tab: second } = await call("open_tab", { url: FOCUS_PAGE });
  const shown = await tabs.tabIn(agent, first);
  const other = await tabs.tabIn(agent, second);
  await showTab(win, shown.tab);
  await within(SimpleTest.promiseFocus(win), 10_000, "the window's focus");
  const ref = await refFor(call, second, /textbox "Name" \[(e\d+)\]/);
  await takeControlOf(win, shown.browser);
  for (const [name, args] of [
    ["click_element", { tab: second, ref }],
    ["type_text", { tab: second, ref, text: "x" }],
    ["navigate_tab", { tab: second, to: FOCUS_PAGE }],
  ]) {
    await Assert.rejects(
      call(name, args),
      e => e.code === "user_in_control",
      `${name} fails with user_in_control`
    );
    Assert.equal(
      win.gBrowser.selectedTab,
      shown.tab,
      `${name} leaves the user's tab shown`
    );
  }
  Assert.ok(
    !(await pageFocus(other.browser)).hasFocus,
    "and the agent's other tab has no focus"
  );
  await giveBackFrom(win, shown.browser);
});

/**
 * A tab the user carries out of the agent's window is theirs, and its page
 * has only the focus the user gives it.
 */
add_task(
  async function a_tab_taken_to_the_users_window_loses_the_agents_focus() {
    const setup = await agentSetup({ sites: { "example.com": "full" } });
    const { call, tabs, agent, win } = setup;
    await call("open_tab", { url: FOCUS_PAGE });
    const { tab } = await call("open_tab", { url: FOCUS_PAGE });
    const found = await tabs.tabIn(agent, tab);
    await within(SimpleTest.promiseFocus(window), 10_000, "the window's focus");
    Assert.ok(
      (await pageFocus(found.browser)).hasFocus,
      "the agent's tab has focus in its window"
    );

    const taken = gBrowser.adoptTab(found.tab, { selectTab: false });
    atTaskEnd(async () => {
      if (taken.isConnected && !taken.closing) {
        await BrowserTestUtils.removeTab(taken);
      }
    });
    await untilPage(
      taken.linkedBrowser,
      s => !s.hasFocus,
      "the taken tab's page loses focus"
    );
    Assert.ok(
      !taken.linkedBrowser.browsingContext.svalFocusEmulated,
      "its focus is no longer emulated"
    );
    Assert.ok(
      (await pageFocus(win.gBrowser.selectedBrowser)).hasFocus,
      "and the agent's tab selected in its place has it"
    );
  }
);

/**
 * Records every failed assertion of `win`'s tab switcher until the task
 * ends. A release build only dumps one (`AsyncTabSwitcher.assert`), and a
 * debug build throws in the middle of a tab switch.
 *
 * @param {Window} win
 * @returns {string[]} The failures, each with its stack.
 */
function switcherFailures(win) {
  const proto = win.gBrowser.AsyncTabSwitcher.prototype;
  const assert = proto.assert;
  const failures = [];
  proto.assert = function (cond) {
    if (!cond) {
      failures.push(`Assertion failure\n${Error().stack}`);
    }
    return assert.call(this, cond);
  };
  atTaskEnd(() => {
    proto.assert = assert;
  });
  return failures;
}

/**
 * A minimised or covered agent window hides none of the agent's work: the
 * tab it works in stays visible and focused, and the one it leaves goes
 * hidden as in a window on screen, through tabbrowser's own tab switches.
 * The window is minimised in the middle of one, and switched again while
 * minimised.
 */
add_task(async function a_hidden_agents_window_keeps_its_page_visible() {
  const setup = await agentSetup({ sites: { "example.com": "full" } });
  const { call, tabs, agent, win } = setup;
  const failures = switcherFailures(win);
  const { tab } = await call("open_tab", { url: FOCUS_PAGE });
  const { browser } = await tabs.tabIn(agent, tab);
  const { tab: other } = await call("open_tab", { url: FOCUS_PAGE });
  const { browser: otherBrowser } = await tabs.tabIn(agent, other);
  await untilPage(
    browser,
    s => s.visibility === "hidden",
    "the first tab is in the background"
  );
  await within(SimpleTest.promiseFocus(window), 10_000, "the window's focus");

  const minimized = BrowserTestUtils.waitForEvent(win, "sizemodechange");
  win.gBrowser.tabContainer.addEventListener(
    "TabSelect",
    () => win.minimize(),
    {
      once: true,
    }
  );
  atTaskEnd(() => win.restore());
  const email = await refFor(call, tab, /textbox "Email" \[(e\d+)\]/);
  await call("type_text", { tab, ref: email, text: "a@example.com" });
  await within(minimized, 10_000, "the agent's window minimising");
  Assert.equal(win.windowState, win.STATE_MINIMIZED, "the window is minimised");
  Assert.equal(win.gBrowser.selectedBrowser, browser, "the tab is selected");
  await untilPage(
    browser,
    s => s.visibility === "visible" && s.hasFocus,
    "the tab the agent switched to is visible and focused"
  );
  await untilPage(
    otherBrowser,
    s => s.visibility === "hidden" && !s.hasFocus,
    "the tab it left goes hidden and unfocused"
  );

  const otherEmail = await refFor(call, other, /textbox "Email" \[(e\d+)\]/);
  await call("type_text", {
    tab: other,
    ref: otherEmail,
    text: "b@example.com",
  });
  Assert.equal(
    win.gBrowser.selectedBrowser,
    otherBrowser,
    "hidden, it switches"
  );
  await untilPage(
    otherBrowser,
    s => s.visibility === "visible" && s.hasFocus,
    "the tab the agent came back to is visible and focused"
  );
  await untilPage(
    browser,
    s => s.visibility === "hidden" && !s.hasFocus,
    "the tab it left goes hidden and unfocused"
  );
  await switchDone(win);
  Assert.deepEqual(failures, [], "the tab switcher's bookkeeping held");
});

/**
 * A minimised or covered agent window goes on rendering the agent's page, so
 * a scroll reaches the page's listeners at its next refresh tick, and
 * `scroll_page`, which waits for the page to see its scroll, answers.
 */
add_task(async function a_minimised_agents_window_goes_on_rendering() {
  const { call, tabs, agent, win } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: FOCUS_PAGE });
  const { browser } = await tabs.tabIn(agent, tab);
  await SpecialPowers.spawn(browser, [], () => {
    const tall = content.document.createElement("div");
    tall.style.height = "5000px";
    content.document.body.append(tall);
    content.wrappedJSObject.scrolls = 0;
    content.addEventListener("scroll", () => content.wrappedJSObject.scrolls++);
  });
  const minimized = BrowserTestUtils.waitForEvent(win, "sizemodechange");
  win.minimize();
  atTaskEnd(() => win.restore());
  await within(minimized, 10_000, "the agent's window minimising");
  Assert.equal(win.windowState, win.STATE_MINIMIZED, "the window is minimised");

  await within(
    call("scroll_page", { tab, direction: "down" }),
    10_000,
    "scroll_page in a minimised window"
  );
  const seen = await SpecialPowers.spawn(browser, [], () => ({
    scrollY: content.scrollY,
    scrolls: content.wrappedJSObject.scrolls,
  }));
  Assert.greater(seen.scrollY, 0, "the page scrolled");
  Assert.equal(seen.scrolls, 1, "and its listener heard it");
});
