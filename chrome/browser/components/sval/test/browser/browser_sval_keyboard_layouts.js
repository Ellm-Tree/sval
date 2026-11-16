/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * Sval's shortcuts under keyboard layouts other than US, Latin and not, each
 * pressed as the platform's own key event so the widget words it as that
 * layout does.
 *
 * Gecko matches a `<key key="C">` by character only
 * (`KeyEventHandler::KeyEventMatched`), trying each candidate
 * `WidgetKeyboardEvent::GetShortcutKeyCandidates` makes from the event's
 * character and its alternative characters. The widget adds those: on
 * Windows the layout's own characters for the key, its Latin character on a
 * non-Latin layout, and `+` for `VK_OEM_PLUS` (`NativeKey::
 * WillDispatchKeyboardEvent`); on macOS the layout's characters, and the
 * Latin ones a layout types with Command where Command switches it to Latin
 * (`TISInputSourceWrapper::WillDispatchKeyboardEvent`). Accel with a digit
 * matches on a layout that types digits with Shift, as AZERTY does, through
 * the shifted digit. `EventUtils.synthesizeKey` gives no alternative
 * characters (`TextInputProcessor::WillDispatchKeyboardEvent`), so only a
 * native event tests this.
 *
 * On macOS a native event carries the characters the caller gives, and they
 * are left empty here so the match rests on the characters the widget reads
 * from the layout. Its key codes are physical places on an ANSI keyboard,
 * so each layout names where its letter is; Windows' virtual key codes
 * follow the layout's letters.
 */

const { COPY_ADDRESS_KEY } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalShortcuts.sys.mjs"
);

const NativeKeys = {};
Services.scriptloader.loadSubScript(
  "chrome://mochikit/content/tests/SimpleTest/NativeKeyCodes.js",
  NativeKeys
);

const isMac = AppConstants.platform === "macosx";

/**
 * The shortcuts pressed: the `<key>` each runs, the key's place by the
 * character on it, and its modifiers as `synthesizeNativeKey` takes them.
 * Split View's are the layout's own on macOS (`splitModifiers`).
 */
const SHORTCUTS = [
  {
    id: COPY_ADDRESS_KEY,
    at: "C",
    modifiers: { accelKey: true, shiftKey: true },
  },
  { id: "focusURLBar", at: "L", modifiers: { accelKey: true } },
  {
    id: "toggleSidebarKb",
    at: "Z",
    modifiers: isMac ? { ctrlKey: true } : { ctrlKey: true, altKey: true },
  },
  { id: "key_selectTab1", at: "1", modifiers: { accelKey: true } },
  { id: "key_selectLastTab", at: "9", modifiers: { accelKey: true } },
  { id: "key_addTabSplitView", at: "+" },
];

const MAC_US = {
  C: "MAC_VK_ANSI_C",
  L: "MAC_VK_ANSI_L",
  Z: "MAC_VK_ANSI_Z",
  1: "MAC_VK_ANSI_1",
  9: "MAC_VK_ANSI_9",
  "+": "MAC_VK_ANSI_Equal",
};

const WIN_KEYS = {
  C: "WIN_VK_C",
  L: "WIN_VK_L",
  Z: "WIN_VK_Z",
  1: "WIN_VK_1",
  9: "WIN_VK_9",
  "+": "WIN_VK_OEM_PLUS",
};

/**
 * The layouts each platform is tested under, and on macOS where each
 * layout puts the keys it moves. A layout that Command switches to Latin
 * (Greek, Hebrew, Arabic) is pressed at the US places, where its user
 * finds the Latin letters.
 *
 * `plusUnshifted` marks a macOS layout that types `+` without Shift, where
 * Split View's Control+Plus is Control and that key alone. On the others its
 * user holds Shift to type `+`, and Gecko matches the key with Shift ignored.
 */
const MAC_LAYOUTS = [
  { layout: "KEYBOARD_LAYOUT_EN_US", keys: {} },
  {
    layout: "KEYBOARD_LAYOUT_FRENCH",
    keys: { Z: "MAC_VK_ANSI_W", "+": "MAC_VK_ANSI_Slash" },
  },
  {
    layout: "KEYBOARD_LAYOUT_GERMAN",
    keys: { Z: "MAC_VK_ANSI_Y", "+": "MAC_VK_ANSI_RightBracket" },
    plusUnshifted: true,
  },
  {
    layout: "KEYBOARD_LAYOUT_SPANISH",
    keys: { "+": "MAC_VK_ANSI_RightBracket" },
    plusUnshifted: true,
  },
  {
    // Command types QWERTY's letters; without it the keys are Dvorak's.
    layout: "KEYBOARD_LAYOUT_DVORAK_QWERTY",
    keys: { Z: "MAC_VK_ANSI_Slash", "+": "MAC_VK_ANSI_RightBracket" },
  },
  { layout: "KEYBOARD_LAYOUT_GREEK", keys: {} },
  { layout: "KEYBOARD_LAYOUT_HEBREW", keys: {} },
  { layout: "KEYBOARD_LAYOUT_ARABIC", keys: {} },
];

const WIN_LAYOUTS = [
  "KEYBOARD_LAYOUT_EN_US",
  "KEYBOARD_LAYOUT_FRENCH",
  "KEYBOARD_LAYOUT_GERMAN",
  "KEYBOARD_LAYOUT_SPANISH",
  "KEYBOARD_LAYOUT_RUSSIAN",
  "KEYBOARD_LAYOUT_GREEK",
  "KEYBOARD_LAYOUT_HEBREW",
  "KEYBOARD_LAYOUT_ARABIC",
  "KEYBOARD_LAYOUT_THAI",
  "KEYBOARD_LAYOUT_JAPANESE",
].map(layout => ({ layout, keys: {} }));

/**
 * Split View's modifiers as a user of `layout` presses them: on macOS
 * Control, with Shift where the layout types `+` with it; elsewhere
 * Control+Shift.
 *
 * @param {object} layout A `MAC_LAYOUTS` or `WIN_LAYOUTS` entry.
 * @returns {object} As `synthesizeNativeKey` takes them.
 */
function splitModifiers(layout) {
  return { ctrlKey: true, shiftKey: !isMac || !layout.plusUnshifted };
}

/**
 * Presses a key as the platform's own event and resolves once Gecko has
 * dispatched it.
 *
 * @param {string} layout An `EventUtils` layout's name.
 * @param {string} at The character on the key.
 * @param {object} modifiers As `synthesizeNativeKey` takes them.
 * @param {object} keys The layout's macOS places, by character.
 * @returns {Promise}
 */
function pressNative(layout, at, modifiers, keys) {
  const name = isMac ? (keys[at] ?? MAC_US[at]) : WIN_KEYS[at];
  return within(
    new Promise(resolve =>
      EventUtils.synthesizeNativeKey(
        EventUtils[layout],
        NativeKeys[name],
        modifiers,
        "",
        "",
        resolve
      )
    ),
    10_000,
    `${layout}'s ${at}`
  );
}

/**
 * Records the `command` events the window's keys raise and stops each before
 * its handlers, so a key is shown to run without running it.
 *
 * @returns {string[]} the ids of the elements each command reached.
 */
function catchCommands() {
  const caught = [];
  const listener = event => {
    if (event.target.id) {
      caught.push(event.target.id);
    }
    event.stopPropagation();
    event.preventDefault();
  };
  window.addEventListener("command", listener, true);
  atTaskEnd(() => window.removeEventListener("command", listener, true));
  return caught;
}

/**
 * A headless macOS run synthesizes no native key event (`HeadlessWidget` has
 * no `SynthesizeNativeKeyEvent`), and `scripts/test.sh` makes a macOS run
 * headless through `MOZ_HEADLESS`, which the manifest's `headless` does not
 * see.
 */
const headless = Cc["@mozilla.org/gfx/info;1"].getService(
  Ci.nsIGfxInfo
).isHeadless;

add_task(
  { skip_if: () => isMac && headless },
  async function each_shortcut_runs_under_each_layout() {
    const tab = await openPage(ROOT + "sval_agent_page.html");
    tab.linkedBrowser.focus();
    await TestUtils.waitForCondition(
      () => Services.focus.focusedElement === tab.linkedBrowser,
      "the page has the focus"
    );
    const caught = catchCommands();
    for (const entry of isMac ? MAC_LAYOUTS : WIN_LAYOUTS) {
      for (const { id, at, modifiers } of SHORTCUTS) {
        const el = document.getElementById(id);
        const expected = el.getAttribute("command") || el.id;
        const before = caught.length;
        await pressNative(
          entry.layout,
          at,
          modifiers ?? splitModifiers(entry),
          entry.keys
        );
        // A key that is not reserved, as the panel's is on macOS, reaches the
        // page first and runs once the page hands it back.
        await TestUtils.waitForCondition(
          () => caught.slice(before).includes(expected),
          `${entry.layout}: ${at} runs ${expected}`
        );
        Assert.ok(true, `${entry.layout}: ${at} runs ${expected}`);
      }
    }
  }
);
