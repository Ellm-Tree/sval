/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */

/**
 * Settings' Extensions category (decision 1479): the list and its switch, an
 * extension's page with its switches, its own settings page and Remove,
 * extensions' shortcuts in Keyboard shortcuts and on each extension's page,
 * and search finding the category.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

ChromeUtils.defineESModuleGetters(this, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  ExtensionPermissions: "resource://gre/modules/ExtensionPermissions.sys.mjs",
  ExtensionTestCommon: "resource://testing-common/ExtensionTestCommon.sys.mjs",
  Management: "resource://gre/modules/Extension.sys.mjs",
});

const ID = "settings@sval.invalid";
const NAME = "Settings test extension";
const PRIVATE = "internal:privateBrowsingAllowed";

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel starting");
});

/**
 * Resolves when the extension next finishes starting, after a reload or an
 * enable (`Management`'s `ready`).
 *
 * @returns {Promise<void>}
 */
function nextStart() {
  return new Promise(resolve => {
    const ready = (kind, started) => {
      if (started.id === ID) {
        Management.off("ready", ready);
        resolve();
      }
    };
    Management.on("ready", ready);
  });
}

const EXTENSION = {
  manifest: {
    browser_specific_settings: { gecko: { id: ID } },
    name: NAME,
    description: "Does nothing at all",
    permissions: ["tabs"],
    optional_permissions: ["bookmarks"],
    options_ui: { page: "options.html" },
    commands: {
      "do-nothing": {
        suggested_key: { default: "Alt+Shift+9" },
        description: "Do nothing",
      },
    },
  },
  files: { "options.html": "<!doctype html><title>Options</title>" },
};

/** Installs the extension a task uses, as about:addons' tests do. */
async function installExtension() {
  const extension = ExtensionTestUtils.loadExtension({
    ...EXTENSION,
    useAddonManager: "temporary",
  });
  await extension.startup();
  return extension;
}

/**
 * Installs the extension without `ExtensionTestUtils`, whose wrapper stops
 * following an add-on that something else uninstalls
 * (`AOMExtensionWrapper.onUninstalled`). What the task leaves is removed at
 * its end.
 */
async function installRemovable() {
  const xpi = ExtensionTestCommon.generateXPI(EXTENSION);
  atTaskEnd(async () => {
    await (await AddonManager.getAddonByID(ID))?.uninstall();
    Services.obs.notifyObservers(xpi, "flush-cache-entry");
    xpi.remove(false);
  });
  await AddonManager.installTemporaryAddon(xpi);
}

/**
 * Opens Settings on the Extensions category with the extension listed.
 *
 * @returns {Promise<object>} as `openSettings`, with `row()`.
 */
async function openExtensions() {
  const ui = await openPane(
    "svalExtensions",
    ({ byId }) =>
      byId("sval-extensions-list").querySelector(`[data-extension-id="${ID}"]`),
    "the extension is listed"
  );
  ui.row = () =>
    ui
      .byId("sval-extensions-list")
      .querySelector(`[data-extension-id="${ID}"]`);
  return ui;
}

/**
 * Opens the extension's page from its row.
 *
 * @param {object} ui
 */
async function openExtensionPage(ui) {
  ui.row().querySelector(".sval-extension-link").click();
  await TestUtils.waitForCondition(
    () =>
      !ui.byId("sval-extension-page").hidden &&
      ui.byId("sval-extension-cards").querySelector("[data-extension-card]"),
    "the extension's page shows"
  );
}

add_task(async function the_list_shows_and_switches_an_extension() {
  const extension = await installExtension();
  const ui = await openExtensions();
  Assert.ok(
    ui.byId("addonsButton").hidden,
    "Firefox's footer link to add-ons is hidden"
  );
  const row = ui.row();
  Assert.equal(
    row.querySelector(".sval-extension-link").textContent,
    NAME,
    "the row names the extension"
  );
  Assert.equal(
    row.querySelector(".sval-extension-line").textContent,
    "Does nothing at all",
    "with its description"
  );
  Assert.ok(
    ui.byId("sval-extensions-empty").hidden,
    "the empty state is hidden"
  );

  const toggle = row.querySelector("input.sval-switch");
  Assert.ok(toggle.checked, "the switch is on");
  toggle.click();
  const addon = await AddonManager.getAddonByID(ID);
  await TestUtils.waitForCondition(
    () => addon.userDisabled && !ui.row().querySelector("input").checked,
    "the switch turns the extension off"
  );
  const started = nextStart();
  ui.row().querySelector("input.sval-switch").click();
  await TestUtils.waitForCondition(
    () => !addon.userDisabled && ui.row().querySelector("input").checked,
    "and on again"
  );
  await within(started, 10_000, "the extension's restart");
  await extension.unload();
  await TestUtils.waitForCondition(
    () => !ui.row(),
    "an uninstalled extension leaves the list"
  );
});

add_task(async function an_extensions_page_changes_what_it_may_do() {
  const extension = await installExtension();
  const ui = await openExtensions();
  await openExtensionPage(ui);

  Assert.ok(
    ui.tab.linkedBrowser.currentURI.spec.endsWith(
      `#svalExtensions-extension?id=${encodeURIComponent(ID)}`
    ),
    "the page has an address of its own"
  );
  Assert.equal(ui.byId("sval-extension-title").textContent, NAME);
  Assert.equal(
    ui.byId("sval-extension-crumb").getAttribute("href"),
    "#svalExtensions",
    "its breadcrumb leads to Extensions"
  );
  Assert.ok(!ui.byId("sval-extensions").checkVisibility(), "the list hides");

  const privateSwitch = () => ui.byId("sval-extension-page-private");
  const allowed = async () =>
    (await ExtensionPermissions.get(ID)).permissions.includes(PRIVATE);
  const before = await allowed();
  Assert.equal(privateSwitch().checked, before, "private windows as set");
  const reloaded = nextStart();
  privateSwitch().click();
  await TestUtils.waitForCondition(
    async () => (await allowed()) !== before,
    "Run in private windows changes the permission"
  );
  await TestUtils.waitForCondition(
    () => privateSwitch()?.checked === !before,
    "and the switch follows it"
  );
  await within(reloaded, 10_000, "the extension's reload");

  const permissions = ui.byId("sval-extension-cards");
  Assert.ok(
    permissions.querySelector(".sval-extension-permissions li"),
    "its permissions are listed in words"
  );
  const optional = permissions.querySelector("#sval-extension-page-optional-0");
  Assert.ok(optional && !optional.checked, "an optional one is off");
  optional.click();
  await TestUtils.waitForCondition(
    async () =>
      (await ExtensionPermissions.get(ID)).permissions.includes("bookmarks"),
    "its switch grants it"
  );

  const settingsCard = () =>
    permissions.querySelector('[data-extension-card="settings"]');
  Assert.ok(
    !settingsCard().querySelector("details").open,
    "the extension's own settings start collapsed"
  );
  // The extension's reload above replaces the card, collapsed again, so
  // each check opens the card as it is and finds its page.
  await TestUtils.waitForCondition(
    () =>
      (settingsCard().querySelector("details").open ||
        !settingsCard().querySelector("summary").click()) &&
      permissions
        .querySelector(
          '[data-extension-card="settings"] inline-options-browser browser'
        )
        ?.browsingContext?.currentURI?.spec.endsWith("/options.html"),
    "the extension's own settings page shows in its card"
  );

  ui.byId("sval-extension-back").click();
  await TestUtils.waitForCondition(
    () =>
      ui.byId("sval-extension-page").hidden &&
      ui.page.document.activeElement ===
        ui.row()?.querySelector(".sval-extension-link"),
    "Back returns to the list, on the extension"
  );
  await extension.unload();
});

add_task(async function remove_asks_first() {
  await installRemovable();
  const ui = await openExtensions();
  await openExtensionPage(ui);
  const dialog = ui.byId("sval-extension-dialog");
  const remove = () =>
    ui
      .byId("sval-extension-cards")
      .querySelector('[data-sval-key="page-remove"]');

  remove().click();
  Assert.ok(dialog.open, "Remove asks first");
  ui.byId("sval-extension-dialog-cancel").click();
  Assert.ok(!dialog.open, "Cancel closes the dialog");
  Assert.ok(await AddonManager.getAddonByID(ID), "and keeps the extension");

  remove().click();
  ui.byId("sval-extension-dialog-confirm").click();
  await TestUtils.waitForCondition(
    async () => !(await AddonManager.getAddonByID(ID)),
    "Remove removes it"
  );
  await TestUtils.waitForCondition(
    () => ui.byId("sval-extension-page").hidden && !ui.row(),
    "and the list shows without it"
  );
  Assert.stringContains(
    ui.byId("sval-extensions-message").textContent,
    NAME,
    "the list says which extension went"
  );
  Assert.equal(
    ui.byId("sval-extensions-empty").hidden,
    !!ui.byId("sval-extensions-list").children.length,
    "the empty state shows when nothing is listed"
  );
});

add_task(async function extensions_shortcuts_are_in_keyboard_shortcuts() {
  const extension = await installExtension();
  const ui = await openExtensions();
  await showPane(ui.page, "svalKeyboard");
  const card = await TestUtils.waitForCondition(
    () =>
      ui
        .byId("sval-keys-extensions-list")
        .querySelector(`[data-extension-id="${ID}"]`),
    "the extension's shortcuts are listed"
  );
  Assert.ok(ui.byId("sval-keys-extensions").checkVisibility(), "and shown");
  Assert.equal(card.querySelector("h2").textContent, NAME, "under its name");
  const row = card.querySelector(".sval-keys-row");
  Assert.equal(row.querySelector("th").textContent, "Do nothing");
  Assert.ok(
    row.querySelector(".sval-keys-shortcut").textContent.endsWith("9"),
    "with its key"
  );
  Assert.ok(!row.querySelector("button, sval-button"), "read-only");

  card.querySelector(`[data-sval-key="keys-change:${ID}"]`).click();
  const editable = await TestUtils.waitForCondition(
    () =>
      ui.byId("sval-extension-page").checkVisibility() &&
      ui
        .byId("sval-extension-cards")
        .querySelector(
          '[data-extension-card="shortcuts"] [data-command="do-nothing"]'
        ),
    "Change leads to the extension's own shortcuts"
  );
  Assert.equal(
    ui.page.document.activeElement,
    editable.closest("section").querySelector(".sval-site-card-title"),
    "with the focus on that card"
  );
  const commands = WebExtensionPolicy.getByID(ID).extension.shortcuts;
  editable.querySelector('[data-action="clear"]').click();
  await TestUtils.waitForCondition(
    async () =>
      !(await commands.allCommands()).find(c => c.name === "do-nothing")
        .shortcut,
    "Clear takes the shortcut away"
  );
  const reset = await TestUtils.waitForCondition(
    () =>
      ui
        .byId("sval-extension-cards")
        .querySelector(
          '[data-command="do-nothing"] [data-action="reset"]:not([hidden])'
        ),
    "and Reset is offered"
  );
  reset.click();
  await TestUtils.waitForCondition(
    async () =>
      (await commands.allCommands()).find(c => c.name === "do-nothing")
        .shortcut,
    "Reset puts the extension's own shortcut back"
  );
  await extension.unload();
});

add_task(async function search_finds_the_extensions_category() {
  await panelWithFolder(null);
  const ui = await openSettings();
  const input = ui.byId("searchInput");
  const query = "install from file";
  const done = BrowserTestUtils.waitForEvent(
    ui.page,
    "PreferencesSearchCompleted",
    false,
    event => event.detail == query
  );
  input.value = query;
  input.dispatchEvent(new ui.page.Event("input"));
  await within(done, 10_000, "the settings search completing");
  const pane = paneOf(ui.page, "svalExtensions");
  Assert.ok(
    !pane.hidden && !pane.classList.contains("visually-hidden"),
    "the Extensions category is found"
  );
});
