/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */

/**
 * Settings' own fields of Firefox's are Sval's: the search box is a search
 * `sval-field` (`settings-search-sval-field.patch`) that searches as typed,
 * empties with its clear button and takes the focus with its text selected
 * from Find in Settings; the home page's address field is a `sval-field`
 * that adds the address it holds. No rule of Firefox's sheets reaches
 * either.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

/**
 * Asserts that `el` looks the same with Firefox's sheets in its page on and
 * off, at rest, under the pointer and focused.
 *
 * @param {Element} el
 * @param {string} what
 */
function assertNoFirefoxSheet(el, what) {
  const doc = el.ownerDocument;
  const sheets = InspectorUtils.getAllStyleSheets(doc, true).filter(s =>
    /\/(in-content\/common|global)(-shared)?\.css$/.test(s.href ?? "")
  );
  Assert.ok(sheets.length, `${what}: the page has Firefox's sheets`);
  const inner = fieldInner(el);
  const look = () =>
    [[], [":hover"], [":focus-visible"]].map(locks => {
      locks.forEach(l => InspectorUtils.addPseudoClassLock(inner, l));
      const cs = inner.documentGlobal.getComputedStyle(inner);
      const out = [
        "color",
        "background-color",
        "border-top-color",
        "border-top-width",
        "border-top-left-radius",
        "min-height",
        "font-size",
        "font-family",
        "outline-style",
        "appearance",
      ].map(p => cs.getPropertyValue(p));
      locks.forEach(l => InspectorUtils.removePseudoClassLock(inner, l));
      return out;
    });
  const withSheets = look();
  sheets.forEach(s => (s.disabled = true));
  const without = look();
  sheets.forEach(s => (s.disabled = false));
  Assert.deepEqual(
    without,
    withSheets,
    `${what}: no rule of Firefox's sheets reaches the field`
  );
}

add_task(async function settings_search_is_a_sval_field() {
  const ui = await openSettings();
  const input = ui.byId("searchInput");
  await fieldDrawn(input);
  Assert.equal(input.localName, "sval-field", "the search box is a sval-field");
  Assert.equal(input.type, "search", "of the search kind");
  await translated(input);
  Assert.ok(input.placeholder, "Fluent gives it its placeholder");
  assertNoFirefoxSheet(input, "the search box");

  const done = query =>
    BrowserTestUtils.waitForEvent(
      ui.page,
      "PreferencesSearchCompleted",
      false,
      event => event.detail == query
    );
  let searched = done("cookies");
  await typeInto(input, "cookies");
  await within(searched, 10_000, "the search for cookies");
  Assert.equal(
    ui.page.gLastCategory.category,
    "paneSearchResults",
    "typing searches Settings"
  );

  const clear = input.shadowRoot.getElementById("clear");
  await fieldDrawn(input);
  Assert.ok(clear.checkVisibility(), "the clear button shows");
  searched = done("");
  // The clear button stays out of the Tab order, because Escape empties a
  // search from the keyboard.
  AccessibilityUtils.setEnv({ focusableRule: false });
  EventUtils.synthesizeMouseAtCenter(clear, {}, ui.page);
  AccessibilityUtils.resetEnv();
  await within(searched, 10_000, "the search emptied");
  Assert.equal(input.value, "", "its press empties the search");
  Assert.equal(
    ui.page.document.activeElement,
    input,
    "and keeps the focus there"
  );

  await typeInto(input, "home");
  input.blur();
  ui.page.document.getElementById("focusSearch1").doCommand();
  Assert.equal(
    ui.page.document.activeElement,
    input,
    "Find in Settings focuses the search"
  );
  Assert.deepEqual(
    [input.selectionStart, input.selectionEnd],
    [0, 4],
    "with its text selected"
  );
});

add_task(async function the_home_page_address_is_a_sval_field() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.startup.homepage", "about:home"]],
  });
  const ui = await openSettings();
  await showPane(ui.page, "customHomepage");
  const field = await TestUtils.waitForCondition(
    () => ui.byId("customHomepageAddUrlInput"),
    "the home page's address field"
  );
  await fieldDrawn(field);
  Assert.equal(field.localName, "sval-field", "the address is a sval-field");
  await translated(field);
  Assert.ok(field.placeholder, "Fluent gives it its placeholder");
  assertNoFirefoxSheet(field, "the address");
  await typeInto(field, "https://example.com/");
  ui.byId("customHomepageAddAddressButton").click();
  await TestUtils.waitForCondition(
    () =>
      Services.prefs.getStringPref("browser.startup.homepage") ===
      "https://example.com/",
    "Add address makes it the home page"
  );
  await TestUtils.waitForCondition(
    () => field.value === "",
    "and empties the field"
  );
});
