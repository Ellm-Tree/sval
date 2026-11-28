/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Every on/off state outside the panel and history toggles
 * (`browser_sval_header_toggles.js`) tells on from off by a difference of
 * 3:1 or more (WCAG 1.4.11), in the light theme and the dark: the header's
 * pressed buttons, the open shield, and the site menu's and Settings' pins,
 * segments and switches (header signals spec §1). The files for each
 * control test when its state is set; this one tests how it looks.
 */

/* import-globals-from head.js */
/* import-globals-from sval_header_toggle_helpers.js */
/* import-globals-from sval_preferences_helpers.js */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_header_toggle_helpers.js",
  this
);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

const { PINS_PREF } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteControls.sys.mjs"
);

const SITE_PAGE =
  "https://example.net/browser/browser/components/sval/test/browser/sval_element_picker.html";

keepPrefs(PINS_PREF);

/**
 * Waits for `els` to finish easing between colours.
 *
 * @param {Element[]} els
 */
function settled(els) {
  return within(
    TestUtils.waitForCondition(
      () => !els.some(el => el.getAnimations().length),
      "the colours settle"
    ),
    10_000,
    "the colours settling"
  );
}

/**
 * @param {object} on The on state's painted colour.
 * @param {object} off The off state's.
 * @param {string} what
 */
function apart(on, off, what) {
  const ratio = contrastRatio(on, off);
  Assert.greaterOrEqual(
    ratio,
    3,
    `${what}: on is ${ratio.toFixed(2)}:1 against off`
  );
}

/**
 * The colour `node` is painted in on its popup: its own background over each
 * ancestor's inside `popup`, over the popup's surface. A popup draws its
 * surface in its shadow tree, which an ancestor walk does not reach.
 *
 * @param {Element} node
 * @param {Element} popup
 * @returns {{r: number, g: number, b: number}}
 */
function paintedOnPopup(node, popup) {
  const probe = node.ownerDocument.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "div"
  );
  probe.style.backgroundColor = "var(--sval-prot-popup)";
  popup.append(probe);
  let under = rgbaOf(getComputedStyle(probe).backgroundColor);
  probe.remove();
  const layers = [];
  for (let el = node; el != popup; el = el.parentElement) {
    layers.unshift(rgbaOf(getComputedStyle(el).backgroundColor));
  }
  for (const layer of layers) {
    under = paintedOver(layer, under);
  }
  return under;
}

/**
 * @param {object} glyph The on state's glyph colour.
 * @param {object} chip What it is drawn on.
 * @param {string} what
 */
function readable(glyph, chip, what) {
  const ratio = contrastRatio(glyph, chip);
  Assert.greaterOrEqual(
    ratio,
    3,
    `${what}: the glyph is ${ratio.toFixed(2)}:1 against its chip`
  );
}

// A window's own colours differ when it is see-through, as Sval's default
// window is where the system allows it.
const LOOKS = [false, true].flatMap(see =>
  [false, true].map(dark => ({ see, dark }))
);

add_task(async function the_headers_pressed_buttons_and_the_open_shield() {
  Services.prefs.setStringPref(
    PINS_PREF,
    JSON.stringify(["javascript", "remove", "snip"])
  );
  await BrowserTestUtils.withNewTab(SITE_PAGE, async () => {
    const icon = id =>
      document.getElementById(id).querySelector(".toolbarbutton-icon");
    const ids = [
      "sval-snip-button",
      "sval-remove-button",
      "reader-mode-button",
    ];
    // The reader button's pressed look is Reader View's own attribute.
    const press = (button, on) =>
      button.id === "reader-mode-button"
        ? button.toggleAttribute("readeractive", on)
        : button.setAttribute("aria-pressed", String(on));
    const shield = document.getElementById("sval-protection-button");
    const panel = document.getElementById("sval-protection-panel");
    for (const { see, dark } of LOOKS) {
      const theme = `${see ? "see-through" : "solid"} ${dark ? "dark" : "light"}`;
      await windowSeeThrough(see);
      await inTheme(window, dark);
      for (const id of ids) {
        const button = document.getElementById(id);
        press(button, true);
        await settled([icon(id)]);
        const on = paintedColour(icon(id));
        readable(getComputedStyle(icon(id)).fill, on, `${theme}, ${id}`);
        press(button, false);
        await settled([icon(id)]);
        apart(on, paintedColour(icon(id)), `${theme}, ${id}`);
      }

      // Open, the shield is the face its panel's stem grows from, in the
      // panel's fill (`sval-protection.css`), so it is read against that
      // fill rather than told apart from its closed look.
      const shown = BrowserTestUtils.waitForEvent(panel, "popupshown");
      shield.click();
      await within(shown, 5_000, "the protection panel's popupshown");
      await settled([shield]);
      const on = paintedColour(shield);
      readable(getComputedStyle(shield).color, on, `${theme}, the open shield`);
      const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
      panel.hidePopup();
      await within(hidden, 5_000, "the protection panel's popuphidden");
    }
  });
});

add_task(async function the_site_menus_pins_segments_and_switch() {
  Services.prefs.clearUserPref(PINS_PREF);
  await BrowserTestUtils.withNewTab(SITE_PAGE, async () => {
    const menu = document.getElementById("sval-site-menu");
    const button = document.getElementById("sval-site-menu-button");
    await within(
      TestUtils.waitForCondition(
        () => !button.disabled,
        "the site controls reading the page"
      ),
      10_000,
      "the site controls reading the page"
    );
    for (const { see, dark } of LOOKS) {
      const theme = `${see ? "see-through" : "solid"} ${dark ? "dark" : "light"}`;
      await windowSeeThrough(see);
      await inTheme(window, dark);
      const shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
      button.click();
      await within(shown, 5_000, "the site menu's popupshown");
      try {
        const pinned = document.getElementById("sval-site-pin-javascript");
        const unpinned = document.getElementById("sval-site-pin-remove");
        is(pinned.getAttribute("aria-pressed"), "true", "JavaScript is pinned");
        is(unpinned.getAttribute("aria-pressed"), "false", "Remove is not");
        const chosen = menu.querySelector(
          ".sval-prot-segment:has(> .sval-prot-radio:checked)"
        );
        const other = menu.querySelector(
          ".sval-prot-segment:not(:has(> .sval-prot-radio:checked))"
        );
        const toggle = menu.querySelector(".sval-prot-switch");
        is(toggle.getAttribute("aria-checked"), "true", "JavaScript is on");
        await settled([pinned, unpinned, chosen, other, toggle]);
        readable(
          getComputedStyle(pinned).color,
          paintedOnPopup(pinned, menu),
          `${theme}, the site menu's pin`
        );
        readable(
          getComputedStyle(chosen).color,
          paintedOnPopup(chosen, menu),
          `${theme}, the chosen segment`
        );
        apart(
          paintedOnPopup(pinned, menu),
          paintedOnPopup(unpinned, menu),
          `${theme}, the site menu's pin`
        );
        apart(
          paintedOnPopup(chosen, menu),
          paintedOnPopup(other, menu),
          `${theme}, the chosen segment`
        );
        // An off switch is an outline on the popup, so its track is what is
        // behind it.
        apart(
          paintedOnPopup(toggle, menu),
          paintedOnPopup(toggle.parentElement, menu),
          `${theme}, the switch`
        );
      } finally {
        const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
        menu.hidePopup();
        await within(hidden, 5_000, "the site menu's popuphidden");
      }
    }
  });
});

add_task(async function settings_pins() {
  Services.prefs.clearUserPref(PINS_PREF);
  for (const dark of [false, true]) {
    await inTheme(window, dark);
    const ui = await openPane(
      "paneAppearance",
      ({ byId }) => byId("sval-address-pin-snip")?.checkVisibility(),
      "Appearance's Pinned to the address bar card"
    );
    const pinned = ui.byId("sval-address-pin-javascript");
    const unpinned = ui.byId("sval-address-pin-remove");
    await settled([pinned, unpinned]);
    readable(
      getComputedStyle(pinned).color,
      paintedColour(pinned),
      `${dark ? "dark" : "light"}, Settings' pin`
    );
    apart(
      paintedColour(pinned),
      paintedColour(unpinned),
      `${dark ? "dark" : "light"}, Settings' pin`
    );
    closeSettings();
  }
});
