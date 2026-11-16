/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_blocking_helpers.js */

// Sval's lists reach Gecko's content classifier through SvalBlockingLists and
// block in the page; the site exception and the allowed domains let a request
// through; a blocked ad reaches the protection panel's Ads row
// (protections spec §1.1, §1.2 and §1.7).

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_blocking_helpers.js",
  this
);

const { ALLOWED_DOMAIN_BRANCH, SvalBlocking } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
);
const { SvalBlockingLists } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlockingLists.sys.mjs"
);
const { readLog } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalProtectionButton.sys.mjs"
);
const { ContentBlockingAllowList } = ChromeUtils.importESModule(
  "resource://gre/modules/ContentBlockingAllowList.sys.mjs"
);

const FIRST_PARTY =
  "https://example.net/browser/browser/components/sval/test/browser/sval_agent_page.html";
const AD_ORIGIN = "https://example.org";
const AD_URL = `${AD_ORIGIN}/browser/browser/components/sval/test/browser/sval_agent_page.html`;

const TEST_ADS = "! Title: Test ads\n||example.org^";

/**
 * Serves `body` as EasyList from the test publisher and downloads it.
 *
 * @param {string} body
 */
async function serveEasyList(body) {
  await serveLists({ "sval-easylist": body });
  ok(await SvalBlockingLists.update("sval-easylist"), "EasyList downloads");
}

const loads = requestLoads;

add_setup(async function () {
  // The level, and the prefs Sval and Firefox derive from it, as this file
  // found them.
  keepPrefs(
    "browser.sval.adblock.",
    "privacy.trackingprotection.",
    "privacy.query_stripping.",
    "browser.contentblocking.category"
  );
  await SpecialPowers.pushPrefEnv({
    set: [...CONTENT_BLOCKING_TEST_PREFS],
  });
  registerCleanupFunction(async () => {
    SvalBlocking.setLevel("off");
    clearPrefBranches(ALLOWED_DOMAIN_BRANCH);
    await IOUtils.remove(SvalBlockingLists.dir, {
      recursive: true,
      ignoreAbsent: true,
    });
  });

  SvalBlocking.setLevel("off");
  SvalBlocking.setListEnabled("sval-easylist", true);
  SvalBlocking.flush();
  await serveEasyList(TEST_ADS);
  await listsInForce();
});

add_task(async function a_list_from_the_loader_blocks_and_counts_as_an_ad() {
  await BrowserTestUtils.withNewTab(FIRST_PARTY, async browser => {
    ok(!(await loads(browser, AD_URL)), "the listed host is blocked");
    ok(
      SvalBlocking.adOriginsFor(browser).has(AD_ORIGIN),
      "the block is attributed to the ads feature"
    );
    const log = readLog(window, browser);
    is(log.ads, 1, "the panel counts it under Ads");
    is(log.blocked, 0, "and not under trackers");
  });
});

add_task(async function a_new_page_in_the_tab_starts_with_no_ads() {
  await BrowserTestUtils.withNewTab(FIRST_PARTY, async browser => {
    ok(!(await loads(browser, AD_URL)), "the listed host is blocked");
    ok(SvalBlocking.adOriginsFor(browser).has(AD_ORIGIN), "counted as an ad");
    const next = `${FIRST_PARTY}?next`;
    BrowserTestUtils.startLoadingURIString(browser, next);
    await within(
      BrowserTestUtils.browserLoaded(browser, false, next),
      15_000,
      "the next page's load"
    );
    is(
      SvalBlocking.adOriginsFor(browser).size,
      0,
      "the next page's document has no ads counted from the one before"
    );
  });
});

/**
 * The classifier holds a request until its engines from this device's copies
 * are built, so none passes while they are being built: turning it off drops
 * them, and the first request once it is back on waits for them.
 */
add_task(async function a_request_waits_for_the_engines_being_built() {
  await BrowserTestUtils.withNewTab(FIRST_PARTY, async browser => {
    await SpecialPowers.pushPrefEnv({
      set: [
        ["privacy.trackingprotection.content.protection.enabled", false],
        ["privacy.trackingprotection.content.annotation.enabled", false],
      ],
    });
    await SpecialPowers.popPrefEnv();
    ok(
      !(await loads(browser, AD_URL)),
      "the first request after the classifier is back is blocked"
    );
  });
});

add_task(async function the_site_exception_lets_it_through() {
  await BrowserTestUtils.withNewTab(FIRST_PARTY, async browser => {
    ContentBlockingAllowList.add(browser);
    try {
      await within(
        BrowserTestUtils.reloadTab(gBrowser.selectedTab),
        15_000,
        "the page's reload with protections off"
      );
      ok(await loads(browser, AD_URL), "loads with protections off");
    } finally {
      ContentBlockingAllowList.remove(browser);
    }
  });
});

add_task(async function an_allowed_domain_passes_on_every_site() {
  SvalBlocking.addAllowedDomain("example.org");
  await BrowserTestUtils.withNewTab(FIRST_PARTY, async browser => {
    await untilLoads(browser, AD_URL, "the allowed domain loads");
  });
  await BrowserTestUtils.withNewTab(
    "https://example.com/browser/browser/components/sval/test/browser/sval_agent_page.html",
    async browser => {
      ok(await loads(browser, AD_URL), "on another site too");
    }
  );
  SvalBlocking.removeAllowedDomain("example.org");
  await BrowserTestUtils.withNewTab(FIRST_PARTY, async browser => {
    await untilBlocked(browser, AD_URL, "removed, it is blocked again");
  });
});

add_task(async function an_allowed_domain_beats_an_important_rule() {
  // The copy with the important rule also blocks a host the plain copy
  // leaves alone, so a page tells which copy is in force.
  const marker = AD_URL.replace("example.org", "www.example.com");
  await serveEasyList("||example.org^$important\n||www.example.com^");
  await BrowserTestUtils.withNewTab(FIRST_PARTY, async browser => {
    await untilBlocked(browser, marker, "the important copy in force");
    ok(!(await loads(browser, AD_URL)), "the important rule blocks");
    SvalBlocking.addAllowedDomain("example.org");
    await untilLoads(browser, AD_URL, "the allowed domain still loads");
    SvalBlocking.removeAllowedDomain("example.org");
    await untilBlocked(browser, AD_URL, "removed, it is blocked again");
  });
  await serveEasyList(TEST_ADS);
  await BrowserTestUtils.withNewTab(FIRST_PARTY, browser =>
    untilLoads(browser, marker, "the plain copy back in force")
  );
});

// The harness reaches every host through a proxy on 127.0.0.1, so the test
// server's names connect to a local address, as a public name rebound to
// one would. The same address as a curated list downloads.
add_task(async function a_user_list_on_a_local_address_is_refused() {
  const url = `${FIRST_PARTY}?list`;
  await SpecialPowers.pushPrefEnv({
    set: [["browser.sval.adblock.list.sval-oisd-big.url", url]],
  });
  ok(
    await SvalBlockingLists.update("sval-oisd-big"),
    "the address answers a download Sval curates"
  );
  const { id } = SvalBlocking.addList(url, "ads");
  SvalBlocking.flush();
  ok(!(await SvalBlockingLists.update(id)), "the user's list is refused");
  is(SvalBlockingLists.status(id).state, "never", "and nothing is kept");
  SvalBlocking.removeList(id);
  SvalBlocking.flush();
});

add_task(async function off_unloads_the_lists() {
  SvalBlocking.setLevel("off");
  await BrowserTestUtils.withNewTab(FIRST_PARTY, browser =>
    untilLoads(browser, AD_URL, "Off blocks nothing from Sval's lists")
  );
});

/**
 * Off and back on in one turn, as an undo of Off does, blocks with the lists
 * turned back on. They block a host the lists before Off left alone, so the
 * page tells the engine built from them from the one Off dropped.
 */
add_task(async function off_and_straight_back_on_blocks_again() {
  const marker = AD_URL.replace("example.org", "www.example.com");
  await SpecialPowers.pushPrefEnv({
    set: [
      [
        "browser.sval.adblock.list.sval-adguard-base.url",
        listAddress("sval-adguard-base", "||www.example.com^"),
      ],
    ],
  });
  ok(await SvalBlockingLists.update("sval-adguard-base"), "a list downloads");
  SvalBlocking.setListEnabled("sval-easylist", true);
  SvalBlocking.flush();
  await BrowserTestUtils.withNewTab(FIRST_PARTY, async browser => {
    await untilBlocked(browser, AD_URL, "EasyList blocks");
    ok(await loads(browser, marker), "and leaves the other host alone");
    SvalBlocking.setLevel("off");
    SvalBlocking.setListEnabled("sval-adguard-base", true);
    SvalBlocking.flush();
    await untilBlocked(browser, marker, "the list turned back on blocks");
  });
});
