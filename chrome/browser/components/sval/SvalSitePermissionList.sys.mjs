/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * A site's permissions as the site page lists them (site page spec §3), and
 * the permission constants the site menu (`SvalSiteControls`) shares with it.
 *
 * A row is one permission on one origin, as Firefox's permission manager keys
 * it: a change to a row writes that origin alone. Permissions a private
 * window holds are never listed, because the page never lists private data.
 */

import {
  siteForURI,
  siteOrigins,
} from "moz-src:///browser/components/sval/SvalJavascript.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SitePermissions: "resource:///modules/SitePermissions.sys.mjs",
});

export const MEDIA_PERMISSION = "autoplay-media";

/**
 * The permissions the site menu always lists, whatever the site holds; any
 * other the site holds follows them.
 */
export const LISTED_PERMISSIONS = [
  "camera",
  "microphone",
  "geo",
  "desktop-notification",
  "popup",
];

/**
 * Permissions the site menu leaves out: media has its own row, and
 * HTTPS-Only's exception lives in the certificate view.
 */
export const UNLISTED_PERMISSIONS = new Set([
  MEDIA_PERMISSION,
  "https-only-load-insecure",
]);

/** A permission's glyph in the site menu. */
export const PERMISSION_ICONS = {
  camera: "sc-camera",
  microphone: "sc-mic",
  screen: "sc-screen",
  geo: "sc-location",
  "desktop-notification": "sc-bell",
  popup: "sc-popup",
  "persistent-storage": "sc-storage",
  "storage-access": "sc-storage",
  "local-network": "sc-network",
  "loopback-network": "sc-laptop",
  xr: "sc-glasses",
};

/** The cookie exception Manage Exceptions writes; the page lists it last. */
const COOKIE_PERMISSION = "cookie";

/** The permission that lets a site offer to install an extension. */
const INSTALL_PERMISSION = "install";

/**
 * Permissions the page offers a row for only once held. Page Info leaves
 * this one out too (`EXCLUDE_PERMS` in pageinfo/permissions.js): it is held
 * per scheme, under a type the scheme is appended to.
 */
const HELD_ONLY_PERMISSIONS = new Set(["open-protocol-handler"]);

let words = null;

/**
 * @returns {Map<number, string>} The word a permission select shows for each
 *   `SitePermissions` state it offers. Unknown and Prompt both read "Ask".
 */
export function permissionWords() {
  if (!words) {
    const SP = lazy.SitePermissions;
    words = new Map([
      [SP.ALLOW, "Allow"],
      [SP.BLOCK, "Block"],
      [SP.UNKNOWN, "Ask"],
      [SP.PROMPT, "Ask"],
    ]);
  }
  return words;
}

/**
 * @param {string} type
 * @returns {?string} What a permission is called on the site page and in the
 *   Sites list: Firefox's label, except that Sval names add-ons extensions.
 */
export function permissionLabel(type) {
  if (type === INSTALL_PERMISSION) {
    return "Install extensions";
  }
  return lazy.SitePermissions.getPermissionLabel(type);
}

/**
 * @param {{type: string, capability: number, isDefault: boolean}} perm
 * @param {?string} host The host it is held for, named when it is not the
 *   site's own.
 * @returns {string} What a held permission lets the site do, in a phrase
 *   for the Sites list, such as "Use the camera: allowed". One the defaults
 *   file grants says so, since the user never chose it.
 */
export function permissionPhrase(perm, host = null) {
  const SP = lazy.SitePermissions;
  let phrase;
  if (perm.type === INSTALL_PERMISSION) {
    phrase =
      perm.capability === SP.BLOCK
        ? "Can't install extensions"
        : "Can install extensions";
  } else {
    const label = permissionLabel(perm.type);
    const state = SP.getCurrentStateLabel(perm.capability, perm.type);
    phrase = state ? `${label}: ${state.toLowerCase()}` : label;
  }
  if (host) {
    phrase = `${phrase} on ${host}`;
  }
  return perm.isDefault ? `${phrase} (default)` : phrase;
}

/**
 * @param {string} type
 * @returns {boolean} Whether a permission of this type gets a row: one
 *   `SitePermissions` manages and names, as the site menu lists them.
 */
function shown(type) {
  const SP = lazy.SitePermissions;
  return (
    !UNLISTED_PERMISSIONS.has(type) &&
    SP.listPermissions().includes(type) &&
    !!SP.getPermissionLabel(type)
  );
}

/**
 * @returns {nsIPermission[]} Every permission a row may show, leaving out a
 *   private window's.
 */
function shownPermissions() {
  return Services.perms.all.filter(
    perm => !perm.principal.privateBrowsingId && shown(perm.type)
  );
}

/**
 * @param {nsIPrincipal} principal
 * @returns {?string} The site the principal's address belongs to.
 */
function siteOfPrincipal(principal) {
  return siteForURI(principal.URI);
}

/**
 * @param {string} id
 * @returns {number} Where the permission sorts among one origin's rows.
 */
function rank(id) {
  const listed = LISTED_PERMISSIONS.indexOf(id);
  return listed == -1 ? LISTED_PERMISSIONS.length : listed;
}

/**
 * @param {object} a
 * @param {object} b
 * @returns {number} Rows of other origins by host, then permission.
 */
function byHostThenPermission(a, b) {
  const order = (x, y) => (x > y) - (x < y);
  return (
    order(a.principal.host, b.principal.host) ||
    rank(a.id) - rank(b.id) ||
    order(a.id, b.id) ||
    order(a.origin, b.origin)
  );
}

/**
 * A site's permissions in the page's order: on the site's own https address,
 * the listed permissions, then every other permission Page Info offers, by
 * label, each held or at its default, then whatever else that address
 * holds; every permission another origin under the site holds, by host then
 * permission; then the cookie exception, offered on the site's own https
 * address even when unset.
 *
 * @param {string} site As `siteOf` cuts one.
 * @returns {Array<{id: string, origin: string, principal: nsIPrincipal,
 *   state: number, own: boolean, isDefault: boolean}>} `own` when the origin
 *   is the site's own https or http address; `isDefault` when the
 *   permission is the defaults file's grant (`nsIPermission.isDefault`).
 */
export function permissionsFor(site) {
  const SP = lazy.SitePermissions;
  const [home] = siteOrigins(site, ["https"]);
  const homeOrigin = home?.prePath;
  const ownOrigins = new Set(
    siteOrigins(site, ["https", "http"]).map(uri => uri.prePath)
  );
  const rowOf = perm => ({
    id: perm.type,
    origin: perm.principal.originNoSuffix,
    principal: perm.principal,
    state: perm.capability,
    own: ownOrigins.has(perm.principal.originNoSuffix),
    isDefault: perm.isDefault,
  });
  const held = shownPermissions()
    .filter(perm => siteOfPrincipal(perm.principal) === site)
    .map(rowOf);

  const homeRows = held.filter(row => row.origin === homeOrigin);
  const homePrincipal = home
    ? Services.scriptSecurityManager.createContentPrincipal(home, {})
    : null;
  const unset = id => ({
    id,
    origin: homeOrigin,
    principal: homePrincipal,
    state: SP.getDefault(id),
    own: true,
    isDefault: false,
  });
  const heldAtHome = id => homeRows.find(row => row.id === id);

  const offered = [
    ...LISTED_PERMISSIONS,
    ...SP.listPermissions()
      .filter(
        id =>
          shown(id) &&
          !LISTED_PERMISSIONS.includes(id) &&
          !HELD_ONLY_PERMISSIONS.has(id) &&
          id !== COOKIE_PERMISSION
      )
      .sort((a, b) => permissionLabel(a).localeCompare(permissionLabel(b))),
  ];
  const rows = [];
  if (homePrincipal) {
    for (const id of offered) {
      rows.push(heldAtHome(id) ?? unset(id));
    }
    for (const row of homeRows) {
      if (!offered.includes(row.id) && row.id !== COOKIE_PERMISSION) {
        rows.push(row);
      }
    }
  }
  const elsewhere = held.filter(row => row.origin !== homeOrigin);
  rows.push(
    ...elsewhere
      .filter(row => row.id !== COOKIE_PERMISSION)
      .sort(byHostThenPermission)
  );
  if (homePrincipal) {
    rows.push(heldAtHome(COOKIE_PERMISSION) ?? unset(COOKIE_PERMISSION));
  }
  rows.push(
    ...elsewhere
      .filter(row => row.id === COOKIE_PERMISSION)
      .sort(byHostThenPermission)
  );
  return rows;
}

/**
 * Saves a row's permission on its own origin.
 *
 * @param {object} row From `permissionsFor`.
 * @param {number} state A `SitePermissions` state other than UNKNOWN, which
 *   is no choice: `clearPermission` gives the row its default.
 */
export function setPermission(row, state) {
  lazy.SitePermissions.setForPrincipal(row.principal, row.id, state);
}

/**
 * Removes a row's permission from its own origin.
 *
 * @param {object} row From `permissionsFor`.
 */
export function clearPermission(row) {
  lazy.SitePermissions.removeFromPrincipal(row.principal, row.id);
}

/**
 * @returns {Map<string, nsIPermission[]>} Every permission a row would show,
 *   by the site it is of.
 */
export function permissionsBySite() {
  const bySite = new Map();
  for (const perm of shownPermissions()) {
    const site = siteOfPrincipal(perm.principal);
    if (site) {
      bySite.set(site, [...(bySite.get(site) ?? []), perm]);
    }
  }
  return bySite;
}

/**
 * @returns {string[]} Every site holding a permission a row would show.
 */
export function sitesWithPermissions() {
  return [...permissionsBySite().keys()];
}

/**
 * @param {string} site As `siteOf` cuts one.
 * @param {string[]} [except] Types left out of the count.
 * @returns {number} Every other permission outside private windows whose
 *   origin is of the site, rows or not, as forgetting the site clears them.
 */
export function permissionCount(site, except = []) {
  return Services.perms.all.filter(
    perm =>
      !perm.principal.privateBrowsingId &&
      !except.includes(perm.type) &&
      siteOfPrincipal(perm.principal) === site
  ).length;
}
