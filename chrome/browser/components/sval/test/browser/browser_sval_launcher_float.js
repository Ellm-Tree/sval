/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * The Launcher's float (launcher spec §3, §7): ⌘L (Ctrl+L), Alt+D and Open
 * Location float the address bar over the page with the address selected,
 * also when it is already focused in place, while the toolbar keeps showing
 * the address; a click on the field and F6 open it in place. Escape, a
 * click on the scrim and a pick return it to the toolbar, with focus on the
 * page.
 */

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);

add_setup(failOnConsoleErrors);

add_setup(async function () {
  await PlacesUtils.history.clear();
  registerCleanupFunction(async () => {
    await UrlbarTestUtils.promisePopupClose(window);
    gURLBar.handleRevert();
    await PlacesUtils.history.clear();
  });
});

/** Whether the address bar floats, its close's fade done. */
function floating() {
  return gURLBar.hasAttribute("sval-launcher-floating");
}

/**
 * Waits for the address bar to float, or to be back in the toolbar.
 *
 * @param {boolean} expected
 * @param {string} what
 */
async function untilFloating(expected, what) {
  await TestUtils.waitForCondition(() => floating() === expected, what);
}

/**
 * A tab showing a page, its content focused.
 *
 * @returns {Promise<object>} the tab.
 */
async function pageTab() {
  // With nothing typed the Launcher lists only tabs this device has used
  // (`recentTabs` `onlyUsed`), and its list opens only with a row to show.
  const first = SvalPanel.observer.nodeIdFor(gBrowser.selectedTab);
  Assert.ok(first, "the window's first tab is in the Workspace");
  SvalPanel.settings.setLastActive(first, Date.now());
  atTaskEnd(() => SvalPanel.settings.forgetLastActive(first));
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE),
    10_000,
    "a page's tab"
  );
  await within(SimpleTest.promiseFocus(window), 10_000, "the window's focus");
  gBrowser.selectedBrowser.focus();
  return tab;
}

/** Presses the Launcher's key. */
function pressLauncherKey() {
  EventUtils.synthesizeKey("l", { accelKey: true });
}

/**
 * Floats the Launcher with its key and waits for its list.
 */
async function floatIt() {
  const shown = UrlbarTestUtils.promisePopupOpen(window, pressLauncherKey);
  await within(shown, 10_000, "the Launcher's list");
  await untilFloating(true, "the address bar floats");
}

/**
 * The address bar floats centred over the page and below the toolbar, the
 * scrim covers the page and not the toolbar, and the toolbar's pill still
 * shows the page's address.
 */
function assertFloatsOverThePage() {
  const area = gBrowser.tabbox.getBoundingClientRect();
  const card = gURLBar.getBoundingClientRect();
  const toolbox = gNavToolbox.getBoundingClientRect();
  Assert.lessOrEqual(
    Math.abs(card.left + card.width / 2 - (area.left + area.width / 2)),
    1,
    "the card is centred over the page"
  );
  Assert.greater(card.top, toolbox.bottom, "the card is below the toolbar");
  const scrim = document.getElementById("sval-launcher-scrim");
  Assert.ok(scrim.checkVisibility(), "the scrim shows");
  const covered = scrim.getBoundingClientRect();
  Assert.greaterOrEqual(
    Math.round(covered.top),
    Math.round(toolbox.bottom),
    "the scrim leaves the toolbar uncovered"
  );
  Assert.deepEqual(
    [covered.left, covered.width, covered.height].map(Math.round),
    [area.left, area.width, area.height].map(Math.round),
    "the scrim covers the page"
  );
  const address = document.getElementById("sval-launcher-address");
  Assert.ok(address.checkVisibility(), "the toolbar shows the address");
  Assert.equal(address.textContent, "example.com", "the page's host");
}

/** Focus is on the page, with the address bar back in the toolbar. */
function assertBackInTheToolbar() {
  Assert.ok(!floating(), "the address bar is in the toolbar");
  Assert.equal(
    document.activeElement,
    gBrowser.selectedBrowser,
    "focus is on the page"
  );
  Assert.ok(
    !document.getElementById("sval-launcher-scrim").hasAttribute("open"),
    "the scrim is gone"
  );
}

add_task(async function the_launcher_key_floats_the_address_bar() {
  const tab = await pageTab();
  const shown = gURLBar.value;
  try {
    await floatIt();
    Assert.ok(gURLBar.focused, "the field has focus");
    Assert.equal(gURLBar.selectionStart, 0, "the address is selected");
    Assert.equal(gURLBar.selectionEnd, gURLBar.value.length);
    assertFloatsOverThePage();

    EventUtils.synthesizeKey("KEY_Escape");
    await untilFloating(false, "Escape returns the address bar");
    assertBackInTheToolbar();
    Assert.ok(!gURLBar.view.isOpen, "the list is closed");
    Assert.equal(gURLBar.value, shown, "the field shows the address again");
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function open_location_floats_the_address_bar() {
  const tab = await pageTab();
  try {
    const shown = UrlbarTestUtils.promisePopupOpen(window, () =>
      document.getElementById("Browser:OpenLocation").doCommand()
    );
    await within(shown, 10_000, "the Launcher's list");
    await untilFloating(true, "Open Location floats the address bar");
    EventUtils.synthesizeKey("KEY_Escape");
    await untilFloating(false, "Escape returns the address bar");

    if (AppConstants.platform !== "macosx") {
      gBrowser.selectedBrowser.focus();
      const altD = UrlbarTestUtils.promisePopupOpen(window, () =>
        EventUtils.synthesizeKey("d", { altKey: true })
      );
      await within(altD, 10_000, "the Launcher's list");
      await untilFloating(true, "Alt+D floats the address bar");
      EventUtils.synthesizeKey("KEY_Escape");
      await untilFloating(false, "Escape returns the address bar");
    }
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

// Firefox's prompt about an extension hiding tabs (`tabHidePopup` in
// ext-tabs.js) stays in the window once answered, and its Disable Extension
// button's access key is D.
add_task(
  { skip_if: () => AppConstants.platform === "macosx" },
  async function alt_d_floats_it_after_a_hidden_tabs_prompt() {
    const tab = await pageTab();
    const hiddenTab = BrowserTestUtils.addTab(gBrowser, PAGE2);
    await within(
      BrowserTestUtils.browserLoaded(hiddenTab.linkedBrowser),
      10_000,
      "a second tab's load"
    );
    const extension = ExtensionTestUtils.loadExtension({
      useAddonManager: "temporary",
      manifest: {
        browser_specific_settings: { gecko: { id: "hider@sval.invalid" } },
        permissions: ["tabs", "tabHide"],
      },
      background() {
        const { browser } = this;
        browser.test.onMessage.addListener(async url => {
          const [found] = await browser.tabs.query({ url });
          await browser.tabs.hide(found.id);
          browser.test.sendMessage("hidden");
        });
      },
    });
    try {
      await extension.startup();
      const { ExtensionControlledPopup } = ChromeUtils.importESModule(
        "resource:///modules/ExtensionControlledPopup.sys.mjs"
      );
      const prompt = ExtensionControlledPopup._getAndMaybeCreatePanel(document);
      const asked = BrowserTestUtils.waitForPopupEvent(prompt, "shown");
      extension.sendMessage(PAGE2);
      await within(extension.awaitMessage("hidden"), 10_000, "tabs.hide");
      await within(asked, 10_000, "Firefox asking about the hidden tab");
      const answered = BrowserTestUtils.waitForPopupEvent(prompt, "hidden");
      document.getElementById("extension-tab-hide-notification").button.click();
      await within(answered, 10_000, "Keep Tabs Hidden answering it");

      gBrowser.selectedBrowser.focus();
      const altD = UrlbarTestUtils.promisePopupOpen(window, () =>
        EventUtils.synthesizeKey("d", { altKey: true })
      );
      await within(altD, 10_000, "the Launcher's list");
      await untilFloating(true, "Alt+D floats the address bar");
      EventUtils.synthesizeKey("KEY_Escape");
      await untilFloating(false, "Escape returns the address bar");
    } finally {
      await extension.unload();
      BrowserTestUtils.removeTab(hiddenTab);
      BrowserTestUtils.removeTab(tab);
    }
  }
);

add_task(async function a_click_and_f6_open_it_in_place() {
  const tab = await pageTab();
  try {
    EventUtils.synthesizeMouseAtCenter(gURLBar.inputField, {});
    await TestUtils.waitForCondition(() => gURLBar.focused, "focused");
    Assert.ok(!floating(), "a click opens it in place");
    await UrlbarTestUtils.promisePopupClose(window, () =>
      EventUtils.synthesizeKey("KEY_Escape")
    );
    gBrowser.selectedBrowser.focus();

    EventUtils.synthesizeKey("KEY_F6");
    await TestUtils.waitForCondition(() => gURLBar.focused, "F6 focuses it");
    Assert.ok(!floating(), "F6 opens it in place");

    // The key floats it from there too.
    await floatIt();
    Assert.ok(gURLBar.focused, "the field keeps focus");
    Assert.equal(
      gURLBar.selectionEnd - gURLBar.selectionStart,
      gURLBar.value.length,
      "with the address selected"
    );
    EventUtils.synthesizeKey("KEY_Escape");
    await untilFloating(false, "Escape returns the address bar");
    assertBackInTheToolbar();
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function a_click_on_the_scrim_returns_it() {
  const tab = await pageTab();
  try {
    await floatIt();
    const scrim = document.getElementById("sval-launcher-scrim");
    const box = scrim.getBoundingClientRect();
    Assert.equal(
      document.elementFromPoint(box.left + box.width / 2, box.bottom - 8),
      scrim,
      "the scrim lies over the page"
    );
    // The scrim is no control, and the a11y checks see the page below it;
    // Escape is the keyboard's way back.
    AccessibilityUtils.setEnv({ mustHaveAccessibleRule: false });
    EventUtils.synthesizeMouse(scrim, box.width / 2, box.height - 8, {});
    AccessibilityUtils.resetEnv();
    await untilFloating(false, "a click on the scrim returns it");
    assertBackInTheToolbar();
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function a_pick_returns_it() {
  const tab = await pageTab();
  try {
    await floatIt();
    const loaded = BrowserTestUtils.browserLoaded(
      gBrowser.selectedBrowser,
      false,
      PAGE2
    );
    EventUtils.sendString(PAGE2);
    EventUtils.synthesizeKey("KEY_Enter");
    await within(loaded, 10_000, "the page typed loads");
    await untilFloating(false, "the pick returns it");
    assertBackInTheToolbar();
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

/**
 * The address bar's placeholder says what the Launcher finds, and a key cap
 * beside it names the Launcher's key while the field is empty and waits
 * (launcher spec §8).
 */
add_task(async function a_key_cap_names_the_key() {
  const { ariaShortcut, keyOf, shortcutText } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalKeys.sys.mjs"
  );
  const keyEl = document.getElementById("focusURLBar");
  const cap = document.getElementById("sval-launcher-key");
  await TestUtils.waitForCondition(
    () =>
      document.l10n.getAttributes(gURLBar.inputField).id ===
        "launcher-placeholder" && !!gURLBar.inputField.placeholder,
    "the placeholder says what the Launcher finds"
  );
  Assert.equal(cap.textContent, shortcutText(keyOf(keyEl)), "the cap's key");
  Assert.equal(
    gURLBar.inputField.getAttribute("aria-keyshortcuts"),
    ariaShortcut(keyOf(keyEl)),
    "the field names the key to assistive technology"
  );

  const tab = await openPage("about:blank");
  try {
    gURLBar.blur();
    await TestUtils.waitForCondition(
      () => !!cap.getBoundingClientRect().width,
      "the cap shows while the field is empty and unfocused"
    );
    gURLBar.focus();
    await TestUtils.waitForCondition(
      () => !cap.getBoundingClientRect().width,
      "and hides while it is focused"
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

/**
 * A cleared key hides the cap, and a key changed in Settings › Keyboard shows
 * as changed.
 */
add_task(async function the_key_cap_follows_the_key() {
  const { CustomKeys } = ChromeUtils.importESModule(
    "moz-src:///browser/components/customkeys/CustomKeys.sys.mjs"
  );
  const { keyOf, shortcutText } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalKeys.sys.mjs"
  );
  const cap = document.getElementById("sval-launcher-key");
  registerCleanupFunction(() => CustomKeys.resetKey("focusURLBar"));
  CustomKeys.changeKey("focusURLBar", { modifiers: "accel,shift", key: "K" });
  const key = shortcutText(keyOf(document.getElementById("focusURLBar")));
  await TestUtils.waitForCondition(
    () => cap.textContent === key && !cap.hidden,
    "the changed key"
  );
  CustomKeys.clearKey("focusURLBar");
  await TestUtils.waitForCondition(() => cap.hidden, "no key, no cap");
  Assert.ok(
    !gURLBar.inputField.hasAttribute("aria-keyshortcuts"),
    "and no key for assistive technology"
  );
  CustomKeys.resetKey("focusURLBar");
});

/**
 * In a command's choices Escape steps back to the first list, and Escape
 * there closes the float. The float is the address bar, not a dialog.
 */
add_task(async function escape_steps_back_then_closes() {
  const tab = await pageTab();
  try {
    await floatIt();
    Assert.ok(
      !gURLBar.closest("[role=dialog], dialog") &&
        gURLBar.getAttribute("role") !== "dialog",
      "the float is no dialog"
    );
    Assert.equal(
      gURLBar.inputField.getAttribute("role"),
      "combobox",
      "it is the address bar's combobox"
    );
    EventUtils.sendString("move this tab");
    await UrlbarTestUtils.promiseSearchComplete(window);
    let at = -1;
    for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
      const { result } = await UrlbarTestUtils.getDetailsOfResultAt(window, i);
      if (result.payload.commandId === "move-tab") {
        at = i;
      }
    }
    Assert.greaterOrEqual(at, 0, "Move this tab to… is listed");
    UrlbarTestUtils.setSelectedRowIndex(window, at);
    EventUtils.synthesizeKey("KEY_Enter");
    await TestUtils.waitForCondition(
      () => document.getElementById("sval-launcher-chip"),
      "its choices show"
    );
    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(
      () => !document.getElementById("sval-launcher-chip"),
      "Escape steps back"
    );
    Assert.ok(floating(), "the float stays");
    EventUtils.synthesizeKey("KEY_Escape");
    await untilFloating(false, "Escape at the first list closes it");
    assertBackInTheToolbar();
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

/**
 * Whether the address bar floats and is not closing: a close removes the
 * scrim at once, and the float's attribute only once the card has faded.
 */
function staysFloating() {
  return (
    floating() &&
    document.getElementById("sval-launcher-scrim").hasAttribute("open")
  );
}

/**
 * Shift+Tab from the first row moves focus to the engine button, as in the
 * address bar (`UrlbarController.focusOnUnifiedSearchButton`), and the
 * Launcher stays: its engine menu picks a search mode in the float, with
 * focus back in the field. Focus leaving for the page ends the float.
 */
add_task(async function the_engine_button_keeps_the_float() {
  const tab = await pageTab();
  try {
    await floatIt();
    EventUtils.sendString("sval");
    await UrlbarTestUtils.promiseSearchComplete(window);
    const button = gURLBar.querySelector(".searchmode-switcher");
    EventUtils.synthesizeKey("KEY_Tab", { shiftKey: true });
    await TestUtils.waitForCondition(
      () => document.activeElement === button,
      "Shift+Tab reaches the engine button"
    );
    Assert.ok(staysFloating(), "the float stays on the engine button");

    const popup = UrlbarTestUtils.searchModeSwitcherPopup(window);
    const shown = BrowserTestUtils.waitForEvent(popup, "shown");
    EventUtils.synthesizeKey("KEY_ArrowDown");
    await within(shown, 10_000, "the engine menu");
    Assert.ok(staysFloating(), "the float stays while its menu shows");

    const item = popup.querySelector(".searchmode-switcher-installed");
    const engineName = item.dataset.engineName;
    const hidden = UrlbarTestUtils.searchModeSwitcherPopupClosed(window);
    item.click();
    await within(hidden, 10_000, "the engine menu closes");
    await TestUtils.waitForCondition(
      () => gURLBar.searchMode?.engineName === engineName,
      "the engine's search mode"
    );
    Assert.ok(gURLBar.focused, "focus is back in the field");
    Assert.ok(staysFloating(), "the float stays after the pick");
    Assert.equal(gURLBar.value, "sval", "the field keeps what was typed");

    button.focus();
    Assert.ok(staysFloating(), "the float stays on the engine button again");
    gBrowser.selectedBrowser.focus();
    await untilFloating(false, "focus on the page ends the float");
  } finally {
    gURLBar.searchMode = null;
    BrowserTestUtils.removeTab(tab);
  }
});

/**
 * A click on the engine button opens its list over the floating Launcher,
 * as in the address bar, and the Launcher stays: Escape leaves focus in the
 * field, and a pick searches with the engine there.
 */
add_task(async function a_click_on_the_engine_button_keeps_the_float() {
  const tab = await pageTab();
  try {
    await floatIt();
    EventUtils.sendString("sval");
    await UrlbarTestUtils.promiseSearchComplete(window);
    const button = gURLBar.querySelector(".searchmode-switcher");
    const popup = UrlbarTestUtils.searchModeSwitcherPopup(window);

    let shown = BrowserTestUtils.waitForEvent(popup, "shown");
    EventUtils.synthesizeMouseAtCenter(button, {});
    await within(shown, 10_000, "the engine menu");
    Assert.ok(staysFloating(), "the float stays while its menu shows");
    assertFloatsOverThePage();
    const shield = document.getElementById("sval-protection-button");
    Assert.ok(
      !shield || !BrowserTestUtils.isVisible(shield),
      "the page's protections are the toolbar's, not the Launcher's"
    );

    let hidden = UrlbarTestUtils.searchModeSwitcherPopupClosed(window);
    EventUtils.synthesizeKey("KEY_Escape");
    await within(hidden, 10_000, "the engine menu closes");
    await TestUtils.waitForCondition(
      () => gURLBar.focused,
      "focus is back in the field"
    );
    Assert.ok(staysFloating(), "the float stays after Escape");

    shown = BrowserTestUtils.waitForEvent(popup, "shown");
    EventUtils.synthesizeMouseAtCenter(button, {});
    await within(shown, 10_000, "the engine menu again");
    const item = popup.querySelector(".searchmode-switcher-installed");
    const engineName = item.dataset.engineName;
    hidden = UrlbarTestUtils.searchModeSwitcherPopupClosed(window);
    EventUtils.synthesizeMouseAtCenter(item, {});
    await within(hidden, 10_000, "the engine menu closes on the pick");
    await TestUtils.waitForCondition(
      () => gURLBar.searchMode?.engineName === engineName,
      "the engine's search mode"
    );
    Assert.ok(gURLBar.focused, "focus is in the field");
    Assert.ok(staysFloating(), "the float stays after the pick");
    assertFloatsOverThePage();
  } finally {
    gURLBar.searchMode = null;
    BrowserTestUtils.removeTab(tab);
  }
});
