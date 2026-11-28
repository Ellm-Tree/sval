/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_panel_helpers.js */

/**
 * A Workspace's and a group's colour in the Edit dialog (decision 0057): the
 * window this Workspace shows wears each choice while the dialog is open,
 * Cancel and Escape put its colour back, and Save keeps the choice in one
 * write. A custom colour and a transparency are stored as the engine keeps
 * them, the window's text reads on what is chosen, and a group's dialog
 * wears the block the group will have. A Workspace's presets come dark and
 * light, and a custom colour is picked on a wheel and a Shade.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_panel_helpers.js",
  this
);

const { SvalColor } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalColor.sys.mjs"
);

/**
 * @param {object} engine
 * @param {string} id
 * @returns {Promise<object>} the node's appearance as the document holds it.
 */
async function storedAppearance(engine, id) {
  return (await engine.tree()).nodes[id].appearance ?? {};
}

/**
 * Opens the Edit dialog for node `id`, as Edit… does.
 *
 * @param {string} id
 * @returns {Promise<{doc: Document, closed: Promise}>} the dialog's
 *   document, its colours drawn, and the edit's end.
 */
async function openEdit(id) {
  const closed = SvalPanel.edit({ id });
  const doc = await dialogDocument(".sval-nw-swatch");
  return { doc, closed };
}

/**
 * @param {Document} doc
 * @param {string} token A preset, "" for no colour, or "custom".
 */
function clickSwatch(doc, token) {
  AccessibilityUtils.setEnv({ nonNegativeTabIndexRule: false });
  doc.querySelector(`.sval-nw-swatch[data-token="${token}"]`).click();
  AccessibilityUtils.resetEnv();
}

/**
 * @param {Document} doc
 * @param {string} label
 * @returns {Element} the colour section's slider of that name.
 */
function sliderNamed(doc, label) {
  return [...doc.querySelectorAll(".sval-cp-slider")].find(
    each => each.getAttribute("aria-label") === label
  );
}

/**
 * @param {Window} win
 * @returns {{scheme: string, more: boolean}} the appearance `win` draws in.
 */
function appearanceOf(win) {
  return {
    scheme: win.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light",
    more: win.matchMedia("(prefers-contrast: more)").matches,
  };
}

/**
 * Counts the appearance writes the panel makes from now on.
 *
 * @returns {{count: number}}
 */
function countAppearanceWrites() {
  const counter = { count: 0 };
  const engine = SvalPanel.engine;
  const mutate = engine.mutate;
  engine.mutate = function (op, ...rest) {
    if (op?.kind === "setAppearance") {
      counter.count++;
    }
    return mutate.call(this, op, ...rest);
  };
  registerCleanupFunction(() => {
    engine.mutate = mutate;
  });
  return counter;
}

/**
 * The contrast of `fg` on `bg`, both as a document paints them.
 *
 * @param {string} fg
 * @param {string} bg
 * @returns {{w: number, lc: number}}
 */
function paintedContrast(fg, bg) {
  const rgb = value => {
    const { r, g, b } = InspectorUtils.colorToRGBA(value);
    return [r / 255, g / 255, b / 255];
  };
  return SvalColor.contrast(rgb(fg), rgb(bg));
}

/** @returns {Promise<object>} the panel with a green Workspace. */
function greenWorkspace() {
  return withFreshPanel({
    before: ({ engine, ids }) =>
      engine.mutate({
        kind: "setAppearance",
        id: ids.workspace,
        color: "green",
        emoji: null,
        now: Date.now(),
      }),
  });
}

add_setup(async function the_window_is_ready() {
  await within(SvalPanel.started, 10_000, "the panel starting");
});

/**
 * Each choice shows on the window at once, and Escape puts back the colour
 * the dialog opened with, writing nothing.
 */
add_task(async function escape_puts_the_colour_back() {
  const { engine, ids } = await greenWorkspace();
  Assert.equal(SvalPanel.windowColor, "green", "the window starts green");
  const writes = countAppearanceWrites();

  const { doc, closed } = await openEdit(ids.workspace);
  clickSwatch(doc, "blue");
  Assert.equal(SvalPanel.windowColor, "blue", "the window wears blue at once");
  Assert.equal(
    (await storedAppearance(engine, ids.workspace)).color,
    "green",
    "while nothing is written yet"
  );

  doc.querySelector(".sval-nw-name").focus();
  EventUtils.synthesizeKey("KEY_Escape", {}, doc.defaultView);
  await within(closed, 10_000, "the dialog closing");
  Assert.equal(SvalPanel.windowColor, "green", "Escape puts green back");
  Assert.equal(writes.count, 0, "and writes nothing");
  Assert.ok(
    !document.documentElement.hasAttribute("data-sval-color-preview"),
    "and the window no longer previews"
  );
});

/**
 * Cancel puts the colour back as well.
 */
add_task(async function cancel_puts_the_colour_back() {
  const { ids } = await greenWorkspace();
  const { doc, closed } = await openEdit(ids.workspace);
  clickSwatch(doc, "purple");
  Assert.equal(SvalPanel.windowColor, "purple", "the window wears purple");
  doc.querySelector(".sval-nw-cancel").click();
  await within(closed, 10_000, "the dialog closing");
  Assert.equal(SvalPanel.windowColor, "green", "Cancel puts green back");
});

/**
 * A custom colour made in the dialog is kept on Save, in one write, as the
 * engine stores it, and the window's text reads on it.
 */
add_task(async function a_custom_colour_is_kept_in_one_write() {
  const { engine, ids } = await withFreshPanel();
  const writes = countAppearanceWrites();
  const { doc, closed } = await openEdit(ids.workspace);

  clickSwatch(doc, "red");
  clickSwatch(doc, "custom");
  const wheel = doc.querySelector(".sval-cp-wheel");
  Assert.ok(
    BrowserTestUtils.isVisible(wheel),
    "a custom colour opens its wheel"
  );
  wheel.focus();
  for (let i = 0; i < 20; i++) {
    EventUtils.synthesizeKey(
      "KEY_ArrowRight",
      { shiftKey: true },
      doc.defaultView
    );
  }
  const chosen = SvalPanel.windowColor;
  Assert.equal(typeof chosen, "object", "the window wears the custom colour");

  doc.querySelector(".sval-nw-create").click();
  await within(closed, 10_000, "the dialog closing");
  Assert.equal(
    writes.count,
    1,
    "Save writes once, however many changes led to it"
  );
  const stored = (await storedAppearance(engine, ids.workspace)).color;
  Assert.deepEqual(
    SvalColor.colorOf(stored, "workspace"),
    stored,
    "as a Workspace's custom colour this build draws"
  );
  Assert.ok(SvalColor.sameColor(stored, chosen), "the one the window wore");
  Assert.ok(SvalColor.sameColor(SvalPanel.windowColor, stored), "and wears");

  const root = getComputedStyle(document.documentElement);
  // A see-through window's toolbar is clear over the colour the window
  // shows, which its text is solved on (`--sval-tint`).
  const { w, lc } = paintedContrast(
    root.getPropertyValue("--toolbar-text-color"),
    root.getPropertyValue(
      document.documentElement.hasAttribute("data-sval-see-through")
        ? "--sval-tint"
        : "--toolbar-background-color"
    )
  );
  Assert.greaterOrEqual(
    w,
    4.5,
    `the toolbar's text reads at ${w.toFixed(2)}:1`
  );
  Assert.greaterOrEqual(Math.abs(lc), 75, `and at Lc ${lc.toFixed(1)}`);
});

/**
 * Where the window cannot show through, the dialog offers no Transparency,
 * and a colour changed there keeps the transparency the Workspace holds for
 * the devices that can.
 */
async function transparencyIsHiddenAndKept() {
  const { engine, ids } = await withFreshPanel({
    before: ({ engine: e, ids: i }) =>
      e.mutate({
        kind: "setAppearance",
        id: i.workspace,
        color: "blue",
        emoji: null,
        transparency: 0.5,
        now: Date.now(),
      }),
  });
  const { doc, closed } = await openEdit(ids.workspace);
  Assert.ok(
    sliderNamed(doc, "Transparency").closest(".sval-cp-row").hidden,
    "the window can't show through, so no Transparency"
  );
  clickSwatch(doc, "green");
  doc.querySelector(".sval-nw-create").click();
  await within(closed, 10_000, "the dialog closing");
  const stored = await storedAppearance(engine, ids.workspace);
  Assert.equal(stored.color, "green", "the colour is written");
  Assert.equal(
    stored.transparency,
    0.5,
    "with the transparency the Workspace held"
  );
  Assert.ok(
    !document.documentElement.hasAttribute("data-sval-see-through"),
    "and the window stays solid"
  );
}

/**
 * Transparency goes as far as the colour allows, shows on the window while
 * the dialog is open, and is stored with it. On macOS and Windows the window
 * shows the system's material through, unless the system reduces
 * transparency; elsewhere the dialog does not offer it.
 */
add_task(async function transparency_is_kept_and_shown_where_it_can_be() {
  const seeThrough = SvalColor.seeThroughMaterial(
    AppConstants.platform,
    query => matchMedia(query).matches
  );
  if (!seeThrough) {
    await transparencyIsHiddenAndKept();
    return;
  }
  const { engine, ids } = await withFreshPanel();
  const { doc, closed } = await openEdit(ids.workspace);
  const root = document.documentElement;
  const rootAlpha = () =>
    InspectorUtils.colorToRGBA(getComputedStyle(root).backgroundColor).a;
  const transparency = sliderNamed(doc, "Transparency");
  Assert.equal(
    transparency.getAttribute("aria-valuetext"),
    `${Math.round(SvalColor.DEFAULT_TRANSPARENCY * 100)}%`,
    "a Workspace that holds no transparency opens at Sval's default"
  );
  Assert.less(rootAlpha(), 1, "and its window shows through");
  clickSwatch(doc, "blue");
  transparency.focus();
  EventUtils.synthesizeKey("KEY_Home", {}, doc.defaultView);
  Assert.equal(
    rootAlpha(),
    1,
    "at no transparency the window's one background is whole"
  );
  EventUtils.synthesizeKey("KEY_End", {}, doc.defaultView);
  Assert.less(
    rootAlpha(),
    1,
    "the window shows through while the dialog is open"
  );
  Assert.equal(
    root.hasAttribute("windowsmica"),
    seeThrough === "acrylic" || seeThrough === "blur",
    "on Windows and Linux the window asks for the system's backdrop behind it"
  );
  // The header eases its colour, so it is read as the colour it is given.
  Assert.equal(
    getComputedStyle(document.getElementById("navigator-toolbox"))
      .getPropertyValue("--toolbox-background-color")
      .trim(),
    "transparent",
    "the toolbox is clear over the window's background"
  );
  for (const id of ["sval-panel-container", "browser"]) {
    Assert.equal(
      getComputedStyle(document.getElementById(id)).backgroundColor,
      "rgba(0, 0, 0, 0)",
      `#${id} is clear over the window's background`
    );
  }
  doc.querySelector(".sval-nw-create").click();
  await within(closed, 10_000, "the dialog closing");

  const scheme = matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
  Assert.equal(
    (await storedAppearance(engine, ids.workspace)).transparency,
    SvalColor.round(SvalColor.maxTransparency("blue", scheme, false), 2),
    "the transparency is written"
  );
  Assert.less(rootAlpha(), 1, "and the window keeps showing through");
});

/**
 * No colour is Sval's own colour, see-through like any other where the
 * window can show what is behind it: the dialog offers Transparency with it,
 * the window shows through, and the Workspace keeps no colour and the
 * transparency.
 */
add_task(async function no_colour_can_be_see_through() {
  const seeThrough = SvalColor.seeThroughMaterial(
    AppConstants.platform,
    query => matchMedia(query).matches
  );
  const { engine, ids } = await withFreshPanel();
  const { doc, closed } = await openEdit(ids.workspace);
  const row = sliderNamed(doc, "Transparency").closest(".sval-cp-row");
  if (!seeThrough) {
    Assert.ok(row.hidden, "the window can't show through, so no Transparency");
    doc.querySelector(".sval-nw-cancel").click();
    await within(closed, 10_000, "the dialog closing");
    return;
  }
  Assert.ok(!row.hidden, "No color offers Transparency");
  const root = document.documentElement;
  const transparency = sliderNamed(doc, "Transparency");
  transparency.focus();
  EventUtils.synthesizeKey("KEY_End", {}, doc.defaultView);
  Assert.ok(
    root.hasAttribute("data-sval-see-through"),
    "the window shows through with no colour"
  );
  Assert.ok(
    root.hasAttribute("data-sval-translucent"),
    "and its menus show through with it"
  );
  Assert.less(
    InspectorUtils.colorToRGBA(getComputedStyle(root).backgroundColor).a,
    1,
    "its background lets what is behind it through"
  );
  doc.querySelector(".sval-nw-create").click();
  await within(closed, 10_000, "the dialog closing");
  const stored = await storedAppearance(engine, ids.workspace);
  Assert.equal(stored.color ?? null, null, "the Workspace keeps no colour");
  Assert.equal(
    stored.transparency,
    SvalColor.round(SvalColor.maxTransparency(), 2),
    "and the transparency is written"
  );
  Assert.ok(
    root.hasAttribute("data-sval-see-through"),
    "and the window keeps showing through"
  );
});

/**
 * A system that reduces transparency gets the solid window, and the dialog
 * hides Transparency and keeps the stored value, on every platform.
 */
add_task(async function reduced_transparency_hides_it_and_keeps_it() {
  await SpecialPowers.pushPrefEnv({
    set: [["ui.prefersReducedTransparency", 1]],
  });
  await TestUtils.waitForCondition(
    () => matchMedia("(prefers-reduced-transparency: reduce)").matches,
    "the system reduces transparency"
  );
  await transparencyIsHiddenAndKept();
  await SpecialPowers.popPrefEnv();
});

/**
 * A group's dialog wears the block the group will have, fits its width, and
 * picks a custom colour on a wheel of every hue whose intensity the arrow
 * keys move, with no Shade and no Transparency.
 */
add_task(async function a_groups_dialog_wears_its_block() {
  const { ids } = await withFreshPanel();
  const { doc, closed } = await openEdit(ids.groupA);
  const view = doc.defaultView;
  const card = () =>
    view.getComputedStyle(doc.querySelector("sval-dialog")).backgroundColor;
  const painted = colour => {
    const probe = doc.body.appendChild(doc.createElement("div"));
    probe.style.backgroundColor = colour;
    const value = view.getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  };
  const { scheme } = appearanceOf(view);
  Assert.equal(
    doc.querySelectorAll(".sval-nw-swatch").length,
    SvalColor.PRESETS.length + 2,
    "a group's presets are one row"
  );
  clickSwatch(doc, "orange");
  Assert.equal(
    card(),
    painted(
      SvalColor.swatchOf("orange", "group", {
        scheme,
        on: SvalPanel.windowBlockSurface(),
      })
    ),
    "the card is the group's block on this window"
  );

  clickSwatch(doc, "custom");
  const wheel = doc.querySelector(".sval-cp-wheel");
  Assert.ok(BrowserTestUtils.isVisible(wheel), "a group picks on a wheel");
  // The frame grows to the card a moment after it does.
  await TestUtils.waitForCondition(
    () => doc.documentElement.scrollWidth <= doc.documentElement.clientWidth,
    "the dialog fits its width"
  );
  const canvas = wheel.querySelector("canvas");
  const context = canvas.getContext("2d");
  const R = canvas.width / 2;
  const hues = [0, 90, 180, 270].map(deg => {
    const a = (deg * Math.PI) / 180;
    const [r, g, b] = context.getImageData(
      Math.floor(R + 0.8 * R * Math.cos(a)),
      Math.floor(R - 0.8 * R * Math.sin(a)),
      1,
      1
    ).data;
    return SvalColor.toOklch([r / 255, g / 255, b / 255])[2];
  });
  Assert.greater(
    Math.max(...hues) - Math.min(...hues),
    180,
    `the wheel holds every hue: ${hues.map(Math.round).join(", ")}`
  );
  Assert.ok(!sliderNamed(doc, "Shade"), "a group has no Shade");
  wheel.focus();
  for (let i = 0; i < 10; i++) {
    EventUtils.synthesizeKey("KEY_ArrowDown", { shiftKey: true }, view);
  }
  Assert.equal(
    wheel.getAttribute("aria-valuenow"),
    "0",
    "down to no intensity"
  );
  const grey = card();
  for (let i = 0; i < 10; i++) {
    EventUtils.synthesizeKey("KEY_ArrowUp", { shiftKey: true }, view);
  }
  Assert.equal(
    wheel.getAttribute("aria-valuenow"),
    "100",
    "and up to its most"
  );
  Assert.notEqual(card(), grey, "and the block follows it");
  Assert.ok(!sliderNamed(doc, "Transparency"), "a group has no transparency");
  doc.querySelector(".sval-nw-cancel").click();
  await within(closed, 10_000, "the dialog closing");
});

/**
 * A coloured group's quieter text, such as an unloaded tab's name, is the
 * muted ink solved on its block, and reads on the block as the row draws it.
 */
add_task(async function a_groups_muted_text_reads_on_its_block() {
  const { engine, ids } = await withFreshPanel();
  for (const color of ["yellow", { h: 150, c: 0.2 }]) {
    await engine.mutate({
      kind: "setAppearance",
      id: ids.groupA,
      color,
      emoji: null,
      now: Date.now(),
    });
    await SvalPanel.refresh();
    const row = SvalPanel._rowElementFor(ids.groupA);
    const style = getComputedStyle(row);
    const muted = style.getPropertyValue("--sval-accent-muted").trim();
    Assert.ok(muted, `${JSON.stringify(color)} has its muted ink`);
    Assert.equal(
      style.getPropertyValue("--text-color-deemphasized").trim(),
      muted,
      "which is the row's quieter text"
    );
    const { w, lc } = paintedContrast(muted, style.backgroundColor);
    Assert.greaterOrEqual(w, 4.5, `it reads at ${w.toFixed(2)}:1`);
    Assert.greaterOrEqual(Math.abs(lc), 60, `and at Lc ${lc.toFixed(1)}`);
  }
});

/**
 * A Workspace's presets come in two rows. The version that suits the
 * appearance is the preset itself; the other is a custom colour that stays
 * as its swatch shows it, in both appearances. White takes Black's place in
 * the light row.
 */
add_task(async function each_preset_comes_dark_and_light() {
  const { engine, ids } = await withFreshPanel();
  const { doc, closed } = await openEdit(ids.workspace);
  const { scheme, more } = appearanceOf(doc.defaultView);
  const other = scheme === "dark" ? "light" : "dark";
  const bySlot = slot => doc.querySelector(`[data-slot="${slot}"]`);

  Assert.equal(
    doc.querySelectorAll('.sval-nw-swatch[data-row="2"]').length,
    SvalColor.PRESETS.length,
    "the light row holds a swatch under each preset"
  );
  Assert.ok(bySlot("light:white"), "White among them");
  Assert.ok(!bySlot("light:black"), "in Black's place");

  clickSwatch(doc, "pink");
  Assert.equal(
    bySlot(`${scheme}:pink`).getAttribute("aria-checked"),
    "true",
    "the version that suits the appearance is the preset"
  );
  Assert.equal(SvalPanel.windowColor, "pink", "which the window wears");

  AccessibilityUtils.setEnv({ nonNegativeTabIndexRule: false });
  bySlot(`${other}:pink`).click();
  AccessibilityUtils.resetEnv();
  const chosen = SvalPanel.windowColor;
  Assert.equal(typeof chosen, "object", "the other version is custom");
  Assert.deepEqual(
    chosen,
    SvalColor.presetVersion("pink", other, scheme, more),
    "pink's window in the other appearance"
  );
  Assert.equal(
    bySlot(`${other}:pink`).getAttribute("aria-checked"),
    "true",
    "and its swatch is the one chosen"
  );
  Assert.ok(
    doc.querySelector(".sval-cp-custom").hidden,
    "a preset's version opens no wheel"
  );
  Assert.deepEqual(
    SvalColor.windowTint(chosen, "dark", more),
    SvalColor.windowTint(chosen, "light", more),
    "it stays as shown in both appearances"
  );

  AccessibilityUtils.setEnv({ nonNegativeTabIndexRule: false });
  bySlot("light:white").click();
  AccessibilityUtils.resetEnv();
  const white = SvalPanel.windowColor;
  Assert.equal(white.c, 0, "White is neutral");
  Assert.equal(
    white.l,
    SvalColor.allowedLs(white.h, 0, more).at(-1),
    "at the lightest the text allows"
  );
  Assert.ok(
    !SvalColor.isDarkSurface(SvalColor.windowTint(white, scheme, more), more),
    "and takes dark text"
  );

  doc.querySelector(".sval-nw-create").click();
  await within(closed, 10_000, "the dialog closing");
  Assert.deepEqual(
    (await storedAppearance(engine, ids.workspace)).color,
    white,
    "Save keeps White"
  );
});

/**
 * The wheel picks the hue and intensity under the pointer at the Workspace
 * colour's shade, and its arrow keys move them. Shade runs over every
 * lightness the text allows, dark to light: crossing the gap turns the text
 * over by itself, and nothing in the dialog moves while the colour changes.
 */
add_task(async function the_wheel_and_shade_pick_a_colour() {
  const { ids } = await withFreshPanel();
  const { doc, closed } = await openEdit(ids.workspace);
  const win = doc.defaultView;
  const { scheme, more } = appearanceOf(win);
  clickSwatch(doc, "blue");
  clickSwatch(doc, "custom");
  const wheel = doc.querySelector(".sval-cp-wheel");
  const shade = sliderNamed(doc, "Shade");
  const box = wheel.getBoundingClientRect();
  // Where the parts sit in the card, which focus may scroll.
  const card = doc.querySelector(".sval-nw");
  const layout = () => {
    const top = card.getBoundingClientRect().top;
    return [
      wheel.getBoundingClientRect().top - top,
      shade.getBoundingClientRect().top - top,
      card.getBoundingClientRect().width,
      card.getBoundingClientRect().height,
    ];
  };
  const start = layout();
  const stays = what => {
    Assert.deepEqual(layout(), start, `nothing moves ${what}`);
  };
  const takesLightText = () =>
    SvalColor.isDarkSurface(
      SvalColor.windowTint(SvalPanel.windowColor, scheme, more),
      more
    );

  // Up and to the right of the centre, half way out: hue 45, half intensity.
  const R = box.width / 2;
  const at = (deg, out) => [
    R + out * R * Math.cos((deg * Math.PI) / 180),
    R - out * R * Math.sin((deg * Math.PI) / 180),
  ];
  const [x1, y1] = at(45, 0.5);
  // A slider has no accessible action: the keyboard is its accessible way
  // in (tested below), and the pointer drag is checked here.
  AccessibilityUtils.setEnv({ actionCountRule: false });
  EventUtils.synthesizeMouse(wheel, x1, y1, { type: "mousedown" }, win);
  let color = SvalPanel.windowColor;
  Assert.less(Math.abs(color.h - 45), 3, `a press picks its hue: ${color.h}`);
  Assert.less(
    Math.abs(color.c - SvalColor.CHROMA_MAX / 2),
    0.01,
    `and its intensity: ${color.c}`
  );
  const side = takesLightText();
  const [x2, y2] = at(200, 0.9);
  EventUtils.synthesizeMouse(wheel, x2, y2, { type: "mousemove" }, win);
  // A move is drawn on the next frame (`SvalColorPicker._drag`).
  await within(
    TestUtils.waitForCondition(
      () => SvalPanel.windowColor !== color,
      "the move drawn"
    ),
    10_000,
    "the move drawn"
  );
  color = SvalPanel.windowColor;
  Assert.less(Math.abs(color.h - 200), 3, `a drag follows it: ${color.h}`);
  Assert.equal(takesLightText(), side, "at the same shade");
  Assert.ok(
    SvalColor.allowedLs(color.h, color.c, more).includes(color.l),
    "at a lightness the text allows"
  );
  stays("during a drag");
  EventUtils.synthesizeMouse(wheel, x2, y2, { type: "mouseup" }, win);
  AccessibilityUtils.resetEnv();

  wheel.focus();
  EventUtils.synthesizeKey("KEY_ArrowLeft", {}, win);
  Assert.less(
    Math.abs(SvalPanel.windowColor.h - color.h - 5),
    0.2,
    "Left turns the hue"
  );
  EventUtils.synthesizeKey("KEY_ArrowUp", {}, win);
  Assert.greater(SvalPanel.windowColor.c, color.c, "and Up adds intensity");

  shade.focus();
  EventUtils.synthesizeKey("KEY_Home", {}, win);
  Assert.ok(takesLightText(), "Shade starts dark, under light text");
  Assert.equal(shade.dataset.side, "deep");
  const { h, c } = SvalPanel.windowColor;
  const allowed = SvalColor.allowedLs(h, c, more);
  Assert.equal(SvalPanel.windowColor.l, allowed[0], "at the darkest allowed");
  let flips = 0;
  let before = takesLightText();
  for (let i = 1; i < allowed.length; i++) {
    EventUtils.synthesizeKey("KEY_ArrowRight", {}, win);
    Assert.equal(SvalPanel.windowColor.l, allowed[i], "one shade at a time");
    if (takesLightText() !== before) {
      flips++;
      before = takesLightText();
    }
  }
  Assert.equal(flips, 1, "the text turns over once, at the gap");
  Assert.ok(!takesLightText(), "and Shade ends light, under dark text");
  Assert.equal(shade.dataset.side, "pale");
  stays("as Shade crosses the gap");

  doc.querySelector(".sval-nw-cancel").click();
  await within(closed, 10_000, "the dialog closing");
});

/**
 * Custom opens on the colour on show, a preset or its version for the other
 * appearance, so the person tweaks what they see. With no colour chosen it
 * opens on Sval's own window colour, whatever custom colour came before.
 */
add_task(async function custom_starts_from_the_colour_on_show() {
  const { ids } = await withFreshPanel();
  const { doc, closed } = await openEdit(ids.workspace);
  const { scheme, more } = appearanceOf(doc.defaultView);
  const shown = () => SvalColor.windowTint(SvalPanel.windowColor, scheme, more);
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 2 / 255);

  const ownColor = SvalColor.customFrom(null, scheme, more);
  clickSwatch(doc, "custom");
  Assert.ok(
    SvalColor.sameColor(SvalPanel.windowColor, ownColor),
    "with no colour chosen, Custom opens on Sval's own colour"
  );

  for (const row of ["1", "2"]) {
    const swatch = doc.querySelector(
      `.sval-nw-swatch[data-row="${row}"][data-col="3"]`
    );
    clickSwatch(doc, swatch.dataset.token);
    const before = shown();
    clickSwatch(doc, "custom");
    Assert.equal(
      doc.querySelector(".sval-nw-swatch[aria-checked='true']").dataset.slot,
      "custom",
      `Custom is chosen after row ${row}'s preset`
    );
    Assert.equal(typeof SvalPanel.windowColor, "object", "as a custom colour");
    Assert.ok(near(shown(), before), "that looks as the preset did");
  }

  clickSwatch(doc, "");
  clickSwatch(doc, "custom");
  Assert.ok(
    SvalColor.sameColor(SvalPanel.windowColor, ownColor),
    "after No color, Custom opens on Sval's own colour again"
  );

  doc.querySelector(".sval-nw-cancel").click();
  await within(closed, 10_000, "the dialog closing");
});

/**
 * What the home page in `tab` was last handed: the colour it names and the
 * frame colour it meets.
 *
 * @param {Element} tab
 * @returns {Promise<{tint: ?string, edge: string}>}
 */
function homeLookOf(tab) {
  return SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const root = content.document.documentElement;
    return {
      tint: root.getAttribute("data-sval-tint"),
      edge: root.style.getPropertyValue("--g-tint").trim(),
    };
  });
}

/**
 * The home page follows every colour the window shows: each choice in the
 * Edit dialog while it is open, and the colour saved, through a preset, a
 * light custom colour, another preset and a dark custom colour.
 */
add_task(async function the_home_page_follows_each_colour() {
  const { ids } = await withFreshPanel();
  const tab = await openPage("about:home");
  const rgba = value => InspectorUtils.colorToRGBA(value);
  const followed = async what => {
    const want = {
      tint: SvalColor.colorKey(SvalPanel.windowColor),
      edge: rgba(
        getComputedStyle(document.documentElement)
          .getPropertyValue("--sval-tint")
          .trim()
      ),
    };
    let seen;
    await within(
      TestUtils.waitForCondition(async () => {
        seen = await homeLookOf(tab);
        return seen.tint === want.tint;
      }, what),
      10_000,
      what
    );
    Assert.deepEqual(rgba(seen.edge), want.edge, `${what}: its frame colour`);
  };
  const choose = async (what, pick) => {
    const { doc, closed } = await openEdit(ids.workspace);
    pick(doc);
    await followed(`${what}, while the dialog is open`);
    doc.querySelector(".sval-nw-create").click();
    await within(closed, 10_000, "the dialog closing");
    await followed(`${what}, saved`);
  };
  const shadeTo = (doc, key) => {
    clickSwatch(doc, "custom");
    sliderNamed(doc, "Shade").focus();
    EventUtils.synthesizeKey(key, {}, doc.defaultView);
  };
  await choose("a preset", doc => clickSwatch(doc, "blue"));
  await choose("a light custom colour", doc => shadeTo(doc, "KEY_End"));
  await choose("another preset", doc => clickSwatch(doc, "purple"));
  await choose("a dark custom colour", doc => shadeTo(doc, "KEY_Home"));
  BrowserTestUtils.removeTab(tab);
});
