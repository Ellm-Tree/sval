/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */

/**
 * The helper process that alone touches the shared folder, and the module
 * that supervises it (local-copy spec §3, §4.2, decision 1437): what a helper
 * answers for an ordinary folder, and how long one lives. The helper's own
 * rules, paths, links and caps among them, are tested in its crate
 * (`tools/sval-folder`).
 */

function decode(data) {
  return Array.from(
    new Uint8Array(ChromeUtils.base64URLDecode(data, { padding: "require" }))
  );
}

/**
 * A write removes the temporary files a killed helper left beside this
 * device's file once they are stale, and nothing else: not a recent one,
 * which a helper may still be writing, and not one named for another file.
 */
add_task(async function a_write_sweeps_its_own_stale_temporary_files() {
  const root = await makeTempDir("sval-temporaries");
  const dir = PathUtils.join(root, "sval", "ws", "abc");
  await IOUtils.makeDirectory(dir);
  const stale = "me.json.0123456789abcdef.tmp";
  const recent = "me.json.fedcba9876543210.tmp";
  const peers = "peer.json.0123456789abcdef.tmp";
  const unlike = "me.json.tmp";
  for (const name of [stale, recent, peers, unlike]) {
    await IOUtils.writeUTF8(PathUtils.join(dir, name), "half-written");
  }
  const hourAgo = Date.now() - 60 * 60 * 1000;
  for (const name of [stale, peers, unlike]) {
    await IOUtils.setModificationTime(PathUtils.join(dir, name), hourAgo);
  }

  Assert.deepEqual(
    await SvalSharedFolder.writeFile({
      root,
      path: "sval/ws/abc/me.json",
      bytes: new Uint8Array([7]),
      requireTop: null,
      deadline: deadline(),
    }),
    { reachable: true },
    "the write goes through"
  );
  Assert.deepEqual(
    (await IOUtils.getChildren(dir))
      .map(child => PathUtils.filename(child))
      .sort(),
    ["me.json", recent, unlike, peers].sort(),
    "and only this file's stale temporary file is gone"
  );
});

add_task(async function a_file_written_through_the_helper_reads_back() {
  const root = await makeTempDir("sval-round-trip");
  const bytes = new Uint8Array([1, 2, 3, 250]);
  Assert.deepEqual(
    await SvalSharedFolder.writeFile({
      root,
      path: "sval/ws/abc/me.json",
      bytes,
      requireTop: null,
      deadline: deadline(),
    }),
    { reachable: true },
    "first use creates sval/ and writes the file"
  );
  const onDisk = PathUtils.join(root, "sval", "ws", "abc", "me.json");
  Assert.deepEqual(
    Array.from(await IOUtils.read(onDisk)),
    Array.from(bytes),
    "with the bytes intact"
  );
  Assert.deepEqual(
    (await IOUtils.getChildren(PathUtils.parent(onDisk))).map(child =>
      PathUtils.filename(child)
    ),
    ["me.json"],
    "and no temp file left"
  );

  await IOUtils.writeUTF8(
    PathUtils.join(root, "sval", "ws", "abc", "peer.json.tmp"),
    "half-written"
  );
  const read = await SvalSharedFolder.readDir({
    root,
    path: "sval/ws/abc",
    suffix: ".json",
    mine: "me.json",
    requireTop: "sval",
    deadline: deadline(),
  });
  Assert.equal(read.reachable, true, "the folder answered");
  Assert.deepEqual(
    read.entries.map(entry => entry.name),
    ["me.json"],
    "a leftover .tmp is not a candidate"
  );
  Assert.deepEqual(decode(read.entries[0].data), Array.from(bytes));
  Assert.deepEqual(read.unreadable, []);

  const where = { root, path: "sval/ws/abc/me.json" };
  Assert.deepEqual(
    await SvalSharedFolder.exists({ ...where, deadline: deadline() }),
    { reachable: true, exists: true }
  );
  Assert.deepEqual(
    await SvalSharedFolder.remove({ ...where, deadline: deadline() }),
    { reachable: true }
  );
  Assert.deepEqual(
    await SvalSharedFolder.exists({ ...where, deadline: deadline() }),
    { reachable: true, exists: false },
    "and removing it removed it"
  );
});

/**
 * `listNames` answers with the names in a directory and reads none of them,
 * which is all a device needs to see that a folder holds another sync key's
 * workspaces.
 */
add_task(async function list_names_names_a_directory_and_reads_nothing() {
  const root = await makeTempDir("sval-names");
  Assert.deepEqual(
    await SvalSharedFolder.listNames({
      root,
      path: "sval/ws",
      deadline: deadline(),
    }),
    { reachable: true, names: [] },
    "an absent directory has no names"
  );
  for (const name of ["bbb", "aaa"]) {
    await IOUtils.makeDirectory(PathUtils.join(root, "sval", "ws", name));
  }
  Assert.deepEqual(
    await SvalSharedFolder.listNames({
      root,
      path: "sval/ws",
      deadline: deadline(),
    }),
    { reachable: true, names: ["aaa", "bbb"] },
    "and a present one has its children's names, sorted"
  );
});

/**
 * One helper writes several files and reads several directories back, and
 * each name read comes with its own file's bytes, whatever order the helper
 * read them in and whatever the names are.
 */
add_task(async function one_helper_writes_and_reads_many_files() {
  const root = await makeTempDir("sval-batch");
  await IOUtils.makeDirectory(PathUtils.join(root, "sval"));
  const written = {
    "sval/ws/one/a.json": new Uint8Array([1]),
    // This device's own file, which the helper reads first and lists in
    // name order.
    "sval/ws/one/z-mine.json": new Uint8Array([2, 2]),
    "sval/ws/two/b.json": new Uint8Array([3, 3, 3]),
  };
  Assert.deepEqual(
    await SvalSharedFolder.writeFiles({
      root,
      files: Object.entries(written).map(([path, bytes]) => ({ path, bytes })),
      requireTop: "sval",
      deadline: deadline(),
    }),
    { reachable: true },
    "every file was written"
  );
  if (AppConstants.platform !== "win") {
    // A name a cloud client or another system may give a file, which Sval
    // never writes itself.
    const odd = new Uint8Array([4, 4, 4, 4]);
    await IOUtils.write(
      PathUtils.join(root, "sval", "ws", "one", "m:c.json"),
      odd
    );
    written["sval/ws/one/m:c.json"] = odd;
  }

  const read = await SvalSharedFolder.readDirs({
    root,
    dirs: [
      { path: "sval/ws/one", suffix: ".json", mine: "z-mine.json" },
      { path: "sval/ws/two", suffix: ".json", mine: "z-mine.json" },
    ],
    requireTop: "sval",
    deadline: deadline(),
    consume: async ({ dirs }) => {
      const found = {};
      for (const [index, dir] of ["one", "two"].entries()) {
        for (const entry of dirs[index].entries) {
          found[`sval/ws/${dir}/${entry.name}`] = Array.from(
            await IOUtils.read(entry.file)
          );
        }
      }
      return { reachable: true, found };
    },
  });
  Assert.equal(read.reachable, true, "the folder answered");
  Assert.deepEqual(
    read.found,
    Object.fromEntries(
      Object.entries(written).map(([path, bytes]) => [path, Array.from(bytes)])
    ),
    "each name came with its own bytes"
  );
  Assert.ok(
    !(await IOUtils.getChildren(requestDir(), { ignoreAbsent: true })).some(
      path => PathUtils.filename(path).startsWith("files-")
    ),
    "and the copies went with the request"
  );
});

/**
 * Counts the helpers started while `run` runs, each with its exit.
 *
 * @param {Function} run
 * @returns {Promise<object[]>} The helpers, as `SvalSharedFolder` keeps them.
 */
async function helpersStartedBy(run) {
  const started = [];
  const realStart = SvalSharedFolder._start;
  SvalSharedFolder._start = async function (...args) {
    const helper = await realStart.apply(this, args);
    started.push(helper);
    return helper;
  };
  try {
    await run();
  } finally {
    SvalSharedFolder._start = realStart;
  }
  return started;
}

/**
 * The requests of one burst share a helper (decision 1437): starting one is
 * most of what a request costs.
 */
add_task(async function a_burst_of_requests_shares_one_helper() {
  const root = await makeTempDir("sval-burst");
  await IOUtils.makeDirectory(PathUtils.join(root, "sval"));
  const answers = [];
  const started = await helpersStartedBy(async () => {
    for (let i = 0; i < 10; i++) {
      answers.push(
        await SvalSharedFolder.writeFile({
          root,
          path: `sval/ws/abc/file-${i}.json`,
          bytes: new Uint8Array([i]),
          requireTop: "sval",
          deadline: deadline(),
        })
      );
    }
  });
  Assert.ok(
    answers.every(answer => answer.reachable),
    "each was answered"
  );
  Assert.lessOrEqual(started.length, 1, "by one helper at most");
  for (let i = 0; i < 10; i++) {
    Assert.deepEqual(
      await IOUtils.read(
        PathUtils.join(root, "sval", "ws", "abc", `file-${i}.json`)
      ),
      new Uint8Array([i]),
      `file ${i} holds its own bytes`
    );
  }
});

/**
 * One helper lives between requests and goes when it
 * is released, as it is when the user clears the shared folder: its stdin
 * closes and it exits. The next request starts another.
 */
add_task(async function a_helper_lives_between_requests_until_released() {
  const root = await makeTempDir("sval-lives");
  await IOUtils.makeDirectory(PathUtils.join(root, "sval"));
  const ask = () =>
    SvalSharedFolder.exists({ root, path: "sval", deadline: deadline() });
  const [first] = await helpersStartedBy(async () => {
    await SvalSharedFolder.release();
    await SvalSharedFolder._whenIdle();
    Assert.deepEqual(await ask(), { reachable: true, exists: true });
  });
  Assert.ok(first, "the first request started a helper");
  const later = await helpersStartedBy(ask);
  Assert.equal(later.length, 0, "a request later reuses it");
  Assert.ok(first.alive, "which waited for it");

  await SvalSharedFolder.release();
  Assert.equal(
    await within(first.exited, 10_000, "the released helper exiting"),
    0,
    "a released helper exits on the end of its stdin"
  );
  Assert.ok(!SvalSharedFolder.busy, "and nothing is left busy");
  const again = await helpersStartedBy(async () => {
    Assert.deepEqual(await ask(), { reachable: true, exists: true });
  });
  Assert.equal(again.length, 1, "the next request started another");
});

/** A tree that never staged the helper fails each request, saying so. */
add_task(async function a_missing_helper_fails_the_request() {
  const root = await makeTempDir("sval-missing-helper");
  await SvalSharedFolder.release();
  await SvalSharedFolder._whenIdle();
  SvalSharedFolder._helperCommand = () => ({
    command: tempPath("sval-no-such-helper"),
    arguments: [],
  });
  try {
    Assert.deepEqual(
      await SvalSharedFolder.exists({
        root,
        path: "sval",
        deadline: deadline(),
      }),
      { reachable: false, reason: "helper-failed", error: "HelperMissing" }
    );
  } finally {
    SvalSharedFolder._helperCommand = null;
  }
});

/**
 * A helper that exits before it answers fails the request, and no other is
 * started for it. The next request starts a helper of its own.
 */
add_task(
  { skip_if: noFifo },
  async function a_helper_that_exits_unanswered_fails_its_request() {
    const root = await makeTempDir("sval-exits");
    await IOUtils.makeDirectory(PathUtils.join(root, "sval"));
    await SvalSharedFolder.release();
    await SvalSharedFolder._whenIdle();
    SvalSharedFolder._helperCommand = () => ({
      command: "/bin/sh",
      arguments: ["-c", "exit 3"],
    });
    let started;
    try {
      started = await helpersStartedBy(async () => {
        Assert.deepEqual(
          reasonOf(
            await SvalSharedFolder.exists({
              root,
              path: "sval",
              deadline: deadline(),
            })
          ),
          { reachable: false, reason: "helper-failed" }
        );
      });
    } finally {
      SvalSharedFolder._helperCommand = null;
    }
    Assert.equal(started.length, 1, "after one helper");
    Assert.deepEqual(
      await SvalSharedFolder.exists({
        root,
        path: "sval",
        deadline: deadline(),
      }),
      { reachable: true, exists: true },
      "and the next request reaches the folder"
    );
  }
);
