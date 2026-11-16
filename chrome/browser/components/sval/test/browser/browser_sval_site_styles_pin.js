/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_site_styles_helpers.js */

// Colorshift's button in the site controls: the Colorshift row in Site
// settings pins it to the address bar; it opens Colorshift and shows pressed
// while Colorshift is open; it carries the dot for a saved Colorshift while
// pinned; and it is dimmed where the page can have no Colorshift.

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_site_styles_helpers.js",
  this
);

const { PINS_PREF } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteControls.sys.mjs"
);
const { COLORSHIFT_BUTTON_ID } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteStylePanel.sys.mjs"
);

/** A blue tint at 60 percent. */
const TINT = { hue: 220, strength: 60, complement: 55 };

add_setup(failOnConsoleErrors);
add_setup(function () {
  registerCleanupFunction(() => Services.prefs.clearUserPref(PINS_PREF));
});

/**
 * @param {Window} [win]
 * @returns {Element} the site controls' Colorshift button.
 */
function button(win = window) {
  return win.document.getElementById(COLORSHIFT_BUTTON_ID);
}

/** @returns {string[]} the buttons the pref pins. */
function pinned() {
  return JSON.parse(Services.prefs.getStringPref(PINS_PREF));
}

function pinColorshift() {
  Services.prefs.setStringPref(
    PINS_PREF,
    JSON.stringify([...pinned(), "colorshift"])
  );
}

async function openMenu(win = window) {
  const menu = win.document.getElementById("sval-site-menu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  win.document.getElementById("sval-site-menu-button").click();
  await within(shown, 10_000, "the site menu showing");
}

async function closeMenu(win = window) {
  const menu = win.document.getElementById("sval-site-menu");
  if (menu.state === "closed") {
    return;
  }
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(hidden, 10_000, "the site menu hiding");
}

add_task(async function the_colorshift_row_pins_and_unpins_the_button() {
  atTaskEnd(() => Services.prefs.clearUserPref(PINS_PREF));
  await BrowserTestUtils.withNewTab(STYLE_PAGE, async () => {
    await menuReady();
    ok(button().hidden, "the button starts unpinned");
    await openMenu();
    try {
      const pin = byId("sval-site-pin-colorshift");
      is(pin.getAttribute("aria-pressed"), "false", "the pin is off");
      pin.click();
      ok(pinned().includes("colorshift"), "the pref pins Colorshift");
      await until(() => !button().hidden, "the button showing");
      is(
        byId("sval-site-pin-colorshift").getAttribute("aria-pressed"),
        "true",
        "the pin is on"
      );
      byId("sval-site-pin-colorshift").click();
      ok(!pinned().includes("colorshift"), "the pref unpins it");
      await until(() => button().hidden, "the button hiding");
    } finally {
      await closeMenu();
    }
  });
});

add_task(async function the_button_opens_colorshift_and_shows_pressed() {
  atTaskEnd(() => Services.prefs.clearUserPref(PINS_PREF));
  pinColorshift();
  await BrowserTestUtils.withNewTab(STYLE_PAGE, async () => {
    await menuReady();
    await until(() => !button().hidden, "the button showing");
    is(button().dataset.offer, "ok", "the button is offered");
    is(button().getAttribute("aria-pressed"), "false", "it starts unpressed");
    const shown = editorShown();
    button().click();
    await shown;
    is(button().getAttribute("aria-pressed"), "true", "it shows pressed");
    // A second press keeps the unsaved changes and moves the focus there.
    button().click();
    await until(
      () => editor().contains(document.activeElement),
      "the focus moving into Colorshift"
    );
    is(editor().state, "open", "Colorshift stays open");
    await closeEditor();
    is(button().getAttribute("aria-pressed"), "false", "it unpresses");
  });
});

add_task(async function a_pinned_button_carries_the_saved_colorshift_dot() {
  atTaskEnd(() => Services.prefs.clearUserPref(PINS_PREF));
  SvalSiteStyles.setStyle("example.com", TINT);
  atTaskEnd(() => Services.prefs.clearUserPref(STYLES_PREF));
  await BrowserTestUtils.withNewTab(STYLE_PAGE, async () => {
    await menuReady();
    const menuButton = byId("sval-site-menu-button");
    await until(
      () => menuButton.hasAttribute("sval-styled"),
      "Site settings carrying the dot"
    );
    pinColorshift();
    await until(
      () => button().hasAttribute("sval-styled"),
      "the Colorshift button carrying the dot"
    );
    ok(!menuButton.hasAttribute("sval-styled"), "Site settings drops it");
  });
});

add_task(async function a_private_window_dims_the_button() {
  atTaskEnd(() => Services.prefs.clearUserPref(PINS_PREF));
  pinColorshift();
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    15_000,
    "a private window opening"
  );
  try {
    await within(
      BrowserTestUtils.loadURIString({
        browser: win.gBrowser.selectedBrowser,
        uriString: STYLE_PAGE,
      }),
      15_000,
      "the page loading in a private window"
    );
    await until(
      () => button(win).dataset.offer === "private",
      "the button reading the private page"
    );
    ok(!button(win).hidden, "the pinned button shows");
    is(button(win).getAttribute("aria-disabled"), "true", "it is dimmed");
    button(win).click();
    const panel = win.document.getElementById(STYLE_PANEL_ID);
    ok(!panel || panel.state === "closed", "a press opens nothing");
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the private window closing"
    );
  }
});
