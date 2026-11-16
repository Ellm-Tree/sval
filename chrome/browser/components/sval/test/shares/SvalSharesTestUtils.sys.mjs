/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The real-share suite's configuration and its fault switch (real-share tests
 * spec §3). The nightly job sets SVAL_CI_SHARES=1 and says where each share is
 * mounted and where its runner's switch listens; without it every task skips.
 *
 * Test code touches a share with IOUtils only while that share is restored: a
 * process that reads a hung NFS mount through IOUtils stalls its own I/O queue.
 */

import { Subprocess } from "resource://gre/modules/Subprocess.sys.mjs";
import {
  explained,
  waitForCondition,
  within,
} from "resource://testing-common/SvalTestWait.sys.mjs";

// How long a share takes to answer again after the switch restores it: the
// Windows SMB client keeps failing for about 30 s, macOS's reconnects within
// about 10 s, and the Linux mounts answer within a few
// seconds. A wait for the share after a restore is bounded by this and a
// margin.
const RECONNECT_MS = Services.appinfo.OS == "WINNT" ? 30000 : 10000;
const RECONNECT_MARGIN_MS = 10000;
const SETTLE_POLL_MS = 2000;

// The file system names a network mount has: from `stat -f` on Linux, and
// from mount(8) on macOS.
export const NETWORK_FS = [
  "nfs",
  "nfs4",
  "cifs",
  "smb",
  "smb2",
  "smb3",
  "smbfs",
];

// A run directory is named `<run id>-<platform>`.
const RUN_NAME = /^[\w.]+(-[\w.]+)*-(linux|windows|macos)$/;

const WINDOWS = () => Services.appinfo.OS == "WINNT";

export const SvalSharesTestUtils = {
  get config() {
    if (Services.env.get("SVAL_CI_SHARES") !== "1") {
      return null;
    }
    const control = Services.env.get("SVAL_CI_SHARE_CONTROL");
    const run = Services.env.get("SVAL_CI_SHARES_RUN");
    if (!control || !run) {
      throw new Error(
        "SVAL_CI_SHARES=1 needs SVAL_CI_SHARE_CONTROL and SVAL_CI_SHARES_RUN"
      );
    }
    // The run name is one path component, so it can never point outside a
    // share's root.
    if (!/^[\w][\w.-]*$/.test(run)) {
      throw new Error("SVAL_CI_SHARES_RUN is not a plain directory name");
    }
    const nfs = Services.env.get("SVAL_CI_SHARE_NFS") || null;
    const smb = Services.env.get("SVAL_CI_SHARE_SMB") || null;
    if (!nfs && !smb) {
      throw new Error(
        "SVAL_CI_SHARES=1 needs SVAL_CI_SHARE_NFS or SVAL_CI_SHARE_SMB: a suite with no share would pass without testing one"
      );
    }
    // Where the Windows job's relay can hang the SMB share: the share's
    // path through it, and its switch.
    const smbHang = Services.env.get("SVAL_CI_SHARE_SMB_HANG") || null;
    const hangControl = Services.env.get("SVAL_CI_SHARE_HANG_CONTROL") || null;
    return { nfs, smb, control, run, smbHang, hangControl };
  },

  /**
   * The configuration, or null when there is none or it is broken: every
   * share task then skips, and test_sval_shares_infra.js fails the job with
   * the reason.
   */
  get configOrNull() {
    try {
      return this.config;
    } catch {
      return null;
    }
  },

  /**
   * @param {string} share `"nfs"` or `"smb"`.
   * @returns {boolean} whether this job has `share`.
   */
  has(share) {
    return !!this.configOrNull?.[share];
  },

  /**
   * Whether the job can hang `share`: stop the server answering while the
   * client's connection stays up. The Windows switch's firewall rule resets
   * the connection, so on Windows only the relay hangs the SMB share.
   *
   * @param {string} share `"nfs"` or `"smb"`.
   * @returns {boolean}
   */
  hangs(share) {
    return !!this.hangTarget(share);
  },

  /**
   * Where to hang `share`, or null when the job cannot.
   *
   * @param {string} share `"nfs"` or `"smb"`.
   * @returns {{root: string, control: string}|null} The share's root to work
   *   in, and the switch that hangs it there.
   */
  hangTarget(share) {
    const config = this.configOrNull;
    if (!config?.[share]) {
      return null;
    }
    if (!WINDOWS()) {
      return { root: config[share], control: config.control };
    }
    if (share == "smb" && config.smbHang && config.hangControl) {
      return { root: config.smbHang, control: config.hangControl };
    }
    return null;
  },

  /** @returns {string} The platform a run directory's name ends in. */
  get platform() {
    switch (Services.appinfo.OS) {
      case "WINNT":
        return "windows";
      case "Darwin":
        return "macos";
      default:
        return "linux";
    }
  },

  /**
   * @param {number} n
   * @returns {Uint8Array} `n` random bytes.
   */
  bytes(n) {
    return crypto.getRandomValues(new Uint8Array(n));
  },

  /**
   * A file's cleanup: every share restored, Sval's helper gone, the shares
   * settled, and this run's directories removed.
   */
  async restoreAndClean() {
    if (!this.configOrNull) {
      return;
    }
    const { SvalSharedFolder } = ChromeUtils.importESModule(
      "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
    );
    await this.control("restore");
    if (this.config.hangControl) {
      await this.control("restore", "smb", 180, this.config.hangControl);
    }
    // A helper stuck on a faulted share exits once the share answers, and an
    // SMB client can keep failing for half a minute after a restore.
    await within(
      SvalSharedFolder._whenIdle(),
      this.reconnectMs,
      "the helper's exit after the restore"
    );
    await this.settle();
    await this.cleanRun();
  },

  shares() {
    const config = this.config;
    return config ? ["nfs", "smb"].filter(share => config[share]) : [];
  },

  /**
   * Runs curl against the switch and parses the JSON it answers.
   *
   * @param {string[]} args curl arguments before the URL.
   * @param {string} url The switch's URL, path and query included.
   * @param {string} what What the call was for, for the error message.
   * @returns {Promise<object>}
   */
  async _curl(args, url, what) {
    const curl = await Subprocess.pathSearch(WINDOWS() ? "curl.exe" : "curl");
    const proc = await Subprocess.call({
      command: curl,
      arguments: ["-fsS", ...args, "--max-time", "10", url],
      stderr: "pipe",
    });
    let out = "";
    let chunk;
    while ((chunk = await proc.stdout.readString())) {
      out += chunk;
    }
    let err = "";
    while ((chunk = await proc.stderr.readString())) {
      err += chunk;
    }
    const { exitCode } = await proc.wait();
    if (exitCode !== 0) {
      throw new Error(
        `share ${what} exited ${exitCode}: ${err.trim().slice(0, 200)}`
      );
    }
    try {
      return JSON.parse(out);
    } catch (ex) {
      throw new Error(
        `share ${what} answered something other than JSON: ${out.slice(0, 200)}`
      );
    }
  },

  /**
   * @param {string} verb "drop", "hang" or "restore".
   * @param {string} share "nfs", "smb" or "all".
   * @param {number} ttl Seconds until the fault lifts itself.
   * @param {string} control The switch, the job's own when absent.
   * @returns {Promise<object>} The switch's state.
   */
  async control(verb, share = "all", ttl = 180, control = this.config.control) {
    // The Windows switch answers 411 to a POST that has no body.
    const body = WINDOWS() ? ["-d", "{}"] : [];
    return this._curl(
      ["-X", "POST", ...body],
      `${control}/${verb}?share=${share}&ttl=${ttl}`,
      `control ${verb} ${share}`
    );
  },

  async state() {
    return this._curl([], `${this.config.control}/state`, "state");
  },

  /** How long a share may take to answer after a restore. */
  get reconnectMs() {
    return RECONNECT_MS + RECONNECT_MARGIN_MS;
  },

  /**
   * After a restore, polls until a probe write and remove succeed on every
   * configured share, because an SMB client reconnects some seconds after the
   * switch restores the share. A probe on a share that has not come back can
   * block, and `waitForCondition` ends the wait on time all the same. Call it
   * only after a restore that followed a fault.
   */
  async settle() {
    for (const share of this.shares()) {
      let last = "not probed";
      await explained(
        waitForCondition(
          async () => (last = await this._probe(share)) === true,
          `${share} answering again after the restore`,
          SETTLE_POLL_MS,
          Math.ceil(this.reconnectMs / SETTLE_POLL_MS)
        ),
        () => ({ last })
      );
    }
  },

  /**
   * The file system type of the mount holding `path`: `stat -f` on Linux, and
   * the deepest mount(8) entry holding it on macOS.
   *
   * @param {string} path
   * @returns {Promise<string>}
   */
  async fsType(path) {
    const mac = Services.appinfo.OS == "Darwin";
    const proc = await Subprocess.call({
      command: mac ? "/sbin/mount" : await Subprocess.pathSearch("stat"),
      arguments: mac ? [] : ["-f", "-c", "%T", path],
      stderr: "pipe",
    });
    let out = "";
    let chunk;
    while ((chunk = await proc.stdout.readString())) {
      out += chunk;
    }
    let err = "";
    while ((chunk = await proc.stderr.readString())) {
      err += chunk;
    }
    const { exitCode } = await proc.wait();
    if (exitCode !== 0) {
      throw new Error(
        `${mac ? "mount" : "stat -f"} exited ${exitCode}: ${err.trim().slice(0, 200)}`
      );
    }
    if (!mac) {
      return out.trim();
    }
    let deepest = null;
    for (const line of out.split("\n")) {
      const match = / on (\/.*?) \(([^,)]+)/.exec(line);
      if (!match) {
        continue;
      }
      const [, point, type] = match;
      const holds =
        point == "/" || path == point || path.startsWith(point + "/");
      if (holds && (!deepest || point.length > deepest.point.length)) {
        deepest = { point, type };
      }
    }
    return deepest?.type ?? "";
  },

  /**
   * Whether `share`'s root is the network share and not the empty local
   * directory an unmounted mount point leaves. Windows reaches its share by a
   * UNC path, which is never local.
   *
   * @param {string} share "nfs" or "smb".
   * @returns {Promise<boolean>}
   */
  async mounted(share) {
    if (WINDOWS()) {
      return true;
    }
    return NETWORK_FS.includes(await this.fsType(this.config[share]));
  },

  /**
   * Writes and removes one file in the run directory, once the share is
   * mounted: writing into an unmounted mount point would succeed on the local
   * disk.
   *
   * @param {string} share "nfs" or "smb".
   * @returns {Promise<true|string>} True, or what failed.
   */
  async _probe(share) {
    const root = this.config[share];
    try {
      if (!(await IOUtils.exists(root))) {
        return "the root is missing";
      }
      if (!(await this.mounted(share))) {
        return "the root is not mounted";
      }
      const run = PathUtils.join(root, this.config.run);
      await IOUtils.makeDirectory(run, {
        createAncestors: false,
        ignoreExisting: true,
      });
      const file = PathUtils.join(run, ".settle");
      await IOUtils.writeUTF8(file, "1");
      await IOUtils.remove(file);
      return true;
    } catch (ex) {
      return `${ex.name ?? ex}`;
    }
  },

  /**
   * A fresh directory under `<share>/<run>/`. The share's root must exist, so
   * an unmounted path never turns into a local directory; only the run
   * directory and the new one are created below it.
   *
   * @param {string} share "nfs" or "smb".
   * @param {string} name A prefix for the new directory's name.
   * @param {string} root The share's root, its configured one when absent.
   * @returns {Promise<string>}
   */
  async runDir(share, name, root = this.config[share]) {
    if (!root) {
      throw new Error(`${share} is not configured`);
    }
    if (!(await IOUtils.exists(root))) {
      throw new Error(`${share} share root missing: not mounted?`);
    }
    const run = PathUtils.join(root, this.config.run);
    await IOUtils.makeDirectory(run, {
      createAncestors: false,
      ignoreExisting: true,
    });
    const dir = PathUtils.join(
      run,
      `${name}-${Math.random().toString(36).slice(2, 8)}`
    );
    await IOUtils.makeDirectory(dir, {
      createAncestors: false,
      ignoreExisting: false,
    });
    return dir;
  },

  /** Removes this run's directory from every configured share. */
  async cleanRun() {
    for (const share of this.shares()) {
      const root = this.config[share];
      if (await IOUtils.exists(root)) {
        // On Windows IOUtils.remove recurses through a junction into its
        // target, so nothing may create a junction under a run directory.
        // POSIX unlinks a symlink without following it.
        await IOUtils.remove(PathUtils.join(root, this.config.run), {
          recursive: true,
          ignoreAbsent: true,
        });
      }
    }
  },

  /**
   * Removes run directories that an earlier job left behind: top-level
   * directories of a configured share whose name ends in `-linux`,
   * `-windows` or `-macos` and that nothing has touched for `maxAgeMs`. Everything else
   * stays.
   *
   * @param {number} maxAgeMs How long a run directory must have gone untouched.
   * @returns {Promise<number>} How many directories it removed.
   */
  async sweepStaleRuns(maxAgeMs = 2 * 24 * 3600 * 1000) {
    let removed = 0;
    for (const share of this.shares()) {
      const root = this.config[share];
      if (!(await IOUtils.exists(root))) {
        continue;
      }
      for (const path of await IOUtils.getChildren(root)) {
        if (!RUN_NAME.test(PathUtils.filename(path))) {
          continue;
        }
        const { type, lastModified } = await IOUtils.stat(path);
        if (type != "directory" || Date.now() - lastModified < maxAgeMs) {
          continue;
        }
        // Safe only without junctions, as in cleanRun.
        await IOUtils.remove(path, { recursive: true, ignoreAbsent: true });
        removed++;
      }
    }
    return removed;
  },
};
