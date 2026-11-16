/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The outer window reads as the inner size plus a typical toolbar
 * (RFPTarget::WindowOuterSizeTypical), in the page and in an iframe,
 * whatever the real toolbars are.
 */

/** SvalRFPService::GetSpoofedOuterSize's chrome, for this platform. */
const CHROME =
  AppConstants.platform == "win"
    ? { width: 16, height: 93 }
    : { width: 0, height: 85 };

/** Evaluated in the page's own global, so it must stand alone. */
async function outerProbe() {
  const read = (win, top) => ({
    width: win.outerWidth - top.innerWidth,
    height: win.outerHeight - top.innerHeight,
  });
  const frame = document.createElement("iframe");
  frame.src = location.href;
  await new Promise(resolve => {
    frame.onload = resolve;
    document.body.append(frame);
  });
  const result = {
    page: read(window, window),
    frame: read(frame.contentWindow, window),
  };
  frame.remove();
  return JSON.stringify(result);
}

async function readOuter(browser) {
  return within(
    SpecialPowers.spawn(browser, [outerProbe.toString()], async src => {
      return JSON.parse(await content.wrappedJSObject.eval(`(${src})()`));
    }),
    10_000,
    "the page's outer size"
  );
}

function checkOuter(fp, where) {
  Assert.deepEqual(fp.page, CHROME, `${where}: outer is inner plus a toolbar`);
  Assert.deepEqual(fp.frame, CHROME, `${where}: an iframe reads the same`);
}

add_task(async function a_normal_window_reads_a_typical_toolbar() {
  await BrowserTestUtils.withNewTab(PAGE2, async browser => {
    checkOuter(await readOuter(browser), "normal window");
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
    checkOuter(await readOuter(tab.linkedBrowser), "private window");
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the window closing"
    );
  }
});

add_task(async function fullscreen_has_no_toolbar() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["full-screen-api.allow-trusted-requests-only", false],
      ["full-screen-api.transition-duration.enter", "0 0"],
      ["full-screen-api.transition-duration.leave", "0 0"],
    ],
  });
  try {
    await BrowserTestUtils.withNewTab(PAGE2, async browser => {
      // The protection follows nsScreen::IsFullscreen, which reads the
      // display-mode media feature, and that follows the window's own size
      // mode. A desktop with no window manager never puts the window in
      // fullscreen, so the feature never changes there and there is nothing
      // to check.
      const displayMode = SpecialPowers.spawn(browser, [], () => {
        const query = content.matchMedia("(display-mode: fullscreen)");
        return query.matches
          ? null
          : new Promise(r =>
              query.addEventListener("change", r, { once: true })
            );
      });
      await within(
        SpecialPowers.spawn(browser, [], async () => {
          const changed = new Promise(r =>
            content.document.addEventListener("fullscreenchange", r, {
              once: true,
            })
          );
          content.document.documentElement.requestFullscreen();
          await changed;
        }),
        10_000,
        "the page's fullscreenchange"
      );
      const reached = await within(
        displayMode,
        5_000,
        "display-mode: fullscreen"
      ).then(
        () => true,
        () => false
      );
      if (reached) {
        const { page } = await readOuter(browser);
        Assert.equal(page.width, 0, "in fullscreen, outer width is inner");
        Assert.equal(page.height, 0, "in fullscreen, outer height is inner");
      } else {
        info("the window never reached fullscreen here; skipping the check");
      }
      await within(
        SpecialPowers.spawn(browser, [], async () => {
          const changed = new Promise(r =>
            content.document.addEventListener("fullscreenchange", r, {
              once: true,
            })
          );
          content.document.exitFullscreen();
          await changed;
        }),
        10_000,
        "the page leaving fullscreen"
      );
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

/**
 * A site's own lift reaches its own documents only: a third-party frame under
 * it reads the protected size, the top's inner size plus a typical toolbar.
 */
add_task(
  async function a_third_party_frame_under_a_lifted_site_stays_protected() {
    await SpecialPowers.pushPrefEnv({
      set: [
        [
          "privacy.fingerprintingProtection.granularOverrides",
          JSON.stringify([
            {
              firstPartyDomain: "example.com",
              overrides: "-WindowOuterSizeTypical",
            },
          ]),
        ],
      ],
    });
    try {
      await BrowserTestUtils.withNewTab(PAGE2, async browser => {
        const src = ROOT.replace("https://example.com", "https://example.org");
        await SpecialPowers.spawn(
          browser,
          [src + "sval_agent_page2.html"],
          s => {
            const frame = content.document.createElement("iframe");
            frame.src = s;
            const loaded = new Promise(r => (frame.onload = r));
            content.document.body.append(frame);
            return loaded.then(() => null);
          }
        );
        const top = await SpecialPowers.spawn(browser, [], () => ({
          width: content.wrappedJSObject.innerWidth,
          height: content.wrappedJSObject.innerHeight,
        }));
        const frame = await SpecialPowers.spawn(
          browser.browsingContext.children[0],
          [],
          () => ({
            width: content.wrappedJSObject.eval("outerWidth"),
            height: content.wrappedJSObject.eval("outerHeight"),
          })
        );
        Assert.deepEqual(
          frame,
          {
            width: top.width + CHROME.width,
            height: top.height + CHROME.height,
          },
          "the third-party frame reads the top's inner size plus a toolbar"
        );
      });
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  }
);
