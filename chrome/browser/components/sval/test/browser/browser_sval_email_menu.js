/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * The page context menu's "Email <address>": it shows for an email address
 * selected as plain text, and hands a message to it to the `mailto:` handler.
 */

const { EMAIL_ITEM_ID } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEmailMenu.sys.mjs"
);
const { MockRegistrar } = ChromeUtils.importESModule(
  "resource://testing-common/MockRegistrar.sys.mjs"
);

const PAGE_HTML =
  "data:text/html,<p>Write to <span id=address>contactus@example.com</span>." +
  " <span id=words>Some words</span></p>" +
  "<a id=mail href='mailto:help@example.org'>help@example.org</a>";

/** The addresses handed to the `mailto:` handler, in order. */
const handed = [];

add_setup(async function () {
  // The dispatcher is where Gecko's external protocol service ends, so the
  // test sees each address there and no mail app opens.
  const cid = MockRegistrar.register(
    "@mozilla.org/content-dispatch-chooser;1",
    {
      handleURI(handler, uri) {
        handed.push(uri.spec);
      },
      QueryInterface: ChromeUtils.generateQI(["nsIContentDispatchChooser"]),
    }
  );
  registerCleanupFunction(() => MockRegistrar.unregister(cid));
});

/**
 * Selects the contents of `selector` in `browser`'s page and opens the page's
 * context menu on it.
 *
 * @param {object} browser
 * @param {string} selector
 * @returns {Promise<Element>} the menu, shown.
 */
async function menuOnSelection(browser, selector) {
  await SpecialPowers.spawn(browser, [selector], sel => {
    const range = content.document.createRange();
    range.selectNodeContents(content.document.querySelector(sel));
    const selection = content.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  const menu = document.getElementById("contentAreaContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  await BrowserTestUtils.synthesizeMouseAtCenter(
    selector,
    { type: "contextmenu", button: 2 },
    browser
  );
  await within(shown, 10_000, "the page's context menu showing");
  return menu;
}

/**
 * Closes `menu` without choosing anything.
 *
 * @param {Element} menu
 */
async function closeMenu(menu) {
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(hidden, 10_000, "the page's context menu hiding");
}

add_task(async function a_selected_address_opens_a_message_to_it() {
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: PAGE_HTML },
    async browser => {
      const menu = await menuOnSelection(browser, "#address");
      const item = document.getElementById(EMAIL_ITEM_ID);
      Assert.ok(!item.hidden, "the menu offers to email the address");
      Assert.equal(
        item.dataset.address,
        "contactus@example.com",
        "for that address"
      );

      const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
      menu.activateItem(item);
      await within(hidden, 10_000, "the page's context menu hiding");
      await TestUtils.waitForCondition(
        () => handed.length,
        "the address reaches the mailto handler"
      );
      Assert.deepEqual(handed.splice(0), ["mailto:contactus@example.com"]);
    }
  );
});

add_task(async function the_item_shows_only_for_a_plain_address() {
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: PAGE_HTML },
    async browser => {
      const item = document.getElementById(EMAIL_ITEM_ID);

      let menu = await menuOnSelection(browser, "#words");
      Assert.ok(item.hidden, "other selected text has no email item");
      await closeMenu(menu);

      menu = await menuOnSelection(browser, "#mail");
      Assert.ok(item.hidden, "nor does a mailto link, which has its own");
      await closeMenu(menu);
    }
  );
});
