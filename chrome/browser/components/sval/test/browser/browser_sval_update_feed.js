/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * The feed the updater asks for updates, as its update checker builds it from
 * application.ini's URL. A release build is on the release channel, which its
 * default prefs fix, and Receive release candidate updates has it read the
 * beta feed, which carries every candidate and every release.
 */

const RELEASE_CANDIDATES_PREF = "browser.sval.update.releaseCandidates";

function feedOn(channel, releaseCandidates) {
  useUpdateChannel(channel);
  Services.prefs.setBoolPref(RELEASE_CANDIDATES_PREF, releaseCandidates);
  registerCleanupFunction(() =>
    Services.prefs.clearUserPref(RELEASE_CANDIDATES_PREF)
  );
  return Cc["@mozilla.org/updates/update-checker;1"]
    .getService(Ci.nsIUpdateChecker)
    .getUpdateURL(Ci.nsIUpdateChecker.BACKGROUND_CHECK);
}

add_task(async function a_release_build_reads_the_release_feed() {
  const url = await feedOn("release", false);
  Assert.ok(
    url.startsWith("https://download.sval.app/update/1/release/"),
    `the release feed: ${url}`
  );
});

add_task(async function release_candidates_read_the_beta_feed() {
  const url = await feedOn("release", true);
  Assert.ok(
    url.startsWith("https://download.sval.app/update/1/beta/"),
    `the beta feed: ${url}`
  );
});

add_task(async function a_development_build_stays_off_every_published_feed() {
  const url = await feedOn("default", true);
  Assert.ok(
    url.startsWith("https://download.sval.app/update/1/default/"),
    `the unpublished default feed: ${url}`
  );
});
