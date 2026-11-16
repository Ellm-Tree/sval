/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */

const { MAX_FILE_BYTES, MAX_ENTRIES } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
);

/**
 * What the shared-folder helper (local-copy spec §3, §4.2) answers for files
 * it will not return: one that will not read, one over the size cap, and a
 * directory with more entries than it lists.
 */

add_task(async function an_own_file_that_does_not_read_for_now_is_an_outage() {
  const root = await makeTempDir("sval-own-denied");
  const dir = PathUtils.join(root, "sval", "ws", "abc");
  await IOUtils.makeDirectory(dir);
  const mine = PathUtils.join(dir, "me.json");
  await IOUtils.writeUTF8(mine, "mine");
  await IOUtils.writeUTF8(PathUtils.join(dir, "peer.json"), "peer");
  await SvalTestDeny.read(mine);
  try {
    const read = await SvalSharedFolder.readDir({
      root,
      path: "sval/ws/abc",
      suffix: ".json",
      mine: "me.json",
      requireTop: "sval",
      deadline: deadline(),
    });
    Assert.deepEqual(
      { reachable: read.reachable, reason: read.reason },
      { reachable: false, reason: "own-file-unreadable" },
      "never read as an absence, which the engine would overwrite"
    );
  } finally {
    await SvalTestDeny.allow(mine);
  }
});

add_task(async function an_own_entry_that_is_a_directory_is_listed_first() {
  const root = await makeTempDir("sval-own");
  const dir = PathUtils.join(root, "sval", "ws", "abc");
  // A directory where this device's file should be: it stays one until
  // someone removes it.
  await IOUtils.makeDirectory(PathUtils.join(dir, "me.json"));
  await IOUtils.writeUTF8(PathUtils.join(dir, "peer.json"), "peer");
  const read = await SvalSharedFolder.readDir({
    root,
    path: "sval/ws/abc",
    suffix: ".json",
    mine: "me.json",
    requireTop: "sval",
    deadline: deadline(),
  });
  Assert.equal(read.reachable, true, "the peers still read");
  Assert.deepEqual(
    read.entries.map(entry => entry.name),
    ["peer.json"]
  );
  Assert.deepEqual(read.unreadable, [
    { name: "me.json", reason: "IsDirectory" },
  ]);
});

add_task(async function a_peer_file_that_will_not_read_is_listed_and_skipped() {
  const root = await makeTempDir("sval-peer");
  const dir = PathUtils.join(root, "sval", "ws", "abc");
  await IOUtils.makeDirectory(PathUtils.join(dir, "other.json"));
  await IOUtils.writeUTF8(PathUtils.join(dir, "peer.json"), "peer");
  const read = await SvalSharedFolder.readDir({
    root,
    path: "sval/ws/abc",
    suffix: ".json",
    mine: "me.json",
    requireTop: "sval",
    deadline: deadline(),
  });
  Assert.equal(read.reachable, true, "one bad peer is not an outage");
  Assert.deepEqual(
    read.entries.map(entry => entry.name),
    ["peer.json"]
  );
  Assert.equal(read.unreadable.length, 1);
  Assert.equal(read.unreadable[0].name, "other.json");
});

add_task(async function a_file_over_the_cap_is_listed_and_never_returned() {
  const root = await makeTempDir("sval-big");
  const dir = PathUtils.join(root, "sval", "ws", "abc");
  await IOUtils.makeDirectory(dir);
  await IOUtils.writeUTF8(PathUtils.join(dir, "peer.json"), "peer");
  const big = PathUtils.join(dir, "big.json");
  await IOUtils.write(big, new Uint8Array(MAX_FILE_BYTES + 1));
  const where = {
    root,
    path: "sval/ws/abc",
    suffix: ".json",
    mine: "me.json",
    requireTop: "sval",
    deadline: deadline(),
  };
  const read = await SvalSharedFolder.readDir(where);
  Assert.equal(read.reachable, true);
  Assert.deepEqual(
    read.entries.map(entry => entry.name),
    ["peer.json"]
  );
  Assert.deepEqual(read.unreadable, [{ name: "big.json", reason: "TooLarge" }]);
  Assert.less(JSON.stringify(read).length, 1000, "and the answer stays small");

  // This device's own file over the cap is listed the same way.
  await IOUtils.move(big, PathUtils.join(dir, "me.json"));
  const own = await SvalSharedFolder.readDir(where);
  Assert.deepEqual(
    own.entries.map(entry => entry.name),
    ["peer.json"]
  );
  Assert.deepEqual(own.unreadable, [{ name: "me.json", reason: "TooLarge" }]);
  Assert.deepEqual(
    reasonOf(
      await SvalSharedFolder.writeFile({
        root,
        path: "sval/ws/abc/other.json",
        bytes: new Uint8Array(MAX_FILE_BYTES + 1),
        requireTop: "sval",
        deadline: deadline(),
      })
    ),
    { reachable: false, reason: "io-error" },
    "and a write no reader would accept is refused"
  );
  Assert.ok(!(await IOUtils.exists(PathUtils.join(dir, "other.json"))));
});

/**
 * A directory of small files, such as the sealed key copies and pairing
 * offers, is read with a cap of its own: a file planted there far over it is
 * listed without being read, so the answer stays as small as the files the
 * directory is for.
 */
add_task(async function a_listing_with_its_own_cap_never_reads_past_it() {
  const root = await makeTempDir("sval-capped");
  const dir = PathUtils.join(root, "sval", "keys");
  await IOUtils.makeDirectory(dir);
  await IOUtils.writeUTF8(PathUtils.join(dir, "peer.key"), "sealed");
  await IOUtils.write(
    PathUtils.join(dir, "planted.key"),
    new Uint8Array(1024 * 1024)
  );
  const read = await SvalSharedFolder.readDir({
    root,
    path: "sval/keys",
    suffix: ".key",
    mine: "me.key",
    maxBytes: 4096,
    requireTop: null,
    deadline: deadline(),
  });
  Assert.equal(read.reachable, true);
  Assert.deepEqual(
    read.entries.map(entry => entry.name),
    ["peer.key"],
    "the small file is read"
  );
  Assert.deepEqual(
    read.unreadable,
    [{ name: "planted.key", reason: "TooLarge" }],
    "and the planted one is listed as too large"
  );
  Assert.less(JSON.stringify(read).length, 1000, "so the answer stays small");
});

add_task(async function entries_past_the_limit_are_listed_not_returned() {
  const root = await makeTempDir("sval-many");
  const dir = PathUtils.join(root, "sval", "ws", "abc");
  await IOUtils.makeDirectory(dir);
  // Two past the limit, and this device's own file besides.
  const peers = MAX_ENTRIES + 2;
  for (let i = 0; i < peers; i++) {
    await IOUtils.writeUTF8(
      PathUtils.join(dir, `f${String(i).padStart(4, "0")}.json`),
      "x"
    );
  }
  // Sorts last, and is still read: this device's file is never starved.
  await IOUtils.writeUTF8(PathUtils.join(dir, "zz-me.json"), "me");
  const read = await SvalSharedFolder.readDir({
    root,
    path: "sval/ws/abc",
    suffix: ".json",
    mine: "zz-me.json",
    requireTop: "sval",
    deadline: deadline(),
  });
  Assert.equal(read.reachable, true);
  Assert.equal(
    read.entries.length,
    MAX_ENTRIES,
    `at most ${MAX_ENTRIES} are returned`
  );
  Assert.ok(
    read.entries.some(entry => entry.name == "zz-me.json"),
    "this device's own file among them"
  );
  Assert.deepEqual(
    read.entries.map(entry => entry.name),
    read.entries.map(entry => entry.name).sort(),
    "in name order"
  );
  Assert.equal(
    read.unreadable.length,
    peers + 1 - MAX_ENTRIES,
    "and the rest are listed"
  );
  Assert.equal(read.unreadable[0].reason, "TooManyEntries");
});
