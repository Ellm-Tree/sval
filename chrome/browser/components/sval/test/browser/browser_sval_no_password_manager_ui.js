/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * Firefox's password manager is locked off (spec §7.3), so its interface is
 * not built: about:logins and the sidebar's password list, breach alerts on
 * saved passwords, the form filler, generated passwords, the save prompts,
 * the insecure field warning and Firefox Relay's email masks. The login
 * storage and HTTP authentication prompts stay.
 */

/** A file of each removed piece. */
const REMOVED_FILES = [
  "chrome://browser/content/aboutlogins/aboutLogins.mjs",
  "resource:///actors/AboutLoginsParent.sys.mjs",
  "resource:///actors/AboutProtectionsParent.sys.mjs",
  "resource:///modules/LoginBreaches.sys.mjs",
  "chrome://global/content/megalist/megalist.html",
  "resource://gre/modules/LoginExport.sys.mjs",
  "resource://gre/modules/LoginManagerChild.sys.mjs",
  "resource://gre/modules/LoginManagerParent.sys.mjs",
  "resource://gre/modules/LoginAutoComplete.sys.mjs",
  "resource://gre/modules/shared/PasswordGenerator.sys.mjs",
  "resource://gre/modules/LoginManagerPrompter.sys.mjs",
  "chrome://browser/content/passwordmgr/login-doorhanger-username-field.mjs",
  "resource://gre/modules/InsecurePasswordUtils.sys.mjs",
  "resource://gre/modules/FirefoxRelay.sys.mjs",
  "resource://gre/modules/FormScenarios.sys.mjs",
  "chrome://browser/content/asrouter/assets/glyph-mail-mask-16.svg",
];

add_task(function removed_password_manager_files_do_not_ship() {
  Assert.ok(
    packaged("resource://gre/modules/LoginManagerAuthPrompter.sys.mjs"),
    "the HTTP authentication prompter is found"
  );
  for (const spec of REMOVED_FILES) {
    Assert.ok(!packaged(spec), `${spec} is not in the package`);
  }
});

add_task(function no_window_holds_a_relay_or_password_prompt() {
  for (const id of [
    "relay-integration-offer-notification",
    "relay-integration-reuse-masks-notification",
    "password-notification-icon",
  ]) {
    Assert.ok(!document.getElementById(id), `the window has no ${id}`);
  }
});

add_task(async function the_login_storage_stays() {
  Assert.equal(
    (await Services.logins.getAllLogins()).length,
    0,
    "the login store answers"
  );
});

add_task(async function no_page_gets_the_login_actor() {
  await BrowserTestUtils.withNewTab("https://example.com/", async browser => {
    Assert.throws(
      () =>
        browser.browsingContext.currentWindowGlobal.getActor("LoginManager"),
      /NotFoundError/,
      "no LoginManager actor is registered"
    );
  });
});

add_task(async function no_command_opens_the_password_list() {
  const { ActionsProviderQuickActions } = ChromeUtils.importESModule(
    "moz-src:///browser/components/urlbar/ActionsProviderQuickActions.sys.mjs"
  );
  const { QuickActionsLoaderDefault } = ChromeUtils.importESModule(
    "moz-src:///browser/components/urlbar/QuickActionsLoaderDefault.sys.mjs"
  );
  await QuickActionsLoaderDefault.ensureLoaded();
  Assert.ok(
    ActionsProviderQuickActions.getAction("downloads"),
    "the quick actions are loaded"
  );
  Assert.ok(
    !ActionsProviderQuickActions.getAction("logins"),
    "no quick action opens the password list"
  );
});
