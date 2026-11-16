/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */

/**
 * A "wait" pass that finds a background step running on the same document
 * joins it when that step publishes everything the pass has to, and runs a
 * step of its own only when the running one merged before a change it needs,
 * or leaves out a document it has to publish.
 */

add_task(async function a_wait_pass_joins_a_step_that_has_its_changes() {
  const { make } = await device("wait-joins");
  const engine = make();
  await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
  const heard = [];
  const stop = engine.addSharedListener(report => heard.push(report));
  try {
    await engine.sync(WORKSPACE, 2000, { shared: "background" });
    const report = await engine.sync(WORKSPACE, 3000, { shared: "wait" });
    Assert.equal(report.sharedRan, true, "the pass carries a step");
    Assert.equal(report.shared, "reached");
    await SvalSharedFolder._whenIdle();
    Assert.equal(heard.length, 1, "and it was the running one");
  } finally {
    stop();
  }
});

add_task(async function a_wait_pass_runs_its_own_step_for_a_later_change() {
  const { make } = await device("wait-later");
  const engine = make();
  await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
  const post = engine.post.bind(engine);
  const merging = Promise.withResolvers();
  const release = Promise.withResolvers();
  engine.post = async (fn, args) => {
    if (fn !== "mergeSnapshot") {
      return post(fn, args);
    }
    const answer = post(fn, args);
    merging.resolve();
    await release.promise;
    return answer;
  };
  const heard = [];
  const stop = engine.addSharedListener(report => heard.push(report));
  try {
    await engine.sync(WORKSPACE, 2000, { shared: "background" });
    await merging.promise;
    await engine.mutate({ kind: "addWorkspace", name: "Later", now: 2500 });
    const waiting = engine.sync(WORKSPACE, 3000, { shared: "wait" });
    release.resolve();
    const report = await waiting;
    Assert.equal(report.sharedRan, true, "the pass carries a step");
    Assert.equal(heard.length, 2, "a second step, after the running one");
    Assert.notEqual(report.sharedWrote, null, "which published the change");
  } finally {
    stop();
  }
});

add_task(async function a_wait_pass_publishes_a_document_added_mid_step() {
  const { make, shared, keyBytes } = await device("wait-added");
  const engine = make();
  await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
  const post = engine.post.bind(engine);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  engine.post = async (fn, args) => {
    if (fn !== "layout") {
      return post(fn, args);
    }
    engine.post = post;
    const answer = post(fn, args);
    started.resolve();
    await release.promise;
    return answer;
  };
  await engine.sync(WORKSPACE, 2000, { shared: "background" });
  await started.promise;
  await engine.addDocument("settings");
  await engine.mutate({
    kind: "setSetting",
    document: "settings",
    key: "k",
    valueJson: "true",
    now: 2500,
  });
  const waiting = engine.sync(WORKSPACE, 3000, { shared: "wait" });
  release.resolve();
  await waiting;

  const reader = new SvalEngine({
    root: shared,
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  registerCleanupFunction(() => reader.terminate());
  await reader.addDocument("settings");
  await reader.sync("settings", 4000);
  Assert.deepEqual(
    await reader.settings("settings"),
    { k: true },
    "the pass returned once the added document was published"
  );
});
