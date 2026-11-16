/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * Firefox's page and text field menus show the key that runs each item's
 * command, as Sval's own menus do.
 */

/**
 * @param {Element} menu A `menupopup`.
 * @param {Function} open Opens it.
 * @returns {Promise<void>}
 */
async function opened(menu, open) {
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  await open();
  await within(shown, 10_000, `${menu.id || "the menu"} showing`);
}

/** @param {Element} menu An open `menupopup`. @returns {Promise<void>} */
async function closed(menu) {
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(hidden, 10_000, `${menu.id || "the menu"} hiding`);
}

/**
 * @param {Element} item A menu item.
 * @param {string} keyId The `<key>` it should name.
 */
function showsKey(item, keyId) {
  Assert.equal(item.getAttribute("key"), keyId, `${item.id} names ${keyId}`);
  Assert.equal(
    item.getAttribute("acceltext"),
    ShortcutUtils.prettifyShortcut(document.getElementById(keyId)),
    `${item.id} shows its key`
  );
}

add_task(async function the_page_menu_shows_the_keys() {
  await BrowserTestUtils.withNewTab(
    {
      gBrowser,
      url: "data:text/html,<p id=text>Some text</p><input id=field value=typed>",
    },
    async browser => {
      const menu = document.getElementById("contentAreaContextMenu");
      await opened(menu, () =>
        BrowserTestUtils.synthesizeMouseAtCenter(
          "#text",
          { type: "contextmenu", button: 2 },
          browser
        )
      );
      showsKey(document.getElementById("context-savepage"), "key_savePage");
      showsKey(document.getElementById("context-viewsource"), "key_viewSource");
      showsKey(document.getElementById("context-selectall"), "key_selectAll");
      await closed(menu);

      await opened(menu, () =>
        BrowserTestUtils.synthesizeMouseAtCenter(
          "#field",
          { type: "contextmenu", button: 2 },
          browser
        )
      );
      for (const [id, key] of [
        ["context-undo", "key_undo"],
        ["context-cut", "key_cut"],
        ["context-copy", "key_copy"],
        ["context-paste", "key_paste"],
        ["context-delete", "key_delete"],
      ]) {
        showsKey(document.getElementById(id), key);
      }
      await closed(menu);
    }
  );
});

add_task(async function the_address_bar_menu_shows_the_keys() {
  const field = gURLBar.inputField;
  const menu = gURLBar.querySelector("moz-input-box").menupopup;
  await opened(menu, () =>
    EventUtils.synthesizeMouseAtCenter(field, {
      type: "contextmenu",
      button: 2,
    })
  );
  const items = [...menu.querySelectorAll("menuitem[cmd]")];
  const byCommand = Object.fromEntries(
    items.map(item => [item.getAttribute("cmd"), item])
  );
  for (const [command, key] of [
    ["cmd_undo", "key_undo"],
    ["cmd_cut", "key_cut"],
    ["cmd_copy", "key_copy"],
    ["cmd_paste", "key_paste"],
    ["cmd_selectAll", "key_selectAll"],
  ]) {
    Assert.equal(
      byCommand[command].getAttribute("key"),
      key,
      `${command} names ${key}`
    );
    Assert.ok(
      byCommand[command].getAttribute("acceltext"),
      `${command} shows its key`
    );
  }
  await closed(menu);
});
