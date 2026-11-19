/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The stem (messages spec §9.4): a popover joined to the button it grows
 * from, the button's face, a stem from it, 12px concave fillets where the
 * stem meets the content and the content's rounded box traced as one SVG
 * path, filled in the popover's fill and stroked once in its edge. Every
 * popover that grows from its button draws through this module, from any
 * side of the button, and `sval-stem.css` holds every rule that draws it.
 *
 * A popup grows a stem while it carries `sval-stem-host`:
 * - `sval-stem-side`: the side of its button it grows from, `top`,
 *   `bottom`, `left` or `right` (`bottom` where it names none);
 * - `sval-stem-hang`: it reaches 32px past its button on each side and
 *   stands inside the window by its shadow's reach, as the header's panels
 *   do; without it, it is at least as wide as its button and keeps the place
 *   Gecko gives it, as the Workspace panel's menus do;
 * - `sval-stem-off`: it opens with no stem this time.
 * The button it grows from is the toolbarbutton around its anchor, as
 * `panel.js` marks `[open]`, or the anchor itself; the face is that
 * button's icon or badge stack, or the whole button. The button carries
 * `sval-stem` and the face `sval-stem-anchor`, each naming the side, while
 * the stem is drawn.
 *
 * An element in a window's own document draws the same shape around itself
 * through {@link SvalStem.drawIn}, from a face it gives.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PanelMultiView:
    "moz-src:///browser/components/customizableui/PanelMultiView.sys.mjs",
});

const STEM_CSS = "chrome://browser/content/sval/sval-stem.css";
const SVG_NS = "http://www.w3.org/2000/svg";

/** The concave fillets' radius where the stem meets the content (§9.4). */
const STEM_FILLET = 12;

/** The edge's width (`sval-stem.css`). */
const STEM_EDGE = 1;

/**
 * Each side a popover can grow from, and how the shape turns to face it.
 * The shape is worked out as if the content hung below the face, in lengths
 * along the face (`u`) and away from it (`v`); `map` turns those into the
 * frame's `x` and `y`, and `unmap` turns them back. A `mirrored` turn
 * reverses the path's direction, so each arc's sweep flag flips with it.
 */
const SIDES = {
  bottom: { map: (u, v) => [u, v], unmap: (x, y) => [x, y], mirrored: false },
  top: { map: (u, v) => [u, -v], unmap: (x, y) => [x, -y], mirrored: true },
  right: { map: (u, v) => [v, u], unmap: (x, y) => [y, x], mirrored: true },
  left: { map: (u, v) => [-v, u], unmap: (x, y) => [y, -x], mirrored: false },
};

/** The custom properties a placed stem sets on its popup. */
const STEM_PROPERTIES = [
  "--sval-fillet-left",
  "--sval-fillet-right",
  "--sval-corner-left",
  "--sval-corner-right",
  "--sval-stem-drop",
  "--sval-stem-face-h",
  "--sval-stem-w",
  "--sval-stem-room",
  "--sval-stem-top-trim",
  "--sval-stem-body-left",
  "--sval-stem-body-top",
  "--sval-stem-body-width",
  "--sval-stem-body-height",
  "--sval-stem-body-radius",
  "--sval-stem-tab-left",
  "--sval-stem-tab-top",
  "--sval-stem-tab-width",
  "--sval-stem-tab-height",
  "--sval-stem-tab-radius",
];

/**
 * @param {Element} el
 * @returns {string} The side `el` grows from: a key of {@link SIDES}.
 */
function sideOf(el) {
  const side = el.getAttribute("sval-stem-side");
  return Object.hasOwn(SIDES, side) ? side : "bottom";
}

/**
 * Turns a rect through one of {@link SIDES}' maps.
 *
 * @param {{left: number, top: number, right: number, bottom: number}} rect
 * @param {function(number, number): number[]} turn `map` or `unmap`.
 * @returns {{left: number, top: number, right: number, bottom: number}}
 */
function turnRect(rect, turn) {
  const [a, b] = turn(rect.left, rect.top);
  const [c, d] = turn(rect.right, rect.bottom);
  return {
    left: Math.min(a, c),
    top: Math.min(b, d),
    right: Math.max(a, c),
    bottom: Math.max(b, d),
  };
}

/** Each corner's name and the way it points, as the shape has them. */
const CORNERS = { tl: [-1, -1], tr: [1, -1], br: [1, 1], bl: [-1, 1] };

/**
 * @param {number[]} way A corner's way, turned by a side's `map`.
 * @returns {string} The corner of the frame it points to.
 */
function cornerAt([x, y]) {
  return `${y < 0 ? "t" : "b"}${x < 0 ? "l" : "r"}`;
}

/**
 * @param {{tl: number, tr: number, br: number, bl: number}} radii In the
 *   frame.
 * @param {object} side One of {@link SIDES}.
 * @returns {{tl: number, tr: number, br: number, bl: number}} The same
 *   radii, at the corners the shape has them.
 */
function radiiToShape(radii, side) {
  const out = {};
  for (const [name, way] of Object.entries(CORNERS)) {
    out[name] = radii[cornerAt(side.map(...way))];
  }
  return out;
}

/**
 * @param {{tl: number, tr: number, br: number, bl: number}} radii As the
 *   shape has them.
 * @param {object} side One of {@link SIDES}.
 * @returns {{tl: number, tr: number, br: number, bl: number}} The same
 *   radii, at the frame's corners.
 */
function radiiFromShape(radii, side) {
  const out = {};
  for (const [name, way] of Object.entries(CORNERS)) {
    out[cornerAt(side.map(...way))] = radii[name];
  }
  return out;
}

/**
 * The corner radii `el` is drawn with: CSS scales all four down by one
 * factor where two on a side add up to more than the side
 * (CSS Backgrounds 3 §5.5), as a pill's 999px radius is.
 *
 * @param {Element} el
 * @param {{width: number, height: number}} rect `el`'s border box.
 * @returns {{tl: number, tr: number, br: number, bl: number}}
 */
function cornerRadii(el, rect) {
  const style = el.documentGlobal.getComputedStyle(el);
  const [tl, tr, br, bl] = [
    style.borderTopLeftRadius,
    style.borderTopRightRadius,
    style.borderBottomRightRadius,
    style.borderBottomLeftRadius,
  ].map(value => parseFloat(value) || 0);
  const fit = (length, a, b) => (a + b > length ? length / (a + b) : 1);
  const scale = Math.min(
    fit(rect.width, tl, tr),
    fit(rect.width, bl, br),
    fit(rect.height, tl, bl),
    fit(rect.height, tr, br)
  );
  return { tl: tl * scale, tr: tr * scale, br: br * scale, bl: bl * scale };
}

/**
 * The SVG path of the joined shape, clockwise from the face's top left as
 * the shape has it, grown outward by `grow`: the face's far corners and
 * sides, the stem, its concave fillets and the body's rounded box. Grown by
 * half the edge's width, the path is where the edge's stroke runs, so the
 * edge lies outside the shape, as a box's border does. The shape is given as
 * if the body hung below the face, and `side` turns each point to where it
 * is drawn.
 *
 * @param {object} shape
 * @param {{left: number, top: number, right: number, bottom: number}} shape.face
 * @param {{tl: number, tr: number}} shape.faceRadii
 * @param {{left: number, right: number}} shape.stem Within the face.
 * @param {{left: number, top: number, right: number, bottom: number}} shape.body
 * @param {{tl: number, tr: number, br: number, bl: number}} shape.radii The body's.
 * @param {{left: number, right: number}} shape.fillets
 * @param {number} grow
 * @param {object} side One of {@link SIDES}.
 * @returns {string}
 */
function stemPath({ face, faceRadii, stem, body, radii, fillets }, grow, side) {
  const o = grow;
  const n = value => Math.round(value * 1000) / 1000;
  const at = (x, y) => side.map(x, y).map(n).join(" ");
  const d = [];
  const line = (x, y) => d.push(`L${at(x, y)}`);
  const arc = (r, sweep, x, y) =>
    d.push(
      `A${n(r)} ${n(r)} 0 0 ${side.mirrored ? 1 - sweep : sweep} ${at(x, y)}`
    );
  // A square corner, grown, is its corner point: the stroke's miter join
  // keeps it square.
  const convex = (r, x, y, cornerX, cornerY) => {
    if (r > 0) {
      arc(r + o, 1, x, y);
    } else {
      line(cornerX, cornerY);
      line(x, y);
    }
  };
  // Where the body's near corner is narrower than the growth, its grown arc
  // starts or ends inside the stem's grown side, so the path meets the arc
  // where the side crosses it.
  const meet = (cx, r, x) =>
    body.top + r - Math.sqrt(Math.max(0, (r + o) ** 2 - (x - cx) ** 2));
  const apart = 1 / 60;

  d.push(`M${at(face.left - o, face.top + faceRadii.tl)}`);
  convex(
    faceRadii.tl,
    face.left + faceRadii.tl,
    face.top - o,
    face.left - o,
    face.top - o
  );
  line(face.right - faceRadii.tr, face.top - o);
  convex(
    faceRadii.tr,
    face.right + o,
    face.top + faceRadii.tr,
    face.right + o,
    face.top - o
  );
  if (face.right - stem.right > apart) {
    line(face.right + o, face.bottom + o);
    line(stem.right + o, face.bottom + o);
  }
  if (body.right - stem.right > apart) {
    const cx = body.right - radii.tr;
    if (fillets.right) {
      line(stem.right + o, body.top - fillets.right);
      arc(fillets.right - o, 0, stem.right + fillets.right, body.top - o);
      line(cx, body.top - o);
      convex(
        radii.tr,
        body.right + o,
        body.top + radii.tr,
        body.right + o,
        body.top - o
      );
    } else if (radii.tr > 0 && cx < stem.right + o) {
      line(stem.right + o, meet(cx, radii.tr, stem.right + o));
      arc(radii.tr + o, 1, body.right + o, body.top + radii.tr);
    } else {
      line(stem.right + o, body.top - o);
      line(cx, body.top - o);
      convex(
        radii.tr,
        body.right + o,
        body.top + radii.tr,
        body.right + o,
        body.top - o
      );
    }
  }
  line(body.right + o, body.bottom - radii.br);
  convex(
    radii.br,
    body.right - radii.br,
    body.bottom + o,
    body.right + o,
    body.bottom + o
  );
  line(body.left + radii.bl, body.bottom + o);
  convex(
    radii.bl,
    body.left - o,
    body.bottom - radii.bl,
    body.left - o,
    body.bottom + o
  );
  if (stem.left - body.left > apart) {
    const cx = body.left + radii.tl;
    line(body.left - o, body.top + radii.tl);
    if (fillets.left) {
      convex(radii.tl, cx, body.top - o, body.left - o, body.top - o);
      line(stem.left - fillets.left, body.top - o);
      arc(fillets.left - o, 0, stem.left - o, body.top - fillets.left);
    } else if (radii.tl > 0 && cx > stem.left - o) {
      arc(radii.tl + o, 1, stem.left - o, meet(cx, radii.tl, stem.left - o));
    } else {
      convex(radii.tl, cx, body.top - o, body.left - o, body.top - o);
      line(stem.left - o, body.top - o);
    }
  }
  if (stem.left - face.left > apart) {
    line(stem.left - o, face.bottom + o);
    line(face.left - o, face.bottom + o);
  }
  d.push("Z");
  return d.join("");
}

/**
 * The face's inside, which a popup's fill leaves out so the button's label
 * shows through the popover's window: the face inset by `inset`, its far
 * corners rounded with it and its near side square, as the anchor is
 * (`sval-stem.css`). The fill over the rim it keeps lies on the button's own
 * fill, of the same colour, so where the two windows' pixels fall makes no
 * gap between them.
 *
 * @param {{left: number, top: number, right: number, bottom: number}} face
 * @param {{tl: number, tr: number}} radii
 * @param {number} inset
 * @param {object} side One of {@link SIDES}.
 * @returns {string}
 */
function facePath(face, radii, inset, side) {
  const n = value => Math.round(value * 1000) / 1000;
  const at = (x, y) => side.map(x, y).map(n).join(" ");
  const sweep = side.mirrored ? 0 : 1;
  const left = face.left + inset;
  const right = face.right - inset;
  const top = face.top + inset;
  const bottom = face.bottom - inset;
  const tl = Math.max(0, radii.tl - inset);
  const tr = Math.max(0, radii.tr - inset);
  if (right <= left || bottom <= top) {
    return "";
  }
  return [
    `M${at(left, top + tl)}`,
    tl ? `A${n(tl)} ${n(tl)} 0 0 ${sweep} ${at(left + tl, top)}` : "",
    `L${at(right - tr, top)}`,
    tr ? `A${n(tr)} ${n(tr)} 0 0 ${sweep} ${at(right, top + tr)}` : "",
    `L${at(right, bottom)}`,
    `L${at(left, bottom)}Z`,
  ].join("");
}

/**
 * Lays out the stem between `face` and `content`, given in one frame, as the
 * shape has them: a content side that comes within `snap` of the face's is
 * put on it, so the edge runs along both in one straight line; the stem
 * runs within the content's near edge; and each end of the stem gets a
 * fillet where there is room for one and a square corner where there is
 * none, so the content's side runs into the stem.
 *
 * @param {object} rects
 * @param {{left: number, top: number, right: number, bottom: number}} rects.face
 * @param {{left: number, top: number, right: number, bottom: number}} rects.content
 * @param {object} side One of {@link SIDES}.
 * @param {number} snap
 * @returns {?object} Null where the content is not beyond the face's side,
 *   or not across from it.
 */
function layOut({ face, content }, side, snap) {
  const faceShape = turnRect(face, side.unmap);
  const body = turnRect(content, side.unmap);
  if (body.top < faceShape.bottom) {
    return null;
  }
  for (const end of ["left", "right"]) {
    if (Math.abs(body[end] - faceShape[end]) < snap) {
      body[end] = faceShape[end];
    }
  }
  const stem = {
    left: Math.max(faceShape.left, body.left),
    right: Math.min(faceShape.right, body.right),
  };
  if (stem.right <= stem.left) {
    return null;
  }
  const rooms = { left: stem.left - body.left, right: body.right - stem.right };
  const fillets = {
    left: rooms.left >= STEM_FILLET ? STEM_FILLET : 0,
    right: rooms.right >= STEM_FILLET ? STEM_FILLET : 0,
  };
  return { face: faceShape, body, stem, rooms, fillets };
}

/**
 * Traces what {@link layOut} laid out, back in its frame.
 *
 * @param {object} layout
 * @param {object} side One of {@link SIDES}.
 * @param {{tl: number, tr: number, br: number, bl: number}} faceRadii In the
 *   frame.
 * @param {{tl: number, tr: number, br: number, bl: number}} contentRadii In
 *   the frame.
 * @param {boolean} faceHole Whether the fill leaves out the face's inside
 *   ({@link facePath}).
 * @returns {{edge: string, fill: string, tab: object, tabRadii: object,
 *   body: object}} The edge's path and the fill's, the face and stem's box
 *   and its corners, and the content's box as the shape draws it.
 */
function trace(layout, side, faceRadii, contentRadii, faceHole) {
  const { face, body, stem, fillets } = layout;
  const shape = {
    face,
    faceRadii: radiiToShape(faceRadii, side),
    stem,
    body,
    radii: radiiToShape(contentRadii, side),
    fillets,
  };
  const edge = stemPath(shape, STEM_EDGE / 2, side);
  return {
    edge,
    fill: faceHole
      ? edge + facePath(face, shape.faceRadii, STEM_EDGE, side)
      : edge,
    tab: turnRect(
      { left: face.left, right: face.right, top: face.top, bottom: body.top },
      side.map
    ),
    tabRadii: radiiFromShape(
      { tl: shape.faceRadii.tl, tr: shape.faceRadii.tr, br: 0, bl: 0 },
      side
    ),
    body: turnRect(body, side.map),
  };
}

/**
 * @param {{tl: number, tr: number, br: number, bl: number}} r Corner radii.
 * @returns {string} The radii as a `border-radius` value.
 */
function cornersValue(r) {
  return [r.tl, r.tr, r.br, r.bl].map(v => `${v}px`).join(" ");
}

// ------------------------------------------------------------ popups

/**
 * The button a popup grows from, while it is a stem host.
 *
 * @param {Element} popup
 * @returns {Element|null}
 */
function buttonOf(popup) {
  const anchor = popup.anchorNode;
  if (
    !anchor ||
    !popup.hasAttribute("sval-stem-host") ||
    popup.hasAttribute("sval-stem-off")
  ) {
    return null;
  }
  return anchor.closest("toolbarbutton") ?? anchor;
}

/**
 * @param {Element} button
 * @returns {Element} The part of `button` drawn as a pill: a toolbarbutton's
 *   icon or badge stack, or the whole of any other button.
 */
function faceOf(button) {
  return (
    button.querySelector(
      ":scope > :is(.toolbarbutton-icon, .toolbarbutton-badge-stack)"
    ) ?? button
  );
}

/**
 * The SVG in `popup`'s shadow tree that draws its joined shape, made the
 * first time it is asked for and kept, hidden while no stem is placed. Its
 * first path draws the fill, its second the edge.
 *
 * @param {Element} popup
 * @returns {SVGSVGElement|null} Null where the popup has no content part yet.
 */
function outlineOf(popup) {
  const shadow = popup.shadowRoot;
  if (!shadow?.querySelector('[part~="content"]')) {
    return null;
  }
  let svg = shadow.querySelector('[part~="sval-stem-outline"]');
  if (!svg) {
    const doc = popup.ownerDocument;
    svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("part", "sval-stem-outline");
    svg.setAttribute("aria-hidden", "true");
    for (const part of ["sval-stem-fill", "sval-stem-edge"]) {
      const path = doc.createElementNS(SVG_NS, "path");
      path.setAttribute("part", part);
      svg.append(path);
    }
    shadow.append(svg);
  }
  return svg;
}

function detach(popup) {
  const button = popup._svalStemButton;
  popup._svalStemButton = null;
  popup._svalStemMargins = null;
  popup._svalStemTab = null;
  popup._svalStemObserver?.disconnect();
  popup._svalStemObserver = null;
  popup.style.removeProperty("margin-left");
  popup.style.removeProperty("margin-right");
  for (const path of popup.shadowRoot?.querySelectorAll(
    '[part~="sval-stem-outline"] > path'
  ) ?? []) {
    path.removeAttribute("d");
  }
  if (button) {
    button.removeAttribute("sval-stem");
    faceOf(button).removeAttribute("sval-stem-anchor");
  }
  popup.removeAttribute("sval-stem");
  for (const name of STEM_PROPERTIES) {
    popup.style.removeProperty(name);
  }
}

/**
 * @param {Element} popup
 * @param {Window} win The popup's browser window.
 * @returns {number} How far the popover's shadow reaches past its content
 *   (`--sval-stem-shadow-reach`, `sval-stem.css`).
 */
function shadowReach(popup, win) {
  return (
    parseFloat(
      win.getComputedStyle(popup).getPropertyValue("--sval-stem-shadow-reach")
    ) || 0
  );
}

/**
 * Moves `popup` along its button's edge until its content stands
 * `shadowReach` inside `win`'s sides, so its shadow fades out within the
 * window and does not end at its edge. The content never stands further in
 * than its button's own side, which the stem joins: a button nearer the
 * edge than that takes the content's side in line with its own. Gecko keeps
 * a chrome popup on the screen alone (`nsMenuPopupFrame::GetConstraintRect`),
 * widened by its input region margin, so a popover that reaches past its
 * button runs off a window that stops short of the screen's edge. Gecko
 * adds a popup's left margin to its place and takes its right margin away
 * whichever side it is aligned by
 * (`nsMenuPopupFrame::AdjustPositionForAnchorAlign`), so moving both by one
 * length moves the popup by that length. A popover wider than the window
 * keeps its left edge in.
 *
 * @param {Element} popup
 * @param {Window} win The popup's browser window.
 * @param {{left: number, right: number}} content The popup's content on the
 *   screen.
 * @param {{left: number, right: number}} face The button on the screen.
 * @returns {boolean} Whether the popup moved.
 */
function keepInWindow(popup, win, content, face) {
  const reach = shadowReach(popup, win);
  const left = Math.min(win.mozInnerScreenX + reach, face.left);
  const right = Math.max(
    win.mozInnerScreenX + win.innerWidth - reach,
    face.right
  );
  const dpr = win.devicePixelRatio;
  // Gecko places a popup on whole device pixels (`nsMenuPopupFrame::GetRects`).
  const slack = 0.5 / dpr;
  let by = 0;
  if (content.right > right + slack) {
    by = -Math.ceil((content.right - right) * dpr) / dpr;
  }
  if (content.left + by < left - slack) {
    by = Math.ceil((left - content.left) * dpr) / dpr;
  }
  if (!by) {
    return false;
  }
  if (!popup._svalStemMargins) {
    const style = win.getComputedStyle(popup);
    popup._svalStemMargins = {
      left: parseFloat(style.marginLeft),
      right: parseFloat(style.marginRight),
      by: 0,
    };
  }
  const margins = popup._svalStemMargins;
  margins.by += by;
  popup.style.marginLeft = `${margins.left + margins.by}px`;
  popup.style.marginRight = `${margins.right - margins.by}px`;
  return true;
}

/**
 * Bounds the height of `popup`'s content to the room between its edge on
 * the far side from its button and `shadowReach` inside `win`'s foot, or
 * top for a popover over its button, and its content scrolls within that
 * (`sval-stem.css`). Gecko keeps a chrome popup on the screen alone
 * (`nsMenuPopupFrame::GetConstraintRect`), so a popover under its button
 * runs past a window that stops short of the screen's foot. The bound is
 * set at `popupshowing` from where the content starts at the nearest, a
 * fillet past the pill, so a menu, which gets no `popuppositioned`, is
 * bounded in its first paint; placing the stem sets it again from where the
 * content stands. A popover beside its button keeps `popup.css`'s bound.
 *
 * @param {Element} popup
 * @param {Window} win The popup's browser window.
 * @param {{top: number, bottom: number}} content The popup's content on the
 *   screen: its top under its button, its bottom over it.
 */
function keepInRoom(popup, win, content) {
  const side = sideOf(popup);
  if (side !== "top" && side !== "bottom") {
    return;
  }
  // The bound replaces `popup.css`'s, which keeps the content within a
  // popup Gecko has shrunk to the screen, so the screen's edge bounds it too.
  const reach = shadowReach(popup, win);
  const room =
    side === "bottom"
      ? Math.min(
          win.mozInnerScreenY + win.innerHeight,
          win.screen.availTop + win.screen.availHeight
        ) -
        reach -
        content.top
      : content.bottom -
        Math.max(win.mozInnerScreenY, win.screen.availTop) -
        reach;
  const value = `${Math.max(0, Math.floor(room))}px`;
  if (popup.style.getPropertyValue("--sval-stem-room") !== value) {
    popup.style.setProperty("--sval-stem-room", value);
  }
}

/**
 * Places the stem once the popup has its place. Each XUL popup is a native
 * window of its own (`nsMenuPopupFrame::CreateWidget`), and the popover's
 * window reaches over its button (`sval-stem.css`), so the popover draws the
 * whole shape: its path is traced from the button's face, measured on the
 * screen, and from the content, measured in the popup. A popup Gecko opens
 * on the other side of its button, where it had no room on its own side,
 * has nothing to grow from, and lets go of it while it stays open: letting
 * go gives it back its own margins, which move it.
 *
 * @param {Element} popup
 * @param {boolean} [traceOnly] Whether only to trace the path again where
 *   the popup stands, without moving it or bounding its content, whose size
 *   would change again within the resize observer's own callback.
 */
function place(popup, traceOnly = false) {
  const button = popup._svalStemButton;
  if (!button) {
    return;
  }
  const win = button.documentGlobal;
  const faceEl = faceOf(button);
  const pill = faceEl.getBoundingClientRect();
  const face = {
    left: win.mozInnerScreenX + pill.left,
    right: win.mozInnerScreenX + pill.right,
    top: win.mozInnerScreenY + pill.top,
    bottom: win.mozInnerScreenY + pill.bottom,
  };
  let frame = popup.getBoundingClientRect();
  const atFrame = () => ({
    left: win.mozInnerScreenX + frame.left,
    top: win.mozInnerScreenY + frame.top,
    width: frame.width,
  });
  // An arrow panel's first `popuppositioned` comes before its window is
  // shown (`nsXULPopupPositionedEvent::Run`), so the stem placed there is in
  // the window's first paint; `popupshown` comes after that paint, and after
  // any opening transition. The frame stands at the place `GetRects` chose,
  // against the main window's root (`nsMenuPopupFrame::PerformMove`), and
  // the window follows it at the next paint
  // (`nsMenuPopupFrame::SchedulePendingWidgetMoveResize`). So the window's
  // rect is empty until the popup is open, and an open popup that moves can
  // fire `popuppositioned` before its window has followed
  // (`XULPopupElement::GetOuterScreenRect` reads the window). Where the two
  // differ by more than a pixel the stem is placed by the frame. macOS can
  // put the window half a point from the frame, and there the stem is
  // placed by the window.
  let box = popup.getOuterScreenRect();
  const framed = atFrame();
  if (
    !box.width ||
    Math.abs(box.left - framed.left) > 1 ||
    Math.abs(box.top - framed.top) > 1
  ) {
    box = framed;
  }
  const part = popup.shadowRoot?.querySelector('[part~="content"]');
  const outline = outlineOf(popup);
  if (!box.width || !part || !outline) {
    return;
  }
  const contentOf = () => {
    const r = part.getBoundingClientRect();
    return {
      left: box.left + r.left - frame.left,
      right: box.left + r.right - frame.left,
      top: box.top + r.top - frame.top,
      bottom: box.top + r.bottom - frame.top,
      width: r.width,
      height: r.height,
    };
  };
  const sideName = sideOf(popup);
  const side = SIDES[sideName];
  const along = sideName === "top" || sideName === "bottom";
  let content = contentOf();
  if (!traceOnly && along && keepInWindow(popup, win, content, face)) {
    // Reading the frame's rect reflows the popup, which moves its frame
    // (`nsMenuPopupFrame::PerformMove`); its window follows at the next
    // paint, so the stem is placed by the frame.
    frame = popup.getBoundingClientRect();
    box = atFrame();
    content = contentOf();
  }
  if (!traceOnly) {
    keepInRoom(popup, win, content);
  }
  // In the popup's window, whose top left is the box's. Gecko places the
  // window on whole device pixels (`nsMenuPopupFrame::GetRects`) and the
  // button stands where the layout puts it, so a content side meant to meet
  // the button's flush lands up to a device pixel off it, and the shape
  // puts it on the button's. The content has no fill or edge of its own
  // while the stem is placed (`sval-stem.css`). Gecko also slides a popover
  // that would leave the screen back along its edge
  // (`nsMenuPopupFrame::SlideOrResize`), which can bring a corner under the
  // stem, and the corner rounds no further than the room left.
  const inWindow = rect => ({
    left: rect.left - box.left,
    right: rect.right - box.left,
    top: rect.top - box.top,
    bottom: rect.bottom - box.top,
  });
  const layout = layOut(
    { face: inWindow(face), content: inWindow(content) },
    side,
    1 / win.devicePixelRatio
  );
  if (!layout) {
    detach(popup);
    return;
  }
  const px = value => `${value}px`;
  for (const end of ["left", "right"]) {
    popup.style.setProperty(`--sval-fillet-${end}`, px(layout.fillets[end]));
    popup.style.setProperty(
      `--sval-corner-${end}`,
      px(Math.max(0, layout.rooms[end] - layout.fillets[end]))
    );
  }
  // The content's near corners follow the corners just set.
  const contentRadii = cornerRadii(part, content);
  const traced = trace(
    layout,
    side,
    cornerRadii(faceEl, pill),
    contentRadii,
    true
  );
  const [fillPath, edgePath] = outline.children;
  fillPath.setAttribute("d", traced.fill);
  edgePath.setAttribute("d", traced.edge);
  const { body, tab } = traced;
  const set = (name, value) => popup.style.setProperty(name, value);
  set("--sval-stem-body-left", px(body.left));
  set("--sval-stem-body-top", px(body.top));
  set("--sval-stem-body-width", px(body.right - body.left));
  set("--sval-stem-body-height", px(body.bottom - body.top));
  set("--sval-stem-body-radius", cornersValue(contentRadii));
  set("--sval-stem-tab-left", px(tab.left));
  set("--sval-stem-tab-top", px(tab.top));
  set("--sval-stem-tab-width", px(tab.right - tab.left));
  set("--sval-stem-tab-height", px(tab.bottom - tab.top));
  set("--sval-stem-tab-radius", cornersValue(traced.tabRadii));
  popup._svalStemTab = tab;
  button.setAttribute("sval-stem", sideName);
  faceEl.setAttribute("sval-stem-anchor", sideName);
  popup.setAttribute("sval-stem", "placed");
}

/** @param {Event} event `popupshown` or `popuppositioned`. */
function onPlaced(event) {
  place(event.target);
}

/**
 * `popupshowing`: marks the popover and its button before Gecko positions
 * the popover, so `sval-stem.css` has already made room for the stem. The
 * popover's content is watched for a change of size, which moves its edge:
 * a menu gets no `popuppositioned`
 * (`nsXULPopupPositionedEvent::DispatchIfNeeded`), and a resize observer is
 * heard after layout and before the paint, so the path is traced again in
 * the same frame.
 *
 * @param {Event} event
 */
function onShowing(event) {
  const popup = event.target;
  if (event.defaultPrevented) {
    return;
  }
  const button = buttonOf(popup);
  if (!button) {
    return;
  }
  detach(popup);
  const win = popup.documentGlobal;
  const faceEl = faceOf(button);
  const face = faceEl.getBoundingClientRect();
  // Gecko places the popup beside its anchor, which can sit inside the
  // pill (the downloads button's indicator, or the first child Gecko anchors
  // to for a button marked `delegatesanchor`, `MaybeDelegatedAnchorFrame`),
  // and the stem then starts further out.
  const anchorEl = popup.anchorNode.hasAttribute("delegatesanchor")
    ? (popup.anchorNode.firstElementChild ?? popup.anchorNode)
    : popup.anchorNode;
  const anchor = anchorEl.getBoundingClientRect();
  const side = sideOf(popup);
  const across = side === "top" || side === "bottom";
  popup._svalStemButton = button;
  const drop = {
    bottom: face.bottom - anchor.bottom,
    top: anchor.top - face.top,
    right: face.right - anchor.right,
    left: anchor.left - face.left,
  }[side];
  popup.style.setProperty("--sval-stem-drop", `${Math.max(0, drop)}px`);
  popup.style.setProperty(
    "--sval-stem-face-h",
    `${across ? face.height : face.width}px`
  );
  popup.style.setProperty(
    "--sval-stem-w",
    `${across ? face.width : face.height}px`
  );
  keepInRoom(popup, win, {
    top: win.mozInnerScreenY + face.bottom + STEM_FILLET,
    bottom: win.mozInnerScreenY + face.top - STEM_FILLET,
  });
  popup.setAttribute("sval-stem", "");
  button.setAttribute("sval-stem", side);
  faceEl.setAttribute("sval-stem-anchor", side);
  if (side === "bottom") {
    // Gecko places a popover under its button its top margin below the
    // anchor, and the margin reaches the shadow's room above the face.
    // macOS keeps a popup's window below the menu bar, at the screen's
    // available top, and moves the window down without moving its frame,
    // so the stem would be drawn that much below the face. The window gives
    // up the room it has no space for and opens where its frame stands.
    const windowTop =
      win.mozInnerScreenY +
      anchor.bottom +
      parseFloat(win.getComputedStyle(popup).marginTop);
    popup.style.setProperty(
      "--sval-stem-top-trim",
      `${Math.max(0, win.screen.availTop - windowTop)}px`
    );
  }
  const part = outlineOf(popup)
    ? popup.shadowRoot.querySelector('[part~="content"]')
    : null;
  if (part) {
    popup._svalStemObserver = new win.ResizeObserver(() => place(popup, true));
    popup._svalStemObserver.observe(part);
  }
}

/**
 * `mousedown`: a press on a popover's window outside what it draws, its
 * content, its stem and the face it wraps, closes the popover, as a press
 * outside its window does.
 *
 * The window reaches past the content on every side by its shadow margin,
 * and over the button and its neighbours (`sval-stem.css`). Windows and GTK
 * let a press in the shadow margin through to the window below
 * (`nsWindow::SetInputRegion`), where Gecko rolls the popover up
 * (`nsXULPopupManager::Rollup`). macOS ignores the margin
 * (`nsCocoaWindow::SetInputRegion`), so there the press reaches the popover
 * itself and nothing rolls it up. A press on the button closes the popover
 * and never reaches the button, so it does not open it again. A `noautohide`
 * popover, which a press outside leaves open, closes only on the button.
 *
 * @param {MouseEvent} event
 */
function onPress(event) {
  if (event.button !== 0) {
    return;
  }
  const popup = event.target.closest?.("panel, menupopup");
  const button = popup?._svalStemButton;
  if (!button || popup.state !== "open") {
    return;
  }
  const win = button.documentGlobal;
  const hits = (rect, left, top) =>
    event.screenX >= left + rect.left &&
    event.screenX < left + rect.right &&
    event.screenY >= top + rect.top &&
    event.screenY < top + rect.bottom;
  const onButton = hits(
    button.getBoundingClientRect(),
    win.mozInnerScreenX,
    win.mozInnerScreenY
  );
  if (!onButton) {
    if (popup.hasAttribute("noautohide")) {
      return;
    }
    const box = popup.getOuterScreenRect();
    const frame = popup.getBoundingClientRect();
    const content = popup.shadowRoot
      ?.querySelector('[part~="content"]')
      ?.getBoundingClientRect();
    if (!content || hits(content, box.left - frame.left, box.top - frame.top)) {
      return;
    }
    const tab = popup._svalStemTab;
    if (tab && hits(tab, box.left, box.top)) {
      return;
    }
  }
  lazy.PanelMultiView.hidePopup(popup);
}

// ------------------------------------------------- in-document hosts

/**
 * @param {Element} host
 * @returns {SVGSVGElement} The outline {@link SvalStem.drawIn} draws in
 *   `host`, made the first time and kept as its first child.
 */
function documentOutlineOf(host) {
  let svg = host.querySelector(":scope > .sval-stem-outline");
  if (!svg) {
    const doc = host.ownerDocument;
    svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "sval-stem-outline");
    svg.setAttribute("aria-hidden", "true");
    svg.append(doc.createElementNS(SVG_NS, "path"));
    host.prepend(svg);
  }
  return svg;
}

export const SvalStem = {
  /**
   * `browser-window-before-initial-xul-layout`: the stem's stylesheet, as an
   * additional author sheet, and the listeners that grow each stem host's
   * stem. `popupshowing` is heard as it bubbles, once the popup's own
   * listeners have had their chance to cancel it or to mark it a host. The
   * rest are captured, so the stem is in place before any listener on the
   * popup sees it shown.
   *
   * @param {Window} win A browser window.
   */
  mount(win) {
    win.windowUtils.loadSheetUsingURIString(
      STEM_CSS,
      win.windowUtils.AUTHOR_SHEET
    );
    win.addEventListener("popupshowing", onShowing);
    win.addEventListener("mousedown", onPress, true);
    for (const type of ["popupshown", "popuppositioned"]) {
      win.addEventListener(type, onPlaced, true);
    }
    win.addEventListener(
      "popuphiding",
      event => {
        if (event.target._svalStemButton) {
          detach(event.target);
        }
      },
      true
    );
  },

  /**
   * Draws the stem's shape around `host`, an element in a window's own
   * document, from `face` to `content`: one path, filled in the popover's
   * fill and stroked in its edge, under `host`'s children, while `content`
   * gives up its own fill (`sval-stem.css`). The face is drawn in full,
   * since nothing of the window shows through it. Where `content` is not
   * beyond the face's `side`, or not across from it, nothing is drawn.
   *
   * @param {Element} host Positioned; the shape is drawn in its frame.
   * @param {object} shape
   * @param {{left: number, top: number, right: number, bottom: number}} shape.face
   *   In the window's viewport.
   * @param {{tl: number, tr: number, br: number, bl: number}} shape.faceRadii
   * @param {Element} shape.content
   * @param {string} shape.side A key of {@link SIDES}.
   */
  drawIn(host, { face, faceRadii, content, side: sideName }) {
    const side = SIDES[sideName];
    const path = documentOutlineOf(host).firstElementChild;
    const frame = host.getBoundingClientRect();
    const box = content.getBoundingClientRect();
    const inHost = rect => ({
      left: rect.left - frame.left,
      right: rect.right - frame.left,
      top: rect.top - frame.top,
      bottom: rect.bottom - frame.top,
    });
    const layout = layOut(
      { face: inHost(face), content: inHost(box) },
      side,
      0.5
    );
    content.toggleAttribute("sval-stem-content", !!layout);
    if (!layout) {
      host.removeAttribute("sval-stem");
      path.removeAttribute("d");
      return;
    }
    const traced = trace(
      layout,
      side,
      faceRadii,
      cornerRadii(content, box),
      false
    );
    path.setAttribute("d", traced.fill);
    host.setAttribute("sval-stem", "placed");
  },
};
