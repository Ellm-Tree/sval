/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * How the import readers open another browser's files (import spec §4).
 * Nothing here writes under the directory it reads: an artifact build of Sval
 * can resolve its own profile root to another browser's.
 *
 * - A plain file (JSON, a property list, a session log) is read where it is.
 *   IOUtils and `PropertyListUtils` open it read-only.
 * - A SQLite database the import page only shows a count from is read where
 *   it is through `MigrationUtils.getRowsFromDBWithoutLocks`, which opens it
 *   immutable and unlocked. That ignores the database's write-ahead log, so
 *   what a running browser has written since its last checkpoint is missing
 *   from such a read.
 * - A SQLite database whose rows are imported is copied with its journal and
 *   write-ahead log, and the copy is opened, so those rows are there.
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
  MigrationUtils: "resource:///modules/MigrationUtils.sys.mjs",
  PropertyListUtils: "resource://gre/modules/PropertyListUtils.sys.mjs",
  Sqlite: "resource://gre/modules/Sqlite.sys.mjs",
});

/** SQLite's companion files, whose contents a copy needs to be current. */
const SIDECARS = ["-journal", "-wal", "-shm"];

/**
 * Whether a reader's error is the other browser holding its file open. On
 * Windows a running Chrome or Edge holds its current session log without
 * sharing it for reading, so Sval's read of it fails with NotAllowedError
 * until that browser quits.
 *
 * @param {Error} err What a reader threw, its underlying error as `cause`.
 * @returns {boolean}
 */
export function heldOpen(err) {
  return (
    AppConstants.platform === "win" && err?.cause?.name === "NotAllowedError"
  );
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
export async function isDirectory(path) {
  try {
    return (await IOUtils.stat(path)).type === "directory";
  } catch {
    return false;
  }
}

/**
 * A property list's root, read where it is.
 *
 * @param {string} path
 * @returns {Promise<*>} Its root, dictionaries as Maps, or null when absent.
 * @throws {Error} when the file exists and is not a property list.
 */
export async function readPlist(path) {
  if (!(await IOUtils.exists(path))) {
    return null;
  }
  const root = await new Promise(resolve =>
    lazy.PropertyListUtils.read(new lazy.FileUtils.File(path), resolve)
  );
  if (root === null) {
    throw new Error("not a property list");
  }
  return root;
}

/**
 * Rows from a SQLite database, read where it is, for what the import page
 * shows. See this module's comment for what such a read misses.
 *
 * @param {string} path
 * @param {string} query
 * @returns {Promise<object[]|null>} The rows, or null when there is no
 *   database.
 */
export async function rowsInPlace(path, query) {
  if (!(await IOUtils.exists(path))) {
    return null;
  }
  return lazy.MigrationUtils.getRowsFromDBWithoutLocks(path, "import", query);
}

/**
 * Runs `read` on a read-only connection to a copy of a SQLite database, taken
 * with its companions, and removes the copy afterwards.
 *
 * @param {string} path
 * @param {Function} read Called with the connection; its result is returned.
 * @returns {Promise<*>} `read`'s result, or null when there is no database.
 */
export async function withCopy(path, read) {
  if (!(await IOUtils.exists(path))) {
    return null;
  }
  // A copy keeps its source's mode (`nsLocalFile::CopyToNative`), which
  // only the profile directory's 0700 kept private, and on Linux every user
  // shares the temporary directory (`GetSpecialSystemDirectory`).
  const temp = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "sval-import",
    0o700
  );
  let db = null;
  try {
    const copy = PathUtils.join(temp, PathUtils.filename(path));
    await IOUtils.copy(path, copy);
    for (const suffix of SIDECARS) {
      if (await IOUtils.exists(path + suffix)) {
        await IOUtils.copy(path + suffix, copy + suffix);
      }
    }
    db = await lazy.Sqlite.openConnection({ path: copy, readOnly: true });
    return await read(db);
  } finally {
    await db?.close();
    await IOUtils.remove(temp, { recursive: true, ignoreAbsent: true });
  }
}
