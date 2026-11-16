/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The pages a failed load or a crash puts in a tab take Sval's design
 * through `SvalPageStyle`.
 */

ChromeUtils.defineESModuleGetters(this, {
  PAGE_SHEET: "moz-src:///browser/components/sval/SvalPageStyle.sys.mjs",
  sheetsFor: "moz-src:///browser/components/sval/SvalPageStyle.sys.mjs",
});

const ERROR_SHEET = "chrome://browser/content/sval/pages/error-pages.css";
const BLOCKED_SHEET = "chrome://browser/content/sval/pages/blocked.css";

add_task(function each_error_page_takes_the_error_sheet() {
  for (const page of [
    "about:neterror?e=dnsNotFound",
    "about:certerror?e=nssBadCert",
    "about:httpsonlyerror?e=httpsOnlyErrorPage",
    "about:tabcrashed?e=tabcrashed",
    "about:framecrashed",
    "about:restartrequired",
    "about:restricted?e=restrictedcontent",
  ]) {
    Assert.deepEqual(
      sheetsFor(page),
      [PAGE_SHEET, ERROR_SHEET],
      `${page} takes the page sheet, then the error pages'`
    );
  }
  Assert.deepEqual(
    sheetsFor("about:blocked?e=deceptiveBlocked"),
    [PAGE_SHEET, BLOCKED_SHEET],
    "a blocked site takes a sheet that keeps its red canvas"
  );
});

/**
 * A failed load's page wears the sheets `sheetsFor` names. A sheet loaded
 * through `nsIDOMWindowUtils.loadSheetUsingURIString` is in no list a page
 * can read, so each is seen by what it sets: the page sheet's tokens on the
 * root, and the error sheet's card around the page's text.
 */
add_task(async function a_failed_load_wears_the_error_sheet() {
  const tab = BrowserTestUtils.addTab(gBrowser, "https://sval-no-host.test/");
  const shown = BrowserTestUtils.waitForErrorPage(tab.linkedBrowser);
  await selectTab(tab);
  await within(shown, 10_000, "the error page");
  const { uri, token, corner } = await SpecialPowers.spawn(
    tab.linkedBrowser,
    [],
    () => {
      const doc = content.document;
      const card = doc.querySelector(
        "net-error-card, body > .container, body > #errorPageContainer"
      );
      return {
        uri: doc.documentURI,
        token: content
          .getComputedStyle(doc.documentElement)
          .getPropertyValue("--sval-action")
          .trim(),
        corner: card && content.getComputedStyle(card).borderTopLeftRadius,
      };
    }
  );
  Assert.ok(uri.startsWith("about:neterror?"), "the tab shows a net error");
  Assert.ok(token, "the page wears the page sheet's tokens");
  Assert.equal(corner, "20px", "and the error sheet's card");
});
