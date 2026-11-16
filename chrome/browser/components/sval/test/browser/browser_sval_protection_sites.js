/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */

/**
 * Settings › Sites (protections spec §2.3 and §4.3, decision
 * 1484): each row says what differs from the defaults and opens the site's
 * page, Reset offers Undo, Add site cuts the address to its site and opens
 * its page, search and the filter say how many rows match, the defaults sit
 * above the list, "Manage sites" opens it filtered, and Firefox's own
 * permission rows and their dialogs are gone.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

const { SvalSiteProtections, SITE_BRANCH } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
);

function reset() {
  clearPrefBranches(SITE_BRANCH);
  for (const name of [
    "privacy.fingerprintingProtection.granularOverrides",
    "privacy.baselineFingerprintingProtection.granularOverrides",
  ]) {
    Services.prefs.clearUserPref(name);
  }
  SvalSiteProtections.setMediaDefault("ask");
  Services.perms.removeAll();
}

async function openSites() {
  for (const tab of [...gBrowser.tabs]) {
    if (tab.linkedBrowser.currentURI?.spec.startsWith("about:preferences")) {
      BrowserTestUtils.removeTab(tab);
    }
  }
  const tab = expectOpened(SvalPanel.openSettingsPage());
  await TestUtils.waitForCondition(
    () => tab.linkedBrowser.contentWindow?.SvalSettings?._els,
    "about:preferences loaded with Sval's panes"
  );
  registerCleanupFunction(() => {
    if (tab.parentNode) {
      BrowserTestUtils.removeTab(tab);
    }
  });
  const page = tab.linkedBrowser.contentWindow;
  await showPane(page, "svalSites");
  const byId = id => page.document.getElementById(id);
  await TestUtils.waitForCondition(
    () => byId("sval-sites")?.checkVisibility(),
    "the Sites card is showing"
  );
  return { page, byId, tab };
}

function rowFor(ui, site) {
  return ui.page.document.querySelector(
    `#sval-sites-body [data-site="${site}"]`
  );
}

function change(select, value) {
  select.value = value;
  select.dispatchEvent(new Event("change"));
}

add_setup(function () {
  registerCleanupFunction(reset);
});

/**
 * @param {object} ui
 * @returns {number} How many rows the list has with nothing narrowing it,
 *   the defaults file's grants included.
 */
function listed(ui) {
  return ui.page.SvalSettings._siteRules().size;
}

/**
 * A row says what differs from the defaults in one line, and holds no
 * control but its link and Reset: the site's page makes the choices.
 */
add_task(async function a_row_says_what_differs_and_holds_no_choices() {
  reset();
  SvalSiteProtections.setProtections("example.net", "off");
  SvalSiteProtections.setMedia("example.org", "block");
  SvalSiteProtections.setExceptions("example.org", ["canvas"]);
  SvalSiteProtections.setProtections("example.com", "full");
  const ui = await openSites();
  const summary = site =>
    rowFor(ui, site).querySelector(".sval-sites-summary").dataset.differs;
  Assert.equal(summary("example.net"), "protections:off");
  Assert.equal(
    summary("example.com"),
    "protections:full",
    "a site kept clear of Mozilla's fix"
  );
  Assert.equal(summary("example.org"), "exceptions:canvas media:block");
  for (const site of ["example.net", "example.org"]) {
    const row = rowFor(ui, site);
    Assert.ok(
      !row.querySelector("select, input"),
      `${site}'s row has no menu or switch`
    );
    const controls = [...row.querySelectorAll("a, button")];
    Assert.deepEqual(
      controls.map(el =>
        ["sval-sites-link", "sval-sites-reset"].find(c =>
          el.classList.contains(c)
        )
      ),
      ["sval-sites-link", "sval-sites-reset"],
      "only the site's link and Reset"
    );
    Assert.equal(controls[0].textContent, site, "the link names the site");
  }
  Assert.ok(
    !ui.page.document.querySelector('#sval-sites [role="table"]'),
    "the list is no table"
  );
});

add_task(async function a_row_opens_the_sites_page() {
  reset();
  SvalSiteProtections.setProtections("example.net", "off");
  const ui = await openSites();
  const link = rowFor(ui, "example.net").querySelector(".sval-sites-link");
  const acc = await accessibleOf(link);
  Assert.equal(acc.name, "example.net", "the link is named for the site");
  Assert.equal(
    acc.description,
    rowFor(ui, "example.net").querySelector(".sval-sites-summary").textContent,
    "and described by what differs"
  );
  // The summary is the pointer's larger target; the keyboard and the a11y
  // checks reach the same page through the site's link above.
  AccessibilityUtils.setEnv({ mustHaveAccessibleRule: false });
  rowFor(ui, "example.net").querySelector(".sval-sites-summary").click();
  AccessibilityUtils.resetEnv();
  await TestUtils.waitForCondition(
    () =>
      ui.byId("sval-site-page").checkVisibility() &&
      ui.byId("sval-site-title").textContent === "example.net",
    "a press anywhere in the row opens the site's page"
  );
  Assert.equal(
    ui.byId("sval-site-crumbs").querySelector("a").dataset.crumb,
    "sites",
    "under the Sites breadcrumb"
  );
  ui.byId("sval-site-back").click();
  await TestUtils.waitForCondition(
    () => ui.byId("sval-sites").checkVisibility(),
    "back to the list"
  );
});

/**
 * Add site asks for an address, cuts it to its site, and opens that site's
 * page at the defaults. The site joins the list once it has a choice.
 */
add_task(async function add_site_opens_its_page_at_the_defaults() {
  reset();
  const ui = await openSites();
  ui.page.document.querySelector('[data-sval-key="add-site"]').click();
  const input = ui.byId("sval-sites-add-input");
  await assertShownLabel(input);
  Assert.ok(
    !ui.byId("sval-sites").querySelector(".sval-agent-adding select"),
    "the add row asks for the address alone"
  );
  input.value = "https://www.example.co.uk/some/page";
  input.dispatchEvent(new Event("input"));
  Assert.stringContains(
    ui.byId("sval-sites-add-preview").textContent,
    "example.co.uk",
    "the preview names the site the address is cut to"
  );
  input.dispatchEvent(
    new ui.page.KeyboardEvent("keydown", { key: "Enter", bubbles: true })
  );
  await TestUtils.waitForCondition(
    () =>
      ui.byId("sval-site-page").checkVisibility() &&
      ui.byId("sval-site-title").textContent === "example.co.uk",
    "the site's page opens"
  );
  Assert.deepEqual(
    SvalSiteProtections.ruleFor("example.co.uk"),
    {},
    "with nothing stored"
  );
  Assert.equal(
    ui.page.document.querySelector('[data-sval-key="site-protections"]').value,
    "",
    "at the defaults"
  );
  change(
    ui.page.document.querySelector('[data-sval-key="site-protections"]'),
    "off"
  );
  ui.byId("sval-site-back").click();
  await TestUtils.waitForCondition(
    () => rowFor(ui, "example.co.uk"),
    "a site with a choice is listed"
  );
  Assert.ok(
    !ui.byId("sval-sites").querySelector(".sval-agent-adding"),
    "and the add row is closed"
  );
});

add_task(async function an_address_that_is_no_site_opens_nothing() {
  reset();
  const ui = await openSites();
  ui.page.document.querySelector('[data-sval-key="add-site"]').click();
  const input = ui.byId("sval-sites-add-input");
  input.value = "not a site";
  input.dispatchEvent(new Event("input"));
  Assert.ok(
    ui.page.document.querySelector('[data-sval-key="adding-site-add"]')
      .disabled,
    "Add waits for a site"
  );
  Assert.equal(input.getAttribute("aria-invalid"), "true");
  input.dispatchEvent(
    new ui.page.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
  );
  Assert.ok(
    !ui.byId("sval-sites").querySelector(".sval-agent-adding"),
    "Escape closes the row"
  );
  Assert.ok(!ui.byId("sval-site-page").checkVisibility());
});

/**
 * Coming back to the tab redraws only what no observer follows, so a site
 * half typed into the Sites card keeps its field and the caret.
 */
add_task(async function coming_back_keeps_a_site_being_typed() {
  reset();
  const ui = await openSites();
  ui.page.document.querySelector('[data-sval-key="add-site"]').click();
  const input = ui.byId("sval-sites-add-input");
  input.focus();
  input.value = "example.co";
  input.dispatchEvent(new Event("input"));

  ui.page.dispatchEvent(new ui.page.Event("focus"));
  await TestUtils.waitForTick();
  Assert.ok(input.isConnected, "the field is still on the page");
  Assert.equal(
    ui.page.document.activeElement,
    input,
    "and still has the caret"
  );
  Assert.equal(input.value, "example.co", "with what was typed");
});

add_task(async function search_and_filter_narrow_the_list() {
  reset();
  SvalSiteProtections.setProtections("alpha.test", "off");
  SvalSiteProtections.setMedia("beta.test", "block");
  const ui = await openSites();
  const filter = ui.byId("sval-sites-filter");
  const [label] = filter.labels;
  Assert.ok(label?.checkVisibility(), "the filter shows its label");
  Assert.ok(label.textContent, "with words in it");
  Assert.equal(
    (await accessibleOf(filter)).name,
    label.textContent,
    "which names it"
  );
  const found = ui.byId("sval-sites-found");
  Assert.equal(found.getAttribute("role"), "status");
  Assert.equal(found.textContent, "", "no count with nothing narrowing");
  Assert.ok(
    !ui.byId("sval-sites-heading").textContent.match(/\d/),
    "the heading carries no count"
  );
  const total = listed(ui);
  // The count line's numbers: the rows shown, then every row.
  const counts = () => found.textContent.match(/\d+/g)?.map(Number);
  change(filter, "block");
  Assert.ok(!rowFor(ui, "alpha.test"), "filtered out");
  Assert.ok(rowFor(ui, "beta.test"), "kept by the Always deny filter");
  Assert.deepEqual(counts(), [1, total], "one row of every one shown");
  change(filter, "all");
  Assert.equal(found.textContent, "");
  const search = ui.byId("sval-sites-search");
  search.value = "alp";
  search.dispatchEvent(new Event("input"));
  Assert.ok(rowFor(ui, "alpha.test"));
  Assert.ok(!rowFor(ui, "beta.test"), "search narrows");
  Assert.deepEqual(counts(), [1, total]);
  search.value = "nothing";
  search.dispatchEvent(new Event("input"));
  Assert.deepEqual(counts(), [0, total]);
  search.value = "";
  search.dispatchEvent(new Event("input"));
  Assert.equal(found.textContent, "");
});

add_task(async function the_media_default_sits_above_the_list() {
  reset();
  SvalSiteProtections.setMedia("beta.test", "block");
  const ui = await openSites();
  const media = await TestUtils.waitForCondition(
    () =>
      ui.page.document.querySelector(
        'setting-group[groupid="svalSiteDefaults"] sval-segments-default#svalSiteMedia'
      ),
    "the media default is drawn"
  );
  Assert.ok(
    media.compareDocumentPosition(ui.byId("sval-sites")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
    "above the list"
  );
  const radios = [...media.querySelectorAll('input[type="radio"]')];
  Assert.ok(
    media.querySelector('[role="radiogroup"]').getAttribute("aria-labelledby"),
    "it has a label"
  );
  Assert.deepEqual(
    radios.map(radio => radio.value),
    ["allow", "ask", "block"],
    "the default offers the site menu's three choices, in its order"
  );
  Assert.equal(media.value, "ask", "Ask first is Sval's default");
  for (const value of ["allow", "block", "ask"]) {
    radios.find(radio => radio.value === value).click();
    Assert.equal(SvalSiteProtections.mediaDefault(), value, `${value} saved`);
    Assert.equal(
      rowFor(ui, "beta.test").querySelector(".sval-sites-summary").dataset
        .differs,
      "media:block",
      `under ${value}, the row names the site's own choice`
    );
    Assert.equal(
      SvalSiteProtections.mediaFor("beta.test"),
      "block",
      `under ${value}, the site keeps its own choice`
    );
  }
});

add_task(async function manage_sites_opens_the_card_filtered() {
  reset();
  for (const tab of [...gBrowser.tabs]) {
    if (tab.linkedBrowser.currentURI?.spec.startsWith("about:preferences")) {
      BrowserTestUtils.removeTab(tab);
    }
  }
  SvalSiteProtections.setProtections("example.com", "off");
  SvalSiteProtections.setProtections("example.net", "off");
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    const button = document.getElementById("sval-protection-button");
    const panel = document.getElementById("sval-protection-panel");
    const shown = BrowserTestUtils.waitForEvent(panel, "popupshown");
    button.click();
    await within(shown, 5_000, "the protection panel's popupshown");
    const opened = BrowserTestUtils.waitForNewTab(gBrowser, url =>
      url.startsWith("about:preferences")
    );
    panel.querySelector(".sval-prot-manage").click();
    const tab = await within(
      opened,
      15_000,
      "the Manage sites tab opening on settings"
    );
    registerCleanupFunction(() => {
      if (tab.parentNode) {
        BrowserTestUtils.removeTab(tab);
      }
    });
    const page = tab.linkedBrowser.contentWindow;
    await TestUtils.waitForCondition(
      () =>
        page.document
          .querySelector('#sval-sites-body [data-site="example.com"]')
          ?.checkVisibility(),
      "the Sites card shows the site"
    );
    Assert.equal(
      page.document.getElementById("sval-sites-search").value,
      "example.com"
    );
    Assert.ok(
      !page.document.querySelector(
        '#sval-sites-body [data-site="example.net"]'
      ),
      "filtered to the site"
    );
    Assert.equal(
      page.document.activeElement,
      page.document.getElementById("sval-sites-search"),
      "with the caret in the search"
    );
    BrowserTestUtils.removeTab(tab);
  });
});

/**
 * Firefox's permission rows, each opening a dialog of exceptions, are drawn
 * nowhere: Sites holds their defaults, and each site's page its permissions.
 */
add_task(async function firefoxs_permission_rows_are_gone() {
  const ui = await openSites();
  await TestUtils.waitForCondition(
    () =>
      ui.page.document.querySelector(
        'setting-group[groupid="svalSiteDefaults"] sval-permission-default'
      ),
    "the defaults are drawn"
  );
  for (const id of [
    "notificationSettingsButton",
    "cameraSettingsButton",
    "autoplaySettingsButton",
    "popupAndRedirectPolicyButton",
  ]) {
    Assert.ok(!ui.page.document.getElementById(id), `no ${id}`);
  }
  Assert.ok(
    !ui.page.document.querySelector('setting-group[groupid="permissions"]'),
    "nor Firefox's permissions group"
  );
});

/**
 * A keyboard user keeps their place in the Sites card: Reset hands focus to
 * Undo, and Undo hands it to the row it brought back.
 */
add_task(async function the_keyboard_keeps_its_place_in_the_sites() {
  reset();
  SvalSiteProtections.setProtections("example.net", "off");
  const ui = await openSites();
  const doc = ui.page.document;
  await within(SimpleTest.promiseFocus(ui.page), 10_000, "the page's focus");
  const resetButton = rowFor(ui, "example.net").querySelector(
    ".sval-sites-reset"
  );
  const acc = await accessibleOf(resetButton);
  Assert.equal(acc.name, "Reset example.net", "Reset names its site");

  resetButton.focus();
  EventUtils.synthesizeKey("KEY_Enter", {}, ui.page);
  Assert.ok(!rowFor(ui, "example.net"), "the row goes");
  const undo = ui.byId("sval-sites-status").querySelector("button");
  Assert.equal(doc.activeElement, undo, "focus is on Undo");
  EventUtils.synthesizeKey("KEY_Enter", {}, ui.page);
  Assert.equal(
    SvalSiteProtections.protectionsFor("example.net"),
    "off",
    "Undo brings the choice back"
  );
  Assert.equal(
    doc.activeElement,
    rowFor(ui, "example.net").querySelector(".sval-sites-link"),
    "and focus goes to its row"
  );
});

/**
 * Reset on a row whose site has hidden-element lines confirms first (site
 * page design 8b), saying what goes and what stays; one without acts at
 * once.
 */
add_task(async function reset_confirms_only_when_it_deletes_lines() {
  reset();
  const { SvalBlocking } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
  );
  const { SITE_EXCEPTIONS } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalFingerprinting.sys.mjs"
  );
  const filters = SvalBlocking.myFilters;
  atTaskEnd(() => SvalBlocking.setMyFilters(filters));
  SvalSiteProtections.setExceptions("example.net", [SITE_EXCEPTIONS[0].id]);
  SvalSiteProtections.setMedia("example.org", "block");
  SvalBlocking.setMyFilters(
    [
      filters,
      "example.net##.sval-reset-a",
      "example.net##.sval-reset-b",
      "example.org##.sval-reset-c",
    ].join("\n")
  );
  SvalSiteProtections.setProtections("example.com", "off");
  const ui = await openSites();
  const dialog = ui.byId("sval-blocking-dialog");
  // The numbers a part of the confirm carries.
  const counts = id => ui.byId(id).textContent.match(/\d+/g)?.map(Number);

  rowFor(ui, "example.net").querySelector(".sval-sites-reset").click();
  Assert.ok(dialog.open, "lines to delete: the confirm opens");
  Assert.equal(
    dialog.dataset.confirm,
    "reset-with-exceptions",
    "it resets the site's choices and its exceptions"
  );
  Assert.stringContains(
    ui.byId("sval-blocking-dialog-title").textContent,
    "example.net",
    "the title names the site"
  );
  Assert.deepEqual(counts("sval-blocking-dialog-body"), [2], "two rules");
  const keep = dialog.querySelector(".sval-reset-keep");
  Assert.ok(keep, "the keep well");
  Assert.ok(keep.querySelector(".sval-glyph-check"), "with its tick");
  Assert.deepEqual(counts("sval-blocking-dialog-confirm"), [2]);
  // The dialog's close event, which takes the well, comes in a task of its
  // own after `close()`.
  const closed = BrowserTestUtils.waitForEvent(dialog, "close");
  ui.byId("sval-blocking-dialog-cancel").click();
  Assert.ok(!dialog.open, "Cancel closes it");
  await within(closed, 10_000, "the confirm's close event");
  Assert.ok(!dialog.querySelector(".sval-reset-keep"), "taking the well");

  rowFor(ui, "example.org").querySelector(".sval-sites-reset").click();
  Assert.equal(
    dialog.dataset.confirm,
    "reset",
    "no exceptions: no clause for them"
  );
  Assert.deepEqual(counts("sval-blocking-dialog-body"), [1], "one rule");
  Assert.deepEqual(counts("sval-blocking-dialog-confirm"), [1]);
  ui.byId("sval-blocking-dialog-confirm").click();
  Assert.ok(!dialog.open, "confirming closes it");
  Assert.equal(SvalSiteProtections.mediaFor("example.org"), "ask", "reset");
  Assert.ok(
    !SvalBlocking.myFilters.includes("example.org##"),
    "its line deleted"
  );
  Assert.ok(
    SvalBlocking.myFilters.includes("example.net##.sval-reset-a"),
    "another site's kept"
  );

  rowFor(ui, "example.com").querySelector(".sval-sites-reset").click();
  Assert.ok(!dialog.open, "no lines: no confirm");
  Assert.deepEqual(SvalSiteProtections.ruleFor("example.com"), {}, "reset");
});
