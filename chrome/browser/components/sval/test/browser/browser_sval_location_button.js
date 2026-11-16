/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The site controls' location button: shown while a site asks for the
 * person's location, its prompt open or closed unanswered, and while the
 * tab uses location; the prompt opens from it, and Firefox's own anchor in
 * the address field never shows.
 */

const LOC_PAGE = "https://example.com/";
const LOC_OTHER = "https://example.org/";

function byId(id) {
  return document.getElementById(id);
}

function locationButton() {
  return byId("sval-location-button");
}

/**
 * Asks for the position as the page, through Firefox's real prompt.
 *
 * @param {Element} browser
 * @returns {Promise<boolean>} Resolves with whether the page was refused,
 *   once the person answers.
 */
function askForLocation(browser) {
  return SpecialPowers.spawn(
    browser,
    [],
    () =>
      new Promise(resolve => {
        content.navigator.geolocation.getCurrentPosition(
          () => resolve(false),
          error => resolve(error.code === error.PERMISSION_DENIED)
        );
      })
  );
}

/** Firefox's anchor for the prompt, which it marks `showing` in the field. */
function fieldGlobeShows() {
  const icon = byId("geo-notification-icon");
  Assert.ok(icon.hasAttribute("showing"), "Firefox marks its globe showing");
  return icon.checkVisibility();
}

/**
 * Checks the button shows the page's refused request, crossed.
 *
 * @param {string} by What refused it, as a failure names it.
 */
function assertRefused(by) {
  Assert.ok(locationButton().checkVisibility(), `the button stays: ${by}`);
  Assert.equal(locationButton().dataset.state, "blocked", by);
  Assert.equal(
    locationButton().querySelector(".sval-header-glyph").dataset.icon,
    "location-off",
    `crossed: ${by}`
  );
  Assert.equal(
    getComputedStyle(
      locationButton().querySelector(".sval-live-ask"),
      "::after"
    ).content,
    "none",
    `with no dot: ${by}`
  );
  Assert.ok(
    !byId("geo-notification-icon").checkVisibility(),
    "no globe in the field"
  );
}

const LOC_PRINCIPAL =
  Services.scriptSecurityManager.createContentPrincipalFromOrigin(
    LOC_PAGE.slice(0, -1)
  );

/**
 * Clicks the button, which saves `expected` for the site and reloads the
 * tab, and checks the reloaded page starts without the button.
 *
 * @param {Element} browser
 * @param {number} expected The `SitePermissions` state the click saves.
 */
async function clickSaves(browser, expected) {
  const menu = byId("sval-site-menu");
  const reloaded = BrowserTestUtils.browserLoaded(browser, false, LOC_PAGE);
  locationButton().click();
  await within(reloaded, 10_000, "the click's reload");
  const { state, scope } = SitePermissions.getForPrincipal(
    LOC_PRINCIPAL,
    "geo"
  );
  Assert.equal(state, expected, "the click saves the site's choice");
  Assert.equal(scope, SitePermissions.SCOPE_PERSISTENT, "for the site");
  Assert.equal(menu.state, "closed", "and opens no site menu");
  Assert.ok(locationButton().hidden, "the reloaded page starts without it");
}

/**
 * Navigates the tab to another page, which starts without the button.
 *
 * @param {Element} browser
 */
async function leaves(browser) {
  const loaded = BrowserTestUtils.browserLoaded(browser);
  BrowserTestUtils.startLoadingURIString(browser, LOC_OTHER);
  await within(loaded, 10_000, "a navigation");
  Assert.ok(locationButton().hidden, "the next page starts without it");
}

add_task(async function the_location_prompt_opens_from_its_button() {
  try {
    await BrowserTestUtils.withNewTab(LOC_PAGE, async browser => {
      Assert.ok(locationButton().hidden, "no button before the site asks");
      const popup = byId("notification-popup");
      const shown = BrowserTestUtils.waitForEvent(popup, "popupshown");
      const answered = askForLocation(browser);
      await within(shown, 10_000, "the location prompt's popupshown");
      Assert.ok(locationButton().checkVisibility(), "the button shows");
      Assert.equal(locationButton().dataset.state, "asking");
      Assert.equal(
        popup.anchorNode,
        locationButton(),
        "the prompt opens on it"
      );
      Assert.ok(!fieldGlobeShows(), "no globe in the address field");
      Assert.ok(
        byId("sval-live-devices").hidden,
        "the live segment leaves location to the button"
      );

      // Editing the address suppresses the prompt (`shouldSuppress` in
      // browser.js) until the field lets go.
      const hidden = BrowserTestUtils.waitForEvent(popup, "popuphidden");
      gURLBar.focus();
      EventUtils.sendString("x");
      await within(hidden, 5_000, "the prompt closing unanswered");
      await within(
        TestUtils.waitForCondition(
          () => locationButton().dataset.state === "waiting",
          "the button waiting"
        ),
        5_000,
        "the button waiting"
      );
      Assert.ok(locationButton().checkVisibility(), "the button stays");
      Assert.ok(!fieldGlobeShows(), "and no globe shows in the field");

      const again = BrowserTestUtils.waitForEvent(popup, "popupshown");
      gURLBar.handleRevert();
      gBrowser.selectedBrowser.focus();
      await within(again, 5_000, "the prompt opening again");
      Assert.equal(popup.anchorNode, locationButton(), "on the button");
      Assert.equal(locationButton().dataset.state, "asking");
      locationButton().click();
      Assert.equal(popup.state, "open", "a click keeps the prompt open");
      Assert.equal(popup.anchorNode, locationButton(), "on the button");

      const closed = BrowserTestUtils.waitForEvent(popup, "popuphidden");
      popup.querySelector(".popup-notification-secondary-button").click();
      await within(closed, 5_000, "the prompt closing on Block");
      Assert.ok(
        await within(answered, 5_000, "the page's answer"),
        "the page is refused"
      );
      assertRefused("the Block answer");
      await clickSaves(browser, SitePermissions.ALLOW);
    });
  } finally {
    SitePermissions.removeFromPrincipal(LOC_PRINCIPAL, "geo");
  }
});

add_task(async function a_blocked_site_shows_the_refused_request() {
  SitePermissions.setForPrincipal(LOC_PRINCIPAL, "geo", SitePermissions.BLOCK);
  try {
    await BrowserTestUtils.withNewTab(LOC_PAGE, async browser => {
      Assert.ok(
        await within(askForLocation(browser), 5_000, "the page's answer"),
        "the saved Block refuses the page"
      );
      assertRefused("the saved Block");
      await leaves(browser);
    });
  } finally {
    SitePermissions.removeFromPrincipal(LOC_PRINCIPAL, "geo");
  }

  await SpecialPowers.pushPrefEnv({ set: [["permissions.default.geo", 2]] });
  try {
    await BrowserTestUtils.withNewTab(LOC_PAGE, async browser => {
      Assert.ok(
        await within(askForLocation(browser), 5_000, "the page's answer"),
        "the Block default refuses the page"
      );
      assertRefused("the Block default");
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function location_in_use_is_blocked_by_a_click() {
  try {
    await BrowserTestUtils.withNewTab(LOC_PAGE, async browser => {
      // As `GeolocationPermissionPrompt` marks a request it allows. An allowed
      // request goes on to the OS's location permission, which a test leaves
      // alone.
      gBrowser.updateBrowserSharing(browser, { geo: true });
      await within(
        TestUtils.waitForCondition(
          () => locationButton().dataset.state === "live",
          "the button live"
        ),
        5_000,
        "the button live"
      );
      Assert.ok(locationButton().checkVisibility(), "the button shows");

      const other = await within(
        BrowserTestUtils.openNewForegroundTab(gBrowser, LOC_PAGE),
        10_000,
        "another tab"
      );
      Assert.ok(locationButton().hidden, "another tab shows none");
      BrowserTestUtils.removeTab(other);
      await switchDone(window);
      Assert.equal(gBrowser.selectedBrowser, browser);
      Assert.equal(locationButton().dataset.state, "live", "its tab shows it");
      Assert.ok(!locationButton().hidden);

      await clickSaves(browser, SitePermissions.BLOCK);
    });
  } finally {
    SitePermissions.removeFromPrincipal(LOC_PRINCIPAL, "geo");
  }
});

add_task(async function location_in_use_clears_on_navigation() {
  await BrowserTestUtils.withNewTab(LOC_PAGE, async browser => {
    gBrowser.updateBrowserSharing(browser, { geo: true });
    await within(
      TestUtils.waitForCondition(
        () => locationButton().dataset.state === "live",
        "the button live"
      ),
      5_000,
      "the button live"
    );
    await leaves(browser);
  });
});
