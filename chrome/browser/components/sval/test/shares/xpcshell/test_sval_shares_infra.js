/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { makeTempDir } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

// This directory is not one of Mozilla's xpcshell lint paths, so the harness
// globals are declared here.
/* global add_task, Assert, registerCleanupFunction, do_get_profile */

// A shared-folder request travels through a directory in the profile
// (`SvalSharedFolder`'s `requestDir`), so these tests run with one.
do_get_profile();

/**
 * The share infrastructure answers before any Sval test relies on it
 * (real-share tests spec §5).
 */

const { SvalSharesTestUtils: Shares, NETWORK_FS } = ChromeUtils.importESModule(
  "resource://testing-common/SvalSharesTestUtils.sys.mjs"
);
const { SvalSharedFolder } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
);
const { waitForCondition } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);
const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);

// A misconfigured job skips every share task, and the_job_is_configured_or_off
// fails with the reason, so the output names the problem.
const notConfigured = () => {
  try {
    return !Shares.config;
  } catch (ex) {
    return true;
  }
};

// What a helper may answer when the share refuses it: its own error, a missing
// folder, Sval giving up at its deadline, or the helper's own 25 s limit
// (backgroundTaskTimeoutSec) ending it first, which Sval reports as
// "helper-failed". A dropped share is never taken for success, because the
// write must also answer reachable: true once restored, and a helper that
// cannot start fails that check.
const REFUSED = ["timeout", "missing", "io-error", "helper-failed"];

registerCleanupFunction(async () => {
  if (!notConfigured()) {
    await Shares.control("restore");
    await Shares.settle();
    await Shares.cleanRun();
  }
});

/**
 * Runs fn with the share environment set to `vars`, then puts it back.
 *
 * @param {object} vars The variables to set; the rest are cleared.
 * @param {Function} fn What to run.
 * @returns {Promise<any>} What fn returns.
 */
async function withShareEnv(vars, fn) {
  const names = [
    "SVAL_CI_SHARES",
    "SVAL_CI_SHARE_CONTROL",
    "SVAL_CI_SHARES_RUN",
    "SVAL_CI_SHARE_NFS",
    "SVAL_CI_SHARE_SMB",
  ];
  const saved = names.map(name => Services.env.get(name));
  names.forEach(name => Services.env.set(name, vars[name] ?? ""));
  try {
    return await fn();
  } finally {
    names.forEach((name, i) => Services.env.set(name, saved[i]));
  }
}

const SHARE_ENV = {
  SVAL_CI_SHARES: "1",
  SVAL_CI_SHARE_CONTROL: "http://127.0.0.1:1",
  SVAL_CI_SHARES_RUN: "sweep-7-linux",
};

add_task(async function the_job_is_configured_or_off() {
  try {
    const config = Shares.config;
    Assert.ok(
      config === null || !!config.run,
      "the share job is off or fully configured"
    );
  } catch (ex) {
    Assert.ok(false, `the share job is misconfigured: ${ex.message}`);
  }
});

add_task(
  { skip_if: () => AppConstants.platform == "win" },
  async function a_local_directory_is_not_taken_for_a_network_share() {
    const dir = await makeTempDir("sval-shares-local");
    try {
      const type = await Shares.fsType(dir);
      Assert.ok(type, "stat names a file system type");
      Assert.ok(!NETWORK_FS.includes(type), `${type} is not a network type`);
    } finally {
      await IOUtils.remove(dir, { recursive: true });
    }
  }
);

add_task(async function a_job_with_no_share_fails_loudly() {
  await withShareEnv({ ...SHARE_ENV }, () => {
    Assert.throws(
      () => Shares.config,
      /needs SVAL_CI_SHARE_NFS or SVAL_CI_SHARE_SMB/,
      "SVAL_CI_SHARES=1 without any share is an error"
    );
  });
  await withShareEnv(
    { ...SHARE_ENV, SVAL_CI_SHARES_RUN: "../escape-linux" },
    () => {
      Assert.throws(
        () => Shares.config,
        /plain directory name/,
        "a run name cannot leave the share"
      );
    }
  );
});

add_task(async function an_unmounted_root_never_becomes_a_local_directory() {
  const base = await makeTempDir("sval-shares-test");
  try {
    const missing = PathUtils.join(base, "not", "mounted");
    await withShareEnv(
      { ...SHARE_ENV, SVAL_CI_SHARE_NFS: missing },
      async () => {
        await Assert.rejects(
          Shares.runDir("nfs", "x"),
          /share root missing/,
          "runDir refuses a root that does not exist"
        );
      }
    );
    Assert.ok(
      !(await IOUtils.exists(PathUtils.join(base, "not"))),
      "no ancestor of the root was created"
    );

    const root = PathUtils.join(base, "mounted");
    await IOUtils.makeDirectory(root);
    await withShareEnv({ ...SHARE_ENV, SVAL_CI_SHARE_NFS: root }, async () => {
      const dir = await Shares.runDir("nfs", "x");
      Assert.equal(
        PathUtils.parent(PathUtils.parent(dir)),
        root,
        "the directory is <root>/<run>/<name>"
      );
      Assert.ok(await IOUtils.exists(dir), "it exists");
      await Shares.cleanRun();
      Assert.ok(
        !(await IOUtils.exists(PathUtils.parent(dir))),
        "cleanRun removes the run directory"
      );
    });
  } finally {
    await IOUtils.remove(base, { recursive: true });
  }
});

add_task(async function sweeping_removes_only_old_run_directories() {
  const root = await makeTempDir("sval-shares-sweep");
  try {
    const day = 24 * 3600 * 1000;
    const old = Date.now() - 3 * day;
    const dirs = {
      oldLinux: "100-1-linux",
      oldWindows: "101-1-windows",
      oldMacos: "102-1-macos",
      fresh: "200-1-linux",
      unrelated: "photos",
      suffixOnly: "backup-linux.bak",
    };
    for (const name of Object.values(dirs)) {
      await IOUtils.makeDirectory(PathUtils.join(root, name, "inner"));
      await IOUtils.writeUTF8(PathUtils.join(root, name, "inner", "f"), "x");
    }
    const aFile = PathUtils.join(root, "999-1-linux-file-linux");
    await IOUtils.writeUTF8(aFile, "x");
    for (const name of [
      dirs.oldLinux,
      dirs.oldWindows,
      dirs.oldMacos,
      dirs.unrelated,
      dirs.suffixOnly,
    ]) {
      await IOUtils.setModificationTime(PathUtils.join(root, name), old);
    }
    await IOUtils.setModificationTime(aFile, old);

    await withShareEnv({ ...SHARE_ENV, SVAL_CI_SHARE_SMB: root }, async () => {
      Assert.equal(await Shares.sweepStaleRuns(), 3, "the stale runs removed");
      Assert.equal(await Shares.sweepStaleRuns(), 0, "nothing more to remove");
    });

    Assert.ok(!(await IOUtils.exists(PathUtils.join(root, dirs.oldLinux))));
    Assert.ok(!(await IOUtils.exists(PathUtils.join(root, dirs.oldWindows))));
    Assert.ok(!(await IOUtils.exists(PathUtils.join(root, dirs.oldMacos))));
    for (const name of [dirs.fresh, dirs.unrelated, dirs.suffixOnly]) {
      Assert.ok(
        await IOUtils.exists(PathUtils.join(root, name, "inner", "f")),
        `${name} stays`
      );
    }
    Assert.ok(
      await IOUtils.exists(aFile),
      "an old file named like a run stays"
    );
  } finally {
    await IOUtils.remove(root, { recursive: true });
  }
});

add_task({ skip_if: notConfigured }, async function the_switch_answers() {
  const state = await Shares.control("restore");
  for (const share of Shares.shares()) {
    Assert.equal(state[share], "normal", `${share} starts restored`);
  }
});

add_task(
  { skip_if: notConfigured },
  async function each_share_root_is_a_mounted_directory() {
    Assert.greater(Shares.shares().length, 0, "a share is configured");
    for (const share of Shares.shares()) {
      const root = Shares.config[share];
      Assert.ok(await IOUtils.exists(root), `${share} root exists`);
      Assert.equal(
        (await IOUtils.stat(root)).type,
        "directory",
        `${share} root is a directory`
      );
      if (AppConstants.platform != "win") {
        const type = await Shares.fsType(root);
        Assert.ok(
          NETWORK_FS.includes(type),
          `${share} root is a network mount (${type})`
        );
      } else if (AppConstants.platform == "win") {
        Assert.ok(root.startsWith("\\\\"), `${share} root is a network path`);
      }
    }
  }
);

add_task(
  { skip_if: notConfigured },
  async function each_platform_has_its_own_run_directory() {
    Assert.ok(
      Shares.config.run.endsWith(`-${Shares.platform}`),
      "the run directory names its platform"
    );
  }
);

add_task(
  { skip_if: notConfigured },
  async function a_dropped_share_refuses_and_a_restored_one_answers() {
    for (const share of Shares.shares()) {
      const dir = await Shares.runDir(share, "infra");
      const root = PathUtils.parent(dir);
      const leaf = PathUtils.filename(dir);
      // An SMB drop errors only after 10 to 20 s, and a hard NFS mount hangs
      // until the deadline, so the helper gets longer than either.
      const write = () =>
        SvalSharedFolder.writeFile({
          root,
          path: `${leaf}/probe.json`,
          bytes: new Uint8Array([1]),
          requireTop: null,
          deadline: Date.now() + 30000,
        });

      let restored = false;
      const restore = async () => {
        await Shares.control("restore", share);
        restored = true;
        await SvalSharedFolder._whenIdle();
        await Shares.settle();
      };
      try {
        await Shares.control("drop", share, 60);
        const refused = await write();
        Assert.equal(
          refused.reachable,
          false,
          `${share}: refused while dropped`
        );
        Assert.ok(
          REFUSED.includes(refused.reason),
          `${share}: refused for an unreachable-share reason`
        );
        await restore();
        const answered = await write();
        Assert.equal(
          answered.reachable,
          true,
          `${share}: answers once restored`
        );
      } finally {
        if (!restored) {
          await restore();
        }
        await IOUtils.remove(dir, { recursive: true });
      }
    }
  }
);

add_task(
  { skip_if: notConfigured },
  async function a_fault_lifts_itself_when_nobody_restores_it() {
    const [share] = Shares.shares();
    Assert.ok(share, "a share is configured, so the fault names it");
    await Shares.control("drop", share, 3);
    await waitForCondition(
      async () => (await Shares.state())[share] == "normal",
      "the fault lifted by itself",
      500,
      20
    );
    await Shares.settle();
  }
);
