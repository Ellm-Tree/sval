/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_agent_on_helpers.js */

/**
 * Pages as a user opens and moves through them, with agent access on: a
 * link in a new tab or a background tab, an address typed in the address
 * bar or the Launcher, back, forward and reload, a redirect, and a load
 * that fails and is reloaded. Each lands in the workspace the window shows,
 * loaded and painted.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_agent_on_helpers.js",
  this
);

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);

add_setup(failOnConsoleErrors);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  await agentAccessOn(registerCleanupFunction);
  await PlacesUtils.history.clear();
  registerCleanupFunction(async () => {
    await UrlbarTestUtils.promisePopupClose(window);
    gURLBar.handleRevert();
    await PlacesUtils.history.clear();
  });
});

/**
 * Asserts that `tab` is filed in the workspace the window shows and that
 * its row is named `title`.
 *
 * @param {object} tab
 * @param {string} title
 */
async function filedAndNamed(tab, title) {
  const id = await nodeOfTab(tab);
  Assert.equal(
    SvalPanel.nodes[id]?.placement.parent,
    SvalPanel.workspaceId,
    `${title}: filed in the workspace the window shows`
  );
  await TestUtils.waitForCondition(
    () => rowNameIn(window, id) === title,
    `${title}: its row is named for its page`
  );
}

/**
 * A page of the user's with two links to `target`: `#new` opens in a new
 * tab, and `#plain` in the page's own.
 *
 * @param {string} target
 * @returns {Promise<object>} its tab.
 */
async function pageWithLinks(target) {
  const tab = await openPage(titledRed("Links"));
  await SpecialPowers.spawn(tab.linkedBrowser, [target], url => {
    for (const [id, blank] of [
      ["new", true],
      ["plain", false],
    ]) {
      const link = content.document.createElement("a");
      link.id = id;
      link.href = url;
      link.textContent = id;
      link.style = "display:block;font-size:40px;color:white";
      if (blank) {
        link.target = "_blank";
      }
      content.document.body.prepend(link);
    }
  });
  return tab;
}

add_task(async function a_link_opens_in_a_new_tab_and_a_background_tab() {
  const target = titledRed("Linked");
  const links = await pageWithLinks(target);

  const front = BrowserTestUtils.waitForNewTab(gBrowser, target, true);
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#new",
    {},
    links.linkedBrowser
  );
  const frontTab = await within(front, 10_000, "the link's new tab");
  await switchDone(window);
  Assert.equal(gBrowser.selectedTab, frontTab, "in front");
  await selectedShows(window, target, "the link's new tab");
  await filedAndNamed(frontTab, "Linked");

  await selectTab(links);
  const back = BrowserTestUtils.waitForNewTab(gBrowser, target, true);
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#plain",
    { accelKey: true },
    links.linkedBrowser
  );
  const backTab = await within(back, 10_000, "the link's background tab");
  Assert.equal(gBrowser.selectedTab, links, "behind the page it came from");
  await filedAndNamed(backTab, "Linked");
  await selectTab(backTab);
  await selectedShows(window, target, "the background tab, once looked at");
});

add_task(async function an_address_typed_in_the_address_bar_loads() {
  const tab = await openPage(titledRed("Before"));
  const here = titledRed("Typed here");
  await within(
    UrlbarTestUtils.promiseAutocompleteResultPopup({ window, value: here }),
    10_000,
    "the address bar's results"
  );
  EventUtils.synthesizeKey("KEY_Enter");
  await selectedShows(window, here, "the page typed for this tab");
  Assert.equal(gBrowser.selectedTab, tab, "in this tab");
  await filedAndNamed(tab, "Typed here");

  const elsewhere = titledRed("Typed elsewhere");
  await within(
    UrlbarTestUtils.promiseAutocompleteResultPopup({
      window,
      value: elsewhere,
    }),
    10_000,
    "the address bar's results"
  );
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, elsewhere, true);
  EventUtils.synthesizeKey("KEY_Enter", { shiftKey: true });
  const newTab = await within(opened, 10_000, "Shift+Enter's new tab");
  await switchDone(window);
  await selectedShows(window, elsewhere, "the page typed for a new tab");
  await filedAndNamed(newTab, "Typed elsewhere");
});

add_task(async function an_address_typed_in_the_launcher_loads() {
  const tab = await openPage(titledRed("Launching"));
  await within(SimpleTest.promiseFocus(window), 10_000, "the window's focus");
  gBrowser.selectedBrowser.focus();
  await within(
    UrlbarTestUtils.promisePopupOpen(window, () =>
      EventUtils.synthesizeKey("l", { accelKey: true })
    ),
    10_000,
    "the Launcher's list"
  );
  await TestUtils.waitForCondition(
    () => gURLBar.hasAttribute("sval-launcher-floating"),
    "the Launcher floats"
  );
  const page = titledRed("Launched");
  EventUtils.sendString(page);
  await within(
    UrlbarTestUtils.promiseSearchComplete(window),
    10_000,
    "the Launcher's results"
  );
  EventUtils.synthesizeKey("KEY_Enter");
  await selectedShows(window, page, "the page the Launcher opened");
  Assert.equal(gBrowser.selectedTab, tab, "in this tab");
  await TestUtils.waitForCondition(
    () => !gURLBar.hasAttribute("sval-launcher-floating"),
    "the Launcher is back in the toolbar"
  );
  await filedAndNamed(tab, "Launched");
});

add_task(async function back_forward_and_reload_show_their_pages() {
  const first = titledRed("Earlier");
  const second = titledRed("Later");
  const tab = await openPage(first);
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, second);
  await selectedShows(window, second, "the page gone to");

  gBrowser.goBack();
  await selectedShows(window, first, "back");
  gBrowser.goForward();
  await selectedShows(window, second, "forward");

  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.body.dataset.before = "reload";
  });
  BrowserCommands.reload();
  await TestUtils.waitForCondition(
    () =>
      SpecialPowers.spawn(
        tab.linkedBrowser,
        [],
        () => !content.document.body?.dataset.before
      ).catch(() => false),
    "the page is a new document"
  );
  await selectedShows(window, second, "reloaded");
  await filedAndNamed(tab, "Later");
});

add_task(async function a_redirect_shows_the_page_it_lands_on() {
  const target = titledRed("Landed");
  const redirect = `${ROOT}sval_agent_redirect.sjs?${encodeURIComponent(target)}`;
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, redirect, false),
    10_000,
    "the redirect's tab"
  );
  await selectedShows(window, target, "the redirect's page");
  await filedAndNamed(tab, "Landed");
});

add_task(async function a_failed_load_keeps_its_address_and_reloads() {
  const page = titledRed("Failed once");
  const failed = failFirstLoad(page, Cr.NS_ERROR_CONNECTION_REFUSED);
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, page, false),
    10_000,
    "the failing tab"
  );
  await within(failed, 10_000, "the first load failing");
  await errorPageShown(tab.linkedBrowser, page, "the failed tab");
  Assert.equal(
    Services.io.newURI(gURLBar.untrimmedValue).spec,
    page,
    "which the address bar shows"
  );
  BrowserCommands.reload();
  await selectedShows(window, page, "reloaded");
  await filedAndNamed(tab, "Failed once");
});
