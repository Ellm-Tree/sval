/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */

/**
 * A background step that fails is logged, and changes nothing the panel shows
 * (local-copy spec). A waited-for step that fails rejects the pass without
 * telling the failure listeners, which hear only of this device's own copy
 * failing (messages spec §4).
 */

const { failEngineCalls } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestFault.sys.mjs"
);
const { SVAL_LOG_PREFIX } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLog.sys.mjs"
);

const ConsoleAPIStorage = Cc["@mozilla.org/consoleAPI-storage;1"].getService(
  Ci.nsIConsoleAPIStorage
);

/**
 * Starts collecting Sval's console events.
 *
 * @returns {object} `{ events, stop }`: the events so far, which grows as they
 *   are delivered, and the function that ends the collecting.
 */
function listenForSval() {
  const events = [];
  const observe = message => {
    if (message.prefix === SVAL_LOG_PREFIX) {
      events.push(message);
    }
  };
  ConsoleAPIStorage.addLogEventListener(
    observe,
    Cc["@mozilla.org/systemprincipal;1"].createInstance(Ci.nsIPrincipal)
  );
  return {
    events,
    stop: () => ConsoleAPIStorage.removeLogEventListener(observe),
  };
}

add_task(
  async function a_failed_background_step_is_logged_and_changes_nothing() {
    const { make } = await device("failed-step");
    const engine = make();
    await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
    const heard = [];
    const stop = engine.addSharedListener(report => heard.push(report));
    const fault = failEngineCalls(engine, "mergeSnapshot");
    const { events, stop: stopListening } = listenForSval();
    try {
      const report = await engine.sync(WORKSPACE, 2000, {
        shared: "background",
      });
      await waitForStep(
        () =>
          events.some(
            e =>
              e.level == "warn" && /a shared step failed/.test(e.arguments[0])
          ),
        "the failure was logged"
      );
      Assert.equal(
        report.shared,
        "unknown",
        "nothing is claimed of the folder"
      );
      Assert.equal(heard.length, 0, "and no listener was told of a step");
      fault.mend();
      const next = await engine.sync(WORKSPACE, 3000);
      Assert.equal(next.shared, "reached", "the next step runs normally");
    } finally {
      stop();
      stopListening();
    }
  }
);

add_task(async function a_failed_wait_step_is_no_failure_of_the_profile() {
  const { make } = await device("failed-wait-step");
  const engine = make();
  await engine.mutate({ kind: "addWorkspace", name: "Mine", now: 1000 });
  const failed = [];
  const forget = engine.addFailureListener(err => failed.push(err));
  const fault = failEngineCalls(engine, "mergeSnapshot");
  try {
    let rejected = null;
    await Assert.rejects(
      engine
        .sync(WORKSPACE, 2000, { shared: "wait", origin: "a" })
        .catch(err => {
          rejected = err;
          throw err;
        }),
      /injected failure of mergeSnapshot/,
      "the pass rejects"
    );
    Assert.ok(engine.failedInSharedStep(rejected), "in its shared step");
    Assert.deepEqual(failed, [], "and no failure listener hears it");
    fault.mend();
  } finally {
    forget();
  }
});
