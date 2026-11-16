/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */

const { OWN_FILE_SET_ASIDE_MS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);

/**
 * This device's own file in the shared folder that stays unreadable for
 * `OWN_FILE_SET_ASIDE_MS` is renamed `<name>.damaged-<now>`, and the next step
 * writes a fresh one from the profile (decision 1144). The clock is the `now`
 * each pass is given.
 */

const MINUTE = 60 * 1000;

/** Far past the passes `publishedDevice` runs, so no interval interferes. */
const T0 = 100 * MINUTE;

/**
 * A device that has published once beside a peer, the path of its own file in
 * the shared folder, and the bytes that file held then.
 *
 * @param {string} name Distinguishes this task's folders.
 * @returns {Promise<object>}
 */
async function publishedDevice(name) {
  const { local, shared, keyBytes, make } = await device(name);
  const engine = make();
  await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
  const peer = await peerPublishes(shared, keyBytes);
  const first = await engine.sync(WORKSPACE, 2000);
  Assert.notEqual(first.sharedWrote, null, "this device published its file");
  const own = resolve(shared, first.sharedWrote);
  return {
    engine,
    local,
    keyBytes,
    shared,
    peer,
    own,
    damaged: at => `${own}.damaged-${at}`,
    healthy: await IOUtils.read(own),
  };
}

/**
 * @param {string} own This device's own file.
 * @returns {Promise<string[]>} the copies set aside beside it.
 */
async function copiesOf(own) {
  const prefix = `${PathUtils.filename(own)}.damaged`;
  return (await IOUtils.getChildren(PathUtils.parent(own)))
    .map(PathUtils.filename)
    .filter(name => name.startsWith(prefix));
}

const GARBAGE = new TextEncoder().encode("not a file Sval can open");

add_task(async function own_file_unreadable_for_ten_minutes_is_set_aside() {
  const setup = await publishedDevice("set-aside");
  const { engine, own, damaged } = setup;
  await IOUtils.write(own, GARBAGE);

  let report = await engine.sync(WORKSPACE, T0);
  Assert.ok(
    report.errors.some(file => file.own),
    "the own file is reported unreadable"
  );
  Assert.equal(report.sharedWrote, null, "and is not written over");
  report = await engine.sync(WORKSPACE, T0 + 9 * MINUTE);
  Assert.deepEqual(
    await IOUtils.read(own),
    GARBAGE,
    "at nine minutes the file is where it was"
  );
  Assert.deepEqual(await copiesOf(own), [], "and nothing is set aside");

  await engine.sync(WORKSPACE, T0 + OWN_FILE_SET_ASIDE_MS);
  Assert.deepEqual(
    await IOUtils.read(damaged(T0 + OWN_FILE_SET_ASIDE_MS)),
    GARBAGE,
    "at ten minutes the file is set aside as it was"
  );

  report = await engine.sync(WORKSPACE, T0 + 11 * MINUTE);
  Assert.notEqual(report.sharedWrote, null, "a fresh own file is published");
  report = await engine.sync(WORKSPACE, T0 + 12 * MINUTE);
  Assert.deepEqual(report.errors, [], "with nothing in error");
  Assert.ok(
    setup.peer.id in (await readBack(setup.local, setup.keyBytes)),
    "the peer's workspace merges"
  );
});

add_task(async function a_file_that_recovers_is_never_moved() {
  const { engine, own, healthy } = await publishedDevice("recovers");
  await IOUtils.write(own, GARBAGE);
  await engine.sync(WORKSPACE, T0);

  await IOUtils.write(own, healthy);
  const report = await engine.sync(WORKSPACE, T0 + 5 * MINUTE);
  Assert.deepEqual(report.errors, [], "the own file read again");

  await IOUtils.write(own, GARBAGE);
  await engine.sync(WORKSPACE, T0 + 12 * MINUTE);
  Assert.deepEqual(
    await IOUtils.read(own),
    GARBAGE,
    "unreadable again, the file stays: its ten minutes start over"
  );
  Assert.deepEqual(await copiesOf(own), [], "nothing is set aside");
});

add_task(async function a_newer_schema_own_file_is_never_moved() {
  const { engine, own, healthy } = await publishedDevice("newer");
  // The byte after the magic is the format version (`crypto::open`).
  const newer = Uint8Array.from(healthy);
  newer[3] += 1;
  await IOUtils.write(own, newer);

  await engine.sync(WORKSPACE, T0);
  const report = await engine.sync(WORKSPACE, T0 + 11 * MINUTE);
  Assert.deepEqual(await IOUtils.read(own), newer, "the file stays in place");
  Assert.deepEqual(await copiesOf(own), [], "nothing is set aside");
  Assert.ok(
    report.schemaTooNew.some(file => file.own),
    "the report names it as from a newer build"
  );
});

add_task(async function a_damaged_copy_is_not_read_as_a_peer() {
  const { engine, own } = await publishedDevice("not-a-peer");
  const before = await engine.sync(WORKSPACE, T0 - MINUTE);

  await IOUtils.write(own, GARBAGE);
  await engine.sync(WORKSPACE, T0);
  await engine.sync(WORKSPACE, T0 + OWN_FILE_SET_ASIDE_MS);
  Assert.equal((await copiesOf(own)).length, 1, "the file was set aside");
  await engine.sync(WORKSPACE, T0 + 11 * MINUTE);

  const after = await engine.sync(WORKSPACE, T0 + 12 * MINUTE);
  Assert.equal(after.merged, before.merged, "as many files merged as before");
  for (const list of ["errors", "unreadable", "schemaTooNew"]) {
    Assert.deepEqual(after[list], [], `nothing in ${list}`);
  }
});

add_task(async function time_out_of_reach_does_not_count() {
  const { engine, shared, own, damaged } = await publishedDevice("away");
  await IOUtils.write(own, GARBAGE);
  await engine.sync(WORKSPACE, T0);

  // The whole folder goes away, as a drive unmounts, and comes back.
  const away = `${shared}-away`;
  await IOUtils.move(shared, away);
  try {
    for (const at of [T0 + MINUTE, T0 + 11 * MINUTE]) {
      const report = await engine.sync(WORKSPACE, at);
      Assert.equal(report.sharedReason, "gone", "the folder is out of reach");
    }
  } finally {
    await IOUtils.move(away, shared);
  }

  await engine.sync(WORKSPACE, T0 + 12 * MINUTE);
  Assert.deepEqual(
    await copiesOf(own),
    [],
    "the ten minutes start again when the file is next seen"
  );
  await engine.sync(WORKSPACE, T0 + 21 * MINUTE);
  Assert.deepEqual(await copiesOf(own), [], "and have not passed at 21");
  await engine.sync(WORKSPACE, T0 + 22 * MINUTE);
  Assert.deepEqual(
    await IOUtils.read(damaged(T0 + 22 * MINUTE)),
    GARBAGE,
    "at 22 the file is set aside"
  );
});

add_task(async function each_set_aside_keeps_its_own_copy() {
  const { engine, own } = await publishedDevice("twice");
  for (const start of [T0, T0 + 30 * MINUTE]) {
    await IOUtils.write(own, GARBAGE);
    await engine.sync(WORKSPACE, start);
    await engine.sync(WORKSPACE, start + OWN_FILE_SET_ASIDE_MS);
    await engine.sync(WORKSPACE, start + 11 * MINUTE);
  }
  Assert.deepEqual(
    (await copiesOf(own)).sort(),
    [
      `${PathUtils.filename(own)}.damaged-${T0 + OWN_FILE_SET_ASIDE_MS}`,
      `${PathUtils.filename(own)}.damaged-${T0 + 30 * MINUTE + OWN_FILE_SET_ASIDE_MS}`,
    ].sort(),
    "both copies are kept"
  );
});

add_task(async function an_own_file_the_folder_will_not_read_is_set_aside() {
  const { engine, own, damaged } = await publishedDevice("denied");
  await SvalTestDeny.read(own);
  try {
    let report = await engine.sync(WORKSPACE, T0);
    Assert.equal(report.sharedReason, "own-file", "the read was refused");
    await engine.sync(WORKSPACE, T0 + OWN_FILE_SET_ASIDE_MS);
    Assert.ok(
      await IOUtils.exists(damaged(T0 + OWN_FILE_SET_ASIDE_MS)),
      "the file was set aside"
    );
    report = await engine.sync(WORKSPACE, T0 + 11 * MINUTE);
    Assert.equal(report.shared, "reached", "the next step reads the folder");
    Assert.notEqual(report.sharedWrote, null, "and writes a fresh file");
  } finally {
    await SvalTestDeny.allow(damaged(T0 + OWN_FILE_SET_ASIDE_MS));
    await SvalTestDeny.allow(own);
  }
});

add_task(async function a_stop_at_another_document_restarts_the_ten_minutes() {
  const { shared, keyBytes, make } = await device("two-docs");
  const engine = make();
  const other = "two-docs-settings";
  await engine.addDocument(other);
  await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
  await engine.mutate({
    kind: "setSetting",
    document: other,
    key: "test.twoDocs",
    valueJson: JSON.stringify(true),
    now: 1000,
  });
  await peerPublishes(shared, keyBytes);
  const first = await engine.sync(WORKSPACE, 2000);
  const ownA = resolve(shared, first.sharedWrote);
  const healthyA = await IOUtils.read(ownA);
  // The other document's file is this device's file of the same name in
  // the other document's directory.
  const ws = PathUtils.parent(PathUtils.parent(ownA));
  const [ownB] = (await IOUtils.getChildren(ws))
    .filter(dir => dir !== PathUtils.parent(ownA))
    .map(dir => PathUtils.join(dir, PathUtils.filename(ownA)));
  Assert.ok(await IOUtils.exists(ownB), "the other document published");

  try {
    await IOUtils.write(ownA, GARBAGE);
    await engine.sync(WORKSPACE, T0);

    // A reads, but the step stops at B before A's merge.
    await IOUtils.write(ownA, healthyA);
    await SvalTestDeny.read(ownB);
    const stopped = await engine.sync(WORKSPACE, T0 + 5 * MINUTE);
    Assert.equal(stopped.sharedReason, "own-file", "the step stopped at B");
    await SvalTestDeny.allow(ownB);

    await IOUtils.write(ownA, GARBAGE);
    await engine.sync(WORKSPACE, T0 + 6 * MINUTE);
    await engine.sync(WORKSPACE, T0 + 11 * MINUTE);
    Assert.deepEqual(
      await copiesOf(ownA),
      [],
      "A's ten minutes count from when it was next seen unreadable"
    );
    await engine.sync(WORKSPACE, T0 + 16 * MINUTE);
    Assert.deepEqual(
      await copiesOf(ownA),
      [`${PathUtils.filename(ownA)}.damaged-${T0 + 16 * MINUTE}`],
      "and it is set aside ten minutes after that"
    );
  } finally {
    await SvalTestDeny.allow(ownB);
  }
});

/**
 * The helper's move, asked through `SvalSharedFolder`, on a folder with
 * `sval/ws/d/me.json`.
 *
 * @param {string} name Distinguishes the folder.
 * @returns {Promise<object>} `{ root, dir, move }`, where `move(from, to)`
 *   answers as the helper does.
 */
async function moveFixture(name) {
  const root = await chosenFolder(name);
  const dir = PathUtils.join(root, "sval", "ws", "d");
  await IOUtils.makeDirectory(dir);
  await IOUtils.writeUTF8(PathUtils.join(dir, "me.json"), "mine");
  const move = (from, to) =>
    SvalSharedFolder.moveFile({
      root,
      from,
      to,
      requireTop: TOP_DIR,
      deadline: deadline(),
    });
  return { root, dir, move };
}

add_task(async function the_move_keeps_an_earlier_copy() {
  const { dir, move } = await moveFixture("move-keeps");
  await IOUtils.writeUTF8(PathUtils.join(dir, "me.json.damaged-1"), "older");
  Assert.deepEqual(
    await move("sval/ws/d/me.json", "sval/ws/d/me.json.damaged-1"),
    { reachable: false, reason: "io-error", error: "Exists" },
    "nothing is moved over an existing copy"
  );
  Assert.equal(
    await IOUtils.readUTF8(PathUtils.join(dir, "me.json.damaged-1")),
    "older",
    "the earlier copy is kept"
  );
  Assert.equal(
    await IOUtils.readUTF8(PathUtils.join(dir, "me.json")),
    "mine",
    "and the file is where it was"
  );
  Assert.deepEqual(
    await move("sval/ws/d/me.json", "sval/ws/d/me.json.damaged-2"),
    { reachable: true },
    "a free name takes it"
  );
  Assert.equal(
    await IOUtils.readUTF8(PathUtils.join(dir, "me.json.damaged-2")),
    "mine"
  );
});

add_task(async function the_move_refuses_a_directory_or_a_way_out() {
  const { dir, move } = await moveFixture("move-refuses");
  await IOUtils.makeDirectory(PathUtils.join(dir, "me.json.damaged-1"));
  Assert.deepEqual(
    reasonOf(await move("sval/ws/d/me.json", "sval/ws/d/me.json.damaged-1")),
    { reachable: false, reason: "io-error" },
    "a directory at the target would take the file into it"
  );
  Assert.ok(await IOUtils.exists(PathUtils.join(dir, "me.json")));
  for (const [from, to] of [
    ["sval/ws/d/me.json", "../me.json"],
    ["/etc/hosts", "sval/ws/d/x"],
    ["sval/ws/d/me.json", null],
  ]) {
    Assert.deepEqual(
      await move(from, to),
      { reachable: false, reason: "io-error", error: "InvalidRequest" },
      "a path outside the folder is no request"
    );
  }
});

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function the_move_refuses_a_link_at_the_target() {
    const { dir, move } = await moveFixture("move-link");
    const outside = await makeTempDir("sval-move-link-outside");
    const proc = await Subprocess.call({
      command: await Subprocess.pathSearch("ln"),
      arguments: ["-s", outside, PathUtils.join(dir, "me.json.damaged-1")],
      stderr: "pipe",
    });
    Assert.equal((await proc.wait()).exitCode, 0, "ln made the link");
    Assert.deepEqual(
      await move("sval/ws/d/me.json", "sval/ws/d/me.json.damaged-1"),
      { reachable: false, reason: "io-error", error: "Symlink" }
    );
    Assert.deepEqual(
      await IOUtils.getChildren(outside),
      [],
      "nothing reached the directory it points at"
    );
  }
);
