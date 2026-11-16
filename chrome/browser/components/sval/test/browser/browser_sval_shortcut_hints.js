/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * Where a command has a key, the menu bar item and the button that run it
 * name the key as `ShortcutUtils` spells it on this platform, and as the user
 * has it (`SvalShortcuts`).
 */

const { CustomKeys } = ChromeUtils.importESModule(
  "moz-src:///browser/components/customkeys/CustomKeys.sys.mjs"
);
const { FLOATING, SvalLauncher } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLauncher.sys.mjs"
);

registerCleanupFunction(() => CustomKeys.resetAll());

const pretty = id =>
  ShortcutUtils.prettifyShortcut(document.getElementById(id));

/** The File menu's popup, as it is about to show. */
function fileMenuShowing() {
  const popup = document.getElementById("menu_FilePopup");
  popup.dispatchEvent(new Event("popupshowing"));
  return popup;
}

/** The File menu holds the Launcher after New Peek, naming its key. */
add_task(async function the_file_menu_offers_the_launcher() {
  const popup = fileMenuShowing();
  const launcher = document.getElementById("sval-menu-launcher");
  Assert.equal(launcher.parentNode, popup, "the Launcher is in the File menu");
  Assert.equal(
    launcher.previousElementSibling.previousElementSibling.id,
    "sval-menu-new-peek",
    "after New Peek"
  );
  Assert.equal(launcher.getAttribute("key"), "focusURLBar");
  Assert.equal(
    launcher.getAttribute("acceltext"),
    pretty("focusURLBar"),
    "and names its key"
  );

  launcher.doCommand();
  await TestUtils.waitForCondition(
    () => gURLBar.hasAttribute(FLOATING),
    "the item opens the Launcher"
  );
  SvalLauncher.close(window, { focusPage: true });
  await TestUtils.waitForCondition(
    () => !gURLBar.hasAttribute(FLOATING),
    "and it closes"
  );
});

/** The header's and the panel's buttons name their keys in their tooltips. */
add_task(async function buttons_name_their_keys() {
  const history = document.getElementById("sval-history-button");
  history.dispatchEvent(new MouseEvent("mouseover"));
  Assert.ok(
    history.getAttribute("tooltiptext").includes(pretty("key_gotoHistory")),
    "the History button"
  );
  Assert.ok(history.getAttribute("aria-keyshortcuts"), "and for a reader");

  const newTab = SvalPanel._els.root.querySelector(".sval-newtab");
  newTab.dispatchEvent(new MouseEvent("mouseover"));
  Assert.ok(
    newTab.title.includes(pretty("key_newNavigatorTab")),
    "the panel's New tab button"
  );

  const tab = await openPage("https://example.com/");
  const favorite = document.getElementById("sval-favorite-button");
  await TestUtils.waitForCondition(
    () =>
      favorite.getAttribute("tooltiptext")?.includes(pretty("addBookmarkAsKb")),
    "the Favorite button names the key that adds"
  );
  BrowserTestUtils.removeTab(tab);
});

/** A key remapped in Settings › Keyboard shows on the next hover. */
add_task(async function a_tooltip_follows_a_remapped_key() {
  const history = document.getElementById("sval-history-button");
  CustomKeys.changeKey("key_gotoHistory", {
    modifiers: "accel,alt",
    key: "Y",
  });
  history.dispatchEvent(new MouseEvent("mouseover"));
  const changed = pretty("key_gotoHistory");
  Assert.ok(
    history.getAttribute("tooltiptext").includes(changed),
    "the changed key"
  );
  CustomKeys.clearKey("key_gotoHistory");
  history.dispatchEvent(new MouseEvent("mouseover"));
  const tooltip = history.getAttribute("tooltiptext");
  Assert.ok(tooltip && !tooltip.includes(changed), "no key");
  Assert.ok(
    !history.hasAttribute("aria-keyshortcuts"),
    "and none for a reader"
  );
  CustomKeys.resetKey("key_gotoHistory");
});
