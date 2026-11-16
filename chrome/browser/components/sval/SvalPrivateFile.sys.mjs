/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Writes a file only its owner can read, for the files that hold a key or a
 * secret: the device's local key, the profile's secrets file, the agents'
 * files and the sync key's backup.
 */

/**
 * Writes `bytes` at `path` with mode 0600. In the profile, the directory
 * around the file is what keeps other users out; the mode keeps the file
 * private wherever else it is, such as a directory the user chose or a backup
 * it was copied into.
 *
 * The temporary file is created with mode 0600 (`IOUtils.createUniqueFile`,
 * which opens with `O_CREAT | O_EXCL` and that mode), so no other user can
 * open it before or while it is filled, and under a random name, so nothing
 * planted beside the target can take the name and block the write. An
 * `"overwrite"` write to an existing file truncates it and keeps its mode, and
 * moving it into place is atomic and keeps the mode too.
 *
 * The filling write is flushed (`flush` opens with `PR_SYNC`), so the bytes
 * are on disk before the move makes them the file: a power loss after the
 * move leaves the new contents, never a renamed empty file in place of the
 * old ones.
 *
 * On Windows a create mode only decides read-only (`OpenFile` in
 * xpcom/io/nsLocalFileWin.cpp), so 0600 leaves the file writable, and the
 * directory's DACL, which the file inherits, is what keeps other users out.
 *
 * A `mode` other than 0600 is given to the filled file before the move, so
 * the file at `path` never has another.
 *
 * @param {string} path
 * @param {Uint8Array} bytes
 * @param {object} [options]
 * @param {number} [options.mode] The file's permissions, 0600 by default.
 * @returns {Promise<void>}
 */
export async function writePrivateFile(path, bytes, { mode = 0o600 } = {}) {
  const suffix = crypto.getRandomValues(new Uint8Array(8)).toHex();
  const tmpPath = await IOUtils.createUniqueFile(
    PathUtils.parent(path),
    `${PathUtils.filename(path)}.${suffix}.tmp`,
    0o600
  );
  try {
    await IOUtils.write(tmpPath, bytes, { mode: "overwrite", flush: true });
    if (mode !== 0o600) {
      await IOUtils.setPermissions(tmpPath, mode, false);
    }
    await IOUtils.move(tmpPath, path);
  } catch (err) {
    await IOUtils.remove(tmpPath, { ignoreAbsent: true }).catch(() => {});
    throw err;
  }
}

/**
 * {@link writePrivateFile} for a value written as JSON, as `IOUtils.writeJSON`
 * writes it.
 *
 * @param {string} path
 * @param {object} value
 * @returns {Promise<void>}
 */
export function writePrivateJSON(path, value) {
  return writePrivateFile(
    path,
    new TextEncoder().encode(JSON.stringify(value))
  );
}
