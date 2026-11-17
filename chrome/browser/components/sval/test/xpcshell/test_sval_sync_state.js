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

add_task(function an_outage_is_timed_from_its_first_step() {
  const engine = engineStub();
  const state = SvalSyncState.of(engine);
  engine.step({ shared: "unreachable", sharedRan: true, sharedReason: "gone" });
  const since = state.unreachableSince;
  Assert.notEqual(since, null, "the outage began");
  Assert.equal(state.folderProblem, "gone");
  engine.step({ shared: "unreachable", sharedRan: true, sharedReason: "gone" });
  Assert.equal(state.unreachableSince, since, "and is one outage");

  engine.step({ shared: "unknown", sharedRan: true });
  Assert.equal(state.folderState, "unreachable", "no answer changes nothing");

  engine.step({ shared: "reached", sharedRan: true });
  Assert.equal(state.unreachableSince, null, "an answer ends it");
  Assert.equal(state.folderProblem, null);
});

add_task(function an_unreadable_own_file_starts_no_wait() {
  const engine = engineStub();
  const state = SvalSyncState.of(engine);
  engine.step({
    shared: "unreachable",
    sharedRan: true,
    sharedReason: "own-file",
  });
  Assert.equal(state.folderState, "unreachable");
  Assert.equal(state.unreachableSince, null, "the folder answered");
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
  engine.pass({
    shared: "unreachable",
    sharedRan: false,
    sharedReason: "gone",
  });
  Assert.equal(state.folderState, "unreachable");
  Assert.equal(state.folderProblem, "gone");
  Assert.equal(state.unreachableSince, null, "when it began is not known");
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
  const since = state.saveFailingSince;
  Assert.notEqual(since, null, "saving is failing");
  engine.fail(new Error("denied"));
  Assert.equal(state.saveFailingSince, since, "since the first failure");

  engine.step({ shared: "reached", sharedRan: true });
  Assert.equal(state.saveFailingSince, since, "a step saves nothing here");
  engine.pass({ shared: "reached", sharedRan: false });
  Assert.equal(state.saveFailingSince, null, "a pass saved");
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
  Services.obs.addObserver(observer, SvalIdentity.SYNC_KEY_STATE_TOPIC);
  state.setKeyState(unreadable);
  state.setKeyState(unreadable);
  Services.obs.removeObserver(observer, SvalIdentity.SYNC_KEY_STATE_TOPIC);
  Assert.equal(state.keyState, unreadable, "a read said why");
  Assert.equal(told, 1, "and a change is told once");
});

add_task(function a_window_with_no_engine_reads_an_empty_state() {
  Assert.equal(SvalSyncState.none.folderState, "none");
  Assert.equal(SvalSyncState.none.lastPass, null);
  Assert.equal(SvalSyncState.none.keyState, null);
  Assert.ok(Object.isFrozen(SvalSyncState.none), "which nothing writes");
});
