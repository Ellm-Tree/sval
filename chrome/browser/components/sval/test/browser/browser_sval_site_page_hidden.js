/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_site_page_helpers.js */

/**
 * The site page's Hidden elements card (site page spec, Hidden elements):
 * every line of My filters for the site, newest first, Show again deleting
 * one, the way to My filters, and the site menu's "Manage in Settings"
 * landing on the card.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_site_page_helpers.js",
  this
);

const { SvalBlocking } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
);

const SITE = "example.com";
const LINES = Array.from({ length: 10 }, (_, i) => `${SITE}##.sval-ad-${i}`);
const NETWORK = `||example.org/ads/banner.png$domain=${SITE}`;

/**
 * @param {object} ui From `partsOf`.
 * @returns {Element[]} The card's rows.
 */
const rowsOf = ui => [
  ...ui.doc.querySelectorAll(
    '[data-site-card="hidden"] .sval-sites-hidden-row'
  ),
];

add_setup(function () {
  registerCleanupFunction(() => SvalBlocking.setMyFilters(""));
});

add_task(async function every_line_newest_first_and_show_again() {
  SvalBlocking.setMyFilters(
    [NETWORK, ...LINES, "example.net##.other"].join("\n")
  );
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  await until(() => rowsOf(ui).length === 11, "every line listed");
  const card = ui.doc.querySelector('[data-site-card="hidden"]');
  ok(
    !card.querySelector(".sval-site-card-count"),
    "the heading carries no count"
  );
  is(
    rowsOf(ui)[0].querySelector(".sval-sites-hidden-rule").title,
    LINES.at(-1),
    "the newest first"
  );
  is(
    rowsOf(ui).at(-1).dataset.kind,
    "network",
    "a network rule says it stops a download"
  );

  rowsOf(ui)[0].querySelector("button").click();
  await until(() => rowsOf(ui).length === 10, "the line gone from the card");
  ok(
    !SvalBlocking.myFilters.split("\n").includes(LINES.at(-1)),
    "Show again deleting the line"
  );
  ok(
    SvalBlocking.myFilters.includes("example.net##.other"),
    "another site's line kept"
  );
  is(
    page.document.activeElement,
    rowsOf(ui)[0].querySelector("button"),
    "focus on the row that took its place"
  );
});

add_task(async function nothing_hidden() {
  SvalBlocking.setMyFilters("");
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  const card = () => ui.doc.querySelector('[data-site-card="hidden"]');
  await until(card, "the card");
  ok(card().querySelector(".sval-empty"), "the empty line");
  SvalBlocking.setMyFilters(LINES[0]);
  await until(() => rowsOf(ui).length === 1, "a line added elsewhere showing");
});

add_task(async function open_in_my_filters_selects_the_newest_line() {
  SvalBlocking.setMyFilters(["example.net##.other", ...LINES].join("\n"));
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  await until(() => rowsOf(ui).length, "the lines");
  ui.doc
    .querySelector('[data-site-card="hidden"] .sval-sites-hidden-open')
    .click();
  ok(!ui.shown(), "the page gives way to My filters");
  // The field takes the focus once Privacy has shown (`_openMyFilters`).
  const field = ui.byId("sval-my-filters-text");
  await until(
    () => page.document.activeElement === field,
    "My filters focused"
  );
  is(
    field.value.slice(field.selectionStart, field.selectionEnd),
    LINES.at(-1),
    "the site's newest line selected"
  );
});

add_task(async function the_hidden_section_lands_on_the_card() {
  SvalBlocking.setMyFilters(LINES.join("\n"));
  const { page } = await openAt(PAGE_URL(SITE));
  const ui = await untilSitePage(page, SITE);
  const card = ui.doc.querySelector('[data-site-card="hidden"]');
  ok(card, "the card");
  // The card's scroll container, as `scrollIntoView` finds it.
  let scroller = card.parentElement;
  while (
    scroller &&
    !["auto", "scroll"].includes(page.getComputedStyle(scroller).overflowY)
  ) {
    scroller = scroller.parentElement;
  }
  scroller ??= ui.doc.scrollingElement;
  scroller.scrollTop = 0;
  const padding = parseFloat(
    page.getComputedStyle(scroller).scrollPaddingTop || "0"
  );
  // The card's place below the scroller's top, past its scroll padding.
  const below = () =>
    card.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top -
    padding;
  Assert.greater(below(), 1, "the card starts below the top");
  page.SvalSettings.showSite(SITE, { section: "hidden" });
  // Whether the card can reach the top depends on the window's height: in a
  // short page it goes as far as the scroller lets it.
  await until(
    () =>
      Math.abs(below()) <= 1 ||
      scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1,
    "the site menu's section scrolling to the card"
  );
  Assert.greater(scroller.scrollTop, 0, "the page scrolled");
});
