/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * Forget this site (site page spec §2): each part the confirm counts, and
 * forgetting them all, Sval's and Firefox's, leaving other sites alone.
 */

const { SvalForgetSite } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalForgetSite.sys.mjs"
);
const { SvalSiteData } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteData.sys.mjs"
);
const { SvalSiteProtections } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
);
const { SvalJavascript } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalJavascript.sys.mjs"
);
const { SvalExtensionSites } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalExtensionSites.sys.mjs"
);
const { SvalBlocking } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
);
const { SITE_EXCEPTIONS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFingerprinting.sys.mjs"
);

const { PlacesTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PlacesTestUtils.sys.mjs"
);

const SITE = "a.com";
const OTHER = "b.com";

/** A jar no contextual identity has, as a deleted workspace's is. */
const ORPHAN_JAR = 4001;

/**
 * @param {number} userContextId
 * @param {string} [host]
 */
function addCookie(userContextId, host = SITE) {
  Services.cookies.add(
    host,
    "/",
    "sval-forget",
    "1",
    true,
    false,
    false,
    Date.now() + 3600 * 1000,
    { userContextId },
    Ci.nsICookie.SAMESITE_LAX,
    Ci.nsICookie.SCHEME_HTTPS
  );
}

/**
 * Stores some data in the site's IndexedDB in the shared jar, so the site
 * has quota usage.
 */
async function storeData() {
  const principal = Services.scriptSecurityManager.createContentPrincipal(
    Services.io.newURI(`https://${SITE}`),
    {}
  );
  const request = indexedDB.openForPrincipal(principal, "sval-forget", 1);
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
  tx.objectStore("data").put(new Uint8Array(64 * 1024).fill(7), 1);
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

/** Updates the site data, as the page does when it opens. */
async function updated() {
  await within(SvalSiteData.update(), 30_000, "the site data updating");
}

/**
 * Takes away everything the task gave the site, whatever the task reached.
 *
 * @param {string} filters My filters as the task found them.
 */
async function putBack(filters) {
  SvalSiteProtections.setRule(SITE, null);
  SvalJavascript.removeRule(SITE);
  if (SvalBlocking.myFilters !== filters) {
    SvalBlocking.setMyFilters(filters);
  }
  await within(
    new Promise(resolve =>
      Services.clearData.deleteDataFromSite(
        SITE,
        {},
        true,
        Ci.nsIClearDataService.CLEAR_FORGET_ABOUT_SITE,
        resolve
      )
    ),
    30_000,
    "the site clearing in teardown"
  );
}

add_task(async function forget_counts_then_clears_every_part() {
  const { store } = await favoritesFixture();
  const filters = SvalBlocking.myFilters;
  atTaskEnd(() => putBack(filters));
  const { nodes } = await SvalPanel.engine.tree();

  SvalSiteProtections.setRule(SITE, {
    protections: "off",
    media: "block",
    exceptions: [SITE_EXCEPTIONS[0].id],
  });
  SvalJavascript.setEnabled(SITE, !SvalJavascript.defaultEnabled());
  SvalBlocking.setMyFilters(
    `${filters}\n${SITE}##.sval-forget\n${OTHER}##.sval-forget`
  );
  const favorite = { title: "A", url: `https://${SITE}/x` };
  const pin = { title: "A pin", url: `https://${SITE}/x` };
  const kept = { title: "B", url: `https://${OTHER}/x` };
  await within(
    store.insertTree([favorite, kept], { pins: [pin] }),
    10_000,
    "the favorites adding"
  );
  await PlacesTestUtils.addVisits([
    `https://${SITE}/x`,
    `https://www.${SITE}/y`,
    `https://${OTHER}/z`,
  ]);
  atTaskEnd(() => PlacesUtils.history.remove(`https://${OTHER}/z`));
  const downloads = await Downloads.getList(Downloads.PUBLIC);
  const download = await Downloads.createDownload({
    source: { url: `https://${SITE}/file.txt` },
    target: PathUtils.join(await makeTempDir("sval-forget"), "file.txt"),
    succeeded: true,
  });
  await downloads.add(download);
  // Paused with its partial data kept: Forget leaves it, as
  // `DownloadList.removeFinished` does, so it is not counted.
  const paused = await Downloads.createDownload({
    source: { url: `https://${SITE}/paused.txt` },
    target: PathUtils.join(await makeTempDir("sval-forget"), "paused.txt"),
    hasPartialData: true,
  });
  await downloads.add(paused);
  atTaskEnd(() => downloads.remove(paused));
  addCookie(0);
  addCookie(ORPHAN_JAR);
  addCookie(0, OTHER);
  atTaskEnd(() => Services.cookies.removeCookiesFromExactHost(OTHER, "{}"));
  await storeData();
  SitePermissions.setForPrincipal(
    Services.scriptSecurityManager.createContentPrincipal(
      Services.io.newURI(`https://${SITE}`),
      {}
    ),
    "camera",
    SitePermissions.ALLOW
  );

  const wasReady = SvalSiteData.ready;
  SvalSiteData.ready = false;
  let unread;
  try {
    unread = await SvalForgetSite.countsFor(SITE);
  } finally {
    SvalSiteData.ready = wasReady;
  }
  Assert.strictEqual(
    unread.dataBytes,
    null,
    "no data size before the site data is read"
  );
  Assert.strictEqual(unread.dataJars, null, "nor jars");

  await updated();
  const counts = await SvalForgetSite.countsFor(SITE);
  const usage = SvalSiteData.jarsFor(SITE, nodes).reduce(
    (sum, jar) => sum + jar.usage,
    0
  );
  Assert.greater(usage, 0, "the site's jars hold data");
  Assert.deepEqual(
    counts,
    {
      choices: 3,
      exceptions: 1,
      hiddenLines: 1,
      favorites: 2,
      history: 2,
      downloads: 1,
      dataBytes: usage,
      dataJars: SvalSiteData.jarsFor(SITE, nodes).length,
      // The camera; the permissions applying the choices count as choices.
      permissions: 1,
      certExceptions: 0,
    },
    "every part is counted"
  );
  Assert.ok(SvalForgetSite.holdsAnything(counts), "the site holds something");

  Assert.deepEqual(
    await within(SvalForgetSite.forget(SITE), 30_000, "the site forgetting"),
    { failed: [] },
    "every part is forgotten"
  );

  const after = await SvalForgetSite.countsFor(SITE);
  Assert.deepEqual(
    after,
    {
      choices: 0,
      exceptions: 0,
      hiddenLines: 0,
      favorites: 0,
      history: 0,
      downloads: 0,
      dataBytes: 0,
      dataJars: 0,
      permissions: 0,
      certExceptions: 0,
    },
    "nothing is left to count"
  );
  Assert.ok(!SvalForgetSite.holdsAnything(after), "the site holds nothing");
  const left = await downloads.getAll();
  Assert.ok(!left.includes(download), "the finished download is gone");
  Assert.ok(left.includes(paused), "the paused download stays");
  Assert.equal(
    Services.cookies.getCookiesFromHost(SITE, { userContextId: ORPHAN_JAR })
      .length,
    0,
    "a removed workspace's cookie is gone too"
  );

  Assert.deepEqual(
    store
      .all()
      .filter(row => row.kind === "favorite")
      .map(row => row.url),
    [`https://${OTHER}/x`],
    "another site's favorite stays"
  );
  Assert.ok(
    SvalBlocking.myFilters.includes(`${OTHER}##.sval-forget`),
    "another site's hidden-element line stays"
  );
  Assert.equal(
    Services.cookies.getCookiesFromHost(OTHER, {}).length,
    1,
    "another site's cookie stays"
  );
  Assert.ok(
    await PlacesTestUtils.isPageInDB(`https://${OTHER}/z`),
    "another site's visit stays"
  );
});

add_task(async function retry_refuses_a_part_it_does_not_know() {
  await Assert.rejects(
    SvalForgetSite.retry(SITE, ["passwords"]),
    e => e.name === "RangeError",
    "an unknown part is refused"
  );
});

add_task(async function retry_runs_only_the_parts_named() {
  const filters = SvalBlocking.myFilters;
  atTaskEnd(() => putBack(filters));
  SvalSiteProtections.setRule(SITE, {
    protections: "off",
    exceptions: [SITE_EXCEPTIONS[0].id],
  });
  SvalJavascript.setEnabled(SITE, !SvalJavascript.defaultEnabled());
  SvalBlocking.setMyFilters(`${filters}\n${SITE}##.sval-forget`);

  Assert.deepEqual(
    await within(
      SvalForgetSite.retry(SITE, ["exceptions"]),
      30_000,
      "the exceptions retrying"
    ),
    { failed: [] },
    "the exceptions part runs"
  );
  let counts = await SvalForgetSite.countsFor(SITE);
  Assert.deepEqual(
    [counts.choices, counts.exceptions, counts.hiddenLines],
    [2, 0, 1],
    "only the exceptions went"
  );

  await within(
    SvalForgetSite.retry(SITE, ["choices", "hiddenLines"]),
    30_000,
    "the choices and lines retrying"
  );
  counts = await SvalForgetSite.countsFor(SITE);
  Assert.deepEqual(
    [counts.choices, counts.exceptions, counts.hiddenLines],
    [0, 0, 0],
    "the choices and the lines went"
  );
});

add_task(async function forget_counts_and_removes_the_sites_host_rules() {
  const HOST = `app.${SITE}`;
  const SWITCH_ID = "sval-forget@tests.sval.app";
  const filters = SvalBlocking.myFilters;
  atTaskEnd(() => putBack(filters));
  atTaskEnd(() => {
    SvalSiteProtections.setRule(HOST, null);
    SvalJavascript.removeRule(HOST);
    SvalExtensionSites.removeAll(HOST);
  });
  SvalSiteProtections.setRule(HOST, {
    media: "block",
    exceptions: [SITE_EXCEPTIONS[0].id],
  });
  SvalJavascript.setEnabled(HOST, !SvalJavascript.defaultEnabled());
  SvalExtensionSites.setOff(SWITCH_ID, HOST, true);
  SvalBlocking.setMyFilters(
    `${filters}\n${HOST}##.sval-forget\n${HOST}#@#.sval-shown\n${OTHER}##.sval-forget`
  );

  let counts = await SvalForgetSite.countsFor(SITE);
  Assert.deepEqual(
    [counts.choices, counts.exceptions, counts.hiddenLines],
    [3, 1, 2],
    "the host's choices, exception and lines count for its site"
  );

  await within(
    SvalForgetSite.retry(SITE, ["choices", "exceptions", "hiddenLines"]),
    30_000,
    "the site's own parts forgetting"
  );
  counts = await SvalForgetSite.countsFor(SITE);
  Assert.deepEqual(
    [counts.choices, counts.exceptions, counts.hiddenLines],
    [0, 0, 0],
    "nothing of the host's is left"
  );
  Assert.deepEqual(SvalSiteProtections.ruleFor(HOST), {});
  Assert.ok(!SvalJavascript.hasRule(HOST));
  Assert.equal(SvalExtensionSites.ruleFor(SWITCH_ID, HOST), undefined);
  Assert.ok(
    SvalBlocking.myFilters.includes(`${OTHER}##.sval-forget`),
    "another site's line stays"
  );
});
