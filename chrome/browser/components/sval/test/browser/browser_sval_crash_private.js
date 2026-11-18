/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

// A crash keeps no minidump while private browsing is in use
// (private-browsing-no-crash-dump.patch): a minidump holds the memory of the
// process that crashed, which could hold a private window's pages. A private
// tab's process writes none, and the parent removes the one a process every
// window shares leaves while a private window is open. A utility process and
// the process for local files stand for those here: a headless run has no GPU
// process. A normal window's site keeps its report throughout. The parent's
// own crash takes the same flag and ends the run, so nothing here drives it.

const CRASH_PAGE = `${PAGE}?svalcrashprivate`;

const utilityProcessTest = Cc[
  "@mozilla.org/utility-process-test;1"
].createInstance(Ci.nsIUtilityProcessTest);

/**
 * @returns {string[]} The paths of the minidumps and `.extra` files in the
 *   folder a test run's crashes are written to and in the folder of reports
 *   waiting to be sent.
 */
function crashFiles() {
  const dumps = Services.dirsvc.get("ProfD", Ci.nsIFile);
  dumps.append("minidumps");
  const pending = Services.dirsvc.get("UAppData", Ci.nsIFile);
  pending.append("Crash Reports");
  pending.append("pending");
  const paths = [];
  for (const dir of [dumps, pending]) {
    if (!dir.exists()) {
      continue;
    }
    for (const file of dir.directoryEntries) {
      if (/\.(dmp|extra)$/.test(file.leafName)) {
        paths.push(file.path);
      }
    }
  }
  return paths.sort();
}

/**
 * Crashes a utility process, starting one when none runs.
 *
 * @returns {Promise<string>} The id of the report the crash left, or "" when
 *   it left none.
 */
async function crashedUtilityProcess() {
  const pid = await within(
    utilityProcessTest.startProcess(),
    15_000,
    "a utility process starting"
  );
  SimpleTest.expectChildProcessCrash();
  const gone = TestUtils.topicObserved(
    "ipc:utility-shutdown",
    (subject, data) => parseInt(data, 10) === pid
  );
  Cc["@mozilla.org/processtools-service;1"]
    .getService(Ci.nsIProcessToolsService)
    .crash(pid);
  const [subject] = await within(gone, 30_000, "the utility process crashing");
  utilityProcessTest.noteIntentionalCrash(pid);
  subject.QueryInterface(Ci.nsIPropertyBag2);
  return subject.hasKey("dumpID") ? subject.get("dumpID") : "";
}

async function openPrivateWindow() {
  return within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    15_000,
    "a private window opening"
  );
}

add_task(async function a_private_tabs_crash_leaves_no_report() {
  const before = crashFiles();
  const win = await openPrivateWindow();
  const browser = win.gBrowser.selectedBrowser;
  BrowserTestUtils.startLoadingURIString(browser, CRASH_PAGE);
  await pageReady(browser, CRASH_PAGE);

  const extra = await within(
    BrowserTestUtils.crashFrame(browser),
    30_000,
    "the private tab's process crashing"
  );
  Assert.deepEqual(extra, {}, "the crash has no report");
  Assert.deepEqual(crashFiles(), before, "and left no minidump or .extra");

  const doc = browser.contentDocument;
  Assert.equal(
    doc.documentURI.split("?")[0],
    "about:tabcrashed",
    "the crashed-tab page shows"
  );
  Assert.ok(
    BrowserTestUtils.isHidden(doc.getElementById("sendReport")),
    "with no box to send a report"
  );
  Assert.ok(
    BrowserTestUtils.isVisible(doc.getElementById("restoreTab")),
    "and its button to restore the tab"
  );
});

add_task(
  async function a_shared_process_crash_leaves_no_report_while_a_private_window_is_open() {
    const before = crashFiles();
    const win = await openPrivateWindow();
    Assert.equal(
      await crashedUtilityProcess(),
      "",
      "with a private window open, the crash has no report"
    );
    Assert.deepEqual(crashFiles(), before, "and left no minidump or .extra");

    const lastPrivateContextGone = TestUtils.topicObserved(
      "last-pb-context-exited"
    );
    await within(
      BrowserTestUtils.closeWindow(win),
      15_000,
      "the private window closing"
    );
    await within(
      lastPrivateContextGone,
      15_000,
      "the last private browsing context going"
    );

    const dumpID = await crashedUtilityProcess();
    Assert.ok(dumpID, "with none open, the crash has a report");
    await within(
      Services.crashmanager.ensureCrashIsPresent(dumpID),
      15_000,
      "the crash manager recording the crash"
    );
    const dumps = Services.dirsvc.get("ProfD", Ci.nsIFile);
    dumps.append("minidumps");
    for (const suffix of [".dmp", ".extra"]) {
      const file = dumps.clone();
      file.append(dumpID + suffix);
      Assert.ok(file.exists(), `and left its ${suffix} file`);
      file.remove(false);
    }
  }
);

add_task(
  async function a_normal_sites_crash_keeps_its_report_while_a_private_window_is_open() {
    await openPrivateWindow();
    const tab = await openPage(CRASH_PAGE);
    const extra = await within(
      BrowserTestUtils.crashFrame(tab.linkedBrowser),
      30_000,
      "the normal tab's process crashing"
    );
    Assert.ok(extra.ProcessType, "the crash has a report");
  }
);

add_task(
  async function a_local_files_crash_leaves_no_report_while_a_private_window_is_open() {
    // Local files of every window share one process, which a private
    // window's file could be in.
    const before = crashFiles();
    await openPrivateWindow();
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(getTestFilePath("sval_agent_page.html"));
    const url = Services.io.newFileURI(file).spec;
    // The harness links its files into place, so the page's own address is
    // the linked file's, and the tab is waited for by its load alone.
    const tab = await within(
      BrowserTestUtils.openNewForegroundTab(gBrowser, url),
      15_000,
      "the local file opening"
    );
    Assert.equal(
      tab.linkedBrowser.remoteType,
      "file",
      "the page is in the process for local files"
    );
    const extra = await within(
      BrowserTestUtils.crashFrame(tab.linkedBrowser),
      30_000,
      "the local file's process crashing"
    );
    Assert.deepEqual(extra, {}, "the crash has no report");
    Assert.deepEqual(crashFiles(), before, "and left no minidump or .extra");
  }
);
