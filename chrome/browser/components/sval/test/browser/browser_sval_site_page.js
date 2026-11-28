/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_site_page_helpers.js */

/**
 * Settings › Sites › a site's page (site page spec): its address,
 * its header, the Protections and JavaScript cards writing the stores the
 * protection button and the JavaScript button write, the Sites card's link
 * to it and the way back, and the site menu's "Manage in Settings".
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
const { SvalSiteData } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteData.sys.mjs"
);

const { SvalKeepLinks } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalKeepLinks.sys.mjs"
);

const SITE = "example.com";
// Other files load pages from the harness's hosts, which keep stored data
// for the session; no page is ever served from this one.
const EMPTY = "sval-site-page-empty.com";
const PICKER_PAGE =
  "https://example.net/browser/browser/components/sval/test/browser/sval_element_picker.html";

function reset() {
  clearPrefBranches(SITE_BRANCH, JS_BRANCH, "browser.sval.keepLinks.site.");
  SvalBlocking.setMyFilters("");
}

add_setup(function () {
  registerCleanupFunction(reset);
});

/**
 * Reads stored data before the page opens: until a read answers, the page
 * cannot know a site holds nothing.
 */
async function readSiteData() {
  await within(SvalSiteData.update(), 30_000, "the site data reading");
}

add_task(async function the_address_opens_the_page_and_survives_reload() {
  reset();
  await readSiteData();
  const { tab, page } = await openAt(PAGE_URL(EMPTY));
  let ui = await untilSitePage(page, EMPTY);
  Assert.stringContains(page.document.title, EMPTY, "the tab's title");
  ok(!ui.sitesShown(), "the Sites pane's cards are hidden");
  ok(
    page.location.hash.includes(`host=${EMPTY}`),
    "the address keeps the host"
  );
  ok(ui.byId("sval-site-back").checkVisibility(), "with a way back");
  ok(
    ui.byId("sval-site-back").getAttribute("aria-label"),
    "named for where it goes"
  );
  await until(
    () => ui.byId("sval-site-nothing")?.checkVisibility(),
    "the line for a site Sval holds nothing for"
  );
  Assert.stringContains(
    ui.byId("sval-site-nothing").textContent,
    EMPTY,
    "naming the site"
  );

  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  tab.linkedBrowser.reload();
  await within(loaded, 15_000, "the settings tab reloading");
  const again = tab.linkedBrowser.contentWindow;
  await until(() => again.SvalSettings?._els, "Sval's panes loading again");
  ui = await untilSitePage(again, EMPTY);
  Assert.stringContains(again.document.title, EMPTY, "the title after reload");
});

add_task(async function nothing_held_follows_a_choice_made_here() {
  reset();
  await readSiteData();
  const { page } = await openAt(PAGE_URL(EMPTY));
  const ui = await untilSitePage(page, EMPTY);
  const nothing = () => ui.byId("sval-site-nothing").checkVisibility();
  await until(nothing, "Nothing held for an empty site");
  change(ui.byKey("site-protections"), "off");
  await until(() => !nothing(), "a choice made here hiding the line");
  change(ui.byKey("site-protections"), "");
  await until(nothing, "Default bringing the line back");
});

add_task(async function the_nav_sites_button_leaves_the_page() {
  reset();
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  const crumbs = [...ui.byId("sval-site-crumbs").querySelectorAll("a")];
  Assert.deepEqual(
    crumbs.map(a => a.dataset.crumb),
    ["sites"],
    "the breadcrumb is Sites › the site"
  );
  ui.byId("category-svalSites").buttonEl.click();
  await until(
    () => ui.sitesShown() && !ui.shown(),
    "the nav's Sites showing the list"
  );
  is(page.location.hash, "#svalSites", "the address is Sites'");
});

add_task(async function a_site_with_a_choice_holds_something() {
  reset();
  SvalSiteProtections.setProtections(SITE, "off");
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  await until(
    () => page.SvalSettings._sitePage.held !== null,
    "the site's holdings counted"
  );
  ok(page.SvalSettings._sitePage.held, "a choice is something held");
  ok(!ui.byId("sval-site-nothing").checkVisibility(), "no Nothing held line");
});

add_task(async function the_cards_write_the_stores() {
  reset();
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  const protections = ui.byKey("site-protections");
  is(protections.value, "", "Protections reads Default");
  change(protections, "off");
  await until(
    () => SvalSiteProtections.ruleFor(SITE).protections === "off",
    "the Protections choice reaching the store"
  );
  await until(
    () => ui.byKey("site-protections").value === "off",
    "the select redrawn with it"
  );
  change(ui.byKey("site-protections"), "");
  await until(
    () => !SvalSiteProtections.ruleFor(SITE).protections,
    "Default removing the choice"
  );

  change(ui.byKey("site-media"), "block");
  await until(
    () => SvalSiteProtections.ruleFor(SITE).media === "block",
    "the Video and audio choice reaching the store"
  );
  is(
    ui.byKey("site-media").closest(".sval-site-row").dataset.fallback,
    SvalSiteProtections.mediaDefault(),
    "the media row names the default"
  );

  is(ui.byKey("site-javascript").value, "", "JavaScript reads Default");
  change(ui.byKey("site-javascript"), "block");
  await until(
    () => SvalJavascript.rules().get(SITE) === "block",
    "the JavaScript choice reaching its rules"
  );
  await until(
    () => ui.byKey("site-javascript").value === "block",
    "the JavaScript select redrawn"
  );
  change(ui.byKey("site-javascript"), "");
  await until(
    () => !SvalJavascript.rules().has(SITE),
    "Default removing the JavaScript rule"
  );

  ok(!ui.byKey("site-keep-links").checked, "Keep links in this tab reads off");
  ui.byKey("site-keep-links").click();
  await until(
    () => SvalKeepLinks.ruleFor(SITE) === "on",
    "the Keep links in this tab choice reaching its rules"
  );
  ui.byKey("site-keep-links").click();
  await until(
    () => !SvalKeepLinks.hasRule(SITE),
    "turning it back off removing the rule"
  );

  ui.byKey("site-exceptions").click();
  await until(
    () => ui.doc.querySelector("#sval-site-page [data-exception]"),
    "the fingerprinting exceptions opening"
  );
  const first = ui.doc.querySelector("#sval-site-page [data-exception]");
  first.click();
  await until(
    () =>
      SvalSiteProtections.exceptionsFor(SITE).includes(first.dataset.exception),
    "an exception reaching the store"
  );
});

add_task(async function the_sites_card_link_opens_the_page_and_back_returns() {
  reset();
  SvalSiteProtections.setProtections(SITE, "off");
  SvalSiteProtections.setProtections("example.net", "off");
  const { page } = await openAt("about:preferences#svalSites");
  const ui = partsOf(page);
  await until(ui.sitesShown, "the Sites card showing");
  const sitesTitle = page.document.title;
  const search = ui.byId("sval-sites-search");
  search.value = "example.c";
  search.dispatchEvent(new Event("input"));
  const link = () =>
    ui.doc.querySelector(`#sval-sites-body [data-site="${SITE}"] a`);
  await until(link, "the site's link");
  is(link().textContent, SITE, "the site name is the link");

  link().click();
  await untilSitePage(page, SITE);
  ok(page.location.hash.includes(`host=${SITE}`), "the address names it");

  ui.byId("sval-site-back").click();
  await until(() => ui.sitesShown() && !ui.shown(), "back on the Sites card");
  is(ui.byId("sval-sites-search").value, "example.c", "the search is kept");
  is(page.location.hash, "#svalSites", "the address is Sites'");
  await until(
    () => page.document.title === sitesTitle,
    "the title being Settings' again"
  );

  link().click();
  await untilSitePage(page, SITE);
  page.history.back();
  await until(
    () => ui.sitesShown() && !ui.shown(),
    "the browser's Back returning to the card"
  );
  is(ui.byId("sval-sites-search").value, "example.c", "the search still kept");

  link().click();
  await untilSitePage(page, SITE);
  ui.doc.querySelector('#sval-site-crumbs [data-crumb="sites"]').click();
  await until(
    () => ui.sitesShown() && !ui.shown(),
    "the breadcrumb returning to the card"
  );
});

add_task(async function a_host_that_is_no_site_lands_on_the_sites_card() {
  reset();
  for (const host of ["", "not%20a%20site", `www.${SITE}`]) {
    const { tab, page } = await openAt(PAGE_URL(host));
    const ui = partsOf(page);
    await until(ui.sitesShown, `host=${host} showing the Sites card`);
    ok(!ui.shown(), `host=${host} shows no site page`);
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function the_sites_row_reset_says_what_stays() {
  reset();
  SvalSiteProtections.setProtections(SITE, "off");
  const { page } = await openAt("about:preferences#svalSites");
  const ui = partsOf(page);
  const button = () =>
    ui.doc.querySelector(
      `#sval-sites-body [data-site="${SITE}"] .sval-sites-reset`
    );
  await until(button, "the row's Reset");
  ok(button().textContent, "its label");
  await button().updateComplete;
  const acc = await accessibleOf(button().shadowRoot.querySelector("button"));
  Assert.stringContains(acc.name, SITE, "its name names the site");
  ok(button().title, "its tooltip says what stays");
});

add_task(async function manage_in_settings_opens_the_page() {
  reset();
  SvalBlocking.setMyFilters("example.net##.sval-test-ad");
  await BrowserTestUtils.withNewTab(PICKER_PAGE, async () => {
    const menu = document.getElementById("sval-site-menu");
    await until(
      () => !document.getElementById("sval-site-menu-button").disabled,
      "the site menu reading the page"
    );
    const shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
    document.getElementById("sval-site-menu-button").click();
    await within(shown, 5_000, "the site menu's popupshown");
    document.getElementById("sval-site-hidden-toggle").click();
    const opened = BrowserTestUtils.waitForNewTab(gBrowser, url =>
      url.startsWith("about:preferences")
    );
    document.getElementById("sval-site-hidden-manage").click();
    const tab = await within(opened, 15_000, "the settings tab opening");
    atTaskEnd(() => {
      if (tab.parentNode) {
        BrowserTestUtils.removeTab(tab);
      }
    });
    const page = tab.linkedBrowser.contentWindow;
    await until(() => page.SvalSettings?._els, "Sval's panes loading");
    await untilSitePage(page, "example.net");
  });
});
