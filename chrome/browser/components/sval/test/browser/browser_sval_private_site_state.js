/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_private_helpers.js */

/**
 * A private window keeps a site's state to itself (private-windows
 * spec): HSTS, certificate exceptions, permissions, site choices, content
 * prefs and favicons stay in the window, and nothing it chooses is written
 * to the profile.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_private_helpers.js",
  this
);

const { SvalSiteProtections, SITE_BRANCH } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
);
const { ContentBlockingAllowList } = ChromeUtils.importESModule(
  "resource://gre/modules/ContentBlockingAllowList.sys.mjs"
);
const { PlacesTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PlacesTestUtils.sys.mjs"
);
const HSTS_PAGE = ROOT + "sval_private_hsts.sjs";

/** Every private session's data this file made goes when the file ends. */
add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  registerCleanupFunction(async () => {
    Services.perms.removeAll();
    await within(
      SvalPrivateJars._clearedForTests(),
      10_000,
      "the private sessions' clears"
    );
  });
});

add_task(async function hsts_stays_in_its_window() {
  const sss = Cc["@mozilla.org/ssservice;1"].getService(
    Ci.nsISiteSecurityService
  );
  // eslint-disable-next-line sdl/no-insecure-url
  const http = Services.io.newURI("http://example.com/");
  const a = await openPrivate();
  const b = await openPrivate();
  // A top-level page's state is keyed by its own site as well
  // (`NormalizePartitionKey`), as each window's loads of it look it up.
  const partitionKey = "(http,example.com)";
  const attrsA = {
    privateBrowsingId: 1,
    userContextId: jarOf(a),
    partitionKey,
  };
  const attrsB = {
    privateBrowsingId: 1,
    userContextId: jarOf(b),
    partitionKey,
  };
  try {
    await openIsolationPage(a, HSTS_PAGE);
    Assert.ok(
      sss.isSecureURI(http, attrsA),
      "the window that saw the header loads the site over HTTPS only"
    );
    Assert.ok(!sss.isSecureURI(http, attrsB), "another private window doesn't");
    Assert.ok(
      !sss.isSecureURI(http, { partitionKey }),
      "and nor does a normal one"
    );
    await closePrivate(a);
    Assert.ok(!sss.isSecureURI(http, attrsA), "the record went with it");
  } finally {
    await closePrivate(a);
    await closePrivate(b);
  }
});

add_task(async function a_certificate_exception_stays_in_its_window() {
  const overrides = Cc["@mozilla.org/security/certoverride;1"].getService(
    Ci.nsICertOverrideService
  );
  const [cert] = Cc["@mozilla.org/security/x509certdb;1"]
    .getService(Ci.nsIX509CertDB)
    .getCerts();
  const a = await openPrivate();
  const b = await openPrivate();
  const attrsA = { privateBrowsingId: 1, userContextId: jarOf(a) };
  const attrsB = { privateBrowsingId: 1, userContextId: jarOf(b) };
  const taken = attrs =>
    overrides.hasMatchingOverride("example.com", 443, attrs, cert, {});
  try {
    overrides.rememberValidityOverride("example.com", 443, attrsA, cert, true);
    Assert.ok(taken(attrsA), "the window that accepted the exception takes it");
    Assert.ok(!taken(attrsB), "another private window doesn't");
    Assert.ok(!taken({}), "and nor does a normal one");
    await closePrivate(a);
    Assert.ok(!taken(attrsA), "the exception went with it");
  } finally {
    overrides.clearValidityOverride("example.com", 443, attrsA);
    await closePrivate(a);
    await closePrivate(b);
  }
});

add_task(async function a_permission_stays_in_its_window() {
  const a = await openPrivate();
  const b = await openPrivate();
  try {
    const inA = await openIsolationPage(a);
    const inB = await openIsolationPage(b);
    SitePermissions.setForPrincipal(
      inA.linkedBrowser.contentPrincipal,
      "geo",
      SitePermissions.ALLOW
    );
    const query = browser =>
      SpecialPowers.spawn(
        browser,
        [],
        async () =>
          (await content.navigator.permissions.query({ name: "geolocation" }))
            .state
      );
    Assert.equal(await query(inA.linkedBrowser), "granted", "granted here");
    Assert.equal(await query(inB.linkedBrowser), "prompt", "not there");
    await closePrivate(a);
    Assert.deepEqual(
      Services.perms.getAllByTypes(["geo"]),
      [],
      "and gone once its window closed"
    );
  } finally {
    await closePrivate(a);
    await closePrivate(b);
  }
});

/**
 * The built-in permissions, such as the add-ons site's right to offer an
 * install, hold in a private window as in a normal one.
 */
add_task(async function built_in_permissions_hold_in_a_private_window() {
  const a = await openPrivate();
  try {
    const principal = Services.scriptSecurityManager.createContentPrincipal(
      Services.io.newURI("https://addons.mozilla.org/"),
      { privateBrowsingId: 1, userContextId: jarOf(a) }
    );
    Assert.equal(
      Services.perms.testPermissionFromPrincipal(principal, "install"),
      Services.perms.ALLOW_ACTION,
      "the add-ons site may offer an install"
    );
  } finally {
    await closePrivate(a);
  }
});

/**
 * A choice made in a private window, protections off, media and zoom,
 * applies there alone, and leaves nothing behind in the normal window or on
 * disk once the window closes.
 */
add_task(async function nothing_chosen_in_a_private_window_is_kept() {
  const site = "example.com";
  Services.perms.removeAll();
  const a = await openPrivate();
  const b = await openPrivate();
  try {
    const inA = await openIsolationPage(a);
    const inB = await openIsolationPage(b);
    SvalSiteProtections.setProtections(site, "off", jarOf(a));
    SvalSiteProtections.setMedia(site, "allow", jarOf(a));
    Assert.ok(
      ContentBlockingAllowList.includes(inA.linkedBrowser),
      "protections are off in the window that chose"
    );
    Assert.ok(
      !ContentBlockingAllowList.includes(inB.linkedBrowser),
      "and on in another private window"
    );
    Assert.equal(SvalSiteProtections.mediaFor(site, jarOf(b)), "ask");

    a.FullZoom.enlarge();
    await TestUtils.waitForCondition(
      () => a.ZoomManager.getZoomForBrowser(inA.linkedBrowser) > 1,
      "the page zoomed in"
    );
    // A zoom change reaches a window's tabs a turn after it is made.
    await new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
    Assert.equal(
      b.ZoomManager.getZoomForBrowser(inB.linkedBrowser),
      1,
      "another private window keeps its zoom"
    );

    await closePrivate(a);
    Assert.deepEqual(
      [...SvalSiteProtections.rules(jarOf(a))],
      [],
      "the window's choices went with it"
    );
    Assert.deepEqual([...SvalSiteProtections.rules()], [], "none are stored");
    Assert.deepEqual(
      Services.prefs.getChildList(SITE_BRANCH),
      [],
      "none reach a pref"
    );
    Assert.deepEqual(
      Services.perms.getAllByTypes([
        "trackingprotection",
        "trackingprotection-pb",
        "autoplay-media",
      ]),
      [],
      "nor any permission"
    );
    const normal = await openIsolationPage(window);
    try {
      Assert.ok(
        !ContentBlockingAllowList.includes(normal.linkedBrowser),
        "the normal window has its protections"
      );
      Assert.equal(ZoomManager.getZoomForBrowser(normal.linkedBrowser), 1);
    } finally {
      BrowserTestUtils.removeTab(normal);
    }
    Assert.equal(
      await zoomStored(ISOLATION_PAGE),
      undefined,
      "no zoom is in the profile's content prefs"
    );
    const c = await openPrivate();
    try {
      const inC = await openIsolationPage(c);
      Assert.equal(
        c.ZoomManager.getZoomForBrowser(inC.linkedBrowser),
        1,
        "a new private window starts at the default zoom"
      );
    } finally {
      await closePrivate(c);
    }
  } finally {
    await closePrivate(a);
    await closePrivate(b);
  }
});

add_task(async function a_private_page_leaves_no_favicon() {
  // A page only this task opens, already in history as a normal visit
  // leaves it, which is what lets Places store an icon for it.
  const page = `${ISOLATION_PAGE}?icon`;
  const uri = Services.io.newURI(page);
  await PlacesTestUtils.addVisits(page);
  registerCleanupFunction(() => PlacesUtils.history.clear());
  Assert.equal(await PlacesUtils.favicons.getFaviconForPage(uri), null);
  const a = await openPrivate();
  try {
    const tab = await openIsolationPage(a, page);
    await TestUtils.waitForCondition(
      () => tab.getAttribute("image"),
      "the tab shows the page's icon"
    );
    await PlacesTestUtils.promiseAsyncUpdates();
    Assert.equal(
      await PlacesUtils.favicons.getFaviconForPage(uri),
      null,
      "the profile keeps no icon for it"
    );
  } finally {
    await closePrivate(a);
  }
});

/**
 * A site's content prefs, such as its spellcheck language, and the folder a
 * download was last saved to, are each private window's own.
 */
add_task(async function content_prefs_and_the_download_folder_stay_apart() {
  const { DownloadLastDir } = ChromeUtils.importESModule(
    "resource://gre/modules/DownloadLastDir.sys.mjs"
  );
  const cps2 = Cc["@mozilla.org/content-pref/service;1"].getService(
    Ci.nsIContentPrefService2
  );
  const read = context =>
    new Promise(resolve => {
      let value;
      cps2.getByDomainAndName("example.com", "sval.test.pref", context, {
        handleResult(pref) {
          value = pref.value;
        },
        handleCompletion() {
          resolve(value);
        },
      });
    });
  const dir = await makeTempDir("sval-last-dir");
  const folder = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  folder.initWithPath(dir);
  const uri = Services.io.newURI(ISOLATION_PAGE);
  const a = await openPrivate();
  const b = await openPrivate();
  try {
    const contextA = (await openIsolationPage(a)).linkedBrowser.loadContext;
    const contextB = (await openIsolationPage(b)).linkedBrowser.loadContext;
    await new Promise(resolve =>
      cps2.set("example.com", "sval.test.pref", "a", contextA, {
        handleCompletion: resolve,
      })
    );
    Assert.equal(await read(contextA), "a", "the window reads its own pref");
    Assert.equal(await read(contextB), undefined, "another doesn't");
    Assert.equal(await read(null), undefined, "nor does the profile");
    // A page's own process asks through the parent, as spellcheck does.
    const fromPage = browser =>
      SpecialPowers.spawn(browser, [], async () => {
        const service = Cc["@mozilla.org/content-pref/service;1"].getService(
          Ci.nsIContentPrefService2
        );
        const context = docShell.QueryInterface(Ci.nsILoadContext);
        return new Promise(resolve => {
          let value;
          service.getByDomainAndName("example.com", "sval.test.pref", context, {
            handleResult(pref) {
              value = pref.value;
            },
            handleCompletion() {
              resolve(value);
            },
          });
        });
      });
    Assert.equal(
      await fromPage(a.gBrowser.selectedBrowser),
      "a",
      "a page reads its window's pref"
    );
    Assert.equal(
      await fromPage(b.gBrowser.selectedBrowser),
      undefined,
      "and a page in another private window doesn't"
    );

    new DownloadLastDir(a).setFile(uri, folder);
    Assert.equal(
      (await new DownloadLastDir(a).getFileAsync(uri))?.path,
      dir,
      "the window remembers its last download folder"
    );
    Assert.notEqual(
      (await new DownloadLastDir(b).getFileAsync(uri))?.path,
      dir,
      "another private window doesn't"
    );
    Assert.notEqual(
      (await new DownloadLastDir(window).getFileAsync(uri))?.path,
      dir,
      "nor does a normal one"
    );
    await closePrivate(a);
    Assert.equal(await read(contextB), undefined, "and none reached it later");
  } finally {
    await closePrivate(a);
    await closePrivate(b);
    await IOUtils.remove(dir, { recursive: true });
  }
});
