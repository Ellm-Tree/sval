/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * With accessibility on, as it is for anyone running a screen reader or an
 * app that reads the screen, switching tabs logs nothing. The address bar's
 * search-mode button names its menu by element reflection, which leaves its
 * `popovertarget` attribute empty, and an empty value names no element.
 */

add_task(async function switching_tabs_with_accessibility_on_logs_nothing() {
  let accService = Cc["@mozilla.org/accessibilityService;1"].getService(
    Ci.nsIAccessibilityService
  );
  registerCleanupFunction(() => {
    accService = null;
    Cu.forceGC();
  });
  const seen = [];
  // The console service hands each message to its listeners in a runnable of
  // its own, in the order they were logged (nsConsoleService::LogMessage), so
  // this one arriving means every message before it has arrived.
  const mark = "sval-test: every message logged before this one";
  const marked = Promise.withResolvers();
  const listener = {
    observe(message) {
      if (message.message === mark) {
        marked.resolve();
      }
      if (
        message instanceof Ci.nsIScriptError &&
        !(message.flags & Ci.nsIScriptError.infoFlag)
      ) {
        seen.push(`${message.sourceName} ${message.errorMessage}`);
      }
    },
  };
  Services.console.registerListener(listener);
  try {
    const first = await within(
      BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/"),
      10_000,
      "the first tab's opening"
    );
    const second = await within(
      BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.org/"),
      10_000,
      "the second tab's opening"
    );
    await within(
      BrowserTestUtils.switchTab(gBrowser, first),
      10_000,
      "the switch to the first tab"
    );
    await within(
      BrowserTestUtils.switchTab(gBrowser, second),
      10_000,
      "the switch to the second tab"
    );
    // A round trip to each page's process delivers what it logged before.
    await SpecialPowers.spawn(first.linkedBrowser, [], () => {});
    await SpecialPowers.spawn(second.linkedBrowser, [], () => {});
    BrowserTestUtils.removeTab(first);
    BrowserTestUtils.removeTab(second);
    Services.console.logStringMessage(mark);
    await within(marked.promise, 10_000, "the console's earlier messages");
  } finally {
    Services.console.unregisterListener(listener);
  }
  ok(accService, "accessibility was on");
  Assert.deepEqual(
    seen.filter(line => line.includes("getElementById")),
    [],
    "no empty id was looked up"
  );
});

/**
 * With accessibility on, the Browser Console logs nothing about itself when it
 * shows an error's stack and the user or a screen reader reaches that stack.
 * The stack's frame list names its active frame with `aria-activedescendant`,
 * which is empty until a frame has had focus, and an empty value names no
 * element (patches/devtools-frames-empty-activedescendant.patch).
 */
add_task(async function an_error_stack_in_the_browser_console_logs_nothing() {
  let accService = Cc["@mozilla.org/accessibilityService;1"].getService(
    Ci.nsIAccessibilityService
  );
  ok(accService, "accessibility is on");
  registerCleanupFunction(() => {
    accService = null;
    Cu.forceGC();
  });
  const { require } = ChromeUtils.importESModule(
    "resource://devtools/shared/loader/Loader.sys.mjs"
  );
  const {
    BrowserConsoleManager,
  } = require("devtools/client/webconsole/browser-console-manager");
  const hud = await within(
    BrowserConsoleManager.toggleBrowserConsole(),
    20_000,
    "the Browser Console's opening"
  );
  const seen = [];
  const mark = "sval-test: every message logged before this one";
  const marked = Promise.withResolvers();
  const listener = {
    observe(message) {
      if (message.message === mark) {
        marked.resolve();
      }
      if (
        message instanceof Ci.nsIScriptError &&
        message.errorMessage.includes("getElementById")
      ) {
        seen.push(`${message.sourceName} ${message.errorMessage}`);
      }
    },
  };
  Services.console.registerListener(listener);
  try {
    // A script error, as an uncaught exception reports, is what the console
    // shows with a stack to open.
    const reported = "an error the console shows with its stack";
    // eslint-disable-next-line mozilla/no-cu-reportError
    Cu.reportError(new Error(reported));
    const doc = hud.iframeWindow.document;
    const error = await within(
      TestUtils.waitForCondition(() =>
        Array.from(doc.querySelectorAll(".message.error")).find(node =>
          node.textContent.includes(reported)
        )
      ),
      10_000,
      "the error in the console"
    );
    error.querySelector(".collapse-button").click();
    await within(
      TestUtils.waitForCondition(() => error.querySelector(".top-frames-list")),
      10_000,
      "the error's stack"
    );
    const frames = error.querySelector(".top-frames-list");
    frames.focus();
    const accessible = await accessibleOf(frames);
    // What a screen reader reads of the focused list: its attributes, which
    // resolve the active descendant.
    Assert.ok(
      accessible.attributes,
      "the stack's frame list is reachable to a screen reader"
    );
    Services.console.logStringMessage(mark);
    await within(marked.promise, 10_000, "the console's earlier messages");
  } finally {
    Services.console.unregisterListener(listener);
    await within(
      BrowserConsoleManager.closeBrowserConsole(),
      10_000,
      "the Browser Console's closing"
    );
  }
  Assert.deepEqual(seen, [], "no empty id was looked up");
});

/**
 * Closing the Browser Console logs no error. Its watcher is the last one, so
 * closing unregisters DevTools' process actors, and a message to the parent
 * process's own actor would arrive, as a later runnable, after it was gone
 * (patches/devtools-last-watcher-no-destroy-message.patch).
 */
add_task(async function closing_the_browser_console_logs_no_error() {
  const { require } = ChromeUtils.importESModule(
    "resource://devtools/shared/loader/Loader.sys.mjs"
  );
  const {
    BrowserConsoleManager,
  } = require("devtools/client/webconsole/browser-console-manager");
  await within(
    BrowserConsoleManager.toggleBrowserConsole(),
    20_000,
    "the Browser Console's opening"
  );
  const errors = [];
  const sentinel = "sval: the Browser Console has closed";
  let sawSentinel;
  const sentinelSeen = new Promise(resolve => (sawSentinel = resolve));
  const listener = {
    observe(message) {
      if (message.message === sentinel) {
        sawSentinel();
      } else if (
        message instanceof Ci.nsIScriptError &&
        !(message.flags & Ci.nsIScriptError.warningFlag) &&
        !(message.flags & Ci.nsIScriptError.infoFlag)
      ) {
        errors.push(message.errorMessage);
      }
    },
  };
  Services.console.registerListener(listener);
  try {
    await within(
      BrowserConsoleManager.closeBrowserConsole(),
      10_000,
      "the Browser Console's closing"
    );
    // Main-thread runnables run in the order they were queued, so one queued
    // now runs after every message the closing sent, and the console reports
    // to its listeners in order too: the sentinel comes after anything they
    // logged.
    await new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
    Services.console.logStringMessage(sentinel);
    await within(sentinelSeen, 10_000, "the console's report of the sentinel");
  } finally {
    Services.console.unregisterListener(listener);
  }
  Assert.deepEqual(errors, [], "closing the Browser Console logged no error");
});
