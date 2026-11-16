/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Turns on the Release candidates setting the first time a release candidate
 * runs on a profile, so whoever installs a candidate is offered the next one.
 *
 * The choice is written as the profile's own value, so it outlasts the
 * candidate: an update to the release keeps offering candidates until the user
 * turns them off. The pref is a `sticky_pref`, so turning it off is kept as a
 * user value too (`Pref::SetUserValue` drops a non-sticky user value that equals
 * the default), and a profile with any user value is left as it is.
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

export const RELEASE_CANDIDATES_PREF = "browser.sval.update.releaseCandidates";

// scripts/release-channel.sh's form of a release candidate's version.
const CANDIDATE = /^\d+\.\d+\.\d+-rc\.\d+$/;

export const SvalReleaseCandidates = {
  /**
   * @param {string} [version] The version Sval displays.
   */
  start(version = AppConstants.MOZ_APP_VERSION_DISPLAY) {
    if (
      CANDIDATE.test(version) &&
      !Services.prefs.prefHasUserValue(RELEASE_CANDIDATES_PREF)
    ) {
      Services.prefs.setBoolPref(RELEASE_CANDIDATES_PREF, true);
    }
  },
};
