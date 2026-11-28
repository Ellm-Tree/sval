/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Site styles (site styles spec §2): the tint, the theme and the font a
 * person picks for a site, kept apart from My filters. `SvalElementRules`
 * reads every `example.com##…` line of My filters as an element removed from
 * the site, so a style kept there would be listed, counted and forgotten as
 * one.
 *
 * The styles are one synced setting, a JSON list in {@link STYLES_PREF}, of
 * plain values per scope: a host or a site. The most specific
 * scope holding a style decides for a page, whole.
 *
 * Gecko paints a page's colors through its style (`SvalSiteStyleColors.cpp`),
 * which reads it from fields on the tab's top BrowsingContext. The parent
 * sets them as a document starts (`SvalPageRulesParent`), and here on every
 * change to the setting and every top-level location change. Only the font
 * is a user sheet.
 */

import { isSafeStyle } from "moz-src:///browser/components/sval/SvalPageRulesChild.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  mostSpecificRule: "moz-src:///browser/components/sval/SvalSite.sys.mjs",
  scopeOf: "moz-src:///browser/components/sval/SvalSite.sys.mjs",
});

export const STYLES_PREF = "browser.sval.siteStyles";

/**
 * The turn from the accent's hue to the second hue a new tint starts with,
 * in degrees: near enough that the two tones read as one tint.
 */
export const DEFAULT_COMPLEMENT = 55;

/** The adjustments a style can hold, each a percentage from -100 to 100. */
export const ADJUSTMENTS = Object.freeze([
  "contrast",
  "brightness",
  "saturation",
]);

/**
 * The fonts a style can pick, each a stack of generic or installed
 * families: a web font would need `url(`, which `isSafeStyle` refuses.
 * Atkinson Hyperlegible is used where the person installed it, and Verdana
 * and DejaVu Sans are the wide, open faces macOS, Windows and Linux carry.
 */
export const FONTS = Object.freeze({
  system: "system-ui, sans-serif",
  serif: "serif",
  mono: "monospace",
  readable: '"Atkinson Hyperlegible", Verdana, "DejaVu Sans", sans-serif',
});

/**
 * Elements a font leaves alone: code keeps its monospace, and icon fonts
 * draw their glyphs from ligatures or private-use code points that any
 * other family turns into letters or boxes. Icon fonts are told by the
 * class and `aria-hidden` names their libraries use.
 */
const FONT_KEEPS =
  ':is(pre, code, kbd, samp, tt, var, math, [class*="icon" i], [class*="fa-"], ' +
  '[class*="material-symbols"], [class*="material-icons"], [aria-hidden="true"])';

/**
 * The accent's saturation and lightness as a tint takes it, from Zen's own
 * starting values: a mid color, which moves a page's lightness least.
 */
const ACCENT_SATURATION = 0.5;
const ACCENT_LIGHTNESS = 0.55;

/** The themes a style can ask a site for, in place of Sval's own. */
export const THEMES = Object.freeze(["light", "dark"]);

/**
 * @param {*} value
 * @param {number} min
 * @param {number} max
 * @returns {boolean} Whether `value` is a whole number in [min, max].
 */
function isWhole(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

/**
 * @param {*} entry
 * @returns {boolean} Whether `entry` is a style this build can apply, as it
 *   was saved. A scope is checked for the shape of a host alone, as link
 *   rules check a site: the Public Suffix List changes as Sval runs.
 */
function isStyle(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }
  const { scope, hue, strength, complement, theme, font, ...rest } = entry;
  const tinted = strength !== undefined;
  return (
    typeof scope === "string" &&
    /^[a-z0-9._:-]+$/.test(scope) &&
    (tinted
      ? isWhole(strength, 1, 100) &&
        isWhole(hue, 0, 359) &&
        isWhole(complement, 0, 359)
      : hue === undefined && complement === undefined) &&
    (theme === undefined || THEMES.includes(theme)) &&
    (font === undefined || Object.hasOwn(FONTS, font)) &&
    Object.entries(rest).every(
      ([key, value]) =>
        ADJUSTMENTS.includes(key) && isWhole(value, -100, 100) && value !== 0
    )
  );
}

/**
 * @param {number} angle Degrees.
 * @returns {number} The same angle as a whole number in [0, 360).
 */
export function wrapAngle(angle) {
  return ((Math.round(angle) % 360) + 360) % 360;
}

/**
 * @param {object} entry A style or the editor's values.
 * @returns {object} Its values alone, in a fixed order, without the ones
 *   that leave the page as it is.
 */
function valuesOf(entry) {
  const values = {};
  const strength = Math.round(entry.strength ?? 0);
  if (strength > 0) {
    values.hue = wrapAngle(entry.hue ?? 0);
    values.strength = Math.min(100, strength);
    values.complement = wrapAngle(entry.complement ?? DEFAULT_COMPLEMENT);
  }
  for (const key of ADJUSTMENTS) {
    const value = Math.round(entry[key] ?? 0);
    if (value) {
      values[key] = Math.max(-100, Math.min(100, value));
    }
  }
  if (THEMES.includes(entry.theme)) {
    values.theme = entry.theme;
  }
  if (Object.hasOwn(FONTS, entry.font ?? "")) {
    values.font = entry.font;
  }
  return values;
}

/**
 * @param {string} text The pref's value.
 * @returns {object[]|null} its styles, or null when it is not a list of them.
 */
function parse(text) {
  if (text === "") {
    return [];
  }
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(list) || !list.every(isStyle)) {
    return null;
  }
  return list.map(entry => ({ scope: entry.scope, ...valuesOf(entry) }));
}

/** What `SvalSettingsSync` lets a synced list of styles be. */
export const SYNC_RULES = Object.freeze({
  [STYLES_PREF]: Object.freeze({
    accepts: value => typeof value === "string" && parse(value) !== null,
  }),
});

/**
 * @returns {object[]} every style, `{ scope, ...values }`.
 */
export function styles() {
  const list = parse(Services.prefs.getStringPref(STYLES_PREF, ""));
  if (!list) {
    lazy.SvalLog.warn("the site styles are not a list of styles");
    return [];
  }
  return list;
}

/**
 * Saves the styles as one write. None is no user value, which syncs as a
 * reset.
 *
 * @param {object[]} list
 */
function write(list) {
  if (!list.length) {
    Services.prefs.clearUserPref(STYLES_PREF);
    return;
  }
  Services.prefs.setStringPref(STYLES_PREF, JSON.stringify(list));
}

/**
 * @param {string} scope A host or a site.
 * @returns {?object} The values saved at `scope` itself, or null.
 */
export function styleAt(scope) {
  const found = styles().find(entry => entry.scope === scope);
  return found ? valuesOf(found) : null;
}

/**
 * The style that decides for a page on `host`: the one saved at the most
 * specific name of its scope chain.
 *
 * @param {string} host
 * @returns {?{scope: string, values: object}}
 */
export function styleFor(host) {
  const byScope = new Map(styles().map(entry => [entry.scope, entry]));
  const found = lazy.mostSpecificRule(host, name => byScope.get(name));
  return found ? { scope: found.name, values: valuesOf(found.rule) } : null;
}

/**
 * Saves `values` as the style at `scope`, in place of any it had. Values
 * that leave every part to the page remove it.
 *
 * @param {string} scope
 * @param {object} values
 */
export function setStyle(scope, values) {
  const kept = valuesOf(values);
  const list = styles().filter(entry => entry.scope !== scope);
  if (Object.keys(kept).length) {
    list.push({ scope, ...kept });
  }
  write(list);
}

/**
 * Removes the styles saved at each of `scopes`, as one write.
 *
 * @param {string[]} scopes
 */
export function removeStyles(scopes) {
  const list = styles();
  const kept = list.filter(entry => !scopes.includes(entry.scope));
  if (kept.length !== list.length) {
    write(kept);
  }
}

/**
 * @param {number} hue Degrees.
 * @returns {number[]} The accent at `hue`, `[r, g, b]` from 0 to 255.
 */
function accentRGB(hue) {
  const s = ACCENT_SATURATION;
  const l = ACCENT_LIGHTNESS;
  const k = n => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map(n =>
    Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))))
  );
}

/**
 * @param {number[]} rgb `[r, g, b]` from 0 to 255.
 * @returns {number} The color's hue in Oklab's a/b plane, in degrees: the
 *   plane the engine turns its accent in.
 */
function oklabHue([r, g, b]) {
  const [lr, lg, lb] = [r, g, b].map(v => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(
    0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb
  );
  const m = Math.cbrt(
    0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb
  );
  const s = Math.cbrt(
    0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb
  );
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return (Math.atan2(bb, a) * 180) / Math.PI;
}

/**
 * The BrowsingContext fields a style's values paint with
 * (`SvalSiteStyle` in `SvalSiteStyleColors.h`). The engine tints dark colors
 * toward its accent and light ones toward the accent turned by the
 * rotation. A page's light colors are most of what it shows, its
 * backgrounds, so they take the first hue, and its dark colors, text above
 * all, take the second.
 *
 * @param {object} values
 * @returns {object}
 */
export function fieldsOf(values) {
  const { hue, strength, complement, theme } = valuesOf(values);
  let accent = 0;
  let rotation = 0;
  if (strength) {
    const second = wrapAngle(hue + complement);
    const [r, g, b] = accentRGB(second);
    // An nscolor, with the strength in its alpha byte.
    accent =
      ((Math.round((strength / 100) * 255) << 24) |
        (b << 16) |
        (g << 8) |
        r) >>>
      0;
    // The engine turns the accent in Oklab, whose degrees are not HSL's, so
    // the turn is measured there for light colors to take the first hue.
    rotation = oklabHue(accentRGB(hue)) - oklabHue([r, g, b]);
  }
  const adjust = key => (values[key] ?? 0) / 100;
  return {
    svalSiteStyleAccent: accent,
    svalSiteStyleRotation: rotation,
    svalSiteStyleContrast: adjust("contrast"),
    svalSiteStyleBrightness: adjust("brightness"),
    svalSiteStyleSaturation: adjust("saturation"),
    // Dark turns a page over from its first paint, since most pages are
    // light; Light waits until the page is measured dark (`paintWith`).
    svalSiteStyleDark: theme === "dark",
  };
}

/** The fields of a page with no style. */
const NO_FIELDS = Object.freeze(fieldsOf({}));

/**
 * @param {object} values A style's values.
 * @returns {string} The user sheet that sets the style's font, or "" for
 *   none. A declaration `isSafeStyle` refuses is left out.
 */
export function sheetFor(values) {
  const { font } = valuesOf(values);
  const declaration = font && `font-family: ${FONTS[font]} !important`;
  if (!declaration || !isSafeStyle(declaration)) {
    return "";
  }
  return `body, body *:not(${FONT_KEEPS}, ${FONT_KEEPS} *) { ${declaration}; }`;
}

/**
 * What a style draws: the fields Gecko paints its colors with, and the
 * font's sheet.
 *
 * @param {object} values A style's values.
 * @returns {?{fields: object, sheet: string, theme: ?string}} Null where the
 *   values draw nothing.
 */
export function lookOf(values) {
  const kept = valuesOf(values);
  if (!Object.keys(kept).length) {
    return null;
  }
  return {
    fields: fieldsOf(kept),
    sheet: sheetFor(kept),
    theme: kept.theme ?? null,
  };
}

/**
 * @param {nsIURI} uri A top-level document's address.
 * @returns {?{fields: object, sheet: string, theme: ?string}} What its style
 *   draws, or null where none applies.
 */
export function lookFor(uri) {
  const host = uri && lazy.scopeOf(uri.spec)?.host;
  const style = host ? styleFor(host) : null;
  return style ? lookOf(style.values) : null;
}

/**
 * The scheme each browsing context had before a style's theme set it, by
 * the context's id. A navigation to another process gives a tab a new
 * context, and Gecko leaves the override behind on the old one
 * (`CanonicalBrowsingContext::ReplacedBy`), which a page coming back from
 * the back-forward cache shows again.
 */
const schemeBefore = new Map();

/**
 * Asks a tab's pages for the theme their style picks, and gives the tab back
 * the scheme it had after. DevTools sets the same field to simulate a
 * scheme, so Sval puts back what was there and touches a context only where
 * it changed the field.
 *
 * @param {CanonicalBrowsingContext} browsingContext A tab's top one.
 * @param {?string} theme "light", "dark", or null for Sval's own.
 */
function setScheme(browsingContext, theme) {
  const { id } = browsingContext;
  const current = browsingContext.prefersColorSchemeOverride;
  if (theme) {
    if (!schemeBefore.has(id)) {
      schemeBefore.set(id, current);
    }
    if (current !== theme) {
      browsingContext.prefersColorSchemeOverride = theme;
    }
  } else if (schemeBefore.has(id)) {
    browsingContext.prefersColorSchemeOverride = schemeBefore.get(id);
    schemeBefore.delete(id);
  }
}

/**
 * Puts a look into a tab's top browsing context: the scheme its theme asks
 * for, and the fields its colors are painted with. A page still in the other
 * scheme once it was asked for the theme is turned over: Dark from the first
 * paint until the page is measured dark on its own, Light once the page is
 * measured dark (`SvalPageRulesParent.drawsDark`). Each field is set only
 * where it differs, since every set is a transaction sent to each process of
 * the tab's group.
 *
 * @param {CanonicalBrowsingContext} context
 * @param {?{fields: object, theme: ?string}} look
 * @param {?boolean} [drawsDark] Whether the page draws dark on its own, or
 *   null before it is measured.
 */
export function paintWith(context, look, drawsDark = null) {
  setScheme(context, look?.theme ?? null);
  const fields = { ...(look?.fields ?? NO_FIELDS) };
  if (look?.theme === "dark") {
    fields.svalSiteStyleDark = drawsDark !== true;
  } else if (look?.theme === "light") {
    fields.svalSiteStyleDark = drawsDark === true;
  }
  for (const [field, value] of Object.entries(fields)) {
    // A float field reads back at single precision; the accent is a whole
    // 32-bit number, which single precision would round.
    const same =
      typeof value === "number" && field !== "svalSiteStyleAccent"
        ? Math.fround(context[field]) === Math.fround(value)
        : context[field] === value;
    if (!same) {
      context[field] = value;
    }
  }
}

/**
 * Puts a look into a tab's page now: the tab's fields follow it, and the
 * page's actor swaps the font's sheet and measures the page for its theme. A
 * page that has not asked for its rules yet has no actor, and gets its look
 * as it asks (`SvalPageRulesParent`).
 *
 * @param {Element} browser
 * @param {?{fields: object, sheet: string, theme: ?string}} look From
 *   `lookFor` or `lookOf`.
 */
export function showIn(browser, look) {
  const context = browser.browsingContext;
  if (!context) {
    return;
  }
  const actor =
    context.currentWindowGlobal?.getExistingActor("SvalPageRules") ?? null;
  paintWith(context, look, actor?.drawsDark ?? null);
  actor?.sendAsyncMessage("SvalPageRules:Style", styleMessage(look));
}

/**
 * @param {?{sheet: string, theme: ?string}} look
 * @returns {{sheet: string, theme: ?string}} What a page's actor is handed.
 */
export function styleMessage(look) {
  return { sheet: look?.sheet ?? "", theme: look?.theme ?? null };
}

/**
 * The looks Colorshift shows in a tab while its dialog edits them, unsaved,
 * by the tab's browser. A tab's page shows its preview through a load and
 * a change to the setting, until the dialog saves or cancels.
 */
const previews = new WeakMap();

/**
 * @param {Element} browser
 * @param {?nsIURI} uri The tab's top-level address.
 * @returns {?{fields: object, sheet: string, theme: ?string}} The look the
 *   tab shows: its preview while one is open, else its page's style.
 */
export function lookShownIn(browser, uri) {
  return previews.has(browser) ? previews.get(browser) : lookFor(uri);
}

/**
 * Shows `values` in a tab without saving them, until `endPreview`.
 *
 * @param {Element} browser
 * @param {object} values
 */
export function previewIn(browser, values) {
  const look = lookOf(values);
  previews.set(browser, look);
  showIn(browser, look);
}

/**
 * Gives a tab back the look its page's saved style draws.
 *
 * @param {Element} browser
 */
export function endPreview(browser) {
  previews.delete(browser);
  showIn(browser, lookFor(browser.currentURI));
}

/** Gives every open page the look it shows now. */
function showEverywhere() {
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    for (const browser of win.gBrowser?.browsers ?? []) {
      showIn(browser, lookShownIn(browser, browser.currentURI));
    }
  }
}

let watching = false;

export const SvalSiteStyles = {
  STYLES_PREF,
  ADJUSTMENTS,
  DEFAULT_COMPLEMENT,
  FONTS,
  THEMES,
  fieldsOf,
  endPreview,
  lookFor,
  lookOf,
  lookShownIn,
  previewIn,
  removeStyles,
  setStyle,
  sheetFor,
  showIn,
  styleAt,
  styleFor,
  styles,

  /**
   * Follows the setting, from this device or a synced one, into every open
   * page. Runs once, as the first window starts.
   */
  init() {
    if (watching) {
      return;
    }
    watching = true;
    Services.prefs.addObserver(STYLES_PREF, showEverywhere);
  },

  /**
   * A tab's top-level page changed: the page shows the style it has now. A
   * page back from the back-forward cache asks for nothing as it shows, and
   * a page with no web address never asks, so its tab drops the last page's
   * style here.
   *
   * @param {Element} browser
   * @param {nsIURI} uri
   */
  onLocationChange(browser, uri) {
    showIn(browser, lookShownIn(browser, uri));
  },
};
