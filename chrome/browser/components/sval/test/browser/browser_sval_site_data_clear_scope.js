/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_private_helpers.js */

/**
 * The site menu's "Clear cookies and site data" clears the
 * site from the tab's own jar: in a private window, that window's cookies
 * and storage go, while a normal window's and another private session's
 * stay.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_private_helpers.js",
  this
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  registerCleanupFunction(async () => {
    await within(
      new Promise(resolve =>
        Services.clearData.deleteDataFromSite(
          "example.com",
          {},
          true,
          Ci.nsIClearDataService.CLEAR_COOKIES_AND_SITE_DATA,
          resolve
        )
      ),
      10_000,
      "the normal window's data clearing"
    );
    await within(
      SvalPrivateJars._clearedForTests(),
      10_000,
      "the private sessions' clears"
    );
  });
});

/**
 * Clears the selected tab's site through the site menu of `win`, and waits
 * for the tab to reload.
 *
 * @param {Window} win
 */
async function clearThroughMenu(win) {
  const menu = win.document.getElementById("sval-site-menu");
  const shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
  win.document.getElementById("sval-site-menu-button").click();
  await within(shown, 5_000, "the site menu's popupshown");
  try {
    win.document.getElementById("sval-site-data-clear").click();
    const reloaded = BrowserTestUtils.browserLoaded(
      win.gBrowser.selectedBrowser
    );
    win.document.getElementById("sval-site-data-clear-go").click();
    await within(reloaded, 10_000, "the tab reloading");
  } finally {
    if (menu.state !== "closed") {
      const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
      menu.hidePopup();
      await within(hidden, 5_000, "the site menu's popuphidden");
    }
  }
}

add_task(async function a_private_clear_leaves_other_jars() {
  const normal = await openIsolationPage(window);
  const a = await openPrivate();
  const b = await openPrivate();
  try {
    const inA = await openIsolationPage(a);
    const inB = await openIsolationPage(b);
    await writeSiteData(normal.linkedBrowser, "normal");
    await writeSiteData(inA.linkedBrowser, "a");
    await writeSiteData(inB.linkedBrowser, "b");

    await clearThroughMenu(a);

    Assert.deepEqual(
      await readSiteData(inA.linkedBrowser),
      { cookie: null, storage: null },
      "the private window's cookie and storage are gone"
    );
    Assert.equal(cookiesIn(jarOf(a)).length, 0, "from its jar");
    Assert.equal(
      cookiesIn(jarOf(b)).length,
      1,
      "while the other jar keeps its cookie"
    );
    Assert.deepEqual(
      await readSiteData(inB.linkedBrowser),
      { cookie: "b", storage: "b" },
      "another private session keeps its own"
    );
    Assert.deepEqual(
      await readSiteData(normal.linkedBrowser),
      { cookie: "normal", storage: "normal" },
      "and so does a normal window"
    );
  } finally {
    await closePrivate(a);
    await closePrivate(b);
    BrowserTestUtils.removeTab(normal);
  }
});
