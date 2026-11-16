/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Ported from Zen Browser's boost tests (src/zen/tests/boosts), by the Zen
// OSS Team. Each part of a page Gecko paints takes a site style's tint and
// dark: backgrounds, text, borders, gradients, pseudo-elements, inline SVG,
// SVG pictures and form fields. A raster picture keeps its colors.

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_site_styles_helpers.js */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_site_styles_helpers.js",
  this
);

const { lookOf, paintWith } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteStyles.sys.mjs"
);

add_setup(failOnConsoleErrors);

/** A blue tint strong enough to move a mid gray by tens of units. */
const TINT = { hue: 220, strength: 80, complement: 30 };

/**
 * Paints the tab's page with `values`, as a style saved for its site would.
 * The fields reach the page's process on the channel a task sent after them
 * takes, so once a task there answers, the page has them; a snapshot then
 * flushes the restyle they ask for.
 *
 * @param {Element} browser
 * @param {object} values A style's values, {} for none.
 */
async function paint(browser, values) {
  paintWith(browser.browsingContext, lookOf(values));
  await within(
    SpecialPowers.spawn(browser, [], () => {}),
    10_000,
    "the page answering"
  );
}

/**
 * @param {string} html
 * @returns {string} a data: address for a page of `html`.
 */
function page(html) {
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(
      `<style>html, body { margin: 0; padding: 0; background: white; }</style>${html}`
    )
  );
}

/**
 * Opens `html`, reads `selector`'s drawn color with no style and with
 * `values`, and hands both to `check`.
 *
 * @param {string} html
 * @param {string} selector
 * @param {object} values
 * @param {Function} check
 */
async function compare(html, selector, values, check) {
  const tab = await openPage(page(html));
  const browser = tab.linkedBrowser;
  await paint(browser, {});
  const before = await drawnAt(browser, selector);
  await paint(browser, values);
  const after = await drawnAt(browser, selector);
  check(before, after);
  await paint(browser, {});
  BrowserTestUtils.removeTab(tab);
}

const changed = what => (before, after) =>
  Assert.ok(
    !sameColor(before, after),
    `${what} takes the style: ${JSON.stringify(before)} to ${JSON.stringify(after)}`
  );

add_task(async function a_background_is_tinted() {
  await compare(
    `<div id="t" style="width:200px;height:200px;background:rgb(128,128,128)"></div>`,
    "#t",
    TINT,
    changed("a background")
  );
});

add_task(async function text_color_is_tinted() {
  await compare(
    `<div id="t" style="width:200px;height:100px;color:rgb(90,90,90);background:currentColor"></div>`,
    "#t",
    TINT,
    changed("the text color")
  );
});

add_task(async function a_border_is_tinted() {
  await compare(
    `<div style="width:200px;height:200px;box-sizing:border-box;border:40px solid rgb(128,128,128)"><div id="edge" style="position:absolute;left:0;top:0;width:40px;height:40px"></div></div>`,
    "#edge",
    TINT,
    changed("a border")
  );
});

add_task(async function a_gradient_is_tinted() {
  await compare(
    `<div id="t" style="width:200px;height:200px;background:linear-gradient(rgb(128,128,128),rgb(128,128,128))"></div>`,
    "#t",
    TINT,
    changed("a gradient's stops")
  );
});

add_task(async function a_pseudo_element_is_tinted() {
  await compare(
    `<style>#t::before { content: ""; display: block; width: 200px; height: 200px; background: rgb(128,128,128); }</style><div id="t"></div>`,
    "#t",
    TINT,
    changed("a ::before")
  );
});

add_task(async function inline_svg_is_tinted() {
  await compare(
    `<svg id="t" width="200" height="200"><rect width="200" height="200" fill="rgb(128,128,128)"/></svg>`,
    "#t",
    TINT,
    changed("an inline SVG's fill")
  );
});

// An SVG picture is a document of its own with no BrowsingContext, so the
// page's style travels to it with the picture's drawing context.
add_task(async function an_svg_picture_matches_inline_svg() {
  const svg = encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="rgb(120,120,120)"/></svg>`
  );
  const tab = await openPage(
    page(
      `<img id="img" width="200" height="200" src="data:image/svg+xml;charset=utf-8,${svg}"><svg id="inline" width="200" height="200"><rect width="200" height="200" fill="rgb(120,120,120)"/></svg>`
    )
  );
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [], () =>
    content.document.getElementById("img").decode()
  );
  for (const [values, what] of [
    [TINT, "tinted"],
    [{ theme: "dark" }, "dark"],
  ]) {
    await paint(browser, values);
    await until(async () => {
      const img = await drawnAt(browser, "#img");
      const inline = await drawnAt(browser, "#inline");
      return (
        sameColor(img, inline, 4) && !sameColor(img, { r: 120, g: 120, b: 120 })
      );
    }, `the SVG picture drawn ${what}, as the inline SVG is`);
  }
  await paint(browser, {});
  BrowserTestUtils.removeTab(tab);
});

add_task(async function dark_flips_lightness_and_leaves_pictures() {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGM4YaMBAAL8AS3/gzpXAAAAAElFTkSuQmCC";
  const tab = await openPage(
    page(
      `<div id="white" style="width:100px;height:100px;background:white"></div><div id="black" style="width:100px;height:100px;background:black"></div><img id="photo" style="display:block;width:100px;height:100px" src="data:image/png;base64,${png}">`
    )
  );
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [], () =>
    content.document.getElementById("photo").decode()
  );
  await paint(browser, {});
  const photo = await drawnAt(browser, "#photo");
  await paint(browser, { theme: "dark" });
  Assert.less(
    luminance(await drawnAt(browser, "#white")),
    0.05,
    "white is drawn dark"
  );
  const black = await drawnAt(browser, "#black");
  Assert.greater(luminance(black), 0.8, "black is drawn light");
  Assert.ok(
    sameColor(await drawnAt(browser, "#photo"), photo),
    "the picture keeps its colors"
  );
  await paint(browser, {});
  BrowserTestUtils.removeTab(tab);
});

add_task(async function a_text_fields_background_goes_dark() {
  await compare(
    `<input id="t" style="width:200px;height:60px">`,
    "#t",
    { theme: "dark" },
    (before, after) =>
      Assert.less(
        luminance(after),
        luminance(before),
        "the field's background is drawn darker"
      )
  );
});

add_task(async function contrast_brightness_and_saturation_adjust_colors() {
  const html = `<div id="t" style="width:200px;height:200px;background:rgb(200,120,60)"></div>`;
  await compare(html, "#t", { brightness: -60 }, (before, after) =>
    Assert.less(luminance(after), luminance(before), "brightness darkens")
  );
  await compare(html, "#t", { saturation: -100 }, (before, after) =>
    Assert.less(
      Math.max(after.r, after.g, after.b) - Math.min(after.r, after.g, after.b),
      8,
      `no saturation draws gray: ${JSON.stringify(after)}`
    )
  );
  await compare(
    `<div id="t" style="width:200px;height:200px;background:rgb(60,60,60)"></div>`,
    "#t",
    { contrast: 100 },
    (before, after) =>
      Assert.less(
        luminance(after),
        luminance(before),
        "more contrast draws a dark color darker"
      )
  );
});

add_task(async function a_buttons_face_goes_dark_with_its_text() {
  await compare(
    `<button id="t" style="width:200px;height:60px"></button>`,
    "#t",
    { theme: "dark" },
    (before, after) =>
      Assert.less(
        luminance(after),
        luminance(before),
        "the button's face is drawn darker, under its light text"
      )
  );
});

// A mask hides by its luminance, so its content keeps its colors.
add_task(async function an_svg_mask_still_shows_what_it_masks() {
  await compare(
    `<svg width="200" height="200"><mask id="m"><rect width="200" height="200" fill="white"/></mask><rect id="t" width="200" height="200" fill="rgb(128,128,128)" mask="url(#m)"/></svg>`,
    "#t",
    { theme: "dark" },
    (before, after) =>
      Assert.ok(
        !sameColor(after, { r: 15, g: 15, b: 15 }, 10),
        `the masked shape is still drawn: ${JSON.stringify(after)}`
      )
  );
});
