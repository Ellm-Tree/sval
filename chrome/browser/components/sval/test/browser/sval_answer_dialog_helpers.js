/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * What the answer_dialog test files share: how to read a page's answer and
 * the dialogs up in its tab. Each file loads this with `loadSubScript` into
 * its own scope.
 */

/* exported answerIn, nextAnswerIn, dialogsUp, bodyOf, CONFIRM */

/**
 * @param {object} browser
 * @returns {Promise<string|undefined>} What the page put in its body's
 *   `data-answer`.
 */
const answerIn = browser =>
  SpecialPowers.spawn(browser, [], () => content.document.body.dataset.answer);

/**
 * Waits for the page's answer to change from `before`, and returns it.
 *
 * The page writes its answer when `confirm` or `prompt` returns, which is
 * when `PromptParent` replies to it, and it replies only once the dialog's
 * frame has unloaded (`SubDialog`'s `closedPromise`). Clicking the dialog's
 * button, and `answer_dialog` with it, return before that, so the answer is
 * waited for itself.
 *
 * @param {object} browser The browser or frame whose page asked.
 * @param {string} [before] What it held before this dialog was answered.
 * @returns {Promise<string>}
 */
async function nextAnswerIn(browser, before = undefined) {
  let answer;
  await TestUtils.waitForCondition(async () => {
    answer = await answerIn(browser);
    return answer !== before;
  }, "the page has its answer");
  return answer;
}

/**
 * @param {object} browser
 * @returns {number} How many dialogs are up in `browser`'s tab.
 */
const dialogsUp = browser =>
  browser.documentGlobal.gBrowser
    .getTabDialogBox(browser)
    .getContentDialogManager().dialogs.length;

/**
 * @param {object} result A raw tool result.
 * @returns {object} Its JSON body.
 */
const bodyOf = result => JSON.parse(result.content[0].text);

const CONFIRM =
  "document.body.dataset.answer = String(confirm('Delete everything?'))";
