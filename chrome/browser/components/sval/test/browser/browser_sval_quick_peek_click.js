/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */

/**
 * The click that opens a link in a Quick Peek, as Settings › Keyboard shortcuts
 * changes it: the clicks it takes, the ones it refuses and why, what each
 * does on a link in a page afterwards, and Off, which is Settings › Links'
 * switch too. Every click is a real one, on the field or on the link.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

const { SvalQuickPeek, QUICK_PEEK_PREF, QUICK_PEEK_CLICK_PREF } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalQuickPeek.sys.mjs"
  );
const { clickText } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalKeys.sys.mjs"
);

const LINKS_PAGE = ROOT + "sval_quick_peek_links.html";
const QUICK_PEEKED = PAGE2;

add_setup(failOnConsoleErrors);

add_setup(async function () {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const home = await SvalPanel.engine.mutate({
    kind: "addWorkspace",
    name: "Home",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  expectWorkspaceTabs();
  Assert.ok(
    await within(SvalPanel.switchTo(home), 10_000, "the switch to Home"),
    "the window shows this file's workspace"
  );
  await within(SvalPanel.observer.settled(), 10_000, "the observer settling");
  registerCleanupFunction(() => {
    // What the pane wrote, which outlasts the file otherwise.
    Services.prefs.clearUserPref(QUICK_PEEK_CLICK_PREF);
    Services.prefs.clearUserPref(QUICK_PEEK_PREF);
    Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed");
  });
});

/** @returns {Promise<object>} the tree's nodes once the window is quiet. */
async function settledNodes() {
  await within(SvalPanel.observer.settled(), 10_000, "the observer settling");
  return (await SvalPanel.engine.tree()).nodes ?? {};
}

/**
 * Deletes the nodes of the tabs a task opened when it ends: the harness takes
 * them out of the window without closing them as a person does.
 *
 * @param {object[]} tabs
 */
function forgetAtTaskEnd(tabs) {
  const ids = tabs.map(tab => SvalPanel.observer.nodeIdFor(tab));
  atTaskEnd(async () => {
    const nodes = await settledNodes();
    const ops = ids
      .filter(id => id && nodes[id])
      .map(id => ({ kind: "remove", id }));
    if (ops.length) {
      await SvalPanel.engine.mutate({ kind: "batch", ops, now: Date.now() });
      await SvalPanel.refresh();
    }
  });
}

/** @returns {Promise<object>} a new tab on the page of links, in front. */
async function openLinks() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, LINKS_PAGE),
    10_000,
    "the page of links opening"
  );
  await settledNodes();
  forgetAtTaskEnd([tab]);
  return tab;
}

/**
 * Opens Settings › Keyboard shortcuts on the Quick Peek's click's row.
 *
 * @returns {Promise<object>} `{ ui, row, shortcut, input, button }`.
 */
async function openClickRow() {
  const ui = await openPane(
    "svalKeyboard",
    ({ byId }) =>
      byId("sval-keys-list")?.querySelector(".sval-keys-quick-peek"),
    "the click's row"
  );
  const row = ui.byId("sval-keys-list").querySelector(".sval-keys-quick-peek");
  return {
    ui,
    row,
    shortcut: () => row.querySelector(".sval-keys-shortcut").textContent,
    input: row.querySelector(".sval-keys-new"),
    button: action => row.querySelector(`[data-action="${action}"]`),
    off: () => row.classList.contains("sval-keys-unassigned"),
  };
}

/**
 * Starts a change on the row, as Change does.
 *
 * @param {object} pane `openClickRow`'s answer.
 */
async function startChange(pane) {
  const { ui, input, button } = pane;
  button("change").click();
  await TestUtils.waitForCondition(
    () => ui.page.document.activeElement === input,
    "the field waits for the new click"
  );
}

/**
 * Clicks the field with `modifiers` held, as a person does.
 *
 * @param {object} pane `openClickRow`'s answer.
 * @param {object} modifiers EventUtils' modifiers, and `button`.
 */
function clickField(pane, modifiers) {
  EventUtils.synthesizeMouseAtCenter(pane.input, modifiers, pane.ui.page);
}

/**
 * Clicks `#link` in `tab`'s page with `modifiers`, then clicks it plainly,
 * whose page loading in the tab means the first click has been handled, as
 * both reach the parent from the page in order.
 *
 * @param {object} tab
 * @param {object} modifiers
 * @returns {Promise<object[]>} the tabs that opened meanwhile.
 */
async function clickThenFollow(tab, modifiers) {
  const opened = [];
  const record = event => opened.push(event.target);
  gBrowser.tabContainer.addEventListener("TabOpen", record);
  try {
    await BrowserTestUtils.synthesizeMouseAtCenter(
      "#link",
      modifiers,
      tab.linkedBrowser
    );
    const loaded = BrowserTestUtils.browserLoaded(
      tab.linkedBrowser,
      false,
      QUICK_PEEKED
    );
    await BrowserTestUtils.synthesizeMouseAtCenter(
      "#link",
      {},
      tab.linkedBrowser
    );
    await within(loaded, 10_000, "the plain click's page");
  } finally {
    gBrowser.tabContainer.removeEventListener("TabOpen", record);
  }
  forgetAtTaskEnd(opened);
  return opened;
}

/**
 * Clicks `#link` in `tab`'s page with `modifiers`, waits for the Quick Peek it
 * opens to show the link, and closes it with Escape.
 *
 * @param {object} tab
 * @param {object} modifiers
 * @returns {Promise<object[]>} the tabs that opened other than the Quick Peek's.
 */
async function quickPeeksWith(tab, modifiers) {
  const opened = [];
  const record = event => opened.push(event.target);
  gBrowser.tabContainer.addEventListener("TabOpen", record);
  let quickPeek;
  try {
    await BrowserTestUtils.synthesizeMouseAtCenter(
      "#link",
      modifiers,
      tab.linkedBrowser
    );
    await TestUtils.waitForCondition(
      () => SvalQuickPeek.tabOf(window),
      "a Quick Peek opens"
    );
    quickPeek = SvalQuickPeek.tabOf(window);
    await committed(
      quickPeek.linkedBrowser,
      QUICK_PEEKED,
      "the Quick Peek has the link"
    );
  } finally {
    gBrowser.tabContainer.removeEventListener("TabOpen", record);
  }
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    () => !SvalQuickPeek.tabOf(window) && !quickPeek.linkedBrowser,
    "Escape closes the Quick Peek"
  );
  const others = opened.filter(t => t !== quickPeek);
  forgetAtTaskEnd(others);
  return others;
}

add_task(async function the_default_click_opens_a_quick_peek() {
  const pane = await openClickRow();
  Assert.ok(pane.row.querySelector("th").textContent, "the row is named");
  Assert.equal(
    pane.shortcut(),
    clickText("alt"),
    "Option-click, or Alt+click, to begin with"
  );
  Assert.ok(pane.button("reset").hidden, "with nothing to reset");
  const tab = await openLinks();
  Assert.deepEqual(
    await quickPeeksWith(tab, { altKey: true }),
    [],
    "the click opens a Quick Peek, and no tab"
  );
});

/**
 * A page's own scripted click, made while the user has just clicked the
 * page, opens no Quick Peek, though Firefox follows it as it would the user's.
 */
add_task(async function a_pages_own_click_opens_no_quick_peek() {
  const tab = await openLinks();
  const opened = [];
  const record = event => opened.push(event.target);
  gBrowser.tabContainer.addEventListener("TabOpen", record);
  atTaskEnd(() => gBrowser.tabContainer.removeEventListener("TabOpen", record));
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.notifyUserGestureActivation();
    // The page's own script makes the click: one this privileged test code
    // dispatched would be trusted.
    const script = content.document.createElement("script");
    script.textContent = `document.getElementById("link").dispatchEvent(
      new MouseEvent("click", { altKey: true, bubbles: true, cancelable: true })
    );`;
    content.document.body.append(script);
  });
  const loaded = BrowserTestUtils.browserLoaded(
    tab.linkedBrowser,
    false,
    QUICK_PEEKED
  );
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#link",
    {},
    tab.linkedBrowser
  );
  await within(loaded, 10_000, "the plain click's page");
  Assert.equal(
    SvalQuickPeek.tabOf(window),
    null,
    "the page's click opened no Quick Peek"
  );
  Assert.deepEqual(opened, [], "and no tab");
});

add_task(async function a_click_firefox_opens_links_with_is_refused() {
  const pane = await openClickRow();
  await startChange(pane);
  const refusals = [
    [{ accelKey: true }, "tab"],
    [{ shiftKey: true }, "window"],
    [{ accelKey: true, shiftKey: true }, "tab"],
    [{ button: 1 }, "middle"],
  ];
  for (const [modifiers, why] of refusals) {
    clickField(pane, modifiers);
    await TestUtils.waitForCondition(
      () => pane.input.dataset.refusal === why && pane.input.value,
      `the field refuses the click (${why})`
    );
    Assert.equal(
      pane.ui.page.document.activeElement,
      pane.input,
      "and waits for another click"
    );
  }
  Assert.ok(
    !Services.prefs.prefHasUserValue(QUICK_PEEK_CLICK_PREF),
    "no refused click was taken"
  );
  Assert.equal(pane.shortcut(), clickText("alt"), "the row is unchanged");
  EventUtils.synthesizeKey("KEY_Escape", {}, pane.ui.page);
  await TestUtils.waitForCondition(
    () => pane.input.hidden && !pane.button("change").hidden,
    "Escape ends the change"
  );
});

add_task(async function another_click_takes_the_quick_peek_from_firefox() {
  const pane = await openClickRow();
  await startChange(pane);
  clickField(pane, { accelKey: true, altKey: true });
  await TestUtils.waitForCondition(
    () => pane.shortcut() === clickText("accel,alt"),
    "the row shows the new click"
  );
  Assert.ok(pane.input.hidden, "the change is over");
  Assert.ok(!pane.button("reset").hidden, "with a way back");

  const tab = await openLinks();
  Assert.deepEqual(
    await quickPeeksWith(tab, { accelKey: true, altKey: true }),
    [],
    "the new click opens a Quick Peek, and no new tab with it"
  );
  Assert.deepEqual(
    await clickThenFollow(tab, { altKey: true }),
    [],
    "Option-click opens no tab"
  );
  Assert.equal(SvalQuickPeek.tabOf(window), null, "and no Quick Peek");

  // The Workspace panel's own Option-click, on a second tab's row, still
  // shows the two tabs in a Split.
  const second = await within(
    BrowserTestUtils.addTab(gBrowser, "data:text/html,<title>Second</title>"),
    10_000,
    "a second tab"
  );
  await settledNodes();
  forgetAtTaskEnd([second]);
  await selectTab(tab);
  const row = SvalPanel._rowElementFor(SvalPanel.observer.nodeIdFor(second));
  // The rows are a tree with a roving tabindex: Control+Shift+Plus is the
  // keyboard's way to the same Split.
  AccessibilityUtils.setEnv({
    focusableRule: false,
    nonNegativeTabIndexRule: false,
  });
  EventUtils.synthesizeMouseAtCenter(row, { altKey: true });
  AccessibilityUtils.resetEnv();
  await TestUtils.waitForCondition(
    () =>
      gBrowser.selectedTab.splitview?.tabs.length === 2 &&
      gBrowser.selectedTab.splitview.tabs.includes(second),
    "Option-click on a tab's row makes a Split"
  );

  await selectTab(pane.ui.tab);
  pane.button("reset").click();
  await TestUtils.waitForCondition(
    () => pane.shortcut() === clickText("alt"),
    "Reset puts Option-click back"
  );
  Assert.ok(
    !Services.prefs.prefHasUserValue(QUICK_PEEK_CLICK_PREF),
    "as Sval's default"
  );
});

add_task(async function off_is_the_links_switch() {
  const pane = await openClickRow();
  const toggle = pane.ui.byId("sval-quick-peek");
  Assert.ok(toggle.checked, "Settings › Links' switch is on to begin with");
  pane.button("clear").click();
  await TestUtils.waitForCondition(
    () => pane.off(),
    "Clear turns the click off"
  );
  Assert.ok(pane.button("clear").hidden, "with nothing left to clear");
  Assert.ok(!pane.button("reset").hidden, "and a way back");
  Assert.ok(!toggle.checked, "Settings › Links' switch is off too");

  const tab = await openLinks();
  Assert.deepEqual(
    await clickThenFollow(tab, { altKey: true }),
    [],
    "Option-click opens no tab"
  );
  Assert.equal(SvalQuickPeek.tabOf(window), null, "and no Quick Peek");

  // The switch turned on is the row's click back.
  await selectTab(pane.ui.tab);
  toggle.click();
  await TestUtils.waitForCondition(
    () => pane.shortcut() === clickText("alt"),
    "the switch turned on shows the click again"
  );

  // Enter, with the keys held, is the keyboard's way to choose a click.
  pane.button("clear").click();
  await TestUtils.waitForCondition(() => !toggle.checked, "off once more");
  await startChange(pane);
  EventUtils.synthesizeKey("KEY_Enter", { altKey: true }, pane.ui.page);
  await TestUtils.waitForCondition(
    () => pane.shortcut() === clickText("alt") && toggle.checked,
    "choosing a click turns the Quick Peek on, and the switch with it"
  );
  Assert.equal(
    pane.ui.page.document.activeElement,
    pane.button("change"),
    "and the focus is back on Change"
  );
});
