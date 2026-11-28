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
 * A popup whose window shows the system's backdrop, as a see-through
 * window's do, gives the backdrop the stem's shape, the face included
 * ({@link shapeWindow}), and draws the face again over it
 * ({@link showFace}).
 * A popover whose button stands inside an element whose `sval-stem-beside`
 * names a width, while that element is no wider, opens beside the button,
 * on the side facing the window's middle, in place of its own. A pill
 * marked `sval-stem-face` that a button stands alone in is the face the
 * stem grows from, as is a button's own child marked `sval-stem-face`.
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
export const STEM_FILLET = 12;

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
  "--sval-stem-face-left",
  "--sval-stem-face-top",
  "--sval-stem-face-width",
  "--sval-stem-face-height",
  "--sval-stem-face-image",
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
 * The face's inside, which a solid popup's fill leaves out so the button's
 * label shows through the popover's window: the face inset by `inset`, its far
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
 * @returns {?object} Null where the content stands on another side of the
 *   face, or not across from it.
 */
function layOut({ face, content }, side, snap) {
  if (!onSide({ face, content }, side)) {
    return null;
  }
  const faceShape = turnRect(face, side.unmap);
  const body = turnRect(content, side.unmap);
  // A content edge that reaches into the face is put on the face's edge.
  body.top = Math.max(body.top, faceShape.bottom);
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
 * Whether `content` stands on `side` of `face`. A content edge that reaches
 * into the face still does, short of where the stem's margins put it by
 * however its window was rounded or moved; one past the face's middle
 * stands on another side, where Gecko flipped it.
 *
 * @param {object} rects
 * @param {{left: number, top: number, right: number, bottom: number}} rects.face
 * @param {{left: number, top: number, right: number, bottom: number}} rects.content
 * @param {object} side One of {@link SIDES}.
 * @returns {boolean}
 */
function onSide({ face, content }, side) {
  const faceShape = turnRect(face, side.unmap);
  return (
    turnRect(content, side.unmap).top >= (faceShape.top + faceShape.bottom) / 2
  );
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
 * @returns {Element} The part of `button` drawn as a pill: the pill around
 *   it where the button stands alone in one, which marks itself
 *   `sval-stem-face`; else the child of a button that marks it
 *   `sval-stem-face`, a toolbarbutton's icon or badge stack, or the whole
 *   of any other button.
 */
function faceOf(button) {
  const pill = button.parentElement;
  return (
    (pill?.hasAttribute("sval-stem-face") ? pill : null) ??
    button.querySelector(
      ":scope > :is([sval-stem-face], .toolbarbutton-icon, .toolbarbutton-badge-stack)"
    ) ??
    button
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

/**
 * Gives `popup`'s window its whole backdrop back.
 *
 * @param {Element} popup
 */
function clearShape(popup) {
  if (popup._svalStemShapeKey !== null) {
    popup._svalStemShapeKey = null;
    popup.setWindowShape();
  }
}

/**
 * Draws `popup` as itself while it keeps its button and the stem's room.
 *
 * @param {Element} popup
 */
function unplace(popup) {
  for (const path of popup.shadowRoot?.querySelectorAll(
    '[part~="sval-stem-outline"] > path'
  ) ?? []) {
    path.removeAttribute("d");
  }
  faceOf(popup._svalStemButton).removeAttribute("sval-stem-anchor");
  popup.setAttribute("sval-stem", "");
  popup.removeAttribute("sval-stem-pending");
  clearShape(popup);
  showFace(popup, null);
}

function detach(popup) {
  popup._svalStemOffSide = 0;
  showFace(popup, null);
  const button = popup._svalStemButton;
  popup._svalStemButton = null;
  popup._svalStemMargins = null;
  popup._svalStemTab = null;
  popup._svalStemObserver?.disconnect();
  popup._svalStemObserver = null;
  for (const side of ["left", "right", "top", "bottom"]) {
    popup.style.removeProperty(`margin-${side}`);
  }
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
  popup.removeAttribute("sval-stem-pending");
  clearShape(popup);
  popup._svalStemSettling = false;
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
 * @param {Window} win
 * @param {{above: number, below: number}} margin A popup's window past its
 *   content above and below it.
 * @returns {{top: number, bottom: number}} Where the popup's content may
 *   stand on the screen with its whole window on the screen's available
 *   height.
 */
function screenRoom(win, margin) {
  return {
    top: win.screen.availTop + margin.above,
    bottom: win.screen.availTop + win.screen.availHeight - margin.below,
  };
}

/**
 * @returns {number} The least room between a popup and its window's edge,
 *   which Gecko holds every popup to (`nsMenuPopupFrame::GetConstraintRect`).
 */
function windowInset() {
  return Services.prefs.getIntPref("ui.popup.window_inset", 0);
}

/**
 * @param {Element} popup
 * @param {Window} win
 * @returns {number} How far inside its window's edges `popup`'s content
 *   stands: past its shadow's reach, and never nearer than
 *   {@link windowInset}.
 */
function edgeInset(popup, win) {
  return Math.max(windowInset(), shadowReach(popup, win));
}

/**
 * Moves `popup` along its button's edge until its content stands
 * {@link edgeInset} inside `win`'s sides, so its shadow fades out within the
 * window and does not end at its edge: across for a popover above or below
 * its button, up and down for one beside it. The content never stands
 * further in than its button's own side, which the stem joins: a button
 * nearer the edge than that takes the content's side in line with its own.
 * Gecko keeps a chrome popup on the screen alone
 * (`nsMenuPopupFrame::GetConstraintRect`), widened by its input region
 * margin, so a popover that reaches past its button runs off a window that
 * stops short of the screen's edge. Gecko adds a popup's left and top
 * margins to its place and takes its right and bottom margins away
 * whichever side it is aligned by
 * (`nsMenuPopupFrame::AdjustPositionForAnchorAlign`), so moving both of an
 * axis by one length moves the popup by that length. A popover longer than
 * the window keeps its start edge in.
 *
 * @param {Element} popup
 * @param {Window} win The popup's browser window.
 * @param {{left: number, right: number, top: number, bottom: number}} content
 *   The popup's content on the screen.
 * @param {{left: number, right: number, top: number, bottom: number}} face
 *   The button on the screen.
 * @param {boolean} vertical Whether it moves up and down.
 * @param {{above: number, below: number}} around The popup's window past its
 *   content above and below it.
 * @returns {boolean} Whether the popup moved.
 */
function keepInWindow(popup, win, content, face, vertical, around) {
  const [start, end, margin, marginEnd] = vertical
    ? ["top", "bottom", "marginTop", "marginBottom"]
    : ["left", "right", "marginLeft", "marginRight"];
  const origin = vertical ? win.mozInnerScreenY : win.mozInnerScreenX;
  const size = vertical ? win.innerHeight : win.innerWidth;
  const reach = edgeInset(popup, win);
  let low = origin + reach;
  let high = origin + size - reach;
  if (vertical) {
    // macOS keeps a popup's window below the menu bar, at the screen's
    // available top, moving the window without its frame, which would
    // part the stem from its button: the whole window stands on the
    // screen's available height.
    const screen = screenRoom(win, around);
    low = Math.max(low, screen.top);
    high = Math.min(high, screen.bottom);
  }
  low = Math.min(low, face[start]);
  high = Math.max(high, face[end]);
  // A content side short of a fillet's room from its button's side
  // (`layOut`) would step out from the stem: it stands on the button's.
  if (face[start] - low < STEM_FILLET) {
    low = face[start];
  }
  if (high - face[end] < STEM_FILLET) {
    high = face[end];
  }
  const dpr = win.devicePixelRatio;
  // Gecko places a popup on whole device pixels (`nsMenuPopupFrame::GetRects`).
  const slack = 0.5 / dpr;
  let by = 0;
  if (content[end] > high + slack) {
    by = -Math.ceil((content[end] - high) * dpr) / dpr;
  }
  if (content[start] + by < low - slack) {
    by = Math.ceil((low - content[start]) * dpr) / dpr;
  }
  const margins = popup._svalStemMargins?.[margin];
  // A shift that moved the content the other way, as the » panel's does on
  // Linux, would only push it further on each pass and part it from its
  // button: the popover goes back to where Gecko put it and stays there.
  if (
    margins?.lastBy &&
    Math.sign(content[end] - margins.lastEnd) === -Math.sign(margins.lastBy)
  ) {
    margins.held = true;
    margins.lastBy = 0;
    if (margins.by) {
      margins.by = 0;
      popup.style[margin] = `${margins.start}px`;
      popup.style[marginEnd] = `${margins.end}px`;
      return true;
    }
    return false;
  }
  if (!by || margins?.held) {
    if (margins) {
      margins.lastBy = 0;
    }
    return false;
  }
  popup._svalStemMargins ??= {};
  if (!popup._svalStemMargins[margin]) {
    const style = win.getComputedStyle(popup);
    popup._svalStemMargins[margin] = {
      start: parseFloat(style[margin]),
      end: parseFloat(style[marginEnd]),
      by: 0,
    };
  }
  const shift = popup._svalStemMargins[margin];
  shift.by += by;
  shift.lastBy = by;
  shift.lastEnd = content[end];
  popup.style[margin] = `${shift.start + shift.by}px`;
  popup.style[marginEnd] = `${shift.end - shift.by}px`;
  return true;
}

/**
 * Bounds the height of `popup`'s content to the room between its edge on
 * the far side from its button and {@link edgeInset} inside `win`'s foot, or
 * top for a popover over its button, or to the window's height less that
 * inset at each end for one beside its button, and its content scrolls
 * within that (`sval-stem.css`). Gecko keeps a chrome popup on the screen
 * alone (`nsMenuPopupFrame::GetConstraintRect`), so a popover runs past a
 * window that stops short of the screen's edge. The bound is set at
 * `popupshowing` from where the content starts at the nearest, a fillet
 * past the pill, so the content is bounded in its first layout; placing
 * the stem sets it again from where the content stands.
 *
 * @param {Element} popup
 * @param {Window} win The popup's browser window.
 * @param {{top: number, bottom: number}} content The popup's content on the
 *   screen: its top under its button, its bottom over it.
 * @param {{above: number, below: number}} [margin] The popup's window past
 *   its content above and below it, where it is known.
 */
function keepInRoom(popup, win, content, margin = { above: 0, below: 0 }) {
  const side = sideOf(popup);
  // The bound replaces `popup.css`'s, which keeps the content within a
  // popup Gecko has shrunk to the screen, so the screen's edge bounds it too.
  const reach = edgeInset(popup, win);
  let top = Math.max(win.mozInnerScreenY, win.screen.availTop) + reach;
  let bottom =
    Math.min(
      win.mozInnerScreenY + win.innerHeight,
      win.screen.availTop + win.screen.availHeight
    ) - reach;
  if (side === "left" || side === "right") {
    // Its whole window on the screen ({@link keepInWindow}).
    const screen = screenRoom(win, margin);
    top = Math.max(top, screen.top);
    bottom = Math.min(bottom, screen.bottom);
  }
  const room = {
    bottom: bottom - content.top,
    top: content.bottom - top,
    // Beside its button, it moves along the button's edge to stand in the
    // window ({@link keepInWindow}): the window's whole height is its room.
    left: bottom - top,
    right: bottom - top,
  }[side];
  const value = `${Math.max(0, Math.floor(room))}px`;
  if (popup.style.getPropertyValue("--sval-stem-room") !== value) {
    popup.style.setProperty("--sval-stem-room", value);
  }
}

/** How far apart, in CSS pixels, a window shape's ring samples its outline. */
const SHAPE_STEP = 2;

/**
 * Samples a closed path that {@link stemPath} traced, of straight lines and
 * circular arcs alone, by its own geometry: each line by its ends, each arc
 * every {@link SHAPE_STEP} along it. Arc endpoints follow the SVG
 * implementation notes (SVG 1.1 §F.6.5), a radius too short for its chord
 * grown to fit it as SVG grows it.
 *
 * @param {string} d
 * @returns {number[]} Points along it, [x0, y0, x1, y1, ...].
 */
function ringOf(d) {
  const ring = [];
  let x = 0;
  let y = 0;
  for (const [, command, args] of d.matchAll(/([MLAZ])([^MLAZ]*)/g)) {
    const n = args.trim()
      ? args
          .trim()
          .split(/[\s,]+/)
          .map(Number)
      : [];
    if (command === "M" || command === "L") {
      [x, y] = n;
      ring.push(x, y);
      continue;
    }
    if (command !== "A") {
      continue;
    }
    const [radius, , , large, sweep, x2, y2] = n;
    const hx = (x - x2) / 2;
    const hy = (y - y2) / 2;
    const half = hx * hx + hy * hy;
    if (!half) {
      continue;
    }
    const r = Math.max(radius, Math.sqrt(half));
    const reach =
      (large === sweep ? -1 : 1) *
      Math.sqrt(Math.max(0, (r * r - half) / half));
    const cx = reach * hy + (x + x2) / 2;
    const cy = -reach * hx + (y + y2) / 2;
    const from = Math.atan2(y - cy, x - cx);
    let turn = Math.atan2(y2 - cy, x2 - cx) - from;
    if (sweep && turn < 0) {
      turn += 2 * Math.PI;
    } else if (!sweep && turn > 0) {
      turn -= 2 * Math.PI;
    }
    const steps = Math.max(1, Math.ceil((Math.abs(turn) * r) / SHAPE_STEP));
    for (let i = 1; i <= steps; i++) {
      const angle = from + (turn * i) / steps;
      ring.push(cx + r * Math.cos(angle), cy + r * Math.sin(angle));
    }
    [x, y] = [x2, y2];
  }
  return ring;
}

/**
 * Gives a popover whose window shows the system's backdrop
 * (`sval-popover.css`, `sval-menu.css`) a backdrop in the stem's shape, so
 * the backdrop fills the face and the stem as it fills the body
 * (`XULPopupElement.setWindowShape`): the outline as a ring, and the face,
 * the neck from the face to the body and the body as the parts a backdrop
 * of rounded boxes joins. The face is in the shape because the backdrop
 * draws its rim along every free edge of its parts, and the main window
 * draws the face in a material of its own; with the face in, face, neck
 * and body are one surface. A part has one radius for its four corners, so
 * the face is two parts: the face at its far corners' radius, and its half
 * on the stem's side square. A popover drawn solid has no shape.
 *
 * @param {Element} popup
 * @param {boolean} glass Whether its window shows the system's backdrop.
 * @param {object} traced From {@link trace}.
 * @param {object} layout From {@link layOut}.
 * @param {object} side One of {@link SIDES}.
 * @param {{tl: number, tr: number, br: number, bl: number}} faceRadii
 * @param {{tl: number, tr: number, br: number, bl: number}} contentRadii
 */
function shapeWindow(
  popup,
  glass,
  traced,
  layout,
  side,
  faceRadii,
  contentRadii
) {
  if (!glass) {
    clearShape(popup);
    return;
  }
  const box = rect => ({
    x: rect.left,
    y: rect.top,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
  });
  const { face } = layout;
  const far = radiiToShape(faceRadii, side);
  const radius = Math.min(
    Math.max(far.tl, far.tr),
    (face.right - face.left) / 2,
    (face.bottom - face.top) / 2
  );
  const neck = turnRect(
    {
      left: layout.stem.left,
      right: layout.stem.right,
      top: face.bottom,
      bottom: layout.body.top + STEM_FILLET,
    },
    side.map
  );
  const parts = [
    { ...box(traced.body), radius: Math.max(...Object.values(contentRadii)) },
    { ...box(neck), radius: 0 },
    { ...box(turnRect(face, side.map)), radius },
  ];
  if (radius > 0) {
    parts.push({
      ...box(turnRect({ ...face, top: face.top + radius }, side.map)),
      radius: 0,
    });
  }
  // macOS lays the backdrop's views out once, for the window's size as the
  // shape arrives (`SvalShapedBackdropView`), and a popup's window takes
  // its frame's size only at a later paint
  // (`nsMenuPopupFrame::SchedulePendingWidgetMoveResize`): until the two
  // agree, the shape is given again on the next frame. The popover is placed
  // again on every frame while it settles and on every resize, and each
  // shape given rebuilds those views, so a shape is given once for each
  // size of the window.
  const windowRect = popup.getOuterScreenRect();
  const frame = popup.getBoundingClientRect();
  const key = `${windowRect.width}x${windowRect.height} ${traced.edge} ${JSON.stringify(parts)}`;
  if (popup._svalStemShapeKey !== key) {
    popup._svalStemShapeKey = key;
    popup._svalStemShapeFrames = 0;
    popup.setWindowShape({ rings: [ringOf(traced.edge)], parts });
  }
  const sized =
    Math.abs(windowRect.width - frame.width) <= 1 &&
    Math.abs(windowRect.height - frame.height) <= 1;
  // A window that never took its frame's size would hold the wait open
  // while the popover shows: it ends with the popover's own settling
  // ({@link SETTLE_FRAMES}).
  if (
    !sized &&
    !popup._svalStemShapeAgain &&
    popup._svalStemShapeFrames++ < SETTLE_FRAMES
  ) {
    popup._svalStemShapeAgain = true;
    popup.documentGlobal.requestAnimationFrame(() => {
      popup._svalStemShapeAgain = false;
      if (popup._svalStemButton) {
        place(popup, true);
      }
    });
  }
}

/** Ids `document.mozSetImageElement` names each popover's face by. */
let faceKeys = 0;

/**
 * Draws the button's face again in `popup`'s window, at `rect`, over the
 * backdrop {@link shapeWindow} lays across the face, so the button looks as
 * it does while its popover is open. `-moz-element` paints the face
 * element's own rendering, whatever draws its icon, badge or count, and
 * repaints as it changes (`SVGObserverUtils::GetAndObserveBackgroundImage`).
 * The face gives up its fill and edge meanwhile (`sval-stem.css`), so the
 * copy carries the icon alone over the popover's fill.
 *
 * @param {Element} popup
 * @param {?{face: Element, rect: object}} shown The face element, and its
 *   rect in the popup's window; null takes the copy away.
 */
function showFace(popup, shown) {
  const doc = popup.ownerDocument;
  const key = popup._svalStemFaceKey;
  const was = popup._svalStemGlassFace;
  if (was && was !== shown?.face) {
    was.removeAttribute("sval-stem-glass");
    popup._svalStemGlassFace = null;
  }
  if (!shown) {
    if (was) {
      doc.mozSetImageElement(key, null);
    }
    popup.removeAttribute("sval-stem-glass");
    return;
  }
  const shadow = popup.shadowRoot;
  if (!shadow.querySelector('[part~="sval-stem-face"]')) {
    const copy = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    copy.setAttribute("part", "sval-stem-face");
    copy.setAttribute("aria-hidden", "true");
    shadow.append(copy);
  }
  if (!key) {
    popup._svalStemFaceKey = `sval-stem-face-${++faceKeys}`;
  }
  if (popup._svalStemGlassFace !== shown.face) {
    doc.mozSetImageElement(popup._svalStemFaceKey, shown.face);
    popup._svalStemGlassFace = shown.face;
    shown.face.setAttribute("sval-stem-glass", "");
  }
  const { rect } = shown;
  const set = (name, value) => popup.style.setProperty(name, value);
  set("--sval-stem-face-left", `${rect.left}px`);
  set("--sval-stem-face-top", `${rect.top}px`);
  set("--sval-stem-face-width", `${rect.right - rect.left}px`);
  set("--sval-stem-face-height", `${rect.bottom - rect.top}px`);
  set("--sval-stem-face-image", `-moz-element(#${popup._svalStemFaceKey})`);
  popup.setAttribute("sval-stem-glass", "");
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
 * @returns {boolean} Whether it is open and stands where it is drawn,
 *   with nothing left to move.
 */
function place(popup, traceOnly = false) {
  const button = popup._svalStemButton;
  if (!button) {
    return false;
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
  // A stem host's first `popuppositioned` comes before its window is
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
  // Whether the popup's window stands where its frame does: until it
  // does, what shows on the screen is where it stood before.
  let settled = true;
  if (
    !box.width ||
    Math.abs(box.left - framed.left) > 1 ||
    Math.abs(box.top - framed.top) > 1
  ) {
    box = framed;
    settled = false;
  }
  const part = popup.shadowRoot?.querySelector('[part~="content"]');
  const outline = outlineOf(popup);
  if (!box.width || !part || !outline) {
    return false;
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
  const margin = () => ({
    above: content.top - box.top,
    below: box.top + frame.height - content.bottom,
  });
  if (!traceOnly && keepInWindow(popup, win, content, face, !along, margin())) {
    // Reading the frame's rect reflows the popup, which moves its frame
    // (`nsMenuPopupFrame::PerformMove`); its window follows at the next
    // paint, so the stem is placed by the frame.
    settled = false;
    frame = popup.getBoundingClientRect();
    box = atFrame();
    content = contentOf();
  }
  if (!traceOnly) {
    keepInRoom(popup, win, content, margin());
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
  const rects = { face: inWindow(face), content: inWindow(content) };
  // Opened on another side, it has nothing to grow from and lets go. A
  // measure taken while the window or the popup still moves can put the
  // content on the wrong side for a frame, so the popover measures again on
  // the next frame, unseen while it opens and as itself once shown, and
  // lets go only once it has stood off its side for as long as a popover
  // settles ({@link SETTLE_FRAMES}).
  if (!onSide(rects, side)) {
    popup._svalStemOffSide = (popup._svalStemOffSide ?? 0) + 1;
    if (popup._svalStemOffSide <= SETTLE_FRAMES) {
      if (!popup.hasAttribute("sval-stem-pending")) {
        unplace(popup);
      }
      if (!popup._svalStemOffSideAgain && !popup._svalStemSettling) {
        popup._svalStemOffSideAgain = true;
        win.requestAnimationFrame(() => {
          popup._svalStemOffSideAgain = false;
          place(popup);
        });
      }
      return false;
    }
    detach(popup);
    return false;
  }
  popup._svalStemOffSide = 0;
  const layout = layOut(rects, side, 1 / win.devicePixelRatio);
  // Not across from its button, which moved: it shows as itself until
  // Gecko moves it after the button (`popuppositioned`) and the stem
  // reaches again.
  if (!layout) {
    unplace(popup);
    return false;
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
  const faceRadii = cornerRadii(faceEl, pill);
  // Over the backdrop the face is part of the shape, which the fill covers
  // whole ({@link shapeWindow}).
  const glass = win.getComputedStyle(popup).appearance === "auto";
  const traced = trace(layout, side, faceRadii, contentRadii, !glass);
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
  shapeWindow(popup, glass, traced, layout, side, faceRadii, contentRadii);
  showFace(popup, glass ? { face: faceEl, rect: rects.face } : null);
  button.setAttribute("sval-stem", sideName);
  faceEl.setAttribute("sval-stem-anchor", sideName);
  popup.setAttribute("sval-stem", "placed");
  if (popup.hasAttribute("sval-stem-pending")) {
    revealOnceSettled(popup, win);
  }
  return settled && popup.state === "open";
}

/**
 * The longest a popover stays unseen for its place to settle, in frames: a
 * window follows its frame at the next paint, a popover moved into the
 * window moves once more, and one that fills its rows as it opens is placed
 * again for its new size.
 */
const SETTLE_FRAMES = 12;

/** How many frames running a popover stands still before it shows. */
const STILL_FRAMES = 2;

/**
 * Places `popup` again each frame until it is open, its window stands where
 * its frame does, and nothing has moved it for {@link STILL_FRAMES} frames
 * running, then shows it; past {@link SETTLE_FRAMES} it shows wherever it
 * stands.
 *
 * @param {Element} popup
 * @param {Window} win The popup's browser window.
 */
function revealOnceSettled(popup, win) {
  if (popup._svalStemSettling) {
    return;
  }
  popup._svalStemSettling = true;
  let frames = 0;
  let still = 0;
  const reveal = () => {
    popup._svalStemSettling = false;
    popup.removeAttribute("sval-stem-pending");
  };
  const check = () => {
    if (!popup.hasAttribute("sval-stem-pending")) {
      popup._svalStemSettling = false;
      return;
    }
    still = place(popup) ? still + 1 : 0;
    if (still >= STILL_FRAMES || ++frames > SETTLE_FRAMES) {
      reveal();
    } else {
      win.requestAnimationFrame(check);
    }
  };
  win.requestAnimationFrame(check);
}

/** @param {Event} event `popupshown` or `popuppositioned`. */
function onPlaced(event) {
  const popup = event.target;
  place(popup);
  // Shown and still unplaced: a popover that draws no stem draws as itself.
  if (
    event.type === "popupshown" &&
    popup.getAttribute("sval-stem") !== "placed"
  ) {
    popup.removeAttribute("sval-stem-pending");
  }
}

/**
 * Turns a popover to open beside its button, inside an ancestor no wider
 * than the width its `sval-stem-beside` names, whatever side the popover
 * names, as from a column of buttons a popover above or below one would
 * cover the next. The width is read as the popover opens, so it is the
 * ancestor's width at that moment. It opens
 * toward the window's middle, wherever the column stands and whatever the
 * text's direction. Gecko takes a new anchoring while the popup is still
 * showing (`nsMenuPopupFrame::MoveToAnchor`).
 *
 * @param {Element} popup
 * @param {Window} win The popup's browser window.
 */
function turnBeside(popup, win) {
  const column = popup.anchorNode.closest("[sval-stem-beside]");
  if (
    !column ||
    column.getBoundingClientRect().width >
      parseFloat(column.getAttribute("sval-stem-beside"))
  ) {
    return;
  }
  const { left, right } = popup.anchorNode.getBoundingClientRect();
  const beside = left + right < win.innerWidth ? "right" : "left";
  const named = popup.getAttribute("sval-stem-side");
  if (named === beside) {
    return;
  }
  popup.setAttribute("sval-stem-side", beside);
  popup._svalStemTurned = true;
  popup._svalStemNamed = named;
  // Gecko's `start` and `end` follow the anchor's direction.
  const rtl = win.getComputedStyle(popup.anchorNode).direction === "rtl";
  popup.moveToAnchor(
    popup.anchorNode,
    (beside === "right") !== rtl ? "end_before" : "start_before"
  );
}

/**
 * Turns a popover that would open below its button to open above it, where
 * the window has more room above the button than below, as Gecko flips a
 * popup only against the screen's edge (`nsMenuPopupFrame::SetPopupPosition`)
 * and a button near the window's foot would get a popover squeezed into
 * what is left of the window. Gecko takes a new anchoring while the popup is
 * still showing (`nsMenuPopupFrame::MoveToAnchor`) and keeps it as it opens.
 * The popover keeps the end of its button it lines up with; it is kept in
 * the window afterwards ({@link keepInWindow}). A popover that names its
 * side keeps it.
 *
 * @param {Element} popup
 * @param {Window} win The popup's browser window.
 * @param {DOMRect} face The button's face in the window.
 */
function turnToRoom(popup, win, face) {
  if (
    popup.hasAttribute("sval-stem-side") ||
    !popup.hasAttribute("sval-stem-hang")
  ) {
    return;
  }
  const below = win.innerHeight - face.bottom;
  const above = face.top;
  if (above <= below) {
    return;
  }
  popup.setAttribute("sval-stem-side", "top");
  popup._svalStemTurned = true;
  const end = face.left + face.width / 2 > win.innerWidth / 2;
  popup.moveToAnchor(popup.anchorNode, end ? "before_end" : "before_start");
}

/**
 * `popupshowing`: marks the popover and its button before Gecko positions
 * the popover, so `sval-stem.css` has already made room for the stem. The
 * popover's content is watched for a change of size, which moves its edge:
 * `popuppositioned` comes in a task of its own
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
  turnBeside(popup, win);
  turnToRoom(popup, win, face);
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
  // Gecko moves it after its button, as it does an arrow panel
  // (`nsMenuPopupFrame::ShouldFollowAnchor`), and each move places the stem
  // again (`popuppositioned`).
  if (!popup.hasAttribute("followanchor")) {
    popup.setAttribute("followanchor", "true");
  }
  // Unseen until placed, so its first paint is where it stays.
  if (outlineOf(popup)) {
    popup.setAttribute("sval-stem-pending", "");
  }
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
 * A press on one of the popover's own elements is on its content, wherever
 * it says it was: `nsXULElement::Click`, which accessibility's press action
 * calls, sends a press at the screen's corner. Only a press on the popover
 * itself, its margin and stem, is placed by where it was.
 *
 * @param {MouseEvent} event
 */
function onPress(event) {
  if (event.button !== 0) {
    return;
  }
  const popup = event.target.closest?.("panel, menupopup");
  const button = popup?._svalStemButton;
  if (!button || popup.state !== "open" || event.target !== popup) {
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
        const popup = event.target;
        if (popup._svalStemButton) {
          detach(popup);
        }
        // The turn was for this opening; the next asks the room again, from
        // the side the popover names.
        if (popup._svalStemTurned) {
          popup._svalStemTurned = false;
          if (popup._svalStemNamed) {
            popup.setAttribute("sval-stem-side", popup._svalStemNamed);
          } else {
            popup.removeAttribute("sval-stem-side");
          }
          popup._svalStemNamed = null;
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
