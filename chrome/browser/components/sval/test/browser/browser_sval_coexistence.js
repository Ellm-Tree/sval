/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Sval runs beside an installed Firefox and never reads or writes its state
 * (decision 1738). These are the directories Gecko would otherwise share
 * with it.
 */

function dirOrNull(key) {
  try {
    return Services.dirsvc.get(key, Ci.nsIFile).path;
  } catch {
    return null;
  }
}

add_task(async function test_shared_extension_directories_are_off() {
  // Each is keyed by the application id that Sval shares with Firefox.
  const keys = ["XREUSysExt"];
  if (AppConstants.platform != "win") {
    keys.push("XRESysLExtPD");
  }
  if (AppConstants.platform == "linux") {
    keys.push("XRESysSExtPD");
  }
  for (const key of keys) {
    Assert.equal(dirOrNull(key), null, `${key} has no directory`);
  }
});

add_task(async function test_app_data_is_svals() {
  const appData = dirOrNull("UAppData");
  Assert.ok(appData, "UAppData resolves");
  const parts = PathUtils.split(appData).map(p => p.toLowerCase());
  Assert.ok(
    !parts.includes("mozilla") && !parts.includes(".mozilla"),
    "UAppData is outside Mozilla's directories"
  );
  if (AppConstants.platform == "linux") {
    Assert.equal(
      appData,
      PathUtils.join(Services.env.get("HOME"), ".sval"),
      "UAppData is ~/.sval"
    );
  }
});

add_task(function test_executable_is_svals() {
  // An executable named firefox shares its process name, and every Windows
  // registration keyed by the executable, with an installed Firefox.
  const exe = Services.dirsvc.get("XREExeF", Ci.nsIFile).leafName;
  const names =
    AppConstants.platform == "win" ? ["sval.exe"] : ["sval", "sval-bin"];
  Assert.ok(names.includes(exe), `the executable ${exe} is Sval's own`);
});
