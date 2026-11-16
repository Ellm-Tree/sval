/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { syncableAddress } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSyncableAddress.sys.mjs"
);

const PREF = "services.sync.engine.tabs.filteredSchemes";

add_task(function every_scheme_firefox_keeps_off_its_tab_sync_stays() {
  Assert.equal(
    Services.prefs.getStringPref(PREF),
    "about|resource|chrome|file|blob|moz-extension|data"
  );
  for (const url of [
    "about:preferences",
    "about:home",
    "resource://gre/modules/XPCOMUtils.sys.mjs",
    "chrome://browser/content/browser.xhtml",
    "file:///Users/me/notes.html",
    "blob:https://example.com/0c7b9b7e-6a0e-4d2b-9a65-1f1b0e1f3c2a",
    "moz-extension://4b1d0f2a-1c9e-4b0a-9d2f-6e8a1b3c5d7f/page.html",
    "data:text/html,<p>hi</p>",
  ]) {
    Assert.ok(!syncableAddress(url), `${url} stays`);
  }
});

add_task(function a_scheme_is_read_as_a_load_reads_it() {
  for (const url of [
    "FILE:///Users/me/notes.html",
    "  file:///Users/me/notes.html",
    "Data:text/plain,x",
  ]) {
    Assert.ok(!syncableAddress(url), `${url} stays`);
  }
});

add_task(function a_nested_address_is_judged_by_its_innermost() {
  Assert.ok(!syncableAddress("view-source:file:///Users/me/notes.html"));
  Assert.ok(!syncableAddress("jar:file:///Users/me/a.zip!/index.html"));
  Assert.ok(!syncableAddress("view-source:view-source:about:config"));
  Assert.ok(syncableAddress("view-source:https://example.com/"));
});

add_task(function an_address_that_does_not_parse_stays() {
  Assert.ok(!syncableAddress(""));
  Assert.ok(!syncableAddress("http://"));
});

add_task(function web_pages_and_bookmarklets_sync() {
  for (const url of [
    "https://example.com/",
    "http://intranet/",
    "javascript:alert(1)",
    "mailto:me@example.com",
  ]) {
    Assert.ok(syncableAddress(url), `${url} syncs`);
  }
});

add_task(function the_list_is_the_prefs_as_it_stands() {
  Services.prefs.setStringPref(PREF, "https");
  registerCleanupFunction(() => Services.prefs.clearUserPref(PREF));
  Assert.ok(!syncableAddress("https://example.com/"));
  Assert.ok(syncableAddress("file:///Users/me/notes.html"));
  Services.prefs.clearUserPref(PREF);
  Assert.ok(!syncableAddress("file:///Users/me/notes.html"));
});
