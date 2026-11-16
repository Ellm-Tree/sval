/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Opening the Browser Console in its Multiprocess mode tells the user nothing
 * about the browser window's `console`: the window keeps its own, so the
 * console's warning that a script disabled the logging API never shows.
 */

const { require } = ChromeUtils.importESModule(
  "resource://devtools/shared/loader/Loader.sys.mjs"
);
const {
  BrowserConsoleManager,
} = require("devtools/client/webconsole/browser-console-manager");

// Opening the Browser Console records that DevTools were opened; its filter
// bar and mode are prefs.
keepPrefs(
  "devtools.everOpened",
  "devtools.browserconsole.filter.",
  "devtools.browsertoolbox.scope"
);

add_setup(failOnConsoleErrors);

// The category `WebConsoleUI.logWarningAboutReplacedAPI` logs under.
const CATEGORY = "ConsoleAPIDisabled";

add_task(async function multiprocess_browser_console_warns_of_no_script() {
  // The mode the Browser Console's Multiprocess choice stores.
  await SpecialPowers.pushPrefEnv({
    set: [["devtools.browsertoolbox.scope", "everything"]],
  });
  const warnings = [];
  const listener = {
    observe(message) {
      if (
        message instanceof Ci.nsIScriptError &&
        message.category == CATEGORY
      ) {
        warnings.push(message.errorMessage);
      }
    },
  };
  Services.console.registerListener(listener);
  registerCleanupFunction(() => Services.console.unregisterListener(listener));

  const hud = await within(
    BrowserConsoleManager.toggleBrowserConsole(),
    20_000,
    "the Browser Console's opening"
  );
  // The console warns when the browser window's load event, as its top-level
  // target reports it, says the window's console is not its own
  // (`WebConsoleUI.handleDocumentEvent`).
  const { resourceCommand } = hud;
  const loaded = () =>
    resourceCommand
      .getAllResources(resourceCommand.TYPES.DOCUMENT_EVENT)
      .find(
        resource =>
          resource.name == "dom-complete" && resource.targetFront.isTopLevel
      );
  await within(
    TestUtils.waitForCondition(loaded, "the browser window's load event"),
    10_000,
    "the browser window's load event in the Browser Console"
  );
  is(
    loaded().hasNativeConsoleAPI,
    true,
    "the Browser Console finds the window's own console"
  );
  // The marker's row shows the output is rendering before it is read.
  const marker = "sval-console-api-warning: marker";
  await within(
    hud.currentTarget.logWarningInPage(marker, "sval-test"),
    10_000,
    "the marker's logging"
  );
  await within(
    TestUtils.waitForCondition(
      () =>
        [...hud.ui.outputNode.querySelectorAll(".message-body")].some(body =>
          body.textContent.includes(marker)
        ),
      "the marker in the output"
    ),
    10_000,
    "the marker in the Browser Console"
  );

  Assert.deepEqual(warnings, [], "no warning that a script replaced console");
  ok(
    ![...hud.ui.outputNode.querySelectorAll(".message")].some(
      row => row.getAttribute("data-category") == CATEGORY
    ),
    "the Browser Console shows no such warning"
  );

  await within(
    BrowserConsoleManager.closeBrowserConsole(),
    10_000,
    "the Browser Console's closing"
  );
});
