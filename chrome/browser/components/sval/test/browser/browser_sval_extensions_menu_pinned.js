/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The toolbar's extensions menu lists every extension, a pinned one too, and
 * a pinned one unpins from its row's menu (`SvalExtensionsMenu`,
 * extensions-menu-lists-pinned.patch).
 */

const ID = "pinned@sval.invalid";

async function loadExtension() {
  const extension = ExtensionTestUtils.loadExtension({
    manifest: {
      name: "Pinned test extension",
      browser_specific_settings: { gecko: { id: ID } },
      browser_action: { default_area: "menupanel" },
    },
    useAddonManager: "temporary",
  });
  await extension.startup();
  // CustomizableUI keeps a button's place by its widget id after the
  // extension goes, so each task starts unpinned and ends unpinned.
  gUnifiedExtensions.pinToToolbar(widgetIdOf(), false);
  atTaskEnd(async () => {
    gUnifiedExtensions.pinToToolbar(widgetIdOf(), false);
    await extension.unload();
  });
  return extension;
}

function widgetIdOf() {
  return gUnifiedExtensions.browserActionFor(WebExtensionPolicy.getByID(ID))
    .widget.id;
}

async function openMenu() {
  const panel = document.getElementById("unified-extensions-panel");
  const shown = BrowserTestUtils.waitForPopupEvent(panel, "shown");
  gUnifiedExtensions.openPanel();
  await within(shown, 10_000, "the extensions menu opening");
  atTaskEnd(async () => {
    if (panel.state !== "closed") {
      await closeMenu(panel);
    }
  });
  return panel;
}

async function closeMenu(panel) {
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  PanelMultiView.hidePopup(panel);
  await within(hidden, 10_000, "the extensions menu closing");
}

/**
 * The extension's rows in the menu: its button where the menu holds it, or a
 * row of the list.
 *
 * @param {Element} panel
 * @returns {Element[]}
 */
function rowsOf(panel) {
  const widgetId = widgetIdOf();
  return [...panel.querySelectorAll(".unified-extensions-item")].filter(
    row =>
      row.id === widgetId ||
      row.dataset.widgetId === widgetId ||
      row.getAttribute("extension-id") === ID
  );
}

add_task(async function test_pinned_listed() {
  await loadExtension();
  gUnifiedExtensions.pinToToolbar(widgetIdOf(), true);
  const panel = await openMenu();
  const rows = rowsOf(panel);
  Assert.equal(rows.length, 1, "the pinned extension has one row");
  Assert.equal(rows[0].dataset.widgetId, widgetIdOf(), "naming its button");
  Assert.ok(
    panel.querySelector("#unified-extensions-empty-state").hidden,
    "the menu is not empty"
  );
});

add_task(async function test_unpin_from_menu() {
  await loadExtension();
  const widgetId = widgetIdOf();
  gUnifiedExtensions.pinToToolbar(widgetId, true);
  const panel = await openMenu();
  const button = rowsOf(panel)[0].querySelector(
    ".unified-extensions-item-menu-button"
  );
  const menu = document.getElementById("unified-extensions-context-menu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(button, {});
  await within(shown, 10_000, "the row's menu opening");
  const pin = menu.querySelector(
    ".unified-extensions-context-menu-pin-to-toolbar"
  );
  Assert.ok(!pin.hidden, "Pin to Toolbar shows");
  Assert.ok(pin.hasAttribute("checked"), "checked, as it is pinned");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(pin);
  await within(hidden, 10_000, "the row's menu closing");
  await TestUtils.waitForCondition(
    () =>
      CustomizableUI.getPlacementOfWidget(widgetId)?.area ===
      CustomizableUI.AREA_ADDONS,
    "the extension is unpinned"
  );
  Assert.equal(rowsOf(panel).length, 1, "and still listed once");
});

add_task(async function test_unpinned_listed_once() {
  await loadExtension();
  const panel = await openMenu();
  Assert.equal(rowsOf(panel).length, 1, "an unpinned extension has one row");
});

add_task(async function test_button_opens_menu_with_every_extension_pinned() {
  await loadExtension();
  gUnifiedExtensions.pinToToolbar(widgetIdOf(), true);
  // The harness's own extensions sit in the menu; a profile whose one
  // extension is pinned has none there.
  const { getActivePolicies } = gUnifiedExtensions;
  gUnifiedExtensions.getActivePolicies = (...args) =>
    getActivePolicies
      .apply(gUnifiedExtensions, args)
      .filter(policy => policy.id === ID);
  atTaskEnd(() => {
    gUnifiedExtensions.getActivePolicies = getActivePolicies;
  });
  Assert.ok(
    !gUnifiedExtensions.hasExtensionsInPanel(),
    "every extension is pinned"
  );
  const panel = document.getElementById("unified-extensions-panel");
  const shown = BrowserTestUtils.waitForPopupEvent(panel, "shown");
  const tabs = gBrowser.tabs.length;
  EventUtils.synthesizeMouseAtCenter(gUnifiedExtensions.button, {
    type: "mousedown",
  });
  await within(shown, 10_000, "the extensions menu opening");
  atTaskEnd(() => closeMenu(panel));
  Assert.equal(gBrowser.tabs.length, tabs, "no Settings tab opens");
  Assert.equal(rowsOf(panel).length, 1, "and the pinned extension is listed");
});

add_task(async function test_pinned_row_opens_its_popup() {
  const id = "pinned-popup@sval.invalid";
  const extension = ExtensionTestUtils.loadExtension({
    manifest: {
      name: "Pinned popup test extension",
      browser_specific_settings: { gecko: { id } },
      browser_action: { default_area: "navbar", default_popup: "popup.html" },
    },
    files: {
      "popup.html": `<!DOCTYPE html><meta charset="utf-8"><script src="popup.js"></script>`,
      "popup.js": () => {
        // eslint-disable-next-line no-undef -- the extension page's API
        browser.test.sendMessage("popup-opened");
      },
    },
    useAddonManager: "temporary",
  });
  await extension.startup();
  const widgetId = gUnifiedExtensions.browserActionFor(
    WebExtensionPolicy.getByID(id)
  ).widget.id;
  atTaskEnd(async () => {
    gUnifiedExtensions.pinToToolbar(widgetId, false);
    await extension.unload();
  });
  const panel = await openMenu();
  const row = panel.querySelector(`[data-widget-id="${widgetId}"]`);
  const action = row.querySelector(".unified-extensions-item-action-button");
  Assert.ok(!action.disabled, "the pinned extension's row can be clicked");
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  action.doCommand();
  await within(hidden, 10_000, "the extensions menu closing");
  await within(
    extension.awaitMessage("popup-opened"),
    10_000,
    "the extension's popup opening"
  );
  const view = document.getElementById("customizationui-widget-panel");
  if (view) {
    const viewHidden = BrowserTestUtils.waitForPopupEvent(view, "hidden");
    view.hidePopup();
    await within(viewHidden, 10_000, "the extension's popup closing");
  }
});

add_task(async function test_pin_button_pins_and_unpins() {
  await loadExtension();
  const panel = await openMenu();
  const pinOf = () => rowsOf(panel)[0]?.querySelector(".sval-extension-pin");
  Assert.equal(rowsOf(panel).length, 1, "the extension has one row");
  Assert.equal(pinOf().getAttribute("aria-pressed"), "false", "unpinned");
  pinOf().click();
  await TestUtils.waitForCondition(
    () =>
      CustomizableUI.getPlacementOfWidget(widgetIdOf())?.area ===
      CustomizableUI.AREA_NAVBAR,
    "the extension pinned to the toolbar"
  );
  await TestUtils.waitForCondition(
    () => pinOf()?.getAttribute("aria-pressed") === "true",
    "its row in the menu showing it pinned"
  );
  Assert.equal(rowsOf(panel).length, 1, "with one row still");
  Assert.ok(
    !document
      .getElementById(widgetIdOf())
      .querySelector(".sval-extension-pin")
      ?.checkVisibility(),
    "the toolbar button shows no pin"
  );
  pinOf().click();
  await TestUtils.waitForCondition(
    () =>
      CustomizableUI.getPlacementOfWidget(widgetIdOf())?.area ===
      CustomizableUI.AREA_ADDONS,
    "the extension unpinned"
  );
  await TestUtils.waitForCondition(
    () => pinOf()?.getAttribute("aria-pressed") === "false",
    "its row showing it unpinned"
  );
});

add_task(async function test_row_menu_button_is_more() {
  await loadExtension();
  const panel = await openMenu();
  const button = rowsOf(panel)[0].querySelector(
    ".unified-extensions-item-menu-button"
  );
  Assert.ok(
    getComputedStyle(button).listStyleImage.includes("icons/more.svg"),
    "the row's menu button shows the more icon"
  );
});

add_task(async function test_menu_button_hover_keeps_message() {
  await loadExtension();
  const panel = await openMenu();
  const row = rowsOf(panel)[0];
  const deck = row.querySelector(".unified-extensions-item-message-deck");
  const button = row.querySelector(".unified-extensions-item-menu-button");
  const before = deck.selectedIndex;
  button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  button.focus();
  Assert.equal(
    deck.selectedIndex,
    before,
    "the row keeps its message while its menu button is hovered or focused"
  );
  const action = row.querySelector(".unified-extensions-item-action-button");
  action.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  action.focus();
  Assert.equal(
    deck.selectedIndex,
    before,
    "and while the extension's own button is hovered or focused"
  );
});
