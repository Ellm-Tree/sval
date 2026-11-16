/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * One test per Firefox internal `SvalFirefox` names. After an ESR rebase a
 * failure here says which internal moved, in the one file that reaches it.
 */

const { SvalFirefox } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFirefox.sys.mjs"
);
const { PRESETS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalColor.sys.mjs"
);

const URL = "https://example.com/browser/";

/**
 * A lazy tab for `url`, made the way `SvalRestore` makes one.
 *
 * @param {string} url
 * @returns {object} the tab.
 */
function lazyTab(url) {
  const tab = gBrowser.addTrustedTab(null, {
    createLazyBrowser: true,
    skipLoad: true,
  });
  SessionStore.setTabState(tab, {
    entries: [
      { url, triggeringPrincipal_base64: E10SUtils.SERIALIZED_SYSTEMPRINCIPAL },
    ],
    index: 1,
  });
  return tab;
}

add_task(async function a_lazy_tab_is_lazy_and_says_what_it_is_for() {
  const tab = lazyTab(URL);
  try {
    Assert.ok(SvalFirefox.isLazy(tab), "a tab made lazily is lazy");
    Assert.equal(SvalFirefox.lazyUrl(tab), URL, "and is for its address");
    Assert.ok(!SvalFirefox.isLazy(gBrowser.selectedTab), "a shown tab is not");
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function a_loaded_tab_is_not_restoring() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, URL),
    15_000,
    "the new tab opening and loading"
  );
  const pending = lazyTab(URL);
  try {
    Assert.ok(!SvalFirefox.isRestoring(tab), "a tab that loaded is not");
    Assert.ok(!SvalFirefox.isRestoring(pending), "nor is a lazy one");
  } finally {
    BrowserTestUtils.removeTab(pending);
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function history_is_read_from_the_browser() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, URL),
    15_000,
    "the new tab opening and loading"
  );
  try {
    Assert.ok(SvalFirefox.hasNoHistory(tab), "a fresh tab has none");
    const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser);
    BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, `${URL}?next`);
    await within(loaded, 15_000, "the tab's next page loading");
    await TestUtils.waitForCondition(
      () => tab.linkedBrowser.canGoBack,
      "the navigation reached session history"
    );
    Assert.ok(!SvalFirefox.hasNoHistory(tab), "one navigation later it has");
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function inserting_a_lazy_tab_gives_it_a_browser() {
  const tab = lazyTab(URL);
  try {
    SvalFirefox.insertBrowser(window, tab);
    Assert.ok(!SvalFirefox.isLazy(tab), "the tab is no longer lazy");
    Assert.ok(tab.linkedBrowser.isRemoteBrowser, "and has a content browser");
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function a_key_on_a_page_waits_for_the_page_and_comes_back() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, URL),
    15_000,
    "the new tab opening and loading"
  );
  const answers = [];
  const listener = event => {
    if (event.key === "Escape") {
      answers.push(SvalFirefox.awaitsPageReply(window, event));
    }
  };
  window.addEventListener("keydown", listener, true);
  try {
    tab.linkedBrowser.focus();
    EventUtils.synthesizeKey("KEY_Escape");
    await within(
      TestUtils.waitForCondition(() => answers.length === 2),
      10_000,
      "the page's reply to the key"
    );
    Assert.deepEqual(
      answers,
      [true, false],
      "the key goes to the page first, and its reply is acted on"
    );

    answers.length = 0;
    gURLBar.focus();
    EventUtils.synthesizeKey("KEY_Escape");
    Assert.deepEqual(
      answers,
      [false],
      "a key in the toolbar waits for nothing"
    );
  } finally {
    window.removeEventListener("keydown", listener, true);
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function discarding_releases_a_background_tab() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, URL),
    15_000,
    "the new tab opening and loading"
  );
  const other = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, URL),
    15_000,
    "the other tab opening and loading"
  );
  try {
    Assert.ok(SvalFirefox.discard(window, tab), "it was discarded");
    Assert.ok(!tab.linkedPanel, "and is lazy again");
  } finally {
    BrowserTestUtils.removeTab(other);
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function a_tab_moved_to_a_new_window_names_its_adopter() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, URL),
    15_000,
    "the new tab opening and loading"
  );
  const closed = BrowserTestUtils.waitForEvent(tab, "TabClose");
  const opened = BrowserTestUtils.waitForNewWindow();
  gBrowser.replaceTabWithWindow(tab);
  const event = await within(closed, 5_000, "the moved tab's TabClose");
  const win = await within(
    opened,
    15_000,
    "the window the tab moves to opening"
  );
  try {
    const adopter = SvalFirefox.adoptedBy(event);
    Assert.ok(adopter, "the close names the tab that adopts it");
    Assert.equal(adopter.documentGlobal, win, "in the new window");
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the test window closing"
    );
  }
});

add_task(async function every_group_colour_has_its_three_properties() {
  const style = getComputedStyle(document.documentElement);
  for (const color of PRESETS) {
    for (const variant of ["", "-invert", "-pale"]) {
      const name = `--tab-group-color-${color}${variant}`;
      Assert.ok(style.getPropertyValue(name).trim(), `${name} is defined`);
    }
  }
});
