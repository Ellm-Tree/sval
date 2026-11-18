/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_site_page_helpers.js */

/**
 * The site page's Colorshift card: what the site's saved style changes,
 * Remove and its Undo, a host showing the style it takes from its site, and
 * the style counted among the choices of the name it is saved at.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_site_page_helpers.js",
  this
);

const { setStyle, styleAt, removeStyles, STYLES_PREF } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSiteStyles.sys.mjs"
  );
const { describeStyle } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteStylePanel.sys.mjs"
);

const SITE = "example.com";
const HOST = "app.example.com";
const STYLE = { hue: 220, strength: 40, theme: "dark", font: "serif" };

/**
 * @param {object} ui From `partsOf`.
 * @returns {?Element} The Colorshift card.
 */
const cardOf = ui => ui.doc.querySelector('[data-site-card="style"]');

/**
 * @param {object} ui From `partsOf`.
 * @returns {?string} Which style the card shows: "own", "removed",
 *   "inherited" or "none".
 */
const stateOf = ui => cardOf(ui)?.dataset.style ?? null;

/**
 * @param {object} ui From `partsOf`.
 * @returns {?string} What the card says under its title.
 */
const subOf = ui =>
  cardOf(ui)?.querySelector(".sval-site-row-sub")?.textContent ?? null;

/**
 * @param {object} ui From `partsOf`.
 * @returns {string[]} The labels of the "Choices for" list.
 */
const choicesOf = ui =>
  Array.from(
    ui.doc.querySelectorAll("#sval-site-scope-select moz-option"),
    option => option.getAttribute("label")
  );

add_setup(function () {
  registerCleanupFunction(() => Services.prefs.clearUserPref(STYLES_PREF));
});

add_task(async function a_saved_style_is_described_removed_and_put_back() {
  setStyle(SITE, STYLE);
  const saved = styleAt(SITE);
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  await until(() => stateOf(ui) === "own", "the card showing the site's style");
  is(
    subOf(ui),
    describeStyle(saved),
    "the card says what the style changes, as the site menu does"
  );

  ok(
    cardOf(ui).querySelector("h2 .sval-glyph-palette"),
    "the heading carries Colorshift's icon"
  );

  const remove = ui.byKey("site-style-action");
  remove.focus();
  remove.click();
  await until(() => stateOf(ui) === "removed", "the card offering Undo");
  is(styleAt(SITE), null, "Remove deleted the site's style");
  is(page.document.activeElement, ui.byKey("site-style-action"), "focus kept");

  ui.byKey("site-style-action").click();
  await until(() => stateOf(ui) === "own", "the card showing the style again");
  Assert.deepEqual(styleAt(SITE), saved, "Undo put the same style back");
});

add_task(async function a_site_with_no_style_says_so() {
  removeStyles([SITE, HOST]);
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  await until(() => stateOf(ui) === "none", "the card with no style");
  ok(cardOf(ui).querySelector(".sval-empty"), "the empty line");
  ok(!ui.byKey("site-style-action"), "and nothing to remove");

  setStyle(SITE, STYLE);
  await until(() => stateOf(ui) === "own", "a style saved elsewhere showing");
});

add_task(async function a_host_shows_its_own_style_or_its_sites() {
  removeStyles([SITE, HOST]);
  setStyle(HOST, { theme: "light" });
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  await until(() => stateOf(ui) === "none", "the site itself having none");
  const labels = choicesOf(ui);
  ok(
    labels.some(label => label.startsWith(HOST) && label !== HOST),
    "a host whose only choice is a style is listed, with its count"
  );
  ok(!labels[0].includes("\u00b7"), "the site counts no style of its own");

  change(ui.byId("sval-site-scope-select"), HOST);
  await until(() => stateOf(ui) === "own", "the host's own style");
  is(subOf(ui), describeStyle(styleAt(HOST)), "described as the host's");

  removeStyles([HOST]);
  setStyle(SITE, STYLE);
  await until(
    () => stateOf(ui) === "inherited",
    "the host showing the style it takes from its site"
  );
  ok(
    subOf(ui).startsWith(describeStyle(styleAt(SITE))),
    "described as the site's"
  );
  ok(!ui.byKey("site-style-action"), "which is the site's to remove");
});
