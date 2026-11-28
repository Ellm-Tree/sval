/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Every prompt a modal box shows is Sval's prompt page
 * (`prompt-dialog.xhtml`), drawn as `sval-dialog` with `sval-button`
 * answers: a page's `alert`, `confirm` and `prompt`, the question before a
 * page is left, and a sign-in. Each answers as toolkit's common dialog does:
 * its buttons, Enter, Escape and its fields set the prompt's result. Over a
 * window that shows what is behind it, a prompt is frosted as every dialog
 * is; over a window at no transparency it is solid.
 *
 * The window shows what is behind it as it does on macOS, whatever the
 * platform the test runs on. Headless Gecko draws no backdrop filter, so
 * the blur is read from the box's computed style.
 */

const { PromptTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PromptTestUtils.sys.mjs"
);
const { SvalColor } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalColor.sys.mjs"
);

const PROMPT_PAGE = "chrome://browser/content/sval/prompt-dialog.xhtml";
const COLOR = "blue";

add_setup(async function a_window_that_can_see_through() {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  const own = Object.getOwnPropertyDescriptor(SvalPanel, "seeThrough");
  SvalPanel.seeThrough = () =>
    SvalColor.seeThroughMaterial("macosx", query => matchMedia(query).matches);
  registerCleanupFunction(() => {
    if (own) {
      Object.defineProperty(SvalPanel, "seeThrough", own);
    } else {
      delete SvalPanel.seeThrough;
    }
    return within(SvalPanel.refresh(), 10_000, "the panel redrawing");
  });
});

/**
 * Gives the Workspace this window shows {@link COLOR} at `transparency`. The
 * file's end puts the document back.
 *
 * @param {number} transparency
 */
async function tintWindow(transparency) {
  await SvalPanel.engine.mutate({
    kind: "setAppearance",
    id: SvalWindowWorkspace.of(window).id,
    color: COLOR,
    emoji: null,
    transparency,
    now: Date.now(),
  });
  await within(SvalPanel.refresh(), 10_000, "the panel redrawing");
  await TestUtils.waitForCondition(
    () =>
      SvalPanel._tintArgs?.[0] === COLOR &&
      SvalPanel._tintArgs[1] === transparency,
    "the window wears the look"
  );
}

/**
 * Waits for a page prompt of `promptType` in `browser` and the card it
 * draws, once a person can see it.
 *
 * @param {Element} browser
 * @param {string} promptType
 * @returns {Promise<{dialog: object, doc: Document, card: Element}>}
 */
async function pagePrompt(browser, promptType) {
  const dialog = await within(
    PromptTestUtils.waitForPrompt(browser, {
      modalType: Services.prompt.MODAL_TYPE_CONTENT,
      promptType,
    }),
    10_000,
    `the page's ${promptType}`
  );
  const doc = dialog.ui.button0.ownerDocument;
  const box = gBrowser
    .getTabDialogBox(browser)
    .getContentDialogManager()
    ._dialogs.find(shown => shown._frame.contentDocument === doc);
  await dialogShown(box, `the page's ${promptType} showing`);
  return { dialog, doc, card: doc.querySelector("sval-dialog") };
}

/**
 * Calls the page's `alert`, `confirm` or `prompt` with `args` and answers
 * what the page got back, once the prompt it opens has been answered.
 *
 * @param {Element} browser
 * @param {string} name
 * @param {...string} args
 * @returns {Promise} what the page saw.
 */
function inPage(browser, name, ...args) {
  return SpecialPowers.spawn(browser, [name, args], (fn, given) =>
    content[fn](...given)
  );
}

/**
 * The answers `doc` shows, by their `data-button`.
 *
 * @param {Document} doc
 * @returns {string[]}
 */
function shownAnswers(doc) {
  return [...doc.querySelectorAll("sval-button[data-button]")]
    .filter(button => BrowserTestUtils.isVisible(button))
    .map(button => button.dataset.button);
}

add_task(async function a_page_confirm_is_a_sval_dialog() {
  const tab = await openPage("https://example.com/");
  const browser = tab.linkedBrowser;
  for (const [press, expected] of [
    ["accept", true],
    ["cancel", false],
  ]) {
    const shown = pagePrompt(browser, "confirm");
    const answer = inPage(browser, "confirm", "Go on?");
    const { dialog, doc, card } = await shown;
    Assert.equal(doc.documentURI, PROMPT_PAGE, "Sval's prompt page");
    Assert.ok(card, "drawn as sval-dialog");
    Assert.equal(
      dialog.ui.button0.localName,
      "sval-button",
      "with sval-button answers"
    );
    Assert.deepEqual(
      shownAnswers(doc),
      ["cancel", "accept"],
      "Cancel, then OK"
    );
    Assert.equal(
      doc.getElementById("infoBody").textContent,
      "Go on?",
      "the page's message"
    );
    Assert.equal(
      doc.getElementById("titleText").textContent,
      "example.com",
      "under the site that asks"
    );
    doc.querySelector("dialog").getButton(press).click();
    Assert.equal(
      await within(answer, 10_000, "the page's answer"),
      expected,
      `${press} answers ${expected}`
    );
  }
});

add_task(async function a_page_alert_has_one_answer() {
  const tab = await openPage("https://example.com/");
  const browser = tab.linkedBrowser;
  const shown = pagePrompt(browser, "alert");
  const answer = inPage(browser, "alert", "Saved.\nThat's all.");
  const { doc } = await shown;
  Assert.deepEqual(shownAnswers(doc), ["accept"], "OK alone");
  Assert.equal(
    doc.getElementById("infoBody").textContent,
    "Saved.\nThat's all.",
    "the message with its line break"
  );
  Assert.equal(
    getComputedStyle(doc.getElementById("infoBody")).whiteSpace,
    "pre-wrap",
    "which shows"
  );
  doc.querySelector("dialog").getButton("accept").click();
  await within(answer, 10_000, "the alert closing");
});

add_task(async function a_page_prompt_answers_with_its_field() {
  const tab = await openPage("https://example.com/");
  const browser = tab.linkedBrowser;

  let shown = pagePrompt(browser, "prompt");
  let answer = inPage(browser, "prompt", "Your name?", "Ada");
  let { doc } = await shown;
  const field = doc.getElementById("loginTextbox");
  Assert.ok(BrowserTestUtils.isVisible(field), "the field shows");
  Assert.equal(field.value, "Ada", "holding the page's default");
  Assert.ok(
    BrowserTestUtils.isHidden(doc.getElementById("loginLabel")),
    "named by the message, with no label of its own"
  );
  await TestUtils.waitForCondition(
    () => doc.activeElement === field,
    "the field has the focus"
  );
  field.select();
  EventUtils.sendString("Grace", doc.defaultView);
  EventUtils.synthesizeKey("KEY_Enter", {}, doc.defaultView);
  Assert.equal(
    await within(answer, 10_000, "the page's answer"),
    "Grace",
    "Enter answers with what was typed"
  );

  shown = pagePrompt(browser, "prompt");
  answer = inPage(browser, "prompt", "Your name?", "Ada");
  ({ doc } = await shown);
  EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
  Assert.equal(
    await within(answer, 10_000, "the page's answer"),
    null,
    "Escape answers as Cancel"
  );
});

add_task(async function leaving_a_page_asks_first() {
  await SpecialPowers.pushPrefEnv({
    set: [["dom.require_user_interaction_for_beforeunload", false]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const tab = await openPage("https://example.com/");
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [], () => {
    content.addEventListener("beforeunload", event => event.preventDefault());
  });
  const shown = pagePrompt(browser, "confirmEx");
  const left = browser.asyncPermitUnload();
  const { dialog, doc } = await shown;
  Assert.ok(dialog.args.inPermitUnload, "the question before leaving");
  Assert.equal(doc.documentURI, PROMPT_PAGE, "is Sval's prompt page");
  Assert.deepEqual(
    shownAnswers(doc),
    ["cancel", "accept"],
    "staying and leaving"
  );
  doc.querySelector("dialog").getButton("cancel").click();
  const { permitUnload } = await within(left, 10_000, "the answer");
  Assert.ok(!permitUnload, "staying keeps the page");
});

add_task(async function a_sign_in_asks_for_both_fields() {
  const asked = Services.prompt.asyncPromptUsernameAndPassword(
    window.browsingContext,
    Services.prompt.MODAL_TYPE_INTERNAL_WINDOW,
    "Sign in",
    "example.com asks you to sign in.",
    { value: "" },
    { value: "" }
  );
  const { doc } = await openedSvalDialog();
  const card = doc.querySelector("sval-dialog");
  Assert.equal(doc.documentURI, PROMPT_PAGE, "Sval's prompt page");
  Assert.equal(card.icon, "key", "with the key on its card");
  for (const id of ["loginLabel", "password1Label"]) {
    await TestUtils.waitForCondition(
      () => doc.getElementById(id).textContent,
      `${id} is named`
    );
  }
  doc.getElementById("loginTextbox").value = "ada";
  doc.getElementById("password1Textbox").value = "pass-marker";
  doc.querySelector("dialog").getButton("accept").click();
  const result = await within(asked, 10_000, "the sign-in's answer");
  Assert.ok(result.getProperty("ok"), "OK signs in");
  Assert.equal(result.getProperty("user"), "ada", "with the name");
  Assert.equal(result.getProperty("pass"), "pass-marker", "and the password");
});

/**
 * Opens a window-modal confirm and waits for its card.
 *
 * @returns {Promise<{answer: Promise, doc: Document, card: Element,
 *   box: Element}>}
 */
async function windowConfirm() {
  const answer = Services.prompt.asyncConfirm(
    window.browsingContext,
    Services.prompt.MODAL_TYPE_INTERNAL_WINDOW,
    "Remove this engine?",
    "Its keyword stops working."
  );
  const { doc, dialog: card } = await openedSvalDialog();
  const box = doc.defaultView.frameElement.closest(".dialogBox");
  return { answer, doc, card, box };
}

add_task(async function over_a_see_through_window_a_prompt_is_frosted() {
  await tintWindow(0.5);
  const { answer, doc, card, box } = await windowConfirm();
  Assert.equal(doc.documentURI, PROMPT_PAGE, "Sval's prompt page");
  Assert.ok(card.hasAttribute("frosted"), "the card is frosted");
  Assert.equal(
    getComputedStyle(box).backdropFilter,
    "blur(24px)",
    "the box blurs the window under it"
  );
  doc.querySelector("dialog").getButton("cancel").click();
  await within(answer, 10_000, "the prompt's answer");
});

add_task(async function at_no_transparency_a_prompt_is_solid() {
  await tintWindow(0);
  const { answer, doc, card, box } = await windowConfirm();
  Assert.ok(!card.hasAttribute("frosted"), "the card is solid");
  Assert.equal(getComputedStyle(box).backdropFilter, "none", "with no blur");
  doc.querySelector("dialog").getButton("accept").click();
  const result = await within(answer, 10_000, "the prompt's answer");
  Assert.ok(result.getProperty("ok"), "OK answers yes");
});

add_task(async function the_message_can_be_copied() {
  const tab = await openPage("https://example.com/");
  const browser = tab.linkedBrowser;
  const shown = pagePrompt(browser, "alert");
  const answer = inPage(browser, "alert", "copy-marker text");
  const { doc } = await shown;
  const win = doc.defaultView;
  const body = doc.getElementById("infoBody");
  const menu = doc.getElementById("contentAreaContextMenu");
  await translated(...menu.children);

  const openMenu = async () => {
    const opened = BrowserTestUtils.waitForPopupEvent(menu, "shown");
    EventUtils.synthesizeMouseAtCenter(body, { type: "contextmenu" }, win);
    await within(opened, 10_000, "the message's menu");
  };
  await openMenu();
  const copy = doc.getElementById("context-copy");
  Assert.ok(copy.disabled, "Copy waits for a selection");
  let closed = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(doc.getElementById("context-selectall"));
  await within(closed, 10_000, "the menu closing");
  Assert.equal(
    win.getSelection().toString(),
    "copy-marker text",
    "Select All selects the message"
  );

  await openMenu();
  Assert.ok(!copy.disabled, "Copy offers the selection");
  closed = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  await within(
    SimpleTest.promiseClipboardChange("copy-marker text", () =>
      menu.activateItem(copy)
    ),
    10_000,
    "Copy filling the clipboard"
  );
  await within(closed, 10_000, "the menu closing");

  win.getSelection().selectAllChildren(body);
  win.getSelection().modify("extend", "backward", "word");
  await within(
    SimpleTest.promiseClipboardChange("copy-marker ", () =>
      EventUtils.synthesizeKey("c", { accelKey: true }, win)
    ),
    10_000,
    "the copy key filling the clipboard"
  );
  doc.querySelector("dialog").getButton("accept").click();
  await within(answer, 10_000, "the alert closing");
});

add_task(async function an_access_key_presses_its_button() {
  // Underlined on every platform, and pressed with Control and Alt, a pair
  // no browser window shortcut takes.
  await SpecialPowers.pushPrefEnv({
    set: [
      ["ui.key.menuAccessKey", 18],
      ["ui.key.chromeAccess", 6],
    ],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const prompts = Services.prompt;
  const answer = prompts.asyncConfirmEx(
    window.browsingContext,
    prompts.MODAL_TYPE_INTERNAL_WINDOW,
    "Go on?",
    "The engine is removed.",
    prompts.BUTTON_TITLE_IS_STRING * prompts.BUTTON_POS_0 +
      prompts.BUTTON_TITLE_CANCEL * prompts.BUTTON_POS_1,
    "&Go ahead",
    null,
    null,
    null,
    false
  );
  const { doc } = await openedSvalDialog();
  const go = doc.querySelector("dialog").getButton("accept");
  Assert.equal(go.accessKey, "G", "the button takes the label's access key");
  const inner = go.shadowRoot.querySelector("button");
  Assert.equal(inner.getAttribute("accesskey"), "G", "on its inner button");
  Assert.equal(
    inner.querySelector(".accesskey")?.textContent,
    "G",
    "with its letter underlined"
  );
  Assert.ok(!go.hasAttribute("accesskey"), "and none left on the element");
  EventUtils.synthesizeKey(
    "g",
    { ctrlKey: true, altKey: true },
    doc.defaultView
  );
  const result = await within(answer, 10_000, "the prompt's answer");
  Assert.equal(
    result.getProperty("buttonNumClicked"),
    0,
    "it presses Go ahead"
  );
});

/**
 * Asserts `box` stands at least 16px inside `area` on every side, and
 * `top` px below its top edge when `top` is given.
 *
 * @param {Element} box A modal box (`.dialogBox`).
 * @param {DOMRect} area The area it opens over.
 * @param {string} what
 * @param {number} [top]
 */
function assertInset(box, area, what, top) {
  const shown = box.getBoundingClientRect();
  for (const [gap, side] of [
    [shown.top - area.top, "top"],
    [shown.left - area.left, "left"],
    [area.right - shown.right, "right"],
    [area.bottom - shown.bottom, "bottom"],
  ]) {
    Assert.greaterOrEqual(
      Math.round(gap),
      16,
      `${what}: 16px or more from the ${side} edge (${gap}px)`
    );
  }
  if (top !== undefined) {
    Assert.equal(
      Math.round(shown.top - area.top),
      top,
      `${what}: its top ${top}px below the area's`
    );
  }
}

add_task(async function every_prompt_stands_inside_the_area_it_opens_over() {
  const tab = await openPage("https://example.com/");
  const browser = tab.linkedBrowser;
  const prompts = Services.prompt;

  // A tab's prompt, as a site's sign-in opens, stands below the header.
  const tabAsked = prompts.asyncAlert(
    browser.browsingContext,
    prompts.MODAL_TYPE_TAB,
    "Sign in",
    "example.com asks you to sign in."
  );
  const manager = gBrowser.getTabDialogBox(browser).getTabDialogManager();
  await TestUtils.waitForCondition(
    () => manager._dialogs[0]?._frame.contentWindow?.Dialog,
    "the tab's prompt opens"
  );
  let dialog = manager._dialogs[0];
  await dialogShown(dialog, "the tab's prompt showing");
  assertInset(
    dialog._box,
    browser.getBoundingClientRect(),
    "a tab's prompt",
    16
  );
  dialog._frame.contentDocument.querySelector("dialog").acceptDialog();
  await within(tabAsked, 10_000, "the tab's prompt closing");

  // A page's own prompt, centred over the page.
  const shown = pagePrompt(browser, "alert");
  const answer = inPage(browser, "alert", "Inset.");
  const { doc } = await shown;
  dialog = gBrowser
    .getTabDialogBox(browser)
    .getContentDialogManager()
    ._dialogs.find(d => d._frame.contentDocument === doc);
  assertInset(dialog._box, browser.getBoundingClientRect(), "a page's prompt");
  doc.querySelector("dialog").acceptDialog();
  await within(answer, 10_000, "the page's prompt closing");

  // A window's prompt, 16px below the chrome above the page.
  const windowAsked = prompts.asyncAlert(
    window.browsingContext,
    prompts.MODAL_TYPE_INTERNAL_WINDOW,
    "Saved",
    "Inset."
  );
  const { doc: windowDoc } = await openedSvalDialog();
  const box = windowDoc.defaultView.frameElement.closest(".dialogBox");
  const page = browser.getBoundingClientRect();
  assertInset(
    box,
    {
      top: page.top,
      left: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
    },
    "a window's prompt",
    16
  );
  windowDoc.querySelector("dialog").acceptDialog();
  await within(windowAsked, 10_000, "the window's prompt closing");
});
