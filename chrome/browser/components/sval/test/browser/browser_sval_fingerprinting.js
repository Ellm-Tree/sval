/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Sval's fingerprinting defaults (protections spec §3.2): what a page reads,
 * the same in a normal and a private window, and the same in a worker as in
 * the page.
 */

/**
 * Reads every value the defaults decide, inside the page and a worker. Runs
 * as the page itself: Gecko skips several protections for a privileged
 * caller (`CallerType::System`), which a SpecialPowers sandbox is.
 *
 * @param {Browser} browser The tab's browser.
 * @returns {Promise<object>} What the page read.
 */
async function readFingerprint(browser) {
  return within(
    SpecialPowers.spawn(browser, [pageProbe.toString()], async src => {
      const json = await content.wrappedJSObject.eval(`(${src})()`);
      return JSON.parse(json);
    }),
    10_000,
    "the page's fingerprint"
  );
}

/** Evaluated in the page's own global, so it must stand alone. */
async function pageProbe() {
  const media = q => window.matchMedia(q).matches;

  // Two colours, so the image is not uniform: Gecko leaves uniform images
  // unnoised.
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgb(200, 40, 40)";
  ctx.fillRect(0, 0, 32, 64);
  ctx.fillStyle = "rgb(40, 40, 200)";
  ctx.fillRect(32, 0, 32, 64);
  const pixels = ctx.getImageData(0, 0, 64, 64).data;
  let noisedChannels = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const want = (i / 4) % 64 < 32 ? [200, 40, 40] : [40, 40, 200];
    for (let c = 0; c < 3; c++) {
      if (pixels[i + c] != want[c]) {
        noisedChannels++;
      }
    }
  }

  const worker = new Worker(
    URL.createObjectURL(
      new Blob(["postMessage(navigator.hardwareConcurrency)"])
    )
  );
  const workerCores = await new Promise(resolve => {
    worker.onmessage = e => resolve(e.data);
  });
  worker.terminate();

  return JSON.stringify({
    cores: navigator.hardwareConcurrency,
    workerCores,
    gpc: navigator.globalPrivacyControl,
    pdfViewer: navigator.pdfViewerEnabled,
    colorDepth: screen.colorDepth,
    pixelDepth: screen.pixelDepth,
    // The color feature's bits per colour component.
    colorBits: [8, 10].find(bits => media(`(color: ${bits})`)),
    monochrome: media("(monochrome)"),
    screenX: window.screenX,
    screenY: window.screenY,
    innerScreenX: window.mozInnerScreenX,
    wideGamut: media("(color-gamut: p3)"),
    highRange: media("(dynamic-range: high)"),
    reducedTransparency: media("(prefers-reduced-transparency: reduce)"),
    inverted: media("(inverted-colors: inverted)"),
    noisedChannels,
  });
}

/**
 * What most screens of the platform report
 * (`SvalRFPService::kSpoofedScreenPixelDepth`).
 */
const DEPTH = AppConstants.platform == "macosx" ? 30 : 24;

function checkDefaults(fp, where) {
  // Chrome reads the real count: RFP never applies to it.
  const real = window.navigator.hardwareConcurrency;
  Assert.ok(
    fp.cores >= Math.min(real, Math.max(2, Math.ceil(real / 2))) &&
      fp.cores <= real,
    `${where}: core count is a per-site draw of half to all ${real} (got ${fp.cores})`
  );
  Assert.equal(fp.workerCores, fp.cores, `${where}: a worker sees the same`);
  Assert.ok(fp.gpc, `${where}: Global Privacy Control is on`);
  Assert.ok(fp.pdfViewer, `${where}: the PDF viewer reads as enabled`);
  Assert.equal(
    fp.colorDepth,
    DEPTH,
    `${where}: colour depth is the platform's`
  );
  Assert.equal(fp.pixelDepth, DEPTH, `${where}: pixel depth is the platform's`);
  Assert.equal(
    fp.colorBits,
    DEPTH / 3,
    `${where}: the color media feature agrees with the colour depth`
  );
  Assert.ok(!fp.monochrome, `${where}: the screen is not monochrome`);
  Assert.equal(fp.screenX, 0, `${where}: window x is 0`);
  Assert.equal(fp.screenY, 0, `${where}: window y is 0`);
  Assert.equal(fp.innerScreenX, 0, `${where}: inner screen x is 0`);
  Assert.ok(!fp.wideGamut, `${where}: colour gamut reads as sRGB`);
  Assert.ok(!fp.highRange, `${where}: dynamic range reads as standard`);
  Assert.ok(
    !fp.reducedTransparency,
    `${where}: reduced transparency reads as no preference`
  );
  Assert.ok(!fp.inverted, `${where}: inverted colours read as none`);
  Assert.greater(
    fp.noisedChannels,
    0,
    `${where}: canvas readback carries pixel noise`
  );
}

const { Targets } = ChromeUtils.importESModule(
  "resource://gre/modules/RFPTargetConstants.sys.mjs"
);

/**
 * The protections Sval turns on, each decided in the catalogue
 * (`docs/fingerprinting-catalogue.md`). This list and `OFF` are the one
 * statement of the decided set kept by hand, checked against what Gecko has
 * enabled; the settings tests read the switches from `SvalFingerprinting`.
 */
const ON = [
  "CanvasRandomization",
  "FontVisibilityLangPack",
  "JSMathFdlibm",
  "ScreenAvailToResolution",
  "NavigatorHWConcurrencyTiered",
  "MaxTouchPointsCollapse",
  "WebGLVendorSanitize",
  "WebGPUIsFallbackAdapter",
  "VideoElementMozFrames",
  "VideoElementMozFrameDelay",
  "VideoElementPlaybackQuality",
  "MediaError",
  "WebVTT",
  "PdfjsSpoof",
  "ScreenPixelDepth",
  "WindowScreenXY",
  "WindowInnerScreenXY",
  "MouseEventScreenPoint",
  "CSSColorInfo",
  "CSSVideoDynamicRange",
  "CSSPrefersReducedTransparency",
  "CSSInvertedColors",
  "TouchEvents",
  "ScreenSizeCommon",
  "WindowOuterSizeTypical",
  "LanguagesPrimaryOnly",
  "MediaDevicesBeforePermission",
  "GamepadIdGeneric",
  "PermissionsDefaultDenyPrompt",
  "SpeechVoicesDefault",
  "WebGPUTimestampQueryHidden",
  "AudioOutputRandomization",
  "NavigatorHWConcurrencyRandomized",
];

/** Protections the catalogue keeps off, because they cost breakage. */
const OFF = [
  "EfficientCanvasRandomization",
  "NetworkConnection",
  "DiskStorageLimit",
  "CSSPointerCapabilities",
  "PointerEvents",
  "CSSPrefersColorScheme",
  "CSSPrefersReducedMotion",
  "CSSPrefersContrast",
  "JSDateTimeUTC",
  "KeyboardEvents",
  "WindowDevicePixelRatio",
  "ReduceTimerPrecision",
  "ScreenSizeTight",
  "EmojiFontBundled",
];

add_task(function the_enabled_set_is_the_decided_one() {
  const set = Services.rfp.enabledFingerprintingProtections;
  const enabled = name => {
    const bit = Targets[name];
    return !!((set.getNth32BitSet(Math.floor(bit / 32)) >>> (bit % 32)) & 1);
  };
  for (const name of ON) {
    Assert.ok(enabled(name), `${name} is on`);
  }
  for (const name of OFF) {
    Assert.ok(!enabled(name), `${name} is off`);
  }
});

add_task(async function a_normal_window_reads_svals_defaults() {
  // With the viewer off, only PdfjsSpoof makes the page read it as on.
  await SpecialPowers.pushPrefEnv({ set: [["pdfjs.disabled", true]] });
  await BrowserTestUtils.withNewTab(PAGE2, async browser => {
    checkDefaults(await readFingerprint(browser), "normal window");
  });
});

add_task(async function a_private_window_reads_the_same() {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20_000,
    "a new window opening"
  );
  try {
    const tab = await within(
      BrowserTestUtils.openNewForegroundTab(win.gBrowser, PAGE2),
      10_000,
      "a new tab's load"
    );
    checkDefaults(await readFingerprint(tab.linkedBrowser), "private window");
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the window closing"
    );
  }
});

add_task(function defaults_keep_firefox_settings_untouched() {
  // The accent colour is a Sval default protections spec §3 decides; DNT
  // stays at Firefox's default.
  Assert.ok(
    !Services.prefs.getBoolPref("widget.non-native-theme.use-theme-accent"),
    "the OS accent colour is not exposed to pages"
  );
  Assert.ok(
    !Services.prefs.getBoolPref("privacy.donottrackheader.enabled"),
    "Do Not Track stays off"
  );
  Assert.ok(
    Services.prefs.getBoolPref(
      "media.peerconnection.ice.proxy_only_if_behind_proxy"
    ),
    "WebRTC never bypasses a configured proxy"
  );
  Assert.ok(
    Services.prefs.getBoolPref(
      "privacy.partition.network_state.connection_with_proxy"
    ),
    "proxied connections are partitioned"
  );
});
