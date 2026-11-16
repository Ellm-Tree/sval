/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A site's cookies and site data by workspace (site page spec §4): the shared
 * jar, each isolated workspace's jar and the jars of deleted workspaces, each
 * cleared on its own or all at once.
 */

const { SvalSiteData } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteData.sys.mjs"
);
const { SvalWorkspaceJar } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalWorkspaceJar.sys.mjs"
);
const { SvalPrivateJars } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPrivateJars.sys.mjs"
);
const { switcherItems } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);

const SITE = "example.com";
const NAME = "Site data test";

/**
 * @param {number} userContextId
 */
function addCookie(userContextId) {
  Services.cookies.add(
    SITE,
    "/",
    "sval-site-data",
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
 * @param {number} userContextId
 * @returns {number} how many of the site's cookies the jar holds.
 */
function cookiesIn(userContextId) {
  return Services.cookies.getCookiesFromHost(SITE, { userContextId }).length;
}

/**
 * Updates the site data and waits for the topic that says so.
 */
async function updated() {
  const notified = TestUtils.topicObserved(SvalSiteData.TOPIC);
  await within(SvalSiteData.update(), 30_000, "the site data updating");
  await within(notified, 5_000, "the site data topic");
}

/**
 * Stores `bytes` of incompressible data in the site's IndexedDB in a jar, so
 * the jar has quota usage.
 *
 * @param {number} userContextId
 * @param {number} bytes
 * @param {object} [attrs] More origin attributes, such as a private
 *   window's.
 */
async function store(userContextId, bytes, attrs = {}) {
  const principal = Services.scriptSecurityManager.createContentPrincipal(
    Services.io.newURI(`https://${SITE}`),
    { ...attrs, userContextId }
  );
  const request = indexedDB.openForPrincipal(principal, "sval-site-data", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("data");
  const db = await within(
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }),
    10_000,
    "the database opening"
  );
  const data = new Uint8Array(bytes);
  for (let at = 0; at < bytes; at += 65536) {
    crypto.getRandomValues(data.subarray(at, at + 65536));
  }
  const tx = db.transaction("data", "readwrite");
  tx.objectStore("data").put(data, 1);
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
 * Clears the site in every jar, as a task's teardown.
 */
async function clearSiteEverywhere() {
  await within(
    new Promise(resolve =>
      Services.clearData.deleteDataFromSite(
        SITE,
        {},
        true,
        Ci.nsIClearDataService.CLEAR_COOKIES_AND_SITE_DATA |
          Ci.nsIClearDataService.CLEAR_ALL_CACHES,
        resolve
      )
    ),
    30_000,
    "the site clearing in teardown"
  );
}

/**
 * An isolated workspace with a jar of its own, both removed when the task
 * ends.
 *
 * @param {string} name
 * @returns {Promise<{id: string, jar: number}>}
 */
async function isolatedWorkspace(name) {
  const id = await SvalPanel.engine.mutate({
    kind: "addWorkspace",
    name,
    isolated: true,
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  const { nodes } = await SvalPanel.engine.tree();
  const jar = SvalWorkspaceJar.userContextIdFor(nodes, id);
  atTaskEnd(async () => {
    await SvalPanel.engine.mutate({ kind: "remove", id });
    ContextualIdentityService.remove(jar);
  });
  return { id, jar };
}

add_task(async function jars_by_workspace_and_clearing_them() {
  atTaskEnd(clearSiteEverywhere);
  const { id, jar } = await isolatedWorkspace(NAME);
  const { nodes } = await SvalPanel.engine.tree();
  Assert.greater(jar, 0, "the isolated workspace has a jar of its own");

  addCookie(0);
  addCookie(jar);
  await updated();
  Assert.ok(SvalSiteData.ready, "an update has answered");

  const rows = SvalSiteData.jarsFor(SITE, nodes);
  Assert.deepEqual(
    rows.map(row => row.kind),
    ["shared", "isolated"],
    "the shared jar first, then the isolated workspace's"
  );
  Assert.deepEqual(rows[0].userContextIds, [0], "the shared row is jar 0");
  Assert.deepEqual(
    rows[0].sharedNames,
    switcherItems(nodes, null)
      .filter(item => !SvalWorkspaceJar.isIsolated(nodes, item.id))
      .map(item => item.name),
    "the shared row names the shared workspaces"
  );
  Assert.ok(
    !rows[0].sharedNames.includes(NAME),
    "an isolated workspace is not among the shared ones"
  );
  Assert.deepEqual(
    [rows[1].userContextIds, rows[1].workspaceId, rows[1].name],
    [[jar], id, NAME],
    "the isolated row is the workspace's jar, by its name"
  );

  const without = { ...nodes };
  delete without[id];
  Assert.deepEqual(
    SvalSiteData.jarsFor(SITE, without).map(row => [
      row.kind,
      row.userContextIds,
    ]),
    [
      ["shared", [0]],
      ["removed", [jar]],
    ],
    "a jar whose workspace is gone folds into the removed row"
  );

  Assert.ok(SvalSiteData.sitesWithData().includes(SITE), "the site has data");

  Assert.deepEqual(
    await within(
      SvalSiteData.clearJars(SITE, [jar]),
      30_000,
      "the isolated jar clearing"
    ),
    { failed: [] },
    "the isolated jar clears"
  );
  Assert.equal(cookiesIn(jar), 0, "the isolated jar's cookie is gone");
  Assert.equal(cookiesIn(0), 1, "the shared jar's cookie stays");
  Assert.deepEqual(
    SvalSiteData.jarsFor(SITE, nodes).map(row => row.kind),
    ["shared"],
    "an emptied jar has no row"
  );

  addCookie(jar);
  Assert.deepEqual(
    await within(
      SvalSiteData.clearEverywhere(SITE),
      30_000,
      "the site clearing everywhere"
    ),
    { failed: false },
    "every jar clears"
  );
  Assert.equal(cookiesIn(0) + cookiesIn(jar), 0, "both cookies are gone");
  Assert.deepEqual(
    SvalSiteData.jarsFor(SITE, nodes),
    [],
    "a site with no data has no rows"
  );
  Assert.ok(
    !SvalSiteData.sitesWithData().includes(SITE),
    "the site has no data left"
  );
});

add_task(async function which_jars_fold_into_removed() {
  atTaskEnd(clearSiteEverywhere);
  const small = await isolatedWorkspace("Small");
  const large = await isolatedWorkspace("Large");
  const { nodes } = await SvalPanel.engine.tree();
  // No identity has this id: the jar of an identity removed before its
  // data was.
  const orphan = 4000;
  Assert.ok(
    !ContextualIdentityService.getPrivateIdentityFromId(orphan) &&
      !ContextualIdentityService.getPublicIdentityFromId(orphan),
    "the orphan jar has no identity"
  );
  const internal = ContextualIdentityService.getPrivateIdentity(
    "userContextIdInternal.thumbnail"
  ).userContextId;

  await store(small.jar, 64 * 1024);
  await store(large.jar, 1024 * 1024);
  addCookie(orphan);
  addCookie(internal);
  await updated();

  const rows = SvalSiteData.jarsFor(SITE, nodes);
  Assert.deepEqual(
    rows.map(row => [row.kind, row.name]),
    [
      ["isolated", "Large"],
      ["isolated", "Small"],
      ["removed", undefined],
    ],
    "isolated jars by size, largest first, then the removed row"
  );
  Assert.greater(rows[0].usage, rows[1].usage, "the larger jar is first");
  Assert.deepEqual(
    rows[2].userContextIds,
    [orphan],
    "a jar with no identity is removed, an internal one has no row"
  );

  const without = { ...nodes };
  delete without[small.id];
  delete without[large.id];
  const removed = SvalSiteData.jarsFor(SITE, without);
  Assert.equal(removed.length, 1, "every removed jar is one row");
  Assert.deepEqual(
    removed[0].userContextIds.toSorted((a, b) => a - b),
    [small.jar, large.jar, orphan].toSorted((a, b) => a - b),
    "the removed row holds every orphaned jar"
  );
  Assert.equal(
    removed[0].usage,
    rows[0].usage + rows[1].usage + rows[2].usage,
    "the removed row's usage is its jars' sum"
  );
});

add_task(async function without_nodes_no_jar_is_removed() {
  atTaskEnd(clearSiteEverywhere);
  const isolated = await isolatedWorkspace("Isolated");
  const orphan = 4000;
  await store(isolated.jar, 64 * 1024);
  addCookie(orphan);
  await updated();

  Assert.deepEqual(
    SvalSiteData.jarsFor(SITE, null).map(row => [
      row.kind,
      row.name,
      row.userContextIds,
    ]),
    [
      ["isolated", "", [isolated.jar]],
      ["removed", undefined, [orphan]],
    ],
    "a workspace's jar is an unnamed isolated row, a jar with no identity removed"
  );
});

add_task(async function held_counts_every_jar() {
  atTaskEnd(clearSiteEverywhere);
  const container = ContextualIdentityService.create("Sval held test");
  atTaskEnd(() => ContextualIdentityService.remove(container.userContextId));
  const internal = ContextualIdentityService.getPrivateIdentity(
    "userContextIdInternal.thumbnail"
  ).userContextId;
  addCookie(container.userContextId);
  addCookie(internal);
  await store(0, 64 * 1024);
  await updated();

  const { nodes } = await SvalPanel.engine.tree();
  const rows = SvalSiteData.jarsFor(SITE, nodes);
  Assert.deepEqual(
    rows.map(row => row.kind),
    ["shared"],
    "a container's and an internal jar have no row"
  );
  Assert.deepEqual(
    SvalSiteData.heldFor(SITE),
    { jars: 3, usage: rows[0].usage },
    "but count as held"
  );
});

add_task(async function a_private_jar_is_never_listed_or_held() {
  atTaskEnd(clearSiteEverywhere);
  // A jar in the range `SvalPrivateJars` gives private windows, written as
  // a private tab writes it: quota usage reports private storage too.
  const jar = 2 ** 30 + 7;
  Assert.ok(SvalPrivateJars.isPrivateJar(jar), "a private window's jar");
  await store(jar, 64 * 1024, { privateBrowsingId: 1 });
  await updated();

  const { nodes } = await SvalPanel.engine.tree();
  Assert.deepEqual(
    SvalSiteData.jarsFor(SITE, nodes),
    [],
    "the private jar has no row"
  );
  Assert.deepEqual(
    SvalSiteData.heldFor(SITE),
    { jars: 0, usage: 0 },
    "and holds nothing the page counts"
  );
});
