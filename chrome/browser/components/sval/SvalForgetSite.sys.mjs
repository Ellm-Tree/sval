/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Forget this site (site page spec §2): what Sval and Firefox hold for a
 * site, counted part by part for the confirm, and all of it forgotten.
 *
 * Firefox's parts go through `Services.clearData` with Forget About This
 * Site's flags, in every jar. Sval's are its stored choices, site styles
 * among them, its My filters lines and its Favorites and pins, each the
 * site's own and those of every host under it (decision 1980). A private window's own state is none of
 * these: Forget is never offered there (spec §5).
 */

import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  SvalBlocking: "moz-src:///browser/components/sval/SvalBlocking.sys.mjs",
  SvalExtensionSites:
    "moz-src:///browser/components/sval/SvalExtensionSites.sys.mjs",
  SvalFavoritesStore:
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
  SvalJavascript: "moz-src:///browser/components/sval/SvalJavascript.sys.mjs",
  SvalSiteData: "moz-src:///browser/components/sval/SvalSiteData.sys.mjs",
  SvalSiteProtections:
    "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs",
  SvalSiteStyles: "moz-src:///browser/components/sval/SvalSiteStyles.sys.mjs",
  APPLIED_PERMISSIONS:
    "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs",
  forgetSite: "moz-src:///browser/components/sval/SvalElementRules.sys.mjs",
  permissionCount:
    "moz-src:///browser/components/sval/SvalSitePermissionList.sys.mjs",
  scopeOfHost: "moz-src:///browser/components/sval/SvalSite.sys.mjs",
  siteOf: "moz-src:///browser/components/sval/SvalSite.sys.mjs",
  siteOrigins: "moz-src:///browser/components/sval/SvalSite.sys.mjs",
});

/**
 * The parts Forget clears, in the confirm's order (design 8a): the synced
 * ones first, then this device's.
 */
export const PARTS = Object.freeze([
  "choices",
  "exceptions",
  "hiddenLines",
  "favorites",
  "history",
  "downloads",
  "data",
  "caches",
  "permissions",
  "certExceptions",
]);

/**
 * The `nsIClearDataService` flags of each part Firefox clears. "data" is
 * the rest of `CLEAR_FORGET_ABOUT_SITE`, so the parts together are that
 * flag, and a failed flag names its part.
 *
 * @returns {Map<string, number>}
 */
function clearFlags() {
  const CD = Ci.nsIClearDataService;
  const flags = new Map([
    ["history", CD.CLEAR_HISTORY],
    ["downloads", CD.CLEAR_DOWNLOADS],
    ["caches", CD.CLEAR_ALL_CACHES],
    ["permissions", CD.CLEAR_PERMISSIONS],
    ["certExceptions", CD.CLEAR_CERT_EXCEPTIONS],
  ]);
  let named = 0;
  for (const flag of flags.values()) {
    named |= flag;
  }
  flags.set("data", CD.CLEAR_FORGET_ABOUT_SITE & ~named);
  return flags;
}

/**
 * @param {string} site
 * @returns {object[]} The favorite rows, pins among them, whose address is
 *   of the site.
 */
function favoritesOf(site) {
  return (lazy.SvalFavoritesStore.instance?.all() ?? []).filter(
    row => row.kind === "favorite" && lazy.siteOf(row.url) === site
  );
}

/**
 * @param {string} site
 * @returns {Promise<number>} The visits to the site's pages, its subdomains'
 *   included, as `History.removeByFilter` matches a `.host` filter, which
 *   is how Forget About This Site clears history.
 */
async function countVisits(site) {
  const [uri] = lazy.siteOrigins(site, ["https"]);
  if (!uri) {
    return 0;
  }
  const revHost = lazy.PlacesUtils.getReversedHost(uri).slice(0, -1);
  const db = await lazy.PlacesUtils.promiseDBConnection();
  const rows = await db.executeCached(
    `SELECT count(*) AS visits FROM moz_historyvisits v
     JOIN moz_places h ON h.id = v.place_id
     WHERE h.rev_host BETWEEN :revHost || '.' AND :revHost || '/'`,
    { revHost }
  );
  return rows[0].getResultByName("visits");
}

/**
 * @param {object} download
 * @param {string} site
 * @returns {boolean} Whether Forget removes the download: one of the site's
 *   that `DownloadList.removeFinished` takes, which leaves one in progress.
 */
function forgets(download, site) {
  return (
    download.stopped &&
    (!download.hasPartialData || !!download.error) &&
    lazy.siteOf(download.source.url) === site
  );
}

/**
 * @param {string} site
 * @returns {Promise<number>} The site's downloads Forget removes, outside
 *   private windows.
 */
async function countDownloads(site) {
  const list = await lazy.Downloads.getList(lazy.Downloads.PUBLIC);
  return (await list.getAll()).filter(download => forgets(download, site))
    .length;
}

/**
 * Removes the site's downloads as `DownloadList.removeFinished` does, and
 * settles once they are gone. `DownloadsCleaner.deleteBySite` starts that
 * removal without waiting for it, so the clear's callback comes before the
 * list has changed. `DownloadList.remove` ignores a download already gone.
 *
 * @param {string} site
 * @returns {Promise<void>}
 */
async function removeDownloads(site) {
  const list = await lazy.Downloads.getList(lazy.Downloads.ALL);
  for (const download of (await list.getAll()).filter(d => forgets(d, site))) {
    await list.remove(download);
    const sameFile = (await list.getAll()).some(
      other => other.target.path == download.target.path && !other.error
    );
    await download.finalize(!sameFile);
  }
}

/**
 * @param {string} site
 * @returns {number} The certificate exceptions for the site's hosts outside
 *   private windows.
 */
function countCertExceptions(site) {
  const service = Cc["@mozilla.org/security/certoverride;1"].getService(
    Ci.nsICertOverrideService
  );
  return service.getOverrides().filter(override => {
    if (override.originAttributes.privateBrowsingId) {
      return false;
    }
    const [uri] = lazy.siteOrigins(override.asciiHost, ["https"]);
    return !!uri && lazy.siteOf(uri.spec) === site;
  }).length;
}

/**
 * @param {string} site
 * @param {number} flags
 * @returns {Promise<number>} The flags that failed to clear.
 */
function clearData(site, flags) {
  return new Promise(resolve => {
    Services.clearData.deleteDataFromSite(
      Services.eTLD.getSchemelessSiteFromHost(site),
      {},
      true,
      flags,
      resolve
    );
  });
}

/**
 * @param {string} site
 * @param {Iterable<string>} names Sites and hosts a store holds rules for.
 * @returns {string[]} The site, and each of `names` that is a host grouped
 *   under it.
 */
function scopesOf(site, names) {
  const scopes = new Set([site]);
  for (const name of names) {
    if (lazy.scopeOfHost(name)?.site === site) {
      scopes.add(name);
    }
  }
  return [...scopes];
}

/**
 * @param {string} site
 * @returns {string[]} The site and its hosts that hold a site style.
 */
function styleScopesOf(site) {
  const held = lazy.SvalSiteStyles.styles().map(entry => entry.scope);
  return scopesOf(site, held).filter(name => held.includes(name));
}

/**
 * Sval's own parts, each forgetting the share of one store held by the site
 * and its hosts.
 */
const SVAL_PARTS = {
  choices(site) {
    const protections = lazy.SvalSiteProtections;
    for (const name of scopesOf(site, protections.rules().keys())) {
      const { exceptions } = protections.ruleFor(name);
      protections.setRule(name, exceptions ? { exceptions } : null);
    }
    for (const name of scopesOf(site, lazy.SvalJavascript.rules().keys())) {
      lazy.SvalJavascript.removeRule(name);
    }
    for (const name of scopesOf(site, lazy.SvalExtensionSites.names())) {
      lazy.SvalExtensionSites.removeAll(name);
    }
    lazy.SvalSiteStyles.removeStyles(styleScopesOf(site));
  },

  exceptions(site) {
    const protections = lazy.SvalSiteProtections;
    for (const name of scopesOf(site, protections.rules().keys())) {
      const { exceptions, ...rest } = protections.ruleFor(name);
      if (exceptions) {
        protections.setRule(name, Object.keys(rest).length ? rest : null);
      }
    }
  },

  hiddenLines(site) {
    const { text, removed } = lazy.forgetSite(
      lazy.SvalBlocking.myFilters,
      site
    );
    if (removed) {
      lazy.SvalBlocking.setMyFilters(text);
    }
  },

  async favorites(site) {
    const store = lazy.SvalFavoritesStore.instance;
    if (!store) {
      return;
    }
    await store.whenReady();
    let failed = null;
    for (const row of favoritesOf(site)) {
      try {
        await store.delete(row.guid, { undoable: false });
      } catch (err) {
        failed = err;
      }
    }
    if (failed) {
      throw failed;
    }
  },
};

export const SvalForgetSite = {
  PARTS,

  /**
   * What Forget would clear for the site, one figure for each part of the
   * confirm. Caches have no size of their own (`SiteDataManager` keeps
   * none per site), so they have no figure here. A jar holding cookies
   * alone has no usage, so `dataJars` says the site holds data when
   * `dataBytes` is 0. Data and permissions count everything Forget clears,
   * in jars and of types the page has no row for too, except the
   * permissions that apply the site's choices, which `choices` counts.
   *
   * @param {string} site As `siteOf` cuts one.
   * @returns {Promise<{choices: number, exceptions: number,
   *   hiddenLines: number, favorites: number, history: number,
   *   downloads: number, dataBytes: ?number, dataJars: ?number,
   *   permissions: number, certExceptions: number}>} `dataBytes` and
   *   `dataJars`, the jars holding the site's data, are null until
   *   `SvalSiteData` has read the site data.
   */
  async countsFor(site) {
    const protections = lazy.SvalSiteProtections;
    const rules = scopesOf(site, protections.rules().keys()).map(name =>
      protections.ruleFor(name)
    );
    const switches = scopesOf(site, lazy.SvalExtensionSites.names()).map(
      name =>
        lazy.SvalExtensionSites.idsOffOn(name).length +
        lazy.SvalExtensionSites.idsOnAt(name).length
    );
    const data = lazy.SvalSiteData.ready
      ? lazy.SvalSiteData.heldFor(site)
      : null;
    await lazy.SvalFavoritesStore.instance?.whenReady();
    const [history, downloads] = await Promise.all([
      countVisits(site),
      countDownloads(site),
    ]);
    return {
      choices:
        rules.reduce(
          (sum, rule) =>
            sum + Number(!!rule.protections) + Number(!!rule.media),
          0
        ) +
        scopesOf(site, lazy.SvalJavascript.rules().keys()).filter(name =>
          lazy.SvalJavascript.hasRule(name)
        ).length +
        switches.reduce((sum, count) => sum + count, 0) +
        styleScopesOf(site).length,
      exceptions: rules.reduce(
        (sum, rule) => sum + (rule.exceptions?.length ?? 0),
        0
      ),
      hiddenLines: lazy.forgetSite(lazy.SvalBlocking.myFilters, site).removed,
      favorites: favoritesOf(site).length,
      history,
      downloads,
      dataBytes: data?.usage ?? null,
      dataJars: data?.jars ?? null,
      permissions: lazy.permissionCount(site, lazy.APPLIED_PERMISSIONS),
      certExceptions: countCertExceptions(site),
    };
  },

  /**
   * @param {object} counts From `countsFor`.
   * @returns {boolean} Whether any part holds something.
   */
  holdsAnything(counts) {
    return Object.values(counts).some(value => value > 0);
  },

  /**
   * Forgets every part for the site.
   *
   * @param {string} site
   * @returns {Promise<{failed: Array<{part: string,
   *   reason: "disk"}>}>}
   */
  forget(site) {
    return this.retry(site, PARTS);
  },

  /**
   * Forgets the named parts for the site. A part that fails leaves the
   * others to run.
   *
   * `Services.clearData` reports only which flags failed, so a failed
   * Firefox part is put down to the disk. The Favorites store writes this
   * device's copy and syncs it later, so a failed delete is the disk's too.
   *
   * @param {string} site
   * @param {string[]} parts From `PARTS`.
   * @throws {Error} for a name not in `PARTS`.
   * @returns {Promise<{failed: Array<{part: string,
   *   reason: "disk"}>}>} in `PARTS` order.
   */
  async retry(site, parts) {
    const unknown = parts.filter(part => !PARTS.includes(part));
    if (unknown.length) {
      throw new RangeError(
        `sval: no such part to forget: ${unknown.join(", ")}`
      );
    }
    const failed = new Set();
    // Sval's parts go first: the choices part takes the stored rule that
    // Gecko's permissions for the site are applied from, and clearing those
    // permissions first could leave the rule without them.
    for (const part of parts) {
      if (!SVAL_PARTS[part]) {
        continue;
      }
      try {
        await SVAL_PARTS[part](site);
      } catch (err) {
        failed.add(part);
        SvalLog.warn(
          `forget: the ${part} part failed: ${SvalLog.errorName(err)}`
        );
      }
    }
    const flags = clearFlags();
    let wanted = 0;
    for (const part of parts) {
      wanted |= flags.get(part) ?? 0;
    }
    if (wanted) {
      let left;
      try {
        left = await clearData(site, wanted >>> 0);
      } catch (err) {
        left = wanted;
        SvalLog.warn(
          `forget: site data not cleared: ${SvalLog.errorName(err)}`
        );
      }
      for (const [part, flag] of flags) {
        if (left & flag & wanted) {
          failed.add(part);
        }
      }
      if (left) {
        SvalLog.warn(`forget: site data not fully cleared: flags ${left}`);
      }
    }
    if (parts.includes("downloads")) {
      try {
        await removeDownloads(site);
      } catch (err) {
        failed.add("downloads");
        SvalLog.warn(
          `forget: downloads not removed: ${SvalLog.errorName(err)}`
        );
      }
    }
    if (wanted & flags.get("data")) {
      try {
        await lazy.SvalSiteData.update();
      } catch (err) {
        SvalLog.warn(
          `forget: site data not read again: ${SvalLog.errorName(err)}`
        );
      }
    }
    return {
      failed: PARTS.filter(part => failed.has(part)).map(part => ({
        part,
        reason: "disk",
      })),
    };
  },
};
