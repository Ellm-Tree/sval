/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

// A crash report never says what page was open (CONTRIBUTING.md rule 10):
// Gecko has no annotation for a page's address, a crashed tab's report file
// names neither the page nor its site, and the crashed-tab page offers no box
// to add the address. browser_sval_crash_private.js covers a private window,
// whose crash keeps no report.

const HOST = "example.com";
const MARK = "svalcrashmark";
const CRASH_PAGE = `https://${HOST}/browser/browser/components/sval/test/browser/sval_agent_page.html?${MARK}`;

/**
 * Crashes the content process of `browser`, which shows `CRASH_PAGE`.
 *
 * @param {Element} browser
 * @returns {Promise<object>} The crash report's annotations, as its `.extra`
 *   file holds them.
 */
async function crashed(browser) {
  const extra = await within(
    BrowserTestUtils.crashFrame(browser),
    30_000,
    "the tab's process crashing"
  );
  Assert.ok(extra.ProcessType, "the crash left a report with annotations");
  return extra;
}

function assertNoAddress(extra, what) {
  for (const [key, value] of Object.entries(extra)) {
    const text = JSON.stringify(value);
    Assert.ok(
      !text.includes(HOST) && !text.includes(MARK),
      `${what}: the ${key} annotation does not name the page`
    );
  }
}

add_task(async function gecko_has_no_annotation_for_a_pages_address() {
  Assert.ok(
    !Services.appinfo.isAnnotationValid("URL"),
    "URL is no crash annotation"
  );
  Assert.throws(
    () => Services.appinfo.annotateCrashReport("URL", CRASH_PAGE),
    error => error.result === Cr.NS_ERROR_INVALID_ARG,
    "and recording one is refused"
  );
});

add_task(async function a_crashed_tabs_report_does_not_name_its_page() {
  const tab = await openPage(CRASH_PAGE);
  const browser = tab.linkedBrowser;
  assertNoAddress(await crashed(browser), "a tab");
  Assert.equal(
    browser.contentDocument.documentURI.split("?")[0],
    "about:tabcrashed",
    "the crashed-tab page shows"
  );
  Assert.ok(
    browser.contentDocument.getElementById("sendReport"),
    "with its box to send the report"
  );
  Assert.ok(
    !browser.contentDocument.getElementById("includeURL"),
    "and no box to include the page's address"
  );
});
