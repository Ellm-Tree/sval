/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A dialog over a window that shows what is behind it is frosted (decision
 * 0057, `SvalDialogBox`): its box blurs the dimmed window under it and wears
 * the colour the `blur` material's root wears at the window's transparency,
 * the card and its page are clear, and the card's text is solved on that
 * colour to 0057's targets. A critical dialog stays solid, as does every
 * dialog while the system reduces transparency, over a window at no
 * transparency, and on a card drawn in a palette of its own.
 *
 * The window shows what is behind it here as it does on macOS, whatever
 * the platform the test runs on: `SvalPanel.seeThrough` answers for macOS,
 * which still honours reduced transparency. Headless Gecko draws no
 * backdrop filter in any snapshot, so the blur is read from the box's
 * computed style.
 */

const { openSvalDialog } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalDialog.sys.mjs"
);
const { SvalColor } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalColor.sys.mjs"
);

const COLOR = "blue";
const TRANSPARENCY = 0.5;

add_setup(async function a_see_through_window() {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  registerCleanupFunction(closeLeftoverDialog);
  const own = Object.getOwnPropertyDescriptor(SvalPanel, "seeThrough");
  SvalPanel.seeThrough = () =>
    SvalColor.seeThroughMaterial("macosx", query => matchMedia(query).matches);
  registerCleanupFunction(() => {
    if (own) {
      Object.defineProperty(SvalPanel, "seeThrough", own);
    } else {
      delete SvalPanel.seeThrough;
    }
    return within(SvalPanel.refresh(), 10_000, "the panel redrawing");
  });
});

/**
 * Gives the Workspace this window shows {@link COLOR} at `transparency`, as
 * its Edit dialog does, so the window keeps that look through every redraw.
 * The file's end puts the document back.
 *
 * @param {number} transparency
 */
async function tintWindow(transparency) {
  await SvalPanel.engine.mutate({
    kind: "setAppearance",
    id: SvalWindowWorkspace.of(window).id,
    color: COLOR,
    emoji: null,
    transparency,
    now: Date.now(),
  });
  await within(SvalPanel.refresh(), 10_000, "the panel redrawing");
  await TestUtils.waitForCondition(
    () =>
      SvalPanel._tintArgs?.[0] === COLOR &&
      SvalPanel._tintArgs[1] === transparency,
    "the window wears the look"
  );
}

/**
 * Opens the general dialog with `options` and waits for it.
 *
 * @param {object} [options]
 * @returns {Promise<{answer: Promise, doc: Document, dialog: Element,
 *   box: Element}>}
 */
async function opened(options = {}) {
  const answer = openSvalDialog(window, {
    title: "Rename this Workspace?",
    body: "Its tabs stay where they are.",
    primary: "Rename",
    ...options,
  });
  const { doc, dialog } = await openedSvalDialog();
  const box = doc.defaultView.frameElement.closest(".dialogBox");
  return { answer, doc, dialog, box };
}

/**
 * Closes a dialog {@link opened} gave with Escape.
 *
 * @param {object} shown
 * @param {Promise} shown.answer
 * @param {Document} shown.doc
 */
async function closeIt({ answer, doc }) {
  EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
  await within(answer, 10_000, "the dialog's answer");
}

/**
 * @param {string} css
 * @returns {object} `InspectorUtils.colorToRGBA`'s reading.
 */
function rgba(css) {
  return InspectorUtils.colorToRGBA(css);
}

/**
 * Asserts the dialog draws solid, as over an opaque window.
 *
 * @param {object} shown What {@link opened} gave.
 * @param {Document} shown.doc
 * @param {Element} shown.dialog
 * @param {Element} shown.box
 * @param {string} what
 */
function assertSolid({ doc, dialog, box }, what) {
  const view = doc.defaultView;
  Assert.equal(
    getComputedStyle(box).backdropFilter,
    "none",
    `${what}: no blur`
  );
  Assert.ok(
    !dialog.hasAttribute("frosted"),
    `${what}: the card is not frosted`
  );
  Assert.equal(
    rgba(view.getComputedStyle(dialog).backgroundColor).a,
    1,
    `${what}: the card is solid`
  );
  Assert.equal(
    rgba(getComputedStyle(box).backgroundColor).a,
    1,
    `${what}: and so is the box`
  );
}

add_task(async function a_dialog_over_a_see_through_window_is_frosted() {
  await tintWindow(TRANSPARENCY);
  Assert.ok(
    document.documentElement.hasAttribute("data-sval-see-through"),
    "the window shows what is behind it"
  );
  const shown = await opened();
  const { doc, dialog, box } = shown;
  const view = doc.defaultView;
  Assert.equal(
    getComputedStyle(box).backdropFilter,
    "blur(24px)",
    "the box blurs the window under it"
  );
  const scheme = view.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
  const more = view.matchMedia("(prefers-contrast: more)").matches;
  const look = SvalColor.windowLook(
    { color: COLOR, transparency: TRANSPARENCY },
    { scheme, more, seeThrough: "blur" }
  );
  Assert.deepEqual(
    rgba(getComputedStyle(box).backgroundColor),
    rgba(look.accent),
    "and wears what the blur material's root wears"
  );
  Assert.less(
    rgba(getComputedStyle(box).backgroundColor).a,
    1,
    "which lets the blur through"
  );
  Assert.ok(dialog.hasAttribute("frosted"), "the card is frosted");
  for (const [el, what] of [
    [dialog, "the card"],
    [doc.documentElement, "the page's root"],
    [doc.body, "its body"],
  ]) {
    Assert.equal(
      rgba(view.getComputedStyle(el).backgroundColor).a,
      0,
      `${what} is clear`
    );
  }
  Assert.notEqual(
    getComputedStyle(
      document.getElementById("window-modal-dialog"),
      "::backdrop"
    ).backgroundColor,
    "rgba(0, 0, 0, 0)",
    "over the dimmed window"
  );

  // The text is solved on what the frosted box shows (`look.tint`).
  const targets = SvalColor.requirements(more);
  const surface = look.tint;
  for (const [token, kind] of [
    ["--sval-dialog-text", "body"],
    ["--sval-dialog-body", "body"],
    ["--sval-dialog-muted", "muted"],
  ]) {
    const probe = doc.createElement("div");
    probe.style.color = `var(${token})`;
    doc.body.append(probe);
    const { r, g, b } = rgba(view.getComputedStyle(probe).color);
    probe.remove();
    const { w, lc } = SvalColor.contrast([r / 255, g / 255, b / 255], surface);
    Assert.greaterOrEqual(
      Math.round(w * 100) / 100,
      targets[kind].w,
      `${token} is ${w.toFixed(2)}:1 on the frosted card`
    );
    Assert.greaterOrEqual(
      Math.round(Math.abs(lc)),
      targets[kind].lc,
      `${token} is Lc ${lc.toFixed(1)} on the frosted card`
    );
  }
  await closeIt(shown);
});

add_task(async function a_critical_dialog_stays_solid() {
  await tintWindow(TRANSPARENCY);
  const shown = await opened({
    tone: "critical",
    icon: "critical",
    title: "Sval can't save your Workspaces",
  });
  assertSolid(shown, "critical");
  await closeIt(shown);
});

add_task(async function reduced_transparency_keeps_dialogs_solid() {
  await SpecialPowers.pushPrefEnv({
    set: [["ui.prefersReducedTransparency", 1]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  await TestUtils.waitForCondition(
    () => matchMedia("(prefers-reduced-transparency: reduce)").matches,
    "the system reduces transparency"
  );
  await tintWindow(TRANSPARENCY);
  Assert.ok(
    !document.documentElement.hasAttribute("data-sval-see-through"),
    "the window is solid"
  );
  const shown = await opened();
  assertSolid(shown, "reduced transparency");
  await closeIt(shown);
});

add_task(async function a_window_at_no_transparency_keeps_dialogs_solid() {
  await tintWindow(0);
  const shown = await opened();
  assertSolid(shown, "no transparency");
  await closeIt(shown);
});

/**
 * A dialog that previews a look, as the Workspace dialog previews the
 * colour and transparency chosen, draws that look: solid at no
 * transparency, with no colour as with one, and frosted above it.
 */
add_task(async function a_previewed_look_at_no_transparency_is_solid() {
  const { paintTint, isFrosted } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalDialogBox.sys.mjs"
  );
  await tintWindow(TRANSPARENCY);
  const shown = await opened();
  const { doc } = shown;
  Assert.ok(isFrosted(doc), "the card opens frosted over the window");
  for (const color of [null, COLOR]) {
    paintTint(doc, color, { transparency: 0 });
    Assert.ok(!isFrosted(doc), `${color ?? "no colour"} at 0% is not frosted`);
    assertSolid(shown, `${color ?? "no colour"} at 0%`);
    paintTint(doc, color, { transparency: 0.3 });
    Assert.ok(isFrosted(doc), `${color ?? "no colour"} at 30% is frosted`);
    Assert.equal(
      getComputedStyle(shown.box).backdropFilter,
      "blur(24px)",
      `${color ?? "no colour"} at 30%: the box blurs`
    );
  }
  await closeIt(shown);
});

/** The import and export pages, opened as the panel opens them. */
const PAGES = [
  ["the export page", () => SvalPanel.openExport()],
  ["the import page", () => SvalPanel.openImport({ roots: {} })],
];

/**
 * Asserts the picker's inks, which the page's card gives the window's
 * palette (`import.css`), meet 0057's targets on `surface`.
 *
 * @param {Document} doc
 * @param {Element} dialog
 * @param {number[]} surface 0..1 sRGB.
 * @param {string} what
 */
function checkPickerInks(doc, dialog, surface, what) {
  const view = doc.defaultView;
  const targets = SvalColor.requirements(
    view.matchMedia("(prefers-contrast: more)").matches
  );
  for (const [token, kind] of [
    ["--text-strong", "body"],
    ["--text-body", "body"],
    ["--text-muted", "muted"],
  ]) {
    const probe = doc.createElement("span");
    probe.style.color = `var(${token})`;
    dialog.append(probe);
    const { r, g, b } = rgba(view.getComputedStyle(probe).color);
    probe.remove();
    const { w, lc } = SvalColor.contrast([r / 255, g / 255, b / 255], surface);
    Assert.greaterOrEqual(
      Math.round(w * 100) / 100,
      targets[kind].w,
      `${what}: ${token} is ${w.toFixed(2)}:1`
    );
    Assert.greaterOrEqual(
      Math.round(Math.abs(lc)),
      targets[kind].lc,
      `${what}: ${token} is Lc ${lc.toFixed(1)}`
    );
  }
}

/**
 * The import and export pages wear the window's palette as every dialog
 * does: frosted over a see-through window and solid over a solid one, in
 * both appearances, with the picker's text solved on what the card shows.
 */
add_task(async function the_import_and_export_pages_follow_the_window() {
  for (const [scheme, dark] of [
    ["dark", 1],
    ["light", 0],
  ]) {
    await SpecialPowers.pushPrefEnv({
      set: [["ui.systemUsesDarkTheme", dark]],
    });
    for (const [page, open] of PAGES) {
      await tintWindow(TRANSPARENCY);
      let done = open();
      let { doc, dialog } = await openedSvalDialog();
      let box = doc.defaultView.frameElement.closest(".dialogBox");
      const what = `${scheme}, ${page}`;
      Assert.ok(
        !dialog.hasAttribute("solid"),
        `${what}: no palette of its own`
      );
      Assert.ok(dialog.hasAttribute("frosted"), `${what}: frosted`);
      Assert.equal(
        getComputedStyle(box).backdropFilter,
        "blur(24px)",
        `${what}: the box blurs the window`
      );
      const view = doc.defaultView;
      const look = SvalColor.windowLook(
        { color: COLOR, transparency: TRANSPARENCY },
        {
          scheme,
          more: view.matchMedia("(prefers-contrast: more)").matches,
          seeThrough: "blur",
        }
      );
      Assert.deepEqual(
        rgba(getComputedStyle(box).backgroundColor),
        rgba(look.accent),
        `${what}: in the blur material's colour`
      );
      checkPickerInks(doc, dialog, look.tint, `${what}, frosted`);
      EventUtils.synthesizeKey("KEY_Escape", {}, view);
      await within(done, 10_000, `${what}: closing`);

      await tintWindow(0);
      done = open();
      ({ doc, dialog } = await openedSvalDialog());
      box = doc.defaultView.frameElement.closest(".dialogBox");
      assertSolid({ doc, dialog, box }, `${what}, solid`);
      const { r, g, b } = rgba(
        doc.defaultView.getComputedStyle(dialog).backgroundColor
      );
      checkPickerInks(
        doc,
        dialog,
        [r / 255, g / 255, b / 255],
        `${what}, solid`
      );
      EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
      await within(done, 10_000, `${what}: closing`);
    }
    await SpecialPowers.popPrefEnv();
  }
});
