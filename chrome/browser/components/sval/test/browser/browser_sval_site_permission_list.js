/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * A site's permissions as the site page lists them (site page spec §3): every
 * permission Page Info offers, on the site's own address, the five the site
 * menu lists first, then what else it holds, each
 * other origin under the site on rows of its own, and the cookie exception
 * last. A change writes only the row's own origin.
 */

const {
  LISTED_PERMISSIONS,
  permissionLabel,
  permissionsFor,
  setPermission,
  clearPermission,
  sitesWithPermissions,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSitePermissionList.sys.mjs"
);
const { siteForURI } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSite.sys.mjs"
);

const SITE = "a.com";

/**
 * The permissions the site's own address offers, held or not: the listed
 * five, then each other one Page Info offers, by label.
 */
function offered() {
  const others = new Set([
    ...LISTED_PERMISSIONS,
    "autoplay-media",
    "https-only-load-insecure",
    "open-protocol-handler",
    "cookie",
  ]);
  return [
    ...LISTED_PERMISSIONS,
    ...SitePermissions.listPermissions()
      .filter(id => !others.has(id) && permissionLabel(id))
      .sort((a, b) => permissionLabel(a).localeCompare(permissionLabel(b))),
  ];
}

/**
 * @param {string} origin
 * @param {object} [attrs]
 * @returns {nsIPrincipal}
 */
function principalOf(origin, attrs = {}) {
  return Services.scriptSecurityManager.createContentPrincipal(
    Services.io.newURI(origin),
    attrs
  );
}

/**
 * @param {object} row
 * @returns {string} The row as "origin id state own", for comparing lists.
 */
function describe(row) {
  return `${row.origin} ${row.id} ${row.state} ${row.own}`;
}

function removeAll() {
  for (const perm of Services.perms.all) {
    if (siteForURI(perm.principal.URI) === SITE) {
      Services.perms.removePermission(perm);
    }
  }
}

add_setup(async function () {
  removeAll();
  registerCleanupFunction(removeAll);
});

add_task(async function a_sites_permissions_in_the_pages_order() {
  removeAll();
  const SP = SitePermissions;
  SP.setForPrincipal(principalOf("https://a.com"), "camera", SP.ALLOW);
  SP.setForPrincipal(
    principalOf("https://mail.a.com"),
    "desktop-notification",
    SP.BLOCK
  );
  SP.setForPrincipal(principalOf("https://a.com:8443"), "geo", SP.ALLOW);
  SP.setForPrincipal(
    principalOf("https://a.com"),
    "cookie",
    SP.ALLOW_COOKIES_FOR_SESSION
  );
  SP.setForPrincipal(principalOf("https://a.com"), "screen", SP.BLOCK);
  // The site's http address keys a permission of its own.
  // eslint-disable-next-line sdl/no-insecure-url
  SP.setForPrincipal(principalOf("http://a.com"), "camera", SP.BLOCK);
  SP.setForPrincipal(principalOf("https://mail.a.com"), "cookie", SP.ALLOW);
  // An internal permission with no row of its own.
  Services.perms.addFromPrincipal(
    principalOf("https://a.com"),
    "3rdPartyStorage^https://x.com",
    Services.perms.ALLOW_ACTION
  );
  // A permission no row shows, and one from a private window.
  SP.setForPrincipal(principalOf("https://a.com"), "autoplay-media", SP.ALLOW);
  SP.setForPrincipal(
    principalOf("https://a.com", { privateBrowsingId: 1 }),
    "microphone",
    SP.ALLOW,
    SP.SCOPE_SESSION
  );

  const rows = permissionsFor(SITE);
  const held = { camera: SP.ALLOW, screen: SP.BLOCK };
  const listed = offered().map(
    id => `https://a.com ${id} ${held[id] ?? SP.getDefault(id)} true`
  );
  Assert.ok(offered().includes("install"), "installing is offered");
  Assert.deepEqual(
    rows.map(describe),
    [
      ...listed,
      // eslint-disable-next-line sdl/no-insecure-url
      `http://a.com camera ${SP.BLOCK} true`,
      `https://a.com:8443 geo ${SP.ALLOW} false`,
      `https://mail.a.com desktop-notification ${SP.BLOCK} false`,
      `https://a.com cookie ${SP.ALLOW_COOKIES_FOR_SESSION} true`,
      `https://mail.a.com cookie ${SP.ALLOW} false`,
    ],
    "the site's own, then other origins, then cookies"
  );
  Assert.ok(
    !rows.some(r => r.id.startsWith("3rdPartyStorage")),
    "an internal permission has no row"
  );
  for (const row of rows) {
    Assert.equal(
      row.principal.originNoSuffix,
      row.origin,
      `${row.id} on ${row.origin} carries its own principal`
    );
  }

  Assert.ok(
    sitesWithPermissions().includes(SITE),
    "the site is among the sites holding permissions"
  );

  const mail = rows.find(r => r.origin == "https://mail.a.com");
  setPermission(mail, SP.ALLOW);
  Assert.equal(
    SP.getForPrincipal(
      principalOf("https://mail.a.com"),
      "desktop-notification"
    ).state,
    SP.ALLOW,
    "setting a host row changes its own origin"
  );
  Assert.equal(
    SP.getForPrincipal(principalOf("https://a.com"), "desktop-notification")
      .state,
    SP.getDefault("desktop-notification"),
    "and not the site's"
  );

  clearPermission(mail);
  Assert.ok(
    !permissionsFor(SITE).some(
      r => r.origin == "https://mail.a.com" && r.id == "desktop-notification"
    ),
    "a cleared host row is gone"
  );

  removeAll();
});

add_task(async function cookies_are_offered_with_nothing_held() {
  removeAll();
  const rows = permissionsFor(SITE);
  Assert.deepEqual(
    rows.map(r => r.id),
    [...offered(), "cookie"],
    "a site holding nothing still offers every permission and Cookies"
  );
  Assert.equal(
    rows.at(-1).state,
    SitePermissions.getDefault("cookie"),
    "Cookies at their default"
  );
  Assert.ok(
    !sitesWithPermissions().includes(SITE),
    "and the site holds no permissions"
  );
});
