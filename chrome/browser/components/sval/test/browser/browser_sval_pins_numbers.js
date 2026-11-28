/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_pins_helpers.js */

/**
 * The marks drawn on the pins (pins spec §12) read in every workspace colour
 * and in both themes: the number a held modifier shows, on its badge at AA
 * for text (WCAG 1.4.3), and the badge and the attention dot on what they sit
 * on at AA for a graphic (WCAG 1.4.11).
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_pins_helpers.js",
  this
);

const { PRESETS: COLOR_TOKENS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalColor.sys.mjs"
);

add_setup(pinsSetup);

/** @param {string|null} color A workspace colour token, or none. */
async function tintHome(color) {
  await SvalPanel.engine.mutate({
    kind: "setAppearance",
    id: pinsFixture.home,
    color,
    emoji: null,
    now: Date.now(),
  });
  await SvalPanel.refresh();
  await TestUtils.waitForCondition(
    () => SvalPanel.windowColor === color,
    "the window takes the workspace's colour"
  );
}

/**
 * Calls `check` in each theme and workspace colour, on a solid window and a
 * see-through one, with where it is.
 *
 * @param {function(string): void} check
 */
async function inEveryColourAndTheme(check) {
  atTaskEnd(() => tintHome(null));
  for (const see of [false, true]) {
    await windowSeeThrough(see);
    for (const dark of [0, 1]) {
      await SpecialPowers.pushPrefEnv({
        set: [["ui.systemUsesDarkTheme", dark]],
      });
      await TestUtils.waitForCondition(
        () => matchMedia("(prefers-color-scheme: dark)").matches === !!dark,
        "the theme changes"
      );
      for (const color of [null, ...COLOR_TOKENS]) {
        await tintHome(color);
        const kind = see ? "see-through" : "solid";
        check(`${color ?? "no colour"}, ${kind}, ${dark ? "dark" : "light"}`);
      }
      await SpecialPowers.popPrefEnv();
    }
  }
}

add_task(async function a_pins_number_reads_in_every_colour_and_theme() {
  const guid = await pinFavorite("https://example.com/numbered", "Numbered");
  await untilPinShows(guid);
  const block = document.querySelector(".sval-pins");
  const slot = tileOf(guid).closest(".sval-pin-slot");
  Assert.equal(slot.dataset.number, "1", "the first pin is numbered 1");
  // The key `SvalPinsRow` takes as the held modifier: `key_selectTab1`'s.
  const modifiers = document
    .getElementById("key_selectTab1")
    .getAttribute("modifiers");
  let held = AppConstants.platform === "macosx" ? "KEY_Meta" : "KEY_Control";
  if (modifiers === "alt") {
    held = "KEY_Alt";
  }
  EventUtils.synthesizeKey(held, { type: "keydown" });
  atTaskEnd(() => EventUtils.synthesizeKey(held, { type: "keyup" }));
  await TestUtils.waitForCondition(
    () => block.hasAttribute("data-numbers"),
    "holding the modifier shows the numbers"
  );

  const failing = [];
  await inEveryColourAndTheme(where => {
    const badge = getComputedStyle(slot, "::before");
    const panel = drawnBehind(slot);
    const fill = paintedOver(rgbaOf(badge.backgroundColor), panel);
    const ink = paintedOver(rgbaOf(badge.color), fill);
    const text = contrastRatio(ink, fill);
    const shape = contrastRatio(fill, panel);
    if (text < 4.5) {
      failing.push(`${where}: the number at ${text.toFixed(2)}:1`);
    }
    if (shape < 3) {
      failing.push(`${where}: the badge at ${shape.toFixed(2)}:1`);
    }
  });
  Assert.deepEqual(failing, [], "every number reads");
});

add_task(async function a_pins_attention_dot_shows_in_every_colour_and_theme() {
  const guid = await pinFavorite(PAGE, "Asking");
  const page = await clickTile(guid, PAGE);
  await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE2),
    10_000,
    "a tab in front of the pin's page"
  );
  // A tab-modal prompt from a page behind another tab marks its tab as
  // asking for attention (`tabbrowser`'s DOMWillOpenModalDialog handler).
  await SpecialPowers.spawn(page.linkedBrowser, [], () => {
    content.setTimeout(() => content.alert("asking"));
  });
  await TestUtils.waitForCondition(
    () =>
      tileOf(guid)?.closest(".sval-pin-slot").hasAttribute("data-attention"),
    "the pin's page asks for attention"
  );
  const failing = [];
  await inEveryColourAndTheme(where => {
    const tile = tileOf(guid);
    Assert.ok(
      tile.closest(".sval-pin-slot").hasAttribute("data-attention"),
      `the dot stays drawn (${where})`
    );
    const dot = getComputedStyle(tile, "::before");
    const behind = drawnBehind(tile);
    const ratio = contrastRatio(
      paintedOver(rgbaOf(dot.backgroundColor), behind),
      behind
    );
    if (ratio < 3) {
      failing.push(`${where}: the dot at ${ratio.toFixed(2)}:1`);
    }
  });
  Assert.deepEqual(failing, [], "every dot shows");
});
