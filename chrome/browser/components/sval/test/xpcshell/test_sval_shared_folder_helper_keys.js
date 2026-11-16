/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */

/**
 * Another sync key's directories in the shared folder, through the helper
 * (local-copy spec §4.2): an engine names them, and starting over removes the
 * old key's and follows no link while it does.
 */

/**
 * An engine names the directories in the folder that are not its own: every
 * one, for a device with no sync key, and another key's, for one with a key.
 */
add_task(async function an_engine_names_another_keys_workspaces() {
  const shared = await chosenFolder("others-shared");
  const theirs = new SvalEngine({
    root: await makeTempDir("sval-others-theirs"),
    sharedRoot: shared,
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  const ours = new SvalEngine({
    root: await makeTempDir("sval-others-ours"),
    sharedRoot: shared,
    localKey: crypto.getRandomValues(new Uint8Array(32)),
    syncKey: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  const keyless = new SvalEngine({
    root: await makeTempDir("sval-others-keyless"),
    localKey: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  registerCleanupFunction(() => {
    for (const engine of [theirs, ours, keyless]) {
      engine.terminate();
    }
  });
  await theirs.mutate({ kind: "addWorkspace", name: "Theirs", now: 1000 });
  await theirs.sync(WORKSPACE, 1000);

  Assert.deepEqual(
    await keyless.otherWorkspaces(shared),
    (
      await SvalSharedFolder.listNames({
        root: shared,
        path: "sval/ws",
        deadline: deadline(),
      })
    ).names,
    "a device with no key owns nothing in the folder"
  );

  await ours.mutate({ kind: "addWorkspace", name: "Ours", now: 2000 });
  await ours.sync(WORKSPACE, 2000);
  const others = await ours.otherWorkspaces();
  Assert.equal(others.length, 1, "one directory is another key's");
  Assert.deepEqual(
    others,
    await keyless
      .otherWorkspaces(shared)
      .then(all => all.filter(name => others.includes(name))),
    "and it is theirs"
  );
  Assert.equal(
    await theirs.otherWorkspaces().then(list => list.length),
    1,
    "from their side, ours is the other one"
  );
});

/**
 * The first launch after setting up a new folder: the device published its
 * workspaces and a document it has since let go of, such as a history week,
 * and a fresh engine has loaded only the tree. None of what it published is
 * another device's, so the panel offers nothing; another key's workspaces
 * still are.
 */
add_task(async function a_devices_own_documents_are_never_another_devices() {
  const shared = await chosenFolder("own-shared");
  const identity = {
    root: await makeTempDir("sval-own-local"),
    sharedRoot: shared,
    localKey: crypto.getRandomValues(new Uint8Array(32)),
    syncKey: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  };
  const first = new SvalEngine(identity);
  registerCleanupFunction(() => first.terminate());
  const WEEK = "history-2026-W40";
  await first.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
  await first.openDocument(WEEK, () => {});
  await first.mutate({
    kind: "addVisit",
    document: WEEK,
    url: "https://visited.example/",
    title: "",
    transition: 1,
    visitedAt: 1000,
    now: 1000,
  });
  await first.sync(WORKSPACE, 1000);
  await first.removeDocument(WEEK);
  const published = (
    await SvalSharedFolder.listNames({
      root: shared,
      path: "sval/ws",
      deadline: deadline(),
    })
  ).names;
  Assert.equal(published.length, 2, "the tree and the week reached the folder");
  Assert.deepEqual(
    await first.otherWorkspaces(),
    [],
    "a week let go of is still this device's"
  );
  first.terminate();

  const relaunched = new SvalEngine(identity);
  registerCleanupFunction(() => relaunched.terminate());
  await relaunched.sync(WORKSPACE, 2000);
  Assert.deepEqual(
    await relaunched.otherWorkspaces(),
    [],
    "after a restart, nothing this device published is another device's"
  );

  const theirs = new SvalEngine({
    root: await makeTempDir("sval-own-theirs"),
    sharedRoot: shared,
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  registerCleanupFunction(() => theirs.terminate());
  await theirs.mutate({ kind: "addWorkspace", name: "Theirs", now: 3000 });
  await theirs.sync(WORKSPACE, 3000);
  const others = await relaunched.otherWorkspaces();
  Assert.equal(others.length, 1, "another key's workspaces are still found");
  Assert.ok(!published.includes(others[0]), "and they are theirs");
});

/**
 * Starting over removes the old key's directories and nothing else, and a
 * typed key is checked against the folder before it is used.
 */
add_task(async function an_old_keys_directory_is_removed_and_a_key_checked() {
  const shared = await chosenFolder("start-over-shared");
  const oldKey = crypto.getRandomValues(new Uint8Array(32));
  const engine = new SvalEngine({
    root: await makeTempDir("sval-start-over-local"),
    sharedRoot: shared,
    localKey: crypto.getRandomValues(new Uint8Array(32)),
    syncKey: oldKey,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  const other = new SvalEngine({
    root: await makeTempDir("sval-start-over-other"),
    sharedRoot: shared,
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  registerCleanupFunction(() => {
    engine.terminate();
    other.terminate();
  });
  await engine.mutate({ kind: "addWorkspace", name: "Ours", now: 1000 });
  await engine.sync(WORKSPACE, 1000);
  await other.mutate({ kind: "addWorkspace", name: "Theirs", now: 1000 });
  await other.sync(WORKSPACE, 1000);

  Assert.equal(
    await engine.opensWorkspacesHere(oldKey, WORKSPACE),
    true,
    "the key in use opens what is here"
  );
  Assert.equal(
    await engine.opensWorkspacesHere(
      crypto.getRandomValues(new Uint8Array(32)),
      WORKSPACE
    ),
    false,
    "a key that names nothing here does not"
  );

  const before = (
    await SvalSharedFolder.listNames({
      root: shared,
      path: "sval/ws",
      deadline: deadline(),
    })
  ).names;
  Assert.equal(before.length, 2, "two keys' directories to begin with");
  const dirs = await engine.workspaceDirsOf(oldKey);
  Assert.deepEqual(
    await engine.removeWorkspaceDirs(dirs),
    [],
    "the old key's went"
  );
  const after = (
    await SvalSharedFolder.listNames({
      root: shared,
      path: "sval/ws",
      deadline: deadline(),
    })
  ).names;
  Assert.equal(after.length, 1, "and only that one");
  Assert.deepEqual(
    after,
    await engine.otherWorkspaces(),
    "the one left is the other key's"
  );
});

/**
 * Removing an old key's directory removes only files: a link inside goes as a
 * link, and what it points at, and any directory inside, stay.
 */
add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function removing_a_keys_directory_follows_no_link() {
    const root = await makeTempDir("sval-remove-links");
    const outside = await makeTempDir("sval-remove-links-outside");
    await IOUtils.writeUTF8(PathUtils.join(outside, "keep.txt"), "mine");
    const dir = PathUtils.join(root, "sval", "ws", "old");
    await IOUtils.makeDirectory(PathUtils.join(dir, "nested"));
    await IOUtils.writeUTF8(PathUtils.join(dir, "device.json"), "{}");
    const { ctypes } = ChromeUtils.importESModule(
      "resource://gre/modules/ctypes.sys.mjs"
    );
    const libc = ctypes.open(
      AppConstants.platform == "macosx" ? "libc.dylib" : "libc.so.6"
    );
    const symlink = libc.declare(
      "symlink",
      ctypes.default_abi,
      ctypes.int,
      ctypes.char.ptr,
      ctypes.char.ptr
    );
    symlink(outside, PathUtils.join(dir, "elsewhere"));
    libc.close();

    const answer = await SvalSharedFolder.removeDir({
      root,
      path: "sval/ws/old",
      deadline: deadline(),
    });
    Assert.deepEqual(
      answer,
      { reachable: true, removed: false },
      "a directory inside keeps the old one"
    );
    Assert.ok(
      !(await IOUtils.exists(PathUtils.join(dir, "device.json"))),
      "the file went"
    );
    Assert.ok(
      await IOUtils.exists(PathUtils.join(outside, "keep.txt")),
      "what the link pointed at is untouched"
    );
    Assert.ok(
      await IOUtils.exists(PathUtils.join(dir, "nested")),
      "and the directory inside stays"
    );
  }
);

add_task(async function a_folder_without_sval_says_nothing_about_a_key() {
  // What an unmounted mount point looks like: an empty local directory.
  const unmounted = await makeTempDir("sval-key-unmounted");
  const engine = new SvalEngine({
    root: await makeTempDir("sval-key-unmounted-local"),
    sharedRoot: unmounted,
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  registerCleanupFunction(() => engine.terminate());
  Assert.equal(
    await engine.opensWorkspacesHere(
      crypto.getRandomValues(new Uint8Array(32)),
      WORKSPACE
    ),
    null,
    "the folder did not answer"
  );
  Assert.ok(
    !(await IOUtils.exists(PathUtils.join(unmounted, "sval"))),
    "and the helper created nothing"
  );
});
