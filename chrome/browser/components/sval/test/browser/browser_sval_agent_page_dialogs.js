/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_page_dialog_helpers.js */

/**
 * Page dialogs Sval answers itself (agent-control spec §4.1): in an agent's
 * tab an alert is accepted and a beforeunload is accepted, and the next tool
 * result says what the dialog said. A user's own tab keeps its dialogs. A
 * confirm or a prompt waits for the agent
 * (`browser_sval_agent_answers_dialogs.js`).
 * Whose words a dialog may report is `browser_sval_agent_dialog_words.js`.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);
const { PromptTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PromptTestUtils.sys.mjs"
);

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_page_dialog_helpers.js",
  this
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * Has `browser`'s page alert, and checks the alert stays up for the user
 * with nothing reported to an agent.
 *
 * @param {object} browser
 * @param {object} dialogs
 */
async function alertStaysUp(browser, dialogs) {
  const shown = PromptTestUtils.waitForPrompt(browser, {
    modalType: Services.prompt.MODAL_TYPE_CONTENT,
    promptType: "alert",
  });
  await SpecialPowers.spawn(browser, [], () => {
    content.setTimeout(() => content.alert("mine"), 0);
  });
  const dialog = await within(shown, 10_000, "the page's alert");
  // A handler answers a dialog inside the notification `shown` waited on,
  // through its buttons, which mark it no longer active as they are pressed.
  Assert.notStrictEqual(
    dialog.args.promptActive,
    false,
    "nothing answered the alert"
  );
  Assert.equal(
    browser.documentGlobal.gBrowser
      .getTabDialogBox(browser)
      .getContentDialogManager().dialogs.length,
    1,
    "the alert stays up for the user"
  );
  Assert.equal(dialogs.takeReport(browser), null, "and nothing is reported");
  await within(
    PromptTestUtils.handlePrompt(dialog),
    10_000,
    "the page's alert closing once handled"
  );
}

add_task(async function an_alert_is_accepted_and_reported() {
  const setup = await dialogsSetup();
  const { call, tab, browser } = setup;
  const { snapshot } = await call("get_snapshot", { tab });
  const ref = snapshot.match(/button "Alert" \[(e\d+)\]/)[1];
  const result = await call("click_element", { tab, ref });
  Assert.deepEqual(result.dialog, { type: "alert", message: "hello" });
  Assert.equal(result.error, undefined, "the click answered on its own");
  Assert.equal(result.writes, "none");
  Assert.equal(result.url, PAGE);

  const after = await call("get_snapshot", { tab });
  Assert.equal(after.dialog, undefined, "a dialog is reported once");
  await SpecialPowers.spawn(browser, [], () => {
    Assert.ok(!content.windowUtils.isInModalState?.(), "the page is free");
  });
});

add_task(async function a_long_message_is_cut_to_500_characters() {
  const setup = await dialogsSetup();
  const ref = await buttonRunning(setup, "alert('x'.repeat(600) + 'END')");
  const result = await setup.call("click_element", { tab: setup.tab, ref });
  Assert.equal(result.dialog.type, "alert");
  Assert.equal(result.dialog.message, "x".repeat(500));
});

add_task(async function a_beforeunload_lets_navigate_tab_through() {
  // A page may ask only after the user has interacted with it, and an
  // agent's input need not count as that; the pref takes it out of the test.
  await SpecialPowers.pushPrefEnv({
    set: [["dom.require_user_interaction_for_beforeunload", false]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const { call, tab, browser } = await dialogsSetup();
  await SpecialPowers.spawn(browser, [], () => {
    content.addEventListener("beforeunload", event => {
      event.preventDefault();
    });
  });
  const result = await call("navigate_tab", { tab, to: PAGE2 });
  Assert.equal(result.url, PAGE2, "the navigation went on");
  Assert.equal(result.dialog?.type, "beforeunload");
  Assert.equal(typeof result.dialog.message, "string");
});

add_task(async function a_users_own_tab_keeps_its_dialogs() {
  const { dialogs, gate } = await dialogsSetup();
  const userTab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE),
    10_000,
    "a new tab's load"
  );
  atTaskEnd(() => BrowserTestUtils.removeTab(userTab));
  const browser = userTab.linkedBrowser;
  Assert.equal(gate.agentOf(browser), null, "the user's tab is not watched");
  await alertStaysUp(browser, dialogs);
});

add_task(async function a_tab_the_user_took_keeps_its_dialogs() {
  const { dialogs, gate, tabs, agent, tab } = await dialogsSetup();
  const found = await tabs.tabIn(agent, tab);
  const windowOpened = BrowserTestUtils.domWindowOpenedAndLoaded();
  found.win.gBrowser.replaceTabWithWindow(found.tab);
  const userWin = await within(windowOpened, 10_000, "a window opening");
  atTaskEnd(async () => {
    if (!userWin.closed) {
      await within(
        BrowserTestUtils.closeWindow(userWin),
        10_000,
        "the window closing"
      );
    }
  });
  await within(userWin.SvalPanel.started, 10_000, "the panel's startup");
  const taken = userWin.gBrowser.selectedBrowser;
  await TestUtils.waitForCondition(
    () => gate.agentOf(taken) === null,
    "the tab is let go"
  );
  await alertStaysUp(taken, dialogs);
});

add_task(async function a_closed_tabs_dialog_report_goes_with_it() {
  const { dialogs, browser, win } = await dialogsSetup();
  await alertFromTimer(browser.browsingContext, "hello");
  // A closed tab's browser has no id left to ask with, so its report is
  // asked for by the id it had.
  const { browserId } = browser;
  await BrowserTestUtils.removeTab(win.gBrowser.getTabForBrowser(browser));
  Assert.equal(dialogs.takeReport({ browserId }), null, "nothing is kept");
});

add_task(async function leaving_a_pdf_never_saves_it() {
  const { browser } = await dialogsSetup();
  // What PDF.js's beforeunload asks (PromptCollection.asyncBeforeUnloadCheck),
  // where button 0 is Save and button 2 is Don't save.
  const result = await Services.prompt.asyncConfirmEx(
    browser.browsingContext,
    Services.prompt.MODAL_TYPE_CONTENT,
    "Save?",
    "Save the PDF?",
    Ci.nsIPromptService.BUTTON_POS_0_DEFAULT |
      (Ci.nsIPrompt.BUTTON_TITLE_SAVE * Ci.nsIPrompt.BUTTON_POS_0) |
      (Ci.nsIPrompt.BUTTON_TITLE_CANCEL * Ci.nsIPrompt.BUTTON_POS_1) |
      (Ci.nsIPrompt.BUTTON_TITLE_DONT_SAVE * Ci.nsIPrompt.BUTTON_POS_2),
    null,
    null,
    null,
    null,
    false,
    { inPermitUnload: true }
  );
  Assert.equal(
    result.QueryInterface(Ci.nsIPropertyBag2).get("buttonNumClicked"),
    2,
    "Don't save was chosen"
  );
});
