/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// The Workspaces an extension is available in: one synced pref per
// extension, handed to the extension's policy, which Gecko holds against
// the Workspace each tab's browsing context carries.

const { AddonTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/AddonTestUtils.sys.mjs"
);
const { ExtensionTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/ExtensionXPCShellUtils.sys.mjs"
);
const { SvalExtensionSites } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalExtensionSites.sys.mjs"
);
const { AVAILABLE_BRANCH, PIN_BRANCH, SvalExtensionWorkspaces } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalExtensionWorkspaces.sys.mjs"
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

function clearAll() {
  for (const branch of [AVAILABLE_BRANCH, PIN_BRANCH]) {
    for (const name of Services.prefs.getChildList(branch)) {
      Services.prefs.clearUserPref(name);
    }
  }
}

add_setup(async function () {
  await AddonTestUtils.promiseStartupManager();
  SvalExtensionSites.start();
});

add_task(function test_scope_reads_and_writes() {
  Assert.equal(SvalExtensionWorkspaces.availableIn(A), null, "every one");
  Assert.ok(SvalExtensionWorkspaces.isAvailableIn(A, "work"));
  Assert.ok(SvalExtensionWorkspaces.isAvailableIn(A, null), "and none");

  SvalExtensionWorkspaces.setAvailableIn(A, ["work"]);
  Assert.equal(
    Services.prefs.getStringPref(AVAILABLE_BRANCH + A),
    JSON.stringify(["work"]),
    "one pref per extension"
  );
  Assert.ok(SvalExtensionWorkspaces.isAvailableIn(A, "work"));
  Assert.ok(!SvalExtensionWorkspaces.isAvailableIn(A, "home"));
  Assert.ok(!SvalExtensionWorkspaces.isAvailableIn(A, null), "nor a Peek");
  Assert.deepEqual(SvalExtensionWorkspaces.policyEntries(A), ["%work"]);

  SvalExtensionWorkspaces.setAvailableIn(A, null);
  Assert.ok(!Services.prefs.prefHasUserValue(AVAILABLE_BRANCH + A));
  Services.prefs.setStringPref(AVAILABLE_BRANCH + A, "not json");
  Assert.equal(SvalExtensionWorkspaces.availableIn(A), null, "bad is every");
  clearAll();
});

add_task(function test_pin_scope_sits_inside_the_scope() {
  SvalExtensionWorkspaces.setAvailableIn(A, ["work", "home"]);
  Assert.ok(SvalExtensionWorkspaces.pinShowsIn(A, "home"));
  SvalExtensionWorkspaces.setPinScope(A, ["work"]);
  Assert.ok(SvalExtensionWorkspaces.pinShowsIn(A, "work"));
  Assert.ok(!SvalExtensionWorkspaces.pinShowsIn(A, "home"));
  SvalExtensionWorkspaces.setPinScope(A, null);
  Assert.ok(
    !SvalExtensionWorkspaces.pinShowsIn(A, "other"),
    "a pin never shows where the extension isn't available"
  );
  clearAll();
});

add_task(async function test_policy_follows_the_scope() {
  const extension = ExtensionTestUtils.loadExtension({
    manifest: { browser_specific_settings: { gecko: { id: A } } },
    useAddonManager: "permanent",
  });
  await extension.startup();
  const policy = WebExtensionPolicy.getByID(A);
  Assert.ok(!policy.blockedInWorkspace(""), "every Workspace, none included");

  SvalExtensionWorkspaces.setAvailableIn(A, ["work"]);
  Assert.deepEqual([...policy.blockedSites], ["%work"]);
  Assert.ok(!policy.blockedInWorkspace("work"));
  Assert.ok(policy.blockedInWorkspace("home"));
  Assert.ok(policy.blockedInWorkspace(""), "a tab with no Workspace");
  Assert.ok(
    !policy.blockedOnTopSite("example.com"),
    "a Workspace entry is no site"
  );
  await extension.unload();
  clearAll();
});

add_task(async function test_content_scripts_follow_the_tabs_workspace() {
  const server = AddonTestUtils.createHttpServer({ hosts: ["example.com"] });
  server.registerPathHandler("/page", (request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.write("<p>page</p>");
  });
  const extension = ExtensionTestUtils.loadExtension({
    manifest: {
      browser_specific_settings: { gecko: { id: A } },
      content_scripts: [{ matches: ["http://example.com/*"], js: ["ran.js"] }],
    },
    files: {
      "ran.js": "browser.test.sendMessage('ran', location.search)",
    },
    useAddonManager: "permanent",
  });
  await extension.startup();
  SvalExtensionWorkspaces.setAvailableIn(A, ["work"]);

  // Each page's scripts run before its load ends, so the first message names
  // the first page that ran one.
  const page = await ExtensionTestUtils.loadContentPage("about:blank");
  page.browser.browsingContext.svalWorkspace = "home";
  await page.loadURL("http://example.com/page?home");
  page.browser.browsingContext.svalWorkspace = "work";
  await page.loadURL("http://example.com/page?work");
  Assert.equal(
    await extension.awaitMessage("ran"),
    "?work",
    "nothing ran in the other Workspace's tab, and the scope's tab runs it"
  );
  await page.close();
  await extension.unload();
  clearAll();
});

add_task(function test_sync_branches_listed() {
  Assert.ok(SvalSettingsRegistry.SYNCED_BRANCHES.includes(AVAILABLE_BRANCH));
  Assert.ok(SvalSettingsRegistry.SYNCED_BRANCHES.includes(PIN_BRANCH));
});
