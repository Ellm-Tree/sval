/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { makeTempDir } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

// This directory is not one of Mozilla's xpcshell lint paths, so the harness
// globals are declared here.
/* global add_task, Assert, info, registerCleanupFunction, do_timeout, do_get_profile */

// A shared-folder request travels through a directory in the profile
// (`SvalSharedFolder`'s `requestDir`), so these tests run with one.
do_get_profile();

/**
 * A hung share never holds up the profile (real-share tests spec §3.3,
 * test 3), on each share the job can hang (`Shares.hangs`).
 */

const { SvalSharesTestUtils: Shares } = ChromeUtils.importESModule(
  "resource://testing-common/SvalSharesTestUtils.sys.mjs"
);
const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { SvalSharedFolder, SHARED_STEP_TIMEOUT_MS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
);
const { waitForCondition } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);
const { Subprocess } = ChromeUtils.importESModule(
  "resource://gre/modules/Subprocess.sys.mjs"
);
const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);

const WORKSPACE = "workspace-under-test";
const STEP_LIMIT_MS = 8000;

// How long a killed helper may take to be reaped. SIGKILL ends one stuck on a
// hard NFS mount or a cifs mount on Linux at once. A process stuck on macOS's
// SMB client is reaped only once its request gives up, after the client's
// `max_resp_timeout`, 30 s by default (nsmb.conf(5)). One that
// TerminateProcess ended on Windows exits only once the SMB client gives up on
// the connection: 69 s after the hang began on the runner, whose
// `Get-SmbClientConfiguration` has a `SessionTimeout` of 60. Each bound is
// that platform's time and a margin for a loaded runner.
const REAPED_WITHIN_MS =
  10000 + { linux: 0, macosx: 30000, win: 70000 }[AppConstants.platform];

const { bytes } = Shares;

async function localFolder(name) {
  return makeTempDir(`sval-shares-${name}`);
}

registerCleanupFunction(() => Shares.restoreAndClean());

/**
 * The live shared-folder helpers, counted from the process table. Sval's own
 * `busy` says whether a request is queued or running, which cannot show a
 * second process.
 *
 * @returns {Promise<number>}
 */
async function liveHelpers() {
  const proc = await Subprocess.call(
    AppConstants.platform == "win"
      ? {
          command: await Subprocess.pathSearch("tasklist.exe"),
          arguments: [
            "/FI",
            "IMAGENAME eq sval-folder.exe",
            "/FO",
            "CSV",
            "/NH",
          ],
          stderr: "pipe",
        }
      : {
          command: await Subprocess.pathSearch("pgrep"),
          arguments: ["-x", "sval-folder"],
          stderr: "pipe",
        }
  );
  let out = "";
  let chunk;
  while ((chunk = await proc.stdout.readString())) {
    out += chunk;
  }
  await proc.wait();
  // tasklist prints a line starting "INFO:" when nothing matches.
  const prefix = AppConstants.platform == "win" ? '"sval-folder.exe"' : "";
  return out
    .split("\n")
    .filter(line => line.trim() && line.trim().startsWith(prefix)).length;
}

/**
 * Waits for the helper Sval killed to be reaped, and logs how long it took.
 *
 * @param {string} what The wait's description.
 */
async function reaped(what) {
  const start = Date.now();
  await waitForCondition(
    () => !SvalSharedFolder.busy,
    what,
    100,
    REAPED_WITHIN_MS / 100
  );
  info(`${what} ${Date.now() - start} ms after its step ended`);
}

async function hungShareNeverHoldsUpTheProfile(share) {
  const { root, control } = Shares.hangTarget(share);
  const shared = await Shares.runDir(share, "hang", root);
  const local = await localFolder("hang");
  const keyBytes = bytes(32);
  const engine = new SvalEngine({
    root: local,
    sharedRoot: shared,
    keyBytes,
    deviceId: bytes(16),
  });
  try {
    Assert.ok((await engine.markSharedRoot()).reachable, "chosen");
    await engine.mutate({ kind: "addWorkspace", name: "Before", now: 1000 });
    const first = await engine.sync(WORKSPACE, 2000);
    Assert.equal(first.shared, "reached", "the share answers to begin with");

    // Set after the healthy first step, which gets the full limit because a
    // helper on a loaded runner can take longer than the short one to start.
    engine.sharedStepTimeoutMs = STEP_LIMIT_MS;
    await Shares.control("hang", share, 120, control);
    const started = Date.now();
    const id = await engine.mutate({
      kind: "addWorkspace",
      name: "During",
      now: 3000,
    });
    const local1 = await engine.sync(WORKSPACE, 4000, { shared: "skip" });
    Assert.less(Date.now() - started, 1500, "the profile write did not wait");
    Assert.notEqual(local1.wrote, null, "and it was written");

    // A step on a hung share ends at its limit: a fast error would not be a
    // hang given up. `failsFast` allows the client to have failed the step at
    // once.
    const givenUpAtLimit = (report, took, what, failsFast = false) => {
      Assert.equal(report.shared, "unreachable", `${what}: given up`);
      Assert.ok(report.sharedRan, `${what}: a shared step ran`);
      if (!failsFast) {
        Assert.greaterOrEqual(took, STEP_LIMIT_MS - 1000, `${what}: not early`);
      }
      Assert.lessOrEqual(took, STEP_LIMIT_MS + 4000, `${what}: at the limit`);
    };

    let stepStarted = Date.now();
    const hung = await engine.sync(WORKSPACE, 5000);
    givenUpAtLimit(hung, Date.now() - stepStarted, "the first step");
    // The killed helper has to be reaped before another step can start one.
    await reaped("the killed helper went");

    stepStarted = Date.now();
    const second = engine.sync(WORKSPACE, 6000);
    let settled = false;
    second.then(
      () => (settled = true),
      () => (settled = true)
    );
    let most = 0;
    // Sampled every 250 ms for as long as the step may take, and a little more.
    const HELPER_SAMPLES = Math.ceil((STEP_LIMIT_MS + 10_000) / 250);
    await waitForCondition(
      async () => {
        most = Math.max(most, await liveHelpers());
        Assert.lessOrEqual(most, 1, "at most one helper is alive");
        return settled;
      },
      "the second step ending",
      250,
      HELPER_SAMPLES
    );
    Assert.equal(most, 1, "and the count saw the step's helper");
    // A hard NFS mount never fails a request, so the second step waits out its
    // limit too. macOS's SMB client fails new requests at once while it cannot
    // reconnect after the first one timed out.
    givenUpAtLimit(
      await second,
      Date.now() - stepStarted,
      "the second step",
      share != "nfs"
    );
    await reaped("the second killed helper went");

    engine.sharedStepTimeoutMs = SHARED_STEP_TIMEOUT_MS;
    await Shares.control("restore", share, 180, control);
    // macOS's SMB client fails requests until it has reconnected.
    await Shares.settle();
    const back = await engine.sync(WORKSPACE, 7000);
    Assert.equal(back.shared, "reached", "the next step reaches the share");
    const reader = new SvalEngine({
      root: shared,
      keyBytes,
      deviceId: bytes(16),
    });
    try {
      Assert.ok(
        id in JSON.parse(await reader.publishedTree(WORKSPACE)).nodes,
        "and what was made during the hang is on the share"
      );
    } finally {
      reader.terminate();
    }
  } finally {
    engine.terminate();
  }
}

for (const share of ["nfs", "smb"]) {
  add_task(
    { skip_if: () => !Shares.hangs(share) },
    {
      [`a_hung_${share}_share_never_holds_up_the_profile`]: () =>
        hungShareNeverHoldsUpTheProfile(share),
    }[`a_hung_${share}_share_never_holds_up_the_profile`]
  );
}
