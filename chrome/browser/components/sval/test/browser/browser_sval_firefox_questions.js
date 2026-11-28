/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The questions Firefox's chrome asks, as Sval asks them. Reloading a page
 * that came from a form asks before sending it again, under the question as
 * its title rather than the page's address.
 */

const { PromptTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PromptTestUtils.sys.mjs"
);

const POST_TARGET =
  "https://example.com/browser/browser/components/sval/test/browser/sval_form_post.sjs";

add_task(async function the_resend_question_is_its_own_title() {
  const tab = await openPage("https://example.com/");
  const browser = tab.linkedBrowser;
  const sent = BrowserTestUtils.browserLoaded(browser, false, POST_TARGET);
  await SpecialPowers.spawn(browser, [POST_TARGET], target => {
    const form = content.document.createElement("form");
    form.method = "POST";
    form.action = target;
    content.document.body.append(form);
    form.submit();
  });
  await within(sent, 10_000, "the form's page");

  const shown = PromptTestUtils.waitForPrompt(browser, {
    modalType: Services.prompt.MODAL_TYPE_CONTENT,
    promptType: "confirmEx",
  });
  gBrowser.reload();
  const dialog = await within(shown, 10_000, "the resend question");
  const title = dialog.ui.infoTitle;
  await within(
    TestUtils.waitForCondition(() => title.textContent),
    10_000,
    "the title"
  );
  // The title `PromptCollection.confirmRepost` reads.
  const app = Services.strings.createBundle(
    "chrome://global/locale/appstrings.properties"
  );
  Assert.equal(
    title.textContent,
    app.GetStringFromName("confirmRepostTitle"),
    "the question is the title"
  );

  await within(
    PromptTestUtils.handlePrompt(dialog, { buttonNumClick: 1 }),
    10_000,
    "the question closing on Cancel"
  );
});

add_task(async function not_now_on_the_f7_question_leaves_the_cursor_off() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["accessibility.browsewithcaret", false],
      ["accessibility.browsewithcaret_shortcut.enabled", true],
      ["accessibility.warn_on_browsewithcaret", true],
    ],
  });
  await openPage("https://example.com/");
  EventUtils.synthesizeKey("KEY_F7");
  // The question is a window-modal common dialog, read from the window's
  // dialog box.
  const doc = await within(
    TestUtils.waitForCondition(() => {
      const shown = window.gDialogBox.dialog?._frame?.contentDocument;
      return shown?.getElementById("infoBody")?.textContent ? shown : null;
    }),
    10_000,
    "the F7 question"
  );
  doc.querySelector("dialog").getButton("cancel").click();
  await within(
    TestUtils.waitForCondition(() => !window.gDialogBox.isOpen),
    10_000,
    "the F7 question closing on Not Now"
  );
  Assert.ok(
    !Services.prefs.getBoolPref("accessibility.browsewithcaret"),
    "Not Now leaves the text cursor off"
  );
});
