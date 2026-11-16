/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * about:privatebrowsing is the private window's home page. Typed into a normal
 * window, it opens in a new private window, and the tab it was typed into
 * goes back to its page, or closes if it had none. Typed into a private
 * window, it stays where it was typed.
 */

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);

const PRIVATE_PAGE = "about:privatebrowsing";

/**
 * Types `address` into `win`'s address bar and presses Enter, as the user
 * does.
 *
 * @param {Window} win
 * @param {string} address
 */
async function typeAddress(win, address) {
  await within(
    UrlbarTestUtils.promiseAutocompleteResultPopup({
      window: win,
      value: address,
    }),
    10_000,
    "the address bar's results"
  );
  EventUtils.synthesizeKey("KEY_Enter", {}, win);
}

/**
 * Types about:privatebrowsing into `win` and resolves with the private window
 * it opens, once that window shows the private page and its panel is up.
 *
 * @param {Window} win
 * @returns {Promise<Window>}
 */
async function typePrivatePageAndGetItsWindow(win) {
  const opened = BrowserTestUtils.waitForNewWindow({ url: PRIVATE_PAGE });
  await typeAddress(win, PRIVATE_PAGE);
  const privateWin = await within(opened, 20_000, "a private window opening");
  await within(
    privateWin.SvalPanel.started,
    10_000,
    "the private window's panel startup"
  );
  Assert.ok(
    PrivateBrowsingUtils.isWindowPrivate(privateWin),
    "the window it opens is private"
  );
  const browser = privateWin.gBrowser.selectedBrowser;
  is(browser.currentURI.spec, PRIVATE_PAGE, "and shows the private page");
  ok(
    await SpecialPowers.spawn(browser, [], () =>
      content.document.documentElement.classList.contains("private")
    ),
    "in the private palette"
  );
  return privateWin;
}

add_task(async function typed_over_a_page_it_opens_privately_and_goes_back() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE),
    15_000,
    "a tab loading a page"
  );
  const privateWin = await typePrivatePageAndGetItsWindow(window);

  await committed(tab.linkedBrowser, PAGE);
  ok(gBrowser.tabs.includes(tab), "and stays open");

  await within(
    BrowserTestUtils.closeWindow(privateWin),
    20_000,
    "the private window's closing"
  );
});

add_task(async function typed_into_a_tab_with_no_history_it_closes_the_tab() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser),
    10_000,
    "a blank tab opening"
  );
  const tabsBefore = gBrowser.tabs.length;
  const closed = BrowserTestUtils.waitForTabClosing(tab);
  const privateWin = await typePrivatePageAndGetItsWindow(window);
  await within(closed, 10_000, "the tab closing");
  is(gBrowser.tabs.length, tabsBefore - 1, "the tab is gone");

  await within(
    BrowserTestUtils.closeWindow(privateWin),
    20_000,
    "the private window's closing"
  );
});

add_task(async function typed_into_a_windows_only_blank_tab_it_shows_home() {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    20_000,
    "a normal window opening"
  );
  await within(win.SvalPanel.started, 10_000, "its panel startup");
  const blank = await within(
    BrowserTestUtils.openNewForegroundTab(win.gBrowser),
    10_000,
    "a blank tab opening"
  );
  for (const other of win.gBrowser.tabs.filter(t => t !== blank)) {
    BrowserTestUtils.removeTab(other);
  }
  is(win.gBrowser.tabs.length, 1, "the blank tab is the window's only tab");

  const closed = BrowserTestUtils.waitForTabClosing(blank);
  const privateWin = await typePrivatePageAndGetItsWindow(win);
  await within(closed, 10_000, "the typed-into tab closing");

  ok(!win.closed, "the normal window stays open");
  is(win.gBrowser.tabs.length, 1, "with one tab");
  const browser = win.gBrowser.selectedBrowser;
  await committed(browser, win.BROWSER_NEW_TAB_URL);
  ok(
    !PrivateBrowsingUtils.isWindowPrivate(win),
    "and the window is still a normal one"
  );

  await within(
    BrowserTestUtils.closeWindow(privateWin),
    20_000,
    "the private window's closing"
  );
  await within(
    BrowserTestUtils.closeWindow(win),
    20_000,
    "the normal window's closing"
  );
});

add_task(async function typed_in_a_private_window_it_stays_put() {
  const privateWin = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20_000,
    "a private window opening"
  );
  await within(
    privateWin.SvalPanel.started,
    10_000,
    "the private window's panel startup"
  );
  const browser = privateWin.gBrowser.selectedBrowser;
  const pageLoaded = BrowserTestUtils.browserLoaded(browser, false, PAGE);
  BrowserTestUtils.startLoadingURIString(browser, PAGE);
  await within(pageLoaded, 15_000, "the page loading");

  const windowsBefore = [...Services.wm.getEnumerator("navigator:browser")];
  const tabsBefore = privateWin.gBrowser.tabs.length;
  await typeAddress(privateWin, PRIVATE_PAGE);
  await committed(browser, PRIVATE_PAGE);
  // The page tells the parent it is shown at `pageshow`, which fires in the
  // task that completes its load. A question it asks after that is answered
  // after the parent has decided, since one actor's messages arrive in order.
  await SpecialPowers.spawn(browser, [], async () => {
    await ContentTaskUtils.waitForCondition(
      () => content.document.readyState === "complete",
      "the page is shown"
    );
    const answered = new Promise(resolve =>
      content.addEventListener(
        "SvalHomeSearchService",
        e => e.detail?.type === "Paste" && resolve()
      )
    );
    content.dispatchEvent(
      new content.CustomEvent("SvalHomeSearch", {
        detail: Cu.cloneInto({ type: "Paste", data: "x" }, content),
      })
    );
    await answered;
  });

  Assert.deepEqual(
    [...Services.wm.getEnumerator("navigator:browser")],
    windowsBefore,
    "no window opens"
  );
  is(browser.currentURI.spec, PRIVATE_PAGE, "the tab keeps the private page");
  is(privateWin.gBrowser.tabs.length, tabsBefore, "and no tab closes");

  await within(
    BrowserTestUtils.closeWindow(privateWin),
    20_000,
    "the private window's closing"
  );
});
