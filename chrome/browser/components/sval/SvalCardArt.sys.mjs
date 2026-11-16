/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Draws the user's card (`SvalCard`) as SVG: the fortune card of the card
 * design's round 18a. Every mark comes from the card's seed, title, dates
 * and Arc art, so a card draws the same on every device. Arc's shapes and
 * colours are a nod to the card Arc gave its users: the shapes are traced by
 * hand and the colours sampled from Arc's eight gradients, and neither is
 * Arc's own file.
 */

import { cardYears } from "moz-src:///browser/components/sval/SvalCard.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  animateCard: "moz-src:///browser/components/sval/SvalCardMotion.sys.mjs",
});

export const CARD_WIDTH = 210;
export const CARD_HEIGHT = 340;
/** Room around the card for its shadow, inside the SVG's view box. */
export const CARD_PAD = 30;

const GOLD = "#FFC22A";
const NEON = "#5CF2FF";
const CREAM = "#FFF3C4";
const MUTED = "#8F9BC7";
const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

/** Each Arc palette as nine colours, its gradient sampled on a 3×3 grid. */
const ARC_PALETTES = {
  1: "E55680 D37FAD E8DADC DD5082 CB4288 AE88D4 BA62AF 5E1DD0 5D26D7",
  2: "F4A72F F6B814 F7B028 E47C5B F0A12F FBA44F EC7488 F07F7E FC8C8D",
  3: "D64065 C84063 7F187A D02876 DF634C D0733E E1644D EF9828 F4A81C",
  4: "86C2B7 48ADA7 3FAECD 33A67C 25A28C 34A8B8 1C9F76 2DA5A0 38AAC1",
  5: "9A1771 D12B5C 823870 710D7F A22E69 723076 650982 87386F 6C3E75",
  6: "149B60 487A71 865488 149B60 34896C 9F2889 1A9862 249A67 6F6A80",
  7: "6194BA 6F9FC8 8F7EA4 5E5C7A 7E6A8D 5F4F6C 376986 2B394F 294158",
  8: "BF633E BE2F11 D00F08 CD4A37 AE4514 C42F17 CE1007 B34519 C35637",
};

/** Arc's four card shapes, traced in a 416×384 box. */
const ARC_SHAPES = {
  1: "M8 0 H92 Q130 0 128 45 Q120 70 110 90 Q100 140 155 158 Q175 160 195 145 Q240 120 270 175 Q275 200 255 220 Q235 260 265 290 Q295 300 330 275 Q360 260 395 285 Q416 305 416 330 V376 Q416 384 408 384 H8 Q0 384 0 376 Z",
  2: "M8 384 Q0 384 0 300 C0 200 10 120 60 70 C110 20 170 4 300 2 L408 0 Q416 0 416 8 C416 120 410 200 390 250 C360 330 300 370 230 380 C170 384 100 384 8 384 Z",
  3: "M8 0 H408 Q416 0 416 8 V205 Q416 212 408 209 Q208 140 8 209 Q0 212 0 205 V8 Q0 0 8 0 Z M0 262 Q0 255 8 252 Q208 175 408 252 Q416 255 416 262 V376 Q416 384 408 384 H8 Q0 384 0 376 Z",
  4: "M0 210 C0 90 95 0 208 0 C321 0 416 90 416 210 V376 Q416 384 408 384 H8 Q0 384 0 376 Z",
};

const COUNT_WORDS = [
  "ZERO",
  "ONE",
  "TWO",
  "THREE",
  "FOUR",
  "FIVE",
  "SIX",
  "SEVEN",
  "EIGHT",
  "NINE",
  "TEN",
  "ELEVEN",
  "TWELVE",
  "THIRTEEN",
  "FOURTEEN",
  "FIFTEEN",
  "SIXTEEN",
  "SEVENTEEN",
  "EIGHTEEN",
  "NINETEEN",
  "TWENTY",
];

const f1 = n => (+n).toFixed(1);

/**
 * @param {number} seed
 * @returns {Function} mulberry32: the same numbers in [0, 1) for a seed.
 */
function rng(seed) {
  let h = seed >>> 0;
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {number} n
 * @returns {string} `n` in Roman numerals, or nothing for 0.
 */
function roman(n) {
  // Day one has no numeral: the card shows a star in its place.
  if (!n) {
    return "";
  }
  let s = "";
  for (const [v, c] of [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ]) {
    while (n >= v) {
      s += c;
      n -= v;
    }
  }
  return s;
}

/**
 * @param {string} svg A whole SVG document's text.
 * @returns {{viewBox: string, body: string}} its view box and inner markup.
 */
function innerOf(svg) {
  const open = svg.indexOf(">", svg.indexOf("<svg")) + 1;
  const viewBox = /viewBox="([^"]+)"/.exec(svg.slice(0, open))?.[1] ?? "";
  return { viewBox, body: svg.slice(open, svg.lastIndexOf("</svg>")) };
}

/**
 * @param {string} hex `#rrggbb` or `rrggbb`.
 * @returns {number[]}
 */
const rgbOf = hex => {
  const h = hex.replace("#", "");
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
};
const hexOf = c =>
  "#" +
  c
    .map(v =>
      Math.round(Math.max(0, Math.min(255, v)))
        .toString(16)
        .padStart(2, "0")
    )
    .join("");

/**
 * The app icon's moon recoloured in an Arc palette: each facet takes the
 * palette's colour at its centre, shaded as dark or light as the facet was,
 * and the craters take the palette's mean, darkened. The S, the rim and the
 * glow keep Sval's colours.
 *
 * @param {string} icon The icon's inner markup.
 * @param {string[]} palette Nine `#rrggbb` colours.
 * @returns {string}
 */
function tintMoon(icon, palette) {
  const start = icon.indexOf("<polygon");
  const limb = icon.lastIndexOf(
    "<circle",
    icon.indexOf('fill="url(#svali0limb)"')
  );
  if (start < 0 || limb < start) {
    return icon;
  }
  const cols = palette.map(rgbOf);
  const mean = cols.reduce((a, c) => a.map((v, j) => v + c[j] / 9), [0, 0, 0]);
  let mid = icon
    .slice(start, limb)
    .replace(
      /<polygon points="([^"]+)" fill="(#[0-9a-f]{6})"/g,
      (_, pts, fill) => {
        const points = pts
          .trim()
          .split(/\s+/)
          .map(q => q.split(",").map(Number));
        const cx = points.reduce((a, q) => a + q[0], 0) / points.length;
        const cy = points.reduce((a, q) => a + q[1], 0) / points.length;
        return `<polygon points="${pts}" fill="${hexOf(
          arcFacetColour(cols, cx, cy, luminance(rgbOf(fill)))
        )}"`;
      }
    );
  mid = mid
    .split('fill="#0a0f24"')
    .join(`fill="${hexOf(mean.map(v => v * 0.28))}"`);
  return icon.slice(0, start) + mid + icon.slice(limb);
}

/**
 * @param {number[]} c An RGB colour.
 * @returns {number} its relative luminance, 0 to 1.
 */
export const luminance = c =>
  (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;

/**
 * @param {number} palette An Arc palette number, 1 to 8.
 * @returns {number[][]} its nine colours as RGB.
 */
export const arcPalette = palette =>
  ARC_PALETTES[palette].split(" ").map(rgbOf);

/**
 * A moon facet's colour in an Arc palette: the palette's colour at (x, y) in
 * the icon's 1024 space, blended over its 3×3 grid and made a little more
 * saturated, shaded as dark or light as the facet was (`luminance`) and the
 * one highlight facet taken most of the way to white.
 *
 * @param {number[][]} cols The palette as RGB.
 * @param {number} x
 * @param {number} y
 * @param {number} L The facet's own luminance.
 * @returns {number[]}
 */
export function arcFacetColour(cols, x, y, L) {
  let w = 0;
  let o = [0, 0, 0];
  cols.forEach((c, i) => {
    const gx = 111 + ((i % 3) + 0.5) * (802 / 3);
    const gy = 111 + (Math.floor(i / 3) + 0.5) * (802 / 3);
    const wt = Math.exp(-((x - gx) ** 2 + (y - gy) ** 2) / (2 * 230 ** 2));
    w += wt;
    o = o.map((v, j) => v + c[j] * wt);
  });
  o = o.map(v => v / w);
  const m = (o[0] + o[1] + o[2]) / 3;
  const base = o.map(v => m + (v - m) * 1.3);
  return L > 0.7
    ? base.map(v => v + (255 - v) * 0.78)
    : base.map(v => v * (0.62 + ((L - 0.17) / 0.26) * 0.68));
}

export { hexOf, rgbOf, roman, COUNT_WORDS };

let renders = 0;

/**
 * Where the card's parts sit for its years: the rows of year marks grow up
 * from the bottom, and the moon's emblem shrinks to stay clear of them.
 *
 * @param {object} card
 * @param {Date} now
 * @returns {object} `{ ys, n, rows, per, rowY, cy, sc }`: the years, their
 *   rows, the emblem's centre height and its scale.
 */
function layoutOf(card, now) {
  const ys = cardYears(card, now);
  const n = ys.length;
  const rows = Math.ceil(n / 7);
  const per = Math.ceil(n / rows);
  const rowY = i => 236 - (rows - 1 - i) * 28;
  const top = 66;
  const bot = rowY(0) - 12;
  return {
    ys,
    n,
    rows,
    per,
    rowY,
    cy: (top + bot) / 2,
    sc: Math.min(1, (bot - top) / 156),
  };
}

/** How finely the glow's curve is tabulated: entries to a device pixel. */
const CURVE_STEPS = 4;

/** The side of the glow's square tile of dither noise, in pixels. */
const NOISE_SIZE = 128;

/**
 * Paints the card's glow into `ctx` at `scale` pixels to the card's unit,
 * clipped to the card's rounded corners: the night stock brightening
 * toward the moon, with the halo's colour about it. One curve gives every
 * pixel's colour, so no edge or change of slope shows, and each pixel is
 * dithered as it is rounded to 8 bits, so the long dark fade shows no
 * steps. A canvas gradient can't stand in for the curve: its colours reach
 * the canvas already rounded to 8 bits, so no dither drawn under or over it
 * restores the fractions.
 *
 * The curve depends on the distance from the moon alone, so it is
 * tabulated by distance once, and the noise comes from a tile: a pixel
 * costs a square root and a few reads.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} card
 * @param {number} scale
 * @param {Date} [now]
 */
export function paintGlow(ctx, card, scale, now = new Date()) {
  const { cy, sc } = layoutOf(card, now);
  const w = Math.round(CARD_WIDTH * scale);
  const h = Math.round(CARD_HEIGHT * scale);
  const deep = rgbOf("#060A2E");
  const night = rgbOf("#13328F");
  const halo = rgbOf(
    card.arc ? ARC_PALETTES[card.arc.palette].split(" ")[4] : "#1F6BFF"
  );
  const reach = 240;
  const haloWidth = 88 * sc;
  const moonX = (CARD_WIDTH / 2) * scale;
  const moonY = cy * scale;
  const far = Math.hypot(
    Math.max(moonX, w - moonX),
    Math.max(moonY, h - moonY)
  );
  const curve = new Float32Array((Math.ceil(far * CURVE_STEPS) + 1) * 3);
  for (let i = 0; i < curve.length / 3; i++) {
    const d = i / CURVE_STEPS / scale;
    const t = Math.min(1, d / reach);
    // The stock eases from night at the moon to deep at the corners.
    const k = (1 - Math.cos(Math.PI * t)) / 2;
    // The halo lies over it, a bell curve about the moon.
    const a = 0.5 * Math.exp(-((d / haloWidth) ** 2));
    for (let c = 0; c < 3; c++) {
      const stock = night[c] + (deep[c] - night[c]) * k;
      curve[i * 3 + c] = stock + (halo[c] - stock) * a;
    }
  }
  // Triangular noise of one step either way, added before rounding.
  const random = rng(card.seed ^ 0x5bd1e995);
  const noise = new Float32Array(NOISE_SIZE * NOISE_SIZE * 3);
  for (let i = 0; i < noise.length; i++) {
    noise[i] = random() - random();
  }
  const image = ctx.createImageData(w, h);
  // A Uint8ClampedArray rounds and clamps each value it stores.
  const data = image.data;
  for (let y = 0, at = 0; y < h; y++) {
    const dy = y - moonY;
    const row = (y % NOISE_SIZE) * NOISE_SIZE;
    for (let x = 0; x < w; x++, at += 4) {
      const dx = x - moonX;
      const i = Math.round(Math.sqrt(dx * dx + dy * dy) * CURVE_STEPS) * 3;
      const n = (row + (x % NOISE_SIZE)) * 3;
      data[at] = curve[i] + noise[n];
      data[at + 1] = curve[i + 1] + noise[n + 1];
      data[at + 2] = curve[i + 2] + noise[n + 2];
      data[at + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  // The card's rounded corners.
  ctx.globalCompositeOperation = "destination-in";
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 14 * scale);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
}

/**
 * The card as one SVG document, the card at (0, 0) and {@link CARD_PAD}
 * around it.
 *
 * @param {object} card A `SvalCard` card.
 * @param {object} assets
 * @param {string} assets.icon The app icon's SVG text (`home/mark.svg`).
 * @param {string} assets.wordmark The light-on-dark wordmark's SVG text.
 * @param {object} [options]
 * @param {Date} [options.now]
 * @param {string} [options.fontCSS] `@font-face` rules to carry inside the
 *   SVG, for drawing it where the page's fonts do not reach.
 * @param {boolean} [options.bare] The card alone, with no room around it,
 *   as Save image saves it.
 * @returns {string}
 */
export function cardSVG(
  card,
  assets,
  { now = new Date(), fontCSS = "", bare = false } = {}
) {
  const u = `svc${renders++}_`;
  const W = CARD_WIDTH;
  const H = CARD_HEIGHT;
  const cx = W / 2;
  const C0 = 140;
  const { ys, n, rows, per, rowY, cy, sc } = layoutOf(card, now);
  const count = ys.filter(y => !y.next).length;
  const r = rng(card.seed);
  const arc = card.arc;
  const A = arc ? ARC_PALETTES[arc.palette].split(" ").map(h => `#${h}`) : null;

  const spark = (x, y, s, fill, extra = "") =>
    `<path d="M${f1(x)} ${f1(y - s)} Q${f1(x)} ${f1(y)} ${f1(x + s)} ${f1(y)} Q${f1(x)} ${f1(y)} ${f1(x)} ${f1(y + s)} Q${f1(x)} ${f1(y)} ${f1(x - s)} ${f1(y)} Q${f1(x)} ${f1(y)} ${f1(x)} ${f1(y - s)} Z" fill="${fill}" ${extra}/>`;
  const label = (x, yy, c, opacity = 1) =>
    `<text x="${f1(x)}" y="${yy + 18}" text-anchor="middle" font-family="${MONO}" font-size="9" font-weight="600" letter-spacing=".2" fill="${c}" opacity="${opacity}">’`;

  const marks = ys
    .map((y, i) => {
      const row = Math.floor(i / per);
      const inRow = Math.min(per, n - row * per);
      const col = i - row * per;
      const x = cx + (col - (inRow - 1) / 2) * 24;
      const yy = rowY(row);
      const year = String(y.year).slice(2);
      // Each year is its own group, with its kind and centre, so the reveal
      // (`SvalCardMotion`) can bring them in one by one.
      let kind = y.next ? "next" : "sval";
      if (y.arc) {
        kind = "arc";
      }
      const open = `<g class="sval-mcard-year" data-kind="${kind}" data-x="${f1(x)}" data-y="${yy}">`;
      if (y.arc) {
        const w = 14.5;
        const h = (w * 384) / 416;
        return `${open}<path d="${ARC_SHAPES[arc.shape]}" transform="translate(${f1(x - w / 2)} ${f1(yy - h / 2)}) scale(${(w / 416).toFixed(4)})" fill="url(#${u}yg)" stroke="${CREAM}" stroke-width="${f1((0.7 * 416) / w)}"/>${label(x, yy, GOLD)}${year}</text></g>`;
      }
      if (y.next) {
        return `${open}${spark(x, yy, 6, "none", 'stroke="#B3BCDB" stroke-width=".8" stroke-dasharray="1.6 1.4"')}${label(x, yy, MUTED, 0.75)}${year}</text></g>`;
      }
      return `${open}${spark(x, yy, 6.5, NEON)}${label(x, yy, NEON)}${year}</text></g>`;
    })
    .join("");

  const icon = innerOf(assets.icon);
  const moonLayer = (body, prefix) =>
    `<svg x="${f1(cx - 66)}" y="${f1(C0 - 66)}" width="132" height="132" viewBox="${icon.viewBox}">${body.split("svali0").join(prefix)}</svg>`;
  const moon = moonLayer(icon.body, `${u}i`);
  const tint = A ? moonLayer(tintMoon(icon.body, A), `${u}t`) : "";
  const r0 = 58;
  let rays = "";
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const r1 = r0 + (i % 2 ? 8 : 17);
    rays += `<line x1="${f1(cx + r0 * Math.cos(a))}" y1="${f1(C0 + r0 * Math.sin(a))}" x2="${f1(cx + r1 * Math.cos(a))}" y2="${f1(C0 + r1 * Math.sin(a))}" stroke="${CREAM}" stroke-width=".8" opacity="${i % 2 ? 0.3 : 0.55}"/>`;
  }

  let dust = "";
  for (let i = 0; i < 70; i++) {
    const x = 14 + r() * 182;
    const y = 14 + r() * 312;
    const size = (0.3 + Math.pow(r(), 2) * 0.9).toFixed(2);
    const fill = r() < 0.15 ? "#FFF1C2" : "#DCEAFF";
    const opacity = (0.22 + r() * 0.58).toFixed(2);
    if (
      Math.hypot(x - cx, y - cy) < 84 * sc ||
      (y > rowY(0) - 25 * rows && y < 330)
    ) {
      continue;
    }
    dust += `<circle cx="${f1(x)}" cy="${f1(y)}" r="${size}" fill="${fill}" opacity="${opacity}"/>`;
  }

  const [first, ...rest] = card.title.split(" ");
  const words = [first, rest.join(" ")];
  // The longer a word, the smaller its line, so twelve letters still fit.
  const titleSize = w => {
    if (w.length > 12) {
      return 13;
    }
    return w.length > 10 ? 14.5 : 16;
  };
  const titleLine = (y, text) => {
    const size = titleSize(text);
    return `<g font-family="Audiowide" font-size="${size}" text-anchor="middle" letter-spacing="${f1(size * 0.03)}"><text x="${cx}" y="${f1(y + size * 0.1)}" fill="#0A1F6E">${text}</text><text x="${cx}" y="${f1(y + size * 0.05)}" fill="#1446C8">${text}</text><text x="${cx}" y="${y}" fill="#EEF6FF">${text}</text></g>`;
  };

  const wordmark = innerOf(assets.wordmark);
  const defs = [
    `<linearGradient id="${u}bg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#FFF6D6" stop-opacity="0"/><stop offset=".5" stop-color="#FFF6D6"/><stop offset="1" stop-color="#FFF6D6" stop-opacity="0"/></linearGradient>`,
    `<mask id="${u}bm" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="9" fill="none" stroke="#fff" stroke-width="1.8"/><rect x="12.5" y="12.5" width="${W - 25}" height="${H - 25}" rx="6" fill="none" stroke="#fff" stroke-width="1"/></mask>`,
    `<clipPath id="${u}cc"><rect width="${W}" height="${H}" rx="14"/></clipPath>`,
    A
      ? `<linearGradient id="${u}yg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${A[0]}"/><stop offset=".5" stop-color="${A[4]}"/><stop offset="1" stop-color="${A[8]}"/></linearGradient>`
      : "",
  ].join("");
  const corners = [
    [22, 22],
    [W - 22, 22],
    [22, H - 22],
    [W - 22, H - 22],
  ]
    .map(([x, y]) => spark(x, y, 4, GOLD))
    .join("");
  const countWord = count
    ? `${COUNT_WORDS[count] ?? count} YEAR${count === 1 ? "" : "S"}`
    : "DAY ONE";

  const body = [
    `<g class="sval-mcard-dust">${dust}</g>`,
    `<g class="sval-mcard-border"><rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="9" fill="none" stroke="${GOLD}" stroke-opacity=".75" stroke-width="1"/><rect x="12.5" y="12.5" width="${W - 25}" height="${H - 25}" rx="6" fill="none" stroke="${GOLD}" stroke-opacity=".35" stroke-width=".6"/>${corners}</g>`,
    `<g class="sval-mcard-count"><text class="sval-mcard-numeral" x="${cx}" y="42" text-anchor="middle" font-family="Audiowide" font-size="19" letter-spacing="2" fill="${CREAM}">${roman(count)}</text>${count ? "" : spark(cx, 35, 7, GOLD)}<text class="sval-mcard-word" x="${cx}" y="54" text-anchor="middle" font-family="${MONO}" font-size="6.5" letter-spacing="1.8" fill="${MUTED}">${countWord}</text></g>`,
    `<g transform="translate(${cx} ${f1(cy)}) scale(${sc.toFixed(3)}) translate(${-cx} ${-C0})">`,
    `<g class="sval-mcard-rays"><g class="sval-mcard-turn">${rays}<circle cx="${cx}" cy="${C0}" r="${r0 - 4}" fill="none" stroke="${GOLD}" stroke-opacity=".5" stroke-width=".8"/></g></g>`,
    `<g class="sval-mcard-moon">${moon}</g>`,
    tint && `<g class="sval-mcard-tint">${tint}</g>`,
    `</g>`,
    marks,
    // The ring that marks the first year on Sval as the reveal reaches it.
    `<circle class="sval-mcard-flash" r="24" fill="none" stroke="${NEON}" stroke-width="1.4" vector-effect="non-scaling-stroke" opacity="0"/>`,
    `<g class="sval-mcard-title"><text x="${cx}" y="266" text-anchor="middle" font-family="${MONO}" font-size="7.5" letter-spacing="3" fill="${MUTED}">THE</text>${titleLine(285, words[0])}${titleLine(304, words[1])}</g>`,
    `<g class="sval-mcard-wordmark"><svg x="${cx - 17}" y="313" width="34" height="9" viewBox="${wordmark.viewBox}">${wordmark.body.split('id="').join(`id="${u}w`).split("url(#").join(`url(#${u}w`)}</svg></g>`,
    // A light band the motion slides along the gold border, and a faint
    // sheen across the face; both unseen at rest.
    `<g class="sval-mcard-shine" opacity="0"><g mask="url(#${u}bm)"><g class="sval-mcard-band"><rect x="-80" y="-60" width="80" height="${H + 120}" fill="url(#${u}bg)" transform="rotate(20 0 ${H / 2})"/></g></g><g clip-path="url(#${u}cc)" opacity=".1"><g class="sval-mcard-band"><rect x="-80" y="-60" width="80" height="${H + 120}" fill="url(#${u}bg)" transform="rotate(20 0 ${H / 2})"/></g></g></g>`,
  ].join("");

  const style = fontCSS ? `<style>${fontCSS}</style>` : "";
  const pad = bare ? 0 : CARD_PAD;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${W + 2 * pad} ${H + 2 * pad}" width="${W + 2 * pad}" height="${H + 2 * pad}">${style}<defs>${defs}</defs>${body}</svg>`;
}

/**
 * The card's name as a page shows it, "The Wandering Comet".
 *
 * @param {object} card
 * @returns {string}
 */
export function cardName(card) {
  return `The ${card.title
    .toLowerCase()
    .replace(/(^|[ -])[a-z]/g, c => c.toUpperCase())}`;
}

/**
 * What a screen reader says for the card.
 *
 * @param {object} card
 * @param {Date} [now]
 * @returns {string}
 */
export function cardLabel(card, now = new Date()) {
  const ys = cardYears(card, now).filter(y => !y.next);
  const arcYears = ys.filter(y => y.arc).length;
  const name = cardName(card);
  let years = "day one";
  if (ys.length) {
    years = ys.length === 1 ? "1 year" : `${ys.length} years`;
  }
  if (!arcYears) {
    return `${name}, ${years}`;
  }
  return arcYears === ys.length
    ? `${name}, ${years} on Arc`
    : `${name}, ${years}, ${arcYears} of them on Arc`;
}

const ASSETS = {
  icon: "chrome://browser/content/sval/home/mark.svg",
  wordmark: "chrome://branding/content/about-wordmark.svg",
};
const FONT = "chrome://browser/content/sval/card/Audiowide-Regular.ttf";

let assetsLoaded = null;

/**
 * Fetches through this module's own global. Every card drawn shares the one
 * promise, and a page's promise stops settling once the page closes
 * (`nsIGlobalObject::IsScriptForbidden`), which would leave every later
 * card waiting.
 *
 * @returns {Promise<{icon: string, wordmark: string}>}
 */
function loadAssets() {
  assetsLoaded ??= Promise.all(
    Object.values(ASSETS).map(url => fetch(url).then(res => res.text()))
  ).then(([icon, wordmark]) => ({ icon, wordmark }));
  // A failed fetch is tried again by the next card.
  assetsLoaded.catch(() => (assetsLoaded = null));
  return assetsLoaded;
}

/**
 * The card as an element of `doc`, ready to place: inline SVG, so the
 * page's own `@font-face` for Audiowide (`card.css`) reaches its text.
 *
 * @param {Document} doc
 * @param {object} card
 * @param {object} [options]
 * @param {Date} [options.now]
 * @param {boolean} [options.reveal] Whether the card arrives with its
 *   reveal (`SvalCardMotion`), as it does on the import page.
 * @returns {Promise<Element>} a `.sval-mcard` box holding the card.
 */
export async function renderCard(
  doc,
  card,
  { now = new Date(), reveal = false } = {}
) {
  const win = doc.defaultView;
  const svg = cardSVG(card, await loadAssets(), { now });
  const parsed = new win.DOMParser().parseFromString(svg, "image/svg+xml");
  const el = doc.importNode(parsed.documentElement, true);
  el.classList.add("sval-mcard-art");
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", cardLabel(card, now));
  // Set through the CSSOM, which a page's CSP lets through where it blocks
  // a `style` attribute in markup.
  el.querySelectorAll(".sval-mcard-year").forEach((year, i) =>
    year.style.setProperty("--i", i)
  );
  const html = className => {
    const div = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    div.className = className;
    return div;
  };
  const box = html("sval-mcard");
  const tilt = html("sval-mcard-tilt");
  const glare = html("sval-mcard-glare");
  glare.append(html("sval-mcard-glow"), html("sval-mcard-specular"));
  // The glow is painted pixel for pixel at the size the card shows at, and
  // again whenever that size changes, so it is never scaled.
  const glow = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  glow.className = "sval-mcard-stock";
  new win.ResizeObserver(([entry]) => {
    const size = entry.devicePixelContentBoxSize?.[0];
    const width = size?.inlineSize ?? 0;
    if (!width || width === glow.width) {
      return;
    }
    glow.width = width;
    glow.height = Math.round((width * CARD_HEIGHT) / CARD_WIDTH);
    paintGlow(glow.getContext("2d"), card, width / CARD_WIDTH, now);
  }).observe(glow);
  tilt.append(glow, el, glare);
  box.append(tilt);
  lazy.animateCard(box, card, { reveal, now });
  return box;
}

/** How many pixels the saved image draws for each of the card's. */
export const IMAGE_SCALE = 5;

/**
 * The card alone as a PNG, its rounded corners transparent, as a `data:` URL.
 *
 * @param {Window} win A window whose CSP lets it load `data:` images.
 * @param {object} card
 * @param {object} [options]
 * @param {Date} [options.now]
 * @returns {Promise<string>}
 */
export async function cardImage(win, card, { now = new Date() } = {}) {
  const [assets, font] = await Promise.all([
    loadAssets(),
    win
      .fetch(FONT)
      .then(res => res.arrayBuffer())
      .then(buffer => {
        let binary = "";
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return win.btoa(binary);
      }),
  ]);
  // An SVG drawn as an image loads nothing from outside itself, so the
  // card carries its font.
  const svg = cardSVG(card, assets, {
    now,
    bare: true,
    fontCSS: `@font-face{font-family:"Audiowide";src:url(data:font/ttf;base64,${font}) format("truetype");}`,
  });
  const img = new win.Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const canvas = win.document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "canvas"
  );
  canvas.width = CARD_WIDTH * IMAGE_SCALE;
  canvas.height = CARD_HEIGHT * IMAGE_SCALE;
  const ctx = canvas.getContext("2d");
  paintGlow(ctx, card, IMAGE_SCALE, now);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

const DIALOG_URL = "chrome://browser/content/sval/card/card-dialog.xhtml";

/**
 * Shows the user's card in `win`'s dialog box: what View › Your Sval Card
 * and the card in Settings' nav both open.
 *
 * @param {Window} win A browser window.
 * @returns {Promise<void>} once the dialog closes.
 */
export async function openCardDialog(win) {
  await win.gDialogBox?.open(DIALOG_URL, {
    getProperty: name => name === "async",
  });
}
