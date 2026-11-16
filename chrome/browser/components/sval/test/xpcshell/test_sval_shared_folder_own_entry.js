/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */

const { MAX_FILE_BYTES } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
);

/**
 * Someone with write access to the shared folder replaces this device's own
 * file with something that is not a file Sval can read: a link, a directory, or
 * a file over the size cap. The report names this device's own file, the
 * footer says nothing (messages spec §3: Sval recovers it, §8.2), Sval takes
 * in the other devices' files, and writes nothing over the entry.
 */

/**
 * A device that has published once, a peer in the same folder, and the path
 * of this device's own file there.
 *
 * @param {string} name Distinguishes this task's folders.
 * @returns {Promise<object>} `{ engine, local, shared, keyBytes, peer, own }`.
 */
async function publishedDevice(name) {
  const { local, shared, keyBytes, make } = await device(name);
  const engine = make();
  await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
  const first = await engine.sync(WORKSPACE, 2000);
  Assert.notEqual(first.sharedWrote, null, "this device published its file");
  const peer = await peerPublishes(shared, keyBytes);
  return {
    engine,
    local,
    shared,
    keyBytes,
    peer,
    own: resolve(shared, first.sharedWrote),
  };
}

/**
 * Makes a change on this device and syncs, then checks what the user is told
 * and that the peer's workspace arrived.
 *
 * @param {object} setup What `publishedDevice` gave.
 * @param {SvalEngine} setup.engine This device's engine.
 * @param {string} setup.local Its profile folder.
 * @param {Uint8Array} setup.keyBytes The document key.
 * @param {object} setup.peer What `peerPublishes` gave.
 * @returns {Promise<object>} the pass's report.
 */
async function syncPastOwnEntry({ engine, local, keyBytes, peer }) {
  await engine.mutate({ kind: "addWorkspace", name: "Later", now: 3000 });
  const report = await engine.sync(WORKSPACE, 4000);
  Assert.equal(report.shared, "reached", "the folder itself is reachable");
  Assert.ok(
    [...report.errors, ...report.unreadable].some(entry => entry.own),
    "the report names this device's own file as unread"
  );
  Assert.equal(
    indicatorFor(report, 4000).severity,
    "synced",
    "and the footer says nothing about it"
  );
  Assert.equal(report.sharedWrote, null, "nothing was published");
  Assert.ok(
    peer.id in (await readBack(local, keyBytes)),
    "the other device's workspace still arrived"
  );
  return report;
}

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function an_own_file_replaced_by_a_link_is_reported_and_left() {
    const setup = await publishedDevice("own-link");
    const outside = await makeTempDir("sval-own-link-outside");
    const target = PathUtils.join(outside, "elsewhere.json");
    await IOUtils.writeUTF8(target, "elsewhere");
    await IOUtils.remove(setup.own);
    const proc = await Subprocess.call({
      command: await Subprocess.pathSearch("ln"),
      arguments: ["-s", target, setup.own],
      stderr: "pipe",
    });
    Assert.equal((await proc.wait()).exitCode, 0, "ln made the link");

    await syncPastOwnEntry(setup);
    const link = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    link.initWithPath(setup.own);
    Assert.ok(link.isSymlink(), "the link is still there");
    Assert.equal(
      await IOUtils.readUTF8(target),
      "elsewhere",
      "and what it points at is untouched"
    );
  }
);

add_task(async function an_own_file_replaced_by_a_directory_is_reported() {
  const setup = await publishedDevice("own-dir");
  await IOUtils.remove(setup.own);
  await IOUtils.makeDirectory(setup.own);

  await syncPastOwnEntry(setup);
  Assert.equal(
    (await IOUtils.stat(setup.own)).type,
    "directory",
    "the directory is left where it is"
  );

  // Once it is removed, this device publishes again.
  await IOUtils.remove(setup.own);
  const report = await setup.engine.sync(WORKSPACE, 5000);
  Assert.ok(
    ![...report.errors, ...report.unreadable].some(entry => entry.own),
    "its own file is no longer unread"
  );
  Assert.notEqual(report.sharedWrote, null, "this device published again");
  Assert.equal((await IOUtils.stat(setup.own)).type, "regular");
});

add_task(async function an_own_file_over_the_cap_is_reported_and_kept() {
  const setup = await publishedDevice("own-big");
  await IOUtils.write(setup.own, new Uint8Array(MAX_FILE_BYTES + 1));

  await syncPastOwnEntry(setup);
  Assert.equal(
    (await IOUtils.stat(setup.own)).size,
    MAX_FILE_BYTES + 1,
    "the large file is not overwritten"
  );
});
