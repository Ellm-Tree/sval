/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */

/**
 * The shared-folder helper (local-copy spec §4.2) never leaves the folder
 * through a path: a path that climbs out, and a root that is not absolute,
 * are refused.
 */

add_task(async function a_path_that_could_leave_the_folder_is_refused() {
  const root = await makeTempDir("sval-contained");
  const sibling = PathUtils.join(PathUtils.parent(root), "sval-escaped");
  registerCleanupFunction(() =>
    IOUtils.remove(sibling, { recursive: true, ignoreAbsent: true })
  );
  const refused = { reachable: false, reason: "io-error" };
  for (const path of [
    "../sval-escaped/me.json",
    "sval/../../sval-escaped/me.json",
    "sval/./me.json",
    "sval//me.json",
    "/etc/me.json",
    "C:/sval-escaped/me.json",
    "sval/a:b.json",
    "sval\\me.json",
    "sval/me\0.json",
    "",
  ]) {
    Assert.deepEqual(
      reasonOf(
        await SvalSharedFolder.writeFile({
          root,
          path,
          bytes: new Uint8Array([1]),
          requireTop: null,
          deadline: deadline(),
        })
      ),
      refused,
      `a write to ${JSON.stringify(path)} is refused`
    );
  }
  Assert.ok(!(await IOUtils.exists(sibling)), "and nothing left the folder");
  Assert.deepEqual(
    reasonOf(
      await SvalSharedFolder.remove({
        root,
        path: "..",
        deadline: deadline(),
      })
    ),
    refused,
    "a removal of .. is refused"
  );
  Assert.deepEqual(
    reasonOf(
      await SvalSharedFolder.exists({
        root: "relative/folder",
        path: "sval",
        deadline: deadline(),
      })
    ),
    refused,
    "a root that is not absolute is refused"
  );
  Assert.deepEqual(
    await SvalSharedFolder.exists({
      root,
      path: "sval",
      deadline: deadline(),
    }),
    { reachable: true, exists: false },
    "an ordinary path still works"
  );
});
