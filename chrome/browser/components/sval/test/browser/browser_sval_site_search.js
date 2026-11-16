/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_site_page_helpers.js */

/**
 * The Sites list's rows and search (site page spec §3, decision 1484): a site
 * holding only a permission has a row of its own, which opens its page, where
 * the permission changes; the search finds the sites holding only stored
 * data, listed under their own subhead after the list, each opening its
 * page.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_site_page_helpers.js",
  this
);

const { SvalSiteProtections, SITE_BRANCH } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
);
const { SvalSiteData } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteData.sys.mjs"
);
const { sitesWithPermissions } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSitePermissionList.sys.mjs"
);

/**
 * @returns {number} The sites the table lists: the rows, and every site the
 *   harness's profile holds a permission for.
 */
const listed = () => new Set([...ROWS, ...sitesWithPermissions()]).size;

/** The sites with a row in the table. */
const ROWS = ["example.net", "example.org", "example.com"];

/** A site holding only a permission. */
const NOTIFY = "notify.net";

/** A site holding only a cookie. */
const COOKIES = "cookies.net";

/** A site holding only an IndexedDB database. */
const STORED = "stored.net";

/**
 * @param {string} site
 * @param {string} type
 * @param {number} action
 */
function addPermission(site, type, action) {
  Services.perms.addFromPrincipal(
    Services.scriptSecurityManager.createContentPrincipalFromOrigin(
      `https://${site}`
    ),
    type,
    action
  );
}

function addCookie(site) {
  Services.cookies.add(
    site,
    "/",
    "sval-site-search",
    "1",
    true,
    false,
    false,
    Date.now() + 3600 * 1000,
    {},
    Ci.nsICookie.SAMESITE_LAX,
    Ci.nsICookie.SCHEME_HTTPS
  );
}

/**
 * Stores incompressible data in the site's IndexedDB, so it has quota usage.
 *
 * @param {string} site
 */
async function store(site) {
  const principal = Services.scriptSecurityManager.createContentPrincipal(
    Services.io.newURI(`https://${site}`),
    {}
  );
  const request = indexedDB.openForPrincipal(principal, "sval-site-search", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("data");
  const db = await within(
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }),
    10_000,
    "the database opening"
  );
  const data = crypto.getRandomValues(new Uint8Array(65536));
  const tx = db.transaction("data", "readwrite");
  tx.objectStore("data").put(data, 1);
  await within(
    new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    }),
    10_000,
    "the data storing"
  );
  db.close();
}

/** Mozilla's topics as `SiteDataManager.updateSites` starts and ends. */
const READ_STARTS = "sitedatamanager:updating-sites";
const READ_ENDS = "sitedatamanager:sites-updated";

/**
 * Counts the reads of stored data that start and end until the task ends.
 *
 * @returns {{started: number, ended: number}}
 */
function countReads() {
  const reads = { started: 0, ended: 0 };
  const starts = () => reads.started++;
  const ends = () => reads.ended++;
  Services.obs.addObserver(starts, READ_STARTS);
  Services.obs.addObserver(ends, READ_ENDS);
  atTaskEnd(() => {
    Services.obs.removeObserver(starts, READ_STARTS);
    Services.obs.removeObserver(ends, READ_ENDS);
  });
  return reads;
}

/** @param {string} site */
async function clearSite(site) {
  await within(
    new Promise(resolve =>
      Services.clearData.deleteDataFromSite(
        site,
        {},
        true,
        Ci.nsIClearDataService.CLEAR_COOKIES_AND_SITE_DATA,
        resolve
      )
    ),
    30_000,
    "the site clearing in teardown"
  );
  await within(SvalSiteData.update(), 30_000, "the site data rereading");
}

/** Three rows, one of them also holding a permission. */
function threeRows() {
  for (const site of ROWS) {
    SvalSiteProtections.setProtections(site, "off");
  }
  addPermission(
    "example.net",
    "desktop-notification",
    Services.perms.ALLOW_ACTION
  );
  atTaskEnd(() => {
    clearPrefBranches(SITE_BRANCH);
    Services.perms.removeAll();
  });
}

/**
 * @returns {Promise<object>} The Sites list's parts, with Sites showing.
 */
async function openSites() {
  const { page } = await openAt("about:preferences#svalSites");
  const ui = partsOf(page);
  await until(ui.sitesShown, "the Sites card showing");
  const search = ui.byId("sval-sites-search");
  return {
    ...ui,
    page,
    type(text) {
      search.value = text;
      search.dispatchEvent(new page.Event("input"));
    },
    results: () => ui.doc.querySelector(".sval-sites-results"),
    found: () =>
      [...ui.doc.querySelectorAll(".sval-sites-result")].map(row => ({
        site: row.querySelector("a").textContent,
        summary: row.querySelector(".sval-sites-result-sub").textContent,
      })),
    waiting: () => !!ui.doc.querySelector(".sval-sites-results-wait"),
    said: () => ui.byId("sval-sites-found").textContent,
    /** The count line's numbers: the rows shown, then every row. */
    counted: () =>
      ui.byId("sval-sites-found").textContent.match(/\d+/g)?.map(Number),
    nomatch: () => ui.doc.querySelector("#sval-sites-body .sval-agent-nomatch"),
  };
}

add_task(async function a_permission_only_site_has_a_row_and_opens() {
  await within(SvalSiteData.update(), 30_000, "the site data reading");
  threeRows();
  addPermission(NOTIFY, "desktop-notification", Services.perms.ALLOW_ACTION);
  const ui = await openSites();
  is(ui.said(), "", "no count until the list is narrowed");
  const row = () =>
    ui.doc.querySelector(`#sval-sites-body [data-site="${NOTIFY}"]`);
  ok(row(), "and has a row");
  is(
    row().querySelector(".sval-sites-summary").dataset.differs,
    `desktop-notification:${Services.perms.ALLOW_ACTION}`,
    "which says what it may do"
  );

  ui.type("notify");
  Assert.deepEqual(
    ui.counted(),
    [1, listed()],
    "a query counts the list's rows it shows"
  );
  ok(!ui.results(), "and no subhead repeats it");

  ui.type("nowhere");
  ok(!ui.results(), "no subhead when nothing matches");
  Assert.deepEqual(ui.counted(), [0, listed()]);
  ok(ui.nomatch().checkVisibility(), "the list says nothing matches");
  ui.type("notify");

  // The a11y check skips a node with no layout box yet.
  ui.doc.documentElement.getBoundingClientRect();
  row().querySelector("a").click();
  const page = await untilSitePage(ui.page, NOTIFY);
  const key = `site-perm:https://${NOTIFY}:desktop-notification`;
  await until(() => page.byKey(key), "the permission's row on the page");
  is(page.byKey(key).value, String(Services.perms.ALLOW_ACTION), "Allow");
  change(page.byKey(key), String(Services.perms.DENY_ACTION));
  is(
    Services.perms.testExactPermissionFromPrincipal(
      Services.scriptSecurityManager.createContentPrincipalFromOrigin(
        `https://${NOTIFY}`
      ),
      "desktop-notification"
    ),
    Services.perms.DENY_ACTION,
    "a change on the page is the site's permission"
  );
});

add_task(async function stored_data_joins_once_read() {
  threeRows();
  addPermission(NOTIFY, "geo", Services.perms.DENY_ACTION);
  addCookie(COOKIES);
  atTaskEnd(() => clearSite(COOKIES));

  const ui = await openSites();
  const read = TestUtils.topicObserved(SvalSiteData.TOPIC);
  ui.type("net");
  await within(read, 30_000, "the query's read of stored data");
  await until(() => !ui.waiting(), "the status row going");
  Assert.deepEqual(
    ui.found().map(found => found.site),
    [COOKIES],
    "a site with stored data is listed under the list, and a permission's " +
      "site is a row of its own"
  );
  ok(
    !/\d/.test(ui.found()[0].summary),
    "with no size, as it has cookies alone"
  );
  ok(ui.results().querySelector(".sval-sites-results-head"), "the subhead");
  Assert.deepEqual(
    ui.counted(),
    [2, listed()],
    "and the count stays the list's"
  );
});

add_task(async function a_query_being_typed_reads_once_it_pauses() {
  threeRows();
  const ui = await openSites();
  // A read that is running holds the next one back until it ends.
  await within(SvalSiteData.update(), 30_000, "earlier reads ending");
  const reads = countReads();
  for (const text of ["n", "ne", "net"]) {
    ui.type(text);
  }
  is(reads.started, 1, "the query's start reads at once");
  await until(() => reads.started === 2, "a read once typing pauses");
  await until(() => reads.ended === 2, "that read ending");
  ui.type("");
  ui.type("example");
  is(reads.started, 3, "a query begun again reads at once");
});

add_task(async function a_new_permission_adds_a_row() {
  threeRows();
  const ui = await openSites();
  ui.type("notify");
  ok(ui.nomatch().checkVisibility(), "nothing yet");
  addPermission(NOTIFY, "geo", Services.perms.ALLOW_ACTION);
  await until(
    () => ui.doc.querySelector(`#sval-sites-body [data-site="${NOTIFY}"]`),
    "the site joining the list"
  );
});

add_task(async function a_site_with_storage_reads_its_size() {
  atTaskEnd(() => clearSite(STORED));
  await store(STORED);
  await within(SvalSiteData.update(), 30_000, "the site data reading");
  const ui = await openSites();
  ui.type(STORED);
  const total = SvalSiteData.jarsFor(STORED, SvalPanel.nodes).reduce(
    (sum, jar) => sum + jar.usage,
    0
  );
  Assert.greater(total, 0, "the site has quota usage");
  Assert.deepEqual(
    ui.found().map(found => found.site),
    [STORED]
  );
  Assert.stringContains(
    ui.found()[0].summary,
    DownloadUtils.convertByteUnits(total).join(" "),
    "with its size"
  );
});
