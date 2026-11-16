/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * What the files about a video going into Picture-in-Picture as the user
 * leaves its tab share: a video that qualifies, and leaving and coming back
 * to its tab. Each file loads this with `loadSubScript` into its own scope.
 */

/* exported allowMediaOn, startVideo, leaveOpensNothing, leaveOpensPlayer, returnClosesPlayer */

/**
 * Lets the site of `url` play video and audio until the task ends, through
 * the permission Settings › Sites and the protection button grant, which the
 * media gate reads.
 *
 * @param {string} url
 */
function allowMediaOn(url) {
  const principal =
    Services.scriptSecurityManager.createContentPrincipalFromOrigin(
      new URL(url).origin
    );
  Services.perms.addFromPrincipal(
    principal,
    "autoplay-media",
    Services.perms.ALLOW_ACTION
  );
  atTaskEnd(() =>
    Services.perms.removeFromPrincipal(principal, "autoplay-media")
  );
}

/**
 * In the page, through `asPage`: starts a video Picture-in-Picture takes on
 * its own (`PictureInPictureChild.videoIsPiPEligible`), one with a sound
 * track, at least 140 pixels each way and at least 45 seconds long, which a
 * live stream is. The page draws it and its sound is a silent tone, so it
 * plays for as long as the test needs, loads nothing and is never heard.
 *
 * @returns {Promise<string>} `"playing"`, or the name of play()'s error.
 */
async function eligibleVideo() {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  const context = canvas.getContext("2d");
  let frame = 0;
  setInterval(() => {
    context.fillStyle = frame++ % 2 ? "black" : "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
  }, 20);
  const audio = new AudioContext();
  const tone = audio.createOscillator();
  const silence = audio.createGain();
  silence.gain.value = 0;
  const sound = audio.createMediaStreamDestination();
  tone.connect(silence).connect(sound);
  tone.start();
  const stream = canvas.captureStream();
  stream.addTrack(sound.stream.getAudioTracks()[0]);
  const video = document.createElement("video");
  video.id = "sval-pip-video";
  video.width = canvas.width;
  video.height = canvas.height;
  video.srcObject = stream;
  document.body.prepend(video);
  return new Promise(resolve => {
    video.addEventListener("playing", () => resolve("playing"), {
      once: true,
    });
    video.play().catch(e => resolve(e.name));
  });
}

/**
 * Starts the video in `browser`'s page, and waits until Picture-in-Picture
 * listens for the page going hidden. `PictureInPictureToggleChild` starts
 * listening once a video has been in view, from an idle callback
 * (`onIntersection`), so a switch before then would go unseen.
 *
 * @param {object} browser
 * @returns {Promise<string>} `eligibleVideo`'s answer.
 */
async function startVideo(browser) {
  const played = await asPage(browser, eligibleVideo);
  await within(
    SpecialPowers.spawn(browser, [], () =>
      ContentTaskUtils.waitForCondition(
        () =>
          content.windowGlobalChild.getActor("PictureInPictureToggle").docState
            ?.isTrackingVideos,
        "Picture-in-Picture watching the page's visibility"
      )
    ),
    10_000,
    "Picture-in-Picture watching the video"
  );
  return played;
}

/**
 * Resolves once whatever leaving `browser`'s tab set off has reached the
 * parent. The page sends `PictureInPicture:VideoTabHidden` as it goes
 * hidden; the parent answers with `PictureInPicture:AutoToggle`, and the page
 * then asks for the window (`PictureInPicture:Request`). Every actor's
 * messages for a page share the page's one channel, in order, so a round
 * trip started after one message is answered only after that message has
 * arrived. One round trip after the page went hidden follows the first
 * message, and a second follows the request.
 *
 * @param {object} browser
 * @param {Promise} hidden Settles once the page went hidden, bounded.
 */
async function leavingSettled(browser, hidden) {
  await hidden;
  for (const message of ["VideoTabHidden", "Request"]) {
    await within(
      SpecialPowers.spawn(browser, [], () => {}),
      10_000,
      `a round trip after ${message}`
    );
  }
}

/**
 * Runs `leave`, which takes the user away from `browser`'s tab, and asserts
 * no Picture-in-Picture window opens.
 *
 * @param {object} browser The video's.
 * @param {Function} leave
 * @param {string} why
 */
async function leaveOpensNothing(browser, leave, why) {
  // Bounded from before `leave`, which the wait covers.
  const hidden = within(
    BrowserTestUtils.waitForContentEvent(browser, "visibilitychange"),
    20_000,
    "the page going hidden"
  );
  await leave();
  await leavingSettled(browser, hidden);
  Assert.deepEqual(
    [...Services.wm.getEnumerator("Toolkit:PictureInPicture")],
    [],
    why
  );
}

/**
 * Runs `leave`, which takes the user away from the video's tab, and resolves
 * with the Picture-in-Picture window that opens, once the video plays in it.
 *
 * @param {object} browser The video's.
 * @param {Function} leave
 * @returns {Promise<Window>}
 */
async function leaveOpensPlayer(browser, leave) {
  const opened = BrowserTestUtils.domWindowOpenedAndLoaded(null);
  await leave();
  const player = await within(
    opened,
    10_000,
    "a Picture-in-Picture window opening"
  );
  atTaskEnd(async () => {
    if (!player.closed) {
      await within(
        BrowserTestUtils.closeWindow(player),
        10_000,
        "the Picture-in-Picture window closing"
      );
    }
  });
  Assert.equal(
    player.document.documentElement.getAttribute("windowtype"),
    "Toolkit:PictureInPicture",
    "the window is a video's player"
  );
  Assert.ok(
    await within(
      SpecialPowers.spawn(browser, [], async () => {
        const video = content.document.getElementById("sval-pip-video");
        await ContentTaskUtils.waitForCondition(
          () => video.isCloningElementVisually,
          "the video showing in the window"
        );
        return !video.paused;
      }),
      10_000,
      "the video showing in the window"
    ),
    "the video plays on in the window"
  );
  return player;
}

/**
 * Runs `back`, which brings the user back to the video's tab, and asserts
 * its Picture-in-Picture window closes.
 *
 * @param {Window} player
 * @param {Function} back
 */
async function returnClosesPlayer(player, back) {
  const closed = BrowserTestUtils.domWindowClosed(player);
  await back();
  await within(
    closed,
    10_000,
    "the Picture-in-Picture window closing as the tab comes back"
  );
}
