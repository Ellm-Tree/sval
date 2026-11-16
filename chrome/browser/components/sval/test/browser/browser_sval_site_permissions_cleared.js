/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * Clearing a tab's temporary blocks, which a reload does
 * (`SitePermissions.clearTemporaryBlockPermissions`), tells the tab its
 * permissions changed, so the site's controls redraw without the block
 * (`backport-bug-2064716-site-permissions-cleared.patch`).
 */

add_task(async function clearing_a_tabs_temporary_blocks_tells_the_tab() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/"),
    10_000,
    "the tab opening"
  );
  const browser = tab.linkedBrowser;
  SitePermissions.setForPrincipal(
    browser.contentPrincipal,
    "geo",
    SitePermissions.BLOCK,
    SitePermissions.SCOPE_TEMPORARY,
    browser
  );
  Assert.equal(
    SitePermissions.getForPrincipal(browser.contentPrincipal, "geo", browser)
      .state,
    SitePermissions.BLOCK,
    "the tab holds a temporary block"
  );

  const changed = BrowserTestUtils.waitForEvent(
    browser,
    "PermissionStateChange"
  );
  SitePermissions.clearTemporaryBlockPermissions(browser);
  await within(changed, 10_000, "the tab hearing its permissions changed");
  Assert.equal(
    SitePermissions.getForPrincipal(browser.contentPrincipal, "geo", browser)
      .state,
    SitePermissions.UNKNOWN,
    "and the block is gone"
  );
  BrowserTestUtils.removeTab(tab);
});
