/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// Translations fetches its engine and models from the collections
// TranslationsUtils names, and Remote Settings syncs only the collections
// browser.sval.remoteSettings.collections lists (spec §10.9). A name Gecko
// uses that the list leaves out leaves Translations with no engine.
const { TranslationsUtils } = ChromeUtils.importESModule(
  "chrome://global/content/translations/TranslationsUtils.mjs"
);

add_task(function test_translations_collections_are_allowed() {
  const listed = new Set(
    Services.prefs
      .getDefaultBranch("")
      .getStringPref("browser.sval.remoteSettings.collections")
      .split(",")
      .map(entry => entry.trim().split("@")[0])
  );
  for (const name of [
    TranslationsUtils.translationsModelsCollectionName,
    TranslationsUtils.translationsWasmCollectionName,
  ]) {
    Assert.ok(listed.has(name), `${name} is allowed to sync`);
  }
});
