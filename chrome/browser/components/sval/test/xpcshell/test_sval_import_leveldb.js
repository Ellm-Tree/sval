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

add_task(async function a_key_sharing_more_than_the_one_before_is_refused() {
  // One uncompressed data block whose only entry claims four bytes of a
  // previous key that does not exist, then its index block and the footer.
  const trailer = [0, 0, 0, 0, 0];
  const restarts = [0, 0, 0, 0];
  const internal = [...new TextEncoder().encode("k-z"), 1, 1, 0, 0, 0, 0, 0, 0];
  const data = [4, internal.length, 1, ...internal, 0x76, ...restarts];
  const handle = [0, data.length];
  const index = [0, 1, handle.length, 0x7a, ...handle, ...restarts];
  const indexAt = data.length + trailer.length;
  const footer = new Uint8Array(48);
  footer.set([0, 0, indexAt, index.length]);
  footer.set([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb], 40);
  const dir = await makeTempDir("sval-leveldb-shared");
  await IOUtils.write(
    PathUtils.join(dir, "000005.ldb"),
    new Uint8Array([...data, ...trailer, ...index, ...trailer, ...footer])
  );
  Assert.equal((await readLevelDB(dir, "")).size, 0);
});
