/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { SiteDataTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/SiteDataTestUtils.sys.mjs"
);
const { within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);

do_get_profile();

const originIn = userContextId =>
  Services.scriptSecurityManager.createContentPrincipal(
    Services.io.newURI("https://example.com"),
    { userContextId }
  ).origin;

/**
 * Clearing a site for one container leaves its storage in another, and the
 * caller's pattern as it was. `StorageAccessCleaner` strips `userContextId`
 * from the pattern it is given while `permissions.isolateBy.userContext` is
 * false, and `QuotaCleaner` filters by its pattern after an await, so a call
 * with both flags matches every container if the two share one pattern.
 */
add_task(async function a_clear_by_site_keeps_other_containers_storage() {
  Assert.ok(
    !Services.prefs.getBoolPref("permissions.isolateBy.userContext"),
    "the permission manager does not isolate by container"
  );
  await SiteDataTestUtils.addToIndexedDB(originIn(1));
  await SiteDataTestUtils.addToIndexedDB(originIn(2));
  Assert.ok(await SiteDataTestUtils.hasIndexedDB(originIn(1)));
  Assert.ok(await SiteDataTestUtils.hasIndexedDB(originIn(2)));

  const pattern = { userContextId: 1 };
  const failed = await within(
    new Promise(resolve =>
      Services.clearData.deleteDataFromSite(
        "example.com",
        pattern,
        true,
        Ci.nsIClearDataService.CLEAR_DOM_QUOTA |
          Ci.nsIClearDataService.CLEAR_STORAGE_ACCESS,
        resolve
      )
    ),
    30000,
    "the clear by site to finish"
  );

  Assert.equal(failed, 0, "every cleaner succeeded");
  Assert.ok(
    !(await SiteDataTestUtils.hasIndexedDB(originIn(1))),
    "the cleared container's storage is gone"
  );
  Assert.ok(
    await SiteDataTestUtils.hasIndexedDB(originIn(2)),
    "the other container's storage survives"
  );
  Assert.deepEqual(pattern, { userContextId: 1 }, "the pattern is unchanged");

  await SiteDataTestUtils.clear();
});
