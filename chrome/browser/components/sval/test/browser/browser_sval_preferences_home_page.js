/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */

/**
 * Settings › Workspaces' home page group (spec §10.8): what new windows and
 * new tabs show, Restore Defaults, and the custom home page's subpane with
 * its address field, Use Current Pages and Use Favorite…. Each control is
 * shown and sets the pref it stands for. Firefox Home's own switches are
 * shown nowhere. `browser_sval_preferences_in_firefox_categories.js` covers
 * the menu Use Favorite… opens.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

const BLANK = "chrome://browser/content/blanktab.html";
const OPEN_PAGE = "https://example.com/sval-home-page";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.startup.homepage", "about:home"],
      ["browser.newtabpage.enabled", true],
    ],
  });
});

/**
 * Picks `value` in the select `id`, as a person's pick reaches the setting
 * (`setting-group`'s change handler).
 *
 * @param {object} ui {@link openSettings}'s answer.
 * @param {string} id
 * @param {string} value
 */
function pick(ui, id, value) {
  const select = control(ui, id);
  select.value = value;
  select.dispatchEvent(new ui.page.Event("change", { bubbles: true }));
}

/**
 * The element a setting draws, found by its setting's id.
 *
 * @param {object} ui {@link openSettings}'s answer.
 * @param {string} id
 * @returns {Element|undefined}
 */
function control(ui, id) {
  return ui.byId(`setting-control-${id}`)?.controlEl;
}

const homePage = () => Services.prefs.getStringPref("browser.startup.homepage");

add_task(async function the_home_page_group_sets_new_windows_and_tabs() {
  const ui = await openPane(
    "home",
    u => control(u, "homepageRestoreDefaults")?.checkVisibility(),
    "the home page group"
  );
  const doc = ui.page.document;
  Assert.ok(
    doc.querySelector('setting-group[groupid="homepage"]').checkVisibility(),
    "the home page group shows"
  );
  Assert.ok(
    !doc.querySelector('setting-group[groupid="home"]'),
    "and no group of Firefox Home's switches"
  );
  for (const id of ["homepageNewWindows", "homepageNewTabs"]) {
    Assert.ok(control(ui, id).checkVisibility(), `${id} shows`);
  }
  Assert.ok(
    control(ui, "homepageRestoreDefaults").disabled,
    "Restore Defaults waits for a change"
  );

  pick(ui, "homepageNewWindows", "blank");
  await TestUtils.waitForCondition(
    () => homePage() === BLANK,
    "a blank page for new windows"
  );
  pick(ui, "homepageNewTabs", "blank");
  await TestUtils.waitForCondition(
    () => !Services.prefs.getBoolPref("browser.newtabpage.enabled"),
    "a blank page for new tabs"
  );

  pick(ui, "homepageNewWindows", "custom");
  await TestUtils.waitForCondition(
    () => control(ui, "homepageGoToCustomHomepageUrlPanel")?.checkVisibility(),
    "a custom home page offers its subpane"
  );

  await TestUtils.waitForCondition(
    () => !control(ui, "homepageRestoreDefaults").disabled,
    "Restore Defaults is offered"
  );
  control(ui, "homepageRestoreDefaults").click();
  await TestUtils.waitForCondition(
    () =>
      homePage() === "about:home" &&
      Services.prefs.getBoolPref("browser.newtabpage.enabled"),
    "Restore Defaults puts the home page back for both"
  );
});

add_task(async function the_custom_home_page_subpane_sets_its_pages() {
  const tab = await openPage(OPEN_PAGE);
  const ui = await openSettings();
  await showPane(ui.page, "customHomepage");
  await TestUtils.waitForCondition(
    () => control(ui, "customHomepageAddAddressButton")?.checkVisibility(),
    "the custom home page's subpane"
  );
  for (const id of [
    "customHomepageAddUrlInput",
    "customHomepageReplaceWithCurrentPagesButton",
    "customHomepageReplaceWithBookmarksButton",
  ]) {
    Assert.ok(control(ui, id).checkVisibility(), `${id} shows`);
    Assert.ok(!control(ui, id).disabled, `and can be used`);
  }

  const input = control(ui, "customHomepageAddUrlInput");
  input.value = "https://example.org/sval-added";
  input.dispatchEvent(new ui.page.Event("change", { bubbles: true }));
  control(ui, "customHomepageAddAddressButton").click();
  await TestUtils.waitForCondition(
    () => homePage() === "https://example.org/sval-added",
    "an address typed becomes the home page"
  );

  control(ui, "customHomepageReplaceWithCurrentPagesButton").click();
  await TestUtils.waitForCondition(
    () => homePage().split("|").includes(OPEN_PAGE),
    "Use Current Pages sets the open pages"
  );
  Assert.ok(
    !homePage().includes("about:preferences"),
    "without the settings page"
  );
  BrowserTestUtils.removeTab(tab);
});
