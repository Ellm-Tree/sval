/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * Settings › Search and Launcher gives every engine's row a remove button,
 * the engines Sval ships included. It asks before removing, and a default
 * engine's button is disabled (search-remove-app-engine.patch).
 */

const { PromptTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PromptTestUtils.sys.mjs"
);
const { SearchService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/search/SearchService.sys.mjs"
);

add_setup(failOnConsoleErrors);

/** Opens Settings › Search and Launcher and waits for the engine list. */
async function openEngineList() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "about:preferences#search"),
    15_000,
    "Settings › Search and Launcher"
  );
  const doc = tab.linkedBrowser.contentDocument;
  await TestUtils.waitForCondition(
    () => doc.querySelector("#engineList moz-box-item"),
    "the engine list"
  );
  return { tab, doc };
}

/**
 * The remove button on an engine's row, once the row shows.
 *
 * @param {Document} doc The settings page.
 * @param {nsISearchEngine} engine
 * @returns {Promise<Element>}
 */
function removeButton(doc, engine) {
  return TestUtils.waitForCondition(
    () => doc.getElementById(`deleteEngine-${engine.id}`),
    `${engine.name}'s remove button`
  );
}

/**
 * Presses a button and answers the confirmation it opens, which names no
 * origin above its question (prompt-no-own-origin.patch).
 *
 * @param {object} tab The settings tab.
 * @param {Element} button
 * @param {number} buttonNumClick The confirmation's button to press.
 */
async function pressAndAnswer(tab, button, buttonNumClick) {
  const shown = PromptTestUtils.waitForPrompt(tab.linkedBrowser, {
    modalType: Services.prompt.MODAL_TYPE_CONTENT,
    promptType: "confirmEx",
  });
  button.scrollIntoView();
  EventUtils.synthesizeMouseAtCenter(
    button,
    {},
    tab.linkedBrowser.contentWindow
  );
  const dialog = await within(shown, 10_000, "the confirmation");
  const root = dialog.ui.prompt.document.documentElement;
  Assert.ok(!root.hasAttribute("headertitle"), "the dialog names no origin");
  Assert.ok(
    !dialog.ui.prompt.document
      .getElementById("titleContainer")
      ?.checkVisibility(),
    "the origin row is hidden"
  );
  await within(
    PromptTestUtils.handlePrompt(dialog, { buttonNumClick }),
    10_000,
    "the confirmation closing"
  );
}

add_task(async function every_shipped_engine_has_a_remove_button() {
  const { doc } = await openEngineList();
  const defaultEngine = await SearchService.getDefault();
  for (const engine of await SearchService.getAppProvidedEngines()) {
    const button = await removeButton(doc, engine);
    Assert.equal(
      button.disabled,
      engine == defaultEngine,
      `${engine.name}'s remove button is disabled only for the default`
    );
  }
});

add_task(async function the_default_engines_button_follows_the_default() {
  const ddg = SearchService.getEngineById("ddg");
  const bing = SearchService.getEngineById("bing");
  const before = await SearchService.getDefault();
  atTaskEnd(() =>
    SearchService.setDefault(before, SearchService.CHANGE_REASON.UNKNOWN)
  );
  await SearchService.setDefault(ddg, SearchService.CHANGE_REASON.UNKNOWN);

  const { doc } = await openEngineList();
  const ddgButton = await removeButton(doc, ddg);
  const bingButton = await removeButton(doc, bing);
  Assert.ok(ddgButton.disabled, "the default's button is disabled");
  Assert.ok(!bingButton.disabled, "another engine's button is enabled");

  await SearchService.setDefault(bing, SearchService.CHANGE_REASON.UNKNOWN);
  // The list draws its rows again when an engine changes, so each check
  // reads the buttons afresh.
  await TestUtils.waitForCondition(
    () =>
      doc.getElementById(`deleteEngine-${bing.id}`)?.disabled &&
      doc.getElementById(`deleteEngine-${ddg.id}`)?.disabled === false,
    "the buttons follow the new default"
  );
});

add_task(async function removing_a_shipped_engine_asks_first() {
  // The last engine, so putting it back keeps every other engine's place.
  const engine = (await SearchService.getAppProvidedEngines()).at(-1);
  atTaskEnd(async () => {
    if (SearchService.getEngineById(engine.id)) {
      return;
    }
    SearchService._settings.setMetaDataAttribute(
      "sval-removed-app-engines",
      []
    );
    await within(
      SearchService._reloadEngines(
        await SearchService._settings.get(),
        SearchService.CHANGE_REASON.CONFIG
      ),
      10_000,
      "the engine is put back"
    );
  });

  const { tab, doc } = await openEngineList();
  const button = await removeButton(doc, engine);
  Assert.ok(!button.disabled, "the button is enabled");

  // Button 1 is Cancel.
  await pressAndAnswer(tab, button, 1);
  Assert.ok(
    SearchService.getEngineById(engine.id),
    "a cancelled removal keeps the engine"
  );

  // Button 0 is Remove.
  await pressAndAnswer(tab, button, 0);
  await TestUtils.waitForCondition(
    () => !doc.getElementById(`engineList-${engine.id}`),
    "the engine's row goes"
  );
  Assert.ok(
    !SearchService.getEngineById(engine.id),
    "the search service no longer has the engine"
  );
});
