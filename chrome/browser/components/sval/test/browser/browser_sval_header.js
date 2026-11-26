/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Sval's header (`SvalHeader`) and the default theme it holds
 * (`SvalThemes`), in a real window.
 */

ChromeUtils.defineESModuleGetters(this, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  SvalHeader: "moz-src:///browser/components/sval/SvalHeader.sys.mjs",
  CustomizableUI:
    "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
  DEFAULT_THEME_ID: "moz-src:///browser/components/sval/SvalThemes.sys.mjs",
  HEADER_WIDGETS: "moz-src:///browser/components/sval/SvalHeader.sys.mjs",
  RECORD_WIDGETS: "moz-src:///browser/components/sval/SvalHeader.sys.mjs",
});

add_task(async function the_menu_bar_shows_where_the_window_draws_it() {
  const menubar = document.getElementById("toolbar-menubar");
  if (Services.appinfo.nativeMenubar) {
    Assert.ok(menubar.collapsed, "macOS draws the menu bar natively");
    return;
  }
  Assert.ok(!menubar.hasAttribute("autohide"), "the menu bar is shown");
});

add_task(async function the_menu_bar_cannot_be_hidden() {
  if (Services.appinfo.nativeMenubar) {
    return;
  }
  const menubar = document.getElementById("toolbar-menubar");
  Assert.ok(
    !menubar.hasAttribute("toolbarname"),
    "no menu lists a toggle for the menu bar"
  );
  // A profile that hid it before keeps nothing of that.
  menubar.setAttribute("autohide", "true");
  SvalHeader.showMenuBar(document);
  Assert.ok(!menubar.hasAttribute("autohide"), "it is shown at every start");
});

add_task(async function the_nav_bar_holds_the_header_widgets_in_order() {
  const placements = CustomizableUI.getWidgetIdsInArea(
    CustomizableUI.AREA_NAVBAR
  );
  Assert.deepEqual(
    placements.slice(0, HEADER_WIDGETS.length),
    HEADER_WIDGETS,
    "sval's widgets lead the row in order"
  );
  Assert.deepEqual(
    placements.slice(-RECORD_WIDGETS.length - 1),
    ["unified-extensions-button", ...RECORD_WIDGETS],
    "the extensions button, then the records, close the row"
  );
});

add_task(async function a_widget_added_to_the_row_is_arranged_away() {
  CustomizableUI.addWidgetToArea("bookmarks-menu-button", "nav-bar");
  registerCleanupFunction(() =>
    CustomizableUI.removeWidgetFromArea("bookmarks-menu-button")
  );
  Assert.ok(
    !CustomizableUI.getWidgetIdsInArea("nav-bar").includes(
      "bookmarks-menu-button"
    ),
    "a widget outside the header's list leaves the row"
  );
  Assert.equal(
    CustomizableUI.getWidgetIdsInArea("nav-bar").at(-1),
    "sval-private-badge",
    "and the private badge is still last"
  );
});

add_task(async function customize_mode_is_closed() {
  Assert.equal(
    document.getElementById("cmd_CustomizeToolbars").getAttribute("disabled"),
    "true",
    "the customize command is disabled"
  );
  for (const id of ["menu_customizeToolbars", "toolbar-context-customize"]) {
    Assert.ok(document.getElementById(id).hidden, `${id} is not offered`);
  }
});

/**
 * Right-clicks a header widget and reports the toolbar context menu it raised:
 * whether its `popupshowing` was cancelled, and the items left visible. The
 * menu is closed again before this returns.
 *
 * @param {string} id
 * @returns {Promise<{cancelled: boolean, visible: Element[]}>}
 */
async function openToolbarContextMenu(id) {
  const menu = document.getElementById("toolbar-context-menu");
  const showing = BrowserTestUtils.waitForEvent(menu, "popupshowing");
  EventUtils.synthesizeMouseAtCenter(document.getElementById(id), {
    type: "contextmenu",
    button: 2,
  });
  const event = await within(showing, 10_000, `the context menu on ${id}`);
  // The promise can settle between listeners; SvalHeader's runs on the window,
  // after this one, so read the outcome once the dispatch is over.
  await TestUtils.waitForTick();
  const visible = [...menu.children].filter(item => !item.hidden);
  if (event.defaultPrevented) {
    Assert.equal(menu.state, "closed", `the menu stays closed on ${id}`);
  } else {
    await within(
      BrowserTestUtils.waitForPopupEvent(menu, "shown"),
      10_000,
      "the context menu showing"
    );
    const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
    menu.hidePopup();
    await within(hidden, 10_000, "the context menu hiding");
  }
  return { cancelled: event.defaultPrevented, visible };
}

const LAYOUT_ITEMS = [
  "#toolbar-context-customize",
  ".customize-context-moveToPanel",
  ".customize-context-removeFromToolbar",
];

add_task(async function a_button_with_nothing_to_offer_opens_no_menu() {
  const { cancelled } = await openToolbarContextMenu("home-button");
  Assert.ok(cancelled, "no menu opens on home-button");
});

add_task(async function no_header_widget_offers_a_layout_change() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.download.autohideButton", false]],
  });
  const downloads = document.getElementById("downloads-button");
  await TestUtils.waitForCondition(
    () => !downloads.hidden && downloads.getBoundingClientRect().width,
    "the downloads button is drawn"
  );
  for (const id of ["unified-extensions-button", "downloads-button"]) {
    const { visible } = await openToolbarContextMenu(id);
    for (const selector of LAYOUT_ITEMS) {
      Assert.ok(
        !visible.some(item => item.matches(selector)),
        `${selector} is not offered on ${id}`
      );
    }
  }

  const { cancelled, visible } =
    await openToolbarContextMenu("downloads-button");
  Assert.ok(!cancelled, "the downloads button keeps its own items");
  Assert.ok(
    visible.some(
      item => item.id === "toolbar-context-autohide-downloads-button"
    ),
    "such as hiding it when there are no downloads"
  );
  Assert.notEqual(
    visible.at(-1)?.localName,
    "menuseparator",
    "no separator closes the menu"
  );
  await SpecialPowers.popPrefEnv();
});

add_task(async function back_and_forward_keep_their_history_menu() {
  const page = "https://example.com/browser/";
  await BrowserTestUtils.withNewTab(page, async browser => {
    for (const query of ["?second", "?third"]) {
      const loaded = BrowserTestUtils.browserLoaded(browser);
      BrowserTestUtils.startLoadingURIString(browser, page + query);
      await within(loaded, 10_000, `the load of ${query}`);
    }
    const back = BrowserTestUtils.waitForLocationChange(
      gBrowser,
      `${page}?second`
    );
    browser.goBack();
    await within(back, 10_000, "going back");
    await TestUtils.waitForCondition(
      () =>
        !document.getElementById("back-button").disabled &&
        !document.getElementById("forward-button").disabled,
      "both directions have history"
    );

    for (const id of ["back-button", "forward-button"]) {
      const menu = document.getElementById("backForwardMenu");
      const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
      EventUtils.synthesizeMouseAtCenter(document.getElementById(id), {
        type: "contextmenu",
        button: 2,
      });
      await within(shown, 10_000, `the history menu on ${id}`);
      Assert.equal(
        menu.querySelectorAll("menuitem").length,
        3,
        `${id} lists the tab's history`
      );
      const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
      menu.hidePopup();
      await within(hidden, 10_000, "the history menu hiding");
    }
  });
});

add_task(async function a_header_widget_moved_away_is_put_back() {
  const inOrder = () =>
    CustomizableUI.getWidgetIdsInArea(CustomizableUI.AREA_NAVBAR)
      .slice(0, HEADER_WIDGETS.length)
      .join() === HEADER_WIDGETS.join();

  CustomizableUI.removeWidgetFromArea("stop-reload-button");
  await TestUtils.waitForCondition(inOrder, "a removed widget comes back");

  CustomizableUI.addWidgetToArea(
    "stop-reload-button",
    CustomizableUI.AREA_FIXED_OVERFLOW_PANEL
  );
  await TestUtils.waitForCondition(
    inOrder,
    "a widget moved to the overflow menu comes back"
  );
  Assert.ok(
    !CustomizableUI.getWidgetIdsInArea(
      CustomizableUI.AREA_FIXED_OVERFLOW_PANEL
    ).includes("stop-reload-button"),
    "and leaves the overflow menu"
  );

  CustomizableUI.moveWidgetWithinArea("back-button", 4);
  await TestUtils.waitForCondition(inOrder, "a reordered widget goes back");
});

add_task(async function the_address_bar_shows_only_the_domain_until_focused() {
  await BrowserTestUtils.withNewTab(
    "https://www.example.com/browser/",
    async () => {
      const label = document.getElementById("sval-urlbar-domain");
      Assert.equal(
        label.querySelector(".sval-urlbar-host").textContent,
        "example.com",
        "the host, no www."
      );
      Assert.equal(label.getAttribute("aria-hidden"), "true");
      Assert.ok(gURLBar.hasAttribute("sval-domain-only"));
      Assert.ok(
        gURLBar.value.includes("/browser/"),
        "the field keeps the full address"
      );
    }
  );
});

add_task(async function the_path_drops_whole_pieces_from_its_left() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.sval.urlbar.display", "path"]],
  });
  await BrowserTestUtils.withNewTab(
    "https://example.com/browser/chrome/browser/?q=1#top",
    async () => {
      const label = document.getElementById("sval-urlbar-domain");
      const host = label.querySelector(".sval-urlbar-host");
      const tail = label.querySelector(".sval-urlbar-tail");
      const key = document.getElementById("sval-urlbar-key");
      Assert.equal(host.textContent, "example.com");
      Assert.equal(tail.textContent, "/browser/chrome/browser/", "no query");
      Assert.ok(key.textContent, "the Launcher's key is named");
      Assert.ok(!key.hidden, "with room, the key shows");

      await SpecialPowers.pushPrefEnv({
        set: [["browser.sval.urlbar.display", "full"]],
      });
      Assert.equal(
        tail.textContent,
        "/browser/chrome/browser/?q=1#top",
        "the full address after the host"
      );
      await SpecialPowers.popPrefEnv();

      const box = gURLBar.querySelector(".urlbar-input-box");
      const room = host.getBoundingClientRect().width;
      try {
        box.style.maxWidth = `${room + 80}px`;
        await TestUtils.waitForCondition(
          () => tail.textContent.startsWith("\u2026"),
          "a narrow field drops pieces from the left"
        );
        Assert.ok(key.hidden, "the key goes before any piece");
        Assert.ok(
          ["/browser/", "/chrome/browser/", "/"].some(
            end => tail.textContent === "\u2026" + end
          ),
          "what is left is whole pieces from the right"
        );
        box.style.maxWidth = `${room + 4}px`;
        await TestUtils.waitForCondition(
          () => tail.textContent === "",
          "a piece that does not fit is left out, never cut"
        );
      } finally {
        box.style.maxWidth = "";
      }
      await TestUtils.waitForCondition(
        () => tail.textContent === "/browser/chrome/browser/" && !key.hidden,
        "room again shows the whole path and the key"
      );
    }
  );
  await SpecialPowers.popPrefEnv();
});

add_task(function the_address_bar_reserves_no_room_for_firefoxs_icons() {
  Assert.equal(
    getComputedStyle(document.documentElement)
      .getPropertyValue("--urlbar-container-min-width")
      .trim(),
    "140px",
    "the address bar's minimum is Firefox's narrowest at every width"
  );
});

add_task(function the_header_has_no_app_menu_button_or_spacer() {
  Assert.equal(document.getElementById("PanelUI-button"), null);
  Assert.equal(
    document.querySelector('#nav-bar > .titlebar-spacer[type="post-tabs"]'),
    null
  );
  PanelUI.show();
  Assert.equal(PanelUI.panel.state, "closed", "the app menu does not open");
});

add_task(async function a_non_web_page_shows_its_full_address() {
  await BrowserTestUtils.withNewTab("about:license", async () => {
    Assert.ok(!gURLBar.hasAttribute("sval-domain-only"));
  });
});

add_task(async function another_theme_never_stays_enabled() {
  // Starting a theme gives it an internal address of its own, which Firefox
  // keeps after the theme is disabled (`UUIDMap` in Extension.sys.mjs).
  keepPrefs("extensions.webextensions.uuids");
  const dark = await AddonManager.getAddonByID(
    "firefox-compact-dark@mozilla.org"
  );
  Assert.ok(dark, "Firefox's built-in dark theme is present to try");
  await dark.enable();
  await TestUtils.waitForCondition(
    () =>
      Services.prefs.getCharPref("extensions.activeThemeID") ===
      DEFAULT_THEME_ID,
    "the default theme is put back"
  );
  Assert.ok(!dark.isActive, "the other theme is disabled again");
});

add_task(async function a_private_window_wears_the_private_header() {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20_000,
    "the private window's opening"
  );
  const badge = win.document.getElementById("sval-private-badge");
  Assert.equal(badge.querySelector("label").value, "Private");
  await within(
    BrowserTestUtils.closeWindow(win),
    20_000,
    "the private window's closing"
  );
});

add_task(async function the_theme_list_shows_extensions_instead() {
  await BrowserTestUtils.withNewTab("about:addons", async browser => {
    await TestUtils.waitForCondition(
      () => browser.contentWindow?.gViewController?.currentViewId,
      "the add-ons page shows a view"
    );
    const win = browser.contentWindow;
    await within(win.promiseInitialized, 10_000, "the add-ons page's start");
    win.loadView("addons://list/theme");
    await TestUtils.waitForCondition(
      () =>
        win.gViewController.currentViewId === "addons://list/extension" &&
        win.document.querySelector("addon-list")?.getAttribute("type") ===
          "extension",
      "the extensions list is shown"
    );
  });
});

add_task(function arrange_is_idempotent() {
  const before = CustomizableUI.getWidgetIdsInArea("nav-bar");
  SvalHeader.arrange();
  Assert.deepEqual(CustomizableUI.getWidgetIdsInArea("nav-bar"), before);
});

/**
 * Every preset tints the window with a colour of its own, so the tint still
 * tells workspaces apart.
 */
add_task(function every_workspace_colour_tints_differently() {
  const { SvalColor } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalColor.sys.mjs"
  );
  const tints = SvalColor.PRESETS.map(token =>
    SvalColor.css(SvalPanel.windowLookOf(token).tint)
  );
  Assert.equal(
    new Set(tints).size,
    SvalColor.PRESETS.length,
    `no two colours share a tint: ${tints.join(" | ")}`
  );
});

/**
 * Shows a confirmation hint through `show` and resolves with the element it
 * was anchored to, once it is up, then takes it down.
 *
 * @param {() => void} show
 * @returns {Promise<Element>}
 */
async function hintAnchor(show) {
  const shown = BrowserTestUtils.waitForEvent(
    document,
    "popupshown",
    true,
    event => event.target.id === "confirmation-hint"
  );
  show();
  const { target: panel } = await within(
    shown,
    10_000,
    "the confirmation hint showing"
  );
  const anchor = panel.anchorNode;
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  panel.hidePopup();
  await within(hidden, 10_000, "the confirmation hint hiding");
  return anchor;
}

/**
 * Firefox anchors a confirmation hint to its app menu button when the widget
 * the hint is about is not in the toolbar. The header draws no app menu
 * button, so each of those hints shows on the panel toggle.
 */
add_task(async function a_screenshot_copied_hint_shows_on_the_panel_toggle() {
  const { ScreenshotsUtils } = ChromeUtils.importESModule(
    "moz-src:///browser/components/screenshots/ScreenshotsUtils.sys.mjs"
  );
  Assert.ok(
    !document.getElementById("screenshot-button")?.checkVisibility(),
    "the header has no Screenshots button"
  );
  const anchor = await hintAnchor(() =>
    ScreenshotsUtils.showCopiedConfirmationHint(gBrowser.selectedBrowser)
  );
  Assert.equal(anchor.id, "sval-panel-button", "the hint is on the toggle");
  Assert.ok(anchor.checkVisibility(), "which is drawn");
});

add_task(async function a_page_bookmarked_hint_shows_on_the_panel_toggle() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.bookmarks.editDialog.confirmationHintShowCount", 0]],
  });
  const anchor = await hintAnchor(() => StarUI.showConfirmation());
  Assert.equal(anchor.id, "sval-panel-button", "the hint is on the toggle");
  Assert.ok(anchor.checkVisibility(), "which is drawn");
  await SpecialPowers.popPrefEnv();
});

add_task(async function an_extensions_button_hint_shows_on_the_panel_toggle() {
  await SpecialPowers.pushPrefEnv({
    set: [["extensions.unifiedExtensions.button.always_visible", true]],
  });
  const anchor = await hintAnchor(() =>
    gUnifiedExtensions.hideExtensionsButtonFromToolbar()
  );
  Assert.equal(anchor.id, "sval-panel-button", "the hint is on the toggle");
  Assert.ok(anchor.checkVisibility(), "which is drawn");
  await SpecialPowers.popPrefEnv();
});

/**
 * Reopens the full-page translations panel as its "Change source language"
 * does, with the page's languages detected as `detected`, and resolves with
 * the element the panel was anchored to, once it is up, then takes it down.
 *
 * @param {object} detected `TranslationsParent`'s `LangTags`.
 * @returns {Promise<Element>}
 */
async function changeSourceLanguageAnchor(detected) {
  const actor = TranslationsParent.getTranslationsActor(
    gBrowser.selectedBrowser
  );
  const { getDetectedLanguages } = actor;
  actor.getDetectedLanguages = async () => detected;
  try {
    const shown = BrowserTestUtils.waitForEvent(
      document,
      "popupshown",
      true,
      event => event.target.id === "full-page-translations-panel"
    );
    await FullPageTranslationsPanel.onChangeSourceLanguage(null);
    const { target: panel } = await within(
      shown,
      10_000,
      "the translations panel showing"
    );
    const anchor = panel.anchorNode;
    const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    PanelMultiView.hidePopup(panel);
    await within(hidden, 10_000, "the translations panel hiding");
    return anchor;
  } finally {
    actor.getDetectedLanguages = getDetectedLanguages;
  }
}

/**
 * Firefox opens the translations panel on its app menu button when the
 * address bar's translations button is hidden or did not open it. The header
 * draws no app menu button, so the panel opens on the panel toggle.
 */
add_task(async function the_translations_panel_opens_on_the_panel_toggle() {
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    const button = document.getElementById("translations-button");
    Assert.ok(!button.checkVisibility(), "the translations button is hidden");
    const anchor = await changeSourceLanguageAnchor({
      docLangTag: "xx",
      userLangTag: "en",
      isDocLangTagSupported: false,
    });
    Assert.equal(anchor.id, "sval-panel-button", "the panel is on the toggle");
    Assert.ok(anchor.checkVisibility(), "which is drawn");
  });
});

/**
 * F6 reaches the workspace panel: the address bar, then the tree's current
 * row, then the page. Shift+F6 runs the same stops backwards.
 */
add_task(async function f6_stops_at_the_workspace_panel() {
  await BrowserTestUtils.withNewTab("https://example.com/", async browser => {
    const panel = document.getElementById("sval-panel-container");
    const inTree = () =>
      !!document.activeElement?.closest('#sval-panel-container [role="tree"]');
    gURLBar.focus();
    EventUtils.synthesizeKey("KEY_F6");
    await TestUtils.waitForCondition(inTree, "F6 moves into the tree");
    Assert.equal(
      document.activeElement.getAttribute("tabindex"),
      "0",
      "at the row the tree keeps as its stop"
    );
    Assert.ok(panel.contains(document.activeElement));

    EventUtils.synthesizeKey("KEY_F6", { shiftKey: true });
    await TestUtils.waitForCondition(
      () => gURLBar.focused,
      "Shift+F6 goes back to the address bar"
    );

    EventUtils.synthesizeKey("KEY_F6");
    await TestUtils.waitForCondition(inTree, "F6 moves into the tree again");
    EventUtils.synthesizeKey("KEY_F6");
    await TestUtils.waitForCondition(
      () => document.activeElement === browser,
      "and on to the page"
    );

    EventUtils.synthesizeKey("KEY_F6", { shiftKey: true });
    await TestUtils.waitForCondition(
      inTree,
      "Shift+F6 from the page goes back to the tree"
    );
    Assert.ok(
      await SpecialPowers.spawn(
        browser,
        [],
        () => !content.document.hasFocus()
      ),
      "and the page no longer has focus"
    );
  });
});
