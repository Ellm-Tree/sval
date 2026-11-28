/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_site_styles_helpers.js */

// Site styles (site styles spec): a tint the editor sets shows on the site's
// pages and stays there, and only there, with the text still readable; Reset
// takes it away; none of it touches My filters; and every entry point opens
// the editor.

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_site_styles_helpers.js",
  this
);

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);
const { CustomKeys } = ChromeUtils.importESModule(
  "moz-src:///browser/components/customkeys/CustomKeys.sys.mjs"
);
const { SvalBlocking } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
);
const { linesForScope } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalElementRules.sys.mjs"
);
const { STYLE_KEY } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalKeys.sys.mjs"
);
const { STYLE_CONTEXT_ITEM_ID } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteStylePanel.sys.mjs"
);
const { STYLE_MENU_ITEM_ID } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalMenuBar.sys.mjs"
);

const SAME_SITE_PAGE = `https://example.com${STYLE_PATH}?another`;
const OTHER_SITE_PAGE = `https://example.org${STYLE_PATH}`;
/** A blue tint at 60 percent. */
const TINT = { hue: 220, strength: 60, complement: 55 };
const KEY = { modifiers: "accel,alt,shift", key: "Y" };

add_setup(failOnConsoleErrors);
add_setup(function () {
  registerCleanupFunction(async () => {
    CustomKeys.resetAll();
    await UrlbarTestUtils.promisePopupClose(window);
    gURLBar.handleRevert();
  });
});

/**
 * @param {Element} browser
 * @returns {Promise<boolean>} whether the page's white background is drawn
 *   in another color.
 */
async function tinted(browser) {
  return !sameColor(await drawnBackground(browser), WHITE_RGB);
}

add_task(async function a_tint_stays_on_its_site_until_reset() {
  const filters = SvalBlocking.myFilters;
  const tab = await openPage(STYLE_PAGE);
  const browser = tab.linkedBrowser;
  Assert.ok(!(await tinted(browser)), "the page starts white");

  await openFromSiteMenu();
  byId("sval-style-accent").focus();
  for (let i = 0; i < 12; i++) {
    EventUtils.synthesizeKey("KEY_ArrowUp");
  }
  await until(() => tinted(browser), "the page taking the tint");
  const background = await drawnBackground(browser);
  const ink = await drawnAt(browser, "#ink");
  Assert.greater(
    contrast(ink, background),
    7,
    `the text stays readable on the tinted page: ${JSON.stringify(ink)} on ${JSON.stringify(background)}`
  );
  const saved = BrowserTestUtils.waitForPopupEvent(editor(), "hidden");
  byId("sval-style-save").click();
  await within(saved, 10_000, "Save closing the dialog");
  Assert.ok(
    byId("sval-site-menu-button").hasAttribute("sval-styled"),
    "the site controls mark the styled page"
  );

  await within(BrowserTestUtils.reloadTab(tab), 10_000, "the page reloading");
  await pageReady(browser, STYLE_PAGE);
  Assert.ok(
    await tinted(browser),
    "the tint is there once the reloaded page has loaded"
  );

  BrowserTestUtils.startLoadingURIString(browser, SAME_SITE_PAGE);
  await pageReady(browser, SAME_SITE_PAGE);
  Assert.ok(await tinted(browser), "another page of the site shows it");

  const other = await openPage(OTHER_SITE_PAGE);
  Assert.ok(
    !(await tinted(other.linkedBrowser)),
    "another site keeps its own background"
  );
  Assert.ok(
    !byId("sval-site-menu-button").hasAttribute("sval-styled"),
    "and its site controls carry no mark"
  );
  BrowserTestUtils.removeTab(other);
  await selectTab(tab);

  Assert.equal(SvalBlocking.myFilters, filters, "My filters are untouched");
  Assert.deepEqual(
    linesForScope(SvalBlocking.myFilters, "example.com"),
    [],
    "the site has no removal rules"
  );
  await menuReady();
  const menu = byId("sval-site-menu");
  const menuShown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  byId("sval-site-menu-button").click();
  await within(menuShown, 10_000, "the site menu showing");
  Assert.ok(
    !byId("sval-site-hidden-toggle"),
    "the site menu lists no removal rules"
  );
  const shown = editorShown();
  byId("sval-site-style").click();
  await shown;

  Assert.ok(byId("sval-style-reset"), "Reset is offered for the styled site");
  byId("sval-style-reset").click();
  await until(
    async () => sameColor(await drawnBackground(browser), WHITE_RGB),
    "the page going back to its own background"
  );
  const closed = BrowserTestUtils.waitForPopupEvent(editor(), "hidden");
  byId("sval-style-save").click();
  await within(closed, 10_000, "Save closing the dialog");
  Assert.ok(!Services.prefs.prefHasUserValue(STYLES_PREF), "no style is kept");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function a_page_back_from_history_shows_the_style_it_has_now() {
  SvalSiteStyles.setStyle("example.com", TINT);
  const tab = await openPage(STYLE_PAGE);
  const browser = tab.linkedBrowser;
  Assert.ok(await tinted(browser), "the page is styled");
  BrowserTestUtils.startLoadingURIString(browser, OTHER_SITE_PAGE);
  await pageReady(browser, OTHER_SITE_PAGE);
  Assert.ok(!(await tinted(browser)), "the next site's page is not");

  SvalSiteStyles.removeStyles(["example.com"]);
  browser.goBack();
  await pageReady(browser, STYLE_PAGE);
  await until(
    async () => !(await tinted(browser)),
    "the page back from history losing the removed style"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function the_page_menus_and_the_tab_menu_open_the_editor() {
  const tab = await openPage(STYLE_PAGE);
  const browser = tab.linkedBrowser;
  const menu = byId("contentAreaContextMenu");
  const menuShown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#text",
    { type: "contextmenu", button: 2 },
    browser
  );
  await within(menuShown, 10_000, "the page's context menu showing");
  const item = byId(STYLE_CONTEXT_ITEM_ID);
  Assert.ok(!item.hidden, "the context menu offers the editor");
  const shown = editorShown();
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(item);
  await within(hidden, 10_000, "the context menu hiding");
  await shown;
  await closeEditor();

  const tabItem = byId(STYLE_MENU_ITEM_ID);
  Assert.equal(
    tabItem?.getAttribute("key"),
    STYLE_KEY,
    "the Tab menu offers the editor on its key"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function a_tabs_row_menu_opens_the_editor_on_that_tab() {
  const tab = await openPage(STYLE_PAGE);
  const other = await openPage(OTHER_SITE_PAGE);
  await within(SvalPanel.observer.settled(), 10_000, "the rows settling");
  const id = SvalPanel.observer.nodeIdFor(tab);

  const menu = SvalPanel._els.contextMenu;
  SvalPanel._focusRow(id);
  const menuShown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeKey("KEY_ContextMenu");
  await within(menuShown, 10_000, "the row's menu showing");
  const item = menuItem(SvalPanel.rowMenu.menu, "styleSite");
  Assert.ok(!item.hidden, "the row's menu offers the editor");
  const shown = editorShown();
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(item);
  await within(hidden, 10_000, "the row's menu hiding");
  await shown;
  Assert.equal(gBrowser.selectedTab, tab, "the row's tab is selected");
  Assert.equal(
    editor().querySelector(".sval-prot-domain")?.textContent,
    "example.com",
    "the editor styles that tab's site"
  );
  await closeEditor();
  BrowserTestUtils.removeTab(other);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function the_launcher_opens_the_editor() {
  const tab = await openPage(STYLE_PAGE);
  await menuReady();
  await within(
    UrlbarTestUtils.promiseAutocompleteResultPopup({
      window,
      value: "Colorshift this site",
    }),
    10_000,
    "the address bar's results"
  );
  let index = -1;
  for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
    const row = await UrlbarTestUtils.getDetailsOfResultAt(window, i);
    if (row.result.payload.commandId === "style-site") {
      index = i;
    }
  }
  Assert.greater(index, -1, "the Launcher lists the command");
  while (UrlbarTestUtils.getSelectedRowIndex(window) !== index) {
    EventUtils.synthesizeKey("KEY_ArrowDown");
  }
  const shown = editorShown();
  EventUtils.synthesizeKey("KEY_Enter");
  await shown;
  await closeEditor();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function a_key_the_user_gives_opens_the_editor() {
  const key = byId(STYLE_KEY);
  Assert.ok(
    !key.hasAttribute("key") && !key.hasAttribute("keycode"),
    "the editor's key starts with none"
  );
  const taken = [...document.querySelectorAll("key")].find(
    el =>
      el.getAttribute("key")?.toUpperCase() === KEY.key &&
      el.getAttribute("modifiers") === KEY.modifiers
  );
  Assert.ok(!taken, "no other command has the key");
  CustomKeys.changeKey(STYLE_KEY, KEY);
  atTaskEnd(() => CustomKeys.resetKey(STYLE_KEY));

  const tab = await openPage(STYLE_PAGE);
  await menuReady();
  tab.linkedBrowser.focus();
  const shown = editorShown();
  EventUtils.synthesizeKey(KEY.key, {
    accelKey: true,
    altKey: true,
    shiftKey: true,
  });
  await shown;
  await until(
    () => editor().contains(document.activeElement),
    "the focus moving into the editor"
  );
  await closeEditor();
  BrowserTestUtils.removeTab(tab);
});
