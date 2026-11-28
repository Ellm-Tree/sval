/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * On a site set to Ask first, a play the media gate blocks opens a prompt
 * from the media button, once a visit, and each answer does
 * what it says.
 */

const { SvalSiteProtections, SITE_BRANCH } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
);

const GATE_PAGE = ROOT + "sval_media_gate_page.html";
const PROMPT_ID = "sval-media";

function reset() {
  clearPrefBranches(SITE_BRANCH);
  SvalSiteProtections.setMediaDefault("ask");
  Services.perms.removeAll();
}

function mediaButton() {
  return document.getElementById("sval-media-button");
}

/**
 * Runs `videoProbe` as the page and waits for the gate's report of the
 * blocked play, which the site controls answer as it is dispatched.
 *
 * @param {Element} browser
 * @param {object} [options] As for `asPage`.
 */
async function blockedPlay(browser, options) {
  const reported = BrowserTestUtils.waitForEvent(
    browser,
    "GloballyAutoplayBlocked"
  );
  Assert.equal(
    await asPage(browser, videoProbe, options),
    "NotAllowedError",
    "the page's play is blocked"
  );
  await within(reported, 10_000, "the gate's report of the blocked play");
}

/**
 * A blocked play, and the media prompt it opens.
 *
 * @param {Element} browser
 * @returns {Promise<Element>} The prompt's `popupnotification`.
 */
async function promptFor(browser) {
  const shown = BrowserTestUtils.waitForEvent(
    PopupNotifications.panel,
    "popupshown"
  );
  await blockedPlay(browser);
  await within(shown, 10_000, "the media prompt");
  const prompt = PopupNotifications.panel.firstElementChild;
  Assert.equal(prompt.notification.id, PROMPT_ID, "the media prompt opens");
  return prompt;
}

/**
 * Answers the prompt with `button` and waits for it to close.
 *
 * @param {Element} button
 */
async function answer(button) {
  const hidden = BrowserTestUtils.waitForEvent(
    PopupNotifications.panel,
    "popuphidden"
  );
  button.click();
  await within(hidden, 5_000, "the media prompt closing");
}

function promptOpen(browser) {
  return !!PopupNotifications.getNotification(PROMPT_ID, browser);
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      // Sval's default, Gecko's own; the harness allows autoplay.
      ["media.autoplay.default", Ci.nsIAutoplay.BLOCKED],
    ],
  });
  registerCleanupFunction(reset);
});

add_task(async function ask_first_asks_from_the_media_button_once_a_visit() {
  reset();
  await BrowserTestUtils.withNewTab(GATE_PAGE, async browser => {
    const prompt = await promptFor(browser);
    Assert.ok(
      mediaButton().contains(PopupNotifications.panel.anchorNode),
      "from the media button"
    );
    Assert.equal(
      prompt.querySelectorAll(".sval-prompt-action-button").length,
      1,
      "with its third answer as a button of its own"
    );

    const hidden = BrowserTestUtils.waitForEvent(
      PopupNotifications.panel,
      "popuphidden"
    );
    EventUtils.synthesizeKey("KEY_Escape");
    await within(hidden, 5_000, "the media prompt closing");
    Assert.ok(!promptOpen(browser), "Escape closes it");
    Assert.equal(
      mediaButton().getAttribute("sval-media"),
      "asked",
      "and the media button stays lit"
    );

    await blockedPlay(browser, { gesture: true });
    Assert.ok(!promptOpen(browser), "a later play on the visit asks no more");
  });
  reset();
});

add_task(async function allow_for_this_visit_plays_the_page() {
  reset();
  await BrowserTestUtils.withNewTab(GATE_PAGE, async browser => {
    const prompt = await promptFor(browser);
    const reloaded = BrowserTestUtils.browserLoaded(browser);
    await answer(prompt.button);
    await within(reloaded, 10_000, "the reload allowing media");
    Assert.equal(await asPage(browser, videoProbe), "resolved", "it plays");
    Assert.equal(
      mediaButton().getAttribute("sval-media"),
      "visit",
      "for this visit"
    );
    Assert.equal(
      SvalSiteProtections.mediaFor("example.com"),
      "ask",
      "and the site stays on Ask first"
    );
  });
  reset();
});

add_task(async function always_allow_saves_the_sites_choice() {
  reset();
  await BrowserTestUtils.withNewTab(GATE_PAGE, async browser => {
    const prompt = await promptFor(browser);
    const reloaded = BrowserTestUtils.browserLoaded(browser);
    await answer(prompt.querySelector(".sval-prompt-action-button"));
    await within(reloaded, 10_000, "the reload allowing media");
    Assert.equal(await asPage(browser, videoProbe), "resolved", "it plays");
    Assert.equal(
      SvalSiteProtections.mediaFor("example.com"),
      "allow",
      "and the site is on Always allow"
    );
  });
  reset();
});

add_task(async function dont_allow_stops_media_for_the_visit() {
  reset();
  await BrowserTestUtils.withNewTab(GATE_PAGE, async browser => {
    const prompt = await promptFor(browser);
    await answer(prompt.secondaryButton);
    Assert.equal(
      mediaButton().getAttribute("sval-media"),
      "refused",
      "media is stopped for the visit"
    );
    await blockedPlay(browser, { gesture: true });
    Assert.ok(!promptOpen(browser), "and the visit asks no more");
  });
  reset();
});

add_task(async function a_site_on_always_deny_is_never_asked() {
  reset();
  SvalSiteProtections.setMedia("example.com", "block");
  await BrowserTestUtils.withNewTab(GATE_PAGE, async browser => {
    await blockedPlay(browser);
    Assert.ok(!promptOpen(browser), "no prompt opens");
  });
  reset();
});

add_task(async function another_open_prompt_keeps_its_place() {
  reset();
  await BrowserTestUtils.withNewTab(GATE_PAGE, async browser => {
    const shown = BrowserTestUtils.waitForEvent(
      PopupNotifications.panel,
      "popupshown"
    );
    // As PermissionUI shows a site's notifications prompt.
    const other = PopupNotifications.show(
      browser,
      "web-notifications",
      "Allow example.com to send notifications?",
      "web-notifications-notification-icon",
      { label: "Allow", accessKey: "A", callback() {} },
      [{ label: "Block", accessKey: "B", callback() {} }]
    );
    await within(shown, 5_000, "the other prompt");
    await blockedPlay(browser);
    Assert.ok(!promptOpen(browser), "the media prompt waits");
    Assert.equal(
      PopupNotifications.panel.firstElementChild.notification,
      other,
      "and the other prompt stays open"
    );
    Assert.equal(
      mediaButton().getAttribute("sval-media"),
      "asked",
      "with the media button lit"
    );

    const hidden = BrowserTestUtils.waitForEvent(
      PopupNotifications.panel,
      "popuphidden"
    );
    PopupNotifications.remove(other);
    await within(hidden, 5_000, "the other prompt closing");
    await promptFor(browser);
  });
  reset();
});
