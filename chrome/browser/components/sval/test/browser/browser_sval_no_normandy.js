/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * Normandy, Mozilla's recipe client for studies and Heartbeat surveys, is not
 * built: no resource of its own, no startup hook, no extension API, no
 * enterprise policy.
 */

const { Policies } = ChromeUtils.importESModule(
  "resource:///modules/policies/Policies.sys.mjs"
);

add_task(function normandy_registers_no_resource() {
  const resources = Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsIResProtocolHandler);
  for (const root of ["normandy", "normandy-content", "normandy-vendor"]) {
    Assert.ok(!resources.hasSubstitution(root), `no resource://${root}/`);
  }
});

add_task(function no_startup_or_quit_hook_names_normandy() {
  for (const category of [
    "browser-before-ui-startup",
    "browser-quit-application-granted",
  ]) {
    for (const { entry, value } of Services.catMan.enumerateCategory(
      category
    )) {
      Assert.ok(
        !entry.includes("normandy") && !value.includes("Normandy"),
        `${category} runs ${value} from ${entry}`
      );
    }
  }
});

add_task(function the_study_extension_api_does_not_ship() {
  for (const spec of [
    "chrome://browser/content/parent/ext-normandyAddonStudy.js",
    "chrome://browser/content/schemas/normandyAddonStudy.json",
  ]) {
    Assert.ok(!packaged(spec), `${spec} is not in the package`);
  }
});

add_task(function the_studies_policy_is_gone() {
  Assert.ok(
    !("DisableFirefoxStudies" in Policies),
    "no DisableFirefoxStudies policy"
  );
});
