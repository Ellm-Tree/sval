/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Settings › Search and Launcher removes an engine Sval ships for good: it
 * leaves the engine list and stays out of it when the search service loads
 * again, as at the next launch (search-remove-app-engine.patch). Turning an
 * engine off keeps it listed. Installing the engine again from its site
 * brings it back.
 */

const { SearchService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/search/SearchService.sys.mjs"
);
const { SearchUtils } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/search/SearchUtils.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);
const { within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);

do_get_profile();

/** Loads the search service again from the settings it wrote to disk. */
async function relaunch() {
  const written = TestUtils.topicObserved(
    SearchUtils.TOPIC_SEARCH_SERVICE,
    (_subject, data) => data == "write-settings-to-disk-complete"
  );
  await within(written, 10_000, "the search settings are written");
  SearchService.reset();
  await within(SearchService.init(), 10_000, "the search service loads");
}

async function engineIds() {
  return (await SearchService.getEngines()).map(engine => engine.id);
}

add_setup(async function () {
  await within(SearchService.init(), 10_000, "the search service loads");
  Assert.equal(
    (await SearchService.getDefault()).id,
    "ddg",
    "DuckDuckGo is the default"
  );
});

add_task(async function a_removed_engine_stays_removed() {
  const google = SearchService.getEngineById("google");
  Assert.ok(google, "Sval ships Google");

  await SearchService.removeEngine(google, SearchService.CHANGE_REASON.USER);
  Assert.ok(
    !(await engineIds()).includes("google"),
    "Google leaves the engine list"
  );

  await relaunch();
  Assert.ok(
    !(await engineIds()).includes("google"),
    "Google stays out of the engine list at the next launch"
  );
  Assert.ok((await engineIds()).includes("bing"), "Bing is still listed");
});

add_task(async function an_engine_turned_off_stays_listed() {
  SearchService.getEngineById("bing").hidden = true;

  await relaunch();
  const bing = SearchService.getEngineById("bing");
  Assert.ok(bing, "Bing is still in the engine list");
  Assert.ok(bing.hidden, "Bing is still off");
  bing.hidden = false;
});

add_task(async function a_removed_engine_installed_again_comes_back() {
  const google =
    await SearchService.findContextualSearchEngineByHost("google.com");
  Assert.equal(google?.id, "google", "google.com offers Sval's Google");
  await SearchService.addSearchEngine(google);
  Assert.ok((await engineIds()).includes("google"), "Google is listed again");

  await relaunch();
  Assert.ok(
    (await engineIds()).includes("google"),
    "Google stays listed at the next launch"
  );

  await SearchService.removeEngine(
    SearchService.getEngineById("google"),
    SearchService.CHANGE_REASON.USER
  );
  await relaunch();
  Assert.ok(
    !(await engineIds()).includes("google"),
    "Google removed a second time stays out of the engine list"
  );
});
