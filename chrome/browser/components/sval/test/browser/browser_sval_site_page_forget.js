/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_site_page_helpers.js */

/**
 * The site page's Forget this site card and its confirm (site page design,
 * 6 and 8a): the parts the confirm lists, what the site holds,
 * forgetting everything, and a part that fails and Try again. `browser_sval_site_page_always_private.js` covers
 * the page of a private-only session, which has no card.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_site_page_helpers.js",
  this
);

const { SvalForgetSite } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalForgetSite.sys.mjs"
);
const { SvalSiteData } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteData.sys.mjs"
);
const { SvalSiteProtections } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
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
const { SvalTestDeny } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestDeny.sys.mjs"
);

/** A site no other test visits, so its history is this file's alone. */
const SITE = "sval-forget-page.com";

function addCookie() {
  Services.cookies.add(
    SITE,
    "/",
    "sval-forget-page",
    "1",
    true,
    false,
    false,
    Date.now() + 3600 * 1000,
    {},
    Ci.nsICookie.SAMESITE_LAX,
    Ci.nsICookie.SCHEME_HTTPS
  );
}

/**
 * Gives the site two choices, an exception, a hidden-element line, a visit
 * and a cookie, read by `SvalSiteData`, all forgotten when the task ends.
 */
async function holdSome() {
  const filters = SvalBlocking.myFilters;
  atTaskEnd(async () => {
    await within(SvalForgetSite.forget(SITE), 30_000, "the teardown forget");
    if (SvalBlocking.myFilters !== filters) {
      SvalBlocking.setMyFilters(filters);
    }
  });
  SvalSiteProtections.setRule(SITE, {
    protections: "off",
    media: "block",
    exceptions: [SITE_EXCEPTIONS[0].id],
  });
  SvalBlocking.setMyFilters(`${filters}\n${SITE}##.sval-forget-page`);
  await PlacesTestUtils.addVisits(`https://${SITE}/x`);
  addCookie();
  await within(SvalSiteData.update(), 30_000, "the site data reading");
}

/**
 * @param {object} ui From `partsOf`.
 * @returns {object} The Forget card's parts.
 */
function forgetOf(ui) {
  const card = () => ui.doc.querySelector('[data-site-card="forget"]');
  return {
    card,
    button: () => ui.byKey("site-forget"),
    dialog: () => ui.byId("sval-blocking-dialog"),
    confirm: () => ui.byId("sval-blocking-dialog-confirm"),
    /**
     * The confirm's list: each group's devices, then its rows, each as its
     * part and its figure: "counting" while it waits, else the figure's
     * numbers, "" for one with none.
     */
    listed: () =>
      [...ui.doc.querySelectorAll(".sval-forget-group")].map(group => [
        group.dataset.device,
        [...group.querySelectorAll(".sval-forget-row")].map(row => {
          const count = row.querySelector(".sval-forget-count");
          return [
            row.dataset.part,
            count.dataset.counting === "true"
              ? "counting"
              : (count.textContent.match(/\d+/g)?.join(" ") ?? ""),
          ];
        }),
      ]),
  };
}

/**
 * Opens the site's page and its confirm.
 *
 * @param {object} [options]
 * @param {boolean} [options.counted] Whether to wait for every count.
 * @returns {Promise<{page: Window, ui: object, forget: object}>}
 */
async function openConfirm({ counted = true } = {}) {
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  const forget = forgetOf(ui);
  await until(
    () => forget.button() && !forget.button().disabled,
    "Forget… live"
  );
  forget.button().click();
  await until(() => forget.dialog().open, "the confirm opening");
  await until(() => forget.listed().length, "the confirm listing");
  if (counted) {
    // The confirm reads stored data again as it opens, and Forget does
    // nothing until every count is in.
    await until(
      () => !forget.confirm().hasAttribute("aria-disabled"),
      "every count in"
    );
  }
  return { page, ui, forget };
}

add_task(async function the_confirm_lists_what_the_site_holds() {
  await holdSome();
  const { page, ui, forget } = await openConfirm();
  ok(
    forget.button().querySelector(".sval-glyph-trash-2"),
    "Forget… has its icon"
  );
  is(forget.dialog().getAttribute("role"), "alertdialog", "an alert dialog");
  is(forget.dialog().dataset.confirm, "forget", "to forget the site");
  Assert.deepEqual(
    forget.listed(),
    [
      [
        "every",
        [
          ["choices", "2"],
          ["exceptions", "1"],
          ["hiddenLines", "1"],
        ],
      ],
      [
        "this",
        [
          ["history", "1"],
          ["data", ""],
        ],
      ],
    ],
    "only the parts holding something, each in its group"
  );
  ok(ui.doc.querySelector(".sval-forget-foot"), "the foot line");
  is(forget.confirm().dataset.tone, "danger", "in danger red");
  is(page.document.activeElement.id, "sval-blocking-dialog-cancel", "Cancel");

  ui.byId("sval-blocking-dialog-cancel").click();
  ok(!forget.dialog().open, "Cancel closes it");
  is(SvalSiteProtections.ruleFor(SITE).protections, "off", "and keeps all");
  await until(
    () => !ui.doc.querySelector(".sval-forget-group"),
    "the list going with the confirm"
  );
});

add_task(async function forgetting_leaves_nothing_held() {
  await holdSome();
  const { page, ui, forget } = await openConfirm();
  forget.confirm().click();
  ok(!forget.dialog().open, "confirming closes it");
  await until(
    () => ui.byId("sval-site-status").textContent,
    "the announcement"
  );
  is(page.document.activeElement, ui.byId("sval-site-title"), "focus on h1");
  await until(
    () => !ui.byId("sval-site-nothing").hidden,
    "the page saying it holds nothing"
  );
  ok(
    !SvalForgetSite.holdsAnything(await SvalForgetSite.countsFor(SITE)),
    "every part forgotten"
  );
  await until(() => forget.button()?.disabled, "Forget… dimmed");
  ok(ui.byId("sval-site-alert").hidden, "no failure note");
});

/**
 * Stores data in the site's IndexedDB, so the profile's quota storage holds
 * an origin of it.
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
  try {
    const tx = db.transaction("data", "readwrite");
    tx.objectStore("data").put(new Uint8Array(4096), 1);
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

/**
 * A disk that will not list the profile's quota storage fails the quota
 * cleaner (`QuotaCleaner.deleteBySite` lists every origin before it clears
 * one), so the data part fails and the rest are forgotten.
 */
add_task(async function a_failed_part_says_so_and_retries_alone() {
  await holdSome();
  await storeData();
  const storage = PathUtils.join(PathUtils.profileDir, "storage", "default");
  const { page, ui, forget } = await openConfirm();
  await SvalTestDeny.list(storage);
  atTaskEnd(() => SvalTestDeny.allow(storage));

  forget.confirm().click();
  const alert = ui.byId("sval-site-alert");
  await until(() => !alert.hidden, "the failure note");
  is(alert.getAttribute("role"), "alert", "an alert");
  Assert.deepEqual(
    [...alert.querySelectorAll(".sval-site-alert-line")].map(line => [
      line.dataset.part,
      !!line.querySelector(".sval-site-alert-reason"),
    ]),
    [["data", true]],
    "a line for the data part, with why"
  );
  is(SvalSiteProtections.ruleFor(SITE).protections, undefined, "the rest went");
  is(
    page.document.activeElement,
    alert.querySelector("button"),
    "focus on Try again"
  );

  await SvalTestDeny.allow(storage);
  alert.querySelector("button").click();
  await until(() => alert.hidden, "the note going once it worked");
  is(page.document.activeElement, ui.byId("sval-site-title"), "focus on h1");
  await until(
    () => ui.byId("sval-site-status").textContent,
    "the announcement"
  );
  ok(
    !SvalForgetSite.holdsAnything(await SvalForgetSite.countsFor(SITE)),
    "every part forgotten"
  );
});

add_task(async function forget_waits_while_one_runs() {
  await holdSome();
  const { ui, forget } = await openConfirm();
  // Forget runs on from the click, through clearing data that ends on a
  // later turn, so the page is read in the same turn as the click.
  forget.confirm().click();
  is(
    forget.button()?.getAttribute("aria-disabled"),
    "true",
    "Forget… dimmed while the Forget runs"
  );
  // The click is on a control the accessibility API reports as disabled,
  // which is the state under test.
  AccessibilityUtils.setEnv({ mustBeEnabled: false });
  forget.button().click();
  AccessibilityUtils.resetEnv();
  // A confirm the press had asked for opens once the site is counted, which
  // ends before the Forget's clearing does.
  await until(
    () => ui.byId("sval-site-status").textContent,
    "the announcement"
  );
  ok(!forget.dialog().open, "and the press opened no second confirm");
});

/**
 * @param {object} forget From `forgetOf`.
 * @returns {Map<string, string>} 8a's "On this device" rows.
 */
function thisDeviceOf(forget) {
  return new Map(
    forget.listed().find(([device]) => device === "this")?.[1] ?? []
  );
}

/** Forgets the site when the task ends. */
function forgetAtEnd() {
  atTaskEnd(() =>
    within(SvalForgetSite.forget(SITE), 30_000, "the teardown forget")
  );
}

add_task(async function data_stored_after_a_read_shows() {
  forgetAtEnd();
  await within(SvalSiteData.update(), 30_000, "the site data reading");
  addCookie();

  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  await until(
    () => ui.doc.querySelector('[data-site-card="data"] .sval-site-data-row'),
    "the cookie stored after the last read listed"
  );
  const forget = forgetOf(ui);
  await until(
    () => forget.button() && !forget.button().disabled,
    "Forget… live"
  );
  forget.button().click();
  await until(() => forget.dialog().open, "the confirm opening");
  await until(
    () => thisDeviceOf(forget).get("data") === "",
    "the confirm counting the cookie"
  );
  forget.dialog().close();
});

add_task(async function an_unlisted_permission_is_held() {
  forgetAtEnd();
  await within(SvalSiteData.update(), 30_000, "the site data reading");
  Services.perms.addFromPrincipal(
    Services.scriptSecurityManager.createContentPrincipal(
      Services.io.newURI(`https://${SITE}`),
      {}
    ),
    "https-only-load-insecure",
    Services.perms.ALLOW_ACTION
  );
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  const forget = forgetOf(ui);
  await until(
    () => forget.button() && !forget.button().disabled,
    "Forget… live for a permission the page has no row for"
  );
  ok(ui.byId("sval-site-nothing").hidden, "the page holds something");
  forget.button().click();
  await until(() => forget.dialog().open, "the confirm opening");
  await until(
    () => thisDeviceOf(forget).get("permissions") === "1",
    "the confirm counting it"
  );
  forget.dialog().close();
});

add_task(async function a_container_only_site_is_held() {
  forgetAtEnd();
  const container = ContextualIdentityService.create("Sval forget test");
  atTaskEnd(() => ContextualIdentityService.remove(container.userContextId));
  Services.cookies.add(
    SITE,
    "/",
    "sval-forget-page",
    "1",
    true,
    false,
    false,
    Date.now() + 3600 * 1000,
    { userContextId: container.userContextId },
    Ci.nsICookie.SAMESITE_LAX,
    Ci.nsICookie.SCHEME_HTTPS
  );
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  const forget = forgetOf(ui);
  await until(
    () => forget.button() && !forget.button().disabled,
    "Forget… live for a container's cookie"
  );
  ok(ui.byId("sval-site-nothing").hidden, "the page holds something");
  ok(
    ui.doc.querySelector('[data-site-card="data"] .sval-empty'),
    "though the data card lists no container"
  );
  forget.button().click();
  await until(() => forget.dialog().open, "the confirm opening");
  await until(
    () => thisDeviceOf(forget).get("data") === "",
    "the confirm counting it"
  );
  forget.dialog().close();
});

add_task(async function a_count_redraws_only_what_it_changes() {
  forgetAtEnd();
  await within(SvalSiteData.update(), 30_000, "the site data reading");
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  const forget = forgetOf(ui);
  await until(() => forget.button()?.disabled, "Forget… dimmed for nothing");
  const protections = ui.doc.querySelector('[data-site-card="protections"]');
  ok(protections, "the protections card");

  // A read of stored data redraws the data card and counts the site again.
  addCookie();
  await within(SvalSiteData.update(), 30_000, "the site data reading");
  await until(
    () => forget.button() && !forget.button().disabled,
    "the count finding the cookie"
  );
  ok(protections.isConnected, "a count leaves the other cards as drawn");
});
