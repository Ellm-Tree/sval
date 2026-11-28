/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_feedback_helpers.js */

/**
 * The Send Feedback form (feedback spec §2, §4, §5): the footer's button
 * opens it, a short message cannot be sent, a send shows its reference, a
 * failed send keeps everything and sends again, Esc keeps the draft and
 * Cancel drops it, and Help › Send Feedback… and the About dialog's link
 * open it too. Sends go to a collector on localhost.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_feedback_helpers.js",
  this
);

/**
 * Types `text` into the form's message, as a person does.
 *
 * @param {Element} form
 * @param {string} text
 */
function typeMessage(form, text) {
  const { message } = formParts(form);
  message.focus();
  // focus() selects what the message holds (decision 2713), and a person
  // typing on adds to it.
  message.setSelectionRange(message.value.length, message.value.length);
  EventUtils.sendString(text, window);
}

add_task(async function the_button_opens_the_form() {
  await appDataInTemp();
  atTaskEnd(() => discardFeedbackDraft());
  const button = feedbackButton();
  Assert.ok(button.title, "the button says what it does");
  button.click();
  const form = await feedbackShown();
  Assert.ok(
    BrowserTestUtils.isVisible(form.querySelector(".sval-feedback-title")),
    "the form opens"
  );
  const { message, context, send } = formParts(form);
  Assert.equal(document.activeElement, message, "with the message focused");
  Assert.ok(context.hidden, "and no context line");
  const about = form.querySelector('[data-part="about"]');
  Assert.ok(
    about.querySelector(".sval-feedback-tag:not(.sval-feedback-tag-sent)") &&
      !about.querySelector(".sval-feedback-tick"),
    "the build and system row is always sent"
  );
  const box = form.querySelector(".sval-feedback-box").getBoundingClientRect();
  const panel = document
    .getElementById("sval-panel-container")
    .getBoundingClientRect();
  const tab = form.querySelector(".sval-feedback-tab").getBoundingClientRect();
  Assert.greaterOrEqual(
    Math.round(box.left - panel.right),
    8,
    "the popover sits at least 8px past the panel"
  );
  Assert.greaterOrEqual(
    Math.round(box.left - tab.right),
    12,
    "and a fillet's room past the tab"
  );

  const { email } = formParts(form);
  for (const [field, multiline] of [
    [message, true],
    [email, false],
  ]) {
    await fieldDrawn(field);
    const acc = await accessibleOf(fieldInner(field));
    Assert.equal(acc.role, Ci.nsIAccessibleRole.ROLE_ENTRY, "a text field");
    Assert.ok(acc.name, "with a name");
    const state = {};
    const extra = {};
    acc.getState(state, extra);
    Assert.equal(
      !!(extra.value & Ci.nsIAccessibleStates.EXT_STATE_MULTI_LINE),
      multiline,
      `${multiline ? "taking" : "not taking"} more than one line`
    );
  }
  Assert.equal(fieldInner(email).type, "email", "the email is an email field");

  Assert.ok(send.disabled, "an empty message can't be sent");
  typeMessage(form, "123456789");
  Assert.ok(send.disabled, "nor one under 10 characters");
  typeMessage(form, "0");
  Assert.ok(!send.disabled, "10 characters can");

  button.click();
  Assert.ok(form.hidden, "the button again closes it");
});

add_task(async function esc_keeps_the_draft_and_cancel_drops_it() {
  await appDataInTemp();
  atTaskEnd(() => discardFeedbackDraft());
  feedbackButton().click();
  let form = await feedbackShown();
  typeMessage(form, "Sync stopped after I moved the folder.");
  const tick = form.querySelector(".sval-feedback-tick:not(:disabled)");
  const tickedAtFirst = tick.checked;
  tick.click();
  const part = tick.closest(".sval-feedback-row").dataset.part;

  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  Assert.ok(form.hidden, "Esc closes the form");
  Assert.equal(
    document.activeElement,
    feedbackButton(),
    "and the focus goes back to the button"
  );

  feedbackButton().click();
  form = await feedbackShown();
  Assert.equal(
    formParts(form).message.value,
    "Sync stopped after I moved the folder.",
    "the message is kept"
  );
  Assert.equal(
    form.querySelector(`[data-part="${part}"] .sval-feedback-tick`).checked,
    !tickedAtFirst,
    "and so is the tick"
  );

  formParts(form).cancel.click();
  Assert.ok(form.hidden, "Cancel closes it");
  feedbackButton().click();
  form = await feedbackShown();
  Assert.equal(formParts(form).message.value, "", "and drops the draft");
});

add_task(async function a_send_shows_its_reference() {
  await appDataInTemp();
  const server = await feedbackServer();
  atTaskEnd(() => discardFeedbackDraft());
  feedbackButton().click();
  const form = await feedbackShown();
  typeMessage(form, "The panel is lovely, thanks.");
  const parts = formParts(form);
  parts.send.click();
  await TestUtils.waitForCondition(
    () => form.dataset.state === "sent",
    "the report is sent"
  );
  Assert.equal(server.received, 1, "in one request");
  Assert.stringContains(
    parts.reference.textContent,
    "F-0042",
    "the form shows the reference"
  );
  Assert.equal(document.activeElement, parts.close, "Close is focused");
  parts.close.click();
  Assert.ok(form.hidden, "Close closes it");

  feedbackButton().click();
  await feedbackShown();
  Assert.equal(parts.message.value, "", "a sent message is not kept");
});

add_task(async function a_failed_send_keeps_the_form_and_sends_again() {
  await appDataInTemp();
  const server = await feedbackServer();
  server.status = 500;
  atTaskEnd(() => discardFeedbackDraft());
  feedbackButton().click();
  const form = await feedbackShown();
  typeMessage(form, "Tabs vanish when I switch workspaces.");
  const tick = form.querySelector(".sval-feedback-tick:not(:disabled)");
  const part = tick.closest(".sval-feedback-row").dataset.part;
  tick.click();
  const ticked = tick.checked;
  const parts = formParts(form);
  parts.send.click();
  await TestUtils.waitForCondition(
    () => form.dataset.state === "failed",
    "the send fails"
  );
  Assert.equal(
    parts.failure.dataset.cause,
    "server",
    "the form says the server failed"
  );
  Assert.ok(
    parts.failure
      .querySelector(".sval-feedback-failure-body")
      .textContent.includes("500"),
    "with its answer"
  );
  Assert.equal(
    parts.message.value,
    "Tabs vanish when I switch workspaces.",
    "the message is kept"
  );
  Assert.equal(
    form.querySelector(`[data-part="${part}"] .sval-feedback-tick`).checked,
    ticked,
    "and the ticks"
  );
  Assert.ok(
    BrowserTestUtils.isVisible(parts.send) && !parts.send.disabled,
    "Send Again is offered"
  );

  server.status = 200;
  parts.send.click();
  await TestUtils.waitForCondition(
    () => form.dataset.state === "sent",
    "Send Again sends"
  );
  Assert.stringContains(parts.reference.textContent, "F-0042");
  parts.close.click();
});

add_task(async function a_report_that_cannot_be_built_says_so_and_retries() {
  await appDataInTemp();
  atTaskEnd(() => discardFeedbackDraft());
  const { SvalFeedback } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalFeedback.sys.mjs"
  );
  const collect = SvalFeedback.collect;
  SvalFeedback.collect = async () => {
    throw new Error("the report cannot be built");
  };
  atTaskEnd(() => {
    SvalFeedback.collect = collect;
  });
  feedbackButton().click();
  await TestUtils.waitForCondition(
    () => feedbackForm()?.querySelector(".sval-feedback-failure:not([hidden])"),
    "the form shows the failure"
  );
  const form = feedbackForm();
  const parts = formParts(form);
  Assert.equal(
    parts.failure.dataset.cause,
    "collect",
    "the form says the report could not be gathered"
  );
  typeMessage(form, "Tabs vanish when I switch workspaces.");
  Assert.ok(parts.send.disabled, "Send waits for a report");

  SvalFeedback.collect = collect;
  parts.failure.querySelector(".sval-feedback-retry").click();
  await feedbackShown();
  Assert.ok(parts.failure.hidden, "Try Again builds the report");
  Assert.ok(!parts.send.disabled, "and Send can go");
});

add_task(async function view_shows_a_crash_files_annotations() {
  const { pending } = await appDataInTemp();
  atTaskEnd(() => discardFeedbackDraft());
  const id = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";
  await IOUtils.write(
    PathUtils.join(pending, `${id}.dmp`),
    new Uint8Array([0x4d, 0x44, 0x4d, 0x50, ...new Array(60).fill(0)])
  );
  await IOUtils.writeJSON(PathUtils.join(pending, `${id}.extra`), {
    ProductName: "Sval",
    Version: "0.2.0",
    BuildID: "20261022000000",
    ProcessType: "content",
    CrashTime: String(Math.floor(Date.now() / 1000)),
    URL: "https://url-marker.example/",
  });

  feedbackButton().click();
  const form = await feedbackShown();
  const row = form.querySelector(`.sval-feedback-row[data-part="crash:${id}"]`);
  Assert.ok(row, "the crash file has its row");
  row.querySelector(".sval-feedback-view").click();
  const shown = await TestUtils.waitForCondition(
    () => form.querySelector(".sval-feedback-crash .sval-feedback-text"),
    "the crash file's view shows its annotations"
  );
  Assert.ok(
    shown.textContent.includes('"ProcessType": "content"'),
    "View shows the annotations sent with the snapshot"
  );
  Assert.ok(
    !shown.textContent.includes("url-marker"),
    "and they hold no page address, as sent"
  );
});

add_task(async function help_menu_opens_the_form() {
  await appDataInTemp();
  atTaskEnd(() => discardFeedbackDraft());
  const item = document.getElementById("sval-help-send-feedback");
  Assert.ok(item.getAttribute("label"), "Help offers it");
  Assert.equal(
    item.parentNode.id,
    "menu_HelpPopup",
    "in the Help menu the app menu copies"
  );
  item.doCommand();
  const form = await feedbackShown();
  Assert.ok(formParts(form).context.hidden, "with no context");
});

add_task(async function about_dialogs_link_opens_the_form() {
  await appDataInTemp();
  atTaskEnd(() => discardFeedbackDraft());
  const opened = BrowserTestUtils.domWindowOpenedAndLoaded(
    null,
    win => win.document.documentElement.id == "aboutDialog"
  );
  openAboutDialog();
  const about = await within(opened, 10_000, "the About dialog opening");
  atTaskEnd(() =>
    within(BrowserTestUtils.closeWindow(about), 10_000, "the dialog closing")
  );
  const link = about.document.getElementById("submit-feedback");
  await TestUtils.waitForCondition(
    () => link.textContent,
    "the link has its label"
  );
  link.click();
  const form = await feedbackShown();
  Assert.ok(formParts(form).context.hidden, "with no context");
});

/**
 * Opens the form from the column's button with the toolbar in the panel and
 * the panel on `side`, and checks the tab covers the button and the stem
 * meets the box with room for its curve or none (`SvalStem`).
 *
 * @param {string} side
 */
async function checkTabOverColumnButton(side) {
  await appDataInTemp();
  atTaskEnd(() => discardFeedbackDraft());
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.sval.toolbar.inPanel", true],
      // Firefox marks Home as taken out of `#nav-bar` once it moves
      // (`BrowserUsageTelemetry`).
      ["browser.engagement.home-button.has-removed", false],
    ],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  await SvalPanel.placePanel(side);
  atTaskEnd(() => SvalPanel.placePanel("left"));
  SvalPanel._setPanelWidth(48);
  atTaskEnd(() => SvalPanel._setPanelWidth(null));
  const button = feedbackButton();
  // The column's padding comes with its attribute, after the panel's width,
  // and the panel slides to its side.
  const panel = document.getElementById("sval-panel-container");
  await TestUtils.waitForCondition(
    () =>
      panel.hasAttribute("sval-column") &&
      !panel.getAnimations({ subtree: true }).length &&
      BrowserTestUtils.isVisible(button) &&
      button.getBoundingClientRect().width == 36,
    "the button in the column"
  );
  button.click();
  const form = await feedbackShown();
  const b = button.getBoundingClientRect();
  const tab = form.querySelector(".sval-feedback-tab").getBoundingClientRect();
  const box = form.querySelector(".sval-feedback-box").getBoundingClientRect();
  const middle = r => [(r.left + r.right) / 2, (r.top + r.bottom) / 2];
  const [bx, by] = middle(b);
  const [tx, ty] = middle(tab);
  Assert.less(
    Math.abs(tx - bx) + Math.abs(ty - by),
    0.5,
    `the tab stands over the button's middle on the ${side}`
  );
  Assert.greaterOrEqual(tab.width, b.width, "and covers it");
  const neck = side == "left" ? box.left - tab.right : tab.left - box.right;
  Assert.greaterOrEqual(
    neck,
    12,
    `the box stands a fillet's room from the tab on the ${side}: ${neck}px`
  );
}

add_task(async function the_tab_covers_the_columns_button_on_the_left() {
  await checkTabOverColumnButton("left");
});

add_task(async function the_tab_covers_the_columns_button_on_the_right() {
  await checkTabOverColumnButton("right");
});
