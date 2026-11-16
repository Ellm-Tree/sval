/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Firefox's password manager and its address and card autofill are off, so
 * the user's own password manager is the only thing on a page that saves,
 * offers or fills (spec §7.3, decision 0078).
 */

const LOGIN_PAGE =
  "data:text/html,<form><input id=user name=username autocomplete=username>" +
  "<input id=pw type=password autocomplete=current-password></form>";

add_task(async function firefoxs_password_manager_and_autofill_are_off() {
  for (const [name, value] of [
    ["signon.rememberSignons", false],
    ["signon.autofillForms", false],
    ["signon.generation.enabled", false],
    ["browser.contextual-password-manager.enabled", false],
    ["pref.privacy.disable_button.view_passwords", true],
    ["extensions.formautofill.addresses.enabled", false],
    ["extensions.formautofill.creditCards.enabled", false],
  ]) {
    Assert.equal(Services.prefs.getBoolPref(name), value, `${name}`);
    Assert.ok(Services.prefs.prefIsLocked(name), `${name} is locked`);
  }
  for (const name of [
    "extensions.formautofill.addresses.supported",
    "extensions.formautofill.creditCards.supported",
  ]) {
    Assert.equal(Services.prefs.getStringPref(name), "off", `${name}`);
    Assert.ok(Services.prefs.prefIsLocked(name), `${name} is locked`);
  }
});

add_task(async function settings_offer_no_passwords_addresses_or_cards() {
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:preferences#privacy" },
    async browser => {
      const win = browser.contentWindow;
      for (const id of [
        "savePasswords",
        "managePasswordExceptions",
        "fillUsernameAndPasswords",
        "suggestStrongPasswords",
        "requireOSAuthForPasswords",
        "manageSavedPasswords",
        "primaryPasswordNotSet",
        "primaryPasswordSet",
        "saveAndFillAddresses",
        "savedAddressesButton",
        "saveAndFillPayments",
        "savedPaymentsButton",
        "requireOSAuthForPayments",
      ]) {
        const setting = win.Preferences.getSetting(id);
        Assert.ok(setting, `${id} is a setting`);
        Assert.ok(!setting.visible, `${id} is not shown`);
      }
    }
  );
});

add_task(async function a_login_form_has_no_password_manager_menu_items() {
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: LOGIN_PAGE },
    async browser => {
      const menu = document.getElementById("contentAreaContextMenu");
      const shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
      await BrowserTestUtils.synthesizeMouseAtCenter(
        "#pw",
        { type: "contextmenu", button: 2 },
        browser
      );
      await within(shown, 5_000, "the content context menu's popupshown");
      try {
        for (const id of [
          "fill-login",
          "fill-login-generated-password",
          "use-relay-mask",
          "manage-saved-logins",
        ]) {
          Assert.ok(document.getElementById(id).hidden, `${id} is hidden`);
        }
      } finally {
        const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
        menu.hidePopup();
        await within(hidden, 5_000, "the content context menu's popuphidden");
      }
    }
  );
});

add_task(async function password_settings_offer_the_password_manager_choice() {
  const { SvalPasswordManager } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalPasswordManager.sys.mjs"
  );
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:preferences#passwordsAutofill" },
    async browser => {
      const doc = browser.contentDocument;
      const group = await TestUtils.waitForCondition(
        () =>
          doc.querySelector(
            'setting-pane[data-category="panePrivacy"] #sval-password-manager'
          ),
        "the old Passwords and autofill address shows the password manager in Privacy and protection"
      );
      Assert.ok(
        group.checkVisibility(),
        "showing there, inside the category's own pane"
      );
      Assert.deepEqual(
        [...group.querySelectorAll('input[type="radio"]')].map(r => r.value),
        SvalPasswordManager.choices(),
        "one choice per manager, and none"
      );
      Assert.equal(
        group.querySelector("input:checked")?.value,
        SvalPasswordManager.NONE,
        "nothing is chosen until the user chooses"
      );
    }
  );
});

/**
 * Arrowing through the password managers only moves the choice: nothing is
 * installed or recorded until the button under them, which says what it
 * does, and the radios stay usable all the way.
 */
add_task(async function arrowing_through_the_managers_installs_nothing() {
  const { SvalPasswordManager } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalPasswordManager.sys.mjs"
  );
  const { AddonManager } = ChromeUtils.importESModule(
    "resource://gre/modules/AddonManager.sys.mjs"
  );
  let installs = 0;
  const listener = { onNewInstall: () => installs++ };
  AddonManager.addInstallListener(listener);
  registerCleanupFunction(() => AddonManager.removeInstallListener(listener));

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:preferences#privacy" },
    async browser => {
      const page = browser.contentWindow;
      const doc = page.document;
      await TestUtils.waitForCondition(
        () => doc.querySelector("#sval-password-manager input:checked"),
        "the choice is drawn"
      );
      const group = doc.getElementById("sval-password-manager");
      const save = doc.getElementById("sval-password-manager-save");
      Assert.ok(save.disabled, "with nothing chosen there is nothing to save");
      await within(SimpleTest.promiseFocus(page), 10_000, "the page's focus");
      group.querySelector("input:checked").focus();
      const radios = [...group.querySelectorAll("input")];
      for (let i = 1; i < radios.length; i++) {
        EventUtils.synthesizeKey("KEY_ArrowDown", {}, page);
        const focused = doc.activeElement;
        Assert.ok(radios.includes(focused), "focus stays on a radio");
        Assert.ok(focused.checked, "the radio arrowed to is selected");
        Assert.ok(
          radios.every(radio => !radio.disabled),
          "and every radio stays usable"
        );
        Assert.equal(
          SvalPasswordManager.current(),
          SvalPasswordManager.NONE,
          "nothing is chosen yet"
        );
        if (focused.value === SvalPasswordManager.NONE) {
          Assert.equal(save.dataset.action, "save", "None installs nothing");
        } else {
          Assert.ok(!save.disabled, "the button would choose it");
          Assert.equal(
            save.dataset.action,
            "install",
            "and says that it adds the extension"
          );
        }
      }
      Assert.equal(installs, 0, "no extension began installing");
    }
  );
});

/**
 * Native messaging, managed storage and PKCS#11 manifests are read from
 * Sval's own folders and never from the Mozilla folders Firefox reads
 * (decision 1738). `NativeManifests` adds the type's own subdirectory to
 * each. test_sval_native_manifests_key.js covers the Windows registry.
 */
add_task(
  {
    skip_if: () => !["macosx", "linux"].includes(AppConstants.platform),
  },
  function native_manifests_are_read_from_svals_folders() {
    const user = Services.dirsvc.get("XREUserNativeManifests", Ci.nsIFile);
    Assert.equal(
      user.path,
      Services.dirsvc.get("UAppData", Ci.nsIFile).path,
      "the user's manifests are in Sval's application data directory"
    );
    const system = Services.dirsvc.get("XRESysNativeManifests", Ci.nsIFile);
    Assert.equal(
      system.path,
      AppConstants.platform == "macosx"
        ? "/Library/Application Support/Sval"
        : "/etc/sval",
      "the system's manifests are in Sval's system folder"
    );
  }
);

/**
 * Sval installs an extension only when it is the one it asked for. A listing
 * whose file is some other extension is refused before it installs.
 */
add_task(async function an_install_must_deliver_the_add_on_it_names() {
  const { SvalAddons } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAddons.sys.mjs"
  );
  const { ExtensionTestCommon } = ChromeUtils.importESModule(
    "resource://testing-common/ExtensionTestCommon.sys.mjs"
  );
  const xpi = ExtensionTestCommon.generateXPI({
    manifest: {
      manifest_version: 2,
      name: "stand-in",
      version: "1.0",
      browser_specific_settings: { gecko: { id: "delivered@sval.test" } },
    },
  });
  registerCleanupFunction(() => {
    Services.obs.notifyObservers(xpi, "flush-cache-entry");
    xpi.remove(false);
  });
  const url = Services.io.newFileURI(xpi).spec;

  await Assert.rejects(
    SvalAddons.install(url, "expected@sval.test"),
    /Install failed/,
    "an add-on with another id is refused"
  );
  Assert.equal(
    await AddonManager.getAddonByID("delivered@sval.test"),
    null,
    "and nothing was installed"
  );

  await SvalAddons.install(url, "delivered@sval.test");
  const addon = await AddonManager.getAddonByID("delivered@sval.test");
  Assert.ok(addon, "the add-on it names installs");
  await addon.uninstall();
});
