/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Closing a page's toolbox, or the Browser Console in its Multiprocess mode,
 * logs nothing in any process, however busy the page's process still is when
 * it closes.
 */

const { require } = ChromeUtils.importESModule(
  "resource://devtools/shared/loader/Loader.sys.mjs"
);
const { gDevTools } = require("devtools/client/framework/devtools");
const {
  BrowserConsoleManager,
} = require("devtools/client/webconsole/browser-console-manager");

// Opening a toolbox records that one was opened and which tool it showed.
keepPrefs("devtools.everOpened", "devtools.toolbox.selectedTool");

// The parent process's own errors.
add_setup(failOnConsoleErrors);

const ROUNDS = 10;

// A page that keeps logging, so its process has DevTools traffic in flight
// whenever the toolbox closes.
const BUSY_PAGE =
  "https://example.com/document-builder.sjs?html=" +
  encodeURIComponent(
    "<script>setInterval(() => console.log('sval-devtools-close'), 5)</script>"
  );

const ASK = "sval-devtools-close:ask";
const ANSWER = "sval-devtools-close:answer";
const STOP = "sval-devtools-close:stop";

/**
 * Runs in every process, the parent included so that every process answers
 * `ask`. A child process records its console errors, both kinds that
 * `failOnConsoleErrors` reads, and hands them over with each answer. The
 * Browser Console's Multiprocess mode shows a child's errors to the user.
 *
 * @param {string} ask
 * @param {string} answer
 * @param {string} stop
 */
function errorRecorder(ask, answer, stop) {
  /* global sendAsyncMessage, addMessageListener, removeMessageListener */
  const errors = [];
  const isChild =
    Services.appinfo.processType != Ci.nsIXULRuntime.PROCESS_TYPE_DEFAULT;
  const storage = Cc["@mozilla.org/consoleAPI-storage;1"].getService(
    Ci.nsIConsoleAPIStorage
  );
  const onLog = message => {
    if (message.level === "error") {
      errors.push(Array.from(message.arguments ?? [], String).join(" "));
    }
  };
  const scriptErrors = {
    observe(message) {
      if (
        message instanceof Ci.nsIScriptError &&
        !(
          message.flags &
          (Ci.nsIScriptError.warningFlag | Ci.nsIScriptError.infoFlag)
        )
      ) {
        errors.push(message.errorMessage);
      }
    },
  };
  if (isChild) {
    storage.addLogEventListener(
      onLog,
      Cc["@mozilla.org/systemprincipal;1"].createInstance(Ci.nsIPrincipal)
    );
    Services.console.registerListener(scriptErrors);
  }
  const onAsk = () => sendAsyncMessage(answer, errors.splice(0));
  const onStop = () => {
    removeMessageListener(ask, onAsk);
    removeMessageListener(stop, onStop);
    if (isChild) {
      storage.removeLogEventListener(onLog);
      Services.console.unregisterListener(scriptErrors);
    }
  };
  addMessageListener(ask, onAsk);
  addMessageListener(stop, onStop);
}

const RECORDER = `data:,(${errorRecorder})(${JSON.stringify(ASK)}, ${JSON.stringify(ANSWER)}, ${JSON.stringify(STOP)})`;

add_setup(() => {
  // Delayed, so a process that starts during the file records too.
  Services.ppmm.loadProcessScript(RECORDER, true);
  registerCleanupFunction(() => {
    Services.ppmm.removeDelayedProcessScript(RECORDER);
    Services.ppmm.broadcastAsyncMessage(STOP);
  });
});

// DevTools loads this into every process while its process actors are
// registered (ParentProcessWatcherRegistry).
const DEVTOOLS_PROCESS_SCRIPT =
  "resource://devtools/server/connectors/js-process-actor/content-process-jsprocessactor-startup.js";

/**
 * Resolves once DevTools has unregistered its process actors, which it does
 * after the last watcher's destruction, once every process has answered it.
 */
function devToolsLetGo() {
  return within(
    TestUtils.waitForCondition(
      () =>
        !Services.ppmm
          .getDelayedProcessScripts()
          .some(([url]) => url == DEVTOOLS_PROCESS_SCRIPT),
      "DevTools' process script withdrawn"
    ),
    10_000,
    "DevTools unregistering its process actors"
  );
}

/**
 * The console errors child processes logged since the last call. Every
 * process answers after whatever it sent before the question, so an error
 * its late messages cause in the parent has been logged by then too.
 * A process already shutting down never answers: a closed tab's process
 * exits, as each tab of the site may have had a process of its own
 * (dom.ipc.processCount.webIsolated). Its message manager closes instead
 * (nsFrameMessageManager::Close), and it has no more to say.
 *
 * @returns {Promise<string[]>}
 */
async function childErrors() {
  const pending = new Set();
  for (let i = 0; i < Services.ppmm.childCount; i++) {
    pending.add(Services.ppmm.getChildAt(i));
  }
  const errors = [];
  const { promise, resolve } = Promise.withResolvers();
  const settle = mm => {
    pending.delete(mm);
    if (!pending.size) {
      resolve();
    }
  };
  const listener = ({ target, data }) => {
    errors.push(...data);
    settle(target);
  };
  const closed = mm => settle(mm);
  Services.ppmm.addMessageListener(ANSWER, listener);
  Services.obs.addObserver(closed, "message-manager-close");
  try {
    Services.ppmm.broadcastAsyncMessage(ASK);
    await within(promise, 10_000, "every process's answer or exit");
  } finally {
    Services.obs.removeObserver(closed, "message-manager-close");
    Services.ppmm.removeMessageListener(ANSWER, listener);
  }
  return errors;
}

add_task(async function closing_a_page_toolbox_logs_nothing() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, BUSY_PAGE),
    10_000,
    "the page's tab"
  );
  for (let round = 0; round < ROUNDS; round++) {
    const toolbox = await within(
      gDevTools.showToolboxForTab(tab, { toolId: "webconsole" }),
      20_000,
      "the page's toolbox"
    );
    await within(toolbox.destroy(), 10_000, "the toolbox's closing");
    await devToolsLetGo();
    Assert.deepEqual(await childErrors(), [], "no process logged an error");
  }
  BrowserTestUtils.removeTab(tab);
});

add_task(async function closing_a_tab_with_its_toolbox_open_logs_nothing() {
  for (let round = 0; round < ROUNDS; round++) {
    const tab = await within(
      BrowserTestUtils.openNewForegroundTab(gBrowser, BUSY_PAGE),
      10_000,
      "the page's tab"
    );
    const toolbox = await within(
      gDevTools.showToolboxForTab(tab, { toolId: "webconsole" }),
      20_000,
      "the page's toolbox"
    );
    const closed = toolbox.once("destroyed");
    BrowserTestUtils.removeTab(tab);
    await within(closed, 10_000, "the toolbox's closing");
    await devToolsLetGo();
    Assert.deepEqual(await childErrors(), [], "no process logged an error");
  }
});

add_task(
  async function closing_the_multiprocess_browser_console_logs_nothing() {
    // The mode the Browser Console's Multiprocess choice stores, so each
    // opening starts in it. Choosing it in an open console switches modes while
    // the console runs, and a close during that switch is another case.
    await SpecialPowers.pushPrefEnv({
      set: [["devtools.browsertoolbox.scope", "everything"]],
    });
    const tab = await within(
      BrowserTestUtils.openNewForegroundTab(gBrowser, BUSY_PAGE),
      10_000,
      "the page's tab"
    );
    for (let round = 0; round < ROUNDS; round++) {
      const hud = await within(
        BrowserConsoleManager.toggleBrowserConsole(),
        20_000,
        "the Browser Console's opening"
      );
      ok(
        hud.ui.window.document.querySelector(
          'input[name="chrome-debug-mode"][value="everything"]'
        ).checked,
        "the Browser Console shows every process"
      );
      // The page's own messages reach the console once it watches the page's
      // process.
      await within(
        TestUtils.waitForCondition(
          () =>
            [...hud.ui.outputNode.querySelectorAll(".message-body")].some(
              body => body.textContent.includes("sval-devtools-close")
            ),
          "the page's messages"
        ),
        20_000,
        "the page's messages in the Browser Console"
      );
      await within(
        BrowserConsoleManager.closeBrowserConsole(),
        10_000,
        "the Browser Console's closing"
      );
      await devToolsLetGo();
      Assert.deepEqual(await childErrors(), [], "no process logged an error");
    }
    BrowserTestUtils.removeTab(tab);
  }
);
