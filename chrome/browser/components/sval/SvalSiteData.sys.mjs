/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * A site's cookies and site data, by the workspace whose jar holds them
 * (site page spec §4, "Cookies and site data"), read from `SiteDataManager`
 * and cleared through `Services.clearData` one jar at a time or all at once.
 *
 * `SiteDataManager.getSites` and `getSite` answer from the last
 * `updateSites`, and through a promise. The Settings page draws its rows
 * synchronously, so each update keeps its own copy of that answer, which
 * `jarsFor` and `sitesWithData` read.
 */

import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ContextualIdentityService:
    "resource://gre/modules/ContextualIdentityService.sys.mjs",
  SiteDataManager: "resource:///modules/SiteDataManager.sys.mjs",
  SvalPrivateJars: "moz-src:///browser/components/sval/SvalPrivateJars.sys.mjs",
  SvalWorkspaceJar:
    "moz-src:///browser/components/sval/SvalWorkspaceJar.sys.mjs",
  siteForURI: "moz-src:///browser/components/sval/SvalSite.sys.mjs",
  siteOrigins: "moz-src:///browser/components/sval/SvalSite.sys.mjs",
  switcherItems: "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
});

/** What clearing a jar for a site removes, as `SiteDataManager.remove` does. */
const CLEAR_FLAGS =
  Ci.nsIClearDataService.CLEAR_COOKIES_AND_SITE_DATA |
  Ci.nsIClearDataService.CLEAR_ALL_CACHES;

/**
 * The last update's sites, by `SiteDataManager`'s base domain or host.
 *
 * @type {Map<string, object>}
 */
let sites = new Map();

/** The update reading now, or null. */
let running = null;

/**
 * The update that starts once `running` ends, shared by every caller that
 * asked while it ran: `updateSites` restarts its read when called again, so
 * a caller that changed data must wait for a read begun after its change.
 */
let queued = null;

/**
 * @param {number} userContextId
 * @returns {boolean} whether no contextual identity, public or private, has
 *   this id.
 */
function hasNoIdentity(userContextId) {
  return (
    !lazy.ContextualIdentityService.getPrivateIdentityFromId(userContextId) &&
    !lazy.ContextualIdentityService.getPublicIdentityFromId(userContextId)
  );
}

/**
 * Clears `site`'s data in the jars `pattern` matches.
 *
 * @param {string} site
 * @param {object} pattern An OriginAttributesPattern.
 * @returns {Promise<number>} the callback's bitmask of the flags that failed.
 */
function clearSite(site, pattern) {
  return new Promise(resolve => {
    Services.clearData.deleteDataFromSite(
      Services.eTLD.getSchemelessSiteFromHost(site),
      pattern,
      true,
      CLEAR_FLAGS,
      resolve
    );
  });
}

/**
 * The principals of `site` that pages open in the jar `pattern` names have,
 * frames included.
 *
 * @param {string} site
 * @param {{userContextId: number, privateBrowsingId: number}} pattern
 * @returns {nsIPrincipal[]}
 */
function openPrincipalsOf(site, { userContextId, privateBrowsingId }) {
  const schemeless = Services.eTLD.getSchemelessSiteFromHost(site);
  const found = new Map();
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    for (const tab of win.gBrowser?.tabs ?? []) {
      const top = tab.linkedBrowser?.browsingContext;
      for (const context of top?.getAllBrowsingContextsInSubtree() ?? []) {
        const principal = context.currentWindowGlobal?.documentPrincipal;
        const attrs = principal?.originAttributes;
        if (
          principal?.isContentPrincipal &&
          attrs.userContextId === userContextId &&
          attrs.privateBrowsingId === privateBrowsingId &&
          principal.baseDomain === schemeless
        ) {
          found.set(principal.origin, principal);
        }
      }
    }
  }
  return [...found.values()];
}

/**
 * @param {nsIPrincipal} principal
 * @returns {Promise<boolean>} whether the quota manager cleared its storage.
 */
function clearStorageOf(principal) {
  return new Promise(resolve => {
    const request = Services.qms.clearStoragesForPrincipal(principal);
    request.callback = () => resolve(request.resultCode === Cr.NS_OK);
  });
}

export const SvalSiteData = {
  TOPIC: "sval-site-data-updated",

  /** Whether an update has answered since startup. */
  ready: false,

  /**
   * Reads every site's data again (`SiteDataManager.updateSites`, which is
   * slow), then notifies {@link TOPIC}.
   *
   * @returns {Promise<void>}
   */
  update() {
    if (!running) {
      running = this._read().finally(() => {
        running = null;
      });
      return running;
    }
    if (!queued) {
      const next = () => {
        queued = null;
        return this.update();
      };
      queued = running.then(next, next);
    }
    return queued;
  },

  async _read() {
    await lazy.SiteDataManager.updateSites();
    const found = await lazy.SiteDataManager.getSites();
    sites = new Map(found.map(entry => [entry.baseDomain, entry]));
    this.ready = true;
    Services.obs.notifyObservers(null, this.TOPIC);
  },

  /**
   * The jars holding `site`'s data, as the Settings page lists them: the
   * shared jar, then each isolated workspace's by size, largest first, then
   * one row for every jar that is a Sval workspace's with no isolated
   * workspace in `nodes`, or that has no contextual identity at all. A jar
   * of any other identity, such as Firefox's internal ones or a container,
   * has no row, nor does one with no cookies and no usage.
   *
   * Without `nodes`, which no window's panel may hold, which workspaces are
   * isolated is unknown: each Sval workspace's jar is an isolated row with
   * no name, and none is taken for removed.
   *
   * @param {string} site As `siteOf` cuts one.
   * @param {?object} nodes The document's nodes, by id, or null while no
   *   window's panel is started.
   * @returns {Array<{kind: "shared"|"isolated"|"removed",
   *   userContextIds: number[], workspaceId?: string, name?: string,
   *   usage: number}>}
   */
  jarsFor(site, nodes) {
    const jars = this._jarsOf(site);
    if (!jars.length) {
      return [];
    }
    // The identities load in an idle task after startup; reading them before
    // that finds none (`SvalWorkspaceJar.identityOf`).
    lazy.ContextualIdentityService.ensureDataReady();
    const items = nodes ? lazy.switcherItems(nodes, null) : [];
    const byId = new Map(items.map(item => [item.id, item]));
    let shared = null;
    const isolated = [];
    let removed = null;
    for (const [userContextId, jar] of jars) {
      if (!jar.cookiesBlocked && !jar.quotaUsage) {
        continue;
      }
      const usage = jar.quotaUsage;
      if (userContextId === 0) {
        shared = {
          kind: "shared",
          userContextIds: [0],
          usage,
        };
        continue;
      }
      const workspaceId =
        lazy.SvalWorkspaceJar.identityOf(userContextId)?.workspaceId;
      if (!workspaceId && !hasNoIdentity(userContextId)) {
        continue;
      }
      const item = byId.get(workspaceId);
      if (
        (workspaceId && !nodes) ||
        (item && lazy.SvalWorkspaceJar.isIsolated(nodes, workspaceId))
      ) {
        isolated.push({
          kind: "isolated",
          userContextIds: [userContextId],
          workspaceId,
          name: item?.name ?? "",
          usage,
        });
        continue;
      }
      removed ??= { kind: "removed", userContextIds: [], usage: 0 };
      removed.userContextIds.push(userContextId);
      removed.usage += usage;
    }
    isolated.sort((a, b) => b.usage - a.usage);
    return [shared, ...isolated, removed].filter(Boolean);
  },

  /**
   * What every jar the last update read holds of `site`, those `jarsFor`
   * lists and the ones it leaves out alike, as clearing the site everywhere
   * deletes it.
   *
   * @param {string} site As `siteOf` cuts one.
   * @returns {{jars: number, usage: number}} The jars holding cookies or
   *   usage, and their usage together.
   */
  heldFor(site) {
    let jars = 0;
    let usage = 0;
    for (const [, jar] of this._jarsOf(site)) {
      if (jar.cookiesBlocked || jar.quotaUsage) {
        jars++;
        usage += jar.quotaUsage;
      }
    }
    return { jars, usage };
  },

  /**
   * The last update's data for the site, by jar, leaving out private
   * windows' jars (site page spec §5). `SiteDataManager` files a private
   * tab's storage under its jar, since the quota manager's usage includes
   * private origins; its cookies come from `Services.cookies.cookies`,
   * which has none of a private window's (`CookieService::GetCookies`).
   *
   * @param {string} site
   * @returns {Array<[number, object]>}
   */
  _jarsOf(site) {
    const jars =
      sites.get(lazy.SiteDataManager.getBaseDomainFromHost(site))
        ?.containersData ?? new Map();
    return [...jars].filter(
      ([userContextId]) => !lazy.SvalPrivateJars.isPrivateJar(userContextId)
    );
  },

  /**
   * Clears `site`'s cookies, storage and caches in each jar, then updates.
   *
   * @param {string} site
   * @param {number[]} userContextIds
   * @returns {Promise<{failed: number[]}>} the jars that did not fully clear.
   */
  async clearJars(site, userContextIds) {
    const results = await Promise.all(
      userContextIds.map(userContextId => clearSite(site, { userContextId }))
    );
    const failed = userContextIds.filter((_, i) => results[i]);
    if (failed.length) {
      SvalLog.warn(`site data left in ${failed.length} jars`);
    }
    await this.update();
    return { failed };
  },

  /**
   * Clears `site`'s cookies, storage and caches in the one jar a page's
   * origin attributes name, private or not, and starts an update without
   * waiting for it: `SiteDataManager.updateSites` is slow, and the page's
   * reload waits on this.
   *
   * A private jar keeps two things a clear by site does not reach. Its
   * cookies are missing from `Services.cookies.cookies`, which
   * `CookieCleaner.deleteBySite` reads (`CookieService::GetCookies` lists
   * the persistent store alone), so they are removed by pattern, which
   * `CookieService::PickStorage` sends to the private store. Its
   * localStorage lives in memory, outside the quota manager's origin list
   * that `QuotaCleaner` filters (`gPrivateDatastores` in
   * `dom/localstorage/ActorsParent.cpp`), so each origin of the site open in
   * the jar is cleared by principal.
   *
   * @param {string} site
   * @param {object} originAttributes The page's.
   * @param {number} [originAttributes.userContextId]
   * @param {number} [originAttributes.privateBrowsingId]
   * @returns {Promise<{failed: boolean}>}
   */
  async clearJarOf(site, { userContextId = 0, privateBrowsingId = 0 }) {
    const pattern = { userContextId, privateBrowsingId };
    let failed = !!(await clearSite(site, pattern));
    if (privateBrowsingId) {
      const base = Services.eTLD.getSchemelessSiteFromHost(site);
      try {
        Services.cookies.removeCookiesWithOriginAttributes(
          JSON.stringify(pattern),
          base
        );
        Services.cookies.removeCookiesWithOriginAttributes(
          JSON.stringify({
            ...pattern,
            partitionKeyPattern: { baseDomain: base },
          })
        );
      } catch (err) {
        SvalLog.warn(`private cookies not cleared: ${SvalLog.errorName(err)}`);
        failed = true;
      }
      const cleared = await Promise.all(
        openPrincipalsOf(site, pattern).map(clearStorageOf)
      );
      failed ||= cleared.includes(false);
    }
    if (failed) {
      SvalLog.warn("site data left in a page's jar");
    }
    this.update().catch(err =>
      SvalLog.warn(`site data update failed: ${SvalLog.errorName(err)}`)
    );
    return { failed };
  },

  /**
   * Clears `site`'s cookies, storage and caches in every jar, then updates.
   *
   * @param {string} site
   * @returns {Promise<{failed: boolean}>}
   */
  async clearEverywhere(site) {
    const flags = await clearSite(site, {});
    if (flags) {
      SvalLog.warn(`site data not fully cleared: flags ${flags}`);
    }
    await this.update();
    return { failed: !!flags };
  },

  /**
   * @returns {string[]} every site the last update found data for.
   */
  sitesWithData() {
    const found = new Set();
    for (const name of sites.keys()) {
      const site = lazy.siteForURI(lazy.siteOrigins(name, ["https"])[0]);
      if (site) {
        found.add(site);
      }
    }
    return [...found];
  },
};
