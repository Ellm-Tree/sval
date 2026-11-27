/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Extensions that Sval's changes break (`SvalExtensionCompat`, extension-
 * compatibility spec): refused installs and their notices, extensions that
 * ask for containers turned off, the `tabHide` warning, hidden tabs in the
 * panel, and the sidebar switcher for extension sidebars. A refused install
 * is answered by a doorhanger on the extensions button; the other notices are
 * read from the extensions panel, where the user sees them.
 */

/* import-globals-from head.js */
/* import-globals-from sval_extension_notices_helpers.js */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_extension_notices_helpers.js",
  this
);

ChromeUtils.defineESModuleGetters(this, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  disableContainerExtensions:
    "moz-src:///browser/components/sval/SvalExtensionCompat.sys.mjs",
  ExtensionControlledPopup:
    "resource:///modules/ExtensionControlledPopup.sys.mjs",
  ExtensionTestCommon: "resource://testing-common/ExtensionTestCommon.sys.mjs",
  HttpServer: "resource://testing-common/httpd.sys.mjs",
  REFUSED_NOTIFICATION:
    "moz-src:///browser/components/sval/SvalExtensionCompat.sys.mjs",
  removeNotice: "moz-src:///browser/components/sval/SvalAppNotices.sys.mjs",
  TAB_HIDE_WARNED_PREF:
    "moz-src:///browser/components/sval/SvalExtensionCompat.sys.mjs",
  warnUnansweredTabHide:
    "moz-src:///browser/components/sval/SvalExtensionCompat.sys.mjs",
});

// Firefox keeps an internal address for each extension it has loaded
// (`UUIDMap` in Extension.sys.mjs), and the entry of one these tasks update
// and then remove is still there when the file ends.
keepPrefs(TAB_HIDE_WARNED_PREF, "extensions.webextensions.uuids");

const lines = noticeBars;
const buttons = barButtons;
const waitForLines = waitForBars;
const text = bar => noticeText(bar);

/** The notices the panel shows, opened to read them. */
async function linesNow() {
  await openExtensionsPanel();
  return lines();
}

/**
 * Installs `manifest` as an XPI through the add-on manager, as a user's
 * install from a file or a site goes.
 *
 * @param {object} manifest
 * @returns {Promise<{install: object, ended: Promise, cancelled: Promise}>}
 */
async function installXPI(manifest) {
  const xpi = ExtensionTestCommon.generateXPI({ manifest });
  registerCleanupFunction(() => xpi.remove(false));
  const install = await AddonManager.getInstallForFile(xpi);
  const ended = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  install.addListener({
    onInstallEnded: (_install, addon) => ended.resolve(addon),
    onInstallCancelled: () => cancelled.resolve(),
  });
  install.install().catch(() => {});
  return { install, ended: ended.promise, cancelled: cancelled.promise };
}

/**
 * Waits for the refusal's doorhanger on the selected tab, checks which
 * refusal it is, the extension it names and the button it anchors on, and
 * that the download's progress doorhanger is gone, then takes it down and
 * checks the extensions panel carries no line for it.
 *
 * @param {string} refusal The doorhanger's `refusal` option.
 * @param {string} [name] The extension's name, which the doorhanger says.
 */
async function assertRefusedAt(refusal, name) {
  const browser = gBrowser.selectedBrowser;
  const refused = await TestUtils.waitForCondition(
    () => PopupNotifications.getNotification(REFUSED_NOTIFICATION, browser),
    "the refusal's doorhanger"
  );
  Assert.equal(refused.options.refusal, refusal, "the refusal shown");
  if (name) {
    Assert.ok(refused.message.includes(name), "it names the extension");
  }
  Assert.equal(refused.anchorID, "unified-extensions-button");
  Assert.ok(refused.mainAction, "with a button that dismisses it");
  Assert.equal(
    PopupNotifications.getNotification("addon-progress", browser),
    null,
    "no download progress is left beside it"
  );
  refused.remove();
  Assert.equal(
    PopupNotifications.getNotification(REFUSED_NOTIFICATION, browser),
    null,
    "the doorhanger is taken down"
  );
  await TestUtils.waitForCondition(
    () => !gUnifiedExtensions.button.open,
    "the extensions button is released"
  );
  Assert.equal((await linesNow()).length, 0, "and the panel has no line");
}

function gecko(id) {
  return { browser_specific_settings: { gecko: { id } } };
}

/**
 * Resolves once the add-on `id` is uninstalled.
 *
 * @param {string} id
 */
function whenUninstalled(id) {
  return new Promise(resolve => {
    const listener = {
      onUninstalled(addon) {
        if (addon.id === id) {
          AddonManager.removeAddonListener(listener);
          resolve();
        }
      },
    };
    AddonManager.addAddonListener(listener);
  });
}

add_task(async function a_theme_is_refused_at_the_extensions_button() {
  const { cancelled } = await installXPI({
    ...gecko("theme@sval.invalid"),
    name: "Red",
    theme: { colors: { frame: "#ff0000", tab_background_text: "#000" } },
  });
  await within(cancelled, 10_000, "the theme's install being cancelled");
  Assert.equal(
    await AddonManager.getAddonByID("theme@sval.invalid"),
    null,
    "the theme was not installed"
  );
  await assertRefusedAt("theme");
});

add_task(
  async function a_containers_extension_is_refused_at_the_extensions_button() {
    const { cancelled } = await installXPI({
      ...gecko("containers@sval.invalid"),
      name: "Boxes",
      permissions: ["contextualIdentities", "cookies"],
    });
    await within(cancelled, 10_000, "the extension's install being cancelled");
    Assert.equal(
      await AddonManager.getAddonByID("containers@sval.invalid"),
      null,
      "the extension was not installed"
    );
    await assertRefusedAt("containers", "Boxes");
  }
);

add_task(async function a_download_is_refused_before_it_asks_to_install() {
  const xpi = ExtensionTestCommon.generateXPI({
    manifest: {
      ...gecko("downloaded-containers@sval.invalid"),
      name: "Fetched Boxes",
      permissions: ["contextualIdentities"],
    },
  });
  registerCleanupFunction(() => xpi.remove(false));
  // Served over HTTP: a file's address installs without a download.
  const server = new HttpServer();
  server.registerFile("/boxes.xpi", xpi);
  server.start(-1);
  registerCleanupFunction(() => new Promise(resolve => server.stop(resolve)));
  const install = await AddonManager.getInstallForURL(
    `http://localhost:${server.identity.primaryPort}/boxes.xpi`
  );
  let started = false;
  const cancelled = new Promise(resolve =>
    install.addListener({
      onInstallStarted: () => {
        started = true;
      },
      onDownloadCancelled: resolve,
    })
  );
  install.install().catch(() => {});
  await within(cancelled, 10_000, "the download being cancelled");
  Assert.ok(!started, "the install never started, so nothing was prompted");
  await assertRefusedAt("containers", "Fetched Boxes");
});

add_task(async function an_installed_containers_extension_is_turned_off() {
  // A temporary install does not pass the install listener, so it stands in
  // for an extension a profile brought with it.
  const extension = ExtensionTestUtils.loadExtension({
    useAddonManager: "temporary",
    manifest: {
      ...gecko("imported-containers@sval.invalid"),
      name: "Imported Boxes",
      permissions: ["contextualIdentities"],
    },
  });
  await extension.startup();
  Assert.ok(
    !Services.prefs.getBoolPref("privacy.userContext.enabled"),
    "containers stay off while it runs"
  );

  await disableContainerExtensions();
  const addon = await AddonManager.getAddonByID(
    "imported-containers@sval.invalid"
  );
  Assert.ok(addon.userDisabled, "it is disabled");
  Assert.ok(addon, "and not uninstalled");
  Assert.ok(
    !Services.prefs.getBoolPref("privacy.userContext.enabled"),
    "containers are still off"
  );
  const [line] = await waitForLines(1, "a notice names it");
  Assert.equal(
    line.dataset.key,
    "disabled-containers:imported-containers@sval.invalid",
    "the notice is the one for a containers extension turned off"
  );
  Assert.ok(text(line).includes("Imported Boxes"), "it names the extension");
  Assert.equal(buttons(line).length, 2, "Remove and OK");
  buttons(line)[1].click();
  await waitForLines(0, "OK takes it away");

  await disableContainerExtensions();
  Assert.equal(
    (await linesNow()).length,
    0,
    "one already off is not named again"
  );
  await extension.unload();
});

add_task(async function a_tab_hide_extension_installs_with_a_warning_once() {
  const id = "tabs@sval.invalid";
  const manifest = {
    ...gecko(id),
    name: "Tab Sets",
    version: "1.0",
    permissions: ["tabHide"],
  };
  const shown = extensionsPanelShown();
  let { ended } = await installXPI(manifest);
  let addon = await within(ended, 10_000, "the install completing");
  Assert.ok(addon.isActive, "the extension is installed and running");
  await shown;
  const [line] = await waitForLines(1, "a warning is shown");
  Assert.equal(
    line.dataset.key,
    `tab-hide:${id}`,
    "the notice is the tab-hiding warning"
  );
  Assert.ok(text(line).includes("Tab Sets"), "it names the extension");
  Assert.equal(buttons(line).length, 2, "Remove and Keep");
  buttons(line)[1].click();
  await waitForLines(0, "Keep takes it away");
  Assert.ok(
    (await AddonManager.getAddonByID(id)).isActive,
    "and keeps the extension"
  );

  ({ ended } = await installXPI({ ...manifest, version: "2.0" }));
  addon = await within(ended, 10_000, "the update completing");
  Assert.equal(addon.version, "2.0", "an update installs");
  Assert.equal((await linesNow()).length, 0, "with no second warning");

  // The warning's Remove, reached once more by forgetting it was shown.
  Services.prefs.clearUserPref(TAB_HIDE_WARNED_PREF);
  ({ ended } = await installXPI({ ...manifest, version: "3.0" }));
  await within(ended, 10_000, "the reinstall completing");
  const [again] = await waitForLines(1, "the warning is shown");
  const uninstalled = whenUninstalled(id);
  buttons(again)[0].click();
  await within(uninstalled, 10_000, "Remove uninstalling the extension");
  Assert.equal(await AddonManager.getAddonByID(id), null, "it is gone");
  await waitForLines(0, "and so is the warning");
});

add_task(async function an_unanswered_tab_hide_warning_comes_back() {
  const id = "tabsets@sval.invalid";
  const shown = extensionsPanelShown();
  const { ended } = await installXPI({
    ...gecko(id),
    name: "Tab Sets",
    version: "1.0",
    permissions: ["tabHide"],
  });
  const addon = await within(ended, 10_000, "the install completing");
  await shown;
  await waitForLines(1, "a warning is shown");

  // A notice lasts only as long as the session; this is Sval quitting on it.
  removeNotice(`tab-hide:${id}`);
  await waitForLines(0, "the session's notice is gone");
  await warnUnansweredTabHide();
  const [line] = await waitForLines(1, "the next start warns again");
  buttons(line)[1].click();
  await waitForLines(0, "Keep answers it");

  await warnUnansweredTabHide();
  Assert.equal(
    (await linesNow()).length,
    0,
    "an answered warning stays answered"
  );

  const uninstalled = whenUninstalled(id);
  await addon.uninstall();
  await within(uninstalled, 10_000, "the extension uninstalling");
  Services.prefs.clearUserPref(TAB_HIDE_WARNED_PREF);
});

add_task(async function an_ordinary_extension_installs_silently() {
  const id = "ordinary@sval.invalid";
  const { ended } = await installXPI({
    ...gecko(id),
    name: "Ordinary",
    permissions: ["tabs", "storage"],
  });
  const addon = await within(ended, 10_000, "the install completing");
  Assert.ok(addon.isActive, "it is installed");
  Assert.equal((await linesNow()).length, 0, "with no notice");
  await addon.uninstall();
});

/**
 * An extension that hides and shows the tab it is told to.
 */
async function tabHider() {
  const extension = ExtensionTestUtils.loadExtension({
    useAddonManager: "temporary",
    manifest: {
      ...gecko("hider@sval.invalid"),
      permissions: ["tabs", "tabHide"],
    },
    background() {
      const { browser } = this;
      browser.test.onMessage.addListener(async (what, url) => {
        const [tab] = await browser.tabs.query({ url });
        await browser.tabs[what](tab.id);
        browser.test.sendMessage("done");
      });
    },
  });
  await extension.startup();
  return {
    extension,
    async run(what, url) {
      extension.sendMessage(what, url);
      await within(extension.awaitMessage("done"), 10_000, `tabs.${what}`);
    },
  };
}

add_task(async function a_hidden_tab_has_no_row() {
  const url = "https://example.com/browser/";
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, url),
    10_000,
    "the tab's load"
  );
  let id = null;
  await TestUtils.waitForCondition(() => {
    id = SvalPanel.observer.nodeIdFor(tab);
    return id && SvalPanel._rowElementFor(id);
  }, "the tab has a row");
  const other = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank"),
    10_000,
    "a second tab"
  );
  registerCleanupFunction(() => {
    BrowserTestUtils.removeTab(tab);
    BrowserTestUtils.removeTab(other);
  });

  const hider = await tabHider();
  const rowShown = () => !!SvalPanel._rowElementFor(id);
  const navigable = () => SvalPanel._rows.some(row => row.id === id);

  // Firefox asks whether to keep an extension's tabs hidden on each hide
  // until the user answers (`tabHidePopup` in ext-tabs.js). Its Disable
  // Extension button's access key is D, so off macOS a panel the task leaves
  // behind takes a later file's Alt+D from the address bar.
  const doorhanger = ExtensionControlledPopup._getAndMaybeCreatePanel(document);
  const asked = BrowserTestUtils.waitForPopupEvent(doorhanger, "shown");
  await hider.run("hide", url);
  await within(asked, 10_000, "Firefox asking about the hidden tab");
  const answered = BrowserTestUtils.waitForPopupEvent(doorhanger, "hidden");
  document.getElementById("extension-tab-hide-notification").button.click();
  await within(answered, 10_000, "Keep Tabs Hidden answering it");
  Assert.ok(tab.hidden, "the extension hid the tab");
  await TestUtils.waitForCondition(() => !rowShown(), "its row goes");
  Assert.ok(!navigable(), "and keyboard navigation skips it");
  Assert.ok(SvalPanel.nodes[id], "its node stays");

  await hider.run("show", url);
  await TestUtils.waitForCondition(rowShown, "showing it brings its row back");

  await hider.run("hide", url);
  await TestUtils.waitForCondition(() => !rowShown(), "hidden again");
  await selectTab(tab);
  Assert.ok(!tab.hidden, "selecting the tab shows it");
  await TestUtils.waitForCondition(rowShown, "with its row");

  await selectTab(other);
  await hider.run("hide", url);
  await TestUtils.waitForCondition(() => !rowShown(), "hidden once more");
  await hider.extension.unload();
  await TestUtils.waitForCondition(
    rowShown,
    "the extension going shows its tabs, and the row comes back"
  );
});

add_task(async function an_extension_sidebar_shows_the_switcher() {
  const switcher = document.getElementById("sidebar-switcher-target");
  Assert.ok(switcher.hidden, "with no extension sidebar it is hidden");

  const extension = ExtensionTestUtils.loadExtension({
    useAddonManager: "temporary",
    manifest: {
      ...gecko("sidebar@sval.invalid"),
      name: "Notes",
      sidebar_action: {
        default_panel: "panel.html",
        default_icon: "notes.svg",
        open_at_install: false,
      },
    },
    files: {
      "panel.html": "<!doctype html><title>Notes</title>",
      "notes.svg":
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>',
    },
  });
  await extension.startup();
  await TestUtils.waitForCondition(
    () => !switcher.hidden,
    "an extension's sidebar shows the switcher"
  );
  await SidebarController.show("viewHistorySidebar");
  const header = document.getElementById("sidebar-header");
  Assert.ok(header.checkVisibility(), "and the header that holds it");
  Assert.ok(
    document.getElementById("sidebar-close").checkVisibility(),
    "with the close button"
  );
  Assert.ok(
    document.getElementById("sidebar-icon").checkVisibility(),
    "the switcher shows the sidebar's icon"
  );
  const title = document.getElementById("sidebar-title");
  Assert.equal(title.parentElement, switcher, "and its title inside it");
  Assert.ok(title.checkVisibility(), "where it shows");
  const page = SidebarController.browser.contentDocument;
  const pageLeft = SidebarController.browser.getBoundingClientRect().left;
  const search = page.getElementById("search-box").getBoundingClientRect();
  const view = page.getElementById("viewButton").getBoundingClientRect();
  Assert.less(
    Math.abs(switcher.getBoundingClientRect().left - (pageLeft + search.left)),
    1,
    "the switcher lines up with the search field"
  );
  Assert.less(
    Math.abs(
      document.getElementById("sidebar-close").getBoundingClientRect().right -
        (pageLeft + view.right)
    ),
    1,
    "and the close button with the View button"
  );

  const { makeWidgetId } = ChromeUtils.importESModule(
    "resource://gre/modules/ExtensionCommon.sys.mjs"
  ).ExtensionCommon;
  await SidebarController.show(`${makeWidgetId(extension.id)}-sidebar-action`);
  Assert.stringContains(
    getComputedStyle(document.getElementById("sidebar-icon")).listStyleImage,
    "notes.svg",
    "an extension's sidebar shows its own icon in the switcher"
  );
  await SidebarController.show("viewHistorySidebar");

  const menu = document.getElementById("sidebarMenu-popup");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  menu.hidden = false;
  menu.openPopup(switcher);
  await within(shown, 10_000, "the switcher's menu opening");
  const listed = [...menu.children].filter(item => !item.hidden);
  Assert.deepEqual(
    listed.map(item => item.getAttribute("label") || item.id),
    [document.getElementById("sidebar-switcher-history").label, "Notes"],
    "it lists History and the extension's sidebar alone"
  );
  Assert.ok(
    document
      .getElementById("sidebar-switcher-history")
      .querySelector(".menu-icon")
      .checkVisibility(),
    "History's item shows its icon"
  );
  Assert.ok(
    document.getElementById("sidebar-switcher-bookmarks").hidden,
    "sidebar-switcher-bookmarks is not listed"
  );
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(hidden, 10_000, "the menu closing");

  await extension.unload();
  await TestUtils.waitForCondition(
    () => switcher.hidden,
    "the last extension sidebar going hides it again"
  );
  Assert.ok(!header.checkVisibility(), "and the header");
  SidebarController.hide();
  await TestUtils.waitForCondition(
    () => !SidebarController.isOpen,
    "the sidebar closes"
  );
});
