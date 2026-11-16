/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */

/**
 * The one directory a profile's shared-folder requests travel through, and
 * the pipe a helper answers on: what a crash leaves in the directory goes
 * when the next helper starts, another profile's requests never meet it, and
 * an answer that is not the request's own, or not a frame, is never taken.
 */

/**
 * The entries in `dir` named like a request directory.
 *
 * @param {string} dir A directory to look in.
 * @returns {Promise<string[]>}
 */
async function requestDirsIn(dir) {
  return (await IOUtils.getChildren(dir))
    .map(PathUtils.filename)
    .filter(name => name.startsWith("sval-shared"));
}

/**
 * Leaves in `dir` what a request in flight holds, as a browser killed
 * mid-request with its helper would: a write's payload and a listing's
 * copies.
 *
 * @param {string} dir A request directory.
 * @param {Uint8Array} payload The bytes it was writing.
 */
async function leaveRequest(dir, payload) {
  await IOUtils.makeDirectory(PathUtils.join(dir, "files-crashed", "0"), {
    permissions: 0o700,
  });
  await IOUtils.write(PathUtils.join(dir, "payload-crashed-0.bin"), payload);
  await IOUtils.write(
    PathUtils.join(dir, "files-crashed", "0", "0"),
    new Uint8Array([1])
  );
}

add_task(async function a_crash_leftover_goes_when_the_next_helper_starts() {
  const root = await chosenFolder("crash-leftover");
  // Other files in the run share the temporary directory, so only what
  // appears in it during this task is this task's.
  const before = await requestDirsIn(PathUtils.tempDir);
  await SvalSharedFolder.release();
  await SvalSharedFolder._whenIdle();
  await leaveRequest(
    requestDir(),
    crypto.getRandomValues(new Uint8Array(65536))
  );

  const mine = new Uint8Array([7, 7, 7]);
  Assert.deepEqual(
    await SvalSharedFolder.writeFile({
      root,
      path: "sval/mine.json",
      bytes: mine,
      requireTop: "sval",
      deadline: deadline(),
    }),
    { reachable: true },
    "the next request succeeds"
  );
  Assert.deepEqual(
    await IOUtils.read(PathUtils.join(root, "sval", "mine.json")),
    mine,
    "and writes its own bytes"
  );
  Assert.deepEqual(
    await IOUtils.getChildren(requestDir(), { ignoreAbsent: true }),
    [],
    "and nothing of either request is left in the profile"
  );
  Assert.deepEqual(
    (await requestDirsIn(PathUtils.tempDir)).filter(
      name =>
        !before.includes(name) &&
        PathUtils.join(PathUtils.tempDir, name) !== requestDir()
    ),
    [],
    "and no request directory but the profile's is in the temporary directory"
  );
});

add_task(async function two_profiles_requests_never_meet() {
  const root = await chosenFolder("two-profiles");
  const other = await makeTempDir("sval-test-other-profile");
  const theirs = requestDir(other);
  Assert.notEqual(theirs, requestDir(), "each profile has its own directory");
  Assert.equal(PathUtils.parent(theirs), other, "inside that profile");

  // The other profile's browser is in the middle of a write.
  const payload = crypto.getRandomValues(new Uint8Array(4096));
  await leaveRequest(theirs, payload);
  Assert.deepEqual(
    await SvalSharedFolder.writeFile({
      root,
      path: "sval/mine.json",
      bytes: new Uint8Array([1]),
      requireTop: "sval",
      deadline: deadline(),
    }),
    { reachable: true },
    "this profile's request succeeds"
  );
  Assert.deepEqual(
    await IOUtils.read(PathUtils.join(theirs, "payload-crashed-0.bin")),
    payload,
    "and the other profile's request still holds its payload"
  );
  Assert.ok(
    await IOUtils.exists(PathUtils.join(theirs, "files-crashed", "0", "0")),
    "and its copies"
  );
});

/**
 * Asks once of a stand-in helper that says hello and then writes `then`, raw,
 * as its answer.
 *
 * @param {string} then What the stand-in answers with, for `printf`.
 * @returns {Promise<object>} The request's answer.
 */
async function askAnsweredWith(then) {
  const root = await chosenFolder("answered-with");
  await SvalSharedFolder.release();
  await SvalSharedFolder._whenIdle();
  SvalSharedFolder._helperCommand = () => ({
    command: "/bin/sh",
    arguments: [
      "-c",
      `printf '${printfFrame({ hello: 1, build: "stand-in" })}${then}'; exec sleep 3600`,
    ],
  });
  registerCleanupFunction(endStuckHelper);
  try {
    return await SvalSharedFolder.exists({
      root,
      path: "sval",
      deadline: deadline(),
    });
  } finally {
    await endStuckHelper();
  }
}

add_task(
  { skip_if: noFifo },
  async function an_answer_to_another_request_is_not_taken() {
    Assert.deepEqual(
      reasonOf(
        await askAnsweredWith(
          printfFrame({ id: "another", reachable: true, exists: true })
        )
      ),
      { reachable: false, reason: "helper-failed" }
    );
  }
);

add_task(
  { skip_if: noFifo },
  async function a_frame_over_the_limit_is_not_read() {
    Assert.deepEqual(
      reasonOf(await askAnsweredWith("\\000\\040\\000\\001{")),
      { reachable: false, reason: "helper-failed" },
      "a frame declaring more than 1 MiB fails the request unread"
    );
  }
);

add_task(
  { skip_if: noFifo },
  async function a_frame_that_is_not_json_is_not_taken() {
    Assert.deepEqual(
      reasonOf(await askAnsweredWith("\\000\\000\\000\\003{{{")),
      { reachable: false, reason: "helper-failed" }
    );
  }
);
