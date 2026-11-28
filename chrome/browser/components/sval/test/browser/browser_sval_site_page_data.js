/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_site_page_helpers.js */

/**
 * The site page's Cookies and site data card (site page spec, Cookies and
 * site data): a row per jar holding the site's data, each cleared on its
 * own, Clear everywhere behind its confirm and the links to Firefox's
 * dialogs. `browser_sval_site_page_always_private.js` covers the read-only
 * card of a private-only session.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_site_page_helpers.js",
  this
);

const { SvalSiteData } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteData.sys.mjs"
);
const { SvalWorkspaceJar } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalWorkspaceJar.sys.mjs"
);

const SITE = "example.com";
const NAME = "Site page jar";

/**
 * @param {number} userContextId
 */
function addCookie(userContextId) {
  Services.cookies.add(
    SITE,
    "/",
    "sval-site-page-data",
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
 * @returns {number} How many of the site's cookies the jar holds.
 */
function cookiesIn(userContextId) {
  return Services.cookies.getCookiesFromHost(SITE, { userContextId }).length;
}

/** Clears the site in every jar. */
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
    "the site clearing"
  );
  await within(SvalSiteData.update(), 30_000, "the site data rereading");
}

/**
 * An isolated workspace with a jar of its own, known to the panel, both
 * removed when the task ends.
 *
 * @param {string} [name]
 * @returns {Promise<number>} Its jar.
 */
async function isolatedWorkspace(name = NAME) {
  const id = await SvalPanel.engine.mutate({
    kind: "addWorkspace",
    name,
    isolated: true,
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  await SvalPanel.refresh();
  const jar = SvalWorkspaceJar.userContextIdFor(SvalPanel.nodes, id);
  atTaskEnd(async () => {
    await SvalPanel.engine.mutate({ kind: "remove", id });
    await SvalPanel.refresh();
    ContextualIdentityService.remove(jar);
  });
  return jar;
}

/**
 * The site with a cookie in the shared jar and in an isolated workspace's,
 * and no other data, read by `SvalSiteData`. Pages other files load on the
 * site leave storage there.
 *
 * @returns {Promise<number>} The isolated workspace's jar.
 */
async function twoJars() {
  await clearSiteEverywhere();
  atTaskEnd(clearSiteEverywhere);
  const jar = await isolatedWorkspace();
  addCookie(0);
  addCookie(jar);
  await within(SvalSiteData.update(), 30_000, "the site data reading");
  return jar;
}

/**
 * @param {object} ui From `partsOf`.
 * @returns {object} The card's parts.
 */
function cardOf(ui) {
  const card = () => ui.doc.querySelector('[data-site-card="data"]');
  return {
    card,
    rows: () => [...(card()?.querySelectorAll(".sval-site-data-row") ?? [])],
    everywhere: () => card()?.querySelector(".sval-site-data-everywhere"),
  };
}

add_task(async function a_row_per_jar_and_clearing_one() {
  const jar = await twoJars();
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  const data = cardOf(ui);
  await until(() => data.rows().length === 2, "both jars listed");
  const [shared, isolated] = data.rows();
  is(shared.dataset.jar, "shared", "the shared jar first");
  ok(isolated.textContent.includes(NAME), "the isolated workspace by name");
  ok(isolated.querySelector(".sval-iso-pill"), "the isolated workspace's pill");
  is(data.card().getAttribute("aria-busy"), null, "not busy once read");
  is(
    isolated.querySelector(".sval-site-data-size").dataset.usage,
    "0",
    "a jar of cookies alone has no size"
  );
  ok(
    !data.card().querySelector(".sval-site-card-count"),
    "no total when it is nothing"
  );

  isolated.querySelector(".sval-site-data-clear").click();
  await until(() => data.rows().length === 1, "the cleared row gone");
  is(cookiesIn(jar), 0, "the isolated jar cleared");
  is(cookiesIn(0), 1, "the shared jar kept");
  is(data.rows()[0].dataset.jar, "shared", "the shared row stays");
});

add_task(async function clear_everywhere_confirms_first() {
  const jar = await twoJars();
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  const data = cardOf(ui);
  await until(() => data.rows().length === 2, "both jars listed");
  const dialog = ui.byId("sval-blocking-dialog");

  data.everywhere().click();
  ok(dialog.open, "the confirm opens");
  is(dialog.getAttribute("role"), "alertdialog", "as an alert dialog");
  is(dialog.dataset.confirm, "clear-everywhere", "to clear everywhere");
  const card = ui.byId("sval-blocking-dialog-card");
  is(card.icon, "cookie", "the cookie tile");
  is(card.tone, "danger", "in the danger tone");
  is(
    ui.byId("sval-blocking-dialog-confirm").type,
    "danger",
    "the button warns"
  );
  is(page.document.activeElement.id, "sval-blocking-dialog-cancel", "Cancel");

  ui.byId("sval-blocking-dialog-cancel").click();
  ok(!dialog.open, "Cancel closes it");
  is(cookiesIn(0) + cookiesIn(jar), 2, "and clears nothing");
  await until(
    () => !card.icon && card.tone === "default",
    "the tile taken off for the other confirms"
  );

  data.everywhere().click();
  ui.byId("sval-blocking-dialog-confirm").click();
  ok(!dialog.open, "confirming closes it");
  await until(
    () => data.card()?.querySelector(".sval-empty"),
    "the empty line"
  );
  is(cookiesIn(0) + cookiesIn(jar), 0, "every jar cleared");
  ok(!data.everywhere(), "nothing left to clear");
});

/**
 * Waits for the next dialog `page`'s `gSubDialog` opens and closes it.
 *
 * @param {Window} page
 * @param {string} what
 * @returns {Promise<Document>} The dialog's document, once it has shown.
 */
async function nextSubDialog(page, what) {
  const event = await within(
    BrowserTestUtils.waitForEvent(page.document, "dialogopen"),
    10_000,
    what
  );
  const frame = event.target.querySelector(".dialogFrame");
  const doc = frame.contentDocument;
  const closed = BrowserTestUtils.waitForEvent(page.document, "dialogclose");
  atTaskEnd(async () => {
    if (!frame.contentWindow?.closed) {
      frame.contentWindow?.close();
    }
    await within(closed, 10_000, `${what} closing`);
  });
  return doc;
}

add_task(async function the_links_open_firefox_dialogs() {
  await twoJars();
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  const data = cardOf(ui);
  await until(() => data.rows().length === 2, "both jars listed");
  const [manageData, manageExceptions] = data
    .card()
    .querySelectorAll(".sval-site-data-foot button");
  ok(manageData && manageExceptions, "the data and exceptions links");

  let opened = nextSubDialog(page, "Manage data opening");
  manageData.click();
  let doc = await opened;
  is(
    doc.documentURI,
    "chrome://browser/content/preferences/dialogs/siteDataSettings.xhtml",
    "Manage data opens Firefox's site data dialog"
  );
  const closed = BrowserTestUtils.waitForEvent(page.document, "dialogclose");
  doc.defaultView.close();
  await within(closed, 10_000, "the site data dialog closing");

  opened = nextSubDialog(page, "Manage exceptions opening");
  manageExceptions.click();
  doc = await opened;
  is(
    doc.documentURI,
    "chrome://browser/content/preferences/dialogs/permissions.xhtml",
    "Manage exceptions opens Firefox's exceptions dialog"
  );
  await until(
    () =>
      doc.documentElement.getAttribute("data-l10n-id") ===
      "permissions-exceptions-cookie-window2",
    "for cookies, as its Privacy pane opens it"
  );
});

add_task(async function a_removed_workspace_is_listed_last() {
  atTaskEnd(clearSiteEverywhere);
  const first = await isolatedWorkspace("First");
  const second = await isolatedWorkspace("Second");
  // No identity has this id: the jar of a workspace whose identity is gone.
  const orphan = 4000;
  for (const jar of [0, first, second, orphan]) {
    addCookie(jar);
  }
  await within(SvalSiteData.update(), 30_000, "the site data reading");
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  const data = cardOf(ui);
  await until(() => data.rows().length === 4, "four rows");
  Assert.deepEqual(
    data.rows().map(row => row.dataset.jar),
    ["shared", "isolated", "isolated", "removed"],
    "the shared jar, each isolated one, then the removed one"
  );
  ok(
    data.rows().at(-1).querySelector(".sval-site-row-sub"),
    "the removed row says why"
  );

  data.rows().at(-1).querySelector(".sval-site-data-clear").click();
  await until(() => data.rows().length === 3, "the removed row cleared");
  is(cookiesIn(orphan), 0, "the removed workspace's jar cleared");
  is(cookiesIn(first) + cookiesIn(second), 2, "the others kept");
});

/**
 * Stores data in the site's IndexedDB in the shared jar, so the jar has
 * quota usage.
 */
async function storeShared() {
  const principal = Services.scriptSecurityManager.createContentPrincipal(
    Services.io.newURI(`https://${SITE}`),
    {}
  );
  const request = indexedDB.openForPrincipal(principal, "sval-site-page", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("data");
  const db = await within(
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }),
    10_000,
    "the database opening"
  );
  try {
    const tx = db.transaction("data", "readwrite");
    tx.objectStore("data").put(
      crypto.getRandomValues(new Uint8Array(65536)),
      1
    );
    await within(
      new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      }),
      10_000,
      "the data storing"
    );
  } finally {
    db.close();
  }
}

add_task(async function the_shared_row_names_three_and_counts_the_rest() {
  atTaskEnd(clearSiteEverywhere);
  for (const name of ["Personal", "Reading", "", "Travel", "Work"]) {
    const id = await SvalPanel.engine.mutate({
      kind: "addWorkspace",
      name,
      id: crypto.randomUUID(),
      now: Date.now(),
    });
    atTaskEnd(() => SvalPanel.engine.mutate({ kind: "remove", id }));
  }
  atTaskEnd(() => SvalPanel.refresh());
  await SvalPanel.refresh();
  await storeShared();
  await within(SvalSiteData.update(), 30_000, "the site data reading");

  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  const data = cardOf(ui);
  await until(() => data.rows().length === 1, "the shared row");
  const [row] = SvalSiteData.jarsFor(SITE, SvalPanel.nodes);
  Assert.greaterOrEqual(row.sharedNames.length, 5, "every shared Workspace");
  const sub = data.rows()[0].querySelector(".sval-site-row-sub").textContent;
  const named = row.sharedNames.filter(Boolean);
  const shown = row.sharedNames.slice(0, 3).filter(Boolean);
  Assert.deepEqual(
    named.filter(name =>
      new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(
        sub
      )
    ),
    shown,
    "the first three Workspaces named, and not the rest"
  );
  Assert.deepEqual(
    sub.match(/\d+/g),
    [String(row.sharedNames.length - 3)],
    "then the rest counted"
  );
  Assert.greater(
    Number(data.rows()[0].querySelector(".sval-site-data-size").dataset.usage),
    0,
    "the jar's stored data has a size"
  );
  ok(
    data.card().querySelector(".sval-site-card-count"),
    "and the card a total"
  );
});
