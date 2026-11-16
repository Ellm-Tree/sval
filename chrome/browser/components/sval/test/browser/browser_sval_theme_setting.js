/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */

/**
 * Settings › Appearance › Theme picks light or dark for the whole of Sval:
 * the browser window and its own pages, as well as what websites are told.
 * Automatic follows the system.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

const OVERRIDE = "layout.css.prefers-color-scheme.content-override";

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel starting");
  registerCleanupFunction(() => Services.prefs.clearUserPref(OVERRIDE));
});

/** @returns {Promise<Element>} A home tab in this window. */
async function openHome() {
  return within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "about:home"),
    10_000,
    "a home tab opening"
  );
}

/**
 * Waits until the window, and the home page in `home`, are in `scheme`.
 *
 * @param {Element} home
 * @param {"light"|"dark"} scheme
 * @param {string} what
 */
async function untilScheme(home, scheme, what) {
  const query = `(prefers-color-scheme: ${scheme})`;
  // The stylesheet's media queries follow a moment after `matchMedia` does.
  await TestUtils.waitForCondition(
    () =>
      window.matchMedia(query).matches &&
      getComputedStyle(document.documentElement)
        .getPropertyValue("--sval-surface-dark")
        .trim() === (scheme === "dark" ? "1" : "0"),
    `${what}: the window is drawn ${scheme}`
  );
  await TestUtils.waitForCondition(
    () =>
      SpecialPowers.spawn(
        home.linkedBrowser,
        [query],
        q => content.matchMedia(q).matches
      ),
    `${what}: the home page is ${scheme}`
  );
}

add_task(async function the_theme_setting_sets_the_window_and_home() {
  await panelWithFolder(null);
  const home = await openHome();
  const ui = await openSettings();
  await showPane(ui.page, "paneAppearance");
  const choice = value => ui.byId(`preferences-web-appearance-choice-${value}`);
  await TestUtils.waitForCondition(
    () => choice("light")?.checkVisibility(),
    "Appearance shows the theme choices"
  );

  const systemDark = () =>
    window.matchMedia("(-moz-system-dark-theme)").matches;
  // A user clicks the item's own control, the radio its shadow root holds.
  // `MozVisualPickerItem.handleClick` dispatches the click again on the
  // item's host, which has no accessible of its own, so the a11y checks are
  // told the host is not what was clicked.
  const pick = value => {
    AccessibilityUtils.setEnv({ mustHaveAccessibleRule: false });
    choice(value).itemEl.click();
    AccessibilityUtils.resetEnv();
    Assert.ok(choice(value).checked, `${value} is chosen`);
  };

  // Each choice holds against a system in the other scheme.
  pick(systemDark() ? "light" : "dark");
  await untilScheme(
    home,
    systemDark() ? "light" : "dark",
    "against the system"
  );
  pick(systemDark() ? "dark" : "light");
  await untilScheme(home, systemDark() ? "dark" : "light", "with the system");

  pick("auto");
  for (const dark of [!systemDark(), systemDark()]) {
    await SpecialPowers.pushPrefEnv({
      set: [["ui.systemUsesDarkTheme", dark ? 1 : 0]],
    });
    await untilScheme(
      home,
      dark ? "dark" : "light",
      `Automatic on a ${dark ? "dark" : "light"} system`
    );
    await SpecialPowers.popPrefEnv();
  }
  BrowserTestUtils.removeTab(ui.tab);
  BrowserTestUtils.removeTab(home);
});
