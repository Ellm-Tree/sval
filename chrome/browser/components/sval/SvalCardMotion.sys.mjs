/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The user's card in motion (card design round 19): the reveal on the import
 * page, which deals the card in and counts its years one by one, and the
 * tilt and glare that follow the pointer wherever the card shows. Under
 * `prefers-reduced-motion` the reveal is a short fade and the card holds
 * still.
 *
 * It drives the named groups `SvalCardArt.cardSVG` draws: every animation
 * runs from the card's finished look, so a card that never animates, or a
 * PNG of it, is the card as it ends.
 */

import {
  COUNT_WORDS,
  arcFacetColour,
  arcPalette,
  hexOf,
  luminance,
  rgbOf,
  roman,
} from "moz-src:///browser/components/sval/SvalCardArt.sys.mjs";

const EASE = {
  expoOut: "cubic-bezier(0.16, 1, 0.3, 1)",
  cubicOut: "cubic-bezier(0.33, 1, 0.68, 1)",
  cubicInOut: "cubic-bezier(0.65, 0, 0.35, 1)",
  backOut: "cubic-bezier(0.34, 1.56, 0.64, 1)",
};
const cubicInOut = t =>
  t < 0.5 ? 4 * t ** 3 : 1 - Math.pow(-2 * t + 2, 3) / 2;

/** The moon's centre in the icon's 1024 space, which the gradient turns about. */
const ICON_CENTRE = 512;
/** Where the moon sits on the card, as a share of its width and height. */
const MOON = { x: 105 / 210, y: 140 / 340 };

/** Each reveal's times, in ms from the card appearing. */
const TIMES = {
  arc: {
    card: 560,
    border: [200, 400],
    rays: [280, 700],
    moon: [300, 520],
    tint: [820, 520],
    title: [640, 360],
    years: 1060,
  },
  sval: {
    card: 480,
    border: [140, 340],
    rays: [180, 560],
    moon: [200, 460],
    tint: null,
    title: [440, 320],
    years: 700,
  },
};

/**
 * Starts the card's motion: its reveal when asked for, then the pointer's
 * tilt and glare.
 *
 * @param {Element} box The `.sval-mcard` box `SvalCardArt.renderCard` makes.
 * @param {object} card
 * @param {object} options
 * @param {boolean} options.reveal
 */
export function animateCard(box, card, { reveal }) {
  const win = box.documentGlobal;
  const reduced = win.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const svg = box.querySelector(".sval-mcard-art");
  if (reduced) {
    if (reveal) {
      svg.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 200,
        easing: "linear",
        fill: "backwards",
      });
    }
    return;
  }
  const moon = moonOf(svg, card);
  if (!reveal) {
    followPointer(box, moon);
    return;
  }
  revealCard(box, card, moon).then(() => {
    if (box.isConnected) {
      followPointer(box, moon);
    }
  });
}

/**
 * @param {Element} el
 * @param {string} [origin] Where it scales and turns about.
 * @returns {Element}
 */
function centred(el, origin = "center") {
  el.style.transformBox = "fill-box";
  el.style.transformOrigin = origin;
  return el;
}

/**
 * @param {Element} el
 * @param {object[]} frames
 * @param {number} delay
 * @param {number} duration
 * @param {string} easing
 * @returns {Animation}
 */
function play(el, frames, delay, duration, easing) {
  return el.animate(frames, { delay, duration, easing, fill: "backwards" });
}

/**
 * The moon's facets, and how to turn its gradient by an angle: the Arc
 * tinted layer resampled from the Arc palette at each facet's centre turned
 * back by the angle, or for a Sval card the icon's own shading field moved
 * the same way. The facets never move; only their colours do.
 *
 * @param {Element} svg
 * @param {object} card
 * @returns {{turn: Function, rays: Element}}
 */
function moonOf(svg, card) {
  const blue = Array.from(svg.querySelectorAll(".sval-mcard-moon polygon"));
  const tinted = Array.from(svg.querySelectorAll(".sval-mcard-tint polygon"));
  const facets = blue.map((polygon, i) => {
    const points = polygon
      .getAttribute("points")
      .trim()
      .split(/\s+/)
      .map(q => q.split(",").map(Number));
    const colour = rgbOf(polygon.getAttribute("fill"));
    return {
      el: card.arc ? tinted[i] : polygon,
      fill: (card.arc ? tinted[i] : polygon)?.getAttribute("fill"),
      x: points.reduce((a, q) => a + q[0], 0) / points.length,
      y: points.reduce((a, q) => a + q[1], 0) / points.length,
      colour,
      L: luminance(colour),
    };
  });
  const cols = card.arc ? arcPalette(card.arc.palette) : null;
  // The icon's own shading as a smooth field over its facets.
  const field = (x, y) => {
    let w = 0;
    let o = [0, 0, 0];
    for (const f of facets) {
      const wt = Math.exp(-((x - f.x) ** 2 + (y - f.y) ** 2) / (2 * 120 ** 2));
      w += wt;
      o = o.map((v, j) => v + f.colour[j] * wt);
    }
    return o.map(v => v / w);
  };
  const atRest = cols ? null : facets.map(f => field(f.x, f.y));
  let shown = 0;
  return {
    rays: svg.querySelector(".sval-mcard-turn"),
    /** @param {number} degrees */
    turn(degrees) {
      const a = ((((degrees % 360) + 360) % 360) * Math.PI) / 180;
      if (Math.abs(a - shown) < 0.002) {
        return;
      }
      shown = a;
      centred(this.rays).style.transform = `rotate(${degrees}deg)`;
      const cos = Math.cos(-a);
      const sin = Math.sin(-a);
      facets.forEach((f, i) => {
        if (!f.el) {
          return;
        }
        if (a < 0.002) {
          f.el.setAttribute("fill", f.fill);
          return;
        }
        const dx = f.x - ICON_CENTRE;
        const dy = f.y - ICON_CENTRE;
        const x = ICON_CENTRE + dx * cos - dy * sin;
        const y = ICON_CENTRE + dx * sin + dy * cos;
        const c = cols
          ? arcFacetColour(cols, x, y, f.L)
          : f.colour.map((v, j) => v + field(x, y)[j] - atRest[i][j]);
        f.el.setAttribute("fill", hexOf(c));
      });
    },
  };
}

/**
 * The reveal: the card dealt in, its border, rays and moon, the moon
 * taking its Arc colours, then each year landing in turn while the count
 * climbs, a flash on the first year on Sval, the next year's slot, and one
 * shine along the border.
 *
 * @param {Element} box
 * @param {object} card
 * @param {object} moon From {@link moonOf}.
 * @returns {Promise<void>} once it has ended.
 */
function revealCard(box, card, moon) {
  const svg = box.querySelector(".sval-mcard-art");
  const win = svg.documentGlobal;
  const T = card.arc ? TIMES.arc : TIMES.sval;
  const $ = selector => svg.querySelector(selector);

  // The card is dealt in with its glow and shadow, which lie under the
  // drawing in the tilt layer.
  play(
    box.querySelector(".sval-mcard-tilt"),
    [
      {
        opacity: 0,
        transform: "translateY(28px) rotateX(16deg) scale(0.94)",
        offset: 0,
      },
      { opacity: 1, offset: 240 / T.card },
      { opacity: 1, transform: "none" },
    ],
    0,
    T.card,
    EASE.expoOut
  );
  play(
    $(".sval-mcard-border"),
    [{ opacity: 0 }, { opacity: 1 }],
    T.border[0],
    T.border[1],
    "linear"
  );
  play(
    centred($(".sval-mcard-rays")),
    [
      { opacity: 0, transform: "rotate(-24deg)" },
      { opacity: 1, transform: "none" },
    ],
    T.rays[0],
    T.rays[1],
    EASE.cubicOut
  );
  const moonEl = centred($(".sval-mcard-moon"));
  play(moonEl, [{ opacity: 0 }, { opacity: 1 }], T.moon[0], 200, "linear");
  play(
    moonEl,
    [{ transform: "scale(0.82)" }, { transform: "none" }],
    T.moon[0],
    T.moon[1],
    EASE.backOut
  );
  const tint = $(".sval-mcard-tint");
  if (tint && T.tint) {
    play(
      tint,
      [{ opacity: 0 }, { opacity: 1 }],
      T.tint[0],
      T.tint[1],
      EASE.cubicInOut
    );
  }
  const count = centred($(".sval-mcard-count"));
  play(count, [{ opacity: 0 }, { opacity: 1 }], ...T.title, EASE.cubicOut);
  play(
    $(".sval-mcard-title"),
    [
      { opacity: 0, transform: "translateY(8px)" },
      { opacity: 1, transform: "none" },
    ],
    ...T.title,
    EASE.cubicOut
  );

  // The years land one after another, with a breath between the last Arc
  // year and the first on Sval.
  const years = Array.from(svg.querySelectorAll(".sval-mcard-year"));
  const done = years.filter(y => y.dataset.kind !== "next");
  const step = Math.min(140, 560 / Math.max(1, done.length));
  let t = T.years;
  let lastLanding = T.years - step;
  const landings = [];
  let flashed = false;
  done.forEach((year, i) => {
    if (
      i &&
      year.dataset.kind === "sval" &&
      done[i - 1].dataset.kind === "arc"
    ) {
      t += 160;
    }
    centred(year);
    play(year, [{ opacity: 0 }, { opacity: 1 }], t, 120, "linear");
    play(
      year,
      [{ transform: "scale(0)" }, { transform: "none" }],
      t,
      260,
      EASE.backOut
    );
    landings.push(t + 130);
    if (
      !flashed &&
      card.arc &&
      year.dataset.kind === "sval" &&
      done.some(y => y.dataset.kind === "arc")
    ) {
      flashed = true;
      const flash = $(".sval-mcard-flash");
      flash.setAttribute("cx", year.dataset.x);
      flash.setAttribute("cy", year.dataset.y);
      centred(flash);
      play(
        flash,
        [
          { opacity: 0.9, transform: `scale(${4 / 24})` },
          { opacity: 0, transform: "none" },
        ],
        t + 80,
        640,
        EASE.cubicOut
      );
    }
    lastLanding = t;
    t += step;
  });
  const next = years.find(y => y.dataset.kind === "next");
  if (next) {
    const at = card.arc ? lastLanding - 100 : 700;
    play(
      centred(next),
      [
        { opacity: 0, transform: "scale(0.6)" },
        { opacity: 1, transform: "none" },
      ],
      Math.max(0, at),
      320,
      EASE.cubicOut
    );
  }
  const shineAt = card.arc ? lastLanding + 80 : 780;
  const shine = $(".sval-mcard-shine");
  play(shine, [{ opacity: 1 }, { opacity: 1 }], shineAt, 600, "linear");
  for (const band of svg.querySelectorAll(".sval-mcard-band")) {
    play(
      band,
      [{ transform: "translateX(0)" }, { transform: "translateX(400px)" }],
      shineAt,
      600,
      EASE.cubicInOut
    );
  }
  play(
    $(".sval-mcard-wordmark"),
    [{ opacity: 0 }, { opacity: 1 }],
    shineAt,
    400,
    "linear"
  );
  const end = shineAt + 600;

  // The count climbs as each year lands, and the rays and the moon's
  // gradient make one turn from the moon taking its colours to the end.
  const numeral = $(".sval-mcard-numeral");
  const word = $(".sval-mcard-word");
  const final = [numeral.textContent, word.textContent];
  const say = n => {
    numeral.textContent = roman(n);
    word.textContent = n
      ? `${COUNT_WORDS[n] ?? n} YEAR${n === 1 ? "" : "S"}`
      : "DAY ONE";
  };
  say(0);
  const turnFrom = T.tint ? T.tint[0] : T.moon[0];
  return new Promise(resolve => {
    let shown = 0;
    const start = win.performance.now();
    const frame = () => {
      if (!box.isConnected) {
        resolve();
        return;
      }
      const now = win.performance.now() - start;
      const landed = landings.filter(at => now >= at).length;
      if (landed !== shown) {
        shown = landed;
        say(landed);
        count.animate([{ transform: "scale(1.22)" }, { transform: "none" }], {
          duration: 220,
          easing: EASE.cubicOut,
        });
      }
      const p = Math.min(1, Math.max(0, (now - turnFrom) / (end - turnFrom)));
      moon.turn(p >= 1 ? 0 : 360 * cubicInOut(p));
      if (now < end) {
        win.requestAnimationFrame(frame);
        return;
      }
      [numeral.textContent, word.textContent] = final;
      moon.turn(0);
      resolve();
    };
    win.requestAnimationFrame(frame);
  });
}

/**
 * The tilt, glare, border shine and turning rays that follow the pointer
 * over the card, easing back to rest when it leaves.
 *
 * @param {Element} box
 * @param {object} moon From {@link moonOf}.
 */
function followPointer(box, moon) {
  const win = box.documentGlobal;
  const tilt = box.querySelector(".sval-mcard-tilt");
  const glow = box.querySelector(".sval-mcard-glow");
  const specular = box.querySelector(".sval-mcard-specular");
  const shine = box.querySelector(".sval-mcard-shine");
  const band = box.querySelector(".sval-mcard-band");
  const now = { x: 0, y: 0, h: 0, a: 0 };
  const to = { x: 0, y: 0, h: 0, a: 0 };
  let running = false;

  const draw = () => {
    const { x, y, h } = now;
    tilt.style.transform = h
      ? `translateY(${-4 * h}px) rotateX(${-30 * y * h}deg) rotateY(${30 * x * h}deg)`
      : "";
    glow.style.opacity = h;
    glow.style.background = `radial-gradient(circle at ${(x + 0.5) * 100}% ${(y + 0.5) * 100}%, rgb(255 255 255 / 0.2), transparent 55%)`;
    const k = Math.min(1, Math.max(0, (Math.abs(x + y) - 0.12) / 0.38));
    specular.style.opacity = h * k * k * (3 - 2 * k);
    specular.style.transform = `translate(${-x * 44}%, ${-y * 44}%)`;
    shine.style.opacity = 0.55 * h;
    band.style.transform = `translateX(${(x + 0.5) * 210 + 40}px)`;
    moon.turn(now.a);
  };
  const frame = () => {
    now.x += (to.x - now.x) * 0.14;
    now.y += (to.y - now.y) * 0.14;
    now.h += (to.h - now.h) * 0.14;
    // The shortest way round to the pointer's angle.
    const d = ((((to.a - now.a) % 360) + 540) % 360) - 180;
    now.a += d * 0.18;
    const settled =
      Math.abs(to.x - now.x) < 0.001 &&
      Math.abs(to.y - now.y) < 0.001 &&
      Math.abs(to.h - now.h) < 0.001 &&
      Math.abs(d) < 0.1;
    if (settled) {
      Object.assign(now, to);
    }
    draw();
    running = !settled && box.isConnected;
    if (running) {
      win.requestAnimationFrame(frame);
    }
  };
  const wake = () => {
    if (!running) {
      running = true;
      win.requestAnimationFrame(frame);
    }
  };
  box.addEventListener("pointermove", event => {
    const rect = box.getBoundingClientRect();
    to.x = (event.clientX - rect.left) / rect.width - 0.5;
    to.y = (event.clientY - rect.top) / rect.height - 0.5;
    to.x = Math.max(-0.5, Math.min(0.5, to.x));
    to.y = Math.max(-0.5, Math.min(0.5, to.y));
    to.h = 1;
    to.a =
      (Math.atan2(
        (to.y + 0.5 - MOON.y) * rect.height,
        (to.x + 0.5 - MOON.x) * rect.width
      ) *
        180) /
        Math.PI +
      90;
    wake();
  });
  box.addEventListener("pointerleave", () => {
    Object.assign(to, { x: 0, y: 0, h: 0, a: 0 });
    wake();
  });
}
