/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */

/**
 * Where about:preferences puts each setting (spec §10.8): Sval's sections in
 * Firefox's categories, each of Firefox's moved groups in one category, and
 * the settings people look for in a category other than Firefox's. The rest
 * of the page's layout is in `browser_sval_preferences_layout.js`.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel starting");
});

/**
 * Sval's sections in Firefox's categories: the panel side at the top of
 * Appearance, and ad blocking at the top of Privacy and protection, under
 * nothing but Firefox's warnings, which show only when it finds a problem.
 */
add_task(async function sval_sections_sit_in_their_categories() {
  await panelWithFolder(null);
  const ui = await openSettings();
  for (const [category, control] of [
    ["paneAppearance", 'input[name="sval-side"]'],
    ["panePrivacy", "#sval-blocking"],
  ]) {
    await showPane(ui.page, category);
    const el = () => ui.page.document.querySelector(control);
    await TestUtils.waitForCondition(
      () => el()?.checkVisibility(),
      `${control} shows in ${category}`
    );
    const section = el().closest(".sval-pane-section");
    let above = section.previousElementSibling;
    if (above?.getAttribute("groupid") === "securityPrivacyWarnings") {
      above = above.previousElementSibling;
    }
    Assert.equal(
      above?.localName,
      "moz-page-header",
      "under the category's heading"
    );
    Assert.equal(
      section.closest("setting-pane")?.dataset.category,
      category,
      "inside the category"
    );
  }
});

/** Where each of Firefox's setting groups that Sval moves is shown. */
const GROUPS = {
  paneSync: [
    "defaultBrowserSync",
    "svalWarnings",
    "browserLanguage",
    "websiteLanguage",
    "translations",
    "spellCheck",
    "downloads",
    "applications",
    "pageNavigation",
    "media",
    "performance",
  ],
  paneHome: ["homepage", "svalTabArchive", "importBrowserData"],
  paneAppearance: [
    "appearance",
    "zoom",
    "fonts",
    "contrast",
    "keyboardAndScrolling",
    "motionAndLink",
  ],
  panePrivacy: [
    "svalCookies",
    "history2",
    "httpsOnly",
    "browsingProtection",
    "certificates",
    "networkProxy",
  ],
};

/**
 * Each moved group is in its category and in no other, and the groups Sval
 * shows nowhere are gone: Firefox Home's switches, the links between
 * categories, the link to a connection page of its own, Firefox Accounts
 * and their sync, and Firefox's Tabs group, whose settings Sval keeps are in
 * General and Links.
 */
add_task(async function each_group_is_in_its_category_alone() {
  await panelWithFolder(null);
  const ui = await openSettings();
  const doc = ui.page.document;
  for (const [pane, groups] of Object.entries(GROUPS)) {
    await showPane(ui.page, pane);
    for (const id of groups) {
      await TestUtils.waitForCondition(
        () =>
          doc.querySelector(
            `[data-category="${pane}"] setting-group[groupid="${id}"]`
          ),
        `${id} is in ${pane}`
      );
      Assert.equal(
        doc.querySelectorAll(`setting-group[groupid="${id}"]`).length,
        1,
        `and nowhere else`
      );
    }
  }
  for (const id of [
    "home",
    "relatedSettings",
    "connectionLink",
    "accountDisabled",
    "account",
    "sync",
    "cookiesAndSiteData2",
    "permissions",
    "tabs",
  ]) {
    Assert.ok(
      !doc.querySelector(`setting-group[groupid="${id}"]`),
      `${id} is not shown`
    );
  }
  Assert.ok(
    !ui.byId("category-permissions-data"),
    "Site permissions is no category: Sites holds its topic"
  );
});

/**
 * Each setting sits in the category people look for it in: Workspaces has
 * the home page's Favorites switch after the home page group, then pins,
 * then import and export with the complete export; Links has the pins' Quick Peek
 * switch; Search and Launcher has the Launcher's sections; Appearance has
 * the address bar buttons after the address bar card, and an Accessibility
 * heading over Firefox's accessibility groups.
 */
add_task(async function moved_settings_sit_where_people_look() {
  await panelWithFolder(null);
  const ui = await openSettings();
  const doc = ui.page.document;
  const follows = (first, second) =>
    !!(
      first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING
    );
  const shownIn = async (pane, selector) => {
    await showPane(ui.page, pane);
    const el = await TestUtils.waitForCondition(() => {
      const found = doc.querySelector(selector);
      return found?.checkVisibility() && found;
    }, `${selector} shows in ${pane}`);
    Assert.equal(
      el.closest("setting-pane, .sval-pane")?.dataset.category,
      pane,
      `${selector} is in ${pane}`
    );
    return el;
  };

  const favorites = await shownIn("paneHome", "#sval-home-favorites");
  const pins = await shownIn("paneHome", "#sval-pins-lines");
  const group = id => doc.querySelector(`setting-group[groupid="${id}"]`);
  Assert.ok(
    follows(group("homepage"), favorites),
    "Favorites follows the home page"
  );
  Assert.ok(
    follows(favorites, group("svalTabArchive")),
    "idle tabs follow Favorites"
  );
  Assert.ok(follows(group("svalTabArchive"), pins), "pins follow idle tabs");
  Assert.ok(
    follows(pins, group("importBrowserData")),
    "import and export come last"
  );
  const exportAll = await shownIn("paneHome", "#data-export-all");
  Assert.ok(
    group("importBrowserData").contains(exportAll),
    "the complete export is in the import and export group"
  );
  Assert.ok(!doc.getElementById("sval-export-all"), "and nowhere else");
  exportAll.click();
  const exportPage = await TestUtils.waitForCondition(() => {
    const d = gDialogBox.isOpen
      ? gDialogBox.dialog?._frame.contentDocument
      : null;
    return d?.querySelector(".sval-ex-target") ? d : null;
  }, "the export page opens over the window");
  Assert.ok(
    exportPage.querySelector('.sval-ex-radio[value="sval"]').checked,
    "it exports the complete data"
  );
  exportPage.querySelector(".sval-ex-cancel").click();
  await TestUtils.waitForCondition(
    () => !gDialogBox.isOpen,
    "the export page closes"
  );

  await shownIn("paneSvalLinks", "#sval-pins-quick-peek");
  await shownIn("paneSearch", "#sval-launcher-sections");

  const buttons = await shownIn("paneAppearance", "#sval-address-pins");
  Assert.equal(
    buttons.previousElementSibling?.querySelector("h2")?.id,
    "sval-urlbar-heading",
    "the address bar buttons follow the address bar card"
  );
  const heading = group("zoom").previousElementSibling;
  Assert.equal(
    heading?.querySelector("[data-sval-pane]")?.dataset.svalPane,
    "svalAccessibility",
    "an Accessibility heading is over zoom"
  );
  Assert.ok(heading.checkVisibility(), "and shows");
  for (const id of ["fonts", "contrast", "keyboardAndScrolling"]) {
    Assert.ok(follows(heading, group(id)), `${id} is under it`);
  }
});

/**
 * General has one default-browser section and no Startup section, and the
 * check for the default at launch is a checkbox in that section, open whether
 * or not Sval is the default, that sets `browser.shell.checkDefaultBrowser`.
 */
add_task(async function general_has_one_default_browser_section() {
  await panelWithFolder(null);
  const ui = await openSettings();
  await showPane(ui.page, "paneSync");
  const doc = ui.page.document;
  const pane = doc.querySelector('setting-pane[data-category="paneSync"]');
  const checkbox = () =>
    pane.querySelector(
      'setting-group[groupid="defaultBrowserSync"] #alwaysCheckDefault'
    );
  await TestUtils.waitForCondition(
    () => checkbox()?.checkVisibility(),
    "the default-browser section shows its check at launch"
  );

  const groups = [...pane.querySelectorAll("setting-group")].filter(g =>
    g.querySelector("#isNotDefaultPane, #isDefaultPane")
  );
  Assert.deepEqual(
    groups.map(g => g.getAttribute("groupid")),
    ["defaultBrowserSync"],
    "General has one default-browser section"
  );
  Assert.ok(
    !doc.querySelector('setting-group[groupid="startupHome"]'),
    "and no Startup section"
  );
  Assert.equal(
    doc.querySelectorAll("#alwaysCheckDefault").length,
    1,
    "the check at launch is shown once"
  );

  // The check is open whether or not Sval is the default, so a user who has
  // made it the default can ask to be told if another browser takes over.
  Assert.ok(!checkbox().disabled, "the check at launch can be changed");
  registerCleanupFunction(() =>
    Services.prefs.clearUserPref("browser.shell.checkDefaultBrowser")
  );
  const before = Services.prefs.getBoolPref(
    "browser.shell.checkDefaultBrowser"
  );
  Assert.equal(checkbox().checked, before, "the checkbox shows the pref");
  checkbox().click();
  await TestUtils.waitForCondition(
    () =>
      Services.prefs.getBoolPref("browser.shell.checkDefaultBrowser") !==
      before,
    "ticking it sets the pref"
  );
  checkbox().click();
  await TestUtils.waitForCondition(
    () =>
      Services.prefs.getBoolPref("browser.shell.checkDefaultBrowser") ===
      before,
    "and unticking it clears it"
  );
});

/**
 * The settings Sval keeps from Firefox's Tabs group sit where people look for
 * them: General's Warnings asks before the quit key quits, where there is
 * one, and offers the many-tabs warning back once it was turned off, and
 * Links' "Links in pages" chooses whether a new tab takes the focus. Each
 * sets Firefox's own pref.
 */
add_task(async function the_tab_settings_sval_keeps_sit_where_people_look() {
  await panelWithFolder(null);
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.tabs.warnOnOpen", false],
      ["browser.warnOnQuitShortcut", true],
      ["browser.tabs.loadInBackground", true],
    ],
  });
  const ui = await openSettings();
  const doc = ui.page.document;
  await showPane(ui.page, "paneSync");
  const warnings = 'setting-group[groupid="svalWarnings"]';
  const many = await TestUtils.waitForCondition(
    () =>
      doc.querySelector(`${warnings} #warnOpenMany`)?.checkVisibility() &&
      doc.querySelector(`${warnings} #warnOpenMany`),
    "the many-tabs warning, turned off, can be turned back on in General"
  );
  Assert.equal(
    many.closest("setting-pane")?.dataset.category,
    "paneSync",
    "in General"
  );
  many.click();
  await TestUtils.waitForCondition(
    () => Services.prefs.getBoolPref("browser.tabs.warnOnOpen"),
    "which sets Firefox's pref"
  );
  const quit = doc.querySelector(`${warnings} #warnOnQuitKey`);
  if (AppConstants.platform == "win") {
    Assert.ok(!quit?.checkVisibility(), "Windows has no quit key to ask about");
  } else {
    Assert.ok(quit.checkVisibility(), "General asks before the quit key quits");
    Assert.ok(quit.checked, "as the pref says");
    quit.click();
    await TestUtils.waitForCondition(
      () => !Services.prefs.getBoolPref("browser.warnOnQuitShortcut"),
      "and unticking it stops asking"
    );
  }

  await showPane(ui.page, "paneSvalLinks");
  const switchTo = await TestUtils.waitForCondition(
    () =>
      ui.byId("sval-switch-to-new-tabs")?.checkVisibility() &&
      ui.byId("sval-switch-to-new-tabs"),
    "Links offers to switch to a new tab"
  );
  Assert.equal(
    switchTo.closest("section.sval-card").querySelector("h2").id,
    "sval-links-quick-peek-heading",
    "in Links in pages"
  );
  Assert.ok(!switchTo.checked, "off while new tabs load in the background");
  switchTo.click();
  await TestUtils.waitForCondition(
    () => !Services.prefs.getBoolPref("browser.tabs.loadInBackground"),
    "on, a new tab takes the focus"
  );
});
