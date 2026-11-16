/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Turning letterboxing on leaves a browser that has no tab alone.
 *
 * RFPHelper watches every `.browserStack` in the window, and the preloaded
 * about:newtab browser sits in one with no tab until a new tab adopts it.
 * Before its first load commits its URI is about:blank, which letterboxing
 * would round, and rounding needs the browser's tab browser. The harness
 * fails the file on the rejection if letterboxing reaches it.
 */

add_task(async function letterboxing_skips_a_preloaded_browser() {
  const hadPreload = !!gBrowser.preloadedBrowser;
  NewTabPagePreloading.removePreloadedBrowser(window);
  // A preload as it is before its about:newtab commits. `_createBrowser` is
  // the half of `maybeCreatePreloadedBrowser` before the load, which would
  // race the resize observer and commit in time on a quiet machine.
  const preload = NewTabPagePreloading._createBrowser(window);
  registerCleanupFunction(() => {
    if (gBrowser.preloadedBrowser === preload) {
      gBrowser.preloadedBrowser = null;
    }
    gBrowser.getPanel(preload).remove();
    if (hadPreload) {
      NewTabPagePreloading.maybeCreatePreloadedBrowser(window);
    }
  });
  Assert.equal(preload.getTabBrowser(), null, "the preload has no tab");
  Assert.equal(preload.currentURI.spec, "about:blank", "and has not loaded");

  // RFPHelper makes its resize observer when the pref turns letterboxing on,
  // so it is called before this one in the same notification.
  const LETTERBOXING = "privacy.resistFingerprinting.letterboxing";
  Services.prefs.setBoolPref(LETTERBOXING, true);
  registerCleanupFunction(() => Services.prefs.clearUserPref(LETTERBOXING));
  const stack = preload.parentElement;
  await within(
    new Promise(resolve => {
      const observer = new ResizeObserver(() => {
        observer.disconnect();
        resolve();
      });
      observer.observe(stack);
    }),
    10_000,
    "the preload's stack reaching resize observers"
  );
  Assert.equal(
    preload.getTabBrowser(),
    null,
    "the preload still had no tab when letterboxing saw it"
  );
  Services.prefs.clearUserPref(LETTERBOXING);
});
