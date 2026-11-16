/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * A download in a tab marked as an agent's whose question to Sval fails is
 * refused, as a picker is (`SvalAgentFiles.h`): it reaches neither Firefox's
 * dialog nor its transfer, which would save it outside the agent's download
 * permission. Any other tab's download still goes to Firefox's components.
 */

const { MockRegistrar } = ChromeUtils.importESModule(
  "resource://testing-common/MockRegistrar.sys.mjs"
);

const DIALOG = "@mozilla.org/helperapplauncherdialog;1";

/**
 * Stands, until the task ends, a Sval service that fails every question in
 * front of its contract, Firefox's own dialog behind a stand-in that counts
 * what it is made for, and a Firefox transfer that counts what it is made for
 * and takes the download.
 *
 * @returns {object} `asked(question)` resolves once a download has asked Sval
 *   that question (`downloadDialog` or `downloadTransfer`); `stopped`
 *   resolves once Gecko tells a transfer its download has stopped; `made()`
 *   counts the Firefox dialogs and transfers made.
 */
function failingSval() {
  const questions = {};
  const asked = question =>
    (questions[question] ??= Promise.withResolvers()).promise;
  const answer = question => {
    (questions[question] ??= Promise.withResolvers()).resolve();
    fail();
  };
  // XPConnect reports a JS component's failure as an uncaught exception,
  // which fails the test, for every code but a few
  // (xpc_IsReportableErrorCode); the stand-ins fail with one of those.
  const fail = () => {
    throw Components.Exception("", Cr.NS_BASE_STREAM_WOULD_BLOCK);
  };
  const sval = MockRegistrar.register("@sval/agent-files;1", {
    refusesFilePicker: fail,
    refusesClipboardWrite: fail,
    downloadDialog: () => answer("downloadDialog"),
    downloadTransfer: () => answer("downloadTransfer"),
    QueryInterface: ChromeUtils.generateQI(["nsISvalAgentFiles"]),
  });
  const made = { dialogs: 0, transfers: 0 };
  const firefoxDialog = Components.manager.getClassObject(
    Components.manager
      .QueryInterface(Ci.nsIComponentRegistrar)
      .contractIDToCID(DIALOG),
    Ci.nsIFactory
  );
  const dialog = MockRegistrar.register(DIALOG, () => {
    made.dialogs++;
    return firefoxDialog.createInstance(Ci.nsIHelperAppLauncherDialog);
  });
  // nsExternalAppHandler tells its transfer the download has stopped
  // (`NotifyTransfer`) once its saver has closed the file in the download
  // directory, which a task's end then removes.
  const stopped = Promise.withResolvers();
  const transfer = MockRegistrar.register("@mozilla.org/transfer;1", () => {
    made.transfers++;
    return {
      init() {},
      initWithBrowsingContext() {},
      onStateChange(progress, request, flags) {
        if (flags & Ci.nsIWebProgressListener.STATE_STOP) {
          stopped.resolve();
        }
      },
      QueryInterface: ChromeUtils.generateQI(["nsITransfer"]),
    };
  });
  atTaskEnd(() => {
    MockRegistrar.unregister(transfer);
    MockRegistrar.unregister(dialog);
    MockRegistrar.unregister(sval);
  });
  return { asked, stopped: stopped.promise, made: () => ({ ...made }) };
}

/**
 * Starts a download in a new tab, marked as an agent's or not.
 *
 * @param {boolean} agentTab
 * @returns {Promise<object>} `failingSval()`'s stand-ins.
 */
async function downloadIn(agentTab) {
  const dir = await makeTempDir("sval-agent-unasked");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.download.dir", dir],
      ["browser.download.folderList", 2],
      ["browser.download.useDownloadDir", true],
      ["browser.download.always_ask_before_handling_new_types", false],
    ],
  });
  atTaskEnd(() => IOUtils.remove(dir, { recursive: true }));
  const sval = failingSval();
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE),
    10_000,
    "the test page's tab"
  );
  const bc = tab.linkedBrowser.browsingContext;
  bc.svalAgentTab = agentTab;
  atTaskEnd(() => {
    bc.svalAgentTab = false;
  });
  await SpecialPowers.spawn(
    tab.linkedBrowser,
    [`${ROOT}sval_agent_download.sjs?name=unasked.txt`],
    url => {
      content.location.href = url;
    }
  );
  return sval;
}

/**
 * nsExternalAppHandler asks for its dialog before its transfer
 * (`RequestSaveDestination`), so a refusal comes at the dialog.
 */
add_task(async function an_agent_tabs_unasked_download_is_refused() {
  const { asked, made } = await downloadIn(true);
  await within(asked("downloadDialog"), 10_000, "the download asking Sval");
  // SvalAgentFiles.h makes Firefox's dialog in the same call that asked Sval,
  // so by the next event it has made one or refused.
  await new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
  Assert.deepEqual(
    made(),
    { dialogs: 0, transfers: 0 },
    "the download made no Firefox dialog or transfer"
  );
});

add_task(async function another_tabs_unasked_download_goes_to_firefox() {
  const { stopped, made } = await downloadIn(false);
  await within(stopped, 10_000, "the download stopping in Firefox's transfer");
  Assert.deepEqual(
    made(),
    { dialogs: 1, transfers: 1 },
    "the download went to Firefox's dialog and transfer"
  );
});
