/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Settings closed while it loads leaves no script of its own running.
 *
 * `main.js`, a classic script in the page's body, imports its config modules
 * with `ChromeUtils.importESModule(…, { global: "current" })`. While any of
 * the page's `<script type="module">` is still being fetched, that import
 * waits in a nested event loop (`GetModuleLoaderForCurrentGlobal`), and
 * everything else the main thread does runs inside it. A page that goes away
 * cancels its fetches, and the wait ends only because canceling drops them
 * (`ModuleLoaderBase::CancelFetchingModules`). Were it to go on, the browser
 * could never quit: `AppShutdownConfirmed` waits for the main thread to come
 * back out of the loop.
 *
 * Once the page has unloaded, the rest of `main.js` and the pane modules it
 * was still importing register no Setting: each one's `setup()` adds pref and
 * observer-service observers that `Preferences.onUnload` has already passed
 * by, so nothing would remove them.
 */

/**
 * The files on the main thread's real stack, outermost last: the frames this
 * callback runs above, never the async ones that only explain how it was
 * reached.
 *
 * @returns {string[]}
 */
function filesOnTheStack() {
  const files = [];
  for (let frame = Components.stack; frame; frame = frame.caller) {
    files.push(frame.filename);
  }
  return files;
}

/** @returns {boolean} whether a settings page script is on the stack. */
function underASettingsScript() {
  return filesOnTheStack().some(file =>
    file?.startsWith("chrome://browser/content/preferences/")
  );
}

add_task(async function settings_closed_while_it_loads_lets_go() {
  ok(!underASettingsScript(), "the task starts on the outermost loop");
  const tab = gBrowser.addTrustedTab("about:preferences");
  // Every turn until the page has loaded, closing it at the first turn that
  // runs inside one of its scripts, where a person's close would land too.
  let closedFromInside = false;
  await TestUtils.waitForCondition(
    () => {
      closedFromInside = underASettingsScript();
      const doc = tab.linkedBrowser.contentDocument;
      return (
        closedFromInside ||
        (doc?.documentURI?.startsWith("about:preferences") &&
          doc.readyState == "complete")
      );
    },
    "settings loads or lets a turn run inside it",
    1,
    10_000
  );
  info(`closing ${closedFromInside ? "from inside a page script" : "loaded"}`);
  const win = tab.linkedBrowser.contentWindow;
  // `Preferences.onUnload` runs from the listener `preferencesBindings.js`
  // added first, so this one counts the settings it tore down.
  let settingsAtUnload;
  win.addEventListener(
    "unload",
    () => (settingsAtUnload = win.Preferences._settings.size),
    { once: true }
  );
  BrowserTestUtils.removeTab(tab);
  await TestUtils.waitForCondition(
    () => !underASettingsScript(),
    "nothing of the closed page is still running",
    100,
    50
  );
  Assert.equal(
    win.Preferences._settings.size,
    settingsAtUnload,
    "the closed page registered no setting after it unloaded"
  );
});
