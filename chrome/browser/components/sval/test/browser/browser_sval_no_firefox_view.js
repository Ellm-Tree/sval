/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * Firefox View is not built: no page, no button, no menu item, no window
 * handler. The split view's tab picker, about:opentabs, keeps the tab list
 * and the open-tabs modules it shares with Firefox View.
 */

add_task(function firefox_view_does_not_ship() {
  for (const spec of [
    "chrome://browser/content/firefoxview/firefoxview.mjs",
    "chrome://browser/content/firefoxview/opentabs.mjs",
    "chrome://browser/content/firefoxview/card-container.mjs",
    "resource:///modules/firefox-view-tabs-setup-manager.sys.mjs",
    "resource:///modules/SyncedTabsController.sys.mjs",
    "chrome://browser/skin/firefox-view.svg",
  ]) {
    Assert.ok(!packaged(spec), `${spec} is not in the package`);
  }
});

add_task(function the_split_view_picker_keeps_what_it_uses() {
  Assert.ok(
    "@mozilla.org/network/protocol/about;1?what=opentabs" in Cc,
    "about:opentabs is registered"
  );
  for (const spec of [
    "chrome://browser/content/tabbrowser/opentabs.html",
    "chrome://browser/content/tabbrowser/opentabs-splitview.mjs",
    "chrome://browser/content/firefoxview/fxview-tab-list.mjs",
    "chrome://browser/content/firefoxview/helpers.mjs",
    "resource:///modules/OpenTabs.sys.mjs",
    "resource:///modules/OpenTabsController.sys.mjs",
  ]) {
    Assert.ok(packaged(spec), `${spec} is in the package`);
  }
});

add_task(function no_window_holds_firefox_view() {
  Assert.equal(
    typeof window.FirefoxViewHandler,
    "undefined",
    "the window has no Firefox View handler"
  );
  for (const id of ["firefox-view-button", "menu_openFirefoxView"]) {
    Assert.ok(!document.getElementById(id), `the window has no ${id}`);
  }
  Assert.ok(
    !CustomizableUI.getPlacementOfWidget("firefox-view-button"),
    "no toolbar area places the Firefox View button"
  );
});

add_task(function no_window_hook_names_firefox_view() {
  for (const category of [
    "browser-window-domcontentloaded",
    "browser-window-unload",
  ]) {
    for (const { value } of Services.catMan.enumerateCategory(category)) {
      Assert.ok(
        !value.includes("FirefoxViewHandler"),
        `${category} runs ${value}`
      );
    }
  }
});
