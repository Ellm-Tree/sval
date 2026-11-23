/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Fits a modal box (`SubDialog`'s `.dialogBox`) to the card its page draws.
 *
 * The box clips its frame to its rounded corners. Were the card to draw its
 * own edge inside that clip, the edge's anti-aliased curve and the clip's
 * would fall on the same pixels, each taking its share of the coverage, and
 * what lies behind the box would show through along the corners. So the box
 * draws the card's fill and edge, one rounded shape whose edge has a single
 * curve, and the card takes no room for an edge of its own. `SubDialog`
 * sizes the frame to a page's body (`resizeHorizontally`,
 * `resizeVertically`), so a border on a root that draws the card would
 * overflow the frame by its width and scroll the page both ways. The page
 * the box clips lies over the box's own fill of the same colour.
 *
 * @param {Element} card The element that draws the card: its border,
 *   corners and fill.
 * @param {object} [options]
 * @param {string} [options.shadow] The box's shadow.
 */
export function shapeDialogBox(card, { shadow = "none" } = {}) {
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
  box.style.boxShadow = shadow;
  card.style.borderWidth = "0";
}
