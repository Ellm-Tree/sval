/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * A profile that has never crashed has no crash-report folders, and reading
 * them is no error: the crash manager answers with no crashes and logs
 * nothing.
 */

"use strict";

const { CrashManager } = ChromeUtils.importESModule(
  "resource://gre/modules/CrashManager.sys.mjs"
);

add_task(async function folders_never_made_are_read_as_empty() {
  const profile = do_get_profile().path;
  const manager = new CrashManager({
    pendingDumpsDir: PathUtils.join(profile, "no-pending"),
    submittedDumpsDir: PathUtils.join(profile, "no-submitted"),
  });
  const errors = [];
  const observe = message => {
    if (message.level === "error" || message.level === "warn") {
      errors.push(Array.from(message.arguments ?? [], String).join(" "));
    }
  };
  const storage = Cc["@mozilla.org/consoleAPI-storage;1"].getService(
    Ci.nsIConsoleAPIStorage
  );
  storage.addLogEventListener(
    observe,
    Cc["@mozilla.org/systemprincipal;1"].createInstance(Ci.nsIPrincipal)
  );
  let pending, submitted;
  try {
    pending = await manager.pendingDumps();
    submitted = await manager.submittedDumps();
  } finally {
    storage.removeLogEventListener(observe);
  }
  Assert.deepEqual(pending, [], "no pending crashes");
  Assert.deepEqual(submitted, [], "no submitted crashes");
  Assert.deepEqual(errors, [], "nothing is logged");
});
