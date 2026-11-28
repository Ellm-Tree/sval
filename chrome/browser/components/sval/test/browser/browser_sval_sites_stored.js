/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_site_page_helpers.js */

/**
 * Settings › Sites lists every site Sval keeps anything for, once each: a
 * choice, a permission, a zoom, a spellcheck language, a last upload folder,
 * cookies or other data, each row saying what the site stores. The filters narrow that list and the search finds any
 * site in it. A site whose data is cleared on its page leaves the list when
 * nothing else is kept for it. Firefox's own site data list is not in the
 * build.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_site_page_helpers.js",
  this
);

const { SvalSiteData } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteData.sys.mjs"
);
const { SvalSiteProtections } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
);

const COOKIES = "cookies.example";
const DATA = "data.example";
const PERMISSION = "permission.example";
const ZOOM = "zoom.example";
const CHOICE = "choice.example";
const SPELLCHECK = "spellcheck.example";
const UPLOAD = "upload.example";
const KINDS = [COOKIES, DATA, PERMISSION, ZOOM, CHOICE, SPELLCHECK, UPLOAD];

const ZOOM_PREF = "browser.content.full-zoom";
const SPELLCHECK_PREF = "spellcheck.lang";
const UPLOAD_PREF = "browser.upload.lastDir";
const contentPrefs = Cc["@mozilla.org/content-pref/service;1"].getService(
  Ci.nsIContentPrefService2
);

/**
 * @param {string} site
 * @returns {nsIPrincipal}
 */
function principalOf(site) {
  return Services.scriptSecurityManager.createContentPrincipalFromOrigin(
    `https://${site}`
  );
}

/**
 * @param {string} host
 */
function addCookie(host) {
  Services.cookies.add(
    host,
    "/",
    "sval-sites-stored",
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
  const request = indexedDB.openForPrincipal(
    principalOf(site),
    "sval-sites-stored",
    1
  );
  request.onupgradeneeded = () => request.result.createObjectStore("data");
  const db = await within(
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }),
    10_000,
    "the database opening"
  );
  const tx = db.transaction("data", "readwrite");
  tx.objectStore("data").put(crypto.getRandomValues(new Uint8Array(65536)), 1);
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

/**
 * Sets or forgets one of a site's content prefs, as Gecko keeps them.
 *
 * @param {string} site
 * @param {string} name
 * @param {?(number|string)} value
 */
function setPref(site, name, value) {
  return within(
    new Promise((resolve, reject) => {
      const callback = { handleCompletion: resolve, handleError: reject };
      if (value === null) {
        contentPrefs.removeByDomainAndName(site, name, null, callback);
      } else {
        contentPrefs.set(site, name, value, null, callback);
      }
    }),
    10_000,
    `${site}'s ${name}`
  );
}

/**
 * @param {string} site
 */
async function clearData(site) {
  await within(
    new Promise(resolve =>
      Services.clearData.deleteDataFromSite(
        site,
        {},
        true,
        Ci.nsIClearDataService.CLEAR_COOKIES_AND_SITE_DATA |
          Ci.nsIClearDataService.CLEAR_ALL_CACHES,
        resolve
      )
    ),
    30_000,
    `${site} clearing`
  );
}

/** One site for each kind of thing Sval keeps, put back as the task ends. */
async function oneOfEach() {
  atTaskEnd(async () => {
    for (const site of [COOKIES, DATA]) {
      await clearData(site);
    }
    Services.perms.removeFromPrincipal(principalOf(PERMISSION), "geo");
    await setPref(ZOOM, ZOOM_PREF, null);
    await setPref(SPELLCHECK, SPELLCHECK_PREF, null);
    await setPref(UPLOAD, UPLOAD_PREF, null);
    SvalSiteProtections.setProtections(CHOICE, "on");
    await within(SvalSiteData.update(), 30_000, "the data rereading");
  });
  addCookie(COOKIES);
  await store(DATA);
  Services.perms.addFromPrincipal(
    principalOf(PERMISSION),
    "geo",
    Services.perms.ALLOW_ACTION
  );
  await setPref(ZOOM, ZOOM_PREF, 1.2);
  await setPref(SPELLCHECK, SPELLCHECK_PREF, "en-US");
  await setPref(UPLOAD, UPLOAD_PREF, PathUtils.tempDir);
  SvalSiteProtections.setProtections(CHOICE, "off");
  await within(SvalSiteData.update(), 30_000, "the data reading");
}

async function openSites() {
  const { page } = await openAt("about:preferences#svalSites");
  const ui = partsOf(page);
  await until(ui.sitesShown, "the Sites list showing");
  return { ui, page };
}

/**
 * @param {object} ui
 * @returns {string[]} the sites the list shows, in order, once each.
 */
function listed(ui) {
  return [
    ...ui.doc.querySelectorAll(
      '#sval-sites-body .sval-sites-row[aria-level="1"]'
    ),
  ].map(row => row.dataset.site);
}

/**
 * @param {object} ui
 * @param {string} site
 * @returns {?Element} the site's line under its name.
 */
function lineOf(ui, site) {
  return ui.doc.querySelector(
    `#sval-sites-body [data-site="${site}"] .sval-sites-summary`
  );
}

/**
 * Types `text` in the list's search.
 *
 * @param {object} ui
 * @param {string} text
 */
function search(ui, text) {
  const field = ui.byId("sval-sites-search");
  field.value = text;
  field.dispatchEvent(new Event("input"));
}

add_task(async function every_kind_of_site_is_listed_once() {
  await oneOfEach();
  const { ui } = await openSites();
  search(ui, ".example");
  await until(
    () => KINDS.every(site => listed(ui).includes(site)),
    "each kind of site listed"
  );
  for (const site of KINDS) {
    Assert.equal(
      listed(ui).filter(name => name === site).length,
      1,
      `${site} has one row`
    );
  }
  Assert.equal(lineOf(ui, COOKIES).dataset.stored, "cookies", "cookies");
  Assert.equal(lineOf(ui, DATA).dataset.stored, "data", "data");
  Assert.ok(/\d/.test(lineOf(ui, DATA).textContent), "with its size");
  Assert.equal(lineOf(ui, ZOOM).dataset.stored, "zoom", "a zoom");
  Assert.stringContains(lineOf(ui, ZOOM).textContent, "120%", "at 120%");
  Assert.equal(
    lineOf(ui, SPELLCHECK).dataset.stored,
    "spellcheck",
    "a spellcheck language"
  );
  Assert.stringContains(
    lineOf(ui, SPELLCHECK).textContent,
    Services.intl.getLocaleDisplayNames(undefined, ["en-US"])[0],
    "named"
  );
  Assert.equal(
    lineOf(ui, UPLOAD).dataset.stored,
    "upload",
    "a last upload folder"
  );
  Assert.equal(
    lineOf(ui, PERMISSION).dataset.differs,
    `geo:${Services.perms.ALLOW_ACTION}`,
    "a permission"
  );
  Assert.equal(
    lineOf(ui, CHOICE).dataset.differs,
    "protections:off",
    "a choice"
  );
  for (const site of KINDS) {
    Assert.ok(
      !lineOf(ui, site).textContent.includes("·"),
      `${site}'s line joins nothing with a dot`
    );
  }
  Assert.ok(
    !ui.doc.querySelector('#sval-sites-filter option[value="data"]'),
    "the filter has no choice of its own for stored data"
  );
});

add_task(async function the_filters_and_search_narrow_the_whole_list() {
  await oneOfEach();
  const { ui } = await openSites();
  search(ui, ".example");
  await until(() => listed(ui).includes(COOKIES), "the cookies site listed");
  change(ui.byId("sval-sites-filter"), "off");
  await until(
    () => listed(ui).includes(CHOICE) && !listed(ui).includes(COOKIES),
    "a filter keeps the sites it names"
  );
  change(ui.byId("sval-sites-filter"), "all");
  search(ui, "zoom.ex");
  await until(
    () => listed(ui).length === 1 && listed(ui)[0] === ZOOM,
    "the search finds a site with only a zoom"
  );
});

add_task(async function a_cleared_site_leaves_the_list() {
  await oneOfEach();
  const { ui, page } = await openSites();
  search(ui, COOKIES);
  await until(() => listed(ui).includes(COOKIES), "the cookies site listed");
  ui.doc.querySelector(`[data-sval-key="site-link:${COOKIES}"]`).click();
  const sitePage = await untilSitePage(page, COOKIES);
  const everywhere = await TestUtils.waitForCondition(
    () =>
      ui.doc.querySelector(
        ".sval-site-data-everywhere:not([aria-disabled='true'])"
      ),
    "Clear everywhere offered"
  );
  everywhere.click();
  const dialog = ui.byId("sval-blocking-dialog");
  await until(() => dialog.open, "the confirm opening");
  ui.byId("sval-blocking-dialog-confirm").click();
  await until(
    () => !Services.cookies.getCookiesFromHost(COOKIES, {}).length,
    "the site's cookies going"
  );
  ok(sitePage, "cleared from its page");
  ui.byId("sval-site-back").click();
  await until(ui.sitesShown, "back on the Sites list");
  await until(
    () => !listed(ui).includes(COOKIES),
    "the site, with nothing else kept, leaves the list"
  );
});

add_task(async function the_list_stays_quick_with_thousands_of_sites() {
  const sites = Array.from({ length: 2000 }, (_, i) => `many-${i}.example`);
  atTaskEnd(async () => {
    for (const site of sites) {
      Services.cookies.removeCookiesFromExactHost(site, "{}");
    }
    await within(SvalSiteData.update(), 60_000, "the data rereading");
  });
  for (const site of sites) {
    addCookie(site);
  }
  await within(SvalSiteData.update(), 60_000, "the data reading");
  const { ui, page } = await openSites();
  await until(
    () => ui.doc.querySelector('[data-sval-key="sites-more"]'),
    "the long list drawn"
  );
  const started = performance.now();
  page.SvalSettings._describeSites();
  const took = performance.now() - started;
  info(
    `the Sites list drew ${sites.length} stored sites in ${took.toFixed(1)} ms`
  );
  Assert.less(took, 2000, `the list draws in ${took.toFixed(0)} ms`);
});

add_task(async function firefox_site_data_list_is_gone() {
  await Assert.rejects(
    fetch(
      "chrome://browser/content/preferences/dialogs/siteDataSettings.xhtml"
    ),
    /./,
    "Firefox's site data dialog is not in the build"
  );
});
