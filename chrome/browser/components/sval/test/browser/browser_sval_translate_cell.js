/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The site controls' translate cell (`SvalHeader`), which Firefox's
 * full-page translations drive under the id of its own button, and the
 * panel Firefox opens on it.
 */

/**
 * Moves the pointer onto `element`.
 *
 * @param {Element} element
 */
function pointAt(element) {
  EventUtils.synthesizeMouseAtCenter(element, { type: "mousemove" });
}

/**
 * Calls `open` and resolves with whether `panel` showed, or hid before it
 * could, as Gecko hides a popup whose anchor is not drawn.
 *
 * @param {Element} panel
 * @param {function(): void} open
 * @param {string} what The step, as a failure names it.
 * @returns {Promise<boolean>}
 */
async function shows(panel, open, what) {
  const settled = Promise.race([
    BrowserTestUtils.waitForEvent(panel, "popupshown").then(() => true),
    BrowserTestUtils.waitForEvent(panel, "popuphidden").then(() => false),
  ]);
  open();
  return within(settled, 10_000, what);
}

/**
 * Whether `panel` is open on an anchor that is drawn. Gecko closes a popup
 * whose anchor is not drawn at its next refresh
 * (`nsMenuPopupFrame::CheckForAnchorChange`), so a drawn anchor is what keeps
 * it open.
 *
 * @param {Element} panel
 * @returns {boolean}
 */
function staysOpen(panel) {
  return (
    panel.state === "open" &&
    panel.anchorNode.checkVisibility({ visibilityProperty: true })
  );
}

/**
 * Runs `task` on a page detected as one Firefox can translate, once Firefox
 * has shown the translate cell for it. The panel lists the languages
 * the translation models cover, which Firefox reads from Remote Settings, so
 * the models are answered here with one pair each way and nothing is fetched.
 * The page's own language detection is answered too, from before the page
 * loads, so it is what shows the button: once it has, the detection has
 * written the tab's language state, and nothing writes it again after it is
 * cleared below.
 * The pointer is left on the page and everything put back, so the next file
 * starts from the window it would have had.
 *
 * @param {function(Element): Promise<void>} task Given the cell.
 */
async function withTranslateCell(task) {
  const { prototype } = TranslationsParent;
  const { getDetectedLanguages } = prototype;
  const { getNonPivotLanguagePairs } = TranslationsParent;
  prototype.getDetectedLanguages = async () => ({
    docLangTag: "es",
    userLangTag: "en",
    isDocLangTagSupported: true,
  });
  TranslationsParent.getNonPivotLanguagePairs = async () => [
    { sourceLanguage: "es", targetLanguage: "en", variant: "" },
    { sourceLanguage: "en", targetLanguage: "es", variant: "" },
  ];
  try {
    await BrowserTestUtils.withNewTab("https://example.com/", async browser => {
      const button = document.getElementById("translations-button");
      try {
        await within(
          TestUtils.waitForCondition(() => !button.hidden),
          10_000,
          "Firefox showing the translate cell"
        );
        // Firefox sizes the field to its container from a ResizeObserver
        // (`UrlbarInput`), a frame after the cell takes its room, and until
        // then the field covers the cell.
        const container = document.getElementById("urlbar-container");
        await within(
          TestUtils.waitForCondition(
            () =>
              gURLBar.getBoundingClientRect().right <=
              container.getBoundingClientRect().right
          ),
          10_000,
          "the address field fitting its container"
        );
        await task(button);
      } finally {
        const { panel } = FullPageTranslationsPanel.elements;
        if (panel.state !== "closed") {
          const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
          PanelMultiView.hidePopup(panel);
          await within(hidden, 10_000, "the translations panel closing");
        }
        pointAt(browser);
        TranslationsParent.getTranslationsActor(
          browser
        ).languageState.detectedLanguages = null;
        await within(
          TestUtils.waitForCondition(() => button.hidden),
          10_000,
          "Firefox hiding the translate cell"
        );
      }
    });
  } finally {
    prototype.getDetectedLanguages = getDetectedLanguages;
    TranslationsParent.getNonPivotLanguagePairs = getNonPivotLanguagePairs;
  }
}

/**
 * A page in another language shows the cell in the page's cluster, drawn in
 * the idle pill with neither the pointer nor focus on the address bar,
 * between the site menu button and the favorite button, and a screen reader
 * finds it.
 */
add_task(async function the_translate_cell_shows_in_the_idle_pill() {
  await withTranslateCell(async button => {
    gBrowser.selectedBrowser.focus();
    pointAt(gBrowser.selectedBrowser);
    Assert.equal(
      button.parentNode.id,
      "nav-bar-customization-target",
      "the cell is in the header's row"
    );
    Assert.ok(
      button.checkVisibility({
        opacityProperty: true,
        visibilityProperty: true,
      }),
      "the cell is drawn in the idle pill"
    );
    const cell = button.getBoundingClientRect();
    const siteMenu = document
      .getElementById("sval-site-menu-button")
      .getBoundingClientRect();
    const favorite = document
      .getElementById("sval-favorite-button")
      .getBoundingClientRect();
    Assert.greater(cell.width, 0, "the cell has its width");
    Assert.lessOrEqual(siteMenu.right, cell.left, "after the site menu button");
    Assert.lessOrEqual(cell.right, favorite.left, "and before the favorite");
    await accessibleOf(button);
  });
});

/**
 * `TranslationsParent` offers a translation by dispatching this event from
 * the page's browser, and the panel opens on the translate cell whatever
 * the pointer and focus are doing.
 */
add_task(async function the_translation_offer_stays_open_on_the_idle_bar() {
  await withTranslateCell(async button => {
    gBrowser.selectedBrowser.focus();
    pointAt(gBrowser.selectedBrowser);
    const { panel } = FullPageTranslationsPanel.elements;
    const shown = await shows(
      panel,
      () =>
        gBrowser.selectedBrowser.dispatchEvent(
          new CustomEvent("TranslationsParent:OfferTranslation", {
            bubbles: true,
          })
        ),
      "the offer opening"
    );
    Assert.ok(shown, "the offer shows");
    Assert.equal(panel.anchorNode, button, "the offer is on the cell");
    Assert.ok(!gURLBar.focused, "the address bar is idle");
    Assert.ok(staysOpen(panel), "and the offer stays open");
  });
});

add_task(async function the_translations_panel_stays_open_under_the_pointer() {
  await withTranslateCell(async button => {
    gBrowser.selectedBrowser.focus();
    pointAt(gURLBar.inputField);
    const { panel } = FullPageTranslationsPanel.elements;
    const shown = await shows(
      panel,
      () => EventUtils.synthesizeMouseAtCenter(button, {}),
      "the click opening the panel"
    );
    Assert.ok(shown, "the panel shows");
    Assert.equal(panel.anchorNode, button, "the panel is on the cell");
    pointAt(panel);
    Assert.ok(!gURLBar.focused, "the address bar is idle");
    Assert.ok(!gURLBar.matches(":hover"), "and the pointer has left it");
    Assert.ok(staysOpen(panel), "and the panel stays open");
  });
});
