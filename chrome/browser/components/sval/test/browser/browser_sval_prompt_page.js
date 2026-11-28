/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A page's prompts one after another in one tab, from a file page's own
 * buttons, as a person presses them: each opens, answers with the right
 * value whether it is clicked, answered with Enter or dismissed with
 * Escape, and leaves the tab ready for the next. Each card fits what it
 * holds: no scrollbar on the card and every answer whole on screen, a long
 * message scrolling alone. The default answer has the focus, and the
 * message draws no focus ring.
 */

const PROMPTS_PAGE = "sval_prompts_page.html";

/** @returns {string} the test page's file: address. */
function pageURL() {
  const dir = getChromeDir(getResolvedURI(gTestPath));
  dir.append(PROMPTS_PAGE);
  // The test directory links to the source tree, and a file page shows at
  // the address of the file the link leads to.
  dir.normalize();
  return Services.io.newFileURI(dir).spec;
}

/**
 * Presses the page's button `id` with the mouse, and waits for the prompt
 * it opens, once a person can see it. The click's own promise settles only
 * when the prompt has closed, so it is handed back to the caller.
 *
 * @param {Element} browser
 * @param {string} id
 * @returns {Promise<{doc: Document, win: Window, clicked: Promise}>}
 */
async function pressForPrompt(browser, id) {
  const opened = PromptTestUtils.waitForPrompt(browser, {
    modalType: Services.prompt.MODAL_TYPE_CONTENT,
  });
  const clicked = BrowserTestUtils.synthesizeMouseAtCenter(
    `#${id}`,
    {},
    browser
  );
  const dialog = await within(opened, 10_000, `the ${id} prompt opening`);
  const doc = dialog.ui.button0.ownerDocument;
  const box = gBrowser
    .getTabDialogBox(browser)
    .getContentDialogManager()
    ._dialogs.find(shown => shown._frame.contentDocument === doc);
  await dialogShown(box, `the ${id} prompt showing`);
  await within(
    Promise.resolve(doc.mozSubdialogReady),
    10_000,
    `the ${id} prompt fitting its box`
  );
  return { doc, win: doc.defaultView, clicked };
}

/**
 * Asserts the card fits its frame: nothing scrolls on the page, and every
 * answer it shows lies whole inside the frame.
 *
 * @param {Document} doc
 * @param {string} what
 */
function assertFits(doc, what) {
  const page = doc.scrollingElement;
  Assert.lessOrEqual(
    page.scrollWidth,
    page.clientWidth,
    `${what}: the card does not scroll sideways`
  );
  Assert.lessOrEqual(
    page.scrollHeight,
    page.clientHeight,
    `${what}: nor up and down`
  );
  const { innerWidth, innerHeight } = doc.defaultView;
  for (const button of doc.querySelectorAll("sval-button[data-button]")) {
    if (!BrowserTestUtils.isVisible(button)) {
      continue;
    }
    const r = button.getBoundingClientRect();
    Assert.ok(
      r.top >= 0 &&
        r.left >= 0 &&
        r.bottom <= innerHeight + 0.5 &&
        r.right <= innerWidth + 0.5,
      `${what}: ${button.dataset.button} is whole on screen`
    );
  }
}

/**
 * Asserts the default answer has the focus and the message no ring.
 *
 * @param {Document} doc
 * @param {string} what
 */
async function assertFocus(doc, what) {
  const button = doc.querySelector("sval-button[data-default]");
  await TestUtils.waitForCondition(
    () => doc.activeElement === button,
    `${what}: the default answer has the focus`
  );
  Assert.ok(
    !doc.getElementById("infoBody").matches(":focus-visible"),
    `${what}: the message draws no focus ring`
  );
}

/**
 * The page's last answer line (`#out`).
 *
 * @param {Element} browser
 * @returns {Promise<string>}
 */
function said(browser) {
  return SpecialPowers.spawn(
    browser,
    [],
    () => content.document.getElementById("out").textContent
  );
}

const { PromptTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PromptTestUtils.sys.mjs"
);

add_task(async function every_button_of_the_page_asks_in_turn() {
  const tab = await openPage(pageURL());
  const browser = tab.linkedBrowser;

  const steps = [
    ["alert", "click accept", null],
    ["confirm", "click accept", "confirm: true"],
    ["confirm", "click cancel", "confirm: false"],
    ["prompt", "type", "prompt: Ada"],
    ["alert", "enter", null],
    ["confirm", "escape", "confirm: false"],
    ["confirm", "enter", "confirm: true"],
    ["prompt", "escape", "prompt: null"],
    ["prompt", "enter", "prompt: Sval"],
    ["long", "click accept", null],
    ["alert", "click accept", null],
  ];
  for (const [id, how, expected] of steps) {
    const what = `${id} by ${how}`;
    const { doc, win, clicked } = await pressForPrompt(browser, id);
    assertFits(doc, what);
    const body = doc.getElementById("infoBody");
    if (id === "long") {
      Assert.greater(
        body.scrollHeight,
        body.clientHeight,
        `${what}: the long message scrolls`
      );
    }
    if (id === "prompt") {
      await TestUtils.waitForCondition(
        () => doc.activeElement === doc.getElementById("loginTextbox"),
        `${what}: the field has the focus`
      );
    } else {
      await assertFocus(doc, what);
    }
    const dialog = doc.querySelector("dialog");
    if (how === "click accept" || how === "click cancel") {
      const button = dialog.getButton(how.split(" ")[1]);
      EventUtils.synthesizeMouseAtCenter(button, {}, win);
    } else if (how === "type") {
      const field = doc.getElementById("loginTextbox");
      field.select();
      EventUtils.sendString("Ada", win);
      EventUtils.synthesizeMouseAtCenter(dialog.getButton("accept"), {}, win);
    } else if (how === "enter") {
      EventUtils.synthesizeKey("KEY_Enter", {}, win);
    } else {
      EventUtils.synthesizeKey("KEY_Escape", {}, win);
    }
    await within(clicked, 10_000, `${what}: the page's click returning`);
    if (expected !== null) {
      Assert.equal(await said(browser), expected, `${what} answers`);
    }
    Assert.ok(
      !gBrowser.getTabDialogBox(browser).getContentDialogManager()._dialogs
        .length,
      `${what}: no prompt is left open`
    );
  }
});

add_task(async function leaving_the_page_asks_when_its_box_is_ticked() {
  await SpecialPowers.pushPrefEnv({
    set: [["dom.require_user_interaction_for_beforeunload", false]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const tab = await openPage(pageURL());
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [], () => {
    content.document.getElementById("leave").checked = true;
  });
  const opened = PromptTestUtils.waitForPrompt(browser, {
    modalType: Services.prompt.MODAL_TYPE_CONTENT,
    promptType: "confirmEx",
  });
  const left = browser.asyncPermitUnload();
  const dialog = await within(opened, 10_000, "the leave question");
  const doc = dialog.ui.button0.ownerDocument;
  const box = gBrowser
    .getTabDialogBox(browser)
    .getContentDialogManager()
    ._dialogs.find(shown => shown._frame.contentDocument === doc);
  await dialogShown(box, "the leave question showing");
  assertFits(doc, "the leave question");
  EventUtils.synthesizeMouseAtCenter(
    doc.querySelector("dialog").getButton("cancel"),
    {},
    doc.defaultView
  );
  const { permitUnload } = await within(left, 10_000, "the answer");
  Assert.ok(!permitUnload, "staying keeps the page");
  // So the task's end closes the tab without asking again.
  await SpecialPowers.spawn(browser, [], () => {
    content.document.getElementById("leave").checked = false;
  });
});

/**
 * Resizes the window to `width` by `height` and waits for it, and puts the
 * window's own size back when the task ends.
 *
 * @param {number} width
 * @param {number} height
 */
async function windowSize(width, height) {
  const { outerWidth, outerHeight } = window;
  atTaskEnd(async () => {
    const back = BrowserTestUtils.waitForEvent(window, "resize");
    window.resizeTo(outerWidth, outerHeight);
    await within(back, 10_000, "the window's size coming back");
  });
  const resized = BrowserTestUtils.waitForEvent(window, "resize");
  window.resizeTo(width, height);
  await within(resized, 10_000, "the window resizing");
}

/**
 * Asserts the prompt's message fits it: no scrolling, so no scrollbar.
 *
 * @param {Document} doc
 * @param {string} what
 */
function assertMessageFits(doc, what) {
  const body = doc.getElementById("infoBody");
  Assert.lessOrEqual(
    body.scrollHeight,
    body.clientHeight,
    `${what}: the message fits, with no scrollbar`
  );
}

add_task(async function a_short_message_never_scrolls() {
  await SpecialPowers.pushPrefEnv({
    set: [["dom.require_user_interaction_for_beforeunload", false]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  for (const size of [null, [600, 400]]) {
    if (size) {
      await windowSize(...size);
    }
    const at = size ? `at ${size.join("x")}` : "at the window's size";
    const tab = await openPage(pageURL());
    const browser = tab.linkedBrowser;
    for (const id of ["alert", "confirm"]) {
      const { doc, win, clicked } = await pressForPrompt(browser, id);
      assertMessageFits(doc, `${id} ${at}`);
      EventUtils.synthesizeKey("KEY_Escape", {}, win);
      await within(clicked, 10_000, `the ${id} closing`);
    }
    await SpecialPowers.spawn(browser, [], () => {
      content.document.getElementById("leave").checked = true;
    });
    const opened = PromptTestUtils.waitForPrompt(browser, {
      modalType: Services.prompt.MODAL_TYPE_CONTENT,
      promptType: "confirmEx",
    });
    const left = browser.asyncPermitUnload();
    const dialog = await within(opened, 10_000, "the leave question");
    const doc = dialog.ui.button0.ownerDocument;
    const box = gBrowser
      .getTabDialogBox(browser)
      .getContentDialogManager()
      ._dialogs.find(shown => shown._frame.contentDocument === doc);
    await dialogShown(box, "the leave question showing");
    assertMessageFits(doc, `the leave question ${at}`);
    doc.querySelector("dialog").getButton("cancel").click();
    await within(left, 10_000, "the leave question's answer");
    await SpecialPowers.spawn(browser, [], () => {
      content.document.getElementById("leave").checked = false;
    });
    BrowserTestUtils.removeTab(tab);
  }
});
