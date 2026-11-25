/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * Firefox's synced tabs sidebar is not built: Firefox accounts are locked
 * off, so it could only ever ask the user to sign in. The sidebar has no
 * panel for it, and WebRTC's indicator keeps its events on toolkit's
 * EventEmitter.
 */

/** A file of the removed component and of the revamped sidebar's panel. */
const REMOVED_FILES = [
  "resource:///modules/syncedtabs/EventEmitter.sys.mjs",
  "resource:///modules/syncedtabs/TabListView.sys.mjs",
  "chrome://browser/content/syncedtabs/sidebar.xhtml",
  "chrome://browser/skin/syncedtabs/sidebar.css",
  "chrome://browser/content/sidebar/sidebar-syncedtabs.html",
];

add_task(function removed_synced_tabs_files_do_not_ship() {
  Assert.ok(
    packaged("chrome://browser/content/places/historySidebar.xhtml"),
    "a sidebar panel the package keeps is found"
  );
  for (const spec of REMOVED_FILES) {
    Assert.ok(!packaged(spec), `${spec} is not in the package`);
  }
});

add_task(async function the_sidebar_has_no_synced_tabs_panel() {
  await SidebarController.promiseInitialized;
  Assert.ok(
    SidebarController.sidebars.has("viewHistorySidebar"),
    "the sidebar registers its history panel"
  );
  Assert.ok(
    !SidebarController.sidebars.has("viewTabsSidebar"),
    "the sidebar registers no synced tabs panel"
  );
  Assert.ok(
    !document.getElementById("sidebar-switcher-tabs"),
    "the sidebar's switcher has no synced tabs item"
  );
});

add_task(function webrtc_events_reach_their_listeners() {
  const { webrtcUI } = ChromeUtils.importESModule(
    "resource:///modules/webrtcUI.sys.mjs"
  );
  const heard = [];
  const listener = (event, details) => heard.push([event, details]);
  webrtcUI.on("peer-request-allowed", listener);
  webrtcUI.emitter.emit("peer-request-allowed", { callID: "1" });
  webrtcUI.off("peer-request-allowed", listener);
  webrtcUI.emitter.emit("peer-request-allowed", { callID: "2" });
  Assert.deepEqual(
    heard,
    [["peer-request-allowed", { callID: "1" }]],
    "a listener hears an event until it is removed"
  );
});
