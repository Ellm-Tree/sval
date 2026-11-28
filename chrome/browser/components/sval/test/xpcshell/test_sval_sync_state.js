/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { SvalSyncState } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSyncState.sys.mjs"
);

/**
 * What `SvalSyncState` asks of an engine: its three kinds of listener, which
 * the returned object's `pass`, `step` and `fail` call as the engine would.
 */
function engineStub() {
  const heard = { pass: new Set(), step: new Set(), fail: new Set() };
  const tell = kind => report => heard[kind].forEach(fn => fn(report));
  return {
    addPassListener: fn => heard.pass.add(fn),
    addSharedListener: fn => heard.step.add(fn),
    addFailureListener: fn => heard.fail.add(fn),
    pass: tell("pass"),
    step: tell("step"),
    fail: tell("fail"),
  };
}

add_task(function an_engine_has_one_state() {
  const engine = engineStub();
  const state = SvalSyncState.of(engine);
  Assert.equal(SvalSyncState.of(engine), state, "asked for again");
  Assert.notEqual(SvalSyncState.of(engineStub()), state, "another engine's");
  Assert.equal(state.folderState, "none", "nothing is known before a pass");
  Assert.equal(state.lastPass, null);
});

add_task(function a_step_that_reaches_the_folder_is_the_last_sync() {
  const engine = engineStub();
  const state = SvalSyncState.of(engine);
  const report = { shared: "reached", sharedRan: true };
  const before = Date.now();
  engine.step(report);
  Assert.equal(state.lastPass, report, "the report is kept");
  Assert.equal(state.folderState, "reached");
  Assert.greaterOrEqual(state.lastSynced, before, "and timed");

  const synced = state.lastSynced;
  engine.pass({ shared: "reached", sharedRan: false });
  Assert.equal(state.lastSynced, synced, "a pass with no step says no more");
});

/**
 * A step's report that did not reach the folder, the `failures`th in a row.
 *
 * @param {number} failures
 * @param {object} [more]
 * @returns {object}
 */
function away(failures, more = {}) {
  return {
    shared: "unreachable",
    sharedRan: true,
    sharedReason: "offline",
    sharedCause: "io-error",
    sharedFailures: failures,
    ...more,
  };
}

add_task(function an_outage_counts_the_steps_in_a_row() {
  const engine = engineStub();
  const state = SvalSyncState.of(engine);
  engine.step(away(1, { sharedReason: "gone", sharedCause: "missing" }));
  Assert.equal(state.failedSteps, 1, "the outage began");
  Assert.equal(state.folderProblem, "gone");
  Assert.equal(state.folderCause, "missing", "with the helper's reason");
  engine.step(away(2, { sharedReason: "gone", sharedCause: "missing" }));
  Assert.equal(state.failedSteps, 2, "and goes on");

  engine.step({ shared: "unknown", sharedRan: true });
  Assert.equal(state.folderState, "unreachable", "no answer changes nothing");

  engine.step({ shared: "reached", sharedRan: true, sharedFailures: 0 });
  Assert.equal(state.failedSteps, 0, "an answer ends it");
  Assert.equal(state.folderProblem, null);
  Assert.equal(state.folderCause, null);
});

add_task(function a_step_someone_waited_on_answers_at_once() {
  const engine = engineStub();
  const state = SvalSyncState.of(engine);
  engine.step(away(1));
  Assert.ok(!state.failureAsked, "a background step's failure is a blip");
  // A pass that waited for its step hears the step twice: as the step, then
  // as the pass's report.
  engine.step(away(2));
  engine.pass(away(2));
  Assert.ok(state.failureAsked, "a pass someone waited on is an answer");
  Assert.equal(state.failedSteps, 2, "each step counted once");

  engine.step({ shared: "reached", sharedRan: true, sharedFailures: 0 });
  Assert.ok(!state.failureAsked, "until the folder answers");
});

add_task(function an_unreadable_own_file_is_no_outage() {
  const engine = engineStub();
  const state = SvalSyncState.of(engine);
  engine.pass(away(0, { sharedReason: "own-file" }));
  Assert.equal(state.folderState, "unreachable");
  Assert.equal(state.failedSteps, 0, "the folder answered");
  Assert.ok(!state.failureAsked, "so nothing is asked about");
});

/**
 * A device-local settings store, as `SvalLocalSettings.open` gives it, in a
 * file of the task's own.
 *
 * @param {string} name
 * @returns {Promise<object>}
 */
async function storeIn(name) {
  const { SvalLocalSettings } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalLocalSettings.sys.mjs"
  );
  const path = PathUtils.join(PathUtils.tempDir, `${name}-settings.json`);
  await IOUtils.remove(path, { ignoreAbsent: true });
  return { SvalLocalSettings, path, store: await SvalLocalSettings.open(path) };
}

add_task(async function the_last_sync_survives_a_restart() {
  const { SvalLocalSettings, path, store } = await storeIn("restart");
  store.sharedFolder = "/Volumes/documents/Folder Test";
  const state = SvalSyncState.of(engineStub());
  state.keepIn(store);
  Assert.equal(state.lastSynced, null, "never synced with the folder");
  const before = Date.now();
  const engine = engineStub();
  const kept = SvalSyncState.of(engine);
  kept.keepIn(store);
  engine.step({ shared: "reached", sharedRan: true, sharedFailures: 0 });
  Assert.greaterOrEqual(kept.lastSynced, before, "a step reached the folder");
  const synced = kept.lastSynced;

  // A restart: the store is read again from its file, into the state of a
  // new engine that no step has reached.
  await store.flush();
  SvalLocalSettings.forgetCachedValues();
  const reread = await SvalLocalSettings.open(path);
  const after = SvalSyncState.of(engineStub());
  after.keepIn(reread);
  Assert.equal(after.lastSynced, synced, "the launch knows the last sync");
  Assert.equal(after.folderState, "none", "and nothing of the folder's answer");
});

add_task(async function a_locked_key_keeps_the_last_sync() {
  const { store } = await storeIn("locked");
  store.sharedFolder = "/Volumes/documents/Folder Test";
  const engine = engineStub();
  const state = SvalSyncState.of(engine);
  state.keepIn(store);
  engine.step({ shared: "reached", sharedRan: true, sharedFailures: 0 });
  const synced = state.lastSynced;
  engine.pass({ shared: "none", sharedRan: false });
  Assert.equal(state.folderState, "none", "the engine shares nowhere");
  Assert.equal(state.lastSynced, synced, "and the folder last synced then");
});

add_task(async function the_last_sync_belongs_to_its_folder() {
  const { store } = await storeIn("folders");
  store.sharedFolder = "/Volumes/documents/Folder Test";
  const engine = engineStub();
  const state = SvalSyncState.of(engine);
  state.keepIn(store);
  engine.step({ shared: "reached", sharedRan: true, sharedFailures: 0 });
  Assert.notEqual(state.lastSynced, null);

  store.sharedFolder = "/Volumes/other/Sync";
  Assert.equal(state.lastSynced, null, "another folder never synced");
  store.sharedFolder = "/Volumes/documents/Folder Test";
  state.leftFolder();
  Assert.equal(state.lastSynced, null, "and leaving a folder forgets it");
});

add_task(function a_step_heard_before_the_store_is_kept() {
  const engine = engineStub();
  const state = SvalSyncState.of(engine);
  engine.step({ shared: "reached", sharedRan: true, sharedFailures: 0 });
  const heard = state.lastSynced;
  const store = {
    sharedFolder: "/f",
    lastSynced: heard - 1000,
    saveSoon() {},
  };
  state.keepIn(store);
  Assert.equal(store.lastSynced, heard, "the newer time is kept");
});

add_task(function a_folder_too_large_answers_and_syncs_nothing() {
  const engine = engineStub();
  const state = SvalSyncState.of(engine);
  engine.step({ shared: "too-large", sharedRan: true });
  Assert.equal(state.folderState, "too-large");
  Assert.equal(state.lastSynced, null);
});

add_task(function a_state_made_between_steps_takes_the_engines_answer() {
  const engine = engineStub();
  const state = SvalSyncState.of(engine);
  engine.pass(away(2, { sharedRan: false, sharedReason: "gone" }));
  Assert.equal(state.folderState, "unreachable");
  Assert.equal(state.folderProblem, "gone");
  Assert.equal(state.failedSteps, 2, "and how long the outage is");
  Assert.ok(!state.failureAsked, "which nobody waited on");
});

add_task(function leaving_the_folder_forgets_its_answer() {
  const engine = engineStub();
  const state = SvalSyncState.of(engine);
  engine.step({ shared: "reached", sharedRan: true });
  state.leftFolder();
  Assert.equal(state.folderState, "none");
  Assert.equal(state.lastSynced, null);

  engine.step({ shared: "reached", sharedRan: true });
  engine.pass({ shared: "none", sharedRan: false });
  Assert.equal(state.folderState, "none", "as a pass with no folder does");
  Assert.equal(state.lastSynced, null);
});

add_task(function a_pass_that_saves_ends_a_failure() {
  const engine = engineStub();
  const state = SvalSyncState.of(engine);
  engine.fail(new Error("denied"));
  Assert.equal(state.saveFailures, 1, "saving is failing");
  engine.fail(new Error("denied"));
  Assert.equal(state.saveFailures, 2, "twice in a row");

  engine.step({ shared: "reached", sharedRan: true });
  Assert.equal(state.saveFailures, 2, "a step saves nothing here");
  engine.pass({ shared: "reached", sharedRan: false });
  Assert.equal(state.saveFailures, 0, "a pass saved");
});

add_task(function the_keys_state_starts_from_what_the_engine_holds() {
  const { SvalIdentity } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalIdentity.sys.mjs"
  );
  const { none, present, unreadable } = SvalIdentity.SYNC_KEY_STATES;
  const keyed = { ...engineStub(), syncKey: new Uint8Array(32) };
  Assert.equal(SvalSyncState.of(keyed).keyState, present, "a key is held");

  const state = SvalSyncState.of(engineStub());
  Assert.equal(state.keyState, none, "no key is held");

  let told = 0;
  const observer = () => told++;
  Services.obs.addObserver(observer, SvalSyncState.CHANGED_TOPIC);
  state.setKeyState(unreadable);
  state.setKeyState(unreadable);
  Services.obs.removeObserver(observer, SvalSyncState.CHANGED_TOPIC);
  Assert.equal(state.keyState, unreadable, "a read said why");
  Assert.equal(told, 1, "and a change is told once");
});

add_task(function another_keys_workspaces_are_told_when_they_change() {
  const state = SvalSyncState.of(engineStub());
  let told = 0;
  const observer = () => told++;
  Services.obs.addObserver(observer, SvalSyncState.CHANGED_TOPIC);
  state.setOtherWorkspaces(["theirs"], "/folder");
  state.setOtherWorkspaces(["theirs"], "/folder");
  Assert.equal(told, 1, "the same find is told once");
  state.setOtherWorkspaces([], "/folder");
  Services.obs.removeObserver(observer, SvalSyncState.CHANGED_TOPIC);
  Assert.equal(told, 2, "and a dismissal is told");
  Assert.deepEqual(state.otherWorkspaces, []);
  Assert.equal(state.otherWorkspacesIn, "/folder");
});

add_task(function a_window_with_no_engine_reads_an_empty_state() {
  Assert.equal(SvalSyncState.none.folderState, "none");
  Assert.equal(SvalSyncState.none.lastPass, null);
  Assert.equal(SvalSyncState.none.keyState, null);
  Assert.ok(Object.isFrozen(SvalSyncState.none), "which nothing writes");
});
