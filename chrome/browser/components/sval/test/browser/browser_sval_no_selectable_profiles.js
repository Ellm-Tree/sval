/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * Firefox's selectable profiles are not built: no service, no pages, no
 * menus, no profile selector at startup. Sval keeps its data in one
 * directory (decision 1400).
 */

add_task(function selectable_profiles_do_not_ship() {
  for (const spec of [
    "resource:///modules/profiles/SelectableProfileService.sys.mjs",
    "resource:///actors/ProfilesParent.sys.mjs",
    "chrome://browser/content/browser-profiles.js",
    "chrome://browser/content/profiles/profiles.html",
    "chrome://mozapps/content/profile/profileSelection.xhtml",
    "chrome://global/content/aboutProfiles.js",
    "moz-src:///toolkit/profile/ProfilesDatastoreService.sys.mjs",
  ]) {
    Assert.ok(!packaged(spec), `${spec} is not in the package`);
  }
});

add_task(function no_startup_hook_names_selectable_profiles() {
  for (const { value } of Services.catMan.enumerateCategory(
    "browser-first-window-ready"
  )) {
    Assert.ok(
      !value.includes("SelectableProfileService") &&
        !value.includes("ProfilesDatastoreService"),
      `browser-first-window-ready runs ${value}`
    );
  }
});

add_task(function no_window_holds_a_profiles_menu() {
  for (const id of [
    "profiles-menu",
    "Profiles:CreateProfile",
    "moveTabSeparator",
  ]) {
    Assert.ok(!document.getElementById(id), `the window has no ${id}`);
  }
  for (const id of ["appMenu-profiles-button", "PanelUI-profiles"]) {
    Assert.ok(
      !PanelMultiView.getViewNode(document, id),
      `the app menu has no ${id}`
    );
  }
});

add_task(function no_profile_pref_has_a_default() {
  Assert.deepEqual(
    Services.prefs.getDefaultBranch("browser.profiles.").getChildList(""),
    [],
    "Firefox's selectable profile prefs are gone"
  );
});
