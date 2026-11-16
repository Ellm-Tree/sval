/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_site_page_helpers.js */

/**
 * The site page's Permissions card (site page spec, Permissions): a row per
 * permission on one origin, a host chip on every origin other than the
 * site's https address, a change writing that origin alone, Default
 * clearing it, the cookie exception last, and changes made elsewhere
 * followed.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_site_page_helpers.js",
  this
);

const SITE = "example.com";
const HOME = "https://example.com";
const SUB = "https://alerts.example.com";

const principalOf = origin =>
  Services.scriptSecurityManager.createContentPrincipalFromOrigin(origin);

const held = (origin, id) =>
  Services.perms.testExactPermissionFromPrincipal(principalOf(origin), id);

const key = (origin, id) => `site-perm:${origin}:${id}`;

add_setup(function () {
  Services.perms.removeAll();
  registerCleanupFunction(() => Services.perms.removeAll());
});

add_task(async function a_subdomain_row_has_its_host_and_writes_only_it() {
  Services.perms.removeAll();
  Services.perms.addFromPrincipal(
    principalOf(SUB),
    "camera",
    Services.perms.ALLOW_ACTION
  );
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  const select = () => ui.byKey(key(SUB, "camera"));
  await until(select, "the subdomain's camera row");
  const label = SitePermissions.getPermissionLabel("camera");
  const name = select().getAttribute("label");
  ok(
    name.includes(label) && name.includes("alerts.example.com"),
    "named for its permission and host"
  );
  const row = select().closest(".sval-site-row");
  const chip = row.querySelector(".sval-site-host");
  is(chip.textContent, "alerts.example.com", "the chip names the host");
  is(chip.title, SUB, "with the full origin as its tooltip");
  ok(
    !ui
      .byKey(key(HOME, "camera"))
      .closest(".sval-site-row")
      .querySelector(".sval-site-host"),
    "the site's own https row has no chip"
  );

  change(select(), String(SitePermissions.BLOCK));
  await until(
    () => held(SUB, "camera") === Services.perms.DENY_ACTION,
    "the subdomain's camera blocked"
  );
  is(
    held(HOME, "camera"),
    Services.perms.UNKNOWN_ACTION,
    "the site's own address untouched"
  );

  is(select().choices[0][0], "", "Default comes first");
  is(
    select().closest(".sval-site-row").dataset.byDefault,
    String(SitePermissions.UNKNOWN),
    "Default says what the site gets without a choice"
  );
  change(select(), "");
  await until(
    () => held(SUB, "camera") === Services.perms.UNKNOWN_ACTION,
    "Default clearing the subdomain's camera"
  );
  await until(() => !select(), "the cleared row leaving the card");
  ok(
    !ui.doc.querySelector(
      '[data-site-card="permissions"] button:not(.sval-choice-pill)'
    ),
    "the rows have no clear button: Default clears"
  );
});

add_task(async function an_http_origin_gets_a_chip() {
  Services.perms.removeAll();
  // eslint-disable-next-line sdl/no-insecure-url
  const http = "http://example.com";
  Services.perms.addFromPrincipal(
    principalOf(http),
    "geo",
    Services.perms.ALLOW_ACTION
  );
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  await until(() => ui.byKey(key(http, "geo")), "the http address's row");
  const chip = ui
    .byKey(key(http, "geo"))
    .closest(".sval-site-row")
    .querySelector(".sval-site-host");
  is(chip?.textContent, http, "the chip names the scheme");
});

add_task(async function the_cookie_row_writes_the_cookie_permission() {
  Services.perms.removeAll();
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  const select = () => ui.byKey(key(HOME, "cookie"));
  await until(select, "the cookie row");
  const rows = [
    ...ui.doc.querySelectorAll(
      '[data-site-card="permissions"] sval-choice-pill'
    ),
  ];
  is(rows.at(-1), select(), "the cookie row is last");
  is(select().value, "", "it reads Default");
  Assert.deepEqual(
    select().choices.map(([value]) => value),
    [
      "",
      String(SitePermissions.ALLOW),
      String(SitePermissions.ALLOW_COOKIES_FOR_SESSION),
      String(SitePermissions.BLOCK),
    ],
    "its values"
  );
  is(
    select().closest(".sval-site-row").dataset.byDefault,
    String(SitePermissions.ALLOW),
    "Default allows"
  );
  ok(
    select().closest(".sval-site-row").querySelector(".sval-site-row-sub"),
    "its line"
  );
  change(select(), String(SitePermissions.ALLOW_COOKIES_FOR_SESSION));
  await until(
    () => held(HOME, "cookie") === SitePermissions.ALLOW_COOKIES_FOR_SESSION,
    "the cookie exception written"
  );
  change(select(), String(SitePermissions.ALLOW));
  await until(
    () => held(HOME, "cookie") === Services.perms.ALLOW_ACTION,
    "Allow written even where it is the default"
  );
  await until(
    () => select().value === String(SitePermissions.ALLOW),
    "redrawn"
  );
  change(select(), "");
  await until(
    () => held(HOME, "cookie") === Services.perms.UNKNOWN_ACTION,
    "Default removing the exception"
  );
});

add_task(async function a_change_made_elsewhere_shows() {
  Services.perms.removeAll();
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  await until(() => ui.byKey(key(HOME, "camera")), "the camera row");
  Services.perms.addFromPrincipal(
    principalOf(SUB),
    "microphone",
    Services.perms.DENY_ACTION
  );
  await until(
    () =>
      ui.byKey(key(SUB, "microphone"))?.value === String(SitePermissions.BLOCK),
    "the new permission's row"
  );
  SitePermissions.setForPrincipal(
    principalOf(HOME),
    "camera",
    SitePermissions.ALLOW
  );
  await until(
    () => ui.byKey(key(HOME, "camera")).value === String(SitePermissions.ALLOW),
    "the camera row following the site menu's change"
  );
  await until(
    () => ui.byKey("site-forget") && !ui.byKey("site-forget").disabled,
    "a permission counting as held"
  );
});

add_task(async function another_sites_change_leaves_the_page_alone() {
  Services.perms.removeAll();
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  await until(() => ui.byKey(key(HOME, "camera")), "the camera row");
  const drawn = ui.byKey(key(HOME, "camera"));
  // The permission manager notifies observers before its call returns.
  Services.perms.addFromPrincipal(
    principalOf("https://example.net"),
    "camera",
    Services.perms.ALLOW_ACTION
  );
  is(
    ui.byKey(key(HOME, "camera")),
    drawn,
    "another site's change leaves the cards as drawn"
  );
  Services.perms.addFromPrincipal(
    principalOf(SUB),
    "geo",
    Services.perms.ALLOW_ACTION
  );
  isnot(
    ui.byKey(key(HOME, "camera")),
    drawn,
    "the site's own change redraws them"
  );
});
