/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { RELEASE_CANDIDATES_PREF, SvalReleaseCandidates } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalReleaseCandidates.sys.mjs"
  );

function setting() {
  return {
    on: Services.prefs.getBoolPref(RELEASE_CANDIDATES_PREF),
    chosen: Services.prefs.prefHasUserValue(RELEASE_CANDIDATES_PREF),
  };
}

add_setup(() => {
  registerCleanupFunction(() =>
    Services.prefs.clearUserPref(RELEASE_CANDIDATES_PREF)
  );
});

add_task(function a_candidate_turns_the_setting_on() {
  Services.prefs.clearUserPref(RELEASE_CANDIDATES_PREF);
  SvalReleaseCandidates.start("0.1.0-rc.4");
  Assert.deepEqual(setting(), { on: true, chosen: true });
});

add_task(function a_release_leaves_it_off() {
  Services.prefs.clearUserPref(RELEASE_CANDIDATES_PREF);
  SvalReleaseCandidates.start("0.1.0");
  Assert.deepEqual(setting(), { on: false, chosen: false });
});

add_task(function a_release_after_a_candidate_keeps_it_on() {
  Services.prefs.clearUserPref(RELEASE_CANDIDATES_PREF);
  SvalReleaseCandidates.start("0.1.0-rc.4");
  SvalReleaseCandidates.start("0.1.0");
  Assert.deepEqual(setting(), { on: true, chosen: true });
});

add_task(function turning_it_off_on_a_candidate_is_kept() {
  Services.prefs.clearUserPref(RELEASE_CANDIDATES_PREF);
  SvalReleaseCandidates.start("0.1.0-rc.4");
  Services.prefs.setBoolPref(RELEASE_CANDIDATES_PREF, false);
  SvalReleaseCandidates.start("0.1.0-rc.5");
  Assert.deepEqual(setting(), { on: false, chosen: true });
});
