/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The crash manager's periodic maintenance never starts the crash reporter
 * client's Glean ping cleanup. That cleanup runs whatever the upload pref
 * says, and on a Glean store that once had upload on it queues a
 * deletion-request ping for Mozilla's telemetry.
 *
 * The client's `--ping-cleanup` opens its Glean store in `glean/` under the
 * data path it is given (`glean::InitOptions` in the client's glean.rs),
 * which `cleanupPings` in CrashManager.in.sys.mjs makes `Crash Reports/` in
 * the user's app data. A cleanup that ran leaves that store behind. xpcshell
 * has no app data directory, so the test gives it one, as the browser's
 * directory service does.
 */

"use strict";

const { CrashManager } = ChromeUtils.importESModule(
  "resource://gre/modules/CrashManager.sys.mjs"
);
const { CrashServiceUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/CrashService.sys.mjs"
);

function makeManager() {
  const profile = do_get_profile().path;
  return new CrashManager({
    pendingDumpsDir: PathUtils.join(profile, "pending"),
    submittedDumpsDir: PathUtils.join(profile, "submitted"),
    eventsDirs: [PathUtils.join(profile, "events")],
    storeDir: PathUtils.join(profile, "store"),
  });
}

const appData = PathUtils.join(do_get_profile().path, "app-data");
Services.dirsvc.registerProvider({
  getFile(prop, persistent) {
    persistent.value = true;
    if (prop !== "UAppData") {
      throw Components.Exception("", Cr.NS_ERROR_FAILURE);
    }
    const dir = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    dir.initWithPath(appData);
    return dir;
  },
  QueryInterface: ChromeUtils.generateQI(["nsIDirectoryServiceProvider"]),
});

add_task(async function maintenance_runs_no_ping_cleanup() {
  const manager = makeManager();
  Assert.ok(
    CrashServiceUtils.getCrashReporterPath().exists(),
    "the crash reporter client is there for a cleanup to start"
  );
  const glean = PathUtils.join(appData, "Crash Reports", "glean");
  Assert.ok(!(await IOUtils.exists(glean)), "no Glean store before the pass");

  await manager.runMaintenanceTasks();

  Assert.ok(
    !(await IOUtils.exists(glean)),
    "maintenance left no Glean store, so the client's ping cleanup never ran"
  );
});
