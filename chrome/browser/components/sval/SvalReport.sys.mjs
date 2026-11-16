/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Sval's log as a report carries it (messages spec §4): the log files, older
 * first. The log is kept free of what the user browses (`SvalLog`).
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SVAL_LOG_FILE: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  SVAL_LOG_FILE_OLD: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  svalLogDir: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
});

export const SvalReport = {
  /**
   * Sval's log as a report carries it: the files, older first.
   *
   * @param {object} [options]
   * @param {string|null} [options.dir] The folder the log files are in, null
   *   for none; where `SvalLog` writes them unless a test says otherwise.
   * @returns {Promise<string>}
   */
  async log({ dir = lazy.svalLogDir() } = {}) {
    const parts = [];
    for (const name of dir
      ? [lazy.SVAL_LOG_FILE_OLD, lazy.SVAL_LOG_FILE]
      : []) {
      try {
        parts.push(await IOUtils.readUTF8(PathUtils.join(dir, name)));
      } catch {
        // A file the log has not written is left out.
      }
    }
    return parts.join("\n");
  },
};
