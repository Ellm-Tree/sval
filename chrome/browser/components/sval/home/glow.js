/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";
/**
 * The home page's sky: a glow hugging the moon mark, and coloured stars in
 * a fixed, uneven scatter across the field (`home.css`, "moon glow and
 * stars"), in Sval blue, by night or by daylight as the page's scheme is.
 * A page with a Workspace's colour draws the glow in that colour itself.
 *
 * The colours are worked out here from `home.css`'s `--g-*` members and
 * painted again whenever the page's scheme changes. Each is fitted into sRGB
 * by lowering its chroma, keeping its lightness and hue, because a CSS
 * `oklch()` beyond sRGB is clipped channel by channel, which turns a pastel
 * neon.
 */

{
  // Each star as [x %, y %, radius px, glow px], from the design's 560×340
  // field.
  const STARS = [
    [88.93, 13.53, 1.8, 8],
    [76.96, 28.82, 1, 3],
    [11.07, 11.18, 1.2, 4],
    [29.29, 87.65, 1.4, 5],
    [93.21, 84.12, 1.1, 4],
    [6.07, 56.47, 0.9, 3],
    [52.86, 7.06, 1.3, 5],
  ];

  /**
   * Linear sRGB of an oklch colour, unclamped.
   *
   * @param {number} l
   * @param {number} c
   * @param {number} h In degrees.
   * @returns {number[]}
   */
  const linear = (l, c, h) => {
    const a = c * Math.cos((h * Math.PI) / 180);
    const b = c * Math.sin((h * Math.PI) / 180);
    const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const S = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
      4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
      -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
      -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
    ];
  };
  const inGamut = rgb => rgb.every(v => v >= -0.0005 && v <= 1.0005);
  const encode = v => {
    const x = Math.min(1, Math.max(0, v));
    const s = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
    return Math.round(s * 255);
  };

  /**
   * An oklch colour as CSS `rgb()`, its chroma lowered until it is in sRGB.
   *
   * @param {number} l
   * @param {number} c
   * @param {number} h In degrees.
   * @param {number} [alpha]
   * @returns {string}
   */
  const rgb = (l, c, h, alpha = 1) => {
    let chroma = c;
    while (chroma > 0 && !inGamut(linear(l, chroma, h))) {
      chroma -= 0.002;
    }
    const [r, g, b] = linear(l, Math.max(0, chroma), h).map(encode);
    return `rgb(${r} ${g} ${b} / ${alpha.toFixed(2)})`;
  };

  const root = document.documentElement;
  const glow = document.createElement("div");
  glow.className = "moon-glow";
  const sky = document.createElement("div");
  sky.className = "sky-stars";
  const stars = STARS.map(([x, y, r]) => {
    const star = document.createElement("div");
    star.className = "sky-star";
    Object.assign(star.style, {
      left: `${x}%`,
      top: `${y}%`,
      width: `${2 * r}px`,
      height: `${2 * r}px`,
      margin: `-${r}px 0 0 -${r}px`,
    });
    return star;
  });
  sky.append(...stars);

  const paint = () => {
    const computed = getComputedStyle(root);
    const read = name => parseFloat(computed.getPropertyValue(name));
    const h = read("--g-nh");
    const c = read("--g-c");
    const light = root.classList.contains("light");
    // A page with a colour draws its glow in that colour (`home.css`).
    if (root.hasAttribute("data-sval-tint")) {
      glow.style.background = "";
    } else if (light) {
      glow.style.background = `radial-gradient(closest-side, ${rgb(0.7, Math.max(c, 0.03) * 1.1, h, 0.7)} 0%, ${rgb(0.8, c * 0.9, h, 0.35)} 40%, transparent 100%)`;
    } else {
      glow.style.background = `radial-gradient(closest-side, ${rgb(0.75, c, h, 0.32)} 0%, ${rgb(0.6, c, h, 0.12)} 40%, transparent 100%)`;
    }
    const halo = light ? rgb(0.6, c, h, 0.7) : rgb(0.75, c, h, 0.85);
    const core = light ? rgb(0.5, c, h) : "#ffffff";
    STARS.forEach(([, , , g], i) => {
      stars[i].style.background = core;
      stars[i].style.boxShadow =
        `0 0 ${g}px ${g / 3}px ${halo}, 0 0 ${g * 2.5}px ${g / 2}px ${halo}`;
    });
  };
  paint();
  // `workspace.js` sets the scheme as the `light` class, and
  // `SvalHomeWorkspaceChild` the colour.
  new MutationObserver(paint).observe(root, {
    attributeFilter: ["class", "data-sval-tint"],
  });

  glow.setAttribute("aria-hidden", "true");
  sky.setAttribute("aria-hidden", "true");
  document.querySelector(".mark").prepend(glow);
  document.body.prepend(sky);
}
