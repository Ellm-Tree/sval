/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * No sheet of Firefox's reaches a Sval dialog's card or its buttons.
 * `SubDialog` injects `in-content/common.css` into a dialog only when
 * `SvalPageStyle.styleDialog` says it is not Sval's own
 * (`subdialog-sval-dialog-frame.patch`), and Sval's pages link no
 * `global.css`. The card and its buttons draw in their shadow roots, so
 * even with both sheets loaded into the page they look the same.
 */

const { openSvalDialog } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalDialog.sys.mjs"
);

registerCleanupFunction(closeLeftoverDialog);

const FIREFOX_SHEETS = [
  "chrome://global/skin/in-content/common.css",
  "chrome://global/skin/global.css",
];

/**
 * What changes with the sheets without a rule of theirs reaching the card:
 * the properties the card inherits from the page's root, which
 * `in-content/common.css` sets, and the sizes the card's light-DOM
 * content gives it, which a page sheet styles as it styles any of its
 * content.
 */
const FOLLOWS = [
  "accent-color",
  "color-scheme",
  "block-size",
  "height",
  "perspective-origin",
  "transform-origin",
];

/**
 * @param {CSSRule} rule
 * @returns {CSSStyleSheet|null} The sheet the rule is in, or the sheet that
 *   imports that one, at the top.
 */
function topSheetOf(rule) {
  let sheet = rule.parentStyleSheet;
  while (sheet?.ownerRule) {
    sheet = sheet.ownerRule.parentStyleSheet;
  }
  return sheet;
}

/**
 * Every computed property of each element, by a name for it.
 *
 * @param {Map<string, Element>} elements
 * @returns {object}
 */
function stylesOf(elements) {
  const out = {};
  for (const [name, el] of elements) {
    const style = el.documentGlobal.getComputedStyle(el);
    out[name] = Object.fromEntries(
      [...style].map(property => [property, style.getPropertyValue(property)])
    );
  }
  return out;
}

add_task(async function a_sval_dialog_page_takes_no_firefox_sheet() {
  const answer = openSvalDialog(window, {
    title: "Rename this Workspace?",
    body: "Its tabs stay where they are.",
    icon: "pencil",
    closeButton: true,
    extra: "Keep tabs",
    primary: "Rename",
  });
  const { doc, dialog } = await openedSvalDialog();
  const linked = [...doc.styleSheets].map(sheet => sheet.href);
  for (const sheet of FIREFOX_SHEETS) {
    Assert.ok(!linked.includes(sheet), `the page has no ${sheet}`);
  }

  const parts = new Map([
    ["the card", dialog],
    ["the head", dialog.shadowRoot.querySelector('[part~="head"]')],
    ["the icon", dialog.shadowRoot.querySelector('[part~="icon"]')],
    ["the ✕", dialog.shadowRoot.querySelector(".close")],
    [
      "the row of answers",
      dialog.shadowRoot.querySelector('[part~="actions"]'),
    ],
  ]);
  for (const button of dialog.querySelectorAll("sval-button")) {
    parts.set(
      `the ${button.dataset.button} button`,
      button.shadowRoot.querySelector("button")
    );
  }
  const off = stylesOf(parts);
  const utils = doc.defaultView.windowUtils;
  for (const sheet of FIREFOX_SHEETS) {
    utils.loadSheetUsingURIString(sheet, utils.AUTHOR_SHEET);
  }
  const on = stylesOf(parts);
  for (const [name, style] of Object.entries(off)) {
    const changed = Object.keys(style).filter(
      property =>
        style[property] !== on[name][property] && !FOLLOWS.includes(property)
    );
    Assert.deepEqual(
      changed,
      [],
      `with Firefox's sheets loaded, nothing of ${name} changes`
    );
  }
  for (const [name, el] of parts) {
    const from = InspectorUtils.getMatchingCSSRules(el)
      .map(rule => topSheetOf(rule)?.href)
      .filter(href => FIREFOX_SHEETS.includes(href));
    Assert.deepEqual(from, [], `no rule of Firefox's sheets matches ${name}`);
  }
  for (const sheet of FIREFOX_SHEETS) {
    utils.removeSheetUsingURIString(sheet, utils.AUTHOR_SHEET);
  }
  EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
  await within(answer, 10_000, "the answer");
});
