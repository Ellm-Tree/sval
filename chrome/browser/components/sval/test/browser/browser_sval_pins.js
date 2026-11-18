/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_pins_helpers.js */

/**
 * A pin's life (pins spec §5, §11): its icon is its tab, its page never in
 * the tab list; it stays where it was until the user takes it back; closing
 * resets it; and the row follows the workspace.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_pins_helpers.js",
  this
);

add_setup(pinsSetup);

/**
 * The modifier of Firefox's numbered tab keys, which pins take over: Alt on
 * GNOME, the accel key elsewhere (`NUM_SELECT_TAB_MODIFIER`).
 */
const NUMBER_KEY =
  document.getElementById("key_selectTab1").getAttribute("modifiers") === "alt"
    ? { altKey: true }
    : { accelKey: true };

/** @returns {Promise<{tab: object, id: string}>} a tab of the workspace. */
async function aTab() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE),
    10_000,
    "a tab opening"
  );
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  const id = SvalPanel.observer.nodeIdFor(tab);
  atTaskEnd(async () => {
    const nodes = (await SvalPanel.engine.tree()).nodes ?? {};
    if (nodes[id]) {
      await SvalPanel.engine.mutate({ kind: "remove", id, now: Date.now() });
    }
  });
  return { tab, id };
}

add_task(async function a_pins_page_is_its_tab_and_never_a_row() {
  const { tab } = await aTab();
  const guid = await pinFavorite(LINKS_PAGE, "Links");
  const tile = await untilPinShows(guid);
  Assert.ok(
    !tile.closest(".sval-pin-slot").hasAttribute("data-selected"),
    "a pin is not selected until it is clicked"
  );
  const before = (await tabNodes()).length;

  const page = await clickTile(guid, LINKS_PAGE);
  Assert.notStrictEqual(page, tab, "the pin's page is a tab of its own");
  Assert.equal((await tabNodes()).length, before, "the tab list is unchanged");
  Assert.ok(
    !(await tabNodes()).some(node => node.content?.url === LINKS_PAGE),
    "no row describes the pin's page"
  );
  const slot = tileOf(guid).closest(".sval-pin-slot");
  Assert.ok(slot.hasAttribute("data-selected"), "the pin shows selected");
  Assert.ok(slot.hasAttribute("data-wide"), "and wide");
  Assert.ok(
    !SvalPanel._els.tree.querySelector('[aria-selected="true"]'),
    "and no row is viewed"
  );
  Assert.ok(
    document.title.includes("Links / "),
    "the window's title names the pin"
  );

  // Coming back to a pin never resets it.
  await SpecialPowers.spawn(page.linkedBrowser, [], () => {
    content.wrappedJSObject.pinMark = "still here";
  });
  await selectTab(tab);
  await TestUtils.waitForCondition(
    () => !tileOf(guid).closest(".sval-pin-slot").hasAttribute("data-wide"),
    "with a tab selected, no pin is wide"
  );
  Assert.ok(
    SvalPanel._els.tree.querySelector('[aria-selected="true"]'),
    "the tab's row is viewed again"
  );
  Assert.equal(await clickTile(guid, LINKS_PAGE), page, "the same page shows");
  Assert.equal(
    await SpecialPowers.spawn(
      page.linkedBrowser,
      [],
      () => content.wrappedJSObject.pinMark
    ),
    "still here",
    "where it was left"
  );
  Assert.equal(pinTabs().length, 1, "one page for the pin");
});

/**
 * A collapsed group draws the tab being viewed under it. With a pin's page
 * on screen that tab is not viewed, so the group hides it.
 */
add_task(async function a_pins_page_hides_the_tab_a_collapsed_group_drew() {
  const { group } = await viewingAGroupedTab();
  const tab = gBrowser.selectedTab;
  const id = SvalPanel.observer.nodeIdFor(tab);
  const guid = await pinFavorite(LINKS_PAGE, "Links");
  await SvalPanel._setCollapsed(group, true);
  Assert.ok(drawnIds().includes(id), "the viewed tab shows under its group");

  await clickTile(guid, LINKS_PAGE);
  Assert.ok(!drawnIds().includes(id), "a pin's page on screen hides it");
  Assert.ok(drawnIds().includes(group), "and leaves its group drawn");

  await selectTab(tab);
  Assert.ok(drawnIds().includes(id), "back on the tab, its row shows again");
});

add_task(async function a_pin_off_its_page_goes_back_by_its_button() {
  const { tab } = await aTab();
  const guid = await pinFavorite(LINKS_PAGE, "Links");
  const page = await clickTile(guid, LINKS_PAGE);

  // Within its site, a link navigates the pin.
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#link",
    {},
    page.linkedBrowser
  );
  await TestUtils.waitForCondition(
    () =>
      page.linkedBrowser.currentURI.spec === PAGE2 &&
      !page.hasAttribute("busy"),
    "the link navigates the pin"
  );
  Assert.equal(gBrowser.selectedTab, page, "in the pin's own page");
  const slot = () => tileOf(guid).closest(".sval-pin-slot");
  await TestUtils.waitForCondition(
    () => slot().querySelector(".sval-pin-name")?.textContent === PAGE2_TITLE,
    "the wide tile names the page it is on"
  );
  const { keyOf, shortcutText } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalKeys.sys.mjs"
  );
  const number = slot().dataset.number;
  Assert.equal(
    tileOf(guid).title,
    `Links / Second page (${shortcutText(
      keyOf(document.getElementById(`key_selectTab${number}`))
    )})`,
    "its tooltip names the pin, the page and the key that selects it"
  );
  const refresh = slot().querySelector(".sval-pin-refresh");
  Assert.ok(
    refresh.getAttribute("aria-label").includes("Links"),
    "its refresh names the pin it goes back to"
  );

  // Off its page and not selected, the tile has its dot.
  await selectTab(tab);
  await TestUtils.waitForCondition(
    () => slot().hasAttribute("data-off") && !slot().hasAttribute("data-wide"),
    "a pin off its page shows so"
  );

  // A double-click from a tab only selects it.
  const tile = tileOf(guid);
  EventUtils.synthesizeMouse(tile, tile.getBoundingClientRect().width - 6, 20, {
    clickCount: 1,
  });
  await TestUtils.waitForCondition(
    () => slot().querySelector(".sval-pin-refresh"),
    "the first click selects the pin"
  );
  EventUtils.synthesizeMouseAtCenter(
    slot().querySelector(".sval-pin-refresh"),
    {
      clickCount: 2,
    }
  );
  Assert.equal(
    page.linkedBrowser.currentURI.spec,
    PAGE2,
    "the second click of the pair does not reset it"
  );

  // Pressed with the pin selected, the button takes it back.
  EventUtils.synthesizeMouseAtCenter(
    slot().querySelector(".sval-pin-refresh"),
    {}
  );
  await committed(page.linkedBrowser, LINKS_PAGE);
  await TestUtils.waitForCondition(
    () => !slot().hasAttribute("data-off"),
    "and the pin is on its page"
  );
});

add_task(async function closing_a_pin_resets_it_and_keeps_its_icon() {
  await aTab();
  const guid = await pinFavorite(LINKS_PAGE, "Links");
  const page = await clickTile(guid, LINKS_PAGE);
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#link",
    {},
    page.linkedBrowser
  );
  await committed(page.linkedBrowser, PAGE2);

  const closed = BrowserTestUtils.waitForTabClosing(page);
  EventUtils.synthesizeKey("w", { accelKey: true });
  await within(closed, 10_000, "the pin's page closing");
  Assert.strictEqual(selectedPinGuid(), null, "selection moves to a tab");
  Assert.ok(tileOf(guid), "the icon stays");
  Assert.ok(
    tileOf(guid).closest(".sval-pin-slot").hasAttribute("data-unloaded"),
    "and shows it is not loaded"
  );
  const again = await clickTile(guid, LINKS_PAGE);
  Assert.notStrictEqual(
    again,
    page,
    "the next click loads the saved address afresh"
  );
});

add_task(async function closing_a_tab_opened_from_a_pin_returns_to_the_pin() {
  await aTab();
  const guid = await pinFavorite(LINKS_PAGE, "Links");
  const page = await clickTile(guid, LINKS_PAGE);

  const opened = BrowserTestUtils.waitForEvent(
    gBrowser.tabContainer,
    "TabOpen"
  );
  SvalPanel.observer.openNewTab();
  const tab = (await within(opened, 10_000, "a new tab opening")).target;
  await switchDone(window);
  Assert.equal(gBrowser.selectedTab, tab, "the new tab is selected");

  const closed = BrowserTestUtils.waitForTabClosing(tab);
  EventUtils.synthesizeKey("w", { accelKey: true });
  await within(closed, 10_000, "the new tab closing");
  await switchDone(window);
  Assert.equal(gBrowser.selectedTab, page, "the pin's page is selected again");
  Assert.equal(selectedPinGuid(), guid, "and its tile shows it");
});

add_task(async function closing_a_tab_reopened_over_a_pin_returns_to_the_pin() {
  await aTab();
  const guid = await pinFavorite(LINKS_PAGE, "Links");
  const page = await clickTile(guid, LINKS_PAGE);

  let opened = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabOpen");
  SvalPanel.observer.openNewTab();
  const tab = (await within(opened, 10_000, "a new tab opening")).target;
  await switchDone(window);
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, PAGE2);
  await pageReady(tab.linkedBrowser, PAGE2);
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "the panel filing the tab"
  );
  let closed = BrowserTestUtils.waitForTabClosing(tab);
  EventUtils.synthesizeKey("w", { accelKey: true });
  await within(closed, 10_000, "the tab closing");
  await switchDone(window);
  Assert.equal(gBrowser.selectedTab, page, "closing it returns to the pin");

  opened = BrowserTestUtils.waitForEvent(gBrowser.tabContainer, "TabOpen");
  EventUtils.synthesizeKey("t", { accelKey: true, shiftKey: true });
  const reopened = (await within(opened, 10_000, "the tab reopening")).target;
  await switchDone(window);
  Assert.equal(gBrowser.selectedTab, reopened, "the reopened tab is selected");

  closed = BrowserTestUtils.waitForTabClosing(reopened);
  EventUtils.synthesizeKey("w", { accelKey: true });
  await within(closed, 10_000, "the reopened tab closing");
  await switchDone(window);
  Assert.equal(
    gBrowser.selectedTab,
    page,
    "closing the reopened tab returns to the pin too"
  );
  Assert.equal(selectedPinGuid(), guid, "and its tile shows it");
});

add_task(async function a_pin_limited_to_another_workspace_leaves_this_one() {
  await aTab();
  const { store, work } = pinsFixture;
  const mail = await pinFavorite(LINKS_PAGE, "Mail");
  const news = await pinFavorite(PAGE2, "News");
  await TestUtils.waitForCondition(
    () => rowGuids().join() === [mail, news].join(),
    "both pins show"
  );
  await store.setPinScope(mail, [work]);
  await TestUtils.waitForCondition(
    () => rowGuids().join() === news,
    "a pin limited to Work is not in Home"
  );

  // ⌘1 counts what shows here.
  EventUtils.synthesizeKey("1", NUMBER_KEY);
  await TestUtils.waitForCondition(
    () => selectedPinGuid() === news,
    "⌘1 selects the first pin that shows"
  );
  await TestUtils.waitForCondition(
    () => !gBrowser.selectedTab.hasAttribute("busy"),
    "its page loads"
  );
  EventUtils.synthesizeKey("2", NUMBER_KEY);
  Assert.equal(selectedPinGuid(), news, "and ⌘2 has no pin to select");
});

add_task(async function switching_workspace_keeps_where_a_pin_was() {
  await aTab();
  const { home, work } = pinsFixture;
  const guid = await pinFavorite(LINKS_PAGE, "Links");
  const page = await clickTile(guid, LINKS_PAGE);
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#link",
    {},
    page.linkedBrowser
  );
  await TestUtils.waitForCondition(
    () =>
      page.linkedBrowser.currentURI.spec === PAGE2 &&
      !page.hasAttribute("busy"),
    "the pin goes elsewhere in its site"
  );
  expectWorkspaceTabs();
  await SvalPanel.switchTo(work);
  Assert.notEqual(selectedPinGuid(), guid, "Work shows its own tab");
  Assert.ok(
    tileOf(guid).closest(".sval-pin-slot").hasAttribute("data-unloaded"),
    "the pin has no page in Work yet"
  );
  await SvalPanel.switchTo(home);
  Assert.equal(selectedPinGuid(), guid, "back in Home, the pin is selected");
  Assert.equal(gBrowser.selectedTab, page, "on the page it had");
  await TestUtils.waitForCondition(
    () =>
      gBrowser.selectedBrowser.currentURI.spec === PAGE2 &&
      !page.hasAttribute("busy"),
    "where it was"
  );
  Assert.ok(
    tileOf(guid).closest(".sval-pin-slot").hasAttribute("data-selected"),
    "its tile shows it selected"
  );
});

add_task(async function a_tab_chosen_after_a_pin_is_where_a_switch_returns() {
  const { tab } = await aTab();
  const { home, work } = pinsFixture;
  const guid = await pinFavorite(LINKS_PAGE, "Links");
  await clickTile(guid, LINKS_PAGE);
  await SvalPanel.activate(
    SvalPanel._rows.find(row => row.id === SvalPanel.observer.nodeIdFor(tab))
  );
  Assert.equal(gBrowser.selectedTab, tab, "the tab is chosen after the pin");
  expectWorkspaceTabs();
  await SvalPanel.switchTo(work);
  await SvalPanel.switchTo(home);
  Assert.equal(selectedPinGuid(), null, "back in Home, no pin is selected");
  Assert.equal(
    SvalPanel.observer.nodeIdFor(gBrowser.selectedTab),
    SvalPanel.observer.nodeIdFor(tab),
    "the tab chosen last is"
  );
});

add_task(async function moving_an_open_pin_to_favorites_makes_its_page_a_tab() {
  await aTab();
  const guid = await pinFavorite(LINKS_PAGE, "Links");
  const page = await clickTile(guid, LINKS_PAGE);
  await SvalPanel.pins.moveToFavoritesGuid(guid);
  await TestUtils.waitForCondition(() => !tileOf(guid), "the tile goes");
  const nodes = await tabNodes();
  const kept = nodes.find(node => node.content?.url === LINKS_PAGE);
  Assert.ok(kept, "the page is a tab now");
  Assert.equal(
    SvalPanel._rows.find(row => row.kind === "tab")?.id,
    SvalPanel.observer.nodeIdFor(page),
    "at the top of the tab list"
  );
  Assert.ok(!page.hidden, "and shown");
  Assert.equal(
    pinsFixture.store.get(guid)?.parentGuid,
    TOOLBAR,
    "the pin is a favorite now"
  );
  atTaskEnd(() => BrowserTestUtils.removeTab(page));
});

/**
 * The address bar lists an open pin as the pin, wearing the pin's mark
 * (launcher spec §5), and an ordinary open tab's row has no mark and says,
 * selected, that Enter switches to it.
 */
add_task(async function an_open_pins_address_bar_row_is_the_pin() {
  const { UrlbarTestUtils } = ChromeUtils.importESModule(
    "resource://testing-common/UrlbarTestUtils.sys.mjs"
  );
  UrlbarTestUtils.init(this);
  const { tab } = await aTab();
  const guid = await pinFavorite(LINKS_PAGE, "Links");
  await clickTile(guid, LINKS_PAGE);
  await selectTab(tab);
  await within(
    UrlbarTestUtils.promiseAutocompleteResultPopup({ window, value: "sval_" }),
    10_000,
    "the address bar's results"
  );
  const rowOf = async url => {
    for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
      const details = await UrlbarTestUtils.getDetailsOfResultAt(window, i);
      if (details.result.payload.url === url && !details.result.heuristic) {
        return details;
      }
    }
    return null;
  };
  const pin = await rowOf(LINKS_PAGE);
  Assert.equal(
    pin?.result.type,
    UrlbarUtils.RESULT_TYPE.URL,
    "the pin's page is offered as the pin"
  );
  // Its mark at the row's end (`SvalLauncherRows`).
  const mark = pin.element.row.querySelector(".sval-mark");
  Assert.equal(mark?.dataset.mark, "pin", "with the pin's mark");
  Assert.greater(mark.getBoundingClientRect().width, 0, "drawn");
  // Its keys, as a screen reader hears them (`SvalLauncherRows`).
  const { ariaShortcut } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalKeys.sys.mjs"
  );
  const option = pin.element.row.querySelector(".urlbarView-row-inner");
  await TestUtils.waitForCondition(
    () => option.hasAttribute("aria-description"),
    "the pin's row names its keys"
  );
  Assert.equal(
    option.getAttribute("aria-keyshortcuts"),
    ["shift", "accel,shift"]
      .map(modifiers => ariaShortcut({ keycode: "VK_RETURN", modifiers }))
      .join(" ")
  );
  Assert.equal(
    option.getAttribute("aria-description"),
    new Intl.ListFormat(Services.locale.appLocalesAsBCP47, {
      type: "unit",
    }).format(
      ["launcher-foot-new-tab", "launcher-foot-new-window"].map(id =>
        fluentText("sval/launcher.ftl", id)
      )
    ),
    "its keys open it in a new tab or a new window"
  );

  // An ordinary tab's row has no mark.
  const other = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE2),
    10_000,
    "an ordinary tab opening"
  );
  atTaskEnd(() => BrowserTestUtils.removeTab(other));
  // The tree has the tab's title, so "sval_" matches only its address and
  // its row is not the one Enter takes (launcher spec §5).
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  await selectTab(tab);
  await within(
    UrlbarTestUtils.promiseAutocompleteResultPopup({ window, value: "sval_" }),
    10_000,
    "the address bar's results again"
  );
  const plain = await rowOf(PAGE2);
  Assert.equal(plain?.result.type, UrlbarUtils.RESULT_TYPE.TAB_SWITCH);
  Assert.ok(
    !plain.element.row.querySelector(".sval-mark"),
    "an ordinary tab's row has no mark"
  );

  // Selected, the tab's row says that Enter switches to it.
  gURLBar.view.selectedRowIndex = Array.from(
    { length: UrlbarTestUtils.getResultCount(window) },
    (_, i) => UrlbarTestUtils.getRowAt(window, i)
  ).indexOf(plain.element.row);
  const verb = plain.element.row.querySelector(".sval-launcher-hint-verb");
  await TestUtils.waitForCondition(
    () => document.l10n.getAttributes(verb).id === "launcher-hint-switch-tab",
    "the tab's row says it switches"
  );
  await within(
    UrlbarTestUtils.promisePopupClose(window),
    10_000,
    "the results closing"
  );
  gURLBar.handleRevert();
});

add_task(async function more_pins_than_the_lines_hold_fold_into_plus_n() {
  await aTab();
  const width = SvalPanel._els.container.getBoundingClientRect().width;
  const { perLine } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalPinsModel.sys.mjs"
  );
  const room = perLine(width) * 4;
  const guids = [];
  for (let i = 0; i <= room; i++) {
    guids.push(await pinFavorite(`https://example.com/pin${i}`, `Pin ${i}`));
  }
  await TestUtils.waitForCondition(
    () => SvalPanel._els.pins.querySelector(".sval-pin-more"),
    "the last slot is +N"
  );
  const more = SvalPanel._els.pins.querySelector(".sval-pin-more");
  Assert.equal(more.textContent, "+2", "holding the two that do not fit");
  Assert.equal(rowGuids().length, room - 1);
  EventUtils.synthesizeMouseAtCenter(more, {});
  await TestUtils.waitForCondition(
    () => document.getElementById("sval-pins-popover")?.state === "open",
    "+N opens a popover"
  );
  const panel = document.getElementById("sval-pins-popover");
  Assert.deepEqual(
    panel.querySelector(".sval-pins-popover-title").textContent.match(/\d+/g),
    ["2"],
    "titled with how many more"
  );
  Assert.deepEqual(
    Array.from(panel.querySelectorAll("button[data-guid]")).map(
      tile => tile.dataset.guid
    ),
    guids.slice(-2),
    "of the hidden pins"
  );
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  panel.hidePopup();
  await within(hidden, 10_000, "the popover closing");
});

add_task(async function a_private_window_shows_no_pins() {
  const guid = await pinFavorite(LINKS_PAGE, "Links");
  await untilPinShows(guid);
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20_000,
    "a private window opening"
  );
  await TestUtils.waitForCondition(
    () => win.SvalPanel?._els?.pins,
    "the private window's panel is built"
  );
  Assert.ok(win.SvalPanel._els.pins.hidden, "with no pins row");
  Assert.equal(win.SvalPanel.pins, null);
  await within(
    BrowserTestUtils.closeWindow(win),
    20_000,
    "the private window closing"
  );
});

/**
 * A switch is one change (spec §10.7): a pin's page whose leave-this-page
 * dialog is up when the window switches workspace stays loaded, and the
 * window still shows the workspace it went to, in its switcher and its
 * colour.
 */
add_task(async function a_pin_asking_to_stay_does_not_halt_a_switch() {
  const { PromptTestUtils } = ChromeUtils.importESModule(
    "resource://testing-common/PromptTestUtils.sys.mjs"
  );
  await aTab();
  const { home, work } = pinsFixture;
  const guid = await pinFavorite(PAGE, "Asks");
  const page = await clickTile(guid, PAGE);
  await SpecialPowers.spawn(page.linkedBrowser, [], () => {
    content.onbeforeunload = event => event.preventDefault();
  });
  // The page has been used, so its handler may ask.
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "body",
    {},
    page.linkedBrowser
  );
  const asked = PromptTestUtils.waitForPrompt(page.linkedBrowser, {
    modalType: Services.prompt.MODAL_TYPE_CONTENT,
    promptType: "confirmEx",
  });
  const decided = page.linkedBrowser.asyncPermitUnload();
  const dialog = await within(asked, 10_000, "the page asks to stay");

  // Another tab of Home is shown, so the pin is one the switch parks.
  await selectTab(gBrowser.tabs.find(t => !t.hidden && t !== page));
  Assert.ok(await SvalPanel.switchTo(work), "the window switches");
  Assert.equal(SvalWindowWorkspace.of(window).id, work, "to Work");
  Assert.ok(page.linkedPanel, "the asking page stays loaded");

  // The switch leaves the page's own question for the user to answer. The
  // dialog is Firefox's own, whose buttons a headless window leaves
  // unfocusable to the accessibility API.
  AccessibilityUtils.setEnv({ focusableRule: false });
  await within(
    PromptTestUtils.handlePrompt(dialog),
    10_000,
    "the dialog closing once answered"
  );
  AccessibilityUtils.resetEnv();
  Assert.ok(
    (await within(decided, 10_000, "the page's answer")).permitUnload,
    "and the user's answer stands"
  );
  await SpecialPowers.spawn(page.linkedBrowser, [], () => {
    content.onbeforeunload = null;
  });
  await SvalPanel.switchTo(home);
});

/**
 * A pin's page that a switch keeps loaded, here for what was typed into it
 * (pins spec §14), belongs to the workspace it was left in, as a kept tab
 * does (spec §10.7): no key that steps through tabs, and no tab list, reaches
 * it from another workspace.
 */
add_task(async function a_pin_kept_loaded_is_out_of_reach_elsewhere() {
  await SpecialPowers.pushPrefEnv({
    clear: [["browser.engagement.ctrlTab.has-used"]],
  });
  await aTab();
  const { work } = pinsFixture;
  const INPUT = ROOT + "sval_agent_input.html";
  const guid = await pinFavorite(INPUT, "Typed");
  const page = await clickTile(guid, INPUT);
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#field",
    {},
    page.linkedBrowser
  );
  EventUtils.sendString("half a reply");
  await TestUtils.waitForCondition(
    () =>
      SpecialPowers.spawn(
        page.linkedBrowser,
        [],
        () => content.document.getElementById("field").value
      ).then(value => value === "half a reply"),
    "the pin's page holds what was typed"
  );
  expectWorkspaceTabs();
  Assert.ok(await SvalPanel.switchTo(work), "the window switches to Work");
  Assert.ok(page.linkedPanel, "the typed page stays loaded");
  const { tab: other } = await aTab();

  // Recently used order lists the tabs Ctrl+Tab goes to (`ctrlTab.tabList`),
  // and panel order steps through them with the keys below.
  const reached = new Set(window.ctrlTab.tabList);
  await SpecialPowers.pushPrefEnv({
    set: [["browser.ctrlTab.sortByRecentlyUsed", false]],
  });
  const keys = [
    ["KEY_Tab", { ctrlKey: true }],
    ["KEY_Tab", { ctrlKey: true, shiftKey: true }],
    ["KEY_PageDown", { ctrlKey: true }],
    ["KEY_PageUp", { ctrlKey: true }],
  ];
  for (const [key, modifiers] of keys) {
    for (let i = 0; i <= gBrowser.tabs.length; i++) {
      EventUtils.synthesizeKey(key, modifiers);
      reached.add(gBrowser.selectedTab);
    }
  }
  await SpecialPowers.popPrefEnv();
  Assert.ok(reached.has(other), "the keys step through Work's tabs");
  Assert.ok(!reached.has(page), "and never reach Home's pin");

  await selectTab(other);
  EventUtils.synthesizeKey("1", NUMBER_KEY);
  await TestUtils.waitForCondition(
    () => selectedPinGuid() === guid,
    "the first number key selects the pin"
  );
  Assert.notEqual(gBrowser.selectedTab, page, "with a page of Work's own");
  await selectTab(other);

  // The list of all tabs, which would offer hidden ones, opens from the tab
  // strip Sval hides (`gTabsPanel.canOpen`).
  gTabsPanel.init();
  Assert.ok(!gTabsPanel.canOpen, "and no list of all tabs opens to reach it");
});
