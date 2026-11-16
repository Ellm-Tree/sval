/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * What the feedback form's browser tests share: the popover's parts as a
 * user meets them, a collector on localhost behind
 * `browser.sval.support.reportURL`, crash folders moved to temporary ones,
 * and the end of a draft the form keeps across tasks. Each file loads this
 * with `loadSubScript` into its own scope.
 */

/* exported appDataInTemp, feedbackForm, feedbackButton, feedbackShown, formParts, feedbackServer, discardFeedbackDraft */

const { HttpServer } = ChromeUtils.importESModule(
  "resource://testing-common/httpd.sys.mjs"
);

/**
 * Points `CrashReports`' folders at empty temporary ones for the task, so the
 * report the form builds never reads the user's own crash files. Answers the
 * folders' paths, for a task that puts crash files of its own there.
 * `CrashReports.sys.mjs` resolves its folders from `UAppData` once, when it
 * loads, so moving `UAppData` afterwards would not reach it.
 */
async function appDataInTemp() {
  const { CrashReports } = ChromeUtils.importESModule(
    "resource://gre/modules/CrashReports.sys.mjs"
  );
  const { pendingDir, submittedDir } = CrashReports;
  const pending = await makeTempDir("sval-feedback-pending");
  const submitted = await makeTempDir("sval-feedback-submitted");
  CrashReports.pendingDir = await IOUtils.getFile(pending);
  CrashReports.submittedDir = await IOUtils.getFile(submitted);
  atTaskEnd(() => {
    CrashReports.pendingDir = pendingDir;
    CrashReports.submittedDir = submittedDir;
  });
  return { pending, submitted };
}

function feedbackForm(win = window) {
  return win.document.querySelector(".sval-feedback");
}

function feedbackButton(win = window) {
  return win.document.querySelector(".sval-feedback-button");
}

/**
 * Waits for the form to show, with its report's rows.
 *
 * @param {Window} [win]
 * @returns {Promise<Element>} the popover.
 */
async function feedbackShown(win = window) {
  await TestUtils.waitForCondition(() => {
    const form = feedbackForm(win);
    return form && !form.hidden && form.querySelector(".sval-feedback-row");
  }, "the feedback form shows its report");
  return feedbackForm(win);
}

/**
 * @param {Element} form
 * @returns {object} the parts a test presses and reads.
 */
function formParts(form) {
  const actions = [...form.querySelectorAll(".sval-feedback-action")];
  const find = label => actions.find(button => button.textContent === label);
  return {
    message: form.querySelector(".sval-feedback-message"),
    email: form.querySelector(".sval-feedback-email"),
    context: form.querySelector(".sval-feedback-context"),
    cancel: find("Cancel"),
    send: form.querySelector(".sval-feedback-send"),
    close: find("Close"),
    failure: form.querySelector(".sval-feedback-failure"),
    reference: form.querySelector(".sval-feedback-reference"),
  };
}

/**
 * A collector on localhost, which the pref points the form at for the task.
 * It answers `answer.status`, with `answer.reference` on a 200.
 *
 * @returns {Promise<object>} `{ status, reference, received }`, which the test
 *   may change between sends.
 */
async function feedbackServer() {
  const answer = { status: 200, reference: "F-0042", received: 0 };
  const server = new HttpServer();
  server.registerPathHandler("/report", (request, response) => {
    answer.received++;
    response.setStatusLine(request.httpVersion, answer.status, "");
    if (answer.status === 200) {
      response.setHeader("Content-Type", "application/json");
      response.write(JSON.stringify({ reference: answer.reference }));
    }
  });
  server.start(-1);
  await SpecialPowers.pushPrefEnv({
    set: [
      [
        "browser.sval.support.reportURL",
        `http://localhost:${server.identity.primaryPort}/report`,
      ],
    ],
  });
  atTaskEnd(async () => {
    await SpecialPowers.popPrefEnv();
    await new Promise(resolve => server.stop(resolve));
  });
  return answer;
}

/**
 * Ends the draft the form keeps until Sval quits, as Cancel does, so the
 * next task starts from an empty form.
 *
 * @param {Window} [win]
 */
async function discardFeedbackDraft(win = window) {
  const form = feedbackForm(win);
  if (!form || form.hidden) {
    feedbackButton(win).click();
  }
  formParts(await feedbackShown(win)).cancel.click();
}
