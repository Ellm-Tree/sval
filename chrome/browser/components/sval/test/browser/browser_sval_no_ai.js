/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * None of Mozilla's AI features ship in Sval (spec §2, principle 6): each is
 * locked off in app-sval-prefs.js, settings offers none of them, and the
 * menus and sidebar that would offer one are empty of it. Translations runs
 * on the device and stays.
 */

ChromeUtils.defineESModuleGetters(this, {
  AIWindow:
    "moz-src:///browser/components/aiwindow/ui/modules/AIWindow.sys.mjs",
  EngineProcess: "chrome://global/content/ml/EngineProcess.sys.mjs",
  GenAI: "resource:///modules/GenAI.sys.mjs",
});

/** Each AI pref, and the value Sval locks it to. */
const LOCKED = {
  "browser.ml.enable": false,
  "browser.ai.control.default": "blocked",
  "browser.preferences.aiControls": false,
  "browser.ml.chat.enabled": false,
  "browser.ml.chat.provider": "",
  "browser.ml.chat.page": false,
  "browser.ml.chat.menu": false,
  "browser.ml.chat.sidebar": false,
  "browser.ml.chat.shortcuts": false,
  "browser.ml.chat.shortcuts.smartwindow": false,
  "browser.ml.pageAssist.enabled": false,
  "browser.ai.control.sidebarChatbot": "blocked",
  "browser.smartwindow.enabled": false,
  "browser.smartwindow.worldcup.enabled": false,
  "browser.smartwindow.endpoint": "",
  "browser.ai.control.smartWindow": "blocked",
  "browser.ml.linkPreview.enabled": false,
  "browser.ml.linkPreview.optin": false,
  "browser.ml.linkPreview.longPress": false,
  "browser.ai.control.linkPreviewKeyPoints": "blocked",
  "browser.tabs.groups.smart.enabled": false,
  "browser.tabs.groups.smart.userEnabled": false,
  "browser.tabs.groups.smart.optin": false,
  "browser.ai.control.smartTabGroups": "blocked",
  "pdfjs.enableAltText": false,
  "pdfjs.enableGuessAltText": false,
  "pdfjs.enableAltTextModelDownload": false,
  "browser.ai.control.pdfjsAltText": "blocked",
  "extensions.ml.enabled": false,
  "browser.urlbar.quicksuggest.mlEnabled": false,
  "places.semanticHistory.featureGate": false,
  "extensions.formautofill.useml": false,
};

add_task(function ai_prefs_are_locked_off() {
  for (const [name, value] of Object.entries(LOCKED)) {
    const actual =
      typeof value == "boolean"
        ? Services.prefs.getBoolPref(name)
        : Services.prefs.getStringPref(name);
    Assert.strictEqual(actual, value, `${name} is ${JSON.stringify(value)}`);
    Assert.ok(Services.prefs.prefIsLocked(name), `${name} is locked`);
  }
});

/**
 * A feature an ESR rebase brings in arrives with a switch of its own under one
 * of these branches: an `enabled` gate, or an AI control. Each one is locked,
 * so a new feature is off until Sval decides otherwise. Translations is the
 * exception, because it runs on the device and stays.
 */
add_task(function every_ai_feature_switch_is_locked() {
  const kept = new Set(["browser.ai.control.translations"]);
  const switches = [
    "browser.ml.",
    "browser.ai.control.",
    "browser.smartwindow.",
  ]
    .flatMap(branch => Services.prefs.getChildList(branch))
    .filter(
      name =>
        !kept.has(name) &&
        (/\.enabled?$/.test(name) || name.startsWith("browser.ai.control."))
    );
  Assert.greater(switches.length, 0, "the branches hold feature switches");
  for (const name of switches) {
    Assert.ok(Services.prefs.prefIsLocked(name), `${name} is locked`);
  }
});

/**
 * Smart Window, the chatbot and link previews start from Firefox's startup
 * categories. None of them is registered, so none of them runs.
 */
add_task(function no_ai_feature_starts_with_the_browser() {
  const categories = [
    "browser-first-window-ready",
    "browser-window-delayed-startup",
    "browser-idle-startup",
    "browser-window-unload",
    "browser-quit-application-granted",
  ];
  for (const category of categories) {
    for (const { value } of Services.catMan.enumerateCategory(category)) {
      Assert.ok(
        !/\/(aiwindow|genai)\/|GenAI\.sys\.mjs/.test(value),
        `${category} does not start ${value}`
      );
    }
  }
});

add_task(function translations_stay_available() {
  Assert.ok(
    Services.prefs.getBoolPref("browser.translations.enable"),
    "translations are on"
  );
  Assert.ok(
    !Services.prefs.prefIsLocked("browser.translations.enable"),
    "translations can still be turned off"
  );
});

add_task(async function the_ml_engine_does_not_start() {
  await Assert.rejects(
    EngineProcess.getMLEngineParent(),
    /MLEngine is disabled/,
    "no feature can get an on-device inference engine"
  );
});

add_task(async function settings_offer_no_ai_controls() {
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:preferences#tabsBrowsing" },
    async browser => {
      const doc = browser.contentDocument;
      const win = browser.contentWindow;
      Assert.equal(
        doc.getElementById("category-ai-features"),
        null,
        "no AI Controls category"
      );
      Assert.equal(
        doc.querySelector('setting-pane[name="paneAi"]'),
        null,
        "no AI Controls pane"
      );
      for (const id of [
        "linkPreviewEnabled",
        "linkPreviewKeyPoints",
        "tabGroupSuggestions",
      ]) {
        const setting = win.Preferences.getSetting(id);
        Assert.ok(setting, `${id} is a setting`);
        Assert.ok(!setting.visible, `${id} is not shown`);
      }
    }
  );
});

add_task(async function no_chatbot_or_smart_window_entry_points() {
  Assert.ok(!GenAI.canShowChatEntrypoint, "no chatbot entry point is offered");
  const chat = SidebarController.sidebars.get("viewGenaiChatSidebar");
  Assert.ok(!chat?.visible, "no chatbot in the sidebar");
  const viewItem = document.getElementById("menu_genaiChatSidebar");
  Assert.ok(!viewItem || viewItem.hidden, "no chatbot in View > Sidebar");

  Assert.ok(!AIWindow.isAIWindowEnabled(), "Smart Window is unavailable");
  Assert.strictEqual(
    await AIWindow.launchWindow(gBrowser.selectedBrowser, true, "menu"),
    false,
    "Smart Window does not open"
  );
});

add_task(async function the_page_menu_offers_no_ai() {
  await BrowserTestUtils.withNewTab(
    {
      gBrowser,
      url: "data:text/html,<p id=text>Some text <a id=link href='https://example.com/'>a link</a></p>",
    },
    async browser => {
      await SpecialPowers.spawn(browser, [], () => {
        content.getSelection().selectAllChildren(content.document.body);
      });
      const menu = document.getElementById("contentAreaContextMenu");
      const shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
      await BrowserTestUtils.synthesizeMouseAtCenter(
        "#link",
        { type: "contextmenu", button: 2 },
        browser
      );
      await within(shown, 5_000, "the content context menu's popupshown");
      try {
        for (const id of [
          "context-ask-chat",
          "context-previewlink",
          "context-openlinksmartwindow",
        ]) {
          const item = document.getElementById(id);
          Assert.ok(!item || item.hidden, `${id} is hidden`);
        }
      } finally {
        const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
        menu.hidePopup();
        await within(hidden, 5_000, "the content context menu's popuphidden");
      }
    }
  );
});
