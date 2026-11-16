/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */

const { folderProblem } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
);

/**
 * A local copy in the profile, and a shared folder that comes and goes
 * (local-copy spec): what one pass does with the folder there, missing, or
 * not a folder at all.
 */

add_task(async function the_profile_is_written_first_and_says_what_it_held() {
  const { local, keyBytes, make } = await device("first");
  const engine = make({ sharedRoot: null });
  await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
  const first = await engine.sync(WORKSPACE, 2000);
  Assert.equal(first.hadLocalCopy, false, "a fresh profile held no copy");
  Assert.equal(first.shared, "none", "and there is no shared folder");
  Assert.equal(first.sharedRan, false, "so no shared step ran");
  Assert.notEqual(first.wrote, null, "the profile copy was written");
  Assert.ok(await IOUtils.exists(resolve(local, first.wrote)));
  const second = await engine.sync(WORKSPACE, 3000);
  Assert.equal(second.hadLocalCopy, true, "the next pass found it");
  Assert.equal(second.wrote, null, "and had nothing new to write");
  Assert.equal(Object.keys(await readBack(local, keyBytes)).length, 1);
});

add_task(async function first_use_of_a_folder_publishes_there() {
  const { shared, make } = await device("first-use");
  const engine = make();
  await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
  const report = await engine.sync(WORKSPACE, 2000);
  Assert.equal(report.shared, "reached", "an empty chosen folder is reachable");
  Assert.equal(report.sharedRan, true);
  Assert.notEqual(report.sharedWrote, null, "and receives this device's file");
  Assert.ok(await IOUtils.exists(resolve(shared, report.sharedWrote)));
});

add_task(async function marking_a_folder_makes_sval_and_the_next_step_syncs() {
  const { shared, make } = await device("mark", { chosen: false });
  const engine = make();
  await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
  Assert.equal(
    (await engine.sync(WORKSPACE, 2000)).shared,
    "unreachable",
    "a folder without sval/ is unavailable"
  );
  Assert.deepEqual(
    await engine.markSharedRoot(),
    { reachable: true },
    "marking it answers"
  );
  Assert.ok(
    await IOUtils.exists(PathUtils.join(shared, TOP_DIR)),
    "and makes sval/"
  );
  const report = await engine.sync(WORKSPACE, 2500);
  Assert.equal(report.shared, "reached", "the next step reaches the folder");
  Assert.ok(await IOUtils.exists(resolve(shared, report.sharedWrote)));
});

add_task(async function marking_a_missing_folder_makes_nothing() {
  const { make } = await device("mark-missing");
  const gone = missingFolder("mark");
  const engine = make({ sharedRoot: gone });
  const answer = await engine.markSharedRoot();
  Assert.equal(answer.reason, "missing", "a folder that is not there");
  Assert.ok(!(await IOUtils.exists(gone)), "is not made");
});

add_task(
  async function a_missing_folder_is_unreachable_and_local_work_goes_on() {
    const { local, keyBytes, make } = await device("missing");
    const engine = make({ sharedRoot: missingFolder("gone") });
    const id = await engine.mutate({
      kind: "addWorkspace",
      name: "Offline",
      now: 1000,
    });
    const report = await engine.sync(WORKSPACE, 2000);
    Assert.equal(
      report.shared,
      "unreachable",
      "a missing folder is unreachable"
    );
    Assert.deepEqual(report.errors, [], "which is not an error");
    Assert.notEqual(
      report.wrote,
      null,
      "and the profile copy was still written"
    );
    Assert.ok(id in (await readBack(local, keyBytes)));
  }
);

add_task(function folder_problem_names_each_reason() {
  for (const reason of ["missing", "not-a-directory", "no-sval-dir"]) {
    Assert.equal(folderProblem(reason), "gone", `${reason} is gone`);
  }
  Assert.equal(folderProblem("io-error", "NotAllowedError"), "denied");
  Assert.equal(folderProblem("io-error", "NotReadableError"), "offline");
  Assert.equal(folderProblem("io-error"), "offline", "an io-error unnamed");
  Assert.equal(folderProblem("own-file-unreadable"), "own-file");
  Assert.equal(folderProblem("too-large"), "too-large");
  for (const reason of ["helper-failed", "timeout", "busy"]) {
    Assert.equal(folderProblem(reason), "offline", `${reason} is offline`);
  }
});

add_task(async function a_missing_folder_reports_gone() {
  const { make } = await device("missing-reason");
  const engine = make({ sharedRoot: missingFolder("gone-reason") });
  await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
  const report = await engine.sync(WORKSPACE, 2000);
  Assert.equal(report.shared, "unreachable");
  Assert.equal(report.sharedReason, "gone");
});

add_task(async function a_reached_folder_reports_no_reason() {
  const { make } = await device("reached-reason");
  const engine = make();
  await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
  const report = await engine.sync(WORKSPACE, 2000);
  Assert.equal(report.shared, "reached");
  Assert.strictEqual(report.sharedReason, null);
});

add_task(async function a_pass_that_ran_no_shared_step_reports_no_reason() {
  const { make } = await device("none-reason");
  const engine = make({ sharedRoot: null });
  await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
  const report = await engine.sync(WORKSPACE, 2000);
  Assert.equal(report.shared, "none");
  Assert.strictEqual(report.sharedReason, null);
});

/** Spec §6 test 2. */
add_task(
  async function an_offline_edit_survives_a_relaunch_with_the_folder_missing() {
    const { make } = await device("relaunch");
    const gone = missingFolder("relaunch");
    const first = make({ sharedRoot: gone });
    await first.sync(WORKSPACE, 1000);
    const id = await first.mutate({
      kind: "addWorkspace",
      name: "Made offline",
      now: 2000,
    });
    await first.sync(WORKSPACE, 3000);
    first.terminate();

    const relaunched = make({ sharedRoot: gone });
    const report = await relaunched.sync(WORKSPACE, 4000);
    Assert.equal(report.hadLocalCopy, true, "the relaunch found its copy");
    Assert.equal(report.shared, "unreachable", "with the folder still missing");
    Assert.ok(id in (await relaunched.tree()).nodes, "and nothing was lost");
  }
);

/** Spec §6 test 3. */
add_task(async function offline_edits_reach_a_peer_when_the_folder_returns() {
  const { shared, keyBytes, make } = await device("returns");
  const engine = make();
  await engine.mutate({ kind: "addWorkspace", name: "Before", now: 1000 });
  Assert.equal((await engine.sync(WORKSPACE, 2000)).shared, "reached");

  const away = `${shared}-away`;
  await IOUtils.move(shared, away);
  const id = await engine.mutate({
    kind: "addWorkspace",
    name: "Made while away",
    now: 3000,
  });
  Assert.equal(
    (await engine.sync(WORKSPACE, 4000)).shared,
    "unreachable",
    "the folder is gone"
  );

  await IOUtils.move(away, shared);
  const back = await engine.sync(WORKSPACE, 5000);
  Assert.equal(back.shared, "reached", "the next pass finds it again");
  Assert.notEqual(back.sharedWrote, null, "and publishes what was made away");
  Assert.ok(
    id in (await readBack(shared, keyBytes)),
    "so a peer reading the folder sees the edit"
  );
});

/** Spec §6 test 5, on the first step for the folder and on later ones. */
add_task(
  async function an_unmounted_mount_point_is_unreachable_and_untouched() {
    const { shared, make } = await device("unmounted", { chosen: false });
    const engine = make();
    await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
    for (const now of [2000, 3000]) {
      const report = await engine.sync(WORKSPACE, now);
      Assert.equal(
        report.shared,
        "unreachable",
        "a folder with no sval/ in it is unreachable"
      );
      Assert.equal(report.sharedWrote, null, "and nothing was written");
    }
    Assert.deepEqual(
      await IOUtils.getChildren(shared),
      [],
      "sval wrote nothing into it"
    );
  }
);

/** Spec §6 test 7. */
add_task(
  async function a_deleted_device_file_is_rewritten_with_nothing_shown() {
    const { shared, make } = await device("deleted-file");
    const engine = make();
    await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
    const first = await engine.sync(WORKSPACE, 2000);
    const mine = resolve(shared, first.sharedWrote);
    await IOUtils.remove(mine);

    const report = await engine.sync(WORKSPACE, 3000);
    Assert.equal(
      report.shared,
      "reached",
      "sval/ is there, so this is no outage"
    );
    Assert.deepEqual(report.errors, [], "and nothing is reported");
    Assert.equal(
      report.sharedWrote,
      first.sharedWrote,
      "the file was rewritten"
    );
    Assert.ok(await IOUtils.exists(mine));
  }
);

add_task(async function a_shared_folder_that_is_the_profile_is_one_location() {
  const { local, make } = await device("same");
  const engine = make({ sharedRoot: local });
  await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
  const report = await engine.sync(WORKSPACE, 2000);
  Assert.equal(report.shared, "none", "the same folder twice is one location");
  Assert.notEqual(report.wrote, null, "written once");
  Assert.equal(report.sharedWrote, null, "and not a second time");
});

add_task(async function a_shared_path_that_is_a_file_is_unreachable() {
  const { make } = await device("file");
  const notAFolder = tempPath("sval-not-a-folder");
  await IOUtils.writeUTF8(notAFolder, "a file");
  const engine = make({ sharedRoot: notAFolder });
  await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
  const report = await engine.sync(WORKSPACE, 2000);
  Assert.equal(report.shared, "unreachable", "a file is not a folder");
  Assert.deepEqual(report.errors, [], "and is not reported as an error");
  Assert.equal(
    await IOUtils.readUTF8(notAFolder),
    "a file",
    "and is untouched"
  );
});
