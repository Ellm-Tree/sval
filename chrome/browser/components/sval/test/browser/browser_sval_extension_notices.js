/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Extension notices on the extensions button (`SvalExtensionNotices`,
 * messages spec §6): each is a message in Firefox's extensions panel, the
 * button is badged until the panel opens, a message stays until one of its
 * buttons answers it, and none reaches the workspace panel's footer.
 */

/* import-globals-from head.js */
/* import-globals-from sval_extension_notices_helpers.js */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_extension_notices_helpers.js",
  this
);

ChromeUtils.defineESModuleGetters(this, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  CustomizableUI:
    "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
  ExtensionsUI: "resource:///modules/ExtensionsUI.sys.mjs",
  SvalPasswordManager:
    "moz-src:///browser/components/sval/SvalPasswordManager.sys.mjs",
  TAB_HIDE_WARNED_PREF:
    "moz-src:///browser/components/sval/SvalExtensionCompat.sys.mjs",
  disableContainerExtensions:
    "moz-src:///browser/components/sval/SvalExtensionCompat.sys.mjs",
});
const { AddonTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/AddonTestUtils.sys.mjs"
);
const { makeWidgetId } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
).ExtensionCommon;

AddonTestUtils.initMochitest(this);

// Firefox keeps an internal address for each extension it has loaded
// (`UUIDMap` in Extension.sys.mjs), and the entry of one these tasks remove
// is still there when the file ends.
keepPrefs(TAB_HIDE_WARNED_PREF, "extensions.webextensions.uuids");

const text = bar => noticeText(bar);

/**
 * An extension's XPI, removed when the file ends.
 *
 * @param {string} id
 * @param {string} name
 * @param {object} [manifest] More of the manifest.
 * @returns {nsIFile}
 */
function xpiFor(id, name, manifest = {}) {
  return AddonTestUtils.createTempWebExtensionFile({
    manifest: {
      browser_specific_settings: { gecko: { id } },
      name,
      ...manifest,
    },
  });
}

/**
 * Uninstalls the add-on `id` when the task ends, if it is still there.
 *
 * @param {string} id
 */
function uninstallAtTaskEnd(id) {
  atTaskEnd(async () => {
    await (await AddonManager.getAddonByID(id))?.uninstall();
  });
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

/**
 * Resolves with Firefox's permission prompt once it shows in the selected
 * browser (`ExtensionsUI.showPermissionsPrompt`).
 *
 * @returns {Promise<Element>} the prompt's `popupnotification`.
 */
function permissionPrompt() {
  const { panel } = PopupNotifications;
  return within(
    new Promise(resolve => {
      const shown = () => {
        if (PopupNotifications.getNotification("addon-webext-permissions")) {
          panel.removeEventListener("popupshown", shown);
          resolve(panel.firstElementChild);
        }
      };
      panel.addEventListener("popupshown", shown);
    }),
    10_000,
    "Firefox's permission prompt showing"
  );
}

/**
 * Clicks one of the permission prompt's buttons once the prompt is open and
 * the button can take the click.
 *
 * @param {Element} prompt From {@link permissionPrompt}.
 * @param {"button"|"secondaryButton"} which
 */
function answerPrompt(prompt, which) {
  Assert.equal(
    PopupNotifications.panel.state,
    "open",
    "the permission prompt is open"
  );
  Assert.equal(prompt.getAttribute("popupid"), "addon-webext-permissions");
  const button = prompt[which];
  Assert.ok(
    BrowserTestUtils.isVisible(button) && !button.disabled,
    "its button can take the click"
  );
  button.click();
}

/**
 * Installs `xpi` as Settings' "Install an extension from a file" does, through
 * Firefox's permission prompt, which it accepts, and waits for the extension
 * to start.
 *
 * @param {nsIFile} xpi
 * @param {string} id The extension's id.
 */
async function installFromFile(xpi, id) {
  uninstallAtTaskEnd(id);
  const prompted = permissionPrompt();
  const started = AddonTestUtils.promiseWebExtensionStartup(id);
  const install = await AddonManager.getInstallForFile(xpi);
  AddonManager.installAddonFromAOMWithOptions(
    gBrowser.selectedBrowser,
    gBrowser.currentURI,
    install,
    {}
  );
  answerPrompt(await prompted, "button");
  await within(started, 10_000, "the extension starting");
}

/**
 * Raises the notice Sval gives an extension asking for containers that it
 * turns off, as it does at startup for one a profile brought
 * (`disableContainerExtensions`). A temporary install does not pass Sval's
 * install listener, which would refuse the extension.
 *
 * @param {string} id
 * @param {string} name
 * @returns {Promise<string>} the notice's key.
 */
async function containersNotice(id, name) {
  const xpi = xpiFor(id, name, { permissions: ["contextualIdentities"] });
  uninstallAtTaskEnd(id);
  await AddonManager.installTemporaryAddon(xpi);
  await disableContainerExtensions();
  Assert.ok(
    (await AddonManager.getAddonByID(id)).userDisabled,
    "the extension is turned off"
  );
  return `disabled-containers:${id}`;
}

async function badged(on, win = window) {
  await within(
    TestUtils.waitForCondition(
      () => extensionsButton(win).hasAttribute("sval-notice") === on,
      "the extensions button's badge follows its notices"
    ),
    10_000,
    on ? "the badge showing" : "the badge clearing"
  );
}

add_task(async function an_install_opens_the_panel_with_its_message() {
  const id = "pin@sval.invalid";
  const xpi = xpiFor(id, "Pin", {
    browser_action: { default_area: "menupanel" },
  });
  const widgetId = `${makeWidgetId(id)}-browser-action`;
  // Firefox keeps a removed extension's placement for its return.
  registerCleanupFunction(() => CustomizableUI.removeWidgetFromArea(widgetId));

  let shown = extensionsPanelShown();
  await installFromFile(xpi, id);
  await shown;
  let [bar] = await waitForBars(1, "the install's message is shown");
  await within(
    TestUtils.waitForCondition(
      () => barButtons(noticeBars()[0]).length === 2,
      "the extension's button is made"
    ),
    10_000,
    "the message offering to pin the extension"
  );
  [bar] = noticeBars();
  Assert.equal(bar.dataset.key, "addon-installed", "Firefox's install notice");
  Assert.stringContains(text(bar), "Pin", "naming the extension");
  Assert.equal(bar.getAttribute("type"), "info", "as information");
  Assert.equal(bar.dataset.addonId, id, "about its extension");

  barButtons(bar)[1].click();
  await waitForBars(0, "pinning answers the message");
  Assert.equal(
    CustomizableUI.getPlacementOfWidget(widgetId)?.area,
    CustomizableUI.AREA_NAVBAR,
    "the extension's button is pinned to the header"
  );
  Assert.equal(extensionsPanel().state, "open", "the panel stays open");
  await closeExtensionsPanel();

  shown = extensionsPanelShown();
  await installFromFile(xpi, id);
  await shown;
  [bar] = await waitForBars(1, "a second install's message is shown");
  Assert.equal(barButtons(bar).length, 1, "with nothing left to pin");
  barButtons(bar)[0].click();
  await waitForBars(0, "OK answers it");
  await closeExtensionsPanel();
});

add_task(async function a_turned_off_extension_shows_a_warning_well() {
  const id = "boxes@sval.invalid";
  const key = await containersNotice(id, "Boxes");
  await badged(true);

  const [bar] = await waitForBars(1, "the warning is shown");
  Assert.equal(
    bar.dataset.key,
    key,
    "the warning that Sval turned the extension off"
  );
  Assert.stringContains(text(bar), "Boxes", "naming it");
  Assert.equal(barButtons(bar).length, 2, "with Remove, then OK");
  Assert.equal(bar.getAttribute("type"), "warning", "as a warning");

  const uninstalled = whenUninstalled(id);
  barButtons(bar)[0].click();
  await within(uninstalled, 10_000, "Remove uninstalling the extension");
  await waitForBars(0, "and the warning goes");
});

add_task(async function tab_hide_asks_remove_or_keep() {
  const id = "tabsets@sval.invalid";
  const xpi = xpiFor(id, "Tab Sets", { permissions: ["tabHide"] });
  uninstallAtTaskEnd(id);
  const shown = extensionsPanelShown();
  const install = await AddonManager.getInstallForFile(xpi);
  await install.install();
  await shown;

  const [bar] = await waitForBars(1, "the install opens the panel on it");
  Assert.equal(
    bar.dataset.key,
    `tab-hide:${id}`,
    "the warning that the extension sees one workspace's tabs"
  );
  Assert.stringContains(text(bar), "Tab Sets", "naming it");
  Assert.equal(barButtons(bar).length, 2, "with Remove, then Keep");
  Assert.equal(bar.getAttribute("type"), "warning", "as a warning");

  barButtons(bar)[1].click();
  await waitForBars(0, "Keep answers it");
  Assert.ok(
    (await AddonManager.getAddonByID(id)).isActive,
    "and keeps the extension"
  );
  Services.prefs.clearUserPref(TAB_HIDE_WARNED_PREF);
});

add_task(
  async function the_badge_clears_when_the_panel_opens_and_messages_stay() {
    const other = await within(
      BrowserTestUtils.openNewBrowserWindow(),
      15_000,
      "a second window opening"
    );
    // The new window opens in front. The task opens this window's panel, as
    // a person does in the window they are in, so this one is brought back to
    // the front once the other has finished starting.
    await within(other.SvalPanel.started, 10_000, "the other window's panel");
    await within(SimpleTest.promiseFocus(window), 10_000, "the window's focus");
    const key = await containersNotice("badge@sval.invalid", "Badge");
    await badged(true);
    await badged(true, other);
    Assert.stringContains(
      extensionsButton().getAttribute("aria-description") ?? "",
      "1",
      "a screen reader hears that a notice waits"
    );

    let [bar] = await waitForBars(1, "the panel shows the notice");
    Assert.equal(bar.dataset.key, key);
    await badged(false);
    Assert.ok(
      !extensionsButton().hasAttribute("aria-description"),
      "and stops hearing it once the panel has shown it"
    );
    await badged(true, other);

    await closeExtensionsPanel();
    Assert.equal(noticeBars().length, 0, "a closed panel holds no notice");
    Assert.ok(
      !extensionsButton().hasAttribute("sval-notice"),
      "and the badge stays clear"
    );

    [bar] = await waitForBars(1, "the notice is still there when it reopens");
    Assert.equal(bar.dataset.key, key);
    barButtons(bar)[1].click();
    await waitForBars(0, "OK answers it");
    await badged(false, other);
    await closeExtensionsPanel();
  }
);

add_task(async function the_footer_holds_no_extension_notice() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.sval.passwordManager", "none"]],
  });
  const id = "example@sval.invalid";
  const shown = extensionsPanelShown();
  await installFromFile(xpiFor(id, "Example"), id);
  await shown;

  // Offline, the password manager's download from addons.mozilla.org fails
  // without contacting it. Back online, a failed install is tried again
  // (`SvalPasswordManager`), so no manager is chosen by then.
  Services.io.offline = true;
  atTaskEnd(async () => {
    await SvalPasswordManager.choose("none");
    Services.io.offline = false;
  });
  const { failed } = await SvalPasswordManager.choose("bitwarden");
  Assert.ok(failed, "the password manager's install failed");

  const bars = await waitForBars(2, "both notices are in the panel");
  Assert.deepEqual(
    bars.map(bar => bar.dataset.key),
    ["password-manager", "addon-installed"],
    "Sval's notice, newest first, then Firefox's"
  );
  Assert.stringContains(text(bars[0]), "Bitwarden", "naming the manager");
  Assert.stringContains(text(bars[1]), "Example", "and the extension");
  Assert.equal(barButtons(bars[0]).length, 1, "with Try Again");
  Assert.equal(bars[0].getAttribute("type"), "warning");

  const footer = document.getElementById("sval-panel-container");
  for (const said of bars.map(text)) {
    Assert.ok(
      !footer.textContent.includes(said),
      `the workspace panel does not say "${said}"`
    );
  }

  await SvalPasswordManager.choose("none");
  barButtons(bars[1])[0].click();
  await waitForBars(0, "choosing no manager and answering clear them");
  await closeExtensionsPanel();
});

add_task(async function firefoxs_sideload_alert_keeps_its_action() {
  // Firefox's sideloading test's prefs: an extension put in the profile's
  // folder installs turned off, waiting for the user's answer.
  await SpecialPowers.pushPrefEnv({
    set: [["extensions.autoDisableScopes", 15]],
  });
  const id = "sideloaded@sval.invalid";
  await AddonTestUtils.manuallyInstall(xpiFor(id, "Side"));
  uninstallAtTaskEnd(id);
  // What `ExtensionsUI.init` runs at startup to find new sideloads.
  await ExtensionsUI._checkForSideloaded();

  const [bar] = await waitForBars(1, "the sideload alert is in the panel");
  Assert.equal(
    bar.dataset.key,
    `addon-sideload:${id}`,
    "as Firefox's app menu entry"
  );
  const [entry, ...more] = barButtons(bar);
  Assert.ok(!more.length, "one button");
  Assert.stringContains(entry.textContent, "Side", "naming the extension");

  const hidden = within(
    BrowserTestUtils.waitForPopupEvent(extensionsPanel(), "hidden"),
    10_000,
    "the panel closing for Firefox's prompt"
  );
  const prompted = permissionPrompt();
  entry.click();
  await hidden;
  const prompt = await prompted;
  Assert.equal(
    gBrowser.currentURI.spec,
    "about:addons",
    "Firefox's prompt shows over about:addons"
  );
  Assert.ok(
    (await AddonManager.getAddonByID(id)).seen,
    "the button runs Firefox's own action"
  );
  await badged(false);

  answerPrompt(prompt, "secondaryButton");
  Assert.ok(
    (await AddonManager.getAddonByID(id)).userDisabled,
    "and cancelling it leaves the extension off"
  );
});

add_task(async function a_key_press_opens_the_panel_with_focus_inside() {
  await containersNotice("keys@sval.invalid", "Keys");
  await badged(true);
  const button = extensionsButton();
  button.setAttribute("tabindex", "-1");
  atTaskEnd(() => button.removeAttribute("tabindex"));
  button.focus();
  Assert.equal(document.activeElement, button, "the button has the focus");

  const shown = extensionsPanelShown();
  EventUtils.synthesizeKey(" ");
  await shown;
  const [bar] = await waitForBars(1, "Space opens the panel on the notice");
  await within(
    TestUtils.waitForCondition(
      () => extensionsPanel().contains(document.activeElement),
      "the focus moves into the panel"
    ),
    10_000,
    "the focus moving into the panel"
  );
  const ok = barButtons(bar)[1];
  ok.focus();
  Assert.equal(document.activeElement, ok, "the notice's button takes focus");
  EventUtils.synthesizeKey("KEY_Enter");
  await waitForBars(0, "Enter on OK answers it");
  await closeExtensionsPanel();
});
