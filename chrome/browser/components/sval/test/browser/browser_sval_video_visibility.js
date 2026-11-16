/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * Whether a playing video counts as seen, as media reads it: its visible and
 * invisible play time (`TelemetryProbesReporter`) and whether its decoding is
 * suspended (`media.suspend-background-video.*`). A video the user can see
 * plays as seen. One in a background tab is not seen, and its decoding
 * stops. One in the tab an agent works in is seen even while the agent's
 * window is minimised (agent-control spec §4.1). A video in a workspace no
 * window shows does not play at all, since switching unloads its tab
 * (spec §10.7, `browser_sval_switcher_tabs.js`).
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

const VIDEO_PAGE = ROOT + "sval_agent_page.html";
// Served from Mozilla's picture-in-picture tests (`!/` in browser.toml).
const VIDEO =
  "https://example.com/browser/toolkit/components/pictureinpicture/tests/test-video-long.mp4";

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
  await SpecialPowers.pushPrefEnv({
    set: [
      // Settings › Sites: "Allow sites to play video and audio" Always
      // allow. This file is about a video that plays.
      ["media.autoplay.site-permission-only.default", 1],
      // Firefox's default, which the harness's profile turns off
      // (`testing/profiles/unittest-required/user.js`).
      ["media.suspend-background-video.enabled", true],
      // A background video's decoding stops at once rather than after
      // Firefox's ten seconds, so the test waits for the stop itself.
      ["media.suspend-background-video.delay-ms", 0],
    ],
  });
});

/**
 * Starts a muted, looping video at the top of `browser`'s page.
 *
 * @param {object} browser
 */
async function playVideo(browser) {
  await within(
    SpecialPowers.spawn(browser, [VIDEO], async src => {
      const video = content.document.createElement("video");
      video.id = "video";
      video.src = src;
      video.muted = true;
      video.loop = true;
      content.document.body.prepend(video);
      await video.play();
    }),
    10_000,
    "the video playing"
  );
}

/**
 * @param {object} browser
 * @returns {Promise<object>} The video's play time, in seconds, seen and
 *   unseen, and whether its decoding is suspended.
 */
function playTimes(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const video = content.document.getElementById("video");
    return {
      visible: video.visiblePlayTime,
      invisible: video.invisiblePlayTime,
      suspended: video.isVideoDecodingSuspended,
      paused: video.paused,
    };
  });
}

/**
 * Waits until `browser`'s video has played `seconds` more of the kind
 * `kind` names, and gives its play times then.
 *
 * @param {object} browser
 * @param {"visible"|"invisible"} kind
 * @param {number} seconds
 * @param {string} what
 * @returns {Promise<object>}
 */
async function untilPlayed(browser, kind, seconds, what) {
  const from = (await playTimes(browser))[kind];
  let times;
  try {
    await TestUtils.waitForCondition(async () => {
      times = await playTimes(browser);
      return times[kind] >= from + seconds;
    }, what);
  } catch (err) {
    info(`${what}: the video read ${JSON.stringify(times)}`);
    throw err;
  }
  return times;
}

/**
 * Asserts a play time held still. The element sums its paused spans in
 * floating point, so a time read twice can differ in its last digits; 1 ms is
 * the fuzz Mozilla's own test allows (`timeFuzzyEquals` in
 * `test_accumulated_play_time.html`).
 *
 * @param {number} now
 * @param {number} before
 * @param {string} what
 */
function timeUnchanged(now, before, what) {
  Assert.less(Math.abs(now - before), 1e-3, `${what} (${now} vs ${before})`);
}

/**
 * Waits until `browser`'s video's decoding is suspended, or resumed.
 *
 * @param {object} browser
 * @param {boolean} suspended
 * @param {string} what
 */
async function untilSuspended(browser, suspended, what) {
  let times;
  try {
    await TestUtils.waitForCondition(async () => {
      times = await playTimes(browser);
      return times.suspended === suspended;
    }, what);
  } catch (err) {
    info(`${what}: the video read ${JSON.stringify(times)}`);
    throw err;
  }
}

add_task(async function a_video_in_the_selected_tab_plays_seen() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, VIDEO_PAGE),
    10_000,
    "the video's page opening"
  );
  await playVideo(tab.linkedBrowser);
  const times = await untilPlayed(
    tab.linkedBrowser,
    "visible",
    0.5,
    "the video playing seen"
  );
  Assert.equal(times.invisible, 0, "none of it unseen");
  Assert.ok(!times.suspended, "its decoding goes on");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function a_video_in_a_background_tab_plays_unseen() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, VIDEO_PAGE),
    10_000,
    "the video's page opening"
  );
  const browser = tab.linkedBrowser;
  await playVideo(browser);
  await untilPlayed(browser, "visible", 0.2, "the video playing seen");

  const other = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank"),
    10_000,
    "another tab opening in front"
  );
  await untilSuspended(
    browser,
    true,
    "its decoding stopping in the background"
  );
  const unseen = await untilPlayed(
    browser,
    "invisible",
    0.3,
    "the video playing unseen"
  );
  const later = await untilPlayed(
    browser,
    "invisible",
    0.3,
    "and playing on unseen"
  );
  timeUnchanged(later.visible, unseen.visible, "none of it seen meanwhile");
  Assert.ok(!later.paused, "the video still plays");

  await selectTab(tab);
  await untilSuspended(browser, false, "its decoding resuming in front");
  const front = await playTimes(browser);
  const back = await untilPlayed(browser, "visible", 0.3, "playing seen again");
  timeUnchanged(back.invisible, front.invisible, "and no longer unseen");
  BrowserTestUtils.removeTab(other);
  BrowserTestUtils.removeTab(tab);
});

/**
 * An agent's window opens behind the user's, and the page the agent works in
 * stays visible there, minimised or not. The tab the agent leaves goes to
 * the background as in any window.
 */
add_task(async function a_video_in_an_agents_tab_plays_seen() {
  const { call, tabs, agent, win } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: VIDEO_PAGE });
  const { browser } = await tabs.tabIn(agent, tab);
  // `open_tab` answers once the page loads, which can be before tabbrowser
  // has finished showing it; until then the page is hidden.
  await switchDone(win);
  Assert.equal(win.gBrowser.selectedBrowser, browser, "the agent's tab shows");
  await playVideo(browser);
  // Media counts a video seen once layout finds its frame on screen, which a
  // window opened behind does at a later paint, so the first moments may
  // count unseen. From then on none does.
  const shown = await untilPlayed(
    browser,
    "visible",
    0.1,
    "the video playing seen in the agent's window"
  );
  const behind = await untilPlayed(
    browser,
    "visible",
    0.3,
    "and playing on seen"
  );
  timeUnchanged(behind.invisible, shown.invisible, "none of it unseen");

  const minimized = BrowserTestUtils.waitForEvent(win, "sizemodechange");
  win.minimize();
  atTaskEnd(() => win.restore());
  await within(minimized, 10_000, "the agent's window minimising");
  Assert.equal(win.windowState, win.STATE_MINIMIZED, "the window is minimised");
  const minimised = await untilPlayed(
    browser,
    "visible",
    0.3,
    "the video playing seen in the minimised window"
  );
  timeUnchanged(
    minimised.invisible,
    shown.invisible,
    "still none of it unseen"
  );
  Assert.ok(!minimised.suspended, "its decoding goes on");

  await call("open_tab", { url: VIDEO_PAGE });
  await untilSuspended(
    browser,
    true,
    "its decoding stopping once the agent moves to another tab"
  );
  await untilPlayed(browser, "invisible", 0.3, "the video playing unseen");
});
