/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_site_page_helpers.js */

/**
 * A site's page under "Always use private browsing mode" (site page spec
 * §5): the data, hidden elements and permissions cards list what the site
 * holds without a way to change it, and there is no Forget card, since a
 * private window's state is none of what Forget clears.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_site_page_helpers.js",
  this
);

const SITE = "sval-always-private-page.com";

/** Gives the site a cookie outside private windows, cleared at task end. */
function holdCookie() {
  Services.cookies.add(
    SITE,
    "/",
    "sval-always-private-page",
    "1",
    true,
    false,
    false,
    Date.now() + 3600 * 1000,
    {},
    Ci.nsICookie.SAMESITE_LAX,
    Ci.nsICookie.SCHEME_HTTPS
  );
  atTaskEnd(() =>
    within(
      new Promise(resolve =>
        Services.clearData.deleteDataFromSite(
          SITE,
          {},
          true,
          Ci.nsIClearDataService.CLEAR_COOKIES_AND_SITE_DATA,
          resolve
        )
      ),
      30_000,
      "the site clearing in teardown"
    )
  );
}

add_task(async function the_data_card_lists_without_buttons() {
  Assert.ok(
    PrivateBrowsingUtils.permanentPrivateBrowsing,
    "the browser is in permanent private browsing"
  );
  holdCookie();
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  const card = () => ui.doc.querySelector('[data-site-card="data"]');
  await until(
    () => card()?.querySelector(".sval-site-data-row"),
    "the site's cookie listed"
  );
  is(
    card().querySelector(".sval-site-data-row").dataset.jar,
    "shared",
    "in the shared jar"
  );
  ok(
    !card().querySelector("button, sval-button"),
    "no Clear, Clear everywhere or links"
  );
});

add_task(async function there_is_no_forget_card() {
  holdCookie();
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  await until(
    () => ui.doc.querySelector('[data-site-card="data"] .sval-site-data-row'),
    "the site's page drawn with its data"
  );
  ok(
    !ui.doc.querySelector('[data-site-card="forget"]'),
    "Forget is not offered"
  );
  ok(!ui.byKey("site-forget"), "nor its button");
});

add_task(async function the_hidden_card_lists_without_buttons() {
  const { SvalBlocking } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
  );
  const lines = Array.from({ length: 3 }, (_, i) => `${SITE}##.sval-ad-${i}`);
  SvalBlocking.setMyFilters(lines.join("\n"));
  atTaskEnd(() => SvalBlocking.setMyFilters(""));
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  const card = () => ui.doc.querySelector('[data-site-card="hidden"]');
  await until(
    () => card()?.querySelectorAll(".sval-sites-hidden-row").length === 3,
    "every line listed"
  );
  ok(
    !card().querySelector("button, sval-button"),
    "no Show again and no My filters link"
  );
});

add_task(async function the_permissions_card_shows_values_as_text() {
  const principal = Services.scriptSecurityManager.createContentPrincipal(
    Services.io.newURI(`https://alerts.${SITE}`),
    {}
  );
  Services.perms.addFromPrincipal(
    principal,
    "camera",
    Services.perms.ALLOW_ACTION
  );
  atTaskEnd(() => Services.perms.removeFromPrincipal(principal, "camera"));
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  const value = () => ui.byKey(`site-perm:https://alerts.${SITE}:camera`);
  await until(value, "the subdomain's camera row");
  const card = ui.doc.querySelector('[data-site-card="permissions"]');
  ok(!card.querySelector("select, sval-choice-pill"), "no choices");
  ok(!card.querySelector("button, sval-button"), "no ×");
  is(value().dataset.value, String(SitePermissions.ALLOW), "the value as text");
});
