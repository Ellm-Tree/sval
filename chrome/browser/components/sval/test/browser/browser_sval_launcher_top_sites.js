/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_launcher_home_helpers.js */

/**
 * With nothing typed and no recent tab to list, the Launcher lists the
 * user's top sites (launcher spec §5), which the topsites module answers:
 * the sites the user visits often, in its order, and the home page's empty
 * field lists the same rows.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_launcher_home_helpers.js",
  this
);

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);
const { PlacesTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PlacesTestUtils.sys.mjs"
);
const { TopSites } = ChromeUtils.importESModule(
  "resource:///modules/topsites/TopSites.sys.mjs"
);

const OFTEN = "https://sval-often.example.net/";
const SOMETIMES = "https://sval-sometimes.example.org/";

add_setup(failOnConsoleErrors);
add_setup(async function () {
  await PlacesUtils.history.clear();
  registerCleanupFunction(async () => {
    await UrlbarTestUtils.promisePopupClose(window);
    gURLBar.handleRevert();
    await PlacesUtils.history.clear();
  });
});

/**
 * Leaves the tree holding this window's tab alone, so the Launcher has no
 * other tab to list in place of the top sites, whatever an earlier file left
 * in the profile's document.
 */
async function onlyThisTab() {
  const own = SvalPanel.observer.nodeIdFor(gBrowser.selectedTab);
  for (const [id, node] of Object.entries(SvalPanel.nodes)) {
    if (node?.kind === "tab" && id !== own) {
      await SvalPanel.engine.mutate({ kind: "remove", id, now: Date.now() });
    }
  }
  await SvalPanel.refresh();
}

/**
 * Visits `OFTEN` more than `SOMETIMES`, both past the five visits that make a
 * page a top site (`TopSites.getLinksWithDefaults`' frecency threshold), and
 * has the module read history again (`TopSites.refresh`).
 */
async function visitBoth() {
  await PlacesTestUtils.addVisits([
    ...Array(12).fill({ uri: OFTEN, title: "Often" }),
    ...Array(6).fill({ uri: SOMETIMES, title: "Sometimes" }),
  ]);
  TopSites.frecentCache.expire();
  await within(TopSites.refresh(), 10_000, "the top sites refreshing");
}

/**
 * The address bar's rows with nothing typed.
 *
 * @returns {Promise<object[]>} `{ url, providerName }` per row.
 */
async function emptyQueryRows() {
  await within(
    UrlbarTestUtils.promiseAutocompleteResultPopup({ window, value: "" }),
    10_000,
    "the address bar's results"
  );
  const rows = [];
  for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
    const { result } = await UrlbarTestUtils.getDetailsOfResultAt(window, i);
    rows.push({ url: result.payload.url, providerName: result.providerName });
  }
  return rows;
}

add_task(async function the_empty_launcher_lists_the_top_sites() {
  await onlyThisTab();
  await visitBoth();
  const sites = (await TopSites.getSites()).map(site => site.url);
  Assert.deepEqual(
    sites.filter(url => url === OFTEN || url === SOMETIMES),
    [OFTEN, SOMETIMES],
    "the module ranks the page visited more first"
  );

  const rows = await emptyQueryRows();
  Assert.ok(
    rows.length && rows.every(r => r.providerName == "UrlbarProviderTopSites"),
    "every row is a top site"
  );
  Assert.deepEqual(
    rows.map(r => r.url),
    sites,
    "the rows are the module's sites, in its order"
  );
  await closeUrlbarWithItems();
  await PlacesUtils.history.clear();
});

/**
 * A page the user visits often after the list was first read joins it while
 * the browser runs: each visit has the module read the list again
 * (`topsites-refresh-on-rank-change.patch`).
 */
add_task(async function a_site_made_frequent_later_joins_the_launcher() {
  await onlyThisTab();
  await visitBoth();
  const later = "https://sval-later.example.com/";
  Assert.ok(
    !(await TopSites.getSites()).some(site => site.url === later),
    "the page is no top site before its visits"
  );
  // The module's history cache answers for `LinksCache`'s expiration time;
  // expiring it stands for that time passing.
  TopSites.frecentCache.expire();
  const refreshed = TestUtils.topicObserved("topsites-refreshed");
  await PlacesTestUtils.addVisits(
    Array(15).fill({ uri: later, title: "Later" })
  );
  await within(refreshed, 10_000, "the top sites refreshing after the visits");
  Assert.ok(
    (await TopSites.getSites()).some(site => site.url === later),
    "the page is a top site"
  );
  const rows = await emptyQueryRows();
  Assert.ok(
    rows.some(r => r.url === later),
    "the Launcher lists it with nothing typed"
  );
  await closeUrlbarWithItems();
  await PlacesUtils.history.clear();
});

add_task(async function the_home_field_lists_the_same_top_sites() {
  await onlyThisTab();
  await visitBoth();
  const first = gBrowser.selectedTab;
  const { tab } = await homeTab();
  const browser = tab.linkedBrowser;
  // With the window's first tab used, the Launcher lists it as a recent tab
  // in place of the top sites (launcher spec §5).
  const firstId = SvalPanel.observer.nodeIdFor(first);
  const used = SvalPanel.settings.lastActive(firstId);
  SvalPanel.settings.forgetLastActive(firstId);
  atTaskEnd(() => {
    if (used != null) {
      SvalPanel.settings.setLastActive(firstId, used);
    }
  });

  await within(
    UrlbarTestUtils.promisePopupOpen(window, () =>
      EventUtils.synthesizeMouseAtCenter(gURLBar.inputField, {})
    ),
    10_000,
    "a click opens the address bar's view"
  );
  await UrlbarTestUtils.promiseSearchComplete(window);
  const urlbar = await closeUrlbarWithItems();
  Assert.ok(
    urlbar.some(item => item.includes("sval-often.example.net")),
    "the address bar lists the top site"
  );

  await BrowserTestUtils.synthesizeMouseAtCenter(".search input", {}, browser);
  const home = await untilHomeLists(browser, urlbar);
  Assert.deepEqual(home.items, urlbar, "the field lists the same rows");
  await PlacesUtils.history.clear();
});
