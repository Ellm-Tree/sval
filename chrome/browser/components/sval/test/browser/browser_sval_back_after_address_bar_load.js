/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// A page loaded from the address bar counts as user interaction with the page
// it leaves (browser.navigation.requireUserInteraction), so Back returns to
// that page. The mark is set in the parent when the load starts, so it holds
// when the old page's content process is running a script at Enter, whether
// the new page loads in another process or in the same one.

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);

const PATH = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  ""
);
const PAGE_A = `https://example.com${PATH}sval_javascript_page.html`;
const CROSS_SITE = `https://example.org${PATH}sval_javascript_page.html`;
const SAME_SITE = `https://www.example.com${PATH}sval_javascript_page.html`;
const BUSY_MS = 1500;
const BUSY_ROUNDS = 3;

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.navigation.requireUserInteraction", true]],
  });
});

async function loadFromAddressBarAndGoBack(target, { busy }) {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE_A),
    15_000,
    "the new tab opening and loading"
  );
  const browser = tab.linkedBrowser;
  const pidA = browser.browsingContext.currentWindowGlobal.osPid;
  if (busy) {
    // The loop starts as soon as the task returns, and holds A's content
    // process past Enter.
    await SpecialPowers.spawn(browser, [BUSY_MS], ms => {
      content.setTimeout(() => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          // A heavy script on the page.
        }
      }, 0);
    });
  }
  const loaded = BrowserTestUtils.browserLoaded(browser, false, target);
  await UrlbarTestUtils.promiseAutocompleteResultPopup({
    window,
    value: target,
  });
  EventUtils.synthesizeKey("KEY_Enter");
  await within(loaded, 10_000, `${target} to load`);

  const sh = browser.browsingContext.sessionHistory;
  const switched = browser.browsingContext.currentWindowGlobal.osPid != pidA;
  Assert.equal(sh.count, 2, "A and B are in session history");
  Assert.ok(
    sh.getEntryAtIndex(0).hasUserInteraction,
    "the page the address bar load left is marked"
  );
  Assert.ok(
    !sh.getEntryAtIndex(1).hasUserInteraction,
    "the page the address bar load created is not marked"
  );
  Assert.ok(gBrowser.canGoBack, "Back is enabled");
  if (gBrowser.canGoBack) {
    const back = BrowserTestUtils.waitForLocationChange(gBrowser, PAGE_A);
    BrowserCommands.back();
    await within(back, 10_000, "Back to reach A");
  }
  BrowserTestUtils.removeTab(tab);
  return switched;
}

add_task(async function back_after_cross_site_load_from_a_busy_page() {
  for (let i = 0; i < BUSY_ROUNDS; i++) {
    const switched = await loadFromAddressBarAndGoBack(CROSS_SITE, {
      busy: true,
    });
    Assert.ok(switched, "the cross-site load switches process");
  }
});

add_task(async function back_after_same_site_load_from_a_busy_page() {
  for (let i = 0; i < BUSY_ROUNDS; i++) {
    const switched = await loadFromAddressBarAndGoBack(SAME_SITE, {
      busy: true,
    });
    Assert.ok(!switched, "the same-site load stays in its process");
  }
});

add_task(async function back_after_cross_site_load_from_an_idle_page() {
  Assert.ok(
    await loadFromAddressBarAndGoBack(CROSS_SITE, { busy: false }),
    "the cross-site load switches process"
  );
});

add_task(async function back_after_same_site_load_from_an_idle_page() {
  Assert.ok(
    !(await loadFromAddressBarAndGoBack(SAME_SITE, { busy: false })),
    "the same-site load stays in its process"
  );
});
