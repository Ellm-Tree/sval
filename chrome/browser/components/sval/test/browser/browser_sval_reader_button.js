/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The header's reader button (`SvalHeader`), which Firefox's Reader View
 * drives under its own button's id: shown on an article, pressed in Reader
 * View.
 */

const ARTICLE =
  "https://example.com/browser/browser/components/sval/test/browser/sval_reader_article.html";
const NOT_ARTICLE =
  "https://example.com/browser/browser/components/sval/test/browser/sval_agent_page.html";

/**
 * @param {Window} win
 * @returns {Element} the window's reader button.
 */
function readerButton(win = window) {
  return win.document.getElementById("reader-mode-button");
}

add_task(async function a_page_that_is_not_an_article_shows_no_reader_button() {
  const tab = await openPage(NOT_ARTICLE);
  Assert.ok(
    !gBrowser.selectedBrowser.isArticle,
    "Firefox finds no article in the page"
  );
  Assert.ok(readerButton().hidden, "so the reader button is hidden");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function an_article_shows_the_reader_button() {
  const tab = await openPage(ARTICLE);
  const button = readerButton();
  await TestUtils.waitForCondition(
    () => !button.hidden,
    "the reader button shows on an article"
  );
  Assert.ok(!button.hasAttribute("readeractive"), "not pressed");
  await translated(button);
  Assert.equal(
    document.l10n.getAttributes(button).id,
    "reader-view-enter-button",
    "named to enter Reader View"
  );
  button.dispatchEvent(new MouseEvent("mouseover"));
  const key = document.getElementById("key_toggleReaderMode");
  Assert.stringContains(
    button.getAttribute("tooltiptext"),
    ShortcutUtils.prettifyShortcut(key),
    "the tooltip names the shortcut"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function the_reader_button_enters_and_leaves_reader_view() {
  const tab = await openPage(ARTICLE);
  const button = readerButton();
  await TestUtils.waitForCondition(() => !button.hidden, "the button shows");
  const browser = tab.linkedBrowser;

  button.click();
  await committed(browser, `about:reader?url=${encodeURIComponent(ARTICLE)}`);
  await TestUtils.waitForCondition(
    () => button.hasAttribute("readeractive"),
    "the button is pressed in Reader View"
  );
  Assert.ok(!button.hidden, "and still shows");
  await translated(button);
  Assert.equal(
    document.l10n.getAttributes(button).id,
    "reader-view-close-button",
    "named to close Reader View"
  );

  button.click();
  await committed(browser, ARTICLE);
  await TestUtils.waitForCondition(
    () => !button.hasAttribute("readeractive"),
    "the button is released on the page again"
  );
  BrowserTestUtils.removeTab(tab);
});
