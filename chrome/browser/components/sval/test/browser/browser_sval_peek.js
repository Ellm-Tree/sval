/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */

/**
 * The Peek (link routing spec §4): a link from another app opens in
 * a small window of its own, in no workspace, which the user reads and
 * closes or opens in a workspace. Every link arrives as a command line
 * holding `-url`, which these tests run through the registered command-line
 * handlers in their category's order, as `nsCommandLine::Run` does.
 */

const { PLACE_KEYS, PLACE_STORE, SvalPeek, firstPlace, workspaceTitle } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalPeek.sys.mjs"
  );

/**
 * Forgets where the last Peek closed, which the next one would open
 * at in place of its default.
 */
function forgetPlace() {
  for (const key of PLACE_KEYS) {
    Services.xulStore.removeValue(PLACE_STORE.doc, PLACE_STORE.id, key);
  }
}

const QUICK_PAGE = "https://example.com/browser/?quick";
const QUICK_OTHER = "https://example.org/browser/?quick-other";
const QUICK_THIRD = "https://example.net/browser/?quick-third";

/**
 * A link from another app, and the Peek it opened, loaded.
 *
 * @param {string} url
 * @returns {Promise<Window>}
 */
async function linkFromAnotherApp(url) {
  const opened = BrowserTestUtils.waitForNewWindow({ url });
  runCommandLine(["-url", url]);
  const win = await within(opened, 20_000, "the Peek");
  await TestUtils.waitForCondition(
    () => !win.document.getElementById("sval-peek-open").hidden,
    "its open button names a workspace"
  );
  return win;
}

/** @returns {string} the name the window's workspace is shown with. */
function currentName() {
  const id = SvalWindowWorkspace.of(window).id;
  return SvalPanel.nodes[id]?.content?.name || "Untitled Workspace";
}

/**
 * @param {string} url
 * @returns {Promise<object[]>} the tree's tab nodes for `url`.
 */
async function nodesFor(url) {
  return Object.values(await nodes(SvalPanel.engine)).filter(
    node => node.kind === "tab" && node.content?.url === url
  );
}

add_task(async function a_link_from_another_app_opens_in_a_peek() {
  const tabs = gBrowser.tabs.length;
  const win = await linkFromAnotherApp(QUICK_PAGE);

  Assert.ok(SvalPeek.isPeek(win), "it is a Peek");
  Assert.equal(win.gBrowser.tabs.length, 1, "with one page");
  Assert.equal(win.gBrowser.selectedTab.userContextId, 0, "in the shared jar");
  Assert.equal(gBrowser.tabs.length, tabs, "the main window gains no tab");
  Assert.ok(!win.SvalPanel, "no workspace panel");
  Assert.equal(
    SessionStore.getCustomWindowValue(win, "sval-unsaved"),
    "1",
    "kept out of every saved session"
  );
  Assert.deepEqual(await nodesFor(QUICK_PAGE), [], "nothing reaches the tree");
  Assert.equal(
    BrowserWindowTracker.getTopWindow({ private: false }),
    window,
    "the frontmost window for new tabs is still the main window"
  );

  const doc = win.document;
  const tag = doc.getElementById("sval-peek-tag");
  Assert.ok(!tag.hasAttribute("several"), "with nothing to switch to");
  Assert.ok(
    !tag.querySelector(".sval-peek-count").checkVisibility(),
    "the tag shows no count for itself alone"
  );
  Assert.ok(
    tag.title.includes("6"),
    "the tag's tooltip says how many hours unused close it"
  );
  const main = doc.getElementById("sval-peek-open-main");
  Assert.ok(
    main.title.includes(workspaceTitle(currentName())),
    "the open button names the last-used window's workspace"
  );
  Assert.ok(
    win.document.getElementById("urlbar"),
    "the main window's address bar"
  );
  Assert.ok(!win.gURLBar.readOnly, "which the user can type in");
});

add_task(async function closing_one_leaves_its_page_in_history_only() {
  const closedTabs = SessionStore.getClosedTabCount();
  const closedWindows = SessionStore.getClosedWindowCount();
  const win = await linkFromAnotherApp(QUICK_PAGE);
  const closed = BrowserTestUtils.domWindowClosed(win);
  win.focus();
  EventUtils.synthesizeKey("w", { accelKey: true }, win);
  await within(closed, 10_000, "the Peek closing");

  Assert.ok(
    await PlacesUtils.history.hasVisits(QUICK_PAGE),
    "the page is in browsing history"
  );
  Assert.equal(
    SessionStore.getClosedTabCount(),
    closedTabs,
    "no window's undo-close list gains it"
  );
  Assert.equal(
    SessionStore.getClosedWindowCount(),
    closedWindows,
    "nor do the recently closed windows"
  );
  Assert.deepEqual(await nodesFor(QUICK_PAGE), [], "nor the tree");
});

add_task(async function peeks_cascade_count_and_close_together() {
  forgetPlace();
  const first = await linkFromAnotherApp(QUICK_PAGE);
  const second = await linkFromAnotherApp(QUICK_OTHER);
  // A window manager can place each window itself before Sval moves it
  // where it belongs, so the windows get there a moment after they show.
  await TestUtils.waitForCondition(
    () =>
      second.screenX === first.screenX + 28 &&
      second.screenY === first.screenY + 28,
    "the second opens a step right and down from the first"
  );
  for (const win of [first, second]) {
    const tag = win.document.getElementById("sval-peek-tag");
    const count = tag.querySelector(".sval-peek-count");
    Assert.ok(count.checkVisibility(), "the tag shows the count");
    Assert.equal(count.textContent, "2");
    Assert.ok(tag.hasAttribute("several"), "the tag opens the switcher");
  }

  const closed = [first, second].map(win =>
    BrowserTestUtils.domWindowClosed(win)
  );
  const switcher = await openSwitcher(second);
  switcher.querySelector(".sval-peek-switcher-close-all").click();
  await within(Promise.all(closed), 10_000, "both closing");
  Assert.deepEqual(SvalPeek.windows(), [], "none is left");
});

/**
 * Puts `win` in front, focused and visible to its page, as a user who clicks
 * a peek has it. A window Gecko already holds active is not raised again by
 * `focus()` (`nsFocusManager::RaiseWindow`), so focus goes through the main
 * window first.
 *
 * @param {Window} win A Peek.
 */
async function inFront(win) {
  await SimpleTest.promiseFocus(window);
  await SimpleTest.promiseFocus(win);
  await uncovered(win);
}

/**
 * Opens the switcher from `win`'s tag, as a click on it does.
 *
 * @param {Window} win A Peek.
 * @returns {Promise<Element>} the switcher, shown.
 */
async function openSwitcher(win) {
  const switcher = win.document.getElementById("sval-peek-switcher");
  const shown = BrowserTestUtils.waitForPopupEvent(switcher, "shown");
  EventUtils.synthesizeMouseAtCenter(
    win.document.getElementById("sval-peek-tag"),
    {},
    win
  );
  await within(shown, 10_000, "the switcher");
  return switcher;
}

/**
 * @param {Element} switcher
 * @returns {string[]} the sites its rows show, top to bottom.
 */
function rowSites(switcher) {
  return [...switcher.querySelectorAll(".sval-peek-switcher-row")].map(
    row => row.querySelector(".sval-peek-menu-hint").textContent.split(" · ")[0]
  );
}

add_task(async function the_switcher_lists_peeks_in_the_order_they_opened() {
  const pages = [QUICK_PAGE, QUICK_OTHER, QUICK_THIRD];
  const wins = [];
  for (const page of pages) {
    wins.push(await linkFromAnotherApp(page));
  }
  atTaskEnd(() => SvalPeek.closeAll());
  const labels = wins.map(win => win.gBrowser.selectedTab.label);
  const sites = ["example.com", "example.org", "example.net"];
  const third = wins[2];
  await inFront(third);
  let switcher = await openSwitcher(third);
  const doc = third.document;

  Assert.ok(
    switcher.querySelector(".sval-peek-switcher-heading").textContent,
    "the switcher has its heading"
  );
  Assert.equal(
    switcher.querySelector(".sval-peek-switcher-count").textContent,
    "3"
  );
  const rows = [...switcher.querySelectorAll(".sval-peek-switcher-row")];
  Assert.deepEqual(rowSites(switcher), sites, "in the order they opened");
  Assert.ok(rows[2].hasAttribute("current"), "this one is marked");

  // The keyboard reaches each row and its close button in turn.
  const close = rows[1].querySelector(".sval-peek-switcher-close");
  const go = rows[1].querySelector(".sval-peek-switcher-go");
  go.focus();
  EventUtils.synthesizeKey("KEY_Tab", {}, third);
  Assert.equal(doc.activeElement, close, "Tab reaches the close button");
  Assert.ok(close.matches(":focus-visible"), "with its focus showing");
  Assert.ok(
    close.getAttribute("aria-label").includes(labels[1]),
    "the close button is named for its peek"
  );

  // Going to a peek leaves every row where it was.
  const hidden = BrowserTestUtils.waitForPopupEvent(switcher, "hidden");
  const focused = BrowserTestUtils.waitForEvent(wins[0], "focus");
  EventUtils.synthesizeMouseAtCenter(
    rows[0].querySelector(".sval-peek-switcher-go"),
    {},
    third
  );
  await within(hidden, 10_000, "the switcher closing");
  await within(focused, 10_000, "the first peek in front");
  Assert.equal(Services.focus.activeWindow, wins[0], "it is the active window");
  await uncovered(wins[0]);
  switcher = await openSwitcher(wins[0]);
  Assert.deepEqual(
    rowSites(switcher),
    sites,
    "the list keeps its order after a switch"
  );
  const again = [...switcher.querySelectorAll(".sval-peek-switcher-row")];
  Assert.ok(again[0].hasAttribute("current"), "and marks the one in front");

  // Enter on a close button closes its peek.
  const closed = BrowserTestUtils.domWindowClosed(wins[1]);
  const button = again[1].querySelector(".sval-peek-switcher-close");
  button.focus();
  EventUtils.synthesizeKey("KEY_Enter", {}, wins[0]);
  await within(closed, 10_000, "the second peek closing");
  Assert.deepEqual(
    rowSites(switcher),
    [sites[0], sites[2]],
    "the others keep their places"
  );
  Assert.equal(
    switcher.querySelector(".sval-peek-switcher-count").textContent,
    "2"
  );

  // From the keyboard, the tag opens the switcher with focus on its first
  // row.
  const hiddenAgain = BrowserTestUtils.waitForPopupEvent(switcher, "hidden");
  EventUtils.synthesizeKey("KEY_Escape", {}, wins[0]);
  await within(hiddenAgain, 10_000, "Escape closing the switcher");
  const tag = wins[0].document.getElementById("sval-peek-tag");
  tag.focus();
  const shown = BrowserTestUtils.waitForPopupEvent(switcher, "shown");
  EventUtils.synthesizeKey("KEY_Enter", {}, wins[0]);
  await within(shown, 10_000, "the switcher from the keyboard");
  await TestUtils.waitForCondition(
    () =>
      wins[0].document.activeElement ===
      switcher.querySelector(".sval-peek-switcher-go"),
    "focus is on the first row"
  );
});

add_task(async function a_new_tab_from_a_peek_opens_another() {
  const win = await linkFromAnotherApp(QUICK_PAGE);
  const opened = BrowserTestUtils.domWindowOpenedAndLoaded();
  // What a `target=_blank` link and a Ctrl/Cmd-click both do.
  win.openTrustedLinkIn(QUICK_OTHER, "tab");
  const other = await within(opened, 20_000, "another Peek");
  await committed(() => other.gBrowser?.selectedBrowser, QUICK_OTHER);
  Assert.ok(SvalPeek.isPeek(other), "a Peek");
  Assert.equal(win.gBrowser.tabs.length, 1, "the first keeps its one page");
  Assert.equal(
    win.gBrowser.currentURI.spec,
    QUICK_PAGE,
    "and it is still its own"
  );
});

add_task(async function opening_in_the_workspace_moves_the_page_as_it_is() {
  const win = await linkFromAnotherApp(QUICK_PAGE);
  const browser = win.gBrowser.selectedBrowser;
  await SpecialPowers.spawn(browser, [], () => {
    content.wrappedJSObject.svalMark = "kept";
  });
  const closed = BrowserTestUtils.domWindowClosed(win);
  win.document.getElementById("sval-peek-open-main").click();
  await within(closed, 10_000, "the Peek closing");

  const tab = gBrowser.selectedTab;
  expectOpened(tab);
  Assert.equal(
    tab.linkedBrowser.currentURI.spec,
    QUICK_PAGE,
    "the page moved in"
  );
  Assert.equal(
    await SpecialPowers.spawn(
      tab.linkedBrowser,
      [],
      () => content.wrappedJSObject.svalMark
    ),
    "kept",
    "with no reload"
  );
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  await TestUtils.waitForCondition(
    async () => (await nodesFor(QUICK_PAGE)).length === 1,
    "it is filed in the workspace as a tab"
  );
  BrowserTestUtils.removeTab(tab);
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
});

add_task(async function a_page_opened_in_the_workspace_joins_no_group() {
  const { workspace } = await viewingAGroupedTab();
  const win = await linkFromAnotherApp(QUICK_PAGE);
  const closed = BrowserTestUtils.domWindowClosed(win);
  win.document.getElementById("sval-peek-open-main").click();
  await within(closed, 10_000, "the Peek closing");
  const tab = expectOpened(gBrowser.selectedTab);
  Assert.equal(tab.linkedBrowser.currentURI.spec, QUICK_PAGE, "the page");
  atTaskEnd(async () => {
    BrowserTestUtils.removeTab(tab);
    await within(
      SvalPanel.observer.settled(),
      10_000,
      "SvalPanel.observer settling"
    );
  });
  Assert.deepEqual(
    await filedAt(tab),
    { parent: workspace, last: true },
    "it ends the workspace's own list, in no group"
  );
});

add_task(async function with_the_peek_off_a_link_opens_as_a_tab() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.sval.peek.enabled", false]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, QUICK_PAGE);
  runCommandLine(["-url", QUICK_PAGE]);
  const tab = await within(opened, 20_000, "the new tab");
  Assert.equal(SvalPeek.windows().length, 0, "no Peek");
  Assert.equal(tab.documentGlobal, window, "in the frontmost window");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function with_the_peek_off_a_link_joins_no_group() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.sval.peek.enabled", false]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const { workspace } = await viewingAGroupedTab();
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, QUICK_PAGE);
  runCommandLine(["-url", QUICK_PAGE]);
  const tab = await within(opened, 20_000, "the new tab");
  atTaskEnd(async () => {
    BrowserTestUtils.removeTab(tab);
    await within(
      SvalPanel.observer.settled(),
      10_000,
      "SvalPanel.observer settling"
    );
  });
  Assert.deepEqual(
    await filedAt(tab),
    { parent: workspace, last: true },
    "it ends the workspace's own list, in no group"
  );
});

add_task(async function an_idle_peek_closes_even_across_a_sleep() {
  const win = await linkFromAnotherApp(QUICK_PAGE);
  await SimpleTest.promiseFocus(window);
  const closed = BrowserTestUtils.domWindowClosed(win);
  // The computer sleeps through six hours, which a timer does not count.
  const realNow = SvalPeek._now;
  const slept = Date.now() + 6 * 60 * 60 * 1000 + 1000;
  SvalPeek._now = () => slept;
  atTaskEnd(() => {
    SvalPeek._now = realNow;
  });
  Services.obs.notifyObservers(null, "wake_notification");
  await within(closed, 10_000, "the idle Peek closing");
});

add_task(async function an_isolated_workspace_asks_then_opens_in_its_jar() {
  const home = SvalWindowWorkspace.of(window).id;
  const id = await SvalPanel.engine.mutate({
    kind: "addWorkspace",
    name: "Work",
    isolated: true,
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  atTaskEnd(async () => {
    await SvalWindowWorkspace.of(window).switchTo(home);
    await within(
      SvalPanel.observer.settled(),
      10_000,
      "SvalPanel.observer settling"
    );
    // A workspace with no tab of its own opens a blank one when the window
    // switches back to it.
    expectOpened(...gBrowser.tabs);
    await removeWorkspace(id);
    await SvalPanel.refresh();
  });
  await SvalPanel.refresh();

  const win = await linkFromAnotherApp(QUICK_PAGE);
  const doc = win.document;
  const menu = doc.getElementById("sval-peek-menu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  doc.getElementById("sval-peek-open-more").click();
  await within(shown, 10_000, "the menu of other workspaces");
  const row = [...menu.querySelectorAll(".sval-peek-menu-row")].find(each =>
    each
      .querySelector(".sval-peek-menu-label")
      .textContent.includes(workspaceTitle("Work"))
  );
  Assert.ok(row, "it offers the isolated workspace by name");
  Assert.ok(row.querySelector(".sval-peek-isolated"), "marked as isolated");
  row.click();

  await TestUtils.waitForCondition(
    () => win.gDialogBox.dialog && !win.gDialogBox.dialog._isClosing,
    "the Peek asks first"
  );
  await dialogShown(win.gDialogBox.dialog, "the question");
  const question = win.gDialogBox.dialog._frame.contentDocument;
  Assert.ok(
    question
      .getElementById("sval-dialog-title")
      .textContent.includes(workspaceTitle("Work")),
    "it asks about Work"
  );
  Assert.ok(
    question.querySelector('button[data-button="cancel"]'),
    "as a question that can be declined"
  );
  const closed = BrowserTestUtils.domWindowClosed(win);
  question.querySelector('button[data-button="ok"]').click();
  await within(closed, 10_000, "the Peek closing");

  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    id,
    "the window switched to it"
  );
  const tab = gBrowser.selectedTab;
  expectOpened(tab);
  await TestUtils.waitForCondition(
    () =>
      tab.linkedBrowser.currentURI.spec === QUICK_PAGE &&
      !tab.hasAttribute("busy"),
    "the page loads there"
  );
  Assert.equal(tab.linkedBrowser.currentURI.spec, QUICK_PAGE, "the page");
  Assert.equal(
    tab.userContextId,
    gBrowser.defaultUserContextId,
    "in the workspace's own jar"
  );
  Assert.greater(tab.userContextId, 0, "which is not the shared one");
});

add_task(
  async function at_a_cold_start_the_peek_opens_over_the_restored_windows() {
    const before = new Set(Services.wm.getEnumerator("navigator:browser"));
    runCommandLine(
      ["-url", QUICK_PAGE],
      Ci.nsICommandLine.STATE_INITIAL_LAUNCH
    );
    let win;
    await TestUtils.waitForCondition(() => {
      win = SvalPeek.windows()[0];
      return win?.gBrowser?.currentURI.spec === QUICK_PAGE;
    }, "the Peek opens with the page");
    expectOpened(win);
    const normal = [...Services.wm.getEnumerator("navigator:browser")].find(
      each => !before.has(each) && each !== win
    );
    Assert.ok(normal, "Firefox opened the first window as at any launch");
    expectOpened(normal);
    Assert.ok(!SvalPeek.isPeek(normal), "an ordinary one");
    // Opened after the first window, the Peek ends in front once
    // both have been activated, which a window manager does in its own time.
    await TestUtils.waitForCondition(
      () => BrowserWindowTracker.getOrderedWindows()[0] === win,
      "and the Peek is in front of it"
    );
    await TestUtils.waitForCondition(
      () => normal.SvalPanel?.initialized,
      "its panel starts"
    );
    await within(normal.SvalPanel.started, 10_000, "the panel starting");
    await within(
      BrowserTestUtils.closeWindow(normal),
      10_000,
      "the first window closing"
    );
  }
);

add_task(async function escape_closes_a_menu_first_then_stops_the_load() {
  const key = crypto.randomUUID();
  const slow = `${ROOT}sval_agent_slow.sjs?hold=${key}`;
  atTaskEnd(() => fetch(`${ROOT}sval_agent_slow.sjs?release=${key}`));
  await linkFromAnotherApp(QUICK_PAGE);
  // The page never finishes loading, so the wait is for the window's own
  // document and its delayed startup, which adds the loading line.
  const opened = BrowserTestUtils.domWindowOpenedAndLoaded();
  runCommandLine(["-url", slow]);
  const win = await within(opened, 20_000, "the second Peek");
  expectOpened(win);
  await TestUtils.waitForCondition(
    () =>
      win.document.getElementById("sval-load-line")?.hasAttribute("loading"),
    "a Peek loading a slow page"
  );
  await inFront(win);

  const switcher = win.document.getElementById("sval-peek-switcher");
  const shown = BrowserTestUtils.waitForPopupEvent(switcher, "shown");
  win.document.getElementById("sval-peek-tag").click();
  await within(shown, 10_000, "the switcher");
  const hidden = BrowserTestUtils.waitForPopupEvent(switcher, "hidden");
  EventUtils.synthesizeKey("KEY_Escape", {}, win);
  await within(hidden, 10_000, "Escape closing the switcher");
  Assert.ok(
    win.document.getElementById("sval-load-line").hasAttribute("loading"),
    "the page is still loading"
  );

  EventUtils.synthesizeKey("KEY_Escape", {}, win);
  await TestUtils.waitForCondition(
    () =>
      !win.document.getElementById("sval-load-line").hasAttribute("loading"),
    "a second Escape stops the load"
  );
  SvalPeek.closeAll();
});

add_task(async function an_address_alone_opens_in_a_peek_too() {
  // What Linux's desktop entry passes (`Exec=sval %u`).
  const opened = BrowserTestUtils.waitForNewWindow({ url: QUICK_PAGE });
  runCommandLine([QUICK_PAGE]);
  const win = await within(opened, 20_000, "the Peek");
  Assert.ok(SvalPeek.isPeek(win), "a Peek");
});

/**
 * Resizes `win`'s content area to `width` and waits until it is the width it
 * got. The frame's own width differs by platform (Windows draws resize
 * borders outside the content), so the change is made relative to the
 * content area.
 *
 * @param {Window} win
 * @param {number} width
 */
async function resizeTo(win, width) {
  win.resizeBy(width - win.innerWidth, 0);
  await TestUtils.waitForCondition(
    () => win.innerWidth === width,
    `the window ${width}px wide`
  );
}

add_task(async function the_row_fits_at_every_width_down_to_the_minimum() {
  // The most the row holds: the tag with a count and its chevron, and the
  // open button with its menu of other workspaces.
  const home = SvalWindowWorkspace.of(window).id;
  const id = await SvalPanel.engine.mutate({
    kind: "addWorkspace",
    name: "Work",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  atTaskEnd(async () => {
    await removeWorkspace(id);
    await SvalPanel.refresh();
  });
  await SvalPanel.refresh();
  Assert.equal(SvalWindowWorkspace.of(window).id, home, "the window stays put");
  await linkFromAnotherApp(QUICK_PAGE);
  const win = await linkFromAnotherApp(QUICK_OTHER);
  const doc = win.document;
  Assert.ok(
    !doc.getElementById("sval-peek-open-more").hidden,
    "the open button has its menu"
  );

  // A window can't be wider than its screen, and a CI screen may be narrow.
  const frame = win.outerWidth - win.innerWidth;
  const widths = [1040, 900, 800, 792, 720].filter(
    width => width + frame <= win.screen.availWidth
  );
  Assert.ok(widths.includes(900), "the screen fits the widths that matter");
  for (const width of widths) {
    await resizeTo(win, width);
    Assert.ok(
      !doc.getElementById("nav-bar").hasAttribute("overflowing"),
      `at ${width}px nothing moves to the overflow menu`
    );
    const main = doc.getElementById("sval-peek-open-main");
    Assert.lessOrEqual(
      main.scrollWidth,
      main.clientWidth,
      `at ${width}px the open button shows all it holds`
    );
    Assert.lessOrEqual(
      doc.getElementById("sval-peek-open").getBoundingClientRect().right,
      win.innerWidth,
      `at ${width}px the open button is inside the window`
    );
  }
});

add_task(async function a_second_peek_shows_the_switcher_in_the_tag() {
  const first = await linkFromAnotherApp(QUICK_PAGE);
  const doc = first.document;
  const tag = doc.getElementById("sval-peek-tag");
  const chevron = tag.querySelector(".sval-peek-chevron");
  const main = doc.getElementById("sval-peek-open-main");
  Assert.ok(!chevron.checkVisibility(), "one peek's tag shows no chevron");

  await linkFromAnotherApp(QUICK_OTHER);
  await TestUtils.waitForCondition(
    () => tag.hasAttribute("several"),
    "the first peek's tag counts the second"
  );
  Assert.ok(
    tag.querySelector(".sval-peek-count").checkVisibility(),
    "the tag shows the count"
  );
  Assert.ok(chevron.checkVisibility(), "the tag shows the chevron");
  Assert.lessOrEqual(
    main.scrollWidth,
    main.clientWidth,
    "the open button shows all it holds"
  );
});

add_task(async function a_peek_opens_at_its_default_size() {
  Assert.deepEqual(
    firstPlace({ left: 0, top: 0, width: 2000, height: 1200 }),
    { left: 505, top: 144, width: 990, height: 723 },
    "49.5% of the screen's width, 73% as tall, 12% down"
  );
  Assert.deepEqual(
    firstPlace({ left: 0, top: 0, width: 1440, height: 875 }),
    { left: 324, top: 105, width: 792, height: 578 },
    "at least 792 wide on a small screen"
  );
  Assert.deepEqual(
    firstPlace({ left: 0, top: 0, width: 3000, height: 1000 }),
    { left: 928, top: 120, width: 1144, height: 800 },
    "at most 1144 wide, and short enough to leave room below"
  );

  forgetPlace();
  const win = await linkFromAnotherApp(QUICK_PAGE);
  const { screen } = win;
  const place = firstPlace({
    left: screen.availLeft,
    top: screen.availTop,
    width: screen.availWidth,
    height: screen.availHeight,
  });
  // A window's `width` and `height` attributes size its inside: Gecko adds
  // the frame's own (`GetOuterToInnerSizeDifferenceInCSSPixels` in
  // `AppWindow::OnChromeLoaded`), which on Windows holds the resize borders.
  await TestUtils.waitForCondition(
    () => win.innerWidth === place.width && win.innerHeight === place.height,
    `the peek opens ${place.width} by ${place.height}`
  );
});
