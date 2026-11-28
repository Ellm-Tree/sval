/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Every Workspace and group colour Sval draws, and the text on it (decision
 * 0057). A colour is a preset's name, or a custom one: `{h, c, l, mode}` for
 * a Workspace, an OKLCH hue, chroma and lightness and the appearance it was
 * picked in, and `{h, c}` for a group, whose lightness its window sets. This
 * module is the one place either becomes a colour on screen.
 *
 * Text is solved, never chosen: each ink is the colour nearest its surface,
 * in the surface's hue, that meets APCA-W3 0.0.98G-4g and WCAG 2 at once,
 * against the darkest and lightest the surface can be. Under the window's
 * `prefers-contrast: more` the targets rise.
 *
 * Pure: no Gecko service is reached, so the maths runs in any JS engine.
 */

const DEG = Math.PI / 180;

/** The presets, in the order the pickers show them. */
export const PRESETS = Object.freeze([
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "purple",
  "pink",
  "gray",
  "black",
]);

/**
 * How each preset is named to a person, because spec §10.5 forbids an action
 * reachable by sight alone.
 */
export const PRESET_LABELS = Object.freeze({
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  cyan: "Cyan",
  blue: "Blue",
  purple: "Purple",
  pink: "Pink",
  gray: "Gray",
  black: "Black",
});

/** The most chroma the pickers offer. */
export const CHROMA_MAX = 0.25;

// ------------------------------------------------------------ colour maths

function oklchToLin(L, C, h) {
  const a = C * Math.cos(h * DEG);
  const b = C * Math.sin(h * DEG);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = v => v.every(x => x >= -1e-4 && x <= 1 + 1e-4);

function gam(x) {
  x = Math.min(1, Math.max(0, x));
  return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
}

const lin = x => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);

/**
 * The most chroma sRGB holds at lightness `L` and hue `h`.
 *
 * @param {number} L
 * @param {number} h
 * @returns {number}
 */
export function maxChroma(L, h) {
  let lo = 0;
  let hi = 0.4;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklchToLin(L, mid, h))) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * An OKLCH colour in gamma sRGB, each channel 0..1, gamut-mapped by chroma
 * reduction as CSS Color 4 maps it.
 *
 * @param {number} L
 * @param {number} C
 * @param {number} h
 * @returns {number[]}
 */
export function oklch(L, C, h) {
  L = Math.min(1, Math.max(0, L));
  if (!inGamut(oklchToLin(L, C, h))) {
    C = maxChroma(L, h);
  }
  return oklchToLin(L, C, h).map(gam);
}

/**
 * @param {number[]} rgb Gamma sRGB, 0..1.
 * @returns {number[]} `[L, C, h]`.
 */
export function toOklch(rgb) {
  const [r, g, b] = rgb.map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), (Math.atan2(B, A) / DEG + 360) % 360];
}

const hexToRgb = hex =>
  [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);

/**
 * @param {number[]} rgb Gamma sRGB, 0..1.
 * @param {number} [alpha]
 * @returns {string} a CSS colour.
 */
export function css(rgb, alpha = 1) {
  const [r, g, b] = rgb.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255));
  return alpha >= 1
    ? `rgb(${r} ${g} ${b})`
    : `rgb(${r} ${g} ${b} / ${+alpha.toFixed(3)})`;
}

const lum = rgb => {
  const [r, g, b] = rgb.map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

// APCA-W3 0.0.98G-4g: its own screen luminance (a plain 2.4 power), a soft
// clamp for near-black, and an exponent pair for each polarity, which is how
// it rates light text on dark apart from dark text on light.
function apcaY(rgb) {
  const [r, g, b] = rgb.map(v => Math.max(0, v) ** 2.4);
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  return y < 0.022 ? y + (0.022 - y) ** 1.414 : y;
}

function apcaLc(txt, bg) {
  if (Math.abs(bg - txt) < 0.0005) {
    return 0;
  }
  if (bg > txt) {
    const s = (bg ** 0.56 - txt ** 0.57) * 1.14;
    return s < 0.1 ? 0 : (s - 0.027) * 100;
  }
  const s = (bg ** 0.65 - txt ** 0.62) * 1.14;
  return s > -0.1 ? 0 : -(s + 0.027) * 100;
}

/**
 * A surface as the solver sees it: its luminance span under each method,
 * from the darkest it can be to the lightest.
 *
 * @param {number[]} dark The surface at its darkest, gamma sRGB.
 * @param {number[]} light The surface at its lightest.
 * @returns {{w: number[], a: number[]}}
 */
function span(dark, light) {
  return { w: [lum(dark), lum(light)], a: [apcaY(dark), apcaY(light)] };
}

const solid = rgb => span(rgb, rgb);

// Both methods' contrast rises as the backdrop moves away from the ink, so an
// ink's worst backdrop is the end of the span nearest it.
function worstW(y, [lo, hi]) {
  if (y >= hi) {
    return ratio(y, hi);
  }
  return y <= lo ? ratio(y, lo) : 1;
}

function worstA(y, [lo, hi]) {
  if (y >= hi) {
    return apcaLc(y, hi);
  }
  return y <= lo ? apcaLc(y, lo) : 0;
}

function scoreOf(ink, S) {
  return { w: worstW(lum(ink), S.w), lc: worstA(apcaY(ink), S.a) };
}

/**
 * The lowest contrast `ink` has on surface `S` at its worst, as a WCAG 2
 * ratio and an APCA Lc.
 *
 * @param {number[]} ink
 * @param {number[]|{w: number[], a: number[]}} surface A colour or a span.
 * @returns {{w: number, lc: number}}
 */
export function contrast(ink, surface) {
  return scoreOf(ink, Array.isArray(surface) ? solid(surface) : surface);
}

function meets(ink, S, req) {
  const s = scoreOf(ink, S);
  return s.w >= req.w - 1e-6 && (!req.lc || s.lc >= req.lc - 1e-6);
}

const WHITE = [1, 1, 1];
const BLACK = [0, 0, 0];
const MIDNIGHT = hexToRgb("#060a2e");
// `--sval-palette-blue` (`sval-tokens.css`), the fill of what is on.
const ACTION = hexToRgb("#1f6bff");

// The ink side for a surface: the side whose purest ink meets req, and when
// both or neither do, the one APCA rates higher; and whether either meets it.
function sides(S, req) {
  const okLight = meets(WHITE, S, req);
  const okDark = meets(BLACK, S, req);
  let side;
  if (okLight !== okDark) {
    side = okLight ? "light" : "dark";
  } else {
    side = scoreOf(WHITE, S).lc >= scoreOf(BLACK, S).lc ? "light" : "dark";
  }
  return { side, any: okLight || okDark };
}

const sideFor = (S, req) => sides(S, req).side;

const anySide = (S, req) => meets(WHITE, S, req) || meets(BLACK, S, req);

// A colour as CSS draws it: 8 bits a channel.
const quantize = rgb =>
  rgb.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255) / 255);

// The ink of hue h and chroma c nearest the surface that still meets req,
// checked as CSS will draw it.
function solveInk(h, c, S, req, side) {
  const at = L => quantize(oklch(L, c, h));
  const ok = L => meets(at(L), S, req);
  let lo = 0;
  let hi = 1;
  if (side === "light") {
    if (!ok(1)) {
      return WHITE;
    }
    for (let i = 0; i < 22; i++) {
      const m = (lo + hi) / 2;
      if (ok(m)) {
        hi = m;
      } else {
        lo = m;
      }
    }
    return at(hi);
  }
  if (!ok(0)) {
    return BLACK;
  }
  for (let i = 0; i < 22; i++) {
    const m = (lo + hi) / 2;
    if (ok(m)) {
      lo = m;
    } else {
      hi = m;
    }
  }
  return at(lo);
}

/**
 * Sval's targets (decision 0057): body text, muted text and lines, each a
 * WCAG 2 ratio and an APCA Lc, raised when the system asks for more contrast.
 *
 * @param {boolean} more
 * @returns {{body: {w: number, lc: number}, muted: {w: number, lc: number}, line: {w: number, lc: number}}}
 */
export function requirements(more) {
  return more
    ? {
        body: { w: 7, lc: 90 },
        muted: { w: 4.5, lc: 75 },
        line: { w: 3, lc: 45 },
      }
    : {
        body: { w: 4.5, lc: 75 },
        muted: { w: 4.5, lc: 60 },
        line: { w: 3, lc: 30 },
      };
}

// ------------------------------------------------------------ the presets

// A light-appearance window: the most colour, up to cap, that dark text
// still reads on at three Lc above the target, so the text can keep a trace
// of the hue. At that lightness sRGB holds little chroma for red, blue and
// purple, so the cap binds only yellow, green and cyan.
function paleOf(h, cap, more) {
  const body = requirements(more).body;
  const req = { w: body.w, lc: body.lc + 3 };
  let best = null;
  for (let L = 0.8; L <= 0.97; L += 0.005) {
    const c = Math.min(cap, maxChroma(L, h) * 0.92);
    if (
      meets(BLACK, solid(oklch(L, c, h)), req) &&
      (!best || c > best.c + 1e-4)
    ) {
      best = { L, c };
    }
  }
  return best ? oklch(best.L, best.c, h) : oklch(0.94, 0, h);
}

/**
 * Each preset's window in the dark appearance, then in the light one. Gray
 * and black keep their own light colours: gray has no hue to show, and
 * black's light window is a dark one. Red, orange and pink keep their own
 * too, set apart from each other, where `paleOf` would make them nearly
 * alike. The others are worked out from the dark colour's hue (`paleOf`).
 *
 * `lightMore` is the light window under more contrast, where a light window
 * must be so pale that sRGB holds little chroma for red, blue, purple and
 * pink. Those neighbours are set apart by lightness as well as hue, so each
 * light preset stays at least 0.04 in OKLab from the next. A preset without
 * one moves its light window's lightness as little as the targets need.
 *
 * The rest are each preset's group block (`sval-panel.css`, tree): `h` its
 * hue, `bh` its block's hue on a dark surface, `bc` its block's chroma, `bd`
 * and `bdd` a nudge to its block's lightness step on a light and a dark
 * surface, `bdir` -1 for a block that steps darker than any window, so black
 * stays apart from gray. `base` and `invert` are its ink on a light and a
 * dark surface, under the names Firefox's tab groups give them.
 */
const PRESET_TABLE = {
  red: {
    dark: "#610e11",
    light: "#fbc3bb",
    h: 25,
    bc: 0.14,
    bd: -0.03,
    base: "#a9131f",
    invert: "#ff7e77",
  },
  orange: {
    dark: "#934302",
    light: "#fcc493",
    lightMore: "#ffe1ba",
    h: 55,
    bc: 0.1,
    bd: 0.025,
    base: "#974c00",
    invert: "#ffb481",
  },
  yellow: {
    dark: "#f4db37",
    h: 98,
    bh: 90,
    bc: 0.1,
    bd: 0.06,
    base: "#695b03",
    invert: "#ffe566",
    cap: 0.13,
  },
  green: {
    dark: "#225c13",
    h: 140,
    bc: 0.09,
    bd: 0.01,
    base: "#006e30",
    invert: "#83e499",
  },
  cyan: {
    dark: "#005a6a",
    h: 215,
    bc: 0.09,
    bd: 0.015,
    base: "#056774",
    invert: "#6ae1f5",
  },
  blue: {
    dark: "#17356d",
    lightMore: "#e7f1ff",
    h: 262,
    bc: 0.1,
    bd: 0,
    base: "#0a4ac5",
    invert: "#a5c5fe",
  },
  purple: {
    dark: "#432262",
    lightMore: "#ebe0ff",
    h: 305,
    bc: 0.11,
    bd: 0,
    base: "#7328ae",
    invert: "#d1a9ff",
  },
  pink: {
    dark: "#5c1d3f",
    light: "#fbbedc",
    lightMore: "#ffe9f4",
    h: 350,
    bc: 0.095,
    bd: 0.02,
    base: "#a4216e",
    invert: "#ffa9d2",
  },
  gray: {
    dark: "#31363c",
    light: "#e2e5e9",
    h: 255,
    bc: 0.012,
    bd: 0,
    base: "#535c66",
    invert: "#b5bfcb",
  },
  black: {
    dark: "#090a0c",
    light: "#2c2e31",
    h: 265,
    bc: 0.006,
    bd: -0.1,
    bdd: 0,
    bdir: -1,
    base: "#1c1f25",
    invert: "#d4d7e0",
  },
};

const PRESET_TINTS = {};
for (const name of PRESETS) {
  const p = PRESET_TABLE[name];
  const dark = hexToRgb(p.dark);
  PRESET_TINTS[name] = {
    dark,
    light: p.light
      ? hexToRgb(p.light)
      : paleOf(toOklch(dark)[2], p.cap ?? 0.1, false),
    lightMore: p.lightMore ? hexToRgb(p.lightMore) : null,
  };
}

// ------------------------------------------------------------ the shapes

const isNumberIn = (v, lo, hi) =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/**
 * Whether `value` is a preset's name.
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isPreset(value) {
  return typeof value === "string" && PRESETS.includes(value);
}

/**
 * `value` if this build can draw it as a colour of `kind`, or null. Anything
 * else, such as a shape a later build adds or a damaged value, reads as no
 * colour. Nothing is written back: a write sends the stored value as the
 * document holds it.
 *
 * @param {*} value What the document holds in `appearance.color`.
 * @param {"workspace"|"group"} kind
 * @returns {string|object|null}
 */
export function colorOf(value, kind) {
  if (isPreset(value)) {
    return value;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const { h, c, l, mode } = value;
  if (!isNumberIn(h, 0, 360) || h === 360 || !isNumberIn(c, 0, 0.4)) {
    return null;
  }
  if (kind === "group") {
    return { h, c };
  }
  if (!isNumberIn(l, 0, 1) || (mode !== "dark" && mode !== "light")) {
    return null;
  }
  return { h, c, l, mode };
}

/**
 * How a colour is named to a person: a preset's name, or "Custom color".
 *
 * @param {string|object} color A filtered colour.
 * @returns {string}
 */
export function colorName(color) {
  return isPreset(color) ? PRESET_LABELS[color] : "Custom color";
}

/**
 * Whether two stored colours are the same choice.
 *
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
export function sameColor(a, b) {
  if (a === b) {
    return true;
  }
  if (!a || !b || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  return a.h === b.h && a.c === b.c && a.l === b.l && a.mode === b.mode;
}

/**
 * A stable string for a stored colour, for caches and for telling one
 * window's look from another.
 *
 * @param {*} color
 * @returns {string}
 */
export function colorKey(color) {
  if (!color) {
    return "";
  }
  if (typeof color === "string") {
    return color;
  }
  return [color.h, color.c, color.l, color.mode].join("|");
}

// ------------------------------------------------------------ lightness

const L_STEPS = Array.from(
  { length: 191 },
  (_, i) => +(0.03 + i * 0.005).toFixed(3)
);

const okAt = (L, h, c, more) =>
  anySide(solid(oklch(L, c, h)), requirements(more).body);

/**
 * The lightnesses of hue `h` and chroma `c` on which light or dark body text
 * meets its target, in steps of 0.005: the picker's Shade offers only these.
 *
 * @param {number} h
 * @param {number} c
 * @param {boolean} more
 * @returns {number[]}
 */
export function allowedLs(h, c, more) {
  return bands(h, c, more).all;
}

/**
 * The lightness nearest `L` that body text meets its target on.
 *
 * @param {number} L
 * @param {number} h
 * @param {number} c
 * @param {boolean} more
 * @returns {number}
 */
export function clampL(L, h, c, more) {
  if (okAt(L, h, c, more)) {
    return L;
  }
  for (let d = 0.005; d <= 1; d += 0.005) {
    if (L - d >= 0 && okAt(L - d, h, c, more)) {
      return L - d;
    }
    if (L + d <= 1 && okAt(L + d, h, c, more)) {
      return L + d;
    }
  }
  return L;
}

/**
 * Whether `rgb` is a dark surface: one that takes light text.
 *
 * @param {number[]} rgb
 * @param {boolean} more
 * @returns {boolean}
 */
export function isDarkSurface(rgb, more) {
  return sideFor(solid(rgb), requirements(more).body) === "light";
}

const bandsCache = new Map();

/**
 * The picker's shades at hue `h` and chroma `c`: every allowed lightness, and
 * those split into the pale ones, which take dark text, and the deep ones,
 * which take light text.
 *
 * @param {number} h
 * @param {number} c
 * @param {boolean} more
 * @returns {{all: number[], pale: number[], deep: number[]}}
 */
export function bands(h, c, more) {
  const key = `${h.toFixed(1)}|${c.toFixed(3)}|${more}`;
  let b = bandsCache.get(key);
  if (!b) {
    const req = requirements(more).body;
    b = { all: [], pale: [], deep: [] };
    for (const L of L_STEPS) {
      const { side, any } = sides(solid(oklch(L, c, h)), req);
      if (any) {
        b.all.push(L);
        (side === "light" ? b.deep : b.pale).push(L);
      }
    }
    bandsCache.set(key, b);
  }
  return b;
}

/**
 * A choice of the Workspace picker's two rows of presets: a preset's dark
 * version, its light version, or White, the light row's slot under Black.
 * The version that suits `scheme` is the preset itself, which follows the
 * appearance. The other is a custom colour that stays as the swatch shows
 * it: the preset's window in that appearance, at the nearest lightness body
 * text meets its target on. White is the lightest neutral that does.
 *
 * @param {string} name A preset, or "white".
 * @param {"dark"|"light"} side The row.
 * @param {"dark"|"light"} scheme
 * @param {boolean} more
 * @returns {string|{h: number, c: number, l: number, mode: string}}
 */
export function presetVersion(name, side, scheme, more) {
  if (name === "white") {
    return { h: 0, c: 0, l: allowedLs(0, 0, more).at(-1), mode: scheme };
  }
  // Black's light window is a dark one, so its dark version is the preset
  // in either appearance.
  if (side === scheme || name === "black") {
    return name;
  }
  const [L, C, H] = toOklch(windowTint(name, side, more));
  const h = round(H, 1) % 360;
  const c = round(C, 3);
  const Ls = allowedLs(h, c, more);
  const l = Ls[nearestIndex(Ls, L)];
  // Picked against the appearance its surface suits, so it has no
  // counterpart: yellow's dark window takes dark text.
  const mode = isDarkSurface(oklch(l, c, h), more) ? "light" : "dark";
  return { h, c, l, mode };
}

/**
 * The index of the value in `list` nearest `v`.
 *
 * @param {number[]} list
 * @param {number} v
 * @returns {number}
 */
export function nearestIndex(list, v) {
  let best = 0;
  list.forEach((x, i) => {
    if (Math.abs(x - v) < Math.abs(list[best] - v)) {
      best = i;
    }
  });
  return best;
}

// ------------------------------------------------------------ the window

// Sval's own window, with no colour: `--sval-palette-ink-850` and
// `--sval-palette-frame-light` (`sval-tokens.css`).
const UNTINTED = { dark: hexToRgb("#0a1140"), light: hexToRgb("#eef2fc") };

/**
 * A Workspace colour's window in one appearance, opaque.
 *
 * A preset passes as it is, except under more contrast, where its lightness
 * moves as little as that needs. A custom colour that suits the appearance it
 * was picked in (a dark surface in dark, a light one in light) has a
 * counterpart in the other with its hue: deep in dark, and in light the most
 * colourful light surface dark text reads on. One picked against its
 * appearance stays the same in both. No colour is Sval's own window: its
 * navy in dark and its blue white in light (`sval-tokens.css`).
 *
 * @param {string|object|null} color A preset, a Workspace's custom colour,
 *   or null for none.
 * @param {"dark"|"light"} scheme
 * @param {boolean} more
 * @returns {number[]} gamma sRGB.
 */
export function windowTint(color, scheme, more) {
  if (!color) {
    return UNTINTED[scheme];
  }
  if (isPreset(color)) {
    const tints = PRESET_TINTS[color];
    const rgb =
      (more && scheme === "light" && tints.lightMore) || tints[scheme];
    if (anySide(solid(rgb), requirements(more).body)) {
      return rgb;
    }
    const [L, C, h] = toOklch(rgb);
    return oklch(clampL(L, h, C, more), C, h);
  }
  const { h, c, l, mode } = color;
  const picked = oklch(clampL(l, h, c, more), c, h);
  if (scheme === mode) {
    return picked;
  }
  const suits = (mode === "dark") === isDarkSurface(picked, more);
  if (!suits) {
    return picked;
  }
  if (scheme === "light") {
    return paleOf(h, Math.min(c, 0.1), more);
  }
  const c2 = Math.min(c / 0.45, 0.14);
  return oklch(clampL(0.3, h, c2, more), c2, h);
}

/**
 * The address bar's pill on a window of `tint`: a step deeper on a dark
 * window, a step paler on a light one.
 *
 * @param {number[]} tint
 * @param {"light"|"dark"} side The window's ink side.
 * @returns {number[]}
 */
function pillOf(tint, side) {
  const [L, C, h] = toOklch(tint);
  return side === "light"
    ? oklch(L - 0.11, C * 0.7, h)
    : oklch(Math.min(1, L + 0.05), C * 0.5, h);
}

/**
 * How transparent a Workspace's window can be, 0..1. The colour's layer
 * keeps at least 35% over the material, so a window always carries its
 * colour; text is solved on the colour the window shows over the
 * material's middle ({@link apparentOf}), and what is behind the window is
 * not measured (decision 0057).
 *
 * @returns {number}
 */
export function maxTransparency() {
  return MAX_TRANSPARENCY;
}

const MAX_TRANSPARENCY = 0.65;

/**
 * Sval's default window: a Workspace that holds no transparency of its own
 * is this see-through (decision 0057). A transparency the user chose, 0
 * included, is kept as chosen.
 */
export const DEFAULT_TRANSPARENCY = 0.3;

/**
 * A Workspace's transparency as its window shows it.
 *
 * @param {number|null|undefined} stored As the appearance group holds it
 *   (`SvalTree.appearanceOf`), null for none.
 * @returns {number}
 */
export function transparencyOf(stored) {
  return stored ?? DEFAULT_TRANSPARENCY;
}

// What each window material shows on average, gamma sRGB, a neutral grey in
// each appearance of the material. `hud` was measured on macOS 26 in Sval's
// window with a clear root: over black and over white wallpapers the dark
// material shows 18 and 171.5 of 255 and the light one 113 and 246, rising
// in step with the wallpaper between, and a colour layered over it mixes
// with it in gamma sRGB. Each is the middle of its range.
//
// PROVISIONAL: `acrylic`, Windows' DWMSBT_TRANSIENTWINDOW backdrop, is not
// measured. It carries `hud`'s values.
//
// `blur` is the compositor's blur alone, with no material of its own, and
// Sval paints `hud` over it ({@link BLUR_LAYER}), so it has `hud`'s middle.
const MATERIAL_MID = {
  hud: { dark: 94.75 / 255, light: 179.5 / 255 },
  acrylic: { dark: 94.75 / 255, light: 179.5 / 255 },
  blur: { dark: 94.75 / 255, light: 179.5 / 255 },
};

/**
 * The grey layer, and its alpha, that shows a wallpaper of black as `black`
 * and of white as `white` (gamma sRGB, of 255) and every one between in
 * step, as `hud` does.
 *
 * @param {number} black
 * @param {number} white
 * @returns {{grey: number, alpha: number}}
 */
function layerShowing(black, white) {
  const alpha = 1 - (white - black) / 255;
  return { grey: black / 255 / alpha, alpha };
}

// What Sval paints under a `blur` window's colour in each appearance of the
// material: `hud` as measured.
const BLUR_LAYER = {
  dark: layerShowing(18, 171.5),
  light: layerShowing(113, 246),
};

/**
 * The colour a see-through window's root wears: its colour at the share
 * `1 - t`, and on `blur` over the layer that stands in for a material
 * ({@link BLUR_LAYER}), as the one colour the two give together.
 *
 * @param {number[]} tint
 * @param {number} t
 * @param {"light"|"dark"} side The window's ink side.
 * @param {"hud"|"acrylic"|"blur"} material
 * @returns {string}
 */
function accentOf(tint, t, side, material) {
  if (material !== "blur") {
    return css(tint, 1 - t);
  }
  const { grey, alpha } = BLUR_LAYER[side === "light" ? "dark" : "light"];
  const under = alpha * t;
  const whole = 1 - t + under;
  return css(
    tint.map(v => (v * (1 - t) + grey * under) / whole),
    whole
  );
}

/**
 * The material a window shows through on `platform` (`AppConstants.platform`),
 * or null for a window that draws its colour solid: the HUD window material
 * on macOS (`nsCocoaWindow::SetTransparencyMode`), and on Windows the Acrylic
 * backdrop where Gecko can lay one, which `-moz-windows-mica` reports
 * (`nsWindow::UpdateMicaBackdrop`, `WinUtils::MicaEnabled`). Never while the
 * system reduces transparency. On Linux, the compositor's blur where it
 * offers one, which `-moz-windows-mica` reports there too
 * (`nsLookAndFeel::NativeGetInt`, `nsWindow::SetMicaBackdrop`).
 *
 * @param {string} platform
 * @param {Function} matches Whether the window matches a media query.
 *   `prefers-reduced-transparency` is Windows' Transparency effects setting
 *   there.
 * @returns {"hud"|"acrylic"|"blur"|null}
 */
export function seeThroughMaterial(platform, matches) {
  if (matches("(prefers-reduced-transparency: reduce)")) {
    return null;
  }
  switch (platform) {
    case "macosx":
      return "hud";
    case "win":
      return matches("(-moz-windows-mica)") ? "acrylic" : null;
    case "linux":
      return matches("(-moz-windows-mica)") ? "blur" : null;
    default:
      return null;
  }
}

/**
 * The colour a see-through window shows: its colour at the share `1 - t`
 * over the material's middle, in the material's appearance, which is the
 * one the window's text side gives: the root's color-scheme reaches the
 * window (`nsCocoaWindow::SetTransparencyMode`, `nsWindow::SetColorScheme`).
 * Where that side's purest ink would miss the body target on the mix, the
 * mix moves in OKLCH lightness, away from the ink, as far as the target
 * needs, so the text keeps its side and its target.
 *
 * @param {number[]} tint
 * @param {number} t
 * @param {"light"|"dark"} side The window's ink side.
 * @param {boolean} more
 * @param {"hud"|"acrylic"|"blur"} material
 * @returns {number[]}
 */
function apparentOf(tint, t, side, more, material) {
  const mid = MATERIAL_MID[material][side === "light" ? "dark" : "light"];
  const mixed = quantize(tint.map(v => (1 - t) * v + t * mid));
  const req = requirements(more).body;
  const ink = side === "light" ? WHITE : BLACK;
  const ok = rgb => meets(ink, solid(rgb), req);
  if (ok(mixed)) {
    return mixed;
  }
  const [L, C, h] = toOklch(mixed);
  const at = l => quantize(oklch(l, C, h));
  // The lightness where the ink starts to meet the target lies between the
  // mix and the end of the range away from the ink.
  let fail = L;
  let pass = side === "light" ? 0 : 1;
  for (let i = 0; i < 22; i++) {
    const m = (fail + pass) / 2;
    if (ok(at(m))) {
      pass = m;
    } else {
      fail = m;
    }
  }
  return at(pass);
}

/**
 * Every colour drawn on a surface of `tint`: Design's card set, the window's and the address bar's
 * inks, and what a group's block is measured from. The ink takes `side`
 * when given, else the side the surface gives.
 *
 * - `strong`: titles and the toolbar's text and icons.
 * - `body`, `muted`, `line`: text, quieter text, and field borders and rings.
 * - `field` and `fieldInk`: the address bar and the dialog's fields.
 * - `secondary` and `secondaryInk`: the dialog's secondary buttons.
 * - `focus`: a focus ring, 3:1 on the surface.
 *
 * @param {number[]} tint
 * @param {boolean} more
 * @param {"light"|"dark"} [side]
 * @returns {object}
 */
function rolesOf(tint, more, side) {
  const R = requirements(more);
  const [L, C, h] = toOklch(tint);
  const S = solid(tint);
  side ??= sideFor(S, R.body);
  const dark = side === "light";
  // Quantized as the page paints it, so its ink meets its target on the
  // colour drawn.
  const field = quantize(pillOf(tint, side));
  const FS = solid(field);
  // The button steps away from the card, lighter on a dark card and darker
  // on a light one, and eases back toward the card until its text reads.
  const away = dark ? 0.07 : -0.06;
  let secondary = oklch(L + away, C, h);
  for (let f = 0.9; f > 0 && !anySide(solid(secondary), R.body); f -= 0.1) {
    secondary = oklch(L + away * f, C, h);
  }
  const SS = solid(secondary);
  let strong = dark ? WHITE : MIDNIGHT;
  if (!meets(strong, S, R.body)) {
    strong = dark ? WHITE : BLACK;
  }
  // The selected row steps as `sval-panel.css` steps an untinted window's,
  // a further fifth while hovered, and eases back toward the window until
  // the window's strong ink reads on it. A window whose ink only just reads
  // on it steps away from the ink instead, so the row still stands out.
  const selectedAt = scale => {
    const step = (dark ? 0.17 : -0.12) * scale;
    for (let i = 10; i >= -10; i--) {
      const fill = quantize(oklch(L + (step * i) / 10, C + 0.02, h));
      if (i && meets(strong, solid(fill), R.body)) {
        return fill;
      }
    }
    return tint;
  };
  const selected = selectedAt(1);
  const selectedHover = selectedAt(1.2);
  // An on switch is told from an off one by its fill alone (WCAG 1.4.11):
  // Sval's blue, moved off the window and its popups' surface
  // (`sval-tokens.css`) until it stands apart from both.
  const popup = solid(quantize(oklch(L + (dark ? 0.04 : -0.04), C, h)));
  const [aL, aC, ah] = toOklch(ACTION);
  const apart = rgb => meets(rgb, S, R.line) && meets(rgb, popup, R.line);
  let switchOn = ACTION;
  for (let i = 1; i <= 100 && !apart(switchOn); i++) {
    switchOn = quantize(oklch(aL + (dark ? i : -i) / 100, aC, ah));
  }
  const tc = Math.min(C, 0.02);
  const mc = Math.min(C, 0.05);
  const fieldSide = sideFor(FS, R.body);
  const focusRgb = hexToRgb(dark ? "#5cf2ff" : "#1f6bff");
  return {
    tint,
    side,
    lch: [L, C, h],
    strong,
    body: solveInk(h, tc, S, R.body, side),
    muted: solveInk(h, mc, S, R.muted, side),
    line: solveInk(h, Math.min(C, 0.06), S, R.line, side),
    field,
    fieldInk: solveInk(h, tc, FS, R.body, fieldSide),
    fieldMuted: solveInk(h, mc, FS, R.muted, fieldSide),
    secondary,
    secondaryInk: solveInk(h, tc, SS, R.body, sideFor(SS, R.body)),
    selected,
    selectedHover,
    switchOn,
    focus: scoreOf(focusRgb, S).w >= 3 ? focusRgb : strong,
    surfaces: {
      window: S,
      field: FS,
      secondary: SS,
      popup,
      selected: solid(selected),
      selectedHover: solid(selectedHover),
    },
  };
}

const lookCache = new Map();

/**
 * A Workspace's window in one appearance.
 *
 * @param {object} appearance
 * @param {string|object|null} appearance.color A filtered colour
 *   ({@link colorOf}), or null for none.
 * @param {number} [appearance.transparency] As stored, 0..1.
 * @param {object} context
 * @param {"dark"|"light"} context.scheme The system appearance.
 * @param {boolean} [context.more] Whether the window asks for more contrast.
 * @param {"hud"|"acrylic"|"blur"|null} [context.seeThrough] The material the
 *   window shows what is behind it through ({@link seeThroughMaterial}), or
 *   null for a window that cannot.
 * @returns {object|null} null for no colour on a window that is not
 *   see-through. Otherwise the roles of
 *   `rolesOf` solved on the colour the window shows (`tint`), with
 *   `transparency` (clamped to the colour's most), `accent` (the colour the
 *   root wears on a window that can see through, {@link accentOf}, or null
 *   for one that cannot), `material` (`context.seeThrough`), `block` (what a group's
 *   block steps from), and `home` (the home page's wash,
 *   {@link homeWashOf}).
 */
export function windowLook(
  { color, transparency = 0 },
  { scheme, more = false, seeThrough = null }
) {
  const max = maxTransparency();
  const t = seeThrough ? Math.min(Math.max(0, transparency || 0), max) : 0;
  // With no colour the window is Sval's own (`sval-header.css`) until it is
  // see-through, when it is Sval's own colour like any other's.
  if (!color && !t) {
    return null;
  }
  const key = `${colorKey(color)}|${scheme}|${more}|${seeThrough}|${t.toFixed(4)}`;
  let look = lookCache.get(key);
  if (look) {
    return look;
  }
  const tint = quantize(windowTint(color, scheme, more));
  // The text keeps the side the solid colour gives at every transparency,
  // and is solved on the colour the window shows, which popups and the
  // window's opaque parts wear so they match it.
  const side = sideFor(solid(tint), requirements(more).body);
  const roles = rolesOf(
    t ? apparentOf(tint, t, side, more, seeThrough) : tint,
    more,
    side
  );
  const [L] = roles.lch;
  const surfaceDark = side === "light";
  // A window that can see through wears its colour at the share the
  // transparency leaves, whole at none.
  const accent = seeThrough ? accentOf(tint, t, side, seeThrough) : null;
  look = {
    ...roles,
    transparency: t,
    maxTransparency: max,
    accent,
    material: seeThrough,
    // A group's block steps from the lightness the window shows, so it
    // stands off what is round it.
    block: {
      l: L,
      surfaceDark,
      // A dark window too light for its blocks to step lighter under light
      // text steps them darker.
      dir: surfaceDark && L > 0.42 ? -1 : 1,
    },
    home: homeWashOf(roles.tint, more),
  };
  lookCache.set(key, look);
  return look;
}

// The home page's night sky (`home.css`, `--grad-night`): the lightest of
// its stops, where light text reads least.
const NIGHT_SKY = hexToRgb("#13328f");

// The most of a Workspace's colour the home page's wash lays over its sky,
// where the wash is strongest.
const HOME_WASH_MAX = 0.8;

// The least OKLCH lightness the glow round the home page's mark takes, so a
// dark colour still glows against the night sky.
const HOME_GLOW_L = 0.62;

/**
 * The home page's wash: the colour the window shows, laid over the stock
 * night sky as a fade (`home.css`), at the strength light text still meets
 * its body target over the sky's lightest stop, and the text solved on
 * that, light in the colour's hue. A light colour gets a weaker wash than a
 * dark one.
 *
 * @param {number[]} tint The colour the window shows.
 * @param {boolean} more
 * @returns {{alpha: number, glow: string, edge: string, mid: string,
 *   body: string, muted: string}} `glow` the colour the mark glows in, the
 *   colour lifted as far as a glow needs to show on the sky, `edge` the wash where it is strongest, `mid` where it fades
 *   out.
 */
function homeWashOf(tint, more) {
  const R = requirements(more);
  const under = a =>
    solid(quantize(NIGHT_SKY.map((v, i) => (1 - a) * v + a * tint[i])));
  let alpha = HOME_WASH_MAX;
  while (alpha > 0 && !meets(WHITE, under(alpha), R.body)) {
    alpha = round(alpha - 0.02, 2);
  }
  alpha = Math.max(0, alpha);
  const S = under(alpha);
  const [L, C, h] = toOklch(tint);
  return {
    alpha,
    glow: css(oklch(Math.max(L, HOME_GLOW_L), C, h)),
    edge: css(tint, alpha),
    mid: css(tint, round(alpha * 0.45, 3)),
    body: css(solveInk(h, Math.min(C, 0.02), S, R.body, "light")),
    muted: css(solveInk(h, Math.min(C, 0.05), S, R.muted, "light")),
  };
}

/**
 * Every colour drawn on an opaque surface of `rgb`, as a window look
 * ({@link windowLook}) gives them: a group's dialog wears its block so.
 *
 * @param {number[]} rgb
 * @param {boolean} more
 * @returns {object}
 */
export function surfaceLook(rgb, more) {
  const roles = rolesOf(quantize(rgb), more);
  return {
    ...roles,
    transparency: 0,
    accent: null,
    block: { l: roles.lch[0], surfaceDark: roles.side === "light", dir: 1 },
  };
}

/**
 * A window look as the custom properties its document draws with
 * (`sval-panel.css`, window tint; `sval-header.css`; `sval-dialog.css`).
 *
 * @param {object} look {@link windowLook}'s answer.
 * @returns {{[name: string]: string}}
 */
export function windowProperties(look) {
  const k = 1 - look.transparency;
  return {
    "--sval-tint": css(look.tint),
    "--sval-tint-strong": css(look.strong),
    "--sval-tint-body": css(look.body),
    "--sval-tint-muted": css(look.muted),
    "--sval-tint-line": css(look.line),
    "--sval-tint-field": css(look.field, k),
    "--sval-tint-field-ink": css(look.fieldInk),
    "--sval-tint-field-muted": css(look.fieldMuted),
    "--sval-tint-secondary": css(look.secondary, k),
    "--sval-tint-secondary-ink": css(look.secondaryInk),
    "--sval-tint-focus": css(look.focus),
    "--sval-tint-selected": css(look.selected),
    "--sval-tint-selected-hover": css(look.selectedHover),
    "--sval-tint-switch-on": css(look.switchOn),
    "--sval-tint-l": String(+look.block.l.toFixed(4)),
    // A group's block lets through half of what the window does, so it reads
    // as tinted glass and keeps its colour; its text is solved on the solid
    // block.
    "--sval-tint-alpha": String(+(1 - look.transparency / 2).toFixed(4)),
    "--sval-surface-dark": look.block.surfaceDark ? "1" : "0",
    "--sval-block-dir": String(look.block.dir),
  };
}

// ------------------------------------------------------------ groups

/**
 * A group colour's block and ink members (`sval-panel.css`, tree): a
 * preset's own, or for a custom `{h, c}` its hue, with `c` as the block's
 * chroma and its ink solved to 4.5:1 on Sval's light and dark windows.
 *
 * @param {string|object} color A preset or a group's custom colour.
 * @returns {{h: number, bh: number, bc: number, bd: number, bdd: number,
 *   bdir: number, base: string, invert: string}}
 */
export function groupMembers(color) {
  if (isPreset(color)) {
    const p = PRESET_TABLE[color];
    return {
      h: p.h,
      bh: p.bh ?? p.h,
      bc: p.bc,
      bd: p.bd,
      bdd: p.bdd ?? p.bd,
      bdir: p.bdir ?? 0,
      base: p.base,
      invert: p.invert,
    };
  }
  const { h, c } = color;
  const R = requirements(false);
  const inkC = Math.min(0.2, c * 1.5);
  return {
    h,
    bh: h,
    bc: c,
    bd: 0,
    bdd: 0,
    bdir: 0,
    base: css(solveInk(h, inkC, solid(hexToRgb("#eef2fc")), R.muted, "dark")),
    invert: css(
      solveInk(h, inkC, solid(hexToRgb("#0a1140")), R.muted, "light")
    ),
  };
}

// How far inside the edge of {@link groupBounds} a block stops.
const BOUND_MARGIN = 0.004;

// How a selected row deepens its block's chroma (`sval-panel.css`, tree).
const SELECTED_CHROMA = 1.3;

/**
 * The side a group's text is on in a window: the window's own, so a block
 * reads as part of the panel it sits in.
 *
 * @param {{surfaceDark: boolean}} on
 * @returns {"light"|"dark"}
 */
const blockSide = on => (on.surfaceDark ? "light" : "dark");

const boundsCache = new Map();

/**
 * How far a group's block may go on window `on`: the lightnesses on which
 * the purest ink of the window's side still meets the body target, at the
 * block's chroma at rest and selected. The block steps off its window as
 * `sval-panel.css`'s formula says, and stops at these, so its text always
 * reads (decision 0057).
 *
 * @param {string|object} color
 * @param {{l: number, surfaceDark: boolean, dir: number}} on
 * @param {boolean} more
 * @returns {{min: number, max: number}}
 */
export function groupBounds(color, on, more) {
  const key = `${colorKey(color)}|${on.surfaceDark}|${more}`;
  let bounds = boundsCache.get(key);
  if (bounds) {
    return bounds;
  }
  const m = groupMembers(color);
  const sd = on.surfaceDark ? 1 : 0;
  const c = m.bc * (0.85 + 0.15 * sd);
  const h = m.h + sd * (m.bh - m.h);
  const req = requirements(more).body;
  const light = blockSide(on) === "light";
  const ink = light ? WHITE : BLACK;
  const ok = L =>
    [c, c * SELECTED_CHROMA].every(chroma =>
      meets(ink, solid(quantize(oklch(L, chroma, h))), req)
    );
  // Light ink reads on everything below its bound, dark ink on everything
  // above it.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid) === light) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  // A step inside the edge, so the colour as CSS rounds it still reads.
  bounds = light
    ? { min: 0.04, max: lo - BOUND_MARGIN }
    : { min: hi + BOUND_MARGIN, max: 1 };
  boundsCache.set(key, bounds);
  return bounds;
}

/**
 * A group's block as the panel draws it, on a window of lightness `l` and
 * side `surfaceDark` stepping `dir`: `sval-panel.css`'s `--sval-block`
 * formula, stopped at {@link groupBounds}, for a picker's swatch, for the
 * text solved on it and for tests.
 *
 * @param {string|object} color
 * @param {{l: number, surfaceDark: boolean, dir: number}} on
 * @param {number} [step] 1 at rest.
 * @param {object} [options]
 * @param {boolean} [options.more]
 * @param {boolean} [options.selected] With the selected row's chroma.
 * @returns {number[]}
 */
export function groupBlock(
  color,
  on,
  step = 1,
  { more = false, selected = false } = {}
) {
  const m = groupMembers(color);
  const sd = on.surfaceDark ? 1 : 0;
  const kdir = m.bdir + (1 + m.bdir) * on.dir;
  const { min, max } = groupBounds(color, on, more);
  const L = Math.min(
    max,
    Math.max(
      min,
      0.04,
      on.l +
        step *
          ((1 - sd) * (-0.075 + 0.6 * m.bd) +
            sd *
              kdir *
              (0.085 +
                m.bdd +
                Math.max(0, -m.bdir) * Math.max(0, -on.dir) * (-m.bd - m.bdd)))
    )
  );
  const c = m.bc * (0.85 + 0.15 * sd) * (selected ? SELECTED_CHROMA : 1);
  return oklch(L, c, m.h + sd * (m.bh - m.h));
}

const groupInkCache = new Map();

/**
 * The text drawn on a group's block, on the window's side, solved over the
 * steps the block takes on window `on`, from rest to a selected row
 * (`sval-panel.css`, tree, `--sval-selected-block-step`): `text` meets the
 * body target, `muted` the muted one.
 *
 * @param {string|object} color
 * @param {{l: number, surfaceDark: boolean, dir: number}} on
 * @param {boolean} more
 * @returns {{text: string, muted: string}}
 */
export function groupInk(color, on, more) {
  const key = `${colorKey(color)}|${on.l}|${on.surfaceDark}|${on.dir}|${more}`;
  let ink = groupInkCache.get(key);
  if (ink) {
    return ink;
  }
  const R = requirements(more);
  const steps = [
    groupBlock(color, on, 1, { more }),
    groupBlock(color, on, on.surfaceDark ? 1.25 : 1.45, { more }),
    groupBlock(color, on, on.surfaceDark ? 1.5 : 2.3, { more, selected: true }),
  ].sort((a, b) => lum(a) - lum(b));
  // WCAG and APCA weigh the channels apart, so the steps' darkest and
  // lightest under one need not be those under the other.
  const ws = steps.map(lum);
  const as = steps.map(apcaY);
  const S = {
    w: [Math.min(...ws), Math.max(...ws)],
    a: [Math.min(...as), Math.max(...as)],
  };
  const [, C, h] = toOklch(steps[0]);
  const side = blockSide(on);
  ink = {
    text: css(solveInk(h, Math.min(C, 0.02), S, R.body, side)),
    muted: css(solveInk(h, Math.min(C, 0.05), S, R.muted, side)),
  };
  groupInkCache.set(key, ink);
  return ink;
}

/**
 * What an untinted window's group blocks step from, in each appearance:
 * Sval's navy and the light window's blue white (`sval-panel.css`).
 *
 * @param {"dark"|"light"} scheme
 * @returns {{l: number, surfaceDark: boolean, dir: number}}
 */
export function untintedSurface(scheme) {
  return scheme === "dark"
    ? { l: 0.215, surfaceDark: true, dir: 1 }
    : { l: 0.962, surfaceDark: false, dir: 1 };
}

/**
 * A group colour as the custom properties `SvalPanel.applyAccent` sets,
 * under `prefix`.
 *
 * @param {string|object} color
 * @param {string} prefix
 * @returns {{[name: string]: string}}
 */
export function groupProperties(color, prefix) {
  const m = groupMembers(color);
  return {
    [prefix]: m.base,
    [`${prefix}-invert`]: m.invert,
    [`${prefix}-h`]: String(m.h),
    [`${prefix}-bh`]: String(m.bh),
    [`${prefix}-bc`]: String(m.bc),
    [`${prefix}-bd`]: String(m.bd),
    [`${prefix}-bdd`]: String(m.bdd),
    [`${prefix}-bdir`]: String(m.bdir),
  };
}

/**
 * A group's {@link groupBounds} on window `on`, as the custom properties
 * `SvalPanel.applyAccent` sets under `prefix`.
 *
 * @param {string|object} color
 * @param {{l: number, surfaceDark: boolean, dir: number}} on
 * @param {boolean} more
 * @param {string} prefix
 * @returns {{[name: string]: string}}
 */
export function groupBoundProperties(color, on, more, prefix) {
  const { min, max } = groupBounds(color, on, more);
  return {
    [`${prefix}-lmin`]: String(round(min, 4)),
    [`${prefix}-lmax`]: String(round(max, 4)),
  };
}

const chipCache = new Map();

/**
 * A colour as a chip or swatch that stands for its Workspace or group, such
 * as the Launcher's and Ctrl+Tab's: the fill a Workspace's window has, or
 * for a group's custom hue and chroma a fill as deep or pale as the presets'
 * windows, with the text solved on it.
 *
 * @param {string|object} color A filtered Workspace or group colour.
 * @param {object} context
 * @param {"dark"|"light"} context.scheme
 * @param {boolean} [context.more]
 * @returns {{fill: string, ink: string}} CSS colours.
 */
export function chipOf(color, { scheme, more = false }) {
  const key = `${colorKey(color)}|${color?.h ?? ""}|${color?.c ?? ""}|${scheme}|${more}`;
  let chip = chipCache.get(key);
  if (chip) {
    return chip;
  }
  let fill;
  if (isPreset(color) || "l" in color) {
    fill = windowTint(color, scheme, more);
  } else {
    const L = scheme === "dark" ? 0.34 : 0.92;
    fill = oklch(clampL(L, color.h, color.c, more), color.c, color.h);
  }
  const R = requirements(more);
  const S = solid(fill);
  const [, C, h] = toOklch(fill);
  chip = {
    fill: css(fill),
    ink: css(solveInk(h, Math.min(C, 0.05), S, R.body, sideFor(S, R.body))),
  };
  chipCache.set(key, chip);
  return chip;
}

/**
 * A colour as a mark on any surface, such as a dot or a tile beside a name:
 * its ink on a light surface and on a dark one, picked by the element's
 * `color-scheme`.
 *
 * @param {string|object} color A filtered Workspace or group colour.
 * @returns {string} a CSS colour.
 */
export function markOf(color) {
  const { base, invert } = groupMembers(color);
  return `light-dark(${base}, ${invert})`;
}

/**
 * The colour a choice shows as a dot or swatch: a Workspace's window, or a
 * group's block on the window given.
 *
 * @param {string|object} color
 * @param {"workspace"|"group"} kind
 * @param {object} context
 * @param {"dark"|"light"} context.scheme
 * @param {boolean} [context.more]
 * @param {{l: number, surfaceDark: boolean, dir: number}} [context.on] The
 *   window a group's block sits on; the untinted one when absent.
 * @returns {string} a CSS colour.
 */
export function swatchOf(color, kind, { scheme, more = false, on }) {
  if (kind === "workspace") {
    return css(windowTint(color, scheme, more));
  }
  return css(groupBlock(color, on ?? untintedSurface(scheme), 1, { more }));
}

/**
 * A custom colour as it looks in `scheme`, to start editing from: a preset
 * or a custom colour picked in the other appearance is taken as it looks
 * now, and no colour as Sval's own window looks.
 *
 * @param {string|object|null} color
 * @param {"dark"|"light"} scheme
 * @param {boolean} more
 * @returns {{h: number, c: number, l: number, mode: string}}
 */
export function customFrom(color, scheme, more) {
  if (color && typeof color === "object" && color.mode === scheme) {
    return { ...color };
  }
  const [L, C, h] = toOklch(windowTint(color, scheme, more));
  const hue = C < 0.004 && color && typeof color === "object" ? color.h : h;
  return {
    h: round(hue % 360, 1),
    c: round(C, 3),
    l: round(L, 3),
    mode: scheme,
  };
}

/**
 * @param {number} v
 * @param {number} digits
 * @returns {number}
 */
export function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** For tests: the targets' check, over a span or a solid colour. */
export const testing = {
  meets: (ink, surface, req) =>
    meets(ink, Array.isArray(surface) ? solid(surface) : surface, req),
  anySide: (surface, req) =>
    anySide(Array.isArray(surface) ? solid(surface) : surface, req),
  materialMid: MATERIAL_MID,
  pillOf,
  presetTints: PRESET_TINTS,
};

/** The module as one object, for `ChromeUtils.defineESModuleGetters`. */
export const SvalColor = Object.freeze({
  PRESETS,
  PRESET_LABELS,
  CHROMA_MAX,
  allowedLs,
  bands,
  chipOf,
  clampL,
  colorKey,
  colorName,
  colorOf,
  contrast,
  css,
  customFrom,
  groupBlock,
  groupBoundProperties,
  groupBounds,
  groupInk,
  groupMembers,
  groupProperties,
  isDarkSurface,
  isPreset,
  markOf,
  maxChroma,
  maxTransparency,
  DEFAULT_TRANSPARENCY,
  transparencyOf,
  seeThroughMaterial,
  nearestIndex,
  oklch,
  presetVersion,
  requirements,
  round,
  sameColor,
  surfaceLook,
  swatchOf,
  toOklch,
  untintedSurface,
  windowLook,
  windowProperties,
  windowTint,
});
