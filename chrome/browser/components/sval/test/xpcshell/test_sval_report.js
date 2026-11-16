/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The report's log (messages spec §4): the log files, older first.
 */

"use strict";

const { makeTempDir } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

const { SvalReport } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalReport.sys.mjs"
);
const { SVAL_LOG_FILE, SVAL_LOG_FILE_OLD } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLog.sys.mjs"
);

add_setup(() => {
  do_get_profile();
});

add_task(async function report_log_holds_both_files_older_first() {
  const dir = await makeTempDir("sval-report");
  await IOUtils.writeUTF8(PathUtils.join(dir, SVAL_LOG_FILE_OLD), "older\n");
  await IOUtils.writeUTF8(PathUtils.join(dir, SVAL_LOG_FILE), "newer\n");

  const text = await SvalReport.log({ dir });
  const older = text.indexOf("older");
  const newer = text.indexOf("newer");
  Assert.ok(
    older >= 0 && newer > older,
    "the log holds both files, older first"
  );
});

/** A file the log has not written is left out rather than failing. */
add_task(async function a_missing_file_is_skipped() {
  const dir = await makeTempDir("sval-report-new");
  await IOUtils.writeUTF8(PathUtils.join(dir, SVAL_LOG_FILE), "only\n");
  const text = await SvalReport.log({ dir });
  Assert.ok(text.includes("only"), "the one file is there");
});

/** With no log folder, the report carries no log. */
add_task(async function no_folder_is_no_log() {
  Assert.equal(await SvalReport.log({ dir: null }), "", "nothing is read");
});
