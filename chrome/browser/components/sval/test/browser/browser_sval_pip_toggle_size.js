/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A video back from Picture-in-Picture keeps the toggle its size calls for:
 * a call tile, a controls-less <video>, is not taken for a small video.
 */

const VIDEO_PAGE = ROOT + "sval_pip_video_page.html";

/**
 * @param {Element} browser
 * @returns {Promise<object>} The toggle's size attributes, once shown.
 */
function toggleSize(browser) {
  return SpecialPowers.spawn(browser, [], async () => {
    const video = content.document.getElementById("call");
    let toggle;
    await ContentTaskUtils.waitForCondition(() => {
      toggle = video.openOrClosedShadowRoot?.getElementById(
        "pictureInPictureToggle"
      );
      return toggle && !toggle.hidden;
    }, "the toggle shown");
    return {
      small: toggle.hasAttribute("small-video"),
      medium: toggle.hasAttribute("medium-video"),
    };
  });
}

add_task(async function a_call_tile_keeps_its_toggle_size() {
  const tab = await openPage(VIDEO_PAGE);
  const browser = tab.linkedBrowser;
  try {
    Assert.deepEqual(
      await toggleSize(browser),
      { small: false, medium: true },
      "a 640px video's toggle"
    );

    const opened = BrowserTestUtils.domWindowOpenedAndLoaded(null);
    await SpecialPowers.spawn(browser, [], () => {
      const video = content.document.getElementById("call");
      content.windowUtils.dispatchEventToChromeOnly(
        video,
        new content.CustomEvent("MozTogglePictureInPicture", { bubbles: true })
      );
    });
    const pip = await within(opened, 10_000, "the Picture-in-Picture window");
    await within(
      BrowserTestUtils.closeWindow(pip),
      10_000,
      "the Picture-in-Picture window closing"
    );
    await SpecialPowers.spawn(browser, [], async () => {
      const video = content.document.getElementById("call");
      await ContentTaskUtils.waitForCondition(
        () => !video.isCloningElementVisually,
        "the video back in the page"
      );
    });

    Assert.deepEqual(
      await toggleSize(browser),
      { small: false, medium: true },
      "the same toggle once the video is back"
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});
