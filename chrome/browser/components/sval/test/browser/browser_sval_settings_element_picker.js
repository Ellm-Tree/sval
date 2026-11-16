/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */

// Settings and the element picker: the Pinned to the address bar card, the Sites
// rows naming a site's My filters lines, the Removed elements filter, and the
// confirm before a row's Reset deletes those lines.

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

const { SvalBlocking } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
);
const { SvalSiteControls, PINS_PREF } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteControls.sys.mjs"
);
const { SvalSiteProtections, SITE_BRANCH } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
);
const { SvalProtectionButton } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalProtectionButton.sys.mjs"
);

const SITE = "example.net";
const OTHER = "example.org";
const HIDE = `${SITE}##.sval-test-ad`;
const NETWORK = `||${OTHER}/ads/banner.png$image,domain=${SITE}`;
const OTHER_LINE = `${OTHER}##.sval-test-other`;

keepPrefs(PINS_PREF, "browser.sval.adblock.", SITE_BRANCH);

/**
 * @param {Function} check
 * @param {string} what
 * @returns {Promise<void>} once `check` passes, bounded.
 */
function until(check, what) {
  return within(TestUtils.waitForCondition(check, what), 10_000, what);
}

function reset(lines = []) {
  clearPrefBranches(SITE_BRANCH);
  SvalSiteProtections.setMediaDefault("ask");
  Services.prefs.clearUserPref(PINS_PREF);
  SvalBlocking.setMyFilters(lines.join("\n"));
}

/** Opens the Sites card, drawn. */
function openSites() {
  return openPane(
    "svalSites",
    ({ byId }) => byId("sval-sites")?.checkVisibility(),
    "the Sites card is showing"
  );
}

function rowOf(ui, site) {
  return ui.page.document.querySelector(
    `#sval-sites-body [data-site="${site}"]`
  );
}

/**
 * @param {object} ui The open Settings page.
 * @param {string} site The site whose row to read.
 * @returns {string} what the site's row says differs, by its keys.
 */
function summaryOf(ui, site) {
  return rowOf(ui, site).querySelector(".sval-sites-summary").dataset.differs;
}

function words(element) {
  return element.textContent.replace(/\s+/g, " ").trim();
}

function change(select, value) {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * @param {object} ui From `openSites`.
 * @param {string} site
 * @returns {Promise<void>} once the confirm is open for the site's Reset.
 */
async function askToReset(ui, site) {
  rowOf(ui, site).querySelector(".sval-sites-reset").click();
  await until(
    () => ui.byId("sval-blocking-dialog").open,
    "the confirm opening"
  );
}

add_task(async function the_pinned_card_follows_the_pins() {
  reset();
  const ui = await openPane(
    "paneAppearance",
    ({ byId }) => byId("sval-address-pin-snip")?.checkVisibility(),
    "Appearance's Pinned to the address bar card"
  );
  const javascript = ui.byId("sval-address-pin-javascript");
  const snip = ui.byId("sval-address-pin-snip");
  const picker = ui.byId("sval-address-pin-remove");
  const pressed = pin => pin.getAttribute("aria-pressed") === "true";
  const card = snip.closest(".sval-card");
  is(
    card.querySelector("h2").id,
    "sval-address-pins-heading",
    "the card is titled"
  );
  ok(words(card.querySelector(".sval-agents-note")), "it says where they show");
  Assert.deepEqual(
    [...card.querySelectorAll(".sval-address-pin [aria-pressed]")].map(
      pin => pin.id
    ),
    [
      "sval-address-pin-javascript",
      "sval-address-pin-remove",
      "sval-address-pin-snip",
    ],
    "JavaScript, Remove from this site, then Snip"
  );
  ok(
    words(snip.closest(".sval-address-pin").querySelector(".sval-agents-note")),
    "Snip says what it does"
  );
  ok(pressed(javascript), "JavaScript is pinned by default");
  ok(pressed(snip), "so is Snip");
  ok(!pressed(picker), "Remove from this site is not");
  ok(
    picker.title && snip.title && picker.title != snip.title,
    "an unpinned pin and a pinned one each say what a press does"
  );

  picker.click();
  Assert.deepEqual(
    SvalSiteControls.pins(),
    ["javascript", "remove", "snip"],
    "pinning Remove from this site adds it"
  );
  await until(() => pressed(picker), "the pin drawing pinned");
  javascript.click();
  snip.click();
  Assert.deepEqual(SvalSiteControls.pins(), ["remove"], "and unpinning");

  SvalSiteControls.setPinned("snip", true);
  await until(() => pressed(snip), "the pin following the site menu's pin");
  SvalSiteControls.setPinned("remove", false);
  await until(() => !pressed(picker), "and its unpin");
});

add_task(async function a_site_with_only_hidden_elements_has_a_row() {
  reset([HIDE, OTHER_LINE]);
  const ui = await openSites();
  ok(rowOf(ui, SITE), "a site with a My filters line and no choice has a row");
  is(summaryOf(ui, SITE), "removed:1", "its line is what differs");

  SvalSiteProtections.setProtections(SITE, "off");
  await until(
    () => summaryOf(ui, SITE) === "protections:off removed:1",
    "a choice joins the line"
  );

  SvalSiteProtections.setProtections(SITE, "on");
  SvalBlocking.setMyFilters("");
  await until(() => !rowOf(ui, SITE), "the row going with its last line");
});

add_task(async function a_row_counts_each_line() {
  reset([OTHER_LINE, HIDE, NETWORK]);
  SvalSiteProtections.setProtections(SITE, "off");
  const ui = await openSites();
  is(
    summaryOf(ui, SITE),
    "protections:off removed:2",
    "both lines are counted"
  );
});

add_task(async function a_line_with_two_sites_keeps_the_other() {
  reset([`${SITE},${OTHER}##.sval-test-both`]);
  const ui = await openSites();
  ok(rowOf(ui, SITE) && rowOf(ui, OTHER), "each site has its row");
  rowOf(ui, SITE).querySelector(".sval-sites-link").click();
  const show = () =>
    ui.page.document.querySelector(
      '[data-site-card="hidden"] .sval-sites-hidden-show'
    );
  await until(show, "the site's page with its line");
  show().click();
  is(SvalBlocking.myFilters, `${OTHER}##.sval-test-both`);
  ui.byId("sval-site-back").click();
  await until(
    () => ui.byId("sval-sites").checkVisibility() && !rowOf(ui, SITE),
    "the first site's row going"
  );
  ok(rowOf(ui, OTHER), "the other keeps its row");
});

add_task(async function the_filter_has_hidden_elements() {
  reset([HIDE]);
  SvalSiteProtections.setProtections(OTHER, "off");
  const ui = await openSites();
  ok(rowOf(ui, SITE) && rowOf(ui, OTHER), "both rows show");
  const filter = ui.byId("sval-sites-filter");
  const option = filter.querySelector('option[value="hidden"]');
  ok(option.textContent, "the filter offers removed elements");
  change(filter, "hidden");
  await until(() => !rowOf(ui, OTHER), "the filter narrowing the list");
  ok(rowOf(ui, SITE), "to sites with lines");
  Assert.equal(
    (ui.byId("sval-sites-found").textContent.match(/\d+/g) ?? [])[0],
    "1",
    "the search line says how many match"
  );
});

add_task(async function the_row_x_confirms_before_deleting_lines() {
  reset([HIDE, OTHER_LINE, NETWORK]);
  SvalSiteProtections.setProtections(SITE, "off");
  const ui = await openSites();
  const dialog = ui.byId("sval-blocking-dialog");
  ok(!dialog.hasAttribute("role"), "the shared dialog has no role at rest");
  await askToReset(ui, SITE);
  is(dialog.getAttribute("role"), "alertdialog", "the confirm has one");
  is(dialog.dataset.confirm, "reset", "it asks to reset the site");
  Assert.stringContains(
    ui.byId("sval-blocking-dialog-title").textContent,
    SITE,
    "naming it"
  );
  Assert.stringContains(
    ui.byId("sval-blocking-dialog-body").textContent,
    "2",
    "and how many rules go"
  );
  const confirm = ui.byId("sval-blocking-dialog-confirm");
  Assert.stringContains(confirm.textContent, "2", "the confirm counts them");
  is(confirm.dataset.tone, "danger", "the confirm is the danger button");
  is(
    ui.page.document.activeElement,
    ui.byId("sval-blocking-dialog-cancel"),
    "focus starts on Cancel"
  );

  // The scrim is the dialog element itself, which has no accessible object to
  // click.
  AccessibilityUtils.setEnv({ mustHaveAccessibleRule: false });
  try {
    dialog.dispatchEvent(new ui.page.MouseEvent("click", { bubbles: true }));
  } finally {
    AccessibilityUtils.resetEnv();
  }
  ok(dialog.open, "the scrim does nothing");

  await closeDialog(
    dialog,
    () => ui.byId("sval-blocking-dialog-cancel").click(),
    "Cancel closing the confirm"
  );
  is(SvalSiteProtections.protectionsFor(SITE), "off", "the choice stays");
  is(
    SvalBlocking.myFilters,
    [HIDE, OTHER_LINE, NETWORK].join("\n"),
    "and both lines"
  );
  ok(rowOf(ui, SITE), "the row stays");

  await askToReset(ui, SITE);
  await closeDialog(dialog, () => confirm.click(), "the confirm closing");
  is(SvalSiteProtections.protectionsFor(SITE), "on", "the choices go");
  is(SvalBlocking.myFilters, OTHER_LINE, "with both lines, and no others");
  await until(() => !rowOf(ui, SITE), "the row going");
  ok(!dialog.hasAttribute("role"), "and gives the role back");
  is(
    confirm.dataset.tone,
    "primary",
    "the dialog's other uses get their button back"
  );
  ok(
    ui.byId("sval-blocking-dialog-title").previousElementSibling.hidden,
    "and lose the tile"
  );
});

add_task(async function one_line_reads_in_the_singular() {
  reset([HIDE]);
  const ui = await openSites();
  await askToReset(ui, SITE);
  const confirm = ui.byId("sval-blocking-dialog-confirm");
  ok(
    confirm.textContent.includes("1") &&
      ui.byId("sval-blocking-dialog-body").textContent.includes("1"),
    "the confirm and its body count the one rule"
  );
  ui.byId("sval-blocking-dialog-confirm").click();
  await until(() => !rowOf(ui, SITE), "the row going");
  is(SvalBlocking.myFilters, "");
});

add_task(async function the_row_x_with_no_lines_resets_at_once() {
  reset([OTHER_LINE]);
  SvalSiteProtections.setProtections(SITE, "off");
  const ui = await openSites();
  rowOf(ui, SITE).querySelector(".sval-sites-reset").click();
  ok(!ui.byId("sval-blocking-dialog").open, "nothing is asked");
  is(SvalSiteProtections.protectionsFor(SITE), "on", "the choice went");
  ok(!rowOf(ui, SITE), "and the row");
  is(SvalBlocking.myFilters, OTHER_LINE, "My filters is as it was");
  ok(
    ui.byId("sval-sites-status").querySelector("button"),
    "with Undo, as before"
  );
});

add_task(async function manage_sites_arrives_filtered() {
  reset([HIDE, NETWORK, OTHER_LINE]);
  SvalSiteProtections.setProtections("example.com", "off");
  const ui = await openSettings();
  await showPane(ui.page, "svalSites");
  await BrowserTestUtils.withNewTab("https://example.net/", async () => {
    SvalProtectionButton.forWindow(window).manageSites(SITE);
    await until(
      () => ui.byId("sval-sites-search").value === SITE,
      "the Sites card filtered to the domain"
    );
    ok(!rowOf(ui, "example.com"), "other sites are filtered out");

    SvalProtectionButton.forWindow(window).manageSite(SITE, { hidden: true });
    await until(
      () =>
        ui.byId("sval-site-page").checkVisibility() &&
        ui.byId("sval-site-title").textContent === SITE,
      "Manage in Settings opening the site's page"
    );

    SvalProtectionButton.forWindow(window).manageSites("example.com");
    await until(
      () =>
        !ui.byId("sval-site-page").checkVisibility() &&
        ui.byId("sval-sites-search").value === "example.com",
      "a plain Manage sites leaving the page for the card"
    );
  });
});

add_task(async function a_subdomains_line_has_a_row_under_its_site() {
  reset([`www.${SITE}##.sval-test-ad`, HIDE]);
  const ui = await openSites();
  ok(rowOf(ui, SITE), "the site has its row");
  is(
    rowOf(ui, `www.${SITE}`)?.dataset.parent,
    SITE,
    "a subdomain named by a line has one under its site"
  );
  is(
    summaryOf(ui, SITE),
    "removed:1",
    "and its line is not counted for the site"
  );
  is(summaryOf(ui, `www.${SITE}`), "removed:1", "but for the subdomain");
});
