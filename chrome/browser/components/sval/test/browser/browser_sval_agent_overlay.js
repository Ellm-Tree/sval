/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_take_control_helpers.js */

/**
 * The page is the agent's until the user takes it (agent-control spec §6). One
 * overlay covers every agent tab and says what the agent is doing. It keeps the
 * user's input, the window's navigation and the page's popups and dialogs from
 * reaching the page or covering Take control, while the agent's own input goes
 * on beneath it.
 *
 * The user's input here is synthesized in the parent, at the page's place in
 * the window and to whatever has focus there, which is the path a person's
 * mouse and keyboard take. `BrowserTestUtils.synthesizeMouse` would dispatch
 * inside the page instead, beneath the overlay, as the agent's input is.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_take_control_helpers.js",
  this
);

const { activityText } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs"
);
const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
  // Pressing the downloads button records that it was used
  // (`SET_USAGE_PREF_BUTTONS` in BrowserUsageTelemetry.sys.mjs). Undone when
  // the file ends, so no later file starts with it set.
  await SpecialPowers.pushPrefEnv({
    clear: [["browser.engagement.downloads-button.has-used"]],
  });
});

/**
 * The capsule says what the agent is doing in the selected tab, and where;
 * another tab's activity waits until that tab is selected.
 */
add_task(async function the_overlay_says_what_the_agent_is_doing() {
  const { call, win, browser, tab } = await layerSetup();
  const status = () =>
    partsOf(browser).card.querySelector(".sval-agent-status").textContent;
  await call("get_snapshot", { tab });
  const host = browser.currentURI.hostPort;
  Assert.equal(
    status(),
    activityText("get_snapshot", host),
    "a read names the page's site"
  );
  Assert.ok(status().includes(host), "the line names the site");
  await call("scroll_page", { tab, direction: "down" });
  Assert.equal(status(), activityText("scroll_page", host));

  const { tab: other } = await call("open_tab", { url: PAGE });
  Assert.ok(other, "the agent opened another tab");
  await showTab(win, win.gBrowser.getTabForBrowser(browser));
  Assert.equal(
    status(),
    activityText("scroll_page", host),
    "each tab keeps its own line, shown when it is selected"
  );
  Assert.equal(
    partsOf(browser)
      .card.querySelector(".sval-agent-status")
      .getAttribute("aria-live"),
    "polite",
    "and a screen reader hears each line"
  );
});

/**
 * The ring around the robot pulses as the agent acts and comes to rest
 * after, so the window of an agent doing nothing draws nothing new.
 */
add_task(async function the_ring_pulses_only_while_the_agent_acts() {
  await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 0]] });
  const { call, browser, tab } = await layerSetup();
  const avatar = partsOf(browser).card.querySelector(".sval-agent-avatar");
  const ring = () => avatar.getAnimations()[0];

  await call("get_snapshot", { tab });
  Assert.ok(ring(), "the ring pulses as the agent acts");
  Assert.ok(
    Number.isFinite(ring().effect.getComputedTiming().endTime),
    "and the pulse has an end"
  );
  ring().finish();
  Assert.ok(!ring(), "once it ends, the ring is at rest");

  await call("scroll_page", { tab, direction: "down" });
  Assert.ok(ring(), "the next action pulses it again");
  const { endTime } = ring().effect.getComputedTiming();
  await call("get_snapshot", { tab });
  Assert.greater(
    ring().effect.getComputedTiming().endTime,
    endTime,
    "and each action while it pulses carries the pulse on"
  );
  await SpecialPowers.popPrefEnv();
});

/**
 * One overlay covers the whole of an agent's window, panel, toolbar,
 * address bar and page alike, with one card and no bar above the page. Every agent tab is held beneath it, a background one included,
 * and no tab of the user's is.
 */
add_task(async function one_overlay_covers_the_whole_window() {
  const { call, tabs, agent, win, browser } = await layerSetup();
  const { tab: other } = await call("open_tab", { url: PAGE });
  const { browser: second } = await tabs.tabIn(agent, other);
  await showTab(win, win.gBrowser.getTabForBrowser(browser));

  const doc = win.document;
  Assert.equal(
    doc.querySelectorAll(".sval-agent-overlay").length,
    1,
    "one overlay"
  );
  Assert.equal(doc.querySelectorAll(".sval-agent-card").length, 1, "one card");
  Assert.equal(
    doc.querySelectorAll(".sval-agent-take").length,
    1,
    "one Take control"
  );
  const { overlay, card } = partsOf(browser);
  Assert.ok(!overlay.hidden, "the overlay is up");
  Assert.ok(
    card.querySelector(".sval-agent-text").textContent.includes(AGENT_LABEL),
    "the card names the agent"
  );
  Assert.ok(
    card.querySelector("button").classList.contains("sval-agent-take"),
    "with one button, Take control"
  );
  Assert.deepEqual(
    [...overlay.querySelectorAll("button")].map(b => b.className),
    ["sval-agent-take", "sval-agent-stop", "sval-agent-resume"],
    "and Stop, with Resume for its place"
  );
  for (const [which, b] of [
    ["the selected tab", browser],
    ["a background tab", second],
  ]) {
    Assert.ok(partsOf(b).bar?.hidden, `${which} has no bar above it`);
    Assert.ok(b.hasAttribute("sval-agent-layer"), `${which} cannot take focus`);
  }

  // What a press anywhere in the window lands on.
  for (const [what, el] of [
    ["the panel", win.SvalPanel._els.switcher],
    ["the address bar", win.gURLBar.inputField],
    ["the toolbar", doc.getElementById("back-button")],
    ["the page", browser],
  ]) {
    const r = el.getBoundingClientRect();
    Assert.equal(
      doc
        .elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        ?.closest(".sval-agent-overlay"),
      overlay,
      `a press on ${what} lands on the overlay`
    );
  }

  Assert.ok(
    !document.querySelector(".sval-agent-overlay"),
    "the user's window has no overlay"
  );
  for (const userTab of gBrowser.tabs) {
    if (userTab.linkedPanel) {
      Assert.ok(
        !userTab.linkedBrowser.hasAttribute("sval-agent-layer"),
        "and no tab of the user's is held"
      );
    }
  }
});

/**
 * The user's clicks and keys on the panel, the toolbar and the address bar,
 * and the window's shortcuts, do nothing while the overlay is up, and work
 * once the user has taken control.
 */
add_task(async function the_users_input_does_not_reach_the_window() {
  const { win, browser, call, tabs, agent } = await layerSetup();
  const { tab: other } = await call("open_tab", { url: PAGE });
  const { tab: otherEl } = await tabs.tabIn(agent, other);
  await showTab(win, win.gBrowser.getTabForBrowser(browser));
  const doc = win.document;
  // The panel draws its rows afresh, so the row is looked up at each press.
  const row = () => win.SvalPanel._rowElementFor(other);
  await TestUtils.waitForCondition(row, "the other tab's row is drawn");
  const downloadsPanel = doc.getElementById("downloadsPanel");
  let menus = 0;
  const onShown = () => menus++;
  doc.addEventListener("popupshown", onShown, true);
  atTaskEnd(() => doc.removeEventListener("popupshown", onShown, true));

  const tryAll = async () => {
    await EventUtils.synthesizeMouseAtCenter(row(), {}, win);
    await EventUtils.synthesizeMouseAtCenter(
      doc.getElementById("downloads-button"),
      {},
      win
    );
    if (downloadsPanel && downloadsPanel.state !== "closed") {
      downloadsPanel.hidePopup();
    }
    await EventUtils.synthesizeMouseAtCenter(
      doc.getElementById("nav-bar"),
      { type: "contextmenu", button: 2 },
      win
    );
    doc.getElementById("toolbar-context-menu").hidePopup();
    await EventUtils.synthesizeMouseAtCenter(win.gURLBar.inputField, {}, win);
    EventUtils.sendString("abc", win);
  };

  await tryAll();
  Assert.equal(
    win.gBrowser.selectedBrowser,
    browser,
    "a click on another tab's row in the panel does not select it"
  );
  Assert.equal(menus, 0, "no toolbar menu opens");
  Assert.ok(!win.gURLBar.focused, "the address bar does not take the keyboard");
  Assert.ok(!win.gURLBar.value.includes("abc"), "nor typing");
  Assert.equal(
    doc.activeElement,
    partsOf(browser).card,
    "the keyboard stays on the card"
  );
  EventUtils.synthesizeKey("l", { accelKey: true }, win);
  Assert.ok(!win.gURLBar.focused, "the address bar's shortcut does nothing");
  const count = win.gBrowser.tabs.length;
  EventUtils.synthesizeKey("t", { accelKey: true }, win);
  Assert.equal(win.gBrowser.tabs.length, count, "nor does the new-tab key");
  EventUtils.synthesizeKey("KEY_Tab", {}, win);
  Assert.equal(
    doc.activeElement,
    partsOf(browser).card.querySelector(".sval-agent-take"),
    "Tab reaches Take control"
  );
  EventUtils.synthesizeKey("KEY_Tab", {}, win);
  Assert.equal(
    doc.activeElement,
    partsOf(browser).card.querySelector(".sval-agent-stop"),
    "then Stop"
  );
  EventUtils.synthesizeKey("KEY_Tab", {}, win);
  Assert.equal(
    doc.activeElement,
    partsOf(browser).card.querySelector(".sval-agent-polite input"),
    "then the paired agent's Be polite tick"
  );
  EventUtils.synthesizeKey("KEY_Tab", {}, win);
  Assert.equal(
    doc.activeElement,
    partsOf(browser).card,
    "and goes no further than the card"
  );

  await takeControlOf(win, browser);
  Assert.ok(partsOf(browser).overlay.hidden, "the overlay goes");
  Assert.ok(!partsOf(browser).bar.hidden, "and the bar comes");
  EventUtils.synthesizeKey("l", { accelKey: true }, win);
  await TestUtils.waitForCondition(
    () => win.gURLBar.focused,
    "the address bar's shortcut works"
  );
  win.gURLBar.blur();
  await EventUtils.synthesizeMouseAtCenter(win.gURLBar.inputField, {}, win);
  Assert.ok(win.gURLBar.focused, "a click puts the keyboard in it");
  EventUtils.sendString("abc", win);
  Assert.ok(win.gURLBar.value.includes("abc"), "and the user types there");
  EventUtils.synthesizeKey("KEY_Escape", {}, win);
  EventUtils.synthesizeKey("KEY_Escape", {}, win);
  const shown = BrowserTestUtils.waitForEvent(
    doc,
    "popupshown",
    true,
    e => e.target.id === "downloadsPanel"
  );
  await EventUtils.synthesizeMouseAtCenter(
    doc.getElementById("downloads-button"),
    {},
    win
  );
  await within(shown, 10_000, "the popupshown event");
  const panel = doc.getElementById("downloadsPanel");
  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  panel.hidePopup();
  await within(hidden, 10_000, "the popuphidden event");
  await within(
    win.SvalPanel.observer.settled(),
    10_000,
    "win.SvalPanel.observer settling"
  );
  await EventUtils.synthesizeMouseAtCenter(row(), {}, win);
  await TestUtils.waitForCondition(
    () => win.gBrowser.selectedTab === otherEl,
    "a click on the other tab's row selects it"
  );
  Assert.ok(
    partsOf(browser).overlay.hidden,
    "and the overlay stays down: the whole workspace is the user's"
  );
  Assert.ok(
    isUserInControl(otherEl.linkedBrowser.browsingContext.browserId),
    "the other tab with it"
  );
});

/**
 * With the overlay up, the user's clicks, scrolling and keys never reach the
 * page, even when the page tries to take focus. The same input reaches a
 * page of the user's, so the test would see it if it got through.
 */
add_task(async function the_users_input_does_not_reach_an_agents_page() {
  const userTab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, INPUT),
    10_000,
    "a new tab's load"
  );
  atTaskEnd(() => BrowserTestUtils.removeTab(userTab));
  await within(SimpleTest.promiseFocus(window), 10_000, "the window's focus");
  await inputReaches(window, userTab.linkedBrowser, "in the user's own tab");

  const { win, browser } = await layerSetup();
  await inputBlocked(win, browser, "under the overlay");
  Assert.equal(
    win.document.activeElement,
    partsOf(browser).card,
    "the keyboard is on the card"
  );
  Assert.ok(!isUserInControl(browser.browsingContext.browserId));
});

/**
 * Right-click, touch and drag and drop land on the overlay, never the page.
 */
add_task(async function other_pointers_do_not_reach_the_page() {
  await SpecialPowers.pushPrefEnv({
    set: [["dom.w3c_touch_events.enabled", 1]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  // A touch screen's events, where the platform can make them, and a
  // touch's pointer events everywhere.
  let touches = true;
  const pointers = async (win, browser) => {
    await EventUtils.synthesizeMouseAtCenter(
      browser,
      { type: "contextmenu", button: 2 },
      win
    );
    // The tap lands on the page, or under the overlay on the overlay, and
    // neither is a control: the chrome's checker sees the <browser> or the
    // overlay.
    AccessibilityUtils.setEnv({ mustHaveAccessibleRule: false });
    await EventUtils.synthesizeMouseAtCenter(
      browser,
      { inputSource: MouseEvent.MOZ_SOURCE_TOUCH },
      win
    );
    AccessibilityUtils.resetEnv();
    try {
      EventUtils.synthesizeTouchAtCenter(browser, {}, win);
    } catch (err) {
      info(`no touch events here: ${err.name}`);
      touches = false;
    }
    await settle(browser);
    return (await pageState(browser)).seen;
  };
  const userTab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, INPUT),
    10_000,
    "a new tab's load"
  );
  atTaskEnd(() => BrowserTestUtils.removeTab(userTab));
  await within(SimpleTest.promiseFocus(window), 10_000, "the window's focus");
  const menu = document.getElementById("contentAreaContextMenu");
  const userSeen = await pointers(window, userTab.linkedBrowser);
  if (menu.state !== "closed") {
    menu.hidePopup();
  }
  const types = ["contextmenu", "pointerdown"];
  if (touches) {
    types.push("touchstart");
  }
  for (const type of types) {
    Assert.ok(userSeen.includes(type), `a ${type} reaches a user's page`);
  }

  const { win, browser } = await layerSetup();
  const seen = await pointers(win, browser);
  for (const type of types) {
    Assert.ok(!seen.includes(type), `no ${type} reached the agent's page`);
  }
  // A drag's events are hit-tested at the pointer, as the pointer's own are
  // (the drag service sends them to the window, which finds what is at the
  // point), so wherever the page shows, a drop lands on the overlay. EventUtils'
  // drop helpers dispatch straight at an element, which no drag ever does,
  // so the check is what is at those points.
  const page = browser.getBoundingClientRect();
  for (const [x, y] of [
    [page.left + 5, page.top + 5],
    [page.left + page.width / 2, page.top + page.height / 2],
    [page.right - 5, page.bottom - 5],
  ]) {
    Assert.equal(
      win.document.elementFromPoint(x, y)?.closest(".sval-agent-overlay"),
      partsOf(browser).overlay,
      `the overlay is what a drop at ${Math.round(x)},${Math.round(y)} lands on`
    );
  }
});

/**
 * The agent's own input is dispatched inside the page, beneath the overlay,
 * and works with the overlay up.
 */
add_task(async function the_agents_input_reaches_the_page_beneath_it() {
  const { call, tab, win, browser } = await layerSetup();
  Assert.ok(!partsOf(browser).overlay.hidden, "the overlay is up");
  await call("type_text", {
    tab,
    ref: await refFor(call, tab, /textbox "Field" \[(e\d+)\]/),
    text: "hi",
  });
  await call("press_keys", { tab, keys: ["!"] });
  await call("click_element", {
    tab,
    ref: await refFor(call, tab, /button "Press" \[(e\d+)\]/),
  });
  await call("scroll_page", { tab, direction: "down" });
  const state = await pageState(browser);
  Assert.equal(state.value, "hi!", "the agent typed");
  Assert.equal(state.title, "Pressed", "the agent clicked");
  Assert.ok(state.seen.includes("click"), "the page heard the click");
  Assert.greater(state.scrollY, 0, "the agent scrolled");
  Assert.equal(
    win.document.activeElement,
    partsOf(browser).card,
    "and the user's keyboard went back to the card"
  );
});

/**
 * The find bar sends Enter, Tab and the scrolling keys on to the page, so it
 * does not stay open in a tab under the overlay.
 */
add_task(async function find_in_page_does_not_reach_the_page() {
  const { win, tabEl } = await layerSetup();
  const findBar = await win.gBrowser.getFindBar(tabEl);
  findBar.open();
  await TestUtils.waitForCondition(() => findBar.hidden, "the find bar closes");
});

/**
 * The keyboard stays where the user put it while the agent works: the
 * agent's typing, keys and clicks move no focus in the window, so a screen
 * reader hears nothing of the overlay again, and Take control, once reached,
 * takes the next Enter.
 */
add_task(async function the_agents_input_leaves_the_users_focus_alone() {
  const { call, tab, win, browser } = await layerSetup();
  const { card } = partsOf(browser);
  const take = card.querySelector(".sval-agent-take");
  Assert.equal(win.document.activeElement, card, "the card has focus");
  EventUtils.synthesizeKey("KEY_Tab", {}, win);
  Assert.equal(win.document.activeElement, take, "Tab reaches Take control");

  const moves = [];
  const record = event => moves.push(event.type);
  win.addEventListener("focus", record, true);
  win.addEventListener("blur", record, true);
  atTaskEnd(() => {
    win.removeEventListener("focus", record, true);
    win.removeEventListener("blur", record, true);
  });
  await call("type_text", {
    tab,
    ref: await refFor(call, tab, /textbox "Field" \[(e\d+)\]/),
    text: "hi",
  });
  await call("press_keys", { tab, keys: ["!"] });
  await call("click_element", {
    tab,
    ref: await refFor(call, tab, /button "Press" \[(e\d+)\]/),
  });
  await settle(browser);
  const state = await pageState(browser);
  Assert.equal(state.value, "hi!", "the agent typed");
  Assert.equal(state.title, "Pressed", "the agent clicked");
  Assert.deepEqual(moves, [], "no focus moved in the window");
  Assert.equal(win.document.activeElement, take, "Take control keeps focus");

  const service = Cc["@mozilla.org/accessibilityService;1"].getService(
    Ci.nsIAccessibilityService
  );
  const acc = await accessibleOf(take);
  const states = {};
  acc.getState(states, {});
  Assert.ok(
    states.value & Ci.nsIAccessibleStates.STATE_FOCUSED,
    "a screen reader has Take control focused"
  );
  Assert.equal(
    // A browser with no accessible is what is checked.
    // eslint-disable-next-line sval/accessible-read
    service.getAccessibleFor(browser),
    null,
    "and the page stays out of its tree"
  );

  EventUtils.synthesizeKey("KEY_Enter", {}, win);
  await TestUtils.waitForCondition(
    () => isUserInControl(browser.browsingContext.browserId),
    "Enter on Take control takes the workspace"
  );
  await giveBackFrom(win, browser);
});

/**
 * The user's keys never reach the page while the agent has it, during the
 * agent's input as at any other time.
 */
add_task(async function the_user_cannot_type_into_the_page_during_input() {
  const { call, tab, win, browser } = await layerSetup();
  const ref = await refFor(call, tab, /textbox "Field" \[(e\d+)\]/);
  const typing = call("type_text", { tab, ref, text: "hi" });
  EventUtils.sendString("abc", win);
  await typing;
  EventUtils.sendString("abc", win);
  await settle(browser);
  const state = await pageState(browser);
  Assert.equal(state.value, "hi", "only the agent's keys reached the page");
});

/**
 * Navigation the window asks of an agent's tab is refused while the overlay
 * is up: the address bar, the back button and its key, Reload and Stop, and
 * the same asked by the window's own code. The page stays as it is, the
 * keyboard goes to the card, and the agent's own navigation goes on.
 */
add_task(async function the_window_cannot_navigate_an_agents_tab() {
  const { call, tab, win, browser } = await layerSetup();
  await call("navigate_tab", { tab, to: PAGE });
  await SpecialPowers.spawn(browser, [], () => {
    content.wrappedJSObject.marker = "still here";
  });
  const unchanged = async (why, action) => {
    await noLoadStarts(browser, action, why);
    Assert.equal(browser.currentURI.spec, PAGE, `${why} leaves the page`);
    Assert.equal(
      await SpecialPowers.spawn(
        browser,
        [],
        () => content.wrappedJSObject.marker
      ),
      "still here",
      `${why} does not load it again`
    );
    Assert.equal(
      win.document.activeElement,
      partsOf(browser).card,
      `${why} puts the keyboard on the card`
    );
  };

  win.gURLBar.focus();
  EventUtils.sendString(PAGE2, win);
  await unchanged("Enter in the address bar", () =>
    EventUtils.synthesizeKey("KEY_Enter", {}, win)
  );
  Assert.ok(!win.gURLBar.value.includes("page2"), "nothing was typed there");

  win.gURLBar.value = PAGE2;
  await unchanged("the address bar's own load", () =>
    win.gURLBar.handleCommand()
  );
  Assert.ok(!win.gURLBar.value.includes("page2"), "the address bar reverts");

  await unchanged("the Reload command", () =>
    win.document.getElementById("Browser:Reload").doCommand()
  );

  await unchanged("the back button", () =>
    EventUtils.synthesizeMouseAtCenter(
      win.document.getElementById("back-button"),
      {},
      win
    )
  );

  await unchanged("the back key", () =>
    EventUtils.synthesizeKey(
      "KEY_ArrowLeft",
      AppConstants.platform == "macosx" ? { accelKey: true } : { altKey: true },
      win
    )
  );

  await unchanged("the reload key", () =>
    EventUtils.synthesizeKey("r", { accelKey: true }, win)
  );

  const slow = ROOT + "sval_agent_slow.sjs";
  const going = call("navigate_tab", { tab, to: slow });
  await TestUtils.waitForCondition(
    () => browser.webProgress.isLoadingDocument,
    "the agent's load is under way"
  );
  partsOf(browser).card.focus();
  EventUtils.synthesizeKey("KEY_Escape", {}, win);
  Assert.equal((await going).url, slow, "Esc did not stop the agent's load");
});

/**
 * Popups Firefox draws for a page, such as a `<select>`'s list, do not open
 * over an agent's tab, where the user could pick from them.
 */
add_task(async function a_pages_popups_do_not_open_under_the_layer() {
  const addSelect = b =>
    SpecialPowers.spawn(b, [], () => {
      const select = content.document.createElement("select");
      select.id = "pick";
      select.innerHTML = "<option>One</option><option>Two</option>";
      content.document.body.prepend(select);
    });
  const userTab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, INPUT),
    10_000,
    "a new tab's load"
  );
  atTaskEnd(() => BrowserTestUtils.removeTab(userTab));
  await addSelect(userTab.linkedBrowser);
  const popup = () => document.getElementById("ContentSelectDropdownPopup");
  const shown = BrowserTestUtils.waitForEvent(document, "popupshown", true);
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#pick",
    {},
    userTab.linkedBrowser
  );
  await within(shown, 10_000, "the user's list opening");
  Assert.equal(popup().state, "open", "a user's page opens its list");
  popup().hidePopup();

  const { win, browser } = await layerSetup();
  await addSelect(browser);
  // Opening the list starts with `popupshowing`, in the turn the page's
  // request arrives, so once both sides are idle it would have been seen.
  let opened = false;
  const onShowing = e =>
    (opened ||= e.target.id === "ContentSelectDropdownPopup");
  win.document.addEventListener("popupshowing", onShowing, true);
  atTaskEnd(() =>
    win.document.removeEventListener("popupshowing", onShowing, true)
  );
  await BrowserTestUtils.synthesizeMouseAtCenter("#pick", {}, browser);
  await settle(browser);
  Assert.ok(!opened, "an agent's page does not");
});

/**
 * A page that raises dialog after dialog never covers Take control.
 */
add_task(async function page_dialogs_never_cover_take_control() {
  const { PromptTestUtils } = ChromeUtils.importESModule(
    "resource://testing-common/PromptTestUtils.sys.mjs"
  );
  const { win, browser } = await layerSetup();
  const shown = PromptTestUtils.waitForPrompt(browser, {
    modalType: Services.prompt.MODAL_TYPE_CONTENT,
    promptType: "confirm",
  });
  await SpecialPowers.spawn(browser, [], () => {
    content.setTimeout(() => {
      for (let i = 0; i < 100; i++) {
        content.confirm("Again?");
      }
    }, 0);
  });
  await within(shown, 10_000, "the popupshown event");
  const take = partsOf(browser).card.querySelector(".sval-agent-take");
  const box = take.getBoundingClientRect();
  Assert.equal(
    win.document.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2
    ),
    take,
    "Take control is not covered"
  );
  await EventUtils.synthesizeMouseAtCenter(take, {}, win);
  Assert.ok(
    isUserInControl(browser.browsingContext.browserId),
    "and takes control"
  );
});

/**
 * While the overlay holds the agent's window, a workspace chosen from the
 * menu bar's Workspaces menu opens in a window of its own, and the agent's
 * window stays on the agent's workspace.
 */
add_task(async function the_menu_bar_opens_a_workspace_beside_the_agents() {
  const { win, ws, browser } = await layerSetup();
  Assert.ok(partsOf(browser).overlay, "the overlay is up");
  const own = await SvalPanel.engine.mutate({
    kind: "addWorkspace",
    name: "Elsewhere",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  atTaskEnd(() => removeWorkspace(own));
  await win.SvalPanel.refresh();
  const popup = win.document.getElementById("sval-workspaces-menu-popup");
  // As the menu bar fills it before it shows (`SvalMenuBar`); macOS draws it
  // natively, where a test cannot open it.
  popup.dispatchEvent(new win.Event("popupshowing"));
  const entry = popup.querySelector(
    `menuitem[data-workspace-id="${CSS.escape(own)}"]`
  );
  const opening = BrowserTestUtils.domWindowOpenedAndLoaded();
  entry.doCommand();
  const opened = await within(opening, 20_000, "the new window's opening");
  expectOpened(opened);
  await within(
    opened.SvalPanel.started,
    20_000,
    "the new window's panel starting"
  );
  expectWorkspaceTabs(opened);
  Assert.equal(
    SvalWindowWorkspace.of(opened).id,
    own,
    "the new window shows it"
  );
  Assert.equal(
    SvalWindowWorkspace.of(win).id,
    ws,
    "and the agent's window stays the agent's"
  );
});

/**
 * Settings asked for from the menu bar of the agent's window, in front,
 * opens in the user's own window, and the agent's workspace gains no tab.
 */
add_task(async function settings_open_in_the_users_window() {
  const { win, ws, browser } = await layerSetup();
  Assert.ok(partsOf(browser).overlay, "the overlay is up");
  const agentTabs = win.gBrowser.tabs.length;
  const userTabs = gBrowser.tabs.length;
  // Every platform's menu bar carries it, macOS's in the application menu.
  win.document.getElementById("menu_preferences").doCommand();
  await within(
    committed(() => gBrowser.selectedBrowser, "about:preferences"),
    10_000,
    "Settings in the user's window"
  );
  // An empty selected tab takes Settings in place (`switchToTabHavingURI`).
  if (gBrowser.tabs.length > userTabs) {
    expectOpened(gBrowser.selectedTab);
  }
  Assert.equal(
    win.gBrowser.tabs.length,
    agentTabs,
    "the agent's window opens no tab"
  );
  Assert.equal(
    SvalWindowWorkspace.of(win).id,
    ws,
    "and stays on the agent's workspace"
  );
});
