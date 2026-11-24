/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_private_helpers.js */

/**
 * A private window's tabs and downloads stay its own (private-windows
 * spec): its tabs never leave it, Switch to Tab stays in it, it lists only
 * its own downloads, and its private page says what lasts.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_private_helpers.js",
  this
);

const SvalDownloadWorkspaces = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalDownloadWorkspaces.sys.mjs"
);

/** Every private session's data this file made goes when the file ends. */
add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  registerCleanupFunction(async () => {
    Services.perms.removeAll();
    await within(
      SvalPrivateJars._clearedForTests(),
      10_000,
      "the private sessions' clears"
    );
  });
});

add_task(async function tabs_stay_in_their_private_window() {
  const a = await openPrivate();
  const b = await openPrivate();
  try {
    const tab = await openIsolationPage(a);
    Assert.equal(b.gBrowser.adoptTab(tab), null, "no move to another one");
    Assert.equal(tab.documentGlobal, a, "the tab stays");
    Assert.equal(a.gBrowser.replaceTabWithWindow(tab), null, "nor out");
    Assert.equal(a.gBrowser.replaceTabsWithWindow(tab), null);
    Assert.ok(!tab.closing, "and stays open");
    const normal = await openIsolationPage(window);
    try {
      Assert.equal(a.gBrowser.adoptTab(normal), null, "nothing moves in");
      Assert.equal(normal.documentGlobal, window);
    } finally {
      BrowserTestUtils.removeTab(normal);
    }
    Assert.ok(
      (await tabMenuItem(a, tab, "context_openTabInWindow")).hidden,
      "Move to New Window is not offered in a private window"
    );
    Assert.ok(
      !(
        await tabMenuItem(
          window,
          gBrowser.selectedTab,
          "context_openTabInWindow"
        )
      ).hidden,
      "and is in a normal one"
    );
  } finally {
    await closePrivate(a);
    await closePrivate(b);
  }
});

/**
 * Switch to tab in a private window offers its own session's tabs alone:
 * another private window's open pages stay out of it.
 */
add_task(async function switch_to_tab_stays_in_its_window() {
  const { UrlbarProviderOpenTabs } = ChromeUtils.importESModule(
    "moz-src:///browser/components/urlbar/UrlbarProviderOpenTabs.sys.mjs"
  );
  const a = await openPrivate();
  const b = await openPrivate();
  try {
    await openIsolationPage(a);
    await TestUtils.waitForCondition(
      () =>
        UrlbarProviderOpenTabs.getOpenTabUrls(true, jarOf(a)).has(
          ISOLATION_PAGE
        ),
      "the page is an open tab of its window's session"
    );
    Assert.ok(
      !UrlbarProviderOpenTabs.getOpenTabUrls(true, jarOf(b)).has(
        ISOLATION_PAGE
      ),
      "another private window is not offered it"
    );
    Assert.ok(
      !UrlbarProviderOpenTabs.getOpenTabUrls(false).has(ISOLATION_PAGE),
      "nor is a normal window"
    );
    Assert.ok(
      !b.switchToTabHavingURI(ISOLATION_PAGE, false),
      "and a switch from there does not reach it"
    );
    Assert.equal(a.gBrowser.tabs.length, 2, "the tab stays where it is");
  } finally {
    await closePrivate(a);
    await closePrivate(b);
  }
});

add_task(async function each_private_window_lists_its_own_downloads() {
  const dir = await makeTempDir("sval-downloads");
  const list = await Downloads.getList(Downloads.PRIVATE);
  const a = await openPrivate();
  const b = await openPrivate();
  let download = null;
  try {
    const inA = await openIsolationPage(a);
    download = await Downloads.createDownload({
      source: {
        url: ISOLATION_PAGE,
        isPrivate: true,
        browsingContextId: inA.linkedBrowser.browsingContext.id,
      },
      target: PathUtils.join(dir, "private.txt"),
      succeeded: true,
    });
    await list.add(download);
    for (const [win, count] of [
      [a, 1],
      [b, 0],
    ]) {
      const panel = win.document.getElementById("downloadsPanel");
      const shown = BrowserTestUtils.waitForPopupEvent(panel, "shown");
      win.DownloadsPanel.showPanel();
      await within(shown, 10_000, "the downloads panel opening");
      await TestUtils.waitForCondition(
        () => !win.DownloadsView.loading,
        "the panel listing"
      );
      Assert.equal(
        win.DownloadsView.richListBox.itemChildren.length,
        count,
        count ? "the window lists its download" : "another lists none of it"
      );
      Assert.ok(
        !win.document.getElementById("sval-downloads-views"),
        "with no view of other windows' downloads"
      );
      const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
      win.DownloadsPanel.hidePanel();
      await within(hidden, 10_000, "the downloads panel closing");
    }
  } finally {
    if (download) {
      await list.remove(download);
      await download.finalize(true).catch(() => {});
    }
    await closePrivate(a);
    await closePrivate(b);
    await IOUtils.remove(dir, { recursive: true });
  }
});

/**
 * @param {Window} win A private window.
 * @param {string} path Where the download's file is, which this writes.
 * @returns {Promise<object>} A finished download a page of `win` started,
 *   on the private list.
 */
async function downloadedIn(win, path) {
  const tab = await openIsolationPage(win);
  await IOUtils.writeUTF8(path, "private");
  const download = await Downloads.createDownload({
    source: {
      url: ISOLATION_PAGE,
      isPrivate: true,
      browsingContextId: tab.linkedBrowser.browsingContext.id,
    },
    target: path,
    succeeded: true,
  });
  await (await Downloads.getList(Downloads.PRIVATE)).add(download);
  return download;
}

/**
 * A private window's downloads end with its session while another private
 * window stays open. Gecko ends them only with the last private window
 * (`DownloadObserver`'s `last-pb-context-exited`).
 */
add_task(async function a_private_windows_downloads_end_with_it() {
  const dir = await makeTempDir("sval-downloads");
  const list = await Downloads.getList(Downloads.PRIVATE);
  const a = await openPrivate();
  const b = await openPrivate();
  try {
    const closedPath = PathUtils.join(dir, "closed.txt");
    const openPath = PathUtils.join(dir, "open.txt");
    const closed = await downloadedIn(a, closedPath);
    const open = await downloadedIn(b, openPath);

    await closePrivate(a);
    await TestUtils.waitForCondition(
      async () => !(await list.getAll()).includes(closed),
      "the closed window's download leaves the private list"
    );
    Assert.ok(
      (await list.getAll()).includes(open),
      "the open window keeps its download"
    );
    Assert.ok(
      await IOUtils.exists(closedPath),
      "the file stays, as the user has not chosen otherwise"
    );
  } finally {
    await closePrivate(a);
    await closePrivate(b);
    await IOUtils.remove(dir, { recursive: true });
  }
});

/**
 * With "Delete files downloaded in a private window when that window
 * closes" on, a private window's files go as it closes, and no other
 * window's do.
 */
add_task(async function a_private_windows_files_go_with_it_when_chosen() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.download.deletePrivate", true]],
  });
  const dir = await makeTempDir("sval-downloads");
  const a = await openPrivate();
  const b = await openPrivate();
  try {
    const closedPath = PathUtils.join(dir, "closed.txt");
    const openPath = PathUtils.join(dir, "open.txt");
    await downloadedIn(a, closedPath);
    await downloadedIn(b, openPath);

    await closePrivate(a);
    await TestUtils.waitForCondition(
      async () => !(await IOUtils.exists(closedPath)),
      "the closed window's file is deleted"
    );
    Assert.ok(await IOUtils.exists(openPath), "the open window's file stays");
  } finally {
    await closePrivate(a);
    await closePrivate(b);
    await IOUtils.remove(dir, { recursive: true });
    await SpecialPowers.popPrefEnv();
  }
});

/**
 * A private download no tab started is listed in the private window in
 * front, so it can always be reached.
 */
add_task(async function a_download_no_tab_started_is_listed() {
  const dir = await makeTempDir("sval-downloads");
  const list = await Downloads.getList(Downloads.PRIVATE);
  const a = await openPrivate();
  const b = await openPrivate();
  let download = null;
  try {
    download = await Downloads.createDownload({
      source: { url: ISOLATION_PAGE, isPrivate: true },
      target: PathUtils.join(dir, "no-tab.txt"),
      succeeded: true,
    });
    a.DownloadsCommon.getData(a);
    await list.add(download);
    await TestUtils.waitForCondition(
      () => SvalDownloadWorkspaces.workspaceOfDownload(download) !== null,
      "the download has a workspace"
    );
    const front = BrowserWindowTracker.getTopWindow({ private: true });
    for (const win of [a, b]) {
      Assert.equal(
        SvalDownloadWorkspaces.listed(win, download),
        win === front,
        win === front
          ? "the private window in front lists it"
          : "the other doesn't"
      );
    }
  } finally {
    if (download) {
      await list.remove(download);
      await download.finalize(true).catch(() => {});
    }
    await closePrivate(a);
    await closePrivate(b);
    await IOUtils.remove(dir, { recursive: true });
  }
});

add_task(async function the_private_page_says_what_lasts() {
  const a = await openPrivate();
  try {
    const browser = a.gBrowser.selectedBrowser;
    const note = await TestUtils.waitForCondition(
      () =>
        SpecialPowers.spawn(
          browser,
          [],
          () => content.document.querySelector(".private-note")?.textContent
        ),
      "the private page's note"
    );
    Assert.ok(note.trim(), "the private page's note says what lasts");
  } finally {
    await closePrivate(a);
  }
});
