/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * None of Mozilla's AI features ship in Sval (spec §2, principle 6). Smart
 * Window, the chatbot, link previews and smart tab groups are not built, the
 * on-device models that remain are locked off, settings offers none of them,
 * and the menus and sidebar that would offer one are empty of it.
 * Translations runs on the device and stays.
 */

ChromeUtils.defineESModuleGetters(this, {
  EngineProcess: "chrome://global/content/ml/EngineProcess.sys.mjs",
});

/** Each AI pref, and the value Sval locks it to. */
const LOCKED = {
  "browser.ml.enable": false,
  "browser.ai.control.default": "blocked",
  "pdfjs.enableAltText": false,
  "pdfjs.enableGuessAltText": false,
  "pdfjs.enableAltTextModelDownload": false,
  "browser.ai.control.pdfjsAltText": "blocked",
  "extensions.ml.enabled": false,
  "browser.urlbar.quicksuggest.mlEnabled": false,
  "places.semanticHistory.featureGate": false,
  "extensions.formautofill.useml": false,
};

/**
 * A file of each removed AI component, and the vendored model runtimes only
 * those components loaded.
 */
const REMOVED_FILES = [
  "moz-src:///browser/components/aiwindow/ui/modules/AIWindow.sys.mjs",
  "resource:///modules/GenAI.sys.mjs",
  "moz-src:///browser/components/genai/LinkPreview.sys.mjs",
  "moz-src:///browser/components/pagedata/PageDataService.sys.mjs",
  "resource://gre/actors/PageExtractorParent.sys.mjs",
  "moz-src:///browser/components/tabbrowser/SmartTabGrouping.sys.mjs",
  "chrome://browser/content/urlbar/SmartbarInput.mjs",
  "chrome://browser/content/multilineeditor/multiline-editor.mjs",
  "chrome://browser/content/preferences/config/aiFeatures.mjs",
  "chrome://global/content/ml/transformers.js",
  "chrome://global/content/ml/ort.webgpu.mjs",
  "chrome://global/content/ml/wllama-module.mjs",
  "chrome://global/content/ml/openai.mjs",
];

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
  const switches = ["browser.ml.", "browser.ai.control."]
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

add_task(function removed_ai_files_do_not_ship() {
  Assert.ok(
    packaged("chrome://global/content/ml/EngineProcess.sys.mjs"),
    "the engine process Translations runs in is found"
  );
  for (const spec of REMOVED_FILES) {
    Assert.ok(!packaged(spec), `${spec} is not in the package`);
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
        Assert.strictEqual(
          win.Preferences.getSetting(id),
          undefined,
          `${id} is not a setting`
        );
      }
    }
  );
});

add_task(function no_chatbot_or_smart_window_entry_points() {
  Assert.ok(
    !SidebarController.sidebars.has("viewGenaiChatSidebar"),
    "no chatbot in the sidebar"
  );
  for (const id of [
    "menu_genaiChatSidebar",
    "menu_newAIWindow",
    "menu_newClassicWindow",
    "chatsHistoryMenu",
    "viewGenaiChatSidebarKb",
    "ai-window-toggle",
    "smartwindow-ask-button",
    "context_askChat",
    "context-ask-chat",
    "context-previewlink",
    "context-openlinksmartwindow",
  ]) {
    Assert.equal(document.getElementById(id), null, `no #${id}`);
  }
});
