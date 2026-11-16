/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * about:license and about:buildconfig set their own CSP, which
 * `info-pages-allow-chrome-fonts.patch` opens to `chrome:` fonts, so their
 * text draws in Sval's Outfit.
 */

for (const url of ["about:license", "about:buildconfig"]) {
  add_task(async function text_is_outfit() {
    const tab = await openPage(url);
    const families = await within(
      SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
        const doc = content.document;
        await ContentTaskUtils.waitForCondition(
          () =>
            [...doc.fonts].some(
              // A face from an `@font-face` rule keeps its family's quotes.
              face =>
                face.family.replaceAll('"', "") === "Outfit" &&
                face.status === "loaded"
            ),
          "Outfit loaded in the page"
        );
        const range = doc.createRange();
        range.selectNodeContents(doc.querySelector("h1") ?? doc.body);
        return InspectorUtils.getUsedFontFaces(range).map(
          face => face.CSSFamilyName
        );
      }),
      15_000,
      `${url} drawing its text`
    );
    Assert.ok(
      families.includes("Outfit"),
      `${url} draws its heading in Outfit (${families.join(", ")})`
    );
    BrowserTestUtils.removeTab(tab);
  });
}
