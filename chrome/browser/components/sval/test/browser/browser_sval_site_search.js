/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_site_page_helpers.js */

/**
 * The Sites list's rows and search (site page spec §3): a site
 * holding only a permission has a row of its own, which opens its page, where
 * the permission changes. `browser_sval_sites_stored.js` covers the sites
 * listed for what they store.
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
 * @returns {number} The sites the table lists at least: the rows, and every
 *   site the harness's profile holds a permission for. Sites the profile
 *   stores data for are listed too.
 */
const listed = () => new Set([...ROWS, ...sitesWithPermissions()]).size;

/** The sites with a row in the table. */
const ROWS = ["example.net", "example.org", "example.com"];

/** A site holding only a permission. */
const NOTIFY = "notify.net";

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
  const total = ui.counted()[1];
  Assert.greaterOrEqual(total, listed(), "the count holds every listed site");
  Assert.deepEqual(
    ui.counted(),
    [1, total],
    "a query counts the list's rows it shows"
  );

  ui.type("nowhere");
  Assert.deepEqual(ui.counted(), [0, total]);
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
