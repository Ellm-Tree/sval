/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_site_page_helpers.js */

/**
 * Settings › Sites with choices saved for one host under a site
 * (host-scoped rules spec §5): host rows under their site's, each row's
 * Reset taking its own choices alone, the site page at a host's scope, its
 * address surviving a reload, Add site and Add an address reaching a host, and
 * Forget's confirm naming the hosts.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_site_page_helpers.js",
  this
);

const { SvalSiteProtections, SITE_BRANCH } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
);
const { SvalJavascript, SITE_BRANCH: JS_BRANCH } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalJavascript.sys.mjs"
);
const { SvalBlocking } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
);

// No page is ever served from these names, so nothing else holds them.
const SITE = "sval-hosts-test.com";
const HOST = `app.${SITE}`;
const OTHER_HOST = `nas.${SITE}`;

function reset() {
  clearPrefBranches(SITE_BRANCH, JS_BRANCH);
  SvalBlocking.setMyFilters("");
}

add_setup(function () {
  registerCleanupFunction(reset);
});

/**
 * @returns {Promise<{page: Window, ui: object}>} Settings at the Sites list.
 */
async function openSites() {
  const { page } = await openAt("about:preferences#svalSites");
  const ui = partsOf(page);
  await until(ui.sitesShown, "the Sites list showing");
  return { page, ui };
}

/**
 * @param {object} ui
 * @param {string} name
 * @returns {?Element} The list's row for a site or a host.
 */
function rowOf(ui, name) {
  return ui.doc.querySelector(`#sval-sites-body [data-site="${name}"]`);
}

/**
 * @param {object} ui
 * @returns {Array<[string, string]>} Each row's name and level, top down.
 */
function rowsOf(ui) {
  return [...ui.doc.querySelectorAll("#sval-sites-body .sval-sites-row")].map(
    row => [row.dataset.site, row.getAttribute("aria-level")]
  );
}

function differs(ui, name) {
  return rowOf(ui, name).querySelector(".sval-sites-summary").dataset.differs;
}

/**
 * @param {object} ui
 * @returns {?Element} The "Choices for" select.
 */
function scopeSelect(ui) {
  const select = ui.byId("sval-site-scope-select");
  return select?.checkVisibility() ? select : null;
}

add_task(async function host_rows_sit_under_their_site() {
  reset();
  SvalJavascript.setEnabled(SITE, false);
  SvalJavascript.setEnabled(HOST, true);
  SvalSiteProtections.setMedia(OTHER_HOST, "allow");
  const { ui } = await openSites();
  await until(() => rowOf(ui, HOST), "the host's row");
  const rows = rowsOf(ui);
  const at = rows.findIndex(([name]) => name === SITE);
  Assert.deepEqual(
    rows.slice(at, at + 3),
    [
      [SITE, "1"],
      [HOST, "2"],
      [OTHER_HOST, "2"],
    ],
    "each host's row follows its site's, a level down"
  );
  for (const [name, level] of [
    [SITE, 1],
    [HOST, 2],
  ]) {
    const accessible = await accessibleOf(rowOf(ui, name));
    is(accessible.role, Ci.nsIAccessibleRole.ROLE_LISTITEM, `${name} a row`);
    const found = {};
    accessible.groupPosition(found, {}, {});
    is(found.value, level, `${name} at its level to assistive technology`);
  }
  is(differs(ui, SITE), "javascript:block", "the site says only its own");
  is(differs(ui, HOST), "javascript:allow", "the host says only its own");
  is(differs(ui, OTHER_HOST), "media:allow", "and so does the other host");
  ok(
    rowOf(ui, HOST).querySelector(".sval-sites-host-site"),
    "the host's name sets its site's part apart"
  );
});

add_task(async function a_site_with_only_host_choices_has_no_reset() {
  reset();
  SvalJavascript.setEnabled(HOST, false);
  const { ui } = await openSites();
  await until(() => rowOf(ui, SITE), "the site's row");
  is(
    rowOf(ui, SITE).querySelector(".sval-sites-summary").dataset.own,
    "none",
    "the site says it has no choices of its own"
  );
  ok(!rowOf(ui, SITE).querySelector(".sval-sites-reset"), "and no Reset");
  ok(rowOf(ui, HOST).querySelector(".sval-sites-reset"), "its host has one");
});

add_task(async function a_hosts_reset_leaves_the_sites_choices() {
  reset();
  SvalJavascript.setEnabled(SITE, false);
  SvalSiteProtections.setProtections(SITE, "off");
  SvalJavascript.setEnabled(HOST, true);
  SvalSiteProtections.setMedia(HOST, "allow");
  const { ui } = await openSites();
  await until(() => rowOf(ui, HOST), "the host's row");
  rowOf(ui, HOST).querySelector(".sval-sites-reset").click();
  await until(() => !rowOf(ui, HOST), "the host's row going");
  ok(!SvalJavascript.rules().has(HOST), "the host's JavaScript rule went");
  ok(!SvalSiteProtections.rules().has(HOST), "and its other choices");
  is(SvalJavascript.rules().get(SITE), "block", "the site keeps its rule");
  is(
    SvalSiteProtections.rules().get(SITE)?.protections,
    "off",
    "and its choices"
  );

  ui.byKey("sites-undo").click();
  await until(() => rowOf(ui, HOST), "Undo bringing the host back");
  is(SvalJavascript.rules().get(HOST), "allow", "with its JavaScript rule");
});

add_task(async function a_hosts_reset_takes_what_it_shows_again() {
  reset();
  const shown = `${HOST}#@#.sval-site-ad`;
  SvalBlocking.setMyFilters(`${SITE}##.sval-site-ad\n${shown}`);
  const { ui } = await openSites();
  await until(() => rowOf(ui, HOST), "the host's row for its exception");
  is(differs(ui, HOST), "shown:1", "the host counts it");
  rowOf(ui, HOST).querySelector(".sval-sites-reset").click();
  await until(() => !rowOf(ui, HOST), "the host's row going");
  is(
    SvalBlocking.myFilters,
    `${SITE}##.sval-site-ad`,
    "the host's exception went and the site's line stayed"
  );

  ui.byKey("sites-undo").click();
  await until(() => rowOf(ui, HOST), "Undo bringing the host back");
  is(
    SvalBlocking.myFilters,
    `${SITE}##.sval-site-ad\n${shown}`,
    "with its exception"
  );
});

add_task(async function a_sites_reset_leaves_its_hosts_choices() {
  reset();
  SvalJavascript.setEnabled(SITE, false);
  SvalJavascript.setEnabled(HOST, true);
  SvalBlocking.setMyFilters(`${SITE}##.sval-site-ad\n${HOST}##.sval-host-ad`);
  const { ui } = await openSites();
  await until(() => rowOf(ui, HOST), "the host's row");
  rowOf(ui, SITE).querySelector(".sval-sites-reset").click();
  await until(
    () => ui.byId("sval-blocking-dialog").open,
    "the confirm for the site's line"
  );
  ui.byId("sval-blocking-dialog-confirm").click();
  await until(
    () => rowOf(ui, SITE)?.querySelector(".sval-sites-summary").dataset.own,
    "the site keeping a row for its host, with nothing of its own"
  );
  ok(!SvalJavascript.rules().has(SITE), "the site's rule went");
  is(SvalJavascript.rules().get(HOST), "allow", "the host keeps its rule");
  is(
    SvalBlocking.myFilters,
    `${HOST}##.sval-host-ad`,
    "and its removed element"
  );
});

add_task(async function the_site_page_edits_a_hosts_own_choices() {
  reset();
  SvalJavascript.setEnabled(SITE, false);
  SvalJavascript.setEnabled(OTHER_HOST, true);
  const { page } = await openAt(`${PAGE_URL(SITE)}&scope=${HOST}`);
  const ui = await untilSitePage(page, SITE);
  await until(() => scopeSelect(ui)?.value === HOST, "the host's scope");
  const javascript = ui.byKey("site-javascript");
  is(javascript.value, "block", "the host shows what it inherits");
  ok("default" in javascript.dataset, "marked as not its own");

  change(javascript, "allow");
  await until(
    () => SvalJavascript.rules().get(HOST) === "allow",
    "the host's own rule"
  );
  is(SvalJavascript.rules().get(SITE), "block", "the site keeps its rule");
  await until(
    () => !("default" in ui.byKey("site-javascript").dataset),
    "the choice reading as the host's own"
  );

  change(ui.byKey("site-protections"), "off");
  await until(
    () => SvalSiteProtections.rules().get(HOST)?.protections === "off",
    "the host's protections"
  );
  ok(!SvalSiteProtections.rules().has(SITE), "the site has none");

  change(scopeSelect(ui), SITE);
  await until(
    () => ui.byKey("site-javascript").value === "block",
    "the site's own choice at its scope"
  );
  ok(!page.location.hash.includes("scope="), "the address drops the host");
});

add_task(async function the_hosts_scope_survives_a_reload() {
  reset();
  const { tab, page } = await openAt(`${PAGE_URL(SITE)}&scope=${HOST}`);
  let ui = await untilSitePage(page, SITE);
  await until(() => scopeSelect(ui)?.value === HOST, "the host's scope");
  ok(page.location.hash.includes(`scope=${HOST}`), "kept in the address");

  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  tab.linkedBrowser.reload();
  await within(loaded, 15_000, "the settings tab reloading");
  const again = tab.linkedBrowser.contentWindow;
  await until(() => again.SvalSettings?._els, "Sval's panes loading again");
  ui = await untilSitePage(again, SITE);
  await until(() => scopeSelect(ui)?.value === HOST, "the host's scope again");
});

add_task(async function a_scope_that_is_no_host_of_the_site_is_dropped() {
  reset();
  const { page } = await openAt(`${PAGE_URL(SITE)}&scope=example.org`);
  const ui = await untilSitePage(page, SITE);
  ok(!scopeSelect(ui), "no select for a site with no hosts");
  ok(ui.byId("sval-site-more").checkVisibility(), "Add an address is in ⋯");
  ok(!page.location.hash.includes("scope="), "the address drops it");
});

add_task(async function add_site_with_a_host_opens_its_scope() {
  reset();
  const { page, ui } = await openSites();
  ui.byKey("add-site").click();
  await until(() => ui.byKey("adding-site"), "the add row's field");
  const input = ui.byKey("adding-site");
  input.value = `https://${HOST}/inbox`;
  input.dispatchEvent(new Event("input"));
  ui.byKey("adding-site-add").click();
  await untilSitePage(page, SITE);
  await until(() => scopeSelect(ui)?.value === HOST, "the host's scope");
});

add_task(async function add_a_host_switches_to_it() {
  reset();
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  ok(!scopeSelect(ui), "no select while the site has no hosts");
  ui.byId("sval-site-more").click();
  await until(
    () => ui.byId("sval-site-more-menu").hasAttribute("open"),
    "the ⋯ menu opening"
  );
  ui.byId("sval-site-add-host").click();
  await until(() => ui.byKey("site-add-host"), "the Add an address field");
  const input = ui.byKey("site-add-host");
  input.value = "example.org";
  input.dispatchEvent(new Event("input"));
  ok(ui.byKey("site-add-host-add").disabled, "another site is refused");
  input.value = OTHER_HOST;
  input.dispatchEvent(new Event("input"));
  ui.byKey("site-add-host-add").click();
  await until(() => scopeSelect(ui)?.value === OTHER_HOST, "the host's scope");
  ok(page.location.hash.includes(`scope=${OTHER_HOST}`), "in the address");
  ok(
    ui.doc.querySelector('[data-site-card="whole"]'),
    "the whole site's cards have their heading"
  );
});

add_task(async function forget_names_the_hosts() {
  reset();
  SvalJavascript.setEnabled(HOST, false);
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  const forget = () => ui.byKey("site-forget");
  await until(() => forget() && !forget().disabled, "Forget… live");
  forget().click();
  await until(
    () => ui.doc.querySelector('.sval-forget-row[data-part="hosts"]'),
    "the confirm listing the host choices"
  );
  ui.byId("sval-blocking-dialog-cancel").click();
  is(SvalJavascript.rules().get(HOST), "block", "Cancel keeps them");
});
