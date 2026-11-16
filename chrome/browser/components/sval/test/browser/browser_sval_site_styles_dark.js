/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_site_styles_helpers.js */

// A site's theme (site styles spec §5): Dark always ends with a dark page, a
// site's own dark theme where it has one, an inverted page where it stays
// light, and a page that is dark already left as it is. Light is the
// reverse. Pictures keep their colors.

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_site_styles_helpers.js",
  this
);

const { THEME_MEASURED_TOPIC } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPageRulesChild.sys.mjs"
);

add_setup(failOnConsoleErrors);

/**
 * @param {Element} browser
 * @returns {Promise<void>} once dark has next measured the page.
 */
function measured(browser) {
  return within(
    SpecialPowers.spawn(
      browser,
      [THEME_MEASURED_TOPIC],
      topic =>
        new Promise(resolve => {
          // The actor's view of the window and this one are wrappers of
          // their own, so the window is told by its id.
          const id = content.windowGlobalChild.innerWindowId;
          const observe = subject => {
            if (subject.windowGlobalChild?.innerWindowId == id) {
              Services.obs.removeObserver(observe, topic);
              resolve();
            }
          };
          Services.obs.addObserver(observe, topic);
        })
    ),
    10_000,
    "dark measuring the page"
  );
}

/**
 * @param {Element} browser
 * @returns {Promise<boolean>} whether the page's background is drawn dark,
 *   as the person sees it.
 */
async function drawnDark(browser) {
  return luminance(await drawnBackground(browser)) < 0.05;
}

/**
 * Opens `url`, picks `theme` in the editor, and resolves once the theme has
 * measured the page.
 *
 * @param {string} url
 * @param {string} [theme]
 * @returns {Promise<Element>} the tab.
 */
async function themeOn(url, theme = "dark") {
  const tab = await openPage(url);
  const browser = tab.linkedBrowser;
  await openFromSiteMenu();
  const done = measured(browser);
  // The page runs its tasks in order, so once this one answers, the
  // observer is in place.
  await within(
    SpecialPowers.spawn(browser, [], () => {}),
    10_000,
    "the page answering"
  );
  await pickTheme(theme);
  await done;
  return tab;
}

/**
 * Cancels the dialog, which puts back the page's own scheme.
 *
 * @param {Element} tab
 */
async function themeOff(tab) {
  const browser = tab.linkedBrowser;
  const hidden = BrowserTestUtils.waitForPopupEvent(editor(), "hidden");
  byId("sval-style-cancel").click();
  await within(hidden, 10_000, "Cancel closing the dialog");
  await until(
    () => browser.browsingContext.prefersColorSchemeOverride === "none",
    "the tab's color scheme going back"
  );
  BrowserTestUtils.removeTab(tab);
}

add_task(async function a_light_page_without_a_dark_theme_is_inverted() {
  const url = `https://example.com${STYLE_PATH}?plain`;
  const before = await openPage(url);
  const photo = await drawnAt(before.linkedBrowser, "#photo");
  BrowserTestUtils.removeTab(before);

  const tab = await themeOn(url);
  const browser = tab.linkedBrowser;
  Assert.equal(
    browser.browsingContext.prefersColorSchemeOverride,
    "dark",
    "the site is asked for its dark theme"
  );
  await until(() => drawnDark(browser), "the page drawn dark");
  const background = await drawnBackground(browser);
  const ink = await drawnAt(browser, "#ink");
  Assert.greater(
    contrast(ink, background),
    7,
    `its text is light on the dark page: ${JSON.stringify(ink)} on ${JSON.stringify(background)}`
  );
  Assert.ok(
    sameColor(await drawnAt(browser, "#photo"), photo),
    "the picture keeps its colors"
  );
  await themeOff(tab);
});

add_task(async function a_page_with_its_own_dark_theme_uses_it() {
  const tab = await themeOn(`https://example.com${STYLE_PATH}?theme`);
  const browser = tab.linkedBrowser;
  await until(
    async () =>
      sameColor(await drawnBackground(browser), { r: 17, g: 17, b: 17 }),
    "the page drawn in its own dark theme, not inverted"
  );
  Assert.ok(
    !browser.browsingContext.svalSiteStyleDark,
    "the page's colors are not inverted"
  );
  await themeOff(tab);
});

add_task(async function a_page_that_is_dark_already_is_left_alone() {
  const tab = await themeOn(`https://example.com${STYLE_PATH}?dark-only`);
  const browser = tab.linkedBrowser;
  await until(
    async () =>
      sameColor(await drawnBackground(browser), { r: 18, g: 18, b: 18 }),
    "the page drawn with its own background"
  );
  await themeOff(tab);
});

add_task(async function a_dark_page_is_dark_as_it_loads() {
  SvalSiteStyles.setStyle("example.com", { theme: "dark" });
  const tab = await openPage(`https://example.com${STYLE_PATH}?plain`);
  const browser = tab.linkedBrowser;
  Assert.ok(
    browser.browsingContext.svalSiteStyleDark,
    "the tab paints inverted from its first paint"
  );
  Assert.ok(await drawnDark(browser), "the loaded page is drawn dark");

  const theme = await openPage(`https://example.com${STYLE_PATH}?theme`);
  await until(
    async () =>
      sameColor(await drawnBackground(theme.linkedBrowser), {
        r: 17,
        g: 17,
        b: 17,
      }),
    "a page with a dark theme loading in it"
  );
  Services.prefs.clearUserPref(STYLES_PREF);
  BrowserTestUtils.removeTab(theme);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function light_lightens_a_page_that_is_only_dark() {
  const tab = await themeOn(
    `https://example.com${STYLE_PATH}?dark-only`,
    "light"
  );
  const browser = tab.linkedBrowser;
  Assert.equal(
    browser.browsingContext.prefersColorSchemeOverride,
    "light",
    "the site is asked for its light theme"
  );
  await until(
    async () => luminance(await drawnBackground(browser)) > 0.6,
    "the dark page drawn light"
  );
  const background = await drawnBackground(browser);
  const ink = await drawnAt(browser, "#ink");
  Assert.greater(
    contrast(ink, background),
    7,
    `its text is dark on the light page: ${JSON.stringify(ink)} on ${JSON.stringify(background)}`
  );
  await themeOff(tab);
});

add_task(async function light_leaves_a_light_page_alone() {
  const tab = await themeOn(`https://example.com${STYLE_PATH}?plain`, "light");
  const browser = tab.linkedBrowser;
  Assert.ok(
    sameColor(await drawnBackground(browser), WHITE_RGB),
    "the light page keeps its white"
  );
  Assert.ok(
    !browser.browsingContext.svalSiteStyleDark,
    "its colors are not turned over"
  );
  await themeOff(tab);
});
