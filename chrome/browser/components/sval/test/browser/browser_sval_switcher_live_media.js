/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * Switching workspaces ends neither a call nor a video playing in
 * picture-in-picture (spec §10.7). Their tab stays loaded while its workspace
 * is hidden, as Firefox keeps such a tab when it unloads tabs to save memory.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);

add_setup(async function media_plays_without_asking() {
  // Opening picture-in-picture records that its toggle was used
  // (`PictureInPictureChild.sys.mjs`). Undone when the file ends.
  await SpecialPowers.pushPrefEnv({
    clear: [["media.videocontrols.picture-in-picture.video-toggle.has-used"]],
  });
  await SpecialPowers.pushPrefEnv({
    set: [
      // Settings › Sites: "Allow sites to play video and audio" Always
      // allow. This file is about what a switch does to media that plays.
      ["media.autoplay.site-permission-only.default", 1],
      ["media.navigator.streams.fake", true],
      ["media.navigator.permission.fake", true],
    ],
  });
});

add_task(async function a_call_goes_on_across_a_switch() {
  const { ids, observer } = await withSwitcherTabs();
  const [first, second] = ids.workspaces;

  const tab = observer.tabFor(ids.tabs[0]);
  await untilRestored(tab);
  // A call needs a secure page: `getUserMedia` refuses a `data:` one.
  const page = ROOT + "sval_call_page.html";
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, page);
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, page);
  await within(loaded, 10_000, "the call's page loading");
  // The user has let the site use the camera and microphone before, so the
  // call starts without asking, through the same grant a prompt makes.
  const principal = tab.linkedBrowser.contentPrincipal;
  for (const kind of ["camera", "microphone"]) {
    SitePermissions.setForPrincipal(principal, kind, SitePermissions.ALLOW);
  }
  registerCleanupFunction(() => {
    for (const kind of ["camera", "microphone"]) {
      SitePermissions.removeFromPrincipal(principal, kind);
    }
  });
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const stream = await content.navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true,
    });
    content.wrappedJSObject.call = stream;
  });
  const live = () =>
    SpecialPowers.spawn(tab.linkedBrowser, [], () =>
      content.wrappedJSObject.call
        .getTracks()
        .map(track => `${track.kind}: ${track.readyState}`)
    );
  Assert.deepEqual(
    await live(),
    ["audio: live", "video: live"],
    "the call is on"
  );
  await TestUtils.waitForCondition(
    () => tab.getAttribute("sharing") === "camera",
    "the tab shows the camera in use"
  );

  Assert.ok(
    await SvalWindowWorkspace.of(window).switchTo(second),
    "the window switched away"
  );
  Assert.ok(
    gBrowser.tabs.includes(tab) && tab.linkedPanel,
    "the call's page is still loaded"
  );
  Assert.deepEqual(
    await live(),
    ["audio: live", "video: live"],
    "and the call goes on"
  );

  Assert.ok(
    await SvalWindowWorkspace.of(window).switchTo(first),
    "and switched back"
  );
  Assert.equal(gBrowser.selectedTab, tab, "the user is back in the call");
  Assert.deepEqual(
    await live(),
    ["audio: live", "video: live"],
    "which never stopped"
  );

  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    for (const track of content.wrappedJSObject.call.getTracks()) {
      track.stop();
    }
  });
});

add_task(async function a_picture_in_picture_video_plays_on_across_a_switch() {
  const { ids, observer } = await withSwitcherTabs({
    body: `<video id="video" muted></video>`,
  });
  const [first, second] = ids.workspaces;

  const tab = observer.tabFor(ids.tabs[0]);
  await untilRestored(tab);
  // A video the page draws itself, frame by frame, so it plays for as long
  // as the test needs and loads nothing.
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const doc = content.document;
    const canvas = doc.createElement("canvas");
    const context = canvas.getContext("2d");
    let frame = 0;
    content.setInterval(() => {
      context.fillStyle = frame++ % 2 ? "black" : "white";
      context.fillRect(0, 0, canvas.width, canvas.height);
    }, 20);
    const video = doc.getElementById("video");
    video.srcObject = canvas.captureStream();
    await video.play();
  });

  const opened = BrowserTestUtils.domWindowOpenedAndLoaded(null);
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const video = content.document.getElementById("video");
    content.windowUtils.dispatchEventToChromeOnly(
      video,
      new content.CustomEvent("MozTogglePictureInPicture", { bubbles: true })
    );
    await ContentTaskUtils.waitForCondition(
      () => video.isCloningElementVisually,
      "the video is shown in picture-in-picture"
    );
  });
  const player = await within(opened, 10_000, "the picture-in-picture window");
  registerCleanupFunction(async () => {
    if (!player.closed) {
      await within(
        BrowserTestUtils.closeWindow(player),
        10_000,
        "the picture-in-picture window closing"
      );
    }
  });
  await within(SimpleTest.promiseFocus(window), 10_000, "focus coming back");

  const playing = () =>
    SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
      const video = content.document.getElementById("video");
      const from = video.currentTime;
      await ContentTaskUtils.waitForCondition(
        () => video.currentTime > from,
        "the video moves on"
      );
      return !video.paused && video.isCloningElementVisually;
    });
  Assert.ok(await playing(), "the video plays in picture-in-picture");

  Assert.ok(
    await SvalWindowWorkspace.of(window).switchTo(second),
    "the window switched away"
  );
  Assert.ok(
    gBrowser.tabs.includes(tab) && tab.linkedPanel,
    "the video's page is still loaded"
  );
  Assert.ok(!gBrowser.visibleTabs.includes(tab), "out of reach");
  Assert.ok(!player.closed, "the picture-in-picture window is still open");
  Assert.ok(await playing(), "and the video plays on in it");

  Assert.ok(
    await SvalWindowWorkspace.of(window).switchTo(first),
    "and switched back"
  );
  Assert.equal(gBrowser.selectedTab, tab, "the user is back on its page");
  Assert.ok(await playing(), "with the video still playing");
});
