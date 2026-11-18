/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The scope the site menu and the Privacy and Security panel save at, on a
 * host under its site (host-scoped rules spec §4): the title's dropdown,
 * which opens at the host, and what each scope's choices reach.
 */

const { SvalJavascript, SITE_BRANCH: JS_BRANCH } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalJavascript.sys.mjs"
);
const { SvalSiteProtections, SITE_BRANCH: PROTECTION_BRANCH } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
  );
const { SvalBlocking } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
);

const PATH = "/browser/browser/components/sval/test/browser/";
const HOST_PAGE = `https://test1.example.com${PATH}sval_javascript_page.html`;
const SIBLING_PAGE = `https://test2.example.com${PATH}sval_javascript_page.html`;
const SITE_PAGE = `https://example.com${PATH}sval_javascript_page.html`;

add_setup(async function () {
  registerCleanupFunction(() => {
    clearPrefBranches(JS_BRANCH, PROTECTION_BRANCH);
    SvalBlocking.setMyFilters("");
  });
});

function byId(id) {
  return document.getElementById(id);
}

function menu() {
  return byId("sval-site-menu");
}

async function openMenu() {
  await within(
    TestUtils.waitForCondition(
      () => !byId("sval-site-menu-button").disabled,
      "the site controls reading the page"
    ),
    10_000,
    "the site controls reading the page"
  );
  const shown = BrowserTestUtils.waitForEvent(menu(), "popupshown");
  byId("sval-site-menu-button").click();
  await within(shown, 5_000, "the site menu's popupshown");
  atTaskEnd(closeMenu);
}

async function closeMenu() {
  if (menu().state === "closed") {
    return;
  }
  const hidden = BrowserTestUtils.waitForEvent(menu(), "popuphidden");
  menu().hidePopup();
  await within(hidden, 5_000, "the site menu's popuphidden");
}

/** @returns {?string} The scope the open menu's title shows. */
function scopeShown() {
  return menu().querySelector(".sval-site-head .sval-scope")?.dataset.scope;
}

/**
 * @param {Element} browser
 * @returns {Promise<boolean>} Whether the page's script ran.
 */
function scriptRan(browser) {
  return SpecialPowers.spawn(
    browser,
    [],
    () => content.document.body.dataset.ran === "yes"
  );
}

/**
 * Clicks the menu's JavaScript switch and waits for the reload it makes.
 *
 * @param {Element} browser
 */
async function flipJavascript(browser) {
  const loaded = BrowserTestUtils.browserLoaded(browser);
  byId("sval-site-js").click();
  await within(loaded, 10_000, "the tab reloading");
}

add_task(async function a_plain_site_has_no_scope_to_choose() {
  await BrowserTestUtils.withNewTab(SITE_PAGE, async () => {
    await openMenu();
    Assert.ok(!byId("sval-site-scope-button"), "the title is the site alone");
    Assert.ok(!byId("sval-site-perm-scope"), "and permissions say nothing");
  });
});

add_task(async function the_site_s_scope_reaches_a_sibling_host() {
  atTaskEnd(() => clearPrefBranches(JS_BRANCH));
  await BrowserTestUtils.withNewTab(HOST_PAGE, async browser => {
    await openMenu();
    Assert.equal(scopeShown(), "test1.example.com", "it opens at the host");
    Assert.ok(byId("sval-site-perm-scope"), "permissions say they stay");

    const button = byId("sval-site-scope-button");
    button.focus();
    EventUtils.synthesizeKey("KEY_ArrowDown");
    Assert.ok(!byId("sval-site-scope-menu").hidden, "Down opens the scopes");
    EventUtils.synthesizeKey("KEY_Escape");
    Assert.ok(byId("sval-site-scope-menu").hidden, "Escape closes them");
    Assert.equal(menu().state, "open", "and leaves the menu open");

    EventUtils.synthesizeKey("KEY_ArrowDown");
    EventUtils.synthesizeKey("KEY_ArrowDown");
    EventUtils.synthesizeKey("KEY_Enter");
    Assert.equal(scopeShown(), "example.com", "the site is picked");

    await flipJavascript(browser);
    Assert.equal(SvalJavascript.ruleFor("example.com"), "block");
    Assert.ok(!SvalJavascript.hasRule("test1.example.com"), "not the host");
    Assert.ok(!(await scriptRan(browser)), "the host follows its site");
    Assert.equal(scopeShown(), "example.com", "the menu stays at the site");
  });
  await BrowserTestUtils.withNewTab(SIBLING_PAGE, async browser => {
    Assert.ok(!(await scriptRan(browser)), "and so does another host");
  });
});

add_task(async function a_host_s_choice_beats_its_site_s() {
  SvalJavascript.setEnabled("example.com", false);
  atTaskEnd(() => clearPrefBranches(JS_BRANCH));
  await BrowserTestUtils.withNewTab(HOST_PAGE, async browser => {
    Assert.ok(!(await scriptRan(browser)), "the site blocks it");
    await openMenu();
    Assert.equal(scopeShown(), "test1.example.com", "it opens at the host");
    await flipJavascript(browser);
    Assert.equal(SvalJavascript.ruleFor("test1.example.com"), "allow");
    Assert.ok(await scriptRan(browser), "the host runs script");
    await closeMenu();

    await openMenu();
    byId("sval-site-scope-button").click();
    menu().querySelector("[data-scope='example.com']").click();
    Assert.ok(byId("sval-site-keeps"), "the site's scope names what it keeps");
  });
  await BrowserTestUtils.withNewTab(SIBLING_PAGE, async browser => {
    Assert.ok(!(await scriptRan(browser)), "another host stays blocked");
  });
});

add_task(async function show_again_here_excepts_the_host_alone() {
  SvalBlocking.setMyFilters("example.com##.sval-scope-gone");
  atTaskEnd(() => SvalBlocking.setMyFilters(""));
  await BrowserTestUtils.withNewTab(HOST_PAGE, async () => {
    await openMenu();
    byId("sval-site-scope-button").click();
    menu().querySelector("[data-scope='example.com']").click();
    byId("sval-site-hidden-toggle").click();
    const popup = BrowserTestUtils.waitForEvent(menu(), "popupshown");
    byId("sval-site-hidden-show-0").click();
    await within(popup, 5_000, "the choices opening");
    const choices = byId("sval-site-show-again-menu");
    choices.activateItem(choices.querySelector("[data-where='here']"));
    await within(
      TestUtils.waitForCondition(
        () => SvalBlocking.myFilters.includes("#@#"),
        "the choice saving"
      ),
      5_000,
      "the choice saving"
    );
    Assert.deepEqual(
      SvalBlocking.myFilters.split("\n"),
      ["example.com##.sval-scope-gone", "test1.example.com#@#.sval-scope-gone"],
      "the site keeps its rule and the host is excepted"
    );
  });
});

/**
 * Opens the menu's hidden list, picks `where` from the first row's
 * choices and waits for it to save.
 *
 * @param {string} where The choice's `data-where`.
 */
async function chooseForFirstRow(where) {
  byId("sval-site-hidden-toggle").click();
  const popup = BrowserTestUtils.waitForEvent(menu(), "popupshown");
  byId("sval-site-hidden-show-0").click();
  await within(popup, 5_000, "the choices opening");
  const choices = byId("sval-site-show-again-menu");
  const before = SvalBlocking.myFilters;
  choices.activateItem(choices.querySelector(`[data-where='${where}']`));
  await within(
    TestUtils.waitForCondition(
      () => SvalBlocking.myFilters !== before,
      "the choice saving"
    ),
    5_000,
    "the choice saving"
  );
}

/** @returns {?string} The header's count of rules hiding something. */
function headerCount() {
  return byId("sval-site-menu-button").getAttribute("sval-count");
}

add_task(async function a_host_lists_its_site_s_rules_and_counts_what_hides() {
  SvalBlocking.setMyFilters("example.com##body");
  atTaskEnd(() => SvalBlocking.setMyFilters(""));
  await BrowserTestUtils.withNewTab(HOST_PAGE, async browser => {
    await within(
      TestUtils.waitForCondition(() => headerCount() == "1", "the count"),
      10_000,
      "the header counting the site's rule"
    );
    await openMenu();
    Assert.equal(scopeShown(), "test1.example.com", "it opens at the host");
    const row = () => menu().querySelector(".sval-site-hidden-row");
    Assert.equal(row()?.dataset.inherited, "true", "the site's rule is listed");
    let loaded = BrowserTestUtils.browserLoaded(browser);
    await chooseForFirstRow("here");
    await within(loaded, 10_000, "the tab reloading at the choice");
    await closeMenu();
    Assert.equal(headerCount(), null, "a rule shown here counts none");

    await openMenu();
    Assert.equal(row()?.dataset.excepted, "true", "it is listed, shown here");
    loaded = BrowserTestUtils.browserLoaded(browser);
    await chooseForFirstRow("hide-here");
    Assert.equal(
      SvalBlocking.myFilters,
      "example.com##body",
      "hiding it here again takes the exception out"
    );
    await within(loaded, 10_000, "the tab reloading at the choice");
    await closeMenu();
    await within(
      TestUtils.waitForCondition(() => headerCount() == "1", "the count"),
      10_000,
      "the header counting the rule again"
    );
  });
});

add_task(async function the_protection_panel_saves_at_the_host() {
  atTaskEnd(() => clearPrefBranches(PROTECTION_BRANCH));
  await BrowserTestUtils.withNewTab(HOST_PAGE, async browser => {
    const panel = byId("sval-protection-panel");
    const shown = BrowserTestUtils.waitForEvent(panel, "popupshown");
    byId("sval-protection-button").click();
    await within(shown, 5_000, "the panel opening");
    atTaskEnd(async () => {
      if (panel.state !== "closed") {
        const gone = BrowserTestUtils.waitForEvent(panel, "popuphidden");
        panel.hidePopup();
        await within(gone, 5_000, "the panel closing");
      }
    });
    Assert.equal(
      panel.querySelector(".sval-prot-head .sval-scope")?.dataset.scope,
      "test1.example.com",
      "it opens at the host"
    );
    const loaded = BrowserTestUtils.browserLoaded(browser);
    byId("sval-prot-main").click();
    await within(loaded, 10_000, "the tab reloading");
    Assert.equal(
      SvalSiteProtections.ruleFor("test1.example.com").protections,
      "off",
      "the host's protections are off"
    );
    Assert.equal(
      SvalSiteProtections.protectionsFor("test2.example.com"),
      "on",
      "and another host's stay on"
    );
  });
});

add_task(async function the_button_and_the_launcher_act_at_the_host() {
  const { COMMANDS } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalLauncherCommands.sys.mjs"
  );
  atTaskEnd(() => clearPrefBranches(JS_BRANCH));
  await BrowserTestUtils.withNewTab(HOST_PAGE, async browser => {
    let loaded = BrowserTestUtils.browserLoaded(browser);
    byId("sval-javascript-button").click();
    await within(loaded, 10_000, "the reload with script off");
    Assert.ok(!(await scriptRan(browser)), "the button blocks the host");
    Assert.equal(SvalJavascript.ruleFor("test1.example.com"), "block");
    Assert.ok(!SvalJavascript.hasRule("example.com"), "and not its site");

    loaded = BrowserTestUtils.browserLoaded(browser);
    COMMANDS.find(c => c.id === "allow-javascript").run(window);
    await within(loaded, 10_000, "the reload with script on");
    Assert.ok(await scriptRan(browser), "the command allows the host");
    Assert.ok(!SvalJavascript.hasRule("test1.example.com"), "back to none");
    Assert.ok(!SvalJavascript.hasRule("example.com"), "the site untouched");
  });
});
