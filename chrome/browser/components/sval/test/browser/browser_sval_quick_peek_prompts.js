/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * A page in a Quick Peek asks the user as a page in a tab does: its prompt, such as
 * an extension's install or a site's permission, shows while the Quick Peek is
 * open and goes with it. The prompt of the tab under the Quick Peek waits for the
 * Quick Peek to close.
 */

const { SvalQuickPeek } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalQuickPeek.sys.mjs"
);
const { AddonTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/AddonTestUtils.sys.mjs"
);
ChromeUtils.defineESModuleGetters(this, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
});

AddonTestUtils.initMochitest(this);

// Firefox keeps an internal address for each extension it has loaded
// (`UUIDMap` in Extension.sys.mjs), and the entry of the one installed here
// is still there when the file ends.
keepPrefs("extensions.webextensions.uuids");

const LINKS_PAGE = ROOT + "sval_quick_peek_links.html";

add_setup(async function () {
  await within(SvalPanel.started, 40_000, "the panel's startup");
});

/**
 * Alt-clicks the page's `#link`, as a person does, and waits for the Quick Peek's
 * page.
 *
 * @param {object} browser
 * @returns {Promise<object>} the Quick Peek's tab.
 */
async function quickPeekAt(browser) {
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#link",
    { altKey: true },
    browser
  );
  await TestUtils.waitForCondition(
    () => SvalQuickPeek.tabOf(window),
    "a Quick Peek opens"
  );
  const quickPeek = SvalQuickPeek.tabOf(window);
  await within(
    pageReady(quickPeek.linkedBrowser, PAGE2),
    10_000,
    "the Quick Peek's page"
  );
  return quickPeek;
}

/**
 * Has `browser`'s page ask for the user's location, which Firefox asks the
 * user about in a doorhanger.
 *
 * @param {object} browser
 */
function askForLocation(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    content.navigator.geolocation.getCurrentPosition(
      () => {},
      () => {}
    );
  });
}

/** @returns {object|null} the browser whose prompt shows, if one does. */
function shownPromptBrowser() {
  const { panel } = PopupNotifications;
  return panel.state === "open"
    ? (panel.firstElementChild?.notification.browser ?? null)
    : null;
}

/**
 * @param {object|null} browser
 * @param {string} what
 */
async function untilPromptOf(browser, what) {
  await TestUtils.waitForCondition(
    () => shownPromptBrowser() === browser,
    what
  );
}

add_task(async function a_quick_peeks_prompt_shows_over_it_and_goes_with_it() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, LINKS_PAGE),
    10_000,
    "the page of links opening"
  );
  const quickPeek = await quickPeekAt(tab.linkedBrowser);
  const quickPeekBrowser = quickPeek.linkedBrowser;

  await askForLocation(quickPeekBrowser);
  await untilPromptOf(quickPeekBrowser, "the Quick Peek's prompt shows");
  Assert.ok(
    PopupNotifications.getNotification("geolocation", quickPeekBrowser),
    "the prompt is the Quick Peek's page asking"
  );

  cardOf(quickPeek).querySelector(".sval-quick-peek-close").click();
  await untilPromptOf(null, "closing the Quick Peek takes its prompt");
  Assert.ok(!SvalQuickPeek.tabOf(window), "the Quick Peek is closed");
});

add_task(async function the_tabs_prompt_waits_for_the_quick_peek_to_close() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, LINKS_PAGE),
    10_000,
    "the page of links opening"
  );
  await askForLocation(tab.linkedBrowser);
  await untilPromptOf(tab.linkedBrowser, "the tab's prompt shows");

  const quickPeek = await quickPeekAt(tab.linkedBrowser);
  await untilPromptOf(null, "the Quick Peek hides the tab's prompt");

  cardOf(quickPeek).querySelector(".sval-quick-peek-close").click();
  await untilPromptOf(tab.linkedBrowser, "the tab's prompt shows again");
  PopupNotifications.remove(
    PopupNotifications.getNotification("geolocation", tab.linkedBrowser)
  );
});

add_task(
  async function the_quick_peeks_dialog_takes_clicks_in_the_quick_peek() {
    const tab = await within(
      BrowserTestUtils.openNewForegroundTab(gBrowser, LINKS_PAGE),
      10_000,
      "the page of links opening"
    );
    const quickPeek = await quickPeekAt(tab.linkedBrowser);
    const quickPeekBrowser = quickPeek.linkedBrowser;

    // A page's alert shows in the tab's own dialog box, as Firefox's ask to
    // open a link in another app does (`ContentDispatchChooser`).
    const shown = BrowserTestUtils.promiseAlertDialogOpen();
    await SpecialPowers.spawn(quickPeekBrowser, [], () => {
      content.setTimeout(() => content.alert("From the Quick Peek"));
    });
    await within(shown, 10_000, "the Quick Peek's alert");
    const [dialog] = gBrowser
      .getTabDialogBox(quickPeekBrowser)
      .getContentDialogManager()._dialogs;
    await within(dialog._dialogReady, 10_000, "the alert laid out");
    const dialogWin = dialog._frame.contentWindow;
    Assert.ok(
      cardOf(quickPeek).contains(dialog._frame),
      "the alert shows over the Quick Peek's page"
    );

    const closed = BrowserTestUtils.waitForEvent(
      window,
      "DOMModalDialogClosed"
    );
    const ok = dialogWin.document.querySelector("dialog").getButton("accept");
    await moveWindowOnScreen();
    const rect = ok.getBoundingClientRect();
    const point = {
      screenX: Math.round(dialogWin.mozInnerScreenX + rect.x + rect.width / 2),
      screenY: Math.round(dialogWin.mozInnerScreenY + rect.y + rect.height / 2),
    };
    for (const type of ["mousedown", "mouseup"]) {
      await nativeMouse({ type, target: document.documentElement, ...point });
    }
    await within(closed, 10_000, "pressing OK closes the alert");
    Assert.equal(
      SvalQuickPeek.tabOf(window),
      quickPeek,
      "the Quick Peek stays open"
    );

    cardOf(quickPeek).querySelector(".sval-quick-peek-close").click();
    await TestUtils.waitForCondition(
      () => !SvalQuickPeek.tabOf(window),
      "the Quick Peek closes"
    );
  }
);

add_task(async function an_install_the_quick_peeks_page_asks_for_installs() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, LINKS_PAGE),
    10_000,
    "the page of links opening"
  );
  const quickPeek = await quickPeekAt(tab.linkedBrowser);
  const quickPeekBrowser = quickPeek.linkedBrowser;
  const site = quickPeekBrowser.contentPrincipal;
  // The site may install add-ons, as Firefox lets addons.mozilla.org.
  Services.perms.addFromPrincipal(site, "install", Services.perms.ALLOW_ACTION);
  atTaskEnd(() => Services.perms.removeFromPrincipal(site, "install"));

  const id = "quick-peek-install@sval.test";
  atTaskEnd(async () => {
    await (await AddonManager.getAddonByID(id))?.uninstall();
  });
  const xpi = AddonTestUtils.createTempWebExtensionFile({
    manifest: {
      browser_specific_settings: { gecko: { id } },
      name: "Installed from a Quick Peek",
    },
  });
  const install = await AddonManager.getInstallForFile(xpi);
  const installed = within(
    new Promise(resolve =>
      install.addListener({
        onInstallEnded: resolve,
        onInstallCancelled: () => resolve(null),
      })
    ),
    10_000,
    "the install ending"
  );
  AddonManager.installAddonFromWebpage(
    "application/x-xpinstall",
    quickPeekBrowser,
    site,
    install
  );
  await untilPromptOf(
    quickPeekBrowser,
    "the Quick Peek's install prompt shows"
  );
  const prompt = PopupNotifications.panel.firstElementChild;
  Assert.equal(prompt.getAttribute("popupid"), "addon-webext-permissions");

  // Pressed as a person presses it, on the button's own inner parts.
  await EventUtils.synthesizeMouseAtCenter(prompt.button, {});
  Assert.ok(await installed, "the add-on installs");
  Assert.ok(await AddonManager.getAddonByID(id), "it is in the add-ons list");
  Assert.equal(
    SvalQuickPeek.tabOf(window),
    quickPeek,
    "the Quick Peek stays open"
  );

  cardOf(quickPeek).querySelector(".sval-quick-peek-close").click();
  await TestUtils.waitForCondition(
    () => !SvalQuickPeek.tabOf(window),
    "the Quick Peek closes"
  );
});

/**
 * @param {object} quickPeek A Quick Peek's tab.
 * @returns {Element} its card, the panel over the content area.
 */
function cardOf(quickPeek) {
  return document.getElementById(quickPeek.linkedPanel);
}

/**
 * A dialog of the page under a Quick Peek is hidden by it, so it leaves the
 * keyboard with the Quick Peek, and takes it once the Quick Peek closes.
 */
add_task(async function a_dialog_under_a_quick_peek_waits_for_the_keyboard() {
  const owner = await openPage(LINKS_PAGE);
  const quickPeek = await quickPeekAt(owner.linkedBrowser);
  quickPeek.linkedBrowser.focus();
  Assert.equal(
    document.activeElement,
    quickPeek.linkedBrowser,
    "the Quick Peek has the keyboard"
  );

  const dialogs = () =>
    gBrowser.getTabDialogBox(owner.linkedBrowser).getContentDialogManager()
      ._dialogs;
  await SpecialPowers.spawn(owner.linkedBrowser, [], () => {
    content.setTimeout(() => content.prompt("A question"), 0);
  });
  await within(
    TestUtils.waitForCondition(
      () => dialogs().length,
      "the page's dialog opens"
    ),
    10_000,
    "the page's dialog opening"
  );
  const [dialog] = dialogs();
  // The manager focuses a dialog once it is ready (`_onDialogOpen`).
  await within(dialog._dialogReady, 10_000, "the page's dialog being ready");
  Assert.equal(
    document.activeElement,
    quickPeek.linkedBrowser,
    "the Quick Peek keeps the keyboard"
  );

  SvalQuickPeek.close(window);
  await within(
    TestUtils.waitForCondition(
      () => document.activeElement === dialog._frame,
      "the dialog has the keyboard"
    ),
    10_000,
    "the dialog taking the keyboard"
  );
  dialog._frame.contentDocument.querySelector("dialog").cancelDialog();
  await within(
    TestUtils.waitForCondition(() => !dialogs().length, "the dialog closes"),
    10_000,
    "the dialog closing"
  );
});
