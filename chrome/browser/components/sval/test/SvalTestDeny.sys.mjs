/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Takes a file's read, or a directory's write or listing, away from the
 * test's own user, so a test can provoke the refusal a real disk gives, and
 * gives it back.
 *
 * On macOS and Linux that is the file mode. Windows ignores the mode
 * (`nsLocalFile::SetPermissions` sets only the read-only attribute there), so
 * there a deny entry for Everyone goes on the path's access list through
 * `icacls`, and is removed again. A deny entry binds administrators too. It
 * names the data rights alone, so the path can still be renamed, removed and
 * stat'd, as a file a real disk refuses to read can.
 *
 * Root ignores the mode, so a denial that does not take throws: a test whose
 * premise does not hold fails, naming the cause, and never passes having
 * asserted nothing. CI's Linux suites run as an unprivileged user
 * (`scripts/as-test-user.sh`) for this reason.
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
});

/** Everyone's well-known SID, which `icacls` takes with a leading `*`. */
const EVERYONE = "*S-1-1-0";

/** The mode each path had before it was denied, to put back on POSIX. */
const modes = new Map();

/** The paths given a deny entry on Windows, to take it off again. */
const deniedOnWindows = new Set();

async function icacls(args) {
  const command = PathUtils.join(
    Services.env.get("SystemRoot"),
    "System32",
    "icacls.exe"
  );
  const proc = await lazy.Subprocess.call({
    command,
    arguments: args,
    stderr: "stdout",
  });
  let output = "";
  let chunk;
  while ((chunk = await proc.stdout.readString())) {
    output += chunk;
  }
  const { exitCode } = await proc.wait();
  if (exitCode !== 0) {
    throw new Error(`icacls ${args.join(" ")} exited ${exitCode}: ${output}`);
  }
}

async function deny(path, mode, right) {
  if (AppConstants.platform == "win") {
    await icacls([path, "/deny", `${EVERYONE}:(${right})`]);
    deniedOnWindows.add(path);
    return;
  }
  if (!modes.has(path)) {
    modes.set(path, (await IOUtils.stat(path)).permissions);
  }
  await IOUtils.setPermissions(path, mode);
}

async function refused(probe) {
  try {
    await probe();
    return false;
  } catch {
    return true;
  }
}

function notDenied(path) {
  return new Error(
    `${path} was denied and is still usable: a test that needs a refusal ` +
      `cannot run as root (run it through scripts/as-test-user.sh)`
  );
}

export const SvalTestDeny = {
  /**
   * Makes `path`, a file, unreadable to this user.
   *
   * @param {string} path
   */
  async read(path) {
    await deny(path, 0o000, "RD");
    if (!(await refused(() => IOUtils.read(path)))) {
      throw notDenied(path);
    }
  },

  /**
   * Makes `dir` refuse a new file from this user. Its files stay writable.
   *
   * @param {string} dir
   */
  async write(dir) {
    await deny(dir, 0o555, "WD,AD");
    const probe = PathUtils.join(dir, "sval-deny-probe");
    if (!(await refused(() => IOUtils.writeUTF8(probe, "x")))) {
      await IOUtils.remove(probe);
      throw notDenied(dir);
    }
  },

  /**
   * Makes `dir` refuse to list its entries to this user. What is inside
   * stays reachable by path.
   *
   * @param {string} dir
   */
  async list(dir) {
    await deny(dir, 0o311, "RD");
    if (!(await refused(() => IOUtils.getChildren(dir)))) {
      throw notDenied(dir);
    }
  },

  /**
   * Gives back what {@link read}, {@link write} or {@link list} took. A path never denied,
   * or already given back, is left as it is.
   *
   * @param {string} path
   */
  async allow(path) {
    if (AppConstants.platform == "win") {
      if (!deniedOnWindows.delete(path)) {
        return;
      }
      if (await IOUtils.exists(path)) {
        await icacls([path, "/remove:d", EVERYONE]);
      }
      return;
    }
    const mode = modes.get(path);
    if (mode === undefined) {
      return;
    }
    modes.delete(path);
    if (await IOUtils.exists(path)) {
      await IOUtils.setPermissions(path, mode);
    }
  },
};
