/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * With Sval's shipped defaults, code pasted from a page that tells the user
 * to "paste this into the console" does not run: the Web Console refuses the
 * paste until the user types "allow pasting", and the Browser Console has no
 * command line, so nothing typed there runs with the browser's privileges.
 */

const { require } = ChromeUtils.importESModule(
  "resource://devtools/shared/loader/Loader.sys.mjs"
);
const { gDevTools } = require("devtools/client/framework/devtools");
const {
  BrowserConsoleManager,
} = require("devtools/client/webconsole/browser-console-manager");
const WebConsoleUtils = require("devtools/client/webconsole/utils").Utils;

// Opening a toolbox records that one was opened and which tool it showed,
// and the Browser Console keeps its filters and mode as prefs.
keepPrefs(
  "devtools.everOpened",
  "devtools.toolbox.selectedTool",
  "devtools.browserconsole.filter.",
  "devtools.browsertoolbox.scope"
);

add_task(async function debugging_the_browser_is_off_by_default() {
  const defaults = Services.prefs.getDefaultBranch("");
  Assert.ok(
    !defaults.getBoolPref("devtools.chrome.enabled"),
    "chrome debugging is off by default"
  );
  Assert.ok(
    !defaults.getBoolPref("devtools.debugger.remote-enabled"),
    "remote debugging is off by default"
  );
});

add_task(async function the_web_console_refuses_a_paste_until_allowed() {
  const pasted = "sval-test: pasted code";
  const tab = await openPage("https://example.com/");
  const toolbox = await within(
    gDevTools.showToolboxForTab(tab, { toolId: "webconsole" }),
    20_000,
    "the page's toolbox"
  );
  try {
    const { hud } = toolbox.getPanel("webconsole");
    const { document } = hud.ui;
    await within(
      SimpleTest.promiseClipboardChange(pasted, () =>
        Cc["@mozilla.org/widget/clipboardhelper;1"]
          .getService(Ci.nsIClipboardHelper)
          .copyString(pasted)
      ),
      10_000,
      "the clipboard taking the code"
    );
    hud.jsterm.focus();
    goDoCommand("cmd_paste");
    Assert.equal(
      document
        .querySelector("#webconsole-notificationbox .notification")
        ?.getAttribute("data-key"),
      "selfxss-notification",
      "the console warns about pasting"
    );
    Assert.equal(hud.jsterm._getValue(), "", "the paste is refused");

    for (const char of "allow pasting") {
      EventUtils.sendString(char);
    }
    await TestUtils.waitForCondition(
      () =>
        !document.querySelector("#webconsole-notificationbox .notification"),
      "the warning closing once pasting is allowed"
    );
    const cleared = hud.jsterm.once("set-input-value");
    hud.jsterm._setValue("");
    await within(cleared, 10_000, "the console's input clearing");
    goDoCommand("cmd_paste");
    Assert.equal(hud.jsterm._getValue(), pasted, "the paste goes in");
  } finally {
    // Typing "allow pasting" records the user as one the console trusts, in
    // the pref and in the module's own count, which later files share.
    WebConsoleUtils.usageCount = 0;
    await within(toolbox.destroy(), 10_000, "the toolbox closing");
  }
});

add_task(async function the_browser_console_has_no_command_line() {
  const hud = await within(
    BrowserConsoleManager.toggleBrowserConsole(),
    20_000,
    "the Browser Console's opening"
  );
  try {
    Assert.equal(
      hud.ui.document.querySelector(".jsterm-input-container"),
      null,
      "the Browser Console offers no command line"
    );
  } finally {
    await within(
      BrowserConsoleManager.closeBrowserConsole(),
      10_000,
      "the Browser Console's closing"
    );
  }
});
