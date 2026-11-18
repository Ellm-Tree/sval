/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A press of play plays the video on a site set to Ask first (decision 0132):
 * a player's own button that calls play() inside the press, and the video's
 * native controls. The press allows media for the visit, with no reload. A
 * play() the page makes after the press has been handled plays nothing, and
 * on Always deny a press of play plays nothing.
 */

const { SvalSiteProtections, SITE_BRANCH } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
);
const { mediaOf } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteControls.sys.mjs"
);

const PRESS_PAGE = ROOT + "sval_media_press_page.html";

function reset() {
  clearPrefBranches(SITE_BRANCH);
  SvalSiteProtections.setMediaDefault("ask");
  Services.perms.removeAll();
}

function mediaButton() {
  return document.getElementById("sval-media-button");
}

/**
 * Presses the middle of the page's element `selector` through the platform,
 * as a person's click arrives.
 *
 * @param {Element} browser
 * @param {string} selector
 */
async function press(browser, selector) {
  const box = await SpecialPowers.spawn(browser, [selector], sel => {
    const rect = content.document.querySelector(sel).getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  const rect = browser.getBoundingClientRect();
  const point = {
    screenX: window.mozInnerScreenX + rect.left + box.x,
    screenY: window.mozInnerScreenY + rect.top + box.y,
  };
  await nativeMouse({
    type: "mousemove",
    target: browser,
    ...point,
    eventTargetToListen: window,
  });
  for (const type of ["mousedown", "mouseup"]) {
    await nativeMouse({ type, target: browser, ...point });
  }
}

/**
 * Whether the page's video `id` is playing.
 *
 * @param {Element} browser
 * @param {string} id
 * @returns {Promise<boolean>}
 */
function playing(browser, id) {
  return SpecialPowers.spawn(
    browser,
    [id],
    which => !content.document.getElementById(which).paused
  );
}

/**
 * Marks the page, so a test can tell it was never reloaded.
 *
 * @param {Element} browser
 */
function markPage(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    content.wrappedJSObject.marked = true;
  });
}

function isMarked(browser) {
  return SpecialPowers.spawn(
    browser,
    [],
    () => !!content.wrappedJSObject.marked
  );
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      // Sval's default, Gecko's own; the harness allows autoplay.
      ["media.autoplay.default", Ci.nsIAutoplay.BLOCKED],
    ],
  });
  // A press the platform delivers lands on the page's `<browser>`, which has
  // no accessible of its own to operate.
  AccessibilityUtils.setEnv({ mustHaveAccessibleRule: false });
  registerCleanupFunction(() => {
    AccessibilityUtils.resetEnv();
    reset();
  });
});

add_task(async function a_press_on_a_players_button_plays_its_video() {
  reset();
  await moveWindowOnScreen();
  const tab = await openPage(PRESS_PAGE);
  const browser = tab.linkedBrowser;
  await markPage(browser);
  const played = within(
    BrowserTestUtils.waitForEvent(gBrowser, "SvalMediaPressPlayed"),
    10_000,
    "the press reported as playing a video"
  );
  await press(browser, "#overlay");
  await played;
  await TestUtils.waitForCondition(
    () => playing(browser, "custom"),
    "the player's video playing"
  );
  await TestUtils.waitForCondition(
    () => mediaButton().getAttribute("sval-media") === "visit",
    "the media button showing media allowed for this visit"
  );
  Assert.equal(mediaOf(window).visit, "allow", "the visit allows media");
  Assert.ok(await isMarked(browser), "and the page was not reloaded");
  Assert.equal(
    await asPage(browser, () =>
      document
        .getElementById("native")
        .play()
        .then(
          () => "resolved",
          e => e.name
        )
    ),
    "resolved",
    "another video on the page plays without a press"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function a_press_on_native_controls_plays_the_video() {
  reset();
  await moveWindowOnScreen();
  const tab = await openPage(PRESS_PAGE);
  const browser = tab.linkedBrowser;
  await press(browser, "#native");
  await TestUtils.waitForCondition(
    () => playing(browser, "native"),
    "the video with native controls playing"
  );
  await TestUtils.waitForCondition(
    () => mediaOf(window).visit === "allow",
    "the visit allowing media"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function a_play_after_the_press_plays_nothing() {
  reset();
  await moveWindowOnScreen();
  const tab = await openPage(PRESS_PAGE);
  const browser = tab.linkedBrowser;
  const blocked = within(
    BrowserTestUtils.waitForEvent(gBrowser, "GloballyAutoplayBlocked"),
    10_000,
    "the play() after the click blocked"
  );
  await press(browser, "#text");
  await blocked;
  Assert.ok(!(await playing(browser, "custom")), "the video stays paused");
  Assert.equal(mediaOf(window).visit, null, "nothing is allowed for the visit");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function on_always_deny_a_press_plays_nothing() {
  reset();
  SvalSiteProtections.setMedia("example.com", "block");
  await moveWindowOnScreen();
  const tab = await openPage(PRESS_PAGE);
  const browser = tab.linkedBrowser;
  let reported = false;
  const listener = () => (reported = true);
  gBrowser.addEventListener("SvalMediaPressPlayed", listener);
  atTaskEnd(() =>
    gBrowser.removeEventListener("SvalMediaPressPlayed", listener)
  );
  await press(browser, "#overlay");
  await SpecialPowers.spawn(
    browser,
    [],
    () => new Promise(resolve => ChromeUtils.idleDispatch(() => resolve()))
  );
  Assert.ok(!(await playing(browser, "custom")), "the video stays paused");
  Assert.ok(!reported, "and no press is reported as playing it");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function a_pages_process_cannot_name_the_event_chrome_gets() {
  reset();
  const tab = await openPage(PRESS_PAGE);
  const forged = [];
  const listener = event => forged.push(event.type);
  gBrowser.addEventListener("SvalForgedEvent", listener);
  atTaskEnd(() => gBrowser.removeEventListener("SvalForgedEvent", listener));
  const blocked = within(
    BrowserTestUtils.waitForEvent(gBrowser, "GloballyAutoplayBlocked"),
    10_000,
    "the actor's message arriving as the event Gecko sends"
  );
  // What a page's process could send if it were taken over.
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.windowGlobalChild
      .getActor("Autoplay")
      .sendAsyncMessage("SvalForgedEvent", {});
  });
  await blocked;
  Assert.deepEqual(forged, [], "no event of the name the process chose");
  BrowserTestUtils.removeTab(tab);
});
