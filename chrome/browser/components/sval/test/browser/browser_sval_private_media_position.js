/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * The system's media controls get no duration or position for a private tab
 * (media-controls-private-no-position.patch), as they get no title or
 * address for one. A tab's media controller hands the controls each position
 * state it reports, as a `positionstatechange` event.
 */

/**
 * Plays five seconds of tone in `tab`'s page, then declares a position for
 * it as a player does and pauses it. The media controller takes only media longer
 * than `media.mediacontrol.eligible.media.duration.s`.
 *
 * @param {Element} tab A loaded tab.
 * @returns {Promise<number[]>} The duration of each position state the
 *   tab's media controller reported before it reported the pause. The page
 *   sends the pause after its position states, on the same channel.
 */
async function reportedDurations(tab) {
  const controller = tab.linkedBrowser.browsingContext.mediaController;
  const durations = [];
  const record = event => durations.push(event.duration);
  controller.addEventListener("positionstatechange", record);
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
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
    const video = content.document.createElement("video");
    video.src = content.URL.createObjectURL(blob);
    video.loop = true;
    content.document.body.append(video);
    await video.play();
  });
  await TestUtils.waitForCondition(
    () => controller.isPlaying,
    "the media controller has the playing media"
  );
  const paused = BrowserTestUtils.waitForEvent(
    controller,
    "playbackstatechange",
    false,
    () => !controller.isPlaying
  );
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.navigator.mediaSession.setPositionState({
      duration: 60,
      position: 5,
      playbackRate: 1,
    });
    content.document.querySelector("video").pause();
  });
  await within(paused, 15_000, "the media controller reporting the pause");
  controller.removeEventListener("positionstatechange", record);
  return durations;
}

add_setup(async function allow_sites_to_play() {
  // Settings, Sites: "Allow sites to play video and audio" Always allow.
  await SpecialPowers.pushPrefEnv({
    set: [["media.autoplay.site-permission-only.default", 1]],
  });
});

add_task(async function a_private_tab_reports_no_position() {
  const tab = await openPage(PAGE);
  Assert.ok(
    (await reportedDurations(tab)).includes(60),
    "a normal tab reports the position its page declares"
  );

  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    15_000,
    "a private window opening"
  );
  const privateTab = await openPage(PAGE, win);
  Assert.deepEqual(
    await reportedDurations(privateTab),
    [],
    "a private tab reports none, declared or guessed"
  );
});
