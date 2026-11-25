/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_pins_helpers.js */
/* import-globals-from sval_launcher_home_helpers.js */

/**
 * With nothing typed, the Launcher lists the most recently used tabs under
 * Recent tabs, then the user's top sites under Frequent sites (launcher spec
 * §5), which the topsites module answers in its order. A site open in a tab
 * of any workspace is left out of Frequent sites, and the home page's empty
 * field lists the same rows.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_pins_helpers.js",
  this
);
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
const { FREQUENT_SITES, RECENT_TABS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLauncherTabs.sys.mjs"
);

const RECENT_HEADING = "launcher-section-recent-tabs";
const FREQUENT_HEADING = "launcher-section-frequent-sites";

add_setup(failOnConsoleErrors);
add_setup(pinsSetup);
add_setup(async function () {
  await PlacesUtils.history.clear();
  registerCleanupFunction(async () => {
    await UrlbarTestUtils.promisePopupClose(window);
    gURLBar.handleRevert();
    await PlacesUtils.history.clear();
  });
});

/**
 * Leaves the tree holding this window's tab alone, so the Launcher lists
 * only the tabs a task adds, whatever an earlier file left in the profile's
 * document.
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
 * A site's front page, each a site of its own (`siteOf`).
 *
 * @param {number} n
 * @returns {string}
 */
function site(n) {
  return `https://sval-frequent-${n}.test/`;
}

/**
 * Waits out a refresh already running. `TopSites.refresh` returns at once
 * while one runs, and that one may have read history before the latest
 * visits, so its notification says nothing about them.
 */
async function settledRefresh() {
  if (TopSites._refreshing) {
    await within(
      TestUtils.topicObserved("topsites-refreshed"),
      10_000,
      "the refresh already running"
    );
  }
}

/**
 * Visits `count` sites, the first most, each past the five visits that make
 * a page a top site (`TopSites.getLinksWithDefaults`' frecency threshold),
 * and has the module read history again (`TopSites.refresh`).
 *
 * @param {number} count
 * @returns {Promise<string[]>} the module's sites, in its order.
 */
async function visitSites(count) {
  const visits = [];
  for (let n = 0; n < count; n++) {
    visits.push(
      ...Array(6 + 2 * (count - n)).fill({ uri: site(n), title: `Site ${n}` })
    );
  }
  await PlacesTestUtils.addVisits(visits);
  await settledRefresh();
  TopSites.frecentCache.expire();
  await within(TopSites.refresh(), 10_000, "the top sites refreshing");
  const sites = (await TopSites.getSites()).map(s => s.url);
  Assert.deepEqual(
    sites,
    Array.from({ length: count }, (_, n) => site(n)),
    "the module ranks the sites visited more first"
  );
  return sites;
}

/**
 * Tabs of Work, which the window does not show, each used by this device,
 * the first most recently; removed when the task ends.
 *
 * @param {number} count
 * @returns {Promise<string[]>} their nodes.
 */
async function recentWorkTabs(count) {
  const ids = [];
  const now = Date.now();
  for (let n = 0; n < count; n++) {
    const id = await treeTab(
      pinsFixture.work,
      `Recent ${n}`,
      `https://sval-recent-${n}.example.org/`
    );
    // Recent tabs lists only the tabs this device has used.
    SvalPanel.settings.setLastActive(id, now - n);
    atTaskEnd(() => SvalPanel.settings.forgetLastActive(id));
    ids.push(id);
  }
  return ids;
}

/**
 * The address bar's rows with nothing typed, once the view has the words of
 * their headings.
 *
 * @returns {Promise<object[]>} `{ url, nodeId, providerName, heading }` per
 *   row, `heading` the Fluent id of the heading above it or null.
 */
async function emptyQueryRows() {
  await within(
    UrlbarTestUtils.promiseAutocompleteResultPopup({ window, value: "" }),
    10_000,
    "the address bar's results"
  );
  const details = [];
  for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
    details.push(await UrlbarTestUtils.getDetailsOfResultAt(window, i));
  }
  await TestUtils.waitForCondition(
    () =>
      details.every(
        d =>
          !d.element.row.hasAttribute("data-l10n-id") ||
          d.element.row.hasAttribute("label")
      ),
    "the headings have their words"
  );
  return details.map(({ result, element }) => ({
    url: result.payload.url,
    nodeId: result.payload.svalNodeId ?? null,
    providerName: result.providerName,
    heading: element.row.hasAttribute("label")
      ? element.row.getAttribute("data-l10n-id")
      : null,
  }));
}

add_task(async function recent_tabs_come_first_then_frequent_sites() {
  await onlyThisTab();
  const sites = await visitSites(FREQUENT_SITES + 2);
  const tabs = await recentWorkTabs(RECENT_TABS + 1);

  const rows = await emptyQueryRows();
  const recent = rows.slice(0, RECENT_TABS);
  const frequent = rows.slice(RECENT_TABS);
  Assert.deepEqual(
    recent.map(r => r.nodeId),
    tabs.slice(0, RECENT_TABS),
    "the most recently used tabs come first, as many as Recent tabs lists"
  );
  Assert.deepEqual(
    frequent.map(r => [r.providerName, r.url]),
    sites.slice(0, FREQUENT_SITES).map(url => ["UrlbarProviderTopSites", url]),
    "then the module's first sites, in its order, as many as Frequent sites lists"
  );
  Assert.deepEqual(
    rows.map(r => r.heading),
    [
      RECENT_HEADING,
      ...Array(RECENT_TABS - 1).fill(null),
      FREQUENT_HEADING,
      ...Array(FREQUENT_SITES - 1).fill(null),
    ],
    "each group under its own heading"
  );
  await closeUrlbarWithItems();
  await PlacesUtils.history.clear();
});

/**
 * A site with a tab in the tree is left out of Frequent sites, whether or not
 * Recent tabs lists the tab, and whichever of the site's pages it shows. A
 * site with no tab stays.
 */
add_task(async function a_site_open_in_a_tab_is_left_out() {
  await onlyThisTab();
  const sites = await visitSites(3);
  // A tab this device never showed, so no recent tab, at another page of
  // the second site.
  await treeTab(pinsFixture.work, "Open page", `${sites[1]}some/page`);

  const rows = await emptyQueryRows();
  Assert.ok(
    rows.every(r => r.providerName === "UrlbarProviderTopSites"),
    "Recent tabs lists no tab this device never used"
  );
  Assert.deepEqual(
    rows.map(r => r.url),
    [sites[0], sites[2]],
    "Frequent sites leaves out the site with a tab, and keeps the others"
  );
  Assert.equal(rows[0].heading, FREQUENT_HEADING, "under Frequent sites");
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
  await visitSites(2);
  const later = "https://sval-later.example.com/";
  // The module's history cache answers for `LinksCache`'s expiration time;
  // expiring it stands for that time passing.
  await settledRefresh();
  TopSites.frecentCache.expire();
  const refreshed = TestUtils.topicObserved("topsites-refreshed");
  await PlacesTestUtils.addVisits(
    Array(15).fill({ uri: later, title: "Later" })
  );
  await within(refreshed, 10_000, "the top sites refreshing after the visits");
  Assert.ok(
    (await TopSites.getSites()).some(s => s.url === later),
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

add_task(async function the_home_field_lists_the_same_groups() {
  await onlyThisTab();
  await visitSites(2);
  await recentWorkTabs(2);
  const { tab } = await homeTab();
  const browser = tab.linkedBrowser;

  await within(
    UrlbarTestUtils.promisePopupOpen(window, () =>
      EventUtils.synthesizeMouseAtCenter(gURLBar.inputField, {})
    ),
    10_000,
    "a click opens the address bar's view"
  );
  await UrlbarTestUtils.promiseSearchComplete(window);
  const urlbar = await closeUrlbarWithItems();
  const heading = id =>
    `## ${fluentText("sval/launcher.ftl", id, { attribute: "label" })}`;
  Assert.deepEqual(
    urlbar.filter(item => item.startsWith("## ")),
    [heading(RECENT_HEADING), heading(FREQUENT_HEADING)],
    "the address bar lists Recent tabs, then Frequent sites"
  );
  Assert.ok(
    urlbar.some(item => item.includes("sval-frequent-0.test")),
    "with the top site"
  );

  await BrowserTestUtils.synthesizeMouseAtCenter(".search input", {}, browser);
  const home = await untilHomeLists(browser, urlbar);
  Assert.deepEqual(home.items, urlbar, "the field lists the same rows");
  await PlacesUtils.history.clear();
});
