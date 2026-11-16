/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { readLevelDB } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImportLevelDB.sys.mjs"
);
const { makeTempDir, tempPath } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

/**
 * data/import/leveldb was written by LevelDB 1.23 with Snappy compression:
 * k-a set to "old", k-b to "gone", k-b deleted, k-a set to "kept", k-c to a
 * long repetitive text and other-x to "unrelated", then compacted into a
 * table; then k-d set to "logged" and k-e, never set, deleted, in the log.
 */
const FIXTURE = do_get_file("data/import/leveldb").path;
const LONG = "the quick brown fox jumps over the lazy dog ".repeat(40).trim();

const text = map =>
  Object.fromEntries(
    [...map].map(([key, value]) => [key, new TextDecoder().decode(value)])
  );

add_task(async function the_newest_record_of_each_key_is_its_value() {
  Assert.deepEqual(text(await readLevelDB(FIXTURE, "k-")), {
    "k-a": "kept",
    "k-c": LONG,
    "k-d": "logged",
  });
});

add_task(async function a_missing_database_is_empty() {
  Assert.equal(
    (await readLevelDB(tempPath("sval-leveldb-absent"), "k-")).size,
    0
  );
});

add_task(async function a_damaged_table_costs_only_its_own_records() {
  const dir = await makeTempDir("sval-leveldb-damaged");
  for (const path of await IOUtils.getChildren(FIXTURE)) {
    const name = PathUtils.filename(path);
    const bytes = await IOUtils.read(path);
    await IOUtils.write(
      PathUtils.join(dir, name),
      name.endsWith(".ldb") ? bytes.subarray(0, bytes.length - 20) : bytes
    );
  }
  Assert.deepEqual(text(await readLevelDB(dir, "k-")), { "k-d": "logged" });
});
