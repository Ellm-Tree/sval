/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * about:license opens with Sval's own license: who made it, the AGPL grant
 * with the app store permission, the warranty disclaimer, and both texts in
 * full, as AGPL section 5(d) asks of an interactive program, then the
 * licenses of the crates built into the engine and sval-mcp.
 */

add_task(async function about_license_shows_svals_license_first() {
  await BrowserTestUtils.withNewTab("about:license", async browser => {
    const page = await SpecialPowers.spawn(browser, [], () => {
      const header = content.document.querySelector(".license-header");
      // Each text is the <pre> after its heading.
      const text = id =>
        content.document.getElementById(id)?.nextElementSibling?.textContent ??
        "";
      return {
        header: header.textContent.replace(/\s+/g, " "),
        agpl: text("sval-agpl"),
        permission: text("sval-app-store"),
        components: header.querySelectorAll("#sval-components ~ ul li").length,
        componentHeadings: header.querySelectorAll("#sval-components ~ h3")
          .length,
        componentTexts: header.querySelectorAll("#sval-components ~ h3 + pre")
          .length,
      };
    });
    // Booleans, so a failure names the claim and does not print the page.
    Assert.ok(page.header.includes("Sval is made by Ellm Tree, Inc."), "who");
    Assert.ok(page.header.includes("WITHOUT ANY WARRANTY"), "the disclaimer");
    Assert.ok(
      !page.header.includes("Mozilla Project"),
      "the header does not say the Mozilla Project made these binaries"
    );
    Assert.ok(page.agpl.includes("GNU AFFERO GENERAL PUBLIC LICENSE"), "AGPL");
    Assert.ok(page.agpl.includes("END OF TERMS AND CONDITIONS"), "all of it");
    Assert.ok(page.permission.includes("App Store Permission"), "permission");
    Assert.greater(page.components, 0, "the engine's components are listed");
    Assert.equal(
      page.componentTexts,
      page.componentHeadings,
      "each group of components comes with its license text"
    );
  });
});

add_task(async function each_license_link_in_svals_block_has_its_text() {
  await BrowserTestUtils.withNewTab("about:license", async browser => {
    const targets = await SpecialPowers.spawn(browser, [], () =>
      [...content.document.querySelectorAll(".license-header a[href]")]
        .map(a => new content.URL(a.href).hash.slice(1))
        .filter(Boolean)
        .map(id => ({ id, found: !!content.document.getElementById(id) }))
    );
    Assert.deepEqual(
      targets.map(t => t.id),
      ["sval-agpl", "sval-app-store", "sval-components", "mpl"],
      "the block links to Sval's texts, its components' and the MPL"
    );
    for (const { id, found } of targets) {
      Assert.ok(found, `#${id} is on the page`);
    }
  });
});
