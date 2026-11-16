/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The screen reads as a common resolution at or above the real one
 * (RFPTarget::ScreenSizeCommon), and the available screen and
 * CSS device size agree with it, in the page and in an iframe. Strict's
 * tighter buckets (RFPTarget::ScreenSizeTight) pick from a shorter list, and
 * Restore puts the common list back.
 */

const { restore, restoreDefaults, setStrict, snapshot } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalFingerprinting.sys.mjs"
  );

// Zoom scales the screen's size in CSS pixels. At this zoom any screen up to
// 5K at a scale of 1 reads smaller than the smallest size in both of
// SvalRFPService::GetSpoofedScreenSize's lists, so the size a page should
// read is that smallest size, whatever screen the test runs on.
const ZOOM = 4;
const SMALLEST_COMMON = [1280, 720];
const SMALLEST_TIGHT = [1366, 768];

/** Evaluated in the page's own global, so it must stand alone. */
async function screenProbe() {
  const read = win => ({
    width: win.screen.width,
    height: win.screen.height,
    availWidth: win.screen.availWidth,
    availHeight: win.screen.availHeight,
    innerWidth: win.innerWidth,
    innerHeight: win.innerHeight,
    deviceWidth: win.matchMedia(`(device-width: ${win.screen.width}px)`)
      .matches,
    deviceHeight: win.matchMedia(`(device-height: ${win.screen.height}px)`)
      .matches,
  });
  const frame = document.createElement("iframe");
  frame.src = location.href;
  await new Promise(resolve => {
    frame.onload = resolve;
    document.body.append(frame);
  });
  const result = { page: read(window), frame: read(frame.contentWindow) };
  frame.remove();
  return JSON.stringify(result);
}

async function readScreen(browser) {
  return within(
    SpecialPowers.spawn(browser, [screenProbe.toString()], async src => {
      return JSON.parse(await content.wrappedJSObject.eval(`(${src})()`));
    }),
    10_000,
    "the page's screen"
  );
}

async function withZoomedTab(win, fn) {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(win.gBrowser, PAGE2),
    10_000,
    "a new tab's load"
  );
  const browser = tab.linkedBrowser;
  const dpr = () =>
    SpecialPowers.spawn(browser, [], () => content.devicePixelRatio);
  const initial = await dpr();
  win.ZoomManager.setZoomForBrowser(browser, ZOOM);
  try {
    await BrowserTestUtils.waitForCondition(
      async () => Math.abs((await dpr()) - initial * ZOOM) < 0.01,
      "the zoom reaches the page"
    );
    // The screen in the page's CSS pixels, from the chrome's own reading,
    // which no fingerprinting protection touches.
    const scale = win.devicePixelRatio / (await dpr());
    const real = [
      Math.round(win.screen.width * scale),
      Math.round(win.screen.height * scale),
    ];
    return await fn(browser, real);
  } finally {
    win.ZoomManager.setZoomForBrowser(browser, 1);
    BrowserTestUtils.removeTab(tab);
  }
}

function checkCommon(fp, real, where, tight = false) {
  Assert.ok(
    real[0] <= SMALLEST_COMMON[0] && real[1] <= SMALLEST_COMMON[1],
    `${where}: the zoomed real screen ${real.join("x")} is below every listed size`
  );
  const [width, height] = tight ? SMALLEST_TIGHT : SMALLEST_COMMON;
  for (const [name, s] of Object.entries(fp)) {
    const at = `${where}, ${name}`;
    Assert.deepEqual(
      [s.width, s.height],
      [width, height],
      `${at}: the screen is the smallest listed size`
    );
    Assert.equal(s.availWidth, s.width, `${at}: available width is the width`);
    Assert.lessOrEqual(s.availHeight, s.height, `${at}: available height fits`);
    Assert.lessOrEqual(s.innerWidth, s.width, `${at}: the window fits across`);
    Assert.lessOrEqual(s.innerHeight, s.height, `${at}: the window fits down`);
    Assert.ok(s.deviceWidth, `${at}: device-width matches screen.width`);
    Assert.ok(s.deviceHeight, `${at}: device-height matches screen.height`);
  }
  const screenOf = ({ width: w, height: h, availWidth, availHeight }) => ({
    w,
    h,
    availWidth,
    availHeight,
  });
  Assert.deepEqual(
    screenOf(fp.frame),
    screenOf(fp.page),
    `${where}: an iframe reads the same`
  );
}

add_task(async function a_normal_window_reads_a_common_screen() {
  await withZoomedTab(window, async (browser, real) => {
    checkCommon(await readScreen(browser), real, "normal window");
  });
});

add_task(async function a_private_window_reads_the_same() {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20_000,
    "a new window opening"
  );
  try {
    await withZoomedTab(win, async (browser, real) => {
      checkCommon(await readScreen(browser), real, "private window");
    });
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the window closing"
    );
  }
});

add_task(async function a_site_can_be_lifted() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [
        "privacy.fingerprintingProtection.granularOverrides",
        JSON.stringify([
          { firstPartyDomain: "example.com", overrides: "-ScreenSizeCommon" },
        ]),
      ],
    ],
  });
  try {
    await withZoomedTab(window, async (browser, real) => {
      const { page } = await readScreen(browser);
      Assert.lessOrEqual(
        Math.abs(page.width - real[0]) + Math.abs(page.height - real[1]),
        2,
        `the lifted site reads the real screen (${page.width}x${page.height})`
      );
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function strict_tightens_the_buckets_and_restore_undoes_it() {
  const saved = snapshot();
  try {
    setStrict(true);
    await withZoomedTab(window, async (browser, real) => {
      checkCommon(await readScreen(browser), real, "Strict", true);
    });
    const win = await within(
      BrowserTestUtils.openNewBrowserWindow({ private: true }),
      20_000,
      "a new window opening"
    );
    try {
      await withZoomedTab(win, async (browser, real) => {
        checkCommon(await readScreen(browser), real, "Strict, private", true);
      });
    } finally {
      await within(
        BrowserTestUtils.closeWindow(win),
        10_000,
        "the window closing"
      );
    }

    restoreDefaults();
    await withZoomedTab(window, async (browser, real) => {
      checkCommon(await readScreen(browser), real, "after Restore");
    });
  } finally {
    restore(saved);
  }
});
