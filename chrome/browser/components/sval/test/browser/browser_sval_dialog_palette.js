/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A Sval dialog's card wears the palette of the window it opens in
 * (`SvalDialogBox.fitFrame`): Sval's own in each system appearance, the
 * private window's violet and an agent's window's navy, whatever the caller
 * passes, with its text at WCAG 2's ratios, and the box round the card the
 * card's colour, solid. On a Workspace's colour the card's text is solved
 * (`SvalDialogBox.paintTint`) and meets all of decision 0057's targets.
 */

const { openSvalDialog } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalDialog.sys.mjs"
);
const { SvalColor } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalColor.sys.mjs"
);

registerCleanupFunction(closeLeftoverDialog);

add_setup(solidWindows);

/**
 * The colour `value` paints in `doc`, as 0..1 sRGB and its alpha.
 *
 * @param {Document} doc
 * @param {string} value A CSS colour or `var()`.
 * @returns {{rgb: number[], a: number}}
 */
function painted(doc, value) {
  const probe = doc.createElement("div");
  probe.style.backgroundColor = value;
  doc.body.append(probe);
  const { r, g, b, a } = InspectorUtils.colorToRGBA(
    doc.defaultView.getComputedStyle(probe).backgroundColor
  );
  probe.remove();
  return { rgb: [r / 255, g / 255, b / 255], a };
}

/** Each ink the card draws on itself, and the target it meets (0057). */
const INKS = [
  ["--sval-dialog-text", "body"],
  ["--sval-dialog-body", "body"],
  ["--sval-dialog-muted", "muted"],
];

/**
 * Checks each ink the card `dialog` draws on itself, and its focus ring,
 * against 0057's targets for the system's contrast: the WCAG 2 ratio, and
 * with `apca` the APCA Lc too.
 *
 * @param {Document} doc
 * @param {Element} dialog
 * @param {string} what
 * @param {object} options
 * @param {boolean} options.apca
 */
function checkInks(doc, dialog, what, { apca }) {
  const view = doc.defaultView;
  const card = painted(doc, view.getComputedStyle(dialog).backgroundColor);
  const more = view.matchMedia("(prefers-contrast: more)").matches;
  const targets = SvalColor.requirements(more);
  for (const [token, kind] of INKS) {
    const ink = painted(doc, `var(${token})`);
    const { w, lc } = SvalColor.contrast(ink.rgb, card.rgb);
    Assert.greaterOrEqual(
      Math.round(w * 100) / 100,
      targets[kind].w,
      `${what}: ${token} is ${w.toFixed(2)}:1 on the card`
    );
    if (apca) {
      Assert.greaterOrEqual(
        Math.round(Math.abs(lc)),
        targets[kind].lc,
        `${what}: ${token} is Lc ${lc.toFixed(1)} on the card`
      );
    }
  }
  const focus = painted(doc, "var(--sval-dialog-focus)");
  Assert.greaterOrEqual(
    SvalColor.contrast(focus.rgb, card.rgb).w,
    targets.line.w,
    `${what}: the focus ring shows on the card`
  );
}

/**
 * Opens the general dialog in `win`, checks its palette, and closes it.
 *
 * @param {Window} win
 * @param {string} what The palette, for the messages.
 * @returns {Promise<{card: number[], root: Element}>} The card's colour
 *   and the page's root, with the attributes it took.
 */
async function checkPalette(win, what) {
  const answer = openSvalDialog(win, {
    title: "Rename this Workspace?",
    body: "Its tabs stay where they are.",
    primary: "Rename",
  });
  const { doc, dialog } = await openedSvalDialog(win);
  const view = doc.defaultView;
  const card = painted(doc, view.getComputedStyle(dialog).backgroundColor);
  Assert.equal(card.a, 1, `${what}: the card is solid`);
  const box = view.frameElement.closest(".dialogBox");
  Assert.deepEqual(
    InspectorUtils.colorToRGBA(win.getComputedStyle(box).backgroundColor),
    InspectorUtils.colorToRGBA(view.getComputedStyle(dialog).backgroundColor),
    `${what}: the box is the card's colour`
  );
  checkInks(doc, dialog, what, { apca: false });
  const root = {
    private: doc.documentElement.getAttribute("privatebrowsingmode"),
    agent: doc.documentElement.getAttribute("data-sval-agent"),
    tint: doc.documentElement.hasAttribute("data-sval-tint"),
  };
  EventUtils.synthesizeKey("KEY_Escape", {}, view);
  await within(answer, 10_000, "the dialog's answer");
  return { card: card.rgb, root };
}

add_task(async function sval_s_palette_follows_the_system_appearance() {
  const cards = {};
  for (const [scheme, dark] of [
    ["dark", 1],
    ["light", 0],
  ]) {
    await SpecialPowers.pushPrefEnv({
      set: [["ui.systemUsesDarkTheme", dark]],
    });
    const { card, root } = await checkPalette(window, scheme);
    Assert.ok(!root.tint && !root.private, `${scheme}: Sval's own palette`);
    cards[scheme] = card;
    await SpecialPowers.popPrefEnv();
  }
  Assert.notDeepEqual(cards.dark, cards.light, "each appearance has its card");
  Assert.greater(
    cards.light.reduce((a, b) => a + b),
    cards.dark.reduce((a, b) => a + b),
    "the light one lighter"
  );
});

add_task(async function a_private_window_s_dialog_is_violet() {
  await SpecialPowers.pushPrefEnv({ set: [["ui.systemUsesDarkTheme", 0]] });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const { card: normal } = await checkPalette(window, "a normal window");
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20_000,
    "the private window"
  );
  atTaskEnd(() =>
    within(BrowserTestUtils.closeWindow(win), 10_000, "its closing")
  );
  const { card, root } = await checkPalette(win, "a private window");
  Assert.equal(root.private, "temporary", "the page takes the window's mode");
  Assert.notDeepEqual(card, normal, "its card is the private palette's");
  Assert.greater(card[2], card[1], "violet");
});

add_task(async function an_agent_s_window_gives_its_dialog_the_agent_palette() {
  await SpecialPowers.pushPrefEnv({ set: [["ui.systemUsesDarkTheme", 0]] });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const { card: normal } = await checkPalette(window, "a person's window");
  document.documentElement.setAttribute("data-sval-agent", "probe");
  atTaskEnd(() => document.documentElement.removeAttribute("data-sval-agent"));
  const { card, root } = await checkPalette(window, "an agent's window");
  Assert.equal(root.agent, "probe", "the page takes the window's agent");
  Assert.notDeepEqual(card, normal, "and the agent palette with it");
});

add_task(async function a_workspace_colour_s_solved_text_meets_0057() {
  const { paintTint } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalDialogBox.sys.mjs"
  );
  for (const [scheme, dark] of [
    ["dark", 1],
    ["light", 0],
  ]) {
    await SpecialPowers.pushPrefEnv({
      set: [["ui.systemUsesDarkTheme", dark]],
    });
    const answer = openSvalDialog(window, {
      title: "Rename this Workspace?",
      body: "Its tabs stay where they are.",
      primary: "Rename",
    });
    const { doc, dialog } = await openedSvalDialog();
    for (const color of SvalColor.PRESETS) {
      paintTint(doc, color, { transparency: 0 });
      Assert.ok(
        doc.documentElement.hasAttribute("data-sval-tint"),
        `${scheme}, ${color}: the card wears the colour`
      );
      checkInks(doc, dialog, `${scheme}, ${color}`, { apca: true });
    }
    EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
    await within(answer, 10_000, "the dialog's answer");
    await SpecialPowers.popPrefEnv();
  }
});
