/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Reader view in Sval's design (`SvalPageStyle`, `pages/reader.css`): it
 * takes Sval's sheets, and Outfit loads in its process.
 */

ChromeUtils.defineESModuleGetters(this, {
  PAGE_SHEET: "moz-src:///browser/components/sval/SvalPageStyle.sys.mjs",
  sheetsFor: "moz-src:///browser/components/sval/SvalPageStyle.sys.mjs",
});

const ARTICLE =
  "https://example.com/browser/browser/components/sval/test/browser/sval_reader_article.html";
const READER = `about:reader?url=${encodeURIComponent(ARTICLE)}`;

/**
 * Opens the article in reader view under `scheme`, and resolves with the
 * body's scheme classes and whether Outfit has loaded once the article shows.
 *
 * @param {string} scheme A `reader.color_scheme` value.
 */
async function readerLook(scheme) {
  await SpecialPowers.pushPrefEnv({
    set: [["reader.color_scheme", scheme]],
  });
  const tab = await openPage(READER);
  const look = await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    await ContentTaskUtils.waitForCondition(
      () => content.document.body.classList.contains("loaded"),
      "reader view shows the article"
    );
    const doc = content.document;
    await doc.fonts.ready;
    return {
      scheme: [...doc.body.classList].filter(c => c != "loaded"),
      outfit: doc.fonts.check("16px Outfit"),
    };
  });
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
  return look;
}

add_task(function reader_view_takes_its_sheets() {
  Assert.deepEqual(
    sheetsFor(READER),
    [PAGE_SHEET, "chrome://browser/content/sval/pages/reader.css"],
    "reader view takes the page sheet, then its own, whatever article it shows"
  );
});

add_task(async function the_light_scheme_loads_outfit() {
  const look = await readerLook("light");
  Assert.ok(look.scheme.includes("light"), "the light scheme is on");
  Assert.ok(look.outfit, "Outfit loads in reader view's process");
});
