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
 * curve, and the card keeps its border's width in a clear colour. The page
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
  // The card's own edge, read without the clear colour an earlier call set.
  card.style.removeProperty("border-color");
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
  card.style.borderColor = "transparent";
}
