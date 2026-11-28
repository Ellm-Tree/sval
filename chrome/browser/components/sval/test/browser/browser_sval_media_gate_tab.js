/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The media gate across a tab's life (protections spec §4.1): a
 * click on the page lets nothing play, a blocked press of play is reported
 * again so the media button lights up, the media button's allowance plays
 * the page, a redirect to another origin of an Always site plays from its
 * first moment, and a visit's allowance never outlives the visit in a
 * content process the tab has left.
 */

const { SvalSiteProtections, SITE_BRANCH } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
);
const { mediaOf, mediaNameOf } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteControls.sys.mjs"
);

const GATE_PAGE = ROOT + "sval_media_gate_page.html";
const LOOP_PAGE = ROOT + "sval_media_gate_loop.html";
const FRAME_PAGE = ROOT + "sval_media_gate_frame.html";
const PATH = new URL(ROOT).pathname;

function pageOn(origin) {
  return origin + PATH + "sval_media_gate_page.html";
}

function reset() {
  clearPrefBranches(SITE_BRANCH);
  SvalSiteProtections.setMediaDefault("ask");
  Services.perms.removeAll();
}

/**
 * Runs `fn` as the page and collects the GloballyAutoplayBlocked events it
 * causes. Blocking posts the event as a task in the content process, and
 * AutoplayChild forwards it over the same actor channel the idle reply
 * takes, so once the content process has gone idle every event has arrived.
 *
 * @param {Element} browser
 * @param {Function} fn As for `asPage`.
 * @param {object} [options] As for `asPage`.
 * @returns {Promise<{result: *, events: CustomEvent[]}>}
 */
async function collectBlocked(browser, fn, options) {
  const events = [];
  const listener = event => events.push(event);
  gBrowser.addEventListener("GloballyAutoplayBlocked", listener);
  try {
    const result = await asPage(browser, fn, options);
    await SpecialPowers.spawn(
      browser,
      [],
      () => new Promise(resolve => ChromeUtils.idleDispatch(() => resolve()))
    );
    return { result, events };
  } finally {
    gBrowser.removeEventListener("GloballyAutoplayBlocked", listener);
  }
}

/** In the page: one video, kept on the window, and its first play(). */
async function firstPlay() {
  const canvas = document.createElement("canvas");
  canvas.getContext("2d").fillRect(0, 0, 1, 1);
  const video = document.createElement("video");
  video.muted = true;
  video.srcObject = canvas.captureStream();
  document.body.append(video);
  window.gateVideo = video;
  return video.play().then(
    () => "resolved",
    e => e.name
  );
}

/** In the page: play() again on the same video. */
async function playAgain() {
  return window.gateVideo.play().then(
    () => "resolved",
    e => e.name
  );
}

/** In the page: an AudioContext made with no gesture, as on load. */
function makeContext() {
  window.gateCtx = new AudioContext();
  return window.gateCtx.state;
}

/** In the page: resume() on that context, as a press of play does. */
function resumeContext() {
  // A blocked resume() stays pending, so it is not awaited.
  window.gateCtx.resume();
  return window.gateCtx.state;
}

/** In the page: the autoplay policy its document had as it was parsed. */
function policyAtStart() {
  return window.policyAtStart;
}

/**
 * Resolves once the page `browser` shows has had its `pagehide`, or at once
 * for about:blank. The bound counts from the call, so it covers the step
 * that leaves the page too. The parent stores a page in the back-forward cache
 * (`nsFrameLoaderOwner::ChangeRemotenessCommon`) before the page's own
 * process hides it, and a back or forward that restores the page before
 * that `pagehide` shows it with no `pageshow`. So a step that leaves a page
 * ends once the page is gone.
 *
 * @param {Element} browser
 * @returns {Promise}
 */
function pageLeft(browser) {
  if (browser.currentURI.spec == "about:blank") {
    return Promise.resolve();
  }
  return within(
    BrowserTestUtils.waitForContentEvent(
      browser,
      "pagehide",
      false,
      event => event.target.documentURI != "about:blank"
    ),
    20_000,
    "the page left hidden"
  );
}

async function load(browser, url) {
  const left = pageLeft(browser);
  const loaded = BrowserTestUtils.browserLoaded(browser);
  BrowserTestUtils.startLoadingURIString(browser, url);
  await within(loaded, 10_000, `the load of ${url}`);
  await left;
}

/**
 * Goes back or forward in the tab's history and waits for the page to be
 * shown. A location change comes as the page commits, before a fresh load has
 * parsed its body. `pageshow` comes after `load`, and also for a page the
 * bfcache restores, so it covers the page whether the bfcache kept it or not.
 *
 * @param {Element} browser
 * @param {"back"|"forward"} direction
 * @param {string} url Where the tab should end up.
 */
async function traverse(browser, direction, url) {
  const left = pageLeft(browser);
  const shown = BrowserTestUtils.waitForContentEvent(browser, "pageshow");
  if (direction == "back") {
    browser.goBack();
  } else {
    browser.goForward();
  }
  await within(shown, 10_000, `the page shown by going ${direction}`);
  await left;
  Assert.equal(browser.currentURI.spec, url, `the tab went ${direction}`);
}

function mediaButton() {
  return document.getElementById("sval-media-button");
}

/**
 * Allows media for the visit from the media button, and waits for its
 * reload.
 *
 * @param {Element} browser
 */
async function allowForVisit(browser) {
  const reloaded = BrowserTestUtils.browserLoaded(browser);
  mediaButton().click();
  await within(reloaded, 10_000, "the reload allowing media for the visit");
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

add_task(async function a_press_of_play_waits_for_the_media_button() {
  reset();
  await BrowserTestUtils.withNewTab(GATE_PAGE, async browser => {
    const autoplay = await collectBlocked(browser, firstPlay);
    Assert.equal(autoplay.result, "NotAllowedError", "autoplay is blocked");
    Assert.equal(autoplay.events.length, 1, "and reported");
    Assert.ok(!autoplay.events[0].detail.userGesture, "as autoplay");
    Assert.equal(autoplay.events[0].detail.kind, "video", "of a video");
    Assert.equal(
      mediaButton().getAttribute("sval-media"),
      "asked",
      "the media button lights up"
    );
    Assert.equal(
      mediaOf(window).tried,
      "video",
      "and says a video tried to play"
    );
    Assert.equal(
      mediaButton().getAttribute("tooltiptext"),
      mediaNameOf(mediaOf(window)),
      "in its tooltip"
    );

    const press = await collectBlocked(browser, playAgain, { gesture: true });
    Assert.equal(press.result, "NotAllowedError", "a press of play is blocked");
    Assert.equal(press.events.length, 1, "and reported");
    Assert.ok(press.events[0]?.detail.userGesture, "as a press of play");
    Assert.equal(
      mediaButton().getAttribute("sval-media"),
      "asked",
      "the media button stays lit"
    );

    await allowForVisit(browser);
    Assert.equal(
      await asPage(browser, firstPlay),
      "resolved",
      "the media button's allowance plays it"
    );
  });
});

add_task(async function a_press_of_play_on_a_never_site_is_reported_again() {
  reset();
  SvalSiteProtections.setMedia("example.com", "block");
  await BrowserTestUtils.withNewTab(GATE_PAGE, async browser => {
    await collectBlocked(browser, firstPlay);
    const press = await collectBlocked(browser, playAgain, { gesture: true });
    Assert.equal(press.result, "NotAllowedError", "the press is blocked");
    Assert.equal(press.events.length, 1, "and reported");
    Assert.ok(press.events[0]?.detail.userGesture, "as a press of play");
    Assert.equal(panelIn().state, "closed", "and nothing opens on its own");
  });
  reset();
});

/**
 * With Settings › Sites on Always allow, a site with no choice plays from
 * the start, and a site's own Ask first and Always deny keep their meaning:
 * both block autoplay and a press of play.
 */
add_task(async function under_always_allow_ask_first_and_always_deny_hold() {
  reset();
  SvalSiteProtections.setMediaDefault("allow");
  await BrowserTestUtils.withNewTab(GATE_PAGE, async browser => {
    const autoplay = await collectBlocked(browser, firstPlay);
    Assert.equal(autoplay.result, "resolved", "unset: autoplay plays");
    Assert.equal(autoplay.events.length, 0, "unset: nothing to report");
  });

  SvalSiteProtections.setMedia("example.com", "ask");
  await BrowserTestUtils.withNewTab(GATE_PAGE, async browser => {
    const autoplay = await collectBlocked(browser, firstPlay);
    Assert.equal(
      autoplay.result,
      "NotAllowedError",
      "Ask first: autoplay blocked"
    );
    Assert.equal(
      mediaButton().getAttribute("sval-media"),
      "asked",
      "Ask first: the media button lights up"
    );
    const press = await collectBlocked(browser, playAgain, { gesture: true });
    Assert.equal(
      press.result,
      "NotAllowedError",
      "Ask first: a press of play blocked"
    );
  });

  SvalSiteProtections.setMedia("example.com", "block");
  await BrowserTestUtils.withNewTab(GATE_PAGE, async browser => {
    await collectBlocked(browser, firstPlay);
    const press = await collectBlocked(browser, playAgain, { gesture: true });
    Assert.equal(
      press.result,
      "NotAllowedError",
      "Always deny: the press blocked"
    );
  });
  reset();
});

add_task(
  async function a_press_of_play_resuming_a_blocked_context_lights_the_button() {
    reset();
    await BrowserTestUtils.withNewTab(GATE_PAGE, async browser => {
      const made = await collectBlocked(browser, makeContext);
      Assert.equal(made.result, "suspended", "the context is blocked");
      Assert.equal(made.events.length, 1, "and reported");
      Assert.ok(!made.events[0].detail.userGesture, "with no gesture");
      Assert.equal(
        mediaButton().getAttribute("sval-media"),
        "asked",
        "the media button lights up"
      );

      const press = await collectBlocked(browser, resumeContext, {
        gesture: true,
      });
      Assert.equal(press.result, "suspended", "resume() is blocked");
      Assert.equal(press.events.length, 1, "and reported");
      Assert.ok(press.events[0]?.detail.userGesture, "as a press of play");
      Assert.equal(panelIn().state, "closed", "and nothing opens on its own");
    });
  }
);

add_task(async function a_redirect_to_another_origin_of_an_always_site() {
  reset();
  SvalSiteProtections.setMedia("example.com", "allow");
  const target = pageOn("https://www.example.com");
  const www = Services.scriptSecurityManager.createContentPrincipal(
    Services.io.newURI(target),
    {}
  );
  Assert.equal(
    Services.perms.testExactPermissionFromPrincipal(www, "autoplay-media"),
    Services.perms.UNKNOWN_ACTION,
    "the redirect's target has no permission of its own yet"
  );
  await BrowserTestUtils.withNewTab("about:blank", async browser => {
    await load(
      browser,
      ROOT + "sval_agent_redirect.sjs?" + encodeURIComponent(target)
    );
    Assert.equal(
      browser.currentURI.spec,
      target,
      "the tab followed the redirect"
    );
    Assert.equal(
      await asPage(browser, policyAtStart),
      "allowed",
      "the redirected page could play from its first moment"
    );
    Assert.equal(await asPage(browser, videoProbe), "resolved", "and plays");
  });
  reset();
});

add_task(async function a_visits_allowance_ends_when_the_tab_leaves_the_site() {
  reset();
  const other = pageOn("https://example.org");
  await BrowserTestUtils.withNewTab(other, async browser => {
    await load(browser, GATE_PAGE);
    await allowForVisit(browser);
    Assert.equal(
      await asPage(browser, videoProbe),
      "resolved",
      "allowed for the visit"
    );

    await traverse(browser, "back", other);
    await traverse(browser, "forward", GATE_PAGE);
    Assert.equal(
      Services.perms.testForBrowser(
        browser.contentPrincipal,
        "autoplay-media",
        browser.browserId
      ),
      Services.perms.UNKNOWN_ACTION,
      "the tab's grant ended as the tab left the site"
    );
    Assert.equal(
      await asPage(browser, videoProbe),
      "NotAllowedError",
      "the page the grant was for is blocked again"
    );
  });
  reset();
});

add_task(async function a_visits_allowance_outlives_the_pages_frames() {
  reset();
  await BrowserTestUtils.withNewTab(FRAME_PAGE, async browser => {
    await allowForVisit(browser);
    Assert.equal(
      await asPage(browser, videoProbe),
      "resolved",
      "the reload that replaced the page's frame plays it"
    );

    const discarded = TestUtils.topicObserved(
      "browsing-context-discarded",
      context => context.browserId == browser.browserId
    );
    await SpecialPowers.spawn(browser, [], () =>
      content.document.querySelector("iframe").remove()
    );
    await within(discarded, 10_000, "the removed frame's discard");
    Assert.equal(
      Services.perms.testForBrowser(
        browser.contentPrincipal,
        "autoplay-media",
        browser.browserId
      ),
      Services.perms.ALLOW_ACTION,
      "the tab keeps its grant as a frame goes"
    );
    Assert.equal(
      await asPage(browser, videoProbe),
      "resolved",
      "and the page still plays"
    );
  });
  reset();
});

add_task(async function the_media_button_shows_the_grant_the_tab_holds() {
  reset();
  await BrowserTestUtils.withNewTab(GATE_PAGE, async browser => {
    await allowForVisit(browser);
    Assert.equal(
      mediaButton().getAttribute("sval-media"),
      "visit",
      "the media button shows the visit's allowance"
    );

    // As the grant's expiry (`privacy.temporary_permission_expire_time_ms`)
    // takes it away.
    Services.perms.removeFromPrincipalForBrowser(
      browser.contentPrincipal,
      "autoplay-media",
      browser.browserId
    );
    Assert.equal(
      mediaButton().getAttribute("sval-media"),
      "blocked",
      "the media button shows media blocked once the grant is gone"
    );
    Assert.equal(
      await asPage(browser, videoProbe),
      "NotAllowedError",
      "as the page finds"
    );
  });
  reset();
});

add_task(async function a_removed_tab_grant_reaches_the_process_the_tab_left() {
  reset();
  // One process per site, kept alive by a second tab on it, so the tab comes
  // back to the process the grant was given in, from the bfcache or not.
  await SpecialPowers.pushPrefEnv({
    set: [["dom.ipc.processCount.webIsolated", 1]],
  });
  const keeper = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, GATE_PAGE),
    15_000,
    "the keeper tab opening and loading"
  );
  const other = pageOn("https://example.org");
  await BrowserTestUtils.withNewTab(GATE_PAGE, async browser => {
    const principal = browser.contentPrincipal;
    const pidGate = browser.browsingContext.currentWindowGlobal.osPid;
    Services.perms.addFromPrincipalForBrowser(
      principal,
      "autoplay-media",
      Services.perms.ALLOW_ACTION,
      browser.browserId
    );
    Assert.equal(await asPage(browser, videoProbe), "resolved", "granted");

    await load(browser, other);
    Assert.notEqual(
      browser.browsingContext.currentWindowGlobal.osPid,
      pidGate,
      "the tab moved to another process"
    );
    Services.perms.removeFromPrincipalForBrowser(
      principal,
      "autoplay-media",
      browser.browserId
    );

    await traverse(browser, "back", GATE_PAGE);
    Assert.equal(
      browser.browsingContext.currentWindowGlobal.osPid,
      pidGate,
      "back in the process the grant was given in"
    );
    Assert.equal(
      await asPage(browser, videoProbe),
      "NotAllowedError",
      "the removed grant no longer applies there"
    );
  });
  BrowserTestUtils.removeTab(keeper);
  await SpecialPowers.popPrefEnv();
  reset();
});

/**
 * Resolves once the loop page has made `count` more play() attempts than
 * `from`, and returns those attempts and the video's state.
 *
 * @param {Element} browser
 * @param {number} from
 * @param {number} count
 * @param {boolean} [active] Count only attempts made with the user's
 *   activation.
 */
function loopAttempts(browser, from, count, active = false) {
  return within(
    SpecialPowers.spawn(
      browser,
      [from, count, active],
      async (start, n, withActivation) => {
        const page = content.wrappedJSObject;
        const made = () =>
          Array.from(page.attempts)
            .slice(start)
            .filter(a => !withActivation || a.active)
            .map(a => ({ active: a.active, result: a.result }));
        await ContentTaskUtils.waitForCondition(
          () => made().length >= n,
          "the player's play() attempts"
        );
        const video = content.document.getElementById("video");
        return {
          attempts: made(),
          paused: video.paused,
          currentTime: video.currentTime,
        };
      }
    ),
    15_000,
    "the loop page's play() attempts"
  );
}

/** In the page: how many play() attempts the loop has made. */
function attemptCount() {
  return window.attempts.length;
}

/**
 * A page that calls play() over and over plays nothing after a click on its
 * text: a click on the page is no allowance, and the blocked
 * attempts made with it are reported as presses of play.
 */
add_task(async function a_click_on_the_page_plays_nothing() {
  reset();
  await BrowserTestUtils.withNewTab(LOOP_PAGE, async browser => {
    const before = await loopAttempts(browser, 0, 1);
    Assert.equal(
      before.attempts[0].result,
      "NotAllowedError",
      "the player's autoplay is blocked"
    );
    await TestUtils.waitForCondition(
      () => mediaButton().getAttribute("sval-media") === "asked",
      "the media button lighting up"
    );
    const pressed = within(
      BrowserTestUtils.waitForEvent(
        gBrowser,
        "GloballyAutoplayBlocked",
        false,
        event => event.detail.userGesture
      ),
      10_000,
      "a blocked play() reported with the click's activation"
    );
    const from = await asPage(browser, attemptCount);
    await BrowserTestUtils.synthesizeMouseAtCenter("#text", {}, browser);
    const after = await loopAttempts(browser, from, 2, true);
    await pressed;
    Assert.deepEqual(
      after.attempts.map(a => a.result),
      ["NotAllowedError", "NotAllowedError"],
      "every play() made with the click's activation is blocked"
    );
    Assert.ok(after.paused, "the video stays paused");
    Assert.equal(
      after.currentTime,
      before.currentTime,
      "and its time has not moved"
    );
  });
});

/**
 * An element that played inside a press on the page plays again only while
 * the site allows media: Gecko's blessing of an element a press started
 * counts for nothing under the gate. The site menu's choice changes the
 * gate without a reload, as `SvalSiteProtections.setMedia` does here.
 */
add_task(async function a_played_element_needs_the_allowance_to_play_again() {
  reset();
  SvalSiteProtections.setMedia("example.com", "allow");
  await BrowserTestUtils.withNewTab(LOOP_PAGE, async browser => {
    const first = await loopAttempts(browser, 0, 1);
    Assert.equal(first.attempts[0].result, "resolved", "Always allow plays");
    // The page's own play button calls play() inside the press.
    await BrowserTestUtils.synthesizeMouseAtCenter("#play", {}, browser);

    SvalSiteProtections.setMedia("example.com", "ask");
    await TestUtils.waitForCondition(
      async () => (await asPage(browser, documentPolicy)) === "disallowed",
      "the page's media policy following Ask first"
    );
    const from = await asPage(browser, pauseVideo);
    const after = await loopAttempts(browser, from, 2);
    Assert.deepEqual(
      after.attempts.map(a => a.result),
      ["NotAllowedError", "NotAllowedError"],
      "the element pressed before cannot play again"
    );
    Assert.ok(after.paused, "and stays paused");
  });
  reset();
});

/** In the page: the autoplay policy for its media elements. */
function documentPolicy() {
  return navigator.getAutoplayPolicy("mediaelement");
}

/** In the page: pauses the loop's video, returning the attempts so far. */
function pauseVideo() {
  document.getElementById("video").pause();
  return window.attempts.length;
}

/**
 * Plays a looping audio element with sound, and waits for Firefox to mark
 * the tab audible. Its five seconds of tone are made in the page as a WAV
 * file: the media controller, which the media button pauses through, takes
 * only media longer than `media.mediacontrol.eligible.media.duration.s`.
 *
 * @param {Element} tab
 */
async function playSound(tab) {
  await within(
    SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
      const rate = 8000;
      const samples = rate * 5;
      const bytes = new DataView(new ArrayBuffer(44 + samples * 2));
      const text = (at, value) =>
        [...value].forEach((c, i) => bytes.setUint8(at + i, c.charCodeAt(0)));
      text(0, "RIFF");
      bytes.setUint32(4, 36 + samples * 2, true);
      text(8, "WAVEfmt ");
      bytes.setUint32(16, 16, true);
      bytes.setUint16(20, 1, true);
      bytes.setUint16(22, 1, true);
      bytes.setUint32(24, rate, true);
      bytes.setUint32(28, rate * 2, true);
      bytes.setUint16(32, 2, true);
      bytes.setUint16(34, 16, true);
      text(36, "data");
      bytes.setUint32(40, samples * 2, true);
      for (let i = 0; i < samples; i++) {
        const value = Math.sin((2 * Math.PI * 440 * i) / rate) * 8000;
        bytes.setInt16(44 + i * 2, value, true);
      }
      const blob = new content.Blob([bytes.buffer], { type: "audio/wav" });
      const audio = content.document.createElement("audio");
      audio.id = "sound";
      audio.src = content.URL.createObjectURL(blob);
      audio.loop = true;
      content.document.body.append(audio);
      await audio.play();
    }),
    10_000,
    "the page's sound starting"
  );
  await TestUtils.waitForCondition(
    () => tab.soundPlaying,
    "the tab is playing sound"
  );
}

/**
 * The media button shows sound the page plays as playing, whatever the
 * site's choice says, and its click stops it.
 */
add_task(async function the_media_button_shows_sound_that_plays() {
  reset();
  SvalSiteProtections.setMedia("example.com", "allow");
  await BrowserTestUtils.withNewTab(GATE_PAGE, async browser => {
    await playSound(gBrowser.getTabForBrowser(browser));
    SvalSiteProtections.setMedia("example.com", "ask");
    await TestUtils.waitForCondition(
      () => SvalSiteProtections.mediaFor("example.com") === "ask",
      "the site's choice changing"
    );
    Assert.equal(
      mediaButton().getAttribute("sval-media"),
      "allowed",
      "the button shows the sound playing after the choice changed"
    );

    mediaButton().click();
    Assert.equal(
      mediaButton().getAttribute("sval-media"),
      "blocked",
      "its click stops media for the visit"
    );
    await within(
      SpecialPowers.spawn(browser, [], () =>
        ContentTaskUtils.waitForCondition(
          () => content.document.getElementById("sound").paused,
          "the sound pausing"
        )
      ),
      10_000,
      "the page's sound pausing"
    );
  });
  reset();
});
