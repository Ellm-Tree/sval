/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_private_helpers.js */

/**
 * A Peek opened from a private window is a private Peek inside that window's
 * session: in its jar, with nothing of it saved, opening into that window
 * alone, listing and reopening only the Peeks of its session, and closing
 * with the window it came from.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_private_helpers.js",
  this
);

const { SvalPeek } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPeek.sys.mjs"
);
const { PlacesTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PlacesTestUtils.sys.mjs"
);

const PEEK_PAGE = "https://example.com/browser/?private-peek";
const OTHER = "https://example.com/browser/?private-peek-other";
const NORMAL_PAGE = "https://example.com/browser/?normal-peek";

add_setup(privateSetup);

/**
 * A private window, closed when the task ends.
 *
 * @returns {Promise<Window>}
 */
async function privateHost() {
  const win = await openPrivate();
  atTaskEnd(() => closePrivate(win));
  return win;
}

/**
 * Forgets every closed Peek kept for reopening, as clearing history does, so
 * a task finds only the ones it closed.
 */
function forgetClosedPeeks() {
  Services.obs.notifyObservers(null, "browser:purge-session-history");
}

/**
 * Runs `open`, and returns the Peek it opens once the Peek has started,
 * closed when the task ends.
 *
 * @param {Function} open
 * @returns {Promise<Window>}
 */
async function peekFrom(open) {
  const opened = BrowserTestUtils.domWindowOpenedAndLoaded();
  open();
  const win = await within(opened, 20_000, "the Peek");
  Assert.ok(SvalPeek.isPeek(win), "a Peek opened");
  await TestUtils.waitForCondition(
    () => SvalPeek.windows().includes(win) && tagOf(win).title,
    "the Peek has started"
  );
  atTaskEnd(async () => {
    if (!win.closed) {
      await within(
        BrowserTestUtils.closeWindow(win),
        10_000,
        "the Peek closing"
      );
    }
  });
  return win;
}

/**
 * Loads `url` in a Peek's page.
 *
 * @param {Window} win A Peek.
 * @param {string} url
 */
async function showIn(win, url) {
  const browser = win.gBrowser.selectedBrowser;
  BrowserTestUtils.startLoadingURIString(browser, url);
  await pageReady(browser, url);
}

function tagOf(win) {
  return win.document.getElementById("sval-peek-tag");
}

/**
 * @param {Window} win A Peek.
 * @returns {Promise<number>} how many Peeks its switcher lists.
 */
async function switcherOf(win) {
  const switcher = win.document.getElementById("sval-peek-switcher");
  await uncovered(win);
  const shown = BrowserTestUtils.waitForPopupEvent(switcher, "shown");
  tagOf(win).click();
  await within(shown, 10_000, "the switcher");
  const count = switcher.querySelectorAll(".sval-peek-switcher-row").length;
  const hidden = BrowserTestUtils.waitForPopupEvent(switcher, "hidden");
  switcher.hidePopup();
  await within(hidden, 10_000, "the switcher closing");
  return count;
}

add_task(async function new_peek_from_a_private_window_is_in_its_session() {
  const host = await privateHost();
  const jar = jarOf(host);
  const before = Object.keys(await privateTree(host)).length;

  const popup = host.document.getElementById("menu_FilePopup");
  popup.dispatchEvent(new host.Event("popupshowing"));
  const item = host.document.getElementById("sval-menu-new-peek");
  const peek = await peekFrom(() => item.doCommand());

  Assert.ok(PrivateBrowsingUtils.isWindowPrivate(peek), "it is private");
  Assert.equal(
    peek.gBrowser.selectedTab.userContextId,
    jar,
    "in the jar of the private window it came from"
  );
  Assert.equal(
    peek.gBrowser.defaultUserContextId,
    jar,
    "which a tab opened in it takes too"
  );
  Assert.ok(tagOf(peek).hasAttribute("private"), "its tag is marked private");

  await showIn(peek, PEEK_PAGE);
  Assert.equal(
    Object.keys(await privateTree(host)).length,
    before,
    "its page is no tab of the private window"
  );
  Assert.ok(
    !(await PlacesTestUtils.isPageInDB(PEEK_PAGE)),
    "and no visit is recorded"
  );
  await assertProfileTreeClean(["private-peek"]);

  const viaKey = await peekFrom(() =>
    EventUtils.synthesizeKey("n", { accelKey: true, altKey: true }, host)
  );
  Assert.equal(jarOf(viaKey), jar, "the shortcut opens one in the session");
  const viaLauncher = await peekFrom(() => SvalPeek.openEmpty(peek));
  Assert.equal(
    jarOf(viaLauncher),
    jar,
    "and so does New Peek asked for in a private Peek"
  );
});

add_task(async function a_private_peek_opens_into_its_private_window_alone() {
  const host = await privateHost();
  const peek = await peekFrom(() => SvalPeek.openEmpty(host));
  await showIn(peek, PEEK_PAGE);
  await SpecialPowers.spawn(peek.gBrowser.selectedBrowser, [], () => {
    content.wrappedJSObject.svalMark = "kept";
  });

  const doc = peek.document;
  const main = doc.getElementById("sval-peek-open-main");
  await TestUtils.waitForCondition(
    () => main.dataset.private === "true",
    "the open button is the private window's"
  );
  Assert.ok(!doc.getElementById("sval-peek-open").hidden, "it is shown");
  Assert.ok(
    doc.getElementById("sval-peek-open-more").hidden,
    "with no menu of Workspaces"
  );
  Assert.equal(main.dataset.workspace, "", "and it names no Workspace");

  const normalTabs = gBrowser.tabs.length;
  const closed = BrowserTestUtils.domWindowClosed(peek);
  main.click();
  await within(closed, 10_000, "the Peek closing");

  const tab = host.gBrowser.selectedTab;
  Assert.equal(
    tab.linkedBrowser.currentURI.spec,
    PEEK_PAGE,
    "the page moved in"
  );
  Assert.equal(
    await SpecialPowers.spawn(
      tab.linkedBrowser,
      [],
      () => content.wrappedJSObject.svalMark
    ),
    "kept",
    "as it was, with no reload"
  );
  Assert.equal(gBrowser.tabs.length, normalTabs, "no normal window took it");
  await TestUtils.waitForCondition(
    async () => host.SvalPanel.observer.nodeIdFor(tab),
    "the private window files it as its tab"
  );
  await assertProfileTreeClean(["private-peek"]);
});

add_task(async function a_closed_private_peek_reopens_in_its_session_only() {
  forgetClosedPeeks();
  const host = await privateHost();
  const jar = jarOf(host);
  const kept = await peekFrom(() => SvalPeek.openEmpty(host));
  const closing = await peekFrom(() => SvalPeek.openEmpty(host));
  await showIn(closing, PEEK_PAGE);
  await within(
    BrowserTestUtils.closeWindow(closing),
    10_000,
    "a private Peek closing"
  );

  const normal = await peekFrom(() => SvalPeek.openEmpty(window));
  Assert.ok(
    !SvalPeek.reopenClosed(normal),
    "a normal Peek has no closed private Peek to reopen"
  );
  const otherHost = await privateHost();
  const stranger = await peekFrom(() => SvalPeek.openEmpty(otherHost));
  Assert.ok(
    !SvalPeek.reopenClosed(stranger),
    "nor has a Peek of another private session"
  );

  const opened = BrowserTestUtils.domWindowOpenedAndLoaded();
  Assert.ok(SvalPeek.reopenClosed(kept), "a Peek of its session reopens it");
  const back = await within(opened, 20_000, "the reopened Peek");
  atTaskEnd(
    () =>
      !back.closed &&
      within(BrowserTestUtils.closeWindow(back), 10_000, "it closing")
  );
  await committed(() => back.gBrowser?.selectedBrowser, PEEK_PAGE);
  Assert.ok(PrivateBrowsingUtils.isWindowPrivate(back), "as a private Peek");
  Assert.equal(jarOf(back), jar, "in the same session");

  // The session's end forgets what it closed.
  await showIn(back, OTHER);
  await within(
    BrowserTestUtils.closeWindow(back),
    10_000,
    "the reopened Peek closing"
  );
  await within(
    BrowserTestUtils.closeWindow(kept),
    10_000,
    "the other Peek closing"
  );
  await closePrivate(host);
  const again = await openPrivate();
  atTaskEnd(() => closePrivate(again));
  const fresh = await peekFrom(() => SvalPeek.openEmpty(again));
  Assert.ok(
    !SvalPeek.reopenClosed(fresh),
    "a later session reopens nothing of an ended one"
  );
});

add_task(async function a_private_peek_lists_only_its_sessions_peeks() {
  const host = await privateHost();
  const first = await peekFrom(() => SvalPeek.openEmpty(host));
  const second = await peekFrom(() => SvalPeek.openEmpty(host));
  const normalOne = await peekFrom(() => SvalPeek.openEmpty(window));
  const normalTwo = await peekFrom(() => SvalPeek.openEmpty(window));
  const otherHost = await privateHost();
  const stranger = await peekFrom(() => SvalPeek.openEmpty(otherHost));
  await showIn(first, PEEK_PAGE);
  await showIn(normalOne, NORMAL_PAGE);

  const countOn = win =>
    tagOf(win).querySelector(".sval-peek-count").textContent;
  await TestUtils.waitForCondition(
    () => countOn(first) === "2" && countOn(normalOne) === "2",
    "each tag counts its own kind"
  );
  Assert.equal(countOn(second), "2", "a private Peek counts its session's");
  Assert.equal(countOn(normalTwo), "2", "a normal Peek counts the normal ones");
  Assert.equal(countOn(stranger), "1", "another session's Peek counts itself");
  Assert.ok(
    !tagOf(stranger).hasAttribute("several"),
    "and has no switcher to open"
  );
  Assert.equal(await switcherOf(first), 2, "a private Peek lists its two");
  Assert.equal(await switcherOf(normalOne), 2, "a normal Peek lists its two");
});

add_task(async function a_tab_a_private_peek_opens_is_a_peek_in_its_session() {
  const host = await privateHost();
  const jar = jarOf(host);
  const peek = await peekFrom(() => SvalPeek.openEmpty(host));
  await showIn(peek, PEEK_PAGE);

  const opened = BrowserTestUtils.domWindowOpenedAndLoaded();
  // What a `target=_blank` link and a Ctrl/Cmd-click both do.
  peek.openTrustedLinkIn(OTHER, "tab");
  const other = await within(opened, 20_000, "another Peek");
  atTaskEnd(
    () =>
      !other.closed &&
      within(BrowserTestUtils.closeWindow(other), 10_000, "it closing")
  );
  await committed(() => other.gBrowser?.selectedBrowser, OTHER);
  Assert.ok(SvalPeek.isPeek(other), "a Peek");
  Assert.ok(PrivateBrowsingUtils.isWindowPrivate(other), "a private one");
  Assert.equal(jarOf(other), jar, "in the same session and jar");
  Assert.equal(peek.gBrowser.tabs.length, 1, "the first keeps its one page");
  Assert.equal(
    peek.gBrowser.currentURI.spec,
    PEEK_PAGE,
    "which is still its own"
  );
  await TestUtils.waitForCondition(
    () => tagOf(other).hasAttribute("private"),
    "and it is marked private"
  );
});

add_task(async function a_private_windows_peeks_close_with_it() {
  forgetClosedPeeks();
  const host = await openPrivate();
  const mine = await peekFrom(() => SvalPeek.openEmpty(host));
  const alsoMine = await peekFrom(() => SvalPeek.openEmpty(host));
  const normal = await peekFrom(() => SvalPeek.openEmpty(window));
  const otherHost = await privateHost();
  const stranger = await peekFrom(() => SvalPeek.openEmpty(otherHost));

  const closed = Promise.all([
    BrowserTestUtils.domWindowClosed(mine),
    BrowserTestUtils.domWindowClosed(alsoMine),
  ]);
  await closePrivate(host);
  await within(closed, 10_000, "the private window's Peeks closing");
  Assert.ok(!normal.closed, "a normal Peek stays");
  Assert.ok(!stranger.closed, "and so does another session's");
  Assert.ok(
    !SvalPeek.reopenClosed(normal) && !SvalPeek.reopenClosed(stranger),
    "and nothing of the ended session is kept to reopen"
  );
});

add_task(async function a_link_from_another_app_opens_a_normal_peek() {
  // With a private window open and used last.
  await privateHost();
  const opened = BrowserTestUtils.waitForNewWindow({ url: NORMAL_PAGE });
  runCommandLine(["-url", NORMAL_PAGE]);
  const peek = await within(opened, 20_000, "the Peek");
  atTaskEnd(
    () =>
      !peek.closed &&
      within(BrowserTestUtils.closeWindow(peek), 10_000, "the Peek closing")
  );
  Assert.ok(SvalPeek.isPeek(peek), "a Peek");
  Assert.ok(!PrivateBrowsingUtils.isWindowPrivate(peek), "a normal one");
  Assert.ok(!tagOf(peek).hasAttribute("private"), "marked as a Peek");
});
