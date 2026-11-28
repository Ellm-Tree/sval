/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */

/**
 * Shared steps run in the background on their own clock (local-copy spec):
 * when one is due, what a pass reports before it has run, and the passes that
 * start no helper at all.
 */

const { SHARED_INTERVAL_MS, SHARED_RETRY_MS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);

/**
 * A step that does not reach the folder is tried again
 * within seconds, once, so a blip is told from an outage quickly. A second
 * failure goes back to the interval, and a step that reaches the folder
 * reports it at once.
 */
add_task(async function a_failed_reach_is_retried_within_seconds() {
  Assert.equal(SHARED_RETRY_MS, 5000, "the retry is seconds away");
  const { make } = await device("retry");
  const away = missingFolder("retry");
  const engine = make({ sharedRoot: away });
  await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
  const heard = [];
  const stop = engine.addSharedListener(report => heard.push(report));
  // A step starts inside the `sync` call that is due, and its first act is
  // asking the worker for the folder's layout.
  const startsStep = async now => {
    const posted = [];
    engine.post = (...args) => {
      posted.push(args[0]);
      return SvalEngine.prototype.post.apply(engine, args);
    };
    await engine.sync(WORKSPACE, now, { shared: "background" });
    delete engine.post;
    return posted.includes("layout");
  };
  try {
    let now = 10_000;
    await engine.sync(WORKSPACE, now, { shared: "background" });
    await waitForStep(() => heard.length == 1, "the first step");
    Assert.equal(heard[0].shared, "unreachable");
    Assert.equal(heard[0].sharedReason, "gone");
    Assert.equal(heard[0].sharedCause, "missing", "the path is not there");
    Assert.equal(heard[0].sharedFailures, 1, "one failure");

    Assert.ok(
      !(await startsStep(now + SHARED_RETRY_MS - 1)),
      "no retry before the retry is due"
    );
    now += SHARED_RETRY_MS;
    Assert.ok(await startsStep(now), "a retry at the retry's time");
    await waitForStep(() => heard.length == 2, "the retry");
    Assert.equal(heard[1].sharedFailures, 2, "a second failure in a row");

    Assert.ok(
      !(await startsStep(now + SHARED_RETRY_MS)),
      "an outage is not retried at the retry's pace"
    );
    // The drive comes back, with the folder the user chose on it.
    await IOUtils.makeDirectory(PathUtils.join(away, TOP_DIR), {
      createAncestors: true,
    });
    Assert.ok(
      await startsStep(now + SHARED_INTERVAL_MS),
      "the next step runs at the interval"
    );
    await waitForStep(() => heard.length == 3, "the step that reaches it");
    Assert.equal(heard[2].shared, "reached", "is reached at once");
    Assert.equal(heard[2].sharedFailures, 0, "and the outage is over");
    Assert.equal(heard[2].sharedCause, null);
  } finally {
    stop();
  }
});

/**
 * Makes the helper's next `readDirs` answers `answers`, in order, then puts
 * the real one back. An answer that is a function is called with the
 * request and the real `readDirs`, for one that answers late.
 *
 * @param {Array<object|Function>} answers
 */
function nextReads(answers) {
  const real = SvalSharedFolder.readDirs;
  SvalSharedFolder.readDirs = request => {
    const next = answers.shift();
    if (!answers.length) {
      SvalSharedFolder.readDirs = real;
    }
    return typeof next === "function"
      ? next(request, real.bind(SvalSharedFolder))
      : Promise.resolve(next);
  };
  registerCleanupFunction(() => {
    SvalSharedFolder.readDirs = real;
  });
}

/**
 * A step whose turn at the helper never came asked the folder nothing: it
 * changes nothing the panel shows, and is retried soon. Only a second one in
 * a row counts, as the helper ahead stuck in the folder.
 */
add_task(async function a_step_that_never_had_its_turn_says_nothing() {
  const { make } = await device("no-turn");
  const engine = make();
  await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
  const heard = [];
  const stop = engine.addSharedListener(report => heard.push(report));
  try {
    let now = 10_000;
    await engine.sync(WORKSPACE, now, { shared: "background" });
    await waitForStep(() => heard.length == 1, "the first step");
    Assert.equal(heard[0].shared, "reached");

    nextReads([{ reachable: false, reason: "busy" }]);
    now += SHARED_INTERVAL_MS;
    await engine.sync(WORKSPACE, now, { shared: "background" });
    await waitForStep(() => heard.length == 2, "the step with no turn");
    Assert.equal(heard[1].sharedRan, false, "asked the folder nothing");
    Assert.equal(heard[1].shared, "reached", "so the folder's answer stands");
    Assert.equal(heard[1].sharedFailures, 0, "and no outage starts");

    now += SHARED_RETRY_MS;
    await engine.sync(WORKSPACE, now, { shared: "background" });
    await waitForStep(() => heard.length == 3, "the retry, seconds later");
    Assert.equal(heard[2].shared, "reached");

    nextReads([
      { reachable: false, reason: "busy" },
      { reachable: false, reason: "busy" },
    ]);
    now += SHARED_INTERVAL_MS;
    await engine.sync(WORKSPACE, now, { shared: "background" });
    await waitForStep(() => heard.length == 4, "a step with no turn");
    now += SHARED_RETRY_MS;
    await engine.sync(WORKSPACE, now, { shared: "background" });
    await waitForStep(() => heard.length == 5, "and another");
    Assert.equal(heard[4].shared, "unreachable", "two in a row is the folder");
    Assert.equal(heard[4].sharedFailures, 1, "and counts once");
  } finally {
    stop();
  }
});

/** A folder that answers late, inside the step's limit, is reached. */
add_task(async function a_folder_that_answers_late_is_reached() {
  const { make } = await device("late");
  const engine = make();
  await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
  // A slow disk: the answer comes once the test lets it, after the question.
  const late = Promise.withResolvers();
  let asked = false;
  nextReads([
    async (request, real) => {
      asked = true;
      await late.promise;
      return real(request);
    },
  ]);
  const pass = engine.sync(WORKSPACE, 2000, { shared: "fresh" });
  await waitForStep(() => asked, "the folder is asked");
  late.resolve();
  const report = await pass;
  Assert.equal(report.shared, "reached", "a slow answer is an answer");
  Assert.equal(report.sharedFailures, 0);
});

add_task(async function a_background_pass_does_not_wait_and_reports_later() {
  const { make } = await device("background");
  const engine = make();
  await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
  const heard = [];
  const stop = engine.addSharedListener(report => heard.push(report));
  try {
    const report = await engine.sync(WORKSPACE, 2000, {
      shared: "background",
    });
    Assert.equal(
      report.sharedRan,
      false,
      "the pass did not wait for the folder"
    );
    Assert.equal(
      report.shared,
      "unknown",
      "nothing has been heard from it yet"
    );
    Assert.notEqual(report.wrote, null, "the profile copy was written at once");
    await waitForStep(() => heard.length, "the step finished");
    Assert.equal(heard[0].shared, "reached");
    Assert.equal(heard[0].sharedRan, true);
    Assert.notEqual(heard[0].sharedWrote, null, "and published");
  } finally {
    stop();
  }
});

add_task(async function background_steps_run_at_most_every_thirty_seconds() {
  const { make } = await device("interval");
  const engine = make();
  await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
  const heard = [];
  const stop = engine.addSharedListener(report => heard.push(report));
  try {
    let now = 10_000;
    await engine.sync(WORKSPACE, now, { shared: "background" });
    await waitForStep(() => heard.length == 1, "the first step");

    // A step starts inside the `sync` call that is due, and its first act,
    // before it awaits anything, is asking the worker for the folder's
    // layout. So a call that posted no "layout" started no step.
    const posted = [];
    engine.post = (...args) => {
      posted.push(args[0]);
      return SvalEngine.prototype.post.apply(engine, args);
    };
    now += SHARED_INTERVAL_MS - 1;
    await engine.sync(WORKSPACE, now, { shared: "background" });
    delete engine.post;
    Assert.ok(!posted.includes("layout"), "no step before thirty seconds");
    Assert.equal(heard.length, 1);

    now += 1;
    await engine.sync(WORKSPACE, now, { shared: "background" });
    await waitForStep(() => heard.length == 2, "one at thirty");

    engine.setSharedRoot(engine.sharedRoot);
    await engine.sync(WORKSPACE, now + 1, { shared: "background" });
    await waitForStep(
      () => heard.length == 3,
      "choosing a folder makes the next step due at once"
    );
  } finally {
    stop();
  }
});

/** A clock set back makes a step due; it never holds steps off. */
add_task(async function a_clock_set_back_does_not_stop_background_steps() {
  const { make } = await device("clock-back");
  const engine = make();
  await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
  const heard = [];
  const stop = engine.addSharedListener(report => heard.push(report));
  try {
    const now = 10 * 60 * 60 * 1000;
    await engine.sync(WORKSPACE, now, { shared: "background" });
    await waitForStep(() => heard.length == 1, "the first step");

    await engine.sync(WORKSPACE, now - 60 * 60 * 1000, {
      shared: "background",
    });
    await waitForStep(
      () => heard.length == 2,
      "a pass an hour before the last step's start runs one"
    );
  } finally {
    stop();
  }
});

add_task(async function a_skip_pass_never_starts_a_helper() {
  const { make } = await device("skip");
  const engine = make();
  await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
  const report = await engine.sync(WORKSPACE, 2000, { shared: "skip" });
  Assert.equal(report.sharedRan, false);
  Assert.notEqual(report.wrote, null, "the profile was written");
  Assert.ok(!SvalSharedFolder.busy, "and no helper was started");
});

/** The shutdown path writes the profile and asks nothing of the helper. */
add_task(async function the_shutdown_pass_never_starts_a_helper() {
  const { local, keyBytes, make } = await device("shutdown");
  const engine = make();
  await engine.sync(WORKSPACE, 1000, { shared: "skip" });
  const id = await engine.mutate({
    kind: "addWorkspace",
    name: "Made before quitting",
    now: 2000,
  });
  const realRun = SvalSharedFolder._run;
  let requests = 0;
  SvalSharedFolder._run = function (...args) {
    requests++;
    return realRun.apply(this, args);
  };
  try {
    const report = await engine.publishPending();
    Assert.notEqual(report, null, "a pass ran for the unpublished change");
    Assert.equal(report.sharedRan, false, "without a shared step");
    await engine.publishBeforeShutdown();
    Assert.equal(requests, 0, "and no request was made of a helper");
    Assert.ok(!SvalSharedFolder.busy, "so none is alive");
    Assert.ok(id in (await readBack(local, keyBytes)), "the profile has it");
  } finally {
    SvalSharedFolder._run = realRun;
  }
});

add_task(async function a_step_over_several_documents_starts_two_helpers() {
  const a = await device("batched");
  const alice = a.make();
  await alice.addDocument("batched-settings");
  await alice.addDocument("batched-favorites");
  await alice.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
  await alice.mutate({
    kind: "setSetting",
    document: "batched-settings",
    key: "test.batched",
    valueJson: JSON.stringify(true),
    now: 1000,
  });
  const realRun = SvalSharedFolder._run;
  const ops = [];
  SvalSharedFolder._run = function (request, ...rest) {
    ops.push(request.op);
    return realRun.call(this, request, ...rest);
  };
  let report;
  try {
    report = await alice.sync(WORKSPACE, 2000);
  } finally {
    SvalSharedFolder._run = realRun;
  }
  Assert.equal(report.shared, "reached");
  Assert.deepEqual(
    ops,
    ["readDirs", "writeFiles"],
    "one helper read every document and one published every change"
  );

  const bob = new SvalEngine({
    root: await makeTempDir("sval-batched-b-local"),
    sharedRoot: a.shared,
    keyBytes: a.keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  registerCleanupFunction(() => bob.terminate());
  await bob.addDocument("batched-settings");
  await bob.sync(WORKSPACE, 3000);
  Assert.equal(
    (await bob.settings("batched-settings"))["test.batched"],
    true,
    "another device reads what that step published"
  );
});

add_task(
  { skip_if: () => AppConstants.platform === "win" },
  async function a_file_with_an_odd_name_does_not_stop_a_step() {
    const a = await device("odd-name");
    const alice = a.make();
    await alice.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
    const first = await alice.sync(WORKSPACE, 2000);
    Assert.equal(first.shared, "reached");
    // A name another machine or a cloud client chose, beside Sval's files.
    const dir = PathUtils.parent(
      PathUtils.join(a.shared, ...first.sharedWrote.split("/"))
    );
    await IOUtils.writeUTF8(PathUtils.join(dir, "a:conflict.json"), "{}");

    const bob = new SvalEngine({
      root: await makeTempDir("sval-odd-name-b-local"),
      sharedRoot: a.shared,
      keyBytes: a.keyBytes,
      deviceId: crypto.getRandomValues(new Uint8Array(16)),
    });
    registerCleanupFunction(() => bob.terminate());
    const id = await bob.mutate({ kind: "addWorkspace", name: "Bob's" });
    Assert.equal((await bob.sync(WORKSPACE, 3000)).shared, "reached");
    Assert.equal((await alice.sync(WORKSPACE, 4000)).shared, "reached");
    Assert.ok(
      (await alice.tree()).nodes[id],
      "the devices still sync beside it"
    );
  }
);

add_task(async function a_step_over_more_documents_than_a_helper_takes() {
  const a = await device("many");
  const alice = a.make();
  const names = Array.from({ length: 70 }, (_, i) => `many-${i}`);
  for (const name of names) {
    await alice.addDocument(name);
  }
  const last = names.at(-1);
  await alice.mutate({
    kind: "setSetting",
    document: last,
    key: "test.many",
    valueJson: JSON.stringify(true),
    now: 1000,
  });
  Assert.equal((await alice.sync(WORKSPACE, 2000)).shared, "reached");

  const bob = new SvalEngine({
    root: await makeTempDir("sval-many-b-local"),
    sharedRoot: a.shared,
    keyBytes: a.keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  registerCleanupFunction(() => bob.terminate());
  await bob.addDocument(last);
  Assert.equal((await bob.sync(WORKSPACE, 3000)).shared, "reached");
  Assert.equal(
    (await bob.settings(last))["test.many"],
    true,
    "the document past the first batch reached another device"
  );
});
