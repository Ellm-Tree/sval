/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Fits a page wearing `sval-dialog.css` to the browser window's modal box
 * (`gDialogBox`). Loaded before the page's own script.
 *
 * The page is a document of its own, so the window's private and agent
 * attributes are copied onto its root, and a tinted window's colour is
 * solved here for an opaque card (`SvalColor`), where `sval-dialog.css`
 * picks its palette from them as `sval-header.css` does for the window. The
 * box then draws the card's fill and edge, with its shadow
 * (`SvalDialogBox`); `SubDialog` clones the box for each dialog and removes
 * it when the dialog closes, so nothing outlives the page.
 */

"use strict";

{
  const THEME_ATTRIBUTES = ["data-sval-agent", "privatebrowsingmode"];

  const { SvalColor } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalColor.sys.mjs"
  );

  /** The custom properties the last {@link paintTint} set. */
  let tintProperties = [];

  /**
   * The colour of the window under the dialog, as the dialog opened, and
   * its transparency: no colour is Sval's own, see-through like any other
   * (`SvalColor.windowLook`).
   */
  let windowColor = null;
  let windowTransparency = 0;
  let windowSeeThrough = null;

  /**
   * Gives the card a Workspace's colour, solved opaque in this document's
   * appearance and contrast, or for a group's dialog the group's block on
   * the window under it; or the window's colour, or none. On a window that
   * can see through, the card is the colour the window shows at
   * `transparency` (`SvalColor.windowLook`), so it matches the window round
   * it.
   *
   * @param {string|object|null} [color] A Workspace colour; the window's
   *   when absent.
   * @param {object} [options]
   * @param {string|object|null} [options.group] A group colour to wear as
   *   its block.
   * @param {object} [options.on] The window that block sits on
   *   (`SvalColor.groupBlock`).
   * @param {number} [options.transparency] The Workspace's; the window's
   *   when absent.
   */
  const paintTint = (
    color = windowColor,
    { group = null, on = null, transparency = windowTransparency } = {}
  ) => {
    const root = document.documentElement;
    for (const name of tintProperties) {
      root.style.removeProperty(name);
    }
    tintProperties = [];
    const scheme = matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
    const more = matchMedia("(prefers-contrast: more)").matches;
    let look = null;
    if (group && on) {
      look = SvalColor.surfaceLook(
        SvalColor.groupBlock(group, on, 1, { more }),
        more
      );
    } else {
      look = SvalColor.windowLook(
        { color, transparency },
        { scheme, more, seeThrough: windowSeeThrough }
      );
    }
    if (!look) {
      root.removeAttribute("data-sval-tint");
      root.removeAttribute("data-sval-ink");
      return;
    }
    for (const [name, value] of Object.entries(
      SvalColor.windowProperties(look)
    )) {
      root.style.setProperty(name, value);
      tintProperties.push(name);
    }
    root.setAttribute("data-sval-tint", "true");
    root.setAttribute("data-sval-ink", look.side);
  };

  // A page that draws a colour of its own, such as the Workspace dialog's
  // preview, paints through this.
  window.svalPaintDialogTint = paintTint;

  const fit = () => {
    const frame = window.frameElement;
    const browserRoot = frame?.ownerDocument.documentElement;
    const root = document.documentElement;
    for (const name of THEME_ATTRIBUTES) {
      const value = browserRoot?.getAttribute(name);
      if (value === null || value === undefined) {
        root.removeAttribute(name);
      } else {
        root.setAttribute(name, value);
      }
    }
    const panel = browserRoot?.hasAttribute("data-sval-tint")
      ? frame.documentGlobal.SvalPanel
      : null;
    windowColor = panel?.windowColor ?? null;
    windowTransparency = panel?.windowLook?.transparency ?? 0;
    // Whether the window can see through, whatever it shows now, so a
    // Workspace's dialog previews a transparency on a window that is solid.
    windowSeeThrough = frame?.documentGlobal.SvalPanel?.seeThrough() ?? null;
    paintTint();
    const { shapeDialogBox } = ChromeUtils.importESModule(
      "moz-src:///browser/components/sval/SvalDialogBox.sys.mjs"
    );
    // Sval's own dialogs draw the card as `.sval-dialog`; Firefox's dialogs
    // in Sval's frame draw it on the root (`pages/dialog.css`).
    const card = document.querySelector(".sval-dialog") ?? root;
    shapeDialogBox(card, {
      shadow: getComputedStyle(card)
        .getPropertyValue("--sval-dialog-shadow")
        .trim(),
    });
  };

  // `SubDialog.resizeVertically` sizes the frame to the page once, at load,
  // and the box keeps that as its `min-height`. A card that grows or shrinks
  // after that, such as a line that rewraps, would be clipped or leave a band
  // under it. `SubDialog` replaces the page's `resizeBy` with one that moves
  // the frame and the box together, so the card asks for its height through
  // that whenever it differs from the frame's. The frame is the smaller of
  // the window's room and the height `SubDialog` keeps in the overlay's
  // `--subdialog-inner-height`, which `resizeBy` moves, so the card is
  // measured against that height: a card that opened taller than the window
  // and then shrinks would otherwise leave the kept height above the card.
  const track = () => {
    const card = document.querySelector(".sval-dialog");
    if (!card || !window.frameElement) {
      return;
    }
    const overlay = window.frameElement.closest(".dialogOverlay");
    new ResizeObserver(() => {
      const kept =
        parseFloat(
          overlay?.style.getPropertyValue("--subdialog-inner-height")
        ) || innerHeight;
      const delta = Math.ceil(card.getBoundingClientRect().height) - kept;
      if (delta) {
        window.resizeBy(0, delta);
      }
    }).observe(card);
  };

  const start = () => {
    fit();
    // `SubDialog._onContentLoaded` replaces `resizeBy` before `load`.
    if (document.readyState === "complete") {
      track();
    } else {
      window.addEventListener("load", track, { once: true });
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}
