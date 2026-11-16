/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Reports a user sends go to Sval's collector and nowhere else (decision
 * 1199): the Send Feedback form's address, and the address Gecko's crash
 * dialogs post a crash report to.
 */

add_task(async function feedback_goes_to_sval_s_collector() {
  Assert.equal(
    Services.prefs
      .getDefaultBranch("")
      .getStringPref("browser.sval.support.reportURL"),
    "https://feedback.sval.app/report",
    "the Send Feedback form posts to the collector's /report"
  );
});

add_task(async function crash_reports_go_to_sval_s_collector() {
  // The ServerURL annotation, which the crash reporter window and
  // CrashSubmit.sys.mjs post to. The browser binary compiles application.ini
  // in (build/moz.build, application.ini.h), so this reads the Gecko the
  // build runs on.
  const url = Services.appinfo.serverURL;
  Assert.equal(
    url.prePath + url.filePath,
    "https://feedback.sval.app/submit",
    "a crash report posts to the collector's /submit"
  );
});
