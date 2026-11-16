/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */

/**
 * The most one shared step reads from the folder (decision 0032). Someone who
 * can write to the folder fills every document's directory; the step copies
 * nothing past the limit, and the footer's indicator says sync stopped.
 * Under the limit the same folder syncs.
 */

const { MAX_FILE_BYTES, MAX_STEP_BYTES } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
);

/** Planted per document, each `MAX_FILE_BYTES`. */
const PLANTED = 3;

/**
 * Every directory under `root` that holds a file, and that file's extension.
 *
 * @param {string} root
 * @returns {Promise<object[]>} `{ dir, extension }` each.
 */
async function documentDirs(root) {
  const found = [];
  const walk = async dir => {
    let holdsFile = null;
    for (const child of await IOUtils.getChildren(dir)) {
      const { type } = await IOUtils.stat(child);
      if (type === "directory") {
        await walk(child);
      } else {
        holdsFile = child;
      }
    }
    if (holdsFile) {
      const name = PathUtils.filename(holdsFile);
      found.push({ dir, extension: name.slice(name.lastIndexOf(".")) });
    }
  };
  await walk(root);
  return found;
}

add_task(async function a_folder_over_the_step_limit_is_too_large_to_sync() {
  // The engine names the helper's reason for an unreachable step only at
  // Debug (`SvalEngine`, `#unreachable`), and that reason is what a failure
  // of this task needs to show.
  Services.prefs.setStringPref("browser.sval.loglevel", "Debug");
  registerCleanupFunction(() =>
    Services.prefs.clearUserPref("browser.sval.loglevel")
  );
  const { shared, make } = await device("step-cap");
  const engine = make();
  await engine.addDocument("step-cap-a");
  await engine.addDocument("step-cap-b");
  Assert.equal((await engine.sync(WORKSPACE, 1000)).shared, "reached");

  const dirs = await documentDirs(PathUtils.join(shared, TOP_DIR));
  Assert.equal(dirs.length, 3, "each document has its directory");
  const filler = new Uint8Array(MAX_FILE_BYTES);
  const planted = [];
  for (const { dir, extension } of dirs) {
    for (let i = 0; i < PLANTED; i++) {
      const path = PathUtils.join(dir, `${"f".repeat(31)}${i}${extension}`);
      await IOUtils.write(path, filler);
      planted.push(path);
    }
  }
  Assert.greater(
    dirs.length * PLANTED * MAX_FILE_BYTES,
    MAX_STEP_BYTES,
    "the folder holds more than one step reads"
  );

  const over = await engine.sync(WORKSPACE, 2000);
  Assert.equal(over.shared, "too-large");
  Assert.equal(over.sharedReason, "too-large", "named as too large");
  const shown = indicatorFor(over, 2000);
  Assert.deepEqual(
    [shown.severity, shown.state],
    ["error", "too-large"],
    "the indicator says sync stopped on a folder too large"
  );

  // One planted file fewer in each directory is under the limit.
  for (let i = 0; i < dirs.length; i++) {
    await IOUtils.remove(planted[i * PLANTED]);
  }
  const under = await engine.sync(WORKSPACE, 3000);
  Assert.equal(under.shared, "reached", "a folder under the limit syncs");
  Assert.equal(
    indicatorFor(under, 3000).severity,
    "synced",
    "and the indicator is back to synced"
  );
});
