/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * about:processes shows nothing of a private session it is outside of: no
 * site on that session's process and no row for one of its documents. That
 * holds in a normal window and in another private window. The page shows a
 * normal window's site and tab, and a private window's own.
 */

const { SvalPrivateProcesses } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPrivateProcesses.sys.mjs"
);

const PRIVATE_SITE = "https://example.org/";
const NORMAL_SITE = "https://example.com/";

/**
 * @param {Document} doc about:processes' document.
 * @returns {object[]} What each of its rows was drawn from.
 */
function rowsOf(doc) {
  return [...doc.querySelectorAll("#process-tbody tr")];
}

add_task(async function a_normal_window_lists_nothing_of_a_private_window() {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20_000,
    "a private window opening"
  );
  atTaskEnd(
    () =>
      !win.closed &&
      within(BrowserTestUtils.closeWindow(win), 10_000, "the window closing")
  );
  const privateTab = await openPage(PRIVATE_SITE, win);
  const privateId = privateTab.linkedBrowser.outerWindowID;
  const normalTab = await openPage(NORMAL_SITE);
  const normalId = normalTab.linkedBrowser.outerWindowID;

  const info = await ChromeUtils.requestProcInfo();
  const serving = id =>
    info.children.find(child =>
      child.windows.some(shown => shown.outerWindowId === id)
    );
  const privateProcess = serving(privateId);
  Assert.ok(privateProcess, "Gecko reports the private page's process");
  Assert.stringContains(
    privateProcess.origin,
    "example.org",
    "by the private window's site"
  );

  // In this window: with a string alone, the tab opens in the window used
  // last, which is the private one.
  // about:processes draws nothing while its window is covered, as this one
  // is by the private window.
  await uncovered(window);
  const inThisWindow = { gBrowser, url: "about:processes" };
  await BrowserTestUtils.withNewTab(inThisWindow, async browser => {
    const doc = browser.contentDocument;
    const view = browser.contentWindow;
    await within(
      TestUtils.waitForCondition(() =>
        rowsOf(doc).some(row => row.win?.outerWindowId === normalId)
      ),
      15_000,
      "the page listing the normal window's tab"
    );
    const rows = rowsOf(doc);
    Assert.ok(
      !rows.some(row => row.win?.outerWindowId === privateId),
      "the private window's tab has no row"
    );
    const drawn = rows.find(row => row.process?.pid === privateProcess.pid);
    Assert.ok(drawn, "the private window's process is listed");
    Assert.equal(drawn.process.origin, "", "with no site");
    Assert.deepEqual(drawn.process.windows, [], "and no documents");
    Assert.ok(
      !doc.getElementById("process-tbody").textContent.includes("example.org"),
      "the page names the private window's site nowhere"
    );
    Assert.ok(
      rows.some(row => row.process?.origin.includes("example.com")),
      "a normal window's process keeps its site"
    );

    Assert.equal(
      SvalPrivateProcesses.originFor(view, privateProcess.origin),
      "",
      "a normal window is told no site for the private process"
    );
  });

  const privateViewer = await openPage("about:processes", win);
  Assert.equal(
    SvalPrivateProcesses.originFor(
      privateViewer.linkedBrowser.contentWindow,
      privateProcess.origin
    ),
    privateProcess.origin,
    "the page opened in a private window is told what Gecko reports"
  );
  Assert.ok(
    SvalPrivateProcesses.windowsFor(
      privateViewer.linkedBrowser.contentWindow,
      privateProcess
    ).some(shown => shown.outerWindowId === privateId),
    "and lists the private window's documents"
  );
  BrowserTestUtils.removeTab(normalTab);
});

add_task(async function a_private_window_lists_nothing_of_another() {
  const [first, second] = await within(
    Promise.all([
      BrowserTestUtils.openNewBrowserWindow({ private: true }),
      BrowserTestUtils.openNewBrowserWindow({ private: true }),
    ]),
    20_000,
    "two private windows opening"
  );
  atTaskEnd(async () => {
    for (const win of [first, second]) {
      if (!win.closed) {
        await within(
          BrowserTestUtils.closeWindow(win),
          10_000,
          "a private window closing"
        );
      }
    }
  });
  const tab = await openPage(PRIVATE_SITE, first);
  const id = tab.linkedBrowser.outerWindowID;
  const info = await ChromeUtils.requestProcInfo();
  const process = info.children.find(child =>
    child.windows.some(shown => shown.outerWindowId === id)
  );
  Assert.ok(process, "Gecko reports the first window's page");

  const other = await openPage("about:processes", second);
  const view = other.linkedBrowser.contentWindow;
  Assert.equal(
    SvalPrivateProcesses.originFor(view, process.origin),
    "",
    "another private window is told no site for the process"
  );
  Assert.deepEqual(
    SvalPrivateProcesses.windowsFor(view, process),
    [],
    "and none of its documents"
  );
  Assert.ok(
    !other.linkedBrowser.contentDocument
      .getElementById("process-tbody")
      .textContent.includes("example.org"),
    "its page names the first window's site nowhere"
  );
});
