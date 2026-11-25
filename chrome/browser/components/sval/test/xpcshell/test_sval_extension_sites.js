/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// Each extension's switch for each site, stored as one synced pref per site
// holding the ids of the extensions off there, and handed to each running
// extension's policy.

const { AddonTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/AddonTestUtils.sys.mjs"
);
const { ExtensionTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/ExtensionXPCShellUtils.sys.mjs"
);
const { DEFAULT_BRANCH, SITE_BRANCH, SvalExtensionSites } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalExtensionSites.sys.mjs"
  );
const { SvalSettingsRegistry } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSettingsRegistry.sys.mjs"
);

AddonTestUtils.init(this);
AddonTestUtils.createAppInfo(
  "xpcshell@tests.mozilla.org",
  "XPCShell",
  "42",
  "42"
);
AddonTestUtils.overrideCertDB();
ExtensionTestUtils.init(this);

const A = "a@tests.sval.app";
const B = "b@tests.sval.app";

function clearAll() {
  for (const branch of [SITE_BRANCH, DEFAULT_BRANCH]) {
    for (const name of Services.prefs.getChildList(branch)) {
      Services.prefs.clearUserPref(name);
    }
  }
}

add_setup(async function () {
  await AddonTestUtils.promiseStartupManager();
  SvalExtensionSites.start();
});

add_task(function test_set_and_read() {
  Assert.ok(!SvalExtensionSites.isOff(A, "example.com"), "on by default");
  SvalExtensionSites.setOff(A, "example.com", true);
  Assert.ok(SvalExtensionSites.isOff(A, "example.com"));
  Assert.ok(!SvalExtensionSites.isOff(B, "example.com"), "per extension");
  Assert.ok(!SvalExtensionSites.isOff(A, "example.org"), "per site");
  SvalExtensionSites.setOff(A, "example.org", true);
  Assert.deepEqual(SvalExtensionSites.sitesOff(A), [
    "example.com",
    "example.org",
  ]);
  Assert.deepEqual(SvalExtensionSites.idsOffOn("example.com"), [A]);
  Assert.deepEqual(SvalExtensionSites.blockedSitesFor(A), [
    "example.com",
    "example.org",
  ]);
  SvalExtensionSites.setOff(A, "example.com", false);
  Assert.ok(!SvalExtensionSites.isOff(A, "example.com"), "on again");
  clearAll();
});

add_task(function test_pref_shape() {
  SvalExtensionSites.setOff(B, "example.com", true);
  SvalExtensionSites.setOff(A, "example.com", true);
  Assert.equal(
    Services.prefs.getStringPref(`${SITE_BRANCH}example.com`),
    JSON.stringify([A, B]),
    "one pref per site, its ids sorted"
  );
  SvalExtensionSites.setOff(A, "example.com", false);
  SvalExtensionSites.setOff(B, "example.com", false);
  Assert.ok(
    !Services.prefs.prefHasUserValue(`${SITE_BRANCH}example.com`),
    "an empty site leaves no pref"
  );
});

add_task(function test_bad_pref_reads_as_none() {
  Services.prefs.setStringPref(`${SITE_BRANCH}example.com`, "not json");
  Assert.ok(!SvalExtensionSites.isOff(A, "example.com"));
  Services.prefs.setStringPref(`${SITE_BRANCH}example.com`, '{"a":1}');
  Assert.deepEqual(SvalExtensionSites.idsOffOn("example.com"), []);
  clearAll();
});

add_task(async function test_entry_applies_on_install() {
  Services.prefs.setStringPref(
    `${SITE_BRANCH}example.com`,
    JSON.stringify([A])
  );
  const extension = ExtensionTestUtils.loadExtension({
    manifest: { browser_specific_settings: { gecko: { id: A } } },
    useAddonManager: "permanent",
  });
  await extension.startup();
  Assert.deepEqual(
    [...WebExtensionPolicy.getByID(A).blockedSites].sort(),
    ["example.com"],
    "the running extension's policy holds the site"
  );
  SvalExtensionSites.setOff(A, "example.org", true);
  Assert.deepEqual(
    [...WebExtensionPolicy.getByID(A).blockedSites].sort(),
    ["example.com", "example.org"],
    "and follows a change"
  );
  await extension.unload();
  Assert.ok(
    Services.prefs.prefHasUserValue(`${SITE_BRANCH}example.com`),
    "removing the extension keeps its switches"
  );
  clearAll();
});

add_task(async function test_a_host_switch_beats_its_sites() {
  const extension = ExtensionTestUtils.loadExtension({
    manifest: { browser_specific_settings: { gecko: { id: A } } },
    useAddonManager: "permanent",
  });
  await extension.startup();
  const policy = WebExtensionPolicy.getByID(A);

  SvalExtensionSites.setOff(A, "app.example.com", false);
  Assert.equal(
    SvalExtensionSites.ruleFor(A, "app.example.com"),
    undefined,
    "on, as its site is, stores nothing"
  );
  SvalExtensionSites.setOff(A, "example.com", true);
  SvalExtensionSites.setOff(A, "app.example.com", false);
  Assert.equal(SvalExtensionSites.ruleFor(A, "app.example.com"), "on");
  Assert.deepEqual(SvalExtensionSites.idsOnAt("app.example.com"), [A]);
  Assert.deepEqual(SvalExtensionSites.idsOffOn("app.example.com"), []);
  Assert.ok(!SvalExtensionSites.isOff(A, "deep.app.example.com"));
  Assert.ok(SvalExtensionSites.isOff(A, "other.example.com"));
  Assert.deepEqual(
    [...policy.blockedSites].sort(),
    ["example.com", "~app.example.com"],
    "the policy holds the host it runs on"
  );
  Assert.ok(
    !policy.blockedOnTopSite("deep.app.example.com"),
    "Gecko lets it run under the host"
  );
  Assert.ok(
    policy.blockedOnTopSite("other.example.com"),
    "and keeps it off on its sibling"
  );
  Assert.deepEqual(SvalExtensionSites.names(), [
    "app.example.com",
    "example.com",
  ]);

  SvalExtensionSites.setOff(A, "app.example.com", true);
  Assert.equal(
    SvalExtensionSites.ruleFor(A, "app.example.com"),
    undefined,
    "off again, as its site is, takes the host's switch away"
  );
  await extension.unload();
  clearAll();
});

add_task(async function test_content_scripts_follow_the_top_level_host() {
  const server = AddonTestUtils.createHttpServer({
    hosts: ["app.example.com", "other.example.com"],
  });
  server.registerPathHandler("/top", (request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.write(`<iframe src="http://other.example.com/frame"></iframe>`);
  });
  for (const path of ["/frame", "/page"]) {
    server.registerPathHandler(path, (request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.write("<p>page</p>");
    });
  }
  const extension = ExtensionTestUtils.loadExtension({
    manifest: {
      browser_specific_settings: { gecko: { id: A } },
      content_scripts: [
        {
          matches: ["http://*.example.com/*"],
          js: ["ran.js"],
          all_frames: true,
        },
      ],
    },
    files: { "ran.js": "browser.test.sendMessage('ran', location.href)" },
    useAddonManager: "permanent",
  });
  await extension.startup();
  await SvalExtensionSites.setOff(A, "app.example.com", true);

  // Each page's scripts run before its load ends, so the first message names
  // the first page that ran one.
  const top = await ExtensionTestUtils.loadContentPage(
    "http://app.example.com/top"
  );
  await top.close();
  const sibling = await ExtensionTestUtils.loadContentPage(
    "http://other.example.com/page"
  );
  Assert.equal(
    await extension.awaitMessage("ran"),
    "http://other.example.com/page",
    "nothing ran in the host's tab, its sibling's frame included, and its sibling's own page runs it"
  );
  await sibling.close();
  await extension.unload();
  clearAll();
});

add_task(async function test_off_by_default_runs_only_where_switched_on() {
  const extension = ExtensionTestUtils.loadExtension({
    manifest: { browser_specific_settings: { gecko: { id: A } } },
    useAddonManager: "permanent",
  });
  await extension.startup();
  const policy = WebExtensionPolicy.getByID(A);

  await SvalExtensionSites.setOffByDefault(A, true);
  Assert.ok(SvalExtensionSites.isOff(A, "example.com"), "off where no switch");
  Assert.ok(!SvalExtensionSites.isOff(B, "example.com"), "per extension");
  Assert.deepEqual([...policy.blockedSites], ["*"]);
  Assert.ok(policy.blockedOnTopSite("example.com"), "Gecko holds it off");
  Assert.ok(!policy.blockedOnTopSite(""), "a page with no host is never off");

  await SvalExtensionSites.setOff(A, "example.com", false);
  Assert.equal(SvalExtensionSites.ruleFor(A, "example.com"), "on");
  Assert.deepEqual(SvalExtensionSites.sitesOn(A), ["example.com"]);
  Assert.ok(!SvalExtensionSites.isOff(A, "app.example.com"));
  Assert.ok(!policy.blockedOnTopSite("app.example.com"), "runs on the site");
  Assert.ok(policy.blockedOnTopSite("example.org"), "and nowhere else");
  await extension.unload();
  clearAll();
});

add_task(async function test_changing_the_default_drops_redundant_switches() {
  await SvalExtensionSites.setOff(A, "example.com", true);
  await SvalExtensionSites.setOff(A, "app.example.com", false);
  await SvalExtensionSites.setOff(A, "example.org", true);

  await SvalExtensionSites.setOffByDefault(A, true);
  Assert.equal(
    SvalExtensionSites.ruleFor(A, "example.com"),
    undefined,
    "a site switched off matches the default"
  );
  Assert.equal(SvalExtensionSites.ruleFor(A, "example.org"), undefined);
  Assert.equal(
    SvalExtensionSites.ruleFor(A, "app.example.com"),
    "on",
    "the host switched on stays the exception"
  );
  Assert.ok(SvalExtensionSites.isOff(A, "example.com"));
  Assert.ok(!SvalExtensionSites.isOff(A, "app.example.com"));
  Assert.equal(
    Services.prefs.getStringPref(DEFAULT_BRANCH + A),
    "off",
    "one pref per extension"
  );

  await SvalExtensionSites.setOffByDefault(A, false);
  Assert.equal(
    SvalExtensionSites.ruleFor(A, "app.example.com"),
    undefined,
    "on by default takes the host's switch away"
  );
  Assert.ok(!Services.prefs.prefHasUserValue(DEFAULT_BRANCH + A));
  clearAll();
});

add_task(function test_sync_branch_listed() {
  Assert.ok(SvalSettingsRegistry.SYNCED_BRANCHES.includes(SITE_BRANCH));
  Assert.ok(SvalSettingsRegistry.SYNCED_BRANCHES.includes(DEFAULT_BRANCH));
});

add_task(async function test_off_by_default_keeps_content_scripts_out() {
  const server = AddonTestUtils.createHttpServer({
    hosts: ["off.example.com", "on.example.com"],
  });
  server.registerPathHandler("/page", (request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.write("<p>page</p>");
  });
  const extension = ExtensionTestUtils.loadExtension({
    manifest: {
      browser_specific_settings: { gecko: { id: A } },
      content_scripts: [
        { matches: ["http://*.example.com/*"], js: ["ran.js"] },
      ],
    },
    files: { "ran.js": "browser.test.sendMessage('ran', location.host)" },
    useAddonManager: "permanent",
  });
  await extension.startup();
  await SvalExtensionSites.setOffByDefault(A, true);
  await SvalExtensionSites.setOff(A, "on.example.com", false);

  // Each page's scripts run before its load ends, so the first message names
  // the first page that ran one.
  const off = await ExtensionTestUtils.loadContentPage(
    "http://off.example.com/page"
  );
  await off.close();
  const on = await ExtensionTestUtils.loadContentPage(
    "http://on.example.com/page"
  );
  Assert.equal(
    await extension.awaitMessage("ran"),
    "on.example.com",
    "nothing ran on a site the default holds off, and the site switched on runs it"
  );
  await on.close();
  await extension.unload();
  clearAll();
});
