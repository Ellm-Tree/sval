/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The site controls' live fill (decision 1985): what happens on the page now
 * draws one chip, the same size, colours and ink on every control. A camera
 * in use, location in use, media playing and a translated page each take it.
 */

const { SvalSiteProtections } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
);

const FILL_PAGE = "https://example.com/";
const FILL_SITE = "example.com";

function byId(id) {
  return document.getElementById(id);
}

/**
 * Plays a looping media element with sound in the page, as the media
 * button's own test does, and waits for the tab to be heard. The media
 * controller takes only media longer than
 * `media.mediacontrol.eligible.media.duration.s`, so the tone lasts five
 * seconds.
 *
 * @param {Element} browser
 */
async function playMedia(browser) {
  await SpecialPowers.spawn(browser, [], async () => {
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
    video.id = "tone";
    video.src = content.URL.createObjectURL(blob);
    video.loop = true;
    content.document.body.append(video);
    await video.play();
  });
}

/**
 * Waits for `els` to finish easing between colours.
 *
 * @param {Element[]} els
 */
function settled(els) {
  return within(
    TestUtils.waitForCondition(
      () => !els.some(el => el.getAnimations().length),
      "the colours settle"
    ),
    10_000,
    "the colours settling"
  );
}

/**
 * @param {Element} chip
 * @returns {object} What a person sees of a live chip.
 */
function fillOf(chip) {
  const style = getComputedStyle(chip);
  const rect = chip.getBoundingClientRect();
  return {
    height: rect.height,
    background: style.backgroundColor,
    radius: style.borderTopLeftRadius,
  };
}

/**
 * @param {Element} element
 * @param {string} what
 */
async function waitFor(element, what) {
  await within(
    TestUtils.waitForCondition(() => element?.checkVisibility(), what),
    10_000,
    what
  );
}

add_task(async function every_live_control_draws_the_same_fill() {
  // The page plays only where its site allows media.
  SvalSiteProtections.setMedia(FILL_SITE, "allow");
  registerCleanupFunction(() => SvalSiteProtections.setMedia(FILL_SITE, ""));
  await BrowserTestUtils.withNewTab(FILL_PAGE, async browser => {
    gBrowser.updateBrowserSharing(browser, {
      webRTC: { sharing: "camera", camera: 1 },
      geo: true,
    });
    const cells = byId("sval-live-devices").querySelector(".sval-live-cells");
    const location = byId("sval-location-button");
    await waitFor(cells, "the camera's live cell");
    await waitFor(location, "the location button");
    Assert.equal(location.dataset.state, "live");

    const media = byId("sval-media-button");
    await playMedia(browser);

    // As `FullPageTranslationsPanel` marks the cell of a translated page.
    const translate = byId("translations-button");
    translate.hidden = false;
    translate.setAttribute("translationsactive", "true");
    try {
      await settled([
        cells,
        location.querySelector(".sval-live-ask"),
        translate.querySelector(".sval-translate-chip"),
      ]);
      const camera = fillOf(cells);
      Assert.equal(camera.height, 26, "the fill is a 26px chip");
      const chips = {
        location: location.querySelector(".sval-live-ask"),
        translate: translate.querySelector(".sval-translate-chip"),
      };
      for (const [name, chip] of Object.entries(chips)) {
        Assert.deepEqual(
          fillOf(chip),
          camera,
          `${name} draws the camera's fill`
        );
      }
      const ink = getComputedStyle(
        cells.querySelector(".sval-header-glyph")
      ).fill;
      Assert.equal(
        getComputedStyle(location.querySelector(".sval-header-glyph")).fill,
        ink,
        "location's glyph takes the live ink"
      );
      Assert.equal(
        getComputedStyle(byId("translations-button-icon")).fill,
        ink,
        "translate's glyph takes the live ink"
      );
      // Gecko lets a capturing page play whatever the site's choice, and
      // the media button is unusable then; the camera's cell is the fill.
      Assert.ok(
        !media.hasAttribute("sval-playing"),
        "media takes no fill while the page captures"
      );

      gBrowser.updateBrowserSharing(browser, { webRTC: {} });
      await within(
        TestUtils.waitForCondition(
          () => media.hasAttribute("sval-playing"),
          "the media button playing"
        ),
        10_000,
        "the media button playing once the capture ends"
      );
      const icon = media.querySelector(".toolbarbutton-icon");
      await settled([icon]);
      Assert.deepEqual(fillOf(icon), camera, "media draws the camera's fill");
      Assert.equal(getComputedStyle(icon).fill, ink, "in the live ink");
    } finally {
      translate.removeAttribute("translationsactive");
      translate.hidden = true;
    }

    await SpecialPowers.spawn(browser, [], () =>
      content.document.getElementById("tone").pause()
    );
    await within(
      TestUtils.waitForCondition(
        () => !media.hasAttribute("sval-playing"),
        "the media button paused"
      ),
      10_000,
      "the fill goes when the media pauses"
    );
  });
});
