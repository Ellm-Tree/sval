/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_agent_on_helpers.js */
/* import-globals-from sval_panel_startup_helpers.js */

/**
 * A Peek and a Quick Peek are seen (link routing spec §4, §5): the page a
 * link from another app opens in a Peek, or an Alt-click opens in a Quick
 * Peek, loads, renders and paints, with agent access off and on, since the
 * agent gate holds a first load in any tab that could be an agent's. A Peek
 * keeps the address it was given through a first load that fails, so a
 * reload or a move into a workspace loads it.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_agent_on_helpers.js",
  this
);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_panel_startup_helpers.js",
  this
);

const RED_ORG = RED.replace("://example.com/", "://example.org/");

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
});

add_task(async function a_link_from_another_app_is_painted_in_its_peek() {
  const win = await linkFromAnotherApp(RED);
  await shows(win.gBrowser.selectedBrowser, RED, "the peek");
});

add_task(async function with_agent_access_on_a_peek_is_painted_too() {
  await agentAccessOn();
  const win = await linkFromAnotherApp(RED);
  await shows(win.gBrowser.selectedBrowser, RED, "the peek");
});

add_task(async function a_peek_opened_over_a_second_window_is_painted() {
  await agentAccessOn();
  await secondWindow();
  const win = await linkFromAnotherApp(RED);
  await shows(win.gBrowser.selectedBrowser, RED, "the peek");
});

add_task(async function a_quick_peeked_at_in_a_second_window_is_painted() {
  await agentAccessOn();
  const win = await secondWindow();
  const tab = await openPage(PAGE, win);
  await SpecialPowers.spawn(tab.linkedBrowser, [RED_ORG], url => {
    const link = content.document.createElement("a");
    link.id = "quick-peek-link";
    link.href = url;
    link.textContent = "Quick Peek here";
    content.document.body.prepend(link);
  });
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#quick-peek-link",
    { altKey: true },
    tab.linkedBrowser
  );
  const quickPeek = await TestUtils.waitForCondition(
    () => SvalQuickPeek.tabOf(win),
    "a Quick Peek opens"
  );
  await shows(quickPeek.linkedBrowser, RED_ORG, "the Quick Peek");
});

/**
 * A link from another app whose first load fails with `status`, and its
 * peek once that load has stopped.
 *
 * @param {string} url
 * @param {number} status
 * @returns {Promise<Window>}
 */
async function failedPeek(url, status) {
  const failed = failFirstLoad(url, status);
  const win = await linkFromAnotherApp(url);
  await within(failed, 10_000, "the first load failing");
  await TestUtils.waitForCondition(
    () => !win.gBrowser.selectedTab.hasAttribute("busy"),
    "the failed load has stopped"
  );
  return win;
}

add_task(async function a_refused_first_load_keeps_its_address_to_reload() {
  const url = `${RED}?refused-reload`;
  const win = await failedPeek(url, Cr.NS_ERROR_BLOCKED_BY_POLICY);
  await errorPageShown(win.gBrowser.selectedBrowser, url, "refused");
  win.BrowserCommands.reload();
  await shows(win.gBrowser.selectedBrowser, url, "the peek, reloaded");
});

add_task(async function a_refused_first_load_keeps_its_address_to_move() {
  const url = `${RED}?refused-move`;
  const win = await failedPeek(url, Cr.NS_ERROR_BLOCKED_BY_POLICY);
  await errorPageShown(win.gBrowser.selectedBrowser, url, "refused");
  await movedInShows(win, url);
});

add_task(async function a_failed_connection_keeps_its_address_to_reload() {
  const url = `${RED}?failed-reload`;
  const win = await failedPeek(url, Cr.NS_ERROR_CONNECTION_REFUSED);
  await errorPageShown(win.gBrowser.selectedBrowser, url, "failed");
  win.BrowserCommands.reload();
  await shows(win.gBrowser.selectedBrowser, url, "the peek, reloaded");
});

add_task(async function a_failed_connection_keeps_its_address_to_move() {
  const url = `${RED}?failed-move`;
  const win = await failedPeek(url, Cr.NS_ERROR_CONNECTION_REFUSED);
  await errorPageShown(win.gBrowser.selectedBrowser, url, "failed");
  await movedInShows(win, url);
});

/**
 * A load cancelled before it commits, as a stop or a content policy cancels
 * one, shows no page at all, so the address is kept as if typed.
 */
add_task(async function a_cancelled_first_load_keeps_its_address_to_move() {
  const url = `${RED}?cancelled-move`;
  const win = await failedPeek(url, Cr.NS_ERROR_ABORT);
  const browser = win.gBrowser.selectedBrowser;
  Assert.equal(browser.currentURI.spec, "about:blank", "no page committed");
  Assert.equal(browser.userTypedValue, url, "the tab keeps the address");
  Assert.equal(win.gURLBar.untrimmedValue, url, "which the address bar shows");
  await movedInShows(win, url);
});

/**
 * A first load still on its way when the page moves has shown nothing, so
 * the page opens again at its address, whatever then becomes of that load.
 * The load is held where the agent gate holds one, and cancelled once the
 * move has decided how to bring the page across, as a stop or a content
 * policy cancels a load while the tab is still busy with it.
 */
add_task(async function a_first_load_in_flight_opens_again_at_its_address() {
  const url = `${RED}?in-flight-move`;
  const { promise: held, resolve } = Promise.withResolvers();
  const observer = {
    observe(subject) {
      const channel = subject.QueryInterface(Ci.nsIHttpChannel);
      if (channel.URI.spec === url) {
        Services.obs.removeObserver(observer, "http-on-modify-request");
        channel.suspend();
        resolve(channel);
      }
    },
  };
  Services.obs.addObserver(observer, "http-on-modify-request");
  atTaskEnd(() => {
    try {
      Services.obs.removeObserver(observer, "http-on-modify-request");
    } catch {}
  });
  const win = await linkFromAnotherApp(url);
  const channel = await within(held, 10_000, "the first load starting");
  const cancel = () => {
    try {
      channel.cancel(Cr.NS_ERROR_ABORT);
      channel.resume();
    } catch {}
  };
  atTaskEnd(cancel);
  await TestUtils.waitForCondition(
    () => win.gBrowser.selectedTab.hasAttribute("busy"),
    "the peek is busy with its first load"
  );
  Assert.equal(
    win.gBrowser.selectedBrowser.currentURI.spec,
    "about:blank",
    "no page committed"
  );
  await movedInShows(win, url, { whenOpened: cancel });
});

/**
 * The address bar of a page that never loaded holds what the user typed
 * there, which can be any address. Only a web address is opened again
 * elsewhere, as the system principal opens it; anything else moves the
 * tab as it is.
 */
add_task(async function a_typed_address_that_is_not_a_web_page_is_not_opened() {
  const url = `${RED}?cancelled-typed`;
  const win = await failedPeek(url, Cr.NS_ERROR_ABORT);
  const browser = win.gBrowser.selectedBrowser;
  const { browserId } = browser;
  browser.userTypedValue = "about:license";
  const opened = BrowserTestUtils.waitForEvent(
    gBrowser.tabContainer,
    "TabOpen"
  );
  const closed = BrowserTestUtils.domWindowClosed(win);
  win.document.getElementById("sval-peek-open-main").click();
  const tab = expectOpened(
    (await within(opened, 10_000, "the moved tab")).target
  );
  atTaskEnd(async () => {
    BrowserTestUtils.removeTab(tab);
    await within(
      SvalPanel.observer.settled(),
      10_000,
      "SvalPanel.observer settling"
    );
  });
  await within(closed, 10_000, "the peek closing");
  Assert.equal(
    tab.linkedBrowser.browserId,
    browserId,
    "the peek's own page moved, as it is"
  );
  Assert.equal(tab.linkedBrowser.currentURI.spec, "about:blank", "unloaded");
});

/**
 * The agent gate's own refusal: a tab in a window that could be an agent's
 * and that has no tab observer to file it, as a window has whose profile
 * holds no workspace while its shared folder is away (local-copy spec
 * §4.4). Its page shows why it did not load, at its address, and a reload
 * once the folder is back and the window has its workspace loads it.
 */
add_task(async function a_tab_the_gate_could_not_file_keeps_its_address() {
  await agentAccessOn();
  const missing = tempPath("sval-missing");
  const profile = await freshProfile({ shared: missing });
  const win = await profile.open();
  Assert.ok(!win.SvalPanel.observer, "the window has no tab observer");
  const url = `${RED}?unfiled`;
  const tab = BrowserTestUtils.addTab(win.gBrowser, url);
  await selectTab(tab);
  await errorPageShown(
    tab.linkedBrowser,
    url,
    "the unfiled tab",
    "about:agentblocked"
  );

  // The folder comes back as the chosen one, holding `sval/`, and the
  // window's own startup retry finds it.
  await IOUtils.makeDirectory(PathUtils.join(missing, "sval"));
  await TestUtils.waitForCondition(
    () => win.SvalPanel.observer,
    "the window's startup retry gave it a workspace and a tab observer",
    100,
    300
  );
  win.gBrowser.reloadTab(tab);
  await shows(tab.linkedBrowser, url, "the tab, reloaded");
});
