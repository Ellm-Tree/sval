/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Fits a page in a browser window's modal box (`SubDialog`'s `.dialogBox`)
 * to the card it draws, and gives the page the window's palette. Sval's own
 * dialogs call {@link fitFrame} from `sval-dialog` (`elements/`); Firefox's
 * dialogs, which `SvalPageStyle.styleDialog` dresses in Sval's design, from
 * `sval-dialog-frame.js`.
 *
 * The page is a document of its own, so the window's private and agent
 * attributes are copied onto its root, and a tinted window's colour is
 * solved here for an opaque card (`SvalColor`), where `sval-dialog.css`
 * picks its palette from them as `sval-header.css` does for the window.
 * `SubDialog` clones the box for each dialog and removes it when the dialog
 * closes, so nothing set on it outlives the page.
 *
 * Over a window that shows what is behind it, a card is frosted (decision
 * 0057): the box blurs the dimmed window under it and wears the colour the
 * window's root wears where only a blur lies behind it, the `blur`
 * material's (`SvalColor.windowLook`), and the card's text is solved on
 * what that shows. A critical card stays solid.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalColor: "moz-src:///browser/components/sval/SvalColor.sys.mjs",
});

const THEME_ATTRIBUTES = ["data-sval-agent", "privatebrowsingmode"];

/** How far a frosted box blurs what lies under it, in CSS pixels. */
export const FROST_BLUR = 24;

/**
 * The look a frosted card wears over the browser window `win`: the colour
 * the `blur` material's root wears at the window's transparency
 * (`SvalColor.windowLook`), or null when a card over the window is solid,
 * because the window draws its colour solid or at no transparency. The
 * Send Feedback form's card, drawn in the window's own document, frosts by
 * it (`SvalFeedbackForm`).
 *
 * @param {Window} win A browser window.
 * @returns {object|null}
 */
export function frostLook(win) {
  const panel = win.SvalPanel;
  const root = win.document.documentElement;
  const transparency = panel?.windowLook?.transparency ?? 0;
  if (
    !root.hasAttribute("data-sval-tint") ||
    !root.hasAttribute("data-sval-see-through") ||
    !panel.seeThrough() ||
    transparency <= 0
  ) {
    return null;
  }
  const look = lazy.SvalColor.windowLook(
    { color: panel.windowColor, transparency },
    {
      scheme: win.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light",
      more: win.matchMedia("(prefers-contrast: more)").matches,
      seeThrough: "blur",
    }
  );
  return (look?.transparency ?? 0) > 0 ? look : null;
}

/**
 * What each page's window showed as the page opened: its colour and
 * transparency, the material it can see through, if any
 * (`SvalColor.windowLook`), whether the page's card frosts over that
 * window, and whether it shows frosted now, which a look at no
 * transparency does not. No colour is Sval's own, see-through like any
 * other.
 *
 * @type {WeakMap<Document, {color: string|object|null,
 *   transparency: number, seeThrough: string|null, frosted: boolean,
 *   frostShown: boolean, properties: string[]}>}
 */
const windows = new WeakMap();

function stateOf(doc) {
  let state = windows.get(doc);
  if (!state) {
    state = {
      color: null,
      transparency: 0,
      seeThrough: null,
      frosted: false,
      frostShown: false,
      properties: [],
    };
    windows.set(doc, state);
  }
  return state;
}

/**
 * Whether the page `doc` shows its card frosted: a `sval-dialog` that is
 * neither critical nor `solid`, over a window that shows what is behind it
 * now, painted in a look with some transparency. Reduced transparency
 * leaves a window nothing to see through (`SvalColor.seeThroughMaterial`),
 * and a window at no transparency is opaque.
 *
 * @param {Document} doc
 * @returns {boolean}
 */
export function isFrosted(doc) {
  return stateOf(doc).frostShown;
}

/**
 * Gives the page `doc` a Workspace's colour, solved opaque in the page's
 * appearance and contrast, or for a group's dialog the group's block on the
 * window under it; or the window's colour, or none. On a window that can
 * see through, the card is the colour the window shows at `transparency`
 * (`SvalColor.windowLook`), so it matches the window round it. A frosted
 * card's box takes the colour the `blur` material's root wears at that
 * transparency, and its text is solved on what that shows.
 *
 * @param {Document} doc
 * @param {string|object|null} [color] A Workspace colour; the window's
 *   when absent.
 * @param {object} [options]
 * @param {string|object|null} [options.group] A group colour to wear as its
 *   block.
 * @param {object} [options.on] The window that block sits on
 *   (`SvalColor.groupBlock`).
 * @param {number} [options.transparency] The Workspace's; the window's when
 *   absent.
 */
export function paintTint(
  doc,
  color = stateOf(doc).color,
  { group = null, on = null, transparency = stateOf(doc).transparency } = {}
) {
  const state = stateOf(doc);
  const win = doc.defaultView;
  const root = doc.documentElement;
  for (const name of state.properties) {
    root.style.removeProperty(name);
  }
  state.properties = [];
  const scheme = win.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
  const more = win.matchMedia("(prefers-contrast: more)").matches;
  const look =
    group && on
      ? lazy.SvalColor.surfaceLook(
          lazy.SvalColor.groupBlock(group, on, 1, { more }),
          more
        )
      : lazy.SvalColor.windowLook(
          { color, transparency },
          {
            scheme,
            more,
            seeThrough: state.frosted ? "blur" : state.seeThrough,
          }
        );
  if (look) {
    for (const [name, value] of Object.entries(
      lazy.SvalColor.windowProperties(look)
    )) {
      root.style.setProperty(name, value);
      state.properties.push(name);
    }
    root.setAttribute("data-sval-tint", "true");
    root.setAttribute("data-sval-ink", look.side);
  } else {
    root.removeAttribute("data-sval-tint");
    root.removeAttribute("data-sval-ink");
  }
  const box = win.frameElement?.closest(".dialogBox");
  if (!state.frosted || !box) {
    return;
  }
  // A look at no transparency is solid, as the window it previews would be:
  // without a colour there is no look at all, and Sval's own card is drawn
  // by the stylesheet.
  const shown = (look?.transparency ?? 0) > 0;
  state.frostShown = shown;
  root.toggleAttribute("data-sval-frosted", shown);
  const card = doc.querySelector("sval-dialog");
  card?.toggleAttribute("frosted", shown);
  box.style.backdropFilter = shown ? `blur(${FROST_BLUR}px)` : "none";
  box.style.backgroundColor = shown
    ? look.accent
    : win.getComputedStyle(card ?? root).backgroundColor;
}

/**
 * Lets the box draw the card's fill and edge.
 *
 * The box clips its frame to its rounded corners. Were the card to draw its
 * own edge inside that clip, the edge's anti-aliased curve and the clip's
 * would fall on the same pixels, each taking its share of the coverage, and
 * what lies behind the box would show through along the corners. So the box
 * draws the card's fill and edge, with the card's `--sval-dialog-shadow`
 * round it, one rounded shape whose edge has a
 * single curve, and the card takes no room for an edge of its own.
 * `SubDialog` sizes the frame to a page's body (`resizeHorizontally`,
 * `resizeVertically`), so a border on a root that draws the card would
 * overflow the frame by its width and scroll the page both ways. The page
 * the box clips lies over the box's own fill of the same colour.
 *
 * @param {Element} card The element that draws the card.
 */
function shapeDialogBox(card) {
  const win = card.documentGlobal;
  const box = win.frameElement?.closest(".dialogBox");
  if (!box) {
    return;
  }
  // The card's own edge, read without the width an earlier call cleared.
  card.style.removeProperty("border-width");
  const style = win.getComputedStyle(card);
  const width = parseFloat(style.borderTopWidth) || 0;
  const radius = parseFloat(style.borderTopLeftRadius) || 0;
  box.style.border = `${width}px solid ${style.borderTopColor}`;
  // The box's padding edge, where it clips the frame, has the card's radius.
  box.style.borderRadius = `${radius + width}px`;
  box.style.backgroundColor = style.backgroundColor;
  box.style.backgroundClip = "border-box";
  box.style.outline = "none";
  box.style.boxShadow =
    style.getPropertyValue("--sval-dialog-shadow").trim() || "none";
  card.style.borderWidth = "0";
}

/**
 * Asks for the card's height whenever it differs from the frame's.
 * `SubDialog.resizeVertically` sizes the frame to the page once, at load,
 * and the box keeps that as its `min-height`, so a card that grows or
 * shrinks after that, such as a line that rewraps, would be clipped or leave
 * a band under it. `SubDialog` replaces the page's `resizeBy` with one that
 * moves the frame and the box together. The frame is the smaller of the
 * window's room and the height `SubDialog` keeps in the overlay's
 * `--subdialog-inner-height`, which `resizeBy` moves, so the card is
 * measured against that height: a card that opened taller than the window
 * and then shrinks would otherwise leave the kept height above the card.
 *
 * @param {Element} card
 */
function track(card) {
  const win = card.documentGlobal;
  const overlay = win.frameElement.closest(".dialogOverlay");
  new win.ResizeObserver(() => {
    const kept =
      parseFloat(overlay?.style.getPropertyValue("--subdialog-inner-height")) ||
      win.innerHeight;
    const delta = Math.ceil(card.getBoundingClientRect().height) - kept;
    if (delta) {
      win.resizeBy(0, delta);
    }
  }).observe(card);
}

/**
 * Fits the box `doc` is shown in to the card the page draws: a
 * `sval-dialog`, or for Firefox's dialogs the root (`pages/dialog.css`).
 * Does nothing for a page outside a modal box.
 *
 * @param {Document} doc
 * @returns {boolean} Whether the page is in a modal box.
 */
export function fitFrame(doc) {
  const frame = doc.defaultView.frameElement;
  const box = frame?.closest(".dialogBox");
  if (!box) {
    return false;
  }
  const browserRoot = frame.ownerDocument.documentElement;
  const root = doc.documentElement;
  for (const name of THEME_ATTRIBUTES) {
    const value = browserRoot.getAttribute(name);
    if (value === null) {
      root.removeAttribute(name);
    } else {
      root.setAttribute(name, value);
    }
  }
  const panel = frame.documentGlobal.SvalPanel;
  const state = stateOf(doc);
  const tinted = browserRoot.hasAttribute("data-sval-tint");
  state.color = tinted ? (panel?.windowColor ?? null) : null;
  state.transparency = tinted ? (panel?.windowLook?.transparency ?? 0) : 0;
  // Whether the window can see through, whatever it shows now, so a
  // Workspace's dialog previews a transparency on a window that is solid.
  state.seeThrough = panel?.seeThrough() ?? null;
  const card = doc.querySelector("sval-dialog");
  state.frosted =
    !!card &&
    card.tone !== "critical" &&
    !card.hasAttribute("solid") &&
    !!state.seeThrough &&
    browserRoot.hasAttribute("data-sval-see-through") &&
    state.transparency > 0;
  paintTint(doc);
  // The box takes the card's edge, and an opaque card's fill.
  shapeDialogBox(card ?? root);
  if (state.frosted) {
    // A frosted card is clear, so the box takes the window's fill and blur
    // again.
    paintTint(doc);
  }
  if (card) {
    track(card);
  }
  return true;
}
