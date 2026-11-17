/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * A link from another app whose address is a download (link routing spec
 * §4): one whose file extension names a type Gecko does not show opens in
 * the frontmost window and never in a peek, and one whose response turns out
 * to be a download closes its peek. Either way the download opens the
 * window's Downloads panel, and no peek or empty tab is left. A page or a PDF
 * stays in its peek. Agent access holds a peek's first load, so the response
 * check runs with it on too. A download from a page a peek shows is the
 * peek's: its own downloads button and panel announce it.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);
const { SvalPeek } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPeek.sys.mjs"
);
const { SvalLinkDownloads } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLinkDownloads.sys.mjs"
);
const { HttpServer } = ChromeUtils.importESModule(
  "resource://testing-common/httpd.sys.mjs"
);

const RED = ROOT + "sval_agent_red.html";
const PDF = ROOT + "sval_agent_doc.pdf";

/**
 * A server whose addresses have no file extension, or the one named, so the
 * type is the response's to say.
 */
const server = new HttpServer();
const respond = (type, disposition) => (request, response) => {
  response.setHeader("Content-Type", type, false);
  if (disposition) {
    response.setHeader("Content-Disposition", disposition, false);
  }
  response.write("a file from another app\n");
};
server.registerPathHandler(
  "/attachment",
  respond("text/plain", 'attachment; filename="attached.txt"')
);
server.registerPathHandler("/binary", respond("application/octet-stream"));
server.registerPathHandler("/archive.zip", respond("application/zip"));
server.start(-1);
registerCleanupFunction(() => new Promise(resolve => server.stop(resolve)));
const BASE = `http://localhost:${server.identity.primaryPort}`;

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
});

/** Turns agent access on for the task, as Settings › Agents does. */
async function agentAccessOn() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.sval.agents.enabled", true]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  await TestUtils.waitForCondition(() => SvalAgents.store, "access is open");
}

/**
 * Saves the task's downloads in a folder of its own, and takes every
 * download off the list and closes the Downloads panel when the task ends.
 *
 * @returns {Promise<object>} The downloads list.
 */
async function downloadsGoToATempFolder() {
  const dir = await makeTempDir("sval-peek-downloads");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.download.dir", dir],
      ["browser.download.folderList", 2],
      ["browser.download.useDownloadDir", true],
      ["browser.download.always_ask_before_handling_new_types", false],
      ["browser.download.alwaysOpenPanel", true],
    ],
  });
  const list = await Downloads.getList(Downloads.ALL);
  const panel = document.getElementById("downloadsPanel");
  atTaskEnd(async () => {
    if (panel.state !== "closed") {
      const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
      DownloadsPanel.hidePanel();
      await within(hidden, 10_000, "the downloads panel closing");
    }
    for (const download of await list.getAll()) {
      await download.finalize(true).catch(() => {});
      await list.remove(download);
    }
    await IOUtils.remove(dir, { recursive: true });
    await SpecialPowers.popPrefEnv();
  });
  return list;
}

/**
 * Every window that opens from now until the task ends.
 *
 * @returns {Window[]}
 */
function windowsOpening() {
  const opened = [];
  const observer = (subject, topic) => {
    if (topic === "domwindowopened") {
      opened.push(subject);
    }
  };
  Services.ww.registerNotification(observer);
  atTaskEnd(() => Services.ww.unregisterNotification(observer));
  return opened;
}

/**
 * @returns {Promise} This window's Downloads panel opening, within the time
 *   a download from another app takes to start.
 */
function panelOpens() {
  return within(
    BrowserTestUtils.waitForPopupEvent(
      document.getElementById("downloadsPanel"),
      "shown"
    ),
    30_000,
    "the Downloads panel opening on its own"
  );
}

/**
 * Waits for the download of `url` to finish, and for this window's Downloads
 * panel to open on its own and list it.
 *
 * @param {object} list
 * @param {string} url
 * @param {Promise} shown From {@link panelOpens}, called before the link
 *   was opened.
 * @returns {Promise<object>} The download.
 */
async function announcedHere(list, url, shown) {
  let download;
  await TestUtils.waitForCondition(async () => {
    download = (await list.getAll()).find(d => d.source.url === url);
    return download?.succeeded;
  }, `${url} is downloaded`);
  await shown;
  Assert.ok(
    BrowserTestUtils.isVisible(document.getElementById("downloads-button")),
    "the header's downloads button shows"
  );
  const name = PathUtils.filename(download.target.path);
  await TestUtils.waitForCondition(
    () =>
      [...DownloadsView.richListBox.itemChildren].some(
        row => row.querySelector(".downloadTarget")?.value === name
      ),
    "the panel lists it"
  );
  return download;
}

/**
 * Opens `url` as a link from another app whose response is a download, and
 * checks its peek closes and this window announces the download.
 *
 * @param {string} url
 */
async function peekClosesForDownload(url) {
  const list = await downloadsGoToATempFolder();
  const tabs = gBrowser.tabs.length;
  const shown = panelOpens();
  const opened = BrowserTestUtils.domWindowOpened();
  runCommandLine(["-url", url]);
  const peek = await within(opened, 20_000, "the peek opening");
  Assert.ok(SvalPeek.isOpening(peek), "the link opened a peek");
  await within(
    BrowserTestUtils.domWindowClosed(peek),
    20_000,
    "the peek closing once its page is a download"
  );
  await announcedHere(list, url, shown);
  Assert.equal(SvalPeek.windows().length, 0, "no peek is left");
  Assert.equal(gBrowser.tabs.length, tabs, "and no tab opened here");
}

add_task(async function an_attachment_closes_its_peek() {
  await peekClosesForDownload(`${BASE}/attachment`);
});

add_task(async function a_binary_response_closes_its_peek() {
  await peekClosesForDownload(`${BASE}/binary`);
});

add_task(async function with_agent_access_on_a_download_closes_its_peek() {
  await agentAccessOn();
  await peekClosesForDownload(`${BASE}/attachment`);
});

add_task(async function an_address_named_as_a_download_never_opens_a_peek() {
  const url = `${BASE}/archive.zip`;
  Assert.ok(
    !SvalLinkDownloads.rendersInline(Services.io.newURI(url)),
    "Gecko shows no page of a ZIP file"
  );
  const list = await downloadsGoToATempFolder();
  const tabs = gBrowser.tabs.length;
  const shown = panelOpens();
  const opened = windowsOpening();
  runCommandLine(["-url", url]);
  await announcedHere(list, url, shown);
  await TestUtils.waitForCondition(
    () => gBrowser.tabs.length === tabs,
    "the tab opened for it closes"
  );
  Assert.deepEqual(opened, [], "no window opened");
});

/**
 * Opens `url` as a link from another app and waits for its peek to show it.
 *
 * @param {string} url
 * @returns {Promise<Window>}
 */
async function peekShows(url) {
  const opened = BrowserTestUtils.waitForNewWindow();
  runCommandLine(["-url", url]);
  const win = await within(opened, 20_000, "the peek");
  atTaskEnd(async () => {
    if (!win.closed) {
      await within(
        BrowserTestUtils.closeWindow(win),
        10_000,
        "the peek closing"
      );
    }
  });
  Assert.ok(SvalPeek.isPeek(win), "a peek");
  await pageReady(win.gBrowser.selectedBrowser, url);
  return win;
}

add_task(async function a_page_and_a_pdf_stay_in_their_peeks() {
  const list = await downloadsGoToATempFolder();
  for (const url of [RED, PDF]) {
    Assert.ok(
      SvalLinkDownloads.rendersInline(Services.io.newURI(url)),
      `Gecko shows ${url}`
    );
    const win = await peekShows(url);
    Assert.ok(!win.closed, "the peek stays open");
    Assert.equal(win.gBrowser.selectedTab.isEmpty, false, "showing its page");
  }
  Assert.deepEqual(await list.getAll(), [], "nothing was downloaded");
});

/**
 * Clicks a link to `url` in the page `win` shows.
 *
 * @param {Window} win
 * @param {string} url
 */
async function clickLinkIn(win, url) {
  await SpecialPowers.spawn(win.gBrowser.selectedBrowser, [url], href => {
    const link = content.document.createElement("a");
    link.href = href;
    link.textContent = "a file";
    content.document.body.append(link);
    link.click();
  });
}

/**
 * @param {Window} win
 * @returns {string[]} The file names `win`'s Downloads panel lists.
 */
function listedIn(win) {
  return [...win.DownloadsView.richListBox.itemChildren].map(
    row => row.querySelector(".downloadTarget")?.value
  );
}

add_task(async function a_download_from_a_peeks_page_shows_in_the_peek() {
  const list = await downloadsGoToATempFolder();
  const peek = await peekShows(RED);
  const button = () => peek.document.getElementById("downloads-button");
  Assert.ok(
    !BrowserTestUtils.isVisible(button()),
    "a Peek with no downloads of its own shows no downloads button"
  );

  await clickLinkIn(peek, `${BASE}/attachment`);
  await TestUtils.waitForCondition(
    () => peek.document.getElementById("downloadsPanel")?.state === "open",
    "the Peek's Downloads panel opens on its own"
  );
  Assert.ok(BrowserTestUtils.isVisible(button()), "its downloads button shows");
  await TestUtils.waitForCondition(
    () => listedIn(peek).includes("attached.txt"),
    "the Peek's panel lists the download"
  );
  Assert.notEqual(
    document.getElementById("downloadsPanel")?.state,
    "open",
    "the window behind the Peek opens no panel"
  );

  await clickLinkIn(peek, `${BASE}/binary`);
  await TestUtils.waitForCondition(
    () => listedIn(peek).length === 2,
    "a second download joins the Peek's list"
  );
  await TestUtils.waitForCondition(
    async () => (await list.getAll()).every(d => d.succeeded),
    "both are downloaded"
  );
  Assert.ok(!peek.closed, "the Peek stays open on its page");
  Assert.ok(
    peek.document.getElementById("sval-downloads-views") === null ||
      !BrowserTestUtils.isVisible(
        peek.document.getElementById("sval-downloads-views")
      ),
    "the panel offers no switch between workspaces"
  );

  const panelHidden = BrowserTestUtils.waitForPopupEvent(
    peek.document.getElementById("downloadsPanel"),
    "hidden"
  );
  peek.DownloadsPanel.hidePanel();
  await within(panelHidden, 10_000, "the Peek's Downloads panel closing");
  const narrowest = 720;
  peek.resizeBy(narrowest - peek.innerWidth, 0);
  await TestUtils.waitForCondition(
    () => peek.innerWidth === narrowest,
    `the Peek ${narrowest}px wide`
  );
  const doc = peek.document;
  Assert.ok(
    !doc.getElementById("nav-bar").hasAttribute("overflowing"),
    "at the narrowest, the downloads button stays in the row"
  );
  const main = doc.getElementById("sval-peek-open-main");
  Assert.lessOrEqual(
    main.scrollWidth,
    main.clientWidth,
    "and the open button shows all it holds"
  );
});
