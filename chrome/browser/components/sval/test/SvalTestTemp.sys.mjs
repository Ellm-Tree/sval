/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Unique paths in the temporary directory for Sval's tests.
 *
 * Nothing here removes what it makes. `scripts/test.sh` gives each run a
 * temporary directory of its own and removes it when the run ends, so the
 * random part of each name is what keeps one test's files apart from
 * another's in the same run.
 *
 *   const { makeTempDir, tempPath } = ChromeUtils.importESModule(
 *     "resource://testing-common/SvalTestTemp.sys.mjs"
 *   ).SvalTestTemp;
 */

function uniqueName(prefix, suffix) {
  if (!prefix.startsWith("sval-")) {
    throw new Error(`a test temporary name starts with "sval-": ${prefix}`);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${hex}${suffix}`;
}

export const SvalTestTemp = {
  /**
   * Makes an empty directory in the temporary directory.
   *
   * @param {string} prefix The start of its name, beginning `sval-`.
   * @returns {Promise<string>} Its path.
   */
  async makeTempDir(prefix) {
    const path = PathUtils.join(PathUtils.tempDir, uniqueName(prefix, ""));
    await IOUtils.makeDirectory(path, { ignoreExisting: false });
    return path;
  },

  /**
   * A path in the temporary directory that nothing exists at yet.
   *
   * @param {string} prefix The start of its name, beginning `sval-`.
   * @param {string} [suffix] The end of its name, such as `.json`.
   * @returns {string} The path.
   */
  tempPath(prefix, suffix = "") {
    return PathUtils.join(PathUtils.tempDir, uniqueName(prefix, suffix));
  },
};
