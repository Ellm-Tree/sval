/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_blocking_helpers.js */

// Blocking turned off and straight back on blocks with the rules it has
// then. The user's own rules carry them, so no list is downloaded.

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_blocking_helpers.js",
  this
);

const { SvalBlocking, MY_FILTER_BRANCH } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
);

const PATH = "/browser/browser/components/sval/test/browser/";
const FIRST_PARTY = `https://example.net${PATH}sval_agent_page.html`;
const BEFORE = `https://example.org${PATH}sval_agent_page.html`;
const AFTER = `https://www.example.com${PATH}sval_agent_page.html`;

/**
 * @param {Element} browser Showing a first-party page.
 * @param {string} url
 * @returns {Promise<boolean>} whether the page's request for `url` is blocked.
 */
function blocked(browser, url) {
  return SpecialPowers.spawn(browser, [url], async target => {
    try {
      await content.fetch(`${target}?${Math.random()}`, { mode: "no-cors" });
      return false;
    } catch {
      return true;
    }
  });
}

/**
 * @param {Element} browser
 * @param {string} url
 * @param {string} what
 */
function untilBlocked(browser, url, what) {
  return within(
    TestUtils.waitForCondition(() => blocked(browser, url), what),
    30_000,
    what
  );
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [...CONTENT_BLOCKING_TEST_PREFS],
    clear: [
      ["browser.sval.adblock.level"],
      ["browser.sval.adblock.customFrom"],
    ],
  });
  registerCleanupFunction(() => clearPrefBranches(MY_FILTER_BRANCH));
  registerCleanupFunction(() => {
    SvalBlocking.setMyFilters("");
    SvalBlocking.setLevel("balanced");
    SvalBlocking.flush();
  });
});

add_task(async function off_and_straight_back_on_blocks_with_the_new_rules() {
  SvalBlocking.setLevel("balanced");
  SvalBlocking.setMyFilters("||example.org^");
  SvalBlocking.flush();
  await BrowserTestUtils.withNewTab(FIRST_PARTY, async browser => {
    await untilBlocked(browser, BEFORE, "the user's rule blocks");
    ok(!(await blocked(browser, AFTER)), "and leaves the other host alone");

    SvalBlocking.setLevel("off");
    SvalBlocking.setMyFilters("||example.org^\n||www.example.com^\n");
    SvalBlocking.setLevel("balanced");
    SvalBlocking.flush();
    await untilBlocked(browser, AFTER, "the rule added while off blocks");
    ok(await blocked(browser, BEFORE), "and the earlier rule still does");
  });
});
