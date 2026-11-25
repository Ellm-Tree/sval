/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * Quick Peek (link routing spec §5) in a real window: what an Alt-click on a
 * link shows, what closes the Quick Peek, and what keeping it as a tab or a split
 * leaves in the window and in the tree, which every other device reads.
 */

const { SvalQuickPeek } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalQuickPeek.sys.mjs"
);
const SvalPanelModel = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);
const SvalTree = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTree.sys.mjs"
);

/** A page of links, among them `#link` to QUICK_PEEKED. */
const LINKS_PAGE = ROOT + "sval_quick_peek_links.html";
const QUICK_PEEKED = PAGE2;

/** The workspace the window shows. */
let home = null;

add_setup(failOnConsoleErrors);

/**
 * The window's own panel, engine and tab observer, showing a workspace of
 * this file's own, so the tabs a task counts are this file's and what is
 * asserted is the real panel and observer.
 */
add_setup(async function () {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  home = await SvalPanel.engine.mutate({
    kind: "addWorkspace",
    name: "Home",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  expectWorkspaceTabs();
  Assert.ok(
    await within(
      SvalWindowWorkspace.of(window).switchTo(home),
      10_000,
      "the switch to Home"
    ),
    "the window shows this file's workspace"
  );
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "the observer filing the switch's tabs"
  );

  registerCleanupFunction(() => {
    Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed");
    gBrowser.defaultUserContextId = 0;
  });
});

/** @returns {Promise<object>} the tree's nodes once the window is quiet. */
async function settledNodes() {
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  return (await SvalPanel.engine.tree()).nodes ?? {};
}

/**
 * Deletes the nodes of `ids` when the task ends. The harness takes a task's
 * tabs out of the window without closing them as a person does, so their
 * nodes stay.
 *
 * @param {Function} ids Answers the node ids, once the task has them.
 */
function forgetAtTaskEnd(ids) {
  atTaskEnd(async () => {
    const nodes = await settledNodes();
    const ops = ids()
      .filter(id => id && nodes[id])
      .map(id => ({ kind: "remove", id }));
    if (ops.length) {
      await SvalPanel.engine.mutate({ kind: "batch", ops, now: Date.now() });
    }
  });
}

/** @returns {Promise<{tab: object, id: string}>} a new tab on LINKS_PAGE. */
async function openLinks() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, LINKS_PAGE),
    10_000,
    "the page of links opening"
  );
  await settledNodes();
  const id = SvalPanel.observer.nodeIdFor(tab);
  forgetAtTaskEnd(() => [id]);
  return { tab, id };
}

/**
 * Alt-clicks link `selector` in `browser`'s page, as a person does, and
 * waits for the Quick Peek to show `url` loaded.
 *
 * @param {object} browser
 * @param {object} [options]
 * @param {string} [options.selector]
 * @param {string} [options.url]
 * @returns {Promise<object>} the Quick Peek's tab.
 */
async function quickPeekAt(
  browser,
  { selector = "#link", url = QUICK_PEEKED } = {}
) {
  await BrowserTestUtils.synthesizeMouseAtCenter(
    selector,
    { altKey: true },
    browser
  );
  await TestUtils.waitForCondition(
    () => SvalQuickPeek.tabOf(window),
    "a Quick Peek opens"
  );
  const quickPeek = SvalQuickPeek.tabOf(window);
  await TestUtils.waitForCondition(
    () =>
      quickPeek.linkedBrowser?.currentURI.spec === url &&
      !quickPeek.hasAttribute("busy"),
    "the Quick Peek's page loads"
  );
  return quickPeek;
}

/**
 * @param {object} quickPeek A Quick Peek's tab.
 * @returns {Element} its card, the panel over the content area.
 */
function cardOf(quickPeek) {
  return document.getElementById(quickPeek.linkedPanel);
}

/**
 * @param {object} quickPeek A Quick Peek's tab.
 * @param {string} name "copy", "split", "tab" or "close".
 * @returns {Element} that button of the Quick Peek's bar.
 */
function buttonOf(quickPeek, name) {
  return cardOf(quickPeek).querySelector(`.sval-quick-peek-${name}`);
}

/**
 * Waits until no Quick Peek is open and `quickPeek`'s tab is gone.
 *
 * @param {object} quickPeek A Quick Peek's tab.
 * @param {string} what
 */
async function untilClosed(quickPeek, what) {
  await TestUtils.waitForCondition(
    () => !SvalQuickPeek.tabOf(window) && !quickPeek.linkedBrowser,
    what
  );
}

/**
 * The tab nodes that hold the quick-peeked page, which every other device would
 * show. Counted by page, because the window's other tabs are filed as their
 * own pages commit, whenever that is.
 *
 * @returns {Promise<number>}
 */
async function quickPeekedNodeCount() {
  return Object.values(await settledNodes()).filter(
    node => node.kind === SvalTree.TAB && node.content?.url === QUICK_PEEKED
  ).length;
}

/**
 * Marks the page in `browser`, so a reload, which loses the mark, shows.
 *
 * @param {object} browser
 */
function markPage(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    content.wrappedJSObject.quickPeekMark = "still here";
  });
}

/**
 * @param {object} browser
 * @returns {Promise<string|undefined>} the page's mark.
 */
function pageMark(browser) {
  return SpecialPowers.spawn(
    browser,
    [],
    () => content.wrappedJSObject.quickPeekMark
  );
}

add_task(async function an_alt_click_shows_the_link_over_the_tab() {
  const { tab } = await openLinks();
  const closedBefore = SessionStore.getClosedTabCountForWindow(window);

  const quickPeek = await quickPeekAt(tab.linkedBrowser);
  Assert.equal(gBrowser.selectedTab, tab, "the tab under it stays selected");
  Assert.equal(
    tab.linkedBrowser.currentURI.spec,
    LINKS_PAGE,
    "and stays on its page"
  );
  const card = cardOf(quickPeek);
  Assert.ok(BrowserTestUtils.isVisible(card), "the Quick Peek is on screen");
  Assert.equal(
    card.querySelector(".sval-quick-peek-host").textContent,
    "example.com",
    "its bar shows the page's address"
  );
  Assert.ok(
    BrowserTestUtils.isVisible(card.querySelector(".sval-quick-peek-shield")),
    "with the protection shield"
  );
  Assert.equal(
    buttonOf(quickPeek, "split").dataset.split,
    "new",
    "Open in Split says what it does"
  );
  Assert.ok(buttonOf(quickPeek, "split").title, "in its tooltip");
  await SimpleTest.promiseClipboardChange(
    quickPeek.linkedBrowser.currentURI.spec,
    () => EventUtils.synthesizeMouseAtCenter(buttonOf(quickPeek, "copy"), {})
  );
  // The Quick Peek's browser is made active as it shows, and the page hears of it
  // through a visibilitychange of its own, so its state is waited for.
  await TestUtils.waitForCondition(
    async () =>
      (await SpecialPowers.spawn(
        quickPeek.linkedBrowser,
        [],
        () => content.document.visibilityState
      )) === "visible",
    "the page is live, not a background tab"
  );
  Assert.equal(
    quickPeek.userContextId,
    tab.userContextId,
    "it uses the tab's sign-ins"
  );
  Assert.equal(
    SvalPanel.observer.nodeIdFor(quickPeek),
    null,
    "it is in no workspace"
  );
  Assert.equal(await quickPeekedNodeCount(), 0, "the tree gains no tab for it");

  EventUtils.synthesizeKey("KEY_Escape");
  await untilClosed(quickPeek, "Escape closes the Quick Peek");
  Assert.equal(gBrowser.selectedTab, tab, "the tab is back in front");
  Assert.ok(
    !gBrowser.tabpanels.hasAttribute("sval-quick-peek"),
    "with nothing dimmed"
  );
  Assert.ok(
    await PlacesUtils.history.hasVisits(QUICK_PEEKED),
    "the quick-peeked page is in History"
  );
  Assert.equal(
    SessionStore.getClosedTabCountForWindow(window),
    closedBefore,
    "and in no recently closed list"
  );
  Assert.equal(await quickPeekedNodeCount(), 0, "and no tab of it is left");
  await PlacesUtils.history.clear();
});

/**
 * A Quick Peek's card lies over the page, so in a coloured window it wears
 * the colour the window shows, opaque, where a see-through window's toolbar
 * is clear over its root (`sval-panel.css`, window tint).
 */
add_task(async function the_card_is_opaque_in_a_coloured_window() {
  const { SvalColor } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalColor.sys.mjs"
  );
  const shown = SvalPanel._tintArgs ?? [null];
  registerCleanupFunction(() => SvalPanel._applyWindowTint(...shown));

  const { tab } = await openLinks();
  const quickPeek = await quickPeekAt(tab.linkedBrowser);
  // The panel draws the window's look again as tabs come and go, so the
  // colour goes on once the Quick Peek is up.
  SvalPanel._applyWindowTint("purple", 0.4);
  const probe = document.createElement("div");
  probe.style.backgroundColor = SvalColor.css(
    SvalPanel.windowLookOf("purple", 0.4).tint
  );
  document.documentElement.append(probe);
  const tint = getComputedStyle(probe).backgroundColor;
  probe.remove();
  Assert.equal(
    getComputedStyle(cardOf(quickPeek)).backgroundColor,
    tint,
    "the card is the colour the window shows"
  );
  Assert.equal(
    InspectorUtils.colorToRGBA(tint).a,
    1,
    "which lets nothing through"
  );

  buttonOf(quickPeek, "close").click();
  await untilClosed(quickPeek, "the Quick Peek closing");
  SvalPanel._applyWindowTint(...shown);
});

/**
 * The Quick Peek's bar draws the loading line for its own page, whichever
 * tab the window shows under it.
 */
add_task(async function the_bar_draws_the_quick_peeks_load() {
  const { tab } = await openLinks();
  const quickPeek = await quickPeekAt(tab.linkedBrowser);
  const line = cardOf(quickPeek).querySelector(".sval-load-line");
  Assert.ok(!line.hasAttribute("loading"), "a loaded page draws no line");

  const key = crypto.randomUUID();
  const release = () => fetch(`${ROOT}sval_agent_slow.sjs?release=${key}`);
  atTaskEnd(release);
  BrowserTestUtils.startLoadingURIString(
    quickPeek.linkedBrowser,
    `${ROOT}sval_agent_slow.sjs?hold=${key}`
  );
  await TestUtils.waitForCondition(
    () => line.hasAttribute("loading"),
    "a loading page draws the line"
  );
  Assert.ok(
    !document.getElementById("sval-load-line").hasAttribute("loading"),
    "the address field's line stays with the tab under it"
  );

  await release();
  await TestUtils.waitForCondition(
    () => !quickPeek.hasAttribute("busy"),
    "the held page loading"
  );
  Assert.ok(!line.hasAttribute("loading"), "a finished load clears the line");

  EventUtils.synthesizeKey("KEY_Escape");
  await untilClosed(quickPeek, "Escape closes the Quick Peek");
  await PlacesUtils.history.clear();
});

/**
 * A Quick Peek opened while the switch to its tab is still finishing, here to a
 * site whose page loads in a process of its own, shows a live page once the
 * switch is done. The tab switcher unloads every tab nobody asked to see,
 * and the Quick Peek's tab is one nobody selected.
 */
add_task(async function a_quick_peek_opened_as_its_tab_shows_stays_live() {
  const { tab } = await openLinks();
  const url = QUICK_PEEKED.replace("://example.com/", "://example.org/");
  const quickPeek = await quickPeekAt(tab.linkedBrowser, {
    selector: "#elsewhere",
    url,
  });
  await switchDone();
  await TestUtils.waitForCondition(
    async () =>
      (await SpecialPowers.spawn(
        quickPeek.linkedBrowser,
        [],
        () => content.document.visibilityState
      )) === "visible",
    "the page is live, not a background tab"
  );
  Assert.ok(quickPeek.linkedBrowser.docShellIsActive, "and renders");
  EventUtils.synthesizeKey("KEY_Escape");
  await untilClosed(quickPeek, "Escape closes the Quick Peek");
  await PlacesUtils.history.clear();
});

add_task(async function plain_and_accel_clicks_open_no_quick_peek() {
  const { tab } = await openLinks();
  const opened = within(
    BrowserTestUtils.waitForNewTab(gBrowser, QUICK_PEEKED, true),
    10_000,
    "the link's new tab"
  );
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#link",
    { accelKey: true },
    tab.linkedBrowser
  );
  const other = await opened;
  Assert.equal(SvalQuickPeek.tabOf(window), null, "Ctrl/Cmd-click opens a tab");
  forgetAtTaskEnd(() => [SvalPanel.observer.nodeIdFor(other)]);

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
    "a plain click follows the link"
  );
});

add_task(async function with_quick_peek_off_an_alt_click_opens_nothing() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.sval.quickPeek.enabled", false]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const { tab } = await openLinks();
  let opened = 0;
  const count = () => opened++;
  gBrowser.tabContainer.addEventListener("TabOpen", count);
  atTaskEnd(() => gBrowser.tabContainer.removeEventListener("TabOpen", count));

  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#link",
    { altKey: true },
    tab.linkedBrowser
  );
  // A plain click after it: its page loading means the Alt-click has been
  // handled, as both reach the parent from the page in order.
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
    "the Alt-click opened no Quick Peek"
  );
  Assert.equal(opened, 0, "and no tab");
});

add_task(async function open_as_tab_keeps_the_page_right_after_the_tab() {
  const first = await openLinks();
  const second = await openLinks();
  await within(
    BrowserTestUtils.switchTab(gBrowser, first.tab),
    10_000,
    "the switch back"
  );
  const quickPeek = await quickPeekAt(first.tab.linkedBrowser);
  expectOpened(quickPeek);
  const browser = quickPeek.linkedBrowser;
  await markPage(browser);

  EventUtils.synthesizeMouseAtCenter(buttonOf(quickPeek, "tab"), {});
  await TestUtils.waitForCondition(
    () =>
      gBrowser.selectedTab === quickPeek &&
      SvalPanel.observer.nodeIdFor(quickPeek),
    "the page is a tab of its own, in front"
  );
  const id = SvalPanel.observer.nodeIdFor(quickPeek);
  forgetAtTaskEnd(() => [id]);
  const nodes = await settledNodes();
  const order = SvalTree.childrenByParent(nodes).get(home);
  Assert.deepEqual(
    order.filter(each => [first.id, id, second.id].includes(each)),
    [first.id, id, second.id],
    "right after the tab it came from"
  );
  Assert.ok(!quickPeek.hidden, "it is one of the window's tabs");
  Assert.ok(drawnIds().includes(id), "with its row in the panel");
  Assert.equal(quickPeek.linkedBrowser, browser, "the same page");
  Assert.equal(await pageMark(browser), "still here", "not reloaded");
  Assert.equal(
    quickPeek.userContextId,
    first.tab.userContextId,
    "in the workspace's jar"
  );
  Assert.ok(
    !gBrowser.tabpanels.hasAttribute("sval-quick-peek"),
    "and the content area is not dimmed"
  );
});

add_task(
  async function a_kept_quick_peek_follows_its_tab_not_the_selected_group() {
    const first = await openLinks();
    const second = await openLinks();
    const group = await SvalPanel.engine.mutate({
      kind: "addGroup",
      parent: home,
      name: "Reading",
      id: crypto.randomUUID(),
      now: Date.now(),
    });
    forgetAtTaskEnd(() => [group]);
    await SvalPanel.refresh();
    await within(
      BrowserTestUtils.switchTab(gBrowser, first.tab),
      10_000,
      "the switch back"
    );
    // A right-click on a group's row selects it for the menu, which is where a
    // new tab from a link goes from then on.
    const menu = await rightClickOpens(
      SvalPanel._rowElementFor(group),
      SvalPanel._els.contextMenu
    );
    const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
    menu.hidePopup();
    await within(hidden, 10_000, "the menu closing");
    Assert.equal(
      await SvalPanel._newTabParent(),
      group,
      "a new tab from a link would go in the group"
    );

    const quickPeek = await quickPeekAt(first.tab.linkedBrowser);
    expectOpened(quickPeek);
    EventUtils.synthesizeMouseAtCenter(buttonOf(quickPeek, "tab"), {});
    await TestUtils.waitForCondition(
      () =>
        gBrowser.selectedTab === quickPeek &&
        SvalPanel.observer.nodeIdFor(quickPeek),
      "the page is a tab of its own"
    );
    const id = SvalPanel.observer.nodeIdFor(quickPeek);
    forgetAtTaskEnd(() => [id]);
    const nodes = await settledNodes();
    Assert.equal(
      nodes[id].placement.parent,
      home,
      "the kept page is beside its tab, not in the selected group"
    );
    Assert.deepEqual(
      SvalTree.childrenByParent(nodes)
        .get(home)
        .filter(each => [first.id, id, second.id].includes(each)),
      [first.id, id, second.id],
      "right after the tab it came from"
    );
  }
);

/**
 * @param {object} nodes
 * @param {string} id A tab's id.
 * @returns {string[]} the panes of the split `id` is in, or none.
 */
function splitPanesOf(nodes, id) {
  const split = nodes[id]?.placement?.parent;
  return nodes[split]?.kind === SvalTree.SPLIT
    ? SvalTree.childrenByParent(nodes).get(split)
    : [];
}

/**
 * Quick Peeks from `owner` and keeps the page in a split.
 *
 * @param {object} owner The tab to Quick Peek from, a pane or not.
 * @returns {Promise<{quickPeek: object, id: string}>}
 */
async function keepInSplit(owner) {
  if (gBrowser.selectedTab !== owner) {
    await within(
      BrowserTestUtils.switchTab(gBrowser, owner),
      10_000,
      "the switch to the tab quick-peeked from"
    );
  }
  const quickPeek = await quickPeekAt(owner.linkedBrowser);
  expectOpened(quickPeek);
  await markPage(quickPeek.linkedBrowser);
  EventUtils.synthesizeMouseAtCenter(buttonOf(quickPeek, "split"), {});
  await TestUtils.waitForCondition(
    () =>
      SvalPanel.observer.nodeIdFor(quickPeek) &&
      quickPeek.splitview &&
      gBrowser.selectedTab === quickPeek,
    "the page is in a split, in front"
  );
  const id = SvalPanel.observer.nodeIdFor(quickPeek);
  forgetAtTaskEnd(() => [id]);
  Assert.equal(
    await pageMark(quickPeek.linkedBrowser),
    "still here",
    "the page was not reloaded"
  );
  return { quickPeek, id };
}

add_task(async function open_in_split_splits_until_the_split_is_full() {
  const { tab, id } = await openLinks();

  const kept = [await keepInSplit(tab)];
  let nodes = await settledNodes();
  Assert.deepEqual(
    splitPanesOf(nodes, id),
    [id, kept[0].id],
    "a tab in no split makes a split, the tab on the left"
  );
  Assert.deepEqual(
    tab.splitview?.tabs,
    [tab, kept[0].quickPeek],
    "and the window shows it"
  );

  kept.push(await keepInSplit(tab));
  kept.push(await keepInSplit(tab));
  nodes = await settledNodes();
  Assert.deepEqual(
    splitPanesOf(nodes, id),
    [id, ...kept.map(each => each.id)],
    "a split of two or three takes the page as its last pane"
  );
  Assert.equal(tab.splitview?.tabs.length, 4, "four pages on screen");

  await within(
    BrowserTestUtils.switchTab(gBrowser, tab),
    10_000,
    "the switch to the first pane"
  );
  const quickPeek = await quickPeekAt(tab.linkedBrowser);
  const split = buttonOf(quickPeek, "split");
  Assert.equal(
    split.getAttribute("aria-disabled"),
    "true",
    "a full split takes no more"
  );
  Assert.equal(split.dataset.split, "full", "and the button says why");
  // A person can still click it.
  AccessibilityUtils.setEnv({ mustBeEnabled: false });
  EventUtils.synthesizeMouseAtCenter(split, {});
  AccessibilityUtils.resetEnv();
  Assert.equal(
    SvalQuickPeek.tabOf(window),
    quickPeek,
    "clicking it keeps the Quick Peek"
  );
  EventUtils.synthesizeMouseAtCenter(buttonOf(quickPeek, "close"), {});
  await untilClosed(quickPeek, "the close button closes the Quick Peek");
  Assert.equal(tab.splitview?.tabs.length, 4, "the split is as it was");
});

add_task(async function a_quick_peek_closes_when_its_tab_goes() {
  const { tab } = await openLinks();
  const { tab: other } = await openLinks();

  await within(BrowserTestUtils.switchTab(gBrowser, tab), 10_000, "a switch");
  let quickPeek = await quickPeekAt(tab.linkedBrowser);
  const area = gBrowser.tabpanels.getBoundingClientRect();
  // The dim is the mouse's way out; the keyboard's is Escape.
  AccessibilityUtils.setEnv({ mustHaveAccessibleRule: false });
  EventUtils.synthesizeMouse(gBrowser.tabpanels, area.width / 2, 8, {});
  AccessibilityUtils.resetEnv();
  await untilClosed(quickPeek, "a click on the dim closes the Quick Peek");

  quickPeek = await quickPeekAt(tab.linkedBrowser);
  EventUtils.synthesizeMouseAtCenter(document.getElementById("nav-bar"), {});
  await untilClosed(quickPeek, "a click on the toolbar closes it");

  quickPeek = await quickPeekAt(tab.linkedBrowser);
  EventUtils.synthesizeKey("w", { accelKey: true });
  await untilClosed(quickPeek, "Close Tab's key closes the Quick Peek");
  Assert.ok(!tab.closing, "and leaves the tab under it open");
  Assert.equal(gBrowser.selectedTab, tab, "in front");

  quickPeek = await quickPeekAt(tab.linkedBrowser);
  await selectTab(other);
  await untilClosed(quickPeek, "showing another tab closes it");

  await within(BrowserTestUtils.switchTab(gBrowser, tab), 10_000, "a switch");
  quickPeek = await quickPeekAt(tab.linkedBrowser);
  await SpecialPowers.spawn(tab.linkedBrowser, [QUICK_PEEKED], url => {
    content.location = url;
  });
  await untilClosed(quickPeek, "the tab going to another page closes it");

  await within(BrowserTestUtils.switchTab(gBrowser, other), 10_000, "a switch");
  quickPeek = await quickPeekAt(other.linkedBrowser);
  BrowserTestUtils.removeTab(other);
  await untilClosed(quickPeek, "closing the tab closes it");
});

add_task(async function a_link_to_a_download_leaves_no_quick_peek() {
  const dir = await makeTempDir("sval-quick-peek-download");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.download.dir", dir],
      ["browser.download.folderList", 2],
      ["browser.download.useDownloadDir", true],
      ["browser.download.always_ask_before_handling_new_types", false],
      ["browser.download.alwaysOpenPanel", false],
    ],
  });
  const list = await Downloads.getList(Downloads.ALL);
  atTaskEnd(async () => {
    for (const download of await list.getAll()) {
      await download.finalize(true).catch(() => {});
      await list.remove(download);
    }
    await SpecialPowers.popPrefEnv();
  });
  const { tab } = await openLinks();
  const tabs = gBrowser.tabs.length;

  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#download",
    { altKey: true },
    tab.linkedBrowser
  );
  await TestUtils.waitForCondition(async () => {
    const downloads = await list.getAll();
    return downloads.some(
      d => d.succeeded && d.source.url.endsWith("?name=invite.ics")
    );
  }, "the file downloads");
  await TestUtils.waitForCondition(
    () => !SvalQuickPeek.tabOf(window) && gBrowser.tabs.length === tabs,
    "the Quick Peek opened for it closes"
  );
  Assert.equal(gBrowser.selectedTab, tab, "the tab clicked in is in front");
});

add_task(
  async function the_quick_peeked_pages_own_windows_open_as_firefox_opens_them() {
    const { tab } = await openLinks();
    const quickPeek = await quickPeekAt(tab.linkedBrowser, {
      selector: "#again",
      url: `${LINKS_PAGE}?again`,
    });

    // A popup opens over the window, and the Quick Peek stays.
    const popupOpened = BrowserTestUtils.waitForNewWindow({
      url: `${LINKS_PAGE}?popup`,
    });
    await BrowserTestUtils.synthesizeMouseAtCenter(
      "#popup",
      {},
      quickPeek.linkedBrowser
    );
    const popup = await within(popupOpened, 10_000, "the page's popup");
    Assert.equal(
      SvalQuickPeek.tabOf(window),
      quickPeek,
      "the Quick Peek stays open"
    );

    // A popup is no window to Quick Peek in: an Alt-click there does what it does.
    const popupBrowser = popup.gBrowser.selectedBrowser;
    await BrowserTestUtils.synthesizeMouseAtCenter(
      "#link",
      { altKey: true },
      popupBrowser
    );
    const loaded = BrowserTestUtils.browserLoaded(
      popupBrowser,
      false,
      QUICK_PEEKED
    );
    await BrowserTestUtils.synthesizeMouseAtCenter("#link", {}, popupBrowser);
    await within(loaded, 10_000, "the popup's plain click");
    Assert.equal(
      SvalQuickPeek.tabOf(popup),
      null,
      "no Quick Peek opens in a popup"
    );
    await within(
      BrowserTestUtils.closeWindow(popup),
      10_000,
      "the popup closing"
    );
    await within(SimpleTest.promiseFocus(window), 10_000, "the window's focus");

    // A link to a new tab opens one in the workspace, which closes the Quick Peek.
    const newTab = within(
      BrowserTestUtils.waitForNewTab(gBrowser, `${QUICK_PEEKED}?blank`),
      10_000,
      "the page's new tab"
    );
    await BrowserTestUtils.synthesizeMouseAtCenter(
      "#blank",
      {},
      quickPeek.linkedBrowser
    );
    const opened = await newTab;
    await untilClosed(quickPeek, "the new tab in front closes the Quick Peek");
    await settledNodes();
    const id = SvalPanel.observer.nodeIdFor(opened);
    forgetAtTaskEnd(() => [id]);
    Assert.ok(id, "the new tab is filed in the workspace");
  }
);

/**
 * Closing a window with a Quick Peek open closes the Quick Peek with it, with no error
 * logged (`failOnConsoleErrors`): the window, reopened from Recently Closed
 * Windows, brings back the tabs it showed and no hidden page.
 */
add_task(
  async function closing_a_window_with_a_quick_peek_takes_the_quick_peek() {
    // Handed an empty workspace, as the switcher hands one, the window keeps
    // its startup tab; on a workspace with tabs it lands on the last of them
    // and closes the startup tab (`SvalRestore`'s `isDebris`).
    const workspace = await SvalPanel.engine.mutate({
      kind: "addWorkspace",
      name: "",
      id: crypto.randomUUID(),
      now: Date.now(),
    });
    const opening = BrowserTestUtils.waitForNewWindow();
    SvalPanelModel.handWorkspaceTo(OpenBrowserWindow(), workspace);
    const win = await within(opening, 10_000, "a second window");
    expectWorkspaceTabs(win);
    await within(win.SvalPanel.started, 10_000, "its panel's startup");
    await within(win.SvalPanel.observer.settled(), 10_000, "observer settling");
    const browser = win.gBrowser.selectedBrowser;
    BrowserTestUtils.startLoadingURIString(browser, LINKS_PAGE);
    await pageReady(browser, LINKS_PAGE);
    await BrowserTestUtils.synthesizeMouseAtCenter(
      "#link",
      { altKey: true },
      browser
    );
    await committed(
      () => SvalQuickPeek.tabOf(win)?.linkedBrowser,
      QUICK_PEEKED
    );

    const shown = win.gBrowser.tabs
      .filter(tab => tab !== SvalQuickPeek.tabOf(win))
      .map(tab => tab.linkedBrowser.currentURI.spec);
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the window closing"
    );

    const [closed] = SessionStore.getClosedWindowData();
    const urls = closed.tabs.map(tab => tab.entries.at(-1)?.url);
    SessionStore.forgetClosedWindowById(closed.closedId);
    Assert.deepEqual(
      urls,
      shown,
      "the closed window keeps the tabs it showed, and not the Quick Peek's page"
    );
  }
);
