/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { SvalColor, testing } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalColor.sys.mjs"
);

const SCHEMES = ["dark", "light"];

/**
 * A CSS colour `SvalColor.css` wrote, back in gamma sRGB.
 *
 * @param {string} value
 * @returns {number[]}
 */
function rgbOf(value) {
  return value
    .match(/[\d.]+/g)
    .slice(0, 3)
    .map(v => Number(v) / 255);
}

/**
 * Every ink of a window look against the surface it is drawn on, at that
 * surface's worst backdrop: the failures, as text.
 *
 * @param {object} look `SvalColor.windowLook`'s answer.
 * @param {boolean} more
 * @returns {string[]}
 */
function failuresOf(look, more) {
  const R = SvalColor.requirements(more);
  const { window, field, secondary, popup, selected, selectedHover } =
    look.surfaces;
  const checks = [
    ["title", look.strong, window, R.body],
    ["selected row", look.strong, selected, R.body],
    ["hovered selected row", look.strong, selectedHover, R.body],
    ["on switch on the window", look.switchOn, window, R.line],
    ["on switch on a popup", look.switchOn, popup, R.line],
    ["body", look.body, window, R.body],
    ["muted", look.muted, window, R.muted],
    ["line", look.line, window, R.line],
    ["address bar", look.fieldInk, field, R.body],
    ["address bar muted", look.fieldMuted, field, R.muted],
    ["button", look.secondaryInk, secondary, R.body],
  ];
  const out = [];
  for (const [name, ink, surface, req] of checks) {
    if (!testing.meets(ink, surface, req)) {
      const { w, lc } = SvalColor.contrast(ink, surface);
      out.push(`${name} ${w.toFixed(2)}:1 Lc ${lc.toFixed(1)}`);
    }
  }
  return out;
}

/**
 * The transparencies a window is checked at: solid, part way, and the most
 * its colour allows.
 *
 * @param {string|object} color
 * @param {string} scheme
 * @param {boolean} more
 * @returns {number[]}
 */
function transparenciesOf(color, scheme, more) {
  const max = SvalColor.maxTransparency(color, scheme, more);
  return [...new Set([0, max / 2, max])];
}

/**
 * Every preset's window, in both appearances, with and without more
 * contrast, solid and as see-through as it may be: each text meets its
 * target at the surface's worst backdrop.
 */
add_task(function every_preset_meets_its_targets() {
  for (const more of [false, true]) {
    for (const scheme of SCHEMES) {
      for (const color of SvalColor.PRESETS) {
        for (const transparency of transparenciesOf(color, scheme, more)) {
          const look = SvalColor.windowLook(
            { color, transparency },
            { scheme, more, seeThrough: "hud" }
          );
          Assert.deepEqual(
            failuresOf(look, more),
            [],
            `${color} in ${scheme}${more ? ", more contrast" : ""} at ${Math.round(transparency * 100)}%`
          );
        }
      }
    }
  }
});

/**
 * The distance between two colours in OKLab.
 *
 * @param {number[]} a Gamma sRGB.
 * @param {number[]} b
 * @returns {number}
 */
function deltaE(a, b) {
  const lab = rgb => {
    const [L, C, h] = SvalColor.toOklch(rgb);
    return [
      L,
      C * Math.cos((h * Math.PI) / 180),
      C * Math.sin((h * Math.PI) / 180),
    ];
  };
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/**
 * Each preset's window in each appearance is told apart from the next one
 * the picker shows beside it, with and without more contrast, and a light
 * window takes dark text.
 */
add_task(function neighbouring_presets_are_distinct() {
  for (const more of [false, true]) {
    for (const scheme of SCHEMES) {
      const tints = SvalColor.PRESETS.map(color => [
        color,
        SvalColor.windowTint(color, scheme, more),
      ]);
      for (let i = 0; i + 1 < tints.length; i++) {
        const [a, ta] = tints[i];
        const [b, tb] = tints[i + 1];
        Assert.greaterOrEqual(
          deltaE(ta, tb),
          0.04,
          `${a} and ${b} in ${scheme}${more ? ", more contrast" : ""}`
        );
      }
      if (scheme === "light") {
        for (const [color, tint] of tints.filter(([c]) => c !== "black")) {
          Assert.ok(
            !SvalColor.isDarkSurface(tint, more),
            `${color}'s light window takes dark text`
          );
        }
      }
    }
  }
});

/**
 * Each preset's version for its own appearance is the preset. The other is
 * a custom colour that looks as the preset does in that appearance, and
 * stays so in both. White is the lightest neutral that takes dark text.
 */
add_task(function each_preset_has_a_version_for_each_appearance() {
  for (const more of [false, true]) {
    for (const scheme of SCHEMES) {
      const other = scheme === "dark" ? "light" : "dark";
      for (const name of SvalColor.PRESETS) {
        Assert.equal(
          SvalColor.presetVersion(name, scheme, scheme, more),
          name,
          `${name}'s ${scheme} version in ${scheme} is the preset`
        );
        if (name === "black") {
          continue;
        }
        const version = SvalColor.presetVersion(name, other, scheme, more);

        const shown = SvalColor.windowTint(version, scheme, more);
        Assert.less(
          deltaE(shown, SvalColor.windowTint(name, other, more)),
          0.02,
          `${name}'s ${other} version in ${scheme} looks as ${name} does in ${other}`
        );
        Assert.deepEqual(
          SvalColor.windowTint(version, other, more),
          shown,
          "and stays so"
        );
      }
      const white = SvalColor.presetVersion("white", "light", scheme, more);
      const tint = SvalColor.windowTint(white, scheme, more);
      Assert.equal(white.c, 0, "White is neutral");
      Assert.equal(
        white.l,
        SvalColor.allowedLs(white.h, 0, more).at(-1),
        "and as light as the text allows"
      );
      Assert.ok(!SvalColor.isDarkSurface(tint, more), "taking dark text");
      Assert.greaterOrEqual(
        deltaE(tint, SvalColor.windowTint("gray", "light", more)),
        0.04,
        "apart from Gray's light window beside it"
      );
    }
  }
});

/**
 * A sweep of custom colours over the hue circle, the chroma the picker
 * offers and the lightnesses it allows, picked in either appearance and
 * shown in both: every text meets its target, solid and see-through.
 */
add_task(function custom_colours_meet_their_targets() {
  const failed = [];
  let checked = 0;
  for (const more of [false, true]) {
    for (let h = 0; h < 360; h += 30) {
      for (const c of [0, 0.06, 0.12, 0.25]) {
        const Ls = SvalColor.allowedLs(h, c, more);
        const picks = [Ls[0], Ls[Math.floor(Ls.length / 2)], Ls.at(-1)];
        for (const l of picks) {
          for (const mode of SCHEMES) {
            const color = { h, c, l, mode };
            for (const scheme of SCHEMES) {
              for (const transparency of transparenciesOf(
                color,
                scheme,
                more
              )) {
                checked++;
                const look = SvalColor.windowLook(
                  { color, transparency },
                  { scheme, more, seeThrough: "hud" }
                );
                const failures = failuresOf(look, more);
                if (failures.length) {
                  failed.push(
                    `${JSON.stringify(color)} in ${scheme} at ${transparency.toFixed(2)}: ${failures.join(", ")}`
                  );
                }
              }
            }
          }
        }
      }
    }
  }
  Assert.greater(checked, 1000, `the sweep checked ${checked} windows`);
  Assert.deepEqual(failed.slice(0, 10), [], "no custom colour misses");
});

/**
 * The picker's Shade offers only lightnesses body text meets its target on,
 * and splits them by the side the text takes.
 */
add_task(function the_shades_hold_only_colours_that_pass() {
  const R = SvalColor.requirements(false);
  for (let h = 0; h < 360; h += 45) {
    const { all, pale, deep } = SvalColor.bands(h, 0.12, false);
    Assert.equal(pale.length + deep.length, all.length);
    for (const L of all) {
      Assert.ok(
        testing.anySide(SvalColor.oklch(L, 0.12, h), R.body),
        `L ${L} at hue ${h} takes readable text`
      );
    }
    for (const L of deep) {
      Assert.ok(
        SvalColor.isDarkSurface(SvalColor.oklch(L, 0.12, h), false),
        "a deep colour takes light text"
      );
    }
  }
});

/**
 * Every colour can go to the same transparency: its layer keeps a share of
 * the colour over the material (decision 0057).
 */
add_task(function every_colour_reaches_the_same_transparency() {
  for (const color of [
    ...SvalColor.PRESETS,
    { h: 45, c: 0.18, l: 0.6, mode: "light" },
  ]) {
    for (const scheme of ["dark", "light"]) {
      Assert.equal(
        SvalColor.windowLook(
          { color, transparency: 1 },
          { scheme, seeThrough: "hud" }
        ).transparency,
        0.65,
        `${JSON.stringify(color)} in ${scheme} stops at 65%`
      );
    }
  }
});

/**
 * A group's block lets through half of what its window does, so a
 * see-through window's groups are tinted glass too, and a solid window's
 * are solid.
 */
add_task(function a_groups_block_takes_the_windows_share() {
  const share = transparency =>
    SvalColor.windowProperties(
      SvalColor.windowLook(
        { color: "purple", transparency },
        { scheme: "dark", seeThrough: "hud" }
      )
    )["--sval-tint-alpha"];
  Assert.equal(share(0), "1", "a solid window's blocks are solid");
  Assert.equal(share(0.4), "0.8", "a see-through window's blocks half as much");
});

/**
 * A window is see-through only where it can be, and wears its colour at the
 * share it keeps, whole at no transparency.
 */
add_task(function transparency_is_clamped_and_native() {
  const solid = SvalColor.windowLook(
    { color: "blue", transparency: 0.5 },
    { scheme: "dark", seeThrough: null }
  );
  Assert.equal(
    solid.transparency,
    0,
    "a window that cannot see through is solid"
  );
  Assert.equal(solid.accent, null, "and wears no colour of its own");

  const whole = SvalColor.windowLook(
    { color: "blue", transparency: 0 },
    { scheme: "dark", seeThrough: "hud" }
  );
  Assert.equal(
    whole.accent,
    SvalColor.css(whole.tint),
    "a window that can see through, at none, wears its colour whole"
  );

  const clear = SvalColor.windowLook(
    { color: "blue", transparency: 1 },
    { scheme: "dark", seeThrough: "hud" }
  );
  Assert.equal(
    clear.accent,
    SvalColor.css(whole.tint, 0.35),
    "in the colour itself, at the share it keeps"
  );
});

/**
 * Linux offers a see-through window only where the compositor blurs what is
 * behind it, and the window paints the material the compositor lacks under
 * its colour: over a black and a white wallpaper it shows what `hud` shows.
 */
add_task(function a_blurred_window_paints_hud_over_the_blur() {
  const matches = mica => query =>
    query === "(-moz-windows-mica)" ? mica : false;
  Assert.equal(SvalColor.seeThroughMaterial("linux", matches(true)), "blur");
  Assert.equal(SvalColor.seeThroughMaterial("linux", matches(false)), null);

  for (const scheme of SCHEMES) {
    const look = transparency =>
      SvalColor.windowLook(
        { color: "blue", transparency },
        { scheme, seeThrough: "blur" }
      );
    const whole = look(0);
    Assert.equal(
      whole.accent,
      SvalColor.css(whole.tint),
      `${scheme}: at none the window wears its colour whole`
    );
    const t = 0.5;
    const accent = look(t).accent;
    const alpha = Number(accent.match(/\/ ([\d.]+)/)[1]);
    const rgb = rgbOf(accent);
    // hud's measures over black and white wallpapers, in the material's
    // appearance (`SvalColor.sys.mjs`, MATERIAL_MID).
    const [black, white] =
      whole.side === "light" ? [18 / 255, 171.5 / 255] : [113 / 255, 246 / 255];
    for (const [name, wallpaper, shows] of [
      ["black", 0, black],
      ["white", 1, white],
    ]) {
      rgb.forEach((v, i) => {
        const seen = v * alpha + wallpaper * (1 - alpha);
        const want = whole.tint[i] * (1 - t) + shows * t;
        Assert.less(
          Math.abs(seen - want),
          1.5 / 255,
          `${scheme}, over ${name}: channel ${i} shows hud under the colour`
        );
      });
    }
  }
});

/**
 * No colour is Sval's own window: drawn by Sval's own styles while solid,
 * and as Sval's own colour, like any other, while see-through. Custom starts
 * from it as it looks.
 */
add_task(function no_colour_is_svals_own_colour() {
  for (const scheme of SCHEMES) {
    for (const seeThrough of [null, "hud", "acrylic", "blur"]) {
      Assert.equal(
        SvalColor.windowLook(
          { color: null, transparency: seeThrough ? 0 : 0.4 },
          { scheme, seeThrough }
        ),
        null,
        `${scheme}, ${seeThrough}: a solid window with no colour is Sval's own`
      );
    }
    const own = SvalColor.windowTint(null, scheme, false);
    const look = SvalColor.windowLook(
      { color: null, transparency: 0.4 },
      { scheme, seeThrough: "acrylic" }
    );
    Assert.equal(
      look.accent,
      SvalColor.css(own, 0.6),
      `${scheme}: a see-through window with no colour wears Sval's own`
    );
    Assert.equal(
      look.side,
      SvalColor.isDarkSurface(own, false) ? "light" : "dark",
      `${scheme}: with text on the side Sval's own colour gives`
    );
    const custom = SvalColor.windowTint(
      SvalColor.customFrom(null, scheme, false),
      scheme,
      false
    );
    Assert.ok(
      custom.every((v, i) => Math.abs(v - own[i]) < 2 / 255),
      `${scheme}: Custom starts from Sval's own colour as it looks`
    );
  }
});

/**
 * Every colour's home page is the night sky under a wash of the colour the
 * window shows, as strong as the page's light text allows: a dark colour
 * washes strongly, a light one weakly. The text, solved on the sky's
 * lightest stop under the wash at its strongest, meets its targets, with
 * and without more contrast.
 */
add_task(function the_home_page_wears_a_wash_of_the_colour() {
  const sky = [0x13 / 255, 0x32 / 255, 0x8f / 255];
  const alphaOf = value => Number(value.match(/\/ ([\d.]+)\)/)?.[1] ?? 1);
  for (const scheme of SCHEMES) {
    for (const more of [false, true]) {
      const R = SvalColor.requirements(more);
      const looks = {
        yellow: SvalColor.windowLook({ color: "yellow" }, { scheme, more }),
        blue: SvalColor.windowLook({ color: "blue" }, { scheme, more }),
        black: SvalColor.windowLook({ color: "black" }, { scheme, more }),
        "light custom": SvalColor.windowLook(
          { color: { h: 95, c: 0.07, l: 0.92, mode: scheme } },
          { scheme, more }
        ),
        "dark custom": SvalColor.windowLook(
          { color: { h: 150, c: 0.07, l: 0.3, mode: scheme } },
          { scheme, more }
        ),
        "no colour, see-through": SvalColor.windowLook(
          { color: null, transparency: 0.5 },
          { scheme, more, seeThrough: "acrylic" }
        ),
      };
      for (const [name, look] of Object.entries(looks)) {
        const what = `${scheme}${more ? ", more" : ""}, ${name}`;
        const { home } = look;
        Assert.equal(
          rgbOf(home.edge).join(),
          rgbOf(SvalColor.css(look.tint)).join(),
          `${what}: the wash is the colour the window shows`
        );
        Assert.equal(alphaOf(home.edge), home.alpha, `${what}: its strength`);
        const tint = rgbOf(SvalColor.css(look.tint));
        const under = sky.map(
          (v, i) =>
            Math.round(((1 - home.alpha) * v + home.alpha * tint[i]) * 255) /
            255
        );
        Assert.ok(
          testing.meets(rgbOf(home.body), under, R.body),
          `${what}: the page's text reads where the wash is strongest`
        );
        Assert.ok(
          testing.meets(rgbOf(home.muted), under, R.muted),
          `${what}: and its quieter text`
        );
        const [glowL, , glowH] = SvalColor.toOklch(rgbOf(home.glow));
        const [, tintC, tintH] = SvalColor.toOklch(tint);
        Assert.greaterOrEqual(
          glowL,
          0.6,
          `${what}: the mark's glow is light enough to show on the sky`
        );
        if (tintC > 0.03) {
          Assert.less(
            Math.abs(((glowH - tintH + 540) % 360) - 180),
            12,
            `${what}: in the colour's hue`
          );
        }
      }
      Assert.less(
        looks["light custom"].home.alpha,
        looks["dark custom"].home.alpha,
        `${scheme}: a light colour washes the sky more weakly than a dark one`
      );
    }
  }
});

/**
 * A see-through window's colour is the one it shows: its own colour mixed
 * with the material's middle at the share the transparency leaves, the
 * material in the appearance its text side gives. Where its text could not
 * meet its target on that mix, the colour moves only as far as the target
 * needs, in lightness away from the text. Its text
 * keeps its side at every transparency and meets its targets on that
 * colour, and at none the window is its colour itself.
 */
add_task(function a_see_through_window_shows_its_colour_over_the_material() {
  const colors = [
    ...SvalColor.PRESETS,
    { h: 290, c: 0.12, l: 0.36, mode: "dark" },
    { h: 45, c: 0.18, l: 0.6, mode: "light" },
    { h: 200, c: 0.07, l: 0.9, mode: "light" },
  ];
  let mixes = 0;
  for (const more of [false, true]) {
    const R = SvalColor.requirements(more);
    for (const scheme of SCHEMES) {
      for (const color of colors) {
        const what = `${JSON.stringify(color)} in ${scheme}${more ? ", more contrast" : ""}`;
        const look = transparency =>
          SvalColor.windowLook(
            { color, transparency },
            { scheme, more, seeThrough: "hud" }
          );
        const solid = look(0);
        const own = rgbOf(
          SvalColor.css(SvalColor.windowTint(color, scheme, more))
        );
        Assert.deepEqual(
          rgbOf(SvalColor.css(solid.tint)),
          own,
          `${what}: at none the window shows its colour`
        );
        const mid =
          testing.materialMid.hud[solid.side === "light" ? "dark" : "light"];
        const ink = solid.side === "light" ? [1, 1, 1] : [0, 0, 0];
        for (const t of [0.3, 0.65]) {
          const seen = look(t);
          Assert.equal(seen.side, solid.side, `${what} at ${t}: same side`);
          Assert.equal(
            seen.accent,
            SvalColor.css(own, 1 - t),
            `${what} at ${t}: the window wears its own colour`
          );
          const mix = own.map(v => (1 - t) * v + t * mid);
          if (testing.meets(ink, rgbOf(SvalColor.css(mix)), R.body)) {
            mixes++;
            seen.tint.forEach((v, i) =>
              Assert.less(
                Math.abs(v - mix[i]),
                0.6 / 255,
                `${what} at ${t}: channel ${i} is the mix`
              )
            );
          } else {
            const away = solid.side === "light" ? -1 : 1;
            const [L, C, h] = SvalColor.toOklch(seen.tint);
            Assert.greater(
              (L - SvalColor.toOklch(mix)[0]) * away,
              0,
              `${what} at ${t}: moved off the mix away from the text`
            );
            Assert.ok(
              !testing.meets(
                ink,
                SvalColor.oklch(L - away * 0.01, C, h),
                R.body
              ),
              `${what} at ${t}: only as far as the target needs`
            );
          }
          for (const [name, text, req] of [
            ["title", seen.strong, R.body],
            ["body", seen.body, R.body],
            ["muted", seen.muted, R.muted],
            ["line", seen.line, R.line],
          ]) {
            Assert.ok(
              testing.meets(text, seen.tint, req),
              `${what} at ${t}: ${name} meets its target on what shows`
            );
          }
        }
      }
    }
  }
  Assert.greater(mixes, 10, `${mixes} windows show the plain mix`);
});

/**
 * A custom colour that suits the appearance it was picked in has a
 * counterpart in the other with its hue; one picked against its appearance
 * is the same in both (decision 0057).
 */
add_task(function a_custom_colour_has_its_counterpart() {
  const deep = { h: 290, c: 0.12, l: 0.36, mode: "dark" };
  const inDark = SvalColor.windowTint(deep, "dark", false);
  const inLight = SvalColor.windowTint(deep, "light", false);
  Assert.ok(SvalColor.isDarkSurface(inDark, false), "deep in dark");
  Assert.ok(!SvalColor.isDarkSurface(inLight, false), "pale in light");
  Assert.less(
    Math.abs(SvalColor.toOklch(inLight)[2] - 290),
    10,
    "with the same hue"
  );

  const vivid = { h: 45, c: 0.18, l: 0.5, mode: "light" };
  Assert.deepEqual(
    SvalColor.windowTint(vivid, "dark", false),
    SvalColor.windowTint(vivid, "light", false),
    "a colour picked against its appearance is the same in both"
  );
});

/**
 * A group's text and muted text on its block meet their targets on every
 * window, solid and see-through, in both appearances and with more
 * contrast, from the block at rest
 * through a hovered row to a selected one: the block stops stepping where
 * they would not (decision 0057).
 */
add_task(function a_groups_text_meets_its_target_on_its_block() {
  const failed = [];
  for (const more of [false, true]) {
    const R = SvalColor.requirements(more);
    for (const scheme of SCHEMES) {
      const windows = [
        SvalColor.untintedSurface(scheme),
        ...[
          ...SvalColor.PRESETS,
          { h: 290, c: 0.12, l: 0.36, mode: "dark" },
        ].flatMap(color =>
          [0, 0.3, 0.65].map(
            transparency =>
              SvalColor.windowLook(
                { color, transparency },
                { scheme, more, seeThrough: "hud" }
              ).block
          )
        ),
      ];
      const groups = [...SvalColor.PRESETS];
      for (let h = 0; h < 360; h += 60) {
        groups.push({ h, c: 0.1 }, { h, c: 0.25 });
      }
      for (const on of windows) {
        const steps = on.surfaceDark ? [1, 1.25, 1.5] : [1, 1.45, 2.3];
        for (const color of groups) {
          const ink = SvalColor.groupInk(color, on, more);
          const text = rgbOf(ink.text);
          const muted = rgbOf(ink.muted);
          for (const step of steps) {
            const block = SvalColor.groupBlock(color, on, step, {
              more,
              selected: step === steps.at(-1),
            });
            if (!testing.meets(text, block, R.body)) {
              failed.push(`text: ${JSON.stringify({ color, on, step, more })}`);
            }
            if (!testing.meets(muted, block, R.muted)) {
              failed.push(
                `muted: ${JSON.stringify({ color, on, step, more })}`
              );
            }
          }
        }
      }
    }
  }
  Assert.deepEqual(failed.slice(0, 10), [], "every group's text reads");
});
