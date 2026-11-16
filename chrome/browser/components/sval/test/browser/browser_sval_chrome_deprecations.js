/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A deprecation warning is for the authors of web pages. Sval's own windows
 * read `Window.fullScreen` as Firefox's chrome does, and their console shows
 * nothing for it; a web page reading it is still warned.
 */

/**
 * The deprecation warnings the console receives while `act` runs.
 *
 * @param {Function} act
 * @returns {Promise<string[]>}
 */
async function fullScreenWarningsWhile(act) {
  const seen = [];
  const listener = {
    observe(message) {
      if (
        message instanceof Ci.nsIScriptError &&
        message.errorMessage.includes("Window.fullScreen")
      ) {
        seen.push(message.sourceName);
      }
    },
  };
  Services.console.registerListener(listener);
  try {
    await act();
  } finally {
    Services.console.unregisterListener(listener);
  }
  return seen;
}

add_task(async function a_browser_window_reads_full_screen_silently() {
  const seen = await fullScreenWarningsWhile(async () => {
    const win = await within(
      BrowserTestUtils.openNewBrowserWindow(),
      20_000,
      "the window's opening"
    );
    ok(!win.fullScreen, "the window is not in full screen");
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the window's closing"
    );
  });
  Assert.deepEqual(seen, [], "the window logged no deprecation warning");
});

add_task(async function a_web_page_reading_full_screen_is_warned() {
  const seen = await fullScreenWarningsWhile(async () => {
    await BrowserTestUtils.withNewTab("https://example.com/", async browser => {
      await SpecialPowers.spawn(browser, [], () => {
        // Read for its warning.
        content.fullScreen;
      });
      // The warning is reported from the page's process; a second round
      // trip delivers what it logged before.
      await SpecialPowers.spawn(browser, [], () => {});
    });
  });
  Assert.equal(seen.length, 1, "the page's read is warned once");
});
