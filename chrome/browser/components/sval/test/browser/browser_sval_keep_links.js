/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Keep links in this tab (`SvalKeepLinks`, `SvalKeepsLinkInTab`): which of a
 * page's requests for a new tab load in its own tab, on real pages.
 */

ChromeUtils.defineESModuleGetters(this, {
  SvalKeepLinks: "moz-src:///browser/components/sval/SvalKeepLinks.sys.mjs",
  SITE_BRANCH: "moz-src:///browser/components/sval/SvalKeepLinks.sys.mjs",
});

const KL_PATH = "/browser/browser/components/sval/test/browser/";
const KL_PAGE = `https://example.com${KL_PATH}sval_keep_links_page.html`;
const KL_HOST_PAGE = `https://test1.example.com${KL_PATH}sval_keep_links_page.html`;
const KL_TARGET = `https://www.example.com${KL_PATH}sval_keep_links_target.html`;
const KL_OTHER_TARGET = `https://example.org${KL_PATH}sval_keep_links_target.html`;

registerCleanupFunction(() => clearPrefBranches(SITE_BRANCH));

/**
 * Clicks `selector` on the page in `browser`, as a person does.
 *
 * @param {string} selector
 * @param {Element} browser
 * @param {object} [modifiers]
 */
async function click(selector, browser, modifiers = {}) {
  await BrowserTestUtils.synthesizeMouseAtCenter(selector, modifiers, browser);
}

/**
 * Clicks `selector` and waits for the page it opens in a new tab, which it
 * then closes.
 *
 * @param {string} selector
 * @param {Element} browser
 * @param {string} url
 * @param {object} [modifiers]
 */
async function opensNewTab(selector, browser, url, modifiers = {}) {
  const tabs = gBrowser.tabs.length;
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, url, true);
  await click(selector, browser, modifiers);
  const tab = await within(opened, 10_000, `a new tab for ${url}`);
  Assert.equal(gBrowser.tabs.length, tabs + 1, "one tab opened");
  BrowserTestUtils.removeTab(tab);
}

/**
 * Clicks `selector` and waits for its page to load in the same tab.
 *
 * @param {string} selector
 * @param {Element} browser
 */
async function staysInTab(selector, browser) {
  const tabs = gBrowser.tabs.length;
  await click(selector, browser);
  await pageReady(browser, KL_TARGET);
  Assert.equal(gBrowser.tabs.length, tabs, "no tab opened");
}

add_task(async function a_site_without_the_rule_opens_its_links_in_new_tabs() {
  await BrowserTestUtils.withNewTab(KL_PAGE, async browser => {
    await pageReady(browser, KL_PAGE);
    Assert.equal(
      browser.browsingContext.svalKeepLinksSite,
      "",
      "the tab keeps no site's links"
    );
    await opensNewTab("#same", browser, KL_TARGET);
  });
});

add_task(async function a_site_with_the_rule_keeps_its_links_in_the_tab() {
  SvalKeepLinks.setOn("example.com", true);
  await BrowserTestUtils.withNewTab(KL_PAGE, async browser => {
    await pageReady(browser, KL_PAGE);
    Assert.equal(
      browser.browsingContext.svalKeepLinksSite,
      "example.com",
      "the tab keeps the site's links"
    );
    await staysInTab("#same", browser);
  });
  SvalKeepLinks.removeRule("example.com");
});

add_task(async function the_rule_leaves_other_sites_and_the_users_keys_alone() {
  SvalKeepLinks.setOn("example.com", true);
  await BrowserTestUtils.withNewTab(KL_PAGE, async browser => {
    await pageReady(browser, KL_PAGE);
    await opensNewTab("#other", browser, KL_OTHER_TARGET);
    await opensNewTab("#same", browser, KL_TARGET, { accelKey: true });
  });
  SvalKeepLinks.removeRule("example.com");
});

add_task(async function a_frames_link_opens_a_new_tab() {
  SvalKeepLinks.setOn("example.com", true);
  await BrowserTestUtils.withNewTab(KL_PAGE, async browser => {
    await pageReady(browser, KL_PAGE);
    const frame = browser.browsingContext.children[0];
    const opened = BrowserTestUtils.waitForNewTab(gBrowser, KL_TARGET, true);
    await BrowserTestUtils.synthesizeMouseAtCenter("#framed", {}, frame);
    BrowserTestUtils.removeTab(
      await within(opened, 10_000, "a new tab for the frame's link")
    );
  });
  SvalKeepLinks.removeRule("example.com");
});

add_task(async function a_script_keeps_only_a_window_it_lets_go_of() {
  SvalKeepLinks.setOn("example.com", true);
  await BrowserTestUtils.withNewTab(KL_PAGE, async browser => {
    await pageReady(browser, KL_PAGE);
    await opensNewTab("#open-opener", browser, KL_TARGET);

    const opened = BrowserTestUtils.waitForNewWindow({ url: KL_TARGET });
    await click("#open-features", browser);
    const win = await within(opened, 10_000, "the popup window");
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the popup closing"
    );

    await staysInTab("#open-noopener", browser);
  });
  SvalKeepLinks.removeRule("example.com");
});

add_task(async function a_rule_reaches_an_open_tab_as_it_changes() {
  await BrowserTestUtils.withNewTab(KL_PAGE, async browser => {
    await pageReady(browser, KL_PAGE);
    SvalKeepLinks.setOn("example.com", true);
    Assert.equal(
      browser.browsingContext.svalKeepLinksSite,
      "example.com",
      "turning it on reaches the open tab"
    );
    SvalKeepLinks.setOn("example.com", false);
    Assert.equal(
      browser.browsingContext.svalKeepLinksSite,
      "",
      "turning it off reaches the open tab"
    );
    Assert.deepEqual(
      [...SvalKeepLinks.rules()],
      [],
      "turning a site back to off stores no rule"
    );
  });
});

add_task(async function a_host_rule_covers_that_host_alone() {
  SvalKeepLinks.setOn("test1.example.com", true);
  await BrowserTestUtils.withNewTab(KL_HOST_PAGE, async browser => {
    await pageReady(browser, KL_HOST_PAGE);
    await staysInTab("#same", browser);
  });
  await BrowserTestUtils.withNewTab(KL_PAGE, async browser => {
    await pageReady(browser, KL_PAGE);
    await opensNewTab("#same", browser, KL_TARGET);
  });
  SvalKeepLinks.removeRule("test1.example.com");
});
