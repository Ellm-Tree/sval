/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */

/**
 * A Peek's page opened in an isolated workspace loads its address
 * again in that workspace's jar, whatever kind of page it is (link
 * routing spec §4): a web page, Reader View, a file and an about: page. A page that
 * could not load again there is refused before the window switches.
 */

const { workspaceTitle } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPeek.sys.mjs"
);

const QUICK_PAGE = "https://example.com/browser/?quick-reopen";
const ARTICLE =
  "https://example.com/browser/browser/components/sval/test/browser/sval_reader_article.html";
const READER = `about:reader?url=${encodeURIComponent(ARTICLE)}`;

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
});

/**
 * An isolated workspace named Work, removed when the task ends with the
 * window back on the workspace it showed.
 *
 * @returns {Promise<string>} its id.
 */
async function isolatedWorkspace() {
  const home = SvalPanel.workspaceId;
  const id = await SvalPanel.engine.mutate({
    kind: "addWorkspace",
    name: "Work",
    isolated: true,
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  atTaskEnd(async () => {
    if (SvalPanel.workspaceId !== home) {
      await SvalPanel.switchTo(home);
      await within(
        SvalPanel.observer.settled(),
        10_000,
        "SvalPanel.observer settling"
      );
      // A workspace with no tab of its own opens a blank one when the window
      // switches back to it.
      expectOpened(...gBrowser.tabs);
    }
    await removeWorkspace(id);
    await SvalPanel.refresh();
  });
  await SvalPanel.refresh();
  return id;
}

/**
 * A Peek for a link from another app, which the user has started to
 * go to `url` in.
 *
 * @param {string} url
 * @returns {Promise<Window>}
 */
async function peekGoingTo(url) {
  const opened = BrowserTestUtils.waitForNewWindow({ url: QUICK_PAGE });
  runCommandLine(["-url", QUICK_PAGE]);
  const win = await within(opened, 20_000, "the Peek");
  atTaskEnd(async () => {
    if (!win.closed) {
      await within(
        BrowserTestUtils.closeWindow(win),
        10_000,
        "the Peek closing"
      );
    }
  });
  await TestUtils.waitForCondition(
    () => !win.document.getElementById("sval-peek-open").hidden,
    "its open button names a workspace"
  );
  const browser = win.gBrowser.selectedBrowser;
  BrowserTestUtils.startLoadingURIString(browser, url);
  return win;
}

/**
 * A Peek for a link from another app, showing `url` once the user
 * has gone there in it.
 *
 * @param {string} url
 * @returns {Promise<Window>}
 */
async function peekShowing(url) {
  const win = await peekGoingTo(url);
  await pageReady(win.gBrowser.selectedBrowser, url);
  return win;
}

/**
 * Picks Work from the Peek's menu of other workspaces.
 *
 * @param {Window} win A Peek.
 * @returns {Promise<Document>} the dialog the Peek answers with.
 */
async function pickWork(win) {
  const doc = win.document;
  const menu = doc.getElementById("sval-peek-menu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  doc.getElementById("sval-peek-open-more").click();
  await within(shown, 10_000, "the menu of other workspaces");
  const row = [...menu.querySelectorAll(".sval-peek-menu-row")].find(each =>
    each
      .querySelector(".sval-peek-menu-label")
      .textContent.includes(workspaceTitle("Work"))
  );
  Assert.ok(row, "it offers the isolated workspace");
  row.click();
  await TestUtils.waitForCondition(
    () => win.gDialogBox.dialog && !win.gDialogBox.dialog._isClosing,
    "the Peek answers with a dialog"
  );
  await dialogShown(win.gDialogBox.dialog, "the dialog");
  return win.gDialogBox.dialog._frame.contentDocument;
}

/**
 * Opens the Peek's page in Work, agreeing to the reload.
 *
 * @param {Window} win A Peek.
 * @param {string} id Work's id.
 * @returns {Promise<Element>} the tab it opened in, selected.
 */
async function openInWork(win, id) {
  const question = await pickWork(win);
  Assert.ok(
    question
      .getElementById("sval-dialog-title")
      .textContent.includes(workspaceTitle("Work")),
    "it asks about Work"
  );
  Assert.ok(
    question.querySelector('button[data-button="cancel"]'),
    "as a question that can be declined"
  );
  const closed = BrowserTestUtils.domWindowClosed(win);
  question.querySelector('button[data-button="ok"]').click();
  await within(closed, 10_000, "the Peek closing");
  Assert.equal(SvalPanel.workspaceId, id, "the window switched to it");
  const tab = expectOpened(gBrowser.selectedTab);
  Assert.greater(tab.userContextId, 0, "in a jar of its own");
  Assert.equal(
    tab.userContextId,
    gBrowser.defaultUserContextId,
    "the workspace's"
  );
  return tab;
}

add_task(async function a_web_page_opens_again_in_the_isolated_jar() {
  const id = await isolatedWorkspace();
  const page = "https://example.org/browser/?quick-reopen-web";
  const tab = await openInWork(await peekShowing(page), id);
  await pageReady(tab.linkedBrowser, page);
  Assert.equal(
    tab.linkedBrowser.contentPrincipal.originAttributes.userContextId,
    tab.userContextId,
    "its page is the jar's"
  );
});

add_task(async function reader_view_opens_the_article_in_reader_view() {
  const id = await isolatedWorkspace();
  const win = await peekShowing(READER);
  await SpecialPowers.spawn(win.gBrowser.selectedBrowser, [], () =>
    ContentTaskUtils.waitForCondition(
      () => content.document.body.classList.contains("loaded"),
      "reader view shows the article in the Peek"
    )
  );
  const tab = await openInWork(win, id);
  await pageReady(tab.linkedBrowser, READER);
  await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    ContentTaskUtils.waitForCondition(
      () => content.document.body.classList.contains("loaded"),
      "reader view shows the article in the workspace"
    )
  );
});

add_task(async function a_file_opens_again_in_the_isolated_jar() {
  const id = await isolatedWorkspace();
  const file = getChromeDir(getResolvedURI(gTestPath));
  file.append("sval_reader_article.html");
  // The harness's test directory is links to the source tree, and a file:
  // load commits at the linked file's own path.
  file.normalize();
  const url = Services.io.newFileURI(file).spec;
  const tab = await openInWork(await peekShowing(url), id);
  await pageReady(tab.linkedBrowser, url);
});

add_task(async function an_about_page_opens_again_in_the_isolated_jar() {
  const id = await isolatedWorkspace();
  const tab = await openInWork(await peekShowing("about:license"), id);
  await pageReady(tab.linkedBrowser, "about:license");
});

add_task(async function view_source_opens_again_in_the_isolated_jar() {
  const id = await isolatedWorkspace();
  const url = `view-source:${ARTICLE}`;
  const tab = await openInWork(await peekShowing(url), id);
  await pageReady(tab.linkedBrowser, url);
});

/**
 * The error page for a file that is not there has a null principal, which
 * may not load a file (`nsScriptSecurityManager::CheckLoadURIWithPrincipal`),
 * so it cannot load again in another jar: the Peek says so, and the
 * main window stays where it was.
 */
add_task(async function a_page_that_cannot_load_again_is_refused_first() {
  const home = SvalPanel.workspaceId;
  await isolatedWorkspace();
  const file = getChromeDir(getResolvedURI(gTestPath));
  file.normalize();
  file.append("sval_no_such_page.html");
  const url = Services.io.newFileURI(file).spec;
  const win = await peekGoingTo(url);
  const browser = win.gBrowser.selectedBrowser;
  await TestUtils.waitForCondition(
    () =>
      browser.documentURI?.spec.startsWith("about:neterror") &&
      browser.currentURI.spec === url,
    "it shows why the file did not load"
  );
  const notice = await pickWork(win);
  Assert.ok(
    notice
      .getElementById("sval-dialog-title")
      .textContent.includes(workspaceTitle("Work")),
    "it names Work"
  );
  Assert.ok(
    !notice.querySelector('button[data-button="cancel"]'),
    "as a notice, with nothing to decline"
  );
  notice.querySelector('button[data-button="ok"]').click();
  await TestUtils.waitForCondition(
    () => !win.gDialogBox.isOpen,
    "the notice closes"
  );
  Assert.ok(!win.closed, "the Peek stays");
  Assert.equal(win.gBrowser.currentURI.spec, url, "with its page as it was");
  Assert.equal(SvalPanel.workspaceId, home, "the window did not switch");
});
