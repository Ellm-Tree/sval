/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */

/**
 * What the shared-folder helper (local-copy spec §4.2, §4.3) answers when the
 * folder cannot be used: a root that is missing or is a file, a used folder
 * whose sval/ directory is gone, and a write whose temporary name is taken.
 */

add_task(async function a_missing_root_is_unreachable() {
  Assert.deepEqual(
    await SvalSharedFolder.readDir({
      root: missingFolder("gone"),
      path: "sval/ws/abc",
      suffix: ".json",
      mine: "me.json",
      requireTop: null,
      deadline: deadline(),
    }),
    { reachable: false, reason: "missing", error: "NotFoundError" },
    "and the helper's error name comes with the reason"
  );
});

/** Spec §4.3. */
add_task(async function a_root_that_is_a_file_is_unreachable_and_untouched() {
  const notAFolder = tempPath("sval-helper-not-a-folder");
  await IOUtils.writeUTF8(notAFolder, "a file");
  Assert.deepEqual(
    reasonOf(
      await SvalSharedFolder.writeFile({
        root: notAFolder,
        path: "sval/ws/abc/me.json",
        bytes: new Uint8Array([1]),
        requireTop: null,
        deadline: deadline(),
      })
    ),
    { reachable: false, reason: "not-a-directory" }
  );
  Assert.equal(await IOUtils.readUTF8(notAFolder), "a file", "untouched");
});

/** Spec §6 test 5, the helper half. */
add_task(
  async function a_chosen_folder_without_sval_is_unreachable_and_untouched() {
    const root = await makeTempDir("sval-unmounted");
    Assert.deepEqual(
      reasonOf(
        await SvalSharedFolder.writeFile({
          root,
          path: "sval/ws/abc/me.json",
          bytes: new Uint8Array([1]),
          requireTop: "sval",
          deadline: deadline(),
        })
      ),
      { reachable: false, reason: "no-sval-dir" }
    );
    Assert.ok(
      !(await IOUtils.exists(PathUtils.join(root, "sval"))),
      "and the helper created nothing"
    );
  }
);

add_task(async function marking_makes_sval_only_in_a_folder_that_is_there() {
  const gone = missingFolder("mark");
  Assert.deepEqual(
    reasonOf(
      await SvalSharedFolder.makeDir({
        root: gone,
        path: "sval",
        deadline: deadline(),
      })
    ),
    { reachable: false, reason: "missing" }
  );
  Assert.ok(!(await IOUtils.exists(gone)), "a missing folder is not made");

  const notAFolder = tempPath("sval-helper-mark-file");
  await IOUtils.writeUTF8(notAFolder, "a file");
  Assert.deepEqual(
    reasonOf(
      await SvalSharedFolder.makeDir({
        root: notAFolder,
        path: "sval",
        deadline: deadline(),
      })
    ),
    { reachable: false, reason: "not-a-directory" }
  );

  const root = await makeTempDir("sval-mark");
  for (const time of ["first", "second"]) {
    Assert.deepEqual(
      await SvalSharedFolder.makeDir({
        root,
        path: "sval",
        deadline: deadline(),
      }),
      { reachable: true },
      `the ${time} mark answers`
    );
  }
  Assert.deepEqual(
    (await IOUtils.getChildren(root)).map(PathUtils.filename),
    ["sval"],
    "and makes sval/ alone"
  );
});

/**
 * Something planted where a fixed temporary name would go cannot block this
 * device's writes: the temporary file's name is random.
 */
add_task(async function a_planted_temp_directory_does_not_block_the_write() {
  const root = await makeTempDir("sval-planted-temp");
  const dir = PathUtils.join(root, "sval", "ws", "abc");
  const planted = PathUtils.join(dir, "me.json.tmp");
  await IOUtils.makeDirectory(planted);
  await IOUtils.writeUTF8(PathUtils.join(planted, "keep.txt"), "keep");
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
    Array.from(await IOUtils.read(PathUtils.join(dir, "me.json"))),
    [7],
    "with its bytes"
  );
  Assert.equal(
    await IOUtils.readUTF8(PathUtils.join(planted, "keep.txt")),
    "keep",
    "and what was planted is left alone"
  );
  Assert.deepEqual(
    (await IOUtils.getChildren(dir))
      .map(child => PathUtils.filename(child))
      .sort(),
    ["me.json", "me.json.tmp"],
    "and no temporary file of its own is left"
  );
});
