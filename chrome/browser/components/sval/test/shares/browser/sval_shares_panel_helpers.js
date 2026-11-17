/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../../sval-panel.js */
/* import-globals-from head.js */

/**
 * What the panel's real-share files share (real-share tests spec §3.3).
 *
 * Test code touches a share with IOUtils only while that share is restored: a
 * process that reads a hung mount through IOUtils stalls its own I/O queue.
 * Only Sval's helper reaches a share during a fault, and nothing here creates a
 * link inside a run directory. Each file loads this with `loadSubScript` into
 * its own scope.
 */

/* exported SvalIdentity, SvalSharedFolder, SHARED_STEP_TIMEOUT_MS, FAULT_STEP_MS, UNREACHABLE_WITHIN_MS, the_job_is_configured_or_off, shareTask, folderIs, ask, askLimitMs, askUntil, limitSteps, requireIdle, restoreShare, shareChosen */

const { SvalIdentity } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalIdentity.sys.mjs"
);
const { SvalSharedFolder, SHARED_STEP_TIMEOUT_MS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
);

// The panel's limit for a shared step while its share is faulted, as the hang
// suite's (real-share tests spec §3.3, test 3). A step on a hard NFS mount
// waits out its whole limit, and what these tasks check does not depend on
// how long that is. A step that must reach the share keeps the product's
// limit, because a real helper on a loaded runner can take longer than this
// just to start (`SvalEngine.sharedStepTimeoutMs`).
const FAULT_STEP_MS = 8000;

// The step that finds a dropped share ends at SHARED_STEP_TIMEOUT_MS at the
// latest, and the helper's own start can take a few seconds on a loaded runner.
const UNREACHABLE_WITHIN_MS = SHARED_STEP_TIMEOUT_MS + 15000;

// What a pass needs besides its shared step: the profile's passes and the
// redraw, on a loaded runner.
const PASS_MARGIN_MS = 5000;

/** The engine's limit for a shared step, as this file last set it. */
let stepMs = SHARED_STEP_TIMEOUT_MS;

/**
 * Sets the engine's limit for a shared step, which bounds each `ask`.
 *
 * @param {number} ms The limit.
 */
function limitSteps(ms) {
  SvalPanel.engine.sharedStepTimeoutMs = ms;
  stepMs = ms;
}

/**
 * The most one `ask` may take: a pass that waits for the folder joins the
 * step already running, or waits it out and runs its own
 * (`SvalEngine.sync`), so two steps at their limit, and the pass around them.
 *
 * @returns {number}
 */
function askLimitMs() {
  return 2 * stepMs + PASS_MARGIN_MS;
}

// A misconfigured job skips every share task, and the_job_is_configured_or_off
// fails with the reason, so the output names the problem.
const unavailable = share => () => {
  try {
    return !Shares.config?.[share];
  } catch (ex) {
    return true;
  }
};

/**
 * Fails, naming the reason, when the share job is misconfigured; each file
 * runs it as its first task.
 */
async function the_job_is_configured_or_off() {
  try {
    const config = Shares.config;
    Assert.ok(
      config === null || !!config.run,
      "the share job is off or fully configured"
    );
  } catch (ex) {
    Assert.ok(false, `the share job is misconfigured: ${ex.message}`);
  }
}

/** What the running task set up and must take down before the next starts. */
const teardown = [];

function atEnd(fn) {
  teardown.push(fn);
}

/**
 * Resolves once no helper is alive, or with false after `ms`.
 *
 * @param {number} ms How long to wait.
 * @returns {Promise<boolean>} whether the helper slot is free.
 */
async function idleWithin(ms) {
  try {
    await TestUtils.waitForCondition(
      () => !SvalSharedFolder.busy,
      "the helper went",
      100,
      Math.ceil(ms / 100)
    );
    return true;
  } catch (ex) {
    return false;
  }
}

/**
 * Waits for the helper to go and throws, naming the reason, when it does not,
 * so a stuck one reads as itself and not as the harness timing the file out.
 *
 * @param {number} ms How long the helper may take.
 * @param {string} when What the wait follows.
 */
async function requireIdle(ms, when) {
  if (!(await idleWithin(ms))) {
    SvalSharedFolder.killLive();
    throw new Error(`a helper was alive ${ms} ms ${when}`);
  }
}

/**
 * Restores `share` and waits until it answers again: the restore first,
 * because a helper stuck in a dropped hard NFS mount exits only when the share
 * answers, then a bounded wait for the helper, then the settle the Windows
 * SMB client needs.
 *
 * @param {string} share "nfs" or "smb".
 */
async function restoreShare(share) {
  await Shares.control("restore", share);
  await requireIdle(Shares.reconnectMs, "after the restore");
  await Shares.settle();
}

/**
 * Runs `body` as a task for `share`. However it ends, the share is restored
 * and the task's panel fixture comes down.
 *
 * @param {string} share "nfs" or "smb".
 * @param {Function} body The task, called with the share.
 */
function shareTask(share, body) {
  const task = {
    async [`${share}_${body.name}`]() {
      try {
        await body(share);
      } finally {
        try {
          limitSteps(SHARED_STEP_TIMEOUT_MS);
          await restoreShare(share);
        } finally {
          while (teardown.length) {
            try {
              await teardown.pop()();
            } catch (ex) {
              Assert.ok(false, `teardown failed: ${ex}`);
            }
          }
        }
      }
    },
  }[`${share}_${body.name}`];
  add_task({ skip_if: unavailable(share) }, task);
}

/**
 * Waits for the panel to hear what the shared folder said.
 *
 * A launch starts its first shared step in the background, so the answer
 * arrives after `_start` has returned.
 *
 * @param {string} state The `folderState` to wait for.
 */
async function folderIs(state) {
  await TestUtils.waitForCondition(
    () => SvalPanel.syncState.folderState === state,
    `the panel hears that the folder is ${state}`,
    100,
    UNREACHABLE_WITHIN_MS / 100
  );
}

/**
 * What the shared folder says when asked now. A pass that outlives its
 * steps' limit fails here, naming itself.
 *
 * @returns {Promise<string|null>} "reached", "unreachable" or "unknown".
 */
function ask() {
  return within(
    SvalPanel.syncWithFolder(),
    askLimitMs(),
    "a pass that waits for the shared folder"
  );
}

/**
 * Asks until the shared folder says `state`, or the time a step needs to find
 * a dropped share has passed. Windows' SMB client keeps an established session
 * for a few seconds after the firewall blocks it, so the first ask after a
 * drop can still be answered.
 *
 * @param {string} state The answer to wait for.
 * @returns {Promise<string|null>} The last answer.
 */
async function askUntil(state) {
  const deadline = Date.now() + UNREACHABLE_WITHIN_MS;
  let answer = await ask();
  while (answer !== state && Date.now() < deadline) {
    await TestUtils.waitForTick();
    answer = await ask();
  }
  return answer;
}

/**
 * This window's panel sharing a run directory on `share`, chosen as
 * Settings' Change… chooses a folder, with a workspace of the task's and its
 * tab published there. The shared folder the panel had is chosen again when
 * the task ends.
 *
 * @param {string} share "nfs" or "smb".
 * @returns {Promise<object>} `{ shared, ws, tab }`.
 */
async function shareChosen(share) {
  await requireIdle(SHARED_STEP_TIMEOUT_MS, "before the task began");
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const shared = await Shares.runDir(share, "panel");
  await IOUtils.makeDirectory(PathUtils.join(shared, "sval"));
  const { present } = SvalIdentity.SYNC_KEY_STATES;
  if ((await SvalIdentity.syncKey()).state !== present) {
    await SvalIdentity.adoptSyncKey(crypto.getRandomValues(new Uint8Array(32)));
  }
  if (SvalPanel.syncKeyState !== present) {
    await within(SvalPanel.run("retrySyncKey"), 30_000, "the key read");
  }
  const before = SvalPanel.sharedRootSetting();
  atEnd(() =>
    within(
      SvalPanel.chooseSharedFolder(before),
      UNREACHABLE_WITHIN_MS,
      "choosing the earlier folder again"
    )
  );
  const { engine } = SvalPanel;
  const ws = await engine.mutate({
    kind: "addWorkspace",
    name: "Kept",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  const tab = await engine.mutate({
    kind: "addTab",
    parent: ws,
    name: "A page",
    url: "https://example.com/kept",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  atEnd(() => engine.mutate({ kind: "remove", id: ws, now: Date.now() }));
  const chosen = await within(
    SvalPanel.chooseSharedFolder(shared),
    UNREACHABLE_WITHIN_MS,
    "the share chosen"
  );
  Assert.ok(chosen.reached, "the share is reached and holds the copy");
  await requireIdle(SHARED_STEP_TIMEOUT_MS, "after the share was chosen");
  return { shared, ws, tab };
}
